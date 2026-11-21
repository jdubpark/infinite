import { randomUUID } from "node:crypto";
import { evalProxyUrl } from "./egress.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { Grader, GraderProbe } from "./eval-grader.js";
import { type EvalIdentity, type EvalProbe, evalCanaries, repositoryUrl, stopEvalIdentity } from "./eval-identity.js";
import { EVAL_MODULE, type CapturedPayload, type MinedPayload, type TrialEnding, type TrialConfiguration, type TrialGrade } from "./eval-types.js";
import type { EvalIdentityState } from "./eval-types.js";
import { type NextTrial, type TrialGates, type TrialJobs } from "./eval-trial-jobs.js";
import { type TrialSettings } from "./eval-config.js";
import { gradeOf, TRIAL_HARNESS_VERSION } from "./eval-trial-rules.js";
import {
  clearTrialSession, dropTrial, EVAL_TRIALS_MODULE, finishTrial, gradingTrial, insertTrial, liveTrials, readTrial, startTrial, sweepTrials,
  TRIAL_KEEP_DAYS_DEFAULT, TRIAL_PATCH_KEEP_DAYS, trialSessions,
} from "./eval-trial-store.js";
import { gradeTrial, prepareTrialSource, type SourceResult, type TrialContext } from "./eval-trial.js";
import { loadTask, type BundleState, type ValidateContext } from "./eval-validate.js";
import type { HaltService } from "./halt/service.js";
import type { HostLoadGate } from "./host-load.js";
import type { Manager } from "./manager.js";
import { readOutcome } from "./outcome-store.js";
import { outcomeId } from "./outcome-projector.js";
import type { ProjectSourceService } from "./project-source.js";
import { inventoryRuntimeProcesses, type RuntimeProcess } from "./team-retirement.js";
import type { ReplayState } from "./team-replay.js";
import type { TeamService } from "./teams.js";
import type { TeamModelProfile } from "./team-types.js";
import { spawnTeamBundle } from "./team-workspace.js";
import type { Config, Provider } from "./types.js";

// The trial pump: one trial at a time, host-wide. It starts a trial when the job's gates pass, follows the live trial
// through its replay run, stops the eval account, grades the result, and cleans the account. A restart voids the trial
// it was running. Nothing here throws: a failed step leaves its rows for the next one.

export const EVAL_STOPPING_MS = 120_000, TRIAL_LAUNCH_MS = 900_000, TRIAL_SESSION_KEEP_MS = 3_600_000, TRIAL_SESSIONS_BATCH = 20,
  EVAL_LIMIT_UNSTATED_MS = 900_000, EVAL_LIMIT_MAX_MS = 86_400_000;
const IDENTITY_FRESH_MS = 600_000, STOP_TRIES = 3;

export type TrialTeams = Pick<TeamService, "createForReplay" | "replayState" | "endReplay" | "forgetReplay" | "replayIds" | "providerLimits">;
export type TrialPumpOptions = {
  config: Config; store: EvidenceStore; jobs: TrialJobs; grader: Grader; identity: EvalIdentity;
  teams: () => TrialTeams; sessions: Pick<Manager, "list" | "remove">; source: Pick<ProjectSourceService, "mirrorPath" | "status">;
  hostLoad: Pick<HostLoadGate, "held">; halt: () => Pick<HaltService, "check">;
  graderProbe: () => Promise<GraderProbe>; inventory?: () => Promise<RuntimeProcess[]>; now?: () => string;
};

type ReadyTrial = Extract<SourceResult, { kind: "ready" }>;
type Trial = Extract<NextTrial, { kind: "trial" }>;
/** The trial the pump holds in memory. A restart never sees it: start-up voids every trial row instead. */
type Live = {
  trialId: string; jobId: string; taskId: string; projectId: string; configuration: TrialConfiguration; settings: TrialSettings;
  source: ReadyTrial; ctx: TrialContext; launchedAt: number; endedSeenAt?: number;
  /** The last session the run reported, kept for a run that is later lost. */
  sessionId?: string;
  /** Stops that failed so far; the third voids the trial. */
  stopFailures?: number;
};
type Stop = "stopped" | "alive" | "failed";

