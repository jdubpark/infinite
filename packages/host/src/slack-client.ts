import { readFileSync } from "node:fs";
import { WebSocket, type RawData } from "ws";
import type { IntakeThread, IntakeThreadReader, SlackThreadMessage } from "./intake-types.js";

/** `transient` marks failures worth retrying later; the code is Slack's error code or a transport label. */
export class SlackError extends Error {
  constructor(readonly code: string, readonly transient: boolean) { super(`Slack request failed: ${code}`); }
}

export interface SlackEnvelope {
  envelopeId: string; teamId?: string; eventId?: string;
  event?: { type: string; user?: string; botId?: string; channel?: string; ts?: string; threadTs?: string; text?: string };
}

const DEFAULT_ENDPOINT = "https://slack.com/api";
const UNREADABLE = new Set(["channel_not_found", "not_in_channel", "thread_not_found"]);
const PAGE_LIMIT = 200;
const MAX_THREAD_MESSAGES = 1000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Slack's Web API and Socket Mode, with bot and app tokens read from files on every call. */
export class SlackClient implements IntakeThreadReader {
  private readonly endpoint: string;

  constructor(private readonly options: { botTokenFile: string; appTokenFile: string; endpoint?: string; timeoutMs?: number }) {
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  }

  async authTest(): Promise<{ teamId: string; userId: string; botId: string }> {
    const data = await this.call("auth.test", "bot", {});
    if (typeof data.team_id !== "string" || typeof data.user_id !== "string" || typeof data.bot_id !== "string") {
      throw new SlackError("invalid_response", false);
    }
    return { teamId: data.team_id, userId: data.user_id, botId: data.bot_id };
  }

  /** Reads the thread oldest first, at most 1,000 messages. A refusal Slack gives for the binding is `unreadable`; an outage throws. */
  async thread(binding: IntakeThread): Promise<SlackThreadMessage[] | "unreadable"> {
    const messages: SlackThreadMessage[] = [];
    let cursor = "";
    do {
      let data: Record<string, any>;
      try {
        data = await this.call("conversations.replies", "bot", {
          channel: binding.channelId, ts: binding.threadTs, limit: PAGE_LIMIT, include_all_metadata: true,
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        if (error instanceof SlackError && !error.transient && UNREADABLE.has(error.code)) return "unreadable";
        throw error;
      }
      for (const message of Array.isArray(data.messages) ? data.messages : []) {
        messages.push(threadMessage(message));
        if (messages.length >= MAX_THREAD_MESSAGES) return messages;
      }
      cursor = typeof data.response_metadata?.next_cursor === "string" ? data.response_metadata.next_cursor : "";
    } while (cursor);
    return messages;
  }

  /** Posts into the bound thread. The key travels as message metadata so a lost response can be found later. */
  async post(binding: IntakeThread, text: string, key: string): Promise<{ ts: string }> {
    const data = await this.call("chat.postMessage", "bot", {
      channel: binding.channelId, thread_ts: binding.threadTs, text,
      metadata: { event_type: "infinite_intake", event_payload: { key } },
    });
    if (typeof data.ts !== "string") throw new SlackError("invalid_response", false);
    return { ts: data.ts };
  }

  /** Opens Socket Mode. The envelope is acknowledged only after `handle` resolves; a rejection leaves it for redelivery. */
  connect(handle: (envelope: SlackEnvelope) => Promise<void>): { close(): void; connected(): boolean } {
    let socket: WebSocket | undefined;
    let ready = false;
    let closed = false;
    let attempts = 0;
    let timer: NodeJS.Timeout | undefined;
    let pending: AbortController | undefined;

    const schedule = () => {
      if (closed) return;
      const wait = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** attempts);
      attempts++;
      timer = setTimeout(() => { timer = undefined; void open(); }, wait);
    };

    const ack = (current: WebSocket, envelopeId: string) => {
      if (socket === current && current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ envelope_id: envelopeId }));
    };

