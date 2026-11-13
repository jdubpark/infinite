import { deterministicUuid, type IntakeConfig, type IntakeInbound, type IntakeMessage, type IntakeMessageKind, type IntakeRecord, type IntakeThread, type SlackThreadMessage } from "./intake-types.js";
import type { IntakeStore } from "./intake-store.js";
import type { Mission, MissionDecision } from "./mission-types.js";
import type { MissionService } from "./missions.js";
import type { Config } from "./types.js";
import type { TeamService } from "./teams.js";
import { TeamError } from "./teams.js";
import { SlackError, type SlackClient, type SlackEnvelope } from "./slack-client.js";
import { splitSlackText } from "./slack-text.js";
import { failureSummary, outboundText } from "./intake.js";

const IDENTITY_RETRY_MS = 30_000;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const RETRY_EVERY_MS = 600_000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const FINISHED = "This request has finished. File a follow-up with Linear's agent in this thread.";
const ALREADY_ANSWERED = "That question was already answered.";
const NOT_STARTED = "This request has not started yet.";
const NO_REASON = "No reason was recorded.";
const UNEXPECTED = "The request could not be applied.";
const ACTIONS = new Set(["status", "pause", "resume", "cancel"]);
/** Identity failures a retry cannot fix: the surface stops with a reason, as it does for another workspace's token. */
const PERMANENT_IDENTITY = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "credential_unavailable"]);
const QUESTION = /^Q(\d+)(?!\w)\s*/i;

interface Outcome { outcome: string; reply?: string }
type SavedCall = NonNullable<IntakeInbound["call"]>;
type Routed = { outcome: string; reply?: string; call?: Omit<SavedCall, "revision"> };
const OUTCOMES: Record<SavedCall["action"], string> = { answer: "answered", steer: "steered", pause: "pause", resume: "resume", cancel: "cancel" };

const now = () => new Date().toISOString();
/**
 * Text from a caught error that a record, the API, or Slack may hold: the host's own refusal, or Slack's code. Anything
 * else is a summary of its name and code, because its message can carry host paths or addresses.
 */
const errorText = (error: unknown) => error instanceof TeamError || error instanceof SlackError ? error.message : failureSummary(error);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameThread = (a: IntakeThread | undefined, b: IntakeThread | undefined) =>
  Boolean(a && b && a.channelId === b.channelId && a.threadTs === b.threadTs);
const mentionsIdentifier = (text: string, identifier: string) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(identifier)}(?![A-Za-z0-9])`).test(text);

/**
 * Adds the text as one pending message, or as numbered parts when it is longer than one Slack message. Every part of
 * every kind is made here, after the outbound filter has removed host paths and addresses.
 */
function addParts(config: Config, draft: IntakeRecord, key: string, kind: IntakeMessageKind, text: string, createdAt: string) {
  const parts = splitSlackText(outboundText(config, text));
  parts.forEach((part, index) => {
    const partKey = parts.length > 1 ? `${key}#${index + 1}` : key;
    if (draft.messages.some(message => message.key === partKey)) return;
    const message: IntakeMessage = { key: partKey, kind, text: part, createdAt, status: "pending", attempts: 0 };
    draft.messages.push(message);
  });
}

const questionText = (decision: MissionDecision) => (n: number) => {
  const options = decision.options.length ? [decision.options.map((option, index) => `${index + 1}. ${option}`).join("   ")] : [];
  return [`Q${n}: ${decision.question}`, ...options, "Reply with a mention and your answer."].join("\n");
};

/**
 * Posts an intake record's messages into the Slack thread it is bound to and applies the owner's tagged replies to its
 * mission. Every outbound message goes to `record.thread`; nothing here takes a channel from an inbound event as a place to post.
 */
