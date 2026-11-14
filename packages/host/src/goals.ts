import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSealed, unseal } from "./vault.js";
import { autonomyOf, type AutonomyMode } from "./autonomy.js";
import { TeamService, TeamError } from "./teams.js";
import { goalActionSchema, goalExtendSchema, goalOutcomeSchema, goalParallelismSchema, goalSteerSchema, parseCreateGoal, type CreateGoal, type CycleClass, type GoalCycle, type GoalReasonCode, type ProductGoal } from "./goal-types.js";
import type { Config } from "./types.js";
import { DEFAULT_TEAM_RETENTION, hostClosedBlockedReason, type CreateTeam, type TeamGoalContext, type TeamView } from "./team-types.js";
import { addRollups, emptyRollup, type StoredRollup, type UsageRollup } from "./team-usage.js";
import type { LinearService } from "./linear.js";
import { applyFuseReason } from "./fuse/rules.js";
import type { FuseGate } from "./fuse/types.js";
import { addToPendingWake, type PendingWake, type ProjectSignal, type SignalReader } from "./signals/types.js";
import { cadenceDue, classifyCycle, cycleWakeOf, defaultWakeMinGapMinutes, foldedCycles, isReviewed, keptCycles, latestReviewed, maxFailedCycles, maxPreviousWork, restoreWake, runObjectiveLimitBytes, unresolvedOperation, wakeObjective } from "./goal-standing.js";

type Action = { requestId: string; revision: number };
/** `parallelism` remains readable only so a pre-migration queued owner control can be discarded safely. */
type PendingControl = { action: "pause" | "resume" | "cancel" | "steer" | "parallelism"; requestId: string; teamId: string; revision: number; text?: string; parallelism?: number };
type GoalExtensionIntent = Action & { minutes: number; fingerprint: string; teamId?: string; targetDeadlineAt?: string; targetCeilingAt?: string; failures?: number };
/** `wake` is the standing goal's pending wake this launch consumed, returned to the goal if the run is never created. */
type PendingLaunch = { request: CreateTeam; context: TeamGoalContext; autonomy?: AutonomyMode; wake?: PendingWake };
type Stored = {
  goal: ProductGoal;
  fingerprint: string;
  receipts: Record<string, string>;
  launch?: PendingLaunch;
  control?: PendingControl;
  extensionIntent?: GoalExtensionIntent;
  /** Standing goals: after a retryable failure to create a cycle's run, no cycle starts before this time. */
  launchRetryAt?: string;
};
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = new Set(["blocked", "ready-for-review", "no-opportunity", "limit-reached", "cancelled", "achieved"]);
const timeLimitReason = "The approved time limit has expired.";
const repeatedFailuresReason = "Three cycles in a row failed, so this standing goal paused. Review the failed cycles, then resume it to reset the count.";
const maxExtensionFailures = 3;
const launchRetryMs = 60_000;
/**
 * Failures to create a standing cycle's run that leave no run and pass with time: storage the host could not measure
 * or found low, a window that lapsed while creation waited (the retry gets a fresh one), a mission's hold on the
 * repository, and file or process resource exhaustion. Everything else (configuration, lineup, parent, schema) blocks.
 */
