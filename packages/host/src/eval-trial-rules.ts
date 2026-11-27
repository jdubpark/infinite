import { createHash } from "node:crypto";
import { canonicalJson } from "./evidence/crypto.js";
import { profileIdentityKey, promptVersion, type ProfileKey } from "./config-identity.js";
import { profileIdentity } from "./run-events.js";
import type { ParsedReport } from "./eval-report.js";
import type { TeamModelProfile } from "./team-types.js";
import { VOID_ENDINGS, type EvalIdentityState, type TrialConfiguration, type TrialEnding, type TrialGrade, type TrialState } from "./eval-types.js";

export const TRIAL_HARNESS_VERSION = 1, VOID_ATTEMPTS_MAX = 3, VOID_STREAK_PAUSE = 3;
export const TRIAL_RELEASES = 10;

export type SlotRow = { taskId: string; configRef: string; slot: number; attempt: number; state: TrialState; ending: TrialEnding | null };

export type GradeFacts = {
  ending: TrialEnding;
  expected: readonly string[];
  report?: ParsedReport;
  guard?: "passed" | "failed";
  overwritten: number; diff: TrialGrade["diff"]; isolation: "isolated" | "none";
};

type IdentityProbe = { state: EvalIdentityState; fetch?: "refused" | "open" | "skipped" };

const slotKey = (taskId: string, configRef: string, slot: number) => JSON.stringify([taskId, configRef, slot]);

export function gradeOf(facts: GradeFacts): TrialGrade {
  const expectedTotal = facts.expected.length;
  const common = { ending: facts.ending, expectedTotal, overwritten: facts.overwritten, diff: facts.diff, isolation: facts.isolation };
  if (facts.ending !== "graded") return { ...common, expectedPassed: null, guardPassed: null, resolved: false };
  const cases = facts.report?.state === "parsed" ? facts.report.cases : undefined;
  const expectedPassed = cases ? facts.expected.filter(key => cases.get(key) === "passed").length : null;
  const guardPassed = facts.guard === undefined ? null : facts.guard === "passed";
  const resolved = expectedPassed !== null && expectedPassed === expectedTotal && expectedTotal > 0 && guardPassed === true;
  return { ...common, expectedPassed, guardPassed, resolved };
}

export function restoreSet(input: { referenceChanged: readonly string[]; resultChanged: readonly string[]; hiddenFiles: readonly string[];
  gradingPaths: readonly string[]; testPath: (path: string) => boolean }): { restore: string[]; overwritten: number } {
  const covered = (path: string) => input.gradingPaths.some(grading => path === grading || path.startsWith(`${grading}/`));
  const restore = new Set<string>(input.hiddenFiles);
  for (const path of new Set([...input.referenceChanged, ...input.resultChanged])) {
    if (input.testPath(path) || covered(path)) restore.add(path);
  }
  const overwritten = [...new Set(input.resultChanged)].filter(path => restore.has(path)).length;
  return { restore: [...restore].sort(), overwritten };
}

export function nextSlot(input: { tasks: readonly string[]; configRefs: readonly string[]; trialsPerTask: number; rows: readonly SlotRow[] }):
  { taskId: string; configRef: string; slot: number; attempt: number } | undefined {
  const bySlot = new Map<string, SlotRow[]>();
  for (const row of input.rows) {
    const key = slotKey(row.taskId, row.configRef, row.slot);
    const list = bySlot.get(key);
    if (list) list.push(row);
    else bySlot.set(key, [row]);
  }
  for (const taskId of input.tasks) {
    for (let slot = 0; slot < input.trialsPerTask; slot += 1) {
      for (const configRef of input.configRefs) {
        const rows = bySlot.get(slotKey(taskId, configRef, slot)) ?? [];
        const done = rows.some(row => row.state === "final" && row.ending !== null && !VOID_ENDINGS.includes(row.ending));
        if (done || rows.length >= VOID_ATTEMPTS_MAX) continue;
        return { taskId, configRef, slot, attempt: rows.length };
      }
    }
  }
  return undefined;
}

export function isolationLabel(input: { probe: IdentityProbe; sourceClean: boolean }): "isolated" | "none" {
  return input.probe.state === "ready" && input.probe.fetch === "refused" && input.sourceClean ? "isolated" : "none";
}

export function trialPromptVersion(profile: TeamModelProfile): string {
  const canonical = JSON.parse(canonicalJson(profile)) as TeamModelProfile;
  return promptVersion("implementer", canonical.provider, canonical, false, false, false);
}

export function trialProfileKey(profile: TeamModelProfile): ProfileKey {
  const identity = profileIdentity(profile, profile.provider);
  return { provider: identity.provider, model: identity.model ?? null, effort: identity.effort ?? null };
}

export function configRef(configuration: TrialConfiguration): string {
  const profile = configuration.profile;
  const key: ProfileKey = {
    provider: profile.provider,
    model: profile.model,
    effort: ("effort" in profile ? profile.effort : profile.variant) ?? null,
  };
  const identity = canonicalJson({ profile: profileIdentityKey(key), guidance: configuration.guidance, knowledge: configuration.knowledge });
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

export function endingOfBlock(code: string | undefined): TrialEnding {
  switch (code) {
    case "task-scope-violation": return "scope-violation";
    case "missing-agent-report": return "no-result";
    case "halted": return "void-owner";
    default: return "void-host";
  }
}

export function endingOfReport(kind: "question" | "blocked" | "escalate"): TrialEnding {
  switch (kind) {
    case "question": return "question";
    case "blocked": return "blocked";
    case "escalate": return "escalated";
  }
}