/** The git ancestry check of ValidateContext. A trial never asks it, so a call is a bug and says so. */
const NO_ANCESTRY = { isAncestor: () => Promise.reject(new Error("Trials do not check ancestry.")) } as unknown as ValidateContext["git"];

export class TrialPump {
  private readonly options: TrialPumpOptions;
  private readonly now: () => string;
  private readonly inventory: () => Promise<RuntimeProcess[]>;
  /** The bundle state of this pump; the validation pump keeps its own. */
  private readonly bundle: BundleState = { spawn: () => { throw new Error("No bundle is set."); }, job: null, sha256: null, restreamedFor: null, tooLarge: null };
  private readonly limits = new Map<Provider, number>();
  private started = false;
  /** True once this process tried the start-up. */
  private attempted = false;
  /** True while the account may hold what this process left: voided rows, or a failed stop or clean. */
  private dirty = false;
  private live: Live | undefined;
  private probed: { at: number; probe: EvalProbe; projectId: string | undefined } | undefined;
  /** Steps to skip before the next trial start, after a source that could not start. */
  private cooldown = 0;

  constructor(options: TrialPumpOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
    this.inventory = options.inventory ?? inventoryRuntimeProcesses;
  }

  /** One step: start-up once, then advance the live trial or start one. Never throws. */
  async step(): Promise<void> {
    try {
      await this.advance();
    } catch {
      // A failed step leaves its rows for the next step.
    }
  }

  /**
   * The checks of a running member, outside the chain: a cancelled job or halted project, the member's time, the launch limit,
   * and a task that no longer opens. It never stops the account, grades, cleans, or starts a trial. Never throws.
   */
  async watch(): Promise<void> {
    try {
      const live = this.live;
      if (live === undefined) return;
      const state = await this.options.teams().replayState(live.trialId);
      if (state === undefined || this.live !== live) return;
      this.seen(live, state);
      if (state.phase === "running") await this.checkRunning(live, state);
    } catch {
      // A failed check is repeated on the next tick.
    }
  }

  /** Hourly: sweepTrials, forgetReplay for final trials whose run remains, and sessions.remove for at most 20 sessions ended over an hour ago. */
  async sweep(): Promise<void> {
    try {
      if (!this.ready()) return;
      const at = this.now();
      this.options.store.tryWrite(tx => { sweepTrials(tx, at); });
      const teams = this.options.teams();
      for (const trialId of teams.replayIds()) {
        try {
          if (this.options.store.read(db => readTrial(db, trialId))?.state === "final") await teams.forgetReplay(trialId);
        } catch {
          // One unreadable row or failed removal leaves that run for the next sweep.
        }
      }
      const endedBefore = new Date(Date.parse(at) - TRIAL_SESSION_KEEP_MS).toISOString();
      const ended = this.options.store.read(db => trialSessions(db, endedBefore, TRIAL_SESSIONS_BATCH));
      for (const { trialId, sessionId } of ended) {
        try {
          try {
            await this.options.sessions.remove(sessionId);
          } catch (error) {
            // A session that is already gone needs no removal; any other refusal keeps the row for the next sweep.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
          }
          this.options.store.write(tx => clearTrialSession(tx, trialId));
        } catch {
          // One failed row leaves the others to their removal.
        }
      }
    } catch {
      // The sweep never throws.
    }
  }

  /** The last probe when it is at most 10 minutes old; `unavailable` before any probe. */
  identityState(): EvalIdentityState {
    if (this.options.config.eval?.member === undefined) return "not-configured";
    if (this.probed !== undefined && Date.now() - this.probed.at <= IDENTITY_FRESH_MS) return this.probed.probe.state;
    return "unavailable";
  }

  private async advance(): Promise<void> {
    if (!this.ready()) return;
    if (!this.started && !(await this.startup())) return;
    if (this.live !== undefined) return this.advanceLive(this.live);
    const open = this.openJob();
    if (open === undefined) return;
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    const grader = await this.graderState();
    const identity = await this.identityProbe(grader.uid, open.projectId);
    const next = await this.options.jobs.next(this.gates(identity, grader));
    if (next.kind === "trial") await this.begin(next, identity, grader);
  }

