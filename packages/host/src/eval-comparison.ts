import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { areaNames, priorCells, writePriors, type PriorTask } from "./eval-priors.js";
import { comparisonStats, type StatTask, type StatTrial } from "./eval-stats.js";
import { jobRows, REPORT_KEEP_DAYS, type JobTrialRow } from "./eval-trial-store.js";
import type {
  ComparisonPin, ComparisonReport, EvalJobReason, EvalRefusal, PromptOrigin, TrialJobPayload,
} from "./eval-types.js";
import type { Config } from "./types.js";

// The report pass: once for each finished job, a stored report (compare and confirm) and prior rows (baseline and compare).
// It reads plain columns and the job's own sealed payload. It never opens a task payload.

export const REPORT_CANDIDATES = 20, REPORT_SESSION_WAIT_MS = 86_400_000;
export const REPORT_DUE_SQL = "SELECT job_id, project_ref, kind, status, reason, finished_at, payload FROM eval_jobs WHERE reported_at IS NULL "
  + "AND kind != 'validate' AND finished_at IS NOT NULL ORDER BY finished_at, job_id LIMIT 20";
export const SESSIONS_HELD_SQL = "SELECT 1 AS held FROM eval_trials WHERE job_id = ? AND session_id IS NOT NULL LIMIT 1";
/** At most 200 ids, one placeholder each. */
export const REPORT_TASKS_SQL = "SELECT t.task_id, t.area_ref, t.prompt_origin, t.kind, COALESCE(r.holdout, 0) AS holdout FROM eval_tasks t "
  + "LEFT JOIN eval_groups g ON g.group_id = t.group_id LEFT JOIN eval_groups r ON r.group_id = g.root_id WHERE t.task_id IN (…)";

const DAY_MS = 86_400_000;
const TASKS_MAX = 200;
const TRIALS_PER_TASK_DEFAULT = 3;
const OTHER_AREA = "other";
const UNREADABLE_LOG = "Eval report unreadable.";

type Project = Config["projects"][number];
type DueRow = { job_id: string; project_ref: string; kind: "baseline" | "compare" | "confirm"; status: ComparisonReport["status"];
  reason: EvalJobReason | null; finished_at: string; payload: string };
type TaskSqlRow = { task_id: string; area_ref: string | null; prompt_origin: PromptOrigin | null; kind: string | null; holdout: number };

let unreadableLogged = false;

function logUnreadable(): void {
  if (unreadableLogged) return;
  unreadableLogged = true;
  console.warn(UNREADABLE_LOG);
}

const tasksSql = (count: number): string => REPORT_TASKS_SQL.replace("(…)", `(${Array.from({ length: count }, () => "?").join(", ")})`);

function taskRows(db: EvidenceDb, ids: readonly string[]): Map<string, TaskSqlRow> {
  const rows = new Map<string, TaskSqlRow>();
  if (ids.length === 0) return rows;
  for (const row of db.all<TaskSqlRow>(tasksSql(ids.length), ...ids)) rows.set(row.task_id, row);
  return rows;
}

