import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { profileIdentityKey } from "./config-identity.js";
import { epochAt } from "./configuration-store.js";
import { canonicalJson } from "./evidence/crypto.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { CONFIRM_TASKS_MIN, TRIAL_TASKS_SQL, type TrialTaskRow } from "./eval-sets.js";
import { configRef, TRIAL_HARNESS_VERSION, trialProfileKey, trialPromptVersion } from "./eval-trial-rules.js";
import { insertCopy, REUSE_DAYS, reusable, type ReuseSource } from "./eval-trial-store.js";
import {
  evalConfigurationSchema, evalTaskIdSchema, evalWindowSchema, PROMPT_ORIGINS,
  type ComparisonJobRequest, type ComparisonPin, type EvalRefusal, type TrialConfiguration,
} from "./eval-types.js";
import { ID_RE } from "./schema-primitives.js";

export const COMPARE_TASKS_MIN = 2, COMPARISON_TASKS_DEFAULT = 20;

const COMPARISON_TASKS_MAX = 200, TRIALS_PER_TASK_DEFAULT = 3, TRIALS_PER_TASK_MAX = 5, MAX_TRIALS_MAX = 1_000;
const SELECTION_PAGES_MAX = 100, EXCLUDED_GROUPS_MAX = 200, GROUP_ID_MAX = 64;
const DAY_MS = 86_400_000;

const distinct = (list: unknown[]) => new Set(list.map(item => configRef(item as TrialConfiguration))).size === list.length;

const comparisonShape = z.object({
  kind: z.enum(["compare", "confirm"]),
  configurations: z.array(evalConfigurationSchema).min(2).max(4).refine(distinct, "Two configurations name one configRef"),
  taskFilter: z.object({
    taskIds: z.array(evalTaskIdSchema).max(COMPARISON_TASKS_MAX).optional(),
    origins: z.array(z.enum(["captured", "mined"])).max(2).optional(),
    areas: z.array(z.string().regex(ID_RE)).max(32).optional(),
    promptOrigins: z.array(z.enum(PROMPT_ORIGINS)).max(PROMPT_ORIGINS.length).optional(),
    excludeGroups: z.array(z.string().min(1).max(GROUP_ID_MAX)).max(EXCLUDED_GROUPS_MAX).optional(),
    maxTasks: z.number().int().min(1).max(COMPARISON_TASKS_MAX).optional(),
  }).strict().optional(),
  trialsPerTask: z.number().int().min(1).max(TRIALS_PER_TASK_MAX).optional(),
  limits: z.object({
    maxTrials: z.number().int().min(1).max(MAX_TRIALS_MAX),
    maxWallMinutes: z.number().int().min(10).max(43_200),
  }).strict(),
  windows: z.array(evalWindowSchema).min(1).max(4).optional(),
  expiresAt: z.iso.datetime().optional(),
}).strict();

export const comparisonJobSchema = comparisonShape
  .refine(request => request.kind !== "confirm" || request.configurations.length === 2, "A confirm job compares exactly two configurations")
  .refine(request => request.kind !== "confirm" || request.taskFilter?.taskIds === undefined, "A confirm job admits no taskIds")
  .refine(request => request.kind !== "confirm" || request.taskFilter?.excludeGroups === undefined, "A confirm job admits no excludeGroups") as unknown as z.ZodType<ComparisonJobRequest>;

export type ComparisonPlan = {
  tasks: string[]; pins: ComparisonPin[]; subject?: string; roots: string[];
  copies: { taskId: string; configuration: number; slot: number; source: ReuseSource }[];
  slots: number; planned: { tasks: number; trials: number };
};

export function pinsOf(db: EvidenceDb, configurations: readonly TrialConfiguration[], at: string): ComparisonPin[] {
  return configurations.map(configuration => ({
    configRef: configRef(configuration),
    profileEpoch: epochAt(db, profileIdentityKey(trialProfileKey(configuration.profile)), at),
    promptVersion: trialPromptVersion(configuration.profile),
  }));
}

export function subjectOf(pins: readonly ComparisonPin[]): string {
  const sorted = [...pins].sort((a, b) => (a.configRef < b.configRef ? -1 : a.configRef > b.configRef ? 1 : 0));
  return createHash("sha256").update(canonicalJson(sorted), "utf8").digest("hex");
}

export function pinsChanged(db: EvidenceDb, configurations: readonly TrialConfiguration[], pins: readonly ComparisonPin[], at: string): boolean {
  const now = pinsOf(db, configurations, at);
  if (now.length !== pins.length) return true;
  return now.some((pin, index) => {
    const pinned = pins[index];
    return pinned === undefined || pin.configRef !== pinned.configRef || pin.profileEpoch !== pinned.profileEpoch
      || pin.promptVersion !== pinned.promptVersion;
  });
}

