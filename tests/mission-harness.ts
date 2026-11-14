import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { stopSessionWorkers, waitFor } from "./helpers.js";
import { unseal } from "../packages/host/src/vault.js";
import { Manager } from "../packages/host/src/manager.js";
import type { HostLoadProbe } from "../packages/host/src/host-load.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { MissionService, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import type { Config } from "../packages/host/src/types.js";
import type { CreateTeam, NativeContinuation, TeamAssignment, TeamLineup, TeamView } from "../packages/host/src/team-types.js";
import type { CreateMission, MissionReport } from "../packages/host/src/mission-types.js";
import { emptyRollup, type UsageRollup } from "../packages/host/src/team-usage.js";
import { applySignal, initialAttention, screenDecision, type Attention, type Signal, type SignalEvent } from "@infinite/attention";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

/** Real team and mission services over real session workers, with a two-repository project behind a fake group lookup. */
export function missionHarness(options?: { configure?: (config: Config) => void; hostProbe?: HostLoadProbe }) {
  const root = realpathSync(mkdtempSync("/tmp/inf-mission-"));
  const receipts = join(root, "receipts");
  mkdirSync(receipts, { mode: 0o700 });
  const repo = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "check.mjs"), `import { existsSync } from "node:fs";\nif (!existsSync("${name}.txt")) process.exit(1);\n`);
    git(path, "init", "--initial-branch=main"); git(path, "add", "check.mjs");
    git(path, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", `Initial ${name}`);
    return path;
  };
  const api = repo("api"), web = repo("web");
  const key = randomBytes(32), keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const agent = (provider: string) => ({ command: process.execPath, args: [resolve("tests/fixtures/mission-agent.mjs"), "mission", receipts, provider] });
  const checks = [{ command: process.execPath, args: ["check.mjs"] }];
  const config: Config = { port: 0, origin: "http://127.0.0.1", keyFile, stateDir: join(root, "state"), runDir: join(root, "run"), tokens: [],
    environment: "local", enableDemo: true, maxSessions: 24, agents: { claude: agent("claude"), codex: agent("codex") },
    projects: [{ id: "api", name: "API", path: api, team: { checks } }, { id: "web", name: "Web", path: web, team: { checks } }],
    teams: { workspaceDir: join(root, "teams"), lineup } };
  options?.configure?.(config);
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = { get: id => {
    if (id !== "shop") throw new TeamError(404, "project-group-not-found", "This project does not exist.");
    return { id, name: "Shop", kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: at, updatedAt: at,
      repos: [
        { projectId: "api", name: "API", path: api, checkouts: [{ projectId: "api", name: "API", path: api, primary: true, teamReady: true }] },
        { projectId: "web", name: "Web", path: web, checkouts: [{ projectId: "web", name: "Web", path: web, primary: true, teamReady: true }] },
      ] };
  } };
  let services: { teams: TeamService; missions: MissionService } | undefined;
  const open = () => {
    const manager = new Manager(config, key, options?.hostProbe);
    const teams = new TeamService(config, key, manager, (_project, start) => start());
    const missions = new MissionService(config, key, manager, teams, groups);
    teams.start(); missions.start();
    services = { teams, missions };
    return services;
  };
  const shut = () => { services?.missions.close(); services?.teams.close(); services = undefined; };
  const coordinatorReceipts = () => readdirSync(receipts).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(receipts, name), "utf8"))).filter(receipt => receipt.role === "mission-coordinator");
  const create = (objective = "Add an endpoint to the API and call it from the web client"): CreateMission =>
    ({ requestId: randomUUID(), groupId: "shop", objective, maxSubtasks: 8, maxMinutes: 30 });
  const release = (name: string) => writeFileSync(join(receipts, name), "go", { mode: 0o600 });
  const close = async () => {
    const closing = services;
    shut();
    // A tick already under way can still launch a coordinator attempt or subteam member after close().
    await closing?.missions.idle(); await closing?.teams.idle();
    // Workers exit 1.5 s after their child. Sweep until none answers, so no worker or provider outlives the test.
    for (let pass = 1; await stopSessionWorkers(config); pass++) {
      if (pass === 8) throw new Error("Session workers still answer after the mission test stopped them");
      await new Promise(done => setTimeout(done, 500));
    }
    await new Promise(done => setTimeout(done, 1700));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, api, web, open, shut, close, create, release, coordinatorReceipts, services: () => services! };
}

type FakeRun = { id: string; projectId: string; missionId: string; status: TeamView["status"]; revision: number; updatedAt: string; parallelism?: number; parallelismCeiling?: number;
  usage?: UsageRollup; workspaceRemovedAt?: string;
  recovery?: { attempts: number; status: "stopping" | "planning" | "exhausted"; source: { code: string; memberId: string; revision: number; reportKind?: string; reason: string; at: string } };
  decisions: { id: string; memberId: string; revision: number; question: string; options: string[]; createdAt: string; answer?: string }[] };