  /** Once per process, before any trial: drops the preparing rows, voids the running ones, and stops, cleans, and resets the account. */
  private async startup(): Promise<boolean> {
    const rows = this.options.store.read(db => liveTrials(db));
    // The first attempt of a process always runs. Later attempts wait for a job unless this process has something to clean.
    const open = this.openJob();
    if (this.attempted && !this.dirty && rows.length === 0 && open === undefined) return false;
    this.attempted = true;
    if (rows.length > 0) this.dirty = true;
    const at = this.now();
    for (const row of rows) {
      if (row.state === "preparing") {
        this.options.store.write(tx => dropTrial(tx, row.trialId));
        continue;
      }
      // The run's session is read before the run ends, so the sweep can remove it later.
      const session = await this.options.teams().replayState(row.trialId).then(state => state?.sessionId, () => undefined);
      await this.options.teams().endReplay(row.trialId, "void-host").catch(() => undefined);
      this.options.store.write(tx => finishTrial(tx, row.trialId, this.final(gradeOf({ ending: "void-host", expected: this.expectedOf(row.taskId),
        overwritten: 0, diff: null, isolation: "none" }), null, null, session ?? null), at));
      this.options.jobs.record(row.jobId, "void-host");
    }
    const identity = await this.identityProbe(undefined, open?.projectId);
    // An identity that is configured but cannot be probed has not been cleaned: start-up runs again on the next step.
    if (identity.state === "unavailable" || identity.state === "misconfigured") return false;
    if (identity.state !== "not-configured") {
      const stopped = await stopEvalIdentity(this.options.identity, identity.uid ?? -1, this.inventory);
      // A process that stays alive blocks the open job, so the wait is visible and ends when the owner resumes it.
      if (stopped === "alive" && open !== undefined) this.options.jobs.block(open.jobId, "eval-processes-alive");
      if (stopped !== "stopped") return false;
      if (!(await this.cleanAndScrub())) return false;
      for (const jobId of this.options.jobs.running()) {
        if (!(await this.options.grader.clean(jobId))) return false;
      }
    }
    this.started = true;
    this.dirty = false;
    return true;
  }

  /** The live trial, one step: the run's state decides whether it runs on, ends, or grades. */
  private async advanceLive(live: Live): Promise<void> {
    const teams = this.options.teams();
    const state = await teams.replayState(live.trialId);
    if (state !== undefined) this.seen(live, state);
    if (state === undefined) {
      // The run was deleted while its member ran: the trial voids at once.
      return this.close(live, "void-host", undefined, await this.stop(live));
    }
    if (state.phase === "running") return this.advanceRunning(live, state);
    if (!state.sessionExited) {
      live.endedSeenAt ??= Date.now();
      if (Date.now() - live.endedSeenAt < EVAL_STOPPING_MS) return;
    }
    const stopped = await this.stop(live);
    // A stop that failed is tried again on the next steps; the third failure voids the trial.
    if (stopped === "failed" && (live.stopFailures = (live.stopFailures ?? 0) + 1) < STOP_TRIES) return;
    if (stopped !== "stopped") {
      if (state.ending === "void-limit") this.limit(live.configuration.profile.provider, state.resetsAt);
      return this.close(live, "void-host", state, stopped);
    }
    if (state.ending === "settled") return this.grade(live, state);
    return this.close(live, state.ending ?? "void-host", state, stopped);
  }

  private seen(live: Live, state: ReplayState): void {
    if (state.sessionId !== undefined) live.sessionId = state.sessionId;
  }

  private async advanceRunning(live: Live, state: ReplayState): Promise<void> {
    await this.checkRunning(live, state);
  }

  /** The checks of a running member; `advanceLive` and `watch` share them. */
  private async checkRunning(live: Live, state: ReplayState): Promise<void> {
    const teams = this.options.teams();
    if (this.jobStatus(live.jobId) === "cancelled" || this.halted(live.projectId)) {
      await teams.endReplay(live.trialId, "void-owner");
      return;
    }
    // A task that no longer opens (its row was removed or retired) has nothing to grade: its run ends void-host.
    if (loadTask(this.options.store, live.taskId).kind !== "task") {
      await teams.endReplay(live.trialId, "void-host");
      return;
    }
    if (state.memberStartedAt !== undefined) {
      if (Date.now() - Date.parse(state.memberStartedAt) > live.settings.trialMinutes * 60_000) await teams.endReplay(live.trialId, "timeout");
      return;
    }
    if (Date.now() - live.launchedAt > TRIAL_LAUNCH_MS) await teams.endReplay(live.trialId, "void-host");
  }