const retryableCreation = new Set(["host-storage-low", "host-storage-unavailable", "goal-deadline", "mission-repository-reserved", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EAGAIN", "EBUSY"]);
function errorCode(error: unknown) {
  const code: unknown = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}
/** Goals created before ceilings existed use their original creation-time budget. */
const ceilingOf = (goal: ProductGoal) => goal.ceilingAt ?? new Date(Date.parse(goal.createdAt) + (goal.maxTotalMinutes ?? goal.maxMinutes) * 60000).toISOString();
/** Flatten totals for existing cycle displays while retaining the complete rollup for parent aggregation. */
const cycleUsageSnapshot = (usage: UsageRollup) => ({ ...usage.total, ...usage });
/** A cycle's usage from its retained snapshot, for a cycle whose run record is gone. */
function snapshotRollup(cycle: GoalCycle): StoredRollup {
  const snapshot = cycle.usage;
  if (snapshot?.total && snapshot.byProfile && snapshot.byProvider && Number.isInteger(snapshot.unmeasuredMembers))
    return { total: snapshot.total, byProfile: snapshot.byProfile, byProvider: snapshot.byProvider, unmeasuredMembers: snapshot.unmeasuredMembers };
  const rollup = emptyRollup(cycle.memberCount);
  if (snapshot) rollup.total = snapshot;
  return rollup;
}

/** Goals select bounded work; the Team executor owns every agent and Git operation. */
export class GoalService {
  private readonly records = new Map<string, Stored>();
  private readonly saved = new Map<string, string>();
  private readonly directory: string;
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private tickQueued = false;
  private fuse?: FuseGate;
  private signals?: SignalReader;

  constructor(private readonly config: Config, private readonly key: Buffer, private readonly teams: TeamService, private readonly linear?: LinearService) {
    this.directory = join(config.stateDir, "goals");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `goal:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.goal.id !== id) throw new TeamError(409, "invalid-goal-record", "A goal record cannot be authenticated.");
      if (!stored.goal.stopReason && stored.goal.status === "limit-reached") {
        if (stored.goal.reason === timeLimitReason) stored.goal.stopReason = "deadline";
        else {
          const lastTeamId = stored.goal.activeTeamId ?? stored.goal.cycles.at(-1)?.teamId;
          if (lastTeamId) try {
            const reason = this.teams.get(lastTeamId).stopReason;
            if (reason === "deadline" || reason === "member-limit") stored.goal.stopReason = reason;
          } catch (error) { if (!(error instanceof TeamError) || error.code !== "team-not-found") throw error; }
        }
      }
      this.records.set(id, stored);
      this.saved.set(id, digest(stored));
    }
  }
  /** The launch-rate fuse. A service without one starts every cycle it would have started before. */
  useFuse(fuse: FuseGate) { this.fuse = fuse; }
  /** The project signal inbox. A service without one behaves as if no signal ever arrives. */
  useSignals(reader: SignalReader) { this.signals = reader; }
  private wakeGapMinutes() { return this.config.autonomy?.continuity?.wakeMinGapMinutes ?? defaultWakeMinGapMinutes; }
  /** The inbox head, or undefined while it cannot be read. The reader must not throw; a throw reads as unreadable. */
  private signalHead() {
    try { const head = this.signals?.head(); return Number.isInteger(head) && head! >= 0 ? head : undefined; }
    catch { return undefined; }
  }
  enabled() {
    const lineup = this.config.teams?.lineup;
    return Boolean(lineup && lineup.coordinator.tier === "strong" && lineup.reviewer.tier === "strong");
  }
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task); this.serial = next.catch(() => {}); return next;
  }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "goal-not-found", "This goal does not exist.");
    return stored;
  }
  private save(stored: Stored) {
    if (this.saved.get(stored.goal.id) === digest(stored)) return;
    stored.goal.updatedAt = now();
    writeSealed(join(this.directory, `${stored.goal.id}.sealed`), this.key, `goal:${stored.goal.id}`, stored);
    this.saved.set(stored.goal.id, digest(stored));
  }
  private event(stored: Stored, text: string) {
    stored.goal.events.push({ at: now(), text });
    if (stored.goal.events.length > 200) stored.goal.events.splice(0, stored.goal.events.length - 200);
  }
  private block(stored: Stored, reason: string) {
    if (stored.goal.status !== "blocked") stored.goal.blockedAt = now();
    stored.goal.status = "blocked"; stored.goal.reason = reason;
  }
  private closeStaleBlocked(stored: Stored) {
    const goal = stored.goal;
    if (goal.status !== "blocked") return;
    const hours = this.config.teams?.retention?.blockedHours ?? DEFAULT_TEAM_RETENTION.blockedHours;
    // A record from before this field cannot date its block (a child's block writes no goal event), so its period
    // starts at its last save: never earlier than the block, hence never an early close.
    goal.blockedAt ??= goal.updatedAt;
    const since = Date.parse(goal.blockedAt);
    if (!Number.isFinite(since) || Date.now() - since < hours * 3600000) return;
    const reason = hostClosedBlockedReason(hours, goal.reason);
    this.setControl(stored, "cancel");
    goal.status = "cancelled"; goal.reason = reason;
    if (!goal.events.some(event => event.text === reason)) this.event(stored, reason);
    this.save(stored);
  }
  /** Status rows for owner alerts. Unlike list(), reading them does not refresh tracker state or usage. */
  statuses() { return [...this.records.values()].map(({ goal }) => ({ id: goal.id, title: goal.title, status: goal.status, reason: goal.reason })); }
  ownsActiveTeam(teamId: string) {
    return [...this.records.values()].some(({ goal }) =>
      !terminal.has(goal.status) && goal.activeTeamId === teamId);
  }
  /**
   * A live goal may still need the source run while its cycle evidence is being retained. A live standing goal keeps
   * only its active cycle's run and the parent of its next cycle; older cycles follow the normal retention windows.
   */
  retainsTeamRun(teamId: string) {
    return [...this.records.values()].some(({ goal, launch }) => !terminal.has(goal.status) && (goal.standing
      ? goal.activeTeamId === teamId || launch?.request.requestId === teamId || latestReviewed(goal.cycles)?.teamId === teamId
      : goal.activeTeamId === teamId || goal.cycles.some(cycle => cycle.teamId === teamId)));
  }
  /** Persisted goal records for the read-only Understanding view; performs no tracker or usage refresh. */
  understandingRecords() { return [...this.records.values()].map(({ goal }) => structuredClone(goal)); }
  list() { return [...this.records.values()].map(({ goal }) => this.get(goal.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string) {
    const goal = structuredClone(this.record(id).goal);
    const tracking = this.linear?.updateGoal(goal, goal.linearTracking === true);
    goal.linear = this.linear?.getGoal(id) ?? tracking ?? goal.linear;
    const tasks: { teamId: string; taskId: string; title: string; usage?: import("./usage-api.js").TaskUsage }[] = [];
    const rollups = goal.cycles.map(cycle => {
      try {
        const team = this.teams.get(cycle.teamId), { usage } = team;
        for (const task of team.tasks) tasks.push({ teamId: cycle.teamId, taskId: task.id, title: task.title, ...((task as typeof task & { usage?: import("./usage-api.js").TaskUsage }).usage ? { usage: (task as typeof task & { usage?: import("./usage-api.js").TaskUsage }).usage } : {}) });
        // A cycle whose members are all unmeasured has no figure; a zero total would read as measured and free.
        if (usage.total.messages > 0 || usage.unmeasuredMembers === 0) cycle.usage = cycleUsageSnapshot(usage);
        else delete cycle.usage;
        return usage;
      } catch (error) {
        if (error instanceof TeamError && error.code === "team-not-found") return snapshotRollup(cycle);
        throw error;
      }
    });
    goal.usage = addRollups(goal.foldedUsage ? [...rollups, goal.foldedUsage] : rollups);
    const last = goal.cycles.at(-1);
    if (goal.standing && last && !goal.activeTeamId && !terminal.has(goal.status))
      goal.nextCycleAt = new Date(cadenceDue(last, goal.standing.cadenceMinutes, Date.now())).toISOString();
    return { ...goal, tasks };
  }
  answer(teamId: string, decisionId: string, body: Action & { text: string }) {
    return this.enqueue(async () => {
      const team = this.teams.get(teamId);
      if (!team.goal) throw new TeamError(409, "not-a-goal-team", "This team does not belong to a goal.");
      return this.teams.answer(teamId, decisionId, body, () => {
        const { goal } = this.record(team.goal!.id);
        if (goal.activeTeamId !== teamId || !["running", "needs-input"].includes(goal.status) || Date.now() >= Date.parse(goal.deadlineAt))
          throw new TeamError(409, "goal-not-running", "Only the active team of a running goal can receive a decision.");
      });
    });
  }
  activeForProject(projectId: string) {
    return [...this.records.values()].some(({ goal, launch, control }) => goal.projectId === projectId && (Boolean(launch || control || goal.activeTeamId) || ["running", "needs-input", "paused"].includes(goal.status)));
  }
  create(input: CreateGoal, admit?: () => void) {
    const request = parseCreateGoal(input);
    return this.enqueue(() => {
      const fingerprint = digest(request), prior = this.records.get(request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different goal.");
        return structuredClone(prior.goal);
      }
      // A scheduled approval can expire or change while waiting behind another
      // goal operation. Validate it in this transaction, immediately before a
      // new goal receives its execution window. Existing receipts remain replayable.
      admit?.();
      if (!this.enabled()) throw new TeamError(409, "goals-not-configured", "Configure a team lineup with a strong coordinator and reviewer before starting a goal.");
      if (Buffer.byteLength(JSON.stringify(request)) > 40000) throw new TeamError(409, "goal-too-large", "Keep the goal and evidence below 40 KiB. Link to longer source material.");
      const project = this.config.projects.find(value => value.id === request.projectId);
      if (!project?.team || (!project.team.checks.length && !project.team.establishChecks)) throw new TeamError(409, "goal-project-not-configured", "Configure required checks or authorize the team to establish them before a goal can start.");
      if (request.linearIssueId && !project.linear) throw new TeamError(409, "linear-not-configured", "Configure Linear for this project before linking an issue.");
      if (request.standing && autonomyOf(project) !== "autonomous")
        throw new TeamError(409, "standing-requires-autonomy", "A standing goal needs an autonomous project. Start a finite goal, or make the project autonomous first.");
      // Every cycle passes the whole objective; the host never cuts the owner's text to fit its wake reasons.
      if (request.standing && Buffer.byteLength(request.objective) > runObjectiveLimitBytes)
        throw new TeamError(400, "standing-objective-too-large", `A standing goal's objective must fit in ${runObjectiveLimitBytes.toLocaleString("en-US")} bytes of UTF-8. Shorten it and start the goal again.`);
      const { requestId, parallelism: _legacyParallelism, ...fields } = request;
      const createdAt = now();
      const cursor = request.standing?.wakeOn ? this.signalHead() : undefined;
      const stored: Stored = { fingerprint, receipts: {}, goal: {
        ...fields, parallelism: 4, maxTotalMinutes: request.maxTotalMinutes ?? request.maxMinutes, linearTracking: Boolean(project.linear), id: requestId, revision: 1, status: "running", createdAt, updatedAt: createdAt,
        deadlineAt: new Date(Date.parse(createdAt) + request.maxMinutes * 60000).toISOString(),
        ceilingAt: new Date(Date.parse(createdAt) + (request.maxTotalMinutes ?? request.maxMinutes) * 60000).toISOString(),
        lineup: structuredClone(this.config.teams!.lineup!), autonomy: autonomyOf(project), cycles: [], memberCount: 0, steering: [], events: [], outcomes: [],
        ...(cursor !== undefined ? { signalCursor: cursor } : {}),
      } };
      this.event(stored, request.standing
        ? `Standing goal approved. A cycle starts now and then every ${request.standing.cadenceMinutes} minutes, each within its own time and attempt limits.`
        : "Goal approved. The coordinator can select and build work within its scope and limits.");
      this.records.set(requestId, stored); this.save(stored);
      stored.goal.linear = this.linear?.updateGoal(stored.goal, stored.goal.linearTracking === true); this.save(stored);
      return structuredClone(stored.goal);
    });
  }
  private replay(stored: Stored, action: string, body: Action & object) {
    const prior = stored.receipts[body.requestId];
    if (!prior) return false;
    if (prior !== digest({ action, ...body })) throw new TeamError(409, "request-conflict", "This request ID belongs to a different goal action.");
    return true;
  }
  private validateAction(stored: Stored, body: Action) {
    if (body.revision !== stored.goal.revision) throw new TeamError(409, "stale-goal-revision", "The goal changed. Refresh it before sending this action.");
    if (stored.control) throw new TeamError(409, "goal-control-pending", "The previous goal action is still being applied.");
  }
  private admit(stored: Stored, action: string, body: Action & object) {
    this.validateAction(stored, body);
    stored.receipts[body.requestId] = digest({ action, ...body });
    stored.goal.revision++;
  }
  private setControl(stored: Stored, action: PendingControl["action"], options: { text?: string; parallelism?: number } = {}) {
    if (!stored.goal.activeTeamId) return;
    let team: TeamView;
    try { team = this.teams.get(stored.goal.activeTeamId); }
    catch (error) {
      if (error instanceof TeamError && error.code === "team-not-found") {
        if (stored.goal.cycles.some(cycle => cycle.teamId === stored.goal.activeTeamId && cycle.status === "cancelled"))
          stored.goal.activeTeamId = undefined;
        return;
      }
      throw error;
    }
    if (["ready-for-review", "merged", "no-change", "cancelled", "blocked"].includes(team.status)) return;
    stored.control = { action, requestId: randomUUID(), teamId: team.id, revision: team.revision, ...options };
  }
  pause(id: string, input: Action) { return this.action(id, "pause", goalActionSchema.parse(input)); }
  resume(id: string, input: Action) { return this.action(id, "resume", goalActionSchema.parse(input)); }
  cancel(id: string, input: Action) { return this.action(id, "cancel", goalActionSchema.parse(input)); }
  private action(id: string, action: "pause" | "resume" | "cancel", body: Action) {
    return this.enqueue(() => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, action, body)) return structuredClone(goal);
      if (action !== "cancel" && terminal.has(goal.status)) throw new TeamError(409, "goal-not-running", "This goal has stopped. Start a new goal to approve more work.");
      if (action === "resume" && goal.status !== "paused") throw new TeamError(409, "goal-not-paused", "Only a paused goal can resume.");
      // A standing goal's time limit belongs to its cycle; an expired cycle is stopped by the scheduler, not the resume.
      if (action === "resume" && goal.standing && autonomyOf(this.config.projects.find(value => value.id === goal.projectId)) !== "autonomous")
        throw new TeamError(409, "standing-requires-autonomy", "This standing goal can resume only after its project is autonomous again.");
      if (action === "resume" && !goal.standing && Date.now() >= Date.parse(goal.deadlineAt)) throw new TeamError(409, "goal-deadline", "This goal's time limit has expired. Extend it or start a new goal to approve more time.");
      this.admit(stored, action, body);
      goal.status = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "running";
      goal.reason = action === "resume" ? undefined : "The goal is stopping its active team. Existing work will remain available.";
      if (goal.standing) {
        goal.reasonCode = undefined;
        if (action === "resume") goal.failedCycles = 0;
      }
      this.setControl(stored, action);
      this.event(stored, `Goal ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`);
      this.save(stored); return structuredClone(goal);
    });
  }
  private async finishExtension(stored: Stored, intent: GoalExtensionIntent) {
    try {
      // A durable team receipt is an applied action, even if a later pause, steer or cancel changed the goal.
      let effective = intent.teamId ? this.teams.goalExtension(intent.teamId, intent.requestId) : undefined;
      if (!effective) {
        this.validateExtension(stored, intent);
        if (intent.teamId !== stored.goal.activeTeamId) throw new TeamError(409, "goal-extension-stale", "The active team changed before the time extension could be applied.");
        const target = intent.targetDeadlineAt && intent.targetCeilingAt
          ? { deadlineAt: intent.targetDeadlineAt, ceilingAt: intent.targetCeilingAt } : undefined;
        if (intent.teamId) effective = await this.teams.extendGoalTime(intent.teamId, intent.requestId, intent.minutes, stored.goal.deadlineAt, ceilingOf(stored.goal), target);
        else {
          if (!target) throw new TeamError(409, "goal-extension-pending", "The pending time extension has no recorded target.");
          effective = { ...target, stopReason: undefined };
        }
      }
      const next = structuredClone(stored), goal = next.goal;
      const wasDeadlineStopped = goal.stopReason === "deadline" || effective.stopReason === "deadline";
      goal.deadlineAt = new Date(Math.max(Date.parse(goal.deadlineAt), Date.parse(effective.deadlineAt))).toISOString();
      goal.ceilingAt = new Date(Math.max(Date.parse(ceilingOf(goal)), Date.parse(effective.ceilingAt), Date.parse(goal.deadlineAt))).toISOString();
      if (goal.revision === intent.revision) {
        if (goal.status === "limit-reached" && wasDeadlineStopped) { goal.status = "running"; goal.reason = undefined; }
        if (wasDeadlineStopped && intent.teamId) goal.deadlineContinuation = true;
        else if (!intent.teamId) goal.deadlineContinuation = false;
        if (goal.stopReason === "deadline") goal.stopReason = undefined;
      }
      // Reconciliation records the original request without undoing a newer owner action or its control.
      next.receipts[intent.requestId] = intent.fingerprint; goal.revision++;
      if (intent.failures) this.event(next, "The pending time extension recovered successfully.");
      this.event(next, `The owner extended the time limit by ${intent.minutes} minutes.`);
      next.extensionIntent = undefined;
      this.save(next); Object.assign(stored, next);
      return structuredClone(goal);
    } catch (error) {
      if (error instanceof TeamError) {
        stored.extensionIntent = undefined;
        this.event(stored, `The time extension was ${intent.failures ? "abandoned" : "rejected"}: ${error.message}`);
      } else {
        intent.failures = (intent.failures ?? 0) + 1;
        if (intent.failures === 1) this.event(stored, `The time extension could not be recorded. Recovery will retry, up to ${maxExtensionFailures} failed attempts; goal controls remain available.`);
        if (intent.failures >= maxExtensionFailures) {
          const applied = intent.teamId && this.teams.goalExtension(intent.teamId, intent.requestId);
          if (!applied) stored.extensionIntent = undefined;
          if (intent.failures === maxExtensionFailures) this.event(stored, applied
            ? `Automatic time extension recovery was abandoned after ${maxExtensionFailures} failed attempts. The team receipt is retained; retry the same request to reconcile it.`
            : `The time extension was abandoned after ${maxExtensionFailures} failed attempts. Submit a new extension request to try again.`);
        }
      }
      this.save(stored);
      throw error;
    }
  }
  private validateExtension(stored: Stored, body: Action) {
    const goal = stored.goal;
    this.validateAction(stored, body);
    const timeStopped = goal.status === "limit-reached" && goal.stopReason === "deadline";
    if (!timeStopped && !["running", "needs-input", "paused"].includes(goal.status)) throw new TeamError(409, "goal-not-extendable", "Only a goal that reached its time limit, or one still running, can be extended.");
    if (goal.standing && !goal.activeTeamId) throw new TeamError(409, "goal-not-extendable", "A standing goal has no time limit between cycles. An extension applies to the current cycle only.");
    if (stored.launch) throw new TeamError(409, "goal-launch-pending", "The next feature is being attached. Retry the extension after it appears.");
  }
  private async recoverExtension(stored: Stored) {
    if (!stored.extensionIntent || (stored.extensionIntent.failures ?? 0) >= maxExtensionFailures) return;
    try { await this.finishExtension(stored, stored.extensionIntent); }
    catch { /* Definitive rejections are recorded; transient failures retain the intent without blocking reconciliation. */ }
  }
  /** The goal records an extension intent before the serialized team mutation, then commits its receipt. */
  extend(id: string, input: Action & { minutes: number }) {
    const body = goalExtendSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), goal = stored.goal;
      const fingerprint = digest({ action: "extend", ...body });
      if (stored.extensionIntent) {
        if (stored.extensionIntent.requestId !== body.requestId || stored.extensionIntent.fingerprint !== fingerprint)
          throw new TeamError(409, "goal-extension-pending", "The previous time extension is still being applied.");
        return this.finishExtension(stored, stored.extensionIntent);
      }
      if (this.replay(stored, "extend", body)) return structuredClone(goal);
      this.validateExtension(stored, body);
      const intent: GoalExtensionIntent = { ...body, fingerprint, ...(goal.activeTeamId ? { teamId: goal.activeTeamId } : {}) };
      stored.extensionIntent = intent;
      if (!intent.teamId) {
        intent.targetDeadlineAt = new Date(Math.max(Date.now(), Date.parse(goal.deadlineAt)) + body.minutes * 60000).toISOString();
        intent.targetCeilingAt = new Date(Math.max(Date.parse(ceilingOf(goal)), Date.parse(intent.targetDeadlineAt))).toISOString();
      }
      this.save(stored);
      return this.finishExtension(stored, intent);
    });
  }
  steer(id: string, input: Action & { text: string }) {
    const body = goalSteerSchema.parse(input);
    return this.enqueue(() => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, "steer", body)) return structuredClone(goal);
      if (!["running", "needs-input"].includes(goal.status)) throw new TeamError(409, "goal-not-running", "Resume the goal before sending direction, or start a new goal if it has stopped.");
      if (stored.launch) throw new TeamError(409, "goal-launch-pending", "The next feature is being attached. Retry this direction after it appears.");
      if (goal.steering.length >= 20 || Buffer.byteLength([goal.objective, ...goal.steering.map(item => `User direction: ${item.text}`), `User direction: ${body.text}`].join("\n\n")) > 24000)
        throw new TeamError(409, "goal-steering-limit", "Start a new goal with consolidated directions.");
      this.admit(stored, "steer", body);
      goal.steering.push({ text: body.text, revision: goal.revision, at: now() });
      // Between cycles, direction starts the next cycle early, subject to every gate and the wake gap.
      if (goal.standing && !goal.activeTeamId) goal.pendingWake = { ...(goal.pendingWake ?? { signals: [], dropped: 0, since: now() }), owner: true };
      this.setControl(stored, "steer", { text: body.text });
      this.event(stored, "Direction recorded. The approved scope and execution limits remain in force.");
      this.save(stored); return structuredClone(goal);
    });
  }
  setParallelism(id: string, input: Action & { parallelism: number }) {
    goalParallelismSchema.parse(input);
    this.record(id);
    return Promise.reject(new TeamError(409, "agent-managed-capacity", "Goal worker capacity is agent-managed. The project manager selects a limit for each cycle."));
  }
  outcome(id: string, input: Action & { result: "achieved" | "not-achieved" | "inconclusive"; summary: string; evidence: string }) {
    const body = goalOutcomeSchema.parse(input);
    return this.enqueue(() => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, "outcome", body)) return structuredClone(goal);
      if (!terminal.has(goal.status) || goal.activeTeamId || stored.control || stored.launch)
        throw new TeamError(409, "goal-still-active", "Stop the active work before recording a product outcome.");
      this.admit(stored, "outcome", body);
      goal.outcomes.push({ result: body.result, summary: body.summary, evidence: body.evidence, at: now(), revision: goal.revision });
      if (body.result === "achieved") goal.status = "achieved";
      else if (goal.status === "achieved") goal.status = goal.cycles.some(cycle => ["ready-for-review", "merged"].includes(cycle.status)) ? "ready-for-review" : "no-opportunity";
      this.event(stored, "A user recorded a product outcome with supporting evidence.");
      this.save(stored); return structuredClone(goal);
    });
  }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => {
      if (this.tickQueued || this.closed) return;
      this.tickQueued = true;
      void this.enqueue(async () => {
        try {
          for (const stored of this.records.values()) {
            try { await this.step(stored); }
            catch (error) {
              if (this.closed) return;
              const reason = error instanceof TeamError ? error.message : "The goal could not advance. Its work and evidence remain available.";
              if (stored.goal.status !== "blocked" || stored.goal.reason !== reason) this.event(stored, reason);
              if (!["paused", "cancelled", "limit-reached"].includes(stored.goal.status)) this.block(stored, reason);
              else stored.goal.reason = reason;
              this.save(stored);
            }
          }
        } finally { this.tickQueued = false; }
      }).catch(() => { this.tickQueued = false; });
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
  private refresh(stored: Stored, team: TeamView) {
    const cycle = stored.goal.cycles.find(value => value.teamId === team.id)!;
    Object.assign(cycle, { status: team.status, memberCount: team.members.length, baseCommit: team.baseCommit, headCommit: team.headCommit, branch: team.branch, workspace: team.workspace, brief: team.brief, reason: team.reason });
    if (team.usage.total.messages > 0 || team.usage.unmeasuredMembers === 0) cycle.usage = cycleUsageSnapshot(team.usage);
    else delete cycle.usage;
    if (["ready-for-review", "merged", "no-change", "blocked", "cancelled"].includes(team.status)) cycle.finishedAt ??= now();
    stored.goal.memberCount = stored.goal.cycles.reduce((sum, value) => sum + value.memberCount, 0) + (stored.goal.foldedMembers ?? 0);
  }
  private teamExtendable(stored: Stored) {
    if (!stored.goal.activeTeamId) return false;
    let team: TeamView;
    try { team = this.teams.get(stored.goal.activeTeamId); }
    catch (error) { if (error instanceof TeamError && error.code === "team-not-found") return false; throw error; }
    const context = team.goal;
    return Boolean(context?.extendMinutes && context.ceilingAt && Date.now() < Date.parse(context.ceilingAt));
  }
  private async applyControl(stored: Stored) {
    const control = stored.control;
    if (!control) return true;
    if (control.action === "parallelism") {
      stored.control = undefined;
      this.event(stored, "A legacy owner worker-limit change was discarded because capacity is agent-managed.");
      this.save(stored);
      return true;
    }
    const body = { requestId: control.requestId, revision: control.revision };
    try {
      if (control.action === "steer") await this.teams.steer(control.teamId, { ...body, text: control.text! });
      else await this.teams[control.action](control.teamId, body);
    } catch (error) {
      if (this.closed) return false;
      if (!(error instanceof TeamError)) throw error;
      if (["members-stopping", "team-operation-running"].includes(error.code)) return false;
      if (error.code === "stale-team-revision" && ["pause", "cancel"].includes(control.action)) {
        let team: TeamView;
        try { team = this.teams.get(control.teamId); }
        catch (missing) {
          if (missing instanceof TeamError && missing.code === "team-not-found") {
            stored.control = undefined;
            if (stored.goal.activeTeamId === control.teamId && stored.goal.cycles.some(cycle => cycle.teamId === control.teamId && cycle.status === "cancelled"))
              stored.goal.activeTeamId = undefined;
            this.save(stored); return true;
          }
          throw missing;
        }
        stored.control = { ...control, requestId: randomUUID(), revision: team.revision };
        this.save(stored); return false;
      }
      if (error.code === "team-not-found") {
        stored.control = undefined;
        if (stored.goal.activeTeamId === control.teamId && stored.goal.cycles.some(cycle => cycle.teamId === control.teamId && cycle.status === "cancelled"))
          stored.goal.activeTeamId = undefined;
        this.save(stored); return true;
      }
      stored.control = undefined;
      if (!["paused", "cancelled", "limit-reached"].includes(stored.goal.status)) this.block(stored, error.message);
      else stored.goal.reason = error.message;
      this.event(stored, `The goal action could not be applied: ${error.message}`); this.save(stored); return false;
    }
    if (this.closed) return false;
    stored.control = undefined; this.save(stored); return true;
  }
  private async launch(stored: Stored) {
    const pending = stored.launch!;
    let team: TeamView;
    try { team = await this.teams.createForGoal(pending.request, pending.context, stored.goal.lineup, stored.goal.linearTracking === true, autonomyOf(pending)); }
    catch (error) {
      // A standing goal outlives a creation failure that passes with time. With no run created, the cycle goes back
      // through every gate a minute later and gets a fresh window. A created run, or any other failure, still blocks.
      const code = errorCode(error);
      if (this.closed || !stored.goal.standing || !code || !retryableCreation.has(code) || this.runCreated(pending.request.requestId)) throw error;
      const reason = `The next cycle's run could not be created: ${(error as Error).message} The goal retries in a minute.`;
      if (stored.goal.reason !== reason) this.event(stored, reason);
      stored.goal.reason = reason;
      stored.launchRetryAt = new Date(Date.now() + launchRetryMs).toISOString();
      this.withdrawLaunch(stored);
      return;
    }
    if (this.closed) return;
    if (stored.launchRetryAt) { stored.launchRetryAt = undefined; stored.goal.reason = undefined; }
    if (!stored.goal.cycles.some(cycle => cycle.teamId === team.id)) {
      stored.goal.cycles.push(this.cycleEntry(stored.goal, team, pending));
      if (stored.goal.standing) this.fold(stored.goal);
    }
    stored.goal.activeTeamId = team.id; stored.goal.stopReason = undefined; stored.goal.deadlineContinuation = false; stored.launch = undefined;
    this.event(stored, `Started feature ${pending.context.cycle}. The coordinator will inspect evidence before choosing work.`);
    this.refresh(stored, team); this.save(stored);
  }
  private async step(stored: Stored) {
    if (this.closed) return;
    await this.recoverExtension(stored);
    const goal = stored.goal;
    this.closeStaleBlocked(stored);
    goal.linear = this.linear?.updateGoal(goal, goal.linearTracking === true) ?? goal.linear;
    if (goal.linear?.status === "blocked" && !terminal.has(goal.status)) {
      const reason = goal.linear.reason ?? "The Linear issue no longer matches this approved goal. Review it before starting another goal.";
      this.block(stored, reason); this.setControl(stored, "cancel"); this.event(stored, reason);
    }
    this.save(stored);
    if (goal.standing) this.readSignals(stored);
    const trackingReady = !goal.linear || goal.linear.status === "synced";
    // Mirror first: a paused team's approved extension still protects the goal from its old deadline.
    if (goal.activeTeamId) {
      let team: TeamView | undefined;
      try { team = this.teams.get(goal.activeTeamId); }
      catch (error) { if (!(error instanceof TeamError) || error.code !== "team-not-found") throw error; }
      if (team) {
        const deadlineApproved = Boolean(team.goal?.extendMinutes) || Boolean(team.goal?.ownerExtendedDeadlineAt);
        if (deadlineApproved && team.goal?.deadlineAt && Date.parse(team.goal.deadlineAt) > Date.parse(goal.deadlineAt)) {
          const minutes = Math.round((Date.parse(team.goal.deadlineAt) - Date.parse(goal.deadlineAt)) / 60000);
          goal.deadlineAt = team.goal.deadlineAt;
          if (team.goal.ceilingAt && (!goal.ceilingAt || Date.parse(team.goal.ceilingAt) > Date.parse(goal.ceilingAt))) goal.ceilingAt = team.goal.ceilingAt;
          this.event(stored, `The active team extended the time limit by ${minutes} minutes under the approved extension policy.`);
          this.save(stored);
        }
      }
    }
    const teamDecides = ["running", "needs-input"].includes(goal.status) && this.teamExtendable(stored);
    if (goal.standing) this.stopExpiredCycle(stored, teamDecides);
    else if (["running", "needs-input", "paused"].includes(goal.status) && Date.now() >= Date.parse(goal.deadlineAt) && !teamDecides) {
      goal.status = "limit-reached"; goal.stopReason = "deadline"; goal.deadlineContinuation = true; goal.reason = timeLimitReason;
      this.setControl(stored, "cancel"); this.event(stored, goal.reason); this.save(stored);
    }
    if (stored.launch) {
      // A standing launch whose run was never created (a restart, or a failed creation) is withdrawn: its wake returns
      // to the goal and the next cycle passes every gate again, with a fresh window, before any run is created.
      if (goal.standing && !this.runCreated(stored.launch.request.requestId)) this.withdrawLaunch(stored);
      else if (goal.status === "paused" || terminal.has(goal.status)) {
        try {
          const team = this.teams.get(stored.launch.request.requestId);
          if (!goal.cycles.some(cycle => cycle.teamId === team.id)) goal.cycles.push(this.cycleEntry(goal, team, stored.launch));
          goal.activeTeamId = team.id; this.setControl(stored, goal.status === "paused" ? "pause" : "cancel");
        } catch (error) { if (!(error instanceof TeamError) || error.code !== "team-not-found") throw error; }
        stored.launch = undefined; this.save(stored);
      } else if (trackingReady) await this.launch(stored);
    }
    if (!await this.applyControl(stored) || this.closed) return;
    if (goal.activeTeamId) {
      let team: TeamView | undefined;
      try { team = this.teams.get(goal.activeTeamId); }
      catch (error) { if (!(error instanceof TeamError) || error.code !== "team-not-found") throw error; }
      if (!team) {
        const cycle = goal.cycles.find(value => value.teamId === goal.activeTeamId);
        if (cycle?.status === "cancelled") {
          goal.activeTeamId = undefined;
          if (goal.standing) this.settleCycle(stored, cycle);
          else if (["running", "needs-input"].includes(goal.status)) {
            const deadlineStopped = goal.stopReason === "deadline" || goal.deadlineContinuation === true;
            const extendedDeadline = deadlineStopped && goal.deadlineContinuation === true && Date.now() < Date.parse(goal.deadlineAt);
            const reason = cycle.reason ?? "The active team stopped before producing a reviewed result.";
            if (extendedDeadline) { goal.status = "running"; goal.reason = undefined; }
            else if (goal.stopReason) { goal.status = "limit-reached"; goal.reason = reason; }
            else this.block(stored, reason);
            if (extendedDeadline) this.event(stored, "The deadline-stopped team settled after an owner extension; the goal will continue in a new cycle.");
          }
          this.save(stored);
        }
      } else {
      this.refresh(stored, team);
      if (["ready-for-review", "merged", "no-change", "blocked", "cancelled"].includes(team.status)) {
        if (["running", "needs-input"].includes(goal.status) && ["ready-for-review", "merged", "no-change"].includes(team.status) && team.linear && team.linear.status !== "synced") {
          if (team.linear.status === "blocked") {
            const reason = team.linear.reason ?? "The feature's Linear issue no longer permits continuation.";
            this.block(stored, reason); this.event(stored, reason);
          } else { this.save(stored); return; }
        }
        if (team.members.every(member => ["stopped", "waiting"].includes(member.status))) goal.activeTeamId = undefined;
        // A standing goal classifies the cycle once its members have stopped and continues on its cadence.
        if (goal.standing) { if (!goal.activeTeamId) this.settleCycle(stored, goal.cycles.find(value => value.teamId === team!.id)!, team); }
        else if (["running", "needs-input"].includes(goal.status)) {
          if (team.status === "blocked" || team.status === "cancelled") {
            const deadlineStopped = team.stopReason === "deadline" || goal.stopReason === "deadline" || goal.deadlineContinuation === true;
            if (deadlineStopped) { goal.stopReason = "deadline"; goal.deadlineContinuation = true; }
            const extendedDeadline = deadlineStopped && goal.deadlineContinuation === true && Date.now() < Date.parse(goal.deadlineAt);
            const reason = team.reason ?? "The active team stopped before producing a reviewed result.";
            if (extendedDeadline) { goal.status = "running"; goal.reason = undefined; }
            else if (team.stopReason) { goal.status = "limit-reached"; goal.reason = reason; }
            else this.block(stored, reason);
            if (extendedDeadline) this.event(stored, "The deadline-stopped team settled after an owner extension; the goal will continue in a new cycle.");
          } else if (team.status === "no-change") {
            goal.status = goal.cycles.some(cycle => ["ready-for-review", "merged"].includes(cycle.status)) ? "ready-for-review" : "no-opportunity";
            goal.reason = team.reason ?? "The coordinator found no further work justified by the available evidence.";
          } else {
            goal.status = "running"; goal.reason = undefined;
            this.event(stored, "A feature passed checks and independent review. The next feature will use its recorded commit.");
          }
        }
      } else if (["running", "needs-input"].includes(goal.status)) {
        if (team.status === "paused") { goal.status = "paused"; goal.reason = "The active team was paused."; }
        else { goal.status = team.status === "needs-input" ? "needs-input" : "running"; goal.reason = team.reason; }
      }
      this.save(stored);
      }
    }
    // Cancellation cleanup must not depend on the cycle remaining the active one: the goal can
    // clear activeTeamId as soon as its members settle, while retention removes the workspace later.
    for (const cycle of goal.cycles.filter(value => value.status === "cancelled")) {
      let team: TeamView;
      try { team = this.teams.get(cycle.teamId); }
      catch (error) {
        if (!(error instanceof TeamError) || error.code !== "team-not-found") throw error;
        const cleanupEvent = `The host removed cancelled goal cycle ${cycle.cycle}'s settled run record after its workspace was removed.`;
        if (!goal.events.some(event => event.text === cleanupEvent)) { this.event(stored, cleanupEvent); this.save(stored); }
        continue;
      }
      if (team.status !== "cancelled" || !team.workspaceRemovedAt) continue;
      this.refresh(stored, team);
      this.save(stored);
      try { await this.teams.removeRun(team.id); }
      catch (error) { if (!(error instanceof TeamError) || error.code !== "team-not-found") continue; }
      const cleanupEvent = `The host removed cancelled goal cycle ${cycle.cycle}'s settled run record after its workspace was removed.`;
      if (!goal.events.some(event => event.text === cleanupEvent)) { this.event(stored, cleanupEvent); this.save(stored); }
    }
    if (terminal.has(goal.status) || goal.status === "paused") return;
    if (goal.standing) { await this.startStandingCycle(stored, trackingReady); return; }
    const timeUp = Date.now() >= Date.parse(goal.deadlineAt) && !this.teamExtendable(stored);
    if (timeUp || (!goal.activeTeamId && goal.memberCount >= goal.maxMembers)) {
      goal.status = "limit-reached";
      goal.stopReason = timeUp ? "deadline" : "member-limit";
      goal.deadlineContinuation = timeUp;
      goal.reason = timeUp ? timeLimitReason : "The approved agent-attempt limit has been reached.";
      this.setControl(stored, "cancel"); this.event(stored, goal.reason); this.save(stored); await this.applyControl(stored); return;
    }
    if (goal.activeTeamId) return;
    if (goal.cycles.length >= (goal.maxRuns ?? 0)) {
      goal.status = "ready-for-review"; goal.reason = "The approved feature-run limit has been reached. Review the accumulated changes; product impact has not been inferred.";
      this.event(stored, goal.reason); this.save(stored); return;
    }
    if (!trackingReady) return;
    const fuse = applyFuseReason(goal, this.fuse?.check({ projectId: goal.projectId }));
    if (fuse.changed) { if (fuse.wait) this.event(stored, goal.reason!); this.save(stored); }
    if (fuse.wait) return;
    await this.prepare(stored, goal.cycles.length + 1, Math.min(60, goal.maxMembers - goal.memberCount));
  }
  /** Records the next cycle's launch, consuming a standing goal's pending wake in the same write, then starts it. */
  private async prepare(stored: Stored, cycle: number, maxMembers: number) {
    const goal = stored.goal;
    const parent = latestReviewed(goal.cycles);
    const sourceIssue = goal.linear?.issue;
    const context: TeamGoalContext = { id: goal.id, revision: goal.revision, cycle, successCriteria: goal.successCriteria, nonGoals: goal.nonGoals, allowedPaths: goal.allowedPaths, evidence: goal.evidence,
      ...(sourceIssue ? { sourceIssue: { id: sourceIssue.id, identifier: sourceIssue.identifier, url: sourceIssue.url, title: sourceIssue.title, description: sourceIssue.description } } : {}),
      // The team context accepts 16 entries, so a long-running goal passes its newest reviewed cycles.
      previousWork: goal.cycles.filter(isReviewed).slice(-maxPreviousWork).map(value => `${value.brief?.title ?? `Feature ${value.cycle}`}: ${value.brief?.expectedOutcome ?? "Reviewed change"}`.slice(0, 2000)),
      deadlineAt: goal.deadlineAt, maxMembers, ...(parent ? { parentRunId: parent.teamId } : {}),
      extendMinutes: goal.extendMinutes ?? 0, ceilingAt: ceilingOf(goal) };
    const wake = goal.standing ? goal.pendingWake : undefined;
    const objective = wakeObjective([goal.objective, ...goal.steering.map(value => `User direction: ${value.text}`)].join("\n\n"), wake);
    // Every cycle of a goal keeps the goal's pinned mode; a goal with no pin is supervised.
    const autonomy = autonomyOf(goal);
    stored.launch = { context, autonomy, request: { requestId: randomUUID(), projectId: goal.projectId, provider: goal.lineup.coordinator.provider, useConfiguredLineup: true, title: `${goal.title} · ${cycle}`.slice(0, 100), objective, parallelism: goal.parallelism },
      ...(wake ? { wake } : {}) };
    if (wake) goal.pendingWake = undefined;
    this.save(stored); await this.launch(stored);
  }
  /**
   * The boundary between standing cycles. In order: the mode rule (3.4 rule 3), the lineup block (rule 7), the failure
   * count (rule 5), the cadence or an eligible wake, Linear tracking, and the fuse. Only then do allowances renew.
   */
  private async startStandingCycle(stored: Stored, trackingReady: boolean) {
    const goal = stored.goal, standing = goal.standing!;
    if (goal.activeTeamId || stored.launch) return;
    // A project that is no longer enrolled reads as supervised too, so the goal pauses instead of ending.
    if (autonomyOf(this.config.projects.find(value => value.id === goal.projectId)) !== "autonomous")
      return this.hold(stored, "paused", "supervised-mode", "The project is supervised, so this standing goal paused at its cycle boundary. Resume it once the project is autonomous again.");
    if (!this.enabled()) {
      goal.status = "blocked"; goal.reason = "The host lineup no longer has a strong coordinator and reviewer. Configure one, then start a new goal.";
      this.event(stored, goal.reason); this.save(stored); return;
    }
    if ((goal.failedCycles ?? 0) >= maxFailedCycles) return this.hold(stored, "paused", "repeated-failures", repeatedFailuresReason);
    const last = goal.cycles.at(-1);
    if (last) {
      const settled = Date.parse(last.settledAt ?? last.finishedAt ?? now());
      const woken = goal.pendingWake !== undefined && Date.now() >= settled + this.wakeGapMinutes() * 60000;
      if (Date.now() < cadenceDue(last, standing.cadenceMinutes, Date.now()) && !woken) return;
    }
    if (stored.launchRetryAt && Date.now() < Date.parse(stored.launchRetryAt)) return;
    if (!trackingReady) return;
    const fuse = applyFuseReason(goal, this.fuse?.check({ projectId: goal.projectId }));
    if (fuse.changed) { if (fuse.wait) this.event(stored, goal.reason!); this.save(stored); }
    if (fuse.wait) return;
    // Allowances renew for each cycle (3.2), and the cycle takes the host's current lineup (3.5).
    const startedAt = Date.now();
    goal.deadlineAt = new Date(startedAt + goal.maxMinutes * 60000).toISOString();
    goal.ceilingAt = new Date(startedAt + (goal.maxTotalMinutes ?? goal.maxMinutes) * 60000).toISOString();
    goal.lineup = structuredClone(this.config.teams!.lineup!);
    await this.prepare(stored, foldedCycles(goal) + goal.cycles.length + 1, Math.min(60, goal.maxMembers));
  }
  /** Whether the team service holds the run of this request; a launch intent without one never created its run. */
  private runCreated(requestId: string) { return this.teams.goalIdOf(requestId) !== undefined; }
  /** Clears a standing launch whose run was never created and returns its wake to the goal, in one write. */
  private withdrawLaunch(stored: Stored) {
    stored.goal.pendingWake = restoreWake(stored.launch?.wake, stored.goal.pendingWake);
    stored.launch = undefined;
    this.save(stored);
  }
  private hold(stored: Stored, status: "paused" | "blocked", code: GoalReasonCode, reason: string) {
    const goal = stored.goal;
    goal.status = status; goal.reasonCode = code; goal.reason = reason;
    this.event(stored, reason); this.save(stored);
  }
  /** A standing cycle past its time limit stops; the goal itself has no time stop. */
  private stopExpiredCycle(stored: Stored, teamDecides: boolean) {
    const goal = stored.goal;
    if (!goal.activeTeamId || teamDecides || !["running", "needs-input", "paused"].includes(goal.status) || Date.now() < Date.parse(goal.deadlineAt)) return;
    const cycle = goal.cycles.find(value => value.teamId === goal.activeTeamId);
    if (!cycle || cycle.deadlineStop) return;
    this.setControl(stored, "cancel");
    // setControl leaves a settled run alone; that cycle is classified as it settled.
    if (stored.control?.action !== "cancel" || stored.control.teamId !== cycle.teamId) return;
    cycle.deadlineStop = { at: now(), ...(this.fuse?.check({ projectId: goal.projectId }).state === "open" ? { fuseOpen: true as const } : {}) };
    this.event(stored, `Cycle ${cycle.cycle} reached its time limit and is stopping. The goal continues with its next cycle.`);
    this.save(stored);
  }
  /** Classifies a standing cycle once its members have stopped, then applies stop rules 4 and 5. The caller saves. */
  private settleCycle(stored: Stored, cycle: GoalCycle, team?: TeamView) {
    const goal = stored.goal;
    if (cycle.class) return;
    const ownerStop = goal.status === "paused" || goal.status === "cancelled";
    cycle.class = classifyCycle({ status: cycle.status, stopReason: team?.stopReason, blockCode: team?.blockCode, deadlineStop: cycle.deadlineStop, ownerStop,
      fuseOpen: !ownerStop && this.fuse?.check({ projectId: goal.projectId }).state === "open" });
    cycle.settledAt = now();
    this.event(stored, `Cycle ${cycle.cycle} settled as ${cycle.class}.`);
    const unresolved = team && unresolvedOperation(team, this.teams.hasDeliveryAttempt(team.id));
    if (unresolved) {
      // A goal that already stopped keeps its own reason; the event still names the open operation.
      if (terminal.has(goal.status)) this.event(stored, unresolved);
      else this.hold(stored, "blocked", "external-operation", unresolved);
      return;
    }
    if (cycle.class === "failed") goal.failedCycles = (goal.failedCycles ?? 0) + 1;
    else if (cycle.class !== "excluded") goal.failedCycles = 0;
    if (!["running", "needs-input"].includes(goal.status)) return;
    goal.status = "running"; goal.reason = undefined;
    if ((goal.failedCycles ?? 0) >= maxFailedCycles) this.hold(stored, "paused", "repeated-failures", repeatedFailuresReason);
  }
  /** W2: folds new signals from other runs into the pending wake and advances the cursor, in one write. */
  private readSignals(stored: Stored) {
    const goal = stored.goal, kinds = goal.standing?.wakeOn;
    if (!kinds?.length || !this.signals || goal.status === "paused" || terminal.has(goal.status)) return;
    if (goal.signalCursor === undefined) {
      const head = this.signalHead();
      if (head !== undefined) { goal.signalCursor = head; this.save(stored); }
      return;
    }
    const cursor = goal.signalCursor;
    let read: ProjectSignal[];
    try { read = this.signals.after(goal.projectId, cursor, { kinds, limit: 50 }); }
    catch { return; }
    const fresh = read.filter(signal => Number.isInteger(signal.seq) && signal.seq > cursor);
    if (!fresh.length) return;
    const own = new Set(goal.cycles.map(cycle => cycle.teamId));
    if (stored.launch) own.add(stored.launch.request.requestId);
    const wakes = fresh.filter(signal => signal.projectId === goal.projectId && kinds.includes(signal.kind) &&
      !(signal.runId && (own.has(signal.runId) || this.teams.goalIdOf(signal.runId) === goal.id)));
    goal.pendingWake = addToPendingWake(goal.pendingWake, wakes, now());
    goal.signalCursor = Math.max(...fresh.map(signal => signal.seq));
    this.save(stored);
  }
  private cycleEntry(goal: ProductGoal, team: TeamView, pending: PendingLaunch): GoalCycle {
    return { teamId: team.id, cycle: pending.context.cycle, goalRevision: pending.context.revision, status: team.status, startedAt: team.createdAt, memberCount: team.members.length, autonomy: autonomyOf(pending),
      ...(goal.standing ? { lineup: structuredClone(goal.lineup) } : {}), ...(pending.wake ? { wake: cycleWakeOf(pending.wake) } : {}) };
  }
  /** Keeps the newest `keptCycles` cycles, the active one, and the parent of the next cycle; older ones fold into totals. */
  private fold(goal: ProductGoal) {
    const cutoff = goal.cycles.length - keptCycles;
    if (cutoff <= 0) return;
    const keep = new Set([latestReviewed(goal.cycles)?.teamId, goal.activeTeamId]);
    const folded = goal.cycles.slice(0, cutoff).filter(cycle => !keep.has(cycle.teamId));
    if (!folded.length) return;
    const totals: Record<CycleClass, number> = { reviewed: 0, "no-change": 0, failed: 0, excluded: 0, ...goal.cycleTotals };
    for (const cycle of folded) totals[cycle.class ?? classifyCycle({ status: cycle.status, fuseOpen: false, ownerStop: false })]++;
    goal.cycleTotals = totals;
    goal.foldedUsage = addRollups([...(goal.foldedUsage ? [goal.foldedUsage] : []), ...folded.map(cycle => this.foldedRollup(cycle))]);
    goal.foldedMembers = (goal.foldedMembers ?? 0) + folded.reduce((sum, cycle) => sum + cycle.memberCount, 0);
    goal.cycles = goal.cycles.filter(cycle => !folded.includes(cycle));
  }
  /** The usage `get()` would show for this cycle. Folding must not fail a launch, so any read error uses the snapshot. */
  private foldedRollup(cycle: GoalCycle): StoredRollup {
    try {
      const { usage } = this.teams.get(cycle.teamId);
      if (!usage.unavailable) return usage;
    } catch { /* The retained snapshot below. */ }
    return snapshotRollup(cycle);
  }
}
