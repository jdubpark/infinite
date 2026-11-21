import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { canonicalJson } from "./evidence/crypto.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { validationSettings, type EvalGraderConfig, type ValidationSettings } from "./eval-config.js";
import type { GraderProbe } from "./eval-grader.js";
import type { EvalJobReason, EvalJobView, EvalJobWait, EvalRefusal, ValidateJobRequest } from "./eval-types.js";
import type { TaskValidation } from "./eval-validate.js";
import type { RoutineStatus } from "./routine-types.js";
import type { Config } from "./types.js";

export const JOB_EXPIRY_DAYS_MAX = 30, JOB_TASKS_MAX = 1_000, JOB_TASKS_DEFAULT = 100, JOB_LIST_MAX = 100, STUCK_AFTER = 3,
  JOB_KEEP_DAYS = 90, REVALIDATE_DAYS = 30;
/** Rows one `next` call reads per job, and the rows one sweep pass deletes. */
const NEXT_PAGE = 200, ACTIVE_LIMIT = 100, SWEEP_LIMIT = 100, DAY_MS = 86_400_000;
/** The cursor of the revalidation phase starts with this text; a task id never does. */
const VALID_PHASE = "valid:";

const TASK_ID_PATTERN = /^(captured|mined):[A-Za-z0-9:._-]{1,200}$/;
const AREA_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const windowSchema = z.object({
  startHourUtc: z.number().int().min(0).max(23),
  endHourUtc: z.number().int().min(1).max(24),
}).strict().refine(window => window.endHourUtc !== window.startHourUtc, "a window must not be empty");

export const validateJobSchema: z.ZodType<ValidateJobRequest> = z.object({
  kind: z.literal("validate"),
  taskFilter: z.object({
    taskIds: z.array(z.string().regex(TASK_ID_PATTERN)).max(JOB_TASKS_MAX).optional(),
    origins: z.array(z.enum(["captured", "mined"])).max(2).optional(),
    areas: z.array(z.string().regex(AREA_PATTERN)).max(32).optional(),
    revalidate: z.boolean().optional(),
    maxTasks: z.number().int().min(1).max(JOB_TASKS_MAX).optional(),
  }).strict().optional(),
  limits: z.object({ maxWallMinutes: z.number().int().min(10).max(43_200) }).strict(),
  windows: z.array(windowSchema).min(1).max(4).optional(),
  expiresAt: z.iso.datetime().optional(),
}).strict();

/** One task of the project, through `eval_tasks_next`: the next candidate or valid row after the cursor. */
export const NEXT_TASK_SQL = "SELECT task_id, origin, area_ref, validated_at FROM eval_tasks WHERE project_ref = ? AND state = ? AND task_id > ? ORDER BY task_id LIMIT 200";
/** The jobs in one status, oldest first, through `eval_jobs_status`. */
export const ACTIVE_JOBS_SQL = "SELECT * FROM eval_jobs WHERE status = ? AND kind = 'validate' ORDER BY created_at, job_id LIMIT ?";
/** Whether a project has a job of one kind that holds its slot, through `eval_jobs_project`. */
export const ACTIVE_PROJECT_JOBS_SQL = "SELECT job_id FROM eval_jobs WHERE project_ref = ? AND kind = ? AND status IN ('scheduled', 'running', 'paused', 'blocked') LIMIT 1";
/** The newest jobs of a project, through `eval_jobs_project`. */
export const PROJECT_JOBS_SQL = "SELECT * FROM eval_jobs WHERE project_ref = ? ORDER BY created_at DESC, job_id DESC LIMIT ?";
/** The newest jobs, in index order through `eval_jobs_created`, with no predicate, so the plan is a scan that stops at LIMIT. */
export const JOBS_SQL = "SELECT * FROM eval_jobs ORDER BY created_at DESC, job_id DESC LIMIT ?";
/** Finished jobs older than the cutoff, through the `created_at` range of `eval_jobs_created`. `finished_at` is never before `created_at`. */
export const JOB_SWEEP_SQL = "SELECT job_id FROM eval_jobs WHERE created_at < ? AND finished_at < ? ORDER BY created_at, job_id LIMIT ?";

