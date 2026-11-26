import { createHash, randomUUID } from "node:crypto";
import type { Mission, MissionStatus, MissionSubtask } from "./mission-types.js";
import type { Manager } from "./manager.js";
import type { MissionService } from "./missions.js";
import type { TeamAssignment, TeamMember, TeamRun, TeamStatus } from "./team-types.js";
import type { TeamService } from "./teams.js";
import type { Status, WorkerState } from "./types.js";
import { z } from "zod";

const MAX_SUBTASKS = 12;
const MAX_ASSIGNMENTS_PER_CHILD = 12;
const MAX_PRIOR_ATTEMPTS_PER_SLOT = 3;
const MAX_CHECKS_PER_CHILD = 8;
const MAX_MEMBER_LIVENESS_PER_CHILD = 5;
const MAX_LIVENESS_READS = 64;
const MAX_CONCURRENT_LIVENESS_READS = 8;
const MAX_TRACKED_MISSIONS = 16;
const MAX_OBSERVATIONS_PER_MISSION = 8;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
export const missionProgressQuerySchema = z.strictObject({ cursor: z.string().max(128).optional() });
const workerPriority = (status: TeamMember["status"]) => status === "running" ? 0 : status === "unavailable" ? 1 : status === "waiting" ? 2 : 3;

export type MissionProgressMemberSource = {
  runId: string;
  memberId: string;
  sessionId: string;
  revision: number;
  role: TeamMember["role"];
  taskId?: string;
  status: TeamMember["status"];
  exitConfirmedAt?: string;
};

export type MissionProgressCheck = {
  revision: number;
  round?: number;
  headCommit?: string;
  status: TeamRun["checks"][number]["status"];
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
};

export type MissionProgressChild =
  | { kind: "missing" }
  | { kind: "mismatched" }
  | {
      kind: "linked";
      runId: string;
      missionId: string;
      projectId: string;
      revision: number;
      status: TeamStatus;
      updatedAt: string;
      assignments: MissionProgressMemberSource[];
      checks: MissionProgressCheck[];
      assignmentsTruncated?: true;
      checksTruncated?: true;
    };

