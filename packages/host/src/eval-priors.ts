import { createHash } from "node:crypto";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { configRef, trialProfileKey } from "./eval-trial-rules.js";
import { REPORT_KEEP_DAYS, type JobTrialRow } from "./eval-trial-store.js";
import { VOID_ENDINGS, type PromptOrigin, type ReplayPrior, type TrialConfiguration } from "./eval-types.js";
import type { Config } from "./types.js";

// The prior export: a finished baseline or compare job's graded trials, counted by cell, for the evidence router.
// A row holds ids, enumerations, counts, and times; the profile's provider, model, and effort are plain columns.

export const PRIOR_KEEP_DAYS = REPORT_KEEP_DAYS, PRIORS_MAX = 500;
export const PRIORS_SQL = "SELECT * FROM eval_priors WHERE project_ref = ? ORDER BY generated_at DESC, prior_id LIMIT 500";

const DAY_MS = 86_400_000;
const OTHER_AREA = "other";
const BUILT_IN_AREAS = ["mixed", "root"] as const;
type Project = Config["projects"][number];

export type PriorTask = { areaRef: string | null; kind: string | null; promptOrigin: PromptOrigin | null };
export type PriorCell = {
  configuration: number; profileId: string; provider: string; model: string | null; effort: string | null;
  areaRef: string | null; kind: string | null; promptOrigin: PromptOrigin; profileEpoch: number; promptVersion: string;
  tasks: number; trials: number; resolved: number;
};

type PriorRow = {
  prior_id: string; job_id: string; project_ref: string; configuration: number; profile_id: string; provider: string;
  model: string | null; effort: string | null; profile_epoch: number; prompt_version: string; area_ref: string | null;
  kind: string | null; prompt_origin: PromptOrigin; tasks: number; trials: number; resolved: number; generated_at: string;
};

const keyOf = (cell: Pick<PriorCell, "configuration" | "areaRef" | "kind" | "promptOrigin" | "profileEpoch" | "promptVersion">) =>
  JSON.stringify([cell.configuration, cell.areaRef, cell.kind, cell.promptOrigin, cell.profileEpoch, cell.promptVersion]);

/**
 * Counts the rows of one job by cell. A row counts when it is final, not void, isolated, and has a known `configId`, epoch,
 * and prompt version, and when its task has a known prompt origin. Cells are sorted by their key.
 */
export function priorCells(configurations: readonly TrialConfiguration[], rows: readonly JobTrialRow[], tasks: ReadonlyMap<string, PriorTask>): PriorCell[] {
  const indexOf = new Map(configurations.map((configuration, index) => [configRef(configuration), index]));
  const cells = new Map<string, PriorCell & { taskIds: Set<string> }>();
  for (const row of rows) {
    if (row.state !== "final" || row.ending === null || VOID_ENDINGS.includes(row.ending)) continue;
    if (row.isolation !== "isolated") continue;
    if (row.configId === null || row.profileEpoch === null || row.promptVersion === null) continue;
    const index = indexOf.get(row.configRef);
    const task = tasks.get(row.taskId);
    if (index === undefined || task === undefined || task.promptOrigin === null) continue;
    const base = { configuration: index, areaRef: task.areaRef, kind: task.kind, promptOrigin: task.promptOrigin,
      profileEpoch: row.profileEpoch, promptVersion: row.promptVersion };
    const key = keyOf(base);
    let cell = cells.get(key);
    if (cell === undefined) {
      const configuration = configurations[index]!;
      const profile = trialProfileKey(configuration.profile);
      cell = { ...base, profileId: configuration.profile.id, provider: profile.provider, model: profile.model, effort: profile.effort,
        tasks: 0, trials: 0, resolved: 0, taskIds: new Set() };
      cells.set(key, cell);
    }
    cell.taskIds.add(row.taskId);
    cell.trials += 1;
    if (row.resolved === true) cell.resolved += 1;
  }
  return [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { taskIds, ...cell }]) => ({ ...cell, tasks: taskIds.size }));
}

/**
 * Writes one row per cell, once: a second call for the same job and cells inserts nothing. Returns the number of rows inserted.
 */
export function writePriors(tx: EvidenceTx, input: { jobId: string; projectId: string; cells: readonly PriorCell[]; at: string }): number {
  const project = tx.index("project", input.projectId);
  const expires = new Date(Date.parse(input.at) + PRIOR_KEEP_DAYS * DAY_MS).toISOString();
  let written = 0;
  for (const cell of input.cells) {
    const priorId = createHash("sha256").update(`${input.jobId}\n${keyOf(cell)}`, "utf8").digest("hex");
    const result = tx.run(
      "INSERT OR IGNORE INTO eval_priors (prior_id, job_id, project_ref, configuration, profile_id, provider, model, effort, profile_epoch, "
      + "prompt_version, area_ref, kind, prompt_origin, tasks, trials, resolved, generated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      priorId, input.jobId, project, cell.configuration, cell.profileId, cell.provider, cell.model, cell.effort, cell.profileEpoch,
      cell.promptVersion, cell.areaRef, cell.kind, cell.promptOrigin, cell.tasks, cell.trials, cell.resolved, input.at, expires);
    written += result.changes;
  }
  return written;
}

/** The project's newest priors, at most PRIORS_MAX. An area the feature map no longer names reads `other`. */
export function readPriors(db: EvidenceDb, project: Project): ReplayPrior[] {
  const names = areaNames(db, project);
  return db.all<PriorRow>(PRIORS_SQL, db.index("project", project.id)).map(row => ({
    projectId: project.id,
    profileId: row.profile_id,
    profile: { provider: row.provider, model: row.model, effort: row.effort },
    profileEpoch: row.profile_epoch,
    promptVersion: row.prompt_version,
    role: "implementer",
    area: (row.area_ref === null ? undefined : names.get(row.area_ref)) ?? OTHER_AREA,
    kind: row.kind,
    tasks: row.tasks,
    trials: row.trials,
    resolved: row.resolved,
    source: "replay",
    promptOrigin: row.prompt_origin,
    generatedAt: row.generated_at,
    jobId: row.job_id,
  }));
}

/** The blind index of each area name the host knows: the feature map's areas, `mixed`, and `root`. */
export function areaNames(db: EvidenceDb, project: Project): Map<string, string> {
  const names = new Map<string, string>();
  for (const area of project.team?.features?.areas ?? []) names.set(db.index("area", area.id), area.id);
  for (const builtIn of BUILT_IN_AREAS) names.set(db.index("area", builtIn), builtIn);
  return names;
}