/** SHA-256 of the canonical JSON of the validation settings and eval.grader. */
export function jobDigest(settings: ValidationSettings, grader: EvalGraderConfig | undefined): string {
  return sha256(canonicalJson({ settings, grader: grader ?? null }));
}

export type NextWork =
  | { kind: "task"; jobId: string; projectId: string; taskId: string; settings: ValidationSettings }
  | { kind: "wait"; jobId: string; waiting: EvalJobWait }
  | { kind: "none" };

export type Gates = { grader: GraderProbe; hostLoadHeld: boolean; halted: (projectId: string) => boolean };

/** Sealed in `eval_jobs.payload`: the normalized request, its digest, and the digest pinned at the last approval. */
type JobPayload = { projectId: string; request: ValidateJobRequest; requestDigest: string; jobDigest: string };

export type EvalJobRow = JobRow;
type JobRow = {
  job_id: string; project_ref: string; kind: string; status: RoutineStatus; reason: EvalJobReason | null;
  waiting: EvalJobWait | null; request_id: string; created_at: string; started_at: string | null; expires_at: string;
  finished_at: string | null; updated_at: string; visited: number; valid: number; rejected: number; retired: number;
  undecided: number; streak: number; cursor: string | null; payload: string;
};

type CandidateRow = { task_id: string; origin: string; area_ref: string | null; validated_at: string | null };

type JobColumn = "status" | "reason" | "waiting" | "started_at" | "finished_at" | "visited" | "valid" | "rejected"
  | "retired" | "undecided" | "streak" | "cursor" | "payload";
type JobUpdate = Partial<Record<JobColumn, SQLInputValue>>;

const NONE: NextWork = { kind: "none" };

/** The baseline job's views and resume digest, supplied by TrialJobs for rows of kind `baseline`. */
export type BaselineJobHooks = {
  views(db: EvidenceDb, rows: readonly EvalJobRow[]): Map<string, EvalJobView>;
  digest(projectId: string, jobId: string): string | undefined;
};

export class EvalJobs {
  private readonly store: EvidenceStore;
  private readonly config: Pick<Config, "projects" | "eval">;
  private readonly now: () => string;
  private readonly baseline: BaselineJobHooks | undefined;
  /** The job whose task `next` handed out and `record` has not yet closed. One task runs at a time. */
  private inFlight: string | undefined;

  constructor(options: { store: EvidenceStore; config: Pick<Config, "projects" | "eval">; now?: () => string; baseline?: BaselineJobHooks }) {
    this.store = options.store;
    this.config = options.config;
    this.now = options.now ?? (() => new Date().toISOString());
    this.baseline = options.baseline;
  }

  create(projectId: string, request: ValidateJobRequest, requestId: string): { created: boolean; job: EvalJobView } | EvalRefusal {
    const parsed = validateJobSchema.safeParse(request);
    if (!parsed.success) return refusal(400, "invalid-eval-request");
    const project = this.projectOf(projectId);
    if (project === undefined) return refusal(404, "unknown-project");
    const nowMs = Date.parse(this.now());
    const expiresMs = parsed.data.expiresAt === undefined ? nowMs + JOB_EXPIRY_DAYS_MAX * DAY_MS : Date.parse(parsed.data.expiresAt);
    if (expiresMs > nowMs + JOB_EXPIRY_DAYS_MAX * DAY_MS) return refusal(400, "invalid-eval-request");
    const normalized: ValidateJobRequest = {
      ...parsed.data,
      taskFilter: { ...parsed.data.taskFilter, maxTasks: parsed.data.taskFilter?.maxTasks ?? JOB_TASKS_DEFAULT },
      expiresAt: new Date(expiresMs).toISOString(),
    };
    // Digest the body as the client sent it, so a replay later still matches. The default expiry moves with the clock.
    const requestDigest = sha256(canonicalJson({ projectId, request: parsed.data }));
    return this.store.write(tx => {
      const existing = tx.get<JobRow>("SELECT * FROM eval_jobs WHERE request_id = ?", requestId);
      if (existing !== undefined) {
        const payload = tx.open<JobPayload>("eval_jobs", existing.job_id, existing.payload);
        if (payload.requestDigest !== requestDigest) return refusal(409, "request-conflict");
        return { created: false, job: this.viewOf(tx, existing) };
      }
      const found = validationSettings(project);
      if ("missing" in found) return refusal(409, "eval-config-incomplete");
      const ref = tx.index("project", projectId);
      if (tx.get(ACTIVE_PROJECT_JOBS_SQL, ref, "validate") !== undefined) return refusal(409, "job-active");
      const jobId = randomUUID();
      const at = this.now();
      const payload: JobPayload = {
        projectId,
        request: normalized,
        requestDigest,
        jobDigest: jobDigest(found.settings, this.config.eval?.grader),
      };
      tx.run(
        "INSERT INTO eval_jobs (job_id, project_ref, kind, status, reason, waiting, request_id, created_at, started_at, "
        + "expires_at, finished_at, updated_at, payload) VALUES (?, ?, 'validate', 'scheduled', NULL, NULL, ?, ?, NULL, ?, NULL, ?, ?)",
        jobId,
        ref,
        requestId,
        at,
        normalized.expiresAt ?? at,
        at,
        tx.seal("eval_jobs", jobId, payload),
      );
      return { created: true, job: this.viewOf(tx, this.rowOf(tx, jobId) as JobRow) };
    });
  }

