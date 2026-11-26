import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  createCipherChannel, createServerHello, equalBytes, HANDSHAKE_TIMEOUT_MS, keyFromHash,
  matchesClientHello, MAX_FRAME_BYTES, MAX_PENDING_REQUESTS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
  MAX_TERMINAL_STREAMS, MAX_TERMINAL_BUFFERED_BYTES, MAX_EVENTS_STREAMS, MAX_EVENTS_BUFFERED_BYTES,
  MAX_EVENTS_EVENT_BYTES,
  object, parseClientHello, parseRelayEnvelope, remoteSocketUrl, tokenKey, UUID,
  type CipherChannel, type RelayEnvelope, type RemoteMethod, type RemoteRequest, type RemoteResponse,
  type RemoteTerminalCommand, type RemoteTerminalEvent, type RemoteEventsCommand, type RemoteEventsEvent,
} from "@infinite/remote/protocol";
import { runtimeSecurity } from "./deployment.js";
import type { Config } from "./types.js";

const MAX_CHANNELS = 32;
const MAX_ACTIVE_REQUESTS = 16;
const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES * 2;
const MAX_REQUEST_FRAME = MAX_REQUEST_BYTES * 2 + 4096;
const REQUEST_TIMEOUT_MS = 30000;
const TEAM_LIST_RETRY_MS = 5 * 60_000;

