import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { writeSealed, unseal } from "./vault.js";
import { TeamError } from "./teams.js";
import type { Config, Project } from "./types.js";
import { createGoalSchema, type CreateGoal, type ProductGoal } from "./goal-types.js";
import { createRoutineSchema, routineActionSchema, type CreateRoutine, type Routine, type RoutineAction, type RoutineWake } from "./routine-types.js";
import type { GoalService } from "./goals.js";
import { applyFuseReason } from "./fuse/rules.js";
import type { FuseGate } from "./fuse/types.js";
import { KeyedQueue, mapConcurrent } from "./keyed-queue.js";
import { readSignals } from "./signals/consume.js";
import { addToPendingWake, type SignalReader } from "./signals/types.js";
import { KEPT_PAUSED, LEFT_AS_IS, STILL_HALTED, pauseFailure, releaseRefusal, type HaltCovers, type HaltHeldBy, type HaltMark, type HaltOutcome } from "./halt/rules.js";

type HookSet = {
  isProjectBusy(projectId: string): Promise<boolean>;
  startGoal(request: CreateGoal, admit: () => void): Promise<ProductGoal>;
};
type RunsOfGoals = (goalIds: readonly string[]) => Iterable<string>;
type LaunchIntent = { request: CreateGoal; createdAt: string; attempted?: boolean; wake?: RoutineWake };
type Stored = {
  routine: Routine;
  fingerprint: string;
  authority: string;
  receipts: Record<string, string>;
  launch?: LaunchIntent;
  ownerHalt?: { haltId: string };
};
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function digestedTeams(teams: Config["teams"]): Config["teams"] {
  if (!teams || !("outcomes" in teams || "memberTraces" in teams)) return teams;
  const rest: Partial<NonNullable<Config["teams"]>> = { ...teams };
  delete rest.outcomes;
  delete rest.memberTraces;
  return rest as Config["teams"];
}
function digestedProjectTeam(team: Project["team"]): Project["team"] {
  if (!team || !("eval" in team || "mainCheck" in team)) return team;
  const rest: Partial<NonNullable<Project["team"]>> = { ...team };
  delete rest.eval;
  delete rest.mainCheck;
  return rest as Project["team"];
}
const terminal = new Set<Routine["status"]>(["completed", "cancelled", "expired"]);
const allowedSettled = new Set(["no-opportunity", "achieved"]);
const maxRecords = 1000;
const maxApprovalMs = 30 * 24 * 60 * 60 * 1000;
const minute = 60_000;
const defaultWakeMinGapMinutes = 5;

export class RoutineService {
  private readonly records = new Map<string, Stored>();
  private readonly saved = new Map<string, string>();
  private readonly directory: string;
  private readonly queues = new KeyedQueue();
  private readonly activeTicks = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private tickQueued = false;
  private fuse?: FuseGate;
  private signals?: { reader: SignalReader; runsOfGoals: RunsOfGoals };

