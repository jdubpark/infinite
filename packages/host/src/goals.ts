import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSealed, unseal } from "./vault.js";
import { autonomyOf, type AutonomyMode } from "./autonomy.js";
import { autonomyStartEvent, startMode } from "./evaluator-profiles.js";
import { TeamService, TeamError } from "./teams.js";
import { goalActionSchema, goalExtendSchema, goalOutcomeSchema, goalParallelismSchema, goalSteerSchema, parseCreateGoal, type CreateGoal, type CycleClass, type GoalCycle, type GoalReasonCode, type ProductGoal } from "./goal-types.js";
import type { Config } from "./types.js";
import { DEFAULT_TEAM_RETENTION, hostClosedBlockedReason, type CreateTeam, type TeamGoalContext, type TeamView } from "./team-types.js";
import { addRollups, emptyRollup, type StoredRollup, type UsageRollup } from "./team-usage.js";
import type { LinearService } from "./linear.js";
import type { LinearTrackingView } from "./linear-types.js";
import { applyFuseReason } from "./fuse/rules.js";
import type { FuseGate } from "./fuse/types.js";
import { readSignals } from "./signals/consume.js";
import { addToPendingWake, type PendingWake, type SignalReader } from "./signals/types.js";
import { cadenceDue, classifyCycle, cycleWakeOf, defaultWakeMinGapMinutes, foldedCycles, isReviewed, keptCycles, latestReviewed, maxFailedCycles, maxPreviousWork, restoreWake, runObjectiveLimitBytes, unresolvedOperation, wakeObjective, retryableCreationFailure } from "./goal-standing.js";
import { KEPT_PAUSED, LEFT_AS_IS, LEFT_PAUSED, STILL_HALTED, isHaltReason, pauseFailure, releaseRefusal, type HaltCovers, type HaltHeldBy, type HaltMark, type HaltOutcome } from "./halt/rules.js";
import { digestEvent, correctGoalObjective, createGoalObjective, goalObjectiveNote, goalObjectiveView, goalRecordDigest, loadGoalObjective, steerGoalObjective, type ObjectiveUnavailable } from "./objective-goals.js";
import { objectivePromptsOn } from "./objective-digest.js";
import { correctionSchema, type CriterionInput } from "./objective-input.js";
import { objectiveError, recordView, type ObjectiveRecordView } from "./objective-record.js";

type Action = { requestId: string; revision: number };
/**
 * `parallelism` remains readable only so a pre-migration queued owner control can be discarded safely. `halt` is set on
 * the owner's halt pause: the run decides in its own queue under the token and shows the reason. A release that read
 * the control without it applies the owner's pause instead.
 */
