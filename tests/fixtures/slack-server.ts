import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { IntakeThread } from "../../packages/host/src/intake-types.js";

interface StoredMessage {
  channel: string; threadTs: string; ts: string; text: string;
  user?: string; botId?: string; metadata?: { event_type: string; event_payload: { key: string } };
}

const bindingKey = (channelId: string, threadTs: string) => `${channelId}:${threadTs}`;
const FORM_METHODS = new Set(["auth.test", "conversations.replies", "apps.connections.open", "chat.getPermalink"]);
const toMicros = (ts: string) => {
  const [seconds, fraction = ""] = ts.split(".");
  return Number(seconds) * 1_000_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
};
const fromMicros = (micros: number) => `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;

export async function startSlackServer(options: { teamId?: string; botUserId?: string } = {}) {
  const teamId = options.teamId ?? "T00000000", botUserId = options.botUserId ?? "U00000001", botId = "B00000000";
  const appToken = `xapp-1-${randomBytes(12).toString("hex")}`;
  const botToken = `xoxb-${randomBytes(12).toString("hex")}`;
  const directory = mkdtempSync(join(tmpdir(), "slack-fixture-"));
  const appTokenFile = join(directory, "app-token");
  const botTokenFile = join(directory, "bot-token");
  writeFileSync(appTokenFile, `${appToken}\n`, { mode: 0o600 });
  writeFileSync(botTokenFile, `${botToken}\n`, { mode: 0o600 });

  let latest = toMicros("1700000000.000000");
  const nextTs = () => fromMicros(++latest);
  const observe = (ts: string) => { latest = Math.max(latest, toMicros(ts)); };
  const threads = new Map<string, StoredMessage[]>();
  const hidden = new Set<string>();
  const posts: StoredMessage[] = [];
  const postPayloads: Record<string, any>[] = [];
  const calls: { method: string; token: string; body?: Record<string, any> }[] = [];
  const reactions = new Set<string>();
  const acked: string[] = [];
  const sent = new Map<string, string>();
  const sockets = new Set<WebSocket>();
  let socketAddress: string | undefined;
  let loseNext = false, down = false, limited = false;

  const messagePayload = (message: StoredMessage) => ({
    ts: message.ts, text: message.text, ...(message.user ? { user: message.user } : {}),
    ...(message.botId ? { bot_id: message.botId } : {}), ...(message.metadata ? { metadata: message.metadata } : {}),
  });

  let port = 0;
  const httpServer = createServer(async (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    try {
      const method = request.url?.match(/^\/api\/([\w.]+)$/)?.[1];
      if (request.method !== "POST" || !method) { reply(404, { ok: false, error: "unknown_method" }); return; }
      const token = bearer(request);
      const call = { method, token } as { method: string; token: string; body?: Record<string, any> };
      calls.push(call);
      if (down) { reply(503, { ok: false, error: "service_unavailable" }); return; }
      if (limited) { response.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "30" }).end("ratelimited"); return; }
      const raw = await readBody(request);
      let body: Record<string, any>;
      if (FORM_METHODS.has(method)) {
        if (!(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) { reply(200, { ok: false, error: "invalid_arguments" }); return; }
        body = Object.fromEntries(new URLSearchParams(raw));
      } else body = JSON.parse(raw || "{}");
      call.body = body;
      const appMethod = method === "apps.connections.open";
      if (appMethod ? !token.startsWith("xapp-") : !token.startsWith("xoxb-")) { reply(200, { ok: false, error: "invalid_auth" }); return; }
      switch (method) {
        case "auth.test":
          reply(200, { ok: true, team_id: teamId, user_id: botUserId, bot_id: botId }); return;
        case "apps.connections.open":
          reply(200, { ok: true, url: socketAddress ?? `ws://127.0.0.1:${port}/socket` }); return;
        case "conversations.replies": {
          const key = bindingKey(body.channel, body.ts);
          if (hidden.has(body.channel)) { reply(200, { ok: false, error: "not_in_channel" }); return; }
          const all = threads.get(key);
          if (!all) { reply(200, { ok: false, error: "thread_not_found" }); return; }
          const limit = Math.min(Number(body.limit) || 100, 1000);
          const offset = body.cursor ? Number(Buffer.from(body.cursor, "base64").toString()) : 0;
          const page = all.slice(offset, offset + limit);
          const next = offset + limit < all.length ? Buffer.from(String(offset + limit)).toString("base64") : "";
          reply(200, { ok: true, messages: page.map(messagePayload), has_more: next !== "", response_metadata: { next_cursor: next } }); return;
        }
        case "chat.getPermalink": {
          if (typeof body.channel !== "string" || typeof body.message_ts !== "string") { reply(200, { ok: false, error: "invalid_arguments" }); return; }
          reply(200, { ok: true, channel: body.channel, permalink: `https://example.slack.com/archives/${body.channel}/p${body.message_ts.replace(".", "")}` }); return;
        }
        case "chat.postMessage": {
          postPayloads.push(body);
          const message: StoredMessage = {
            channel: body.channel, threadTs: body.thread_ts, ts: nextTs(), text: body.text,
            user: botUserId, botId, metadata: body.metadata,
          };
          posts.push(message);
          const list = threads.get(bindingKey(body.channel, body.thread_ts));
          list?.push(message);
          if (loseNext) { loseNext = false; request.socket.destroy(); return; }
          reply(200, { ok: true, channel: body.channel, ts: message.ts }); return;
        }
        case "reactions.add": {
          if (![body.channel, body.timestamp, body.name].every(value => typeof value === "string" && value !== "")) {
            reply(200, { ok: false, error: "invalid_arguments" }); return;
          }
          const key = `${body.channel}:${body.timestamp}:${body.name}`;
          if (reactions.has(key)) { reply(200, { ok: false, error: "already_reacted" }); return; }
          reactions.add(key);
          reply(200, { ok: true }); return;
        }
        default:
          reply(200, { ok: false, error: "unknown_method" });
      }
    } catch {
      reply(400, { ok: false, error: "invalid_request" });
    }
  });

  const socketServer = new WebSocketServer({ server: httpServer, path: "/socket" });
  socketServer.on("connection", socket => {
    sockets.add(socket);
    socket.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (typeof frame.envelope_id === "string") acked.push(frame.envelope_id);
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.send(JSON.stringify({ type: "hello" }));
  });

  await new Promise<void>((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(0, "127.0.0.1", resolve); });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Slack fixture needs a TCP address");
  port = address.port;
  const endpoint = `http://127.0.0.1:${port}/api`;

  const connected = () => [...sockets].find(socket => socket.readyState === WebSocket.OPEN);
  const sendFrame = async (envelopeId: string, frame: string) => {
    const socket = connected();
    if (!socket) throw new Error("No Slack Socket Mode connection is open");
    sent.set(envelopeId, frame);
    await new Promise<void>((resolve, reject) => socket.send(frame, error => error ? reject(error) : resolve()));
    return envelopeId;
  };

  return {
    endpoint, appTokenFile, botTokenFile, teamId, botUserId, botId,
    seedThread(binding: IntakeThread, messages: { user?: string; botId?: string; text: string; ts?: string; key?: string }[]) {
      const key = bindingKey(binding.channelId, binding.threadTs);
      const list = threads.get(key) ?? [];
      for (const message of messages) {
        const ts = message.ts ?? (list.length === 0 ? binding.threadTs : nextTs());
        observe(ts);
        list.push({
          channel: binding.channelId, threadTs: binding.threadTs, ts, text: message.text,
          ...(message.user ? { user: message.user } : {}), ...(message.botId ? { botId: message.botId } : {}),
          ...(message.key ? { metadata: { event_type: "infinite_intake", event_payload: { key: message.key } } } : {}),
        });
      }
      threads.set(key, list);
    },
    hide(channelId: string) { hidden.add(channelId); },
    posts(binding: IntakeThread) {
      return posts.filter(post => post.channel === binding.channelId && post.threadTs === binding.threadTs)
        .map(post => ({ text: post.text, key: post.metadata?.event_payload.key ?? "", ts: post.ts }));
    },
    postPayloads(binding: IntakeThread) {
      return postPayloads.filter(payload => payload.channel === binding.channelId && payload.thread_ts === binding.threadTs);
    },
    async emit(event: Record<string, unknown>, emitOptions: { teamId?: string; eventId?: string } = {}) {
      const envelopeId = randomUUID();
      return sendFrame(envelopeId, JSON.stringify({
        envelope_id: envelopeId, type: "events_api", accepts_response_payload: false,
        payload: { type: "event_callback", team_id: emitOptions.teamId ?? teamId, event_id: emitOptions.eventId ?? `Ev${randomUUID()}`, event },
      }));
    },
    async emitRaw(type: string, payload: Record<string, unknown> = {}) {
      const envelopeId = randomUUID();
      return sendFrame(envelopeId, JSON.stringify({ envelope_id: envelopeId, type, accepts_response_payload: false, payload }));
    },
    async emitInteraction(payload: Record<string, unknown>) {
      const envelopeId = randomUUID();
      return sendFrame(envelopeId, JSON.stringify({ envelope_id: envelopeId, type: "interactive", accepts_response_payload: true, payload }));
    },
    acks() { return [...acked]; },
    async redeliver(envelopeId: string) {
      const frame = sent.get(envelopeId);
      if (!frame) throw new Error("Cannot redeliver: unknown envelope");
      await sendFrame(envelopeId, frame);
    },
    loseNextPostResponse() { loseNext = true; },
    unavailable(value: boolean) { down = value; },
    rateLimited(value: boolean) { limited = value; },
    returnSocketAddress(url: string) { socketAddress = url; },
    dropSocket() { for (const socket of sockets) socket.terminate(); },
    get calls() { return calls; },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => socketServer.close(() => resolve()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function bearer(request: IncomingMessage) {
  return (request.headers.authorization ?? "").replace(/^Bearer\s+/, "");
}

async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
