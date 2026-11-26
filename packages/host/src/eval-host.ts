import type express from "express";
import type { ChildProcess } from "node:child_process";
import { type EvidenceStore, evidenceDatabasePath } from "./evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceTx } from "./evidence/types.js";
import { evalBudgetSource, summarizeProjectBudgets, type EvalBudgetSource, type EvalUsageReader } from "./eval-budget.js";
import { TaskCapture } from "./eval-capture.js";
import { type Grader, type GraderProbe, launcherGrader, PROBE_FRESH_MS, stopGrader } from "./eval-grader.js";
import { applyDuplicateRule, GroupPass, rootOf, sweepGroups } from "./eval-groups.js";
import { launcherEvalIdentity, type EvalIdentity } from "./eval-identity.js";
import { ACTIVE_JOBS_SQL, EvalJobs, JOB_LIST_MAX, type EvalJobRow, type NextWork } from "./eval-jobs.js";
import { TrialJobs } from "./eval-trial-jobs.js";
import { ComparisonPass, reportFor } from "./eval-comparison.js";
import { readPriors } from "./eval-priors.js";
import { rotateHoldout } from "./eval-sets.js";
import { EVAL_TRIALS_MODULE, evalTrialsModule, trialsSince } from "./eval-trial-store.js";
import { TrialPump, type TrialTeams } from "./eval-trial-pump.js";
import { JudgeCalibrations } from "./judge-calibration-jobs.js";
import { JUDGE_MODULE, judgeCalibrationsModule } from "./judge-store.js";
import { judgeRoutes } from "./judge-routes.js";
import { mineGit, type MineGit } from "./eval-mine-git.js";
import { Miner } from "./eval-miner.js";
import { evalRoutes } from "./eval-routes.js";
import { retireTask, runGroupId } from "./eval-store.js";
import { evalSummary, SUMMARY_JOBS } from "./eval-summary.js";
import {
  EVAL_MODULE,
  type BaselineJobRequest,
  type ComparisonJobRequest,
  type ComparisonReport,
  type EvalHostApi,
  type EvalJobView,
  type EvalRefusal,
  type EvalSummary,
  type GraderState,
  type ReplayPrior,
  type ValidateJobRequest,
} from "./eval-types.js";
import { type BundleState, type TaskValidation, type ValidateContext, validateTask } from "./eval-validate.js";
import type { FuseGate } from "./fuse/types.js";
import type { HaltService } from "./halt/service.js";
import type { HostLoadGate } from "./host-load.js";
import type { Manager } from "./manager.js";
import type { CostLookup } from "./outcome-cells.js";
import { spawnTeamBundle } from "./team-workspace.js";
import { inventoryRuntimeProcesses, type RuntimeProcess } from "./team-retirement.js";
import type { ProjectSourceService, ProjectSourceStatus } from "./project-source.js";
import type { TeamRun } from "./team-types.js";
import type { Config } from "./types.js";

export const TICK_MS = 60_000, SWEEP_MS = 3_600_000;
const TERMINAL = new Set(["completed", "cancelled", "expired"]);

export type EvalHostOptions = {
  config: Config;
  store: EvidenceStore;
  source: Pick<ProjectSourceService, "mirrorPath" | "status">;
  hostLoad: Pick<HostLoadGate, "held">;
  halt: () => Pick<HaltService, "check">;
  runs: () => readonly TeamRun[];
  grader?: Grader;
  mineGit?: MineGit;
  inventory?: () => Promise<RuntimeProcess[]>;
  now?: () => string;
  teams?: () => TrialTeams;
  sessions?: Pick<Manager, "list" | "remove">;
  identity?: EvalIdentity;
  cost?: CostLookup;
  usage?: () => EvalUsageReader;
  fuse?: () => Pick<FuseGate, "check">;
};

type Probed = { at: number; probe: GraderProbe };
type Work = Extract<NextWork, { kind: "task" }>;

