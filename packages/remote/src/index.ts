import {
  acceptServerHello, createCipherChannel, createClientHello, HANDSHAKE_TIMEOUT_MS, MAX_FRAME_BYTES,
  MAX_PENDING_REQUESTS, MAX_REQUEST_BYTES, object, remoteSocketUrl, systemRandomBytes, tokenKey, UUID,
  type CipherChannel, type RandomBytes, type RemoteMethod, type RemoteRequest,
} from "./protocol.js";

export interface RemoteConnection { url: string; token: string; relay?: { machineId: string } }
export interface RemoteRequestOptions {
  method?: RemoteMethod; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal;
}
export interface RemoteClientOptions { randomBytes?: RandomBytes; requestTimeoutMs?: number }
export interface RemoteClient {
  request<T = unknown>(path: string, options?: RemoteRequestOptions): Promise<T>;
  close(): void;
}

export class RemoteError extends Error {
  constructor(message: string, public status = 0, public body: unknown = undefined, public code = "connection-failed") {
    super(message); this.name = "RemoteError";
  }
}

type Pending = { mutation: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void };

/** Connect on demand. Only new explicit calls reconnect; pending operations are never replayed. */
export function createRemoteClient(connection: RemoteConnection, options: RemoteClientOptions = {}): RemoteClient {
  const random = options.randomBytes ?? systemRandomBytes;
  const key = tokenKey(connection.token), token = connection.token;
  const machineId = connection.relay?.machineId ?? "";
  if (machineId && !UUID.test(machineId)) throw new Error("Invalid machine identifier");
  const endpoint = remoteSocketUrl(connection.url, connection.relay ? `/relay/clients/${machineId}` : "/api/remote");
  const timeout = options.requestTimeoutMs ?? 30000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 300000) throw new Error("Invalid remote request timeout");
  let socket: WebSocket | undefined, channel: CipherChannel | undefined, opening: Promise<void> | undefined, stopped = false;
  let failOpening: ((error: Error) => void) | undefined, handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let counter = 0;
  const pending = new Map<string, Pending>();
  const interrupted = (mutation: boolean) => new RemoteError(
    mutation ? "Connection interrupted. Delivery may be uncertain; refresh the session before retrying." : "Machine connection interrupted. Reconnect to refresh.",
    0, undefined, mutation ? "delivery-unknown" : "disconnected",
  );
  const disconnect = (error: Error) => {
    const previous = socket; socket = undefined; channel?.destroy(); channel = undefined;
    clearTimeout(handshakeTimer); handshakeTimer = undefined;
    failOpening?.(error); failOpening = undefined; opening = undefined;
    for (const item of pending.values()) { item.cleanup(); item.reject(interrupted(item.mutation)); }
    pending.clear();
    try { previous?.close(); } catch { /* already disconnected */ }
  };
  const connect = () => {
    if (stopped) return Promise.reject(new RemoteError("Machine connection is closed", 0, undefined, "closed"));
    if (channel && socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (opening) return opening;
    if (socket || channel) disconnect(new RemoteError("Machine connection is closing", 0, undefined, "disconnected"));
    const hello = createClientHello(key, machineId, random);
    let current: WebSocket;
    const ready = new Promise<void>((resolve, reject) => {
      failOpening = reject;
      try { current = new WebSocket(endpoint); socket = current; }
      catch { reject(new RemoteError("Could not open the machine connection")); return; }
      handshakeTimer = setTimeout(() => { if (socket === current) disconnect(new RemoteError("Machine did not authenticate in time", 0, undefined, "handshake-timeout")); }, HANDSHAKE_TIMEOUT_MS);
      current.onopen = () => { if (socket === current) current.send(JSON.stringify(hello)); };
      current.onerror = () => { if (socket === current) disconnect(new RemoteError("Machine is offline or unavailable", 0, undefined, "offline")); };
      current.onclose = () => { if (socket === current) disconnect(new RemoteError("Machine is offline or authentication failed", 0, undefined, "offline")); };
      current.onmessage = event => {
        if (socket !== current) return;
        try {
          if (typeof event.data !== "string" || event.data.length > MAX_FRAME_BYTES) throw new Error("Invalid remote frame");
          const frame: unknown = JSON.parse(event.data);
          if (!channel) {
            const welcome = acceptServerHello(key, hello, frame);
            channel = createCipherChannel(key, hello, welcome, "client");
            clearTimeout(handshakeTimer); handshakeTimer = undefined; failOpening = undefined; opening = undefined;
            resolve(); return;
          }
          const response = object(channel.open(frame));
          if (response.type !== "response" || typeof response.id !== "string" || !Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599) throw new Error("Invalid remote response");
          const item = pending.get(response.id);
          // A locally canceled read may still finish at the runner.
          if (!item) return;
          pending.delete(response.id); item.cleanup();
          const status = Number(response.status);
          if (status >= 200 && status < 300) item.resolve(response.body);
          else {
            const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
            item.reject(new RemoteError(typeof body.error === "string" ? body.error : `Machine request failed (${status})`, status, response.body, typeof body.code === "string" ? body.code : "request-failed"));
          }
        } catch { disconnect(new RemoteError("Machine authentication or message integrity failed", 0, undefined, "integrity-failed")); }
      };
    });
    opening = ready;
    void ready.catch(() => { if (opening === ready) opening = undefined; });
    return ready;
  };
  return {
    async request<T>(path: string, init: RemoteRequestOptions = {}): Promise<T> {
      if (init.signal?.aborted) throw new RemoteError("Request canceled before delivery", 0, undefined, "aborted");
      const method = init.method ?? (init.body === undefined ? "GET" : "POST");
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("#") || path.includes("\\")) throw new RemoteError("Invalid API path", 400, undefined, "invalid-request");
      const apiPath = path.startsWith("/api/") ? path : `/api${path}`;
      const ready = connect();
      if (init.signal) {
        const signal = init.signal;
        await new Promise<void>((resolve, reject) => {
          const canceled = () => { signal.removeEventListener("abort", canceled); reject(new RemoteError("Request canceled before delivery", 0, undefined, "aborted")); };
          signal.addEventListener("abort", canceled, { once: true });
          void ready.then(() => { signal.removeEventListener("abort", canceled); resolve(); }, error => { signal.removeEventListener("abort", canceled); reject(error); });
          if (signal.aborted) canceled();
        });
      } else await ready;
      if (init.signal?.aborted) throw new RemoteError("Request canceled before delivery", 0, undefined, "aborted");
      if (!channel || socket?.readyState !== WebSocket.OPEN) throw new RemoteError("Machine disconnected before delivery", 0, undefined, "disconnected");
      if (pending.size >= MAX_PENDING_REQUESTS) throw new RemoteError("Too many pending machine requests", 429, undefined, "busy");
      // Readiness and cancellation can settle in a different order than callers
      // arrived. Allocate the replay-protected identity in actual send order.
      if (!Number.isSafeInteger(counter + 1)) throw new RemoteError("Reconnect this machine before sending another request", 0, undefined, "closed");
      const request: RemoteRequest = { type: "request", id: `${++counter}`, token, method, path: apiPath, headers: init.headers, body: init.body };
      if (new TextEncoder().encode(JSON.stringify(request)).length > MAX_REQUEST_BYTES) throw new RemoteError("Request is too large", 413, undefined, "request-too-large");
      const mutation = method !== "GET", activeSocket = socket, activeChannel = channel;
      return new Promise<T>((resolve, reject) => {
        const cancel = () => {
          const item = pending.get(request.id);
          if (!item) return;
          pending.delete(request.id); item.cleanup();
          reject(mutation ? interrupted(true) : new RemoteError("Request canceled", 0, undefined, "aborted"));
        };
        const timer = setTimeout(() => {
          if (socket === activeSocket) disconnect(new RemoteError("Machine request timed out", 0, undefined, "timeout"));
        }, timeout);
        const cleanup = () => { clearTimeout(timer); init.signal?.removeEventListener("abort", cancel); };
        pending.set(request.id, { mutation, resolve: value => resolve(value as T), reject, cleanup });
        init.signal?.addEventListener("abort", cancel, { once: true });
        try { activeSocket.send(JSON.stringify(activeChannel.seal(request))); }
        catch { disconnect(new RemoteError("Machine connection failed while sending")); }
      });
    },
    close() { stopped = true; disconnect(new RemoteError("Machine connection closed", 0, undefined, "closed")); key.fill(0); },
  };
}