export class IntakeSlackSurface {
  private readonly slack: IntakeConfig["slack"];
  private botUserId?: string;
  private started = false;
  private ready = false;
  private closed = false;
  private reason?: string;
  private droppedCount = 0;
  private connection?: { close(): void; connected(): boolean };
  private identityTimer?: NodeJS.Timeout;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pumping = new Set<string>();
  private readonly draining = new Set<string>();
  private readonly composeRetries = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>();
  /** The newest unresolved error per record; a later successful reconcile of that record clears it. */
  private readonly failures = new Map<string, string>();
  private unsubscribers: (() => void)[] = [];

  private readonly log: (line: string, error: unknown) => void;

  constructor(private readonly config: Config, private readonly store: IntakeStore, private readonly missions: MissionService,
    private readonly teams: Pick<TeamService, "get">, private readonly client: SlackClient,
    options: { log?: (line: string, error: unknown) => void } = {}) {
    this.slack = config.intake?.slack;
    this.log = options.log ?? ((line, error) => console.warn(line, error));
  }

  async start(): Promise<void> {
    if (!this.slack || this.closed || this.started) return;
    this.started = true;
    await this.verify();
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    clearTimeout(this.identityTimer);
    this.identityTimer = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const retry of this.composeRetries.values()) clearTimeout(retry.timer);
    this.composeRetries.clear();
    this.connection?.close();
    this.connection = undefined;
  }

  status(): { connected: boolean; reason?: string; dropped: number; lastError?: string } {
    const lastError = [...this.failures.values()].at(-1);
    return { connected: this.connection?.connected() ?? false, ...(this.reason ? { reason: this.reason } : {}),
      ...(lastError ? { lastError } : {}), dropped: this.droppedCount };
  }

  private async verify(): Promise<void> {
    if (this.closed || !this.slack) return;
    let identity: { teamId: string; userId: string };
    try {
      identity = await this.client.authTest();
    } catch (error) {
      if (error instanceof SlackError && !error.transient && PERMANENT_IDENTITY.has(error.code)) {
        this.reason = `The Slack identity check failed: ${error.code}.`;
        return;
      }
      this.identityTimer = setTimeout(() => { this.identityTimer = undefined; void this.verify(); }, IDENTITY_RETRY_MS);
      return;
    }
    if (this.closed) return;
    if (identity.teamId !== this.slack.teamId) {
      this.reason = "The Slack token belongs to a different workspace.";
      return;
    }
    this.botUserId = identity.userId;
    this.begin();
  }

  private begin(): void {
    this.ready = true;
    this.connection = this.client.connect(envelope => this.receive(envelope));
    this.unsubscribers = [
      this.store.onChange(record => this.reconcile(record.issueId)),
      this.missions.onChange(mission => {
        const record = this.store.forMission(mission.id);
        if (record) this.reconcile(record.issueId);
      }),
    ];
    for (const record of this.store.list()) {
      this.reconcile(record.issueId);
      if (record.inbound.some(item => !item.handledAt)) void this.drain(record.issueId);
    }
  }

  // Outbound

  private reconcile(issueId: string): void {
    if (!this.ready || this.closed) return;
    const record = this.store.get(issueId);
    if (!record?.thread || record.state === "skipped") return;
    try {
      const mission = record.missionId ? this.missions.peek(record.missionId) : undefined;
      // Compose against a copy first, so a record with nothing missing is not rewritten.
      const probe = structuredClone(record);
      this.compose(probe, mission);
      if (probe.messages.length !== record.messages.length || probe.questions.length !== record.questions.length) {
        this.store.update(issueId, draft => this.compose(draft, mission));
      }
      this.settle(issueId);
    } catch (error) {
      this.fail(issueId, error);
      return;
    }
    void this.pump(issueId);
  }

  /** A successful reconcile clears the record's error and its pending composition retry. */
  /** The record's identifier for messages and logs; undefined when the store cannot read it. */
  private identifierOf(issueId: string): string | undefined {
    try { return this.store.get(issueId)?.identifier; } catch { return undefined; }
  }

  /** Logs the error in full and keeps only its summary, prefixed with the identifier, for status. */
  private noteFailure(issueId: string, step: string, error: unknown): void {
    const identifier = this.identifierOf(issueId);
    this.logFailure(issueId, step, error, identifier);
    const summary = errorText(error);
    this.failures.delete(issueId);
    this.failures.set(issueId, identifier ? `${identifier}: ${summary}` : summary);
  }

  private logFailure(issueId: string, step: string, error: unknown, identifier = this.identifierOf(issueId)): void {
    this.log(`Intake Slack ${step} failed${identifier ? ` for ${identifier}` : ""}.`, error);
  }

  private settle(issueId: string): void {
    this.failures.delete(issueId);
    const retry = this.composeRetries.get(issueId);
    if (retry) clearTimeout(retry.timer);
    this.composeRetries.delete(issueId);
  }

  /** Records the error and retries this record's reconcile on the Slack retry schedule; the mission is never touched. */
  private fail(issueId: string, error: unknown): void {
    this.noteFailure(issueId, "compose", error);
    const retry = this.composeRetries.get(issueId) ?? { attempts: 0 };
    retry.attempts += 1;
    clearTimeout(retry.timer);
    const delay = RETRY_DELAYS_MS[retry.attempts - 1] ?? RETRY_EVERY_MS;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      this.reconcile(issueId);
    }, delay);
    this.composeRetries.set(issueId, retry);
  }

  private compose(draft: IntakeRecord, mission: Mission | undefined): void {
    const at = now();
    const has = (key: string) => draft.messages.some(message => message.key === key || message.key.startsWith(`${key}#`));
    const add = (key: string, kind: IntakeMessageKind, text: string) => {
      if (!has(key)) addParts(this.config, draft, key, kind, text, at);
    };
    const title = `${draft.identifier} "${draft.title}"`;
    if (draft.state === "started") {
      add("ack", "ack", `Started on ${title}. I'll post questions and the result here.\nReply with a mention to answer or steer.`);
    } else if (draft.state === "queued" && draft.holdReason === "max-active") {
      add("ack", "ack", `Queued ${title}. It starts when a running request finishes. I'll post questions and the result here.`);
    } else if (draft.state === "queued" && draft.holdReason) {
      // Posted once: the key exists after the first hold, so a later hold reason posts nothing.
      add("ack", "ack", `Received ${title}. It has not started: ${draft.holdReason}\nI'll post questions and the result here once it starts.`);
    }
    // A split acknowledgement is decided by its first part.
    const ack = draft.messages.find(message => message.key === "ack" || message.key === "ack#1");
    if (draft.state === "started" && ack && !ack.text.startsWith("Started on ")) {
      add("started", "started", `Started on ${draft.identifier}.`);
    }
    if (mission) {
      for (const decision of mission.decisions) {
        if (decision.answer || has(`q:${decision.id}`)) continue;
        const n = this.questionNumber(draft, decision.id);
        addParts(this.config, draft, `q:${decision.id}`, "question", questionText(decision)(n), at);
      }
      if (mission.status === "ready-for-review" && mission.result) {
        add(`result:${mission.result.revision}`, "result", this.resultText(mission));
      }
      if (mission.status === "blocked") {
        add(`status:blocked:${mission.revision}`, "status", `Blocked: ${mission.reason ?? NO_REASON}\nFile a follow-up with Linear's agent in this thread.`);
      }
      if (mission.status === "cancelled") {
        add(`status:cancelled:${mission.revision}`, "status", `Cancelled: ${mission.reason ?? NO_REASON}\nFile a follow-up with Linear's agent in this thread.`);
      }
      if (mission.status === "paused" && draft.closure) {
        add(`status:paused:${mission.revision}`, "status", `Paused: ${draft.closure.reason}\nReply with a mention and "resume" or "cancel".`);
      }
    }
    if (draft.editNotedAt) {
      add("edit-note", "edit-note", `${draft.identifier} was edited after the run started. The run keeps the original text; reply with a mention to steer it.`);
    }
  }

  /** The record's number for a decision; a new one is one more than the highest number on any record in the same thread. */
  private questionNumber(draft: IntakeRecord, decisionId: string): number {
    const existing = draft.questions.find(question => question.decisionId === decisionId);
    if (existing) return existing.n;
    const others = this.store.list().filter(record => record.issueId !== draft.issueId && sameThread(record.thread, draft.thread));
    const highest = Math.max(0, ...others.flatMap(record => record.questions.map(question => question.n)), ...draft.questions.map(question => question.n));
    const n = highest + 1;
    draft.questions.push({ decisionId, n });
    return n;
  }

  private resultText(mission: Mission): string {
    const done = mission.subtasks.filter(subtask => subtask.status === "done");
    const noChange = done.length > 0 && done.every(subtask => subtask.teamStatus === "no-change");
    const views = mission.subtasks.flatMap(subtask => {
      if (!subtask.teamId) return [];
      try { return [this.teams.get(subtask.teamId)]; }
      catch (error) { if (error instanceof TeamError && error.status === 404) return []; throw error; }
    });
    const lines = [noChange ? "Answer (agent report):" : "Ready for review (agent report):", mission.result!.summary];
    for (const team of views) {
      const url = team.pullRequest?.pullRequestUrl ?? team.deliveryReceipt?.pullRequestUrl;
      if (url) lines.push(`Pull request: ${url}`);
    }
    for (const team of views) {
      if (!team.pullRequest && !team.deliveryReceipt && team.publication?.publishedAt) {
        lines.push(`Branch: ${team.publication.repository} ${team.publication.branch}`);
      }
    }
    return lines.join("\n");
  }

  private async pump(issueId: string): Promise<void> {
    if (!this.ready || this.closed || this.pumping.has(issueId)) return;
    this.pumping.add(issueId);
    try {
      while (!this.closed) {
        const record = this.store.get(issueId);
        if (!record?.thread || record.state === "skipped") return;
        const message = record.messages.find(item => item.status === "pending");
        if (!message) return;
        const due = message.nextAttemptAt ? Date.parse(message.nextAttemptAt) : 0;
        if (due > Date.now()) { this.wake(issueId, due); return; }
        await this.deliver(issueId, record.thread, message);
      }
    } catch (error) {
      // A failed store write leaves the message pending; the next change pumps again.
      this.noteFailure(issueId, "store", error);
    } finally {
      this.pumping.delete(issueId);
    }
  }

  private wake(issueId: string, at: number): void {
    clearTimeout(this.timers.get(issueId));
    this.timers.set(issueId, setTimeout(() => {
      this.timers.delete(issueId);
      void this.pump(issueId);
    }, Math.max(0, at - Date.now())));
  }

  /**
   * The Slack key is the record's ID and the message's local key, so two records in one thread never share a receipt.
   * The message is marked uncertain before the post, so a crash inside the send is found by lookup on restart.
   */
  private async deliver(issueId: string, thread: IntakeThread, message: IntakeMessage): Promise<void> {
    const key = message.key, transport = `${issueId}:${key}`;
    if (message.uncertain) {
      let messages: SlackThreadMessage[] | "unreadable";
      try {
        messages = await this.client.thread(thread);
      } catch (error) {
        this.patch(issueId, key, item => { item.attempts += 1; });
        this.failed(issueId, key, error);
        return;
      }
      const found = Array.isArray(messages) ? messages.find(item => item.key === transport) : undefined;
      if (found) {
        this.patch(issueId, key, item => {
          item.status = "sent"; item.ts = found.ts; delete item.uncertain; delete item.nextAttemptAt; delete item.error;
        });
        return;
      }
    }
    this.patch(issueId, key, item => { item.uncertain = true; item.attempts += 1; });
    try {
      const { ts } = await this.client.post(thread, message.text, transport);
      this.patch(issueId, key, item => {
        item.status = "sent"; item.ts = ts;
        delete item.uncertain; delete item.nextAttemptAt; delete item.error;
      });
    } catch (error) {
      this.failed(issueId, key, error);
    }
  }

  /** Called after the attempt was counted; schedules the next attempt or gives up. */
  private failed(issueId: string, key: string, error: unknown): void {
    if (!(error instanceof SlackError)) this.logFailure(issueId, "deliver", error);
    const permanent = error instanceof SlackError && !error.transient;
    this.patch(issueId, key, item => {
      item.error = errorText(error);
      if (permanent) {
        item.status = "failed"; delete item.uncertain; delete item.nextAttemptAt;
        return;
      }
      item.uncertain = true;
      if (Date.now() - Date.parse(item.createdAt) >= GIVE_UP_MS) {
        item.status = "failed"; delete item.nextAttemptAt;
        return;
      }
      item.nextAttemptAt = new Date(Date.now() + (RETRY_DELAYS_MS[item.attempts - 1] ?? RETRY_EVERY_MS)).toISOString();
    });
  }

  private patch(issueId: string, key: string, change: (message: IntakeMessage) => void): void {
    this.store.update(issueId, draft => {
      const message = draft.messages.find(item => item.key === key);
      if (message) change(message);
    });
  }

  // Inbound

  private async receive(envelope: SlackEnvelope): Promise<void> {
    const slack = this.slack;
    const event = envelope.event;
    if (!slack || !event || envelope.teamId !== slack.teamId || event.type !== "app_mention" || event.user !== slack.ownerUserId
      || event.botId !== undefined || !event.channel || !event.ts) {
      this.droppedCount += 1;
      return;
    }
    const thread: IntakeThread = { channelId: event.channel, threadTs: event.threadTs ?? event.ts };
    const text = this.commandText(event.text ?? "");
    const eventId = envelope.eventId ?? envelope.envelopeId;
    const bound = this.store.boundTo(thread);
    if (bound.length === 0) {
      if (slack.bindByMention && this.bind(thread, text)) return;
      this.droppedCount += 1;
      return;
    }
    const ts = event.ts;
    const duplicate = (record: IntakeRecord) => record.inbound.some(item => item.eventId === eventId || item.ts === ts);
    // A redelivered event, or a second event for the same message, is dropped with no write and no reply. An entry a
    // failed store write left unhandled on the record that holds it is applied now.
    const holders = bound.filter(duplicate);
    if (holders.length > 0) {
      for (const record of holders) if (record.inbound.some(item => !item.handledAt)) void this.drain(record.issueId);
      return;
    }
    const target = this.target(bound, text);
    this.store.update(target.record.issueId, draft => {
      if (duplicate(draft)) return;
      const accepted: IntakeInbound = { eventId, ts, text: target.text, receivedAt: now() };
      if (target.reply) {
        // Settled here: nothing is applied to any mission, and the reply says why.
        accepted.handledAt = now();
        accepted.outcome = target.outcome;
        addParts(this.config, draft, `reply:${eventId}`, "reply", target.reply, now());
      }
      draft.inbound.push(accepted);
    });
    void this.drain(target.record.issueId);
  }

  /**
   * The record a reply belongs to, among the records bound to its thread (oldest first): the one whose questions hold a
   * leading `Qn`; the one a leading identifier names, with the identifier removed; the one unfinished record; or the
   * newest finished one. With more than one unfinished record and neither prefix, nothing is applied, and the newest
   * unfinished record keeps the reply naming the open identifiers. A `Qn` no record holds gets the unknown-question reply.
   */
  private target(bound: IntakeRecord[], text: string): { record: IntakeRecord; text: string; outcome?: string; reply?: string } {
    const unfinished = bound.filter(record => record.state !== "finished");
    const fallback = unfinished.length > 0 ? unfinished.at(-1)! : bound.at(-1)!;
    const leading = QUESTION.exec(text);
    if (leading) {
      const n = Number(leading[1]);
      const holder = bound.find(record => record.questions.some(question => question.n === n));
      return holder ? { record: holder, text } : { record: fallback, text, outcome: "unknown-question", reply: `There is no question Q${n}.` };
    }
    for (const record of bound) {
      const named = new RegExp(`^${escapeRegExp(record.identifier)}(?=$|[\\s:,])`, "i").exec(text);
      if (named) return { record, text: text.slice(named[0].length).replace(/^\s*[:,]?\s*/, "") };
    }
    if (unfinished.length > 1) {
      const open = unfinished.map(record => record.identifier).join(", ");
      return { record: fallback, text, outcome: "ambiguous",
        reply: `More than one request is open in this thread: ${open}. Start your reply with an identifier or a question number.` };
    }
    return { record: fallback, text };
  }

  private commandText(text: string): string {
    return text.replace(new RegExp(`<@${escapeRegExp(this.botUserId ?? "")}(?:\\|[^>]*)?>`, "g"), "").trim();
  }

  /** Attaches a thread to the one started or queued record without a thread whose identifier the owner's mention names. */
  private bind(thread: IntakeThread, text: string): boolean {
    const matches = this.store.list().filter(record =>
      !record.thread && (record.state === "started" || record.state === "queued") && mentionsIdentifier(text, record.identifier));
    if (matches.length !== 1) return false;
    this.store.update(matches[0].issueId, draft => { draft.thread = thread; });
    return true;
  }

  private async drain(issueId: string): Promise<void> {
    if (this.draining.has(issueId)) return;
    this.draining.add(issueId);
    try {
      for (;;) {
        if (this.closed) return;
        const record = this.store.get(issueId);
        const entry = record?.inbound.find(item => !item.handledAt);
        if (!record || !entry) return;
        await this.apply(record, entry);
      }
    } catch (error) {
      // A failed store write leaves the entry unhandled; it is applied again on the next event, a redelivery, or a start.
      this.noteFailure(issueId, "inbound", error);
    } finally {
      this.draining.delete(issueId);
    }
  }

  private async apply(record: IntakeRecord, entry: IntakeInbound): Promise<void> {
    const { outcome, reply } = await this.act(record, entry);
    this.store.update(record.issueId, draft => {
      const item = draft.inbound.find(candidate => candidate.eventId === entry.eventId);
      if (!item || item.handledAt) return;
      item.handledAt = now();
      item.outcome = outcome;
      if (reply) addParts(this.config, draft, `reply:${entry.eventId}`, "reply", reply, now());
    });
  }

  /** An entry with a saved call performs exactly that call; any other entry is routed once, and the chosen call is saved first. */
  private async act(record: IntakeRecord, entry: IntakeInbound): Promise<Outcome> {
    if (entry.call) return this.perform(record, entry, entry.call);
    if (record.state === "finished") return { outcome: "finished", reply: FINISHED };
    const mission = record.missionId ? this.missions.peek(record.missionId) : undefined;
    if (!mission) return { outcome: "not-started", reply: NOT_STARTED };
    const routed = this.route(record, mission, entry.text);
    if (!routed.call) return { outcome: routed.outcome, reply: routed.reply };
    const call: SavedCall = { ...routed.call, revision: mission.revision };
    this.rememberCall(record.issueId, entry.eventId, call);
    return this.perform(record, entry, call);
  }

  /** Chooses the mission call for a reply from the mission's current state, or the reply that needs no call. */
  private route(record: IntakeRecord, mission: Mission, text: string): Routed {
    const lower = text.toLowerCase();
    if (lower === "status") {
      const open = mission.decisions.filter(decision => !decision.answer).flatMap(decision => {
        const question = record.questions.find(item => item.decisionId === decision.id);
        return question ? [`Q${question.n}: ${decision.question}`] : [];
      });
      return { outcome: "status", reply: [mission.status, ...open].join("\n") };
    }
    if (ACTIONS.has(lower)) return { outcome: lower, call: { action: lower as "pause" | "resume" | "cancel" } };
    const open = mission.decisions.filter(decision => !decision.answer);
    const leading = QUESTION.exec(text);
    if (open.length === 0) {
      if (leading || /^\d+$/.test(text)) return { outcome: "already-answered", reply: ALREADY_ANSWERED };
      return { outcome: "steered", call: { action: "steer", text } };
    }
    let decision: MissionDecision;
    if (leading) {
      const number = Number(leading[1]);
      const question = record.questions.find(item => item.n === number);
      if (!question) return { outcome: "unknown-question", reply: `There is no question Q${number}.` };
      const target = mission.decisions.find(item => item.id === question.decisionId);
      if (!target || target.answer) return { outcome: "already-answered", reply: ALREADY_ANSWERED };
      decision = target;
    } else {
      decision = open[0];
    }
    const remainder = leading ? text.slice(leading[0].length).trim() : text;
    if (remainder === "") return { outcome: "empty-answer", reply: "Reply with a mention and your answer." };
    const choice = /^\d+$/.test(remainder) ? Number(remainder) : undefined;
    const answer = choice !== undefined && choice >= 1 && choice <= decision.options.length ? decision.options[choice - 1] : remainder;
    return { outcome: "answered", call: { action: "answer", decisionId: decision.id, text: answer } };
  }

  /**
   * Runs the saved call at its saved revision. The revision is saved before each attempt; a stale revision is replaced by
   * the current one and the same call is retried once. Any other mission refusal becomes the reply.
   */
  private async perform(record: IntakeRecord, entry: IntakeInbound, saved: SavedCall): Promise<Outcome> {
    try {
      const missionId = record.missionId;
      if (!missionId) throw new TeamError(404, "mission-not-found", "This mission does not exist.");
      const requestId = deterministicUuid("intake-slack-event", entry.eventId);
      let revision = saved.revision;
      for (let attempt = 1; ; attempt++) {
        const call: SavedCall = { ...saved, revision };
        this.rememberCall(record.issueId, entry.eventId, call);
        try {
          await this.run(missionId, requestId, call);
          break;
        } catch (error) {
          if (attempt === 1 && error instanceof TeamError && error.code === "stale-mission-revision") {
            revision = this.currentRevision(missionId);
            continue;
          }
          throw error;
        }
      }
      return { outcome: OUTCOMES[saved.action] };
    } catch (error) {
      if (error instanceof TeamError) return { outcome: "refused", reply: error.message };
      this.logFailure(record.issueId, "action", error, record.identifier);
      return { outcome: "error", reply: UNEXPECTED };
    }
  }

  private run(missionId: string, requestId: string, call: SavedCall): Promise<unknown> {
    const { revision } = call;
    if (call.action === "steer") return this.missions.steer(missionId, { requestId, revision, text: call.text! }, "slack");
    if (call.action === "answer") return this.missions.answer(missionId, call.decisionId!, { requestId, revision, text: call.text! }, "slack");
    if (call.action === "pause") return this.missions.pause(missionId, { requestId, revision });
    if (call.action === "resume") return this.missions.resume(missionId, { requestId, revision });
    return this.missions.cancel(missionId, { requestId, revision });
  }

  private currentRevision(missionId: string): number {
    const mission = this.missions.peek(missionId);
    if (!mission) throw new TeamError(404, "mission-not-found", "This mission does not exist.");
    return mission.revision;
  }

  private rememberCall(issueId: string, eventId: string, call: SavedCall): void {
    this.store.update(issueId, draft => {
      const item = draft.inbound.find(candidate => candidate.eventId === eventId);
      if (item && !item.handledAt) item.call = call;
    });
  }
}
