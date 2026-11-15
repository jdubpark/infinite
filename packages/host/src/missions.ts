import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { writeSealed, unseal } from "./vault.js";
import type { ConnectorSource } from "./mcp-types.js";
import { inputSourceLabel } from "./team-types.js";
import { TeamService, TeamError, providerInputReason } from "./teams.js";
import type { Manager } from "./manager.js";
import type { Config } from "./types.js";
import { DEFAULT_TEAM_RETENTION, hostClosedBlockedReason, type BlockerEvidence, type CreateTeam, type NativeContinuation, type TeamAssignment, type TeamView } from "./team-types.js";
import type { ProductGoal } from "./goal-types.js";
import type { ProjectGroup } from "./project-group-types.js";
import { createMissionSchema, missionActionSchema, missionExtendSchema, missionReportEnvelopeSchema, missionTextSchema, type Board, type BoardColumn, type BoardItem, type CreateMission, type Mission, type MissionFollowUp, type MissionInputSource, type MissionOrigin, type MissionReport, type MissionSubtaskPlan } from "./mission-types.js";
import { missionFollowUpPromptWithMessageCount, missionPromptWithMessageCount, subteamReport, type MissionCoordinatorNote, type MissionMessage, type MissionOpenChildDecision, type MissionPromptRepo } from "./team-prompts.js";
import { addRollups, emptyRollup, teamUsage } from "./team-usage.js";
import type { UsageService } from "./usage-service.js";
import { ledgerRecord } from "./usage-store.js";
import { missionCoordinatorLaunch, teamModelLaunch } from "./launch.js";
import { ensureDefaultTeamRoot, ensureHostDirectory } from "./team-workspace.js";
import { resumeFailed } from "./native-continuation.js";
import { HOST_LOAD_REASON_PREFIX, LaunchHeldError, holdsHostLoadReason } from "./host-load.js";
import { applyFuseReason, workLaunch } from "./fuse/rules.js";
import type { FuseAdmission, FuseCheck, FuseGate } from "./fuse/types.js";
import { HALT_PAUSED_TEAM, KEPT_PAUSED, LEFT_AS_IS, LEFT_PAUSED, STILL_HALTED, isHaltReason, pauseFailure, releaseRefusal, type HaltCovers, type HaltHeldBy, type HaltMark, type HaltOutcome } from "./halt/rules.js";

/** The mission's only view of projects; the project group service implements it. */
export type ProjectGroupLookup = { get(id: string): ProjectGroup };

type Action = { requestId: string; revision: number };
/** One coordinator session. Like a team member, it ends with one report; the host starts the next attempt when needed. */
type Attempt = { memberId: string; sessionId: string; revision: number; prompt: string; cursor: number; stopRequestId: string; status: "queued" | "running" | "reported" | "stopped"; report?: MissionReport; startedAt?: string;
  /** The host requested this session stop because its mission was no longer live. */
  stopping?: true;
  continuation?: NativeContinuation;
  nativeConfirmed?: boolean;
  resumeFailed?: boolean;
  consumedInbox?: MissionMessage[];
  consumedNotes?: MissionMessage[];
  /** The owner input count when this attempt's prompt was built; a result from an attempt that missed later input is not applied. */
  ownerInputs?: number;
  /** The session ended its turn or went quiet without a report; it is stopped and the next attempt is told why. */
  missedReport?: boolean;
  /** The journal position read for turn signals, and the latest turn boundary seen there. */
  signalCursor?: number; turnSignal?: { kind: string; at: string };
  /** When the attempt stopped. Absent on attempts stopped before this field existed. */
  endedAt?: string;
  /** The note filed with the report, held until the report is consumed. */
  note?: string;
  /** The rule that made this attempt start a new conversation instead of resuming. It also marks the boundary that retires every older conversation. */
  rotated?: RotationRule;
  /** The journal position read for usage, and the context size of the newest main-conversation model call seen there. */
  usageCursor?: number; contextTokens?: number };
type RotationRule = "idle" | "size" | "age";
/** A subteam action recorded before it is sent, so a restart replays it under the same request ID. */
type ChildOp = { kind: "answer" | "steer" | "pause" | "resume" | "cancel" | "parallelism"; subtaskId: string; teamId: string; requestId: string; revision?: number; decisionId?: string; text?: string; parallelism?: number; by?: "owner" | "coordinator" | "connector"; source?: ConnectorSource;
  /**
   * Set on a pause or resume that the owner's halt queued, with the token of the mission's halt and, on a pause, the
   * reason the paused subteam shows. The subteam decides in its own queue: a pause reaches it only while it is working,
   * and a resume only while it is still paused under that token.
   */
  halt?: { token: string; reason?: string } };
type Stored = {
  mission: Mission;
  fingerprint: string;
  requestFingerprints?: string[];
  receipts: Record<string, string>;
  /**
   * Set when the owner's halt paused this mission, with the mission revision it left; any owner action moves the
   * revision on. `token` marks the subteams this halt paused, and `children` lists the ones whose pause they confirmed.
   */
  ownerHalt?: { haltId: string; revision: number; token: string; children: string[] };
  folder: string;
  repos: MissionPromptRepo[];
  attempts: Attempt[];
  /** Messages that start the next coordinator attempt. */
  inbox: MissionMessage[];
  /** Messages carried into the next attempt without starting one. */
  notes: MissionMessage[];
  /** Escalation keys already sent, so one decision or block reaches the coordinator once. */
  notified: string[];
  /** Child create requests persisted before the create, keyed by subtask ID. */
  launches: Record<string, CreateTeam>;
  ops: ChildOp[];
  /** Attribution for a paused or stopped launch that must adopt and stop an already-created child. */
  controlSource?: ConnectorSource;
  refusals: number;
  /** Owner directions and answers recorded so far. */
  ownerInputs?: number;
  /** The finished same-repository subtask run a pending launch starts from, keyed by subtask ID. */
  bases?: Record<string, string>;
  /** When an intake mission's clock stopped (waiting on the owner or paused); the stopped span is added to its deadline on resume. */
  clockStoppedAt?: string;
  /** When the mission became blocked. Records blocked before this field existed fall back to the mission's last change. */
  blockedAt?: string;
  /** The newest notes the coordinator filed with its reports. Agent text: never in the mission view, events, Slack, or Linear. */
  coordinatorNotes?: MissionCoordinatorNote[];
};

const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Display names may change; durable replay binds connector identity to its kind and ID. */
const receiptDigest = <T extends object>(value: T & { source?: ConnectorSource | string }) => {
  const { source, ...body } = value;
  // Slack and owner actions predate source-aware receipts and keep their original hash shape.
  return digest({ ...body, ...(typeof source === "object" ? { source: { kind: source.kind, id: source.id } } : {}) });
};
const live = new Set<Mission["status"]>(["planning", "working", "needs-input"]);
const teamDone = new Set(["ready-for-review", "merged", "no-change"]);
const maxAttempts = 60;
/** How long a coordinator's turn-end must stand, with no newer turn activity, before the attempt counts as ending without a report. */
const turnEndSettleMs = 5000;
/** Journal signals that show the provider is in a turn; a turn-end closes it. */
const turnActivity = new Set(["turn-start", "tool-start", "tool-end", "prompt-open", "prompt-closed", "answer"]);
/** Messages delivered per coordinator attempt; the rest wait for the next attempt. */
const messageLimit = 30;
const timeLimitReason = "The approved time limit has expired. Subteams are paused and their workspaces are kept. Extend the time limit to continue, or cancel the mission.";
const messageTooLargeReason = "The next coordinator message cannot fit with the mission state. Its evidence remains queued; no empty coordinator attempt was started.";
/** Follow-ups open at once, and settled ones kept for clients. */
const followUpLimit = 5, settledFollowUpsKept = 10;
/** Coordinator notes kept, newest first, and their total length. */
const noteLimit = 8, noteCharacters = 16000;
/** Rotation defaults; `autonomy.continuity` overrides each, and 0 turns a rule off. */
const rotationDefaults = { rotateIdleMinutes: 60, rotateContextTokens: 120000, rotateAttempts: 40 };
const rotationText: Record<RotationRule, string> = {
  idle: "the previous conversation was idle too long",
  size: "the previous conversation grew too large",
  age: "the previous conversation had too many attempts",
};
/** A time to the minute in UTC, for board rows and events. */
const utcMinute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
/** Marks an attempt stopped and records when, once. */
const endAttempt = (attempt: Attempt) => { attempt.status = "stopped"; attempt.endedAt ??= now(); };
/** Puts an attempt's consumed messages back at the front of the queues and clears them on the attempt, so they return once. */
function returnConsumed(stored: Stored, attempt: Attempt) {
  stored.inbox = [...(attempt.consumedInbox ?? []), ...stored.inbox];
  stored.notes = [...(attempt.consumedNotes ?? []), ...stored.notes];
  delete attempt.consumedInbox; delete attempt.consumedNotes;
}
const openFollowUps = (mission: Mission) => (mission.followUps ?? []).filter(item => item.state === "open");
/** Settles every open follow-up of an ending mission. */
function cancelFollowUps(mission: Mission) {
  const at = now();
  for (const item of openFollowUps(mission)) Object.assign(item, { state: "cancelled", settledAt: at });
  trimFollowUps(mission);
}
/** Keeps every open follow-up and the most recently settled ones. */
function trimFollowUps(mission: Mission) {
  const settled = (mission.followUps ?? []).filter(item => item.state !== "open").sort((a, b) => (a.settledAt ?? "").localeCompare(b.settledAt ?? ""));
  const dropped = new Set(settled.slice(0, Math.max(0, settled.length - settledFollowUpsKept)));
  if (dropped.size) mission.followUps = mission.followUps!.filter(item => !dropped.has(item));
}
const messageCannotFitReason = "The next coordinator message cannot fit with the mission state, even shortened. No empty coordinator attempt was started; start a new mission with a consolidated objective.";
const subtaskStatus = (status: TeamView["status"]) => teamDone.has(status) ? "done" as const : status === "blocked" ? "blocked" as const : status === "cancelled" ? "cancelled" as const : "running" as const;
const notFound = (error: unknown) => error instanceof TeamError && error.code === "team-not-found";

/**
 * A mission splits one owner task across a project's repositories. Its coordinator only plans and
 * decides; every change runs as an ordinary single-repository team run that owns its agents and Git work.
 */
const answerDispatchRefusal = "This mission answers a question and cannot start subtasks. Report the answer as a result, ask the owner a question, or report blocked.";
// An answer mission's prompt offers no follow-up: it answers now, asks the owner, or reports blocked.
const answerFollowUpRefusal = "This mission answers a question and cannot set a follow-up. Report the answer as a result, ask the owner a question, or report blocked.";