  control(jobId: string, action: "pause" | "resume" | "cancel"): EvalJobView | EvalRefusal {
    return this.store.write(tx => {
      const row = this.rowOf(tx, jobId);
      if (row === undefined) return refusal(404, "unknown-job");
      const at = this.now();
      if (action === "pause") {
        if (row.status !== "scheduled" && row.status !== "running") return refusal(409, "invalid-job-transition");
        update(tx, jobId, at, { status: "paused", reason: "owner" });
      } else if (action === "resume") {
        if (row.status !== "paused" && row.status !== "blocked") return refusal(409, "invalid-job-transition");
        const values: JobUpdate = {
          status: row.started_at === null ? "scheduled" : "running",
          reason: null,
          waiting: null,
        };
        if (row.status === "blocked") {
          // The owner's resume approves the configuration as it is now, so the job pins the current digest.
          const projectId = this.refs(tx).get(row.project_ref);
          const digest = projectId === undefined ? undefined : row.kind !== "validate"
            ? this.baseline?.digest(projectId, jobId) : this.pinnedDigest(projectId)?.digest;
          if (digest === undefined || projectId === undefined) return refusal(409, "eval-config-incomplete");
          const payload = tx.open<JobPayload>("eval_jobs", jobId, row.payload);
          values.payload = tx.seal("eval_jobs", jobId, { ...payload, jobDigest: digest });
        }
        update(tx, jobId, at, values);
      } else {
        if (row.status === "completed" || row.status === "cancelled" || row.status === "expired") {
          return refusal(409, "invalid-job-transition");
        }
        update(tx, jobId, at, { status: "cancelled", reason: "owner", waiting: null, finished_at: at });
      }
      return this.viewOf(tx, this.rowOf(tx, jobId) as JobRow);
    });
  }

  view(jobId: string): EvalJobView | undefined {
    return this.store.read(db => {
      const row = db.get<JobRow>("SELECT * FROM eval_jobs WHERE job_id = ?", jobId);
      return row === undefined ? undefined : this.viewOf(db, row);
    });
  }

  list(limit = JOB_LIST_MAX): EvalJobView[] {
    return this.store.read(db => {
      return this.viewsOf(db, db.all<JobRow>(JOBS_SQL, Math.min(limit, JOB_LIST_MAX)), this.refs(db));
    });
  }

  projectJobs(projectId: string, limit: number): EvalJobView[] {
    return this.store.read(db => {
      const ref = db.index("project", projectId);
      return this.viewsOf(db, db.all<JobRow>(PROJECT_JOBS_SQL, ref, Math.min(limit, JOB_LIST_MAX)), new Map([[ref, projectId]]));
    });
  }

