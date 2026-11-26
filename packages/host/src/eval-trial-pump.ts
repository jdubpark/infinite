import { randomUUID } from "node:crypto";
import { evalProxyUrl } from "./egress.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { Grader, GraderProbe } from "./eval-grader.js";
import { type EvalIdentity, type EvalProbe, evalCanaries, repositoryUrl, stopEvalIdentity } from "./eval-identity.js";
import { EVAL_MODULE, TRIAL_ENDINGS, type EvalJobWait, type CapturedPayload, type MinedPayload, type TrialEnding, type TrialConfiguration, type TrialGrade } from "./eval-types.js";
import type { EvalIdentityState } from "./eval-types.js";
import { type NextTrial, type TrialGates, type TrialJobs } from "./eval-trial-jobs.js";
import { trialSettings, type TrialSettings } from "./eval-config.js";
import { readTrialPatch } from "./eval-calibration.js";
import { gradeOf, TRIAL_HARNESS_VERSION } from "./eval-trial-rules.js";
import {
  clearTrialSession, dropTrial, EVAL_TRIALS_MODULE, finishTrial, gradingTrial, insertTrial, liveTrials, readTrial, startTrial, sweepTrials,
  TRIAL_KEEP_DAYS_DEFAULT, TRIAL_PATCH_KEEP_DAYS, trialSessions,
} from "./eval-trial-store.js";
import { gradeTrial, prepareTrialSource, type SourceResult, type TrialContext } from "./eval-trial.js";
import { loadTask, type BundleState, type ValidateContext } from "./eval-validate.js";
import type { HaltService } from "./halt/service.js";
import { graderJobOf, type JudgeCalibrations, type JudgementOutcome, type NextJudgement } from "./judge-calibration-jobs.js";
import { clearJudgementSession, judgeSessions, type JudgementCost } from "./judge-store.js";
import { judgePackage, judgeTaskOf, writeJudgePackage } from "./judge-package.js";
import { JUDGE_ENDINGS, type JudgeEnding } from "./judge-types.js";
import type { HostLoadGate } from "./host-load.js";
import type { Manager } from "./manager.js";
import type { CostLookup, SessionCost } from "./outcome-cells.js";
import { readOutcome } from "./outcome-store.js";
import { outcomeId } from "./outcome-projector.js";
import type { ProjectSourceService } from "./project-source.js";
import { inventoryRuntimeProcesses, type RuntimeProcess } from "./team-retirement.js";
import { replayWorkspace, type ReplayState } from "./team-replay.js";
import type { TeamService } from "./teams.js";
import type { TeamModelProfile } from "./team-types.js";
import { spawnTeamBundle } from "./team-workspace.js";
import type { Config, Provider } from "./types.js";

export const EVAL_STOPPING_MS = 120_000, TRIAL_LAUNCH_MS = 900_000, TRIAL_SESSION_KEEP_MS = 3_600_000, TRIAL_SESSIONS_BATCH = 20,
  EVAL_LIMIT_UNSTATED_MS = 900_000, TRIAL_COST_WAIT_MS = 86_400_000, EVAL_LIMIT_MAX_MS = 86_400_000;
const IDENTITY_FRESH_MS = 600_000, STOP_TRIES = 3;

export type TrialTeams = Pick<TeamService, "createForReplay" | "replayState" | "endReplay" | "forgetReplay" | "replayIds" | "providerLimits">;
export type TrialPumpOptions = {
  config: Config; store: EvidenceStore; jobs: TrialJobs; grader: Grader; identity: EvalIdentity;
  teams: () => TrialTeams; sessions: Pick<Manager, "list" | "remove">; source: Pick<ProjectSourceService, "mirrorPath" | "status">;
  hostLoad: Pick<HostLoadGate, "held">; halt: () => Pick<HaltService, "check">;
  cost?: CostLookup;
  graderProbe: () => Promise<GraderProbe>; inventory?: () => Promise<RuntimeProcess[]>; now?: () => string;
  judgements?: JudgeCalibrations;
  prepareSource?: typeof prepareTrialSource;
};

