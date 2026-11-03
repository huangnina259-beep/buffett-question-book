import type { ProviderConfig } from "./provider-config";

/** Server-only transport. It does not enable generation or approve an answer. */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ProviderUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reported: boolean;
};
export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs: number;
  /** Opt-in only after compatibility evaluation; omitted by default. */
  jsonObject?: boolean;
  signal?: AbortSignal;
};
export type ProviderErrorCode = "configuration" | "invalid_request" | "cancelled" | "timeout" |
  "network" | "authentication" | "rate_limited" | "upstream" | "invalid_response" |
  "response_too_large" | "refusal" | "truncated";

const messages: Record<ProviderErrorCode, string> = {
  configuration: "The model service is not configured for this request.",
  invalid_request: "The model request exceeds the allowed limits.",
  cancelled: "The model request was cancelled.",
  timeout: "The model service did not finish within the time limit.",
  network: "The model service could not be reached.",
  authentication: "The model service could not authenticate this request.",
  rate_limited: "The model service is temporarily at its request limit.",
  upstream: "The model service could not complete this request.",
  invalid_response: "The model service returned an unusable response.",
  response_too_large: "The model service returned more data than allowed.",
  refusal: "The model service declined to produce this answer.",
  truncated: "The model service did not finish the answer within its output limit.",
};

/** Fixed messages only: never attach the upstream body, URL, key, or raw error. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus?: number;
  readonly usage?: ProviderUsage;
  constructor(code: ProviderErrorCode, details: { httpStatus?: number; usage?: ProviderUsage } = {}) {
    super(messages[code]);
    this.name = "ProviderError";
    this.code = code;
    this.httpStatus = details.httpStatus;
    this.usage = details.usage;
  }
}

export type ChatCompletionResult = {
  text: string;
  requestedModel: string;
  reportedModel: string | null;
  usage: ProviderUsage;
  elapsedMs: number;
};

const INPUT_BYTE_LIMIT = 524_288;
const RESPONSE_BYTE_LIMIT = 2_097_152;
const OUTPUT_CHARACTER_LIMIT = 100_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usageFrom(value: unknown): ProviderUsage {
  if (!record(value)) return { inputTokens: null, outputTokens: null, totalTokens: null, reported: false };
  const count = (item: unknown) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : null;
  const inputTokens = count(value.prompt_tokens);
  const outputTokens = count(value.completion_tokens);
  const reportedTotal = count(value.total_tokens);
  // Missing counts remain unknown. They are never silently converted to zero.
  const sum = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const totalTokens = reportedTotal ?? (sum !== null && Number.isSafeInteger(sum) ? sum : null);
  return { inputTokens, outputTokens, totalTokens, reported: sum !== null && Number.isSafeInteger(sum) &&
    (reportedTotal === null || reportedTotal === sum) };
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ProviderError("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ProviderError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function endpointFor(config: ProviderConfig) {
  if (config.protocol !== "chat-completions" || !config.apiKey || /[\r\n]/.test(config.apiKey)) {
    throw new ProviderError("configuration");
  }
  let url: URL;
  try { url = new URL(config.baseURL); }
  catch { throw new ProviderError("configuration"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      /\/(console|login)(\/|$)/i.test(url.pathname)) throw new ProviderError("configuration");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url.href;
}

function requestBody(request: ChatCompletionRequest) {
  if (typeof request.model !== "string" || !request.model.trim() || request.model.length > 160 || /[\r\n]/.test(request.model) ||
      !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 8192 ||
      !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 90_000 ||
      !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 24 ||
      request.messages.some((message) => !message || !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" || !message.content.trim())) {
    throw new ProviderError("invalid_request");
  }
  // response_format is omitted by default; jsonObject is an explicit evaluation
  // opt-in, not an answer-quality guarantee. No tools, streaming, retry, or extra choices.
  const body = JSON.stringify({
    model: request.model,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    max_tokens: request.maxTokens,
    stream: false,
    ...(request.jsonObject ? { response_format: { type: "json_object" } } : {}),
  });
  if (new TextEncoder().encode(body).byteLength > INPUT_BYTE_LIMIT) throw new ProviderError("invalid_request");
  return body;
}

async function readBoundedJson(response: Response, signal: AbortSignal) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_BYTE_LIMIT) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderError("response_too_large");
  }
  if (!response.body) throw new ProviderError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Cancelling the reader also bounds a mocked or stalled body that does not
  // itself honor fetch's AbortSignal.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ProviderError("cancelled");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new ProviderError("cancelled");
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BYTE_LIMIT) {
        await reader.cancel();
        throw new ProviderError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ProviderError("invalid_response"); }
}

/** One HTTP attempt, with explicit output/time bounds and reported token usage. */
export async function callChatCompletion(
  config: ProviderConfig,
  request: ChatCompletionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatCompletionResult> {
  const endpoint = endpointFor(config);
  const body = requestBody(request);
  if (request.signal?.aborted) throw new ProviderError("cancelled");
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  request.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
  let usage: ProviderUsage | undefined;
  try {
    const response = await abortable(fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
      body, signal: controller.signal, redirect: "error", cache: "no-store",
    }), controller.signal);
    if (!response.ok) {
      // Upstream error text can echo prompts or credentials. Never read or relay it.
      await response.body?.cancel().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? "authentication" :
        response.status === 429 ? "rate_limited" : "upstream";
      throw new ProviderError(code, { httpStatus: response.status });
    }
    const payload = await readBoundedJson(response, controller.signal);
    if (!record(payload)) throw new ProviderError("invalid_response");
    usage = usageFrom(payload.usage);
    if (payload.error || !Array.isArray(payload.choices) || payload.choices.length !== 1 || !record(payload.choices[0])) {
      throw new ProviderError("invalid_response", { usage });
    }
    const choice = payload.choices[0];
    const message = choice.message;
    if (choice.finish_reason === "length") throw new ProviderError("truncated", { usage });
    if (choice.finish_reason === "content_filter" || (record(message) && message.refusal)) {
      throw new ProviderError("refusal", { usage });
    }
    const hasToolCalls = record(message) && message.tool_calls != null &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0);
    if (choice.finish_reason !== "stop" || !record(message) || message.role !== "assistant" || hasToolCalls || message.function_call ||
        typeof message.content !== "string" || !message.content.trim() || message.content.length > OUTPUT_CHARACTER_LIMIT) {
      throw new ProviderError("invalid_response", { usage });
    }
    return {
      text: message.content,
      requestedModel: request.model,
      reportedModel: typeof payload.model === "string" && payload.model.length <= 160 && !/[\r\n]/.test(payload.model) ? payload.model : null,
      usage,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderError(timedOut ? "timeout" : "cancelled", { usage });
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("network", { usage });
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
  }
}
