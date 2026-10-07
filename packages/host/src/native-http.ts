import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

export const NATIVE_HTTP_BODY = 8 * 1024 * 1024;

export async function readNativeBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > NATIVE_HTTP_BODY) throw new Error("Native request is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readNativeResponse(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 32 * 1024 * 1024) throw new Error("Native response is too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Stream SSE without buffering it. Closing a UI closes transport, not a session. */
export function proxyNativeHttp(req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>, body?: Buffer) {
  const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method: req.method, headers: { ...headers, ...(body?.length ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}) },
  }, response => {
    res.writeHead(response.statusCode ?? 502, { "Content-Type": response.headers["content-type"] ?? "application/json", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    response.on("error", () => res.destroy()); response.pipe(res);
  });
  // A stalled handshake must not hold a native client open forever; SSE itself
  // is deliberately long lived and emits provider heartbeats.
  const timeout = setTimeout(() => upstream.destroy(new Error("Native connection timed out")), 15000);
  upstream.once("response", () => clearTimeout(timeout));
  upstream.on("error", () => {
    clearTimeout(timeout);
    if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: "Native connection unavailable; inspect the session before retrying input" })); }
    else res.destroy();
  });
  res.on("close", () => { clearTimeout(timeout); upstream.destroy(); });
  upstream.end(body);
}

export async function* nativeEvents(response: Response) {
  if (!response.ok || !response.body) throw new Error("Native event stream unavailable");
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      if (pending.length > NATIVE_HTTP_BODY) throw new Error("Native event is too large");
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) yield JSON.parse(data);
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
