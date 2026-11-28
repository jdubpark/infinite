import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSealed, unseal } from "./vault.js";
import { autonomyOf, type AutonomyMode } from "./autonomy.js";
import { autonomyStartEvent, startMode } from "./evaluator-profiles.js";
import { TeamService, TeamError } from "./teams.js";
import { deliverControl, holdForStoppedCommand, supersedeWaiting } from "./goal-waiting-control.js";
import { goalActionSchema, goalExtendSchema, goalOutcomeSchema, goalParallelismSchema, goalSteerSchema, parseCreateGoal, type CreateGoal, type CycleClass, type GoalCycle, type GoalOutcomeInput, type GoalReasonCode, type ProductGoal } from "./goal-types.js";
import { SHARED_INPUT_LIMITS } from "./schema-primitives.js";
import type { Config } from "./types.js";
import { DEFAULT_TEAM_RETENTION, hostClosedBlockedReason, type CreateTeam, type TeamGoalContext, type TeamView } from "./team-types.js";
import { addRollups, type StoredRollup, type UsageRollup } from "./team-usage.js";
import { advanceGoalDigest, formatPreviousWork, snapshotRollup } from "./goal-cycle-digest.js";
import type { LinearService } from "./linear.js";
import type { LinearTrackingView } from "./linear-types.js";
import { applyFuseReason } from "./fuse/rules.js";
import type { FuseGate } from "./fuse/types.js";
import { KeyedQueue, PendingCreates, mapConcurrent, pauseWithPendingCreates } from "./keyed-queue.js";
import { readSignals } from "./signals/consume.js";
import { addToPendingWake, type PendingWake, type SignalReader } from "./signals/types.js";
import { cadenceDue, classifyCycle, cycleWakeOf, defaultWakeMinGapMinutes, foldedCycles, isReviewed, keptCycles, latestReviewed, maxFailedCycles, maxPreviousWork, restoreWake, runObjectiveLimitBytes, unresolvedOperation, wakeObjective, retryableCreationFailure } from "./goal-standing.js";
import { KEPT_PAUSED, LEFT_AS_IS, LEFT_PAUSED, STILL_HALTED, isHaltReason, pauseFailure, releaseRefusal, type HaltCovers, type HaltHeldBy, type HaltMark, type HaltOutcome } from "./halt/rules.js";
import { correctionGate, digestEvent, correctGoalObjective, createGoalObjective, goalObjectiveNote, goalObjectiveView, goalRecordDigest, goalRecordPort, loadGoalObjective, ratingStamp, steerGoalObjective, type ObjectiveUnavailable } from "./objective-goals.js";
import { objectivePromptsOn, objectiveRegisterOn } from "./objective-digest.js";
import { answerProvisional, applyLateVerdict, assertVerdictAnswer, continueGoal, criteriaRowsFor, cycleVerdict, deliveryHold, holdReasonChange, lateVerdict, markProvisional, owedStop, provisionalStop, verdictFailed, withdrawProvisional, CONTINUE_EVENT, DELIVERY_HOLD_REASON, LATE_RECEIPT_EVENT, PROVISIONAL_EVENT } from "./goal-verdicts.js";
import { correctionSchema, type CriterionInput } from "./objective-input.js";
import { objectiveError, recordView, type ObjectiveRecordView } from "./objective-record.js";
import { goalMetricsRead, pruneMetrics, settleMetrics } from "./goal-metrics.js";
import { cancelReleasedGoalRun } from "./goal-released-run.js";

type Action = { requestId: string; revision: number };
type PendingControl = { action: "pause" | "resume" | "cancel" | "steer" | "parallelism"; requestId: string; teamId: string; revision: number; text?: string; parallelism?: number; halt?: HaltRunMark; waiting?: true };
type HaltRunMark = { token: string; reason: string };
type GoalExtensionIntent = Action & { minutes: number; fingerprint: string; teamId?: string; targetDeadlineAt?: string; targetCeilingAt?: string; failures?: number };
type PendingLaunch = { request: CreateTeam; context: TeamGoalContext; autonomy?: AutonomyMode; wake?: PendingWake };
type InboxState = "current" | "behind" | "unknown";
type Stored = {
  goal: ProductGoal;
  fingerprint: string;
  receipts: Record<string, string>;
  launch?: PendingLaunch;
  control?: PendingControl;
  extensionIntent?: GoalExtensionIntent;
  launchRetryAt?: string;
  endedAs?: { teamId: string; status: string; headCommit?: string };
  ownerHalt?: { haltId: string; revision: number; run?: { teamId: string; token: string } };
  objectiveRecord?: unknown;
  objectiveNotice?: ObjectiveUnavailable;
  metrics?: unknown;
};
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = new Set(["blocked", "ready-for-review", "no-opportunity", "limit-reached", "cancelled", "achieved"]);
const timeLimitReason = "The approved time limit has expired.";
const stoppingReason = "The goal is stopping its active team. Existing work will remain available.";
const ownerStopReason = { pause: "The owner paused this goal. No new work starts until it resumes.", cancel: "The owner cancelled this goal. Existing work remains available." };
const trackingHoldPrefix = "New work waits for Linear tracking: ";
const trackingHoldReason = (view: LinearTrackingView | undefined) => `${trackingHoldPrefix}${view?.reason ?? "Linear has not confirmed this goal's issue."}`;
const repeatedFailuresReason = "Three cycles in a row failed, so this standing goal paused. Review the failed cycles, then resume it to reset the count.";
const maxExtensionFailures = 3;
const correctionEvent = (version: number) => `The owner corrected the objective record to version ${version}.`;
const launchRetryMs = 60_000;
const ceilingOf = (goal: ProductGoal) => goal.ceilingAt ?? new Date(Date.parse(goal.createdAt) + (goal.maxTotalMinutes ?? goal.maxMinutes) * 60000).toISOString();
const cycleUsageSnapshot = (usage: UsageRollup) => ({ ...usage.total, ...usage });