export class MissionService {
  private readonly records = new Map<string, Stored>();
  private readonly saved = new Map<string, string>();
  private readonly directory: string;
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private tickQueued = false;
  private usage?: UsageService;
  private readonly listeners = new Set<(mission: Mission) => void>();
  private fuse?: FuseGate;

  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager, private readonly teams: TeamService, private readonly groups: ProjectGroupLookup) {
    this.directory = join(config.stateDir, "missions");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `mission:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.mission.id !== id) throw new TeamError(409, "invalid-mission-record", "A mission record cannot be authenticated.");
      this.records.set(id, stored);
      this.saved.set(id, digest(stored));
      let capacityChanged = false;
      for (const subtask of stored.mission.subtasks) {
        const teamId = subtask.teamId ?? stored.launches[subtask.id]?.requestId;
        if (!teamId) continue;
        let parallelism: number | undefined;
        try { parallelism = this.teams.ensureMissionCapacityCeiling(teamId, stored.mission.id, subtask.size === "solo" ? 1 : 4); }
        catch (error) { if (!notFound(error)) throw error; }
        if (parallelism !== undefined && subtask.parallelism !== parallelism) {
          subtask.parallelism = parallelism;
          capacityChanged = true;
        }
      }
      if (capacityChanged) this.event(stored, "Subtask worker limits were reconciled from their persisted team capacity.");
      if (capacityChanged) this.save(stored);
    }
    this.teams.useMissionReservations((projectId, exceptMissionId) => {
      for (const [missionId, stored] of this.records) {
        if (missionId === exceptMissionId) continue;
        const pendingLaunch = Object.values(stored.launches).some(request => request.projectId === projectId);
        const activeSubteam = stored.mission.subtasks.some(subtask => subtask.repoProjectId === projectId && subtask.teamId && this.teams.isActiveRun(subtask.teamId));
        if (pendingLaunch || activeSubteam) return missionId;
      }
      return undefined;
    });
  }
  /** The usage ledger that prices coordinator sessions; subteam usage comes from their runs. */
  useUsage(service: UsageService) { this.usage = service; }
  /** The launch-rate fuse. A service without one launches every coordinator attempt it would have launched before. */
  useFuse(fuse: FuseGate) { this.fuse = fuse; }
  /** Whether the mission's sealed record file is on disk, so a record that failed to load still counts. Only a missing file is false. */
  hasRecordFile(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return false;
    try {
      lstatSync(join(this.directory, `${id}.sealed`));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  }
  ownsActiveSubteam(teamId: string) {
    return [...this.records.values()].some(({ mission }) =>
      (mission.status !== "blocked" || mission.stopReason === "deadline") && !["ready-for-review", "cancelled"].includes(mission.status) &&
      mission.subtasks.some(subtask => subtask.teamId === teamId && ["running", "blocked"].includes(subtask.status)));
  }
  /** A live mission retains integration state while it still references a source subteam. */
  retainsSubteamRun(teamId: string) {
    return [...this.records.values()].some(({ mission }) =>
      (mission.status !== "blocked" || mission.stopReason === "deadline") && !["ready-for-review", "cancelled"].includes(mission.status) &&
      mission.subtasks.some(subtask => subtask.teamId === teamId));
  }
  enabled() {
    const lineup = this.config.teams?.lineup;
    return Boolean(lineup && lineup.coordinator.tier === "strong" && lineup.reviewer.tier === "strong");
  }
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task); this.serial = next.catch(() => {}); return next;
  }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "mission-not-found", "This mission does not exist.");
    return stored;
  }
  /** Calls each listener after a sealed write, with the stored mission and no computed usage. */
  onChange(listener: (mission: Mission) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** The stored mission without computed usage, for callers that read on every change. */
  peek(id: string): Mission | undefined {
    const stored = this.records.get(id);
    return stored && structuredClone(stored.mission);
  }
  private save(stored: Stored) {
    const attempt = stored.attempts.at(-1), mission = stored.mission;
    mission.coordinator = attempt && { memberId: attempt.memberId, sessionId: attempt.sessionId,
      status: attempt.status !== "stopped" ? "running" : live.has(mission.status) ? "waiting" : "stopped" };
    this.settleClock(stored);
    if (this.saved.get(mission.id) === digest(stored)) return;
    mission.updatedAt = now();
    writeSealed(join(this.directory, `${mission.id}.sealed`), this.key, `mission:${mission.id}`, stored);
    this.saved.set(mission.id, digest(stored));
    for (const listener of [...this.listeners]) {
      // A listener that throws must not fail a save that is already written.
      try { listener(structuredClone(mission)); } catch { /* the listener owns its failure */ }
    }
  }
  /**
   * An intake mission's clock stops while it waits on the owner or is paused; the stopped span is added to its
   * deadline when it leaves that state, so only working time counts. Other missions keep the wall-clock deadline.
   */
  private settleClock(stored: Stored) {
    const mission = stored.mission;
    if (mission.origin?.kind !== "intake") return;
    const stopped = mission.status === "needs-input" || mission.status === "paused";
    if (stopped && !stored.clockStoppedAt) stored.clockStoppedAt = now();
    else if (!stopped && stored.clockStoppedAt) {
      mission.deadlineAt = new Date(this.deadlineMs(stored, Date.now())).toISOString();
      delete stored.clockStoppedAt;
    }
  }
  /** The deadline on the clock as it reads at this moment: a stopped intake clock adds its stopped time back. */
  private deadlineMs(stored: Stored, at: number) {
    return Date.parse(stored.mission.deadlineAt) + (stored.clockStoppedAt ? at - Date.parse(stored.clockStoppedAt) : 0);
  }
  private event(stored: Stored, text: string) {
    stored.mission.events.push({ at: now(), text });
    if (stored.mission.events.length > 200) stored.mission.events.splice(0, stored.mission.events.length - 200);
  }
  private view(stored: Stored): Mission {
    const mission = structuredClone(stored.mission), profile = mission.lineup.coordinator;
    const coordinator = teamUsage(stored.attempts.map(attempt => ({ sessionId: attempt.sessionId, provider: profile.provider, modelProfile: profile })), profile.provider, this.usage).rollup;
    const subteams = mission.subtasks.flatMap(subtask => {
      if (!subtask.teamId) return subtask.finalEvidence?.usage ? [subtask.finalEvidence.usage] : [];
      try { return [this.teams.get(subtask.teamId).usage]; }
      catch (error) { if (notFound(error)) return [subtask.finalEvidence?.usage ?? emptyRollup()]; throw error; }
    });
    mission.usage = addRollups([coordinator, ...subteams]);
    if (stored.clockStoppedAt) mission.clockStoppedAt = stored.clockStoppedAt;
    return mission;
  }
  list() { return [...this.records.values()].map(stored => this.view(stored)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  /** Persisted mission records for the read-only Understanding view; performs no usage refresh. */
  understandingRecords() { return [...this.records.values()].map(stored => structuredClone(stored.mission)); }
  understandingOwnsSession(missionId: string, memberId: string, sessionId: string, projectId: string): boolean {
    const stored = this.records.get(missionId);
    return Boolean(stored && stored.mission.repoProjectIds.includes(projectId) && stored.attempts.some(attempt =>
      attempt.memberId === memberId && attempt.sessionId === sessionId));
  }
  get(id: string) { return this.view(this.record(id)); }

  /** A create retry returns its recorded mission before any admission check runs again. */
  replayCreate(input: CreateMission) {
    const request = createMissionSchema.parse(input), prior = this.records.get(request.requestId);
    if (!prior) return undefined;
    const fingerprint = digest(request);
    if (prior.fingerprint !== fingerprint && !prior.requestFingerprints?.includes(fingerprint))
      throw new TeamError(409, "request-conflict", "This request ID belongs to a different mission.");
    return this.view(prior);
  }
  create(input: CreateMission, originalInput?: CreateMission, origin?: MissionOrigin, authorize?: () => void) {
    const request = createMissionSchema.parse(input);
    const originalFingerprint = originalInput && digest(createMissionSchema.parse(originalInput));
    return this.enqueue(() => {
      authorize?.();
      const replayed = this.replayCreate(request);
      if (replayed) return replayed;
      const fingerprint = digest(request);
      if (!this.enabled()) throw new TeamError(409, "missions-not-configured", "Configure a team lineup with a strong coordinator and reviewer before starting a mission.");
      const group = this.groups.get(request.groupId);
      const checkoutIds = new Set(group.repos.flatMap(repo => repo.checkouts.map(checkout => checkout.projectId)));
      if (request.checkouts?.some(projectId => !checkoutIds.has(projectId)))
        throw new TeamError(400, "mission-checkout-invalid", "Choose checkouts that belong to this project.");
      const checkoutEvents: string[] = [];
      const repos: MissionPromptRepo[] = group.repos.map(repo => {
        const requested = repo.checkouts.find(checkout => request.checkouts?.includes(checkout.projectId));
        const chosen = requested
          ?? repo.checkouts.find(checkout => checkout.primary && checkout.teamReady)
          ?? repo.checkouts.find(checkout => checkout.teamReady)
          ?? repo.checkouts.find(checkout => checkout.primary)
          ?? repo.checkouts[0];
        if (!chosen) throw new TeamError(409, "mission-repository-missing", `Repository ${repo.projectId} has no enrolled checkout on this host.`);
        const project = this.config.projects.find(item => item.id === chosen.projectId);
        if (!project) throw new TeamError(409, "mission-repository-missing", `Repository ${chosen.projectId} is no longer enrolled on this host.`);
        const teamReady = Boolean(project.team && (project.team.checks.length || project.team.establishChecks));
        if (!requested && chosen.projectId !== repo.projectId)
          checkoutEvents.push(`Repository ${repo.name}: the primary checkout is not configured for subteams; using ${chosen.projectId}.`);
        return { projectId: project.id, name: repo.name, path: realpathSync(project.path), teamReady };
      });
      if (!repos.some(repo => repo.teamReady)) throw new TeamError(409, "mission-project-not-configured", "Configure required checks, or authorize a team to establish them, in at least one repository of this project.");
      const lineup = structuredClone(this.config.teams!.lineup!), profile = this.config.agents[lineup.coordinator.provider];
      if (!profile) throw new TeamError(409, "provider-not-configured", "The coordinator provider must be configured and available on this host.");
      // The mission report tool reaches Claude and Codex through the team MCP server.
      if (lineup.coordinator.provider !== "claude") throw new TeamError(409, "mission-coordinator-unsupported", "Missions need a Claude Code coordinator in the team lineup; a Codex coordinator cannot yet be restricted to reading and reporting.");
      try { missionCoordinatorLaunch(lineup.coordinator.provider, profile); }
      catch (error) { throw new TeamError(409, "mission-coordinator-profile", `The coordinator profile cannot run as a read-only mission coordinator: ${(error as Error).message}`); }
      try { teamModelLaunch(profile, lineup.coordinator); }
      catch { throw new TeamError(409, "team-model-profile-conflict", "Move model, effort, and fallback-model arguments from provider profiles into the team lineup before starting a mission."); }
      const folder = this.missionFolder(request.requestId, repos);
      const createdAt = now();
      const stored: Stored = { fingerprint, ...(originalFingerprint && originalFingerprint !== fingerprint ? { requestFingerprints: [originalFingerprint] } : {}),
        receipts: {}, folder, repos, attempts: [], inbox: [{ type: "start" }], notes: [], notified: [], launches: {}, ops: [], refusals: 0, mission: {
        id: request.requestId, ...(origin ? { origin: structuredClone(origin) } : {}), ...(request.mode ? { mode: request.mode } : {}), groupId: group.id, groupName: group.name, repoProjectIds: repos.map(repo => repo.projectId),
        title: request.title ?? request.objective.split("\n")[0].trim().slice(0, 100), objective: request.objective,
        maxSubtasks: request.maxSubtasks, maxMinutes: request.maxMinutes, deadlineAt: new Date(Date.parse(createdAt) + request.maxMinutes * 60000).toISOString(),
        revision: 1, status: "planning", createdAt, updatedAt: createdAt, lineup, subtasks: [], decisions: [], steering: [], events: [],
      } };
      if (request.mode === "answer") this.event(stored, "Question received. The coordinator will read the repositories and report an answer; it cannot start subtasks.");
      else this.event(stored, origin
        ? `Mission started by intake from ${origin.identifier}: ${origin.rule}. The coordinator will inspect the repositories and dispatch subtasks.`
        : "Mission approved. The coordinator will inspect the repositories and dispatch subtasks.");
      for (const text of checkoutEvents) this.event(stored, text);
      this.records.set(stored.mission.id, stored); this.save(stored);
      return this.view(stored);
    });
  }
  /** The coordinator's folder sits below the team workspace root and outside every repository it reads. */
  private missionFolder(id: string, repos: MissionPromptRepo[]) {
    const workspaceDir = this.config.teams!.workspaceDir;
    const root = ensureDefaultTeamRoot(workspaceDir, true);
    const folder = ensureHostDirectory(root, join(root, "missions", id), 0o750);
    for (const repo of repos) {
      const inside = relative(repo.path, folder);
      if (!inside || (!inside.startsWith("..") && !isAbsolute(inside)))
        throw new TeamError(409, "mission-folder-unsafe", "The team workspace directory is inside a project repository; move it outside every repository before starting a mission.");
    }
    return folder;
  }

  private replay(stored: Stored, action: string, body: Action & object) {
    const prior = stored.receipts[body.requestId];
    if (!prior) return false;
    if (prior !== receiptDigest({ action, ...body })) throw new TeamError(409, "request-conflict", "This request ID belongs to a different mission action.");
    return true;
  }
  private admit(stored: Stored, action: string, body: Action & object) {
    if (body.revision !== stored.mission.revision) throw new TeamError(409, "stale-mission-revision", "The mission changed. Refresh it before sending this action.");
    stored.receipts[body.requestId] = receiptDigest({ action, ...body });
    stored.mission.revision++;
  }
  pause(id: string, input: Action, reason?: string, source?: MissionInputSource, authorize?: () => void) {
    // A supplied reason joins the request fingerprint; an omitted one leaves the fingerprint as it was before reasons existed.
    const body = { ...missionActionSchema.parse(input), ...(reason === undefined ? {} : { reason }), ...(source === undefined ? {} : { source }) };
    return this.action(id, "pause", body, authorize);
  }
  resume(id: string, input: Action, source?: MissionInputSource, authorize?: () => void) { return this.action(id, "resume", { ...missionActionSchema.parse(input), ...(source === undefined ? {} : { source }) }, authorize); }
  cancel(id: string, input: Action, source?: MissionInputSource, authorize?: () => void) { return this.action(id, "cancel", { ...missionActionSchema.parse(input), ...(source === undefined ? {} : { source }) }, authorize); }
  /**
   * The owner approves `minutes` more working time. A running or paused mission keeps going with a later deadline;
   * a mission blocked by its time limit (`stopReason: "deadline"`) resumes its paused subteams. Any other mission is
   * refused. Idempotent by `requestId`. While the owner's halt covers the mission, its subteams stay paused: a mission
   * the halt paused stays paused and still resumes on release, and the resumes an extension queues wait in
   * `applyOps` until no halt covers the mission's repositories.
   */
  extend(id: string, input: { requestId: string; revision: number; minutes: number }): ReturnType<MissionService["resume"]> {
    const body = missionExtendSchema.parse(input);
    return this.enqueue(() => {
      const stored = this.record(id), mission = stored.mission;
      if (this.replay(stored, "extend", body)) return this.view(stored);
      const deadlineBlocked = mission.status === "blocked" && mission.stopReason === "deadline";
      if (!(live.has(mission.status) || mission.status === "paused" || deadlineBlocked))
        throw new TeamError(409, "mission-not-extendable", "Only a running mission, or one stopped by its time limit, can be extended.");
      const halted = mission.status === "paused" && stored.ownerHalt?.revision === mission.revision;
      this.admit(stored, "extend", body);
      // Approved time is not a change to the halt's pause, so the release still resumes the mission.
      if (halted) stored.ownerHalt!.revision = mission.revision;
      const at = Date.now();
      // The extension adds working time to whatever is left, never to a deadline already passed. A stopped intake
      // clock measures what is left from the moment it stopped; the stopped span is added back when it restarts.
      const from = deadlineBlocked ? at : Math.max(Date.parse(mission.deadlineAt), stored.clockStoppedAt ? Date.parse(stored.clockStoppedAt) : at);
      const deadline = from + body.minutes * 60000;
      mission.deadlineAt = new Date(deadline).toISOString();
      if (deadlineBlocked) {
        mission.status = "working"; mission.stopReason = undefined; mission.reason = undefined; stored.blockedAt = undefined;
        const mark = stored.ownerHalt;
        const haltPaused = (teamId: string) => Boolean(mark && (mark.children.includes(teamId) || stored.ops.some(op => op.teamId === teamId && op.kind === "pause" && op.halt?.token === mark.token)));
        for (const subtask of mission.subtasks.filter(item => item.teamId && item.status === "running")) {
          // A time-limit pause that never reached the subteam is withdrawn rather than followed by a resume. A subteam
          // that the halt paused, or will pause, gets the resume anyway; it waits in `applyOps` until the halt lifts.
          const pending = stored.ops.findIndex(op => op.teamId === subtask.teamId && op.kind === "pause" && !op.halt);
          if (pending >= 0) stored.ops.splice(pending, 1);
          if (pending < 0 || haltPaused(subtask.teamId!)) this.queueOp(stored, { kind: "resume", subtaskId: subtask.id, teamId: subtask.teamId! });
        }
        stored.inbox.push({ type: "resumed" }); this.settle(stored);
      }
      this.event(stored, `The owner extended the time limit by ${body.minutes} minutes; the mission now stops at ${utcMinute(mission.deadlineAt)}.`);
      this.save(stored); return this.view(stored);
    });
  }
  private action(id: string, action: "pause" | "resume" | "cancel", body: Action & { reason?: string; source?: MissionInputSource }, authorize?: () => void) {
    const reason = body.reason;
    return this.enqueue(() => {
      const stored = this.record(id), mission = stored.mission;
      authorize?.();
      if (this.replay(stored, action, body)) return this.view(stored);
      if (action === "pause" && !live.has(mission.status)) throw new TeamError(409, "mission-not-running", "Only a running mission can be paused.");
      if (action === "resume" && mission.status !== "paused") throw new TeamError(409, "mission-not-paused", "Only a paused mission can resume.");
      // The paused status still holds here, so the stopped clock is added to the deadline without writing it yet.
      if (action === "resume" && Date.now() >= this.deadlineMs(stored, Date.now())) throw new TeamError(409, "mission-deadline", "This mission's time limit has expired. Extend the time limit to continue.");
      if (action === "cancel" && mission.status === "cancelled") throw new TeamError(409, "mission-cancelled", "This mission has already been cancelled.");
      this.admit(stored, action, body);
      stored.controlSource = typeof body.source === "object" ? body.source : undefined;
      if (action === "cancel") this.stop(stored, "cancelled", `Cancelled by ${body.source ? inputSourceLabel(body.source) : "the owner"}. Subteam workspaces remain available for inspection.`, typeof body.source === "object" ? body.source : undefined);
      else if (action === "pause") {
        mission.status = "paused"; mission.reason = reason ?? `Paused by ${body.source ? inputSourceLabel(body.source) : "the owner"}. The coordinator and active subteams are stopping.`;
        for (const subtask of mission.subtasks.filter(item => item.teamId && item.status === "running")) this.queueOp(stored, { kind: "pause", subtaskId: subtask.id, teamId: subtask.teamId!, ...(stored.controlSource ? { source: stored.controlSource } : {}) });
      } else {
        mission.status = "working"; mission.reason = undefined;
        mission.stopReason = undefined;
        for (const subtask of mission.subtasks.filter(item => item.teamId && item.status === "running")) {
          // A pause that never reached the subteam is withdrawn rather than followed by a resume.
          const pending = stored.ops.findIndex(op => op.teamId === subtask.teamId && op.kind === "pause");
          if (pending >= 0) stored.ops.splice(pending, 1);
          else this.queueOp(stored, { kind: "resume", subtaskId: subtask.id, teamId: subtask.teamId!, ...(stored.controlSource ? { source: stored.controlSource } : {}) });
        }
        stored.inbox.push({ type: "resumed" });
        this.settle(stored);
      }
      this.event(stored, action === "pause" && reason ? `Mission paused: ${reason}` : `Mission ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}${body.source ? ` by ${inputSourceLabel(body.source)}` : ""}.`);
      this.save(stored); return this.view(stored);
    });
  }
  /**
   * Host-internal: the owner's halt pauses each planning, working, or waiting mission with any repository in scope, as
   * the owner's pause does, without an owner request, and marks it with the revision it leaves. A waiting mission keeps
   * its questions; the release settles it back to waiting while any of them is open.
   */
  haltPause(mark: HaltMark, covers: HaltCovers) {
    return this.enqueue(() => {
      const outcomes: HaltOutcome[] = [];
      for (const stored of this.records.values()) {
        const mission = stored.mission;
        if (!live.has(mission.status) || !covers(mission.repoProjectIds, mission.id)) continue;
        try {
          // Only a subteam that is working or waiting for input now: one paused, blocked, or ended stays as it is.
          const working = mission.subtasks.filter(item => {
            if (!item.teamId || item.status !== "running") return false;
            try { return HALT_PAUSED_TEAM.has(this.teams.get(item.teamId).status); } catch (error) { if (notFound(error)) return false; throw error; }
          });
          mission.revision++; mission.status = "paused"; mission.reason = mark.reason;
          const token = randomUUID();
          for (const subtask of working) this.queueOp(stored, { kind: "pause", subtaskId: subtask.id, teamId: subtask.teamId!, halt: { token, reason: mark.reason } });
          stored.ownerHalt = { haltId: mark.haltId, revision: mission.revision, token, children: [] };
          this.event(stored, `Mission paused: ${mark.reason}`); this.save(stored);
          outcomes.push({ kind: "mission", id: mission.id, title: mission.title, result: "paused" });
        } catch (error) { outcomes.push(pauseFailure("mission", mission.id, mission.title, error)); }
      }
      return outcomes;
    });
  }
  /**
   * Host-internal: resumes each mission still paused, unchanged, under this halt's mark, with the owner's resume rules.
   * A mission that stays paused hands its reason to each subteam its halt paused before the mark ends, so a restart
   * in between repeats that step and no subteam keeps a halt's reason once the halt is off.
   */
  haltResume(haltId: string, heldBy: HaltHeldBy, keep: boolean) {
    return this.enqueue(async () => {
      const outcomes: HaltOutcome[] = [];
      for (const stored of this.records.values()) {
        const mission = stored.mission, mark = stored.ownerHalt, base = { kind: "mission" as const, id: mission.id, title: mission.title };
        if (mark?.haltId !== haltId) continue;
        try {
          if (mission.status !== "paused" || mission.revision !== mark.revision) {
            // A mission whose time limit passed during the halt stays blocked, and its subteams stay paused until the
            // owner extends it, the way a paused mission keeps its subteams paused.
            const holds = mission.status === "paused" || mission.status === "blocked" && mission.stopReason === "deadline";
            if (mission.status === "paused" && isHaltReason(mission.reason)) mission.reason = LEFT_PAUSED;
            if (holds) await this.settleHaltChildren(stored, mark, mission.reason ?? LEFT_PAUSED);
            this.endHaltMark(stored, mark, holds); this.save(stored);
            outcomes.push({ ...base, result: "left", reason: LEFT_AS_IS }); continue;
          }
          if (keep) {
            await this.settleHaltChildren(stored, mark, KEPT_PAUSED);
            this.endHaltMark(stored, mark, true); mission.reason = KEPT_PAUSED; this.save(stored);
            outcomes.push({ ...base, result: "kept", reason: KEPT_PAUSED }); continue;
          }
          const other = heldBy(mission.repoProjectIds);
          if (other) {
            stored.ownerHalt = { ...mark, haltId: other.haltId }; mission.reason = other.reason; this.save(stored);
            outcomes.push({ ...base, result: "held", reason: STILL_HALTED }); continue;
          }
          if (Date.now() >= this.deadlineMs(stored, Date.now())) {
            const reason = "This mission's time limit has expired. Extend the time limit to continue.";
            await this.settleHaltChildren(stored, mark, releaseRefusal(reason));
            this.endHaltMark(stored, mark, true); mission.reason = releaseRefusal(reason); this.save(stored);
            outcomes.push({ ...base, result: "refused", reason }); continue;
          }
          mission.revision++; mission.status = "working"; mission.reason = undefined;
          // Each subteam the halt paused gets a resume that its own queue applies only while it is still paused under
          // this halt's token. So does each subteam of a withdrawn pause, which a restart may have left unrecorded
          // after the pause reached it; one the pause never reached does not carry the token and is not touched.
          const withdrawn = this.endHaltMark(stored, mark, false);
          for (const teamId of new Set([...mark.children, ...withdrawn])) {
            const subtask = mission.subtasks.find(item => item.teamId === teamId && item.status === "running");
            if (subtask) this.queueOp(stored, { kind: "resume", subtaskId: subtask.id, teamId, halt: { token: mark.token } });
          }
          stored.inbox.push({ type: "resumed" });
          this.settle(stored);
          this.event(stored, "Mission resumed: the owner released the halt."); this.save(stored);
          outcomes.push({ ...base, result: "resumed" });
        } catch (error) { outcomes.push({ ...base, result: "refused", reason: error instanceof Error ? error.message : "The mission could not resume." }); }
      }
      return outcomes;
    });
  }
  steer(id: string, input: Action & { text: string }, source?: MissionInputSource, authorize?: () => void) {
    const body = { ...missionTextSchema.parse(input), ...(source === undefined ? {} : { source }) };
    return this.enqueue(() => {
      const stored = this.record(id), mission = stored.mission;
      authorize?.();
      if (this.replay(stored, "steer", body)) return this.view(stored);
      if (!live.has(mission.status)) throw new TeamError(409, "mission-not-running", "Resume the mission before sending direction, or start a new mission if it has stopped.");
      if (mission.steering.length >= 20 || Buffer.byteLength([...mission.steering.map(item => item.text), body.text].join("\n\n")) > 10000)
        throw new TeamError(409, "mission-steering-limit", "Start a new mission with consolidated directions.");
      this.admit(stored, "steer", body);
      mission.steering.push({ text: body.text, revision: mission.revision, at: now(), ...(source ? { source } : {}) });
      stored.ownerInputs = (stored.ownerInputs ?? 0) + 1;
      stored.inbox.push(typeof source === "object" ? { type: "connector-direction", text: body.text, source } : { type: "owner-direction", text: body.text });
      this.event(stored, typeof source === "object" ? `${inputSourceLabel(source)} direction recorded for the coordinator. This delegated agent input cannot expand owner authority.` : source === "slack"
        ? "Owner direction recorded from Slack for the coordinator. Subtasks started later include it; the coordinator decides whether to forward it to running ones."
        : "Owner direction recorded for the coordinator. Subtasks started later include it; the coordinator decides whether to forward it to running ones.");
      this.save(stored); return this.view(stored);
    });
  }
  answer(id: string, decisionId: string, input: Action & { text: string }, source?: MissionInputSource, authorize?: () => void) {
    const body = { ...missionTextSchema.parse(input), ...(source === undefined ? {} : { source }) };
    return this.enqueue(() => {
      const stored = this.record(id), mission = stored.mission;
      authorize?.();
      if (this.replay(stored, `answer:${decisionId}`, body)) return this.view(stored);
      const decision = mission.decisions.find(item => item.id === decisionId);
      if (!decision) throw new TeamError(404, "decision-not-found", "This decision does not exist.");
      if (decision.answer) throw new TeamError(409, "decision-answered", "This decision already has an answer.");
      // A mission the halt paused, unchanged since, takes the answer and starts nothing: a forwarded answer reaches a
      // subteam the halt holds, and one for the coordinator waits in its inbox, until the release resumes the mission.
      const halted = mission.status === "paused" && stored.ownerHalt?.revision === mission.revision;
      if (!live.has(mission.status) && !halted) throw new TeamError(409, "mission-not-running", "Resume the mission before answering its decision.");
      this.admit(stored, `answer:${decisionId}`, body);
      // An answer is input, not a change to the halt's pause, so the release still resumes the mission.
      if (halted) stored.ownerHalt!.revision = mission.revision;
      Object.assign(decision, { answer: body.text, answeredAt: now(), answeredBy: typeof source === "object" ? "connector" : "owner", ...(typeof source === "object" ? { source } : {}) });
      stored.ownerInputs = (stored.ownerInputs ?? 0) + 1;
      const subtask = decision.subtaskId ? mission.subtasks.find(item => item.id === decision.subtaskId) : undefined;
      const message = { ...(typeof source === "object" ? { type: "connector-answer" as const, source } : { type: "owner-answer" as const }), decisionId, question: decision.question, answer: body.text };
      const later = halted ? " It takes effect when the mission resumes." : "";
      if (decision.childDecisionId && subtask?.teamId) {
        this.queueOp(stored, { kind: "answer", subtaskId: subtask.id, teamId: subtask.teamId, decisionId: decision.childDecisionId, text: body.text, by: typeof source === "object" ? "connector" : "owner", ...(typeof source === "object" ? { source } : {}) });
        stored.notes.push({ ...message, forwardedTo: { subtaskId: subtask.id, childDecisionId: decision.childDecisionId } });
        this.event(stored, (typeof source === "object" ? `${inputSourceLabel(source)} answered a question; the delegated answer is being forwarded to subtask ${subtask.id}.` : source === "slack"
          ? `The owner answered a question from Slack; the answer is being forwarded to subtask ${subtask.id}.`
          : `The owner answered a question; the answer is being forwarded to subtask ${subtask.id}.`) + later);
      } else {
        stored.inbox.push(message);
        this.event(stored, (typeof source === "object" ? `${inputSourceLabel(source)} answered the coordinator question; this is delegated agent input.` : source === "slack" ? "The owner answered the coordinator's question from Slack." : "The owner answered the coordinator's question.") + later);
      }
      this.settle(stored);
      this.save(stored); return this.view(stored);
    });
  }

  start() {
    if (this.timer || this.closed) return;
    const tick = () => {
      if (this.tickQueued || this.closed) return;
      this.tickQueued = true;
      void this.enqueue(async () => {
        try {
          for (const stored of this.records.values()) {
            try { await this.step(stored); }
            catch (error) {
              if (this.closed) return;
              const reason = error instanceof TeamError ? error.message : "The mission could not advance. Its subteams and evidence remain available.";
              this.event(stored, reason);
              if (live.has(stored.mission.status) || stored.mission.status === "paused") this.stop(stored, "blocked", reason);
              this.save(stored);
            }
          }
        } finally { this.tickQueued = false; }
      }).catch(() => { this.tickQueued = false; });
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
  /** Settles once work queued before now has finished, so a caller can stop sessions it may still launch. */
  idle() { return this.serial.then(() => undefined); }

  private async step(stored: Stored) {
    if (this.closed) return;
    const mission = stored.mission;
    this.closeStaleBlocked(stored);
    // A stopped mission with nothing left to stop or observe needs no further ticks.
    if (["blocked", "ready-for-review", "cancelled"].includes(mission.status) && !stored.ops.length && !Object.keys(stored.launches).length &&
        (stored.attempts.at(-1)?.status ?? "stopped") === "stopped" &&
        !mission.subtasks.some(subtask => subtask.status === "running" || subtask.status === "cancelled" && subtask.teamId)) return;
    this.settleClock(stored);
    // A stopped intake clock is not checked; its deadline moves when the owner or the pause releases it.
    if ((live.has(mission.status) || mission.status === "paused") && !stored.clockStoppedAt && Date.now() >= Date.parse(mission.deadlineAt)) {
      mission.status = "blocked"; mission.stopReason = "deadline"; mission.reason = timeLimitReason; stored.blockedAt = stored.blockedAt ?? now();
      for (const subtask of mission.subtasks.filter(item => item.teamId && item.status === "running")) {
        stored.ops = stored.ops.filter(op => op.teamId !== subtask.teamId || op.kind !== "resume");
        this.queueOp(stored, { kind: "pause", subtaskId: subtask.id, teamId: subtask.teamId! });
      }
      mission.coordinator = mission.coordinator ? { ...mission.coordinator, status: "stopped" } : undefined;
      this.event(stored, timeLimitReason); this.save(stored);
    }
    await this.launchSubteams(stored);
    await this.applyOps(stored);
    await this.stepCoordinator(stored);
    if (this.closed) return;
    await this.refresh(stored);
    if (live.has(mission.status)) {
      this.schedule(stored);
      await this.launchSubteams(stored);
      this.fireFollowUps(stored);
      await this.wake(stored);
    }
    this.save(stored);
  }
  /**
   * Each due follow-up of a live mission becomes `fired` and adds one host message to the inbox in the same write,
   * so a restart can neither lose the message nor fire it twice. A paused mission is not live, so its follow-ups wait.
   */
  private fireFollowUps(stored: Stored) {
    const at = Date.now(), due = openFollowUps(stored.mission).filter(item => Date.parse(item.dueAt) <= at);
    if (!due.length) return;
    for (const item of due) {
      Object.assign(item, { state: "fired", settledAt: now() });
      stored.inbox.push({ type: "follow-up", followUpId: item.id, dueAt: item.dueAt, reason: item.reason, check: item.check });
      this.event(stored, `The coordinator's follow-up for ${utcMinute(item.dueAt)} came due; the host asked the coordinator to look again: ${item.reason}`);
    }
    trimFollowUps(stored.mission);
    this.save(stored);
  }
  /** Stops the mission: queued work is cancelled and active subteams receive a cancel. */
  private stop(stored: Stored, status: "blocked" | "cancelled", reason: string, source?: ConnectorSource) {
    const mission = stored.mission;
    mission.stopReason = undefined;
    mission.status = status; mission.reason = reason; stored.controlSource = source;
    stored.blockedAt = status === "blocked" ? stored.blockedAt ?? now() : undefined;
    for (const subtask of mission.subtasks) {
      if (subtask.status === "queued" && !stored.launches[subtask.id]) subtask.status = "cancelled";
      else if (subtask.teamId && ["running", "blocked"].includes(subtask.status)) this.queueOp(stored, { kind: "cancel", subtaskId: subtask.id, teamId: subtask.teamId, ...(source ? { source } : {}) });
    }
    stored.inbox = []; stored.notes = [];
    // A blocked mission cannot resume, so its follow-ups could never fire.
    cancelFollowUps(mission);
  }
  /**
   * A blocked mission cannot resume, so it waits on the owner only to be read and cancelled. After the retention
   * period for blocked work the host closes it, saying so, instead of leaving it under "needs input" for good.
   */
  private closeStaleBlocked(stored: Stored) {
    const mission = stored.mission;
    if (mission.status !== "blocked") return;
    const hours = (this.config.teams?.retention ?? DEFAULT_TEAM_RETENTION).blockedHours;
    const since = Date.parse(stored.blockedAt ?? mission.updatedAt);
    if (!(Date.now() - since >= hours * 3600000)) return;
    const reason = hostClosedBlockedReason(hours, mission.reason);
    this.stop(stored, "cancelled", reason); this.event(stored, reason); this.save(stored);
  }
  private settle(stored: Stored) {
    const mission = stored.mission;
    if (!live.has(mission.status)) return;
    mission.status = mission.decisions.some(decision => !decision.answer) ? "needs-input" : mission.subtasks.length ? "working" : "planning";
    mission.reason = undefined;
  }
  /**
   * A release that leaves the mission paused: each subteam that its halt paused, and each one a withdrawn halt pause may
   * already have reached, keeps its pause and shows `reason` instead of the halt's. Each subteam decides in its own
   * queue, against the halt's token; one the pause never reached is not touched. A failure is recorded and the next
   * subteam goes on.
   */
  private async settleHaltChildren(stored: Stored, mark: NonNullable<Stored["ownerHalt"]>, reason: string) {
    const undelivered = stored.ops.filter(op => op.kind === "pause" && op.halt?.token === mark.token).map(op => op.teamId);
    for (const teamId of new Set([...mark.children, ...undelivered])) {
      try { await this.teams.haltSettleChild(teamId, mark.token, reason); }
      catch (error) {
        if (notFound(error)) continue;
        this.event(stored, `The halt's reason on subteam ${teamId} could not be updated: ${error instanceof Error ? error.message : "the subteam could not be reached."}`);
      }
    }
  }
  /**
   * Ends the mission's halt mark. Every halt pause under its token that has not reached its subteam is withdrawn, so
   * none arrives once no release owns the token. While the mission stays paused, or blocked at its time limit, each of
   * those subteams gets the mission's ordinary pause instead, the one the owner's pause of a mission queues: it carries
   * no halt token, it skips a subteam that is already paused, blocked, or finished, and the owner's resume or extension
   * of the mission resumes it.
   * Returns the subteams whose halt pause was withdrawn.
   */
  private endHaltMark(stored: Stored, mark: NonNullable<Stored["ownerHalt"]>, staysPaused: boolean) {
    const withdrawn = stored.ops.filter(op => op.kind === "pause" && op.halt?.token === mark.token);
    stored.ops = stored.ops.filter(op => !withdrawn.includes(op));
    if (staysPaused) for (const op of withdrawn)
      if (!stored.ops.some(item => item.kind === "pause" && item.teamId === op.teamId)) this.queueOp(stored, { kind: "pause", subtaskId: op.subtaskId, teamId: op.teamId });
    stored.ownerHalt = undefined;
    return withdrawn.map(op => op.teamId);
  }
  private queueOp(stored: Stored, op: Omit<ChildOp, "requestId">) {
    // A cancel supersedes any earlier action on the same subteam, and a later pause supersedes a halt's resume.
    if (op.kind === "cancel") stored.ops = stored.ops.filter(item => item.teamId !== op.teamId);
    else if (op.kind === "pause") stored.ops = stored.ops.filter(item => !(item.kind === "resume" && item.halt && item.teamId === op.teamId));
    else if (op.kind === "parallelism") stored.ops = stored.ops.filter(item => item.kind !== "parallelism" || item.teamId !== op.teamId);
    stored.ops.push({ ...op, requestId: randomUUID() });
  }
  private message(stored: Stored, key: string, message: MissionMessage) {
    if (stored.notified.includes(key)) return;
    stored.notified.push(key);
    if (stored.notified.length > 500) stored.notified.splice(0, stored.notified.length - 500);
    stored.inbox.push(message);
  }

  /** Each create request is persisted first; a replay after a restart returns the same subteam. */
  private async launchSubteams(stored: Stored) {
    const mission = stored.mission;
    for (const [subtaskId, request] of Object.entries(stored.launches)) {
      const subtask = mission.subtasks.find(item => item.id === subtaskId)!;
      if (!live.has(mission.status)) {
        // The mission stopped or paused before this create resolved; adopt a created subteam so it can be stopped.
        try {
          const team = this.teams.get(request.requestId);
          Object.assign(subtask, { teamId: team.id, status: "running", teamStatus: team.status });
          const keepPaused = mission.status === "paused" || mission.status === "blocked" && mission.stopReason === "deadline";
          this.queueOp(stored, { kind: keepPaused ? "pause" : "cancel", subtaskId, teamId: team.id, ...(stored.controlSource ? { source: stored.controlSource } : {}) });
        } catch (error) {
          if (!notFound(error)) throw error;
          if (mission.status !== "paused" && !(mission.status === "blocked" && mission.stopReason === "deadline")) subtask.status = "cancelled";
        }
        delete stored.launches[subtaskId]; delete stored.bases?.[subtaskId]; this.save(stored); continue;
      }
      const baseRunId = stored.bases?.[subtaskId];
      try {
        // Owner-requested intake work is not mirrored to Linear as a team; the intake issue is the record.
        const team = await this.teams.createForMission(request, mission.id, mission.lineup, { ...(baseRunId ? { baseRunId } : {}), parallelismCeiling: subtask.size === "solo" ? 1 : 4, ...(mission.origin?.source ? { requestSource: mission.origin.source } : {}), ...(mission.origin?.kind === "intake" ? { linearTracking: false } : {}) });
        if (this.closed) return;
        Object.assign(subtask, { teamId: team.id, status: "running", teamStatus: team.status });
        const base = baseRunId && mission.subtasks.find(item => item.teamId === baseRunId);
        this.event(stored, `Started subtask ${subtask.id} in ${subtask.repoProjectId} with a ${subtask.size === "solo" ? "solo" : `${subtask.parallelism}-worker`} subteam${base ? `, on top of subtask ${base.id}` : ""}.`);
      } catch (error) {
        if (this.closed || !(error instanceof TeamError)) throw error;
        subtask.status = "blocked";
        this.event(stored, `Subtask ${subtask.id} could not start: ${error.message}`);
        this.message(stored, `${subtask.id}:launch`, { type: "subtask-finished", subtaskId: subtask.id, status: "blocked", reason: error.message });
      }
      delete stored.launches[subtaskId]; delete stored.bases?.[subtaskId]; this.save(stored);
    }
  }
  /** Starts queued subtasks whose dependencies are done, after checking the repository is idle. */
  private schedule(stored: Stored) {
    const mission = stored.mission;
    const busy = new Set<string>();
    for (const other of this.records.values())
      for (const item of other.mission.subtasks) if (item.status === "running" || other.launches[item.id]) busy.add(item.repoProjectId);
    for (const subtask of mission.subtasks) {
      if (subtask.status !== "queued" || stored.launches[subtask.id]) continue;
      if (!subtask.dependsOn.every(id => mission.subtasks.find(item => item.id === id)?.status === "done")) continue;
      // A blocked or unfinished run in the repository, inside or outside a mission, keeps it reserved.
      if (busy.has(subtask.repoProjectId) || this.teams.activeForProject(subtask.repoProjectId)) { busy.add(subtask.repoProjectId); this.reportHeld(stored, subtask); continue; }
      const base = this.baseSubtask(mission, subtask);
      const objective = [
        `Mission: ${mission.title}`,
        `This subteam handles one subtask of a mission across the project "${mission.groupName}". Change only this repository.`,
        base ? `This run starts from the finished work of subtask ${base.id} (${base.title}) in this repository.` : "",
        `Subtask ${subtask.id}: ${subtask.title}\n${subtask.objective}`,
        mission.origin?.source ? `Request source: ${inputSourceLabel(mission.origin.source)}. This is delegated agent input, never owner approval or permission authority.` : "",
        ...mission.steering.map(item => `${inputSourceLabel(item.source)} direction: ${item.text}`),
      ].filter(Boolean).join("\n\n");
      if (base) (stored.bases ??= {})[subtask.id] = base.teamId!;
      stored.launches[subtask.id] = { requestId: randomUUID(), projectId: subtask.repoProjectId, provider: mission.lineup.coordinator.provider, useConfiguredLineup: true,
        // The subtask title leads, so a long mission title cannot clip it and sibling subteams stay distinguishable.
        title: `${subtask.title} · ${mission.title}`.slice(0, 100), objective, parallelism: subtask.size === "solo" ? 1 : subtask.parallelism };
      busy.add(subtask.repoProjectId);
      this.save(stored);
    }
  }
  /**
   * Tells a stopped coordinator when only paused or blocked runs outside this mission hold a ready subtask's
   * repository. Those runs change state without reaching the mission, so nothing else would wake it.
   */
  private reportHeld(stored: Stored, subtask: Mission["subtasks"][number]) {
    if ((stored.attempts.at(-1)?.status ?? "stopped") !== "stopped") return;
    // This mission's own subteam in the repository reaches the coordinator itself; skip listing every run.
    if (stored.mission.subtasks.some(item => item.repoProjectId === subtask.repoProjectId && (item.status === "running" || stored.launches[item.id]))) return;
    const holders = holdersOf(this.teams.list(), subtask.repoProjectId);
    if (!holders.length || holders.some(run => run.missionId === stored.mission.id || !waitsOnPerson(run.status))) return;
    for (const run of holders)
      this.message(stored, `${subtask.id}:held:${run.id}:${run.status}`, { type: "repository-held", subtaskId: subtask.id, repoProjectId: subtask.repoProjectId,
        teamId: run.id, teamStatus: run.status, ...(run.reason ? { reason: run.reason } : {}) });
  }
  /**
   * A subtask that depends, directly or through other subtasks, on finished work in its own repository
   * starts from the latest such run in dependency order, so it builds on that work.
   */
  private baseSubtask(mission: Mission, subtask: Mission["subtasks"][number]) {
    const byId = new Map(mission.subtasks.map(item => [item.id, item]));
    const ancestors = (id: string) => {
      const found = new Set<string>(), pending = [...(byId.get(id)?.dependsOn ?? [])];
      while (pending.length) {
        const next = pending.pop()!;
        if (found.has(next)) continue;
        found.add(next); pending.push(...(byId.get(next)?.dependsOn ?? []));
      }
      return found;
    };
    const candidates = [...ancestors(subtask.id)].map(id => byId.get(id)!)
      .filter(item => item.repoProjectId === subtask.repoProjectId && item.teamId && item.status === "done" && ["ready-for-review", "merged"].includes(item.teamStatus ?? ""));
    // Drop any candidate that a later candidate already builds on; among independent ones, take the most recently finished.
    const latest = candidates.filter(item => !candidates.some(other => other !== item && ancestors(other.id).has(item.id)));
    const finished = (item: typeof subtask) => { try { return this.teams.get(item.teamId!).updatedAt; } catch (error) { if (notFound(error)) return ""; throw error; } };
    return latest.sort((a, b) => finished(b).localeCompare(finished(a)))[0];
  }
  /** Mirrors each subteam's status and sends the coordinator each new decision, block, or finish once. */
  private async refresh(stored: Stored) {
    const mission = stored.mission;
    for (const subtask of mission.subtasks.filter(item => item.teamId)) {
      const teamId = subtask.teamId!;
      let team: TeamView;
      try { team = this.teams.get(teamId); }
      catch (error) {
        if (!notFound(error)) throw error;
        if (subtask.status === "cancelled" || subtask.teamStatus === "cancelled" || subtask.finalEvidence) {
          subtask.status = "cancelled"; subtask.teamStatus = "cancelled"; delete subtask.teamId;
          this.event(stored, "The host removed cancelled subtask " + subtask.id + "'s settled subteam record and workspace.");
          if (live.has(mission.status))
            this.message(stored, teamId + ":cancelled", { type: "subtask-finished", subtaskId: subtask.id, teamId, status: "cancelled", teamStatus: "cancelled",
              ...(subtask.finalEvidence?.reason ? { reason: subtask.finalEvidence.reason } : {}),
              retentionNote: "Cancelled run data and its workspace are deleted after its members settle. If work is still needed, dispatch a replacement subtask with a new ID in the same repository." });
          this.save(stored);
        }
        continue;
      }
      subtask.teamStatus = team.status;
      if (!stored.ops.some(op => op.kind === "parallelism" && op.teamId === team.id)) subtask.parallelism = team.parallelism;
      const status = subtaskStatus(team.status), changed = status !== subtask.status;
      subtask.status = status;
      if (status === "cancelled") subtask.finalEvidence = { ...(team.reason ? { reason: team.reason } : {}), ...(team.headCommit ? { headCommit: team.headCommit } : {}), usage: team.usage };
      if (changed && status !== "running") this.event(stored, `Subtask ${subtask.id} is ${status} (subteam ${team.status}).`);
      if (live.has(mission.status) && status !== "running") {
        const report = subteamReport(team), blocker = currentAgentBlockerEvidence(team);
        this.message(stored, `${team.id}:${status === "cancelled" ? "cancelled" : `${status}:${team.revision}`}`, { type: "subtask-finished", subtaskId: subtask.id, teamId: team.id, status, teamStatus: team.status,
          ...(team.reason ? { reason: team.reason } : {}),
          ...(report ? { report } : {}),
          ...(blocker ? { blocker } : {}),
          ...(status === "cancelled" ? { retentionNote: "Cancelled run data and its workspace are deleted after its members settle. If work is still needed, dispatch a replacement subtask with a new ID in the same repository." } : {}) });
      }
      if (status === "cancelled" && team.workspaceRemovedAt) {
        // Persist the host-observed cancellation and its final evidence before deleting the child record.
        this.save(stored);
        try { await this.teams.removeRun(team.id); }
        catch (error) { if (!notFound(error)) continue; }
        delete subtask.teamId;
        this.event(stored, `The host deleted cancelled subtask ${subtask.id}'s settled subteam record after its workspace was removed.`);
        this.save(stored);
        continue;
      }
      if (!live.has(mission.status)) continue;
      for (const decision of team.decisions.filter(item => item.revision === team.revision && !item.answer))
        this.message(stored, `${team.id}:${decision.id}`, { type: "child-decision", subtaskId: subtask.id, teamId: team.id, decisionId: decision.id, question: decision.question, options: decision.options,
          ...(decision.answerMode ? { answerMode: decision.answerMode } : {}) });
      // A permission diagnostic can finish without changing the team's phase. Wake its
      // supervising coordinator once, with observations rather than approval authority.
      for (const outcome of team.permissionRecovery?.outcomes ?? []) {
        if (outcome.revision !== team.revision) continue;
        const brief = (value: string) => value.slice(0, 240);
        this.message(stored, `${team.id}:permission-recovery:${outcome.id}`, {
          type: "permission-recovery", subtaskId: subtask.id, teamId: team.id,
          outcomeId: outcome.id, status: outcome.status, cause: brief(outcome.cause),
          action: brief(outcome.action), decision: brief(outcome.decision),
          consequence: brief(outcome.consequence), execution: "unknown",
        });
      }
    }
  }
  private connectorSource(mission: Mission): ConnectorSource | undefined {
    return [...mission.decisions].reverse().find(item => item.source)?.source
      ?? [...mission.steering].reverse().map(item => item.source).find((source): source is ConnectorSource => typeof source === "object")
      ?? mission.origin?.source;
  }
  private async applyOps(stored: Stored) {
    const remaining: ChildOp[] = [], steered: (string | undefined)[] = [];
    for (const op of [...stored.ops]) {
      let team: TeamView;
      try { team = this.teams.get(op.teamId); } catch (error) { if (notFound(error)) continue; throw error; }
      const settled = teamDone.has(team.status) || team.status === "cancelled";
      if (op.halt) {
        // The halt's own pause or resume: the subteam decides in its own queue, against the halt's token.
        try {
          const done = op.kind === "pause" ? await this.teams.haltPauseChild(op.teamId, op.halt.token, op.halt.reason ?? stored.mission.reason ?? "") : await this.teams.haltResumeChild(op.teamId, op.halt.token);
          const mark = stored.ownerHalt;
          if (op.kind === "pause" && done && mark?.token === op.halt.token && !mark.children.includes(op.teamId)) mark.children.push(op.teamId);
        } catch (error) {
          if (this.closed) return;
          if (!(error instanceof TeamError)) throw error;
          if (["members-stopping", "team-operation-running"].includes(error.code)) { remaining.push(op); continue; }
          this.event(stored, `A ${op.kind} for subtask ${op.subtaskId} was not applied: ${error.message}`);
        }
        continue;
      }
      if ((op.kind === "cancel" && settled) || (op.kind === "parallelism" && settled) || (op.kind === "pause" && (settled || ["paused", "blocked"].includes(team.status))) || (op.kind === "resume" && team.status !== "paused")) continue;
      const deadlineBlocked = stored.mission.status === "blocked" && stored.mission.stopReason === "deadline";
      // A resume waits while the mission is blocked at its time limit, and while the owner's halt covers any of its
      // repositories, as one that an extension queued during the halt does. The halt's own resume is decided above.
      if (op.kind === "resume" && (deadlineBlocked || this.fuse?.held?.(stored.mission.repoProjectIds))) { remaining.push(op); continue; }
      // Steering restarts a paused or blocked subteam, so direction waits until both it and its owning mission are running again.
      if (op.kind === "steer" && (team.status === "paused" || stored.mission.status === "paused" || deadlineBlocked)) { remaining.push(op); continue; }
      if (op.kind === "steer" && settled) { steered.push(`Subtask ${op.subtaskId} finished before the direction reached it.`); continue; }
      // A delivered steer raises the team revision, so a steer already bound to a revision replays its request
      // and is rebound only after the team refuses that revision as stale.
      if (op.revision !== team.revision && !(op.kind === "steer" && op.revision !== undefined)) { op.requestId = randomUUID(); op.revision = team.revision; this.save(stored); }
      try {
        if (op.kind === "answer") await this.teams.answer(op.teamId, op.decisionId!, { requestId: op.requestId, revision: op.revision, text: op.text! }, undefined, op.by ?? "owner", op.source);
        else if (op.kind === "steer") team = await this.teams.steer(op.teamId, { requestId: op.requestId, revision: op.revision!, text: op.text! }, op.source ?? (op.by === "coordinator" ? "coordinator" : undefined));
        else if (op.kind === "parallelism") team = await this.teams.setMissionParallelism(op.teamId, { requestId: op.requestId, revision: op.revision!, parallelism: op.parallelism! });
        else await this.teams[op.kind](op.teamId, { requestId: op.requestId, revision: op.revision }, op.source);
      } catch (error) {
        if (this.closed) return;
        if (!(error instanceof TeamError)) throw error;
        if (["members-stopping", "team-operation-running", "team-paused", "stale-team-revision"].includes(error.code)) {
          if (op.kind === "steer" && error.code === "stale-team-revision") op.revision = undefined;
          remaining.push(op); continue;
        }
        if (op.kind === "steer") { steered.push(`The direction for subtask ${op.subtaskId} was not applied: ${error.message}`); continue; }
        this.event(stored, `A ${op.kind} for subtask ${op.subtaskId} was not applied: ${error.message}`);
        if (op.kind === "answer" && op.by === "coordinator" && live.has(stored.mission.status)) stored.inbox.push({ type: "refused", kind: "answer-child", reason: error.message });
        continue;
      }
      if (op.kind === "answer") this.event(stored, `Decision ${op.decisionId} of subtask ${op.subtaskId} was answered by the ${op.by}.`);
      if (op.kind === "parallelism") {
        const subtask = stored.mission.subtasks.find(item => item.id === op.subtaskId);
        if (subtask) subtask.parallelism = team.parallelism;
        this.event(stored, `The mission coordinator set subtask ${op.subtaskId} to a ${team.parallelism}-worker limit.`);
      }
      if (op.kind === "steer") {
        // Mirror the restarted subteam now, so a report consumed on this tick sees it working.
        const subtask = stored.mission.subtasks.find(item => item.id === op.subtaskId);
        if (subtask) Object.assign(subtask, { status: subtaskStatus(team.status), teamStatus: team.status });
        steered.push(undefined);
        this.event(stored, `Subtask ${op.subtaskId} received the coordinator's direction and is replanning.`);
      }
    }
    if (this.closed) return;
    stored.ops = remaining;
    // Steer outcomes apply in order once the queue is settled, so a resulting stop keeps its cancels: a delivered
    // direction resets the refusal count, and an undelivered one counts as a refused report.
    for (const reason of steered) {
      if (reason === undefined) stored.refusals = 0;
      else if (live.has(stored.mission.status)) this.refuse(stored, "steer-subtask", reason);
      else this.event(stored, `A steer was not applied: ${reason}`);
    }
    this.save(stored);
  }

  private assignment(stored: Stored, attempt: Attempt): TeamAssignment {
    return { runId: stored.mission.id, memberId: attempt.memberId, revision: attempt.revision, role: "mission-coordinator" };
  }
  private readReport(stored: Stored, attempt: Attempt) {
    let page: ReturnType<Manager["events"]>;
    do {
      page = this.manager.events(attempt.sessionId, attempt.cursor, 200, new Set(["mission-report"]));
      attempt.cursor = page.cursor;
      for (const event of page.events) {
        const parsed = missionReportEnvelopeSchema.safeParse(event.data);
        if (!parsed.success) continue;
        const envelope = parsed.data;
        if (envelope.missionId !== stored.mission.id || envelope.memberId !== attempt.memberId || envelope.revision !== attempt.revision) continue;
        attempt.report = envelope.report; attempt.status = "reported";
        if (envelope.note !== undefined) attempt.note = envelope.note;
        return;
      }
    } while (page.more);
  }
  /**
   * Whether the session's latest turn boundary in its journal is a turn-end that has settled. The attention
   * state alone is not enough: it keeps a past turn-end, so a continuing turn can read as finished on a quiet screen.
   */
  private turnEnded(attempt: Attempt) {
    let page: ReturnType<Manager["events"]>;
    do {
      page = this.manager.events(attempt.sessionId, attempt.signalCursor ?? 0, 200, new Set(["signal"]));
      attempt.signalCursor = page.cursor;
      for (const event of page.events) {
        const kind = String(event.data.kind);
        if (kind === "turn-end" || turnActivity.has(kind)) attempt.turnSignal = { kind, at: event.at };
      }
    } while (page.more);
    return attempt.turnSignal?.kind === "turn-end" && Date.now() - Date.parse(attempt.turnSignal.at) >= turnEndSettleMs;
  }
  private launched(attempt: Attempt) {
    try { this.manager.meta(attempt.sessionId); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  /** Applies a fuse result to the mission reason. True when the launch must wait. */
  private fuseWait(stored: Stored, result: FuseCheck | FuseAdmission) {
    const { wait, changed } = applyFuseReason(stored.mission, result);
    if (changed && wait) this.event(stored, stored.mission.reason!);
    if (changed) this.save(stored);
    return wait;
  }
  private async launch(stored: Stored, attempt: Attempt) {
    const mission = stored.mission;
    try {
      if (!this.launched(attempt)) {
        const projectId = mission.repoProjectIds[0];
        const halted = this.fuse?.held?.(mission.repoProjectIds); if (halted && this.fuseWait(stored, halted)) return;
        if (this.fuse && this.fuseWait(stored, this.fuse.check({ projectId }))) return;
        // A launch that the host's load holds is not charged to the fuse. The Manager repeats this check as its backstop.
        const hold = this.manager.hostLoad.held();
        if (hold) throw new LaunchHeldError(hold);
        if (this.fuse && this.fuseWait(stored, this.fuse.admit(workLaunch({ launchId: attempt.sessionId, projectId, provider: mission.lineup.coordinator.provider,
          team: this.assignment(stored, attempt), profile: mission.lineup.coordinator })))) return;
      }
      const session = await this.manager.createTeamSession({ requestId: attempt.sessionId, provider: mission.lineup.coordinator.provider, projectId: mission.repoProjectIds[0],
        title: `Mission coordinator: ${mission.title}`.slice(0, 100), prompt: attempt.prompt, ...(attempt.continuation ? { continuation: attempt.continuation } : {}) }, this.assignment(stored, attempt), stored.folder, mission.lineup.coordinator,
      this.config.teams?.workspaceDir, this.config.teams?.trustWorkspaces === true, { haltScope: mission.repoProjectIds });
      if (this.closed) return;
      attempt.status = "running"; attempt.startedAt ??= now();
      if (mission.reason?.startsWith(HOST_LOAD_REASON_PREFIX)) mission.reason = undefined;
      if (session.status === "unavailable") this.event(stored, "The coordinator runtime is unavailable; the mission is waiting for confirmed state.");
    } catch (error) {
      this.fuse?.release(attempt.sessionId);
      if (error instanceof LaunchHeldError) {
        // Only an empty reason or an earlier host-load hold is replaced; the event records the first hold, not each tick.
        if (holdsHostLoadReason(mission.reason)) {
          if (mission.reason === undefined) this.event(stored, `The coordinator launch is waiting: ${error.reason}`);
          mission.reason = error.reason; this.save(stored);
        }
        return;
      }
      if (error instanceof TeamError && (error.code === "fuse-open" || error.code === "halted")) return;
      if (error instanceof Error && /configured session limit/.test(error.message)) return;
      throw error;
    }
    this.save(stored);
  }
  private async stepCoordinator(stored: Stored) {
    const mission = stored.mission, attempt = stored.attempts.at(-1);
    if (!attempt || attempt.status === "stopped") return;
    if (attempt.status === "queued") {
      if (live.has(mission.status)) { await this.launch(stored, attempt); return; }
      if (!this.launched(attempt)) {
        // A pause withdraws an attempt that never launched; its messages, such as a fired follow-up, wait for the
        // attempt after resume. A blocked or cancelled mission emptied its queues when it stopped, so nothing returns.
        endAttempt(attempt);
        if (mission.status === "paused" || mission.status === "blocked" && mission.stopReason === "deadline") returnConsumed(stored, attempt);
        this.save(stored); return;
      }
      attempt.status = "running";
    }
    if (attempt.status === "running") {
      // A report filed while a missed-report stop is pending or being retried still counts.
      this.readReport(stored, attempt);
      if (attempt.status === "running" && !attempt.stopping && !attempt.missedReport && live.has(mission.status)) {
        const state = await this.manager.state(attempt.sessionId);
        if (attempt.continuation && state.nativeSession?.id === attempt.continuation.nativeSessionId) attempt.nativeConfirmed = true;
        // A coordinator that ends its turn without a report, or goes quiet, would otherwise hold the attempt open
        // while subteam and owner messages wait behind it. A provider prompt waiting on the owner is not quiet.
        const quiet = state.attention.state !== "needs-you" &&
          Date.now() - Date.parse(state.attention.lastActivityAt ?? attempt.startedAt ?? now()) > (this.config.teams?.stallMinutes ?? 30) * 60000;
        const ended = state.attention.state === "turn-finished" && this.turnEnded(attempt);
        if (state.status !== "exited" && !ended && !quiet) { this.save(stored); return; }
        this.readReport(stored, attempt);
        if (attempt.status === "running" && state.status === "exited") {
          if (!attempt.report && resumeFailed(state, attempt.continuation)) {
            this.failResume(stored, attempt);
            this.save(stored); return;
          }
          endAttempt(attempt);
          this.stop(stored, "blocked", "The mission coordinator exited without a valid structured report. Subteam workspaces remain available.");
          this.event(stored, stored.mission.reason!); this.save(stored); return;
        }
        if (attempt.status === "running") { attempt.missedReport = true; this.save(stored); }
      }
    }
    // A reported attempt, or one the mission no longer wants, is stopped before anything acts on its report.
    let state;
    if (!live.has(mission.status) && !attempt.stopping) { attempt.stopping = true; this.save(stored); }
    try { state = await this.manager.stopTeamSession(attempt.sessionId, attempt.stopRequestId, this.assignment(stored, attempt)); }
    catch { this.save(stored); return; }
    if (attempt.continuation && state.nativeSession?.id === attempt.continuation.nativeSessionId) attempt.nativeConfirmed = true;
    if (this.closed || state.status !== "exited") { this.save(stored); return; }
    // The session can no longer write, so this read is the last chance for a report filed before the stop.
    if (attempt.status === "running") this.readReport(stored, attempt);
    if (!attempt.report && resumeFailed(state, attempt.continuation)) {
      this.failResume(stored, attempt);
      this.save(stored); return;
    }
    endAttempt(attempt);
    const applied = Boolean(attempt.report) && live.has(mission.status);
    if (attempt.report) {
      if (applied) { this.keepNote(stored, attempt); this.consume(stored, attempt.report!, attempt); }
      else this.event(stored, "A coordinator report arrived after the mission stopped; it was not applied.");
      delete attempt.note;
    } else if (attempt.missedReport && live.has(mission.status) && !attempt.stopping)
      this.refuse(stored, "missing", "Your previous attempt ended without a mission report. File exactly one report in every attempt; report wait when nothing needs a decision.");
    // A consumed message is settled only by an applied report. A pause that stopped this attempt first returns its
    // messages for the attempt after resume; a conversation resumed inside the idle window may see them twice.
    // An attempt the host stopped while its mission was not live, and which ended after the mission went live again
    // (resume or extend), returns its messages too, so the next attempt reads them.
    if (!applied && (attempt.stopping && live.has(mission.status) || mission.status === "paused" || mission.status === "blocked" && mission.stopReason === "deadline")) returnConsumed(stored, attempt);
    this.save(stored);
  }
  /** Keeps the newest notes within the count and length limits; the oldest go first. A refused report's note is kept too. */
  private keepNote(stored: Stored, attempt: Attempt) {
    if (attempt.note === undefined) return;
    const notes = stored.coordinatorNotes ??= [];
    notes.push({ at: now(), text: attempt.note });
    while (notes.length > noteLimit || notes.reduce((total, note) => total + note.text.length, 0) > noteCharacters) notes.shift();
  }
  private failResume(stored: Stored, attempt: Attempt) {
    attempt.resumeFailed = true;
    attempt.missedReport = false;
    endAttempt(attempt);
    returnConsumed(stored, attempt);
    this.event(stored, "The coordinator's conversation could not be resumed; a fresh attempt starts with the full mission state.");
  }
  /** Starts the next coordinator attempt once the previous one stopped and a message needs it. */
  private async wake(stored: Stored) {
    const mission = stored.mission, last = stored.attempts.at(-1);
    if ((last && last.status !== "stopped") || !stored.inbox.length) return;
    if (stored.attempts.length >= maxAttempts) {
      this.stop(stored, "blocked", `The mission coordinator reached its limit of ${maxAttempts} attempts. Review the subtasks before starting a new mission.`);
      this.event(stored, mission.reason!); this.save(stored); return;
    }
    const revision = stored.attempts.length + 1, profile = mission.lineup.coordinator;
    let continuation: NativeContinuation | undefined, rotated: RotationRule | undefined;
    if (profile.provider === "claude") {
      for (let index = stored.attempts.length - 1; index >= 0; index--) {
        const previous = stored.attempts[index], nativeSessionId = previous.continuation?.nativeSessionId;
        const failedLater = (id: string) => stored.attempts.slice(index + 1).some(attempt => attempt.resumeFailed && attempt.continuation?.nativeSessionId === id);
        if (previous.nativeConfirmed && nativeSessionId && !failedLater(nativeSessionId)) { continuation = { mode: "resume", nativeSessionId }; break; }
        // A rotation retired every older conversation. When nothing from the rotation on can be resumed, the next
        // attempt starts fresh again rather than selecting, or rotating away from, a retired conversation.
        if (previous.rotated) break;
      }
      // A conversation that is idle, large, or long-lived costs more to resume than to restart from the mission state and notes.
      rotated = continuation && this.rotation(stored, continuation.nativeSessionId);
      if (rotated) continuation = undefined;
      continuation ??= { mode: "start", nativeSessionId: randomUUID() };
    }
    // Messages that need the coordinator go first; any beyond the limit wait for the next attempt rather than being dropped.
    const inbox = stored.inbox.slice(0, messageLimit), notes = stored.notes.slice(0, messageLimit - inbox.length);
    const waiting = stored.inbox.length + stored.notes.length - inbox.length - notes.length;
    // The prompt keeps a byte budget by leaving trailing messages queued, so inbox messages lead and notes are deferred first.
    // Each direction queues one owner-direction message, delivered in order, and only an ending mission drops the inbox.
    // So the directions whose message no attempt has taken are the newest ones; every older one reached an attempt.
    const undelivered = stored.inbox.filter(message => message.type === "owner-direction").length;
    const messages = [...inbox, ...notes], context = { openChildDecisions: this.openChildDecisions(stored), waiting, answerProjectId: this.config.intake?.mission.answerProjectId,
      notes: stored.coordinatorNotes ?? [], deliveredDirections: Math.max(0, mission.steering.length - undelivered) };
    const build = (list: MissionMessage[], promptContext: typeof context) => continuation?.mode === "resume"
      ? missionFollowUpPromptWithMessageCount(mission, stored.repos, list, revision, profile.provider, profile, promptContext)
      : missionPromptWithMessageCount(mission, stored.repos, list, revision, profile.provider, profile, promptContext);
    let built: ReturnType<typeof missionPromptWithMessageCount>;
    try { built = build(messages, context); }
    catch (error) {
      if (!(error instanceof TeamError) || error.code !== "mission-prompt-too-large") throw error;
      built = { prompt: "", includedMessageCount: 0, shortened: false };
    }
    if (!built.includedMessageCount) {
      this.stop(stored, "blocked", messageCannotFitReason);
      this.event(stored, messageCannotFitReason);
      this.save(stored);
      return;
    }
    if (mission.reason === messageTooLargeReason) mission.reason = undefined;
    if (built.shortened) this.event(stored, "The host shortened the next coordinator message to fit the prompt budget; its full record stays with its source.");
    const fromInbox = Math.min(built.includedMessageCount, inbox.length), fromNotes = built.includedMessageCount - fromInbox;
    const attempt: Attempt = { memberId: randomUUID(), sessionId: randomUUID(), revision, cursor: 0, stopRequestId: randomUUID(), status: "queued", ownerInputs: stored.ownerInputs ?? 0,
      prompt: built.prompt, ...(continuation ? { continuation } : {}), ...(rotated ? { rotated } : {}), consumedInbox: inbox.slice(0, fromInbox), consumedNotes: notes.slice(0, fromNotes) };
    stored.attempts.push(attempt); stored.inbox = stored.inbox.slice(fromInbox); stored.notes = stored.notes.slice(fromNotes);
    // A rotation is the host's choice, not a missed report, so it leaves the refusal count alone.
    if (rotated) this.event(stored, `The coordinator continues in a new conversation (rule: ${rotated}) because ${rotationText[rotated]}. It receives the full mission state and its own earlier notes.`);
    this.save(stored);
    await this.launch(stored, attempt);
  }

  /**
   * Whether the next attempt should start a new conversation instead of resuming this one: the first rule that holds,
   * in the order idle, size, age. A rule set to 0 is off; the size rule needs a usage observation and never fires without one.
   */
  private rotation(stored: Stored, nativeSessionId: string): RotationRule | undefined {
    const configured = this.config.autonomy?.continuity;
    const idleMinutes = configured?.rotateIdleMinutes ?? rotationDefaults.rotateIdleMinutes;
    const contextTokens = configured?.rotateContextTokens ?? rotationDefaults.rotateContextTokens;
    const attempts = configured?.rotateAttempts ?? rotationDefaults.rotateAttempts;
    const conversation = stored.attempts.filter(attempt => attempt.continuation?.nativeSessionId === nativeSessionId);
    const ran = conversation.filter(attempt => attempt.startedAt), latest = ran.at(-1);
    // An attempt stopped before endedAt existed has no end time, so the idle rule cannot judge it.
    if (idleMinutes && latest?.endedAt && Date.now() - Date.parse(latest.endedAt) >= idleMinutes * 60000) return "idle";
    if (contextTokens) {
      if (latest) this.observeContext(latest);
      const observed = [...ran].reverse().find(attempt => attempt.contextTokens !== undefined)?.contextTokens;
      if (observed !== undefined && observed >= contextTokens) return "size";
    }
    if (attempts && conversation.length >= attempts) return "age";
    return undefined;
  }
  /**
   * Reads new usage records from the attempt's session journal and keeps the context size of the newest model call in
   * the main conversation: its input, cache-read, cache-write, and output tokens. Subagent transcripts are skipped. A
   * journal that cannot be read leaves the observation as it was; it never stops the mission.
   */
  private observeContext(attempt: Attempt) {
    try {
      for (let pages = 0; pages < 50; pages++) {
        const page = this.manager.events(attempt.sessionId, attempt.usageCursor ?? 0, 200, new Set(["usage"]));
        attempt.usageCursor = page.cursor;
        for (const event of page.events) {
          const record = event.type === "usage" ? ledgerRecord(event.data) : undefined;
          if (!record || record.secondary) continue;
          const { input, cacheRead, cacheWrite, output } = record.tokens;
          attempt.contextTokens = input + cacheRead + cacheWrite + output;
        }
        if (!page.more) return;
      }
    } catch { /* no observation */ }
  }

  /** Every open subteam decision, read from the subteams rather than from messages, so none is lost between attempts. */
  private openChildDecisions(stored: Stored): MissionOpenChildDecision[] {
    const mission = stored.mission, open: MissionOpenChildDecision[] = [];
    for (const subtask of mission.subtasks.filter(item => item.teamId && item.status === "running")) {
      let team: TeamView;
      try { team = this.teams.get(subtask.teamId!); } catch (error) { if (notFound(error)) continue; throw error; }
      for (const decision of team.decisions.filter(item => item.revision === team.revision && !item.answer)) {
        const escalated = mission.decisions.find(item => item.childDecisionId === decision.id && !item.answer);
        const answering = stored.ops.find(op => op.kind === "answer" && op.decisionId === decision.id);
        open.push({ subtaskId: subtask.id, teamId: team.id, decisionId: decision.id, question: decision.question, options: decision.options,
          ...(decision.answerMode ? { answerMode: decision.answerMode } : {}),
          ...(escalated ? { ownerDecisionId: escalated.id } : {}), ...(answering ? { answerPendingBy: answering.by ?? "owner" } : {}) });
      }
    }
    return open;
  }
  /**
   * Whether something other than the coordinator will start a later attempt: an open owner decision, a subteam
   * still working, or a queued subtask that can start without anyone acting. A paused subteam, or a repository
   * held only by paused or blocked runs, waits on a person, so it does not count.
   */
  private willWake(stored: Stored) {
    const mission = stored.mission;
    if (mission.decisions.some(item => !item.answer)) return true;
    if (openFollowUps(mission).length) return true;
    // The subteam's live status, since a resume applied on this tick is not yet mirrored into the subtask.
    const working = (teamId: string) => {
      if (stored.ops.some(op => op.kind === "resume" && op.teamId === teamId)) return true;
      try { return this.teams.get(teamId).status !== "paused"; } catch (error) { if (notFound(error)) return false; throw error; }
    };
    if (mission.subtasks.some(item => item.status === "running" && working(item.teamId!))) return true;
    const stalled = stalledSubtasks(mission);
    const ready = mission.subtasks.filter(item => item.status === "queued" && !stalled.has(item.id) &&
      item.dependsOn.every(id => mission.subtasks.find(other => other.id === id)?.status === "done"));
    if (ready.some(item => stored.launches[item.id])) return true;
    if (!ready.length) return false;
    // Every holder must finish on its own: one paused or blocked holder keeps the repository reserved after the others end.
    const runs = this.teams.list();
    return ready.some(item => holdersOf(runs, item.repoProjectId).every(run => !waitsOnPerson(run.status)));
  }
  private refuse(stored: Stored, kind: string, reason: string, wake = true) {
    stored.refusals++;
    this.event(stored, `The coordinator's ${kind} report was refused: ${reason}`);
    if (stored.refusals >= 3) {
      this.stop(stored, "blocked", `The coordinator's reports were refused three times in a row. Last refusal: ${reason}`);
      return;
    }
    (wake ? stored.inbox : stored.notes).push({ type: "refused", kind, reason });
  }
  private dispatchError(stored: Stored, plans: MissionSubtaskPlan[]) {
    const mission = stored.mission;
    if (mission.subtasks.length + plans.length > mission.maxSubtasks) return `The mission allows at most ${mission.maxSubtasks} subtasks in total.`;
    const ids = new Set(mission.subtasks.map(item => item.id));
    for (const plan of plans) {
      if (ids.has(plan.id)) return `Subtask ID ${plan.id} is already used.`;
      ids.add(plan.id);
      const repo = stored.repos.find(item => item.projectId === plan.repoProjectId);
      if (!repo) return `Repository ${plan.repoProjectId} is not part of this mission's project.`;
      if (!repo.teamReady) return `Repository ${plan.repoProjectId} is not configured for subteams.`;
    }
    for (const plan of plans) if (plan.dependsOn.some(id => id === plan.id || !ids.has(id))) return `Subtask ${plan.id} depends on an unknown subtask or on itself.`;
    for (const plan of plans) if (plan.dependsOn.length > 12) return `Subtask ${plan.id} exceeds the 12-dependency limit after repository ordering.`;
    // Earlier subtasks cannot depend on new ones, so a cycle can only form inside this batch.
    const placed = new Set(mission.subtasks.map(item => item.id)), pending = [...plans];
    while (pending.length) {
      const index = pending.findIndex(plan => plan.dependsOn.every(id => placed.has(id)));
      if (index < 0) return "The subtask dependencies form a cycle.";
      placed.add(pending.splice(index, 1)[0].id);
    }
    return undefined;
  }
  private chainDispatch(stored: Stored, plans: MissionSubtaskPlan[]) {
    const mission = stored.mission;
    const normalized = plans.map(plan => ({ ...plan, parallelism: plan.size === "solo" ? 1 : plan.parallelism, dependsOn: [...plan.dependsOn] }));
    const dependencies = new Map<string, string[]>();
    for (const subtask of mission.subtasks) dependencies.set(subtask.id, subtask.dependsOn);
    for (const plan of normalized) dependencies.set(plan.id, plan.dependsOn);
    const history = mission.subtasks.map(subtask => ({ id: subtask.id, repoProjectId: subtask.repoProjectId, status: subtask.status }));
    const generated: { subtaskId: string; predecessorId: string }[] = [];
    const ancestorsOf = (id: string) => {
      const found = new Set<string>(), pending = [...(dependencies.get(id) ?? [])];
      while (pending.length) {
        const next = pending.pop()!;
        if (found.has(next)) continue;
        found.add(next);
        pending.push(...(dependencies.get(next) ?? []));
      }
      return found;
    };
    for (const plan of normalized) {
      const predecessor = [...history].reverse().find(item => item.repoProjectId === plan.repoProjectId && item.status !== "cancelled");
      if (predecessor && !ancestorsOf(plan.id).has(predecessor.id)) {
        plan.dependsOn.push(predecessor.id);
        generated.push({ subtaskId: plan.id, predecessorId: predecessor.id });
      }
      history.push({ id: plan.id, repoProjectId: plan.repoProjectId, status: "queued" });
    }
    return { plans: normalized, generated };
  }
  private consume(stored: Stored, report: MissionReport, attempt: Attempt) {
    const mission = stored.mission;
    if (mission.mode === "answer" && ["dispatch", "resize-subtask", "cancel-subtask", "steer-subtask", "answer-child"].includes(report.kind)) return this.refuse(stored, report.kind, answerDispatchRefusal);
    if (mission.mode === "answer" && report.kind === "follow-up") return this.refuse(stored, report.kind, answerFollowUpRefusal);
    const subtask = "subtaskId" in report && report.subtaskId ? mission.subtasks.find(item => item.id === report.subtaskId) : undefined;
    if ("subtaskId" in report && report.subtaskId && !subtask) return this.refuse(stored, report.kind, `Subtask ${report.subtaskId} does not exist.`);
    const openChildDecision = (decisionId: string) => {
      if (!subtask?.teamId) return undefined;
      try {
        const team = this.teams.get(subtask.teamId);
        return team.decisions.find(item => item.id === decisionId && item.revision === team.revision && !item.answer);
      } catch (error) { if (notFound(error)) return undefined; throw error; }
    };
    switch (report.kind) {
      case "dispatch": {
        const { plans, generated } = this.chainDispatch(stored, report.subtasks);
        const error = this.dispatchError(stored, plans);
        if (error) return this.refuse(stored, report.kind, error);
        for (const plan of plans) mission.subtasks.push({ ...plan, status: "queued" });
        mission.dispatchSummary = report.summary;
        const edges = generated.length ? ` The host added same-repository dependencies: ${generated.map(edge => `${edge.subtaskId} depends on ${edge.predecessorId}`).join("; ")}.` : "";
        this.event(stored, `The coordinator dispatched ${plans.length} subtask${plans.length === 1 ? "" : "s"}.${edges}`);
        break;
      }
      case "resize-subtask": {
        if ((stored.ownerInputs ?? 0) !== (attempt.ownerInputs ?? 0)) {
          this.event(stored, `The coordinator's resize-subtask report for ${subtask!.id} was not applied because the owner sent direction or an answer after that attempt started.`);
          stored.inbox.push({ type: "refused", kind: report.kind, reason: "The owner sent direction or an answer after your previous attempt started. Reassess the worker limit before reporting again." });
          return;
        }
        const ceiling = subtask!.size === "solo" ? 1 : 4;
        if (report.parallelism > ceiling) return this.refuse(stored, report.kind, `Subtask ${subtask!.id} supports at most ${ceiling} worker${ceiling === 1 ? "" : "s"}.`);
        if (subtask!.status === "queued" && !subtask!.teamId) {
          subtask!.parallelism = report.parallelism;
          const launch = stored.launches[subtask!.id];
          if (launch) launch.parallelism = report.parallelism;
          this.event(stored, `The mission coordinator set queued subtask ${subtask!.id} to a ${report.parallelism}-worker limit: ${report.summary}`);
          break;
        }
        if (subtask!.status !== "running" || !subtask!.teamId)
          return this.refuse(stored, report.kind, `Subtask ${subtask!.id} is not queued or running, so its worker limit cannot change.`, false);
        let team: TeamView;
        try { team = this.teams.get(subtask!.teamId); }
        catch (error) { if (notFound(error)) return this.refuse(stored, report.kind, `The subteam for ${subtask!.id} no longer exists.`, false); throw error; }
        if (team.missionId !== mission.id || team.projectId !== subtask!.repoProjectId)
          return this.refuse(stored, report.kind, `The recorded subteam for ${subtask!.id} does not belong to this mission and repository.`, false);
        this.queueOp(stored, { kind: "parallelism", subtaskId: subtask!.id, teamId: team.id, parallelism: report.parallelism });
        this.event(stored, `The mission coordinator requested a ${report.parallelism}-worker limit for subtask ${subtask!.id}: ${report.summary}`);
        break;
      }
      case "answer-child": {
        if (!openChildDecision(report.decisionId)) return this.refuse(stored, report.kind, "That subteam decision is not open.");
        this.queueOp(stored, { kind: "answer", subtaskId: subtask!.id, teamId: subtask!.teamId!, decisionId: report.decisionId, text: report.text, by: this.connectorSource(mission) ? "connector" : "coordinator", ...(this.connectorSource(mission) ? { source: this.connectorSource(mission) } : {}) });
        for (const decision of mission.decisions.filter(item => item.childDecisionId === report.decisionId && !item.answer))
          Object.assign(decision, { answer: report.text, answeredAt: now(), answeredBy: this.connectorSource(mission) ? "connector" : "coordinator", ...(this.connectorSource(mission) ? { source: this.connectorSource(mission) } : {}) });
        this.event(stored, `The coordinator${this.connectorSource(mission) ? ` carrying ${inputSourceLabel(this.connectorSource(mission))} input` : ""} answered decision ${report.decisionId} of subtask ${subtask!.id}.`);
        break;
      }
      case "question": {
        if (report.childDecisionId && !subtask) return this.refuse(stored, report.kind, "A forwarded question must name its subtask.");
        const forwardedDecision = report.childDecisionId ? openChildDecision(report.childDecisionId) : undefined;
        if (report.childDecisionId && !forwardedDecision) return this.refuse(stored, report.kind, "That subteam decision is not open.");
        if (report.childDecisionId && mission.decisions.some(item => item.childDecisionId === report.childDecisionId && !item.answer))
          return this.refuse(stored, report.kind, "That subteam decision is already waiting for the owner.", false);
        if (mission.decisions.length >= 40) return this.refuse(stored, report.kind, "The mission reached its limit of 40 owner decisions.");
        const answerMode = report.answerMode ?? forwardedDecision?.answerMode;
        if (answerMode === "approval" && report.options.length !== 2)
          return this.refuse(stored, report.kind, "Approval questions require exactly two options: approve first and deny second.");
        if (answerMode === "multiple" && report.options.length < 2)
          return this.refuse(stored, report.kind, "Multiple-selection questions require at least two options.");
        mission.decisions.push({ id: randomUUID(), question: report.question, options: report.options, createdAt: now(),
          ...(answerMode ? { answerMode } : {}),
          ...(subtask ? { subtaskId: subtask.id } : {}), ...(report.childDecisionId ? { childDecisionId: report.childDecisionId } : {}) });
        this.event(stored, "The coordinator asked the owner a question.");
        break;
      }
      case "steer-subtask": {
        if (!["running", "blocked"].includes(subtask!.status) || !subtask!.teamId)
          return this.refuse(stored, report.kind, `Subtask ${subtask!.id} has no running or blocked subteam. A queued subtask receives owner direction when it starts; dispatch a follow-up subtask for finished work.`, false);
        this.queueOp(stored, { kind: "steer", subtaskId: subtask!.id, teamId: subtask!.teamId, text: report.text, by: this.connectorSource(mission) ? "connector" : "coordinator", ...(this.connectorSource(mission) ? { source: this.connectorSource(mission) } : {}) });
        this.event(stored, `The coordinator${this.connectorSource(mission) ? ` carrying ${inputSourceLabel(this.connectorSource(mission))} input` : ""} sent direction to subtask ${subtask!.id}.`);
        break;
      }
      case "cancel-subtask": {
        if (subtask!.status === "done" || subtask!.status === "cancelled") return this.refuse(stored, report.kind, `Subtask ${subtask!.id} has already finished.`, false);
        if (subtask!.teamId) this.queueOp(stored, { kind: "cancel", subtaskId: subtask!.id, teamId: subtask!.teamId });
        else if (!stored.launches[subtask!.id]) {
          // No subteam will report this cancellation, so the coordinator hears it from the host.
          subtask!.status = "cancelled";
          stored.inbox.push({ type: "subtask-finished", subtaskId: subtask!.id, status: "cancelled", reason: "Cancelled before its subteam started." });
        }
        else return this.refuse(stored, report.kind, `Subtask ${subtask!.id} is starting; cancel it after it appears.`);
        this.event(stored, `The coordinator cancelled subtask ${subtask!.id}: ${report.reason}`);
        break;
      }
      case "result": {
        if ((stored.ownerInputs ?? 0) !== (attempt.ownerInputs ?? 0)) {
          // Not the coordinator's fault, so it does not count as a refusal; the owner input waits in the inbox for the next attempt.
          this.event(stored, "The coordinator's result was not applied: the owner sent direction or an answer after that attempt started. A new attempt will consider it.");
          stored.inbox.push({ type: "refused", kind: report.kind, reason: "The owner sent direction or an answer after your previous attempt started. Account for it before reporting a result." });
          return;
        }
        const answering = mission.mode === "answer";
        if (!answering) {
          if (!mission.subtasks.some(item => item.status === "done")) return this.refuse(stored, report.kind, "No subtask has finished. Dispatch a subtask before reporting a result, or report blocked.");
          const stalled = stalledSubtasks(mission);
          const pending = mission.subtasks.filter(item => item.status === "running" || (item.status === "queued" && !stalled.has(item.id))).length;
          if (pending) return this.refuse(stored, report.kind, `${pending} subtask${pending === 1 ? " is" : "s are"} still queued or running. Wait for them to finish or cancel them first.`, false);
          const unfinished = mission.subtasks.filter(item => item.status === "blocked" || stalled.has(item.id)).map(item => item.id);
          if (unfinished.length) return this.refuse(stored, report.kind, `Subtask${unfinished.length === 1 ? "" : "s"} ${unfinished.join(", ")} did not finish. Cancel each with cancel-subtask, dispatch a replacement, or report blocked.`);
        }
        if (mission.decisions.some(item => !item.answer)) return this.refuse(stored, report.kind, "An owner decision is still open.", false);
        mission.result = { summary: report.summary, revision: mission.revision, at: now() };
        mission.status = "ready-for-review"; mission.reason = undefined; stored.inbox = []; stored.notes = [];
        cancelFollowUps(mission);
        this.event(stored, answering ? "The coordinator reported an answer. The mission started no subteam and changed nothing." : "Every subtask finished and the coordinator reported a result. Ready for owner review; the mission itself published nothing.");
        break;
      }
      case "wait": {
        // A subteam decision wakes the coordinator once; waiting past it would leave the subteam waiting with nothing to wake either.
        const unhandled = this.openChildDecisions(stored).find(item => !item.ownerDecisionId && !item.answerPendingBy);
        if (unhandled) return this.refuse(stored, report.kind, `Decision ${unhandled.decisionId} of subtask ${unhandled.subtaskId} is still open. Answer it with answer-child, ask the owner with question, or cancel the subtask.`);
        // Waiting is accepted only when something will start a later attempt: a message that arrived during this attempt
        // (such as a follow-up that fired while it ran) already waits in the inbox, or a subteam, the owner, or an open follow-up will.
        if (!stored.inbox.length && !this.willWake(stored)) return this.refuse(stored, report.kind, "Nothing is running or waiting for the owner, and no follow-up is open, so no later attempt would start. Dispatch, cancel, report a result, ask the owner, set a follow-up, or report blocked.");
        this.event(stored, "The coordinator is waiting for subteam progress, owner input, or a follow-up.");
        break;
      }
      case "follow-up": {
        const unhandled = this.openChildDecisions(stored).find(item => !item.ownerDecisionId && !item.answerPendingBy);
        if (unhandled) return this.refuse(stored, report.kind, `Decision ${unhandled.decisionId} of subtask ${unhandled.subtaskId} is still open. Answer it with answer-child, ask the owner with question, or cancel the subtask.`);
        if (openFollowUps(mission).length >= followUpLimit)
          return this.refuse(stored, report.kind, `${followUpLimit} follow-ups are already open. Act on what you planned to check, wait for one to come due, or report wait.`);
        const at = Date.now(), dueAt = at + report.inMinutes * 60000, deadline = this.deadlineMs(stored, at);
        if (dueAt >= deadline)
          return this.refuse(stored, report.kind, `That time is at or after the mission deadline, ${utcMinute(new Date(deadline).toISOString())}. Choose an earlier time, decide now, or report blocked.`);
        // One report per attempt, so the attempt's member ID names its follow-up and a replayed report adds nothing.
        const followUp: MissionFollowUp = { id: attempt.memberId, dueAt: new Date(dueAt).toISOString(), reason: report.reason, check: report.check, createdAt: new Date(at).toISOString(), state: "open" };
        if (!(mission.followUps ??= []).some(item => item.id === followUp.id)) mission.followUps.push(followUp);
        this.event(stored, `The coordinator plans to look again at ${utcMinute(followUp.dueAt)}: ${report.reason}`);
        break;
      }
      case "blocked":
        // A coordinator can be carrying a stale blocker report while a subteam's own
        // project manager is still trying its bounded, in-scope recovery. Keep that
        // work supervised and wait for its next state change before asking again.
        if (mission.subtasks.some(item => {
          if (!item.teamId) return false;
          try {
            const team = this.teams.get(item.teamId);
            return ["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering"].includes(team.status)
              && (team.recovery?.status === "stopping" || team.recovery?.status === "planning");
          } catch (error) { if (notFound(error)) return false; throw error; }
        })) {
          const reason = `A subteam's bounded recovery is still in progress. Reassess the mission blocker after it finishes. Your deferred report was: ${report.summary}`;
          this.event(stored, `The coordinator's blocked report was deferred: ${reason}`);
          // Do not count this as a refusal or put it in the wake inbox. A child
          // status change will wake the next attempt and carry this note forward.
          stored.notes.push({ type: "refused", kind: report.kind, reason });
          break;
        }
        this.stop(stored, "blocked", report.summary);
        this.event(stored, "The coordinator reported that the mission is blocked.");
        break;
    }
    // A steer resets the refusal count only once its subteam accepts the direction.
    if (report.kind !== "steer-subtask") stored.refusals = 0;
    this.settle(stored);
  }
}

/** Unfinished team runs in a repository, which keep it reserved. */
const holdersOf = (runs: TeamView[], projectId: string) => runs.filter(run => run.projectId === projectId && !["cancelled", "ready-for-review", "merged", "no-change"].includes(run.status));
/** A paused or blocked run continues only when a person acts. */
const waitsOnPerson = (status: TeamView["status"]) => status === "paused" || status === "blocked";

/** Queued subtasks that can never start, because a dependency ended blocked or cancelled, directly or transitively. */
function stalledSubtasks(mission: Mission) {
  const stalled = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const item of mission.subtasks.filter(item => item.status === "queued" && !stalled.has(item.id)))
      if (item.dependsOn.some(id => stalled.has(id) || ["blocked", "cancelled"].includes(mission.subtasks.find(other => other.id === id)?.status ?? "cancelled"))) { stalled.add(item.id); grew = true; }
  }
  return stalled;
}