export function projectMissionChild(run: TeamRun, expectedMissionId: string, expectedProjectId: string): MissionProgressChild {
  if (run.replay || run.id.length === 0 || run.missionId !== expectedMissionId || run.projectId !== expectedProjectId)
    return { kind: "mismatched" };

  const currentTasks = run.tasks.filter(task => (task.revision ?? run.revision) === run.revision && task.memberId);
  const currentScouts = run.discovery?.revision === run.revision ? run.discovery.tasks.filter(task => task.memberId) : [];
  const recentMembers = run.members.slice(-60);
  const byId = new Map(recentMembers.map(member => [member.memberId, member]));
  const selected = new Map<string, TeamMember>();
  let missingCurrentAssignment = false;
  for (const task of currentTasks) {
    const member = byId.get(task.memberId!);
    if (member?.runId === run.id && member.revision === run.revision && member.taskId === task.id) selected.set(member.memberId, member);
    else missingCurrentAssignment = true;
  }
  for (const task of currentScouts) {
    const member = byId.get(task.memberId!);
    if (member?.runId === run.id && member.revision === run.revision && member.role === "scout") selected.set(member.memberId, member);
    else missingCurrentAssignment = true;
  }
  const latestUnassignedRole = new Set<string>();
  for (const member of [...recentMembers].reverse()) {
    if (member.runId !== run.id || member.revision !== run.revision || member.taskId
      || member.status !== "queued" && !statusAwaitingWorker.has(member.status)
      || !["project-manager", "integrator", "reviewer", "delivery"].includes(member.role) || latestUnassignedRole.has(member.role)) continue;
    latestUnassignedRole.add(member.role);
    selected.set(member.memberId, member);
  }
  const priorSelected = new Map<string, TeamMember>();
  let priorTruncated = false;
  const collectPrior = (role: TeamMember["role"], taskId: string, currentMemberId: string) => {
    const candidates = recentMembers.filter(member =>
      member.runId === run.id
      && member.memberId !== currentMemberId
      && !selected.has(member.memberId)
      && member.role === role
      && member.taskId === taskId
      && member.revision <= run.revision,
    );
    if (candidates.length > MAX_PRIOR_ATTEMPTS_PER_SLOT) priorTruncated = true;
    for (const candidate of candidates.slice(-MAX_PRIOR_ATTEMPTS_PER_SLOT)) {
      priorSelected.set(candidate.memberId, candidate);
    }
  };
  for (const task of currentTasks) {
    const member = selected.get(task.memberId!);
    if (member) collectPrior(member.role, task.id, member.memberId);
  }
  for (const task of currentScouts) {
    const member = selected.get(task.memberId!);
    if (member) collectPrior("scout", task.id, member.memberId);
  }
  const currentMembers = [...selected.values()];
  const priorMembers = [...priorSelected.values()];
  const needsObservation = (member: TeamMember) => !member.exitConfirmedAt && (member.status === "queued" || statusAwaitingWorker.has(member.status));
  const ordered = [
    ...currentMembers.filter(needsObservation),
    ...priorMembers.filter(needsObservation),
    ...currentMembers.filter(member => !needsObservation(member)),
    ...priorMembers.filter(member => !needsObservation(member)),
  ];
  const assignments = ordered.slice(0, MAX_ASSIGNMENTS_PER_CHILD).map((member): MissionProgressMemberSource => ({
    runId: member.runId,
    memberId: member.memberId,
    sessionId: member.sessionId,
    revision: member.revision,
    role: member.role,
    ...(member.taskId === undefined ? {} : { taskId: member.taskId }),
    status: member.status,
    ...(member.exitConfirmedAt === undefined ? {} : { exitConfirmedAt: member.exitConfirmedAt }),
  }));
  const currentChecks = run.checks.slice(-64).filter(check => check.revision === run.revision);
  const checks = currentChecks.slice(-MAX_CHECKS_PER_CHILD).map((check): MissionProgressCheck => ({
    revision: check.revision,
    ...(check.round === undefined ? {} : { round: check.round }),
    ...(check.headCommit === undefined ? {} : { headCommit: check.headCommit }),
    status: check.status,
    startedAt: check.startedAt,
    ...(check.finishedAt === undefined ? {} : { finishedAt: check.finishedAt }),
    ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
  }));
  return {
    kind: "linked",
    runId: run.id,
    missionId: run.missionId,
    projectId: run.projectId,
    revision: run.revision,
    status: run.status,
    updatedAt: run.updatedAt,
    assignments,
    checks,
    ...(ordered.length > assignments.length || missingCurrentAssignment || priorTruncated ? { assignmentsTruncated: true as const } : {}),
    ...(currentChecks.length > checks.length ? { checksTruncated: true as const } : {}),
  };
}

export type MissionProgressMissionSource = {
  id: string;
  title: string;
  status: MissionStatus;
  revision: number;
  updatedAt: string;
  coordinator?: {
    runId: string;
    memberId: string;
    sessionId: string;
    revision: number;
    role: "mission-coordinator";
    status: "queued" | "running" | "reported" | "stopped";
  };
  subtasks: Pick<MissionSubtask, "id" | "title" | "repoProjectId" | "status" | "teamId">[];
};

export function projectMissionSource({ mission, attempts }: {
  mission: Pick<Mission, "id" | "title" | "status" | "revision" | "updatedAt" | "subtasks">;
  attempts: readonly { memberId: string; sessionId: string; revision: number; status: "queued" | "running" | "reported" | "stopped" }[];
}): MissionProgressMissionSource {
  const attempt = attempts.at(-1);
  return { id: mission.id, title: mission.title, status: mission.status, revision: mission.revision, updatedAt: mission.updatedAt,
    ...(attempt ? { coordinator: { runId: mission.id, memberId: attempt.memberId, sessionId: attempt.sessionId, revision: attempt.revision,
      role: "mission-coordinator" as const, status: attempt.status } } : {}),
    subtasks: mission.subtasks.map(subtask => ({ id: subtask.id, title: subtask.title, repoProjectId: subtask.repoProjectId,
      status: subtask.status, ...(subtask.teamId ? { teamId: subtask.teamId } : {}) })) };
}

