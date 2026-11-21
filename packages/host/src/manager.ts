import { ProjectContexts } from "./project-context.js";
import { assertFreshNativeContext } from "./context-continuation.js";
import { handoffNativePrompt, handoffPathsOverlap } from "./handoff-types.js";
import { spawn } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  applyLifecycle,
  initialAttention,
  type Attention,
} from "@infinite/attention";
import { readEvents, unseal, writeSealed } from "./vault.js";
import { socketPath, workerCall } from "./ipc.js";
import { SealedFileCache, listedSavedState, listedSession, savedState, unavailableState, type ListedSession, type SavedStatus } from "./session-listing.js";
import { assertRunnerDeployment } from "./deployment.js";
import { DEFAULT_HOOKS } from "./config.js";
import { HostLoadGate, LaunchHeldError, readHostLoad, type HostLoadProbe } from "./host-load.js";
import { validateNativeCodexArgs } from "./native-codex.js";
import { validateNativeOpenCodeArgs } from "./native-opencode.js";
import { ContentError } from "./session-content.js";
import { fuseReason, workLaunch } from "./fuse/rules.js";
import type { FuseGate } from "./fuse/types.js";
import { haltReason } from "./halt/rules.js";
import { agentAcceptOption, isCollapsedPermissionPrompt, oneShotRejectOption, permissionEvidenceHash, oneShotPermissionOption } from "./team-permissions.js";
import { nativeContinuationSchema, teamModelProfileSchema, type NativeContinuation, type TeamAssignment, type TeamModelProfile, type TeamPermissionDecision } from "./team-types.js";
import { missionCoordinatorLaunch, permissionCoordinatorLaunch, sessionAgentProfile, teamModelLaunch, withoutSharedContext } from "./launch.js";
import { withNativeContinuation } from "./native-continuation.js";
import { SESSION_PERMISSION_ACTOR_LABEL, isRequesterNotice, sessionPermissionRequestId, type SessionPermissionAnswer } from "./permission-session-requests.js";
import { deferredCallOpen, type HeadlessPermissionChannel } from "./permission-headless.js";
import { agentBoundary, inventoryRuntimeProcesses, runtimeIdentity, stopRuntimeTree, type RuntimeProcess, type TeamRuntimeInspection, type TeamRuntimeRetirement } from "./team-retirement.js";
import { TeamError } from "./team-workspace.js";
import { projectGithubRepository, sessionGithubGrant, sessionGithubScopeFor, type GithubGrantScope, type SessionGithubOrigin } from "./github-grants.js";
import {
  learningPurpose, SESSION_PURPOSES,
  type SessionPurpose,
} from "./types.js";
import type {
  Config,
  Provider,
  Session,
  WorkerState,
  Bootstrap,
  LaptopWorkspace,
  WorkerRequest,
  ControlLease,
  Receipt,
  TeamPermissionExpansionExpectation,
} from "./types.js";

/** This stop attempt was refused before any worker RPC could deliver it. */
export class TeamStopRefused extends ContentError {}

export interface CreateSession {
  requestId: string;
  provider: Provider;
  projectId: string;
  title: string;
  generatedTitle?: true;
  prompt: string;
  nativeArgs?: string[];
  localUi?: boolean;
  /** Working directory relative to the configured project root. */
  cwd?: string;
  workspace?: LaptopWorkspace & { token: string };
  resumedFrom?: string;
  resumeNativeSession?: { id: string; source: "hook" | "protocol" };
  continuation?: NativeContinuation;
}
interface StoredSession {
  session: Session;
  fingerprint: string;
}
interface StoredTeamRetirement {
  state: "stopping" | "retired";
  requestId: string;
  identity: string;
  sessionId: string;
  seq: number;
  agentUid: number | null;
  known: RuntimeProcess[];
  at: string;
  stoppedAt?: string;
  processes?: RuntimeProcess[];
  unsignalable?: number[];
}
interface StoredTeamPermissionExpansion {
  digest: string;
  promptKey: string;
  receipt: Receipt;
  at: string;
}
interface TeamPermissionExpansionLedger {
  version: 1;
  requests: Record<string, StoredTeamPermissionExpansion>;
  prompts: Record<string, string>;
}
function mergeRecordedRuntimeTree(known: RuntimeProcess[], current: RuntimeProcess[]): RuntimeProcess[] {
  const prior = new Map(known.map(row => [row.pid, row]));
  const observed = new Map(current.map(row => [row.pid, row]));
  for (const row of known) {
    const now = observed.get(row.pid);
    if (now && now.born !== row.born) throw new TeamError(409, "runtime-identity-changed", "A recorded process ID now belongs to a different process.");
  }
  const roots = new Set(known.filter(row => {
    const now = observed.get(row.pid);
    return now?.born === row.born && !now.state.startsWith("Z");
  }).map(row => row.pid));
  for (;;) {
    const before = roots.size;
    for (const row of current) if (roots.has(row.parent)) roots.add(row.pid);
    if (roots.size === before) break;
  }
  for (const row of current) if (roots.has(row.pid)) {
    if (row.pid <= 1 || row.pid === process.pid) throw new TeamError(409, "runtime-identity-changed", "The runtime tree contains an unsafe process identity.");
    const old = prior.get(row.pid);
    if (old && old.born !== row.born) throw new TeamError(409, "runtime-identity-changed", "A discovered process ID now belongs to a different process.");
    prior.set(row.pid, row);
  }
  return [...prior.values()];
}
interface DeletedSessionReceipt {
  id: string;
  fingerprint: string;
}
export function projectCwd(projectPath: string, cwd?: string): string {
  const root = realpathSync(projectPath);
  if (cwd === undefined || cwd === "") return root;
  if (isAbsolute(cwd) || cwd.includes("\\") || cwd.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(cwd))
    throw new ContentError("The session directory must be inside its project", 400);
  const directory = realpathSync(resolve(root, cwd));
  const child = relative(root, directory);
  if (isAbsolute(child) || child === ".." || child.startsWith("../") || !statSync(directory).isDirectory()) throw new ContentError("The session directory must be inside its project", 400);
  return directory;
}
/** List rows stay small: the last message is cut and tool input stays on the detail endpoint. */
export function publicAttention(att: Attention): Attention {
  const lastMessage = att.lastMessage?.slice(0, 280);
  const limit = att.limit ? { ...att.limit, message: att.limit.message.slice(0, 300) } : undefined;
  if (!att.prompt) return { ...att, lastMessage, ...(limit ? { limit } : {}) };
  const { tool, ...prompt } = att.prompt;
  return {
    ...att,
    ...(limit ? { limit } : {}),
    prompt: {
      ...prompt,
      ...(tool ? { tool: { name: tool.name, input: {} } } : {}),
      // Decided on the full prompt, since the row drops the tool input the check reads.
      ...(oneShotPermissionOption(att.prompt) !== undefined ? { delegable: true } : {}),
    },
    lastMessage,
  };
}
/**
 * Older workers deliberately survive API upgrades and answer `state` without attention. Such a
 * row gets an attention block so list rows, the Notifier and the phone never meet a missing
 * field, but the block never invents an idle or finished state: a live old worker reads as
 * `unavailable` (the host cannot tell what it is doing) and a stopped one keeps its lifecycle.
 */
