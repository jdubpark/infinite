import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { promptVersion } from "./config-identity.js";
import { canonicalJson } from "./evidence/crypto.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { trialSettings, validationSettings, TRIAL_MINUTES_DEFAULT, type TrialSettings } from "./eval-config.js";
import type { GraderProbe } from "./eval-grader.js";
import type { EvalProbe } from "./eval-identity.js";
import { ACTIVE_PROJECT_JOBS_SQL, inWindow, JOB_EXPIRY_DAYS_MAX, JOB_TASKS_MAX, type EvalJobRow } from "./eval-jobs.js";
import { applyComparison, comparisonJobSchema, pinsChanged, planComparison } from "./eval-compare-jobs.js";
import { TRIAL_TASKS_SQL, type TrialTaskRow } from "./eval-sets.js";
import { configRef, nextSlot, TRIAL_RELEASES, VOID_STREAK_PAUSE } from "./eval-trial-rules.js";
import {
  advanceTask, dropTrial, jobSlots, jobTrialCount, openTrialCounts, trialCounts, trialsSince, TRIAL_KEEP_DAYS_DEFAULT, type TrialCounts,
} from "./eval-trial-store.js";
import {
  VOID_ENDINGS, type BaselineJobRequest, type BaselineJobView, type ComparisonJobRequest, type ComparisonJobView,
  type EvalJobReason, type EvalJobWait, type EvalRefusal, type TrialConfiguration, type TrialEnding, type TrialJobPayload,
} from "./eval-types.js";
import { lineupProfiles, type TeamModelProfile } from "./team-types.js";
import type { Config, Provider } from "./types.js";

// The baseline job: its schema, its creation, its views, and the one step that hands out the next trial of a job.

export const TRIAL_CONFIGURATIONS_MAX = 4, TRIALS_PER_TASK_DEFAULT = 3, TRIALS_PER_TASK_MAX = 5, TRIAL_TASKS_DEFAULT = 20,
  TRIAL_TASKS_MAX = 200, MAX_TRIALS_MAX = 1_000, TRIAL_SLOTS_FREE_MIN = 4, BASELINE_JOBS_MAX = 100;
/** The baseline jobs in one status, oldest first, through `eval_jobs_status`. */
export const BASELINE_JOBS_SQL = "SELECT * FROM eval_jobs WHERE status = ? AND kind != 'validate' ORDER BY created_at, job_id LIMIT ?";

/** Rows of NEXT_TASK_SQL per read. The statement's own LIMIT is 200. */
const TASK_PAGE = 200;
const TASK_ID_PATTERN = /^(captured|mined):[A-Za-z0-9:._-]{1,200}$/;
const AREA_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const DAY_MS = 86_400_000;

export type TrialGates = {
  identity: EvalProbe; grader: GraderProbe; hostLoadHeld: boolean; halted: (projectId: string) => boolean;
  limited: ReadonlySet<Provider>;     // TeamService.providerLimits() providers and the pump's eval limits
  freeSlots: () => Promise<number>; trialLive: boolean;
};
export type NextTrial =
  | { kind: "trial"; jobId: string; projectId: string; taskId: string; configuration: TrialConfiguration; configRef: string;
      slot: number; attempt: number; settings: TrialSettings }
  | { kind: "wait"; jobId: string; waiting: EvalJobWait } | { kind: "none" };

type JobRequest = BaselineJobRequest | ComparisonJobRequest;
type JobView = BaselineJobView | ComparisonJobView;
/** The column `reported_at` is not in `EvalJobRow`; `SELECT *` carries it. */
type ReportedRow = EvalJobRow & { reported_at?: string | null };
type CandidateRow = Pick<TrialTaskRow, "task_id" | "origin" | "area_ref" | "holdout">;
type Filter = { origins?: Set<string>; areas?: Set<string>; ids?: Set<string> };
type Project = Config["projects"][number];
/** `slots` asks the caller for the free session count, which is read outside the write. */
type Pass = NextTrial | { kind: "slots" };

/** Waits that hold a slot without counting: the project's preconditions and an owner's halt. */
const WAITS_ONLY: ReadonlySet<EvalJobWait> = new Set<EvalJobWait>(["mirror", "halt"]);

