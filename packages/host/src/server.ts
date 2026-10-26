import express from "express";
import { ProjectContexts, contextLinksRequest } from "./project-context.js";
import { createServer } from "node:http";
import { connectTerminals, terminalPages } from "./terminal-stream.js";
import { connectNativeFrontends } from "./native-bridge.js";
import { proxyNativeHttp } from "./native-http.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Manager, publicAttention } from "./manager.js";
import { hashToken, validateLinearConfig } from "./config.js";
import { runtimeSecurity } from "./deployment.js";
import { workerCall, type WorkerError } from "./ipc.js";
import { PushStore, isExpoToken } from "./push.js";
import { controlActor, type PairedDevice } from "./device-control.js";
import { machineIdentity } from "./machine.js";
import { CmuxSessions } from "./cmux/index.js";
import { CmuxError } from "./cmux/client.js";
import { ContentError, recordedMessages, sessionFile } from "./session-content.js";
import { connectRemoteAccess } from "./remote-access.js";
import { ProjectSync, ProjectSyncError, syncFailure } from "./project-sync.js";
import { ProjectSourceError, ProjectSourceService } from "./project-source.js";
import { MirroredProjects } from "./mirrored-projects.js";
import { RepoEnrollmentService, repoEnrollmentRequestSchema } from "./repo-enrollment.js";
import { HandoffService } from "./handoffs.js";
import { handoffPathsOverlap } from "./handoff-types.js";
import { WORKSPACE_LIMITS } from "./workspace-checkpoint.js";
import { UsageService } from "./usage-service.js";
import { usagePlanSchema } from "./usage-api.js";
import { TeamService, TeamError } from "./teams.js";
import { spawnTeamBundle } from "./team-workspace.js";
import { createTeamSchema, teamContinueSchema, teamMutationSchema, teamDeliveryReconcileSchema, teamVerificationReconcileSchema, teamMemberRetireSchema, teamActionSchema, teamTaskRatingSchema, teamParallelismSchema } from "./team-types.js";
import { scorecard } from "./scorecard.js";
import { GoalService } from "./goals.js";
import { MissionService, missionBoard } from "./missions.js";
import { createMissionSchema, missionActionSchema, missionTextSchema } from "./mission-types.js";
import { ProjectGroupService } from "./project-groups.js";
import { LinearService } from "./linear.js";
import { createGoalSchema, goalActionSchema, goalExtendSchema, goalSteerSchema, goalOutcomeSchema, goalParallelismSchema } from "./goal-types.js";
import { createProjectGroupSchema, projectGroupIdSchema, updateProjectGroupSchema } from "./project-group-types.js";
import { DesktopError, DesktopFiles, DesktopResources, DESKTOP_LIMITS } from "./desktop.js";
import type { Config, Role, Receipt, Session } from "./types.js";
import { Summarizer, SummaryError } from "./summary.js";
import { DictationCleaner, DictationError } from "./dictation.js";
import { RepositoryBriefings } from "./repository-briefings.js";
import { UnderstandingService } from "./understanding.js";
import { UnderstandingCatalog, CatalogError } from "./understanding-catalog.js";
import { UnderstandingRuntime } from "./understanding-runtime.js";
import { createUnderstandingAdapter } from "./understanding-adapter.js";
import { BehaviorError, UnderstandingBehaviorService } from "./understanding-behavior.js";
import { BalanceService } from "./balances.js";
import { LiveFeed, type LiveTopic } from "./live.js";
import { MAX_EVENTS_BUFFERED_BYTES, MAX_EVENTS_STREAMS } from "@infinite/remote/protocol";
import { Readings } from "./readings.js";

