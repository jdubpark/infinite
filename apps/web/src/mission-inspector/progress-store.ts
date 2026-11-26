import type { MissionStatus } from "../mission-model";

export const MAX_PROGRESS_OBSERVATIONS = 40;

export type TeamStatus =
  | "planning"
  | "discovering"
  | "implementing"
  | "integrating"
  | "verifying"
  | "reviewing"
  | "delivering"
  | "merged"
  | "needs-input"
  | "paused"
  | "blocked"
  | "ready-for-review"
  | "no-change"
  | "cancelled";

export type TeamRole =
  | "project-manager"
  | "intent-checker"
  | "scout"
  | "implementer"
  | "integrator"
  | "reviewer"
  | "delivery"
  | "evaluator"
  | "permission-coordinator"
  | "judge";

export type MissionSubtaskStatus = "queued" | "running" | "done" | "cancelled" | "blocked";
export type MissionMemberRecordedStatus = "queued" | "running" | "waiting" | "reported" | "stopped" | "unavailable";
export type MissionProgressWorkerStatus =
  | "starting"
  | "running"
  | "exited"
  | "unavailable"
  | "recording-error"
  | "unknown"
  | "mismatched"
  | "not-sampled";
export type MissionCheckStatus = "running" | "passed" | "failed" | "interrupted";

export type MissionProgressMember = {
  runId: string;
  memberId: string;
  sessionId: string;
  revision: number;
  role: TeamRole;
  taskId?: string;
  recordedStatus: MissionMemberRecordedStatus;
  exitConfirmedAt?: string;
  workerStatus: MissionProgressWorkerStatus;
};

export type MissionProgressCheck = {
  revision: number;
  round?: number;
  headCommit?: string;
  status: MissionCheckStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
};

export type MissionProgressLinkedChild = {
  kind: "linked";
  runId: string;
  missionId: string;
  projectId: string;
  revision: number;
  status: TeamStatus;
  assignments: MissionProgressMember[];
  checks: MissionProgressCheck[];
  assignmentsTruncated?: true;
  checksTruncated?: true;
};

export type MissionProgressChild =
  | { kind: "not-created" }
  | { kind: "missing" }
  | { kind: "mismatched" }
  | MissionProgressLinkedChild;

export type MissionProgressSnapshot = {
  mission: {
    id: string;
    title: string;
    status: MissionStatus;
    revision: number;
    coordinator?: {
      runId: string;
      memberId: string;
      sessionId: string;
      revision: number;
      role: "mission-coordinator";
      recordedStatus: "queued" | "running" | "reported" | "stopped";
      workerStatus: MissionProgressWorkerStatus;
    };
  };
  subtasks: {
    id: string;
    title: string;
    repoProjectId: string;
    status: MissionSubtaskStatus;
    child: MissionProgressChild;
  }[];
  subtasksTruncated?: true;
};

export type MissionProgressObservation = {
  cursor: string;
  sequence: number;
  observedAt: string;
  snapshot: MissionProgressSnapshot;
};

export type MissionProgressResyncReason =
  | "initial"
  | "invalid-cursor"
  | "host-restarted"
  | "mission-mismatch"
  | "history-evicted"
  | "retention-gap"
  | "cursor-ahead";

export type MissionProgressPage = {
  missionId: string;
  generation: string;
  cursor: string;
  observedAt: string;
  resync: { required: false } | { required: true; reason: MissionProgressResyncReason };
  observations: MissionProgressObservation[];
  snapshot: MissionProgressSnapshot;
};

export type MissionProgressState = {
  missionId: string | null;
  generation: string | null;
  cursor: string | null;
  snapshot: MissionProgressSnapshot | null;
  observations: MissionProgressObservation[];
  lastSequence: number;
  lastResyncReason: MissionProgressResyncReason | null;
  resyncCount: number;
  observedAt: string | null;
};

export type CompactAssignmentGroup = {
  member: MissionProgressMember;
  priorAttempts: MissionProgressMember[];
};

export type CompactAssignmentsResult = {
  active: CompactAssignmentGroup[];
  finished: MissionProgressMember[];
};

export type ResolvedMissionChild =
  | { kind: "loading"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "not-created" }
  | { kind: "missing" }
  | { kind: "mismatched"; reason: string }
  | { kind: "linked"; child: MissionProgressLinkedChild; verifiedTeamId: string };

export function isConfirmedFinishedMember(
  member: Pick<MissionProgressMember, "recordedStatus" | "exitConfirmedAt">,
): boolean {
  return member.recordedStatus === "stopped"
    || (member.recordedStatus === "reported" && Boolean(member.exitConfirmedAt));
}

