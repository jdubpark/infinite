import { readFileSync } from "node:fs";
import { WebSocket, type RawData } from "ws";
import type { IntakeThread, IntakeThreadReader, SlackOrganizationScope, SlackThreadMessage } from "./intake-types.js";

export class SlackError extends Error {
  constructor(readonly code: string, readonly transient: boolean) { super(`Slack request failed: ${code}`); }
}

export interface SlackEnvelope {
  envelopeId: string; teamId?: string; eventId?: string;
  event?: { type: string; user?: string; botId?: string; appId?: string; botProfile?: true; subtype?: string; channelType?: string; channel?: string; ts?: string; threadTs?: string; text?: string };
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

type SocketPhase =
  | { state: "idle"; attempts: number }
  | { state: "opening"; attempts: number; pending: AbortController }
  | { state: "handshaking"; attempts: number; socket: WebSocket }
  | { state: "connected"; socket: WebSocket }
  | { state: "backoff"; attempts: number; timer: NodeJS.Timeout }
  | { state: "closed" };

const DEFAULT_ENDPOINT = "https://slack.com/api";
const UNREADABLE = new Set(["channel_not_found", "not_in_channel", "thread_not_found"]);
const PAGE_LIMIT = 200;
const MAX_THREAD_MESSAGES = 1000;
const MAX_THREAD_PAGES = 50;
const MAX_RECONNECT_DELAY_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const FORM_METHODS = new Set(["auth.test", "conversations.info", "conversations.replies", "apps.connections.open", "chat.getPermalink"]);
const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "credential_unavailable"]);

export class SlackClient implements IntakeThreadReader {
  private readonly endpoint: string;

  constructor(private readonly options: { botTokenFile: string; appTokenFile: string; endpoint?: string; timeoutMs?: number;
    teamId: string; organizationScope: SlackOrganizationScope; workspaceAllowed: () => boolean }) {
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  }

  async authTest(): Promise<{ teamId: string; userId: string; botId: string }> {
    const data = await this.call("auth.test", "bot", {});
    if (typeof data.team_id !== "string" || typeof data.user_id !== "string" || typeof data.bot_id !== "string") {
      throw new SlackError("invalid_response", false);
    }
    return { teamId: data.team_id, userId: data.user_id, botId: data.bot_id };
  }

  async organizationChannelAllowed(channelId: string): Promise<boolean> {
    const scope = this.options.organizationScope;
    const workspaceAllowed = this.options.workspaceAllowed;
    if (!scope?.workspaces?.length || typeof workspaceAllowed !== "function" || !workspaceAllowed()) return false;
    const teamId = this.options.teamId;
    if (!teamId || (scope.channelIds !== undefined && !scope.channelIds.includes(channelId))) return false;
    let data: Record<string, any>;
    try { data = await this.call("conversations.info", "bot", { channel: channelId }); }
    catch (error) {
      if (error instanceof SlackError && (error.transient || AUTH_ERRORS.has(error.code))) throw error;
      return false;
    }
    const channel = data.channel;
    if (!isRecord(channel)) return false;
    const channelType = (channel.is_channel === true && channel.is_group === false && channel.is_private === false)
      || (channel.is_group === true && channel.is_channel === false && channel.is_private === true);
    return workspaceAllowed()
      && channel.id === channelId && channelType
      && channel.is_im === false && channel.is_mpim === false
      && channel.context_team_id === teamId
      && Array.isArray(channel.shared_team_ids) && channel.shared_team_ids.length === 1 && channel.shared_team_ids[0] === teamId
      && channel.is_shared === false && channel.is_ext_shared === false
      && (channel.is_ext_ws_shared === undefined || channel.is_ext_ws_shared === false)
      && channel.is_org_shared === false && channel.is_pending_ext_shared === false
      && Array.isArray(channel.pending_shared) && channel.pending_shared.length === 0
      && Array.isArray(channel.pending_connected_team_ids) && channel.pending_connected_team_ids.length === 0
      && channel.is_member === true;
  }