export type MissionProgressWorkerStatus = Status | "unknown" | "mismatched" | "not-sampled";

export type MissionProgressMember = Omit<MissionProgressMemberSource, "status"> & {
  recordedStatus: TeamMember["status"];
  workerStatus: MissionProgressWorkerStatus;
};

export type MissionProgressLinkedChild = Omit<Extract<MissionProgressChild, { kind: "linked" }>, "updatedAt" | "assignments"> & {
  assignments: MissionProgressMember[];
};

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
    status: MissionSubtask["status"];
    child: { kind: "not-created" } | { kind: "missing" } | { kind: "mismatched" } | MissionProgressLinkedChild;
  }[];
  subtasksTruncated?: true;
};

export type MissionProgressObservation = {
  cursor: string;
  sequence: number;
  observedAt: string;
  snapshot: MissionProgressSnapshot;
};

export type MissionProgressResyncReason = "initial" | "invalid-cursor" | "host-restarted" | "mission-mismatch" | "history-evicted" | "retention-gap" | "cursor-ahead";

export type MissionProgressPage = {
  missionId: string;
  generation: string;
  cursor: string;
  observedAt: string;
  resync: { required: false } | { required: true; reason: MissionProgressResyncReason };
  observations: MissionProgressObservation[];
  snapshot: MissionProgressSnapshot;
};

export type MissionProgressSources = {
  missions: Pick<MissionService, "progressSource">;
  teams: Pick<TeamService, "missionProgressChild">;
  manager: Pick<Manager, "meta" | "state">;
};

type ParsedCursor = { generation: string; missionId: string; instance: string; sequence: number };
type History = { instance: string; sequence: number; fingerprint: string; observations: MissionProgressObservation[]; livenessCursor: number };
type ExpectedAssignment = MissionProgressMemberSource | NonNullable<MissionProgressMissionSource["coordinator"]>;
type LivenessRequest = { key: string; assignment: ExpectedAssignment };
type SampledProgress = { missionId: string; observedAt: string; snapshot: MissionProgressSnapshot; history: History; hadHistory: boolean };
const statusAwaitingWorker = new Set<TeamMember["status"]>(["running", "waiting", "reported", "unavailable"]);

function assignmentMatches(actual: TeamAssignment | undefined, expected: NonNullable<LivenessRequest["assignment"]>): boolean {
  const taskId = "taskId" in expected ? expected.taskId : undefined;
  return Boolean(actual && actual.runId === expected.runId && actual.memberId === expected.memberId && actual.revision === expected.revision
    && actual.role === expected.role && actual.taskId === taskId);
}

function parseCursor(value: string): ParsedCursor | undefined {
  const match = /^mp1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([1-9][0-9]{0,8})$/.exec(value);
  if (!match) return undefined;
  return { generation: match[1]!, missionId: match[2]!, instance: match[3]!, sequence: Number(match[4]) };
}

function cursorFor(generation: string, missionId: string, instance: string, sequence: number) {
  return `mp1.${generation}.${missionId}.${instance}.${sequence}`;
}

function fingerprint(snapshot: MissionProgressSnapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function boundedSnapshot(snapshot: MissionProgressSnapshot): MissionProgressSnapshot {
  const result = structuredClone(snapshot);
  const bytes = () => Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes() <= MAX_SNAPSHOT_BYTES) return result;
  for (const subtask of result.subtasks) {
    if (subtask.child.kind !== "linked") continue;
    if (subtask.child.assignments.length > 8) {
      subtask.child.assignments.splice(8);
      subtask.child.assignmentsTruncated = true;
    }
    if (subtask.child.checks.length > 4) {
      subtask.child.checks.splice(0, subtask.child.checks.length - 4);
      subtask.child.checksTruncated = true;
    }
  }
  if (bytes() <= MAX_SNAPSHOT_BYTES) return result;
  throw new Error("Mission progress snapshot exceeded its size bound.");
}

export class MissionProgressService {
  readonly generation = randomUUID();
  private readonly histories = new Map<string, History>();
  private readonly inFlight = new Map<string, Promise<SampledProgress>>();
  private activeWorkerReads = 0;