  /** The next task for the validator, or the wait that holds the jobs. Writes only job rows. */
  next(gates: Gates): NextWork {
    return this.store.write(tx => {
      const refs = this.refs(tx);
      const active = [
        ...tx.all<JobRow>(ACTIVE_JOBS_SQL, "scheduled", ACTIVE_LIMIT),
        ...tx.all<JobRow>(ACTIVE_JOBS_SQL, "running", ACTIVE_LIMIT),
      ]
        .sort((a, b) => compareText(a.created_at, b.created_at) || compareText(a.job_id, b.job_id))
        .slice(0, ACTIVE_LIMIT);
      let wait: NextWork | undefined;
      for (const row of active) {
        const work = this.step(tx, row, refs, gates);
        if (work.kind === "task") return work;
        if (work.kind === "wait" && wait === undefined) wait = work;
      }
      return wait ?? NONE;
    });
  }

  /** Closes the task `next` handed out: moves the cursor, counts the outcome, and applies a pause or a wait. */
  record(jobId: string, taskId: string, outcome: TaskValidation): void {
    // Cleared before the write, so a failed write still frees the next job.
    if (this.inFlight === jobId) this.inFlight = undefined;
    this.store.write(tx => {
      const row = this.rowOf(tx, jobId);
      if (row === undefined || row.status === "completed" || row.status === "cancelled" || row.status === "expired") return;
      const at = this.now();
      const cursor = cursorOf(phaseOf(row.cursor).phase, taskId);
      if (outcome.kind === "decided") {
        const counter = outcome.state === "valid" ? "valid" : outcome.state === "rejected" ? "rejected" : "retired";
        update(tx, jobId, at, { visited: row.visited + 1, streak: 0, cursor, waiting: null, [counter]: row[counter] + 1 });
      } else if (outcome.kind === "undecided") {
        const streak = row.streak + 1;
        const stuck = streak >= STUCK_AFTER;
        update(tx, jobId, at, {
          visited: row.visited + 1,
          undecided: row.undecided + 1,
          streak,
          cursor,
          waiting: null,
          ...(stuck ? { status: "paused", reason: "validation-stuck" } : {}),
        });
      } else {
        // An environment outcome counts nothing and keeps the cursor, so the task is visited again.
        if (outcome.cause === "grader-processes-alive") {
          update(tx, jobId, at, { status: "blocked", reason: "grader-processes-alive", waiting: null });
        } else if (outcome.cause === "halted") {
          update(tx, jobId, at, { waiting: "halt" });
        } else {
          const waiting = outcome.cause === "anchor-unknown" ? "mirror" : outcome.cause === "grader-failed" ? "grader"
            : outcome.cause === "bundle-missing" ? "bundle" : outcome.cause === "storage" ? "storage" : null;
          update(tx, jobId, at, { waiting });
        }
      }
    });
  }

  /** Deletes at most SWEEP_LIMIT finished jobs older than JOB_KEEP_DAYS. */
  sweep(): number {
    return this.store.write(tx => {
      const cutoff = new Date(Date.parse(this.now()) - JOB_KEEP_DAYS * DAY_MS).toISOString();
      const old = tx.all<{ job_id: string }>(JOB_SWEEP_SQL, cutoff, cutoff, SWEEP_LIMIT);
      for (const row of old) tx.run("DELETE FROM eval_jobs WHERE job_id = ?", row.job_id);
      return old.length;
    });
  }

  /** One job's turn in `next`: a task, a wait, or nothing from this job. Gates run in the plan's order. */
  private step(tx: EvidenceTx, row: JobRow, refs: Map<string, string>, gates: Gates): NextWork {
    const at = this.now();
    const nowMs = Date.parse(at);
    const projectId = refs.get(row.project_ref);
    if (projectId === undefined) {
      update(tx, row.job_id, at, { status: "blocked", reason: "configuration-changed", waiting: null });
      return NONE;
    }
    const payload = tx.open<JobPayload>("eval_jobs", row.job_id, row.payload);
    const request = payload.request;
    if (Date.parse(row.expires_at) <= nowMs) {
      this.finish(tx, row.job_id, at, "expired", "expired");
      return NONE;
    }
    const maxTasks = request.taskFilter?.maxTasks ?? JOB_TASKS_DEFAULT;
    const wallSpent = row.started_at !== null && nowMs - Date.parse(row.started_at) >= request.limits.maxWallMinutes * 60_000;
    if (row.visited >= maxTasks || wallSpent) {
      this.finish(tx, row.job_id, at, "completed", "limit-reached");
      return NONE;
    }
    const pinned = this.pinnedDigest(projectId);
    if (pinned === undefined || pinned.digest !== payload.jobDigest) {
      update(tx, row.job_id, at, { status: "blocked", reason: "configuration-changed", waiting: null });
      return NONE;
    }
    if (gates.halted(projectId)) return this.waitOn(tx, row, "halt");
    if (request.windows !== undefined && !inWindow(request.windows, nowMs)) return this.waitOn(tx, row, "window");
    if (gates.hostLoadHeld) return this.waitOn(tx, row, "host-load");
    if (gates.grader.state !== "ready") return this.waitOn(tx, row, "grader");
    if (gates.grader.storage !== true) return this.waitOn(tx, row, "storage");
    if (this.inFlight !== undefined && this.inFlight !== row.job_id) return this.waitOn(tx, row, "another-job");
    return this.scan(tx, row, projectId, payload, pinned.settings, nowMs);
  }