const NONE: NextTrial = { kind: "none" };
const EMPTY_COUNTS: TrialCounts = { plannedTasks: 0, plannedTrials: 0, tasks: 0, skipped: 0, started: 0, graded: 0, resolved: 0, ended: 0, void: 0, voidStreak: 0, reused: 0 };

const profileSchema = z.object({ provider: z.enum(["claude", "codex", "grok", "opencode", "demo"]) }).passthrough();
const configurationSchema = z.object({
  profile: profileSchema,
  guidance: z.literal("as-of-base"),
  knowledge: z.literal("none"),
}).strict();
const windowSchema = z.object({
  startHourUtc: z.number().int().min(0).max(23),
  endHourUtc: z.number().int().min(1).max(24),
}).strict().refine(window => window.endHourUtc !== window.startHourUtc, "a window must not be empty");

// A profile is admitted here by provider name only; `create` refuses any profile outside the pools, and any Grok or Demo profile.
export const baselineJobSchema = z.object({
  kind: z.literal("baseline"),
  configurations: z.array(configurationSchema).min(1).max(TRIAL_CONFIGURATIONS_MAX)
    .refine(list => new Set(list.map(item => configRef(item as unknown as TrialConfiguration))).size === list.length, "Two configurations name one configRef"),
  taskFilter: z.object({
    taskIds: z.array(z.string().regex(TASK_ID_PATTERN)).max(JOB_TASKS_MAX).optional(),
    origins: z.array(z.enum(["captured", "mined"])).max(2).optional(),
    areas: z.array(z.string().regex(AREA_PATTERN)).max(32).optional(),
    maxTasks: z.number().int().min(1).max(TRIAL_TASKS_MAX).optional(),
  }).strict().optional(),
  trialsPerTask: z.number().int().min(1).max(TRIALS_PER_TASK_MAX).optional(),
  limits: z.object({
    maxTrials: z.number().int().min(1).max(MAX_TRIALS_MAX),
    maxWallMinutes: z.number().int().min(10).max(43_200),
  }).strict(),
  windows: z.array(windowSchema).min(1).max(4).optional(),
  expiresAt: z.iso.datetime().optional(),
}).strict() as unknown as z.ZodType<BaselineJobRequest>;

/**
 * SHA-256 of the canonical JSON of the validation settings, trialMinutes, eval.grader, eval.member, each configuration's
 * promptVersion("implementer", provider, profile, false, false, false), and project.team.permissions.
 */
export function trialJobDigest(project: Project, config: Pick<Config, "eval">, configurations: readonly TrialConfiguration[]): string {
  const validation = validationSettings(project);
  return sha256(canonicalJson({
    settings: "missing" in validation ? null : validation.settings,
    trialMinutes: project.team?.eval?.trialMinutes ?? TRIAL_MINUTES_DEFAULT,
    grader: config.eval?.grader ?? null,
    member: config.eval?.member ?? null,
    // The sealed payload returns keys in canonical order, and promptVersion renders the profile in key order, so the profile is canonical first.
    prompts: configurations.map(configuration => {
      const profile = JSON.parse(canonicalJson(configuration.profile)) as TeamModelProfile;
      return promptVersion("implementer", profile.provider, profile, false, false, false);
    }),
    permissions: project.team?.permissions ?? null,
  }));
}

export class TrialJobs {
  private readonly store: EvidenceStore;
  private readonly config: Pick<Config, "projects" | "eval" | "teams">;
  private readonly now: () => string;
  /** Per job: the slot whose releases are being counted, and how many in a row. */
  private readonly released = new Map<string, { key: string; count: number }>();

