import type { RunEvent } from "./evidence/types.js";
import type { TeamContinuation, TeamMember, TeamRun, TeamTask } from "./team-types.js";

export type InterruptedSourceCode = "agent-question" | "agent-blocked";

export interface InterruptedTaskSample {
  runId: string;
  projectId: string;
  kind: "recovery" | "block";
  revision: number;
  at: string;
  sourceCode: InterruptedSourceCode;
  sourceMemberId?: string;
  sourceTaskId?: string;
  interruptedCount: number;
  unknown?: true;
  unknownReason?: string;
}

export interface InterruptedTaskReport {
  windowDays: number;
  since: string;
  until: string;
  projectId?: string;
  triggerThreshold: number;
  interruptedTasksTotal: number;
  triggerMet: boolean;
  recoveriesCounted: number;
  blocksCounted: number;
  unknownRecoveries: number;
  unknownBlocks: number;
  bySourceCode: Record<InterruptedSourceCode, number>;
  samples: InterruptedTaskSample[];
}

export interface InterruptedTaskOptions {
  projectId?: string;
  days?: number;
  now?: number;
}

const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;
const TRIGGER_THRESHOLD = 10;
const MAX_SAMPLES = 50;
const RECOVERY_REASON_RE = /^Automatic PM recovery after (agent-question|agent-blocked)(?::|\b)/;

function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function inWindow(iso: string | undefined, cutoffMs: number, nowMs: number): boolean {
  const ms = parseTime(iso);
  return ms !== undefined && ms >= cutoffMs && ms <= nowMs;
}

function isInterruptedSourceCode(value: unknown): value is InterruptedSourceCode {
  return value === "agent-question" || value === "agent-blocked";
}

function sourceCodeFromContinuationReason(reason: string): InterruptedSourceCode | undefined {
  const match = RECOVERY_REASON_RE.exec(reason);
  return match ? (match[1] as InterruptedSourceCode) : undefined;
}

function transitiveDependents(tasks: readonly TeamTask[], sourceTaskId: string): Set<string> {
  const dependentsOf = new Map<string, string[]>();
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      const children = dependentsOf.get(depId);
      if (children) children.push(task.id);
      else dependentsOf.set(depId, [task.id]);
    }
  }
  const visited = new Set<string>([sourceTaskId]);
  const queue = [sourceTaskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const childId of dependentsOf.get(current) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      queue.push(childId);
    }
  }
  return visited;
}

function findMember(run: TeamRun, memberId: string, revision: number): TeamMember | undefined {
  return run.members.find(member => member.memberId === memberId && member.revision === revision)
    ?? run.members.find(member => member.memberId === memberId);
}

function countUnblockedInterrupted(tasks: readonly TeamTask[], sourceTaskId: string): number {
  const excluded = transitiveDependents(tasks, sourceTaskId);
  return tasks.filter(task => task.status !== "integrated" && !excluded.has(task.id)).length;
}

function evaluateAttributedTasks(
  run: TeamRun,
  revision: number,
  tasks: readonly TeamTask[],
  sourceMemberId: string | undefined,
): { ok: true; sourceTaskId?: string; interruptedCount: number } | { ok: false; sourceMemberId?: string; sourceTaskId?: string; reason: string } {
  if (!sourceMemberId) {
    return { ok: false, reason: "missing-source-member" };
  }
  const member = findMember(run, sourceMemberId, revision);
  if (!member) {
    return { ok: false, sourceMemberId, reason: "unknown-source-member" };
  }
  const nonIntegrated = tasks.filter(task => task.status !== "integrated");
  if (member.taskId && tasks.some(task => task.id === member.taskId)) {
    return {
      ok: true,
      sourceTaskId: member.taskId,
      interruptedCount: countUnblockedInterrupted(tasks, member.taskId),
    };
  }
  if (member.role !== "implementer" && (!member.taskId || member.role === "scout") && nonIntegrated.length === 0) {
    return { ok: true, interruptedCount: 0 };
  }
  return {
    ok: false,
    sourceMemberId,
    ...(member.taskId ? { sourceTaskId: member.taskId } : {}),
    reason: "unmapped-source-task",
  };
}