  /** Reads one page of the job's phase after its cursor, and returns the first task that matches or ends the job. */
  private scan(
    tx: EvidenceTx,
    row: JobRow,
    projectId: string,
    payload: JobPayload,
    settings: ValidationSettings,
    nowMs: number,
  ): NextWork {
    const at = this.now();
    const filter = this.filterOf(tx, payload.request);
    const revalidate = payload.request.taskFilter?.revalidate === true;
    const ref = row.project_ref;
    let { phase, after } = phaseOf(row.cursor);
    for (;;) {
      const page = tx.all<CandidateRow>(NEXT_TASK_SQL, ref, phase === "valid" ? "valid" : "candidate", after);
      for (let index = 0; index < page.length; index++) {
        const candidate = page[index];
        if (!matches(candidate, filter, phase, nowMs)) continue;
        // Rows before the match are not tasks of this job, so the cursor moves past them.
        if (index > 0) update(tx, row.job_id, at, { cursor: cursorOf(phase, page[index - 1].task_id) });
        if (row.status === "scheduled") update(tx, row.job_id, at, { status: "running", started_at: at });
        if (row.waiting !== null) update(tx, row.job_id, at, { waiting: null });
        this.inFlight = row.job_id;
        return { kind: "task", jobId: row.job_id, projectId, taskId: candidate.task_id, settings };
      }
      const last = page[page.length - 1]?.task_id;
      if (page.length === NEXT_PAGE && last !== undefined) {
        // A full page with no match: the next call starts after it.
        update(tx, row.job_id, at, { cursor: cursorOf(phase, last) });
        return NONE;
      }
      if (phase === "candidate" && revalidate) {
        // Written now, so `record` keeps the valid phase even when the first valid match is at index 0.
        phase = "valid";
        after = "";
        update(tx, row.job_id, at, { cursor: cursorOf("valid", "") });
        continue;
      }
      this.finish(tx, row.job_id, at, "completed", "done");
      return NONE;
    }
  }

  private filterOf(tx: EvidenceDb, request: ValidateJobRequest): { origins?: Set<string>; areas?: Set<string>; ids?: Set<string> } {
    const filter = request.taskFilter;
    return {
      origins: filter?.origins === undefined ? undefined : new Set(filter.origins),
      // Rows keep the blind index of an area, not its name.
      areas: filter?.areas === undefined ? undefined : new Set(filter.areas.map(area => tx.index("area", area))),
      ids: filter?.taskIds === undefined ? undefined : new Set(filter.taskIds),
    };
  }

  private waitOn(tx: EvidenceTx, row: JobRow, waiting: EvalJobWait): NextWork {
    if (row.waiting !== waiting) update(tx, row.job_id, this.now(), { waiting });
    return { kind: "wait", jobId: row.job_id, waiting };
  }

  private finish(tx: EvidenceTx, jobId: string, at: string, status: "completed" | "expired", reason: EvalJobReason): void {
    update(tx, jobId, at, { status, reason, waiting: null, finished_at: at });
  }

  private viewOf(db: EvidenceDb, row: JobRow): EvalJobView {
    return this.viewsOf(db, [row], this.refs(db))[0];
  }