const PROJECT_ID = /^[a-z0-9-]{1,80}$/;
const DECISION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const COMPONENT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIAGRAM_ID = /^[A-Za-z0-9_:.-]{1,200}$/;
const BEHAVIOR_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const WORK_ID = /^(team|mission|goal):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parsePathSegments(path: string): { rawPathname: string; raw: string[]; decoded: string[] } | undefined {
  if (path.length > 8192 || !path.startsWith("/api/") || path.includes("\\") || path.includes("#") || /[\x00-\x20\x7f]/.test(path)) return undefined;
  const queryIndex = path.indexOf("?");
  const rawPathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  let url: URL;
  try { url = new URL(path, "http://infinite.invalid"); } catch { return undefined; }
  if (url.origin !== "http://infinite.invalid" || url.pathname !== rawPathname) return undefined;
  const raw = rawPathname.slice(1).split("/");
  const decoded: string[] = [];
  for (const segment of raw) {
    if (!segment.length || /%(?![0-9A-Fa-f]{2})/.test(segment)) return undefined;
    let value: string;
    try { value = decodeURIComponent(segment); } catch { return undefined; }
    if (!value.length || value === "." || value === ".." || value.includes("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || /%[0-9A-Fa-f]{2}/.test(value)) return undefined;
    decoded.push(value);
  }
  return { rawPathname, raw, decoded };
}

function allowedPath(method: RemoteMethod, path: string): boolean {
  const parsed = parsePathSegments(path);
  if (!parsed) return false;
  const { rawPathname, raw, decoded } = parsed;
  if (method === "GET" && rawPathname === "/api/me") return true;
  if (method === "GET" && rawPathname === "/api/machine/resources") return true;
  if (method === "GET" && ["/api/permissions/log", "/api/permissions/candidates"].includes(rawPathname)) return true;
  if (method === "GET" && raw.length === 4 && raw[1] === "permissions" && raw[2] === "decisions" && DECISION_ID.test(decoded[3])) return true;
  if (method === "POST" && rawPathname === "/api/permissions/marks") return true;
  if (method === "GET" && rawPathname === "/api/halt") return true;
  if (method === "GET" && ["/api/usage", "/api/usage/daily", "/api/usage/models", "/api/usage/projects", "/api/usage/repair-loops", "/api/usage/interrupted-tasks"].includes(rawPathname)) return true;
  if (method === "GET" && raw.length === 4 && raw[1] === "usage" && raw[2] === "projects" && PROJECT_ID.test(decoded[3])) return true;
  if (method === "POST" && rawPathname === "/api/usage/balances/refresh") return true;
  if (method === "PUT" && raw.length === 5 && raw[1] === "usage" && raw[2] === "accounts" && raw[4] === "plan") return true;
  if (["GET", "POST"].includes(method) && ["/api/sessions", "/api/teams", "/api/goals", "/api/project-groups", "/api/missions"].includes(rawPathname)) return true;
  if (raw[1] === "goals" && raw.length >= 3 && raw.length <= 4 && UUID.test(decoded[2])) {
    return raw.length === 3 ? method === "GET" : method === "POST" && ["steer", "pause", "resume", "cancel", "outcome"].includes(raw[3]);
  }
  if (method === "GET" && ["/api/board", "/api/decision-queue"].includes(rawPathname)) return true;
  if (raw[1] === "project-groups" && raw.length >= 3 && PROJECT_ID.test(decoded[2])) {
    if (raw.length === 3) return ["GET", "PUT", "DELETE"].includes(method);
    if (raw[3] === "understanding") {
      if (raw.length === 4) return method === "GET";
      if (raw.length === 5 && method === "GET" && ["catalog", "components", "briefs", "planned", "work", "generated", "brief"].includes(raw[4])) return true;
      if (raw.length === 6 && method === "GET" && raw[4] === "components" && COMPONENT_ID.test(decoded[5])) return true;
      if (raw.length === 6 && method === "GET" && raw[4] === "diagrams" && DIAGRAM_ID.test(decoded[5])) return true;
      if (raw[4] === "work" && raw.length >= 6 && WORK_ID.test(decoded[5])) {
        if (raw.length === 6) return method === "GET";
        return raw.length === 7 && raw[6] === "refresh" && method === "POST";
      }
      if (raw[4] === "behaviors") {
        if (raw.length === 5) return method === "GET" || method === "POST";
        if (raw.length === 6 && BEHAVIOR_ID.test(decoded[5])) return method === "GET";
        if (raw.length === 7 && BEHAVIOR_ID.test(decoded[5])) return (method === "GET" && raw[6] === "suite") || (method === "POST" && raw[6] === "run");
      }
      if (method === "POST" && raw.length === 5 && raw[4] === "refresh") return true;
      if (method === "POST" && raw[4] === "catalog" && ["projects", "features", "plans", "components", "policy"].includes(raw[5] ?? "")) {
        return raw.length === 6 || (raw.length === 7 && COMPONENT_ID.test(decoded[6]));
      }
    }
    return false;
  }
  if (raw[1] === "missions" && raw.length >= 3 && UUID.test(decoded[2])) {
    if (raw.length === 3) return method === "GET";
    if (raw.length === 4 && raw[3] === "progress") return method === "GET";
    if (raw.length === 4) return method === "POST" && ["steer", "pause", "resume", "cancel", "extend"].includes(raw[3]);
    return raw.length === 5 && method === "POST" && raw[3] === "answer" && UUID.test(decoded[4]);
  }
  if (raw[1] === "teams" && raw.length >= 3 && UUID.test(decoded[2])) {
    if (raw.length === 3) return method === "GET";
    if (raw.length === 4 && ["context", "context-usage", "entries"].includes(raw[3])) return method === "GET";
    if (raw.length === 4) return method === "POST" && ["steer", "pause", "resume", "continue", "cancel"].includes(raw[3]);
    if (raw.length === 5 && raw[3] === "entries" && UUID.test(decoded[4])) return method === "GET";
    return raw.length === 6 && method === "POST" && raw[3] === "decisions" && UUID.test(decoded[4]) && raw[5] === "answer";
  }
  if (["POST", "DELETE"].includes(method) && rawPathname === "/api/devices/push") return true;
  if (method === "POST" && rawPathname === "/api/dictation/cleanup") return true;
  if (raw[1] === "projects" && raw.length >= 3 && PROJECT_ID.test(decoded[2])) {
    if (raw.length === 3) return method === "GET";
    if (raw.length === 4 && raw[3] === "context") return ["GET", "PUT"].includes(method);
    if (raw.length === 4 && raw[3] === "files") return method === "GET";
    if (raw.length === 4 && raw[3] === "file") return ["GET", "DELETE"].includes(method);
    if (raw.length === 4 && (raw[3] === "uploads" || raw[3] === "directories")) return method === "POST";
    if (raw.length === 5 && raw[3] === "graph" && raw[4] === "map") return method === "GET";
    if (raw.length === 5 && raw[3] === "sync" && raw[4] === "apply") return method === "POST";
    if (raw.length === 5 && raw[3] === "uploads" && UUID.test(decoded[4])) return ["PUT", "DELETE"].includes(method);
    return raw.length === 6 && method === "POST" && raw[3] === "uploads" && UUID.test(decoded[4]) && raw[5] === "commit";
  }
  if (raw[1] === "sessions" && raw.length >= 3 && raw.length <= 4 && UUID.test(decoded[2])) {
    if (raw.length === 3) return method === "GET" || method === "DELETE";
    return method === "GET" ? ["events", "messages", "summary", "file", "handoff", "context"].includes(raw[3])
      : method === "POST" && ["control", "input", "answer", "key", "stop", "resize", "resume", "archive"].includes(raw[3]);
  }
  return false;
}

function parseRequest(value: unknown): RemoteRequest {
  const request = object(value);
  if (request.type !== "request" || typeof request.id !== "string" || !/^[1-9][0-9]{0,15}$/.test(request.id) || !Number.isSafeInteger(Number(request.id)) ||
      typeof request.token !== "string" || !/^[\x21-\x7e]{32,200}$/.test(request.token) ||
      typeof request.method !== "string" || !["GET", "POST", "PUT", "DELETE"].includes(request.method) ||
      typeof request.path !== "string" || Object.keys(request).some(key => !["type", "id", "token", "method", "path", "headers", "body"].includes(key)) ||
      Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) throw new Error("Invalid remote request");
  if (request.headers !== undefined) {
    const headers = object(request.headers);
    if (Object.keys(headers).length > 4 || Object.entries(headers).some(([name, value]) =>
      !["x-infinite-client", "x-infinite-control", "content-type", "accept"].includes(name.toLowerCase()) || typeof value !== "string" || value.length > 128 || /[\r\n]/.test(value))) throw new Error("Invalid remote request headers");
  }
  if (request.method === "GET" && request.body !== undefined) throw new Error("GET requests cannot have a body");
  return request as unknown as RemoteRequest;
}

function parseTerminalCommand(value: unknown): RemoteTerminalCommand {
  const message = object(value);
  if (typeof message.id !== "string" || !/^[1-9][0-9]{0,15}$/.test(message.id) || !Number.isSafeInteger(Number(message.id)) ||
      typeof message.token !== "string" || !/^[\x21-\x7e]{32,200}$/.test(message.token) || Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST_BYTES)
    throw new Error("Invalid terminal command");
  if (message.type === "terminal-open") {
    if (typeof message.sessionId !== "string" || !UUID.test(message.sessionId) || typeof message.clientId !== "string" || !UUID.test(message.clientId) ||
        !Number.isSafeInteger(message.after) || Number(message.after) < 0 || typeof message.snapshot !== "boolean" || Object.keys(message).length !== 7)
      throw new Error("Invalid terminal attachment");
  } else {
    if (typeof message.streamId !== "string" || !/^[1-9][0-9]{0,15}$/.test(message.streamId)) throw new Error("Invalid terminal stream");
    if (message.type === "terminal-send") {
      object(message.message);
      if (Object.keys(message).length !== 5) throw new Error("Invalid terminal input");
    } else if (message.type !== "terminal-close" || Object.keys(message).length !== 4) throw new Error("Invalid terminal command");
  }
  return message as unknown as RemoteTerminalCommand;
}

function parseEventsCommand(value: unknown): RemoteEventsCommand {
  const message = object(value);
  if (typeof message.id !== "string" || !/^[1-9][0-9]{0,15}$/.test(message.id) || !Number.isSafeInteger(Number(message.id)) ||
      typeof message.token !== "string" || !/^[\x21-\x7e]{32,200}$/.test(message.token) || Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST_BYTES)
    throw new Error("Invalid events command");
  if (message.type === "events-open") {
    if (!Array.isArray(message.topics) || !message.topics.length || message.topics.length > 16 || new Set(message.topics).size !== message.topics.length ||
        message.topics.some(topic => typeof topic !== "string" || (topic !== "sessions" && topic !== "teams" && !/^session\/[0-9a-f-]{36}$/i.test(topic))) ||
        !Number.isSafeInteger(message.after) || Number(message.after) < 0 || Object.keys(message).length !== 5)
      throw new Error("Invalid events subscription");
  } else if (message.type !== "events-close" || typeof message.streamId !== "string" || !/^[1-9][0-9]{0,15}$/.test(message.streamId) || Object.keys(message).length !== 4)
    throw new Error("Invalid events command");
  return message as unknown as RemoteEventsCommand;
}

export function connectRemoteAccess(server: Server, config: Config): () => void {
  if (!config.remote?.enabled) return () => {};
  if (runtimeSecurity(config.deployment).tenancy !== "single-tenant") throw new Error("Remote machine access requires a single-tenant runner");
  const machineId = config.machine?.id;
  if (!machineId || !UUID.test(machineId)) throw new Error("Remote access requires a stable machine identifier");
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_FRAME, perMessageDeflate: false });
  const peers = new Set<{ close: () => void }>();
  let closed = false, activeRequests = 0, teamListTooLargeAt = -Infinity;
  let relay: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, retryMs = 1000;
  const relayPeers = new Map<string, { receive: (text: string) => void; close: () => void }>();
  const tokenKeys = () => config.tokens.map(device => keyFromHash(device.hash));

  const peer = (send: (text: string, onSent?: () => void) => boolean, terminate: () => void) => {
    let channel: CipherChannel | undefined, authenticatedKey: Uint8Array | undefined, dead = false, pending = 0, lastId = 0;
    const controllers = new Set<AbortController>();
    const terminals = new Map<string, WebSocket>();
    const eventStreams = new Map<string, { controller: AbortController; buffered: number }>();
    const timeout = setTimeout(() => close(), HANDSHAKE_TIMEOUT_MS); timeout.unref();
    const revocation = setInterval(() => { if (authenticatedKey && !authorized()) close(); }, 1000); revocation.unref();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const handle = { receive, close };
    peers.add(handle);
    function close() {
      if (dead) return;
      dead = true; clearTimeout(timeout); clearTimeout(idle); clearInterval(revocation); channel?.destroy(); authenticatedKey?.fill(0);
      for (const controller of controllers) controller.abort();
      for (const terminal of terminals.values()) terminal.terminate();
      terminals.clear();
      for (const stream of eventStreams.values()) stream.controller.abort();
      eventStreams.clear();
      peers.delete(handle); terminate();
    }
    function authorized() {
      return authenticatedKey && config.tokens.some(device => {
        const candidate = keyFromHash(device.hash);
        const matches = equalBytes(candidate, authenticatedKey!); candidate.fill(0); return matches;
      });
    }
    function refreshIdle() {
      clearTimeout(timeout); clearTimeout(idle);
      idle = setTimeout(close, 90000); idle.unref();
    }
    function reply(response: RemoteResponse | RemoteTerminalEvent | RemoteEventsEvent, onSent?: () => void) {
      if (dead || !channel) return;
      if (!authorized()) { close(); return; }
      try { if (!send(JSON.stringify(channel.seal(response)), onSent)) close(); }
      catch { close(); }
    }
    function stopEvents(streamId: string, code: number, notify = true, reason?: string) {
      const stream = eventStreams.get(streamId);
      if (!stream) return;
      eventStreams.delete(streamId); stream.controller.abort();
      if (notify) reply({ type: "events-closed", streamId, code, ...(reason ? { reason } : {}) });
    }
    async function events(command: RemoteEventsCommand) {
      if (command.type === "events-close") { stopEvents(command.streamId, 1000); return; }
      if (eventStreams.size >= MAX_EVENTS_STREAMS) {
        reply({ type: "response", id: command.id, status: 429, body: { error: "Too many open event streams", code: "busy" } }); return;
      }
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Runner is not listening");
      const controller = new AbortController(), stream = { controller, buffered: 0 };
      eventStreams.set(command.id, stream);
      const query = new URLSearchParams({ topics: command.topics.join(","), after: String(command.after) });
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/events?${query}`, {
          headers: { Authorization: `Bearer ${command.token}`, Accept: "text/event-stream" }, redirect: "error", signal: controller.signal,
        });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
          const body = await response.json().catch(() => ({}));
          eventStreams.delete(command.id);
          reply({ type: "response", id: command.id, status: response.status || 502, body }); return;
        }
        reply({ type: "response", id: command.id, status: 200, body: { streamId: command.id } });
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let pendingText = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pendingText += decoder.decode(chunk.value, { stream: true });
          let boundary: number;
          while ((boundary = pendingText.indexOf("\n\n")) >= 0) {
            const frame = pendingText.slice(0, boundary); pendingText = pendingText.slice(boundary + 2);
            const lines = frame.split(/\r?\n/);
            const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
            const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            if (event === "close") {
              const close = object(JSON.parse(data));
              const reason = typeof close.reason === "string" ? close.reason.slice(0, 160) : "Runner closed the live event stream";
              stopEvents(command.id, 1013, true, reason); return;
            }
            const size = Buffer.byteLength(data);
            if (size > MAX_EVENTS_EVENT_BYTES) {
              stopEvents(command.id, 1013, true, "Live event exceeds the remote event limit"); return;
            }
            const update = object(JSON.parse(data));
            if (typeof update.topic !== "string" || !("data" in update)) throw new Error("Invalid live event");
            const eventBytes = Buffer.byteLength(JSON.stringify({ topic: update.topic, data: update.data }));
            if (stream.buffered + eventBytes > MAX_EVENTS_BUFFERED_BYTES) {
              stopEvents(command.id, 1013, true, "Remote event stream buffer limit exceeded"); return;
            }
            stream.buffered += eventBytes;
            reply({ type: "events-event", streamId: command.id, topic: update.topic, data: update.data }, () => { stream.buffered = Math.max(0, stream.buffered - eventBytes); });
          }
          if (Buffer.byteLength(pendingText) > MAX_EVENTS_EVENT_BYTES + 128) {
            stopEvents(command.id, 1013, true, "Unfinished live event exceeds the remote event limit"); return;
          }
        }
        stopEvents(command.id, 1000);
      } catch {
        if (eventStreams.has(command.id)) stopEvents(command.id, 1013);
      }
    }
    function terminal(command: RemoteTerminalCommand) {
      if (command.type !== "terminal-open") {
        const upstream = terminals.get(command.streamId);
        if (!upstream) {
          reply({ type: "terminal-closed", streamId: command.streamId, code: 1008 }); return;
        }
        if (command.type === "terminal-close") { upstream.close(1000); return; }
        const text = JSON.stringify(command.message);
        if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount + Buffer.byteLength(text) > MAX_TERMINAL_BUFFERED_BYTES) {
          upstream.terminate(); return;
        }
        upstream.send(text, error => { if (error) upstream.terminate(); }); return;
      }
      if (terminals.size >= MAX_TERMINAL_STREAMS) {
        reply({ type: "response", id: command.id, status: 429, body: { error: "Too many open terminals", code: "busy" } }); return;
      }
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Runner is not listening");
      const path = `/api/sessions/${command.sessionId}/terminal?after=${command.after}&snapshot=${command.snapshot ? 1 : 0}`;
      const upstream = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
        headers: { Host: new URL(config.origin).host }, maxPayload: MAX_RESPONSE_BYTES, perMessageDeflate: false, handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
      terminals.set(command.id, upstream);
      let opened = false;
      upstream.on("open", () => {
        if (dead || !authorized()) { close(); return; }
        opened = true;
        reply({ type: "response", id: command.id, status: 200, body: { streamId: command.id } });
        upstream.send(JSON.stringify({ token: command.token, clientId: command.clientId }), error => { if (error) upstream.terminate(); });
      });
      upstream.on("message", (data, binary) => {
        try {
          if (dead) return;
          if (binary || Buffer.byteLength(data.toString()) > MAX_RESPONSE_BYTES) throw new Error("Invalid terminal output");
          refreshIdle();
          reply({ type: "terminal-event", streamId: command.id, message: object(JSON.parse(data.toString())) });
        } catch { upstream.terminate(); }
      });
      upstream.on("error", () => upstream.terminate());
      upstream.on("close", code => {
        terminals.delete(command.id);
        if (opened) reply({ type: "terminal-closed", streamId: command.id, code });
        else reply({ type: "response", id: command.id, status: 502, body: { error: "Terminal could not connect", code: "terminal-unavailable" } });
      });
    }
    async function forward(request: RemoteRequest) {
      const controller = new AbortController(); controllers.add(controller);
      const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); deadline.unref();
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Runner is not listening");
        const headers: Record<string, string> = { Authorization: `Bearer ${request.token}`, "Content-Type": "application/json" };
        for (const [name, value] of Object.entries(request.headers ?? {})) {
          if (["x-infinite-client", "x-infinite-control"].includes(name.toLowerCase())) headers[name] = value;
        }
        const read = async (path: string) => {
          const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
            method: request.method, headers, redirect: "error", signal: controller.signal,
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
          });
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          if (reader) for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); return undefined; }
            chunks.push(chunk.value);
          }
          let body: unknown;
          try { body = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; }
          catch { throw new Error("Runner returned a non-JSON response"); }
          return { status: response.status, body };
        };
        const fullTeamList = request.method === "GET" && request.path === "/api/teams";
        const skipFull = fullTeamList && Date.now() - teamListTooLargeAt < TEAM_LIST_RETRY_MS;
        let result = skipFull ? undefined : await read(request.path);
        if (!result && fullTeamList) {
          if (!skipFull) teamListTooLargeAt = Date.now();
          result = await read("/api/teams?view=list");
        }
        if (!result) { reply({ type: "response", id: request.id, status: 413, body: { error: "Machine response exceeds the remote limit", code: "response-too-large" } }); return; }
        reply({ type: "response", id: request.id, status: result.status, body: result.body });
      } catch {
        reply({ type: "response", id: request.id, status: 502, body: {
          error: request.method === "GET" ? "Machine request failed. Refresh to reconnect." : "Delivery may be uncertain. Refresh the session before retrying.",
          code: request.method === "GET" ? "upstream-unavailable" : "delivery-unknown",
        } });
      } finally { clearTimeout(deadline); controllers.delete(controller); pending--; activeRequests--; }
    }
    function receive(text: string) {
      try {
        if (dead || text.length > MAX_REQUEST_FRAME) { close(); return; }
        const frame: unknown = JSON.parse(text);
        if (!channel) {
          const hello = parseClientHello(frame);
          if (hello.machineId !== "" && hello.machineId !== machineId) throw new Error("Wrong machine");
          const candidates = tokenKeys();
          authenticatedKey = candidates.find(key => matchesClientHello(key, hello));
          for (const key of candidates) if (key !== authenticatedKey) key.fill(0);
          if (!authenticatedKey) throw new Error("Unknown device");
          const welcome = createServerHello(authenticatedKey, hello, machineId!, randomBytes);
          channel = createCipherChannel(authenticatedKey, hello, welcome, "server");
          if (!send(JSON.stringify(welcome))) close();
          return;
        }
        const value = object(channel.open(frame));
        const request = value.type === "request" ? parseRequest(value) : value.type === "events-open" || value.type === "events-close" ? parseEventsCommand(value) : parseTerminalCommand(value);
        const suppliedKey = tokenKey(request.token);
        const matches = !!authenticatedKey && equalBytes(suppliedKey, authenticatedKey) && authorized();
        suppliedKey.fill(0);
        if (!matches || Number(request.id) <= lastId) throw new Error("Device revoked or request replayed");
        refreshIdle();
        lastId = Number(request.id);
        if (request.type === "events-open" || request.type === "events-close") { void events(request); return; }
        if (request.type !== "request") { terminal(request); return; }
        if (!allowedPath(request.method, request.path)) {
          reply({ type: "response", id: request.id, status: 403, body: { error: "This endpoint is unavailable through remote machine access", code: "remote-endpoint-denied" } }); return;
        }
        if (request.method === "POST" && request.path.split("?")[0] === "/api/sessions" && request.body && typeof request.body === "object" &&
            ["workspace", "nativeArgs", "localUi"].some(field => field in (request.body as Record<string, unknown>))) {
          reply({ type: "response", id: request.id, status: 403, body: { error: "Native launch options require the paired machine CLI", code: "remote-endpoint-denied" } }); return;
        }
        if (pending >= MAX_PENDING_REQUESTS || activeRequests >= MAX_ACTIVE_REQUESTS) {
          reply({ type: "response", id: request.id, status: 429, body: { error: "Too many pending machine requests", code: "busy" } }); return;
        }
        pending++; activeRequests++;
        void forward(request);
      } catch { close(); }
    }
    return handle;
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url?.split("?")[0] !== "/api/remote") return;
    socket.on("error", () => {});
    const origin = new URL(config.origin);
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : config.port;
    const allowedHosts = [origin.host, `127.0.0.1:${port}`, `localhost:${port}`];
    if (closed || req.url !== "/api/remote" || !allowedHosts.includes(req.headers.host ?? "") || peers.size >= MAX_CHANNELS) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const active = peer((text, onSent) => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + Buffer.byteLength(text) > MAX_BUFFERED_BYTES) return false;
        ws.send(text, error => { if (error) active.close(); else onSent?.(); }); return true;
      }, () => ws.terminate());
      let alive = true;
      const heartbeat = setInterval(() => { if (!alive) active.close(); else { alive = false; ws.ping(); } }, 15000); heartbeat.unref();
      ws.on("pong", () => { alive = true; });
      ws.on("message", (data, binary) => binary ? active.close() : active.receive(data.toString()));
      ws.on("error", active.close);
      ws.on("close", () => { clearInterval(heartbeat); active.close(); });
    });
  };
  server.on("upgrade", upgrade);

  let registrationToken: string | undefined, relayUrl: string | undefined;
  if (config.remote.relay) {
    const { tokenFile, url } = config.remote.relay;
    if (!isAbsolute(tokenFile) || (statSync(tokenFile).mode & 0o077) !== 0) throw new Error("Relay registration token must be an absolute private file");
    registrationToken = readFileSync(tokenFile, "utf8").trim();
    if (!/^[\x21-\x7e]{32,200}$/.test(registrationToken)) throw new Error("Relay registration requires a high-entropy token");
    relayUrl = remoteSocketUrl(url, `/relay/hosts/${machineId}`);
  }

  function startRelay() {
    if (closed || !relayUrl || !registrationToken || relay) return;
    const ws = new WebSocket(relayUrl, { headers: { Authorization: `Bearer ${registrationToken}` }, maxPayload: MAX_REQUEST_FRAME + 1024, perMessageDeflate: false });
    relay = ws;
    let dropped = false, alive = true;
    const drop = () => {
      if (dropped) return;
      dropped = true; clearInterval(heartbeat); clearTimeout(connectTimeout);
      if (relay === ws) relay = undefined;
      for (const active of relayPeers.values()) active.close();
      relayPeers.clear(); ws.terminate();
      if (!closed) {
        retry = setTimeout(startRelay, retryMs + randomBytes(1)[0] * 4); retry.unref();
        retryMs = Math.min(retryMs * 2, 30000);
      }
    };
    const connectTimeout = setTimeout(drop, HANDSHAKE_TIMEOUT_MS); connectTimeout.unref();
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || !alive) { drop(); return; }
      alive = false; ws.ping();
    }, 15000); heartbeat.unref();
    const send = (frame: RelayEnvelope, onSent?: () => void) => {
      const text = JSON.stringify(frame);
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + Buffer.byteLength(text) > MAX_BUFFERED_BYTES) { drop(); return false; }
      ws.send(text, error => { if (error) drop(); else onSent?.(); }); return true;
    };
    ws.on("open", () => { clearTimeout(connectTimeout); retryMs = 1000; });
    ws.on("pong", () => { alive = true; });
    ws.on("error", drop); ws.on("close", drop);
    ws.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Invalid relay frame");
        const frame = parseRelayEnvelope(data.toString());
        if (frame.type === "open") {
          if (relayPeers.has(frame.id)) throw new Error("Duplicate relay channel");
          if (peers.size >= MAX_CHANNELS) { send({ type: "close", id: frame.id }); return; }
          const active = peer((text, onSent) => send({ type: "data", id: frame.id, data: text }, onSent), () => {
            relayPeers.delete(frame.id);
            if (!dropped) send({ type: "close", id: frame.id });
          });
          relayPeers.set(frame.id, active);
        } else if (frame.type === "close") relayPeers.get(frame.id)?.close();
        else relayPeers.get(frame.id)?.receive(frame.data);
      } catch { drop(); }
    });
  }
  if (server.listening) startRelay(); else server.once("listening", startRelay);
  function close() {
    if (closed) return;
    closed = true; clearTimeout(retry); server.off("listening", startRelay); server.off("upgrade", upgrade);
    for (const active of peers) active.close();
    relay?.terminate(); relay = undefined;
    sockets.close();
  }
  server.once("close", close);
  return close;
}
