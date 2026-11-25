import { canonicalJson } from "./evidence/crypto.js";
import type { EvalProjectSettings } from "./eval-config.js";
import type { Capsule, CapturedPayload, CaptureStart, EvalFeatures, MaterialState, ApprovalState, BaseState, NameRead, PromotionReason, StartReason } from "./eval-types.js";
import type { OutcomeRow } from "./outcome-store.js";
import { rowUse } from "./outcome-cells.js";
import { isTestPath, pathArea, type FeatureMap } from "./task-features.js";
import { decisionAuthorityQuestion, withoutCriteria, type TeamMember, type TeamRun, type TeamTask } from "./team-types.js";

export const CAPSULE_MAX_BYTES = 65_536;
export const REFERENCE_MAX_FILES = 500;
export const LATER_FILES_MAX = 2_000;

export function buildCapsule(run: TeamRun, task: TeamTask, member: TeamMember): Capsule | null {
  if (member.startedAt === undefined) return null;
  const startedAt = Date.parse(member.startedAt);
  const before = (at: string | undefined) => at !== undefined && Date.parse(at) < startedAt;
  const steering = run.steering.filter(entry => before(entry.at)).map(entry => entry.text);
  const ownerAnswers: Capsule["ownerAnswers"] = [];
  for (const decision of run.decisions) {
    if (decision.answeredBy === "owner" && decision.answer !== undefined && before(decision.answeredAt)) {
      ownerAnswers.push({ question: decisionAuthorityQuestion(decision), answer: decision.answer });
    }
  }
  return {
    objective: run.objective,
    steering,
    ownerAnswers,
    ...(run.brief ? { brief: run.brief } : {}),
    ...(run.goal ? { goal: withoutCriteria(run.goal) } : {}),
    task: { id: task.id, title: task.title, instructions: task.instructions, paths: [...task.paths] },
  };
}

export function captureStart(
  run: TeamRun,
  task: TeamTask,
  member: TeamMember,
  facts: { commit: string; head: string; at: string },
): CaptureStart {
  return {
    runId: run.id,
    memberId: member.memberId,
    projectId: run.projectId,
    workspace: run.workspace,
    anchorCommit: run.baseCommit,
    memberBaseCommit: member.baseCommit,
    commit: facts.commit,
    integratedHead: facts.head,
    at: facts.at,
    uiChanges: run.brief?.uiChanges === true,
    capsule: buildCapsule(run, task, member),
  };
}

export function capsuleBytes(capsule: Capsule): number {
  return Buffer.byteLength(canonicalJson(capsule), "utf8");
}

export function startVerdict(start: CaptureStart, settings: EvalProjectSettings, map: FeatureMap | undefined): StartReason | undefined {
  if (start.uiChanges) return "ui-changes";
  if (start.capsule === null) return "start-unknown";
  if (capsuleBytes(start.capsule) > CAPSULE_MAX_BYTES) return "capsule-too-large";
  const known = new Set((map?.areas ?? []).map(area => area.id));
  if ((settings.excludeAreas ?? []).some(id => !known.has(id))) return "excluded-area-unknown";
  return undefined;
}

export function evalTestPath(path: string, testPaths: EvalProjectSettings["testPaths"]): boolean {
  if (testPaths === undefined) return isTestPath(path);
  const prefixMatch = testPaths.prefixes.some(prefix => {
    const bare = prefix.replace(/\/$/, "");
    return path === bare || path.startsWith(`${bare}/`);
  });
  return prefixMatch || testPaths.suffixes.some(suffix => path.endsWith(suffix));
}

export function referenceVerdict(read: NameRead, settings: EvalProjectSettings, map: FeatureMap | undefined):
  { files: string[]; hiddenFiles: string[] } | { reason: "capture-failed" | "reference-too-wide" | "excluded-area" | "no-hidden-tests" } {
  if (read.state === "failed") return { reason: "capture-failed" };
  if (read.state === "too-wide" || read.names.length > REFERENCE_MAX_FILES) return { reason: "reference-too-wide" };
  const excluded = new Set(settings.excludeAreas ?? []);
  if (read.names.some(file => excluded.has(pathArea(file, map)))) return { reason: "excluded-area" };
  const files = [...read.names].sort();
  const hiddenFiles = files.filter(file => evalTestPath(file, settings.testPaths));
  if (hiddenFiles.length === 0 || hiddenFiles.length === files.length) return { reason: "no-hidden-tests" };
  return { files, hiddenFiles };
}

export function laterChange(files: readonly string[], later: readonly string[] | undefined): "none" | "changed" | "unknown" {
  if (later === undefined) return "unknown";
  const reference = new Set(files);
  return later.some(file => reference.has(file)) ? "changed" : "none";
}

export type PromotionFacts = {
  state: "captured" | "candidate";
  material: MaterialState;
  approval: ApprovalState | null;
  base: BaseState;
  runDeletedAt: string | null;
  payload: CapturedPayload;
};

export type Promotion = { kind: "wait" } | { kind: "candidate"; features: EvalFeatures } | { kind: "reject"; reason: PromotionReason };

export function promotion(task: PromotionFacts, row: OutcomeRow | undefined): Promotion {
  if (task.material === "pending" || task.approval === "pending" || task.base === "pending") return { kind: "wait" };

  if (row === undefined) {
    return task.state === "captured" && task.runDeletedAt !== null ? { kind: "reject", reason: "ledger-missing" } : { kind: "wait" };
  }

  const use = rowUse(row, "decision");
  if (use.kind === "open") return { kind: "wait" };
  if (use.kind === "withheld") {
    if (use.reason === "unfrozen") return { kind: "wait" };
    return { kind: "reject", reason: "ledger-withheld" };
  }
  if (use.kind === "excluded") return { kind: "reject", reason: "excluded" };

  if (row.flags.includes("same-model-review")) return { kind: "reject", reason: "same-model-review" };
  if (use.levels.accepted === 0) return { kind: "reject", reason: "not-accepted" };
  if (use.levels.accepted === null) return { kind: "reject", reason: "acceptance-unknown" };

  if (task.material === "partial") return { kind: "reject", reason: "patch-missing" };

  if (task.approval === null || task.approval === "unknown") return { kind: "reject", reason: "reference-unknown" };
  const change = task.payload.files === undefined ? "unknown" : laterChange(task.payload.files, task.payload.laterFiles);
  if (change === "unknown") return { kind: "reject", reason: "reference-unknown" };
  if (change === "changed") return { kind: "reject", reason: "reference-ambiguous" };

  if (task.base !== "proven") return { kind: "reject", reason: "base-not-proven" };

  const risk = row.risk === "normal" || row.risk === "elevated" ? row.risk : undefined;
  if (risk === undefined) return { kind: "reject", reason: "features-unknown" };

  return {
    kind: "candidate",
    features: { role: "implementer", area: row.payload.area, kind: row.kind, risk, featureVersion: row.featureVersion },
  };
}
