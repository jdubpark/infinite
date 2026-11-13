import { deterministicUuid, type IntakeConfig, type IntakeInbound, type IntakeMessage, type IntakeMessageKind, type IntakeRecord, type IntakeThread, type SlackThreadMessage } from "./intake-types.js";
import type { IntakeStore } from "./intake-store.js";
import type { Mission, MissionDecision } from "./mission-types.js";
import type { MissionService } from "./missions.js";
import type { Config } from "./types.js";
import type { TeamService } from "./teams.js";
import { TeamError } from "./teams.js";
import { SlackError, type SlackClient, type SlackEnvelope } from "./slack-client.js";
import { splitSlackText } from "./slack-text.js";

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

interface Outcome { outcome: string; reply?: string }

const now = () => new Date().toISOString();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameThread = (a: IntakeThread | undefined, b: IntakeThread | undefined) =>
  Boolean(a && b && a.channelId === b.channelId && a.threadTs === b.threadTs);
const mentionsIdentifier = (text: string, identifier: string) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(identifier)}(?![A-Za-z0-9])`).test(text);

/** Adds the text as one pending message, or as numbered parts when it is longer than one Slack message. */
function addParts(draft: IntakeRecord, key: string, kind: IntakeMessageKind, text: string, createdAt: string) {
  const parts = splitSlackText(text);
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
  private unsubscribers: (() => void)[] = [];

  constructor(config: Config, private readonly store: IntakeStore, private readonly missions: MissionService,
    private readonly teams: Pick<TeamService, "get">, private readonly client: SlackClient) {
    this.slack = config.intake?.slack;
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
    this.connection?.close();
    this.connection = undefined;
  }

  status(): { connected: boolean; reason?: string; dropped: number } {
    return { connected: this.connection?.connected() ?? false, ...(this.reason ? { reason: this.reason } : {}), dropped: this.droppedCount };
  }

  private async verify(): Promise<void> {
    if (this.closed || !this.slack) return;
    let identity: { teamId: string; userId: string };
    try {
      identity = await this.client.authTest();
    } catch {
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
    } catch {
      // A composition that cannot read its mission or team is retried on the next change.
    }
    void this.pump(issueId);
  }

  private compose(draft: IntakeRecord, mission: Mission | undefined): void {
    const at = now();
    const has = (key: string) => draft.messages.some(message => message.key === key || message.key.startsWith(`${key}#`));
    const add = (key: string, kind: IntakeMessageKind, text: string) => {
      if (!has(key)) addParts(draft, key, kind, text, at);
    };
    const title = `${draft.identifier} "${draft.title}"`;
    if (draft.state === "started") {
      add("ack", "ack", `Started on ${title}. I'll post questions and the result here.\nReply with a mention to answer or steer.`);
    } else if (draft.state === "queued" && draft.holdReason === "max-active") {
      add("ack", "ack", `Queued ${title}. It starts when a running request finishes. I'll post questions and the result here.`);
    }
    if (draft.state === "started" && draft.messages.find(message => message.key === "ack")?.text.startsWith("Queued ")) {
      add("started", "started", `Started on ${draft.identifier}.`);
    }
    if (mission) {
      for (const decision of mission.decisions) {
        if (decision.answer || has(`q:${decision.id}`)) continue;
        const n = this.questionNumber(draft, decision.id);
        addParts(draft, `q:${decision.id}`, "question", questionText(decision)(n), at);
      }
      if (mission.status === "ready-for-review" && mission.result) {
        add(`result:${mission.result.revision}`, "result", this.resultText(mission));
      }
      if (mission.status === "blocked") {
        add(`status:blocked:${mission.revision}`, "status", `Blocked: ${mission.reason ?? NO_REASON}\nFile a follow-up with Linear's agent in this thread.`);
      }
      if (mission.status === "cancelled") {
        add(`status:cancelled:${mission.revision}`, "status", `Cancelled: ${mission.reason ?? NO_REASON}`);
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
    } catch {
      // A failed store write leaves the message pending; the next change pumps again.
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

  private async deliver(issueId: string, thread: IntakeThread, message: IntakeMessage): Promise<void> {
    const key = message.key;
    if (message.uncertain) {
      let messages: SlackThreadMessage[] | "unreadable";
      try {
        messages = await this.client.thread(thread);
      } catch (error) {
        this.failed(issueId, key, error);
        return;
      }
      const found = Array.isArray(messages) ? messages.find(item => item.key === key) : undefined;
      if (found) {
        this.patch(issueId, key, item => {
          item.status = "sent"; item.ts = found.ts; delete item.uncertain; delete item.nextAttemptAt; delete item.error;
        });
        return;
      }
    }
    try {
      const { ts } = await this.client.post(thread, message.text, key);
      this.patch(issueId, key, item => {
        item.status = "sent"; item.ts = ts; item.attempts += 1;
        delete item.uncertain; delete item.nextAttemptAt; delete item.error;
      });
    } catch (error) {
      this.failed(issueId, key, error);
    }
  }

  private failed(issueId: string, key: string, error: unknown): void {
    const code = error instanceof SlackError ? error.code : "error";
    const permanent = error instanceof SlackError && !error.transient;
    this.patch(issueId, key, item => {
      item.attempts += 1;
      item.error = code;
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
    const record = this.store.forThread(thread);
    if (!record) {
      if (slack.bindByMention && this.bind(thread, text)) return;
      this.droppedCount += 1;
      return;
    }
    const ts = event.ts;
    this.store.update(record.issueId, draft => {
      if (draft.inbound.some(item => item.eventId === eventId)) return;
      const accepted: IntakeInbound = { eventId, ts, text, receivedAt: now() };
      draft.inbound.push(accepted);
    });
    void this.drain(record.issueId);
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
    } catch {
      // A failed store write leaves the entry unhandled; it is applied again on the next event or start.
    } finally {
      this.draining.delete(issueId);
    }
  }

  private async apply(record: IntakeRecord, entry: IntakeInbound): Promise<void> {
    const { outcome, reply } = await this.act(record, entry.text, entry.eventId);
    this.store.update(record.issueId, draft => {
      const item = draft.inbound.find(candidate => candidate.eventId === entry.eventId);
      if (!item || item.handledAt) return;
      item.handledAt = now();
      item.outcome = outcome;
      if (reply) addParts(draft, `reply:${entry.eventId}`, "reply", reply, now());
    });
  }

  private async act(record: IntakeRecord, text: string, eventId: string): Promise<Outcome> {
    if (record.state === "finished") return { outcome: "finished", reply: FINISHED };
    const mission = record.missionId ? this.missions.peek(record.missionId) : undefined;
    if (!mission) return { outcome: "not-started", reply: NOT_STARTED };
    const requestId = deterministicUuid("intake-slack-event", eventId);
    const id = mission.id;
    try {
      const lower = text.toLowerCase();
      if (ACTIONS.has(lower)) return await this.missionCommand(record, mission, lower, requestId);
      const open = mission.decisions.filter(decision => !decision.answer);
      const leading = /^Q(\d+)(?!\w)\s*/i.exec(text);
      if (open.length === 0) {
        if (leading || /^\d+$/.test(text)) return { outcome: "already-answered", reply: ALREADY_ANSWERED };
        await this.missionAction(id, revision => this.missions.steer(id, { requestId, revision, text }, "slack"));
        return { outcome: "steered" };
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
      const decisionId = decision.id;
      await this.missionAction(id, revision => this.missions.answer(id, decisionId, { requestId, revision, text: answer }, "slack"));
      return { outcome: "answered" };
    } catch (error) {
      // The request ID is derived from the event, so a conflict means this event already reached the mission
      // (a restart before its handled mark was written). The stored receipt covers the revision it was applied at.
      if (error instanceof TeamError && error.code === "request-conflict") return { outcome: "already-applied" };
      if (error instanceof TeamError) return { outcome: "refused", reply: error.message };
      return { outcome: "error", reply: UNEXPECTED };
    }
  }

  private async missionCommand(record: IntakeRecord, mission: Mission, command: string, requestId: string): Promise<Outcome> {
    const id = mission.id;
    if (command === "status") {
      const open = mission.decisions.filter(decision => !decision.answer).flatMap(decision => {
        const question = record.questions.find(item => item.decisionId === decision.id);
        return question ? [`Q${question.n}: ${decision.question}`] : [];
      });
      return { outcome: "status", reply: [mission.status, ...open].join("\n") };
    }
    if (command === "pause") await this.missionAction(id, revision => this.missions.pause(id, { requestId, revision }));
    else if (command === "resume") await this.missionAction(id, revision => this.missions.resume(id, { requestId, revision }));
    else await this.missionAction(id, revision => this.missions.cancel(id, { requestId, revision }));
    return { outcome: command };
  }

  /** Runs one mission call against the current revision, retrying once when the revision moved first. */
  private async missionAction(missionId: string, call: (revision: number) => unknown): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const revision = this.missions.peek(missionId)?.revision;
      if (revision === undefined) throw new TeamError(404, "mission-not-found", "This mission does not exist.");
      try {
        await call(revision);
        return;
      } catch (error) {
        if (attempt === 1 && error instanceof TeamError && error.code === "stale-mission-revision") continue;
        throw error;
      }
    }
  }
}