export function isAwaitingExitMember(
  member: Pick<MissionProgressMember, "recordedStatus" | "exitConfirmedAt">,
): boolean {
  return member.recordedStatus === "reported" && !member.exitConfirmedAt;
}

export function resolveMissionChild(
  mission: { id: string },
  subtask: { id: string; repoProjectId: string; teamId?: string },
  snapshot: MissionProgressSnapshot | null,
  options: { progressError?: string; progressLoading?: boolean } = {},
): ResolvedMissionChild {
  if (!snapshot) {
    if (options.progressError) {
      return { kind: "unavailable", reason: `Mission progress is unavailable: ${options.progressError}` };
    }
    if (options.progressLoading) {
      return { kind: "loading", reason: "Loading subteam progress from the host..." };
    }
    return { kind: "unavailable", reason: "Mission progress snapshot is unavailable." };
  }
  if (snapshot.mission.id !== mission.id) {
    return { kind: "unavailable", reason: "Loaded progress snapshot belongs to a different mission." };
  }
  const progressSubtask = snapshot.subtasks.find(item => item.id === subtask.id);
  if (!progressSubtask) {
    if (snapshot.subtasksTruncated) {
      return { kind: "unavailable", reason: "Subtask progress was omitted because the progress snapshot is truncated." };
    }
    return { kind: "unavailable", reason: "The latest progress snapshot does not include this subtask yet." };
  }
  const { child } = progressSubtask;
  if (child.kind === "not-created") {
    if (subtask.teamId) {
      return { kind: "unavailable", reason: "Mission records a subteam, but the latest progress snapshot has not observed it yet." };
    }
    return { kind: "not-created" };
  }
  if (child.kind === "missing") return { kind: "missing" };
  if (child.kind === "mismatched") {
    return { kind: "mismatched", reason: "The linked subteam record does not match this mission or project." };
  }
  if (child.missionId !== mission.id || child.projectId !== subtask.repoProjectId || !child.runId) {
    return { kind: "mismatched", reason: "The linked subteam progress record does not match this mission or repository." };
  }
  if (!subtask.teamId || child.runId !== subtask.teamId) {
    return { kind: "mismatched", reason: "The linked subteam run does not match the mission subtask record." };
  }
  return { kind: "linked", child, verifiedTeamId: child.runId };
}

export function initialMissionProgressState(): MissionProgressState {
  return {
    missionId: null,
    generation: null,
    cursor: null,
    snapshot: null,
    observations: [],
    lastSequence: 0,
    lastResyncReason: null,
    resyncCount: 0,
    observedAt: null,
  };
}

export function parseMissionProgressCursor(cursor: string | null | undefined): {
  generation: string;
  missionId: string;
  instance: string;
  sequence: number;
} | null {
  if (!cursor) return null;
  const match = /^mp1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([1-9][0-9]{0,8})$/.exec(cursor);
  if (!match) return null;
  return {
    generation: match[1]!,
    missionId: match[2]!,
    instance: match[3]!,
    sequence: Number(match[4]),
  };
}

export function missionProgressResyncNotice(reason: MissionProgressResyncReason | null): string | null {
  if (!reason || reason === "initial") return null;
  switch (reason) {
    case "host-restarted":
      return "Host restarted since your last progress cursor. Replaced the local progress view with the latest snapshot.";
    case "history-evicted":
      return "Progress history for this mission was evicted from host memory. Replaced the local progress view with the latest snapshot.";
    case "retention-gap":
      return "Progress cursor fell behind retained host observations. Replaced the local progress view with the latest snapshot.";
    case "cursor-ahead":
      return "Local progress cursor was ahead of the host sequence. Replaced the local progress view with the latest snapshot.";
    case "invalid-cursor":
      return "Progress cursor could not be parsed by the host. Replaced the local progress view with the latest snapshot.";
    case "mission-mismatch":
      return "Progress cursor belonged to a different mission. Replaced the local progress view with the latest snapshot.";
  }
}

function observationKey(item: MissionProgressObservation): string {
  const parsed = parseMissionProgressCursor(item.cursor);
  if (parsed) return `${parsed.generation}:${parsed.instance}:${parsed.sequence}`;
  return `${item.cursor}:${item.sequence}`;
}