    const receive = (current: WebSocket, raw: RawData) => {
      if (socket !== current) return;
      let frame: Record<string, any>;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type === "hello") { ready = true; attempts = 0; return; }
      if (frame.type === "disconnect") { ready = false; current.close(); return; }
      if (typeof frame.envelope_id !== "string") return;
      const envelopeId = frame.envelope_id;
      // Only events_api envelopes are handled here; other envelope types are acknowledged so Slack does not redeliver them.
      if (frame.type !== "events_api") { ack(current, envelopeId); return; }
      const envelope = toEnvelope(envelopeId, frame.payload);
      Promise.resolve()
        .then(() => handle(envelope))
        .then(() => ack(current, envelopeId), () => undefined);
    };

    const open = async () => {
      if (closed) return;
      pending = new AbortController();
      let url: string;
      try {
        const data = await this.call("apps.connections.open", "app", {}, pending.signal);
        if (typeof data.url !== "string" || !this.allowedSocketAddress(data.url)) throw new SlackError("refused_socket_address", false);
        url = data.url;
      } catch {
        pending = undefined;
        schedule();
        return;
      }
      pending = undefined;
      if (closed) return;
      const current = new WebSocket(url, { handshakeTimeout: this.options.timeoutMs ?? 10_000 });
      socket = current;
      current.on("message", raw => receive(current, raw));
      current.on("error", () => undefined);
      current.on("close", () => {
        if (socket !== current) return;
        socket = undefined;
        ready = false;
        schedule();
      });
    };

    void open();

    return {
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        pending?.abort();
        const current = socket;
        socket = undefined;
        ready = false;
        current?.terminate();
      },
      connected() {
        return ready && socket !== undefined && socket.readyState === WebSocket.OPEN;
      },
    };
  }

  /** wss on a Slack host, or ws on loopback when the endpoint itself is a loopback override. */
  private allowedSocketAddress(address: string) {
    let url: URL;
    try { url = new URL(address); } catch { return false; }
    if (url.protocol === "wss:") return url.hostname.endsWith(".slack.com");
    if (url.protocol === "ws:") return LOOPBACK.has(url.hostname) && LOOPBACK.has(new URL(this.endpoint).hostname);
    return false;
  }

  private token(kind: "bot" | "app") {
    const file = kind === "bot" ? this.options.botTokenFile : this.options.appTokenFile;
    let value: string;
    try { value = readFileSync(file, "utf8").trim(); } catch { throw new SlackError("credential_unavailable", false); }
    if (!value) throw new SlackError("credential_unavailable", false);
    return value;
  }

  private async call(method: string, kind: "bot" | "app", body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
    const secret = this.token(kind);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/${method}`, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (error) {
      throw new SlackError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network", true);
    }
    if (response.status === 429) throw new SlackError("ratelimited", true);
    if (response.status >= 500) throw new SlackError(`http_${response.status}`, true);
    let text: string;
    try { text = await response.text(); } catch { throw new SlackError("network", true); }
    let data: Record<string, any>;
    try { data = JSON.parse(text); } catch { throw new SlackError("invalid_response", false); }
    if (data.ok !== true) throw new SlackError(typeof data.error === "string" ? data.error : "unknown_error", data.error === "ratelimited");
    return data;
  }
}

function threadMessage(raw: Record<string, any>): SlackThreadMessage {
  const key = raw.metadata?.event_type === "infinite_intake" ? raw.metadata.event_payload?.key : undefined;
  return defined({
    ts: String(raw.ts), text: typeof raw.text === "string" ? raw.text : "",
    user: typeof raw.user === "string" ? raw.user : undefined,
    botId: typeof raw.bot_id === "string" ? raw.bot_id : undefined,
    key: typeof key === "string" ? key : undefined,
  });
}

function toEnvelope(envelopeId: string, payload: Record<string, any> | undefined): SlackEnvelope {
  const event = payload?.event;
  return defined({
    envelopeId,
    teamId: typeof payload?.team_id === "string" ? payload.team_id : undefined,
    eventId: typeof payload?.event_id === "string" ? payload.event_id : undefined,
    event: event && typeof event.type === "string" ? defined({
      type: event.type, user: event.user, botId: event.bot_id, channel: event.channel,
      ts: event.ts, threadTs: event.thread_ts, text: event.text,
    }) : undefined,
  });
}

/** Drops absent fields so optional properties are missing rather than undefined. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