export function planComparison(tx: EvidenceTx, input: { projectId: string; request: ComparisonJobRequest; at: string }): ComparisonPlan | EvalRefusal {
  const { request, at } = input;
  const confirm = request.kind === "confirm";
  const ref = tx.index("project", input.projectId);
  const pins = pinsOf(tx, request.configurations, at);
  const subject = confirm ? subjectOf(pins) : undefined;
  if (subject !== undefined && tx.get("SELECT 1 FROM eval_subjects WHERE project_ref = ? AND subject = ?", ref, subject) !== undefined) {
    return { status: 409, code: "subject-confirmed" };
  }
  const filter = request.taskFilter;
  const maxTasks = filter?.maxTasks ?? COMPARISON_TASKS_DEFAULT;
  const ids = filter?.taskIds === undefined || confirm ? undefined : new Set(filter.taskIds);
  const origins = filter?.origins === undefined ? undefined : new Set<string>(filter.origins);
  const promptOrigins = filter?.promptOrigins === undefined ? undefined : new Set<string>(filter.promptOrigins);
  const areas = filter?.areas === undefined ? undefined : new Set(filter.areas.map(area => tx.index("area", area)));
  const excluded = filter?.excludeGroups === undefined || confirm ? undefined : new Set(filter.excludeGroups);
  const wanted = confirm ? 1 : 0;
  const tasks: string[] = [];
  const roots = new Set<string>();
  let after = "";
  for (let page = 0; page < SELECTION_PAGES_MAX && tasks.length < maxTasks; page += 1) {
    const rows = tx.all<TrialTaskRow>(TRIAL_TASKS_SQL, ref, after);
    for (const row of rows) {
      after = row.task_id;
      if (tasks.length >= maxTasks) break;
      if (row.holdout !== wanted) continue;
      if (ids !== undefined && !ids.has(row.task_id)) continue;
      if (origins !== undefined && !origins.has(row.origin)) continue;
      if (areas !== undefined && (row.area_ref === null || !areas.has(row.area_ref))) continue;
      if (promptOrigins !== undefined && (row.prompt_origin === null || !promptOrigins.has(row.prompt_origin))) continue;
      if (excluded !== undefined && excluded.has(row.root_id)) continue;
      tasks.push(row.task_id);
      roots.add(row.root_id);
    }
    if (rows.length === 0) break;
  }
  if (tasks.length < (confirm ? CONFIRM_TASKS_MIN : COMPARE_TASKS_MIN)) return { status: 409, code: "too-few-tasks" };
  const trialsPerTask = request.trialsPerTask ?? TRIALS_PER_TASK_DEFAULT;
  const copies: ComparisonPlan["copies"] = [];
  if (!confirm) {
    const since = new Date(Date.parse(at) - REUSE_DAYS * DAY_MS).toISOString();
    for (const taskId of tasks) {
      request.configurations.forEach((_, configuration) => {
        const pin = pins[configuration] as ComparisonPin;
        const sources = reusable(tx, {
          taskId, configRef: pin.configRef, promptVersion: pin.promptVersion, profileEpoch: pin.profileEpoch,
          harness: TRIAL_HARNESS_VERSION, since, limit: trialsPerTask,
        });
        sources.forEach((source, slot) => copies.push({ taskId, configuration, slot, source }));
      });
    }
  }
  const slots = tasks.length * request.configurations.length * trialsPerTask;
  return {
    tasks, pins, subject, roots: confirm ? [...roots] : [], copies, slots,
    planned: { tasks: tasks.length, trials: Math.max(0, Math.min(request.limits.maxTrials, slots - copies.length)) },
  };
}

export function applyComparison(tx: EvidenceTx, input: { jobId: string; projectId: string; request: ComparisonJobRequest;
  plan: ComparisonPlan; keepDays: number; at: string }): "scheduled" | "complete" {
  const { plan, request } = input;
  for (const copy of plan.copies) {
    const pin = plan.pins[copy.configuration] as ComparisonPin;
    insertCopy(tx, {
      trialId: randomUUID(), jobId: input.jobId, taskId: copy.taskId, projectId: input.projectId,
      configuration: request.configurations[copy.configuration] as TrialConfiguration, slot: copy.slot,
      promptVersion: pin.promptVersion, source: copy.source, keepDays: input.keepDays,
    }, input.at);
  }
  if (plan.subject !== undefined) {
    if (plan.roots.length > 0) {
      tx.run(`UPDATE eval_groups SET confirms = confirms + 1 WHERE group_id IN (${plan.roots.map(() => "?").join(", ")})`, ...plan.roots);
    }
    tx.run("INSERT INTO eval_subjects (project_ref, subject, job_id, created_at) VALUES (?, ?, ?, ?)",
      tx.index("project", input.projectId), plan.subject, input.jobId, input.at);
  }
  return plan.copies.length === plan.slots ? "complete" : "scheduled";
}