/**
 * The real mission service over scripted coordinator sessions and subteams: each coordinator attempt
 * reports what the test tells it to, and each subteam is in whatever state the test sets.
 */
export function scriptedMissionHarness(options?: { configure?: (config: Config) => void }) {
  const root = realpathSync(mkdtempSync("/tmp/inf-mission-script-"));
  const repo = (name: string) => { const path = join(root, name); mkdirSync(path); return path; };
  const checks = [{ command: process.execPath, args: ["-e", "0"] }];
  const config: Config = { port: 0, origin: "http://127.0.0.1", keyFile: join(root, "key"), stateDir: join(root, "state"), runDir: join(root, "run"), tokens: [],
    environment: "local", enableDemo: false, maxSessions: 24, agents: { claude: { command: process.execPath, args: [] } },
    projects: [{ id: "api", name: "API", path: repo("api"), team: { checks } }, { id: "web", name: "Web", path: repo("web"), team: { checks } }],
    teams: { workspaceDir: join(root, "teams"), lineup } };
  options?.configure?.(config);
  type CoordinatorRequest = { requestId: string; prompt: string; continuation?: NativeContinuation };
  const attempts: { sessionId: string; assignment: TeamAssignment; prompt: string; request: CoordinatorRequest }[] = [];
  const reports = new Map<string, MissionReport>();
  // Each coordinator session's journaled signals and the attention the real reducer derives from them.
  const signals = new Map<string, SignalEvent[]>(), attention = new Map<string, Attention>();
  const stateReads = new Map<string, number>(), sessionStatuses = new Map<string, "running" | "exited">();
  const nativeSessions = new Map<string, { id: string; source: "hook" }>();
  const held = new Set<string>(), stops: string[] = [];
  const signal = (sessionId: string, data: Signal, at = new Date()) => {
    const journal = signals.get(sessionId)!;
    const event: SignalEvent = { seq: journal.length + 1, at: at.toISOString(), type: "signal", data: { ...data, source: "hook", provider: "claude" } };
    journal.push(event);
    attention.set(sessionId, applySignal(attention.get(sessionId)!, event));
  };
  const manager = {
    async createTeamSession(request: CoordinatorRequest, assignment: TeamAssignment) {
      if (!attempts.some(item => item.sessionId === request.requestId)) {
        attempts.push({ sessionId: request.requestId, assignment, prompt: request.prompt, request });
        signals.set(request.requestId, []); attention.set(request.requestId, initialAttention(new Date().toISOString(), true));
        sessionStatuses.set(request.requestId, "running");
        signal(request.requestId, { kind: "turn-start" });
      }
      return { status: "running" };
    },
    events(sessionId: string, cursor: number, _limit: number, types: Set<string>) {
      if (types.has("signal")) { const events = signals.get(sessionId)!.filter(event => event.seq > cursor); return { events, cursor: events.at(-1)?.seq ?? cursor, more: false }; }
      const report = reports.get(sessionId), attempt = attempts.find(item => item.sessionId === sessionId)!;
      if (!report || cursor > 0) return { events: [], cursor, more: false };
      const { runId, memberId, revision } = attempt.assignment;
      return { events: [{ data: { requestId: randomUUID(), missionId: runId, memberId, revision, report } }], cursor: 1, more: false };
    },
    meta() { return {}; },
    async state(sessionId: string) {
      stateReads.set(sessionId, (stateReads.get(sessionId) ?? 0) + 1);
      return { status: sessionStatuses.get(sessionId) ?? "running", attention: attention.get(sessionId), nativeSession: nativeSessions.get(sessionId) };
    },
    async stopTeamSession(sessionId: string) {
      stops.push(sessionId);
      if (!held.has(sessionId)) sessionStatuses.set(sessionId, "exited");
      return { status: held.has(sessionId) ? "running" : "exited", nativeSession: nativeSessions.get(sessionId) };
    },
  };
  const runs = new Map<string, FakeRun>(), standalone = new Set<string>(), failing = new Set<string>();
  let resumeBusy = false;
  const created: { request: CreateTeam; options?: { baseRunId?: string; parallelismCeiling?: number } }[] = [];
  const answers: { teamId: string; decisionId: string; text: string; by?: string }[] = [];
  const steers: { teamId: string; text: string }[] = [];
  const capacityCalls: { teamId: string; requestId: string; revision: number; parallelism: number }[] = [];
  const capacityReceipts = new Map<string, string>();
  let loseCapacityReply = false, bumpCapacityRevision = false;
  const steerReceipts = new Map<string, string>();
  let steerLimit: boolean | Set<string> = false, steerBusy = false, loseSteerReply = false;
  const key = randomBytes(32);
  const view = (run: FakeRun) => ({ ...structuredClone(run), title: run.id, tasks: [], usage: run.usage ?? emptyRollup() }) as unknown as TeamView;
  const run = (id: string) => { const value = runs.get(id); if (!value) throw new TeamError(404, "team-not-found", "This team does not exist."); return value; };
  const set = (id: string, patch: Partial<FakeRun>) => Object.assign(run(id), patch, { updatedAt: new Date().toISOString() });
  const teams = {
    useMissionReservations(_lookup: (projectId: string, exceptMissionId?: string) => string | undefined) {},
    isActiveRun(id: string) {
      const current = runs.get(id);
      return Boolean(current && !["cancelled", "ready-for-review", "merged", "no-change"].includes(current.status));
    },
    async createForMission(request: CreateTeam, missionId: string, _lineup: TeamLineup, options?: { baseRunId?: string; parallelismCeiling?: number }) {
      if (runs.has(request.requestId)) return view(run(request.requestId));
      if (failing.has(request.projectId)) throw new TeamError(409, "team-start-failed", "The repository could not start a team run.");
      created.push({ request, options });
      runs.set(request.requestId, { id: request.requestId, projectId: request.projectId, missionId, status: "implementing", revision: 1, decisions: [], updatedAt: new Date().toISOString(), parallelism: request.parallelism, parallelismCeiling: options?.parallelismCeiling });
      return view(run(request.requestId));
    },
    get: (id: string) => view(run(id)),
    list: () => [...runs.values()].map(view),
    async answer(id: string, decisionId: string, body: { text: string }, _authorize?: () => void, by?: string) {
      answers.push({ teamId: id, decisionId, text: body.text, by });
      const target = run(id);
      target.decisions.find(item => item.id === decisionId)!.answer = body.text;
      if (target.decisions.every(item => item.answer)) set(id, { status: "implementing" });
      return view(target);
    },
    async setMissionParallelism(id: string, body: { requestId: string; revision: number; parallelism: number }) {
      const fingerprint = JSON.stringify(body), prior = capacityReceipts.get(body.requestId);
      capacityCalls.push({ teamId: id, ...body });
      if (prior) {
        if (prior !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
        return view(run(id));
      }
      const target = run(id);
      if (bumpCapacityRevision) { bumpCapacityRevision = false; target.revision++; }
      if (body.revision !== target.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
      if (body.parallelism > (target.parallelismCeiling ?? 4)) throw new TeamError(409, "team-parallelism-limit", "The subteam capacity ceiling was exceeded.");
      capacityReceipts.set(body.requestId, fingerprint);
      target.parallelism = body.parallelism;
      if (loseCapacityReply) { loseCapacityReply = false; throw new TeamError(409, "team-operation-running", "The reply was lost after the capacity change was recorded."); }
      return view(target);
    },
    // Mirrors TeamService.steer: a known request replays, then busy, stale, and limit refusals, then a new revision.
    async steer(id: string, body: { requestId: string; revision: number; text: string }) {
      const fingerprint = JSON.stringify(body);
      if (steerReceipts.has(body.requestId)) {
        if (steerReceipts.get(body.requestId) !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
        return view(run(id));
      }
      if (steerBusy) throw new TeamError(409, "team-operation-running", "A workspace operation is in progress. Retry steering after it settles.");
      if (body.revision !== run(id).revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
      if (steerLimit === true || (steerLimit && steerLimit.has(id))) throw new TeamError(409, "team-steering-limit", "This team reached its steering limit. Start a new team from the reviewed integration branch.");
      steerReceipts.set(body.requestId, fingerprint);
      steers.push({ teamId: id, text: body.text });
      const steered = view(set(id, { status: "planning", revision: run(id).revision + 1 }));
      if (loseSteerReply) { loseSteerReply = false; throw new TeamError(409, "team-operation-running", "The reply was lost after the steer was recorded."); }
      return steered;
    },
    async pause(id: string) { return view(set(id, { status: "paused" })); },
    async resume(id: string) {
      if (resumeBusy) throw new TeamError(409, "team-operation-running", "Another team operation is running.");
      return view(set(id, { status: "implementing" }));
    },
    async cancel(id: string) { return view(set(id, { status: "cancelled" })); },
    async removeRun(id: string) { runs.delete(id); },
    activeForProject: (projectId: string) => standalone.has(projectId) ||
      [...runs.values()].some(item => item.projectId === projectId && !["cancelled", "ready-for-review", "merged", "no-change"].includes(item.status)),
  };
  let removed = false;
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = { get: id => {
    if (id !== "shop" || removed) throw new TeamError(404, "project-group-not-found", "This project does not exist.");
    return { id, name: "Shop", kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: at, updatedAt: at,
      repos: [
        { projectId: "api", name: "API", path: config.projects[0].path, checkouts: [{ projectId: "api", name: "API", path: config.projects[0].path, primary: true, teamReady: true }] },
        { projectId: "web", name: "Web", path: config.projects[1].path, checkouts: [{ projectId: "web", name: "Web", path: config.projects[1].path, primary: true, teamReady: true }] },
      ] };
  } };
  const missions = new MissionService(config, key, manager as unknown as Manager, teams as unknown as TeamService, groups);
  missions.start();
  const attempt = async (n: number) => (await waitFor(async () => attempts[n - 1], value => Boolean(value), 20000))!;
  const parse = (prompt: string, label: string) => JSON.parse(prompt.split("\n").find(line => line.startsWith(label))!.slice(label.length));
  return {
    missions, config, teams, runs, standalone, failing, created, answers, steers, capacityCalls, set,
    /** Later steers of these subteams, or of every subteam, are refused at the steering limit. */
    limitSteering: (teamIds?: string[]) => { steerLimit = teamIds ? new Set(teamIds) : true; },
    /** Subteam steers are refused as busy until released. */
    holdSteers: (held: boolean) => { steerBusy = held; },
    /** The next steer is recorded by the subteam, but the mission sees a retryable error instead of its reply. */
    loseNextSteerReply: () => { loseSteerReply = true; },
    loseNextCapacityReply: () => { loseCapacityReply = true; },
    bumpNextCapacityRevision: () => { bumpCapacityRevision = true; },
    remove: () => { removed = true; },
    attempts: () => attempts.length,
    attempt,
    confirmNative: async (n: number) => {
      const current = await attempt(n), sessionId = current.sessionId;
      const nativeSessionId = current.request.continuation?.nativeSessionId;
      if (!nativeSessionId) throw new Error("Coordinator attempt has no native continuation ID");
      const previousReads = stateReads.get(sessionId) ?? 0;
      nativeSessions.set(sessionId, { id: nativeSessionId, source: "hook" });
      await waitFor(async () => stateReads.get(sessionId) ?? 0, reads => reads > previousReads, 5000);
    },
    exitWithoutNative: async (n: number) => {
      const sessionId = (await attempt(n)).sessionId;
      nativeSessions.delete(sessionId);
      sessionStatuses.set(sessionId, "exited");
    },
    refusals: (id: string) => unseal<{ refusals: number }>(key, "mission:" + id, readFileSync(join(config.stateDir, "missions", id + ".sealed"), "utf8")).refusals,
    messages: async (n: number) => parse((await attempt(n)).prompt, "Messages since your last attempt (JSON): "),
    state: async (n: number) => parse((await attempt(n)).prompt, "Mission state (JSON): "),
    report: async (n: number, report: MissionReport) => { reports.set((await attempt(n)).sessionId, report); },
    /** The coordinator's turn ends without a report; its session stays alive at the prompt. */
    endTurn: async (n: number, at?: Date) => { signal((await attempt(n)).sessionId, { kind: "turn-end" }, at); },
    signal: async (n: number, data: Signal) => signal((await attempt(n)).sessionId, data),
    /** What the session worker publishes when the screen goes quiet without a dialog. */
    quietScreen: async (n: number) => {
      const sessionId = (await attempt(n)).sessionId, current = attention.get(sessionId)!;
      const decision = screenDecision(current, null, true, false, new Date().toISOString());
      if (decision.idle) attention.set(sessionId, { ...current, state: decision.idle, since: current.state === decision.idle ? current.since : new Date().toISOString(), source: "screen" });
      return decision.idle;
    },
    /** Stop requests for that attempt's session report it still running until released. */
    /** An earlier turn ended a minute ago and the provider continued in a new turn. */
    continueAfterTurnEnd: async (n: number) => {
      const sessionId = (await attempt(n)).sessionId;
      signal(sessionId, { kind: "turn-end" }, new Date(Date.now() - 60000)); signal(sessionId, { kind: "turn-start" });
    },
    holdStop: async (n: number) => { held.add((await attempt(n)).sessionId); },
    releaseStop: async (n: number) => { held.delete((await attempt(n)).sessionId); },
    /** Subteam resumes are refused as busy and retried until released. */
    holdResume: () => { resumeBusy = true; },
    /** Releases the held stop and resume together, so one tick applies the resume and then consumes the report. */
    releaseStopAndResume: async (n: number) => { const sessionId = (await attempt(n)).sessionId; held.delete(sessionId); resumeBusy = false; },
    stops: async (n: number) => { const sessionId = (await attempt(n)).sessionId; return stops.filter(item => item === sessionId).length; },
    create: (objective = "Change the API and the web client") => missions.create({ requestId: randomUUID(), groupId: "shop", objective, maxSubtasks: 8, maxMinutes: 30 }),
    get: (id: string) => missions.get(id),
    close: () => { missions.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