const oneLine = (text: string | undefined) => {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
};
const teamStep: Record<string, string> = {
  planning: "Planning", discovering: "Gathering evidence", implementing: "Implementing", integrating: "Integrating", verifying: "Running checks",
  reviewing: "Independent review", delivering: "Delivering", paused: "Paused", "ready-for-review": "Ready for review", merged: "Merged",
  "no-change": "No change needed", cancelled: "Cancelled",
};
const openTeamQuestion = (team: TeamView | undefined) => team?.decisions.find(decision => decision.revision === team.revision && !decision.answer)?.question;
/**
 * The structured evidence of the one current-revision agent block that matches the team's reason. Summary-only,
 * ambiguous, superseded, and host-generated blocks carry none, so evidence never attaches to another report.
 */
function currentAgentBlockerEvidence(team: TeamView): BlockerEvidence | undefined {
  if (team.status !== "blocked" || team.blockCode !== "agent-blocked") return undefined;
  const matches = team.members.filter(member => member.revision === team.revision && member.report?.kind === "blocked" && member.report.summary === team.reason);
  const report = matches.length === 1 ? matches[0]?.report : undefined;
  return report?.kind === "blocked" ? report.blocker : undefined;
}
/** A member stopped on a provider prompt waits on the person; the team never approves it. */
const waitsOnProvider = (team: TeamView | undefined) => Boolean(team && !["cancelled", "ready-for-review", "merged", "no-change"].includes(team.status) && team.reason === providerInputReason);
function teamDetail(team: TeamView) {
  const question = openTeamQuestion(team);
  if (question) return question;
  if (waitsOnProvider(team)) return providerInputReason;
  if (team.status === "blocked" || team.status === "cancelled") return team.reason ?? teamStep[team.status] ?? team.status;
  const integrated = team.tasks.filter(task => task.status === "integrated").length;
  return `${teamStep[team.status] ?? team.status}${team.tasks.length && team.status === "implementing" ? `: ${integrated} of ${team.tasks.length} tasks integrated` : ""}`;
}
/** Cancelled subtasks are left out, so done/total counts only work the mission still owes. */
const subtaskCounts = (mission: Mission) => ({ total: mission.subtasks.filter(item => item.status !== "cancelled").length,
  running: mission.subtasks.filter(item => item.status === "running").length, done: mission.subtasks.filter(item => item.status === "done").length });
