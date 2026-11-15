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
  interaction?: SlackInteraction;
}

export interface SlackAction {
  actionId: string;
  blockId: string;
  actionTs: string;
  value?: string;
  selectedValues?: string[];
}

export interface SlackInteraction {
  type: "block_actions";
  userId: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  actions: SlackAction[];
  state?: Record<string, Record<string, { type: string; selectedValues?: string[]; value?: string }>>;
}

const DEFAULT_ENDPOINT = "https://slack.com/api";
const UNREADABLE = new Set(["channel_not_found", "not_in_channel", "thread_not_found"]);
const PAGE_LIMIT = 200;
const MAX_THREAD_MESSAGES = 1000;
const MAX_THREAD_PAGES = 50;
const MAX_RECONNECT_DELAY_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** Read methods take their arguments from a form body; write methods such as chat.postMessage take JSON. */
const FORM_METHODS = new Set(["auth.test", "conversations.replies", "apps.connections.open", "chat.getPermalink"]);

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

  /**
   * Returns the root message followed by the newest replies, oldest first, at most 1,000 in all.
   * Pages forward to the end of the thread, reading at most 50 pages; a longer thread keeps the window read so far.
   * A refusal Slack gives for the binding is `unreadable`; an outage throws.
   */
  async thread(binding: IntakeThread): Promise<SlackThreadMessage[] | "unreadable"> {
    let root: SlackThreadMessage | undefined;
    const recent: SlackThreadMessage[] = [];
    let cursor = "";
    let pages = 0;
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
      pages++;
      const page = (Array.isArray(data.messages) ? data.messages : []).map(threadMessage);
      if (root === undefined && page.length > 0) root = page.shift();
      recent.push(...page);
      const keep = MAX_THREAD_MESSAGES - 1;
      if (recent.length > keep) recent.splice(0, recent.length - keep);
      cursor = typeof data.response_metadata?.next_cursor === "string" ? data.response_metadata.next_cursor : "";
    } while (cursor && pages < MAX_THREAD_PAGES);
    return root === undefined ? [] : [root, ...recent];
  }

  /** Posts into the bound thread. The key travels as message metadata so a lost response can be found later. */
  async post(binding: IntakeThread, text: string, key: string, blocks?: Record<string, unknown>[]): Promise<{ ts: string }> {
    const data = await this.call("chat.postMessage", "bot", {
      channel: binding.channelId, thread_ts: binding.threadTs, text, mrkdwn: false, parse: "none",
      blocks: blocks ?? [{ type: "markdown", text }],
      metadata: { event_type: "infinite_intake", event_payload: { key } },
    });
    if (typeof data.ts !== "string") throw new SlackError("invalid_response", false);
    return { ts: data.ts };
  }

  /** The message's permanent link (`chat.getPermalink`, bot token). A response without one is an error. */
  async permalink(binding: IntakeThread, ts: string): Promise<string> {
    const data = await this.call("chat.getPermalink", "bot", { channel: binding.channelId, message_ts: ts });
    if (typeof data.permalink !== "string" || data.permalink === "") throw new SlackError("invalid_response", false);
    return data.permalink;
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
      // Every envelope with an ID goes through the handler; only its resolution acknowledges it.
      const envelope = toEnvelope(envelopeId, frame.type, frame.payload);
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
    const form = FORM_METHODS.has(method);
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/${method}`, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" },
        body: form ? new URLSearchParams(Object.entries(body).filter(([, value]) => value !== undefined).map(([name, value]) => [name, String(value)])).toString() : JSON.stringify(body),
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

/** Only supported envelope payloads are projected; unknown or malformed payloads are delivered with their ID alone. */
function toEnvelope(envelopeId: string, type: unknown, payload: Record<string, any> | undefined): SlackEnvelope {
  if (type === "interactive") {
    const interaction = blockActions(payload);
    return interaction ? { envelopeId, interaction } : { envelopeId };
  }
  if (type !== "events_api") return { envelopeId };
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

function blockActions(payload: Record<string, any> | undefined): SlackInteraction | undefined {
  if (!payload || payload.type !== "block_actions") return undefined;
  const userId = payload.user?.id;
  const teamId = payload.team?.id;
  const channelId = payload.channel?.id;
  const messageTs = payload.message?.ts ?? payload.container?.message_ts;
  if (![userId, teamId, channelId, messageTs].every(isString)) return undefined;
  if (!Array.isArray(payload.actions)) return undefined;

  const actions: SlackAction[] = [];
  for (const raw of payload.actions) {
    if (!raw || typeof raw !== "object" || !isString(raw.action_id) || !isString(raw.block_id) || !isString(raw.action_ts)) return undefined;
    const selectedValues = raw.selected_options === undefined
      ? undefined
      : selectedOptions(raw.selected_options);
    const selectedOption = raw.selected_option;
    if (selectedValues === INVALID || (selectedOption !== undefined && selectedOption !== null && (!isRecord(selectedOption) || !isString(selectedOption.value))) ||
      (raw.value !== undefined && !isString(raw.value))) return undefined;
    actions.push(defined({
      actionId: raw.action_id,
      blockId: raw.block_id,
      actionTs: raw.action_ts,
      value: raw.value ?? selectedOption?.value,
      selectedValues: selectedValues === undefined ? undefined : selectedValues,
    }));
  }

  const state = interactionState(payload.state);
  if (state === INVALID) return undefined;
  return defined({
    type: "block_actions" as const,
    userId,
    teamId,
    channelId,
    messageTs,
    threadTs: isString(payload.message?.thread_ts) ? payload.message.thread_ts : undefined,
    actions,
    state: state === undefined ? undefined : state,
  });
}

const INVALID = Symbol("invalid Slack interaction field");

function selectedOptions(value: unknown): string[] | undefined | typeof INVALID {
  if (value === null) return [];
  if (!Array.isArray(value)) return INVALID;
  const values: string[] = [];
  for (const option of value) {
    if (!option || typeof option !== "object" || !isString(option.value)) return INVALID;
    values.push(option.value);
  }
  return values;
}

function interactionState(raw: unknown): SlackInteraction["state"] | undefined | typeof INVALID {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isRecord(raw.values)) return INVALID;
  const stateEntries: [string, NonNullable<SlackInteraction["state"]>[string]][] = [];
  for (const [blockId, block] of Object.entries(raw.values)) {
    if (!isRecord(block)) return INVALID;
    const elementEntries: [string, NonNullable<SlackInteraction["state"]>[string][string]][] = [];
    for (const [actionId, element] of Object.entries(block)) {
      if (!isRecord(element) || !isString(element.type)) return INVALID;
      const selectedValues = element.selected_options === undefined
        ? undefined
        : selectedOptions(element.selected_options);
      const selectedOption = element.selected_option;
      if (selectedValues === INVALID || (element.value !== undefined && !isString(element.value)) ||
        (selectedOption !== undefined && selectedOption !== null && (!isRecord(selectedOption) || !isString(selectedOption.value)))) return INVALID;
      elementEntries.push([actionId, defined({
        type: element.type,
        selectedValues: selectedValues === undefined ? undefined : selectedValues,
        value: element.value ?? selectedOption?.value,
      })]);
    }
    stateEntries.push([blockId, Object.fromEntries(elementEntries)]);
  }
  return Object.fromEntries(stateEntries);
}

function isString(value: unknown): value is string { return typeof value === "string"; }
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Drops absent fields so optional properties are missing rather than undefined. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