type ReadyTrial = Extract<SourceResult, { kind: "ready" }>;
type Trial = Extract<NextTrial, { kind: "trial" }>;
type JudgementStart = Extract<NextJudgement, { kind: "start" }>;
type TrialLive = {
  kind: "trial"; trialId: string; jobId: string; taskId: string; projectId: string; configuration: TrialConfiguration; settings: TrialSettings;
  source: ReadyTrial; ctx: TrialContext; launchedAt: number; endedSeenAt?: number;
  sessionId?: string;
  stopFailures?: number;
};
type JudgementLive = {
  kind: "judgement"; judgementId: string; calibrationId: string; projectId: string; provider: Provider; judgeMinutes: number;
  ctx: TrialContext; launchedAt: number; endedSeenAt?: number; sessionId?: string; stopFailures?: number;
};
type Live = TrialLive | JudgementLive;
type Stop = "stopped" | "alive" | "failed";

function waitOf(cause: Exclude<Extract<SourceResult, { kind: "environment" }>["cause"], "eval-processes-alive" | "grader-processes-alive">): EvalJobWait {
  switch (cause) {
    case "halted": return "halt";
    case "storage": return "storage";
    case "grader-failed": return "grader-failed";
    case "eval-failed": return "eval-failed";
    case "bundle-missing": return "bundle-missing";
  }
}

const NO_ANCESTRY = { isAncestor: () => Promise.reject(new Error("Trials do not check ancestry.")) } as unknown as ValidateContext["git"];

export class TrialPump {
  private readonly options: TrialPumpOptions;
  private readonly now: () => string;
  private readonly inventory: () => Promise<RuntimeProcess[]>;
  private readonly bundle: BundleState = { spawn: () => { throw new Error("No bundle is set."); }, job: null, sha256: null, restreamedFor: null, tooLarge: null };
  private readonly limits = new Map<Provider, number>();
  private started = false;
  private attempted = false;
  private dirty = false;
  private live: Live | undefined;
  private lastStart: "trial" | "judgement" | undefined;
  private probed: { at: number; probe: EvalProbe; projectId: string | undefined } | undefined;
  private cooldown = 0;

  constructor(options: TrialPumpOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
    this.inventory = options.inventory ?? inventoryRuntimeProcesses;
  }

  async step(): Promise<void> {
    try {
      await this.advance();
    } catch {
    }
  }

  async watch(): Promise<void> {
    try {
      const live = this.live;
      if (live === undefined) return;
      const state = await this.options.teams().replayState(live.kind === "trial" ? live.trialId : live.judgementId);
      if (state === undefined || this.live !== live) return;
      this.seen(live, state);
      if (state.phase !== "running") return;
      if (live.kind === "trial") await this.checkRunning(live, state);
      else await this.checkJudging(live, state);
    } catch {
    }
  }