export function computeInterruptedTaskMetrics(
  runs: readonly TeamRun[],
  eventsForRun: (runId: string) => readonly RunEvent[],
  options?: InterruptedTaskOptions,
): InterruptedTaskReport {
  const windowDays = options?.days ?? DEFAULT_DAYS;
  const now = options?.now ?? Date.now();
  const cutoffMs = now - windowDays * DAY_MS;
  const since = new Date(cutoffMs).toISOString();
  const until = new Date(now).toISOString();
  const projectId = options?.projectId;

  let interruptedTasksTotal = 0;
  let recoveriesCounted = 0;
  let blocksCounted = 0;
  let unknownRecoveries = 0;
  let unknownBlocks = 0;
  const bySourceCode: Record<InterruptedSourceCode, number> = {
    "agent-question": 0,
    "agent-blocked": 0,
  };
  const samples: InterruptedTaskSample[] = [];

  for (const run of runs) {
    if (run.replay) continue;
    if (projectId !== undefined && run.projectId !== projectId) continue;
    const continuations = run.continuations ?? [];
    if (run.revision <= 1 && continuations.length === 0 && run.status !== "blocked") continue;

    const events = eventsForRun(run.id);
    const continuationsByRevision = new Map<number, TeamContinuation>();
    for (const continuation of continuations) {
      continuationsByRevision.set(continuation.revision, continuation);
    }

    const handledRevisions = new Set<number>();
    const recoveryEvents = events.filter(
      event => event.kind === "run.revision-advanced"
        && event.data.cause === "automatic-recovery"
        && isInterruptedSourceCode(event.data.sourceCode),
    );

    for (const event of recoveryEvents) {
      const sourceCode = event.data.sourceCode as InterruptedSourceCode;
      const fromRevision = typeof event.data.fromRevision === "number" && Number.isSafeInteger(event.data.fromRevision)
        ? event.data.fromRevision
        : undefined;
      if (fromRevision === undefined) {
        if (!inWindow(event.at, cutoffMs, now)) continue;
        unknownRecoveries += 1;
        samples.push({
          runId: run.id,
          projectId: run.projectId,
          kind: "recovery",
          revision: Math.max(1, event.revision - 1),
          at: event.at,
          sourceCode,
          interruptedCount: 0,
          unknown: true,
          unknownReason: "missing-from-revision",
        });
        continue;
      }

      handledRevisions.add(fromRevision);
      const snapshot = continuationsByRevision.get(fromRevision);
      const at = snapshot && parseTime(snapshot.at) !== undefined ? snapshot.at : event.at;
      if (!inWindow(at, cutoffMs, now)) continue;

      if (!snapshot) {
        unknownRecoveries += 1;
        samples.push({
          runId: run.id,
          projectId: run.projectId,
          kind: "recovery",
          revision: fromRevision,
          at,
          sourceCode,
          interruptedCount: 0,
          unknown: true,
          unknownReason: "missing-continuation-snapshot",
        });
        continue;
      }

      const sourceMemberId = typeof event.data.sourceMemberId === "string" && event.data.sourceMemberId.length > 0
        ? event.data.sourceMemberId
        : undefined;
      const evaluation = evaluateAttributedTasks(run, fromRevision, snapshot.tasks, sourceMemberId);
      if (!evaluation.ok) {
        unknownRecoveries += 1;
        samples.push({
          runId: run.id,
          projectId: run.projectId,
          kind: "recovery",
          revision: fromRevision,
          at,
          sourceCode,
          ...(evaluation.sourceMemberId ? { sourceMemberId: evaluation.sourceMemberId } : {}),
          ...(evaluation.sourceTaskId ? { sourceTaskId: evaluation.sourceTaskId } : {}),
          interruptedCount: 0,
          unknown: true,
          unknownReason: evaluation.reason,
        });
        continue;
      }

      recoveriesCounted += 1;
      interruptedTasksTotal += evaluation.interruptedCount;
      bySourceCode[sourceCode] += evaluation.interruptedCount;
      samples.push({
        runId: run.id,
        projectId: run.projectId,
        kind: "recovery",
        revision: fromRevision,
        at,
        sourceCode,
        sourceMemberId: sourceMemberId!,
        ...(evaluation.sourceTaskId ? { sourceTaskId: evaluation.sourceTaskId } : {}),
        interruptedCount: evaluation.interruptedCount,
      });
    }

    for (const continuation of continuations) {
      if (handledRevisions.has(continuation.revision)) continue;
      const sourceCode = sourceCodeFromContinuationReason(continuation.reason);
      if (!sourceCode) continue;
      if (!inWindow(continuation.at, cutoffMs, now)) continue;
      unknownRecoveries += 1;
      samples.push({
        runId: run.id,
        projectId: run.projectId,
        kind: "recovery",
        revision: continuation.revision,
        at: continuation.at,
        sourceCode,
        interruptedCount: 0,
        unknown: true,
        unknownReason: "missing-revision-advanced-event",
      });
    }

    if (run.status === "blocked") {
      const blockEvent = events.filter(event => event.kind === "run.blocked" && event.revision === run.revision).at(-1);
      const sourceCode = isInterruptedSourceCode(run.blockCode)
        ? run.blockCode
        : isInterruptedSourceCode(blockEvent?.data.code)
          ? blockEvent.data.code
          : undefined;
      if (!sourceCode) continue;

      const at = blockEvent && parseTime(blockEvent.at) !== undefined ? blockEvent.at : (run.updatedAt ?? run.createdAt);
      if (!inWindow(at, cutoffMs, now)) continue;

      if (!blockEvent) {
        unknownBlocks += 1;
        samples.push({
          runId: run.id,
          projectId: run.projectId,
          kind: "block",
          revision: run.revision,
          at,
          sourceCode,
          interruptedCount: 0,
          unknown: true,
          unknownReason: "missing-blocked-event",
        });
        continue;
      }

      const sourceMemberId = typeof blockEvent.data.sourceMemberId === "string" && blockEvent.data.sourceMemberId.length > 0
        ? blockEvent.data.sourceMemberId
        : undefined;
      const evaluation = evaluateAttributedTasks(run, run.revision, run.tasks, sourceMemberId);
      if (!evaluation.ok) {
        unknownBlocks += 1;
        samples.push({
          runId: run.id,
          projectId: run.projectId,
          kind: "block",
          revision: run.revision,
          at,
          sourceCode,
          ...(evaluation.sourceMemberId ? { sourceMemberId: evaluation.sourceMemberId } : {}),
          ...(evaluation.sourceTaskId ? { sourceTaskId: evaluation.sourceTaskId } : {}),
          interruptedCount: 0,
          unknown: true,
          unknownReason: evaluation.reason,
        });
        continue;
      }

      blocksCounted += 1;
      interruptedTasksTotal += evaluation.interruptedCount;
      bySourceCode[sourceCode] += evaluation.interruptedCount;
      samples.push({
        runId: run.id,
        projectId: run.projectId,
        kind: "block",
        revision: run.revision,
        at,
        sourceCode,
        sourceMemberId: sourceMemberId!,
        ...(evaluation.sourceTaskId ? { sourceTaskId: evaluation.sourceTaskId } : {}),
        interruptedCount: evaluation.interruptedCount,
      });
    }
  }

  samples.sort((a, b) =>
    (parseTime(b.at) ?? 0) - (parseTime(a.at) ?? 0)
    || a.runId.localeCompare(b.runId)
    || b.revision - a.revision
    || a.kind.localeCompare(b.kind));

  return {
    windowDays,
    since,
    until,
    ...(projectId === undefined ? {} : { projectId }),
    triggerThreshold: TRIGGER_THRESHOLD,
    interruptedTasksTotal,
    triggerMet: interruptedTasksTotal >= TRIGGER_THRESHOLD,
    recoveriesCounted,
    blocksCounted,
    unknownRecoveries,
    unknownBlocks,
    bySourceCode,
    samples: samples.slice(0, MAX_SAMPLES),
  };
}