  /** The trial's grading: the grader builds the grading commit and runs the focused test, then the trial is final. */
  private async grade(live: Live, state: ReplayState): Promise<void> {
    const flagged = this.options.store.write(tx => gradingTrial(tx, live.trialId, this.now()));
    if (!flagged) {
      // A row already in `grading` was left by a step that failed: the trial closes void-host instead of being forgotten.
      const row = this.options.store.read(db => readTrial(db, live.trialId));
      if (row?.state === "grading") return this.close(live, "void-host", state, "stopped");
      this.live = undefined;
      return;
    }
    let result: Awaited<ReturnType<typeof gradeTrial>>;
    try {
      result = await gradeTrial(this.options.store, {
        taskId: live.taskId, baseCommit: live.source.baseCommit, resultCommit: state.resultCommit, workspace: live.source.workspace,
        hiddenFiles: live.source.hiddenFiles, isolation: live.source.isolation,
      }, live.ctx);
    } catch {
      // The account is already stopped; a grading that threw leaves nothing to grade.
      return this.close(live, "void-host", state, "stopped");
    }
    if (result.kind === "environment") return this.close(live, result.cause === "halted" ? "void-owner" : "void-host", state, "stopped");
    try {
      const configured = this.configOf(live.trialId, state);
      const at = this.now();
      this.options.store.write(tx => finishTrial(tx, live.trialId, this.final(result.grade, configured.configId, configured.profileEpoch,
        state.sessionId ?? live.sessionId ?? null, result.patch), at));
    } catch {
      return this.close(live, "void-host", state, "stopped");
    }
    await this.afterFinal(live, result.grade.ending, state);
  }

  /** Ends a trial with `ending`: the stopped account, the final row, the clean, the record, and the run's removal. */
  private async close(live: Live, ending: TrialEnding, state: ReplayState | undefined, stopped: Stop): Promise<void> {
    if (stopped === "alive") this.options.jobs.block(live.jobId, "eval-processes-alive");
    if (stopped !== "stopped") {
      this.started = false;
      this.dirty = true;
    }
    const at = this.now();
    const grade = gradeOf({ ending, expected: this.expectedOf(live.taskId), overwritten: 0, diff: null, isolation: live.source.isolation });
    this.options.store.write(tx => finishTrial(tx, live.trialId, this.final(grade, null, null, state?.sessionId ?? live.sessionId ?? null), at));
    await this.afterFinal(live, ending, state);
  }

  /** The steps after a trial's row is final: the clean, the record, the run's removal, and the provider limit. */
  private async afterFinal(live: Live, ending: TrialEnding, state: ReplayState | undefined): Promise<void> {
    if (!(await this.cleanAndScrub())) {
      this.started = false;
      this.dirty = true;
    }
    this.options.jobs.record(live.jobId, ending);
    await this.options.teams().forgetReplay(live.trialId).catch(() => false);
    if (ending === "void-limit") this.limit(live.configuration.profile.provider, state?.resetsAt);
    this.live = undefined;
  }

