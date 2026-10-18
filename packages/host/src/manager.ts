import { ProjectContexts } from "./project-context.js";
import { assertFreshNativeContext } from "./context-continuation.js";
import { handoffNativePrompt, handoffPathsOverlap } from "./handoff-types.js";
import { spawn } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
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
import { workerCall } from "./ipc.js";
import { assertRunnerDeployment } from "./deployment.js";
import { DEFAULT_HOOKS } from "./config.js";
import { validateNativeCodexArgs } from "./native-codex.js";
import { validateNativeOpenCodeArgs } from "./native-opencode.js";
import { ContentError } from "./session-content.js";
import { permissionEvidenceHash, oneShotPermissionOption } from "./team-permissions.js";
import { teamModelProfileSchema, type TeamAssignment, type TeamModelProfile, type TeamPermissionDecision } from "./team-types.js";
import { permissionCoordinatorLaunch, teamModelLaunch } from "./launch.js";
import type {
  Config,
  Provider,
  Session,
  WorkerState,
  Bootstrap,
  LaptopWorkspace,
} from "./types.js";

export interface CreateSession {
  requestId: string;
  provider: Provider;
  projectId: string;
  title: string;
  prompt: string;
  nativeArgs?: string[];
  localUi?: boolean;
  /** Working directory relative to the configured project root. */
  cwd?: string;
  workspace?: LaptopWorkspace & { token: string };
  resumedFrom?: string;
  resumeNativeSession?: { id: string; source: "hook" | "protocol" };
}
interface StoredSession {
  session: Session;
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
  if (!att.prompt) return { ...att, lastMessage };
  const { tool, ...prompt } = att.prompt;
  return {
    ...att,
    prompt: {
      ...prompt,
      ...(tool ? { tool: { name: tool.name, input: {} } } : {}),
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
const unavailable = (now = new Date().toISOString()): WorkerState => ({
  status: "unavailable",
  seq: 0,
  screen: "",
  attention: applyLifecycle(initialAttention(now, false), "unavailable", now),
});
export class Manager {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly handoffProjects = new Map<string, string>();
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
  ) {
    assertRunnerDeployment(config);
    mkdirSync(join(config.stateDir, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
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
  meta(id: string): StoredSession {
    return unseal(
      this.key,
      `${id}:meta`,
      readFileSync(
        join(this.config.stateDir, "sessions", id, "meta.sealed"),
        "utf8",
      ),
    );
  }
  async state(id: string, screen = false): Promise<WorkerState> {
    try {
      return withDefaultAttention(
        await workerCall(this.config.runDir, id, { op: "state", screen }),
      );
    } catch {
      const file = join(this.config.stateDir, "sessions", id, "status.sealed");
      if (existsSync(file)) {
        const saved = unseal<WorkerState>(
          this.key,
          `${id}:status`,
          readFileSync(file, "utf8"),
        );
        const status = saved.status === "exited" ? "exited" : "unavailable";
        const now = new Date().toISOString();
        return {
          ...saved,
          status,
          screen: "",
          attention: applyLifecycle(
            saved.attention ?? initialAttention(now, false),
            status,
            now,
          ),
        };
      }
      return unavailable();
    }
  }
  /**
   * Every session whose metadata can be read. One session's unreadable status (or a worker
   * that fails to answer) shows that row as unavailable instead of failing the whole list;
   * a session without readable metadata has no title or provider to show and is left out.
   */
  async list() {
    const ids = readdirSync(join(this.config.stateDir, "sessions")).filter(
      (n) => /^[a-f0-9-]{36}$/.test(n),
    );
    const rows = await Promise.allSettled(
      ids.map(async (id) => {
        const { session } = this.meta(id);
        const { screen: _screen, ...state } = await this.state(id).catch(
          () => unavailable(),
        );
        const {
          context: _context,
          initialPrompt: _prompt,
          nativeArgs: _nativeArgs,
          handoff: _handoff,
          ...summary
        } = session;
        return {
          ...summary,
          ...state,
          attention: publicAttention(state.attention),
        };
      }),
    );
    return rows.flatMap((row) =>
      row.status === "fulfilled" ? [row.value] : [],
    );
  }
  context(projectId: string) { return new ProjectContexts(this.config, this.key).context(projectId); }
  setContext(projectId: string, text: string, expectedVersion: number) {
    return new ProjectContexts(this.config, this.key).setContext(projectId, text, expectedVersion);
  }
  create(request: CreateSession): Promise<Session & WorkerState> {
    const operation = this.serial.then(() => this.createOnce(request));
    this.serial = operation.catch(() => {});
    return operation;
  }
  /** The team scheduler owns cwd selection, below the root its run was created under. Public create requests never accept this override. */
  createTeamSession(request: CreateSession, team: TeamAssignment, cwd: string, modelProfile?: TeamModelProfile, workspaceRoot?: string): Promise<Session & WorkerState> {
    if (!this.config.teams || request.nativeArgs !== undefined || request.localUi || request.workspace || request.resumedFrom)
      throw new ContentError("Team sessions require a configured team workspace and managed launch", 400);
    const selection = modelProfile ? teamModelProfileSchema.parse(modelProfile) : undefined;
    if (selection && selection.provider !== request.provider) throw new ContentError("The team model profile does not match its assigned provider", 400);
    const root = realpathSync(workspaceRoot ?? this.config.teams.workspaceDir);
    const canonical = realpathSync(cwd);
    const rel = relative(root, canonical);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ContentError("Invalid team working directory", 400);
    const operation = this.serial.then(() => this.createOnce({ ...request, team, teamCwd: canonical, ...(selection ? { teamModelProfile: selection } : {}) }));
    this.serial = operation.catch(() => {});
    return operation;
  }
  /** A scheduler may stop only its own member and never take over an active human lease. */
  async stopTeamSession(sessionId: string, requestId: string, team: TeamAssignment): Promise<WorkerState> {
    const stored = this.meta(sessionId).session.team;
    if (!stored || stored.runId !== team.runId || stored.memberId !== team.memberId || stored.revision !== team.revision)
      throw new ContentError("This session does not belong to the team assignment", 403);
    const state = await this.state(sessionId);
    if (state.status === "exited") return state;
    if (state.status !== "running") throw new ContentError("The team member has not confirmed a controllable runtime");
    await workerCall(this.config.runDir, sessionId, { op: "stop", requestId });
    return this.state(sessionId);
  }
  /** Apply only the persisted, one-shot approval for this exact assigned member and prompt. */
  async answerTeamPermission(
    sessionId: string,
    requestId: string,
    team: TeamAssignment,
    decision: TeamPermissionDecision,
  ): Promise<import("./types.js").Receipt & { result?: import("@infinite/attention").AnswerResult }> {
    const session = this.meta(sessionId).session;
    const stored = session.team;
    const validAssignment = (value: unknown): value is TeamAssignment => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Partial<TeamAssignment>;
      return typeof candidate.runId === "string" && typeof candidate.memberId === "string" &&
        Number.isInteger(candidate.revision) &&
        ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery"].includes(candidate.role ?? "") &&
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
      if (decision.status !== "answering" || Date.parse(decision.expiresAt) <= Date.now())
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
  resume(sessionId: string, requestId: string): Promise<Session & WorkerState> {
    const operation = this.serial.then(() => this.resumeOnce(sessionId, requestId));
    this.serial = operation.catch(() => {});
    return operation;
  }
  private async resumeOnce(sessionId: string, requestId: string): Promise<Session & WorkerState> {
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
      return remember(await this.createOnce(request));
    const ids = readdirSync(join(this.config.stateDir, "sessions")).filter(id => /^[a-f0-9-]{36}$/.test(id) && id !== sessionId);
    const continuations = await Promise.all(ids.map(async id => {
      let candidate: Session;
      try { candidate = this.meta(id).session; }
      catch { throw new ContentError("A recording cannot be authenticated. Recover it before starting another continuation."); }
      if (candidate.provider !== session.provider) return undefined;
      const current = await this.state(id).catch(() => unavailable());
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
    return remember(await this.createOnce(request));
  }
  private async createOnce(request: CreateSession & { team?: TeamAssignment; teamCwd?: string; teamModelProfile?: TeamModelProfile }) {
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
    if (
      (await this.list()).filter(
        (s) => s.status === "running" || s.status === "starting",
      ).length >= this.config.maxSessions
    )
      throw new Error("The configured session limit has been reached");
    if (!request.team && [...this.handoffProjects.values()].some(path => handoffPathsOverlap(path, realpathSync(project.path)))) throw new ContentError("This project is capturing an accepted team handoff");
    const configuredProfile = this.config.agents[request.provider];
    if (!configuredProfile) throw new Error("Provider is not configured on this host");
    let profile = request.teamModelProfile ? teamModelLaunch(configuredProfile, request.teamModelProfile) : configuredProfile;
    if (request.team?.role === "permission-coordinator") profile = permissionCoordinatorLaunch(request.provider, profile);
    const context = new ProjectContexts(this.config, this.key).snapshot(request.projectId);
    const session: Session = {
      id,
      ...(request.team ? { team: request.team } : {}),
      ...(request.teamModelProfile ? { teamModelProfile: request.teamModelProfile } : {}),
      backend: "infinite",
      machineId: this.config.machine?.id,
      executionLocation: request.workspace ? "laptop" : "cloud",
      ...(request.resumedFrom ? { resumedFrom: request.resumedFrom, resumeNativeSession: request.resumeNativeSession } : {}),
      provider: request.provider,
      title: request.title,
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
            maxMinutes: 60, maxMembers: 16, parallelism: 2,
          }) };
        }
      }
      session.handoff ??= { reason };
    }
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
    child.stdin.end(
      JSON.stringify({
        session,
        profile: request.nativeArgs === undefined || request.localUi ? profile : {
          ...profile, args: [...profile.args, ...request.nativeArgs],
        },
        stateDir: this.config.stateDir,
        runDir: this.config.runDir,
        key: this.key.toString("base64"),
        prompt,
        ...(request.workspace ? { executorTokenHash: createHash("sha256").update(request.workspace.token).digest("hex") } : {}),
        attention: {
          // Native CLI launches keep their exact argv: no hook settings are injected.
          hooks: request.nativeArgs !== undefined
            ? { claude: false, codex: false }
            : this.config.attention?.hooks ?? DEFAULT_HOOKS,
          idleAfterMs: this.config.attention?.idleAfterMs ?? 20000,
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
