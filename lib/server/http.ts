export class RequestError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
    this.name = "RequestError";
  }
}

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store, private");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Vary", "Cookie");
  return Response.json(data, { status, headers });
}

export function routeError(error: unknown, fallback = "Storage is temporarily unavailable. Please try again shortly.") {
  if (error instanceof RequestError) {
    return json({ error: error.message }, error.status,
      error.retryAfter ? { "Retry-After": String(error.retryAfter) } : undefined);
  }
  // Do not send database errors, questions, cookie values, or stack traces to clients.
  console.error("Beta API storage operation failed.");
  return json({ error: fallback }, 503);
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected) {
    throw new RequestError(403, "This request must come from this website.");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new RequestError(403, "This request must come from this website.");
  }
}

export function rejectCrossSiteRead(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if ((site && site !== "same-origin" && site !== "none") ||
      (origin && origin !== new URL(request.url).origin)) {
    throw new RequestError(403, "This request must come from this website.");
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new RequestError(415, "Send a JSON request.");
  const maximum = 16_384;
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) throw new RequestError(413, "This request is too large.");
  if (!request.body) throw new RequestError(400, "The request body is missing.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new RequestError(413, "This request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(400, "The JSON request is not valid."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestError(400, "Send a JSON object.");
  }
  return payload as Record<string, unknown>;
}

export function allowKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new RequestError(400, "This request contains unsupported fields.");
  }
}

export function requiredText(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string") throw new RequestError(400, `${name} is required.`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new RequestError(400, `${name} must contain 1–${maximum} readable characters.`);
  }
  return text;
}