type PendingControl = { action: "pause" | "resume" | "cancel" | "steer" | "parallelism"; requestId: string; teamId: string; revision: number; text?: string; parallelism?: number; halt?: HaltRunMark };
/** The run a goal's halt pause was sent to, and the token that pause marks it with. */
type HaltRunMark = { token: string; reason: string };
type GoalExtensionIntent = Action & { minutes: number; fingerprint: string; teamId?: string; targetDeadlineAt?: string; targetCeilingAt?: string; failures?: number };
/** `wake` is the standing goal's pending wake this launch consumed, returned to the goal if the run is never created. */
type PendingLaunch = { request: CreateTeam; context: TeamGoalContext; autonomy?: AutonomyMode; wake?: PendingWake };
/** How much of the signal inbox a pass has folded into a goal's pending wake. */
type InboxState = "current" | "behind" | "unknown";
type Stored = {
  goal: ProductGoal;
  fingerprint: string;
  receipts: Record<string, string>;
  launch?: PendingLaunch;
  control?: PendingControl;
  extensionIntent?: GoalExtensionIntent;
  /** Standing goals: after a retryable failure to create a cycle's run, no cycle starts before this time. */
  launchRetryAt?: string;
  /**
   * Set when the owner's halt paused this goal, with the goal revision it left. Any owner action moves the revision on.
   * `run` names the active run the halt's pause was sent to, so a release that leaves the goal paused updates that run.
   */
  ownerHalt?: { haltId: string; revision: number; run?: { teamId: string; token: string } };
  /** The objective record (objective-goals.ts). Outside `goal`, so no view or digest reads it. */
  objectiveRecord?: unknown;
  objectiveNotice?: ObjectiveUnavailable;
};
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = new Set(["blocked", "ready-for-review", "no-opportunity", "limit-reached", "cancelled", "achieved"]);
const timeLimitReason = "The approved time limit has expired.";
/** An owner pause or cancel that has an active team to stop says so; once no team is stopping, the reason names the action. */
const stoppingReason = "The goal is stopping its active team. Existing work will remain available.";
const ownerStopReason = { pause: "The owner paused this goal. No new work starts until it resumes.", cancel: "The owner cancelled this goal. Existing work remains available." };
/** While Linear tracking holds new work, the goal shows the tracking reason after this prefix; the prefix lets a later pass clear it. */
const trackingHoldPrefix = "New work waits for Linear tracking: ";
/** The view's reason already names the retry time during a rate limit, so nothing is added to it. */
const trackingHoldReason = (view: LinearTrackingView | undefined) => `${trackingHoldPrefix}${view?.reason ?? "Linear has not confirmed this goal's issue."}`;
const repeatedFailuresReason = "Three cycles in a row failed, so this standing goal paused. Review the failed cycles, then resume it to reset the count.";
const maxExtensionFailures = 3;
const correctionEvent = (version: number) => `The owner corrected the objective record to version ${version}.`;
const launchRetryMs = 60_000;
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
      if (note) this.event(stored, note);
      this.records.set(id, stored);
      if (digest(stored) === before) { this.saved.set(id, before); continue; }
      try { writeSealed(join(this.directory, file), key, `goal:${id}`, stored); this.saved.set(id, digest(stored)); }
      catch { this.saved.set(id, digest(stored)); unsaved++; }
    }
    if (unsaved) console.warn(`Objective records of ${unsaved} goals could not be saved at startup. Each is saved with its goal's next change.`);
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
    // A paused goal, the owner's halt included, starts no cycle, so it has no next cycle time until it resumes.
    if (goal.standing && last && !goal.activeTeamId && !terminal.has(goal.status) && goal.status !== "paused")
      goal.nextCycleAt = new Date(cadenceDue(last, goal.standing.cadenceMinutes, Date.now())).toISOString();
    return { ...goal, tasks };
  }
  answer(teamId: string, decisionId: string, body: Action & { text: string }) {
    return this.enqueue(async () => {
      const team = this.teams.get(teamId);
      if (!team.goal) throw new TeamError(409, "not-a-goal-team", "This team does not belong to a goal.");
      // A goal the halt paused still takes the answer for its run held where it waits; the run starts nothing until it resumes.
      return this.teams.answer(teamId, decisionId, body, held => {
        const { goal } = this.record(team.goal!.id);
        const live = ["running", "needs-input"].includes(goal.status) || held && goal.status === "paused";
        if (goal.activeTeamId !== teamId || !live || Date.now() >= Date.parse(goal.deadlineAt))
          throw new TeamError(409, "goal-not-running", "Only the active team of a running goal can receive a decision.");
      });
    });
  }
  activeForProject(projectId: string) {
    return [...this.records.values()].some(({ goal, launch, control }) => goal.projectId === projectId && (Boolean(launch || control || goal.activeTeamId) || ["running", "needs-input", "paused"].includes(goal.status)));
  }
  create(input: CreateGoal, admit?: () => void, criteria?: CriterionInput[]) {
    const request = parseCreateGoal(input);
    // Creation criteria are part of the request: a goal without them keeps today's fingerprint and size.
    const payload = criteria ? { ...request, criteria } : request;
    return this.enqueue(() => {
      const fingerprint = digest(payload), prior = this.records.get(request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different goal.");
        return structuredClone(prior.goal);
      }
      // A scheduled approval can expire or change while waiting behind another
      // goal operation. Validate it in this transaction, immediately before a
      // new goal receives its execution window. Existing receipts remain replayable.
      admit?.();
      if (!this.enabled()) throw new TeamError(409, "goals-not-configured", "Configure a team lineup with a strong coordinator and reviewer before starting a goal.");
      if (Buffer.byteLength(JSON.stringify(payload)) > 40000) throw new TeamError(409, "goal-too-large", "Keep the goal and evidence below 40 KiB. Link to longer source material.");
      const project = this.config.projects.find(value => value.id === request.projectId);
      if (!project?.team || (!project.team.checks.length && !project.team.establishChecks)) throw new TeamError(409, "goal-project-not-configured", "Configure required checks or authorize the team to establish them before a goal can start.");
      if (request.linearIssueId && !project.linear) throw new TeamError(409, "linear-not-configured", "Configure Linear for this project before linking an issue.");
      const start = startMode(project, this.config.teams?.lineup); if (request.standing && start.mode !== "autonomous")
        throw new TeamError(409, "standing-requires-autonomy", start.reason ? "A standing goal needs an evaluator: no lineup profile of a model family other than the coordinator's can evaluate it. Add one to the lineup's evaluators, or start a finite goal." : "A standing goal needs an autonomous project. Start a finite goal, or make the project autonomous first.");
      // Every cycle passes the whole objective; the host never cuts the owner's text to fit its wake reasons.
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
    });
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
  /**
   * Host-internal: the owner's halt pauses each running goal in scope, and each goal whose run waits for input, as the
   * owner's pause does, without an owner request, and marks it with the revision it leaves. A pending steer is delivered
   * first, never dropped. The goal's run gets the halt's own pause: a working run stops, and one that waits for input is
   * held where it waits, so its question survives the halt.
   */
  haltPause(mark: HaltMark, covers: HaltCovers) {
    const pausable = (goal: ProductGoal) => goal.status === "running" || goal.status === "needs-input";
    return this.enqueue(async () => {
      const outcomes: HaltOutcome[] = [];
      for (const stored of this.records.values()) {
        const goal = stored.goal;
        if (!pausable(goal) || !covers([goal.projectId], goal.id)) continue;
        try {
          if (stored.control?.action === "steer" && !await this.applyControl(stored)) throw new TeamError(409, "goal-control-pending", "The previous goal action is still being applied.");
          if (!pausable(goal)) continue;
          goal.revision++; goal.status = "paused"; goal.reason = mark.reason;
          const token = randomUUID();
          this.setControl(stored, "pause", { halt: { token, reason: mark.reason } });
          const sent = stored.control?.halt?.token === token ? { run: { teamId: stored.control.teamId, token } } : {};
          stored.ownerHalt = { haltId: mark.haltId, revision: goal.revision, ...sent };
          this.event(stored, `Goal paused: ${mark.reason}`); this.save(stored);
          outcomes.push({ kind: "goal", id: goal.id, title: goal.title, result: "paused" });
        } catch (error) { outcomes.push(pauseFailure("goal", goal.id, goal.title, error)); }
      }
      return outcomes;
    });
  }
  /**
   * Host-internal: resumes each goal still paused, unchanged, under this halt's mark, with the owner's resume rules. A
   * goal that stays paused hands its reason to the run its halt paused before the mark ends, so a restart in between
   * repeats that step and the run never keeps a halt's reason once the halt is off.
   */
  haltResume(haltId: string, heldBy: HaltHeldBy, keep: boolean) {
    return this.enqueue(async () => {
      const outcomes: HaltOutcome[] = [];
      for (const stored of this.records.values()) {
        const goal = stored.goal, mark = stored.ownerHalt, base = { kind: "goal" as const, id: goal.id, title: goal.title };
        if (mark?.haltId !== haltId) continue;
        const refuse = async (reason: string) => {
          await this.settleHaltRun(stored, mark, releaseRefusal(reason));
          stored.ownerHalt = undefined; goal.reason = releaseRefusal(reason); this.save(stored);
          outcomes.push({ ...base, result: "refused", reason });
        };
        try {
          if (goal.status !== "paused" || goal.revision !== mark.revision) {
            if (goal.status === "paused" && isHaltReason(goal.reason)) goal.reason = LEFT_PAUSED;
            if (goal.status === "paused") await this.settleHaltRun(stored, mark, goal.reason ?? LEFT_PAUSED);
            stored.ownerHalt = undefined; this.save(stored);
            outcomes.push({ ...base, result: "left", reason: LEFT_AS_IS }); continue;
          }
          if (keep) {
            await this.settleHaltRun(stored, mark, KEPT_PAUSED);
            stored.ownerHalt = undefined; goal.reason = KEPT_PAUSED; this.save(stored);
            outcomes.push({ ...base, result: "kept", reason: KEPT_PAUSED }); continue;
          }
          if (stored.control && !await this.applyControl(stored)) { await refuse("The previous goal action is still being applied."); continue; }
          const other = heldBy([goal.projectId]);
          if (other) {
            stored.ownerHalt = { ...mark, haltId: other.haltId, revision: goal.revision }; goal.reason = other.reason; this.save(stored);
            outcomes.push({ ...base, result: "held", reason: STILL_HALTED }); continue;
          }
          // The owner's resume rules. A standing goal's time limit belongs to its cycle, so a halt that outlasts the
          // cycle's window does not end the goal; it resumes only while its project is still autonomous.
          if (goal.standing && autonomyOf(this.config.projects.find(value => value.id === goal.projectId)) !== "autonomous") { await refuse("This standing goal can resume only after its project is autonomous again."); continue; }
          if (!goal.standing && Date.now() >= Date.parse(goal.deadlineAt)) { await refuse("This goal's time limit has expired. Extend it or start a new goal to approve more time."); continue; }
          goal.revision++; goal.status = "running"; goal.reason = undefined;
          this.setControl(stored, "resume");
          stored.ownerHalt = undefined;
          this.event(stored, "Goal resumed: the owner released the halt."); this.save(stored);
          outcomes.push({ ...base, result: "resumed" });
        } catch (error) { await refuse(error instanceof Error ? error.message : "The goal could not resume."); }
      }
      return outcomes;
    });
  }
  /**
   * A release that leaves the goal paused: the run its halt paused keeps its pause and shows `reason` instead of the
   * halt's. A halt pause still pending is delivered with that reason. The run is also settled in its own queue, against
   * the token, every time: a pending pause may already be saved on the run, when a restart came between that save and
   * the goal's acknowledgement, and its replay then finds no token and changes nothing. Never throws: a failure is
   * recorded on the goal and the release goes on.
   */
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
      { const note = goalObjectiveNote(stored, steerGoalObjective(stored, body.requestId, now())); if (note) this.event(stored, note); }
      // Between cycles, direction starts the next cycle early, subject to every gate and the wake gap.
      if (goal.standing && !goal.activeTeamId) goal.pendingWake = { ...(goal.pendingWake ?? { signals: [], dropped: 0, since: now() }), owner: true };
      this.setControl(stored, "steer", { text: body.text });
      this.event(stored, "Direction recorded. The approved scope and execution limits remain in force.");
      this.save(stored); return structuredClone(goal);
    });
  }
  objectiveRecord(id: string, version?: number) { return goalObjectiveView(this.record(id), version); }
  /**
   * The owner's correction of the criteria, applied exactly once. It writes the goal's sealed file once and answers the
   * corrected record. A replay answers the latest view and writes nothing. Refused while objective prompts are off.
   */
  correctObjective(id: string, input: unknown): Promise<ObjectiveRecordView> {
    const parsed = correctionSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(objectiveError("objective-op-invalid"));
    const body = parsed.data;
    return this.enqueue(() => {
      const stored = this.record(id), goal = stored.goal;
      if (this.replay(stored, "record", body)) return goalObjectiveView(stored);
      const project = this.config.projects.find(value => value.id === goal.projectId);
      if (!objectivePromptsOn(project)) throw objectiveError("objective-prompts-off");
      const next = correctGoalObjective(stored, body, { configured: project?.team?.checks ?? [], requestId: body.requestId, at: now() });
      // The write works on a copy, so a failed write leaves the record, the receipts, the events, and updatedAt as they were.
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
      else if (control.action === "pause" && control.halt) await this.teams.haltPauseChild(control.teamId, control.halt.token, control.halt.reason);
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
      } else if (goal.status === "paused" && goal.reason === stoppingReason && !stored.control && team.status === "paused"
        && team.members.every(member => ["stopped", "waiting"].includes(member.status))) {
        // The owner's pause reached the team and its members have stopped. The team stays attached for the resume.
        goal.reason = ownerStopReason.pause;
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
  /**
   * Records the next cycle's launch, consuming a standing goal's pending wake in the same write, then starts it.
   * With `useWake` false the pending wake stays on the goal: it may hold half of a batch.
   */
  private async prepare(stored: Stored, cycle: number, maxMembers: number, useWake = true) {
    const goal = stored.goal;
    // The digest is built before the launch is saved, so a replay of that launch carries the same digest.
    const project = this.config.projects.find(value => value.id === goal.projectId);
    const pinned = objectivePromptsOn(project) ? goalRecordDigest(stored, project?.team?.checks ?? []) : undefined;
    const note = digestEvent(goal.events, pinned);
    if (note) this.event(stored, note);
    const parent = latestReviewed(goal.cycles);
    const sourceIssue = goal.linear?.issue;
    const context: TeamGoalContext = { id: goal.id, revision: goal.revision, cycle, successCriteria: goal.successCriteria, nonGoals: goal.nonGoals, allowedPaths: goal.allowedPaths, evidence: goal.evidence,
      ...(sourceIssue ? { sourceIssue: { id: sourceIssue.id, identifier: sourceIssue.identifier, url: sourceIssue.url, title: sourceIssue.title, description: sourceIssue.description } } : {}),
      // The team context accepts 16 entries, so a long-running goal passes its newest reviewed cycles.
      previousWork: goal.cycles.filter(isReviewed).slice(-maxPreviousWork).map(value => `${value.brief?.title ?? `Feature ${value.cycle}`}: ${value.brief?.expectedOutcome ?? "Reviewed change"}`.slice(0, 2000)),
      deadlineAt: goal.deadlineAt, maxMembers, ...(parent ? { parentRunId: parent.teamId } : {}),
      extendMinutes: goal.extendMinutes ?? 0, ceilingAt: ceilingOf(goal), ...(pinned && "digest" in pinned ? { record: pinned.digest } : {}) };
    const wake = goal.standing && useWake ? goal.pendingWake : undefined;
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
   *
   * `inbox` is what this pass read of the signal inbox. Only a `current` pending wake starts a cycle early or is used
   * up by a launch, and nothing starts while the goal is `behind`, so the signals of one batch start one cycle.
   */
  private async startStandingCycle(stored: Stored, trackingReady: boolean, inbox: InboxState) {
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
    // More signals wait than one pass reads. No cycle starts until the pending wake holds them all.
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
    // The pass waited since its first read. A signal recorded meanwhile belongs to this cycle, so the inbox is read once
    // more; nothing below waits before the launch is saved. An early start needs the whole inbox. A cadence start does
    // not wait for an unreadable inbox, and it leaves the pending wake alone.
    const latest = this.readWake(stored);
    if (latest === "behind" || (latest !== "current" && early)) return;
    // Allowances renew for each cycle (3.2), and the cycle takes the host's current lineup (3.5).
    const startedAt = Date.now();
    goal.deadlineAt = new Date(startedAt + goal.maxMinutes * 60000).toISOString();
    goal.ceilingAt = new Date(startedAt + (goal.maxTotalMinutes ?? goal.maxMinutes) * 60000).toISOString();
    goal.lineup = structuredClone(this.config.teams!.lineup!);
    await this.prepare(stored, foldedCycles(goal) + goal.cycles.length + 1, Math.min(60, goal.maxMembers), latest === "current");
  }
  /**
   * New work waits while Linear tracking is not synced. The goal stays `running` and shows the tracking reason. No
   * event is recorded: tracking goes briefly unsynced on every refresh.
   */
  private holdForTracking(stored: Stored) {
    const reason = trackingHoldReason(stored.goal.linear);
    if (stored.goal.reason === reason) return;
    stored.goal.reason = reason; this.save(stored);
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
  /**
   * W2: folds new signals from other runs into the pending wake and advances the cursor, in one write. A paused or
   * ended goal reads nothing and keeps its place.
   *
   * The result says how much of the inbox the pending wake now holds. `current`: every signal recorded so far, also
   * when the goal watches no signals. `behind`: one pass reads one page, and more signals wait. `unknown`: the inbox
   * was not read. Nothing more is stored for this: after a restart the saved cursor gives the same answer.
   */
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
      // The reader must not throw. If it does, or the goal's own runs cannot be told, nothing is read on this pass.
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