export class EvalHost implements EvalHostApi {
  readonly capture: TaskCapture;
  private readonly store: EvidenceStore;
  private readonly config: Config;
  private readonly source: EvalHostOptions["source"];
  private readonly hostLoad: EvalHostOptions["hostLoad"];
  private readonly halt: EvalHostOptions["halt"];
  private readonly grader: Grader;
  private readonly git: MineGit;
  private readonly inventory: () => Promise<RuntimeProcess[]>;
  private readonly now: () => string;
  private readonly budget: EvalBudgetSource | undefined;
  private readonly groups: GroupPass;
  private readonly miner: Miner;
  private readonly evalJobs: EvalJobs;
  private readonly trialJobs: TrialJobs;
  private readonly comparison: ComparisonPass;
  private readonly judgements: JudgeCalibrations;
  private readonly trials: TrialPump | undefined;
  private readonly bundle: BundleState = { spawn: () => { throw new Error("No bundle is set."); }, job: null, sha256: null, restreamedFor: null, tooLarge: null };
  private probed: Probed | undefined;
  private validation: Promise<void> | undefined;
  private cleaned = false;
  private cooldown = 0;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(options: EvalHostOptions) {
    this.store = options.store;
    this.config = options.config;
    this.source = options.source;
    this.hostLoad = options.hostLoad;
    this.halt = options.halt;
    this.now = options.now ?? (() => new Date().toISOString());
    this.grader = options.grader ?? launcherGrader(() => this.config.eval?.grader);
    this.git = options.mineGit ?? mineGit(() => this.config.teams?.commandPrefix);
    this.inventory = options.inventory ?? inventoryRuntimeProcesses;
    this.capture = new TaskCapture({
      config: this.config,
      store: this.store,
      source: this.source,
      onPromoted: (tx, task) => applyDuplicateRule(tx, rootOf(tx, task.groupId ?? runGroupId(task.runId)), this.now()),
    });
    this.groups = new GroupPass({ store: this.store, runs: options.runs, now: this.now });
    this.miner = new Miner({ config: this.config, store: this.store, source: this.source, git: this.git, runs: options.runs, now: this.now });
    this.store.register(evalTrialsModule(this.store, this.now));
    this.store.register(judgeCalibrationsModule(this.store, this.now));
    this.budget = evalBudgetSource({ usage: options.usage, fuse: options.fuse });
    this.judgements = new JudgeCalibrations({ store: this.store, config: this.config, now: this.now, budget: this.budget });
    this.trialJobs = new TrialJobs({ store: this.store, config: this.config, now: this.now, budget: this.budget });
    this.comparison = new ComparisonPass({ store: this.store, config: this.config, now: this.now });
    this.evalJobs = new EvalJobs({
      store: this.store, config: this.config, now: this.now,
      baseline: { views: (db, rows) => this.trialViews(db, rows), digest: (projectId, jobId) => this.trialJobs.digest(projectId, jobId) },
    });
    const identity = options.identity ?? launcherEvalIdentity(() => this.config.eval?.member);
    this.trials = options.teams && options.sessions ? new TrialPump({
      config: this.config, store: this.store, jobs: this.trialJobs,
      grader: this.grader, identity, teams: options.teams, sessions: options.sessions, source: this.source, hostLoad: this.hostLoad,
      halt: this.halt, graderProbe: () => this.grader.probe(this.canaries()).catch((): GraderProbe => ({ state: "unavailable" })),
      inventory: this.inventory, now: this.now, cost: options.cost, judgements: this.judgements,
    }) : undefined;
  }

  start(): void {
    this.sweep();
    this.tick();
    this.timers = [setInterval(() => this.tick(), TICK_MS), setInterval(() => this.sweep(), SWEEP_MS)];
    for (const timer of this.timers) timer.unref();
  }

  tick(): void {
    if (this.closed) return;
    try { this.capture.reconcile(); } catch {}
    try { this.groups.run(); } catch {}
    try { this.miner.pump(); } catch {}
    try { this.validate(); } catch {}
    try { this.comparison.step(); } catch {}
    void this.trials?.watch();
  }

  sweep(): void {
    try { this.capture.sweep(); } catch {}
    try { this.store.tryWrite(tx => { sweepGroups(tx); }); } catch {}
    try { this.evalJobs.sweep(); } catch {}
    try { if (this.ready()) this.store.tryWrite(tx => { rotateHoldout(tx, this.now()); }); } catch {}
    if (this.trials === undefined) try { if (this.judgeReady()) this.judgements.sweep(); } catch {}
    void this.trials?.sweep();
  }

  routes(app: express.Express, readGuard: express.RequestHandler, ownerGuard: express.RequestHandler): void {
    evalRoutes(app, { host: this }, readGuard, ownerGuard);
    judgeRoutes(app, { judgements: this.judgements, ready: () => this.judgeReady() }, readGuard, ownerGuard);
  }

  async idle(): Promise<void> {
    await this.capture.idle();
    await this.miner.idle();
    await this.validation;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.capture.close();
    this.miner.close();
  }

  async summary(projectId: string): Promise<EvalSummary | EvalRefusal> {
    const project = this.config.projects.find(item => item.id === projectId);
    if (project === undefined) return refusal(404, "unknown-project");
    if (!this.ready() || !this.trialsReady()) return refusal(503, "evidence-unavailable");
    const grader = await this.graderState();
    const at = this.now();
    const day = `${at.slice(0, 10)}T00:00:00.000Z`;
    const identity = this.trials?.identityStatus() ?? { state: "not-configured" as const };
    const budgets = summarizeProjectBudgets(project.team?.eval?.providerBudgets, this.config.usage?.budgets, this.budget, new Date(at));
    return this.guard(() => evalSummary(this.store, {
      project,
      mining: this.miner.status(projectId),
      grader,
      graderVersion: this.probed?.probe.version ?? null,
      evalIdentity: identity.state,
      evalIdentityLastProbe: identity.lastProbe,
      trials: {
        today: this.trialsToday(projectId, day),
        dailyCap: project.team?.eval?.trialsPerDay ?? null,
        ...(budgets.length > 0 ? { budgets } : {}),
      },
      jobs: this.evalJobs.projectJobs(projectId, SUMMARY_JOBS),
      now: at,
    }));
  }

