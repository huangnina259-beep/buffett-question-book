/** Server-only configuration contract; do not import this file in a client component. */
export type ProviderConfig = {
  name: string;
  baseURL: string;
  protocol: "chat-completions" | "responses";
  apiKey: string;
  model: string;
  dailyRequestLimit: number;
};

export function readProviderConfig(values: Record<string, string | undefined>): ProviderConfig | null {
  if (values.GENERATION_ENABLED !== "true") return null;
  const name = values.MODEL_PROVIDER_NAME?.trim();
  const base = values.MODEL_BASE_URL?.trim();
  const apiKey = values.MODEL_API_KEY?.trim();
  const model = values.MODEL_NAME?.trim();
  const protocol = values.MODEL_PROTOCOL;
  const limit = Number(values.MODEL_DAILY_REQUEST_LIMIT);
  if (!name || !base || !apiKey || !model) throw new Error("Live generation is not fully configured.");
  if (protocol !== "chat-completions" && protocol !== "responses") throw new Error("Unsupported provider protocol.");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /\/(console|login)(\/|$)/i.test(url.pathname)) {
    throw new Error("Use the provider's documented HTTPS inference base URL.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Set an explicit daily generation request limit.");
  return { name, baseURL: url.href.replace(/\/$/, ""), protocol, apiKey, model, dailyRequestLimit: limit };
}
