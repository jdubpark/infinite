import { deterministicUuid, type IntakeConfig, type IntakeInbound, type IntakeMessage, type IntakeMessageKind, type IntakeRecord, type IntakeThread, type SlackThreadMessage } from "./intake-types.js";
import type { IntakeStore } from "./intake-store.js";
import type { Mission, MissionDecision } from "./mission-types.js";
import type { MissionService } from "./missions.js";
import type { Config } from "./types.js";
import type { TeamService } from "./teams.js";
import { TeamError } from "./teams.js";
import { SlackError, type SlackClient, type SlackEnvelope } from "./slack-client.js";
import { splitSlackText } from "./slack-text.js";
import { recommendationLine } from "./question-recommendation.js";
import { failureSummary, isAnswerRecord, outboundText, slackMessageAfter } from "./intake.js";
import { explicitRoute } from "./intake-route.js";
import { formatThreadStatus } from "./slack-thread-status.js";

const IDENTITY_RETRY_MS = 30_000;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const RETRY_EVERY_MS = 600_000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_LINEAR = "File a follow-up with Linear's agent in this thread.";
const FOLLOW_UP_DIRECT = "Mention me in this thread to file a follow-up.";
const ALREADY_ANSWERED = "That question was already answered.";
const NOT_STARTED = "This request has not started yet.";
const NO_REASON = "No reason was recorded.";
const UNEXPECTED = "The request could not be applied.";
const ACTIONS = new Set(["status", "pause", "resume", "cancel"]);
const EXTEND_HELP = "Extend by 5 minutes to 24 hours, for example `extend 6h` or `extend 90m`.";
const EXTEND_PROMPT = "Reply with a mention and `extend` (or `extend 6h`) to give it more time, or `cancel`.";
const EXTEND_MIN = 5, EXTEND_CAP = 1440;
const EXTEND_WORD = /^extend(?=\s|$)/i;
const EXTEND_FORM = /^extend(?:\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?)?$/i;
const EXTEND_ATTEMPT = /^extend\s+[-+.\d]/i;
const MINUTE_UNITS = new Set(["m", "min", "mins", "minute", "minutes"]);
const PERMANENT_IDENTITY = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "credential_unavailable"]);
const ANSWER_START = "Answering this from the repositories, read-only. No issue was filed.";
const ANSWER_FOOTER = "No issue was filed. To start work, mention me with the change you want, or begin with \"work:\".";
const CHANNEL_ANSWER_FOOTER = 'No issue was filed. To start work, mention me in this thread with "work:" and the change you want.';
const WORK_HINT = "I took this as a request for a change. If you only wanted an answer, reply with a mention and \"cancel\", then mention me again starting with \"ask:\".";
const WORK_HINT_QUEUED = "I took this as a request for a change. If you only wanted an answer, reply with a mention and \"cancel\" once it starts, then mention me again starting with \"ask:\".";
const QUESTION = /^Q(\d+)(?!\w)\s*/i;
const alternativePrompt = (n: number, channelReplies = false) => `What would you prefer instead? Reply ${channelReplies ? "in this thread with" : "with a mention and"} Q${n} followed by your alternative.`;

export type DirectRequest = (input: { thread: IntakeThread; ts: string; eventId: string; text: string; entrypoint?: "channel-message" }) => "accepted" | "duplicate";

type SurfaceState =
  | { kind: "idle" }
  | { kind: "verifying"; timer?: NodeJS.Timeout }
  | { kind: "failed"; reason: string }
  | { kind: "running"; botUserId: string; connection: { close(): void; connected(): boolean } }
  | { kind: "closed"; reason?: string };

interface Outcome { outcome: string; reply?: string }
type SavedCall = NonNullable<IntakeInbound["call"]>;
type Routed = { outcome: string; reply?: string; call?: Omit<SavedCall, "revision"> };
const OUTCOMES: Record<SavedCall["action"], string> = { answer: "answered", steer: "steered", pause: "pause", resume: "resume", cancel: "cancel", extend: "extended" };

function extendCommand(text: string): { minutes: number | undefined } | "invalid" | undefined {
  if (!EXTEND_WORD.test(text)) return undefined;
  const form = EXTEND_FORM.exec(text);
  if (form) {
    if (form[1] === undefined) return { minutes: undefined };
    const unit = form[2]?.toLowerCase();
    const minutes = Number(form[1]) * (unit !== undefined && MINUTE_UNITS.has(unit) ? 1 : 60);
    return minutes >= EXTEND_MIN && minutes <= EXTEND_CAP ? { minutes } : "invalid";
  }
  return EXTEND_ATTEMPT.test(text) ? "invalid" : undefined;
}

const addressedToSomeoneElse = (text: string) =>
  /^(?:(?:hey|hi)[,\s]+)?(?:<@[UW][A-Z0-9]+(?:\|[^>]*)?>|<!(?:here|channel|everyone|subteam\^[^>]+)>)/i.test(text);

function isChannelControl(text: string): boolean {
  return ACTIONS.has(text.toLowerCase()) || QUESTION.test(text) || extendCommand(text) !== undefined
    || /^(?:approve[d]?|deny|denied|yes|no)$/i.test(text);
}

const afterThreadBinding = (record: IntakeRecord, ts: string) =>
  slackMessageAfter(ts, record.direct?.ts ?? record.messages.find(message => message.ts)?.ts);

const utcMinute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const extendedAmount = (minutes: number) => {
  const plural = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  return minutes % 60 === 0 ? plural(minutes / 60, "hour") : plural(minutes, "minute");
};

const now = () => new Date().toISOString();
const errorText = (error: unknown) => error instanceof TeamError || error instanceof SlackError ? error.message : failureSummary(error);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameThread = (a: IntakeThread | undefined, b: IntakeThread | undefined) =>
  Boolean(a && b && a.channelId === b.channelId && a.threadTs === b.threadTs);
