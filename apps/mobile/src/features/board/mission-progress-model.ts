import type {
  MissionProgressObservation,
  MissionProgressPage,
  MissionProgressResyncReason,
  MissionProgressSnapshot,
} from "../../api/client";

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
  const replacedBy = new Map<string, string>();
  const replaces = new Map<string, string>();
  const lastStoppedByRepo = new Map<string, MissionProgressSnapshot["subtasks"][number]>();

  for (const subtask of subtasks) {
    const previous = lastStoppedByRepo.get(subtask.repoProjectId);
    if (previous && previous.id !== subtask.id && subtask.status !== "cancelled") {
      replacedBy.set(previous.id, subtask.id);
      replaces.set(subtask.id, previous.id);
    }
    if (subtask.status === "blocked" || subtask.status === "cancelled") {
      lastStoppedByRepo.set(subtask.repoProjectId, subtask);
    } else if (subtask.status === "running" || subtask.status === "queued" || subtask.status === "done") {
      lastStoppedByRepo.delete(subtask.repoProjectId);
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

export function linkedTeamIdOf(child: MissionProgressSnapshot["subtasks"][number]["child"]): string | undefined {
  return child.kind === "linked" ? child.runId : undefined;
}
