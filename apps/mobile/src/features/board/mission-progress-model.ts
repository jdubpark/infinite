import type {
  MissionProgressChild,
  MissionProgressObservation,
  MissionProgressPage,
  MissionProgressResyncReason,
  MissionProgressSnapshot,
} from "../../api/client";
import { TEAM_LABELS } from "../teams/model";

export type MissionProgressSubtaskEntry = {
  subtask: MissionProgressSnapshot["subtasks"][number];
  replacedBySubtaskId?: string;
  replacesSubtaskId?: string;
};

export type MissionProgressSubtaskPartition = {
  active: MissionProgressSubtaskEntry[];
  finished: MissionProgressSubtaskEntry[];
};

export type MissionProgressState = {
  missionId: string;
  generation?: string;
  cursor?: string;
  snapshot?: MissionProgressSnapshot;
  observations: MissionProgressObservation[];
  resyncNotice?: string;
  lastResyncReason?: MissionProgressResyncReason;
  lastUpdatedAt?: string;
};

const MAX_RETAINED_OBSERVATIONS = 24;

export function createMissionProgressState(missionId: string): MissionProgressState {
  return {
    missionId,
    observations: [],
  };
}

export function resyncNoticeForReason(reason: MissionProgressResyncReason, generationChanged = false): string | undefined {
  switch (reason) {
    case "initial":
      return generationChanged ? "Resynchronized after host restart." : undefined;
    case "host-restarted":
      return "Resynchronized after host restart.";
    case "history-evicted":
      return "Resynchronized after cursor eviction.";
    case "retention-gap":
      return "Resynchronized after observation retention gap.";
    case "invalid-cursor":
      return "Resynchronized after invalid cursor.";
    case "cursor-ahead":
      return "Resynchronized after cursor reset.";
    case "mission-mismatch":
      return "Resynchronized for the current mission.";
  }
}

export function applyMissionProgressPage(state: MissionProgressState, page: MissionProgressPage): MissionProgressState {
  const missionChanged = state.missionId !== page.missionId;
  const generationChanged = state.generation !== undefined && state.generation !== page.generation;
  const needsResync = missionChanged || generationChanged || page.resync.required;

  if (needsResync) {
    const reason: MissionProgressResyncReason = page.resync.required
      ? page.resync.reason
      : generationChanged
        ? "host-restarted"
        : "mission-mismatch";
    const notice = resyncNoticeForReason(reason, generationChanged);
    return {
      missionId: page.missionId,
      generation: page.generation,
      cursor: page.cursor,
      snapshot: page.snapshot,
      observations: [...page.observations].slice(-MAX_RETAINED_OBSERVATIONS),
      ...(notice ? { resyncNotice: notice } : {}),
      lastResyncReason: reason,
      lastUpdatedAt: page.observedAt,
    };
  }

  const bySequence = new Map<number, MissionProgressObservation>();
  for (const item of state.observations) bySequence.set(item.sequence, item);
  for (const item of page.observations) bySequence.set(item.sequence, item);
  const merged = [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_RETAINED_OBSERVATIONS);

  return {
    missionId: page.missionId,
    generation: page.generation,
    cursor: page.cursor,
    snapshot: page.snapshot,
    observations: merged,
    ...(state.resyncNotice ? { resyncNotice: state.resyncNotice } : {}),
    ...(state.lastResyncReason ? { lastResyncReason: state.lastResyncReason } : {}),
    lastUpdatedAt: page.observedAt,
  };
}

export function dismissMissionProgressNotice(state: MissionProgressState): MissionProgressState {
  if (!state.resyncNotice) return state;
  const { resyncNotice: _removed, ...rest } = state;
  return rest;
}

export function partitionMissionSubtasks(
  subtasks: readonly MissionProgressSnapshot["subtasks"][number][],
): MissionProgressSubtaskPartition {
  const subtaskIds = new Set(subtasks.map(item => item.id));
  const replacedBy = new Map<string, string>();
  const replaces = new Map<string, string>();

  for (const subtask of subtasks) {
    const prior = subtask.replacesSubtaskId;
    if (prior && prior !== subtask.id && subtaskIds.has(prior)) {
      replacedBy.set(prior, subtask.id);
      replaces.set(subtask.id, prior);
    }
  }

  const active: MissionProgressSubtaskEntry[] = [];
  const finished: MissionProgressSubtaskEntry[] = [];

  for (const subtask of subtasks) {
    const entry: MissionProgressSubtaskEntry = {
      subtask,
      ...(replacedBy.has(subtask.id) ? { replacedBySubtaskId: replacedBy.get(subtask.id) } : {}),
      ...(replaces.has(subtask.id) ? { replacesSubtaskId: replaces.get(subtask.id) } : {}),
    };
    if (subtask.status === "done" || subtask.status === "cancelled") finished.push(entry);
    else active.push(entry);
  }

  return { active, finished };
}