  /** Starts a trial: the row, its source, the run, and the live state. A source that cannot start ends or waits here. */
  private async begin(next: Trial, identity: EvalProbe, grader: GraderProbe): Promise<void> {
    const trialId = randomUUID();
    const inserted = this.options.store.write(tx => insertTrial(tx, {
      trialId, jobId: next.jobId, taskId: next.taskId, configRef: next.configRef, harness: TRIAL_HARNESS_VERSION, slot: next.slot,
      attempt: next.attempt, projectId: next.projectId, configuration: next.configuration, keepDays: TRIAL_KEEP_DAYS_DEFAULT,
    }, this.now()));
    if (inserted !== "inserted") return;
    const ctx = this.contextOf(next, trialId, identity, grader);
    if (ctx === undefined) {
      this.options.store.write(tx => dropTrial(tx, trialId));
      this.cooldown = 1;
      return;
    }
    let source: SourceResult;
    try {
      source = await prepareTrialSource(this.options.store, next.taskId, ctx);
    } catch {
      source = { kind: "environment", cause: "grader-failed" };
    }
    if (source.kind === "skip") {
      this.options.store.write(tx => dropTrial(tx, trialId));
      this.options.jobs.skip(next.jobId, next.taskId);
      return;
    }
    if (source.kind === "environment") {
      this.cooldown = 1;
      this.options.store.write(tx => dropTrial(tx, trialId));
      if (source.cause === "eval-processes-alive" || source.cause === "grader-processes-alive") this.options.jobs.block(next.jobId, "eval-processes-alive");
      return;
    }
    this.options.store.write(tx => startTrial(tx, trialId, this.now()));
    const live: Live = { trialId, jobId: next.jobId, taskId: next.taskId, projectId: next.projectId, configuration: next.configuration,
      settings: next.settings, source, ctx, launchedAt: Date.now() };
    this.live = live;
    try {
      await this.options.teams().createForReplay({ trialId, jobId: next.jobId, purpose: "replay", projectId: next.projectId,
        profile: next.configuration.profile as TeamModelProfile, capsule: source.capsule, features: source.features,
        baseCommit: source.baseCommit, workspace: source.workspace });
    } catch {
      // No member was launched, but a run may exist: it ends void-host, then the trial does, and the account is cleaned.
      try {
        await this.options.teams().endReplay(trialId, "void-host");
      } catch {
        // A run that cannot end is left to the sweep.
      }
      await this.close(live, "void-host", undefined, "stopped");
    }
  }

  private contextOf(next: Trial, trialId: string, identity: EvalProbe, grader: GraderProbe): TrialContext | undefined {
    const { config, source } = this.options;
    try {
      const project = config.projects.find(item => item.id === next.projectId);
      const branch = project?.source?.mode === "github" ? project.source.baseBranch : undefined;
      const status = source.status(next.projectId);
      const mirror = source.mirrorPath(next.projectId);
      if (status.mirrorHead === undefined || branch === undefined) return undefined;
      const prefix = config.teams?.commandPrefix;
      this.bundle.spawn = () => spawnTeamBundle(mirror, branch, prefix);
      return {
        jobId: next.jobId, projectId: next.projectId, settings: next.settings, grader: this.options.grader,
        graderRoot: config.eval?.grader?.root ?? "", uid: grader.uid ?? -1, mirror, mirrorHead: status.mirrorHead, git: NO_ANCESTRY,
        halted: () => this.halted(next.projectId), inventory: this.inventory, now: this.now, bundle: this.bundle,
        trialId, identity: this.options.identity, evalUid: identity.uid ?? -1, probe: identity, root: config.eval?.member?.root ?? "",
      };
    } catch {
      return undefined;
    }
  }

  /** Stops the eval account, as the trial's probe named its uid. */
  private async stop(live: Live): Promise<Stop> {
    return stopEvalIdentity(this.options.identity, live.ctx.evalUid, this.inventory);
  }

  private async cleanAndScrub(): Promise<boolean> {
    if (!(await this.options.identity.clean())) return false;
    return this.options.identity.scrub();
  }

  private limit(provider: Provider, resetsAt: string | undefined): void {
    const now = Date.parse(this.now());
    const stated = resetsAt === undefined ? NaN : Date.parse(resetsAt);
    const until = Number.isFinite(stated) && stated > now ? Math.min(stated, now + EVAL_LIMIT_MAX_MS) : now + EVAL_LIMIT_UNSTATED_MS;
    this.limits.set(provider, until);
  }

  private gates(identity: EvalProbe, grader: GraderProbe): TrialGates {
    const limited = new Set<Provider>();
    const now = Date.parse(this.now());
    for (const [provider, until] of this.limits) if (until > now) limited.add(provider);
    try {
      for (const item of this.options.teams().providerLimits()) limited.add(item.provider);
    } catch {
      // A failed read of the limit memory leaves the limits this pump holds.
    }
    return {
      identity, grader, hostLoadHeld: this.loadHeld(), halted: projectId => this.halted(projectId), limited,
      freeSlots: async () => {
        const rows = await this.options.sessions.list();
        const busy = rows.filter(row => row.status === "running" || row.status === "starting").length;
        return this.options.config.maxSessions - busy;
      },
      trialLive: this.live !== undefined,
    };
  }

