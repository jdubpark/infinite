import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { writeSealed, unseal } from "./vault.js";
import { TeamError } from "./teams.js";
import type { Config, Project } from "./types.js";
import { createGoalSchema, type CreateGoal, type ProductGoal } from "./goal-types.js";
import { createRoutineSchema, routineActionSchema, type CreateRoutine, type Routine, type RoutineAction } from "./routine-types.js";
import type { GoalService } from "./goals.js";
import { applyFuseReason } from "./fuse/rules.js";
import type { FuseGate } from "./fuse/types.js";

type HookSet = {
  isProjectBusy(projectId: string): Promise<boolean>;
  startGoal(request: CreateGoal, admit: () => void): Promise<ProductGoal>;
};
type LaunchIntent = { request: CreateGoal; createdAt: string; attempted?: boolean };
type Stored = {
  routine: Routine;
  fingerprint: string;
  authority: string;
  receipts: Record<string, string>;
  launch?: LaunchIntent;
};
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = new Set<Routine["status"]>(["completed", "cancelled", "expired"]);
const allowedSettled = new Set(["no-opportunity", "achieved"]);
const maxRecords = 1000;
const maxApprovalMs = 30 * 24 * 60 * 60 * 1000;
const minute = 60_000;

/** Owner-approved finite schedules. Every occurrence still enters GoalService's full approval pipeline. */
export class RoutineService {
  private readonly records = new Map<string, Stored>();
  private readonly saved = new Map<string, string>();
  private readonly directory: string;
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private tickQueued = false;
  private fuse?: FuseGate;