const mentionsIdentifier = (text: string, identifier: string) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(identifier)}(?![A-Za-z0-9])`).test(text);

const messageBase = (item: IntakeMessage) => ({
  key: item.key,
  kind: item.kind,
  text: item.text,
  createdAt: item.createdAt,
  attempts: item.attempts,
  ...(item.blocks ? { blocks: item.blocks } : {}),
});

function addParts(config: Config, draft: IntakeRecord, key: string, kind: IntakeMessageKind, text: string, createdAt: string,
  blocks?: Record<string, unknown>[]) {
  const parts = splitSlackText(outboundText(config, text));
  parts.forEach((part, index) => {
    const partKey = parts.length > 1 ? `${key}#${index + 1}` : key;
    if (draft.messages.some(message => message.key === partKey)) return;
    const message: IntakeMessage = { key: partKey, kind, text: part, createdAt, status: "pending", attempts: 0,
      ...(index === parts.length - 1 && blocks ? { blocks } : {}) };
    draft.messages.push(message);
  });
}

const questionText = (decision: MissionDecision, channelReplies = false) => (n: number) => {
  const recommended = decision.recommendation?.answers ?? [];
  const options = decision.options.map((option, index) => `${index + 1}. ${option}${recommended.includes(option) ? " (recommended)" : ""}`);
  const how = channelReplies ? "in this thread with your answer." : "with a mention and your answer.";
  const footer = decision.answerMode === "multiple" ? `Choose one or more options, then Submit. You can also reply ${how}`
    : options.length ? `Choose below, or reply ${how}` : `Reply ${how}`;
  const recommendation = decision.recommendation ? ["", recommendationLine(decision.recommendation)] : [];
  return [`**Q${n}: ${decision.question}**`, ...recommendation, ...(options.length ? ["", ...options] : []), "", footer].join("\n");
};

const safeLabel = (config: Config, label: string) => Array.from(outboundText(config, label)).slice(0, 75).join("");
const choiceBlocks = (config: Config, issueId: string, decision: MissionDecision): Record<string, unknown>[] => {
  const blockId = `infinite-decision:${issueId}:${decision.id}`;
  const button = (text: string, actionId: string, value: string, style?: string) => ({ type: "button", text: { type: "plain_text", text: safeLabel(config, text) }, action_id: actionId, value, ...(style ? { style } : {}) });
  if (decision.answerMode === "approval") return [{ type: "actions", block_id: blockId, elements: [
    button("Approve", "infinite_decision_choice", "0", "primary"), button("Deny", "infinite_decision_deny", "1", "danger"),
  ] }];
  if (decision.answerMode === "multiple") return [
    { type: "section", block_id: blockId, text: { type: "plain_text", text: "Choose one or more options" }, accessory: { type: "multi_static_select", action_id: "infinite_decision_multi", placeholder: { type: "plain_text", text: "Choose one or more" }, options: decision.options.map((label, index) => ({ text: { type: "plain_text", text: safeLabel(config, `${index + 1}. ${label}`) }, value: String(index) })) } },
    { type: "actions", block_id: `${blockId}:submit`, elements: [button("Submit", "infinite_decision_submit", "submit")] },
    { type: "actions", block_id: `${blockId}:other`, elements: [button("None of these", "infinite_decision_other", "other")] },
  ];
  const options = decision.options.length > 0 && decision.options.every(option => Array.from(outboundText(config, option)).length <= 75);
  const selection: Record<string, unknown>[] = options ? [{ type: "actions", block_id: blockId,
      elements: decision.options.map((label, index) => button(`${index + 1}. ${label}`, `infinite_decision_choice_${index}`, String(index))) }]
    : decision.options.length > 0 ? [{ type: "actions", block_id: blockId, elements: [{ type: "static_select", action_id: "infinite_decision_choice",
      placeholder: { type: "plain_text", text: "Choose an option" }, options: decision.options.map((label, index) => ({ text: { type: "plain_text", text: safeLabel(config, `${index + 1}. ${label}`) }, value: String(index) })) }] }] : [];
  if (decision.options.length > 0) selection.push({ type: "actions", block_id: `${blockId}:other`, elements: [button("None of these", "infinite_decision_other", "other")] });
  return selection;
};

export class IntakeSlackSurface {
  private readonly slack: IntakeConfig["slack"];
  private state: SurfaceState = { kind: "idle" };
  private droppedCount = 0;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly drainTimers = new Map<string, NodeJS.Timeout>();
  private readonly pumping = new Set<string>();
  private readonly draining = new Set<string>();
  private readonly composeRetries = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>();
  private readonly failures = new Map<string, string>();
  private unsubscribers: (() => void)[] = [];

  private readonly log: (line: string, error: unknown) => void;
  private readonly direct?: DirectRequest;

  constructor(private readonly config: Config, private readonly store: IntakeStore, private readonly missions: MissionService,
    private readonly teams: Pick<TeamService, "get">, private readonly client: SlackClient,
    options: { log?: (line: string, error: unknown) => void; direct?: DirectRequest } = {}) {
    this.slack = config.intake?.slack;
    this.direct = options.direct;
    this.log = options.log ?? ((line, error) => console.warn(line, error));
  }

  async start(): Promise<void> {
    if (!this.slack || this.state.kind !== "idle") return;
    this.state = { kind: "verifying" };
    await this.verify();
  }

  close(): void {
    const reason = this.state.kind === "failed" || this.state.kind === "closed" ? this.state.reason : undefined;
    if (this.state.kind === "verifying") clearTimeout(this.state.timer);
    if (this.state.kind === "running") this.state.connection.close();
    this.state = { kind: "closed", ...(reason ? { reason } : {}) };
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
    for (const retry of this.composeRetries.values()) clearTimeout(retry.timer);
    this.composeRetries.clear();
  }

