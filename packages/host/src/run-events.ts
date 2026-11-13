import type { TeamRun } from "./team-types.js";

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