  jobs(): EvalJobView[] | EvalRefusal {
    return this.guard(() => this.evalJobs.list());
  }

  job(jobId: string): EvalJobView | EvalRefusal {
    return this.guard(() => this.evalJobs.view(jobId) ?? refusal(404, "unknown-job"));
  }

  create(projectId: string, request: ValidateJobRequest | BaselineJobRequest | ComparisonJobRequest, requestId: string): { created: boolean; job: EvalJobView } | EvalRefusal {
    if (request.kind !== "validate" && !this.trialsReady()) return refusal(503, "evidence-unavailable");
    return this.guard(() => request.kind === "validate" ? this.evalJobs.create(projectId, request, requestId)
      : this.trialJobs.create(projectId, request, requestId));
  }

  control(jobId: string, action: "pause" | "resume" | "cancel"): EvalJobView | EvalRefusal {
    return this.guard(() => this.evalJobs.control(jobId, action));
  }

  retire(taskId: string): { taskId: string; state: "retired" } | EvalRefusal {
    return this.guard(() => this.store.write((tx: EvidenceTx) => {
      const row = tx.get<{ state: string }>("SELECT state FROM eval_tasks WHERE task_id = ?", taskId);
      if (row === undefined) return refusal(404, "unknown-task");
      if (row.state !== "candidate" && row.state !== "valid") return refusal(409, "task-not-active");
      retireTask(tx, taskId, "owner-retired", this.now());
      return { taskId, state: "retired" as const };
    }));
  }

  report(jobId: string): ComparisonReport | EvalRefusal {
    if (!this.ready() || !this.trialsReady()) return refusal(503, "evidence-unavailable");
    return this.guard(() => this.store.read(db => reportFor(db, jobId)));
  }

  priors(projectId: string): { projectId: string; priors: ReplayPrior[] } | EvalRefusal {
    if (!this.ready() || !this.trialsReady()) return refusal(503, "evidence-unavailable");
    const project = this.config.projects.find(item => item.id === projectId);
    if (project === undefined) return refusal(404, "unknown-project");
    return this.guard(() => ({ projectId, priors: this.store.read(db => readPriors(db, project)) }));
  }

  private validate(): void {
    if (this.closed || this.validation !== undefined) return;
    const run: Promise<void> = this.step()
      .catch(() => undefined)
      .finally(() => {
        if (this.validation === run) this.validation = undefined;
      });
    this.validation = run;
  }

  private trialsToday(projectId: string, day: string): number {
    try { return this.store.read(db => trialsSince(db, projectId, day)); } catch { return 0; }
  }

  private async step(): Promise<void> {
    try {
      await this.validateStep();
    } finally {
      await this.trials?.step();
    }
  }

  private async validateStep(): Promise<void> {
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    if (!this.ready()) return;
    const gate = await this.gate();
    if (!this.cleaned && gate.state === "ready") {
      if (!(await this.startupClean(gate.uid ?? -1))) return;
      this.cleaned = true;
    }
    const work = this.evalJobs.next({ grader: gate, hostLoadHeld: this.loadHeld(), halted: projectId => this.halted(projectId) });
    if (work.kind !== "task") {
      await this.retireFinished();
      return;
    }
    await this.runTask(work);
  }

  private async runTask(work: Work): Promise<void> {
    const { jobId, projectId, taskId, settings } = work;
    const fresh = await this.probeNow();
    if (fresh.state !== "ready") return this.environment(jobId, taskId, "grader-failed");
    if (fresh.storage !== true) return this.environment(jobId, taskId, "storage");
    let mirror: string;
    let status: ProjectSourceStatus;
    try {
      mirror = this.source.mirrorPath(projectId);
      status = this.source.status(projectId);
    } catch {
      return this.environment(jobId, taskId, "anchor-unknown");
    }
    const source = this.config.projects.find(project => project.id === projectId)?.source;
    const branch = source?.mode === "github" ? source.baseBranch : undefined;
    if (status.mirrorHead === undefined || branch === undefined) return this.environment(jobId, taskId, "anchor-unknown");
    const prefix = this.config.teams?.commandPrefix;
    this.bundle.spawn = (): ChildProcess => spawnTeamBundle(mirror, branch, prefix);
    const ctx: ValidateContext = {
      jobId, projectId, settings, grader: this.grader, graderRoot: this.config.eval?.grader?.root ?? "", uid: fresh.uid ?? -1,
      mirror, mirrorHead: status.mirrorHead, git: this.git, halted: () => this.closed || this.halted(projectId),
      inventory: this.inventory, now: this.now, bundle: this.bundle,
    };
    let outcome: TaskValidation;
    try {
      outcome = await validateTask(this.store, taskId, ctx);
    } catch {
      outcome = { kind: "environment", cause: "grader-failed" };
    }
    this.record(jobId, taskId, outcome);
    if (outcome.kind === "environment") this.cooldown = 1;
  }