  constructor(options: { store: EvidenceStore; config: Pick<Config, "projects" | "eval" | "teams">; now?: () => string }) {
    this.store = options.store;
    this.config = options.config;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  create(projectId: string, request: JobRequest, requestId: string): { created: boolean; job: JobView } | EvalRefusal {
    const parsed = request.kind === "baseline" ? baselineJobSchema.safeParse(request) : comparisonJobSchema.safeParse(request);
    if (!parsed.success) return refusal(400, "invalid-eval-request");
    const project = this.projectOf(projectId);
    if (project === undefined) return refusal(404, "unknown-project");
    const nowMs = Date.parse(this.now());
    const expiresMs = parsed.data.expiresAt === undefined ? nowMs + JOB_EXPIRY_DAYS_MAX * DAY_MS : Date.parse(parsed.data.expiresAt);
    if (expiresMs > nowMs + JOB_EXPIRY_DAYS_MAX * DAY_MS) return refusal(400, "invalid-eval-request");
    const normalized = {
      ...parsed.data,
      taskFilter: { ...parsed.data.taskFilter, maxTasks: parsed.data.taskFilter?.maxTasks ?? TRIAL_TASKS_DEFAULT },
      trialsPerTask: parsed.data.trialsPerTask ?? TRIALS_PER_TASK_DEFAULT,
      expiresAt: new Date(expiresMs).toISOString(),
    } as JobRequest;
    // Digest the body as the client sent it, so a replay later still matches. The default expiry moves with the clock.
    const requestDigest = sha256(canonicalJson({ projectId, request: parsed.data }));
    return this.store.write(tx => {
      const existing = tx.get<EvalJobRow>("SELECT * FROM eval_jobs WHERE request_id = ?", requestId);
      if (existing !== undefined) {
        const payload = tx.open<TrialJobPayload>("eval_jobs", existing.job_id, existing.payload);
        if (payload.requestDigest !== requestDigest) return refusal(409, "request-conflict");
        return { created: false, job: this.viewOf(tx, existing) };
      }
      const found = trialSettings(project);
      if ("missing" in found) return refusal(409, "eval-config-incomplete");
      const approval = this.profileRefusal(project, normalized.configurations, found.settings.candidateProfiles);
      if (approval !== undefined) return approval;
      const ref = tx.index("project", projectId);
      if (tx.get(ACTIVE_PROJECT_JOBS_SQL, ref, normalized.kind) !== undefined) return refusal(409, "job-active");
      const jobId = randomUUID();
      const at = this.now();
      const comparison = normalized.kind === "baseline" ? undefined : planComparison(tx, { projectId, request: normalized, at });
      if (comparison !== undefined && "code" in comparison) return comparison;
      const payload: TrialJobPayload = {
        projectId,
        request: normalized,
        requestDigest,
        jobDigest: trialJobDigest(project, this.config, normalized.configurations),
        ...(comparison === undefined ? {} : { tasks: comparison.tasks, pins: comparison.pins }),
        ...(comparison?.subject === undefined ? {} : { subject: comparison.subject }),
      };
      tx.run(
        "INSERT INTO eval_jobs (job_id, project_ref, kind, status, reason, waiting, request_id, created_at, started_at, "
        + "expires_at, finished_at, updated_at, payload) VALUES (?, ?, ?, 'scheduled', NULL, NULL, ?, ?, NULL, ?, NULL, ?, ?)",
        jobId,
        ref,
        normalized.kind,
        requestId,
        at,
        normalized.expiresAt ?? at,
        at,
        tx.seal("eval_jobs", jobId, payload),
      );
      if (comparison === undefined) {
        openTrialCounts(tx, jobId, this.plan(tx, ref, normalized));
      } else {
        openTrialCounts(tx, jobId, comparison.planned);
        const outcome = applyComparison(tx, {
          jobId, projectId, request: normalized as ComparisonJobRequest, plan: comparison, keepDays: TRIAL_KEEP_DAYS_DEFAULT, at,
        });
        if (outcome === "complete") finish(tx, jobId, at, "completed", "done");
      }
      return { created: true, job: this.viewOf(tx, this.rowOf(tx, jobId) as EvalJobRow) };
    });
  }

  /** The views of the baseline, compare, and confirm rows of one page, with one counts read for all of them. */
  views(db: EvidenceDb, rows: readonly EvalJobRow[]): Map<string, JobView> {
    const baseline = rows.filter(row => row.kind !== "validate");
    const counts = trialCounts(db, baseline.map(row => row.job_id));
    const refs = this.refsOf(db);
    const states = reportStates(db, baseline.filter(row => row.kind !== "baseline").map(row => row.job_id));
    const views = new Map<string, JobView>();
    for (const row of baseline) {
      const projectId = refs.get(row.project_ref) ?? null;
      const project = projectId === null ? undefined : this.projectOf(projectId);
      const count = counts.get(row.job_id) ?? EMPTY_COUNTS;
      const common = {
        jobId: row.job_id,
        projectId,
        status: row.status,
        reason: row.reason,
        waiting: row.waiting,
        createdAt: row.created_at,
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        finishedAt: row.finished_at,
        tasks: { planned: count.plannedTasks, reached: count.tasks, skipped: count.skipped },
        dailyCap: project?.team?.eval?.trialsPerDay ?? null,
      };
      const trials = { planned: count.plannedTrials, started: count.started, graded: count.graded, resolved: count.resolved, ended: count.ended, void: count.void };
      if (row.kind === "baseline") {
        views.set(row.job_id, { ...common, kind: "baseline", trials });
        continue;
      }
      // A result shows only from the stored report's time, so an interim view never leaks a figure. No payload is opened.
      const reported = (row as ReportedRow).reported_at != null;
      views.set(row.job_id, {
        ...common,
        kind: row.kind === "confirm" ? "confirm" : "compare",
        set: row.kind === "confirm" ? "holdout" : "dev",
        trials: { ...trials, resolved: reported ? count.resolved : null, reused: count.reused },
        // The state column is read, not the payload: a ready row whose payload later fails to open still shows `ready`.
        report: reported ? states.get(row.job_id) ?? "ready" : row.finished_at === null ? null : "pending",
      });
    }
    return views;
  }

  /** The next trial of the job that holds the slot, or the wait that holds it. Free slots are read only when a trial would start. */
  async next(gates: TrialGates): Promise<NextTrial> {
    let free: number | undefined;
    for (;;) {
      const pass = this.store.write(tx => this.pass(tx, gates, free));
      if (pass.kind !== "slots") return pass;
      free = await gates.freeSlots();
    }
  }

  /** The cursor moves past a task that could not be read, and the task counts as skipped. */
  skip(jobId: string, taskId: string): void {
    this.store.write(tx => {
      if (this.rowOf(tx, jobId) === undefined) return;
      setJob(tx, jobId, this.now(), { cursor: taskId });
      advanceTask(tx, jobId, true);
    });
  }

  /** Reads the counters after a trial ended. Three voids in a row pause the job. */
  record(jobId: string, ending: TrialEnding): void {
    this.store.write(tx => {
      const row = this.rowOf(tx, jobId);
      if (row === undefined || (row.status !== "scheduled" && row.status !== "running")) return;
      const counts = trialCounts(tx, [jobId]).get(jobId);
      if (counts === undefined || !VOID_ENDINGS.includes(ending) || counts.voidStreak < VOID_STREAK_PAUSE) return;
      setJob(tx, jobId, this.now(), { status: "paused", reason: "trial-voids", waiting: null });
    });
  }

  /**
   * A trial that could not start, in one transaction. A job that is no longer open only loses the row. Otherwise the row goes
   * and the cause is the job's `waiting`, and the answer is "released"; a WAITS_ONLY cause is never counted and starts the count
   * again. On the TRIAL_RELEASES-th counted release in a row for one slot of one job the row stays and the answer is "exhausted":
   * the caller ends that trial `void-host` and skips the task. The count is in memory, so a restart starts it again.
   */
  release(trial: Pick<Extract<NextTrial, { kind: "trial" }>, "jobId" | "taskId" | "configRef" | "slot" | "attempt"> & { trialId: string },
    waiting: EvalJobWait): "released" | "exhausted" {
    return this.store.write(tx => {
      const row = this.rowOf(tx, trial.jobId);
      if (row === undefined || (row.status !== "scheduled" && row.status !== "running")) {
        this.released.delete(trial.jobId);
        dropTrial(tx, trial.trialId);
        return "released";
      }
      const key = JSON.stringify([trial.taskId, trial.configRef, trial.slot, trial.attempt]);
      const last = this.released.get(trial.jobId);
      const count = WAITS_ONLY.has(waiting) ? 0 : last?.key === key ? last.count + 1 : 1;
      if (count >= TRIAL_RELEASES) {
        this.released.delete(trial.jobId);
        return "exhausted";
      }
      if (count === 0) this.released.delete(trial.jobId);
      else this.released.set(trial.jobId, { key, count });
      dropTrial(tx, trial.trialId);
      if (row.waiting !== waiting) setJob(tx, row.job_id, this.now(), { waiting });
      return "released";
    });
  }

  block(jobId: string, reason: "eval-processes-alive"): void {
    this.store.write(tx => {
      const row = this.rowOf(tx, jobId);
      if (row === undefined || (row.status !== "scheduled" && row.status !== "running")) return;
      setJob(tx, jobId, this.now(), { status: "blocked", reason, waiting: null });
    });
  }

  /** The digest the job would pin now, from its own configurations; undefined while the settings are incomplete. */
  digest(projectId: string, jobId: string): string | undefined {
    return this.store.read(db => {
      const row = db.get<{ payload: string }>("SELECT payload FROM eval_jobs WHERE job_id = ?", jobId);
      if (row === undefined) return undefined;
      const payload = db.open<TrialJobPayload>("eval_jobs", jobId, row.payload);
      return this.pinned(projectId, payload.request.configurations)?.digest;
    });
  }

  running(): string[] {
    return this.store.read(db => db.all<EvalJobRow>(BASELINE_JOBS_SQL, "running", BASELINE_JOBS_MAX).map(row => row.job_id));
  }

  /**
   * Ends the paused and blocked trial jobs whose expiry has passed, so they stop holding their project's holdout groups.
   * A job with a trial that is still preparing, running, or grading waits: it expires on a later call, once that trial is final,
   * so its report never leaves the trial out.
   */
  expireIdle(): number {
    return this.store.write(tx => this.expireIdleIn(tx));
  }

  private expireIdleIn(tx: EvidenceTx): number {
    const at = this.now();
    let ended = 0;
    for (const status of ["paused", "blocked"]) {
      for (const row of tx.all<EvalJobRow>(BASELINE_JOBS_SQL, status, BASELINE_JOBS_MAX)) {
        if (Date.parse(row.expires_at) > Date.parse(at)) continue;
        if (tx.get("SELECT 1 AS live FROM eval_trials WHERE job_id = ? AND state IN ('preparing', 'running', 'grading') LIMIT 1", row.job_id) !== undefined) continue;
        finish(tx, row.job_id, at, "expired", "expired");
        ended += 1;
      }
    }
    return ended;
  }

  private pass(tx: EvidenceTx, gates: TrialGates, free: number | undefined): Pass {
    // A paused job the owner paused stays paused until its expiry; only the expiry ends it.
    this.expireIdleIn(tx);
    const refs = this.refsOf(tx);
    const rows = [
      ...tx.all<EvalJobRow>(BASELINE_JOBS_SQL, "scheduled", BASELINE_JOBS_MAX),
      ...tx.all<EvalJobRow>(BASELINE_JOBS_SQL, "running", BASELINE_JOBS_MAX),
    ]
      .sort((a, b) => compareText(a.created_at, b.created_at) || compareText(a.job_id, b.job_id))
      .slice(0, BASELINE_JOBS_MAX);
    let wait: NextTrial | undefined;
    for (const row of rows) {
      const step = this.step(tx, row, refs, gates, free);
      if (step.kind === "slots" || step.kind === "trial") return step;
      if (step.kind === "wait" && wait === undefined) wait = step;
    }
    return wait ?? NONE;
  }

  /** One job's turn: the gates in the plan's order, then the slot. Gates run before any counts move. */
  private step(tx: EvidenceTx, row: EvalJobRow, refs: Map<string, string>, gates: TrialGates, free: number | undefined): Pass {
    const at = this.now();
    const nowMs = Date.parse(at);
    const projectId = refs.get(row.project_ref);
    if (projectId === undefined) {
      setJob(tx, row.job_id, at, { status: "blocked", reason: "configuration-changed", waiting: null });
      return NONE;
    }
    const payload = tx.open<TrialJobPayload>("eval_jobs", row.job_id, row.payload);
    const request = payload.request;
    if (Date.parse(row.expires_at) <= nowMs) {
      finish(tx, row.job_id, at, "expired", "expired");
      return NONE;
    }
    const wallSpent = row.started_at !== null && nowMs - Date.parse(row.started_at) >= request.limits.maxWallMinutes * 60_000;
    if (jobTrialCount(tx, row.job_id) >= request.limits.maxTrials || wallSpent) {
      finish(tx, row.job_id, at, "completed", "limit-reached");
      return NONE;
    }
    if (row.kind !== "baseline" && payload.pins !== undefined && pinsChanged(tx, request.configurations, payload.pins, at)) {
      finish(tx, row.job_id, at, "completed", "identity-changed");
      return NONE;
    }
    const pinned = this.pinned(projectId, request.configurations);
    if (pinned === undefined || pinned.digest !== payload.jobDigest) {
      setJob(tx, row.job_id, at, { status: "blocked", reason: "configuration-changed", waiting: null });
      return NONE;
    }
    if (gates.halted(projectId)) return this.waitOn(tx, row, "halt");
    if (request.windows !== undefined && !inWindow(request.windows, nowMs)) return this.waitOn(tx, row, "window");
    if (gates.hostLoadHeld) return this.waitOn(tx, row, "host-load");
    const agents = this.config.eval?.member?.agents;
    const agentsReady = request.configurations.every(configuration => agents?.[configuration.profile.provider] !== undefined);
    if (gates.identity.state !== "ready" || !agentsReady) return this.waitOn(tx, row, "eval-identity");
    if (gates.grader.state !== "ready" || (gates.grader.version ?? 0) < 2) return this.waitOn(tx, row, "grader");
    if (gates.grader.storage !== true || gates.identity.storage !== true) return this.waitOn(tx, row, "storage");
    if (gates.trialLive) return this.waitOn(tx, row, "another-job");
    if (request.configurations.some(configuration => gates.limited.has(configuration.profile.provider))) return this.waitOn(tx, row, "provider-limit");
    if (row.kind !== "baseline") return this.scanFixed(tx, row, projectId, payload, pinned.settings, free, nowMs);
    return this.scan(tx, row, projectId, request as BaselineJobRequest, pinned.settings, free, nowMs);
  }

  /**
   * The cursor holds the last task that is finished or skipped. The next valid task after it is the candidate: a task with
   * a slot left starts a trial; a task without one counts as finished, and the cursor moves past it.
   */
  private scan(
    tx: EvidenceTx,
    row: EvalJobRow,
    projectId: string,
    request: BaselineJobRequest,
    settings: TrialSettings,
    free: number | undefined,
    nowMs: number,
  ): Pass {
    const at = this.now();
    const filter = filterOf(tx, request);
    const maxTasks = request.taskFilter?.maxTasks ?? TRIAL_TASKS_DEFAULT;
    const trialsPerTask = request.trialsPerTask ?? TRIALS_PER_TASK_DEFAULT;
    const configRefs = request.configurations.map(configuration => configRef(configuration));
    let reached = (trialCounts(tx, [row.job_id]).get(row.job_id) ?? EMPTY_COUNTS).tasks;
    let cursor = row.cursor;
    for (;;) {
      if (reached >= maxTasks) {
        finish(tx, row.job_id, at, "completed", "done");
        return NONE;
      }
      const page = tx.all<TrialTaskRow>(TRIAL_TASKS_SQL, row.project_ref, cursor ?? "");
      const index = page.findIndex(candidate => selected(candidate, filter));
      if (index === -1) {
        if (page.length === TASK_PAGE) {
          // A full page with no match: the next call starts after it.
          setJob(tx, row.job_id, at, { cursor: page[page.length - 1].task_id });
          return NONE;
        }
        finish(tx, row.job_id, at, "completed", "done");
        return NONE;
      }
      if (index > 0) cursor = page[index - 1].task_id;
      const candidate = page[index];
      const pick = nextSlot({
        tasks: [candidate.task_id], configRefs, trialsPerTask, rows: jobSlots(tx, row.job_id, candidate.task_id),
      });
      if (pick === undefined) {
        advanceTask(tx, row.job_id, false);
        reached += 1;
        cursor = candidate.task_id;
        setJob(tx, row.job_id, at, { cursor });
        continue;
      }
      if (index > 0) setJob(tx, row.job_id, at, { cursor });
      return this.handOut(tx, row, projectId, request.configurations, settings, free, nowMs, candidate.task_id, pick);
    }
  }

  /**
   * The comparison scan: the sealed task list in order, after the cursor (the last finished task). A task that is no longer
   * valid counts as skipped. The end of the list finishes the job. One call reads at most TASK_PAGE tasks.
   */
  private scanFixed(
    tx: EvidenceTx,
    row: EvalJobRow,
    projectId: string,
    payload: TrialJobPayload,
    settings: TrialSettings,
    free: number | undefined,
    nowMs: number,
  ): Pass {
    const at = this.now();
    const tasks = payload.tasks ?? [];
    const request = payload.request;
    const trialsPerTask = request.trialsPerTask ?? TRIALS_PER_TASK_DEFAULT;
    const configRefs = request.configurations.map(configuration => configRef(configuration));
    const after = row.cursor;
    const first = after === null ? 0 : tasks.findIndex(taskId => compareText(taskId, after) > 0);
    if (first === -1) {
      finish(tx, row.job_id, at, "completed", "done");
      return NONE;
    }
    const last = Math.min(tasks.length, first + TASK_PAGE);
    for (let index = first; index < last; index += 1) {
      const taskId = tasks[index] as string;
      const valid = tx.get("SELECT 1 FROM eval_tasks WHERE task_id = ? AND state = 'valid'", taskId) !== undefined;
      const pick = valid ? nextSlot({ tasks: [taskId], configRefs, trialsPerTask, rows: jobSlots(tx, row.job_id, taskId) }) : undefined;
      if (pick !== undefined) return this.handOut(tx, row, projectId, request.configurations, settings, free, nowMs, taskId, pick);
      advanceTask(tx, row.job_id, !valid);
      setJob(tx, row.job_id, at, { cursor: taskId });
    }
    if (last === tasks.length) finish(tx, row.job_id, at, "completed", "done");
    return NONE;
  }

  /** The gates that need a free session count, then the trial for one slot. */
  private handOut(
    tx: EvidenceTx,
    row: EvalJobRow,
    projectId: string,
    configurations: readonly TrialConfiguration[],
    settings: TrialSettings,
    free: number | undefined,
    nowMs: number,
    taskId: string,
    pick: { configRef: string; slot: number; attempt: number },
  ): Pass {
    const at = this.now();
    if (free === undefined) return { kind: "slots" };
    if (free < TRIAL_SLOTS_FREE_MIN) return this.waitOn(tx, row, "session-slots");
    if (trialsSince(tx, projectId, utcDayStart(nowMs)) >= settings.trialsPerDay) return this.waitOn(tx, row, "daily-cap");
    const configuration = configurations.find(item => configRef(item) === pick.configRef);
    if (configuration === undefined) return NONE;
    const started: Record<string, SQLInputValue> = row.status === "scheduled" ? { status: "running", started_at: at } : {};
    if (row.waiting !== null) started.waiting = null;
    if (Object.keys(started).length > 0) setJob(tx, row.job_id, at, started);
    return {
      kind: "trial", jobId: row.job_id, projectId, taskId, configuration,
      configRef: pick.configRef, slot: pick.slot, attempt: pick.attempt, settings,
    };
  }

  /** The settings and digest a job pins now, or undefined while the trial settings are incomplete. */
  private pinned(projectId: string, configurations: readonly TrialConfiguration[]): { settings: TrialSettings; digest: string } | undefined {
    const project = this.projectOf(projectId);
    if (project === undefined) return undefined;
    const found = trialSettings(project);
    if ("missing" in found) return undefined;
    return { settings: found.settings, digest: trialJobDigest(project, this.config, configurations) };
  }

  private profileRefusal(project: Project, configurations: readonly TrialConfiguration[], candidates: readonly TeamModelProfile[]): EvalRefusal | undefined {
    const lineup = this.config.teams?.lineup;
    const pool = new Set([...(lineup ? lineupProfiles(lineup) : []), ...candidates].map(profile => canonicalJson(profile)));
    for (const { profile } of configurations) {
      const provider: string = profile.provider;
      if (provider !== "claude" && provider !== "codex" && provider !== "opencode") return refusal(409, "profile-not-approved");
      if (!pool.has(canonicalJson(profile))) return refusal(409, "profile-not-approved");
      if (profile.dataUse === "contributor" && project.team?.routing?.allowContributor !== true) return refusal(409, "profile-not-approved");
    }
    return undefined;
  }

  /** Planned tasks: the valid tasks the filter selects, at most maxTasks. Planned trials: tasks x configurations x trialsPerTask, at most maxTrials. */
  private plan(db: EvidenceDb, ref: string, request: JobRequest): { tasks: number; trials: number } {
    const filter = filterOf(db, request);
    const maxTasks = request.taskFilter?.maxTasks ?? TRIAL_TASKS_DEFAULT;
    let tasks = 0;
    let after = "";
    let page: CandidateRow[];
    do {
      page = db.all<TrialTaskRow>(TRIAL_TASKS_SQL, ref, after);
      for (const row of page) {
        after = row.task_id;
        if (tasks < maxTasks && selected(row, filter)) tasks += 1;
      }
    } while (page.length === TASK_PAGE && tasks < maxTasks);
    const trialsPerTask = request.trialsPerTask ?? TRIALS_PER_TASK_DEFAULT;
    return { tasks, trials: Math.min(request.limits.maxTrials, tasks * request.configurations.length * trialsPerTask) };
  }

  private waitOn(tx: EvidenceTx, row: EvalJobRow, waiting: EvalJobWait): Pass {
    if (row.waiting !== waiting) setJob(tx, row.job_id, this.now(), { waiting });
    return { kind: "wait", jobId: row.job_id, waiting };
  }

  private viewOf(db: EvidenceDb, row: EvalJobRow): JobView {
    const view = this.views(db, [row]).get(row.job_id);
    if (view === undefined) throw new Error("A trial job row has no view.");
    return view;
  }

  private rowOf(db: EvidenceDb, jobId: string): EvalJobRow | undefined {
    return db.get<EvalJobRow>("SELECT * FROM eval_jobs WHERE job_id = ?", jobId);
  }

  private projectOf(projectId: string): Project | undefined {
    return this.config.projects.find(project => project.id === projectId);
  }

  /** Each configured project's reference, mapped back to its id. Built from the config, not from a row. */
  private refsOf(db: EvidenceDb): Map<string, string> {
    return new Map(this.config.projects.map(project => [db.index("project", project.id), project.id]));
  }
}

function refusal(status: EvalRefusal["status"], code: EvalRefusal["code"]): EvalRefusal {
  return { status, code };
}

function filterOf(db: EvidenceDb, request: JobRequest): Filter {
  const filter = request.taskFilter;
  return {
    origins: filter?.origins === undefined ? undefined : new Set(filter.origins),
    // Rows keep the blind index of an area, not its name.
    areas: filter?.areas === undefined ? undefined : new Set(filter.areas.map(area => db.index("area", area))),
    ids: filter?.taskIds === undefined ? undefined : new Set(filter.taskIds),
  };
}

function selected(candidate: CandidateRow, filter: Filter): boolean {
  if (candidate.holdout === 1) return false;
  if (filter.origins !== undefined && !filter.origins.has(candidate.origin)) return false;
  if (filter.areas !== undefined && (candidate.area_ref === null || !filter.areas.has(candidate.area_ref))) return false;
  if (filter.ids !== undefined && !filter.ids.has(candidate.task_id)) return false;
  return true;
}

/** Writes the named columns and `updated_at`. The column names are fixed in this file. */
function setJob(tx: EvidenceTx, jobId: string, at: string, values: Record<string, SQLInputValue>): void {
  const entries = Object.entries(values);
  tx.run(
    `UPDATE eval_jobs SET ${entries.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ? WHERE job_id = ?`,
    ...entries.map(([, value]) => value),
    at,
    jobId,
  );
}

/** The stored report state of each job that has one, in one query. */
function reportStates(db: EvidenceDb, jobIds: readonly string[]): Map<string, "ready" | "unreadable"> {
  if (jobIds.length === 0) return new Map();
  const marks = jobIds.map(() => "?").join(", ");
  const rows = db.all<{ job_id: string; state: "ready" | "unreadable" }>(`SELECT job_id, state FROM eval_reports WHERE job_id IN (${marks})`, ...jobIds);
  return new Map(rows.map(row => [row.job_id, row.state]));
}

function finish(tx: EvidenceTx, jobId: string, at: string, status: "completed" | "expired", reason: Extract<EvalJobReason, "done" | "limit-reached" | "expired" | "identity-changed">): void {
  setJob(tx, jobId, at, { status, reason, waiting: null, finished_at: at });
}

function utcDayStart(nowMs: number): string {
  const day = new Date(nowMs);
  day.setUTCHours(0, 0, 0, 0);
  return day.toISOString();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Code-unit order, the order SQLite's BINARY collation gives for these ASCII keys. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