function appendObservations(
  existing: readonly MissionProgressObservation[],
  incoming: readonly MissionProgressObservation[],
  afterSequence: number,
): { observations: MissionProgressObservation[]; maxSequence: number } {
  const seen = new Set(existing.map(observationKey));
  const accepted: MissionProgressObservation[] = [];
  let maxSequence = afterSequence;
  const sorted = [...incoming].sort((a, b) => a.sequence - b.sequence);
  for (const item of sorted) {
    const key = observationKey(item);
    if (item.sequence <= afterSequence || seen.has(key)) continue;
    seen.add(key);
    accepted.push(item);
    if (item.sequence > maxSequence) maxSequence = item.sequence;
  }
  if (!accepted.length) {
    return { observations: existing.slice(-MAX_PROGRESS_OBSERVATIONS), maxSequence };
  }
  return {
    observations: [...existing, ...accepted].slice(-MAX_PROGRESS_OBSERVATIONS),
    maxSequence,
  };
}

export function applyMissionProgressPage(state: MissionProgressState, page: MissionProgressPage): MissionProgressState {
  const parsed = parseMissionProgressCursor(page.cursor);
  const cursorSequence = parsed?.sequence ?? 0;
  const sameMission = state.missionId === null || state.missionId === page.missionId;

  if (page.resync.required) {
    const { observations, maxSequence } = appendObservations([], page.observations, 0);
    const nextSequence = Math.max(cursorSequence, maxSequence);
    const isQuietInitial = page.resync.reason === "initial";
    return {
      missionId: page.missionId,
      generation: page.generation,
      cursor: page.cursor,
      snapshot: page.snapshot,
      observations,
      lastSequence: nextSequence,
      lastResyncReason: page.resync.reason,
      resyncCount: (sameMission ? state.resyncCount : 0) + (isQuietInitial ? 0 : 1),
      observedAt: page.observedAt,
    };
  }

  if (!sameMission) {
    const { observations, maxSequence } = appendObservations([], page.observations, 0);
    return {
      missionId: page.missionId,
      generation: page.generation,
      cursor: page.cursor,
      snapshot: page.snapshot,
      observations,
      lastSequence: Math.max(cursorSequence, maxSequence),
      lastResyncReason: null,
      resyncCount: 0,
      observedAt: page.observedAt,
    };
  }

  if (state.generation !== null && state.generation !== page.generation) {
    return state;
  }

  const currentParsed = parseMissionProgressCursor(state.cursor);
  if (parsed && currentParsed && parsed.instance !== currentParsed.instance) {
    return state;
  }

  if (parsed && parsed.sequence < state.lastSequence) {
    return state;
  }

  const { observations, maxSequence } = appendObservations(state.observations, page.observations, state.lastSequence);
  const nextSequence = Math.max(state.lastSequence, cursorSequence, maxSequence);

  return {
    missionId: page.missionId,
    generation: page.generation,
    cursor: page.cursor,
    snapshot: page.snapshot,
    observations,
    lastSequence: nextSequence,
    lastResyncReason: state.lastResyncReason,
    resyncCount: state.resyncCount,
    observedAt: page.observedAt,
  };
}

export function compactAssignments(assignments: readonly MissionProgressMember[]): CompactAssignmentsResult {
  const activeMembers = assignments.filter(member => !isConfirmedFinishedMember(member));
  const finishedMembers = assignments.filter(member => isConfirmedFinishedMember(member));

  const latestActiveIndexBySlot = new Map<string, number>();
  activeMembers.forEach((member, index) => {
    if (member.taskId === undefined) return;
    const key = `${member.role}\0${member.taskId}`;
    const priorIndex = latestActiveIndexBySlot.get(key);
    if (priorIndex === undefined) {
      latestActiveIndexBySlot.set(key, index);
      return;
    }
    const prior = activeMembers[priorIndex]!;
    const memberAwaitingExit = isAwaitingExitMember(member);
    const priorAwaitingExit = isAwaitingExitMember(prior);
    if ((priorAwaitingExit && !memberAwaitingExit) || (priorAwaitingExit === memberAwaitingExit && member.revision >= prior.revision)) {
      latestActiveIndexBySlot.set(key, index);
    }
  });

  const priorByActiveIndex = new Map<number, MissionProgressMember[]>();
  const unlinkedFinished: MissionProgressMember[] = [];

  for (const member of finishedMembers) {
    if (member.taskId !== undefined) {
      const targetIndex = latestActiveIndexBySlot.get(`${member.role}\0${member.taskId}`);
      if (targetIndex !== undefined) {
        const list = priorByActiveIndex.get(targetIndex) ?? [];
        list.push(member);
        priorByActiveIndex.set(targetIndex, list);
        continue;
      }
    }
    unlinkedFinished.push(member);
  }

  const active: CompactAssignmentGroup[] = activeMembers.map((member, index) => ({
    member,
    priorAttempts: (priorByActiveIndex.get(index) ?? []).sort((a, b) => a.revision - b.revision),
  }));

  return {
    active,
    finished: unlinkedFinished,
  };
}
