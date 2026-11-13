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
/** Methods whose arguments Slack reads only from a form body; a JSON body is refused, as Slack ignores its arguments. */
const FORM_METHODS = new Set(["auth.test", "conversations.replies", "apps.connections.open"]);
/** Slack timestamps are microseconds since the epoch written as `seconds.micros`; comparing them as integers keeps order exact. */
const toMicros = (ts: string) => {
  const [seconds, fraction = ""] = ts.split(".");
  return Number(seconds) * 1_000_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
};
const fromMicros = (micros: number) => `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;

/** A loopback fake of the Slack Web API and Socket Mode, with the failure modes the intake client must survive. */
export async function startSlackServer(options: { teamId?: string; botUserId?: string } = {}) {
  const teamId = options.teamId ?? "T00000000", botUserId = options.botUserId ?? "U00000001", botId = "B00000000";
  const appToken = `xapp-1-${randomBytes(12).toString("hex")}`;
  const botToken = `xoxb-${randomBytes(12).toString("hex")}`;
  const directory = mkdtempSync(join(tmpdir(), "slack-fixture-"));
  const appTokenFile = join(directory, "app-token");
  const botTokenFile = join(directory, "bot-token");
  writeFileSync(appTokenFile, `${appToken}\n`, { mode: 0o600 });
  writeFileSync(botTokenFile, `${botToken}\n`, { mode: 0o600 });

  // One clock for the whole fixture: every generated timestamp is later than every timestamp already in use.
  let latest = toMicros("1700000000.000000");
  const nextTs = () => fromMicros(++latest);
  const observe = (ts: string) => { latest = Math.max(latest, toMicros(ts)); };
  const threads = new Map<string, StoredMessage[]>();
  const hidden = new Set<string>();
  const posts: StoredMessage[] = [];
  const calls: { method: string; token: string }[] = [];
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
      calls.push({ method, token });
      if (down) { reply(503, { ok: false, error: "service_unavailable" }); return; }
      if (limited) { response.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "30" }).end("ratelimited"); return; }
      const raw = await readBody(request);
      let body: Record<string, any>;
      if (FORM_METHODS.has(method)) {
        if (!(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) { reply(200, { ok: false, error: "invalid_arguments" }); return; }
        body = Object.fromEntries(new URLSearchParams(raw));
      } else body = JSON.parse(raw || "{}");
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
        case "chat.postMessage": {
          const message: StoredMessage = {
            channel: body.channel, threadTs: body.thread_ts, ts: nextTs(), text: body.text,
            user: botUserId, botId, metadata: body.metadata,
          };
          // The post is stored before a lost response is dropped, so a retry can find it.
          posts.push(message);
          const list = threads.get(bindingKey(body.channel, body.thread_ts));
          list?.push(message);
          if (loseNext) { loseNext = false; request.socket.destroy(); return; }
          reply(200, { ok: true, channel: body.channel, ts: message.ts }); return;
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
    /**
     * Seeds a thread whose replies Slack would return. The first message of an empty thread without a `ts` is the root
     * and takes the binding's thread timestamp. Other messages without a `ts` get a timestamp later than every timestamp
     * already in use, so they sort after everything seeded or posted before them.
     */
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
    /** conversations.replies answers not_in_channel for this channel. */
    hide(channelId: string) { hidden.add(channelId); },
    posts(binding: IntakeThread) {
      return posts.filter(post => post.channel === binding.channelId && post.threadTs === binding.threadTs)
        .map(post => ({ text: post.text, key: post.metadata?.event_payload.key ?? "", ts: post.ts }));
    },
    /** Sends an events_api envelope on the open Socket Mode connection and resolves with its envelope ID once sent. */
    async emit(event: Record<string, unknown>, emitOptions: { teamId?: string; eventId?: string } = {}) {
      const envelopeId = randomUUID();
      return sendFrame(envelopeId, JSON.stringify({
        envelope_id: envelopeId, type: "events_api", accepts_response_payload: false,
        payload: { type: "event_callback", team_id: emitOptions.teamId ?? teamId, event_id: emitOptions.eventId ?? `Ev${randomUUID()}`, event },
      }));
    },
    /** Sends an envelope of any Socket Mode type with the given payload, for envelopes other than events_api. */
    async emitRaw(type: string, payload: Record<string, unknown> = {}) {
      const envelopeId = randomUUID();
      return sendFrame(envelopeId, JSON.stringify({ envelope_id: envelopeId, type, accepts_response_payload: false, payload }));
    },
    acks() { return [...acked]; },
    /** Sends the same envelope again, as Slack does for an envelope that was not acknowledged. */
    async redeliver(envelopeId: string) {
      const frame = sent.get(envelopeId);
      if (!frame) throw new Error("Cannot redeliver: unknown envelope");
      await sendFrame(envelopeId, frame);
    },
    /** The next chat.postMessage is stored, then its HTTP response is dropped. */
    loseNextPostResponse() { loseNext = true; },
    /** Every Web API call answers 503 while true. */
    unavailable(value: boolean) { down = value; },
    /** Every Web API call answers HTTP 429 with the body "ratelimited" while true. */
    rateLimited(value: boolean) { limited = value; },
    /** Replaces the WebSocket address that apps.connections.open returns. */
    returnSocketAddress(url: string) { socketAddress = url; },
    /** Terminates the open Socket Mode connection, as Slack does before it reconnects a client. */
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