  constructor(private readonly config: Config, private readonly key: Buffer, private readonly goals: GoalService, private readonly hooks: HookSet) {
    this.directory = join(config.stateDir, "routines");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `routine:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.routine.id !== id || stored.routine.occurrences.length > stored.routine.maxOccurrences) throw new TeamError(409, "invalid-routine-record", "A routine record cannot be authenticated.");
      // An in-flight call may have reached GoalService before the host stopped. Replay the same idempotent request after restart.
      if (stored.launch?.attempted) stored.launch.attempted = false;
      this.records.set(id, stored); this.saved.set(id, digest(stored));
      if (stored.launch?.attempted === false) this.save(stored);
    }
  }
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task); this.serial = next.catch(() => {}); return next;
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
      project: { path: canonicalPath, team: project.team, teamworkDir: project.teamworkDir, source: project.source, linear: project.linear },
      teams: this.config.teams,
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
  /** The launch-rate fuse. A service without one starts every goal it would have started before. */
  useFuse(fuse: FuseGate) { this.fuse = fuse; }
  create(input: CreateRoutine): Promise<Routine> {
    const request = createRoutineSchema.parse(input);
    return this.enqueue(() => {
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
    return this.enqueue(() => {
      const stored = this.record(id), routine = stored.routine;
      if (this.replay(stored, action, body)) return this.view(stored);
      if (body.revision !== routine.revision) throw new TeamError(409, "stale-routine-revision", "The routine changed. Refresh it before sending this action.");
      if (terminal.has(routine.status)) throw new TeamError(409, "routine-stopped", "This routine has stopped and cannot be changed.");
      if (action === "pause" && routine.status === "paused") throw new TeamError(409, "routine-not-running", "This routine is already paused.");
      if (action === "resume" && routine.status !== "paused" && routine.status !== "blocked") throw new TeamError(409, "routine-not-paused", "Only a paused or blocked routine can resume.");
      if (action === "resume" && Date.now() >= Date.parse(routine.expiresAt)) throw new TeamError(409, "routine-expired", "This routine's approval has expired.");
      if (action === "resume" && !this.assertAuthority(stored)) throw new TeamError(409, "routine-authority-changed", routine.reason!);
      routine.revision++; stored.receipts[body.requestId] = digest({ action, ...body });
      if (action === "pause") { routine.status = "paused"; routine.reason = routine.activeGoalId ? "Future routine triggers are paused. The active goal retains its own controls and limits." : "Future routine triggers are paused."; }
      else if (action === "cancel") { routine.status = "cancelled"; routine.reason = routine.activeGoalId ? "Future routine triggers are cancelled. The active goal retains its own controls and limits." : "Future routine triggers are cancelled."; }
      else { routine.status = routine.occurrences.length ? "running" : "scheduled"; routine.reason = undefined; if (stored.launch) stored.launch.attempted = false; }
      this.save(stored); return this.view(stored);
    });
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
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
  tick() { return this.enqueue(async () => {
    for (const stored of this.records.values()) {
      if (this.closed) return;
      try { await this.step(stored); }
      catch (error) {
        if (this.closed) return;
        const reason = error instanceof TeamError ? error.message : "Routine state could not be reconciled. Review it before resuming.";
        this.block(stored, reason);
      }
    }
  }); }
  private block(stored: Stored, reason: string) {
    if (stored.routine.status !== "blocked" || stored.routine.reason !== reason) stored.routine.revision++;
    stored.routine.status = "blocked"; stored.routine.reason = reason;
    this.save(stored);
  }
  private async step(stored: Stored) {
    const routine = stored.routine;
    if (stored.launch && ["paused", "cancelled", "expired"].includes(routine.status)) {
      await this.reconcileLaunch(stored); return;
    }
    if (stored.launch && routine.status === "blocked") {
      if (stored.launch.attempted) await this.reconcileLaunch(stored);
      else await this.replayLaunch(stored);
      return;
    }
    if (terminal.has(routine.status) || routine.status === "paused" || (routine.status === "blocked" && (!stored.launch || stored.launch.attempted))) return;
    const current = Date.now();
    if (current >= Date.parse(routine.expiresAt)) {
      routine.status = "expired"; routine.revision++; routine.reason = "The routine approval expired; no further goals will start."; this.save(stored); return;
    }
    if (!this.assertAuthority(stored)) return;
    if (routine.activeGoalId) {
      let goal: ProductGoal;
      try { goal = this.goals.get(routine.activeGoalId); }
      catch { this.block(stored, "The active goal record is unavailable. Routine progression stopped to avoid duplicate work."); return; }
      if (goal.status === "running") { routine.status = "running"; this.save(stored); return; }
      const cyclesSettled = goal.cycles.every(cycle => ["merged", "no-change"].includes(cycle.status));
      const safelySettled = !goal.activeTeamId && cyclesSettled && (allowedSettled.has(goal.status) || (goal.status === "ready-for-review" && goal.cycles.length > 0));
      if (safelySettled) {
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
      // Recovery always replays the same persisted request ID and payload.
      await this.replayLaunch(stored); return;
    }
    if (routine.occurrences.length >= routine.maxOccurrences) { routine.status = "completed"; routine.revision++; routine.reason = undefined; this.save(stored); return; }
    if (current < Date.parse(routine.nextRunAt)) return;
    if (current < Date.parse(routine.startsAt)) return;
    const budgetMinutes = routine.goal.maxTotalMinutes ?? routine.goal.maxMinutes;
    if (current + budgetMinutes * minute > Date.parse(routine.expiresAt)) {
      routine.status = "expired"; routine.revision++; routine.reason = "The remaining approval window cannot fit the full goal time budget."; this.save(stored); return;
    }
    // A wait keeps the schedule: the first tick after the fuse closes starts one goal, and missed intervals coalesce.
    const fuse = applyFuseReason(routine, this.fuse?.check({ projectId: routine.goal.projectId }));
    if (fuse.changed) this.save(stored);
    if (fuse.wait) return;
    if (await this.hooks.isProjectBusy(routine.goal.projectId)) { routine.status = "scheduled"; routine.reason = "The project has active work. The routine will check again at its next interval."; routine.nextRunAt = new Date(current + routine.intervalMinutes * minute).toISOString(); this.save(stored); return; }
    if (this.closed || terminal.has(routine.status)) return;
    if (Date.now() >= Date.parse(routine.expiresAt)) {
      routine.status = "expired"; routine.revision++; routine.reason = "The routine approval expired; no further goals will start."; this.save(stored); return;
    }
    if (Date.now() + budgetMinutes * minute > Date.parse(routine.expiresAt)) {
      routine.status = "expired"; routine.revision++; routine.reason = "The remaining approval window cannot fit the full goal time budget."; this.save(stored); return;
    }
    if (!this.assertAuthority(stored)) return;
    const request = createGoalSchema.parse({ requestId: randomUUID(), ...routine.goal });
    stored.launch = { request, createdAt: now() };
    routine.status = "running"; routine.reason = undefined; routine.revision++;
    this.save(stored); // The exact request is durable before GoalService can accept it.
    await this.replayLaunch(stored);
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
      const reason = error instanceof TeamError ? error.message : "The goal launch result is uncertain. Recovery will reuse the same request ID; no replacement goal will start.";
      this.block(stored, reason);
    }
  }
  private recordLaunchReceipt(stored: Stored, goal: ProductGoal) {
    if (!stored.launch) return;
    if (!stored.routine.occurrences.some(value => value.goalId === goal.id)) stored.routine.occurrences.push({ goalId: goal.id, startedAt: stored.launch.createdAt });
    stored.routine.activeGoalId = goal.id;
    if (!["paused", "cancelled", "blocked", "expired"].includes(stored.routine.status)) { stored.routine.status = "running"; stored.routine.reason = undefined; }
    stored.routine.nextRunAt = new Date(Date.parse(stored.launch.createdAt) + stored.routine.intervalMinutes * minute).toISOString();
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