  /** Validate rows take `viewWith`; baseline rows take the views of TrialJobs, read once for the page. */
  private viewsOf(db: EvidenceDb, rows: readonly JobRow[], refs: Map<string, string>): EvalJobView[] {
    const baseline = this.baseline?.views(db, rows.filter(row => row.kind !== "validate"));
    return rows.map(row => (row.kind !== "validate" ? baseline?.get(row.job_id) : undefined)
      ?? viewWith(row, refs.get(row.project_ref) ?? null));
  }

  private rowOf(db: EvidenceDb, jobId: string): JobRow | undefined {
    return db.get<JobRow>("SELECT * FROM eval_jobs WHERE job_id = ?", jobId);
  }

  private projectOf(projectId: string): Config["projects"][number] | undefined {
    return this.config.projects.find(project => project.id === projectId);
  }

  /** The current digest of a project's validation settings, or undefined when they are incomplete. */
  private pinnedDigest(projectId: string): { settings: ValidationSettings; digest: string } | undefined {
    const project = this.projectOf(projectId);
    if (project === undefined) return undefined;
    const found = validationSettings(project);
    if ("missing" in found) return undefined;
    return { settings: found.settings, digest: jobDigest(found.settings, this.config.eval?.grader) };
  }

  /** Each configured project's reference, mapped back to its id. Built from the config, not from a row. */
  private refs(db: EvidenceDb): Map<string, string> {
    return new Map(this.config.projects.map(project => [db.index("project", project.id), project.id]));
  }
}

function refusal(status: EvalRefusal["status"], code: EvalRefusal["code"]): EvalRefusal {
  return { status, code };
}

function viewWith(row: JobRow, projectId: string | null): EvalJobView {
  return {
    jobId: row.job_id,
    projectId,
    kind: "validate",
    status: row.status,
    reason: row.reason,
    waiting: row.waiting,
    createdAt: row.created_at,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    finishedAt: row.finished_at,
    counts: { visited: row.visited, valid: row.valid, rejected: row.rejected, retired: row.retired, undecided: row.undecided },
  };
}

/** Writes the named columns and `updated_at`. The column names are fixed by `JobColumn`. */
function update(tx: EvidenceTx, jobId: string, at: string, values: JobUpdate): void {
  const entries = Object.entries(values) as [JobColumn, SQLInputValue][];
  const sets = [...entries.map(([column]) => `${column} = ?`), "updated_at = ?"];
  tx.run(`UPDATE eval_jobs SET ${sets.join(", ")} WHERE job_id = ?`, ...entries.map(([, value]) => value), at, jobId);
}

function phaseOf(cursor: string | null): { phase: "candidate" | "valid"; after: string } {
  if (cursor === null) return { phase: "candidate", after: "" };
  if (cursor.startsWith(VALID_PHASE)) return { phase: "valid", after: cursor.slice(VALID_PHASE.length) };
  return { phase: "candidate", after: cursor };
}

function cursorOf(phase: "candidate" | "valid", taskId: string): string {
  return phase === "valid" ? `${VALID_PHASE}${taskId}` : taskId;
}

function matches(
  candidate: CandidateRow,
  filter: { origins?: Set<string>; areas?: Set<string>; ids?: Set<string> },
  phase: "candidate" | "valid",
  nowMs: number,
): boolean {
  if (filter.origins !== undefined && !filter.origins.has(candidate.origin)) return false;
  if (filter.areas !== undefined && (candidate.area_ref === null || !filter.areas.has(candidate.area_ref))) return false;
  if (filter.ids !== undefined && !filter.ids.has(candidate.task_id)) return false;
  if (phase === "valid") {
    return candidate.validated_at !== null && Date.parse(candidate.validated_at) <= nowMs - REVALIDATE_DAYS * DAY_MS;
  }
  return true;
}

/** A window is [start, end) in UTC hours; an end below its start crosses midnight. */
export function inWindow(windows: readonly { startHourUtc: number; endHourUtc: number }[], nowMs: number): boolean {
  const hour = new Date(nowMs).getUTCHours();
  return windows.some(window => window.startHourUtc < window.endHourUtc
    ? hour >= window.startHourUtc && hour < window.endHourUtc
    : hour >= window.startHourUtc || hour < window.endHourUtc);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Code-unit order, the order SQLite's BINARY collation gives for these ASCII keys. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