export class GoalService {
  private readonly records = new Map<string, Stored>();
  private readonly saved = new Map<string, string>();
  private readonly directory: string;
  private readonly queues = new KeyedQueue();
  private readonly pendingCreates = new PendingCreates();
  private readonly activeTicks = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private tickQueued = false;
  private fuse?: FuseGate;
  private signals?: SignalReader;

  constructor(private readonly config: Config, private readonly key: Buffer, private readonly teams: TeamService, private readonly linear?: LinearService) {
    this.directory = join(config.stateDir, "goals");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let unsaved = 0;
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
      const before = digest(stored), note = goalObjectiveNote(stored, loadGoalObjective(stored, now()));
      pruneMetrics(stored);
      if (note) this.event(stored, note);
      this.records.set(id, stored);
      if (digest(stored) === before) { this.saved.set(id, before); continue; }
      try { writeSealed(join(this.directory, file), key, `goal:${id}`, stored); this.saved.set(id, digest(stored)); }
      catch { this.saved.set(id, digest(stored)); unsaved++; }
    }
    if (unsaved) console.warn(`Objective records of ${unsaved} goals could not be saved at startup. Each is saved with its goal's next change.`);
    this.teams.useGoalRecords?.(goalRecordPort(id => this.records.get(id), holder => this.save(holder as Stored)));
  }
  useFuse(fuse: FuseGate) { this.fuse = fuse; }
  useSignals(reader: SignalReader) { this.signals = reader; }
  private wakeGapMinutes() { return this.config.autonomy?.continuity?.wakeMinGapMinutes ?? defaultWakeMinGapMinutes; }
  private signalHead() {
    try { const head = this.signals?.head(); return Number.isInteger(head) && head! >= 0 ? head : undefined; }
    catch { return undefined; }
  }
  enabled() {
    const lineup = this.config.teams?.lineup;
    return Boolean(lineup && lineup.coordinator.tier === "strong" && lineup.reviewer.tier === "strong");
  }
  private enqueue<T>(id: string, task: () => T | Promise<T>): Promise<T> {
    return this.queues.enqueue(id, task);
  }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "goal-not-found", "This goal does not exist.");
    return stored;
  }
  private save(stored: Stored) {
    pruneMetrics(stored);
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
    goal.blockedAt ??= goal.updatedAt;
    const since = Date.parse(goal.blockedAt);
    if (!Number.isFinite(since) || Date.now() - since < hours * 3600000) return;
    const reason = hostClosedBlockedReason(hours, goal.reason);
    this.setControl(stored, "cancel");
    goal.status = "cancelled"; goal.reason = reason;
    if (!goal.events.some(event => event.text === reason)) this.event(stored, reason);
    this.save(stored);
  }
  statuses() { return [...this.records.values()].map(({ goal }) => ({ id: goal.id, title: goal.title, status: goal.status, reason: goal.reason })); }
  ownsActiveTeam(teamId: string) { return [...this.records.values()].some(({ goal }) => !terminal.has(goal.status) && goal.activeTeamId === teamId); }
  retainsTeamRun(teamId: string) {
    return [...this.records.values()].some(({ goal, launch }) => !terminal.has(goal.status) && (goal.standing
      ? goal.activeTeamId === teamId || launch?.request.requestId === teamId || latestReviewed(goal.cycles)?.teamId === teamId
      : goal.activeTeamId === teamId || goal.cycles.some(cycle => cycle.teamId === teamId)));
  }
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
    if (goal.standing && last && !goal.activeTeamId && !terminal.has(goal.status) && goal.status !== "paused")
      goal.nextCycleAt = new Date(cadenceDue(last, goal.standing.cadenceMinutes, Date.now())).toISOString();
    return { ...goal, tasks };
  }
  private acceptsDecision(goal: ProductGoal, teamId: string, held: boolean) {
    const live = ["running", "needs-input"].includes(goal.status) || held && goal.status === "paused";
    return goal.activeTeamId === teamId && live && Date.now() < Date.parse(goal.deadlineAt);
  }
  decisionAnswerable(teamId: string, held: boolean) {
    const goalId = this.teams.goalIdOf(teamId), stored = goalId ? this.records.get(goalId) : undefined;
    return Boolean(stored && this.acceptsDecision(stored.goal, teamId, held));
  }
  private answerForGoal(goalId: string, teamId: string, decisionId: string, body: Action & { text: string }) {
    return this.teams.answer(teamId, decisionId, body, held => {
      const { goal } = this.record(goalId);
      if (!this.acceptsDecision(goal, teamId, held))
        throw new TeamError(409, "goal-not-running", "Only the active team of a running goal can receive a decision.");
    });
  }
  answer(teamId: string, decisionId: string, body: Action & { text: string }) {
    const goalId = this.teams.goalIdOf(teamId);
    if (goalId) return this.enqueue(goalId, () => this.answerForGoal(goalId, teamId, decisionId, body));
    return Promise.resolve().then(() => {
      const team = this.teams.get(teamId);
      if (!team.goal) throw new TeamError(409, "not-a-goal-team", "This team does not belong to a goal.");
      return this.enqueue(team.goal.id, () => this.answerForGoal(team.goal!.id, teamId, decisionId, body));
    });
  }
  activeForProject(projectId: string) {
    return [...this.records.values()].some(({ goal, launch, control }) => goal.projectId === projectId && (Boolean(launch || control || goal.activeTeamId) || ["running", "needs-input", "paused"].includes(goal.status)));
  }
  create(input: CreateGoal, admit?: () => void, criteria?: CriterionInput[]) {
    const request = parseCreateGoal(input);
    const payload = criteria ? { ...request, criteria } : request;
    return this.pendingCreates.track(request.requestId, [request.projectId], this.enqueue(request.requestId, () => {
      const fingerprint = digest(payload), prior = this.records.get(request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different goal.");
        return structuredClone(prior.goal);
      }
      admit?.();
      if (!this.enabled()) throw new TeamError(409, "goals-not-configured", "Configure a team lineup with a strong coordinator and reviewer before starting a goal.");
      if (Buffer.byteLength(JSON.stringify(payload)) > SHARED_INPUT_LIMITS.goalPayloadBytes) throw new TeamError(409, "goal-too-large", "Keep the goal and evidence below 40 KiB. Link to longer source material.");
      const project = this.config.projects.find(value => value.id === request.projectId);
      if (!project?.team || (!project.team.checks.length && !project.team.establishChecks)) throw new TeamError(409, "goal-project-not-configured", "Configure required checks or authorize the team to establish them before a goal can start.");
      if (request.linearIssueId && !project.linear) throw new TeamError(409, "linear-not-configured", "Configure Linear for this project before linking an issue.");
      const start = startMode(project, this.config.teams?.lineup); if (request.standing && start.mode !== "autonomous")
        throw new TeamError(409, "standing-requires-autonomy", start.reason ? "A standing goal needs an evaluator: no lineup profile of a model family other than the coordinator's can evaluate it. Add one to the lineup's evaluators, or start a finite goal." : "A standing goal needs an autonomous project. Start a finite goal, or make the project autonomous first.");
      if (request.standing && Buffer.byteLength(request.objective) > runObjectiveLimitBytes)
        throw new TeamError(400, "standing-objective-too-large", `A standing goal's objective must fit in ${runObjectiveLimitBytes.toLocaleString("en-US")} bytes of UTF-8. Shorten it and start the goal again.`);
      if (criteria !== undefined && !objectivePromptsOn(project)) throw objectiveError("objective-prompts-off");
      const { requestId, parallelism: _legacyParallelism, ...fields } = request;
      const createdAt = now();
      const cursor = request.standing?.wakeOn ? this.signalHead() : undefined;
      const stored: Stored = { fingerprint, receipts: {}, goal: {
        ...fields, parallelism: 4, maxTotalMinutes: request.maxTotalMinutes ?? request.maxMinutes, linearTracking: Boolean(project.linear), id: requestId, revision: 1, status: "running", createdAt, updatedAt: createdAt,
        deadlineAt: new Date(Date.parse(createdAt) + request.maxMinutes * 60000).toISOString(),
        ceilingAt: new Date(Date.parse(createdAt) + (request.maxTotalMinutes ?? request.maxMinutes) * 60000).toISOString(),
        lineup: structuredClone(this.config.teams!.lineup!), autonomy: start.mode, cycles: [], memberCount: 0, steering: [], events: [], outcomes: [],
        ...(cursor !== undefined ? { signalCursor: cursor } : {}),
      } };
      { const note = goalObjectiveNote(stored, createGoalObjective(stored, createdAt, criteria && { inputs: criteria, context: { configured: project.team!.checks, requestId, at: createdAt } })); if (note) this.event(stored, note); }
      if (start.reason) this.event(stored, autonomyStartEvent("goal", start.reason));
      this.event(stored, request.standing
        ? `Standing goal approved. A cycle starts now and then every ${request.standing.cadenceMinutes} minutes, each within its own time and attempt limits.`
        : "Goal approved. The coordinator can select and build work within its scope and limits.");
      this.records.set(requestId, stored); this.save(stored);
      stored.goal.linear = this.linear?.updateGoal(stored.goal, stored.goal.linearTracking === true); this.save(stored);
      return structuredClone(stored.goal);
    }));
  }
  private replay(stored: Stored, action: string, body: { requestId: string }) {
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
  private setControl(stored: Stored, action: PendingControl["action"], options: { text?: string; parallelism?: number; halt?: HaltRunMark } = {}) {
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
  cancelReleasedRun(teamId: string, body: Action) { return cancelReleasedGoalRun({ records: this.records, terminal, teams: this.teams,
    enqueue: (id, task) => this.enqueue(id, task), refresh: (stored, team) => this.refresh(stored, team), event: (stored, text) => this.event(stored, text), save: stored => this.save(stored) }, teamId, body); }
  private action(id: string, action: "pause" | "resume" | "cancel", body: Action) {
    return this.enqueue(id, () => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, action, body)) return structuredClone(goal);
      if (action !== "cancel" && terminal.has(goal.status)) throw new TeamError(409, "goal-not-running", "This goal has stopped. Start a new goal to approve more work.");
      if (action === "resume" && goal.status !== "paused") throw new TeamError(409, "goal-not-paused", "Only a paused goal can resume.");
      if (action === "resume" && goal.standing && autonomyOf(this.config.projects.find(value => value.id === goal.projectId)) !== "autonomous")
        throw new TeamError(409, "standing-requires-autonomy", "This standing goal can resume only after its project is autonomous again.");
      if (action === "resume" && !goal.standing && Date.now() >= Date.parse(goal.deadlineAt)) throw new TeamError(409, "goal-deadline", "This goal's time limit has expired. Extend it or start a new goal to approve more time.");
      if (action !== "resume" && body.revision === goal.revision) supersedeWaiting(stored, `The owner's ${action}`, { event: text => this.event(stored, text) });
      this.admit(stored, action, body);
      goal.status = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "running";
      if (goal.standing) {
        goal.reasonCode = undefined;
        if (action === "resume") goal.failedCycles = 0;
      }
      this.setControl(stored, action);
      goal.reason = action === "resume" ? undefined : stored.control ? stoppingReason : ownerStopReason[action];
      this.event(stored, `Goal ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`);
      this.save(stored); return structuredClone(goal);
    });
  }
  haltPause(mark: HaltMark, covers: HaltCovers): Promise<HaltOutcome[]> {
    const pausable = (goal: ProductGoal) => goal.status === "running" || goal.status === "needs-input";
    const task: Promise<HaltOutcome[]> = pauseWithPendingCreates<HaltOutcome>(this.pendingCreates, this.records, covers, id => this.enqueue(id, async () => {
      const stored = this.records.get(id);
      if (!stored) return undefined;
      const goal = stored.goal;
      if (!pausable(goal) || !covers([goal.projectId], goal.id)) return undefined;
      try {
        if (stored.control?.action === "steer" && !await this.applyControl(stored) && !stored.control?.waiting) throw new TeamError(409, "goal-control-pending", "The previous goal action is still being applied.");
        if (!pausable(goal)) return undefined;
        supersedeWaiting(stored, "The halt", { event: text => this.event(stored, text) });
        goal.revision++; goal.status = "paused"; goal.reason = mark.reason;
        const token = randomUUID();
        this.setControl(stored, "pause", { halt: { token, reason: mark.reason } });
        const sent = stored.control?.halt?.token === token ? { run: { teamId: stored.control.teamId, token } } : {};
        stored.ownerHalt = { haltId: mark.haltId, revision: goal.revision, ...sent };
        this.event(stored, `Goal paused: ${mark.reason}`); this.save(stored);
        return { kind: "goal", id: goal.id, title: goal.title, result: "paused" } satisfies HaltOutcome;
      } catch (error) { return pauseFailure("goal", goal.id, goal.title, error); }
    })).finally(() => { this.activeTicks.delete(task); });
    this.activeTicks.add(task);
    return task;
  }
  async haltResume(haltId: string, heldBy: HaltHeldBy, keep: boolean): Promise<HaltOutcome[]> {
    const ids = [...this.records.keys()];
    const outcomes = await Promise.all(ids.map(id => this.enqueue<HaltOutcome | undefined>(id, async () => {
      const stored = this.records.get(id);
      if (!stored) return undefined;
      const goal = stored.goal, mark = stored.ownerHalt, base = { kind: "goal" as const, id: goal.id, title: goal.title };
      if (mark?.haltId !== haltId) return undefined;
      const refuse = async (reason: string): Promise<HaltOutcome> => {
        await this.settleHaltRun(stored, mark, releaseRefusal(reason));
        stored.ownerHalt = undefined; goal.reason = releaseRefusal(reason); this.save(stored);
        return { ...base, result: "refused", reason };
      };
      try {
        if (goal.status !== "paused" || goal.revision !== mark.revision) {
          if (goal.status === "paused" && isHaltReason(goal.reason)) goal.reason = LEFT_PAUSED;
          if (goal.status === "paused") await this.settleHaltRun(stored, mark, goal.reason ?? LEFT_PAUSED);
          stored.ownerHalt = undefined; this.save(stored);
          return { ...base, result: "left", reason: LEFT_AS_IS } satisfies HaltOutcome;
        }
        if (keep) {
          await this.settleHaltRun(stored, mark, KEPT_PAUSED);
          stored.ownerHalt = undefined; goal.reason = KEPT_PAUSED; this.save(stored);
          return { ...base, result: "kept", reason: KEPT_PAUSED } satisfies HaltOutcome;
        }
        if (stored.control && !await this.applyControl(stored)) return await refuse("The previous goal action is still being applied.");
        const other = heldBy([goal.projectId]);
        if (other) {
          stored.ownerHalt = { ...mark, haltId: other.haltId, revision: goal.revision }; goal.reason = other.reason; this.save(stored);
          return { ...base, result: "held", reason: STILL_HALTED } satisfies HaltOutcome;
        }
        if (goal.standing && autonomyOf(this.config.projects.find(value => value.id === goal.projectId)) !== "autonomous") return await refuse("This standing goal can resume only after its project is autonomous again.");
        if (!goal.standing && Date.now() >= Date.parse(goal.deadlineAt)) return await refuse("This goal's time limit has expired. Extend it or start a new goal to approve more time.");
        goal.revision++; goal.status = "running"; goal.reason = undefined;
        this.setControl(stored, "resume");
        stored.ownerHalt = undefined;
        this.event(stored, "Goal resumed: the owner released the halt."); this.save(stored);
        return { ...base, result: "resumed" } satisfies HaltOutcome;
      } catch (error) { return await refuse(error instanceof Error ? error.message : "The goal could not resume."); }
    })));
    return outcomes.filter((item): item is HaltOutcome => item !== undefined);
  }
  private async settleHaltRun(stored: Stored, mark: NonNullable<Stored["ownerHalt"]>, reason: string) {
    const run = mark.run;
    if (!run) return;
    if (stored.control?.halt?.token === run.token) stored.control = { ...stored.control, halt: { token: run.token, reason } };
    try { await this.teams.haltSettleChild(run.teamId, run.token, reason); }
    catch (error) {
      if (error instanceof TeamError && error.code === "team-not-found") return;
      this.event(stored, `The halt's reason on the goal's run could not be updated: ${error instanceof Error ? error.message : "the run could not be reached."}`);
    }
  }
  private async finishExtension(stored: Stored, intent: GoalExtensionIntent) {
    try {
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
    catch { }
  }
  extend(id: string, input: Action & { minutes: number }) {
    const body = goalExtendSchema.parse(input);
    return this.enqueue(id, async () => {
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
    return this.enqueue(id, () => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, "steer", body)) return structuredClone(goal);
      if (!["running", "needs-input"].includes(goal.status)) throw new TeamError(409, "goal-not-running", "Resume the goal before sending direction, or start a new goal if it has stopped.");
      if (stored.launch) throw new TeamError(409, "goal-launch-pending", "The next feature is being attached. Retry this direction after it appears.");
      if (goal.steering.length >= SHARED_INPUT_LIMITS.steeringEntries || Buffer.byteLength([goal.objective, ...goal.steering.map(item => `User direction: ${item.text}`), `User direction: ${body.text}`].join("\n\n")) > SHARED_INPUT_LIMITS.goalSteeringBytes)
        throw new TeamError(409, "goal-steering-limit", "Start a new goal with consolidated directions.");
      this.admit(stored, "steer", body);
      goal.steering.push({ text: body.text, revision: goal.revision, at: now() });
      { const note = goalObjectiveNote(stored, steerGoalObjective(stored, body.requestId, now())); if (note) this.event(stored, note); }
      if (goal.standing && !goal.activeTeamId) goal.pendingWake = { ...(goal.pendingWake ?? { signals: [], dropped: 0, since: now() }), owner: true };
      this.setControl(stored, "steer", { text: body.text });
      this.event(stored, "Direction recorded. The approved scope and execution limits remain in force.");
      this.save(stored); return structuredClone(goal);
    });
  }
  objectiveRecord(id: string, version?: number) { return goalObjectiveView(this.record(id), version); }
  metrics(id: string) {
    const { goal, metrics } = this.record(id);
    return goalMetricsRead(metrics, goal.cycles, this.config.projects.find(value => value.id === goal.projectId)?.team?.checks ?? []);
  }
  correctObjective(id: string, input: unknown): Promise<ObjectiveRecordView> {
    const parsed = correctionSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(objectiveError("objective-op-invalid"));
    const body = parsed.data;
    return this.enqueue(id, () => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, "record", body)) return goalObjectiveView(stored);
      const project = this.config.projects.find(value => value.id === goal.projectId);
      correctionGate(project, body);
      const next = correctGoalObjective(stored, body, { configured: project?.team?.checks ?? [], requestId: body.requestId, at: now(), rating: ratingStamp(goal) });
      const draft: Stored = { ...stored, goal: { ...goal, events: [...goal.events] }, receipts: { ...stored.receipts, [body.requestId]: digest({ action: "record", ...body }) }, objectiveRecord: next };
      this.event(draft, correctionEvent(next.version));
      this.save(draft);
      this.records.set(id, draft);
      return recordView(next);
    });
  }
  setParallelism(id: string, input: Action & { parallelism: number }) {
    goalParallelismSchema.parse(input);
    this.record(id);
    return Promise.reject(new TeamError(409, "agent-managed-capacity", "Goal worker capacity is agent-managed. The project manager selects a limit for each cycle."));
  }
  outcome(id: string, input: GoalOutcomeInput) {
    const body = goalOutcomeSchema.parse(input);
    return this.enqueue(id, () => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, "outcome", body)) return structuredClone(goal);
      if (!terminal.has(goal.status) || goal.activeTeamId || stored.control || stored.launch)
        throw new TeamError(409, "goal-still-active", "Stop the active work before recording a product outcome.");
      assertVerdictAnswer(goal, body, Date.now());
      this.admit(stored, "outcome", body);
      goal.outcomes.push({ result: body.result, summary: body.summary, evidence: body.evidence, at: now(), revision: goal.revision, ...(body.verdictId ? { verdictId: body.verdictId } : {}) });
      answerProvisional(goal);
      if (body.result === "achieved") goal.status = "achieved";
      else if (body.continue) {
        const note = continueGoal(stored, body, now());
        if (note) this.event(stored, note);
      }
      else if (goal.status === "achieved") goal.status = goal.cycles.some(cycle => ["ready-for-review", "merged"].includes(cycle.status)) ? "ready-for-review" : "no-opportunity";
      this.event(stored, body.continue ? CONTINUE_EVENT : "A user recorded a product outcome with supporting evidence.");
      this.save(stored); return structuredClone(goal);
    });
  }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => {
      if (this.tickQueued || this.closed) return;
      this.tickQueued = true;
      const ids = [...this.records.keys()];
      const run = mapConcurrent(ids, 8, id => this.enqueue(id, async () => {
        const stored = this.records.get(id);
        if (!stored || this.closed) return;
        try { await this.step(stored); }
        catch (error) {
          if (this.closed) return;
          const reason = error instanceof TeamError ? error.message : "The goal could not advance. Its work and evidence remain available.";
          if (stored.goal.status !== "blocked" || stored.goal.reason !== reason) this.event(stored, reason);
          if (!["paused", "cancelled", "limit-reached"].includes(stored.goal.status)) this.block(stored, reason);
          else stored.goal.reason = reason;
          try { this.save(stored); } catch {}
        }
      })).catch(() => {}).finally(() => { this.tickQueued = false; this.activeTicks.delete(run); });
      this.activeTicks.add(run);
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    while (this.activeTicks.size > 0) await Promise.allSettled([...this.activeTicks]);
    await this.queues.drain();
  }
  async idle(): Promise<void> {
    while (this.activeTicks.size > 0 || this.queues.size > 0) {
      if (this.activeTicks.size > 0) await Promise.allSettled([...this.activeTicks]);
      if (this.queues.size > 0) await this.queues.settle();
    }
  }
  private refresh(stored: Stored, team: TeamView) {
    const cycle = stored.goal.cycles.find(value => value.teamId === team.id)!;
    const late = lateVerdict(stored.goal, cycle, team) !== undefined;
    Object.assign(cycle, { status: team.status, memberCount: team.members.length, baseCommit: team.baseCommit, headCommit: team.headCommit, branch: team.branch, workspace: team.workspace, brief: team.brief, reason: team.reason }, cycleVerdict(stored.goal, cycle, team));
    if (late) { withdrawProvisional(stored.goal, cycle); this.event(stored, LATE_RECEIPT_EVENT); }
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
      await deliverControl(this.teams, control, body);
    } catch (error) {
      if (this.closed) return false;
      if (!(error instanceof TeamError)) throw error;
      if (["members-stopping", "team-operation-running"].includes(error.code)) return false;
      if (holdForStoppedCommand(stored, control, error, { event: text => this.event(stored, text), save: () => this.save(stored) })) return false;
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
      if (this.closed || !stored.goal.standing || !retryableCreationFailure(error) || this.runCreated(pending.request.requestId)) throw error;
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
    const inbox = goal.standing ? this.readWake(stored) : "current";
    const trackingReady = !goal.linear || goal.linear.status === "synced";
    if (trackingReady && goal.reason?.startsWith(trackingHoldPrefix)) { goal.reason = undefined; this.save(stored); }
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
      if (goal.standing && !this.runCreated(stored.launch.request.requestId)) this.withdrawLaunch(stored);
      else if (goal.status === "paused" || terminal.has(goal.status)) {
        try {
          const team = this.teams.get(stored.launch.request.requestId);
          if (!goal.cycles.some(cycle => cycle.teamId === team.id)) goal.cycles.push(this.cycleEntry(goal, team, stored.launch));
          goal.activeTeamId = team.id; this.setControl(stored, goal.status === "paused" ? "pause" : "cancel");
        } catch (error) { if (!(error instanceof TeamError) || error.code !== "team-not-found") throw error; }
        stored.launch = undefined; this.save(stored);
      } else if (trackingReady) await this.launch(stored);
      else this.holdForTracking(stored);
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
            const nextDigest = advanceGoalDigest(goal, cycle);
            if (nextDigest) goal.digest = nextDigest;
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
      const ended = ["ready-for-review", "merged", "no-change", "blocked", "cancelled"].includes(team.status);
      if (!ended) delete stored.endedAs;
      const classified = ended && stored.endedAs?.teamId === team.id && stored.endedAs.status === team.status && stored.endedAs.headCommit === team.headCommit;
      if (ended) {
        settleMetrics(stored, team.id, this.teams.reviewedObservations?.(team.id));
        if (["running", "needs-input"].includes(goal.status) && ["ready-for-review", "merged", "no-change"].includes(team.status) && team.linear && team.linear.status !== "synced") {
          if (team.linear.status === "blocked") {
            const reason = team.linear.reason ?? "The feature's Linear issue no longer permits continuation.";
            this.block(stored, reason); this.event(stored, reason);
          } else { this.save(stored); return; }
        }
        if (team.members.every(member => ["stopped", "waiting"].includes(member.status)) && !team.publishing) goal.activeTeamId = undefined;
        if (goal.standing) { if (!goal.activeTeamId) this.settleCycle(stored, goal.cycles.find(value => value.teamId === team!.id)!, team); }
        else if (["running", "needs-input"].includes(goal.status) && !classified) {
          stored.endedAs = { teamId: team.id, status: team.status, headCommit: team.headCommit };
          const endedCycle = goal.cycles.find(value => value.teamId === team!.id);
          if (endedCycle) { const nextDigest = advanceGoalDigest(goal, endedCycle, team); if (nextDigest) goal.digest = nextDigest; }
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
            if (provisionalStop(goal, team)) this.stopProvisional(stored);
            else {
              goal.status = "running"; goal.reason = undefined;
              this.event(stored, "A feature passed checks and independent review. The next feature will use its recorded commit.");
            }
          }
        }
      } else if (["running", "needs-input"].includes(goal.status)) {
        if (team.status === "paused") { goal.status = "paused"; goal.reason = "The active team was paused."; }
        else { goal.status = team.status === "needs-input" ? "needs-input" : "running"; goal.reason = team.reason; }
      } else if (goal.status === "paused" && goal.reason === stoppingReason && !stored.control && team.status === "paused"
        && team.members.every(member => ["stopped", "waiting"].includes(member.status))) {
        goal.reason = ownerStopReason.pause;
      }
      this.save(stored);
      }
    }
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
    if ((goal.status === "cancelled" || goal.status === "paused") && goal.reason === stoppingReason && !goal.activeTeamId && !stored.control && !stored.launch) {
      goal.reason = ownerStopReason[goal.status === "paused" ? "pause" : "cancel"]; this.save(stored);
    }
    if (terminal.has(goal.status) || goal.status === "paused") return;
    if (goal.standing) { await this.startStandingCycle(stored, trackingReady, inbox); return; }
    const timeUp = Date.now() >= Date.parse(goal.deadlineAt) && !this.teamExtendable(stored);
    if (timeUp || (!goal.activeTeamId && goal.memberCount >= goal.maxMembers)) {
      goal.status = "limit-reached";
      goal.stopReason = timeUp ? "deadline" : "member-limit";
      goal.deadlineContinuation = timeUp;
      goal.reason = timeUp ? timeLimitReason : "The approved agent-attempt limit has been reached.";
      this.setControl(stored, "cancel"); this.event(stored, goal.reason); this.save(stored); await this.applyControl(stored); return;
    }
    if (goal.activeTeamId) return;
    this.lateReceipt(stored, goal.cycles.at(-1));
    if (owedStop(goal, Boolean(stored.launch || stored.control))) { this.stopProvisional(stored); this.save(stored); return; }
    if (this.holdForDelivery(stored)) return;
    if (goal.cycles.length >= (goal.maxRuns ?? 0)) {
      goal.status = "ready-for-review"; goal.reason = "The approved feature-run limit has been reached. Review the accumulated changes; product impact has not been inferred.";
      this.event(stored, goal.reason); this.save(stored); return;
    }
    if (!trackingReady) { this.holdForTracking(stored); return; }
    const fuse = applyFuseReason(goal, this.fuse?.check({ projectId: goal.projectId }));
    if (fuse.changed) { if (fuse.wait) this.event(stored, goal.reason!); this.save(stored); }
    if (fuse.wait) return;
    await this.prepare(stored, goal.cycles.length + 1, Math.min(60, goal.maxMembers - goal.memberCount));
  }
  private async prepare(stored: Stored, cycle: number, maxMembers: number, useWake = true) {
    const goal = stored.goal;
    const project = this.config.projects.find(value => value.id === goal.projectId);
    const pinned = objectivePromptsOn(project) ? goalRecordDigest(stored, project?.team?.checks ?? [], objectiveRegisterOn(project)) : undefined;
    const note = digestEvent(goal.events, pinned);
    if (note) this.event(stored, note);
    const parent = latestReviewed(goal.cycles);
    const sourceIssue = goal.linear?.issue;
    const context: TeamGoalContext = { id: goal.id, revision: goal.revision, cycle, successCriteria: goal.successCriteria, nonGoals: goal.nonGoals, allowedPaths: goal.allowedPaths, evidence: goal.evidence,
      ...(sourceIssue ? { sourceIssue: { id: sourceIssue.id, identifier: sourceIssue.identifier, url: sourceIssue.url, title: sourceIssue.title, description: sourceIssue.description } } : {}),
      previousWork: formatPreviousWork(goal),
      deadlineAt: goal.deadlineAt, maxMembers, ...(parent ? { parentRunId: parent.teamId } : {}),
      extendMinutes: goal.extendMinutes ?? 0, ceilingAt: ceilingOf(goal), ...(pinned && "digest" in pinned ? { record: pinned.digest } : {}), ...criteriaRowsFor(stored, project) };
    const wake = goal.standing && useWake ? goal.pendingWake : undefined;
    const objective = wakeObjective([goal.objective, ...goal.steering.map(value => `User direction: ${value.text}`)].join("\n\n"), wake);
    const autonomy = autonomyOf(goal);
    stored.launch = { context, autonomy, request: { requestId: randomUUID(), projectId: goal.projectId, provider: goal.lineup.coordinator.provider, useConfiguredLineup: true, title: `${goal.title} · ${cycle}`.slice(0, 100), objective, parallelism: goal.parallelism },
      ...(wake ? { wake } : {}) };
    if (wake) goal.pendingWake = undefined;
    this.save(stored); await this.launch(stored);
  }
  private async startStandingCycle(stored: Stored, trackingReady: boolean, inbox: InboxState) {
    const goal = stored.goal, standing = goal.standing!;
    if (goal.activeTeamId || stored.launch) return;
    if (autonomyOf(this.config.projects.find(value => value.id === goal.projectId)) !== "autonomous")
      return this.hold(stored, "paused", "supervised-mode", "The project is supervised, so this standing goal paused at its cycle boundary. Resume it once the project is autonomous again.");
    if (!this.enabled()) {
      goal.status = "blocked"; goal.reason = "The host lineup no longer has a strong coordinator and reviewer. Configure one, then start a new goal.";
      this.event(stored, goal.reason); this.save(stored); return;
    }
    if ((goal.failedCycles ?? 0) >= maxFailedCycles) return this.hold(stored, "paused", "repeated-failures", repeatedFailuresReason);
    if (inbox === "behind") return;
    const last = goal.cycles.at(-1);
    let early = false;
    if (last) {
      const settled = Date.parse(last.settledAt ?? last.finishedAt ?? now());
      const woken = inbox === "current" && goal.pendingWake !== undefined && Date.now() >= settled + this.wakeGapMinutes() * 60000;
      early = Date.now() < cadenceDue(last, standing.cadenceMinutes, Date.now());
      if (early && !woken) return;
    }
    if (stored.launchRetryAt && Date.now() < Date.parse(stored.launchRetryAt)) return;
    if (!trackingReady) { this.holdForTracking(stored); return; }
    const fuse = applyFuseReason(goal, this.fuse?.check({ projectId: goal.projectId }));
    if (fuse.changed) { if (fuse.wait) this.event(stored, goal.reason!); this.save(stored); }
    if (fuse.wait) return;
    const latest = this.readWake(stored);
    if (latest === "behind" || (latest !== "current" && early)) return;
    const startedAt = Date.now();
    goal.deadlineAt = new Date(startedAt + goal.maxMinutes * 60000).toISOString();
    goal.ceilingAt = new Date(startedAt + (goal.maxTotalMinutes ?? goal.maxMinutes) * 60000).toISOString();
    goal.lineup = structuredClone(this.config.teams!.lineup!);
    await this.prepare(stored, foldedCycles(goal) + goal.cycles.length + 1, Math.min(60, goal.maxMembers), latest === "current");
  }
  private holdForTracking(stored: Stored) {
    const reason = trackingHoldReason(stored.goal.linear);
    if (stored.goal.reason === reason) return;
    stored.goal.reason = reason; this.save(stored);
  }
  private stopProvisional(stored: Stored) {
    markProvisional(stored.goal);
    this.event(stored, PROVISIONAL_EVENT);
  }
  private lateReceipt(stored: Stored, cycle: GoalCycle | undefined): void {
    const team = cycle === undefined ? undefined : this.teams.assessmentOf?.(cycle.teamId);
    if (cycle === undefined || team === undefined || !applyLateVerdict(stored.goal, cycle, team)) return;
    this.event(stored, LATE_RECEIPT_EVENT);
    this.save(stored);
  }
  async syncReceipts(): Promise<void> {
    if (this.closed) return;
    await mapConcurrent([...this.records.keys()], 8, id => this.enqueue(id, () => {
      const stored = this.records.get(id);
      if (!stored || this.closed) return;
      try { for (const cycle of stored.goal.cycles) if (cycle.assessment !== undefined) this.lateReceipt(stored, cycle); } catch {}
    }));
  }
  private holdForDelivery(stored: Stored): boolean {
    const goal = stored.goal, cycle = goal.cycles.at(-1);
    const scanned = this.config.projects.find(item => item.id === goal.projectId)?.source?.mode === "github";
    const detail = cycle?.assessment === undefined ? undefined : this.teams.verdicts?.detail(cycle.teamId);
    const holds = deliveryHold(goal, { nowMs: Date.now(), scanned, detail });
    const change = holdReasonChange(goal, holds);
    if (change === "hold") this.event(stored, DELIVERY_HOLD_REASON);
    if (change !== undefined) this.save(stored);
    return holds;
  }
  private runCreated(requestId: string) { return this.teams.goalIdOf(requestId) !== undefined; }
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
  private stopExpiredCycle(stored: Stored, teamDecides: boolean) {
    const goal = stored.goal;
    if (!goal.activeTeamId || teamDecides || !["running", "needs-input", "paused"].includes(goal.status) || Date.now() < Date.parse(goal.deadlineAt)) return;
    const cycle = goal.cycles.find(value => value.teamId === goal.activeTeamId);
    if (!cycle || cycle.deadlineStop) return;
    this.setControl(stored, "cancel");
    if (stored.control?.action !== "cancel" || stored.control.teamId !== cycle.teamId) return;
    cycle.deadlineStop = { at: now(), ...(this.fuse?.check({ projectId: goal.projectId }).state === "open" ? { fuseOpen: true as const } : {}) };
    this.event(stored, `Cycle ${cycle.cycle} reached its time limit and is stopping. The goal continues with its next cycle.`);
    this.save(stored);
  }
  private settleCycle(stored: Stored, cycle: GoalCycle, team?: TeamView) {
    const goal = stored.goal;
    if (cycle.class) return;
    const ownerStop = goal.status === "paused" || goal.status === "cancelled";
    cycle.class = classifyCycle({ status: cycle.status, stopReason: team?.stopReason, blockCode: team?.blockCode, deadlineStop: cycle.deadlineStop, ownerStop,
      fuseOpen: !ownerStop && this.fuse?.check({ projectId: goal.projectId }).state === "open" });
    cycle.settledAt = now();
    const nextDigest = advanceGoalDigest(goal, cycle, team);
    if (nextDigest) goal.digest = nextDigest;
    this.event(stored, `Cycle ${cycle.cycle} settled as ${cycle.class}.`);
    const unresolved = team && unresolvedOperation(team, this.teams.hasDeliveryAttempt(team.id));
    if (unresolved) {
      if (terminal.has(goal.status)) this.event(stored, unresolved);
      else this.hold(stored, "blocked", "external-operation", unresolved);
      return;
    }
    if (cycle.class === "failed" || (cycle.class === "reviewed" && verdictFailed(cycle))) goal.failedCycles = (goal.failedCycles ?? 0) + 1;
    else if (cycle.class !== "excluded") goal.failedCycles = 0;
    if (!["running", "needs-input"].includes(goal.status)) return;
    goal.status = "running"; goal.reason = undefined;
    if ((goal.failedCycles ?? 0) >= maxFailedCycles) this.hold(stored, "paused", "repeated-failures", repeatedFailuresReason);
  }
  private readWake(stored: Stored): InboxState {
    const goal = stored.goal, kinds = goal.standing?.wakeOn;
    if (!kinds?.length || !this.signals) return "current";
    if (goal.status === "paused" || terminal.has(goal.status)) return "unknown";
    let pending = goal.pendingWake, read: ReturnType<typeof readSignals>;
    try {
      read = readSignals(this.signals, goal.projectId, goal.signalCursor, kinds);
      if (!read) return "unknown";
      if (read.signals.length) {
        const own = new Set(goal.cycles.map(cycle => cycle.teamId));
        if (stored.launch) own.add(stored.launch.request.requestId);
        pending = addToPendingWake(pending, read.signals.filter(signal =>
          !(signal.runId && (own.has(signal.runId) || this.teams.goalIdOf(signal.runId) === goal.id))), now());
      }
    } catch {
      return "unknown";
    }
    const state = read.more ? "behind" : "current";
    if (read.cursor === goal.signalCursor && pending === goal.pendingWake) return state;
    goal.signalCursor = read.cursor;
    if (pending) goal.pendingWake = pending;
    this.save(stored);
    return state;
  }
  private cycleEntry(goal: ProductGoal, team: TeamView, pending: PendingLaunch): GoalCycle {
    return { teamId: team.id, cycle: pending.context.cycle, goalRevision: pending.context.revision, status: team.status, startedAt: team.createdAt, memberCount: team.members.length, autonomy: autonomyOf(pending),
      ...(goal.standing ? { lineup: structuredClone(goal.lineup) } : {}), ...(pending.wake ? { wake: cycleWakeOf(pending.wake) } : {}) };
  }
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
  private foldedRollup(cycle: GoalCycle): StoredRollup {
    try {
      const { usage } = this.teams.get(cycle.teamId);
      if (!usage.unavailable) return usage;
    } catch { }
    return snapshotRollup(cycle);
  }
}