  constructor(private readonly config: Config, private readonly key: Buffer, private readonly goals: GoalService, private readonly hooks: HookSet) {
    this.directory = join(config.stateDir, "routines");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `routine:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.routine.id !== id || stored.routine.occurrences.length > stored.routine.maxOccurrences) throw new TeamError(409, "invalid-routine-record", "A routine record cannot be authenticated.");
      if (stored.launch?.attempted) stored.launch.attempted = false;
      this.records.set(id, stored); this.saved.set(id, digest(stored));
      if (stored.launch?.attempted === false) this.save(stored);
    }
  }
  private enqueue<T>(id: string, task: () => T | Promise<T>): Promise<T> {
    return this.queues.enqueue(`routine:${id}`, task);
  }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "routine-not-found", "This routine does not exist.");
    return stored;
  }
  private save(stored: Stored) {
    if (this.saved.get(stored.routine.id) === digest(stored)) return;
    stored.routine.updatedAt = now();
    writeSealed(join(this.directory, `${stored.routine.id}.sealed`), this.key, `routine:${stored.routine.id}`, stored);
    this.saved.set(stored.routine.id, digest(stored));
  }
  private view(stored: Stored): Routine { return structuredClone(stored.routine); }
  get(id: string) { return this.view(this.record(id)); }
  list() { return [...this.records.values()].map(value => this.view(value)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  private authority(project: Project) {
    let canonicalPath: string;
    try { canonicalPath = realpathSync(project.path); }
    catch { throw new TeamError(409, "routine-project-missing", "The project path cannot be resolved. Routine approval requires an existing canonical project path."); }
    return digest({
      project: { path: canonicalPath, team: digestedProjectTeam(project.team), teamworkDir: project.teamworkDir, source: project.source, linear: project.linear },
      teams: digestedTeams(this.config.teams),
      source: this.config.source,
      linear: this.config.linear,
      agents: this.config.agents,
    });
  }
  private assertAuthority(stored: Stored) {
    const project = this.config.projects.find(value => value.id === stored.routine.goal.projectId);
    if (!project || this.authority(project) !== stored.authority) {
      stored.routine.status = "blocked";
      stored.routine.reason = "The project or host approval policy changed. Review the routine and create a new approval before more work starts.";
      this.save(stored);
      return false;
    }
    return true;
  }
  useFuse(fuse: FuseGate) { this.fuse = fuse; }
  useSignals(reader: SignalReader, runsOfGoals: RunsOfGoals) { this.signals = { reader, runsOfGoals }; }
  create(input: CreateRoutine): Promise<Routine> {
    const request = createRoutineSchema.parse(input);
    return this.queues.enqueue("admission", () => {
      const fingerprint = digest(request), prior = this.records.get(request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different routine.");
        return this.view(prior);
      }
      if (this.records.size >= maxRecords) throw new TeamError(409, "routine-capacity", "The host has reached its retained routine limit.");
      const starts = Date.parse(request.startsAt), expires = Date.parse(request.expiresAt), created = Date.now();
      if (expires <= created || expires <= starts || expires - created > maxApprovalMs) throw new TeamError(400, "invalid-routine-window", "Routine approval must expire in the future, after its start, and within 30 days.");
      if (starts < created) throw new TeamError(400, "invalid-routine-window", "Routine start time cannot be in the past.");
      const project = this.config.projects.find(value => value.id === request.goal.projectId);
      const lineup = this.config.teams?.lineup;
      if (!lineup || lineup.coordinator.tier !== "strong" || lineup.reviewer.tier !== "strong") throw new TeamError(409, "goals-not-configured", "Configure a strong coordinator and reviewer before approving a routine.");
      if (!project?.team || (!project.team.checks.length && !project.team.establishChecks)) throw new TeamError(409, "goal-project-not-configured", "Configure required checks or authorize the team to establish them before approving a routine.");
      if (request.goal.linearIssueId && !project.linear) throw new TeamError(409, "linear-not-configured", "Configure Linear for this project before linking an issue.");
      if (request.goal.maxTotalMinutes !== undefined && request.goal.maxTotalMinutes < request.goal.maxMinutes) throw new TeamError(400, "invalid-routine-budget", "The total time ceiling cannot be shorter than the goal time limit.");
      const routine: Routine = {
        id: request.requestId, revision: 1, status: "scheduled", goal: request.goal,
        intervalMinutes: request.intervalMinutes, maxOccurrences: request.maxOccurrences,
        startsAt: request.startsAt, expiresAt: request.expiresAt, nextRunAt: request.startsAt,
        occurrences: [], createdAt: new Date(created).toISOString(), updatedAt: new Date(created).toISOString(),
      };
      if (request.wakeOn) {
        routine.wakeOn = [...request.wakeOn];
        const head = this.signals?.reader.head();
        if (head !== undefined) routine.signalCursor = head;
      }
      const stored: Stored = { routine, fingerprint, authority: this.authority(project), receipts: {} };
      this.records.set(routine.id, stored); this.save(stored);
      return this.view(stored);
    });
  }
  private replay(stored: Stored, action: string, body: RoutineAction) {
    const prior = stored.receipts[body.requestId];
    if (!prior) return false;
    if (prior !== digest({ action, ...body })) throw new TeamError(409, "request-conflict", "This request ID belongs to a different routine action.");
    return true;
  }
  private action(id: string, action: "pause" | "resume" | "cancel", input: RoutineAction) {
    const body = routineActionSchema.parse(input);
    return this.enqueue(id, () => {
      const stored = this.record(id), routine = stored.routine;
      if (this.replay(stored, action, body)) return this.view(stored);
      if (body.revision !== routine.revision) throw new TeamError(409, "stale-routine-revision", "The routine changed. Refresh it before sending this action.");
      if (terminal.has(routine.status)) throw new TeamError(409, "routine-stopped", "This routine has stopped and cannot be changed.");
      if (action === "pause" && routine.status === "paused") throw new TeamError(409, "routine-not-running", "This routine is already paused.");
      if (action === "resume") { const refusal = this.resumeRefusal(stored); if (refusal) throw refusal; }
      routine.revision++; stored.receipts[body.requestId] = digest({ action, ...body });
      stored.ownerHalt = undefined;
      if (action === "pause") { routine.status = "paused"; routine.reason = routine.activeGoalId ? "Future routine triggers are paused. The active goal retains its own controls and limits." : "Future routine triggers are paused."; }
      else if (action === "cancel") { routine.status = "cancelled"; routine.reason = routine.activeGoalId ? "Future routine triggers are cancelled. The active goal retains its own controls and limits." : "Future routine triggers are cancelled."; }
      else this.applyResume(stored);
      this.save(stored); return this.view(stored);
    });
  }
  private resumeRefusal(stored: Stored): TeamError | undefined {
    const routine = stored.routine;
    if (routine.status !== "paused" && routine.status !== "blocked") return new TeamError(409, "routine-not-paused", "Only a paused or blocked routine can resume.");
    if (Date.now() >= Date.parse(routine.expiresAt)) return new TeamError(409, "routine-expired", "This routine's approval has expired.");
    if (!this.assertAuthority(stored)) return new TeamError(409, "routine-authority-changed", routine.reason!);
    return undefined;
  }
  private applyResume(stored: Stored) {
    const routine = stored.routine;
    routine.status = routine.occurrences.length ? "running" : "scheduled"; routine.reason = undefined; if (stored.launch) stored.launch.attempted = false;
  }
  async haltPause(mark: HaltMark, covers: HaltCovers) {
    const ids = [...this.records.keys()];
    const outcomes = await Promise.all(ids.map(id => this.enqueue(id, () => {
      const stored = this.records.get(id);
      if (!stored) return undefined;
      const routine = stored.routine, title = routine.goal.title;
      if ((routine.status !== "scheduled" && routine.status !== "running") || !covers([routine.goal.projectId], routine.id)) return undefined;
      try {
        routine.revision++; routine.status = "paused"; routine.reason = mark.reason;
        stored.ownerHalt = { haltId: mark.haltId };
        this.save(stored);
        return { kind: "routine", id: routine.id, title, result: "paused" } satisfies HaltOutcome;
      } catch (error) { return pauseFailure("routine", routine.id, title, error); }
    })));
    return outcomes.filter((item): item is HaltOutcome => item !== undefined);
  }
  async haltResume(haltId: string, heldBy: HaltHeldBy, keep: boolean): Promise<HaltOutcome[]> {
    const ids = [...this.records.keys()];
    const outcomes = await Promise.all(ids.map(id => this.enqueue<HaltOutcome | undefined>(id, () => {
      const stored = this.records.get(id);
      if (!stored || stored.ownerHalt?.haltId !== haltId) return undefined;
      const routine = stored.routine, base = { kind: "routine" as const, id: routine.id, title: routine.goal.title };
      try {
        if (routine.status !== "paused") {
          stored.ownerHalt = undefined; this.save(stored);
          return { ...base, result: "left", reason: LEFT_AS_IS } satisfies HaltOutcome;
        }
        if (keep) {
          stored.ownerHalt = undefined; routine.reason = KEPT_PAUSED; this.save(stored);
          return { ...base, result: "kept", reason: KEPT_PAUSED } satisfies HaltOutcome;
        }
        const other = heldBy([routine.goal.projectId]);
        if (other) {
          stored.ownerHalt = { haltId: other.haltId }; routine.reason = other.reason; this.save(stored);
          return { ...base, result: "held", reason: STILL_HALTED } satisfies HaltOutcome;
        }
        const refusal = this.resumeRefusal(stored);
        if (refusal) {
          stored.ownerHalt = undefined;
          if (routine.status === "paused") routine.reason = releaseRefusal(refusal.message);
          this.save(stored);
          return { ...base, result: "refused", reason: refusal.message } satisfies HaltOutcome;
        }
        routine.revision++;
        this.applyResume(stored);
        stored.ownerHalt = undefined;
        this.save(stored);
        return { ...base, result: "resumed" } satisfies HaltOutcome;
      } catch (error) { return { ...base, result: "refused", reason: error instanceof Error ? error.message : "The routine could not resume." } satisfies HaltOutcome; }
    })));
    return outcomes.filter((item): item is HaltOutcome => item !== undefined);
  }
  pause(id: string, action: RoutineAction) { return this.action(id, "pause", action); }
  resume(id: string, action: RoutineAction) { return this.action(id, "resume", action); }
  cancel(id: string, action: RoutineAction) { return this.action(id, "cancel", action); }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => {
      if (this.tickQueued || this.closed) return;
      this.tickQueued = true;
      void this.tick().catch(() => {}).finally(() => { this.tickQueued = false; });
    };
    this.timer = setInterval(tick, 1000); this.timer.unref(); tick();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    while (this.activeTicks.size > 0) await Promise.allSettled([...this.activeTicks]);
    await this.queues.drain();
  }
  async tick() {
    const ids = [...this.records.keys()];
    const run = mapConcurrent(ids, 8, id => this.enqueue(id, async () => {
      const stored = this.records.get(id);
      if (!stored || this.closed) return;
      try { await this.step(stored); }
      catch (error) {
        if (this.closed) return;
        const reason = error instanceof TeamError ? error.message : "Routine state could not be reconciled. Review it before resuming.";
        this.block(stored, reason);
      }
    })).finally(() => { this.activeTicks.delete(run); });
    this.activeTicks.add(run);
    await run;
  }
  private block(stored: Stored, reason: string) {
    if (stored.routine.status !== "blocked" || stored.routine.reason !== reason) stored.routine.revision++;
    stored.routine.status = "blocked"; stored.routine.reason = reason;
    this.save(stored);
  }
  private readWake(stored: Stored): "current" | "behind" | "unknown" {
    const routine = stored.routine;
    if (!this.signals || !routine.wakeOn?.length) return "current";
    const read = readSignals(this.signals.reader, routine.goal.projectId, routine.signalCursor, routine.wakeOn);
    if (!read) return "unknown";
    let pending = routine.pendingWake;
    if (read.signals.length) {
      const goalIds = new Set([
        ...routine.occurrences.map(value => value.goalId),
        ...(routine.activeGoalId ? [routine.activeGoalId] : []),
        ...(stored.launch ? [stored.launch.request.requestId] : []),
      ]);
      let own: Set<string>;
      try {
        own = read.signals.some(signal => signal.runId !== undefined) ? new Set(this.signals.runsOfGoals([...goalIds])) : new Set();
      } catch {
        return "unknown";
      }
      pending = addToPendingWake(pending, read.signals.filter(signal => signal.runId === undefined || !own.has(signal.runId)), now());
    }
    const state = read.more ? "behind" : "current";
    if (read.cursor === routine.signalCursor && pending === routine.pendingWake) return state;
    routine.signalCursor = read.cursor;
    if (pending) routine.pendingWake = pending;
    this.save(stored);
    return state;
  }
  private wakeDue(routine: Routine, current: number) {
    if (!routine.pendingWake || routine.wakeDeferred) return false;
    const last = routine.occurrences[routine.occurrences.length - 1];
    if (!last) return true;
    if (!last.endedAt) return false;
    const gap = this.config.autonomy?.continuity?.wakeMinGapMinutes ?? defaultWakeMinGapMinutes;
    return current >= Date.parse(last.endedAt) + gap * minute;
  }
  private async step(stored: Stored) {
    const routine = stored.routine;
    if (stored.launch && ["paused", "cancelled", "expired"].includes(routine.status)) {
      await this.reconcileLaunch(stored); return;
    }
    if (stored.launch && routine.status === "blocked") {
      if (stored.launch.attempted) await this.reconcileLaunch(stored);
      else await this.queues.enqueue(`project:${routine.goal.projectId}`, () => this.replayLaunch(stored));
      return;
    }
    if (terminal.has(routine.status) || routine.status === "paused" || (routine.status === "blocked" && (!stored.launch || stored.launch.attempted))) return;
    const current = Date.now();
    if (current >= Date.parse(routine.expiresAt)) {
      routine.status = "expired"; routine.revision++; routine.reason = "The routine approval expired; no further goals will start."; this.save(stored); return;
    }
    if (!this.assertAuthority(stored)) return;
    const inbox = this.readWake(stored);
    if (routine.activeGoalId) {
      let goal: ProductGoal;
      try { goal = this.goals.get(routine.activeGoalId); }
      catch { this.block(stored, "The active goal record is unavailable. Routine progression stopped to avoid duplicate work."); return; }
      if (goal.status === "running") { routine.status = "running"; this.save(stored); return; }
      const cyclesSettled = goal.cycles.every(cycle => ["merged", "no-change"].includes(cycle.status));
      const safelySettled = !goal.activeTeamId && cyclesSettled && (allowedSettled.has(goal.status) || (goal.status === "ready-for-review" && goal.cycles.length > 0));
      if (safelySettled) {
        const ended = routine.occurrences.find(value => value.goalId === routine.activeGoalId);
        if (ended && !ended.endedAt) ended.endedAt = now();
        routine.activeGoalId = undefined; routine.reason = undefined;
        if (routine.occurrences.length >= routine.maxOccurrences) routine.status = "completed";
        else { routine.status = "running"; routine.nextRunAt = new Date(Date.now() + routine.intervalMinutes * minute).toISOString(); }
        routine.revision++;
        this.save(stored); return;
      }
      const reason = goal.status === "ready-for-review"
        ? "The previous goal has unmerged work awaiting review or delivery. Routine progression is stopped to avoid duplicate work on a stale base."
        : allowedSettled.has(goal.status) && !cyclesSettled
          ? "The previous goal has unmerged work awaiting review or delivery. Routine progression is stopped to avoid duplicate work on a stale base."
        : `The previous goal stopped with status ${goal.status}${goal.reason ? `: ${goal.reason}` : "."} Routine progression stopped; no replacement goal was started.`;
      this.block(stored, reason); return;
    }
    if (stored.launch) {
      await this.queues.enqueue(`project:${routine.goal.projectId}`, () => this.replayLaunch(stored));
      return;
    }
    if (routine.occurrences.length >= routine.maxOccurrences) { routine.status = "completed"; routine.revision++; routine.reason = undefined; this.save(stored); return; }
    if (inbox === "behind") return;
    if (current < Date.parse(routine.nextRunAt) && !(inbox === "current" && this.wakeDue(routine, current))) return;
    if (current < Date.parse(routine.startsAt)) return;
    const budgetMinutes = routine.goal.maxTotalMinutes ?? routine.goal.maxMinutes;
    if (current + budgetMinutes * minute > Date.parse(routine.expiresAt)) {
      routine.status = "expired"; routine.revision++; routine.reason = "The remaining approval window cannot fit the full goal time budget."; this.save(stored); return;
    }
    const fuse = applyFuseReason(routine, this.fuse?.check({ projectId: routine.goal.projectId }));
    if (fuse.changed) this.save(stored);
    if (fuse.wait) return;
    await this.queues.enqueue(`project:${routine.goal.projectId}`, async () => {
      if (this.closed || terminal.has(routine.status)) return;
      if (await this.hooks.isProjectBusy(routine.goal.projectId)) {
        routine.status = "scheduled"; routine.reason = "The project has active work. The routine will check again at its next interval."; routine.nextRunAt = new Date(Date.now() + routine.intervalMinutes * minute).toISOString();
        if (routine.pendingWake) routine.wakeDeferred = true;
        this.save(stored); return;
      }
      if (this.closed || terminal.has(routine.status)) return;
      if (Date.now() >= Date.parse(routine.expiresAt)) {
        routine.status = "expired"; routine.revision++; routine.reason = "The routine approval expired; no further goals will start."; this.save(stored); return;
      }
      if (Date.now() + budgetMinutes * minute > Date.parse(routine.expiresAt)) {
        routine.status = "expired"; routine.revision++; routine.reason = "The remaining approval window cannot fit the full goal time budget."; this.save(stored); return;
      }
      if (!this.assertAuthority(stored)) return;
      const latest = this.readWake(stored);
      if (latest === "behind") return;
      if (latest !== "current" && current < Date.parse(routine.nextRunAt)) return;
      const pending = latest === "current" ? routine.pendingWake : undefined;
      const request = createGoalSchema.parse({ requestId: randomUUID(), ...routine.goal });
      const wake = pending ? { signalIds: pending.signals.map(signal => signal.id), dropped: pending.dropped } : undefined;
      stored.launch = { request, createdAt: now(), ...(wake ? { wake } : {}) };
      routine.status = "running"; routine.reason = undefined; routine.revision++;
      this.save(stored);
      await this.replayLaunch(stored);
    });
  }
  private async replayLaunch(stored: Stored) {
    if (this.closed || !stored.launch) return;
    let existing: ProductGoal | undefined;
    try { existing = this.goals.get(stored.launch.request.requestId); }
    catch (error) {
      if (!(error instanceof TeamError) || error.code !== "goal-not-found") throw error;
    }
    if (existing) { this.recordLaunchReceipt(stored, existing); return; }
    if (!this.assertAuthority(stored)) return;
    const budgetMinutes = stored.routine.goal.maxTotalMinutes ?? stored.routine.goal.maxMinutes;
    if (Date.now() >= Date.parse(stored.routine.expiresAt) || Date.now() + budgetMinutes * minute > Date.parse(stored.routine.expiresAt)) {
      stored.routine.status = "expired";
      stored.routine.reason = "The approval window ended before this pending goal could be confirmed. Its request remains recorded for reconciliation.";
      stored.routine.revision++; this.save(stored); return;
    }
    if (!existing) { stored.launch.attempted = true; this.save(stored); }
    try {
      const goal = await this.hooks.startGoal(structuredClone(stored.launch.request), () => {
        if (this.closed) throw new TeamError(409, "routine-closed", "The routine service is closing and cannot admit a new goal.");
        if (!this.assertAuthority(stored)) throw new TeamError(409, "routine-authority-changed", stored.routine.reason ?? "The routine approval policy changed.");
        const budgetMinutes = stored.routine.goal.maxTotalMinutes ?? stored.routine.goal.maxMinutes;
        if (Date.now() >= Date.parse(stored.routine.expiresAt) || Date.now() + budgetMinutes * minute > Date.parse(stored.routine.expiresAt))
          throw new TeamError(409, "routine-window-expired", "The remaining approval window cannot fit the full goal time budget.");
      });
      if (this.closed) return;
      this.recordLaunchReceipt(stored, goal);
    } catch (error) {
      if (this.closed) return;
      if (error instanceof TeamError && (error.code === "routine-project-busy" || error.code === "routine-starting")) {
        if (stored.routine.pendingWake || stored.launch.wake) stored.routine.wakeDeferred = true;
        stored.launch = undefined;
        stored.routine.status = "scheduled";
        stored.routine.reason = "The project has active work. The routine will check again at its next interval.";
        stored.routine.nextRunAt = new Date(Date.now() + stored.routine.intervalMinutes * minute).toISOString();
        stored.routine.revision++;
        this.save(stored);
        return;
      }
      const reason = error instanceof TeamError ? error.message : "The goal launch result is uncertain. Recovery will reuse the same request ID; no replacement goal will start.";
      this.block(stored, reason);
    }
  }
  private recordLaunchReceipt(stored: Stored, goal: ProductGoal) {
    if (!stored.launch) return;
    if (!stored.routine.occurrences.some(value => value.goalId === goal.id)) {
      stored.routine.occurrences.push({ goalId: goal.id, startedAt: stored.launch.createdAt, ...(stored.launch.wake ? { wake: stored.launch.wake } : {}) });
    }
    stored.routine.activeGoalId = goal.id;
    if (!["paused", "cancelled", "blocked", "expired"].includes(stored.routine.status)) { stored.routine.status = "running"; stored.routine.reason = undefined; }
    stored.routine.nextRunAt = new Date(Date.parse(stored.launch.createdAt) + stored.routine.intervalMinutes * minute).toISOString();
    if (stored.launch.wake && stored.routine.pendingWake) {
      const consumed = new Set(stored.launch.wake.signalIds);
      const remaining = stored.routine.pendingWake.signals.filter(signal => !consumed.has(signal.id));
      const dropped = Math.max(0, stored.routine.pendingWake.dropped - stored.launch.wake.dropped);
      if (remaining.length > 0 || dropped > 0) {
        stored.routine.pendingWake = { ...stored.routine.pendingWake, signals: remaining, dropped };
      } else {
        delete stored.routine.pendingWake;
      }
    }
    delete stored.routine.wakeDeferred;
    stored.launch = undefined; stored.routine.revision++; this.save(stored);
  }
  private async reconcileLaunch(stored: Stored) {
    if (this.closed || !stored.launch) return;
    try {
      const goal = this.goals.get(stored.launch.request.requestId);
      this.recordLaunchReceipt(stored, goal);
    } catch (error) {
      if (error instanceof TeamError && error.code === "goal-not-found") return;
      throw error;
    }
  }
}