/** Only a mission still under way waits on a subteam's provider prompt; an ended one is past it even while its cancel cascades. */
const promptedSubtask = (mission: Mission, teamById: Map<string, TeamView>) => ["planning", "working", "needs-input", "paused"].includes(mission.status)
  ? mission.subtasks.find(item => item.teamId && waitsOnProvider(teamById.get(item.teamId))) : undefined;
function missionDetail(mission: Mission, teamById: Map<string, TeamView>) {
  // An ended mission no longer takes answers, so its open question is not its caption.
  const question = ["cancelled", "ready-for-review"].includes(mission.status) ? undefined : mission.decisions.find(decision => !decision.answer)?.question;
  if (question) return question;
  const prompted = promptedSubtask(mission, teamById);
  if (prompted) return `Subtask ${prompted.id}: ${providerInputReason}`;
  if (mission.status === "blocked" || mission.status === "cancelled" || mission.status === "paused") return mission.reason ?? mission.status;
  if (mission.status === "ready-for-review") return mission.result?.summary ?? "Ready for review";
  // A coordinator sleeping until its follow-up, with no subteam running, would otherwise look stalled.
  const next = openFollowUps(mission).sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  if (next && mission.coordinator?.status === "waiting" && !mission.subtasks.some(item => item.status === "running"))
    return `Waiting until ${utcMinute(next.dueAt)} to look again: ${next.reason}`;
  if (!mission.subtasks.length) return "Planning subtasks";
  const counts = subtaskCounts(mission), running = mission.subtasks.filter(item => item.status === "running");
  return `${running.length ? `Running: ${running.map(item => item.title).join(", ")}. ` : ""}${counts.done} of ${counts.total} subtasks done`;
}

