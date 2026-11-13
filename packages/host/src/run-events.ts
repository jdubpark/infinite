import { createHash } from "node:crypto";
import type { TeamModelProfile, TeamRun, TeamTaskPlan } from "./team-types.js";
import type { Provider } from "./types.js";

/** The most events one run keeps waiting for the store. */
export const MAX_OUTBOX_EVENTS = 2000;

/** `[kind, runId, ...parts].join(":")`. A part is a string or a number. */
export function runEventKey(kind: string, runId: string, parts: readonly (string | number)[] = []): string {
  return [kind, runId, ...parts].join(":");
}

export interface RunSummaryCounts {
  tasks: number; integrated: number; members: number; round: number; checks: number;
  recoveries: number; decisionsByOwner: number; decisionsByCoordinator: number;
  steering: number; permissionEscalations: number; continuations: number;
}

/** Counts from the run record as it is now. Numbers only. */
export function runSummaryCounts(run: TeamRun): RunSummaryCounts {
  return {
    tasks: run.tasks.length,
    integrated: run.tasks.filter(task => task.status === "integrated").length,
    members: run.members.length,
    round: run.round,
    checks: run.checks.length,
    recoveries: run.recovery?.attempts ?? 0,
    decisionsByOwner: run.decisions.filter(decision => decision.answeredBy === "owner").length,
    decisionsByCoordinator: run.decisions.filter(decision => decision.answeredBy === "coordinator").length,
    steering: run.steering.length,
    permissionEscalations: (run.permissionDecisions ?? []).filter(decision => decision.status === "escalated").length,
    continuations: run.continuations?.length ?? 0,
  };
}

/** SHA-256 hex of the JSON of one tuple per task, in order, covering every field a plan sets. */
export function planDigest(tasks: readonly TeamTaskPlan[]): string {
  const tuples = tasks.map(task => [task.id, task.title, task.instructions, task.agentProfileId ?? null, task.paths, task.dependsOn, task.kind ?? null, task.risk ?? null]);
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
}

/** The most UTF-8 bytes of an owned-path list one event keeps. The store refuses data over 16 KiB. */
export const PATH_FIELD_BUDGET = 12 * 1024;

/** `{ paths }` when the UTF-8 JSON of the list is at most `budget` bytes, else `{ pathsOmitted: true }`. */
export function pathField(paths: readonly string[], budget = PATH_FIELD_BUDGET): { paths: string[] } | { pathsOmitted: true } {
  return Buffer.byteLength(JSON.stringify(paths), "utf8") <= budget ? { paths: [...paths] } : { pathsOmitted: true };
}

/** Why a replacement member continues a stopped one. */
export type ReplacementCause = "stall" | "limit" | "escalation" | "answer";

export interface ProfileIdentity { profileId?: string; provider: string; model?: string; effort?: string }

/** Umbrella C7's profile identity. `effort` is the profile's effort, or its variant for OpenCode. */
export function profileIdentity(profile: TeamModelProfile | undefined, provider: Provider): ProfileIdentity {
  if (!profile) return { provider };
  const effort = "effort" in profile ? profile.effort : profile.variant;
  return { profileId: profile.id, provider, model: profile.model, ...(effort === undefined ? {} : { effort }) };
}
