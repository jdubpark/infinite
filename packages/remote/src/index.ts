import {
  acceptServerHello, createCipherChannel, createClientHello, HANDSHAKE_TIMEOUT_MS, MAX_FRAME_BYTES,
  MAX_PENDING_REQUESTS, MAX_REQUEST_BYTES, MAX_TERMINAL_STREAMS, MAX_TERMINAL_BUFFERED_BYTES,
  object, remoteSocketUrl, systemRandomBytes, tokenKey, UUID,
  type CipherChannel, type RandomBytes, type RemoteMethod, type RemoteRequest, type RemoteTerminalCommand, type TerminalInput,
} from "./protocol.js";

/** A Cloudflare Access service token; Cloudflare checks it before the connection reaches the relay. */
export interface RemoteAccessToken { clientId: string; clientSecret: string }
export interface RemoteConnection { url: string; token: string; relay?: { machineId: string }; access?: RemoteAccessToken }
export interface RemoteRequestOptions {
  method?: RemoteMethod; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal;
}
export interface RemoteClientOptions { randomBytes?: RandomBytes; requestTimeoutMs?: number }
export interface RemoteTerminalOptions {
  clientId: string;
  after?: number;
  snapshot?: boolean;
  onMessage(message: Record<string, unknown>): void;
  onClose(event: { code: number; error?: RemoteError }): void;
}
export interface RemoteTerminal {
  /** A send is not a delivery receipt. Match terminal receipts/refusals by requestId. */
  send(message: TerminalInput): void;
  close(): void;
}
export type { TerminalInput } from "./protocol.js";
export interface RemoteClient {
  request<T = unknown>(path: string, options?: RemoteRequestOptions): Promise<T>;
  /** Opens explicitly; disconnected terminals and uncertain input are never replayed. */
  openTerminal(sessionId: string, options: RemoteTerminalOptions): Promise<RemoteTerminal>;
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
  const access = connection.access;
  if (access && ![access.clientId, access.clientSecret].every(value => /^[\x21-\x7e]{8,200}$/.test(value))) throw new Error("Invalid access token");
  const headers = access ? { "CF-Access-Client-Id": access.clientId, "CF-Access-Client-Secret": access.clientSecret } : undefined;
  const timeout = options.requestTimeoutMs ?? 30000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 300000) throw new Error("Invalid remote request timeout");
  let socket: WebSocket | undefined, channel: CipherChannel | undefined, opening: Promise<void> | undefined, stopped = false;
  let failOpening: ((error: Error) => void) | undefined, handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let counter = 0;
  const pending = new Map<string, Pending>();
  const terminals = new Map<string, RemoteTerminalOptions>();
  const notifyClosed = (streamId: string, code: number, error?: RemoteError) => {
    const terminal = terminals.get(streamId);
    terminals.delete(streamId);
    try { terminal?.onClose({ code, error }); } catch { /* application callbacks do not affect channel integrity */ }
  };
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
    for (const streamId of terminals.keys()) notifyClosed(streamId, 1006, interrupted(true));
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
      // React Native reads headers from the third argument and Node from the second;
      // each ignores the other. Browsers cannot send upgrade headers.
      try { current = headers ? new (WebSocket as unknown as new (url: string, init: object, options: object) => WebSocket)(endpoint, { headers }, { headers }) : new WebSocket(endpoint); socket = current; }
      catch { reject(new RemoteError("Could not open the machine connection")); return; }
      handshakeTimer = setTimeout(() => { if (socket === current) disconnect(new RemoteError("Machine did not authenticate in time. Check that encrypted remote access is enabled on the host.", 0, undefined, "handshake-timeout")); }, HANDSHAKE_TIMEOUT_MS);
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
          if (response.type === "terminal-event" || response.type === "terminal-closed") {
            if (typeof response.streamId !== "string" || !/^[1-9][0-9]{0,15}$/.test(response.streamId)) throw new Error("Invalid terminal stream");
            if (response.type === "terminal-closed") {
              if (!Number.isInteger(response.code) || Number(response.code) < 1000 || Number(response.code) > 4999) throw new Error("Invalid terminal close");
              notifyClosed(response.streamId, Number(response.code));
            } else {
              const message = object(response.message);
              try { terminals.get(response.streamId)?.onMessage(message); } catch { /* isolate renderer callbacks */ }
            }
            return;
          }
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
  const nextId = () => {
    if (!Number.isSafeInteger(counter + 1)) throw new RemoteError("Reconnect this machine before sending another request", 0, undefined, "closed");
    return `${++counter}`;
  };
  const send = (message: RemoteRequest | RemoteTerminalCommand) => {
    if (!channel || socket?.readyState !== WebSocket.OPEN) throw new RemoteError("Machine disconnected before delivery", 0, undefined, "disconnected");
    if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_REQUEST_BYTES) throw new RemoteError("Request is too large", 413, undefined, "request-too-large");
    const frame = JSON.stringify(channel.seal(message));
    if (socket.bufferedAmount + frame.length > MAX_TERMINAL_BUFFERED_BYTES) {
      disconnect(new RemoteError("Machine input buffer is full", 0, undefined, "busy"));
      throw interrupted(true);
    }
    try { socket.send(frame); }
    catch { disconnect(new RemoteError("Machine connection failed while sending")); throw interrupted(true); }
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
      const request: RemoteRequest = { type: "request", id: nextId(), token, method, path: apiPath, headers: init.headers, body: init.body };
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
    async openTerminal(sessionId, init) {
      if (!UUID.test(sessionId) || !UUID.test(init.clientId) || !Number.isSafeInteger(init.after ?? 0) || (init.after ?? 0) < 0)
        throw new RemoteError("Invalid terminal attachment", 400, undefined, "invalid-request");
      await connect();
      if (terminals.size >= MAX_TERMINAL_STREAMS || pending.size >= MAX_PENDING_REQUESTS)
        throw new RemoteError("Too many open terminals or requests", 429, undefined, "busy");
      const streamId = nextId();
      const request: RemoteTerminalCommand = { type: "terminal-open", id: streamId, token, sessionId, clientId: init.clientId, after: init.after ?? 0, snapshot: init.snapshot ?? true };
      terminals.set(streamId, init);
      try {
        await new Promise<void>((resolve, reject) => {
          const activeSocket = socket;
          const timer = setTimeout(() => { if (socket === activeSocket) disconnect(new RemoteError("Terminal attachment timed out", 0, undefined, "timeout")); }, timeout);
          pending.set(streamId, { mutation: false, resolve: value => {
            if (!value || typeof value !== "object" || (value as { streamId?: unknown }).streamId !== streamId) {
              reject(new RemoteError("Invalid terminal attachment receipt")); disconnect(new RemoteError("Invalid terminal attachment receipt"));
            }
            else resolve();
          }, reject, cleanup: () => clearTimeout(timer) });
          try { send(request); }
          catch (error) { pending.delete(streamId); clearTimeout(timer); reject(error); }
        });
      } catch (error) { terminals.delete(streamId); throw error; }
      return {
        send(message) {
          if (!terminals.has(streamId)) throw new RemoteError("Terminal is disconnected. Reattach before sending input.", 0, undefined, "disconnected");
          send({ type: "terminal-send", id: nextId(), token, streamId, message });
        },
        close() {
          if (!terminals.has(streamId)) return;
          terminals.delete(streamId);
          send({ type: "terminal-close", id: nextId(), token, streamId });
        },
      };
    },
    close() { stopped = true; disconnect(new RemoteError("Machine connection closed", 0, undefined, "closed")); key.fill(0); },
  };
}
