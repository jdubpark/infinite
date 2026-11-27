import { createHash } from "node:crypto";
import type { TeamModelProfile, TeamRun, TeamTaskPlan } from "./team-types.js";
import type { Provider } from "./types.js";

export const MAX_OUTBOX_EVENTS = 2000;

export function runEventKey(kind: string, runId: string, parts: readonly (string | number)[] = []): string {
  return [kind, runId, ...parts].join(":");
}

export interface RunSummaryCounts {
  tasks: number; integrated: number; members: number; round: number; checks: number;
  recoveries: number; decisionsByOwner: number; decisionsByCoordinator: number;
  steering: number; permissionEscalations: number; continuations: number;
}

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

export function planDigest(tasks: readonly TeamTaskPlan[]): string {
  const tuples = tasks.map(task => [
    task.id, task.title, task.instructions, task.agentProfileId ?? null, task.paths, task.dependsOn, task.kind ?? null, task.risk ?? null,
    ...(task.criterionRefs ? [[task.criterionRefs.objectiveVersion, task.criterionRefs.criteria]] : []),
  ]);
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
}

export const PATH_FIELD_BUDGET = 12 * 1024;

export function pathField(paths: readonly string[], budget = PATH_FIELD_BUDGET): { paths: string[] } | { pathsOmitted: true } {
  return Buffer.byteLength(JSON.stringify(paths), "utf8") <= budget ? { paths: [...paths] } : { pathsOmitted: true };
}

export type ReplacementCause = "stall" | "limit" | "escalation" | "answer";

export interface ProfileIdentity { profileId?: string; provider: string; model?: string; effort?: string }

export function profileIdentity(profile: TeamModelProfile | undefined, provider: Provider): ProfileIdentity {
  if (!profile) return { provider };
  const effort = "effort" in profile ? profile.effort : profile.variant;
  return { profileId: profile.id, provider, model: profile.model, ...(effort === undefined ? {} : { effort }) };
}

export const MEMBER_STOP_REASONS = ["stall", "limit", "no-report", "owner", "host"] as const;
export type MemberStopReason = typeof MEMBER_STOP_REASONS[number];
export type MemberStopDetail = "pause" | "cancel" | "steer" | "block" | "retired";

export function appendRunEvent(run: TeamRun, text: string): void {
  run.events.push({ at: new Date().toISOString(), text });
  if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
}