  async thread(binding: IntakeThread): Promise<SlackThreadMessage[] | "unreadable"> {
    if (!await this.organizationChannelAllowed(binding.channelId)) return "unreadable";
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

  async post(binding: IntakeThread, text: string, key: string, blocks?: Record<string, unknown>[]): Promise<{ ts: string }> {
    await this.requireOrganizationChannel(binding.channelId);
    const data = await this.call("chat.postMessage", "bot", {
      channel: binding.channelId, thread_ts: binding.threadTs, text, mrkdwn: false, parse: "none",
      blocks: blocks ?? [{ type: "markdown", text }],
      metadata: { event_type: "infinite_intake", event_payload: { key } },
    });
    if (typeof data.ts !== "string") throw new SlackError("invalid_response", false);
    return { ts: data.ts };
  }

  async permalink(binding: IntakeThread, ts: string): Promise<string> {
    await this.requireOrganizationChannel(binding.channelId);
    const data = await this.call("chat.getPermalink", "bot", { channel: binding.channelId, message_ts: ts });
    if (typeof data.permalink !== "string" || data.permalink === "") throw new SlackError("invalid_response", false);
    return data.permalink;
  }

  async acknowledgeProposal(channelId: string, ts: string): Promise<void> {
    await this.requireOrganizationChannel(channelId);
    try {
      await this.call("reactions.add", "bot", { channel: channelId, timestamp: ts, name: "eyes" });
    } catch (error) {
      if (!(error instanceof SlackError) || error.code !== "already_reacted") throw error;
    }
  }

  private async requireOrganizationChannel(channelId: string): Promise<void> {
    if (!await this.organizationChannelAllowed(channelId)) throw new SlackError("organization_scope_denied", false);
  }

  connect(handle: (envelope: SlackEnvelope) => Promise<void>): { close(): void; connected(): boolean } {
    let phase: SocketPhase = { state: "idle", attempts: 0 };

    const schedule = (attempts: number) => {
      if (phase.state === "closed") return;
      const wait = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** attempts);
      const timer = setTimeout(() => {
        if (phase.state !== "backoff" || phase.timer !== timer) return;
        phase = { state: "idle", attempts: phase.attempts };
        void open();
      }, wait);
      phase = { state: "backoff", attempts: attempts + 1, timer };
    };

    const ack = (current: WebSocket, envelopeId: string) => {
      if ((phase.state === "handshaking" || phase.state === "connected") && phase.socket === current && current.readyState === WebSocket.OPEN) {
        current.send(JSON.stringify({ envelope_id: envelopeId }));
      }
    };

    const receive = (current: WebSocket, raw: RawData) => {
      if ((phase.state !== "handshaking" && phase.state !== "connected") || phase.socket !== current) return;
      let frame: Record<string, any>;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type === "hello") { phase = { state: "connected", socket: current }; return; }
      if (frame.type === "disconnect") {
        phase = { state: "handshaking", attempts: phase.state === "handshaking" ? phase.attempts : 0, socket: current };
        current.close();
        return;
      }
      if (typeof frame.envelope_id !== "string") return;
      const envelopeId = frame.envelope_id;
      const envelope = toEnvelope(envelopeId, frame.type, frame.payload);
      Promise.resolve()
        .then(() => handle(envelope))
        .then(() => ack(current, envelopeId), () => undefined);
    };

    const open = async () => {
      if (phase.state !== "idle") return;
      const pending = new AbortController();
      const attempts = phase.attempts;
      phase = { state: "opening", attempts, pending };
      let url: string;
      try {
        const data = await this.call("apps.connections.open", "app", {}, pending.signal);
        if (typeof data.url !== "string" || !this.allowedSocketAddress(data.url)) throw new SlackError("refused_socket_address", false);
        url = data.url;
      } catch {
        if (phase.state !== "opening" || phase.pending !== pending) return;
        schedule(phase.attempts);
        return;
      }
      if (phase.state !== "opening" || phase.pending !== pending) return;
      const current = new WebSocket(url, { handshakeTimeout: this.options.timeoutMs ?? 10_000 });
      phase = { state: "handshaking", attempts: phase.attempts, socket: current };
      current.on("message", raw => receive(current, raw));
      current.on("error", () => undefined);
      current.on("close", () => {
        if ((phase.state !== "handshaking" && phase.state !== "connected") || phase.socket !== current) return;
        schedule(phase.state === "handshaking" ? phase.attempts : 0);
      });
    };

    void open();

    return {
      close() {
        const prev = phase;
        phase = { state: "closed" };
        if (prev.state === "backoff") clearTimeout(prev.timer);
        else if (prev.state === "opening") prev.pending.abort();
        else if (prev.state === "handshaking" || prev.state === "connected") prev.socket.terminate();
      },
      connected() {
        return phase.state === "connected" && phase.socket.readyState === WebSocket.OPEN;
      },
    };
  }

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

function toEnvelope(envelopeId: string, type: unknown, payload: Record<string, any> | undefined): SlackEnvelope {
  if (type === "interactive") {
    const interaction = blockActions(payload);
    return interaction ? { envelopeId, interaction } : { envelopeId };
  }
  if (type !== "events_api") return { envelopeId };
  const event = payload?.event;
  const optionalStrings = ["user", "bot_id", "app_id", "channel", "ts", "thread_ts", "text", "subtype", "channel_type"];
  if (!isRecord(event) || typeof event.type !== "string" || (event.hidden !== undefined && event.hidden !== false)
    || Object.hasOwn(event, "edited")
    || optionalStrings.some(key => Object.hasOwn(event, key) && typeof event[key] !== "string")
    || (Object.hasOwn(event, "bot_profile") && !isRecord(event.bot_profile))) return { envelopeId };
  return defined({
    envelopeId,
    teamId: typeof payload?.team_id === "string" ? payload.team_id : undefined,
    eventId: typeof payload?.event_id === "string" ? payload.event_id : undefined,
    event: defined({
      type: event.type, user: event.user, botId: event.bot_id, appId: event.app_id,
      botProfile: Object.hasOwn(event, "bot_profile") ? true as const : undefined,
      subtype: event.subtype, channelType: event.channel_type, channel: event.channel,
      ts: event.ts, threadTs: event.thread_ts, text: event.text,
    }),
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

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