/**
 * Marks repeated starts of the same work. Missions, or standalone runs, of one project with the same objective are
 * attempts of one work item: the owner sent it again after an earlier one stopped. Numbers count the attempts the
 * host still holds, oldest first. An older attempt that is blocked or cancelled is superseded; one still under way
 * or awaiting review is not, so a client that folds superseded attempts never hides work that can still change.
 */
function markAttempts(entries: { item: BoardItem; scope: string; objective: string | undefined }[]) {
  const works = new Map<string, BoardItem[]>();
  for (const { item, scope, objective } of entries) {
    const text = objective?.trim().replace(/\s+/g, " ");
    if (!text) continue;
    const workId = `${item.kind}-${createHash("sha256").update(`${item.kind}\n${scope}\n${text}`).digest("hex").slice(0, 16)}`;
    works.set(workId, [...works.get(workId) ?? [], item]);
  }
  for (const [workId, attempts] of works) {
    if (attempts.length < 2) continue;
    attempts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    attempts.forEach((item, index) => {
      item.attempt = { workId, number: index + 1, of: attempts.length, superseded: index < attempts.length - 1 && ["blocked", "cancelled"].includes(item.status) };
    });
  }
}
/** The owner's board: missions, plus team runs and goals that no mission started. Goal cycles appear through their goal. */
export function missionBoard(
  missions: Mission[], teams: TeamView[], goals: ProductGoal[], projects: Config["projects"],
  containing: (projectId: string) => { id: string; name: string } | undefined,
): Board {
  const projectName = (id: string) => projects.find(project => project.id === id)?.name ?? id;
  const teamById = new Map(teams.map(team => [team.id, team]));
  const items: BoardItem[] = [], attempts: Parameters<typeof markAttempts>[0] = [];
  for (const mission of missions) {
    const column: BoardColumn = ["needs-input", "blocked"].includes(mission.status) || promptedSubtask(mission, teamById) ? "needs-input" : mission.status === "ready-for-review" ? "review" : mission.status === "cancelled" ? "ended" : "working";
    // A mission started before its checkout folded keeps its pinned record; the row follows the project that holds that checkout now.
    const owner = mission.repoProjectIds.map(id => containing(id)).find(Boolean);
    items.push({ kind: "mission", id: mission.id, title: mission.title, groupId: owner?.id ?? mission.groupId, projectName: owner?.name ?? mission.groupName, column, status: mission.status,
      ...(mission.stopReason ? { stopReason: mission.stopReason } : {}),
      detail: oneLine(missionDetail(mission, teamById)), createdAt: mission.createdAt, updatedAt: mission.updatedAt,
      subtasks: subtaskCounts(mission) });
    attempts.push({ item: items.at(-1)!, scope: owner?.id ?? mission.groupId, objective: mission.objective });
  }
  for (const team of teams) {
    if (team.missionId || team.goal) continue;
    const owner = containing(team.projectId);
    const column: BoardColumn = ["needs-input", "blocked"].includes(team.status) || waitsOnProvider(team) ? "needs-input" : team.status === "ready-for-review" ? "review" : ["merged", "no-change", "cancelled"].includes(team.status) ? "ended" : "working";
    items.push({ kind: "team", id: team.id, title: team.title, ...(owner ? { groupId: owner.id } : {}), projectName: owner?.name ?? projectName(team.projectId), column, status: team.status, detail: oneLine(teamDetail(team)), createdAt: team.createdAt, updatedAt: team.updatedAt });
    attempts.push({ item: items.at(-1)!, scope: team.projectId, objective: team.objective });
  }
  for (const goal of goals) {
    const owner = containing(goal.projectId);
    const column: BoardColumn = ["needs-input", "blocked"].includes(goal.status) || (["running", "paused"].includes(goal.status) && goal.activeTeamId && waitsOnProvider(teamById.get(goal.activeTeamId))) ? "needs-input" : ["running", "paused"].includes(goal.status) ? "working" : goal.status === "ready-for-review" ? "review" : "ended";
    const active = goal.activeTeamId ? teamById.get(goal.activeTeamId) : undefined;
    const detail = openTeamQuestion(active) ?? (goal.status === "running" && active ? `Feature ${goal.cycles.length}: ${teamDetail(active)}` : goal.reason ?? goal.status);
    items.push({ kind: "goal", id: goal.id, title: goal.title, ...(owner ? { groupId: owner.id } : {}), projectName: owner?.name ?? projectName(goal.projectId), column, status: goal.status, detail: oneLine(detail), createdAt: goal.createdAt, updatedAt: goal.updatedAt });
  }
  markAttempts(attempts);
  const order: BoardColumn[] = ["needs-input", "working", "review", "ended"];
  items.sort((a, b) => order.indexOf(a.column) - order.indexOf(b.column) || b.updatedAt.localeCompare(a.updatedAt));
  return { items };
}