  constructor(private readonly sources: MissionProgressSources) {}

  read(missionId: string, suppliedCursor?: string): Promise<MissionProgressPage> {
    let sample = this.inFlight.get(missionId);
    if (!sample) {
      let current!: Promise<SampledProgress>;
      current = this.sample(missionId).finally(() => { if (this.inFlight.get(missionId) === current) this.inFlight.delete(missionId); });
      this.inFlight.set(missionId, current);
      sample = current;
    }
    return sample.then(value => this.page(value, suppliedCursor));
  }

  private async sample(missionId: string): Promise<SampledProgress> {
    const historyAtStart = this.histories.get(missionId);
    const source = this.sources.missions.progressSource(missionId);
    if (source.id !== missionId) throw new Error("Mission progress source does not match the requested mission.");
    const observedAt = new Date().toISOString();
    const subtasks = source.subtasks.slice(0, MAX_SUBTASKS);
    const children = subtasks.map(subtask => ({
      subtask,
      child: subtask.teamId
        ? this.sources.teams.missionProgressChild(subtask.teamId, source.id, subtask.repoProjectId)
        : { kind: "not-created" as const },
    }));
    const requests: LivenessRequest[] = [];
    if (source.coordinator && source.coordinator.status !== "queued")
      requests.push({ key: `coordinator:${source.coordinator.memberId}`, assignment: source.coordinator });
    const memberRequests: LivenessRequest[] = [];
    for (const { subtask, child } of children) {
      if (child.kind !== "linked") continue;
      const current = child.assignments.filter(member => statusAwaitingWorker.has(member.status) && !member.exitConfirmedAt)
        .sort((a, b) => workerPriority(a.status) - workerPriority(b.status)).slice(0, MAX_MEMBER_LIVENESS_PER_CHILD);
      memberRequests.push(...current.map(member => ({ key: `member:${subtask.id}:${member.memberId}`, assignment: member })));
    }
    if (memberRequests.length) {
      const offset = (historyAtStart?.livenessCursor ?? 0) % memberRequests.length;
      requests.push(...memberRequests.slice(offset), ...memberRequests.slice(0, offset));
    }
    requests.splice(MAX_LIVENESS_READS);
    const liveness = new Map<string, MissionProgressWorkerStatus>();
    const memberRequestKeys = new Set(memberRequests.map(request => request.key));
    let sampledMemberCount = 0;
    const values = await Promise.all(requests.map(async request => [request.key, await this.workerStatus(request.assignment)] as const));
    for (const [key, status] of values) {
      liveness.set(key, status);
      if (memberRequestKeys.has(key) && status !== "not-sampled") sampledMemberCount++;
    }

    const snapshot = boundedSnapshot({
      mission: {
        id: source.id,
        title: source.title,
        status: source.status,
        revision: source.revision,
        ...(source.coordinator ? { coordinator: {
          runId: source.coordinator.runId,
          memberId: source.coordinator.memberId,
          sessionId: source.coordinator.sessionId,
          revision: source.coordinator.revision,
          role: source.coordinator.role,
          recordedStatus: source.coordinator.status,
          workerStatus: liveness.get(`coordinator:${source.coordinator.memberId}`) ?? "not-sampled",
        } } : {}),
      },
      subtasks: children.map(({ subtask, child }) => ({
        id: subtask.id,
        title: subtask.title,
        repoProjectId: subtask.repoProjectId,
        status: subtask.status,
        child: child.kind === "linked" ? {
          kind: child.kind,
          runId: child.runId,
          missionId: child.missionId,
          projectId: child.projectId,
          revision: child.revision,
          status: child.status,
          assignments: child.assignments.map(member => ({
            runId: member.runId,
            memberId: member.memberId,
            sessionId: member.sessionId,
            revision: member.revision,
            role: member.role,
            ...(member.taskId === undefined ? {} : { taskId: member.taskId }),
            recordedStatus: member.status,
            ...(member.exitConfirmedAt === undefined ? {} : { exitConfirmedAt: member.exitConfirmedAt }),
            workerStatus: liveness.get(`member:${subtask.id}:${member.memberId}`) ?? "not-sampled",
          })),
          checks: child.checks,
          ...(child.assignmentsTruncated ? { assignmentsTruncated: true as const } : {}),
          ...(child.checksTruncated ? { checksTruncated: true as const } : {}),
        } : child,
      })),
      ...(source.subtasks.length > subtasks.length ? { subtasksTruncated: true as const } : {}),
    });
    const hadHistory = historyAtStart !== undefined && this.histories.get(missionId) === historyAtStart;
    let history = hadHistory ? historyAtStart : undefined;
    const stateFingerprint = fingerprint(snapshot);
    const livenessCursor = memberRequests.length && sampledMemberCount > 0
      ? ((historyAtStart?.livenessCursor ?? 0) + sampledMemberCount) % memberRequests.length
      : 0;
    if (!history) {
      history = { instance: randomUUID(), sequence: 1, fingerprint: stateFingerprint, observations: [], livenessCursor: historyAtStart ? 0 : livenessCursor };
      this.histories.set(missionId, history);
      this.trimHistories();
    } else {
      if (memberRequests.length && sampledMemberCount > 0) history.livenessCursor = livenessCursor;
      if (history.fingerprint !== stateFingerprint) {
        history.sequence++;
        history.fingerprint = stateFingerprint;
        history.observations.push({ cursor: cursorFor(this.generation, missionId, history.instance, history.sequence), sequence: history.sequence, observedAt, snapshot });
        if (history.observations.length > MAX_OBSERVATIONS_PER_MISSION)
          history.observations.splice(0, history.observations.length - MAX_OBSERVATIONS_PER_MISSION);
      }
      this.touch(missionId, history);
    }
    return { missionId, observedAt, snapshot, history, hadHistory };
  }

