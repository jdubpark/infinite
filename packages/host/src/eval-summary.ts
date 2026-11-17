import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb } from "./evidence/types.js";
import { EvidenceError } from "./evidence/types.js";
import { captureSettings, EVAL_RETENTION_DAYS_DEFAULT, mineSettings } from "./eval-config.js";
import { groupStats } from "./eval-groups.js";
import {
  EVAL_MODULE,
  EVAL_STATES,
  type EvalJobView,
  type EvalOrigin,
  type EvalState,
  type EvalSummary,
  type GraderState,
  type MiningStatus,
} from "./eval-types.js";
import { queryCells } from "./outcome-reads.js";
import { OUTCOMES_MODULE } from "./outcome-store.js";
import type { Config } from "./types.js";

export const SUMMARY_AREAS_MAX = 64, SUMMARY_JOBS = 10, COVERAGE_DAYS_MAX = 730;
const DAY_MS = 86_400_000;
const ORIGINS: readonly EvalOrigin[] = ["captured", "mined"];
/** The area names the feature map does not define, which the host always knows. */
const BUILT_IN_AREAS = ["mixed", "root"] as const;
const OTHER_AREA = "other";

export const STATE_COUNTS_SQL = "SELECT origin, state, count(*) AS n FROM eval_tasks WHERE project_ref = ? GROUP BY origin, state";
export const AREA_COUNTS_SQL = "SELECT area_ref, state, count(*) AS n FROM eval_tasks WHERE project_ref = ? AND state IN ('candidate', 'valid') GROUP BY area_ref, state";
export const VALID_CAPTURED_SQL = "SELECT count(*) AS n FROM eval_tasks WHERE project_ref = ? AND origin = 'captured' AND state = 'valid' AND captured_at >= ?";

type StateRow = { origin: string; state: string; n: number };
type AreaRow = { area_ref: string | null; state: string; n: number };
type Project = Config["projects"][number];

export type SummaryInput = {
  project: Project;
  mining: MiningStatus;
  grader: GraderState;
  /** The project's newest jobs, as `EvalJobs.projectJobs` returns them. */
  jobs: EvalJobView[];
  now: string;
};

/**
 * The corpus summary of one project: counts by state and origin, the areas of candidate and valid rows, the group stats,
 * the coverage, and the grader's state. Reads six indexed statements and one outcome read; opens no sealed payload.
 * Throws `EvidenceError` `unavailable` when the corpus module or the store is not available.
 */
export function evalSummary(store: EvidenceStore, input: SummaryInput): EvalSummary {
  if (store.status().modules[EVAL_MODULE] !== "ready") {
    throw new EvidenceError("unavailable", "The eval corpus is unavailable.");
  }
  const { project, now } = input;
  const days = Math.min(project.team?.eval?.retentionDays ?? EVAL_RETENTION_DAYS_DEFAULT, COVERAGE_DAYS_MAX);
  const since = new Date(Date.parse(now) - days * DAY_MS).toISOString();
  const counted = store.read(db => {
    const ref = db.index("project", project.id);
    return {
      states: db.all<StateRow>(STATE_COUNTS_SQL, ref),
      areas: areaCounts(db, ref, project),
      validCaptured: db.get<{ n: number }>(VALID_CAPTURED_SQL, ref, since)?.n ?? 0,
      groups: groupStats(db, ref),
    };
  });
  return {
    projectId: project.id,
    capture: { on: captureSettings(project) !== undefined },
    mining: {
      on: mineSettings(project) !== undefined,
      state: input.mining.state,
      visited: input.mining.visited,
      mined: input.mining.mined,
      skipped: input.mining.skipped,
      failures: input.mining.failures,
      backfillDone: input.mining.backfillDone,
    },
    tasks: { ...tasksOf(counted.states), byArea: counted.areas, bySet: null },
    groups: counted.groups,
    coverage: coverageOf(store, project, counted.validCaptured, days, now),
    grader: { state: input.grader },
    jobs: input.jobs.slice(0, SUMMARY_JOBS),
  };
}

/** Counts by origin and state. A state with no row is 0: a count over existing rows is a fact. */
function tasksOf(rows: readonly StateRow[]): { byState: Record<EvalState, number>; byOrigin: Record<EvalOrigin, Record<EvalState, number>> } {
  const byOrigin = { captured: zeros(), mined: zeros() } as Record<EvalOrigin, Record<EvalState, number>>;
  for (const row of rows) {
    const origin = ORIGINS.find(name => name === row.origin);
    const state = EVAL_STATES.find(name => name === row.state);
    if (origin !== undefined && state !== undefined) byOrigin[origin][state] += row.n;
  }
  const byState = zeros();
  for (const origin of ORIGINS) for (const state of EVAL_STATES) byState[state] += byOrigin[origin][state];
  return { byState, byOrigin };
}

/**
 * Candidate and valid rows by area. A reference maps to a feature-map area, `mixed`, or `root`; any other reference counts
 * under `other`. Past SUMMARY_AREAS_MAX names, the names after the first 63 count under `other`.
 */
function areaCounts(db: EvidenceDb, ref: string, project: Project): { area: string; candidate: number; valid: number }[] {
  const names = new Map<string, string>();
  for (const area of project.team?.features?.areas ?? []) names.set(db.index("area", area.id), area.id);
  for (const builtIn of BUILT_IN_AREAS) names.set(db.index("area", builtIn), builtIn);
  const totals = new Map<string, { candidate: number; valid: number }>();
  for (const row of db.all<AreaRow>(AREA_COUNTS_SQL, ref)) {
    const name = (row.area_ref === null ? undefined : names.get(row.area_ref)) ?? OTHER_AREA;
    const total = totals.get(name) ?? { candidate: 0, valid: 0 };
    if (row.state === "candidate") total.candidate += row.n;
    if (row.state === "valid") total.valid += row.n;
    totals.set(name, total);
  }
  const sorted = [...totals.entries()].sort(([a], [b]) => compareText(a, b));
  const kept = sorted.slice(0, SUMMARY_AREAS_MAX - 1);
  const rest = sorted.slice(SUMMARY_AREAS_MAX - 1);
  const folded = new Map(kept);
  if (rest.length > 0) {
    const other = folded.get(OTHER_AREA) ?? { candidate: 0, valid: 0 };
    for (const [, total] of rest) {
      other.candidate += total.candidate;
      other.valid += total.valid;
    }
    folded.set(OTHER_AREA, other);
  }
  return [...folded.entries()].sort(([a], [b]) => compareText(a, b)).map(([area, total]) => ({ area, ...total }));
}

/**
 * The share of accepted attempts that a valid captured task stands for. Null when the ledger is not ready, when a read
 * was unreadable, or when no attempt is accepted: unknown is never a number.
 */
function coverageOf(
  store: EvidenceStore,
  project: Project,
  validCaptured: number,
  days: number,
  now: string,
): EvalSummary["coverage"] {
  if (store.status().modules[OUTCOMES_MODULE] !== "ready") return null;
  const result = queryCells(store, {
    use: "display", sources: ["production"], by: [], role: "implementer", projectId: project.id, days,
  }, { now });
  if (result.unreadable > 0) return null;
  const accepted = result.cells.reduce((sum, cell) => sum + cell.levels.accepted.yes, 0);
  if (accepted === 0) return null;
  return { days, validCaptured, accepted, share: validCaptured / accepted };
}

function zeros(): Record<EvalState, number> {
  return { captured: 0, candidate: 0, valid: 0, rejected: 0, retired: 0 };
}

/** Code-unit order, the order SQLite's BINARY collation gives for these keys. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
