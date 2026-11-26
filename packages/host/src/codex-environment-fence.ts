import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { NATIVE_MAX_BUFFERED, NATIVE_MAX_MESSAGE } from "./native-transport.js";

const PROBE_METHODS = new Set(["initialize", "initialized", "environment/info", "environment/status"]);
const MAX_QUEUED_BYTES = 256 * 1024;
const MAX_QUEUED_FRAMES = 128;

export type FenceDecision =
  | { allowed: true; generation: number; bootstrap?: boolean }
  | { allowed: false; code: string; reason: string };

export interface FencedDispatchEvent {
  environmentId: string;
  method?: string;
  code: string;
  reason: string;
}

interface RegisteredEndpoint {
  environmentId: string;
  upstreamUrl: string;
  upstreamToken: string;
  proxyToken: string;
}

interface QueuedFrame {
  text: string;
  method?: string;
  params?: Record<string, unknown>;
  id?: string | number;
  probe: boolean;
  authorizedGeneration: number;
  bootstrap: boolean;
}

interface ActiveChannel {
  environmentId: string;
  rejectQueuedToolFrames: (reason: string) => void;
  close: () => void;
}

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function isRpcId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface CodexToolFence {
  add(target: { environmentId: string; url: string; token: string }): { url: string; token: string };
  remove(environmentId: string, reason: string): void;
  revoke(environmentId: string, reason: string): void;
  revokeAll(reason: string): void;
  close(): void;
}