  private page(sample: SampledProgress, suppliedCursor?: string): MissionProgressPage {
    const { missionId, observedAt, snapshot, history } = sample;
    const actualCursor = parseCursor(suppliedCursor ?? "");
    const cursor = cursorFor(this.generation, missionId, history.instance, history.sequence);
    let resync: MissionProgressPage["resync"] = { required: false };
    let observations: MissionProgressObservation[] = [];
    if (!suppliedCursor) resync = { required: true, reason: "initial" };
    else if (!actualCursor) resync = { required: true, reason: "invalid-cursor" };
    else if (actualCursor.generation !== this.generation) resync = { required: true, reason: "host-restarted" };
    else if (actualCursor.missionId !== missionId) resync = { required: true, reason: "mission-mismatch" };
    else if (!sample.hadHistory || this.histories.get(missionId) !== history || actualCursor.instance !== history.instance) resync = { required: true, reason: "history-evicted" };
    else if (actualCursor.sequence > history.sequence) resync = { required: true, reason: "cursor-ahead" };
    else {
      const oldest = history.observations[0]?.sequence ?? history.sequence;
      if (actualCursor.sequence < oldest - 1) resync = { required: true, reason: "retention-gap" };
      else observations = history.observations.filter(item => item.sequence > actualCursor.sequence);
    }
    if (this.histories.get(missionId) === history) this.touch(missionId, history);
    return { missionId, generation: this.generation, cursor, observedAt, resync, observations, snapshot };
  }

  private touch(missionId: string, history: History) {
    this.histories.delete(missionId);
    this.histories.set(missionId, history);
  }

  private trimHistories() {
    while (this.histories.size > MAX_TRACKED_MISSIONS) this.histories.delete(this.histories.keys().next().value!);
  }

  private async workerStatus(expected: ExpectedAssignment): Promise<MissionProgressWorkerStatus> {
    if (this.activeWorkerReads >= MAX_CONCURRENT_LIVENESS_READS) return "not-sampled";
    this.activeWorkerReads++;
    try {
      const actual: TeamAssignment | undefined = this.sources.manager.meta(expected.sessionId).session.team;
      if (!assignmentMatches(actual, expected)) return "mismatched";
      const state = await this.sources.manager.state(expected.sessionId);
      return state.status satisfies WorkerState["status"];
    } catch { return "unknown"; }
    finally { this.activeWorkerReads--; }
  }
}