  status(): { connected: boolean; reason?: string; dropped: number; lastError?: string } {
    const lastError = [...this.failures.values()].at(-1);
    const reason = this.state.kind === "failed" || this.state.kind === "closed" ? this.state.reason : undefined;
    const connected = this.state.kind === "running" ? this.state.connection.connected() : false;
    return { connected, ...(reason ? { reason } : {}), ...(lastError ? { lastError } : {}), dropped: this.droppedCount };
  }

  private async verify(): Promise<void> {
    if (this.state.kind !== "verifying" || !this.slack) return;
    let identity: { teamId: string; userId: string };
    try {
      identity = await this.client.authTest();
    } catch (error) {
      if (this.state.kind !== "verifying") return;
      if (error instanceof SlackError && !error.transient && PERMANENT_IDENTITY.has(error.code)) {
        this.state = { kind: "failed", reason: `The Slack identity check failed: ${error.code}.` };
        return;
      }
      const timer = setTimeout(() => {
        if (this.state.kind !== "verifying") return;
        this.state = { kind: "verifying" };
        void this.verify();
      }, IDENTITY_RETRY_MS);
      this.state = { kind: "verifying", timer };
      return;
    }
    if (this.state.kind !== "verifying") return;
    if (identity.teamId !== this.slack.teamId) {
      this.state = { kind: "failed", reason: "The Slack token belongs to a different workspace." };
      return;
    }
    this.begin(identity.userId);
  }

