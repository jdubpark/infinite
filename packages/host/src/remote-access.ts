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

function allowedPath(method: RemoteMethod, path: string): boolean {
  if (path.length > 8192 || !path.startsWith("/api/") || path.includes("\\") || path.includes("#") || /[\x00-\x20]/.test(path)) return false;
  const url = new URL(path, "http://infinite.invalid");
  // Reject normalization tricks and encoded route delimiters. File names belong in the query.
  if (url.pathname !== path.split("?")[0] || /%/i.test(url.pathname)) return false;
  if (method === "GET" && url.pathname === "/api/me") return true;
  if (method === "GET" && url.pathname === "/api/machine/resources") return true;
  if (["GET", "POST"].includes(method) && url.pathname === "/api/sessions") return true;
  if (["GET", "POST"].includes(method) && url.pathname === "/api/teams") return true;
  if (["GET", "POST"].includes(method) && url.pathname === "/api/goals") return true;
  const goal = /^\/api\/goals\/([^/]+)(?:\/(steer|pause|resume|cancel|outcome))?$/.exec(url.pathname);
  if (goal && UUID.test(goal[1])) return method === "GET" ? !goal[2] : method === "POST" && Boolean(goal[2]);
  const team = /^\/api\/teams\/([^/]+)(?:\/(steer|pause|resume|cancel|decisions\/([^/]+)\/answer))?$/.exec(url.pathname);
  if (team && UUID.test(team[1])) return method === "GET" ? !team[2]
    : method === "POST" && Boolean(team[2]) && (!team[3] || UUID.test(team[3]));
  if (["POST", "DELETE"].includes(method) && url.pathname === "/api/devices/push") return true;
  if (["GET", "PUT"].includes(method) && /^\/api\/projects\/[a-z0-9-]{1,80}\/context$/.test(url.pathname)) return true;
  if (method === "GET" && /^\/api\/projects\/[a-z0-9-]{1,80}$/.test(url.pathname)) return true;
  if (method === "POST" && /^\/api\/projects\/[a-z0-9-]{1,80}\/sync\/apply$/.test(url.pathname)) return true;
  if (method === "GET" && /^\/api\/projects\/[a-z0-9-]{1,80}\/files$/.test(url.pathname)) return true;
  if (["GET", "DELETE"].includes(method) && /^\/api\/projects\/[a-z0-9-]{1,80}\/file$/.test(url.pathname)) return true;
  if (method === "POST" && /^\/api\/projects\/[a-z0-9-]{1,80}\/uploads$/.test(url.pathname)) return true;
  if (method === "POST" && /^\/api\/projects\/[a-z0-9-]{1,80}\/directories$/.test(url.pathname)) return true;
  const upload = /^\/api\/projects\/[a-z0-9-]{1,80}\/uploads\/([^/]+)(\/commit)?$/.exec(url.pathname);
  if (upload && UUID.test(upload[1]) && (upload[2] ? method === "POST" : ["PUT", "DELETE"].includes(method))) return true;
  const match = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match || !UUID.test(match[1])) return false;
  return method === "GET" ? [undefined, "events", "messages", "summary", "file", "handoff"].includes(match[2])
    : method === "POST" && ["control", "input", "answer", "key", "stop", "resize", "resume"].includes(match[2]);
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

/** Existing HTTP authorization remains the authority for roles, revocation and input leases. */
export function connectRemoteAccess(server: Server, config: Config): () => void {
  if (!config.remote?.enabled) return () => {};
  if (runtimeSecurity(config.deployment).tenancy !== "single-tenant") throw new Error("Remote machine access requires a single-tenant runner");
  const machineId = config.machine?.id;
  if (!machineId || !UUID.test(machineId)) throw new Error("Remote access requires a stable machine identifier");
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_FRAME, perMessageDeflate: false });
  const peers = new Set<{ close: () => void }>();
  let closed = false, activeRequests = 0;
  let relay: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, retryMs = 1000;
  const relayPeers = new Map<string, { receive: (text: string) => void; close: () => void }>();
  const tokenKeys = () => config.tokens.map(device => keyFromHash(device.hash));

  const peer = (send: (text: string, onSent?: () => void) => boolean, terminate: () => void) => {
    let channel: CipherChannel | undefined, authenticatedKey: Uint8Array | undefined, dead = false, pending = 0, lastId = 0;
    const controllers = new Set<AbortController>();
    const terminals = new Map<string, WebSocket>();
    const eventStreams = new Map<string, { controller: AbortController; buffered: number }>();
    const timeout = setTimeout(() => close(), HANDSHAKE_TIMEOUT_MS); timeout.unref();
    // Idle terminal subscriptions must also stop after their device is revoked.
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
          // Completed frames are checked independently above; only the unfinished tail is bounded here.
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
      // The only destination is this server's existing authenticated terminal
      // gateway. It owns role checks, input validation, receipts and leases.
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
        const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
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
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            reply({ type: "response", id: request.id, status: 413, body: { error: "Machine response exceeds the remote limit", code: "response-too-large" } }); return;
          }
          chunks.push(chunk.value);
        }
        let body: unknown;
        try { body = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; }
        catch { throw new Error("Runner returned a non-JSON response"); }
        reply({ type: "response", id: request.id, status: response.status, body });
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
        // A replayed client hello cannot pin a channel indefinitely. Complete
        // authentication only after a fresh encrypted request proves key possession.
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
    // This listener owns only the encrypted endpoint; native bridges own their routes.
    if (req.url?.split("?")[0] !== "/api/remote") return;
    socket.on("error", () => {});
    const origin = new URL(config.origin);
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : config.port;
    const allowedHosts = [origin.host, `127.0.0.1:${port}`, `localhost:${port}`];
    if (closed || req.url !== "/api/remote" || !allowedHosts.includes(req.headers.host ?? "") || peers.size >= MAX_CHANNELS) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    // Browser Origins are intentionally accepted here: no cookies or plaintext bearer
    // are consumed, and every message requires the paired-key authenticated channel.
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
        // Reconnect the registration only. No request or mutation is retained for replay.
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