export function withDefaultAttention(
  state: Omit<WorkerState, "attention"> & { attention?: Attention },
  now = new Date().toISOString(),
): WorkerState {
  if (state.attention) return state as WorkerState;
  const status =
    state.status === "exited" || state.status === "recording-error"
      ? state.status
      : "unavailable";
  return {
    ...state,
    attention: applyLifecycle(initialAttention(now, false), status, now),
  };
}
export class Manager {
  private serial: Promise<unknown> = Promise.resolve();
  /** Holds sessions the host starts for itself while the host is short of memory or overloaded. */
  readonly hostLoad: HostLoadGate;
  private readonly handoffProjects = new Map<string, string>();
  private fuse?: FuseGate;
  private readonly listedMeta = new SealedFileCache<ListedSession>((id, raw) => listedSession(unseal<StoredSession>(this.key, `${id}:meta`, raw).session));
  private readonly savedStatus = new SealedFileCache<SavedStatus>((id, raw, mtimeMs) => ({ state: unseal<WorkerState>(this.key, `${id}:status`, raw), savedAt: new Date(mtimeMs).toISOString() }));
  /** The launch gate: the owner's halt, then the launch-rate fuse. Without one, every session starts as before and nothing is counted. */
  useFuse(fuse: FuseGate) { this.fuse = fuse; }
  private headlessChannel?: Pick<HeadlessPermissionChannel, "admit">;
  /** The headless permission channel. Without one, every headless launch starts as before. */
  useHeadlessChannel(channel: Pick<HeadlessPermissionChannel, "admit">) { this.headlessChannel = channel; }
  reserveHandoff(projectId: string) {
    const project = this.config.projects.find(project => project.id === projectId);
    if (!project) throw new ContentError("Handoff project is unavailable");
    this.handoffProjects.set(projectId, realpathSync(project.path));
  }
  releaseHandoff(projectId: string) { this.handoffProjects.delete(projectId); }
  async assertHandoffAlone(sessionId: string) {
    const source = this.meta(sessionId).session;
    for (const id of readdirSync(join(this.config.stateDir, "sessions")).filter(id => /^[a-f0-9-]{36}$/.test(id))) {
      if (id === sessionId) continue;
      const other = this.meta(id).session;
      if ((await this.state(id)).status === "exited") continue;
      const otherPath = realpathSync(other.cwd);
      const overlappingPath = handoffPathsOverlap(realpathSync(source.cwd), otherPath);
      if (other.projectId === source.projectId || overlappingPath)
        throw new ContentError("Another session in this project has not confirmed exit");
    }
  }
  async stopHandoffSession(sessionId: string, requestId: string) {
    if (!this.meta(sessionId).session.handoff?.policy || !this.handoffRequest(sessionId))
      throw new ContentError("This session has not requested handoff", 403);
    const state = await this.state(sessionId);
    if (state.status === "exited") {
      if (state.handoffQuiescence?.requestId !== requestId) throw new ContentError("The source exited without verified handoff process quiescence");
      return state;
    }
    if (state.status !== "running") throw new ContentError("The source runtime has not confirmed a controllable state");
    await workerCall(this.config.runDir, sessionId, { op: "handoff-stop", requestId }, 10000);
    return this.state(sessionId);
  }
  constructor(
    readonly config: Config,
    readonly key: Buffer,
    hostProbe: HostLoadProbe = readHostLoad,
  ) {
    assertRunnerDeployment(config);
    this.hostLoad = new HostLoadGate(config.hostLoad, hostProbe);
    mkdirSync(join(config.stateDir, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    const deletedDir = join(config.stateDir, "deleted-sessions");
    mkdirSync(deletedDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(deletedDir).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = name.slice(0, -7);
      let receipt: DeletedSessionReceipt;
      try {
        receipt = unseal<DeletedSessionReceipt>(key, `deleted:${id}`, readFileSync(join(deletedDir, name), "utf8"));
      } catch {
        continue;
      }
      if (receipt.id !== id || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) continue;
      rmSync(join(config.stateDir, "sessions", id), { recursive: true, force: true });
    }
    mkdirSync(config.runDir, { recursive: true, mode: 0o700 });
    if (
      Buffer.byteLength(
        join(config.runDir, "00000000-0000-0000-0000-000000000000.sock"),
      ) > 100
    )
      throw new Error(
        "runDir is too long for a Unix socket; choose a shorter path",
      );
  }
  private deletedReceiptPath(id: string) {
    return join(this.config.stateDir, "deleted-sessions", `${id}.sealed`);
  }
  meta(id: string): StoredSession {
    if (existsSync(this.deletedReceiptPath(id))) throw Object.assign(new Error("Session not found"), { code: "ENOENT" });
    return unseal(
      this.key,
      `${id}:meta`,
      readFileSync(
        join(this.config.stateDir, "sessions", id, "meta.sealed"),
        "utf8",
      ),
    );
  }
  setArchived(id: string, archived: boolean): Promise<StoredSession["session"]> {
    const operation = this.serial.then(async () => {
      const stored = this.meta(id);
      if (stored.session.team) throw new ContentError("Team sessions cannot be archived", 409);
      if ((await this.state(id)).status !== "exited")
        throw new ContentError("Only an exited session can be archived", 409);

      const { archivedAt: _archivedAt, ...unarchived } = stored.session;
      const session = archived
        ? { ...stored.session, archivedAt: stored.session.archivedAt ?? new Date().toISOString() }
        : unarchived;
      writeSealed(
        join(this.config.stateDir, "sessions", id, "meta.sealed"),
        this.key,
        `${id}:meta`,
        { session, fingerprint: stored.fingerprint },
      );
      return session;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  remove(id: string): Promise<void> {
    const operation = this.serial.then(async () => {
      const stored = this.meta(id);
      if (stored.session.team && !learningPurpose(stored.session.purpose)) throw new ContentError("Team sessions cannot be removed", 409); // the trial sweep removes a learning session

      let workerStateReadFailed = false;
      try {
        await workerCall(this.config.runDir, id, { op: "state" });
      } catch {
        workerStateReadFailed = true;
      }
      if (!workerStateReadFailed)
        throw new ContentError("Only an exited session with unavailable worker state can be removed", 409);

      const statusFile = join(this.config.stateDir, "sessions", id, "status.sealed");
      if (!existsSync(statusFile))
        throw new ContentError("Only an exited session with unavailable worker state can be removed", 409);
      let saved: WorkerState;
      try {
        saved = unseal<WorkerState>(this.key, `${id}:status`, readFileSync(statusFile, "utf8"));
      } catch {
        throw new ContentError("Only an exited session with unavailable worker state can be removed", 409);
      }
      if (saved.status !== "exited")
        throw new ContentError("Only an exited session with unavailable worker state can be removed", 409);

      writeSealed(
        this.deletedReceiptPath(id),
        this.key,
        `deleted:${id}`,
        { id, fingerprint: stored.fingerprint } satisfies DeletedSessionReceipt,
      );
      rmSync(join(this.config.stateDir, "sessions", id), { recursive: true });
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async state(id: string, screen = false): Promise<WorkerState> {
    try {
      return withDefaultAttention(
        await workerCall(this.config.runDir, id, { op: "state", screen }),
      );
    } catch {
      // Dated now, unlike a listing row: a mission's stall check reads `lastActivityAt` from here, and a worker does not
      // save its status on every activity, so a saved time would take a worker that missed one answer for quiet.
      const now = new Date().toISOString();
      const file = join(this.config.stateDir, "sessions", id, "status.sealed");
      if (existsSync(file)) {
        const saved = unseal<WorkerState>(
          this.key,
          `${id}:status`,
          readFileSync(file, "utf8"),
        );
        return savedState(saved, now);
      }
      return unavailableState(now);
    }
  }
  /**
   * `state(id)` for a listing. A worker is asked only when its socket file exists, since a
   * connect to a missing socket fails the same way; a failed ask falls through to the saved status.
   */
  private async listedState(id: string, createdAt: string): Promise<WorkerState> {
    if (existsSync(socketPath(this.config.runDir, id))) {
      try {
        return withDefaultAttention(await workerCall(this.config.runDir, id, { op: "state", screen: false }));
      } catch {
        // Fall through to the saved status, as state() does.
      }
    }
    const saved = this.savedStatus.read(id, join(this.config.stateDir, "sessions", id, "status.sealed"), Date.now());
    // A row without a saved status is unavailable since the session's creation, the one time its record holds.
    return saved === undefined ? unavailableState(createdAt) : listedSavedState(saved);
  }
  /**
   * Every session whose metadata can be read. One session's unreadable status (or a worker
   * that fails to answer) shows that row as unavailable instead of failing the whole list;
   * a session without readable metadata has no title or provider to show and is left out.
   */
  async list(options: { includeFullMessage?: boolean } = {}) {
    const now = Date.now();
    const ids = readdirSync(join(this.config.stateDir, "sessions")).filter(
      (n) => /^[a-f0-9-]{36}$/.test(n) && !existsSync(this.deletedReceiptPath(n)),
    );
    this.listedMeta.retain(new Set(ids), now);
    this.savedStatus.retain(new Set(ids), now);
    const rows = await Promise.allSettled(
      ids.map(async (id) => {
        // meta() refuses a session whose deletion receipt exists, as it did before the cache.
        if (existsSync(this.deletedReceiptPath(id))) throw new Error("Session not found");
        const summary = this.listedMeta.read(id, join(this.config.stateDir, "sessions", id, "meta.sealed"), now);
        if (summary === undefined) throw new Error("Session not found");
        const { screen: _screen, ...state } = await this.listedState(id, summary.createdAt).catch(
          () => unavailableState(summary.createdAt),
        );
        return {
          ...summary,
          ...state,
          attention: options.includeFullMessage ? state.attention : publicAttention(state.attention),
        };
      }),
    );
    const listed = rows.flatMap((row) =>
      row.status === "fulfilled" ? [row.value] : [],
    );
    for (const observer of this.listingObservers) try { observer(listed); } catch { /* an observer never fails a listing */ }
    return listed;
  }
  private readonly listingObservers = new Set<(rows: Awaited<ReturnType<Manager["list"]>>) => void>();
  /** Calls `observer` with every session listing, so a consumer that follows dialogs needs no listing of its own. */
  observeListings(observer: (rows: Awaited<ReturnType<Manager["list"]>>) => void): () => void {
    this.listingObservers.add(observer);
    return () => { this.listingObservers.delete(observer); };
  }

  /**
   * The identity of a session's meta file as the last listing kept it: it changes whenever the file is replaced.
   * Undefined when no settled parse is kept (a file younger than the settle time, or an id that is not listed).
   */
  metaRevision(id: string): string | undefined {
    return this.listedMeta.revision(id);
  }
  context(projectId: string) { return new ProjectContexts(this.config, this.key).context(projectId); }
  setContext(projectId: string, text: string, expectedVersion: number) {
    return new ProjectContexts(this.config, this.key).setContext(projectId, text, expectedVersion);
  }
  /** `startedBy: "owner"` states that the owner started this session; without it the session's GitHub grant is fetch only. */
  create(request: CreateSession, startedBy?: "owner"): Promise<Session & WorkerState> {
    if (request.continuation !== undefined)
      throw new ContentError("Native continuation is only available for managed coordinator team sessions", 400);
    const operation = this.serial.then(() => this.createOnce(request, false, startedBy === "owner" ? "owner-started" : undefined));
    this.serial = operation.catch(() => {});
    return operation;
  }
  /**
   * The team scheduler owns cwd selection, below the root its run was created under. Public create requests never accept this override.
   * `haltScope` names every project the work covers when that is more than the request's own project; the owner's halt
   * over any of them refuses the launch at its final admission.
   */
  createTeamSession(request: CreateSession, team: TeamAssignment, cwd: string, modelProfile?: TeamModelProfile, workspaceRoot?: string, workspaceTrusted = false,
    header: { purpose?: SessionPurpose; configId?: string; haltScope?: readonly string[] } = {}, github?: GithubGrantScope): Promise<Session & WorkerState> {
    if (!this.config.teams || request.nativeArgs !== undefined || request.localUi || request.workspace || request.resumedFrom)
      throw new ContentError("Team sessions require a configured team workspace and managed launch", 400);
    if (header.purpose !== undefined && !SESSION_PURPOSES.includes(header.purpose)) throw new ContentError("The session purpose is not recognized", 400);
    if (header.configId !== undefined && !/^[0-9a-f]{64}$/.test(header.configId)) throw new ContentError("The session config ID must be a lowercase SHA-256 digest", 400);
    let continuation: NativeContinuation | undefined;
    if (request.continuation !== undefined) {
      const parsed = nativeContinuationSchema.safeParse(request.continuation);
      if (!parsed.success) throw new ContentError("Native continuation must include a valid Claude session ID and start or resume mode", 400);
      continuation = parsed.data;
      if (request.provider !== "claude") throw new ContentError("Native continuation is only supported for Claude Code team sessions", 400);
      if (team.role !== "permission-coordinator" && team.role !== "mission-coordinator")
        throw new ContentError("Native continuation is only supported for permission or mission coordinators", 400);
    }
    const selection = modelProfile ? teamModelProfileSchema.parse(modelProfile) : undefined;
    if (selection && selection.provider !== request.provider) throw new ContentError("The team model profile does not match its assigned provider", 400);
    const root = realpathSync(workspaceRoot ?? this.config.teams.workspaceDir);
    const canonical = realpathSync(cwd);
    const rel = relative(root, canonical);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ContentError("Invalid team working directory", 400);
    // Trust and the halt scope are outside the request fingerprint: a replay returns the session as first created.
    const operation = this.serial.then(() => this.createOnce({
      ...request, ...(continuation ? { continuation } : {}), team, teamCwd: canonical, ...(selection ? { teamModelProfile: selection } : {}),
      ...(header.purpose !== undefined ? { purpose: header.purpose } : {}), ...(header.configId !== undefined ? { configId: header.configId } : {}),
    }, workspaceTrusted, { team: github }, header.haltScope));
    this.serial = operation.catch(() => {});
    return operation;
  }
  async inspectTeamRuntime(sessionId: string, team: TeamAssignment): Promise<TeamRuntimeInspection> {
    const stored = this.meta(sessionId).session;
    const same = (left: TeamAssignment | undefined) => Boolean(left && left.runId === team.runId && left.memberId === team.memberId &&
      left.revision === team.revision && left.role === team.role && left.taskId === team.taskId);
    if (!same(stored.team)) throw new TeamError(403, "team-assignment-mismatch", "This session does not match the exact team assignment.");
    const state = await this.state(sessionId);
    if (state.control) throw new TeamError(409, "control-busy", "A person currently controls this session.");
    if (state.status !== "recording-error") throw new TeamError(409, "runtime-not-retirable", "Only a runtime in recording-error can be retired.");
    let sealed: WorkerState;
    try { sealed = unseal<WorkerState>(this.key, `${sessionId}:status`, readFileSync(join(this.config.stateDir, "sessions", sessionId, "status.sealed"), "utf8")); }
    catch { throw new TeamError(409, "runtime-identity-changed", "The sealed worker identity is unavailable."); }
    const workerPid = sealed.workerPid;
    if (!workerPid || !Number.isSafeInteger(workerPid) || workerPid <= 1) throw new TeamError(409, "runtime-identity-changed", "The sealed worker identity is invalid.");
    const processes = await inventoryRuntimeProcesses();
    const worker = processes.find(row => row.pid === workerPid);
    if (!worker) throw new TeamError(409, "runtime-identity-changed", "The sealed worker process is no longer alive.");
    const pid = state.pid ?? sealed.pid ?? null;
    const pty = pid === null ? undefined : processes.find(row => row.pid === pid);
    if (pid === null || !pty || pty.parent !== workerPid) throw new TeamError(409, "runtime-identity-changed", "The PTY process no longer belongs to the sealed worker.");
    const selected = new Set([workerPid]);
    for (;;) { const before = selected.size; for (const row of processes) if (selected.has(row.parent)) selected.add(row.pid); if (selected.size === before) break; }
    const tree = processes.filter(row => selected.has(row.pid));
    if (tree.some(row => row.pid === process.pid || row.pid <= 1)) throw new TeamError(409, "runtime-identity-changed", "The runtime tree contains an unsafe process identity.");
    const boundary = this.config.teams?.commandPrefix ? agentBoundary(this.config.teams.commandPrefix, stored.cwd) : undefined;
    const agentUid = boundary ? await boundary.uid() : null;
    const identity = runtimeIdentity(sessionId, team, stored.runtime?.id ?? null, worker, pid, pty);
    return { sessionId, status: "recording-error", runtimeId: stored.runtime?.id ?? null, workerPid, pid, seq: state.seq,
      ...(state.attention?.since ? { since: state.attention.since } : {}), agentUid, processes: tree, identity };
  }
  retireTeamRuntime(sessionId: string, requestId: string, team: TeamAssignment, identity: string): Promise<TeamRuntimeRetirement> {
    const operation = this.serial.then(() => this.retireTeamRuntimeOnce(sessionId, requestId, team, identity));
    this.serial = operation.catch(() => {});
    return operation;
  }
  controlSession(sessionId: string, request: Extract<WorkerRequest, { op: "control" }>): Promise<ControlLease | null> {
    const operation = this.serial.then(async () => {
      this.meta(sessionId);
      if (request.action !== "release" && existsSync(join(this.config.stateDir, "sessions", sessionId, "retirement.sealed")))
        throw new TeamError(409, "runtime-retiring", "This runtime is being retired; its retained journal remains available read-only.");
      return workerCall<ControlLease | null>(this.config.runDir, sessionId, request);
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  private async retireTeamRuntimeOnce(sessionId: string, requestId: string, team: TeamAssignment, identity: string): Promise<TeamRuntimeRetirement> {
    const stored = this.meta(sessionId).session;
    const matches = stored.team && stored.team.runId === team.runId && stored.team.memberId === team.memberId &&
      stored.team.revision === team.revision && stored.team.role === team.role && stored.team.taskId === team.taskId;
    if (!matches) throw new TeamError(403, "team-assignment-mismatch", "This session does not match the exact team assignment.");
    if (!/^[a-f0-9]{64}$/.test(identity) || !requestId) throw new TeamError(409, "retirement-conflict", "A valid retirement request and inspected identity are required.");
    const file = join(this.config.stateDir, "sessions", sessionId, "retirement.sealed"), scope = `${sessionId}:retirement`;
    let record: StoredTeamRetirement;
    if (existsSync(file)) {
      try { record = unseal<StoredTeamRetirement>(this.key, scope, readFileSync(file, "utf8")); }
      catch { throw new TeamError(409, "retirement-conflict", "The existing runtime retirement record cannot be authenticated."); }
      if (record.requestId !== requestId || record.identity !== identity || record.sessionId !== sessionId) throw new TeamError(409, "retirement-conflict", "A different runtime retirement already owns this session.");
      if (record.state === "retired") return { state: "retired", requestId, identity, sessionId, seq: record.seq,
        stoppedAt: record.stoppedAt!, processes: record.processes ?? record.known, unsignalable: record.unsignalable ?? [] };
    } else {
      const inspection = await this.inspectTeamRuntime(sessionId, team);
      if (inspection.identity !== identity) throw new TeamError(409, "runtime-identity-changed", "The runtime identity changed before retirement began.");
      // Establish the configured process boundary before sealing a record or signaling anything.
      const boundary = this.config.teams?.commandPrefix ? agentBoundary(this.config.teams.commandPrefix, stored.cwd) : undefined;
      const agentUid = boundary ? await boundary.uid() : null;
      if (inspection.agentUid !== agentUid) throw new TeamError(409, "runtime-identity-changed", "The configured agent identity changed before retirement began.");
      record = { state: "stopping", requestId, identity, sessionId, seq: inspection.seq, agentUid, known: inspection.processes, at: new Date().toISOString() };
      writeSealed(file, this.key, scope, record);
    }
    const currentState = await this.state(sessionId);
    if (currentState.control) throw new TeamError(409, "control-busy", "A person currently controls this session.");
    if (currentState.status !== "recording-error" && !(record.state === "stopping" && ["unavailable", "exited"].includes(currentState.status)))
      throw new TeamError(409, "runtime-not-retirable", "Only a runtime in recording-error, or its authenticated in-progress retirement, can be retired.");
    const boundary = this.config.teams?.commandPrefix ? agentBoundary(this.config.teams.commandPrefix, stored.cwd) : undefined;
    const agentUid = boundary ? await boundary.uid() : null;
    if (record.agentUid !== agentUid) throw new TeamError(409, "runtime-identity-changed", "The configured agent identity changed during retirement.");
    const sealed = unseal<WorkerState>(this.key, `${sessionId}:status`, readFileSync(join(this.config.stateDir, "sessions", sessionId, "status.sealed"), "utf8"));
    const workerPid = sealed.workerPid;
    if (!workerPid || !record.known.some(row => row.pid === workerPid)) throw new TeamError(409, "runtime-identity-changed", "The recorded worker identity is unavailable.");
    // A prior attempt may have killed the worker but lost its acknowledgement. Rebuild only
    // descendants of still-live, start-time-matched recorded processes and seal them before
    // signaling so a later retry has the expanded identity set.
    record.known = mergeRecordedRuntimeTree(record.known, await inventoryRuntimeProcesses());
    writeSealed(file, this.key, scope, record);
    try {
      const result = await stopRuntimeTree(record.known, workerPid, {
        checkpoint: known => { record.known = known; writeSealed(file, this.key, scope, record); },
        ...(boundary && agentUid !== null ? { agent: { uid: agentUid, signal: boundary.signal } } : {}),
      });
      const retired: StoredTeamRetirement = { ...record, state: "retired", stoppedAt: new Date().toISOString(), known: result.processes, processes: result.processes, unsignalable: result.unsignalable };
      writeSealed(file, this.key, scope, retired);
      return { state: "retired", requestId, identity, sessionId, seq: retired.seq, stoppedAt: retired.stoppedAt!, processes: retired.processes!, unsignalable: retired.unsignalable! };
    } catch (error) {
      const updated = (error as Error & { knownProcesses?: RuntimeProcess[] }).knownProcesses;
      if (updated) record.known = mergeRecordedRuntimeTree(record.known, updated);
      try { record.known = mergeRecordedRuntimeTree(record.known, await inventoryRuntimeProcesses()); }
      catch (inventoryError) {
        if ((inventoryError as { code?: string }).code === "runtime-identity-changed") throw inventoryError;
      }
      writeSealed(file, this.key, scope, record);
      throw error;
    }
  }
  /** A scheduler may stop only its own member and never take over an active human lease. */
  async stopTeamSession(sessionId: string, requestId: string, team: TeamAssignment): Promise<WorkerState> {
    const stored = this.meta(sessionId).session.team;
    if (!stored || stored.runId !== team.runId || stored.memberId !== team.memberId || stored.revision !== team.revision)
      throw new TeamStopRefused("This session does not belong to the team assignment", 403);
    const state = await this.state(sessionId);
    if (state.status === "exited") return state;
    if (state.status !== "running") throw new TeamStopRefused("The team member has not confirmed a controllable runtime");
    await workerCall(this.config.runDir, sessionId, { op: "stop", requestId });
    return this.state(sessionId);
  }
  /** Expand the visible command text for one exact collapsed Codex prompt, without answering it. */
  expandTeamPermission(
    sessionId: string,
    requestId: string,
    team: TeamAssignment,
    expected: TeamPermissionExpansionExpectation,
  ): Promise<Receipt> {
    const operation = this.serial.then(() => this.expandTeamPermissionOnce(sessionId, requestId, team, expected));
    this.serial = operation.catch(() => {});
    return operation;
  }
  private async expandTeamPermissionOnce(
    sessionId: string,
    requestId: string,
    team: TeamAssignment,
    expected: TeamPermissionExpansionExpectation,
  ): Promise<Receipt> {
    const session = this.meta(sessionId).session;
    const stored = session.team;
    const validAssignment = (value: unknown): value is TeamAssignment => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Partial<TeamAssignment>;
      return typeof candidate.runId === "string" && typeof candidate.memberId === "string" &&
        Number.isInteger(candidate.revision) &&
        ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker"].includes(candidate.role ?? "") &&
        (candidate.taskId === undefined || typeof candidate.taskId === "string");
    };
    const sameAssignment = (left: TeamAssignment | undefined, right: TeamAssignment) =>
      Boolean(left && left.runId === right.runId && left.memberId === right.memberId &&
        left.revision === right.revision && left.role === right.role && left.taskId === right.taskId);
    if (!validAssignment(team) || !/^[a-f0-9-]{36}$/i.test(requestId) || !expected ||
        !Number.isInteger(expected.promptId) || expected.promptId < 1 ||
        !/^[a-f0-9]{64}$/i.test(expected.promptHash) || !/^[a-f0-9]{64}$/i.test(expected.evidenceHash) ||
        typeof expected.targetCwd !== "string" || expected.targetCwd.length < 1 || expected.targetCwd.length > 4096 ||
        typeof expected.expiresAt !== "string" || !Number.isFinite(Date.parse(expected.expiresAt)))
      throw new ContentError("The collapsed permission expansion request is incomplete or does not match the team assignment", 403);

    const requestIdentity = {
      sessionId,
      requestId,
      assignment: { runId: team.runId, memberId: team.memberId, revision: team.revision, role: team.role, taskId: team.taskId ?? null },
      expected: {
        promptId: expected.promptId, promptHash: expected.promptHash, evidenceHash: expected.evidenceHash,
        targetCwd: expected.targetCwd, expiresAt: expected.expiresAt,
      },
    };
    const digest = createHash("sha256").update(JSON.stringify(requestIdentity)).digest("hex");
    const promptKey = createHash("sha256").update(JSON.stringify({
      promptId: expected.promptId, promptHash: expected.promptHash, evidenceHash: expected.evidenceHash,
    })).digest("hex");
    const file = join(this.config.stateDir, "sessions", sessionId, "team-permission-expansions.sealed");
    const scope = `${sessionId}:team-permission-expansions`;
    let ledger: TeamPermissionExpansionLedger = { version: 1, requests: {}, prompts: {} };
    if (existsSync(file)) {
      try {
        const saved = unseal<TeamPermissionExpansionLedger>(this.key, scope, readFileSync(file, "utf8"));
        if (!saved || saved.version !== 1 || !saved.requests || typeof saved.requests !== "object" ||
            Array.isArray(saved.requests) || !saved.prompts || typeof saved.prompts !== "object" || Array.isArray(saved.prompts))
          throw new Error("Invalid expansion ledger");
        ledger = saved;
      } catch {
        throw new ContentError("The existing permission expansion receipt cannot be authenticated", 409);
      }
    }
    const previous = ledger.requests[requestId];
    if (previous) {
      if (previous.digest !== digest || previous.promptKey !== promptKey)
        throw new ContentError("Request ID already belongs to different permission expansion arguments", 409);
      return { ...previous.receipt };
    }
    const promptOwner = ledger.prompts[promptKey];
    if (promptOwner) throw new ContentError("This collapsed prompt already has a permission expansion request", 409);
    if (!stored || !sameAssignment(stored, team))
      throw new ContentError("The permission expansion does not match the current team assignment", 403);

    const assertEligible = (state: WorkerState, leaseId?: string) => {
      if (Date.parse(expected.expiresAt) <= Date.now())
        throw new ContentError("The permission expansion request expired");
      if (session.provider !== "codex" || session.runtime?.transport !== "pty" || session.runtime.nativeUi ||
          state.status !== "running" || state.runtime?.transport !== "pty" || state.runtime.nativeUi)
        throw new ContentError("The assigned team member has no running managed Codex terminal");
      if (state.control && (!leaseId || state.control.id !== leaseId))
        throw new ContentError("A person currently controls this session", 409);
      const prompt = state.attention.prompt;
      if (state.attention.state !== "needs-you" || !prompt || prompt.id !== expected.promptId ||
          prompt.hash !== expected.promptHash || permissionEvidenceHash(prompt) !== expected.evidenceHash ||
          !isCollapsedPermissionPrompt(prompt))
        throw new ContentError("The assigned Codex prompt is no longer the expected collapsed command", 409);
    };

    let canonicalCwd: string;
    try { canonicalCwd = realpathSync(session.cwd); }
    catch { throw new ContentError("The assigned team working directory is unavailable"); }
    if (expected.targetCwd !== canonicalCwd)
      throw new ContentError("The permission expansion targets a different working directory", 403);
    assertEligible(await this.state(sessionId));

    const actor = { id: `team-permission-expand:${requestId}`, label: "Team permission display expansion" };
    let lease: ControlLease | undefined;
    try {
      lease = await workerCall<ControlLease>(this.config.runDir, sessionId, {
        op: "control", action: "claim", actor,
      });
      const controlled = await this.state(sessionId);
      if (!lease?.id || controlled.control?.id !== lease.id)
        throw new ContentError("The team member control lease changed before display expansion", 409);
      assertEligible(controlled, lease.id);

      // Seal the at-most-once intent before the worker can send the toggle key. A
      // host crash or lost acknowledgement leaves an uncertain receipt that is
      // replayed as-is and never dispatched again.
      const receipt: Receipt = { requestId, state: "uncertain", seq: controlled.seq };
      ledger.requests[requestId] = { digest, promptKey, receipt, at: new Date().toISOString() };
      ledger.prompts[promptKey] = requestId;
      writeSealed(file, this.key, scope, ledger);

      try {
        const result = await workerCall<Receipt>(this.config.runDir, sessionId, {
          op: "team-permission-expand", requestId, targetSessionId: sessionId, assignment: stored,
          expected: requestIdentity.expected, actor, leaseId: lease.id,
        }, 12000);
        if (result?.requestId === requestId && (result.state === "delivered" || result.state === "uncertain") &&
            Number.isSafeInteger(result.seq) && result.seq >= 0) {
          ledger.requests[requestId].receipt = { ...result };
          writeSealed(file, this.key, scope, ledger);
          return { ...result };
        }
        return { ...receipt };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && ["unsupported", "prompt-changed", "control-busy", "control-lost"].includes(code)) {
          // A named worker refusal is guaranteed to precede its Ctrl+A write.
          delete ledger.requests[requestId];
          if (ledger.prompts[promptKey] === requestId) delete ledger.prompts[promptKey];
          writeSealed(file, this.key, scope, ledger);
          throw error;
        }
        return { ...receipt };
      }
    } finally {
      if (lease) {
        try { await workerCall(this.config.runDir, sessionId, { op: "control", action: "release", actor, leaseId: lease.id }); }
        catch { /* the next state read reports an expired or lost lease */ }
      }
    }
  }
  /** Apply only the persisted, one-shot approval for this exact assigned member and prompt. */
  async answerTeamPermission(
    sessionId: string,
    requestId: string,
    team: TeamAssignment,
    decision: TeamPermissionDecision,
    /** Whether the coordinator's authority to answer still stands. It is read under the control lease, before the key is sent. */
    current?: () => boolean,
  ): Promise<import("./types.js").Receipt & { result?: import("@infinite/attention").AnswerResult }> {
    const session = this.meta(sessionId).session;
    const stored = session.team;
    const validAssignment = (value: unknown): value is TeamAssignment => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Partial<TeamAssignment>;
      return typeof candidate.runId === "string" && typeof candidate.memberId === "string" &&
        Number.isInteger(candidate.revision) &&
        ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker"].includes(candidate.role ?? "") &&
        (candidate.taskId === undefined || typeof candidate.taskId === "string");
    };
    const sameAssignment = (left: TeamAssignment | undefined, right: TeamAssignment) =>
      Boolean(left && left.runId === right.runId && left.memberId === right.memberId &&
        left.revision === right.revision && left.role === right.role && left.taskId === right.taskId);
    if (!validAssignment(team) || !stored || !sameAssignment(stored, team) || decision.revision !== stored.revision ||
        decision.targetMemberId !== stored.memberId || decision.targetSessionId !== sessionId ||
        requestId !== decision.answerRequestId)
      throw new ContentError("This permission decision does not match the assigned team member", 403);
    if (decision.status !== "answering" || !/^[a-f0-9-]{36}$/i.test(decision.id) ||
        !/^[a-f0-9-]{36}$/i.test(decision.answerRequestId) ||
        !/^[a-f0-9]{64}$/i.test(decision.policyHash) || !decision.coordinatorMemberId ||
        !/^[a-f0-9-]{36}$/i.test(decision.coordinatorMemberId) ||
        !Number.isInteger(decision.promptId) || decision.promptId < 1 || decision.prompt.id !== decision.promptId ||
        !/^[a-f0-9]{64}$/i.test(decision.promptHash) || !/^[a-f0-9]{64}$/i.test(decision.evidenceHash) ||
        decision.prompt.hash !== decision.promptHash || permissionEvidenceHash(decision.prompt) !== decision.evidenceHash ||
        oneShotPermissionOption(decision.prompt) !== decision.option ||
        !Number.isFinite(Date.parse(decision.expiresAt)) || Date.parse(decision.expiresAt) <= Date.now())
      throw new ContentError("The permission decision is incomplete, expired, or not a one-shot approval");
    let canonicalCwd: string;
    try { canonicalCwd = realpathSync(session.cwd); }
    catch { throw new ContentError("The assigned team working directory is unavailable"); }
    if (decision.targetCwd !== canonicalCwd)
      throw new ContentError("The permission decision targets a different working directory", 403);
    const state = await this.state(sessionId);
    if (state.status !== "running" || session.runtime?.nativeUi || state.runtime?.nativeUi)
      throw new ContentError("The assigned team member has no running managed terminal");
    if (state.control) throw new ContentError("A person currently controls this session", 409);

    const actor = { id: `team-permission:${decision.id}`, label: "Team permission" };
    let lease: { id: string } | undefined;
    try {
      const acquired = await workerCall<{ id: string }>(this.config.runDir, sessionId, {
        op: "control", action: "claim", actor,
      });
      lease = acquired;
      const controlled = await this.state(sessionId);
      if (controlled.status !== "running" || controlled.control?.id !== acquired.id ||
          controlled.runtime?.nativeUi || session.runtime?.nativeUi)
        throw new ContentError("The team member or its control lease changed before the answer");
      if (decision.status !== "answering" || Date.parse(decision.expiresAt) <= Date.now() || (current && !current()))
        throw new ContentError("The permission decision was invalidated before the answer");
      try {
        return await workerCall(this.config.runDir, sessionId, {
          op: "team-answer", requestId, decisionId: decision.id,
          coordinatorMemberId: decision.coordinatorMemberId,
          targetSessionId: sessionId, assignment: stored, targetCwd: canonicalCwd,
          expiresAt: decision.expiresAt, policyHash: decision.policyHash,
          promptId: decision.promptId, promptHash: decision.promptHash,
          evidenceHash: decision.evidenceHash, option: decision.option,
          actor, leaseId: acquired.id,
        }, 12000);
      } catch (error) {
        if ((error as { code?: unknown }).code) throw error;
        // The worker may have written keys before its acknowledgement was lost. Never replay here.
        return { requestId, state: "uncertain", seq: controlled.seq };
      }
    } finally {
      if (lease) {
        try { await workerCall(this.config.runDir, sessionId, { op: "control", action: "release", actor, leaseId: lease.id }); }
        catch { /* a lost worker or lease is reported by the next state read */ }
      }
    }
  }
  /**
   * Types one permission-agent decision into a session outside any team run: the exact one-shot option,
   * under a host control lease, after the session, its directory and its control are checked again. A
   * team member's session is refused. An error with a code, or a ContentError, means nothing was typed.
   */
  async answerSessionPermission(sessionId: string, input: SessionPermissionAnswer): Promise<Receipt & { result?: import("@infinite/attention").AnswerResult }> {
    const session = this.meta(sessionId).session;
    if (session.team || session.workspace || session.executionLocation === "laptop" || session.runtime?.transport !== "pty" || session.runtime.nativeUi)
      throw new ContentError("Only an interactive host session outside a team run takes a permission-agent answer", 403);
    if (!input || typeof input.decisionId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.decisionId) ||
        !Number.isInteger(input.promptId) || input.promptId < 1 || !Number.isInteger(input.option) || input.option < 0 ||
        !/^[a-f0-9]{64}$/i.test(input.promptHash) || !/^[a-f0-9]{64}$/i.test(input.evidenceHash) || typeof input.targetCwd !== "string")
      throw new ContentError("The permission answer is incomplete");
    if (input.notice !== undefined && !isRequesterNotice(input.notice))
      throw new ContentError("The permission answer's notice is not the host's fixed reject notice");
    let cwd: string;
    try { cwd = realpathSync(session.cwd); }
    catch { throw new ContentError("The session directory is unavailable"); }
    if (cwd !== input.targetCwd) throw new ContentError("The permission answer targets a different directory", 403);
    const state = await this.state(sessionId);
    if (state.status !== "running" || state.runtime?.nativeUi) throw new ContentError("The session has no running managed terminal");
    if (state.control) throw new ContentError("A person currently controls this session", 409);
    const requestId = sessionPermissionRequestId(sessionId, input.decisionId);
    const actor = { id: `session-permission:${input.decisionId}`, label: SESSION_PERMISSION_ACTOR_LABEL };
    let lease: ControlLease | undefined;
    try {
      lease = await workerCall<ControlLease>(this.config.runDir, sessionId, { op: "control", action: "claim", actor });
      const controlled = await this.state(sessionId);
      if (controlled.status !== "running" || controlled.control?.id !== lease.id)
        throw new ContentError("The session or its control lease changed before the answer", 409);
      // The owner may have revoked or replaced the delegation while the lease was claimed.
      if (input.current && !input.current())
        throw new ContentError("The permission answer was invalidated before the answer", 409);
      try {
        return await workerCall(this.config.runDir, sessionId, {
          op: "session-permission-answer", requestId, decisionId: input.decisionId, targetSessionId: sessionId, targetCwd: cwd,
          promptId: input.promptId, promptHash: input.promptHash, evidenceHash: input.evidenceHash, option: input.option,
          ...(input.notice !== undefined ? { text: input.notice } : {}),
          actor, leaseId: lease.id,
        }, 12000);
      } catch (error) {
        if ((error as { code?: unknown }).code) throw error;
        // The worker may have typed before its acknowledgement was lost. Never replay here.
        return { requestId, state: "uncertain", seq: controlled.seq };
      }
    } finally {
      if (lease) {
        try { await workerCall(this.config.runDir, sessionId, { op: "control", action: "release", actor, leaseId: lease.id }); }
        catch { /* a lost worker or lease is reported by the next state read */ }
      }
    }
  }
  /**
   * Deliver one permission-agent decision to this exact assigned member's dialog: its one-shot accept, or its
   * one-shot reject with the host's fixed notice. `current` is the caller's live fence; it is read again after
   * the control lease is held and before the worker sends a key. The worker repeats the exact-screen check
   * before each key.
   */
  async answerAgentPermission(
    sessionId: string,
    team: TeamAssignment,
    delivery: {
      deliveryId: string; requestId: string; choice: "accept" | "reject"; option: number; notice?: string;
      prompt: import("@infinite/attention").Prompt; evidenceHash: string; targetCwd: string; expiresAt: string; authorityHash: string;
      current: () => boolean;
    },
  ): Promise<import("./types.js").Receipt & { result?: import("@infinite/attention").AnswerResult }> {
    const session = this.meta(sessionId).session;
    const stored = session.team;
    const sameAssignment = Boolean(stored && stored.runId === team.runId && stored.memberId === team.memberId &&
      stored.revision === team.revision && stored.role === team.role && stored.taskId === team.taskId);
    if (!sameAssignment || !/^[a-f0-9-]{36}$/i.test(delivery.deliveryId) || !/^[a-f0-9-]{36}$/i.test(delivery.requestId) ||
        team.role === "permission-coordinator")
      throw new ContentError("This permission delivery does not match the assigned team member", 403);
    const prompt = delivery.prompt;
    const option = delivery.choice === "accept" ? agentAcceptOption(prompt) : oneShotRejectOption(prompt);
    if (!prompt.hash || permissionEvidenceHash(prompt) !== delivery.evidenceHash || option === undefined || option !== delivery.option ||
        !/^[a-f0-9]{64}$/i.test(delivery.authorityHash) || !Number.isFinite(Date.parse(delivery.expiresAt)) || Date.parse(delivery.expiresAt) <= Date.now())
      throw new ContentError("The permission delivery is incomplete, expired, or not a one-shot option");
    let canonicalCwd: string;
    try { canonicalCwd = realpathSync(session.cwd); }
    catch { throw new ContentError("The assigned team working directory is unavailable"); }
    if (delivery.targetCwd !== canonicalCwd)
      throw new ContentError("The permission delivery targets a different working directory", 403);
    const state = await this.state(sessionId);
    if (state.status !== "running" || session.runtime?.nativeUi || state.runtime?.nativeUi)
      throw new ContentError("The assigned team member has no running managed terminal");
    if (state.control) throw new ContentError("A person currently controls this session", 409);

    const actor = { id: `team-permission:${delivery.deliveryId}`, label: "Team permission" };
    let lease: { id: string } | undefined;
    try {
      const acquired = await workerCall<{ id: string }>(this.config.runDir, sessionId, { op: "control", action: "claim", actor });
      lease = acquired;
      const controlled = await this.state(sessionId);
      if (controlled.status !== "running" || controlled.control?.id !== acquired.id || controlled.runtime?.nativeUi || session.runtime?.nativeUi)
        throw new ContentError("The team member or its control lease changed before the answer");
      if (!delivery.current() || Date.parse(delivery.expiresAt) <= Date.now())
        throw new ContentError("The permission delivery was invalidated before the answer");
      try {
        return await workerCall(this.config.runDir, sessionId, {
          op: "team-answer", requestId: delivery.requestId, decisionId: delivery.deliveryId, choice: delivery.choice,
          ...(delivery.choice === "reject" && delivery.notice ? { text: delivery.notice } : {}),
          targetSessionId: sessionId, assignment: stored!, targetCwd: canonicalCwd,
          expiresAt: delivery.expiresAt, policyHash: delivery.authorityHash,
          promptId: prompt.id, promptHash: prompt.hash, evidenceHash: delivery.evidenceHash, option: delivery.option,
          actor, leaseId: acquired.id,
        }, 12000);
      } catch (error) {
        if ((error as { code?: unknown }).code) throw error;
        // The worker may have written keys before its acknowledgement was lost. Never replay here.
        return { requestId: delivery.requestId, state: "uncertain", seq: controlled.seq };
      }
    } finally {
      if (lease) {
        try { await workerCall(this.config.runDir, sessionId, { op: "control", action: "release", actor, leaseId: lease.id }); }
        catch { /* a lost worker or lease is reported by the next state read */ }
      }
    }
  }
  /** Fences one permission-agent answer that is with a session outside a team run, after an owner act ended its authority. */
  async invalidateSessionPermission(sessionId: string, decisionId: string): Promise<"invalidated" | "uncertain"> {
    try {
      if (this.meta(sessionId).session.team || !/^[A-Za-z0-9._:-]{1,100}$/.test(decisionId)) return "uncertain";
      const result = await workerCall<{ invalidated: boolean }>(this.config.runDir, sessionId, {
        op: "session-permission-invalidate", decisionId,
      }, 4000);
      return result.invalidated === true ? "invalidated" : "uncertain";
    } catch { return "uncertain"; }
  }
  /** Fence one persisted delegated decision before its owner revokes or pauses it. */
  async invalidateTeamPermission(sessionId: string, decisionId: string): Promise<"invalidated" | "uncertain"> {
    if (!this.meta(sessionId).session.team || !/^[a-f0-9-]{36}$/i.test(decisionId)) return "uncertain";
    try {
      const result = await workerCall<{ invalidated: boolean }>(this.config.runDir, sessionId, {
        op: "team-answer-invalidate", decisionId,
      }, 4000);
      return result.invalidated === true ? "invalidated" : "uncertain";
    } catch { return "uncertain"; }
  }
  resume(sessionId: string, requestId: string, startedBy?: "owner"): Promise<Session & WorkerState> {
    const operation = this.serial.then(() => this.resumeOnce(sessionId, requestId, startedBy === "owner" ? "owner-started" : undefined));
    this.serial = operation.catch(() => {});
    return operation;
  }
  private async resumeOnce(sessionId: string, requestId: string, github?: SessionGithubOrigin): Promise<Session & WorkerState> {
    if (this.handoffRequest(sessionId)) throw new ContentError("This session yielded to a team; inspect its handoff instead of resuming it");
    if (requestId === sessionId) throw new ContentError("Resumption needs a new request identity", 400);
    const session = this.meta(sessionId).session;
    const project = this.config.projects.find(project => project.id === session.projectId);
    if (!project || (session.projectRoot ? realpathSync(project.path) !== session.projectRoot : session.cwd !== realpathSync(project.path)))
      throw new ContentError("The recorded conversation belongs to a different codebase binding. Start a new session.", 409);
    const receiptFile = join(this.config.stateDir, "resumptions", `${requestId}.sealed`);
    if (existsSync(receiptFile)) {
      const receipt = unseal<{ sourceId: string; targetId: string }>(this.key, `resume:${requestId}`, readFileSync(receiptFile, "utf8"));
      if (receipt.sourceId !== sessionId) throw new ContentError("Request ID already belongs to a different resumption");
      const target = this.meta(receipt.targetId).session;
      if (target.projectId !== session.projectId || (target.projectRoot ?? target.cwd) !== realpathSync(project.path))
        throw new ContentError("The saved continuation receipt belongs to another project or codebase. Open the original session instead.", 409);
      return { ...target, ...(await this.state(receipt.targetId)) };
    }
    const remember = (result: Session & WorkerState) => {
      writeSealed(receiptFile, this.key, `resume:${requestId}`, { sourceId: sessionId, targetId: result.id });
      return result;
    };
    if (session.team) throw new ContentError("Resume this member from its team so its assignment stays consistent");
    // An ordinary resume has no permission channel, so the provider's own rules would decide the call the owner was asked about.
    if (session.headless?.channel && deferredCallOpen((after, limit) => this.events(sessionId, after, limit, new Set(["lifecycle"]))))
      throw new ContentError("This session ended while a call waited for the owner's answer. Start a new session instead of resuming it.", 409);
    const state = await this.state(sessionId);
    if (state.status === "running" || state.status === "starting") return remember({ ...session, ...state });
    const native = state.nativeSession ?? session.resumeNativeSession;
    if (state.status !== "exited") throw new ContentError("The previous process has not confirmed exit. Reconnect before resuming.");
    if (!native || !/^[A-Za-z0-9_-]{1,200}$/.test(native.id) || !["claude", "codex", "opencode"].includes(session.provider))
      throw new ContentError("This recording has no supported native conversation to resume");
    if (session.workspace) throw new ContentError("Recover this hybrid workspace with the laptop CLI before starting a new runtime");
    const args = session.provider === "claude" ? ["--resume", native.id]
      : session.provider === "codex" ? ["resume", native.id] : ["--session", native.id];
    const request: CreateSession = { requestId, provider: session.provider, projectId: session.projectId,
      title: session.title, prompt: "", nativeArgs: args, resumedFrom: sessionId, resumeNativeSession: native };
    if (project) {
      const cwd = relative(realpathSync(project.path), session.cwd);
      if (cwd) request.cwd = cwd;
    }
    // Creation metadata is durable before spawn. Recover its exact receipt even
    // if the API stopped before it could record the resumption result.
    if (existsSync(join(this.config.stateDir, "sessions", requestId, "meta.sealed")))
      return remember(await this.createOnce(request, false, github));
    const ids = readdirSync(join(this.config.stateDir, "sessions")).filter(id => /^[a-f0-9-]{36}$/.test(id) && id !== sessionId);
    const continuations = await Promise.all(ids.map(async id => {
      let candidate: Session;
      try { candidate = this.meta(id).session; }
      catch { throw new ContentError("A recording cannot be authenticated. Recover it before starting another continuation."); }
      if (candidate.provider !== session.provider) return undefined;
      const current = await this.state(id).catch(() => unavailableState(new Date().toISOString()));
      if (candidate.resumedFrom !== sessionId && candidate.resumeNativeSession?.id !== native.id && current.nativeSession?.id !== native.id) return undefined;
      if (current.status === "exited") return undefined;
      if (candidate.projectId !== session.projectId || (candidate.projectRoot ?? candidate.cwd) !== realpathSync(project.path))
        throw new ContentError("This native conversation has a continuation in another project or codebase. Open its original session instead.", 409);
      if (current.status !== "running" && current.status !== "starting")
        throw new ContentError("Another continuation has not confirmed exit. Reconnect before resuming.");
      return { ...candidate, ...current };
    }));
    const live = continuations.filter((candidate): candidate is Session & WorkerState => candidate !== undefined);
    if (live.length > 1) throw new ContentError("Multiple continuations are active. Open an existing session before resuming.");
    if (live[0]) return remember(live[0]);
    // Use the same admission queue as create, without re-entering it.
    return remember(await this.createOnce(request, false, github));
  }
  /**
   * Creates the session, or returns the one its request already made. A team launch that fails before its session
   * record exists gives its fuse launch back: the count stays, and a retry with the same id is not counted twice.
   */
  private async createOnce(request: CreateSession & { team?: TeamAssignment; teamCwd?: string; teamModelProfile?: TeamModelProfile; purpose?: SessionPurpose; configId?: string }, workspaceTrusted = false, github?: SessionGithubOrigin, haltScope?: readonly string[]) {
    try { return await this.createRecorded(request, workspaceTrusted, github, haltScope); }
    catch (error) {
      // A started launch stays started, and a failing fuse never hides the launch error.
      if (request.team) try { this.fuse?.release(request.requestId); } catch { /* the launch error is the one to report */ }
      throw error;
    }
  }
  /** `github` says who decided the session's GitHub grant; see SessionGithubOrigin. `haltScope` is every project the work covers. */
  private async createRecorded(request: CreateSession & { team?: TeamAssignment; teamCwd?: string; teamModelProfile?: TeamModelProfile; purpose?: SessionPurpose; configId?: string }, workspaceTrusted = false, github?: SessionGithubOrigin, haltScope?: readonly string[]) {
    if (!request.resumedFrom && request.nativeArgs) assertFreshNativeContext(request.provider, request.nativeArgs);
    if (request.workspace && (request.provider !== "codex" || !request.localUi))
      throw new Error("Laptop execution requires the Codex native interface");
    if (request.localUi) {
      if (!["codex", "opencode"].includes(request.provider)) throw new Error("Local native UI is available for Codex and OpenCode");
      if (request.provider === "codex") validateNativeCodexArgs(request.nativeArgs ?? [], request.nativeArgs === undefined ? request.prompt : "", Boolean(request.workspace));
      else validateNativeOpenCodeArgs(request.nativeArgs ?? [], request.nativeArgs === undefined ? request.prompt : "");
    }
    const id = request.requestId;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    const dir = join(this.config.stateDir, "sessions", id);
    const deletedPath = this.deletedReceiptPath(id);
    if (existsSync(deletedPath)) {
      const deleted = unseal<DeletedSessionReceipt>(this.key, `deleted:${id}`, readFileSync(deletedPath, "utf8"));
      if (deleted.id !== id) throw new Error("Invalid deleted session receipt");
      if (deleted.fingerprint !== fingerprint) throw new Error("Request ID already belongs to a different session");
      throw new ContentError("This session was deleted and cannot be started again", 410);
    }
    if (existsSync(join(dir, "meta.sealed"))) {
      const stored = this.meta(id);
      if (stored.fingerprint !== fingerprint)
        throw new Error("Request ID already belongs to a different session");
      return { ...stored.session, ...(await this.state(id)) };
    }
    const project = this.config.projects.find(
      (p) => p.id === request.projectId,
    );
    if (!project) throw new Error("Unknown project");
    if (request.provider === "demo" && !this.config.enableDemo)
      throw new Error("Demo is disabled");
    // Only sessions the host starts for itself wait for capacity; an owner-started session is never held.
    if (request.team) {
      const hold = this.hostLoad.held();
      if (hold) throw new LaunchHeldError(hold);
    }
    if (
      (await this.list()).filter(
        (s) => s.status === "running" || s.status === "starting",
      ).length >= this.config.maxSessions
    )
      throw new Error("The configured session limit has been reached");
    // The backstop: a team session is charged before any session directory exists. A replay returned above, and a
    // launch that its caller already admitted is recognised by its id and not charged again. The owner's halt sits in
    // front of the fuse, so a halted launch is refused with its own code. It runs after every wait above and right
    // before the session record is written, over every project the work covers, and it gives back any admission that
    // the caller made for this launch, so a launch the halt refuses leaves the fuse count as it was.
    if (request.team && this.fuse) {
      const spanning = haltScope?.length ? this.fuse.held?.(haltScope) : undefined;
      const admission = spanning ? { ok: false as const, launchId: id, halted: spanning }
        : this.fuse.admit(workLaunch({ launchId: id, projectId: request.projectId, provider: request.provider, team: request.team, profile: request.teamModelProfile, purpose: request.purpose }));
      if (!admission.ok && "halted" in admission) {
        this.fuse.refund?.(id);
        throw new TeamError(409, "halted", haltReason(admission.halted));
      }
      if (!admission.ok) throw new TeamError(409, "fuse-open", fuseReason("open" in admission ? admission.open : "write-failed"));
    }
    if (!request.team && [...this.handoffProjects.values()].some(path => handoffPathsOverlap(path, realpathSync(project.path)))) throw new ContentError("This project is capturing an accepted team handoff");
    const configuredProfile = sessionAgentProfile(this.config, request.provider, request.purpose);
    if (!configuredProfile) throw new Error("Provider is not configured on this host");
    let profile = request.teamModelProfile ? teamModelLaunch(configuredProfile, request.teamModelProfile) : configuredProfile;
    if (request.team?.role === "permission-coordinator") profile = permissionCoordinatorLaunch(request.provider, profile);
    if (request.team?.role === "mission-coordinator") profile = missionCoordinatorLaunch(request.provider, profile);
    if (request.continuation) profile = withNativeContinuation(profile, request.continuation);
    const context = withoutSharedContext(new ProjectContexts(this.config, this.key).snapshot(request.projectId), request.purpose);
    const session: Session = {
      id,
      ...(request.team ? { team: request.team } : {}),
      ...(request.teamModelProfile ? { teamModelProfile: request.teamModelProfile } : {}),
      ...(request.purpose !== undefined ? { purpose: request.purpose } : {}),
      ...(request.configId !== undefined ? { configId: request.configId } : {}),
      ...(request.team && workspaceTrusted ? { workspaceTrusted: true as const } : {}),
      backend: "infinite",
      machineId: this.config.machine?.id,
      executionLocation: request.workspace ? "laptop" : "cloud",
      ...(request.resumedFrom ? { resumedFrom: request.resumedFrom, resumeNativeSession: request.resumeNativeSession } : {}),
      provider: request.provider,
      title: request.title,
      ...(request.generatedTitle ? { generatedTitle: true as const } : {}),
      projectId: request.projectId,
      cwd: request.teamCwd ?? projectCwd(project.path, request.cwd),
      createdAt: new Date().toISOString(),
      status: "starting",
      projectRoot: context.root,
      contextSources: context.sources,
      contextLinksVersion: context.linksVersion,
      contextVersion: context.version,
      context: context.text,
      initialPrompt: request.prompt,
      runtime: { id: randomUUID(), location: this.config.environment, transport: "pty", ...(request.localUi ? { nativeUi: request.provider as "codex" | "opencode" } : {}) },
      ...(request.nativeArgs !== undefined ? { nativeArgs: request.nativeArgs } : {}),
      ...(request.workspace ? { workspace: { cwd: request.workspace.cwd, roots: request.workspace.roots } } : {}),
    };
    if (!request.team) {
      const userRequest = request.nativeArgs === undefined ? request.prompt : handoffNativePrompt(request.provider, request.nativeArgs);
      let reason = "This project has not enabled automatic team handoff.";
      if (project.team?.handoff === "auto") {
        reason = "Handoff requires a new Claude or Codex PTY session at the project root, a supported prompt up to 12000 characters, and only supported model flags.";
        if (!request.localUi && !request.workspace && !request.resumedFrom && ["claude", "codex"].includes(request.provider) && userRequest !== undefined && userRequest.length <= 12000 && session.cwd === realpathSync(project.path)) {
          reason = "Handoff requires configured checks or authorization to establish them, and a reviewed model lineup.";
          if (this.config.teams?.lineup && (project.team.checks.length || project.team.establishChecks)) session.handoff = { policy: structuredClone({
            sourceSessionId: id, projectId: project.id, path: session.cwd, userRequest,
            lineup: this.config.teams.lineup, project: project.team, linear: project.linear,
            commandPrefix: this.config.teams.commandPrefix, workspaceDir: this.config.teams.workspaceDir,
            maxMinutes: project.team.handoffMinutes ?? 60, maxMembers: 16, parallelism: 2,
            ...(project.team.handoffExtendMinutes ? { extendMinutes: project.team.handoffExtendMinutes } : {}),
            ...(project.team.handoffMaxTotalMinutes ? { maxTotalMinutes: project.team.handoffMaxTotalMinutes } : {}),
          }) };
        }
      }
      session.handoff ??= { reason };
    }
    const launchProfile = request.nativeArgs === undefined || request.localUi ? profile : { ...profile, args: [...profile.args, ...request.nativeArgs] };
    // Recorded with the session: a headless launch, whether the permission channel serves it, and why not.
    const headless = this.headlessChannel?.admit({ provider: request.provider, profile: launchProfile, session, hooks: request.nativeArgs === undefined && !request.localUi });
    if (headless) session.headless = headless.record;
    // Keep the native prompt exact. Only opted-in, qualified sessions receive the
    // separate handoff MCP capability; the context snapshot stays in the record.
    const prompt = request.nativeArgs !== undefined ? "" : [
      context.text
        ? `Shared project context (version ${context.version}, provided by the owner):\n${context.text}`
        : "",
      request.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeSealed(join(dir, "meta.sealed"), this.key, `${id}:meta`, {
      session,
      fingerprint,
    });
    // The session record exists now, so the launch counts as started even if the worker fails to spawn.
    if (request.team) try { this.fuse?.started(id); } catch { /* fuse bookkeeping never fails a session */ }
    const worker = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
        import.meta.url,
      ),
    );
    const args = worker.endsWith(".ts")
      ? ["--import", "tsx", worker]
      : [worker];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    // Inert unless autonomy.boundary.github is configured; the grant travels only in the private bootstrap pipe.
    const githubScope = sessionGithubScopeFor({ team: Boolean(request.team), origin: github, repository: projectGithubRepository(project) });
    const githubGrant = sessionGithubGrant(this.config, githubScope, { sessionId: id, projectId: request.projectId });
    child.stdin.end(
      JSON.stringify({
        session,
        profile: launchProfile,
        stateDir: this.config.stateDir,
        runDir: this.config.runDir,
        key: this.key.toString("base64"),
        prompt,
        ...(request.workspace ? { executorTokenHash: createHash("sha256").update(request.workspace.token).digest("hex") } : {}),
        ...(headless?.bootstrap ? { permissionChannel: headless.bootstrap } : {}),
        ...(githubGrant ? { github: githubGrant } : {}),
        attention: {
          // Native CLI launches keep their exact argv: no hook settings are injected.
          hooks: request.nativeArgs !== undefined
            ? { claude: false, codex: false }
            : this.config.attention?.hooks ?? DEFAULT_HOOKS,
          idleAfterMs: this.config.attention?.idleAfterMs ?? 20000,
          limitConfirmMs: this.config.attention?.limitConfirmMs ?? 30000,
        },
      } satisfies Bootstrap),
    );
    child.unref();
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await this.state(id);
      if (state.status !== "unavailable" && (request.workspace || state.status !== "starting"))
        return { ...session, ...state };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ...session, ...(await this.state(id)) };
  }
  handoffRequest(id: string) {
    let cursor = 0;
    for (;;) {
      const page = this.events(id, cursor, 1, new Set(["team-handoff"]));
      if (page.events[0]) return page.events[0];
      if (!page.more) return undefined;
      cursor = page.cursor;
    }
  }
  events(id: string, after: number, limit: number, types?: Set<string>) {
    this.meta(id);
    return readEvents(
      join(this.config.stateDir, "sessions", id, "events"),
      this.key,
      id,
      after,
      limit,
      types,
    );
  }
}