function minutesOf(row: JobTrialRow): number | null {
  if (row.startedAt === null || row.endedAt === null) return null;
  const minutes = (Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 60_000;
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

function statTrial(row: JobTrialRow, pin: ComparisonPin, configuration: number): StatTrial {
  return {
    configuration,
    slot: row.slot,
    ending: row.ending as NonNullable<JobTrialRow["ending"]>,
    resolved: row.resolved === true,
    matches: row.profileEpoch === pin.profileEpoch && row.promptVersion === pin.promptVersion,
    tokens: row.tokens,
    spentUsd: row.spentUsd,
    cost: row.cost,
    minutes: minutesOf(row),
  };
}

type Built = { report: ComparisonReport } | "unreadable";

function buildReport(db: EvidenceDb, due: DueRow, payload: TrialJobPayload, project: Project | undefined, at: string): Built {
  const confirm = due.kind === "confirm";
  const ids = payload.tasks;
  const pins = payload.pins;
  const configurations = payload.request.configurations;
  if (ids === undefined || pins === undefined || ids.length > TASKS_MAX || pins.length !== configurations.length) return "unreadable";
  const rows = jobRows(db, due.job_id).filter(row => row.state === "final" && row.ending !== null);
  const known = taskRows(db, ids);
  const names = project === undefined ? new Map<string, string>() : areaNames(db, project);
  const byTask = new Map<string, StatTrial[]>();
  for (const row of rows) {
    const configuration = pins.findIndex(pin => pin.configRef === row.configRef);
    const pin = pins[configuration];
    if (pin === undefined) continue;
    const list = byTask.get(row.taskId) ?? [];
    list.push(statTrial(row, pin, configuration));
    byTask.set(row.taskId, list);
  }
  const tasks: StatTask[] = ids.map(id => {
    const row = known.get(id);
    return {
      key: id,
      area: (row?.area_ref == null ? undefined : names.get(row.area_ref)) ?? OTHER_AREA,
      promptOrigin: row?.prompt_origin ?? null,
      leftHoldout: confirm && (row === undefined || row.holdout !== 1),
      trials: byTask.get(id) ?? [],
    };
  });
  const stats = comparisonStats({
    seed: due.job_id,
    configurations: configurations.length,
    trialsPerTask: payload.request.trialsPerTask ?? TRIALS_PER_TASK_DEFAULT,
    plannedTasks: ids.length,
    tasks,
  });
  return {
    report: {
      ...stats,
      jobId: due.job_id,
      projectId: payload.projectId,
      kind: confirm ? "confirm" : "compare",
      set: confirm ? "holdout" : "dev",
      source: "replay",
      metric: "resolved",
      status: due.status,
      reason: due.reason,
      generatedAt: at,
      configurations: configurations.map((configuration, index) => ({
        index,
        profileId: configuration.profile.id,
        provider: configuration.profile.provider,
        profileEpoch: (pins[index] as ComparisonPin).profileEpoch,
        promptVersion: (pins[index] as ComparisonPin).promptVersion,
      })),
    },
  };
}

function writeReport(tx: EvidenceTx, due: DueRow, report: ComparisonReport | undefined, at: string): void {
  const expires = new Date(Date.parse(at) + REPORT_KEEP_DAYS * DAY_MS).toISOString();
  tx.run("INSERT OR IGNORE INTO eval_reports (job_id, project_ref, kind, state, generated_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    due.job_id, due.project_ref, due.kind, report === undefined ? "unreadable" : "ready", at, expires,
    tx.seal("eval_reports", due.job_id, report ?? {}));
}

function priorTasks(known: ReadonlyMap<string, TaskSqlRow>): Map<string, PriorTask> {
  const tasks = new Map<string, PriorTask>();
  for (const [id, row] of known) tasks.set(id, { areaRef: row.area_ref, kind: row.kind, promptOrigin: row.prompt_origin });
  return tasks;
}

export class ComparisonPass {
  private readonly store: EvidenceStore;
  private readonly config: Pick<Config, "projects">;
  private readonly now: () => string;

  constructor(options: { store: EvidenceStore; config: Pick<Config, "projects">; now?: () => string }) {
    this.store = options.store;
    this.config = options.config;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** At most one finished job per call. Never throws. */
  step(): "reported" | "waiting" | "idle" {
    try {
      const at = this.now();
      const due = this.store.read(db => {
        const candidates = db.all<DueRow>(REPORT_DUE_SQL);
        for (const candidate of candidates) {
          const waited = Date.parse(at) - Date.parse(candidate.finished_at) >= REPORT_SESSION_WAIT_MS;
          if (waited || db.get(SESSIONS_HELD_SQL, candidate.job_id) === undefined) return candidate;
        }
        return candidates.length === 0 ? undefined : "waiting" as const;
      });
      if (due === undefined) return "idle";
      if (due === "waiting") return "waiting";
      return this.store.write(tx => this.report(tx, due, at)) ? "reported" : "idle";
    } catch {
      return "waiting";
    }
  }

  private report(tx: EvidenceTx, due: DueRow, at: string): boolean {
    if (tx.run("UPDATE eval_jobs SET reported_at = ? WHERE job_id = ? AND reported_at IS NULL", at, due.job_id).changes === 0) return false;
    let payload: TrialJobPayload | undefined;
    try {
      payload = tx.open<TrialJobPayload>("eval_jobs", due.job_id, due.payload);
    } catch {
      payload = undefined;
    }
    const comparison = due.kind !== "baseline";
    if (payload === undefined) {
      if (comparison) {
        writeReport(tx, due, undefined, at);
        logUnreadable();
      }
      return true;
    }
    const project = this.config.projects.find(item => item.id === payload.projectId);
    if (comparison) {
      let built: Built;
      try {
        built = buildReport(tx, due, payload, project, at);
      } catch {
        built = "unreadable";
      }
      if (built === "unreadable") {
        writeReport(tx, due, undefined, at);
        logUnreadable();
        return true;
      }
      writeReport(tx, due, built.report, at);
    }
    if (due.kind === "confirm") return true;
    this.priors(tx, due, payload, at);
    return true;
  }

  private priors(tx: EvidenceTx, due: DueRow, payload: TrialJobPayload, at: string): void {
    let cells: ReturnType<typeof priorCells>;
    try {
      // Copies were counted by the job that ran them; exporting them again would count one trial twice.
      const rows = jobRows(tx, due.job_id).filter(row => !row.reused);
      const ids = payload.tasks ?? [...new Set(rows.map(row => row.taskId))].sort().slice(0, TASKS_MAX);
      const known = taskRows(tx, ids);
      cells = priorCells(payload.request.configurations, rows, priorTasks(known));
    } catch {
      // A job whose rows cannot be built keeps its stamp, so the queue moves on. The write below stays outside the try.
      logUnreadable();
      return;
    }
    writePriors(tx, { jobId: due.job_id, projectId: payload.projectId, cells, at });
  }
}

/** A stored report, or the refusal that says why there is none. */
export function reportFor(db: EvidenceDb, jobId: string): ComparisonReport | EvalRefusal {
  const stored = db.get<{ state: "ready" | "unreadable"; payload: string }>("SELECT state, payload FROM eval_reports WHERE job_id = ?", jobId);
  if (stored !== undefined) {
    if (stored.state === "ready") {
      try {
        return db.open<ComparisonReport>("eval_reports", jobId, stored.payload);
      } catch {
        return { status: 409, code: "report-unreadable" };
      }
    }
    return { status: 409, code: "report-unreadable" };
  }
  const job = db.get<{ kind: string }>("SELECT kind FROM eval_jobs WHERE job_id = ?", jobId);
  if (job === undefined) return { status: 404, code: "unknown-job" };
  if (job.kind === "validate" || job.kind === "baseline") return { status: 409, code: "no-report" };
  return { status: 409, code: "report-not-ready" };
}