  private environment(jobId: string, taskId: string, cause: "grader-failed" | "anchor-unknown" | "storage"): void {
    this.record(jobId, taskId, { kind: "environment", cause });
    this.cooldown = 1;
  }

  private record(jobId: string, taskId: string, outcome: TaskValidation): void {
    try {
      this.evalJobs.record(jobId, taskId, outcome);
    } catch {
    }
  }

  private async retireFinished(): Promise<void> {
    const job = this.bundle.job;
    if (job === null) return;
    const view = this.evalJobs.view(job);
    if (view !== undefined && !TERMINAL.has(view.status)) return;
    if (!(await this.grader.remove(job))) return;
    this.bundle.job = null;
    this.bundle.sha256 = null;
  }

  private async gate(): Promise<GraderProbe> {
    if (this.probed !== undefined && this.probed.probe.state === "ready" && Date.now() - this.probed.at < PROBE_FRESH_MS) return this.probed.probe;
    return this.probeNow();
  }

  private async probeNow(): Promise<GraderProbe> {
    let probe: GraderProbe;
    try {
      probe = await this.grader.probe(this.canaries());
    } catch {
      probe = { state: "unavailable" };
    }
    this.probed = { at: Date.now(), probe };
    return probe;
  }

  private async graderState(): Promise<GraderState> {
    if (this.probed !== undefined && Date.now() - this.probed.at < PROBE_FRESH_MS) return this.probed.probe.state;
    if (this.validation !== undefined) return this.probed?.probe.state ?? "unavailable";
    return (await this.probeNow()).state;
  }

  private canaries(): string[] {
    const workspace = this.config.teams?.workspaceDir;
    const mirrors = this.config.projects.filter(project => project.source?.mode === "github").map(project => this.source.mirrorPath(project.id));
    return [
      evidenceDatabasePath(this.config.stateDir),
      this.config.keyFile,
      this.config.stateDir,
      this.config.runDir,
      ...(this.config.socketDir ? [this.config.socketDir] : []),
      ...(workspace === undefined ? [] : [workspace]),
      ...mirrors,
    ];
  }

  private async startupClean(uid: number): Promise<boolean> {
    if ((await stopGrader(this.grader, uid, this.inventory)) !== "stopped") return false;
    let running: { job_id: string }[];
    try {
      running = this.store.read(db => db.all<{ job_id: string }>(ACTIVE_JOBS_SQL, "running", JOB_LIST_MAX));
    } catch {
      return false;
    }
    for (const job of running) {
      if (!(await this.grader.clean(job.job_id))) return false;
    }
    return true;
  }

  private halted(projectId: string): boolean {
    try {
      return this.halt().check({ projectId }).state !== "clear";
    } catch {
      return true;
    }
  }

  private loadHeld(): boolean {
    try {
      return this.hostLoad.held() !== undefined;
    } catch {
      return true;
    }
  }

  private ready(): boolean {
    try {
      return this.store.status().modules[EVAL_MODULE] === "ready";
    } catch {
      return false;
    }
  }

  private trialViews(db: EvidenceDb, rows: readonly EvalJobRow[]): Map<string, EvalJobView> {
    if (rows.length > 0 && !this.trialsReady()) throw new EvidenceError("unavailable", "The trials module is not ready.");
    return this.trialJobs.views(db, rows);
  }

  private judgeReady(): boolean {
    try {
      return this.ready() && this.trialsReady() && this.store.status().modules[JUDGE_MODULE] === "ready";
    } catch {
      return false;
    }
  }

  private trialsReady(): boolean {
    try {
      return this.store.status().modules[EVAL_TRIALS_MODULE] === "ready";
    } catch {
      return false;
    }
  }

  private guard<T>(fn: () => T): T | EvalRefusal {
    if (!this.ready()) return refusal(503, "evidence-unavailable");
    try {
      return fn();
    } catch (error) {
      if (error instanceof EvidenceError && error.code === "unavailable") return refusal(503, "evidence-unavailable");
      throw error;
    }
  }
}

function refusal(status: EvalRefusal["status"], code: EvalRefusal["code"]): EvalRefusal {
  return { status, code };
}