  async sweep(): Promise<void> {
    try {
      if (!this.ready()) return;
      const at = this.now();
      this.options.store.tryWrite(tx => { sweepTrials(tx, at); });
      try {
        this.options.jobs.expireIdle();
      } catch {
      }
      const teams = this.options.teams();
      for (const trialId of teams.replayIds()) {
        try {
          if (this.forgettable(trialId)) await teams.forgetReplay(trialId);
        } catch {
        }
      }
      const endedBefore = new Date(Date.parse(at) - TRIAL_SESSION_KEEP_MS).toISOString();
      const ended = this.options.store.read(db => trialSessions(db, endedBefore, TRIAL_SESSIONS_BATCH));
      for (const { trialId, sessionId, endedAt } of ended) {
        try {
          const cost = this.costOf(sessionId, endedAt, at);
          if (cost === "wait") continue;
          try {
            await this.options.sessions.remove(sessionId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
          }
          this.options.store.write(tx => clearTrialSession(tx, trialId, cost));
        } catch {
        }
      }
      await this.sweepJudgements(endedBefore, at);
    } catch {
    }
  }

  private forgettable(id: string): boolean {
    if (this.options.store.read(db => readTrial(db, id))?.state === "final") return true;
    if (this.options.judgements === undefined) return false;
    const judgement = this.options.store.read(db => db.get<{ state: string }>("SELECT state FROM judge_judgements WHERE judgement_id = ?", id));
    return judgement?.state === "final" || judgement?.state === "dropped";
  }

  private async sweepJudgements(endedBefore: string, at: string): Promise<void> {
    const judgements = this.options.judgements;
    if (judgements === undefined) return;
    try {
      const ended = this.options.store.read(db => judgeSessions(db, endedBefore, TRIAL_SESSIONS_BATCH));
      for (const { judgementId, sessionId, endedAt } of ended) {
        try {
          const cost = this.costOf(sessionId, endedAt, at);
          if (cost === "wait") continue;
          try {
            await this.options.sessions.remove(sessionId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
          }
          const recorded: JudgementCost | undefined = cost === undefined || cost === "none" ? cost : { tokens: cost.tokens, usd: cost.usd, complete: cost.complete };
          this.options.store.write(tx => clearJudgementSession(tx, judgementId, recorded));
        } catch {
        }
      }
    } catch {
    }
    try {
      judgements.sweep();
    } catch {
    }
  }

  private costOf(sessionId: string, endedAt: string, at: string): SessionCost | "none" | "wait" | undefined {
    const lookup = this.options.cost;
    if (lookup === undefined) return undefined;
    try {
      return lookup(sessionId) ?? "none";
    } catch {
      return Date.parse(at) - Date.parse(endedAt) >= TRIAL_COST_WAIT_MS ? "none" : "wait";
    }
  }

  identityState(): EvalIdentityState {
    if (this.options.config.eval?.member === undefined) return "not-configured";
    if (this.probed !== undefined && Date.now() - this.probed.at <= IDENTITY_FRESH_MS) return this.probed.probe.state;
    return "unavailable";
  }

  identityStatus(): { state: EvalIdentityState; lastProbe?: { state: EvalIdentityState; at: string } | null } {
    const state = this.identityState();
    if (state !== "unavailable") return { state };
    if (this.probed === undefined) return { state, lastProbe: null };
    return { state, lastProbe: { state: this.probed.probe.state, at: new Date(this.probed.at).toISOString() } };
  }

  private async advance(): Promise<void> {
    if (!this.ready()) return;
    if (!this.started && !(await this.startup())) {
      this.options.judgements?.hold("start-up");
      return;
    }
    if (this.live !== undefined) {
      if (this.live.kind === "trial") this.options.judgements?.hold("another-job");
      return this.advanceLive(this.live);
    }
    const open = this.openJob();
    const judging = this.judging();
    if (open === undefined && !judging) return;
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    for (const turn of this.turns(open !== undefined, judging)) {
      if (turn === "trial" ? await this.trialTurn(open) : await this.judgementTurn()) {
        this.lastStart = turn;
        return;
      }
    }
  }

  private turns(trialJobOpen: boolean, judging: boolean): ("trial" | "judgement")[] {
    if (!trialJobOpen) return ["judgement"];
    if (!judging) return ["trial"];
    return this.lastStart === "trial" ? ["judgement", "trial"] : ["trial", "judgement"];
  }

  private async trialTurn(open: { projectId: string | undefined } | undefined): Promise<boolean> {
    if (open === undefined) return false;
    const grader = await this.graderState();
    const identity = await this.identityProbe(grader.uid, open.projectId);
    const next = await this.options.jobs.next(this.gates(identity, grader));
    if (next.kind !== "trial") return false;
    await this.begin(next, identity, grader);
    return true;
  }

  private async startup(): Promise<boolean> {
    const rows = this.options.store.read(db => liveTrials(db));
    const judged = this.liveJudgements();
    const open = this.openJob();
    if (this.attempted && !this.dirty && rows.length === 0 && judged.length === 0 && open === undefined && !this.judging()) return false;
    this.attempted = true;
    if (rows.length > 0 || judged.length > 0) this.dirty = true;
    const at = this.now();
    for (const row of rows) {
      if (row.state === "preparing") {
        this.options.store.write(tx => dropTrial(tx, row.trialId));
        continue;
      }
      const session = await this.options.teams().replayState(row.trialId).then(state => state?.sessionId, () => undefined);
      await this.options.teams().endReplay(row.trialId, "void-host").catch(() => undefined);
      this.voidHost(row.trialId, row.jobId, row.taskId, at, session ?? null);
    }
    for (const { judgementId } of judged) {
      const session = await this.options.teams().replayState(judgementId).then(state => state?.sessionId, () => undefined);
      await this.options.teams().endReplay(judgementId, "void-host").catch(() => undefined);
      try {
        this.options.judgements?.finish(judgementId, { ending: "void-host", sessionId: session ?? null });
      } catch {
      }
    }
    const identity = await this.identityProbe(undefined, open?.projectId);
    if (identity.state === "unavailable" || identity.state === "misconfigured") return false;
    if (identity.state !== "not-configured") {
      this.dirty = true;
      const stopped = await stopEvalIdentity(this.options.identity, identity.uid ?? -1, this.inventory);
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

  private voidHost(trialId: string, jobId: string, taskId: string, at: string, sessionId: string | null): void {
    const final = this.final(gradeOf({ ending: "void-host", expected: this.expectedOf(taskId), overwritten: 0, diff: null, isolation: "none" }), null, null, sessionId);
    this.options.store.write(tx => {
      startTrial(tx, trialId, at);
      finishTrial(tx, trialId, final, at);
    });
    this.options.jobs.record(jobId, "void-host");
  }

  private async advanceLive(live: Live): Promise<void> {
    return live.kind === "trial" ? this.advanceTrial(live) : this.advanceJudgement(live);
  }

  private async advanceTrial(live: TrialLive): Promise<void> {
    const teams = this.options.teams();
    const state = await teams.replayState(live.trialId);
    if (state !== undefined) this.seen(live, state);
    if (state === undefined) {
      return this.close(live, "void-host", undefined, await this.stop(live));
    }
    if (state.phase === "running") return this.advanceRunning(live, state);
    if (!state.sessionExited) {
      live.endedSeenAt ??= Date.now();
      if (Date.now() - live.endedSeenAt < EVAL_STOPPING_MS) return;
    }
    const stopped = await this.stop(live);
    if (stopped === "failed" && (live.stopFailures = (live.stopFailures ?? 0) + 1) < STOP_TRIES) return;
    if (stopped !== "stopped") {
      if (state.ending === "void-limit") this.limit(live.configuration.profile.provider, state.resetsAt);
      return this.close(live, "void-host", state, stopped);
    }
    if (state.ending === "settled") return this.grade(live, state);
    const ending = TRIAL_ENDINGS.find(name => name === state.ending);
    return this.close(live, ending ?? "void-host", state, stopped);
  }

  private seen(live: Live, state: ReplayState): void {
    if (state.sessionId !== undefined) live.sessionId = state.sessionId;
  }

  private async advanceRunning(live: TrialLive, state: ReplayState): Promise<void> {
    await this.checkRunning(live, state);
  }

  private async checkRunning(live: TrialLive, state: ReplayState): Promise<void> {
    const teams = this.options.teams();
    if (this.jobStatus(live.jobId) === "cancelled" || this.halted(live.projectId)) {
      await teams.endReplay(live.trialId, "void-owner");
      return;
    }
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

  private async grade(live: TrialLive, state: ReplayState): Promise<void> {
    const flagged = this.options.store.write(tx => gradingTrial(tx, live.trialId, this.now()));
    if (!flagged) {
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

  private async close(live: TrialLive, ending: TrialEnding, state: ReplayState | undefined, stopped: Stop): Promise<void> {
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

  private async afterFinal(live: TrialLive, ending: TrialEnding, state: ReplayState | undefined): Promise<void> {
    if (!(await this.cleanAndScrub())) {
      this.started = false;
      this.dirty = true;
    }
    this.options.jobs.record(live.jobId, ending);
    await this.options.teams().forgetReplay(live.trialId).catch(() => false);
    if (ending === "void-limit") this.limit(live.configuration.profile.provider, state?.resetsAt);
    this.live = undefined;
  }

  private release(next: Trial, trialId: string, waiting: EvalJobWait): void {
    this.cooldown = 1;
    if (this.options.jobs.release({ ...next, trialId }, waiting) === "released") return;
    this.voidHost(trialId, next.jobId, next.taskId, this.now(), null);
    this.options.jobs.skip(next.jobId, next.taskId);
  }

  private async begin(next: Trial, identity: EvalProbe, grader: GraderProbe): Promise<void> {
    const trialId = randomUUID();
    const inserted = this.options.store.write(tx => insertTrial(tx, {
      trialId, jobId: next.jobId, taskId: next.taskId, configRef: next.configRef, harness: TRIAL_HARNESS_VERSION, slot: next.slot,
      attempt: next.attempt, projectId: next.projectId, configuration: next.configuration, keepDays: TRIAL_KEEP_DAYS_DEFAULT,
    }, this.now()));
    if (inserted !== "inserted") return;
    const ctx = this.contextOf(next, next.settings, trialId, identity, grader);
    if (ctx === undefined) return this.release(next, trialId, "mirror");
    let source: SourceResult;
    try {
      source = await (this.options.prepareSource ?? prepareTrialSource)(this.options.store, next.taskId, ctx);
    } catch {
      source = { kind: "environment", cause: "grader-failed" };
    }
    if (source.kind === "skip") {
      this.options.store.write(tx => dropTrial(tx, trialId));
      this.options.jobs.skip(next.jobId, next.taskId);
      return;
    }
    if (source.kind === "environment") {
      if (source.cause === "eval-processes-alive" || source.cause === "grader-processes-alive") {
        this.cooldown = 1;
        this.options.store.write(tx => dropTrial(tx, trialId));
        this.options.jobs.block(next.jobId, "eval-processes-alive");
        return;
      }
      return this.release(next, trialId, waitOf(source.cause));
    }
    const launchWait = this.halted(next.projectId)
      ? "halt"
      : this.options.jobs.launchWait(next.projectId, next.configuration.profile.provider, next.settings, this.limitedProviders(), trialId);
    if (launchWait !== undefined) {
      await this.cleanAfterJudgement();
      return this.release(next, trialId, launchWait);
    }
    this.options.store.write(tx => startTrial(tx, trialId, this.now()));
    const live: TrialLive = { kind: "trial", trialId, jobId: next.jobId, taskId: next.taskId, projectId: next.projectId, configuration: next.configuration,
      settings: next.settings, source, ctx, launchedAt: Date.now() };
    this.live = live;
    try {
      await this.options.teams().createForReplay({ trialId, jobId: next.jobId, purpose: "replay", projectId: next.projectId,
        profile: next.configuration.profile as TeamModelProfile, capsule: source.capsule, features: source.features,
        baseCommit: source.baseCommit, workspace: source.workspace });
    } catch {
      try {
        await this.options.teams().endReplay(trialId, "void-host");
      } catch {
      }
      await this.close(live, "void-host", undefined, "stopped");
    }
  }

  private liveJudgements(): { judgementId: string }[] {
    try {
      return this.options.judgements?.live() ?? [];
    } catch {
      return [];
    }
  }

  private judging(): boolean {
    try {
      return (this.options.judgements?.running().length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private async judgementTurn(): Promise<boolean> {
    const judgements = this.options.judgements;
    if (judgements === undefined || !this.judging()) return false;
    const grader = await this.graderState();
    const gate = await this.identityProbe(grader.uid, this.probed?.projectId);
    const next = await judgements.next(this.gates(gate, grader));
    if (next.kind !== "start") return false;
    const identity = await this.identityProbe(grader.uid, next.projectId);
    if (identity.state !== "ready") {
      judgements.hold("eval-identity");
      return false;
    }
    await this.beginJudgement(next, identity, grader);
    return true;
  }

  private async beginJudgement(start: JudgementStart, identity: EvalProbe, grader: GraderProbe): Promise<void> {
    const judgements = this.options.judgements;
    if (judgements === undefined || this.live !== undefined) return;
    if (judgements.begin(start) !== "inserted") return;
    const id = start.judgementId;
    const dropped = (reason: Extract<JudgementOutcome, { dropped: string }>["dropped"]) => judgements.finish(id, { dropped: reason });
    try {
      const { resolved, unresolved } = this.options.store.read(db => ({
        resolved: readTrialPatch(db, start.resolvedTrialId), unresolved: readTrialPatch(db, start.unresolvedTrialId) }));
      if (resolved === undefined || unresolved === undefined) return dropped("patch-missing");
      const project = this.options.config.projects.find(item => item.id === start.projectId);
      const found = trialSettings(project, this.options.config.usage?.budgets);
      const graderJob = graderJobOf(start.calibrationId, start.projectId);
      if (!("settings" in found)) {
        this.cooldown = 1;
        return judgements.finish(id, { ending: "void-host", sessionId: null });
      }
      const ctx = this.contextOf({ projectId: start.projectId, jobId: graderJob }, found.settings, id, identity, grader);
      if (ctx === undefined) {
        this.cooldown = 1;
        return judgements.release(id, "mirror");
      }
      const source = await (this.options.prepareSource ?? prepareTrialSource)(this.options.store, start.taskId, ctx);
      if (source.kind === "skip") return dropped("source-skipped");
      if (source.kind === "environment") {
        this.cooldown = 1;
        if (source.cause === "eval-processes-alive" || source.cause === "grader-processes-alive") {
          this.dirty = true;
          this.started = false;
        }
        return judgements.release(id, source.cause === "halted" ? "halt" : source.cause);
      }
      const files = source.isolation === "isolated" ? judgePackage({
        a: { patch: start.resolvedIsA ? resolved : unresolved, gate: { scope: "pass", checks: "skipped" } },
        b: { patch: start.resolvedIsA ? unresolved : resolved, gate: { scope: "pass", checks: "skipped" } },
        task: judgeTaskOf(source.capsule),
      }) : undefined;
      if (files === undefined) {
        judgements.finish(id, { dropped: source.isolation === "isolated" ? "package-too-large" : "not-isolated" });
        return await this.cleanAfterJudgement();
      }
      try {
        await writeJudgePackage(replayWorkspace(`${ctx.root}/trials`, source.workspace), files, this.options.identity.teamPrefix());
      } catch {
        judgements.finish(id, { ending: "void-host", sessionId: null });
        return await this.cleanAfterJudgement();
      }
      const launchWait = this.halted(start.projectId)
        ? "halt"
        : judgements.launchWait(start.projectId, start.profile, this.limitedProviders());
      if (launchWait !== undefined) {
        this.cooldown = 1;
        await this.cleanAfterJudgement();
        return judgements.release(id, launchWait);
      }
      const live: JudgementLive = { kind: "judgement", judgementId: id, calibrationId: start.calibrationId, projectId: start.projectId,
        provider: start.profile.provider, judgeMinutes: start.judgeMinutes, ctx, launchedAt: Date.now() };
      this.live = live;
      try {
        await this.options.teams().createForReplay({ purpose: "duel", trialId: id, jobId: start.calibrationId, projectId: start.projectId,
          profile: start.profile, baseCommit: source.baseCommit, workspace: source.workspace, steering: [], ownerAnswers: [],
          judgeMinutes: start.judgeMinutes });
        judgements.launched(id, null);
      } catch {
        await this.options.teams().endReplay(id, "void-host").catch(() => undefined);
        await this.closeJudgement(live, "void-host", undefined, "stopped");
      }
    } catch {
      try {
        judgements.finish(id, { ending: "void-host", sessionId: null });
      } catch {
      }
      this.live = undefined;
      this.dirty = true;
      this.started = false;
    }
  }

  private async cleanAfterJudgement(): Promise<void> {
    if (!(await this.cleanAndScrub())) {
      this.started = false;
      this.dirty = true;
    }
  }

  private async advanceJudgement(live: JudgementLive): Promise<void> {
    const state = await this.options.teams().replayState(live.judgementId);
    if (state !== undefined) this.seen(live, state);
    if (state === undefined) return this.closeJudgement(live, "void-host", undefined, await this.stop(live));
    if (state.phase === "running") return this.checkJudging(live, state);
    if (!state.sessionExited) {
      live.endedSeenAt ??= Date.now();
      if (Date.now() - live.endedSeenAt < EVAL_STOPPING_MS) return;
    }
    const stopped = await this.stop(live);
    if (stopped === "failed" && (live.stopFailures = (live.stopFailures ?? 0) + 1) < STOP_TRIES) return;
    const ending = JUDGE_ENDINGS.find(name => name === state.ending) ?? "void-host";
    return this.closeJudgement(live, stopped === "stopped" ? ending : "void-host", state, stopped);
  }

  private async checkJudging(live: JudgementLive, state: ReplayState): Promise<void> {
    const teams = this.options.teams();
    if (!this.options.judgements?.running().includes(live.calibrationId) || this.halted(live.projectId)) {
      await teams.endReplay(live.judgementId, "void-owner");
      return;
    }
    if (state.memberStartedAt !== undefined) {
      if (Date.now() - Date.parse(state.memberStartedAt) > live.judgeMinutes * 60_000) await teams.endReplay(live.judgementId, "timeout");
      return;
    }
    if (Date.now() - live.launchedAt > TRIAL_LAUNCH_MS) await teams.endReplay(live.judgementId, "void-host");
  }

  private async closeJudgement(live: JudgementLive, ending: JudgeEnding, state: ReplayState | undefined, stopped: Stop): Promise<void> {
    if (stopped !== "stopped") {
      this.started = false;
      this.dirty = true;
    }
    const sessionId = state?.sessionId ?? live.sessionId ?? null;
    const judgement = ending === "judged" ? state?.judgement : undefined;
    const final: JudgeEnding = ending === "judged" && judgement === undefined ? "void-host" : ending;
    try {
      this.options.judgements?.finish(live.judgementId, { ending: final, sessionId, ...(judgement === undefined ? {} : { judgement }) });
    } catch {
      this.started = false;
      this.dirty = true;
    }
    await this.cleanAfterJudgement();
    await this.options.teams().forgetReplay(live.judgementId).catch(() => false);
    if (final === "void-limit") this.limit(live.provider, state?.resetsAt);
    this.live = undefined;
  }

  private contextOf(next: { projectId: string; jobId: string }, settings: TrialSettings, trialId: string, identity: EvalProbe,
    grader: GraderProbe): TrialContext | undefined {
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
        jobId: next.jobId, projectId: next.projectId, settings, grader: this.options.grader,
        graderRoot: config.eval?.grader?.root ?? "", uid: grader.uid ?? -1, mirror, mirrorHead: status.mirrorHead, git: NO_ANCESTRY,
        halted: () => this.halted(next.projectId), inventory: this.inventory, now: this.now, bundle: this.bundle,
        trialId, identity: this.options.identity, evalUid: identity.uid ?? -1, probe: identity, root: config.eval?.member?.root ?? "",
      };
    } catch {
      return undefined;
    }
  }

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

  private limitedProviders(): Set<Provider> {
    const limited = new Set<Provider>();
    const now = Date.parse(this.now());
    for (const [provider, until] of this.limits) if (until > now) limited.add(provider);
    try {
      for (const item of this.options.teams().providerLimits()) limited.add(item.provider);
    } catch {
    }
    return limited;
  }

  private gates(identity: EvalProbe, grader: GraderProbe): TrialGates {
    const limited = this.limitedProviders();
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

  private async identityProbe(graderUid: number | undefined, projectId: string | undefined): Promise<EvalProbe> {
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

  private openJob(): { jobId: string; projectId: string | undefined } | undefined {
    try {
      return this.options.store.read(db => {
        const row = db.get<{ job_id: string; project_ref: string }>(
          "SELECT job_id, project_ref FROM eval_jobs WHERE kind != 'validate' AND status IN ('scheduled', 'running') ORDER BY created_at, job_id LIMIT 1");
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

  private configOf(trialId: string, state: ReplayState): { configId: string | null; profileEpoch: number | null } {
    if (state.memberId === undefined) return { configId: null, profileEpoch: null };
    try {
      const row = this.options.store.read(db => readOutcome(db, outcomeId(trialId, state.memberId!)));
      if (row?.configId) return { configId: row.configId, profileEpoch: row.profileEpoch };
    } catch {
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