export async function createCodexToolFence(options: {
  authorize: (environmentId: string, method?: string, params?: Record<string, unknown>) => FenceDecision;
  onFenced?: (event: FencedDispatchEvent) => void;
}): Promise<CodexToolFence> {
  const endpoints = new Map<string, RegisteredEndpoint>();
  const channels = new Set<ActiveChannel>();
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: false });
  let closed = false;

  const sendSafe = (socket: WebSocket, text: string, onFail: () => void) => {
    const bytes = Buffer.byteLength(text);
    if (socket.readyState !== WebSocket.OPEN || bytes > NATIVE_MAX_MESSAGE || socket.bufferedAmount + bytes > NATIVE_MAX_BUFFERED) {
      onFail();
      return false;
    }
    try {
      socket.send(text, error => { if (error) onFail(); });
      return true;
    } catch {
      onFail();
      return false;
    }
  };

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const match = /^\/env\/([^/?#]+)$/.exec(req.url ?? "");
    let environmentId: string | undefined;
    if (match) {
      try { environmentId = decodeURIComponent(match[1]); } catch { environmentId = undefined; }
    }
    const endpoint = environmentId ? endpoints.get(environmentId) : undefined;
    if (closed || req.headers.origin !== undefined || !endpoint || !authorized(req.headers.authorization, endpoint.proxyToken)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, frontend => {
      let upstream: WebSocket | undefined;
      let bootstrapUpstream: WebSocket | undefined;
      const queued: QueuedFrame[] = [];
      const bootstrapQueued: QueuedFrame[] = [];
      let queuedBytes = 0;
      const teardown = () => {
        channels.delete(channel);
        queued.length = 0;
        bootstrapQueued.length = 0;
        queuedBytes = 0;
        frontend.terminate();
        upstream?.terminate();
        bootstrapUpstream?.terminate();
      };
      const closeSocket = (sock: WebSocket | undefined) => {
        if (!sock) return;
        if (sock.readyState === WebSocket.OPEN) sock.close();
        else if (sock.readyState === WebSocket.CONNECTING) sock.terminate();
      };
      const sendError = (id: string | number | undefined, reason: string) => {
        if (id === undefined || frontend.readyState !== WebSocket.OPEN) return;
        sendSafe(frontend, JSON.stringify({
          id,
          error: { code: -32000, message: `This request was not executed. ${reason}` },
        }), teardown);
      };
      const rejectQueue = (list: QueuedFrame[], reason: string) => {
        if (list.length === 0) return;
        const retained: QueuedFrame[] = [];
        for (const frame of list) {
          const bytes = Buffer.byteLength(frame.text);
          if (frame.probe) {
            retained.push(frame);
          } else {
            queuedBytes = Math.max(0, queuedBytes - bytes);
            options.onFenced?.({ environmentId: endpoint.environmentId, method: frame.method, code: "conflict", reason });
            sendError(frame.id, reason);
          }
        }
        list.length = 0;
        list.push(...retained);
      };
      const rejectQueuedToolFrames = (reason: string) => {
        rejectQueue(queued, reason);
        rejectQueue(bootstrapQueued, reason);
        const confined = bootstrapUpstream;
        bootstrapUpstream = undefined;
        closeSocket(confined);
      };
      const flushQueue = (target: WebSocket, list: QueuedFrame[]) => {
        const pending = list.splice(0, list.length);
        for (const frame of pending) {
          queuedBytes = Math.max(0, queuedBytes - Buffer.byteLength(frame.text));
          if (!frame.probe) {
            const decision = options.authorize(endpoint.environmentId, frame.method, frame.params);
            if (!decision.allowed) {
              options.onFenced?.({ environmentId: endpoint.environmentId, method: frame.method, code: decision.code, reason: decision.reason });
              sendError(frame.id, decision.reason);
              continue;
            }
            if (decision.generation !== frame.authorizedGeneration || Boolean(decision.bootstrap) !== frame.bootstrap) {
              const reason = "Execution environment placement generation changed while the request was queued";
              options.onFenced?.({ environmentId: endpoint.environmentId, method: frame.method, code: "conflict", reason });
              sendError(frame.id, reason);
              continue;
            }
          }
          if (!sendSafe(target, frame.text, teardown)) return;
        }
      };
      const ensureUpstream = (confined: boolean): WebSocket => {
        if (confined) {
          if (bootstrapUpstream && (bootstrapUpstream.readyState === WebSocket.OPEN || bootstrapUpstream.readyState === WebSocket.CONNECTING)) {
            return bootstrapUpstream;
          }
          const next = new WebSocket(endpoint.upstreamUrl, {
            headers: {
              Authorization: `Bearer ${endpoint.upstreamToken}`,
              "X-Infinite-Confined-Discovery": "1",
            },
            maxPayload: NATIVE_MAX_MESSAGE,
            perMessageDeflate: false,
            handshakeTimeout: 10000,
          });
          bootstrapUpstream = next;
          next.on("error", () => {
            if (bootstrapUpstream === next) bootstrapUpstream = undefined;
            rejectQueue(bootstrapQueued, "Confined startup discovery channel failed");
            next.terminate();
          });
          next.on("close", () => {
            if (bootstrapUpstream === next) bootstrapUpstream = undefined;
            rejectQueue(bootstrapQueued, "Confined startup discovery channel closed");
          });
          next.on("open", () => {
            if (closed || bootstrapUpstream !== next) { next.terminate(); return; }
            flushQueue(next, bootstrapQueued);
          });
          next.on("message", (data, binary) => {
            if (binary || closed) { teardown(); return; }
            sendSafe(frontend, data.toString(), teardown);
          });
          return next;
        }
        if (upstream) return upstream;
        const next = new WebSocket(endpoint.upstreamUrl, {
          headers: { Authorization: `Bearer ${endpoint.upstreamToken}` },
          maxPayload: NATIVE_MAX_MESSAGE,
          perMessageDeflate: false,
          handshakeTimeout: 10000,
        });
        upstream = next;
        next.on("error", teardown);
        next.on("close", () => { channels.delete(channel); closeSocket(bootstrapUpstream); closeSocket(frontend); });
        next.on("open", () => {
          if (closed) { teardown(); return; }
          flushQueue(next, queued);
        });
        next.on("message", (data, binary) => {
          if (binary || closed) { teardown(); return; }
          sendSafe(frontend, data.toString(), teardown);
        });
        return next;
      };

      const channel: ActiveChannel = {
        environmentId: endpoint.environmentId,
        rejectQueuedToolFrames,
        close: teardown,
      };
      channels.add(channel);

      frontend.on("error", teardown);
      frontend.on("close", () => { channels.delete(channel); closeSocket(upstream); closeSocket(bootstrapUpstream); });

      frontend.on("message", (data, binary) => {
        if (binary || closed) { teardown(); return; }
        try {
          const text = data.toString();
          const message = parseObject(JSON.parse(text));
          if (!message) { teardown(); return; }
          const method = typeof message.method === "string" ? message.method : undefined;
          const params = parseObject(message.params);
          const id = isRpcId(message.id) ? message.id : undefined;
          const probe = method !== undefined && PROBE_METHODS.has(method);
          let authorizedGeneration = 0;
          let bootstrap = false;
          if (!probe) {
            const decision = options.authorize(endpoint.environmentId, method, params);
            if (!decision.allowed) {
              options.onFenced?.({ environmentId: endpoint.environmentId, method, code: decision.code, reason: decision.reason });
              sendError(id, decision.reason);
              return;
            }
            authorizedGeneration = decision.generation;
            bootstrap = Boolean(decision.bootstrap);
          }
          const target = ensureUpstream(bootstrap);
          const targetQueue = bootstrap ? bootstrapQueued : queued;
          if (target.readyState === WebSocket.OPEN) {
            sendSafe(target, text, teardown);
          } else if (target.readyState === WebSocket.CONNECTING) {
            const bytes = Buffer.byteLength(text);
            if (queued.length + bootstrapQueued.length >= MAX_QUEUED_FRAMES || queuedBytes + bytes > MAX_QUEUED_BYTES) {
              teardown();
              return;
            }
            targetQueue.push({ text, method, params, id, probe, authorizedGeneration, bootstrap });
            queuedBytes += bytes;
          } else {
            teardown();
          }
        } catch {
          teardown();
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });
  const base = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;

  const close = () => {
    if (closed) return;
    closed = true;
    endpoints.clear();
    for (const channel of [...channels]) channel.close();
    channels.clear();
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.close();
  };
  server.on("error", close);

  return {
    add(target) {
      if (closed) throw new Error("Tool dispatch fence is closed");
      const existing = endpoints.get(target.environmentId);
      if (existing && existing.upstreamUrl === target.url && existing.upstreamToken === target.token) {
        return {
          url: `${base}/env/${encodeURIComponent(existing.environmentId)}`,
          token: existing.proxyToken,
        };
      }
      const proxyToken = randomBytes(32).toString("hex");
      endpoints.set(target.environmentId, {
        environmentId: target.environmentId,
        upstreamUrl: target.url,
        upstreamToken: target.token,
        proxyToken,
      });
      return {
        url: `${base}/env/${encodeURIComponent(target.environmentId)}`,
        token: proxyToken,
      };
    },
    remove(environmentId, reason) {
      endpoints.delete(environmentId);
      for (const channel of [...channels]) {
        if (channel.environmentId === environmentId) {
          channel.rejectQueuedToolFrames(reason);
          channel.close();
        }
      }
    },
    revoke(environmentId, reason) {
      for (const channel of channels) {
        if (channel.environmentId === environmentId) channel.rejectQueuedToolFrames(reason);
      }
    },
    revokeAll(reason) {
      for (const channel of channels) channel.rejectQueuedToolFrames(reason);
    },
    close,
  };
}