const STATUS_AWAITING_WORKER = new Set(["running", "waiting", "reported", "unavailable"]);

export function summarizeMissionProgressChild(child: MissionProgressChild): string {
  if (child.kind === "not-created") return "Team not created yet";
  if (child.kind === "missing") return "Child team record missing";
  if (child.kind === "mismatched") return "Child team mismatch";

  const teamLabel = TEAM_LABELS[child.status] ?? child.status;
  const assignments = child.assignments;
  const recordedActive = assignments.filter(
    member => member.recordedStatus === "running" || member.recordedStatus === "waiting",
  ).length;
  const liveWorkers = assignments.filter(
    member => member.workerStatus === "running" || member.workerStatus === "starting",
  ).length;

  let sampledAwaiting = 0;
  let unsampledAwaiting = 0;
  let unknownAwaiting = 0;
  const issueCounts = new Map<string, number>();
  const bump = (label: string) => issueCounts.set(label, (issueCounts.get(label) ?? 0) + 1);

  for (const member of assignments) {
    const expectedActive = member.recordedStatus === "running" || member.recordedStatus === "waiting";
    const awaitingWorker = STATUS_AWAITING_WORKER.has(member.recordedStatus) && !member.exitConfirmedAt;
    if (awaitingWorker) {
      if (member.workerStatus === "not-sampled") {
        unsampledAwaiting += 1;
      } else if (member.workerStatus === "unknown") {
        unknownAwaiting += 1;
      } else {
        sampledAwaiting += 1;
      }
    }
    if (member.workerStatus === "recording-error" || member.workerStatus === "unavailable" || member.workerStatus === "mismatched") {
      bump(member.workerStatus);
    } else if (expectedActive && member.workerStatus === "exited") {
      bump("exited");
    } else if (awaitingWorker && (member.workerStatus === "unknown" || member.workerStatus === "not-sampled")) {
      bump(member.workerStatus);
    }
  }

  let assignmentText: string;
  let workerText: string | undefined;
  if (assignments.length === 0) {
    assignmentText = child.assignmentsTruncated ? "assignments truncated" : "0 assignments";
  } else {
    assignmentText = child.assignmentsTruncated
      ? `recorded ${recordedActive} active (${assignments.length} shown, truncated)`
      : `recorded ${recordedActive}/${assignments.length} active`;
    const incompleteSampling = Boolean(child.assignmentsTruncated) || unsampledAwaiting > 0 || unknownAwaiting > 0;
    const issueSummary = [...issueCounts.entries()].map(([label, count]) => `${count} ${label}`).join(", ");
    let workerBase: string;
    if (!incompleteSampling) {
      workerBase = `${liveWorkers} ${liveWorkers === 1 ? "worker" : "workers"} live`;
    } else if (sampledAwaiting === 0 && liveWorkers === 0) {
      workerBase = child.assignmentsTruncated && unsampledAwaiting === 0 && unknownAwaiting === 0
        ? "0 sampled workers live"
        : "workers unsampled";
    } else if (sampledAwaiting > 0 && liveWorkers <= sampledAwaiting) {
      workerBase = `${liveWorkers} of ${sampledAwaiting} sampled ${sampledAwaiting === 1 ? "worker" : "workers"} live`;
    } else {
      workerBase = `${liveWorkers} sampled ${liveWorkers === 1 ? "worker" : "workers"} live`;
    }
    workerText = issueSummary ? `${workerBase} (${issueSummary})` : workerBase;
  }

  const latestCheck = child.checks[child.checks.length - 1];
  const checkText = latestCheck
    ? `check ${latestCheck.status}${latestCheck.exitCode !== undefined ? ` (${String(latestCheck.exitCode)})` : ""}${latestCheck.headCommit ? ` · ${latestCheck.headCommit.slice(0, 8)}` : ""}${child.checksTruncated ? " (checks truncated)" : ""}`
    : child.checksTruncated ? "checks truncated" : undefined;

  return [teamLabel, assignmentText, workerText, checkText].filter(Boolean).join(" · ");
}

export function linkedTeamIdOf(child: MissionProgressSnapshot["subtasks"][number]["child"]): string | undefined {
  return child.kind === "linked" ? child.runId : undefined;
}