  /** The cached identity probe while it answered `ready` within the freshness window; otherwise a probe now. */
  private async identityProbe(graderUid: number | undefined, projectId: string | undefined): Promise<EvalProbe> {
    // The probe names the project's repository, so a probe made for another project, or none, is not reused.
    if (this.probed !== undefined && this.probed.projectId === projectId && this.probed.probe.state === "ready"
      && Date.now() - this.probed.at < IDENTITY_FRESH_MS) return this.probed.probe;
    const { config, source, identity } = this.options;
    let probe: EvalProbe;
    try {
      const project = projectId === undefined ? undefined : config.projects.find(item => item.id === projectId);
      const repository = project?.source?.mode === "github" ? project.source.repository : undefined;
      probe = await identity.probe({
        canaries: evalCanaries(config, source),
        ...(graderUid === undefined ? {} : { graderUid }),
        ...(project !== undefined && repository !== undefined ? { fetchUrl: repositoryUrl(config, project.id, repository) } : {}),
        proxyUrl: evalProxyUrl("_eval", "probe", 60),
      });
    } catch {
      probe = { state: "unavailable" };
    }
    this.probed = { at: Date.now(), probe, projectId };
    return probe;
  }

  private async graderState(): Promise<GraderProbe> {
    try {
      return await this.options.graderProbe();
    } catch {
      return { state: "unavailable" };
    }
  }

  private halted(projectId: string): boolean {
    try {
      return this.options.halt().check({ projectId }).state !== "clear";
    } catch {
      return true;
    }
  }

  private loadHeld(): boolean {
    try {
      return this.options.hostLoad.held() !== undefined;
    } catch {
      return true;
    }
  }

  /** The oldest scheduled or running baseline job, with its project when the project still exists; undefined when no job is open. */
  private openJob(): { jobId: string; projectId: string | undefined } | undefined {
    try {
      return this.options.store.read(db => {
        const row = db.get<{ job_id: string; project_ref: string }>(
          "SELECT job_id, project_ref FROM eval_jobs WHERE kind = 'baseline' AND status IN ('scheduled', 'running') ORDER BY created_at, job_id LIMIT 1");
        if (row === undefined) return undefined;
        const project = this.options.config.projects.find(item => db.index("project", item.id) === row.project_ref);
        return { jobId: row.job_id, projectId: project?.id };
      });
    } catch {
      return undefined;
    }
  }

  private jobStatus(jobId: string): string | undefined {
    try {
      return this.options.store.read(db => db.get<{ status: string }>("SELECT status FROM eval_jobs WHERE job_id = ?", jobId)?.status);
    } catch {
      return undefined;
    }
  }

  /** The task's expected cases, or none when the task no longer opens. */
  private expectedOf(taskId: string): string[] {
    try {
      const loaded = loadTask(this.options.store, taskId);
      if (loaded.kind !== "task") return [];
      const payload = loaded.task.payload as CapturedPayload | MinedPayload;
      return payload.expectedCases ?? [];
    } catch {
      return [];
    }
  }

  /** The configuration and epoch of the member's outcome row; both null when the row has no configuration. */
  private configOf(trialId: string, state: ReplayState): { configId: string | null; profileEpoch: number | null } {
    if (state.memberId === undefined) return { configId: null, profileEpoch: null };
    try {
      const row = this.options.store.read(db => readOutcome(db, outcomeId(trialId, state.memberId!)));
      if (row?.configId) return { configId: row.configId, profileEpoch: row.profileEpoch };
    } catch {
      // An unreadable outcome leaves the configuration unknown.
    }
    return { configId: null, profileEpoch: null };
  }

  private final(grade: TrialGrade, configId: string | null, profileEpoch: number | null, sessionId: string | null,
    patch?: Buffer | "too-large" | "secret-shaped"): { grade: TrialGrade; configId: string | null; profileEpoch: number | null;
      sessionId: string | null; patchKeepDays: number; patch?: Buffer | "too-large" | "secret-shaped" } {
    return { grade, configId, profileEpoch, sessionId, patchKeepDays: TRIAL_PATCH_KEEP_DAYS, ...(patch === undefined ? {} : { patch }) };
  }

  private ready(): boolean {
    try {
      const modules = this.options.store.status().modules;
      return modules[EVAL_MODULE] === "ready" && modules[EVAL_TRIALS_MODULE] === "ready";
    } catch {
      return false;
    }
  }
}