  private begin(botUserId: string): void {
    this.state = { kind: "running", botUserId, connection: this.client.connect(envelope => this.receive(envelope)) };
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

  private directOn(): boolean {
    return this.direct !== undefined && this.slack?.directRequests === true;
  }

  private followUp(): string {
    return this.directOn() ? FOLLOW_UP_DIRECT : FOLLOW_UP_LINEAR;
  }

  private mappedChannel(channelId: string): boolean {
    if (!this.directOn()) return false;
    if (this.slack?.ownerOnlyInJoinedChannels) return /^[CG][A-Z0-9]{2,20}$/.test(channelId);
    return (this.slack?.requestChannelIds ?? []).includes(channelId);
  }

  private threadReplies(thread: IntakeThread | undefined): boolean {
    return Boolean(thread && this.mappedChannel(thread.channelId));
  }

  private organizationChannelAllowed(channelId: string): Promise<boolean> {
    const check = this.client.organizationChannelAllowed;
    return check ? check.call(this.client, channelId) : Promise.resolve(!this.slack?.organizationScope);
  }

  private async requireOrganizationSource(thread: IntakeThread | undefined): Promise<void> {
    if (thread && !await this.organizationChannelAllowed(thread.channelId)) throw new SlackError("organization_scope_denied", false);
  }

  private reconcile(issueId: string): void {
    if (this.state.kind !== "running") return;
    void this.reconcileAuthorized(issueId);
  }

  private async reconcileAuthorized(issueId: string): Promise<void> {
    if (this.state.kind !== "running") return;
    const record = this.store.get(issueId);
    if (!record?.thread) return;
    try {
      if (!await this.organizationChannelAllowed(record.thread.channelId)) {
        this.deferReconcile(issueId);
        if (record.messages.some(message => message.status === "pending")) this.wake(issueId, Date.now() + RETRY_EVERY_MS);
        return;
      }
      const mission = record.missionId ? this.missions.peek(record.missionId) : undefined;
      const probe = structuredClone(record);
      this.compose(probe, mission);
      if (probe.messages.length !== record.messages.length || probe.questions.length !== record.questions.length) {
        this.store.update(issueId, draft => this.compose(draft, mission));
      }
      this.settle(issueId);
    } catch (error) {
      this.fail(issueId, error);
      if (record.messages.some(message => message.status === "pending")) this.wake(issueId, Date.now() + RETRY_EVERY_MS);
      return;
    }
    void this.pump(issueId);
  }

  private identifierOf(issueId: string): string | undefined {
    try { return this.store.get(issueId)?.identifier; } catch { return undefined; }
  }

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

  private fail(issueId: string, error: unknown): void {
    this.noteFailure(issueId, "compose", error);
    this.deferReconcile(issueId);
  }

  private deferReconcile(issueId: string): void {
    if (this.state.kind !== "running") return;
    const retry = this.composeRetries.get(issueId) ?? { attempts: 0 };
    if (retry.timer) return;
    retry.attempts += 1;
    const delay = RETRY_DELAYS_MS[retry.attempts - 1] ?? RETRY_EVERY_MS;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      this.reconcile(issueId);
    }, delay);
    this.composeRetries.set(issueId, retry);
  }

  private compose(draft: IntakeRecord, mission: Mission | undefined): void {
    if (draft.state === "skipped") return;
    const at = now();
    const has = (key: string) => draft.messages.some(message => message.key === key || message.key.startsWith(`${key}#`));
    const add = (key: string, kind: IntakeMessageKind, text: string) => {
      if (!has(key)) addParts(this.config, draft, key, kind, text, at);
    };
    const followUp = this.followUp();
    const answer = isAnswerRecord(draft);
    const title = !draft.direct ? `${draft.identifier} "${draft.title}"`
      : answer ? `your question "${draft.title}"`
      : draft.identifier ? `${draft.identifier} "${draft.title}" (${draft.url})` : `your request "${draft.title}"`;
    const routed = draft.direct?.route?.kind === "work" && draft.direct.route.by !== "owner";
    const channelReplies = this.threadReplies(draft.thread);
    const replyHint = channelReplies ? "Reply in this thread to answer or steer." : "Reply with a mention to answer or steer.";
    const hint = routed ? `\n${WORK_HINT}` : "";
    const queuedHint = routed ? `\n${WORK_HINT_QUEUED}` : "";
    if (draft.state === "started" && answer) {
      add("ack", "ack", ANSWER_START);
    } else if (draft.state === "started") {
      add("ack", "ack", `Started on ${title}. I'll post questions and the result here.\n${replyHint}${hint}`);
    } else if (draft.state === "queued" && draft.holdReason === "max-active") {
      add("ack", "ack", `Queued ${title}. It starts when a running request finishes. I'll post questions and the result here.${queuedHint}`);
    } else if (draft.state === "queued" && draft.holdReason) {
      add("ack", "ack", `Received ${title}. It has not started: ${draft.holdReason}\nI'll post questions and the result here once it starts.${queuedHint}`);
    }
    const ack = draft.messages.find(message => message.key === "ack" || message.key === "ack#1");
    if (draft.state === "started" && answer && ack && ack.text !== ANSWER_START) add("started", "started", ANSWER_START);
    if (draft.state === "started" && !answer && ack && !ack.text.startsWith("Started on ")) {
      add("started", "started", draft.direct ? `Started on ${draft.identifier} (${draft.url}).` : `Started on ${draft.identifier}.`);
    }
    if (mission) {
      if (channelReplies && draft.state === "started" && mission.status === "working" && mission.subtasks.length > 0 && !answer) {
        const count = mission.subtasks.length;
        add("progress:first-dispatch", "status", `The coordinator dispatched ${count} subtask${count === 1 ? "" : "s"}. Reply here with \`status\` for progress.`);
      }
      for (const decision of mission.decisions) {
        if (decision.answer || has(`q:${decision.id}`)) continue;
        const n = this.questionNumber(draft, decision.id);
        addParts(this.config, draft, `q:${decision.id}`, "question", questionText(decision, channelReplies)(n), at, choiceBlocks(this.config, draft.issueId, decision));
      }
      if (mission.status === "ready-for-review" && mission.result) {
        add(`result:${mission.result.revision}`, "result", this.resultText(mission, answer, channelReplies));
      }
      if (mission.status === "blocked") {
        const text = mission.stopReason === "deadline"
          ? `Stopped at its time limit: ${mission.reason ?? NO_REASON}\n${channelReplies ? 'Reply in this thread with "extend" (or "extend 6h") to give it more time, or "cancel".' : EXTEND_PROMPT}`
          : `Blocked: ${mission.reason ?? NO_REASON}\n${followUp}`;
        add(`status:blocked:${mission.revision}`, "status", text);
      }
      if (mission.status === "cancelled") {
        add(`status:cancelled:${mission.revision}`, "status", `Cancelled: ${mission.reason ?? NO_REASON}\n${followUp}`);
      }
      if (mission.status === "paused" && draft.closure) {
        add(`status:paused:${mission.revision}`, "status", `Paused: ${draft.closure.reason}\n${channelReplies ? 'Reply in this thread with "resume" or "cancel".' : 'Reply with a mention and "resume" or "cancel".'}`);
      }
    }
    if (draft.editNotedAt && !answer) {
      add("edit-note", "edit-note", `${draft.identifier} was edited after the run started. The run keeps the original text; reply with a mention to steer it.`);
    }
  }

  private questionNumber(draft: IntakeRecord, decisionId: string): number {
    const existing = draft.questions.find(question => question.decisionId === decisionId);
    if (existing) return existing.n;
    const others = this.store.list().filter(record => record.issueId !== draft.issueId && sameThread(record.thread, draft.thread));
    const highest = Math.max(0, ...others.flatMap(record => record.questions.map(question => question.n)), ...draft.questions.map(question => question.n));
    const n = highest + 1;
    draft.questions.push({ decisionId, n });
    return n;
  }

  private resultText(mission: Mission, answer = false, channelReplies = false): string {
    if (answer) return ["Answer (agent report):", mission.result!.summary, "", channelReplies ? CHANNEL_ANSWER_FOOTER : ANSWER_FOOTER].join("\n");
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
    if (this.state.kind !== "running" || this.pumping.has(issueId)) return;
    this.pumping.add(issueId);
    try {
      while (this.state.kind === "running") {
        const record = this.store.get(issueId);
        if (!record?.thread) return;
        const message = record.messages.find((item): item is Extract<IntakeMessage, { status: "pending" }> => item.status === "pending");
        if (!message) return;
        const due = message.nextAttemptAt ? Date.parse(message.nextAttemptAt) : 0;
        if (due > Date.now()) { this.wake(issueId, due); return; }
        if (!await this.deliver(issueId, record.thread, message)) return;
      }
    } catch (error) {
      this.noteFailure(issueId, "store", error);
    } finally {
      this.pumping.delete(issueId);
    }
  }

  private wake(issueId: string, at: number): void {
    if (this.state.kind !== "running") return;
    clearTimeout(this.timers.get(issueId));
    this.timers.set(issueId, setTimeout(() => {
      this.timers.delete(issueId);
      void this.pump(issueId);
    }, Math.max(0, at - Date.now())));
  }

  private async deliver(issueId: string, thread: IntakeThread, message: Extract<IntakeMessage, { status: "pending" }>): Promise<boolean> {
    const key = message.key, transport = `${issueId}:${key}`;
    try {
      if (!await this.organizationChannelAllowed(thread.channelId)) { this.wake(issueId, Date.now() + RETRY_EVERY_MS); return false; }
    } catch (error) {
      this.noteFailure(issueId, "scope", error);
      this.wake(issueId, Date.now() + RETRY_EVERY_MS);
      return false;
    }
    if (message.uncertain) {
      let messages: SlackThreadMessage[] | "unreadable";
      try {
        messages = await this.client.thread(thread);
      } catch (error) {
        this.patch(issueId, key, item => ({ ...messageBase(item), attempts: item.attempts + 1, status: "pending", uncertain: true }));
        this.failed(issueId, key, error);
        return true;
      }
      if (messages === "unreadable" && !await this.organizationChannelAllowed(thread.channelId)) {
        this.wake(issueId, Date.now() + RETRY_EVERY_MS);
        return false;
      }
      const found = Array.isArray(messages) ? messages.find(item => item.key === transport) : undefined;
      if (found) {
        this.patch(issueId, key, item => ({ ...messageBase(item), status: "sent", ts: found.ts }));
        return true;
      }
    }
    try {
      if (!await this.organizationChannelAllowed(thread.channelId)) { this.wake(issueId, Date.now() + RETRY_EVERY_MS); return false; }
    } catch (error) {
      this.noteFailure(issueId, "scope", error);
      this.wake(issueId, Date.now() + RETRY_EVERY_MS);
      return false;
    }
    this.patch(issueId, key, item => ({ ...messageBase(item), attempts: item.attempts + 1, status: "pending", uncertain: true }));
    try {
      const blocks = message.blocks ? [{ type: "markdown", text: message.text }, ...message.blocks] : undefined;
      const { ts } = await this.client.post(thread, message.text, transport, blocks);
      this.patch(issueId, key, item => ({ ...messageBase(item), status: "sent", ts }));
    } catch (error) {
      this.failed(issueId, key, error);
    }
    return true;
  }

  private failed(issueId: string, key: string, error: unknown): void {
    if (!(error instanceof SlackError)) this.logFailure(issueId, "deliver", error);
    const permanent = error instanceof SlackError && !error.transient;
    const summary = errorText(error);
    this.patch(issueId, key, item => {
      if (permanent) return { ...messageBase(item), status: "failed", error: summary };
      if (Date.now() - Date.parse(item.createdAt) >= GIVE_UP_MS) {
        return { ...messageBase(item), status: "failed", uncertain: true, error: summary };
      }
      return {
        ...messageBase(item),
        status: "pending",
        uncertain: true,
        error: summary,
        nextAttemptAt: new Date(Date.now() + (RETRY_DELAYS_MS[item.attempts - 1] ?? RETRY_EVERY_MS)).toISOString(),
      };
    });
  }

  private patch(issueId: string, key: string, change: (message: IntakeMessage) => IntakeMessage): void {
    this.store.update(issueId, draft => {
      const index = draft.messages.findIndex(item => item.key === key);
      if (index !== -1) draft.messages[index] = change(draft.messages[index]);
    });
  }

  private async receive(envelope: SlackEnvelope): Promise<void> {
    if (this.state.kind !== "running") return;
    if (envelope.interaction) { await this.receiveInteraction(envelope); return; }
    const slack = this.slack, event = envelope.event;
    if (!slack || !event || envelope.teamId !== slack.teamId || !event.channel || !event.ts || !event.user
      || event.user === this.state.botUserId || event.botId !== undefined || event.appId !== undefined || event.botProfile
      || event.subtype !== undefined || event.channelType === "im" || event.channelType === "mpim" || event.channel.startsWith("D")) {
      this.droppedCount += 1;
      return;
    }
    if (!await this.organizationChannelAllowed(event.channel)) { this.droppedCount += 1; return; }
    const owner = event.user === slack.ownerUserId;
    const mapped = this.mappedChannel(event.channel);
    const isChannel = event.channelType === "channel" || event.channelType === "group";
    if (slack.ownerOnlyInJoinedChannels && (!owner || !mapped || (event.channelType !== undefined && !isChannel))) {
      this.droppedCount += 1; return;
    }
    const mention = event.type === "app_mention";
    const channelMessage = event.type === "message" && mapped && isChannel;
    if (!mention && !channelMessage) { this.droppedCount += 1; return; }
    const ts = event.ts, thread = { channelId: event.channel, threadTs: event.threadTs ?? ts };
    const inThread = thread.threadTs !== ts;
    if (channelMessage && !slackMessageAfter(ts, inThread ? thread.threadTs : "0")) {
      this.droppedCount += 1;
      return;
    }

    const raw = (event.text ?? "").trim(), text = this.commandText(raw);
    if (channelMessage && raw !== text) return;
    if (channelMessage && (!text || addressedToSomeoneElse(text))) { this.droppedCount += 1; return; }
    const eventId = envelope.eventId ?? envelope.envelopeId;
    if (mapped && inThread && text.toLowerCase() === "status") {
      await this.postThreadStatus(this.store.boundTo(thread), ts, owner, thread);
      return;
    }
    if (!owner) {
      if (mapped && !inThread && text && !isChannelControl(text)) {
        try {
          await this.client.acknowledgeProposal(event.channel, ts);
          this.failures.delete("proposal");
        } catch (error) {
          if (error instanceof SlackError && error.transient) throw error;
          this.log("Intake Slack proposal acknowledgement failed.", error);
          this.failures.set("proposal", errorText(error));
        }
      } else { this.droppedCount += 1; }
      return;
    }

    const bound = this.store.boundTo(thread);
    if (bound.some(record => record.direct && (record.direct.eventId === eventId || record.direct.ts === ts))) return;
    if (bound.length === 0) {
      if (mention && slack.bindByMention && await this.bind(thread, text)) return;
      if (mapped && isChannelControl(text)) return;
      const explicit = explicitRoute(text);
      const channelRequest = explicit ? Boolean(explicit.text) && (explicit.route === "work" || slack.answerQuestions)
        : !inThread && !isChannelControl(text);
      if (this.directOn() && (mention ? Boolean(text || inThread) : channelRequest)) {
        await this.fileDirect(thread, ts, eventId, text, mention ? undefined : "channel-message");
      } else { this.droppedCount += 1; }
      return;
    }
    const duplicate = (record: IntakeRecord) => record.inbound.some(item => item.eventId === eventId || item.ts === ts);
    const holders = bound.filter(duplicate);
    if (holders.length) {
      for (const record of holders) if (record.inbound.some(item => !item.handledAt)) void this.drain(record.issueId);
      return;
    }
    if (bound.every(record => record.state === "finished")) {
      if (!mention) return;
      if (this.directOn() && !this.routesToRecord(bound, text)) { await this.fileDirect(thread, ts, eventId, text); return; }
    }
    const target = this.target(bound, text);
    if (channelMessage && !afterThreadBinding(target.record, ts)) return;
    if (!await this.organizationChannelAllowed(event.channel)) { this.droppedCount += 1; return; }
    this.store.update(target.record.issueId, draft => {
      const accepted: IntakeInbound = { eventId, ts, text: target.text, receivedAt: now(), ...(channelMessage ? { entrypoint: "channel-message" } : {}) };
      if (target.reply) {
        accepted.handledAt = now();
        accepted.outcome = target.outcome;
        addParts(this.config, draft, `reply:${eventId}`, "reply", target.reply, now());
      }
      draft.inbound.push(accepted);
    });
    void this.drain(target.record.issueId);
  }

  private async postThreadStatus(bound: IntakeRecord[], ts: string, owner: boolean, thread: IntakeThread): Promise<void> {
    if (!bound.length) return;
    if (!await this.organizationChannelAllowed(thread.channelId)) return;
    const key = `reply:thread-status:${ts}`;
    if (bound.some(record => record.messages.some(message => message.key === key || message.key.startsWith(`${key}#`)))) return;
    const visible = bound.filter(record => afterThreadBinding(record, ts));
    if (!visible.length) return;
    const active = visible.filter(record => record.state !== "finished");
    const records = active.length ? active : visible.slice(-1);
    const text = records.map(record => formatThreadStatus(record, record.missionId ? this.missions.peek(record.missionId) : undefined, owner)).join("\n\n");
    this.store.update(records.at(-1)!.issueId, draft => addParts(this.config, draft, key, "reply", text, now()));
  }

  private async receiveInteraction(envelope: SlackEnvelope): Promise<void> {
    const slack = this.slack, interaction = envelope.interaction;
    if (!slack || !interaction || interaction.type !== "block_actions" || interaction.teamId !== slack.teamId || interaction.userId !== slack.ownerUserId
      || interaction.actions.length !== 1) { this.droppedCount += 1; return; }
    if (!await this.organizationChannelAllowed(interaction.channelId)) { this.droppedCount += 1; return; }
    const action = interaction.actions[0]!;
    const match = /^(infinite-decision:([0-9a-f-]{36}):([^:]{1,128}))(?:\:(?:submit|other))?$/.exec(action.blockId);
    if (!match || !action.actionTs || !action.actionId.startsWith("infinite_decision_")) { this.droppedCount += 1; return; }
    const [, baseBlockId, issueId, decisionId] = match;
    const record = this.store.get(issueId);
    if (!record?.thread || record.thread.channelId !== interaction.channelId
      || (interaction.threadTs !== undefined && interaction.threadTs !== record.thread.threadTs)) { this.droppedCount += 1; return; }
    const message = record.messages.find(item => item.kind === "question" && item.blocks?.some(block => block.block_id === action.blockId));
    if (!message) { this.droppedCount += 1; return; }
    const controlBlock = message.blocks?.find(block => block.block_id === action.blockId);
    const control = controlBlock?.elements;
    const candidates = [...(Array.isArray(control) ? control : []), ...(controlBlock?.accessory ? [controlBlock.accessory] : [])];
    const element = candidates.find((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && (item as Record<string, unknown>).action_id === action.actionId));
    if (!element) { this.droppedCount += 1; return; }
    const optionValues = Array.isArray(element.options) ? element.options.flatMap(option => option && typeof option === "object"
      && typeof (option as Record<string, unknown>).value === "string" ? [(option as Record<string, unknown>).value as string] : []) : [];
    if ((element.type === "button" && action.value !== element.value)
      || (element.type === "static_select" && action.value !== undefined && !optionValues.includes(action.value))
      || (element.type === "multi_static_select" && action.selectedValues?.some(value => !optionValues.includes(value)))) { this.droppedCount += 1; return; }
    if (message.status !== "sent" && message.uncertain) {
      const messages = await this.client.thread(record.thread);
      const found = Array.isArray(messages) ? messages.find(item => item.key === `${issueId}:${message.key}` && item.ts === interaction.messageTs) : undefined;
      if (found) this.patch(issueId, message.key, item => ({ ...messageBase(item), status: "sent", ts: found.ts }));
    }
    const persisted = this.store.get(issueId)!;
    const sent = persisted.messages.find(item => item.key === message.key);
    if (!sent || sent.status !== "sent" || sent.ts !== interaction.messageTs) { this.droppedCount += 1; return; }
    const identity = `${interaction.channelId}:${interaction.messageTs}:${action.actionTs}:${action.actionId}`;
    const entryId = `interactive:${identity}`;
    const duplicate = persisted.inbound.find(item => item.interactionId === identity || item.eventId === entryId);
    if (duplicate) { if (!duplicate.handledAt) void this.drain(issueId); return; }
    const mission = persisted.missionId ? this.missions.peek(persisted.missionId) : undefined;
    const decision = mission?.decisions.find(item => item.id === decisionId);
    const question = persisted.questions.find(item => item.decisionId === decisionId);
    if (!mission || !decision || decision.answer || !question) { this.droppedCount += 1; return; }
    const mode = decision.answerMode ?? "single";
    const blockRoot = baseBlockId;
    const values = action.selectedValues ?? (action.value === undefined ? [] : [action.value]);
    const validIndexes = (items: string[]) => items.every(value => /^(0|[1-9]\d*)$/.test(value) && Number(value) < decision.options.length)
      && new Set(items).size === items.length;
    if (action.actionId === "infinite_decision_multi" && mode === "multiple") {
      if (!validIndexes(values)) { this.droppedCount += 1; return; }
      return;
    }
    let answerText: string | undefined;
    let reply: string | undefined;
    if (action.actionId === "infinite_decision_other" && (mode === "single" || mode === "multiple") && action.value === "other") reply = alternativePrompt(question.n, this.threadReplies(record.thread));
    else if (action.actionId === "infinite_decision_deny" && mode === "approval" && action.value === "1") reply = alternativePrompt(question.n, this.threadReplies(record.thread));
    else if ((action.actionId === "infinite_decision_choice" || /^infinite_decision_choice_\d+$/.test(action.actionId))
      && (mode === "single" || mode === "approval") && validIndexes(values) && values.length === 1
      && (!action.actionId.endsWith("choice") || action.value === values[0])
      && (!action.actionId.startsWith("infinite_decision_choice_") || action.actionId === `infinite_decision_choice_${values[0]}`)
      && (mode !== "approval" || values[0] === "0")) {
      answerText = decision.options[Number(values[0])];
    } else if (action.actionId === "infinite_decision_submit" && mode === "multiple" && action.value === "submit") {
      const selection = interaction.state?.[blockRoot]?.infinite_decision_multi;
      const selected = selection?.selectedValues ?? [];
      if (selection?.type !== "multi_static_select" || !validIndexes(selected) || selected.length === 0) { this.droppedCount += 1; return; }
      answerText = selected.map((value, index) => `${index + 1}. ${decision.options[Number(value)]}`).join("\n");
    } else { this.droppedCount += 1; return; }
    const text = reply ?? `Q${question.n} ${answerText}`;
    if (!await this.organizationChannelAllowed(interaction.channelId)) { this.droppedCount += 1; return; }
    this.store.update(issueId, draft => {
      if (draft.inbound.some(item => item.interactionId === identity)) return;
      const entry: IntakeInbound = { eventId: entryId, interactionId: identity, ts: interaction.messageTs, text, receivedAt: now(),
        ...(answerText !== undefined ? { call: { action: "answer", decisionId, text: answerText, revision: mission.revision } } : {}) };
      if (reply) { entry.handledAt = now(); entry.outcome = "alternative-requested"; addParts(this.config, draft, `reply:${entryId}`, "reply", reply, now()); }
      draft.inbound.push(entry);
    });
    if (!reply) void this.drain(issueId);
  }

  private async fileDirect(thread: IntakeThread, ts: string, eventId: string, text: string, entrypoint?: "channel-message"): Promise<void> {
    try {
      if (!await this.organizationChannelAllowed(thread.channelId)) { this.droppedCount += 1; return; }
      this.direct!({ thread, ts, eventId, text, ...(entrypoint ? { entrypoint } : {}) });
    } catch (error) {
      this.log("Intake Slack direct request failed.", error);
      this.droppedCount += 1;
      throw error;
    }
  }

  private routesToRecord(bound: IntakeRecord[], text: string): boolean {
    if (QUESTION.test(text) || ACTIONS.has(text.toLowerCase()) || extendCommand(text) !== undefined) return true;
    return bound.some(record => record.identifier !== ""
      && new RegExp(`^${escapeRegExp(record.identifier)}(?=$|[\\s:,])`, "i").test(text));
  }

  private target(bound: IntakeRecord[], text: string): { record: IntakeRecord; text: string; outcome?: string; reply?: string } {
    const unfinished = bound.filter(record => record.state !== "finished");
    const fallback = unfinished.length > 0 ? unfinished.at(-1)! : bound.at(-1)!;
    const leading = QUESTION.exec(text);
    if (leading) {
      const n = Number(leading[1]);
      const holder = bound.find(record => record.questions.some(question => question.n === n));
      return holder ? { record: holder, text } : { record: fallback, text, outcome: "unknown-question", reply: `There is no question Q${n}.` };
    }
    for (const record of bound.filter(item => item.identifier !== "")) {
      const named = new RegExp(`^${escapeRegExp(record.identifier)}(?=$|[\\s:,])`, "i").exec(text);
      if (named) return { record, text: text.slice(named[0].length).replace(/^\s*[:,]?\s*/, "") };
    }
    const answerRecord = unfinished.length > 1 ? unfinished.find(isAnswerRecord) : undefined;
    const selected = answerRecord ? /^answer(?=$|[\s:,])/i.exec(text) : null;
    if (answerRecord && selected) return { record: answerRecord, text: text.slice(selected[0].length).replace(/^\s*[:,]?\s*/, "") };
    if (unfinished.length > 1) {
      const open = unfinished.map(record => record.identifier || `answer (your question "${record.title}")`).join(", ");
      const selector = unfinished.some(isAnswerRecord) ? 'an identifier, "answer", or a question number' : "an identifier or a question number";
      return { record: fallback, text, outcome: "ambiguous",
        reply: `More than one request is open in this thread: ${open}. Start your reply with ${selector}.` };
    }
    return { record: fallback, text };
  }

  private commandText(text: string): string {
    const botUserId = this.state.kind === "running" ? this.state.botUserId : "";
    return text.replace(new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]*)?>`, "g"), "").trim();
  }

  private async bind(thread: IntakeThread, text: string): Promise<boolean> {
    if (!await this.organizationChannelAllowed(thread.channelId)) return false;
    const matches = this.store.list().filter(record =>
      !record.thread && (record.state === "started" || record.state === "queued") && mentionsIdentifier(text, record.identifier));
    if (matches.length !== 1) return false;
    this.store.update(matches[0].issueId, draft => { if (draft.state !== "skipped") draft.thread = thread; });
    return true;
  }

  private async drain(issueId: string): Promise<void> {
    if (this.draining.has(issueId)) return;
    this.draining.add(issueId);
    try {
      for (;;) {
        if (this.state.kind !== "running") return;
        const record = this.store.get(issueId);
        const entry = record?.inbound.find(item => !item.handledAt);
        if (!record || !entry) return;
        await this.requireOrganizationSource(record.thread);
        await this.apply(record, entry);
      }
    } catch (error) {
      this.noteFailure(issueId, "inbound", error);
      if (error instanceof SlackError && (error.transient || error.code === "organization_scope_denied")) this.retryDrain(issueId);
    } finally {
      this.draining.delete(issueId);
    }
  }

  private async apply(record: IntakeRecord, entry: IntakeInbound): Promise<void> {
    await this.requireOrganizationSource(record.thread);
    const { outcome, reply } = await this.act(record, entry);
    await this.requireOrganizationSource(record.thread);
    this.store.update(record.issueId, draft => {
      const item = draft.inbound.find(candidate => candidate.eventId === entry.eventId);
      if (!item || item.handledAt) return;
      item.handledAt = now();
      item.outcome = outcome;
      if (reply) addParts(this.config, draft, `reply:${entry.eventId}`, "reply", reply, now());
    });
  }

  private async act(record: IntakeRecord, entry: IntakeInbound): Promise<Outcome> {
    await this.requireOrganizationSource(record.thread);
    if (entry.call) return this.perform(record, entry, entry.call);
    if (record.state === "finished") return { outcome: "finished", reply: `This request has finished. ${this.followUp()}` };
    const mission = record.missionId ? this.missions.peek(record.missionId) : undefined;
    if (!mission) return { outcome: "not-started", reply: NOT_STARTED };
    const routed = this.route(record, mission, entry.text, entry.entrypoint === "channel-message" ? entry.ts : undefined);
    if (!routed.call) return { outcome: routed.outcome, reply: routed.reply };
    const call: SavedCall = { ...routed.call, revision: mission.revision };
    await this.requireOrganizationSource(record.thread);
    this.rememberCall(record.issueId, entry.eventId, call);
    return this.perform(record, entry, call);
  }

  private route(record: IntakeRecord, mission: Mission, text: string, channelReplyTs?: string): Routed {
    const lower = text.toLowerCase();
    if (lower === "status") {
      const open = mission.decisions.filter(decision => !decision.answer).flatMap(decision => {
        const question = record.questions.find(item => item.decisionId === decision.id);
        return question ? [`Q${question.n}: ${decision.question}`] : [];
      });
      return { outcome: "status", reply: [mission.status, ...open].join("\n") };
    }
    if (ACTIONS.has(lower)) return { outcome: lower, call: { action: lower as "pause" | "resume" | "cancel" } };
    const extend = extendCommand(text);
    if (extend === "invalid") return { outcome: "invalid-extend", reply: EXTEND_HELP };
    if (extend) return { outcome: "extend", call: { action: "extend", minutes: extend.minutes ?? Math.min(mission.maxMinutes, EXTEND_CAP) } };
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
    if (channelReplyTs) {
      const key = `q:${decision.id}`;
      const post = record.messages.find(message => message.ts && (message.key === key || message.key === `${key}#1`));
      if (!slackMessageAfter(channelReplyTs, post?.ts)) {
        return { outcome: "question-not-visible", reply: "Please answer the open question in a new reply so I can match your answer to it." };
      }
    }
    const remainder = leading ? text.slice(leading[0].length).trim() : text;
    if (remainder === "") return { outcome: "empty-answer", reply: this.threadReplies(record.thread) ? "Reply in this thread with your answer." : "Reply with a mention and your answer." };
    const choice = /^\d+$/.test(remainder) ? Number(remainder) : undefined;
    const answer = choice !== undefined && choice >= 1 && choice <= decision.options.length ? decision.options[choice - 1] : remainder;
    return { outcome: "answered", call: { action: "answer", decisionId: decision.id, text: answer } };
  }

  private async perform(record: IntakeRecord, entry: IntakeInbound, saved: SavedCall): Promise<Outcome> {
    await this.requireOrganizationSource(record.thread);
    try {
      const missionId = record.missionId;
      if (!missionId) throw new TeamError(404, "mission-not-found", "This mission does not exist.");
      const requestId = deterministicUuid("intake-slack-event", entry.eventId);
      let revision = saved.revision;
      for (let attempt = 1; ; attempt++) {
        const call: SavedCall = { ...saved, revision };
        this.rememberCall(record.issueId, entry.eventId, call);
        try {
          await this.requireOrganizationSource(record.thread);
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
      if (saved.action === "extend") return { outcome: OUTCOMES.extend, reply: this.extendedText(missionId, saved.minutes!) };
      if (saved.action === "answer") {
        const question = record.questions.find(item => item.decisionId === saved.decisionId);
        return { outcome: OUTCOMES[saved.action], reply: question ? `Received your answer to Q${question.n}.` : "Received your answer." };
      }
      return { outcome: OUTCOMES[saved.action] };
    } catch (error) {
      if (error instanceof SlackError) throw error;
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
    if (call.action === "extend") return this.missions.extend(missionId, { requestId, revision, minutes: call.minutes! });
    return this.missions.cancel(missionId, { requestId, revision });
  }

  private extendedText(missionId: string, minutes: number): string {
    const amount = extendedAmount(minutes);
    const mission = this.missions.peek(missionId);
    return mission ? `Extended by ${amount}. The mission now stops at ${utcMinute(mission.deadlineAt)}.` : `Extended by ${amount}.`;
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

  private retryDrain(issueId: string): void {
    if (this.state.kind !== "running") return;
    clearTimeout(this.drainTimers.get(issueId));
    const timer = setTimeout(() => {
      this.drainTimers.delete(issueId);
      void this.drain(issueId);
    }, RETRY_EVERY_MS);
    timer.unref();
    this.drainTimers.set(issueId, timer);
  }
}