const id = z.uuid();
const MAX_LOGIN_ATTEMPT_BUCKETS = 1024;
/** A recorded pid still names a process. EPERM means it runs under another account, such as the agent user. */
function alive(pid: unknown) {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
const createSchema = z
  .object({
    requestId: id,
    backend: z.enum(["infinite", "cmux"]).optional(),
    provider: z.enum(["claude", "codex", "grok", "opencode", "demo"]),
    projectId: z.string().max(80),
    title: z.string().trim().min(1).max(100),
    generatedTitle: z.literal(true).optional(),
    prompt: z.string().max(24000).default(""),
    nativeArgs: z.array(z.string().max(8192).refine((s) => !s.includes("\0")))
      .max(256).refine((args) => args.join("").length <= 32000).optional(),
    localUi: z.boolean().optional(),
    cwd: z.string().max(4096).optional(),
    workspace: z.object({
      cwd: z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0")),
      roots: z.array(z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0"))).min(1).max(16),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().optional(),
  })
  .strict();
const ANSWER_REFUSALS = new Set([
  "prompt-changed",
  "unsupported",
  "invalid-option",
  "text-not-accepted",
]);
const answerSchema = z
  .object({
    requestId: id,
    promptId: z.number().int().min(1),
    option: z.number().int().min(0).max(50).optional(),
    text: z
      .string()
      .min(1)
      .max(32000)
      .regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/)
      .optional(),
  })
  .strict()
  .refine((b) => b.option !== undefined || b.text !== undefined, {
    message: "option or text is required",
  });
const inputSchema = z
  .object({
    requestId: id,
    text: z
      .string()
      .min(1)
      .max(32000)
      .regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/),
    submit: z.boolean().default(true),
    force: z.boolean().optional(),
  })
  .strict();
export function createApp(config: Config, key: Buffer) {
  config.machine = machineIdentity(config, key);
  if ((config.cmux?.enabled || config.remote?.enabled) && runtimeSecurity(config.deployment).tenancy !== "single-tenant")
    throw new Error("Machine access and cmux require a single-tenant host");
  validateLinearConfig(config);
  const app = express();
  const mirroredProjects = runtimeSecurity(config.deployment).tenancy === "single-tenant" ? new MirroredProjects(config, key) : undefined;
  const enrollment = new RepoEnrollmentService(config, key, { isBusy: async projectId =>
    projectSync.applying(projectId) || projectSource.refreshing(projectId) || await projectRunning(projectId, true) });
  validateLinearConfig(config);
  const manager = new Manager(config, key);
  const projectSync = new ProjectSync(config, key);
  const desktopFiles = new DesktopFiles(config);
  // Session starts admitted past the sync check that the session list may not show yet.
  const startsInFlight = new Map<string, number>();
  const projectFileChanges = new Set<string>();
  const projectConfigChanges = new Set<string>();
  const projectSource = new ProjectSourceService(config, { running: id => sessionRunningInProject(id), prefix: config.teams?.commandPrefix });
  /**
   * Whether a session may be using the project directory: one starting or running there, including cmux sessions,
   * or one whose worker did not answer while its recorded worker or provider process still lives. Laptop-mode
   * tools run elsewhere, and an exited session never counts. A session list that cannot be read counts as running.
   */
  const startInProject = async <T>(projectId: string, start: () => Promise<T>): Promise<T> => {
    if (projectConfigChanges.has(projectId)) throw new TeamError(409, "project-config-changing", "Repository setup is being updated. Retry after it finishes.");
    if (projectFileChanges.has(projectId)) throw new DesktopError("files-changing", "Project files are being changed. Retry after the transfer finishes.");
    if (projectSource.isGithub(projectId) && projectSource.refreshing(projectId))
      throw new ProjectSourceError("A refresh from GitHub is updating this project. Start the session after it finishes.", "source-refreshing");
    if (projectSync.applying(projectId))
      throw new ProjectSyncError("A workspace sync is being applied to this project. Start the session after it finishes.", "sync-applying");
    startsInFlight.set(projectId, (startsInFlight.get(projectId) ?? 0) + 1);
    try { return await start(); } finally {
      const left = startsInFlight.get(projectId)! - 1;
      if (left) startsInFlight.set(projectId, left); else startsInFlight.delete(projectId);
    }
  };
  const linear = new LinearService(config, key);
  const summarizer = config.summaries ? new Summarizer(config.summaries) : undefined;
  const readings = new Readings(config, key, manager, summarizer);
  const ownerServices: { goals?: GoalService; missions?: MissionService; handoffs?: HandoffService } = {};
  const teams = new TeamService(config, key, manager, startInProject, linear, readings, {
    source: projectSource,
    onMerged: id => void projectSource.refresh(id).catch(() => {}),
    ownerActive: run => {
      if (ownerServices.goals?.retainsTeamRun(run.id) || ownerServices.missions?.retainsSubteamRun(run.id)) return true;
      return Boolean(run.handoff && ownerServices.handoffs?.ownsActiveTeam(run.id));
    },
  });
  const usage = new UsageService(config, key, manager);
  const balances = new BalanceService(config.usage?.accounts ?? {});
  usage.useBalances(balances);
  // TeamService ticks on every host and drives the ledger from its own session listing.
  teams.useUsage(usage);
  const goals = new GoalService(config, key, teams, linear);
  ownerServices.goals = goals;
  const projectGroups = new ProjectGroupService(config, key, undefined, { appliedAt: id => projectSync.status(id).appliedAt });
  const missions = new MissionService(config, key, manager, teams, projectGroups);
  ownerServices.missions = missions;
  missions.useUsage(usage);
  usage.useResolvers({
    goalOfRun: runId => { const goal = goals.list().find(value => value.cycles.some(cycle => cycle.teamId === runId)); return goal ? { id: goal.id, title: goal.title } : undefined; },
    runTitle: runId => { try { return teams.get(runId).title; } catch { return undefined; } },
    projectName: projectId => config.projects.find(project => project.id === projectId)?.name,
    sessionTitle: sessionId => { try { return manager.meta(sessionId).session.title; } catch { return undefined; } },
  });
  const projectSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
  const cmux = config.cmux?.enabled ? new CmuxSessions(config, key) : undefined;
  const handoffs: HandoffService = new HandoffService(config, key, manager, teams, startInProject, async (sessionId, projectId) => {
    const sourcePath = realpathSync(manager.meta(sessionId).session.cwd);
    // This callback owns one start reservation. Earlier admitted creates may not
    // have a session row yet, especially while cmux returns a cached listing.
    for (const project of config.projects) {
      if (!handoffPathsOverlap(sourcePath, realpathSync(project.path))) continue;
      if ((startsInFlight.get(project.id) ?? 0) > (project.id === projectId ? 1 : 0) ||
          goals.activeForProject(project.id) || teams.activeForProject(project.id) ||
          projectSync.applying(project.id) || projectFileChanges.has(project.id) || projectConfigChanges.has(project.id))
        throw new TeamError(409, "project-busy", "Another operation may still be using this repository. Finish it before handing off work.");
    }
    const external = (await listSessions()).filter(session => session.backend === "cmux");
    if (external.some(session => session.id !== sessionId && session.status !== "exited" &&
        (session.projectId === projectId || handoffPathsOverlap(sourcePath, realpathSync(session.cwd)))))
      throw new TeamError(409, "project-busy", "Another native session may still be using this project. Release it before handing off work.");
  });
  ownerServices.handoffs = handoffs;
  const assertNoHandoff = (projectId: string) => {
    if (handoffs.activeForProject(projectId)) throw new TeamError(409, "handoff-in-progress", "This project is transferring a task to a team. Wait for its checkpoint to finish.");
  };
  const resumable = (session: { status: string; provider: string; workspace?: unknown; team?: unknown; nativeSession?: unknown; resumeNativeSession?: unknown }) =>
    session.status === "exited" && !session.workspace && !session.team && Boolean(session.nativeSession ?? session.resumeNativeSession) && ["claude", "codex", "opencode"].includes(session.provider);
  // Native records written before executionLocation existed carry only the hybrid workspace.
  const executionLocation = (session: { executionLocation?: "cloud" | "laptop"; workspace?: unknown }): "cloud" | "laptop" =>
    session.executionLocation ?? (session.workspace ? "laptop" : "cloud");
  const usageRow = (id: string) => { const row = usage.session(id); return row.measured ? { usage: row } : {}; };
  const listSessions = async () => {
    const native = (await manager.list({ includeFullMessage: Boolean(config.jev) })).map(session => {
      const handoff = handoffs.view(session.id);
      const managed = managedBy(session);
      return { ...session, ...(managed ? { managedBy: managed } : {}), handoff, ...usageRow(session.id), executionLocation: executionLocation(session), backend: "infinite" as const, machineId: config.machine!.id,
        resumable: resumable(session) && ["unavailable", "available"].includes(handoff.status) };
    });
    // Provider conversation IDs survive restarts and can exist in several
    // recordings. Only a currently verified worker PID identifies this runtime.
    const known = new Set(native.filter(s => s.status === "running" && s.nativeSession && s.pid)
      .map(s => `${s.provider}:${s.nativeSession!.id}:${s.pid}`));
    const external = cmux ? (await cmux.list()).filter(s => s.status !== "running" || !s.nativeSession || !s.pid || !known.has(`${s.provider}:${s.nativeSession.id}:${s.pid}`)) : [];
    const merged = readings.merge([...native, ...external.map(s => ({ ...s, backend: "cmux" as const, machineId: config.machine!.id, resumable: resumable(s) }))]);
    return merged.map(session => ({ ...session, attention: publicAttention(session.attention) }));
  };
  const sessionDetail = async (sessionId: string) => {
    if (cmux && !existsSync(join(config.stateDir, "sessions", sessionId, "meta.sealed"))) {
      const session = await cmux.get(sessionId);
      return { ...session, machineId: config.machine!.id, resumable: resumable(session) };
    }
    const session = { ...manager.meta(sessionId).session, ...(await manager.state(sessionId, true)) };
    const handoff = handoffs.view(sessionId);
    const managed = managedBy(session);
    const { generatedTitle: _generatedTitle, ...publicSession } = readings.merge([session])[0];
    return { ...publicSession, ...(managed ? { managedBy: managed } : {}), handoff, executionLocation: executionLocation(session), backend: "infinite", machineId: config.machine!.id,
      resumable: resumable(session) && ["unavailable", "available"].includes(handoff.status) };
  };
  const sessionEvents = async (sessionId: string, after: number, limit = 200) => {
    if (cmux && !existsSync(join(config.stateDir, "sessions", sessionId, "meta.sealed"))) {
      await cmux.get(sessionId);
      return cmux.events(sessionId, after, limit);
    }
    return manager.events(sessionId, after, limit);
  };
  const live = new LiveFeed({
    sessions: async () => ({ sessions: await listSessions() }),
    teams: () => ({ teams: teams.list() }),
    session: sessionDetail,
    events: (sessionId, after) => sessionEvents(sessionId, after),
  });
  /**
   * A source refresh waits only for work that uses the project tree itself: a cloud session whose working directory
   * lies inside it (team members run in their own clones and do not count), an admitted session start, and a file or
   * repository-setup change in flight. A failed session listing, or a session without a recorded directory, fails closed.
   */
  async function sessionRunningInProject(projectId: string) {
    if (startsInFlight.has(projectId) || projectFileChanges.has(projectId) || projectConfigChanges.has(projectId)) return true;
    const project = config.projects.find(p => p.id === projectId);
    if (!project) return true;
    const canonical = (value: string) => { try { return realpathSync(value); } catch { return resolve(value); } };
    const tree = canonical(project.path);
    const insideTree = (cwd: unknown) => {
      if (typeof cwd !== "string" || !cwd) return true;
      const target = canonical(cwd);
      return target === tree || target.startsWith(tree.endsWith(sep) ? tree : `${tree}${sep}`);
    };
    let sessions: Awaited<ReturnType<typeof listSessions>>;
    try { sessions = await listSessions(); } catch { return true; }
    return sessions.some(s => s.projectId === projectId && s.executionLocation !== "laptop" && insideTree((s as { cwd?: unknown }).cwd) &&
      (["running", "starting"].includes(s.status) ||
        (["unavailable", "recording-error"].includes(s.status) && (alive(s.pid) || alive((s as { workerPid?: unknown }).workerPid)))));
  }
  /**
   * A sync commit or apply evaluates projectRunning only after `applying()` turns true.
   * A start either sees that flag and is refused, or is counted before the check runs.
   */
  const projectRunning = async (projectId: string, ignoreConfigChange = false) => {
    if (!ignoreConfigChange && projectConfigChanges.has(projectId)) return true;
    if (startsInFlight.has(projectId) || handoffs.activeForProject(projectId) || teams.activeForProject(projectId) || goals.activeForProject(projectId)) return true;
    let sessions: Awaited<ReturnType<typeof listSessions>>;
    try { sessions = await listSessions(); } catch { return true; }
    return sessions.some(s => s.projectId === projectId && s.executionLocation !== "laptop" &&
      (["running", "starting"].includes(s.status) ||
        (["unavailable", "recording-error"].includes(s.status) && (alive(s.pid) || alive((s as { workerPid?: unknown }).workerPid)))));
  };
  const desktopResources = new DesktopResources(config, listSessions);
  const changeProjectFiles = async <T>(projectId: string, action: () => Promise<T>) => {
    if (projectFileChanges.has(projectId)) throw new DesktopError("files-changing", "Project files are being changed. Retry after the transfer finishes.");
    projectFileChanges.add(projectId);
    let held = false;
    try {
      if (await projectRunning(projectId)) throw new DesktopError("session-running", "Stop this project's running sessions before replacing files");
      if (projectSync.applying(projectId)) throw new DesktopError("sync-applying", "A workspace sync is being applied. Retry after it finishes.");
      if (projectSource.refreshing(projectId)) throw new DesktopError("source-refreshing", "A refresh from GitHub is updating this project. Retry after it finishes.");
      // Fence sync after checking existing sessions, while new session admission is already closed.
      startsInFlight.set(projectId, (startsInFlight.get(projectId) ?? 0) + 1); held = true;
      return await action();
    } finally {
      if (held) { const left = startsInFlight.get(projectId)! - 1; if (left) startsInFlight.set(projectId, left); else startsInFlight.delete(projectId); }
      projectFileChanges.delete(projectId);
    }
  };
  const pushStore = new PushStore(config.stateDir, key);
  const dictationCleaner = config.dictation ? new DictationCleaner(config.dictation) : undefined;
  const repositoryBriefings = config.repositoryBriefings
    ? new RepositoryBriefings(config.repositoryBriefings, manager, config.projects, config.teams?.workspaceDir)
    : undefined;
  repositoryBriefings?.useUsage(usage);
  const understandingCatalog = new UnderstandingCatalog({ config, key, groups: projectGroups });
  const understandingRuntime = new UnderstandingRuntime({ config, key, groups: projectGroups, catalog: understandingCatalog, adapter: createUnderstandingAdapter(config) });
  const understandingBehaviors = new UnderstandingBehaviorService({ config, key, groups: projectGroups, catalog: understandingCatalog, runtime: understandingRuntime });
  const understanding = new UnderstandingService({ config, key, manager, groups: projectGroups, missions, teams, goals, briefings: repositoryBriefings,
    knowledge: { read: workspaceId => ({ schemaVersion: 1, catalog: understandingCatalog.read(workspaceId), ...understandingRuntime.read(workspaceId) }) },
  });
  async function inputAuthority(sessionId: string, res: express.Response) {
    // Retained workers from earlier releases hash the entire request. Adding
    // optional fields would make a pre-upgrade receipt impossible to retry.
    return (await manager.state(sessionId)).capabilities?.inputControl
      ? { actor: res.locals.actor, leaseId: res.locals.leaseId } : {};
  }
  const cookies = new Map<string, { device: PairedDevice; expires: number }>();
  const eventStreamCounts = new Map<string, number>();
  const attempts = new Map<string, { start: number; count: number }>();
  const origin = new URL(config.origin);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' wss: ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    });
    if (req.headers.origin && req.headers.origin !== origin.origin)
      return res.status(403).json({ error: "Origin is not allowed" });
    const allowedHosts = [
      origin.host,
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
    ];
    if (!allowedHosts.includes(req.headers.host ?? ""))
      return res.status(403).json({ error: "Host is not allowed" });
    next();
  });
  // The sync commit manifest is parsed by its own route, after authentication.
  app.use((req, res, next) => /^\/api\/projects\/[^/]+\/sync\/commit$/.test(req.path) ? next()
    : express.json({ limit: /^\/api\/sessions\/[^/]+\/opencode(?:\/|$)/.test(req.path) ? "8mb" : "96kb" })(req, res, next));
  function authenticate(token: string) {
    const digest = Buffer.from(hashToken(token), "hex");
    return config.tokens.find((t) =>
      timingSafeEqual(digest, Buffer.from(t.hash, "hex")),
    );
  }
  function authenticateRequest(req: express.Request) {
    const bearer = req.headers.authorization?.match(/^Bearer (.{32,200})$/)?.[1];
    if (bearer) {
      const device = authenticate(bearer);
      return device ? { device, credentialHash: device.hash, instance: "legacy", bearer: true } : undefined;
    }
    const value = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("infinite="))
      ?.slice(9);
    const session = value ? cookies.get(hashToken(value)) : undefined;
    if (!session || session.expires <= Date.now()) return undefined;
    const device = config.tokens.find(token => token.hash === session.device.hash);
    return device ? { device, credentialHash: device.hash, instance: hashToken(value!), bearer: false } : undefined;
  }
  app.post("/api/login", (req, res) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const attempt = attempts.get(ip);
    if (!attempt || now - attempt.start > 60000) {
      if (attempts.size >= MAX_LOGIN_ATTEMPT_BUCKETS) {
        for (const [address, bucket] of attempts) if (now - bucket.start > 60000) attempts.delete(address);
        if (attempts.size >= MAX_LOGIN_ATTEMPT_BUCKETS) attempts.delete(attempts.keys().next().value!);
      }
      attempts.set(ip, { start: now, count: 1 });
    } else if (++attempt.count > 10)
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again in one minute." });
    if (req.headers.origin !== origin.origin)
      return res
        .status(403)
        .json({ error: "Browser sign-in requires the configured origin" });
    const token = z.string().min(32).max(200).parse(req.body?.token);
    const device = authenticate(token);
    if (!device)
      return res.status(401).json({ error: "Device key was not recognized" });
    for (const [value, session] of cookies)
      if (session.expires <= now) cookies.delete(value);
    if (cookies.size > 64)
      return res.status(429).json({ error: "Too many browser connections" });
    const value = randomBytes(32).toString("base64url");
    cookies.set(hashToken(value), { device, expires: now + 12 * 60 * 60 * 1000 });
    res.cookie("infinite", value, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.protocol === "https:",
      maxAge: 12 * 60 * 60 * 1000,
      path: "/api",
    });
    return res.json({ role: device.role });
  });
  app.use("/api", (req, res, next) => {
    const auth = authenticateRequest(req);
    const device = auth?.device;
    const hasBearer = Boolean(req.headers.authorization?.match(/^Bearer (.{32,200})$/)?.[1]);
    if (!hasBearer) {
      if (req.method !== "GET" && req.headers.origin !== origin.origin)
        return res
          .status(403)
          .json({ error: "Origin is required for browser changes" });
    }
    if (!auth || !device)
      return res.status(401).json({ error: "Connect with a device key" });
    res.locals.role = device.role;
    res.locals.deviceId = device.id;
    res.locals.bearer = auth.bearer;
    res.locals.authCredentialHash = auth.credentialHash;
    const clientId = req.get("X-Infinite-Client");
    res.locals.actor = controlActor(device, clientId ? id.parse(clientId) : auth.instance);
    res.locals.leaseId = id.optional().parse(req.get("X-Infinite-Control"));
    next();
  });
  const requireRole =
    (roles: Role[]): express.RequestHandler =>
    (_req, res, next) =>
      roles.includes(res.locals.role)
        ? next()
        : void res.status(403).json({
            error: "This device is not allowed to perform that action",
          });
  const requireOwnerCli: express.RequestHandler = (_req, res, next) =>
    res.locals.bearer ? next() : void res.status(403).json({ error: "Workspace sync requires a paired owner CLI" });
  const managedBy = (session: Pick<Session, "team">): Session["managedBy"] => {
    const assignment = session.team;
    if (!assignment) return undefined;
    if (assignment.role === "mission-coordinator") return { kind: "mission", missionId: assignment.runId };
    try {
      const missionId = teams.missionIdOf(assignment.runId);
      return missionId ? { kind: "mission", missionId, teamId: assignment.runId } : undefined;
    }
    catch (error) {
      if (error instanceof TeamError && error.code === "team-not-found") return undefined;
      throw error;
    }
  };
  const missionManagedSession = (sessionId: string) => Boolean(managedBy(manager.meta(sessionId).session));
  const missionManagedError = {
    error: "This session is run by its mission coordinator. Talk to the coordinator from the mission.",
    code: "mission-managed",
  };
  // Attach this after route matching and before role checks, using Express's
  // decoded route params so case, escapes, and optional trailing slashes cannot
  // skip the mission boundary.
  const refuseMissionManaged: express.RequestHandler = (req, res, next) => {
    const param = req.params.id ?? req.params[0];
    const sessionId = Array.isArray(param) ? param[0] : param;
    if (!sessionId || !id.safeParse(sessionId).success) return next();
    try {
      if (missionManagedSession(sessionId)) return void res.status(409).json(missionManagedError);
      next();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return next();
      next(error);
    }
  };
  const refuseTeamSessionDeletion: express.RequestHandler = (req, res, next) => {
    const param = req.params.id;
    const sessionId = Array.isArray(param) ? param[0] : param;
    if (!sessionId || !id.safeParse(sessionId).success) return next();
    try {
      if (manager.meta(sessionId).session.team)
        return void res.status(409).json({ code: "team-session", error: "Team sessions cannot be deleted individually" });
      next();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return next();
      next(error);
    }
  };
  const refuseManagedOutsideProviderPrompt: express.RequestHandler = (req, res, next) => {
    const param = req.params.id ?? req.params[0];
    const sessionId = Array.isArray(param) ? param[0] : param;
    if (!sessionId || !id.safeParse(sessionId).success) return next();
    void (async () => {
      if (!missionManagedSession(sessionId)) return next();
      if ((await manager.state(sessionId)).attention?.state === "needs-you") return next();
      res.status(409).json(missionManagedError);
    })().catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") next();
      else next(error);
    });
  };
  // A fallback lease on a managed session lapses within its TTL once the prompt closes; release stays open.
  const refuseManagedClaim: express.RequestHandler = (req, res, next) =>
    req.body?.action === "claim" || req.body?.action === "renew" ? refuseManagedOutsideProviderPrompt(req, res, next) : next();
  app.get("/api/me", (_req, res) =>
    res.json({
      role: res.locals.role,
      machine: { ...config.machine, environment: config.environment },
      backends: ["infinite", ...(cmux ? ["cmux"] : [])],
      backendProviders: { infinite: Object.keys(config.agents).filter(p => p !== "demo" || config.enableDemo), cmux: cmux ? ["claude", "codex"].filter(p => p in config.agents) : [] },
      terminal: { stream: true, duplex: true, snapshot: true, control: true, raw: res.locals.role === "owner" },
      nativeUi: ["codex", "opencode"].filter(provider => config.agents[provider as "codex" | "opencode"]),
      execution: { laptop: Boolean(config.agents.codex) && runtimeSecurity(config.deployment).tenancy === "single-tenant", cloudHandoff: Boolean(config.agents.codex) && runtimeSecurity(config.deployment).tenancy === "single-tenant", default: "cloud" as const },
      environment: config.environment,
      security: runtimeSecurity(config.deployment),
      providers: Object.keys(config.agents).filter(
        (p) => p !== "demo" || config.enableDemo,
      ),
      teams: { enabled: Boolean(config.teams), repoEnrollment: 1, permissionDelegation: 1, establishChecks: 1, sessionHandoff: 1, projectSource: 1, maxParallelism: 4, ...(config.teams?.lineup ? { lineup: config.teams.lineup } : {}) },
      goals: { enabled: goals.enabled() },
      missions: { enabled: missions.enabled() },
      usage: { enabled: Boolean(config.usage), budgets: config.usage?.budgets ?? {} },
      providerLimits: teams.providerLimits(),
      projects: config.projects.map(({ id, name, path, team, linear }) => ({ id, name, path, ...(team ? { team } : {}), ...(linear ? { linear: { enabled: true } } : {}) })),
      capabilities: {
        ...(mirroredProjects ? { workspaceMirror: 1, mirrorForget: 1 } : {}),
        signals: true,
        answer: ["owner", "controller"].includes(res.locals.role),
        push: Boolean(config.push?.enabled),
        ...(repositoryBriefings || summarizer ? { summaries: { model: repositoryBriefings?.model ?? summarizer!.model } } : {}),
        ...(dictationCleaner ? { dictation: { model: dictationCleaner.config.model } } : {}),
        ...(repositoryBriefings ? { repositoryBriefings: { model: repositoryBriefings.model, automatic: config.repositoryBriefings!.automatic } } : {}),
        ...(config.remote?.enabled ? { remoteTerminal: 1 } : {}),
        desktop: { resources: 1, files: 1, fileTransfer: 1, chunkBytes: DESKTOP_LIMITS.chunkBytes, maxFileBytes: DESKTOP_LIMITS.maxFileBytes },
      },
    }),
  );
  app.get("/api/usage", (_req, res) => res.json(usage.summary()));
  app.get("/api/usage/models", (req, res) => {
    const query = z.object({ role: z.string().trim().min(1).max(40).optional() }).strict().parse(req.query);
    return res.json(scorecard(teams.list(), sessionId => {
      const found = usage.session(sessionId);
      return found.measured ? { cost: found.cost, tokens: found.tokens.input + found.tokens.output + found.tokens.reasoning + found.tokens.cacheRead + found.tokens.cacheWrite, unpriced: found.pricing.unknown } : undefined;
    }, { role: query.role }));
  });
  app.get("/api/usage/daily", (req, res, next) => {
    try { const query = z.object({ days: z.coerce.number().int().min(1).max(366).default(30), tz: z.string().default("UTC"), project: z.string().optional() }).strict().parse(req.query); return void res.json(usage.daily({ days: query.days, tz: query.tz, projectId: query.project })); } catch (error) { if (error instanceof RangeError) return void res.status(400).json({ error: "Invalid timezone or day range" }); return next(error); }
  });
  app.get("/api/usage/projects", (req, res, next) => { try { const query = z.object({ tz: z.string().default("UTC") }).strict().parse(req.query); return void res.json(usage.projects({ tz: query.tz })); } catch (error) { if (error instanceof RangeError) return void res.status(400).json({ error: "Invalid timezone" }); return next(error); } });
  app.get("/api/usage/projects/:id", (req, res, next) => { try { const query = z.object({ tz: z.string().default("UTC") }).strict().parse(req.query), result = usage.project(String(req.params.id), { tz: query.tz }); if (!result) return void res.status(404).json({ error: "Project usage not found" }); return void res.json(result); } catch (error) { if (error instanceof RangeError) return void res.status(400).json({ error: "Invalid timezone" }); return next(error); } });
  app.put("/api/usage/accounts/:id/plan", requireRole(["owner"]), (req, res) => {
    const accounts = config.usage?.accounts, accountId = String(req.params.id);
    const account = accounts && Object.hasOwn(accounts, accountId) ? accounts[accountId] : undefined;
    if (!account) return void res.status(404).json({ error: "Usage account not found" });
    if (account.kind !== "subscription") return void res.status(400).json({ error: "Only subscription plans can be updated" });
    const body = usagePlanSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "Invalid usage plan" });
    usage.setPlan(accountId, body.data.planUsd);
    return void res.json({ accounts: usage.summary().accounts });
  });
  app.post("/api/usage/balances/refresh", requireRole(["owner"]), async (_req, res) => { await balances.refresh(true); return res.json({ accounts: usage.summary().accounts }); });
  app.post("/api/dictation/cleanup", requireRole(["owner", "controller"]), async (req, res) => {
    const body = z.object({ text: z.string().trim().min(1).max(32000) }).strict().parse(req.body);
    if (!dictationCleaner) return void res.status(503).json({ code: "dictation-unavailable", error: "This host has no dictation model configured." });
    try {
      res.json(await dictationCleaner.clean(body.text));
    } catch (error) {
      if (error instanceof DictationError) return void res.status(502).json({ code: "dictation-failed", error: error.message });
      throw error;
    }
  });
  app.get("/api/teams", (_req, res) => res.json({ teams: teams.list() }));
  app.get("/api/goals", (_req, res) => res.json({ goals: goals.list() }));
  app.get("/api/goals/:id", (req, res) => res.json(goals.get(id.parse(req.params.id))));
  app.get("/api/project-groups", requireRole(["owner", "controller", "viewer"]), (_req, res) => res.json(projectGroups.list()));
  app.get("/api/project-groups/:id/understanding", requireRole(["owner", "controller", "viewer"]), (req, res) => res.json(understanding.get(projectGroupIdSchema.parse(req.params.id))));
  app.get("/api/project-groups/:id/understanding/catalog", requireRole(["owner", "controller", "viewer"]), (req, res) => res.json(understandingCatalog.read(projectGroupIdSchema.parse(req.params.id))));
  app.get("/api/project-groups/:id/understanding/components", requireRole(["owner", "controller", "viewer"]), (req, res) => {
    const value = understandingRuntime.read(projectGroupIdSchema.parse(req.params.id));
    return res.json({ components: value.components.map(({ id, name, description, repositoryIds, pinned, retired, redirectTo }) => ({ id, name, description, repositoryIds, pinned, retired, redirectTo })), coverage: value.coverage });
  });
  app.get("/api/project-groups/:id/understanding/components/:componentId", requireRole(["owner", "controller", "viewer"]), (req, res) => {
    const componentId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).parse(req.params.componentId);
    const workspaceId = projectGroupIdSchema.parse(req.params.id);
    const value = understandingRuntime.read(workspaceId);
    const component = value.components.find(item => item.id === componentId);
    if (!component) return void res.status(404).json({ error: "Component is unavailable in this workspace." });
    const behaviors = understandingBehaviors.list(workspaceId, componentId);
    return res.json({ component, relationships: value.relationships.filter(edge => edge.from === componentId || edge.to === componentId), behaviors: behaviors.behaviors,
      coverage: [...new Set([...value.coverage, ...behaviors.coverage])].slice(0, 200) });
  });
  app.get("/api/project-groups/:id/understanding/behaviors", requireRole(["owner", "controller", "viewer"]), (req, res) =>
    res.json(understandingBehaviors.list(projectGroupIdSchema.parse(req.params.id))));
  app.get("/api/project-groups/:id/understanding/behaviors/:behaviorId", requireRole(["owner", "controller", "viewer"]), (req, res) =>
    res.json(understandingBehaviors.get(projectGroupIdSchema.parse(req.params.id), String(req.params.behaviorId))));
  app.get("/api/project-groups/:id/understanding/behaviors/:behaviorId/suite", requireRole(["owner", "controller", "viewer"]), (req, res) =>
    res.json(understandingBehaviors.suite(projectGroupIdSchema.parse(req.params.id), String(req.params.behaviorId))));
  app.post("/api/project-groups/:id/understanding/behaviors", requireRole(["owner"]), (req, res) =>
    res.json(understandingBehaviors.save(projectGroupIdSchema.parse(req.params.id), req.body)));
  app.post("/api/project-groups/:id/understanding/behaviors/:behaviorId/run", requireRole(["owner"]), (req, res) =>
    res.status(202).json(understandingBehaviors.run(projectGroupIdSchema.parse(req.params.id), String(req.params.behaviorId), req.body)));
  app.post("/api/project-groups/:id/understanding/refresh", requireRole(["owner"]), (req, res) => {
    z.object({}).strict().parse(req.body);
    return res.status(202).json(understandingRuntime.refresh(projectGroupIdSchema.parse(req.params.id)));
  });
  app.post(["/api/project-groups/:id/understanding/catalog/:collection", "/api/project-groups/:id/understanding/catalog/:collection/:entityId"], requireRole(["owner"]), (req, res) => {
    const workspaceId = projectGroupIdSchema.parse(req.params.id);
    const collection = z.enum(["projects", "features", "plans", "components", "policy"]).parse(req.params.collection);
    const entityId = req.params.entityId === undefined ? undefined : z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).parse(req.params.entityId);
    return res.json(understandingCatalog.mutate(workspaceId, collection, entityId, req.body, {
      work: understanding.workReferences(workspaceId), components: understandingRuntime.read(workspaceId).components,
    }));
  });
  app.get("/api/project-groups/:id", requireRole(["owner", "controller", "viewer"]), (req, res) => res.json(projectGroups.get(projectGroupIdSchema.parse(req.params.id))));
  app.post("/api/project-groups", requireRole(["owner"]), (req, res) => res.json(projectGroups.create(createProjectGroupSchema.parse(req.body))));
  app.put("/api/project-groups/:id", requireRole(["owner"]), (req, res) => res.json(projectGroups.update(projectGroupIdSchema.parse(req.params.id), updateProjectGroupSchema.parse(req.body))));
  app.delete("/api/project-groups/:id", requireRole(["owner"]), (req, res) => res.json(projectGroups.remove(projectGroupIdSchema.parse(req.params.id), z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict().parse(req.body))));
  app.post("/api/goals", requireRole(["owner"]), async (req, res) => {
    const body = createGoalSchema.parse(req.body);
    assertNoHandoff(body.projectId);
    return res.json(await startInProject(body.projectId, () => goals.create(body)));
  });
  app.post("/api/goals/:id/steer", requireRole(["owner", "controller"]), async (req, res) => res.json(await goals.steer(id.parse(req.params.id), goalSteerSchema.parse(req.body))));
  app.post("/api/goals/:id/parallelism", requireRole(["owner"]), async (req, res) => res.json(await goals.setParallelism(id.parse(req.params.id), goalParallelismSchema.parse(req.body))));
  app.post("/api/goals/:id/outcome", requireRole(["owner", "controller"]), async (req, res) => res.json(await goals.outcome(id.parse(req.params.id), goalOutcomeSchema.parse(req.body))));
  for (const action of ["pause", "resume", "cancel"] as const)
    app.post(`/api/goals/:id/${action}`, requireRole(["owner"]), async (req, res) => res.json(await goals[action](id.parse(req.params.id), goalActionSchema.parse(req.body))));
  app.post("/api/goals/:id/extend", requireRole(["owner"]), async (req, res) => res.json(await goals.extend(id.parse(req.params.id), goalExtendSchema.parse(req.body))));
  app.get("/api/missions", (_req, res) => res.json({ missions: missions.list() }));
  app.get("/api/missions/:id", (req, res) => res.json(missions.get(id.parse(req.params.id))));
  app.post("/api/missions", requireRole(["owner"]), async (req, res) => {
    const body = createMissionSchema.parse(req.body);
    // A retry returns the recorded mission even if the group or a handoff changed since it was admitted.
    const recorded = missions.replayCreate(body);
    if (recorded) return res.json(recorded);
    const group = projectGroups.get(body.groupId);
    const resolvedBody = { ...body, groupId: group.id };
    for (const repo of group.repos)
      for (const checkout of repo.checkouts) assertNoHandoff(checkout.projectId);
    return res.json(await missions.create(resolvedBody, body));
  });
  // Mission controls and answers are owner-only, so every recorded mission answer is the owner's.
  app.post("/api/missions/:id/steer", requireRole(["owner"]), async (req, res) => res.json(await missions.steer(id.parse(req.params.id), missionTextSchema.parse(req.body))));
  app.post("/api/missions/:id/answer/:decisionId", requireRole(["owner"]), async (req, res) =>
    res.json(await missions.answer(id.parse(req.params.id), id.parse(req.params.decisionId), missionTextSchema.parse(req.body))));
  for (const action of ["pause", "resume", "cancel"] as const)
    app.post(`/api/missions/:id/${action}`, requireRole(["owner"]), async (req, res) => res.json(await missions[action](id.parse(req.params.id), missionActionSchema.parse(req.body))));
  app.get("/api/board", (_req, res) => res.json(missionBoard(missions.list(), teams.list(), goals.list(), config.projects, id => projectGroups.containing(id))));
  app.get("/api/teams/:id", (req, res) => res.json(teams.get(id.parse(req.params.id))));
  app.delete("/api/teams/:id", requireRole(["owner"]), async (req, res) => {
    const teamId = id.parse(req.params.id);
    if (goals.ownsActiveTeam(teamId)) throw new TeamError(409, "goal-owned-team", "Control this feature from its goal.");
    if (missions.ownsActiveSubteam(teamId)) throw new TeamError(409, "mission-owned-team", "Control this subteam from its mission.");
    return res.json(await teams.removeRun(teamId));
  });
  app.post("/api/teams/:id/tasks/:taskId/rating", requireRole(["owner"]), (req, res) =>
    res.json(teams.rateTask(id.parse(req.params.id), z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).parse(req.params.taskId), teamTaskRatingSchema.parse(req.body))));
  app.post("/api/teams/:id/permissions/revoke", requireRole(["owner"]), async (req, res) => res.json(await teams.revokePermissions(id.parse(req.params.id), teamActionSchema.parse(req.body))));
  app.get("/api/teams/:id/bundle", requireRole(["owner"]), requireOwnerCli, async (req, res) => {
    let finished = false, child: ReturnType<typeof spawnTeamBundle> | undefined;
    const stop = () => {
      if (!child || finished) return;
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };
    const disconnect = () => { if (!res.writableEnded) { stop(); finished = true; clearTimeout(timer); } };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    const timer = setTimeout(() => { stop(); finished = true; res.destroy(); }, 10 * 60 * 1000);
    timer.unref();
    res.once("close", () => clearTimeout(timer));
    const bundle = await teams.bundle(id.parse(req.params.id));
    if (req.aborted || res.destroyed || res.writableEnded) return;
    const limit = 512 * 1024 * 1024;
    child = spawnTeamBundle(bundle.workspace, bundle.branch, config.teams?.commandPrefix);
    res.status(200).set({ "Content-Type": "application/octet-stream", "X-Infinite-Branch": bundle.branch, "X-Infinite-Head": bundle.head });
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { stop(); finished = true; clearTimeout(timer); res.destroy(); return; }
      if (!res.write(chunk)) child.stdout.pause();
    });
    res.on("drain", () => child.stdout.resume());
    child.stderr.resume();
    child.once("error", () => { finished = true; clearTimeout(timer); res.destroy(); });
    child.once("close", code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) res.destroy(); else res.end();
    });
  });
  app.post("/api/teams", requireRole(["owner"]), async (req, res) => {
    const body = createTeamSchema.parse(req.body);
    assertNoHandoff(body.projectId);
    return res.json(await startInProject(body.projectId, () => teams.create(body)));
  });
  const standaloneTeam = (value: unknown) => {
    const teamId = id.parse(value);
    if (teams.get(teamId).goal) throw new TeamError(409, "goal-owned-team", "Control this feature from its goal. Team decisions can still be answered here.");
    if (teams.get(teamId).missionId) throw new TeamError(409, "mission-owned-team", "Control this subteam from its mission.");
    return teamId;
  };
  app.post("/api/teams/:id/steer", requireRole(["owner", "controller"]), async (req, res) =>
    res.json(await teams.steer(standaloneTeam(req.params.id), teamMutationSchema.parse(req.body))));
  app.post("/api/teams/:id/continue", requireRole(["owner"]), async (req, res) =>
    res.json(await teams.continueRun(standaloneTeam(req.params.id), teamContinueSchema.parse(req.body))));
  app.post("/api/teams/:id/reconcile-delivery", requireRole(["owner"]), async (req, res) =>
    res.json(await teams.reconcileDelivery(standaloneTeam(req.params.id), teamDeliveryReconcileSchema.parse(req.body))));
  app.post("/api/teams/:id/reconcile-verification", requireRole(["owner"]), async (req, res) =>
    res.json(await teams.reconcileVerification(standaloneTeam(req.params.id), teamVerificationReconcileSchema.parse(req.body))));
  app.get("/api/teams/:id/members/:memberId/runtime", requireRole(["owner"]), async (req, res) =>
    res.json(await teams.inspectMemberRuntime(standaloneTeam(req.params.id), id.parse(req.params.memberId))));
  app.post("/api/teams/:id/members/:memberId/retire", requireRole(["owner"]), async (req, res) =>
    res.json(await teams.retireMember(standaloneTeam(req.params.id), id.parse(req.params.memberId), teamMemberRetireSchema.parse(req.body))));
  app.post("/api/teams/:id/parallelism", requireRole(["owner"]), async (req, res) =>
    res.json(await teams.setParallelism(id.parse(req.params.id), teamParallelismSchema.parse(req.body))));
  app.post("/api/teams/:id/decisions/:decisionId/answer", requireRole(["owner", "controller"]), async (req, res) => {
    const teamId = id.parse(req.params.id), decisionId = id.parse(req.params.decisionId), body = teamMutationSchema.parse(req.body);
    if (teams.get(teamId).missionId) throw new TeamError(409, "mission-owned-team", "The mission coordinator answers this subteam's decisions and escalates owner questions to the mission.");
    res.json(await (teams.get(teamId).goal ? goals.answer(teamId, decisionId, body) : teams.answer(teamId, decisionId, body)));
  });
  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/api/teams/:id/${action}`, requireRole(["owner"]), async (req, res) =>
      res.json(await teams[action](standaloneTeam(req.params.id), teamActionSchema.parse(req.body))));
  }
  app.get("/api/machine/resources", async (_req, res) => res.json(await desktopResources.sample()));
  app.post("/api/projects/resolve", requireRole(["owner"]), requireOwnerCli, (req, res) => {
    if (!mirroredProjects) return void res.status(403).json({ error: "Folder mirroring requires a single-tenant host" });
    const { path } = z.object({ path: z.string().max(4096) }).strict().parse(req.body);
    const project = mirroredProjects.resolve(path);
    enrollment.restore(project.id);
    res.json(project);
  });
  app.delete("/api/projects/:id/mirror", requireRole(["owner"]), requireOwnerCli, async (req, res) => {
    if (!mirroredProjects || runtimeSecurity(config.deployment).tenancy !== "single-tenant")
      return void res.status(403).json({ error: "Folder mirroring requires a single-tenant host" });
    const projectId = projectSchema.parse(req.params.id);
    if (!mirroredProjects.isMirrored(projectId)) throw new TeamError(409, "project-not-mirrored", "Only mirrored projects can be forgotten.");
    if (projectConfigChanges.has(projectId)) throw new TeamError(409, "project-config-changing", "Repository setup is being updated. Retry after it finishes.");
    // Holding the configuration lock refuses new sessions, teams and goals while the checks run.
    projectConfigChanges.add(projectId);
    try {
      if (projectSync.applying(projectId)) throw new TeamError(409, "sync-applying", "A workspace sync is being applied to this project. Retry after it finishes.");
      if (projectFileChanges.has(projectId)) throw new TeamError(409, "project-files-changing", "Project files are being changed. Retry after the transfer finishes.");
      assertNoHandoff(projectId);
      if (teams.list().some(team => team.projectId === projectId && !["ready-for-review", "no-change", "cancelled"].includes(team.status)))
        throw new TeamError(409, "project-team-active", "A team run for this project is still active. Finish or cancel it before forgetting the mirror.");
      if (goals.list().some(goal => goal.projectId === projectId && ["running", "needs-input", "paused"].includes(goal.status)))
        throw new TeamError(409, "project-goal-active", "A goal for this project is still active. Finish or cancel it before forgetting the mirror.");
      if (await projectRunning(projectId, true)) throw new TeamError(409, "session-running", "A session is running or starting in this project. Stop it before forgetting the mirror.");
      res.json(mirroredProjects.forget(projectId));
    } finally { projectConfigChanges.delete(projectId); }
  });
  app.get("/api/projects/:id/team", requireRole(["owner"]), requireOwnerCli, (req, res) => {
    res.json(enrollment.get(projectSchema.parse(req.params.id)));
  });
  app.put("/api/projects/:id/team", requireRole(["owner"]), requireOwnerCli, async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    const body = repoEnrollmentRequestSchema.parse(req.body);
    if (runtimeSecurity(config.deployment).tenancy !== "single-tenant")
      throw new TeamError(403, "single-tenant-required", "Repository enrollment requires a single-tenant host.");
    if (projectConfigChanges.has(projectId) || projectFileChanges.has(projectId))
      throw new TeamError(409, "project-busy", "Repository setup or files are being updated. Retry after the operation finishes.");
    projectConfigChanges.add(projectId);
    try { res.json(await enrollment.put(projectId, body)); }
    finally { projectConfigChanges.delete(projectId); }
  });
  app.get("/api/projects/:id/files", async (req, res) => {
    res.json(await desktopFiles.list(projectSchema.parse(req.params.id), z.string().max(4096).default("").parse(req.query.path),
      z.coerce.number().int().min(1).max(200).default(100).parse(req.query.limit), z.string().max(512).optional().parse(req.query.cursor)));
  });
  app.get("/api/projects/:id/file", async (req, res) => {
    res.json(await desktopFiles.download(projectSchema.parse(req.params.id), z.string().min(1).max(4096).parse(req.query.path),
      z.coerce.number().int().min(0).max(DESKTOP_LIMITS.maxFileBytes).default(0).parse(req.query.offset),
      z.coerce.number().int().min(0).max(DESKTOP_LIMITS.chunkBytes).default(DESKTOP_LIMITS.chunkBytes).parse(req.query.length),
      z.string().regex(/^[a-f0-9]{64}$/).optional().parse(req.query.sha256)));
  });
  app.post("/api/projects/:id/uploads", requireRole(["owner"]), async (req, res) => {
    const body = z.object({ path: z.string().min(1).max(4096), size: z.number().int().min(0).max(DESKTOP_LIMITS.maxFileBytes),
      sha256: z.string().regex(/^[a-f0-9]{64}$/), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict().parse(req.body);
    res.json(await desktopFiles.begin(projectSchema.parse(req.params.id), String(res.locals.deviceId), body));
  });
  app.put("/api/projects/:id/uploads/:upload", requireRole(["owner"]), async (req, res) => {
    const body = z.object({ offset: z.number().int().min(0).max(DESKTOP_LIMITS.maxFileBytes), base64: z.string().max(DESKTOP_LIMITS.chunkBytes / 3 * 4) }).strict().parse(req.body);
    res.json(await desktopFiles.chunk(projectSchema.parse(req.params.id), String(res.locals.deviceId), id.parse(req.params.upload), body.offset, body.base64));
  });
  app.post("/api/projects/:id/uploads/:upload/commit", requireRole(["owner"]), async (req, res) => {
    const project = projectSchema.parse(req.params.id);
    res.json(await changeProjectFiles(project, () => desktopFiles.commit(project, String(res.locals.deviceId), id.parse(req.params.upload))));
  });
  app.delete("/api/projects/:id/uploads/:upload", requireRole(["owner"]), async (req, res) => {
    res.json(await desktopFiles.abort(projectSchema.parse(req.params.id), String(res.locals.deviceId), id.parse(req.params.upload)));
  });
  app.delete("/api/projects/:id/file", requireRole(["owner"]), async (req, res) => {
    const project = projectSchema.parse(req.params.id), path = z.string().min(1).max(4096).parse(req.query.path);
    const { expectedHash } = z.object({ expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    res.json(await changeProjectFiles(project, () => desktopFiles.remove(project, path, expectedHash)));
  });
  app.post("/api/projects/:id/directories", requireRole(["owner"]), async (req, res) => {
    const project = projectSchema.parse(req.params.id), { path } = z.object({ path: z.string().min(1).max(4096) }).strict().parse(req.body);
    res.json(await changeProjectFiles(project, () => desktopFiles.directory(project, path)));
  });
  app.post("/api/devices/push", (req, res) => {
    const body = z
      .object({
        token: z.string().max(200).refine(isExpoToken, "Not an Expo push token"),
        platform: z.enum(["android", "ios"]),
      })
      .strict()
      .parse(req.body);
    pushStore.add(String(res.locals.deviceId), body.token, body.platform);
    res.json({ ok: true, push: Boolean(config.push?.enabled) });
  });
  app.delete("/api/devices/push", (req, res) => {
    const body = z
      .object({ token: z.string().max(200) })
      .strict()
      .parse(req.body);
    pushStore.remove(body.token);
    res.json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    const value = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("infinite="))
      ?.slice(9);
    if (value) cookies.delete(hashToken(value));
    res.clearCookie("infinite", { path: "/api" });
    res.json({ ok: true });
  });
  app.get("/api/sessions", async (_req, res) =>
    res.json({ sessions: await listSessions() }),
  );
  app.get("/api/events", (req, res) => {
    const topicValues = z.array(z.union([z.literal("sessions"), z.literal("teams"), z.string().regex(/^session\/[0-9a-f-]{36}$/i)])).min(1).max(16)
      .parse(z.string().min(1).max(4096).parse(req.query.topics).split(","));
    const topics = topicValues.map(value => value === "sessions" || value === "teams" ? value : `session/${id.parse(value.slice(8))}`) as LiveTopic[];
    if (new Set(topics).size !== topics.length) return void res.status(400).json({ error: "Duplicate live topic" });
    const after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).parse(req.query.after);
    const credentialHash = res.locals.authCredentialHash as string;
    const initial = authenticateRequest(req);
    if (!initial || initial.credentialHash !== credentialHash) return void res.status(401).json({ error: "Connect with a device key" });
    const streamCounts = eventStreamCounts;
    const active = streamCounts.get(credentialHash) ?? 0;
    if (active >= MAX_EVENTS_STREAMS) return void res.status(429).json({ code: "busy", error: "Too many live event streams for this device" });
    streamCounts.set(credentialHash, active + 1);
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    let stop = () => {};
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      stop();
      const count = (streamCounts.get(credentialHash) ?? 1) - 1;
      if (count > 0) streamCounts.set(credentialHash, count); else streamCounts.delete(credentialHash);
    };
    const stillAuthenticated = () => {
      const current = authenticateRequest(req);
      return Boolean(current && current.credentialHash === credentialHash && current.device.id === initial.device.id && current.device.role === initial.device.role);
    };
    const terminate = (reason: "auth-revoked" | "buffer-limit") => {
      close();
      if (reason === "buffer-limit") {
        const frame = `event: close\ndata: {"reason":"buffer-limit"}\n\n`;
        if (res.writableLength + Buffer.byteLength(frame) <= MAX_EVENTS_BUFFERED_BYTES) return void res.end(frame);
        res.once("error", () => {});
        return void res.destroy(new Error("HTTP events buffer limit exceeded"));
      }
      res.end();
    };
    const writeFrame = (frame: string) => {
      if (closed || res.destroyed || res.writableEnded) return false;
      if (!stillAuthenticated()) { terminate("auth-revoked"); return false; }
      if (res.writableLength + Buffer.byteLength(frame) > MAX_EVENTS_BUFFERED_BYTES) { terminate("buffer-limit"); return false; }
      res.write(frame);
      return true;
    };
    res.on("close", close);
    res.flushHeaders();
    if (!writeFrame(": connected\n\n")) return;
    const unsubscribe = live.subscribe(topics, after, update => {
      writeFrame(`event: update\ndata: ${JSON.stringify(update)}\n\n`);
    });
    if (closed) unsubscribe(); else stop = unsubscribe;
    if (!closed) {
      heartbeat = setInterval(() => { writeFrame(": heartbeat\n\n"); }, 15000);
      heartbeat.unref();
    }
  });
  app.post("/api/sessions", requireRole(["owner"]), async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: "invalid-create", error: "Invalid session details", details: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) });
    const request = parsed.data;
    assertNoHandoff(request.projectId);
    if (request.workspace && (!res.locals.bearer || runtimeSecurity(config.deployment).tenancy !== "single-tenant"))
      return void res.status(403).json({ error: "Laptop execution requires an owner device key and a single-tenant host" });
    if (request.backend === "cmux") {
      if (!cmux) return void res.status(409).json({ error: "cmux is not enabled on this machine" });
      if (request.nativeArgs || request.workspace || request.localUi) return void res.status(400).json({ error: "Choose a configured project and agent for cmux" });
      return void res.status(201).json(await startInProject(request.projectId, () => cmux.create(request)));
    }
    const { backend: _backend, ...nativeRequest } = request;
    res.status(201).json(await startInProject(request.projectId, () => manager.create(nativeRequest)));
  });
  // Imported sessions keep their own transport and journal. Authorization is the same
  // as the managed-worker routes; raw native gateways remain worker-only.
  app.use("/api/sessions/:id", async (req, res, next) => {
    if (!cmux) return next();
    const sessionId = id.parse(req.params.id);
    if (existsSync(join(config.stateDir, "sessions", sessionId, "meta.sealed"))) return next();
    const action = req.path;
    if ((req.method === "POST" && action === "/archive") || req.method === "DELETE") {
      if (res.locals.role !== "owner") return void res.status(403).json({ error: "This device is not allowed to perform that action" });
      try { await cmux.get(sessionId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return next();
        throw error;
      }
      return void res.status(409).json({ error: "This action is unavailable for cmux sessions", code: "unsupported" });
    }
    if (req.method === "GET") {
      if (action === "/" || action === "") {
        const session = await cmux.get(sessionId);
        return void res.json({ ...session, machineId: config.machine!.id, resumable: resumable(session) });
      }
      if (action === "/events") {
        await cmux.get(sessionId);
        const after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).parse(req.query.after);
        const limit = z.coerce.number().int().min(1).max(200).default(200).parse(req.query.limit);
        const page = cmux.events(sessionId, after, limit);
        const types = typeof req.query.types === "string" ? new Set(req.query.types.split(",")) : undefined;
        return void res.json({ ...page, events: types ? page.events.filter(e => types.has(e.type)) : page.events });
      }
      if (action === "/messages") return void res.json(await cmux.messages(sessionId,
        z.string().max(100).optional().parse(req.query.after), z.coerce.number().int().min(1).max(200).default(200).parse(req.query.limit)));
      if (action === "/file") return void res.json(await sessionFile(await cmux.get(sessionId), z.string().parse(req.query.path)));
      if (action === "/summary" && req.query.status === "1") return void res.json({ state: "unavailable", error: "Repository briefing is unavailable for cmux sessions." });
      return void res.status(409).json({ error: "This action is unavailable for cmux sessions", code: "unsupported" });
    }
    if (req.method !== "POST") return void res.status(405).json({ error: "Unsupported method" });
    const roles = ["/stop", "/resize", "/resume"].includes(action) ? ["owner"] : ["owner", "controller"];
    if (!roles.includes(res.locals.role)) return void res.status(403).json({ error: "This device is not allowed to perform that action" });
    const authority = { actor: res.locals.actor, leaseId: res.locals.leaseId };
    try {
      if (action === "/control") {
        const body = z.object({ action: z.enum(["claim", "renew", "release"]), leaseId: id.optional(), takeover: z.boolean().optional() }).strict().parse(req.body);
        return void res.json({ control: await cmux.call(sessionId, { op: "control", ...body, actor: res.locals.actor }) });
      }
      if (action === "/input") return void res.json(await cmux.call(sessionId, { op: "input", ...inputSchema.parse(req.body), ...authority }));
      if (action === "/answer") return void res.json(await cmux.call(sessionId, { op: "answer", ...answerSchema.parse(req.body), ...authority }));
      if (action === "/key") {
        const body = z.object({ requestId: id, key: z.enum(["interrupt", "enter", "escape", "up", "down", "tab"]) }).strict().parse(req.body);
        return void res.json(await cmux.call(sessionId, { op: "key", ...body, ...authority }));
      }
      if (action === "/stop") return void res.json(await cmux.call(sessionId, { op: "stop", ...z.object({ requestId: id }).strict().parse(req.body), ...authority }));
      if (action === "/resume") {
        const { requestId } = z.object({ requestId: id }).strict().parse(req.body);
        return void res.json(await startInProject((await cmux.get(sessionId)).projectId, () => cmux.resume(sessionId, requestId)));
      }
      return void res.status(409).json({ error: "This action is unavailable for cmux sessions", code: "unsupported" });
    } catch (error) {
      const code = (error as WorkerError).code;
      if (code === "prompt-open" || (code && ANSWER_REFUSALS.has(code)))
        return void res.status(409).json({ error: code, attention: (await cmux.get(sessionId)).attention });
      throw error;
    }
  });
  app.get("/api/sessions/:id", async (req, res) => {
    res.json(await sessionDetail(id.parse(req.params.id)));
  });
  app.get("/api/sessions/:id/handoff", (req, res) => res.json(handoffs.view(id.parse(req.params.id))));
  app.get("/api/sessions/:id/messages", async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const session = manager.meta(sessionId).session;
    const transcript = (await manager.state(sessionId)).capabilities?.transcript === 1;
    res.json(recordedMessages(manager, session, z.string().max(100).optional().parse(req.query.after),
      z.coerce.number().int().min(1).max(200).default(200).parse(req.query.limit), transcript));
  });
  // A digest of the chat after a cursor. The text is the model's reading, labeled as such.
  app.get("/api/sessions/:id/summary", async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const session = manager.meta(sessionId).session;
    if (req.query.status === "1") {
      if (!repositoryBriefings) return void res.json({ state: "unavailable", error: "Repository briefings are not configured on this host." });
      return void res.json(await repositoryBriefings.status(session));
    }
    if (req.query.status !== undefined) return void res.status(400).json({ error: "Use status=1 to read repository briefing status." });
    const from = z.string().regex(/^\d{1,16}$/).default("0").parse(req.query.after);
    if (!Number.isSafeInteger(Number(from))) return void res.status(400).json({ error: "Invalid message cursor" });
    if (repositoryBriefings) {
      try {
        res.json(await repositoryBriefings.summarize(session, from));
      } catch {
        res.status(502).json({ code: "repository-briefing-failed", error: "The repository brief could not be generated." });
      }
      return;
    }
    const transcript = (await manager.state(sessionId)).capabilities?.transcript === 1;
    const messages = [];
    let cursor = from, pages = 0;
    for (;;) {
      const page = recordedMessages(manager, session, cursor, 200, transcript);
      messages.push(...page.messages);
      cursor = page.cursor;
      if (!page.more || ++pages >= 10 || messages.length >= 1000) break;
    }
    if (!summarizer) return void res.status(503).json({ code: "summaries-unavailable", error: "This host has no summary model configured." });
    try {
      res.json(await summarizer.summarize(sessionId, messages, from, cursor));
    } catch (error) {
      if (error instanceof SummaryError) return void res.status(error.status).json({ code: "summary-failed", error: error.message });
      throw error;
    }
  });
  app.get("/api/sessions/:id/file", async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const session = manager.meta(sessionId).session;
    if (session.workspace) throw new ContentError("Hybrid files must be inspected on their executor or through an explicit recovery copy");
    res.json(await sessionFile(session, z.string().parse(req.query.path)));
  });
  app.post("/api/sessions/:id/archive", requireRole(["owner"]), refuseMissionManaged, async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const body = z.object({ requestId: id, archived: z.boolean() }).strict().parse(req.body);
    await manager.setArchived(sessionId, body.archived);
    res.json(await sessionDetail(sessionId));
  });
  app.delete("/api/sessions/:id", requireRole(["owner"]), refuseTeamSessionDeletion, refuseMissionManaged, async (req, res) => {
    const sessionId = id.parse(req.params.id);
    try {
      if (manager.meta(sessionId).session.team)
        return void res.status(409).json({ code: "team-session", error: "Team sessions cannot be deleted individually" });
      await manager.remove(sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return void res.status(404).json({ code: "not-found", error: "Session not found" });
      throw error;
    }
    res.json({ ok: true, id: sessionId });
  });
  app.post("/api/sessions/:id/resume", refuseMissionManaged, requireRole(["owner"]), async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const { requestId } = z.object({ requestId: id }).strict().parse(req.body);
    res.json(await startInProject(manager.meta(sessionId).session.projectId, () => manager.resume(sessionId, requestId)));
  });
  app.get("/api/sessions/:id/native", refuseMissionManaged, requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer) return res.status(403).json({ error: "Pair an owner CLI to use the native frontend" });
    const sessionId = id.parse(req.params.id);
    if (!manager.meta(sessionId).session.runtime?.nativeUi) return res.status(409).json({ error: "This session uses its original terminal transport" });
    res.json(await workerCall(config.runDir, sessionId, { op: "native-info" }));
  });
  app.post("/api/sessions/:id/workspace-export", requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer || req.headers.origin) return void res.status(403).json({ error: "Workspace recovery requires a paired owner CLI" });
    const sessionId = id.parse(req.params.id);
    if (!manager.meta(sessionId).session.workspace) return void res.status(409).json({ error: "This session has no hybrid workspace" });
    const request = z.object({ method: z.enum(["sync/export", "sync/blob"]), hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(req.body);
    if (request.method === "sync/blob" && !request.hash) return void res.status(400).json({ error: "A content hash is required" });
    res.json(await workerCall(config.runDir, sessionId, { op: "workspace-export", ...request }, 300000));
  });
  app.all(/^\/api\/sessions\/([a-f\d-]{36})\/opencode(\/.*)?$/, refuseMissionManaged, requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer || req.headers.origin || !res.locals.leaseId) return void res.status(403).json({ error: "Native access requires an owner CLI and current control" });
    const sessionId = id.parse(req.params[0]);
    if (manager.meta(sessionId).session.runtime?.nativeUi !== "opencode") return void res.status(409).json({ error: "This session does not use an OpenCode server" });
    const backend = await workerCall<{ url: string; token: string }>(config.runDir, sessionId, { op: "native-connect", actor: res.locals.actor, leaseId: res.locals.leaseId });
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(backend.url)) throw new Error("Invalid native endpoint");
    const path = new URL(req.originalUrl, origin).pathname.slice(`/api/sessions/${sessionId}/opencode`.length) || "/";
    const query = new URL(req.originalUrl, origin).search;
    proxyNativeHttp(req, res, new URL(backend.url + path + query), { Authorization: backend.token }, req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body)));
  });
  app.get("/api/sessions/:id/events", async (req, res) => {
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0)
      .parse(req.query.after);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(200)
      .parse(req.query.limit);
    const types: Set<string> | undefined =
      typeof req.query.types === "string"
        ? new Set(
            z
              .array(
                z.enum([
                  "output",
                  "lifecycle",
                  "input-intent",
                  "input-result",
                  "signal",
                  "usage",
                  "message",
                ]),
              )
              .min(1)
              .max(6)
              .parse(req.query.types.split(",")),
          )
        : undefined;
    const sessionId = id.parse(req.params.id);
    const page = await sessionEvents(sessionId, after, limit);
    res.json({ ...page, events: types ? page.events.filter(event => types.has(event.type)) : page.events });
  });
  app.post("/api/sessions/:id/control", refuseManagedClaim, requireRole(["owner", "controller"]), async (req, res) => {
    const sessionId = id.parse(req.params.id);
    manager.meta(sessionId);
    const body = z.object({
      action: z.enum(["claim", "renew", "release"]),
      leaseId: id.optional(),
      takeover: z.boolean().optional(),
    }).strict().parse(req.body);
    if (!(await manager.state(sessionId)).capabilities?.inputControl)
      return void res.status(409).json({ error: "This session uses an older worker without input control", code: "unsupported" });
    res.json({ control: await manager.controlSession(sessionId, { op: "control", ...body, actor: res.locals.actor }) });
  });
  // Only a directly paired owner CLI can send terminal control bytes. Browser
  // cookies and controller/viewer keys retain their existing narrower inputs.
  app.post("/api/sessions/:id/raw", refuseManagedOutsideProviderPrompt, requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer) return res.status(403).json({ error: "Pair an owner CLI to use native input" });
    const sessionId = id.parse(req.params.id);
    manager.meta(sessionId);
    const body = z.object({ requestId: id, text: z.string().min(1).max(8192) }).strict().parse(req.body);
    res.json(await workerCall<Receipt>(config.runDir, sessionId, { op: "raw", ...body, ...await inputAuthority(sessionId, res) }));
  });
  app.get("/api/sessions/:id/stream", async (req, res) => {
    const sessionId = id.parse(req.params.id);
    manager.meta(sessionId);
    let cursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).parse(req.query.after);
    res.set({ "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const send = async (value: unknown) => {
      if (res.destroyed) return;
      if (!res.write(JSON.stringify(value) + "\n")) {
        await new Promise<void>((resolve) => {
          const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
          res.once("drain", done); res.once("close", done);
        });
      }
    };
    try {
      for await (const page of terminalPages(manager, sessionId, cursor, abort.signal, req.query.snapshot === "1")) await send(page);
    } catch {
      if (!res.destroyed) await send({ error: "Recording stream interrupted; reconnect to replay from the last cursor" });
    } finally { res.end(); }
  });
  app.post(
    "/api/sessions/:id/input",
    refuseManagedOutsideProviderPrompt,
    requireRole(["owner", "controller"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = inputSchema.parse(req.body);
      try {
        res.json(
          await workerCall<Receipt>(config.runDir, sessionId, {
            op: "input",
            ...body,
            ...await inputAuthority(sessionId, res),
          }),
        );
      } catch (error) {
        // A dialog is open: the text would land in it, so nothing was typed.
        if ((error as WorkerError).code === "prompt-open")
          return void res.status(409).json({
            error: "prompt-open",
            attention: (await manager.state(sessionId)).attention,
          });
        throw error;
      }
    },
  );
  app.post(
    "/api/sessions/:id/answer",
    requireRole(["owner", "controller"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = answerSchema.parse(req.body);
      const authority = missionManagedSession(sessionId) ? { missionManaged: true as const } : await inputAuthority(sessionId, res);
      try {
        // An answer waits for the dialog to redraw and close, so it gets more than the default 4 s.
        res.json(
          await workerCall(
            config.runDir,
            sessionId,
            { op: "answer", ...body, ...authority },
            12000,
          ),
        );
      } catch (error) {
        const code = (error as WorkerError).code;
        if (code && ANSWER_REFUSALS.has(code))
          return void res.status(409).json({
            error: code,
            attention: (await manager.state(sessionId)).attention,
          });
        throw error;
      }
    },
  );
  app.post(
    "/api/sessions/:id/key",
    refuseManagedOutsideProviderPrompt,
    requireRole(["owner", "controller"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = z
        .object({
          requestId: id,
          key: z.enum(["interrupt", "enter", "escape", "up", "down", "tab"]),
        })
        .strict()
        .parse(req.body);
      res.json(
        await workerCall(config.runDir, sessionId, { op: "key", ...body, ...await inputAuthority(sessionId, res) }),
      );
    },
  );
  app.post(
    "/api/sessions/:id/stop",
    refuseMissionManaged,
    requireRole(["owner"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = z.object({ requestId: id }).strict().parse(req.body);
      res.json(
        await workerCall(config.runDir, sessionId, { op: "stop", ...body, ...await inputAuthority(sessionId, res) }),
      );
    },
  );
  app.post(
    "/api/sessions/:id/resize",
    requireRole(["owner"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = z
        .object({
          cols: z.number().int().min(20).max(240),
          rows: z.number().int().min(5).max(100),
        })
        .strict()
        .parse(req.body);
      res.json(
        await workerCall(config.runDir, sessionId, { op: "resize", ...body, ...await inputAuthority(sessionId, res) }),
      );
    },
  );
  app.get("/api/projects/:id", async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    const project = config.projects.find(p => p.id === projectId);
    if (!project) return void res.status(404).json({ error: "Unknown project" });
    res.json({ id: project.id, name: project.name, path: project.path, source: projectSource.status(projectId), sync: await projectSync.liveStatus(projectId, () => projectRunning(projectId)) });
  });
  app.post("/api/projects/:id/source/refresh", requireRole(["owner"]), async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    if (!projectSource.isGithub(projectId)) throw new ProjectSourceError("This project follows the laptop, not GitHub.", "not-github");
    res.json(await projectSource.refresh(projectId));
  });
  // Sync moves whole checkouts, ignored files and credentials included, so it shares laptop execution's single-tenant gate.
  app.use("/api/projects/:id/sync", (_req, res, next) => runtimeSecurity(config.deployment).tenancy === "single-tenant" ? next()
    : void res.status(403).json({ error: "Workspace sync requires a single-tenant host" }));
  const refuseGithubSync = (projectId: string, res: express.Response) => {
    if (!projectSource.isGithub(projectId)) return false;
    res.status(409).json({ error: "This project follows GitHub; laptop sync is off. Re-enroll with --source laptop to upload from this computer.", code: "source-github" });
    return true;
  };
  app.post("/api/projects/:id/sync/begin", requireRole(["owner"]), requireOwnerCli, (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    if (refuseGithubSync(projectId, res)) return;
    res.json(projectSync.begin(projectId));
  });
  app.post("/api/projects/:id/sync/has", requireRole(["owner"]), requireOwnerCli, async (req, res) => {
    const body = z.object({ hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512) }).strict().parse(req.body);
    res.json({ missing: await projectSync.missing(projectSchema.parse(req.params.id), body.hashes) });
  });
  // A body over one chunk can never be stored; it answers 413 before it is read.
  app.put("/api/projects/:id/sync/blob/:hash", requireRole(["owner"]), requireOwnerCli, express.raw({ type: "application/octet-stream", limit: WORKSPACE_LIMITS.chunkBytes }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: "Send the chunk as application/octet-stream" });
    await projectSync.putBlob(projectSchema.parse(req.params.id), String(req.params.hash), req.body);
    res.json({ stored: true });
  });
  // A batch frames many chunks in one request, so an upload pays one round trip per batch instead of per chunk.
  app.put("/api/projects/:id/sync/blobs", requireRole(["owner"]), requireOwnerCli, express.raw({ type: "application/octet-stream", limit: WORKSPACE_LIMITS.batchBytes }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: "Send the chunk batch as application/octet-stream" });
    res.json({ stored: await projectSync.putBlobs(projectSchema.parse(req.params.id), req.body) });
  });
  // The body wraps a manifest of up to the manifest bound with its generation; the store checks the manifest itself.
  app.post("/api/projects/:id/sync/commit", requireRole(["owner"]), requireOwnerCli, express.json({ limit: WORKSPACE_LIMITS.manifestBytes + 64 * 1024 }), async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    if (refuseGithubSync(projectId, res)) return;
    const body = z.object({ generation: z.uuid(), manifest: z.unknown() }).strict().parse(req.body);
    res.json(await projectSync.commit(projectId, body.generation, body.manifest, () => projectRunning(projectId)));
  });
  app.post("/api/projects/:id/sync/apply", requireRole(["owner"]), async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    if (refuseGithubSync(projectId, res)) return;
    const body = z.object({ force: z.boolean().optional() }).strict().parse(req.body ?? {});
    res.json(await projectSync.apply(projectId, { force: body.force, running: () => projectRunning(projectId) }));
  });
  app.post("/api/projects/:id/sync/export", requireRole(["owner"]), requireOwnerCli, async (req, res) => {
    res.json({ manifest: await projectSync.exportTree(projectSchema.parse(req.params.id)) });
  });
  app.get("/api/projects/:id/sync/blob/:hash", requireRole(["owner"]), requireOwnerCli, async (req, res) => {
    res.json({ base64: await projectSync.readBlob(projectSchema.parse(req.params.id), String(req.params.hash)) });
  });
  const projectContexts = new ProjectContexts(config, key);
  app.get("/api/projects/:id/context-links", (req, res) => {
    return res.json(projectContexts.listLinks(String(req.params.id)));
  });
  app.put("/api/projects/:id/context-links", requireRole(["owner"]), (req, res) => {
    return res.json(projectContexts.setLinks(String(req.params.id), contextLinksRequest.parse(req.body)));
  });
  app.get("/api/projects/:id/context", (req, res) => {
    if (!config.projects.some((p) => p.id === req.params.id))
      return res.status(404).json({ error: "Unknown project" });
    return res.json(manager.context(req.params.id));
  });
  app.put("/api/projects/:id/context", requireRole(["owner"]), (req, res) => {
    if (!config.projects.some((p) => p.id === req.params.id))
      return res.status(404).json({ error: "Unknown project" });
    const body = z
      .object({
        text: z.string().max(24000),
        expectedVersion: z.number().int().min(0),
      })
      .strict()
      .parse(req.body);
    return res.json(
      manager.setContext(
        String(req.params.id),
        body.text,
        body.expectedVersion,
      ),
    );
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found" }),
  );
  app.use(
    express.static(
      fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url)),
    ),
  );
  app.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      // `error` carries the message every client displays; a failed sync operation also names its category.
      if (error instanceof TeamError) return res.status(error.status).json({ code: error.code, error: error.message });
      if (error instanceof CatalogError) return res.status(error.statusCode).json({ code: "understanding-catalog", error: error.message });
      if (error instanceof BehaviorError) return res.status(error.statusCode).json({ code: "understanding-behavior", error: error.message });
      if (error instanceof ProjectSyncError)
        return res.status(error.status).json({ code: error.code, error: error.message, ...(error.category ? { category: error.category, message: error.message } : {}) });
      if (error instanceof ProjectSourceError) return res.status(error.status).json({ error: error.message, code: error.code });
      if (error instanceof ContentError) return res.status(error.status).json({ error: error.message });
      if (error instanceof DesktopError) return res.status(error.status).json({ code: error.code, error: error.message });
      if (error instanceof z.ZodError)
        return res.status(400).json({
          error: "Invalid request",
          details: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      if ((error as { type?: string }).type === "entity.too.large")
        return res.status(413).json({ error: "Request body is too large" });
      if (error instanceof SyntaxError)
        return res.status(400).json({ error: "Invalid JSON" });
      if (/^\/api\/projects\/[^/]+\/(?:files?|uploads|directories)(?:\/|$)/.test(req.path)) {
        const code = (error as NodeJS.ErrnoException).code;
        return res.status(code === "ENOENT" ? 404 : code === "EACCES" || code === "EPERM" ? 403 : 409)
          .json({ code: "file-unavailable", error: "The file operation could not be completed. Refresh the project before retrying." });
      }
      // Workspace sync failures are about the project tree, not a session; their category never names a path.
      if (/^\/api\/projects\/[^/]+\/sync\//.test(req.path)) {
        const failure = syncFailure(error);
        return res.status(409).json({ code: "sync-failed", category: failure.category, error: failure.message, message: failure.message });
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return res.status(404).json({ error: "Session not found" });
      if (["control-busy", "control-lost"].includes((error as WorkerError).code ?? ""))
        return res.status(409).json({
          code: (error as WorkerError).code,
          error: (error as WorkerError).code === "control-busy"
            ? "Another device controls this session. Take over explicitly to send input."
            : "Control changed or expired. This input was not sent. Refresh and take control again.",
        });
      if (error instanceof CmuxError) {
        const status = ["cmux-unavailable", "session-unavailable", "cmux-busy"].includes(error.code) ? 503
          : ["invalid-cursor", "invalid-control"].includes(error.code) ? 400 : 409;
        return res.status(status).json({ code: error.code, error: error.message });
      }
      // Never echo filesystem paths, prompts, tokens, or child process details.
      return res.status(409).json({
        error:
          "Operation could not be completed. Refresh the session before retrying. Input delivery may be uncertain.",
      });
    },
  );
  const server = createServer(app);
  // One listener per event: Node warns about a leak once more than ten listeners share one emitter,
  // and the subsystems below plus the socket routes attached next crossed that limit.
  server.once("listening", () => {
    linear.start();
    teams.start();
    goals.start();
    missions.start();
    handoffs.start();
    readings.start();
    // The timer checks each tick which projects follow GitHub, so one enrolled while the server runs is picked up too.
    projectSource.start();
    void repositoryBriefings?.start().catch(() => {});
    understandingRuntime.start();
    balances.start();
  });
  server.once("close", () => {
    teams.close();
    usage.close();
    balances.close();
    goals.close();
    missions.close();
    repositoryBriefings?.close();
    void understandingRuntime.close();
    void understandingBehaviors.close();
    linear.close();
    handoffs.close();
    readings.stop();
    projectSource.stop();
  });
  const closeTerminals = connectTerminals(server, manager, authenticate, missionManagedSession);
  const closeNative = connectNativeFrontends(server, manager, authenticate, missionManagedSession);
  const closeRemote = connectRemoteAccess(server, config);
  const closeConnections = () => { live.close(); handoffs.close(); missions.close(); readings.stop(); goals.close(); teams.close(); usage.close(); balances.close(); linear.close(); const briefingClosed = Promise.all([repositoryBriefings?.close(), understandingRuntime.close(), understandingBehaviors.close()]).then(() => {}); closeTerminals(); closeNative(); closeRemote(); desktopFiles.close(); cmux?.close(); server.closeAllConnections(); return briefingClosed; };
  return { app, manager, projectSync, teams, goals, missions, readings, sessions: { list: listSessions }, pushStore, server, closeConnections };
}
