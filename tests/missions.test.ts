import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { stopSessionWorkers, waitFor } from "./helpers.js";
import { inProcessHost } from "./helpers.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { MissionService, missionBoard, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import { createMissionReportEnvelope } from "../packages/host/src/team-report-client.js";
import { missionPromptWithMessageCount, type MissionOpenChildDecision, type MissionMessage } from "../packages/host/src/team-prompts.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config, Session } from "../packages/host/src/types.js";
import type { CreateTeam, TeamAssignment, TeamLineup, TeamView } from "../packages/host/src/team-types.js";
import type { CreateMission, Mission, MissionReport } from "../packages/host/src/mission-types.js";
import { emptyRollup } from "../packages/host/src/team-usage.js";
import { applySignal, initialAttention, screenDecision, type Attention, type Signal, type SignalEvent } from "@infinite/attention";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

/** Real team and mission services over real session workers, with a two-repository project behind a fake group lookup. */
function harness() {
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
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = { get: id => {
    if (id !== "shop") throw new TeamError(404, "project-group-not-found", "This project does not exist.");
    return { id, name: "Shop", implicit: false, revision: 1, createdAt: at, updatedAt: at,
      repos: [{ projectId: "api", name: "API", path: api }, { projectId: "web", name: "Web", path: web }] };
  } };
  let services: { teams: TeamService; missions: MissionService } | undefined;
  const open = () => {
    const manager = new Manager(config, key);
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
    shut();
    await stopSessionWorkers(config);
    // Workers exit 1.5 s after their child; wait so they never write into a removed directory.
    await new Promise(done => setTimeout(done, 1700));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, api, web, open, shut, close, create, release, coordinatorReceipts, services: () => services! };
}

const until = (read: () => Mission, accepts: (mission: Mission) => boolean, timeout = 60000) => waitFor(async () => read(), accepts, timeout);
const standaloneRequest = (projectId: string): CreateTeam => ({
  requestId: randomUUID(), projectId, provider: "claude", useConfiguredLineup: true,
  title: "Standalone run", objective: "Make an independent repository change", parallelism: 1,
});

test("mission-managed sessions refuse direct human input but keep answers, reads, and standalone access", { timeout: 15000 }, async () => {
  const host = await inProcessHost();
  const workers: ReturnType<typeof createNetServer>[] = [];
  const workerRequests: { sessionId: string; request: Record<string, unknown> }[] = [];
  const missionId = randomUUID(), subteamId = randomUUID(), standaloneId = randomUUID();
  const coordinatorId = randomUUID(), subteamSessionId = randomUUID(), standaloneSessionId = randomUUID(), ordinarySessionId = randomUUID();
  const refusal = { error: "This session is run by its mission coordinator. Talk to the coordinator from the mission.", code: "mission-managed" };
  const lease = { id: randomUUID(), label: "Test owner", expiresAt: Date.now() + 30000 };
  const assignment = (runId: string, role: TeamAssignment["role"], memberId = randomUUID()): TeamAssignment => ({ runId, memberId, revision: 1, role });
  const sessions: Session[] = [
    { id: coordinatorId, team: assignment(missionId, "mission-coordinator"), provider: "demo", title: "Coordinator", projectId: "rehearsal", cwd: host.config.projects[0].path, createdAt: new Date().toISOString(), status: "running", contextVersion: 0, context: "", initialPrompt: "", runtime: { id: randomUUID(), location: "local", transport: "pty" } },
    { id: subteamSessionId, team: { ...assignment(subteamId, "implementer"), taskId: "api" }, provider: "demo", title: "Subteam member", projectId: "rehearsal", cwd: host.config.projects[0].path, createdAt: new Date().toISOString(), status: "running", contextVersion: 0, context: "", initialPrompt: "", runtime: { id: randomUUID(), location: "local", transport: "pty", nativeUi: "opencode" } },
    { id: standaloneSessionId, team: { ...assignment(standaloneId, "implementer"), taskId: "api" }, provider: "demo", title: "Standalone member", projectId: "rehearsal", cwd: host.config.projects[0].path, createdAt: new Date().toISOString(), status: "running", contextVersion: 0, context: "", initialPrompt: "", runtime: { id: randomUUID(), location: "local", transport: "pty" } },
    { id: ordinarySessionId, provider: "demo", title: "Ordinary session", projectId: "rehearsal", cwd: host.config.projects[0].path, createdAt: new Date().toISOString(), status: "running", contextVersion: 0, context: "", initialPrompt: "", runtime: { id: randomUUID(), location: "local", transport: "pty" } },
  ];
  const state = { status: "running", pid: 123, seq: 1, screen: "", attention: initialAttention(new Date().toISOString(), false), capabilities: { inputControl: 1 }, control: lease };
  let providerPromptOpen = false;
  const currentState = () => providerPromptOpen
    ? { ...state, attention: { ...state.attention, state: "needs-you" as const } }
    : state;
  try {
    assert.throws(() => host.teams.missionIdOf(randomUUID()), error => error instanceof TeamError && error.code === "team-not-found");
    host.teams.get = (id: string) => {
      if (id === subteamId) throw new Error("Team tracking update failed while building a view");
      return { id, title: "Standalone team" } as ReturnType<typeof host.teams.get>;
    };
    host.teams.missionIdOf = (id: string) => id === subteamId ? missionId : undefined;
    for (const session of sessions) {
      const directory = join(host.config.stateDir, "sessions", session.id);
      mkdirSync(directory, { recursive: true });
      mkdirSync(join(directory, "events"), { recursive: true });
      writeSealed(join(directory, "meta.sealed"), host.manager.key, `${session.id}:meta`, { session, fingerprint: "fixture" });
      const worker = createNetServer(socket => {
        let text = "";
        socket.on("data", chunk => {
          text += chunk.toString();
          const end = text.indexOf("\n");
          if (end < 0) return;
          const request = JSON.parse(text.slice(0, end));
          workerRequests.push({ sessionId: session.id, request });
          const result = request.op === "state" ? currentState()
            : request.op === "control" ? request.action === "release" ? null : lease
              : { requestId: request.requestId, state: "delivered", seq: 2 };
          socket.end(JSON.stringify({ result }) + "\n");
        });
      });
      await new Promise<void>((resolve, reject) => { worker.once("error", reject); worker.listen(join(host.config.runDir, `${session.id}.sock`), resolve); });
      workers.push(worker);
    }

    const listed = await host.fetchApi("/sessions");
    assert.equal(listed.status, 200);
    const rows = new Map(listed.body.sessions.map((session: { id: string }) => [session.id, session]));
    assert.deepEqual((rows.get(coordinatorId) as any).managedBy, { kind: "mission", missionId });
    assert.deepEqual((rows.get(subteamSessionId) as any).managedBy, { kind: "mission", missionId, teamId: subteamId });
    assert.equal("managedBy" in (rows.get(standaloneSessionId) as object), false);
    assert.equal("managedBy" in (rows.get(ordinarySessionId) as object), false);
    assert.deepEqual((await host.fetchApi(`/sessions/${subteamSessionId}`)).body.managedBy, { kind: "mission", missionId, teamId: subteamId });

    const roles = ["owner", "controller", "viewer"] as const;
    for (const sessionId of [coordinatorId, subteamSessionId]) {
      for (const role of roles) {
        const response = await host.fetchApi(`/sessions/${sessionId}/input`, role, { requestId: randomUUID(), text: "direct input" });
        assert.equal(response.status, 409, `${role} input to ${sessionId}`);
        assert.deepEqual(response.body, refusal);
      }
    }
    const encodedSubteamId = `%${subteamSessionId.charCodeAt(0).toString(16).padStart(2, "0")}${subteamSessionId.slice(1)}`;
    for (const path of [
      `/sessions/${subteamSessionId}/input/`,
      `/sessions/${subteamSessionId}/INPUT`,
      `/sessions/${encodedSubteamId}/input`,
    ]) {
      const response = await host.fetchApi(path, "owner", { requestId: randomUUID(), text: "path variant input" });
      assert.equal(response.status, 409, `${path} cannot bypass the route guard`);
      assert.deepEqual(response.body, refusal);
    }
    for (const role of roles) {
      for (const [suffix, body] of [
        ["key", { requestId: randomUUID(), key: "enter" }],
        ["raw", { requestId: randomUUID(), text: "native bytes" }],
        ["stop", { requestId: randomUUID() }],
        ["resume", { requestId: randomUUID() }],
      ] as const) {
        const response = await host.fetchApi(`/sessions/${subteamSessionId}/${suffix}`, role, body);
        assert.equal(response.status, 409, `${role} ${suffix}`);
        assert.deepEqual(response.body, refusal);
      }
      const claim = await host.fetchApi(`/sessions/${subteamSessionId}/control`, role, { action: "claim" });
      assert.equal(claim.status, 409, `${role} control claim`);
      assert.deepEqual(claim.body, refusal);
      const native = await host.fetchApi(`/sessions/${subteamSessionId}/native`, role);
      assert.equal(native.status, 409, `${role} native attach`);
      assert.deepEqual(native.body, refusal);
      const opencode = await host.fetchApi(`/sessions/${subteamSessionId}/opencode/session/${randomUUID()}/prompt_async`, role, { parts: [] });
      assert.equal(opencode.status, 409, `${role} OpenCode attach`);
      assert.deepEqual(opencode.body, refusal);
    }
    const opencodeRead = await host.fetchApi(`/sessions/${subteamSessionId}/opencode/session/${randomUUID()}/event`, "owner", undefined, {}, "GET");
    assert.equal(opencodeRead.status, 409, "OpenCode attachment reads are also closed for managed sessions");
    assert.deepEqual(opencodeRead.body, refusal);
    const trailingClaim = await host.fetchApi(`/sessions/${subteamSessionId}/control/`, "owner", { action: "claim" });
    assert.equal(trailingClaim.status, 409, "a trailing slash cannot bypass the claim guard");
    assert.deepEqual(trailingClaim.body, refusal);

    providerPromptOpen = true;
    const scopedRequestOffset = workerRequests.length;
    const clientId = randomUUID();
    const promptClaim = await host.fetchApi(`/sessions/${subteamSessionId}/control`, "owner", { action: "claim" }, { "X-Infinite-Client": clientId });
    assert.equal(promptClaim.status, 200, "a managed session can claim control while a provider prompt is open");
    const promptLease = promptClaim.body.control.id as string;
    const promptHeaders = { "X-Infinite-Client": clientId, "X-Infinite-Control": promptLease };
    for (const [suffix, body] of [
      ["input", { requestId: randomUUID(), text: "provider prompt input" }],
      ["key", { requestId: randomUUID(), key: "enter" }],
      ["raw", { requestId: randomUUID(), text: "provider prompt bytes" }],
    ] as const) {
      const response = await host.fetchApi(`/sessions/${subteamSessionId}/${suffix}`, "owner", body, promptHeaders);
      assert.equal(response.status, 200, `${suffix} is available while the provider prompt is open`);
      assert.equal(response.body.state, "delivered");
    }
    const scopedWrites = workerRequests.slice(scopedRequestOffset).filter(({ sessionId, request }) => sessionId === subteamSessionId && ["input", "key", "raw"].includes(String(request.op)));
    assert.equal(scopedWrites.length, 3);
    for (const { request } of scopedWrites) {
      assert.equal(request.leaseId, promptLease, "prompt fallback preserves normal worker lease fencing");
      assert.ok(request.actor);
    }
    for (const { path, body, method } of [
      { path: `/sessions/${subteamSessionId}/stop`, body: { requestId: randomUUID() } },
      { path: `/sessions/${subteamSessionId}/resume`, body: { requestId: randomUUID() } },
      { path: `/sessions/${subteamSessionId}/native`, method: "GET" },
      { path: `/sessions/${subteamSessionId}/opencode/session/${randomUUID()}/prompt_async`, body: { parts: [] } },
    ]) {
      const response = await host.fetchApi(path, "owner", body, {}, method);
      assert.equal(response.status, 409, `${path} remains refused while a provider prompt is open`);
      assert.deepEqual(response.body, refusal);
    }
    providerPromptOpen = false;
    for (const [suffix, body] of [
      ["input", { requestId: randomUUID(), text: "after prompt closed" }],
      ["key", { requestId: randomUUID(), key: "enter" }],
      ["raw", { requestId: randomUUID(), text: "after prompt closed" }],
    ] as const) {
      const response = await host.fetchApi(`/sessions/${subteamSessionId}/${suffix}`, "owner", body, promptHeaders);
      assert.equal(response.status, 409, `${suffix} returns to the mission-managed refusal after the prompt closes`);
      assert.deepEqual(response.body, refusal);
    }

    providerPromptOpen = true;
    const wsUrl = new URL(`/api/sessions/${subteamSessionId}/native?client=${randomUUID()}&lease=${randomUUID()}`, host.origin);
    wsUrl.protocol = "ws:";
    const websocketResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${host.tokens.owner}` } });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("Native WebSocket did not refuse the managed session")); }, 3000);
      socket.on("error", error => { if (socket.readyState !== WebSocket.CLOSED) { clearTimeout(timer); reject(error); } });
      socket.once("open", () => { clearTimeout(timer); socket.terminate(); reject(new Error("Managed native WebSocket unexpectedly opened")); });
      socket.once("unexpected-response", (_request, response) => {
        let body = "";
        response.on("data", chunk => { body += chunk.toString(); });
        response.on("end", () => { clearTimeout(timer); socket.terminate(); resolve({ status: response.statusCode ?? 0, body }); });
      });
    });
    assert.equal(websocketResponse.status, 409);
    assert.deepEqual(JSON.parse(websocketResponse.body), refusal);
    providerPromptOpen = false;

    const closedClaimId = randomUUID(), openClaimId = randomUUID(), inputRequestId = randomUUID(), rawRequestId = randomUUID(), closedInputId = randomUUID();
    const terminalFrames = await new Promise<{ sawState: boolean; closedClaim: unknown; openClaim: any; input: any; raw: any; closedInput: unknown }>((resolve, reject) => {
      const url = new URL(`/api/sessions/${subteamSessionId}/terminal?after=0`, host.origin);
      url.protocol = "ws:";
      const socket = new WebSocket(url);
      let sawState = false;
      let sentClosedClaim = false, sentOpenClaim = false, sentPromptWrites = false, sentClosedInput = false;
      let openedLease: string | undefined;
      let closedClaim: unknown, openClaim: any, input: any, raw: any;
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("Managed terminal prompt-scoped frames did not complete")); }, 5000);
      socket.once("open", () => socket.send(JSON.stringify({ token: host.tokens.owner, clientId: randomUUID() })));
      socket.on("message", data => {
        const frame = JSON.parse(data.toString());
        sawState ||= Boolean(frame.state);
        if (frame.state && !sentClosedClaim) {
          sentClosedClaim = true;
          socket.send(JSON.stringify({ op: "control", requestId: closedClaimId, action: "claim" }));
        }
        if (frame.refusal?.requestId === closedClaimId && !sentOpenClaim) {
          closedClaim = frame.refusal;
          providerPromptOpen = true;
          sentOpenClaim = true;
          socket.send(JSON.stringify({ op: "control", requestId: openClaimId, action: "claim" }));
        }
        if (frame.requestId === openClaimId && frame.control && !sentPromptWrites) {
          openClaim = frame.control;
          openedLease = frame.control.id;
          sentPromptWrites = true;
          socket.send(JSON.stringify({ op: "input", requestId: inputRequestId, text: "prompt terminal input", submit: false, leaseId: openedLease }));
          socket.send(JSON.stringify({ op: "raw", requestId: rawRequestId, text: "prompt terminal bytes", leaseId: openedLease }));
        }
        if (frame.receipt?.requestId === inputRequestId) input = frame.receipt;
        if (frame.receipt?.requestId === rawRequestId) raw = frame.receipt;
        if (input && raw && !sentClosedInput) {
          providerPromptOpen = false;
          sentClosedInput = true;
          socket.send(JSON.stringify({ op: "input", requestId: closedInputId, text: "after prompt closed", submit: false, leaseId: openedLease }));
        }
        if (frame.refusal?.requestId === closedInputId) {
          clearTimeout(timer); socket.close(); resolve({ sawState, closedClaim, openClaim, input, raw, closedInput: frame.refusal });
        }
      });
      socket.on("error", error => { clearTimeout(timer); reject(error); });
      socket.once("close", () => { if (timer) { clearTimeout(timer); reject(new Error("Managed terminal closed before returning its refusal")); } });
    });
    assert.equal(terminalFrames.sawState, true, "managed terminal keeps its live read stream");
    assert.deepEqual(terminalFrames.closedClaim, { requestId: closedClaimId, code: "mission-managed", error: refusal.error });
    assert.equal(terminalFrames.openClaim.id, lease.id, "a terminal claim is accepted while the worker reports an open prompt");
    assert.equal(terminalFrames.input.state, "delivered", "terminal input is accepted for the open prompt");
    assert.equal(terminalFrames.raw.state, "delivered", "terminal raw input is accepted for the open prompt");
    assert.deepEqual(terminalFrames.closedInput, { requestId: closedInputId, code: "mission-managed", error: refusal.error }, "terminal writes are refused again after the prompt closes");

    const answer = await host.fetchApi(`/sessions/${coordinatorId}/answer`, "owner", { requestId: randomUUID(), promptId: 1, option: 0 });
    assert.equal(answer.status, 200, "provider prompts remain answerable through the owner API");
    assert.equal(answer.body.state, "delivered");
    const controllerAnswer = await host.fetchApi(`/sessions/${coordinatorId}/answer`, "controller", { requestId: randomUUID(), promptId: 1, option: 0 });
    assert.equal(controllerAnswer.status, 200, "the authorized controller can still answer provider prompts");
    const viewerAnswer = await host.fetchApi(`/sessions/${coordinatorId}/answer`, "viewer", { requestId: randomUUID(), promptId: 1, option: 0 });
    assert.equal(viewerAnswer.status, 403, "the managed-answer lease exception does not widen the role gate");
    const managedAnswers = workerRequests.filter(({ sessionId, request }) => sessionId === coordinatorId && request.op === "answer");
    assert.equal(managedAnswers.length, 2);
    for (const { request } of managedAnswers) {
      assert.equal(request.missionManaged, true, "the host marks mission answers for the worker's lease-free path");
      assert.equal("leaseId" in request, false, "mission answers do not depend on a refused input lease");
      assert.equal("actor" in request, false);
    }
    for (const action of ["renew", "release"] as const) {
      const response = await host.fetchApi(`/sessions/${subteamSessionId}/control`, "owner", { action, leaseId: lease.id });
      assert.equal(response.status, 200, `${action} can drop a stale managed-session lease`);
    }
    for (const sessionId of [standaloneSessionId, ordinarySessionId]) {
      const input = await host.fetchApi(`/sessions/${sessionId}/input`, "owner", { requestId: randomUUID(), text: "allowed input" });
      assert.equal(input.status, 200, `input to ${sessionId} remains available`);
    }
    const resized = await host.fetchApi(`/sessions/${coordinatorId}/resize`, "owner", { cols: 80, rows: 24 });
    assert.equal(resized.status, 200, "resize remains available");
    const events = await host.fetchApi(`/sessions/${subteamSessionId}/events`);
    assert.equal(events.status, 200, "read routes remain available");
  } finally {
    await host.stop();
    await Promise.all(workers.map(worker => new Promise<void>(resolve => worker.close(() => resolve()))));
  }
});

test("mission prompt keeps 21 open child questions under the byte limit without repeating their text", () => {
  const openChildDecisions: MissionOpenChildDecision[] = Array.from({ length: 21 }, (_, index) => ({
    subtaskId: `repo-${index % 7}-task-${Math.floor(index / 7)}`,
    teamId: `team-${index}`,
    decisionId: `decision-${index}`,
    question: `Question ${index}: ${"q".repeat(2000 - `Question ${index}: `.length)}`,
    options: [],
  }));
  const messages: MissionMessage[] = openChildDecisions.map(decision => ({
    type: "child-decision", subtaskId: decision.subtaskId, teamId: decision.teamId,
    decisionId: decision.decisionId, question: decision.question, options: decision.options,
  }));
  const mission = {
    id: "mission", groupName: "Example", status: "working", deadlineAt: "", maxSubtasks: 21,
    subtasks: [], decisions: [], dispatchSummary: "", steering: [], objective: "Coordinate repository work.",
  } as unknown as Mission;
  const repos = Array.from({ length: 7 }, (_, index) => ({ projectId: `repo-${index}`, name: `Repo ${index}`, path: `/repo/${index}`, teamReady: true }));
  const result = missionPromptWithMessageCount(mission, repos, messages, 2, "claude", lineup.coordinator,
    { openChildDecisions, waiting: 0 });

  assert.ok(Buffer.byteLength(result.prompt) < 80 * 1024);
  assert.equal(result.includedMessageCount, messages.length);
  assert.equal(result.prompt.match(/Question 0:/g)?.length, 1, "The question text appears only in durable open-decision state");
  assert.match(result.prompt, /See openChildDecisions for decision decision-0 in subtask repo-0-task-0/);

  const oversizedMessages: MissionMessage[] = [...messages, ...Array.from({ length: 20 }, (_, index) => ({
    type: "owner-direction" as const, text: `Direction ${index}: ${"d".repeat(3000)}`,
  }))];
  const bounded = missionPromptWithMessageCount(mission, repos, oversizedMessages, 2, "claude", lineup.coordinator,
    { openChildDecisions, waiting: 0 });
  assert.ok(Buffer.byteLength(bounded.prompt) < 80 * 1024);
  assert.ok(bounded.includedMessageCount < oversizedMessages.length, "Messages that exceed the byte budget remain for a later attempt");
  assert.match(bounded.prompt, new RegExp(`${oversizedMessages.length - bounded.includedMessageCount} more messages are waiting`));
});

test("a mission dispatches dependent subteams across two repositories, routes their questions, and reports only after every subtask finishes", { timeout: 240000 }, async () => {
  const h = harness();
  try {
    let { missions, teams } = h.open();
    const request = h.create();
    await assert.rejects(missions.create({ ...request, groupId: "unknown" }), (error: TeamError) => error.code === "project-group-not-found");
    const created = await missions.create(request);
    assert.equal(created.status, "planning");
    assert.deepEqual(created.repoProjectIds, ["api", "web"]);
    assert.equal(created.groupName, "Shop");
    assert.equal(created.title, "Add an endpoint to the API and call it from the web client");
    assert.equal((await missions.create(request)).id, created.id, "A replayed create returns the same mission");
    await assert.rejects(missions.create({ ...request, objective: "A different mission" }), (error: TeamError) => error.code === "request-conflict");
    assert.equal(missions.list().length, 1);

    // Restart while the first coordinator attempt is running: the same session continues.
    await waitFor(async () => h.coordinatorReceipts().length, count => count === 1, 30000);
    const first = missions.get(created.id).coordinator!;
    assert.equal(first.status, "running");
    assert.ok(realpathSync(h.coordinatorReceipts()[0].cwd).startsWith(join(h.root, "teams", "missions")), "The coordinator runs in a mission folder under the team workspace root");
    h.shut(); ({ missions, teams } = h.open());
    h.release("release-dispatch");
    const asked = await until(() => missions.get(created.id), mission => mission.status === "needs-input");
    assert.equal(h.coordinatorReceipts().filter(receipt => receipt.memberId === first.memberId).length, 1);
    assert.deepEqual(asked.subtasks.map(subtask => [subtask.id, subtask.repoProjectId, subtask.size, subtask.parallelism, subtask.status]),
      [["api-change", "api", "solo", 1, "running"], ["web-change", "web", "team", 2, "queued"]]);
    const apiTeam = teams.get(asked.subtasks[0].teamId!);
    assert.equal(apiTeam.missionId, created.id);
    assert.equal(apiTeam.parallelism, 1, "A solo subtask runs with parallelism 1");
    assert.equal(apiTeam.status, "needs-input");
    const decision = asked.decisions[0];
    assert.equal(decision.childDecisionId, apiTeam.decisions[0].id);
    assert.equal(decision.subtaskId, "api-change");
    assert.match(decision.question, /Which response format/);
    assert.equal(teams.list().length, 1, "The dependent web subtask waits for the API subtask");

    // Restart while the owner question is open: nothing is duplicated, and the answer reaches the subteam.
    h.shut(); ({ missions, teams } = h.open());
    const answer = { requestId: randomUUID(), revision: asked.revision, text: "JSON" };
    const answered = await missions.answer(created.id, decision.id, answer);
    assert.equal(answered.decisions[0].answeredBy, "owner");
    assert.equal(answered.status, "working");
    assert.equal((await missions.answer(created.id, decision.id, answer)).revision, answered.revision, "A replayed answer is not applied twice");
    await waitFor(async () => teams.get(apiTeam.id).decisions[0].answer, value => value === "JSON", 30000);

    // The API subteam finishes; the coordinator's early result is refused while the web subtask runs.
    const refused = await until(() => missions.get(created.id), mission => mission.events.some(event => /result report was refused/.test(event.text)), 120000);
    assert.equal(refused.subtasks[0].status, "done");
    assert.equal(refused.subtasks[0].teamStatus, "ready-for-review");
    assert.equal(refused.subtasks[1].status, "running");
    assert.notEqual(refused.status, "ready-for-review");
    const webTeam = teams.get(refused.subtasks[1].teamId!);
    assert.equal(webTeam.projectId, "web");
    assert.equal(webTeam.parallelism, 2);
    h.release("release-web-question");

    const ready = await until(() => missions.get(created.id), mission => mission.status === "ready-for-review", 120000);
    assert.equal(ready.subtasks.every(subtask => subtask.status === "done"), true);
    assert.match(ready.result!.summary, /reviewed in their own repository/);
    assert.equal(ready.coordinator?.status, "stopped");
    assert.equal(ready.decisions.length, 1, "The coordinator answered the web question itself instead of asking the owner");
    const web = teams.get(webTeam.id);
    assert.equal(web.decisions[0].answer, "Use the primary button; the objective settles it.");
    assert.ok(ready.events.some(event => /answered by the coordinator/.test(event.text)));
    assert.equal(teams.list().length, 2);
    for (const team of teams.list()) {
      assert.equal(team.review?.verdict, "approved");
      assert.ok(team.checks.length > 0 && team.checks.every(check => check.status === "passed"));
    }
    assert.equal(git(h.api, "status", "--porcelain"), "", "Subteams work in isolated copies; the source repositories are unchanged");
    assert.equal(existsSync(join(h.web, "web.txt")), false);
    assert.equal(h.coordinatorReceipts().length, 5, "Dispatch, escalate, early result, answer, and final result each used one attempt");
  } finally { await h.close(); }
});

test("standalone team creation is reserved only while a mission subteam holds that repository", { timeout: 180000 }, async () => {
  const h = harness();
  try {
    const { missions, teams } = h.open();
    const mission = await missions.create(h.create());
    await waitFor(async () => h.coordinatorReceipts().length, count => count === 1, 30000);
    h.release("release-dispatch");
    const waiting = await until(() => missions.get(mission.id), value => value.status === "needs-input", 120000);
    const api = waiting.subtasks.find(subtask => subtask.id === "api-change")!;
    assert.ok(api.teamId);

    const rejected = standaloneRequest("api");
    await assert.rejects(teams.create(rejected), (error: TeamError) =>
      error.status === 409 && error.code === "mission-repository-reserved" && error.message.includes(mission.id));

    const decision = waiting.decisions[0]!;
    await missions.answer(mission.id, decision.id, {
      requestId: randomUUID(), revision: waiting.revision, text: "JSON",
    });
    await waitFor(async () => teams.get(api.teamId!).status, status => status === "ready-for-review", 120000);

    const started = await teams.create(rejected);
    assert.equal(started.id, rejected.requestId);
    assert.equal(started.missionId, undefined, "The new run is standalone after the mission subteam finishes");
  } finally { await h.close(); }
});

test("standalone team creation is reserved while a mission launch is pending", { timeout: 120000 }, async () => {
  const h = harness();
  try {
    const { missions, teams } = h.open();
    const createForMission = teams.createForMission.bind(teams);
    let launchRequested = false;
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
    teams.createForMission = async (request, missionId, pinnedLineup, options) => {
      launchRequested = true;
      await launchGate;
      return createForMission(request, missionId, pinnedLineup, options);
    };

    const mission = await missions.create(h.create());
    await waitFor(async () => h.coordinatorReceipts().length, count => count === 1, 30000);
    h.release("release-dispatch");
    await waitFor(async () => launchRequested, value => value, 30000);

    await assert.rejects(teams.create(standaloneRequest("api")), (error: TeamError) =>
      error.status === 409 && error.code === "mission-repository-reserved" && error.message.includes(mission.id));

    releaseLaunch();
    const launched = await until(() => missions.get(mission.id), value => Boolean(value.subtasks.find(subtask => subtask.id === "api-change")?.teamId), 30000);
    assert.ok(launched.subtasks.find(subtask => subtask.id === "api-change")?.teamId);
  } finally { await h.close(); }
});

test("a mission launch rechecks an active standalone run and records the launch reason", { timeout: 180000 }, async () => {
  const h = harness();
  try {
    const { missions, teams } = h.open();
    const standalone = await teams.create({ ...standaloneRequest("api"), objective: "HOLD-SUBTEAM while the mission attempts to launch" });
    await waitFor(async () => teams.get(standalone.id).members.some(member => member.status === "running"), value => value, 30000);

    // Let MissionService's scheduling check see an available repository once. The real
    // createForMission admission check must still observe the active standalone run.
    const activeForProject = teams.activeForProject.bind(teams);
    let skipSchedulerCheck = false;
    teams.activeForProject = projectId => {
      if (skipSchedulerCheck && projectId === "api") { skipSchedulerCheck = false; return false; }
      return activeForProject(projectId);
    };

    const mission = await missions.create(h.create());
    await waitFor(async () => h.coordinatorReceipts().length, count => count === 1, 30000);
    skipSchedulerCheck = true;
    h.release("release-dispatch");
    const blocked = await until(() => missions.get(mission.id), value => value.subtasks.some(subtask => subtask.status === "blocked"), 120000);
    const api = blocked.subtasks.find(subtask => subtask.id === "api-change")!;
    assert.equal(api.teamId, undefined);
    assert.ok(blocked.events.some(event => event.text.includes("Subtask api-change could not start:") && /active team run already holds repository api/.test(event.text)));
  } finally { await h.close(); }
});

test("a mission refuses invalid dispatches, and pausing and cancelling reach its coordinator and active subteam", { timeout: 120000 }, async () => {
  const h = harness();
  try {
    const { missions, teams } = h.open();
    h.release("release-dispatch");
    const created = await missions.create(h.create("HOLD-SUBTEAM so the subteam stays active; INVALID-DISPATCH first"));
    const running = await until(() => missions.get(created.id), mission => mission.subtasks[0]?.status === "running" && mission.coordinator?.status === "waiting");
    assert.deepEqual(running.events.filter(event => /refused/.test(event.text)).map(event => event.text), [
      "The coordinator's dispatch report was refused: The subtask dependencies form a cycle.",
      "The coordinator's dispatch report was refused: Repository docs is not part of this mission's project.",
    ]);
    assert.deepEqual(running.subtasks.map(subtask => subtask.id), ["held"], "Refused dispatches add no subtasks");
    const teamId = running.subtasks[0].teamId!;
    await waitFor(async () => teams.get(teamId).members.some(member => member.status === "running"), value => value, 30000);
    await assert.rejects(missions.resume(created.id, { requestId: randomUUID(), revision: running.revision }), (error: TeamError) => error.code === "mission-not-paused");
    const paused = await missions.pause(created.id, { requestId: randomUUID(), revision: running.revision });
    assert.equal(paused.status, "paused");
    await waitFor(async () => teams.get(teamId).status, status => status === "paused", 30000);
    const resumed = await missions.resume(created.id, { requestId: randomUUID(), revision: paused.revision });
    assert.equal(resumed.status, "working");
    await waitFor(async () => teams.get(teamId).status, status => status !== "paused", 30000);
    // The resumed coordinator attempt holds; cancel must stop it as well as the subteam.
    await until(() => missions.get(created.id), mission => mission.coordinator?.status === "running");
    const cancelled = await missions.cancel(created.id, { requestId: randomUUID(), revision: resumed.revision });
    assert.equal(cancelled.status, "cancelled");
    await waitFor(async () => teams.get(teamId).status, status => status === "cancelled", 30000);
    const ended = await until(() => missions.get(created.id), mission => mission.coordinator?.status === "stopped" && mission.subtasks[0].status === "cancelled");
    assert.equal(ended.subtasks[0].teamStatus, "cancelled");
    assert.deepEqual(missionBoard([ended], [], [], []).items[0].subtasks, { total: 0, running: 0, done: 0 }, "Cancelled subtasks do not count toward the board's done/total");
    await assert.rejects(missions.steer(created.id, { requestId: randomUUID(), revision: ended.revision, text: "More" }), (error: TeamError) => error.code === "mission-not-running");
  } finally { await h.close(); }
});

test("a mission coordinator reports through its own MCP tool and envelope, separate from team reports", { timeout: 20000 }, async () => {
  const missionId = randomUUID(), memberId = randomUUID();
  const env = { INFINITE_HOOK_URL: "http://127.0.0.1:9/hook", INFINITE_HOOK_TOKEN: "capability",
    INFINITE_TEAM_ASSIGNMENT: JSON.stringify({ runId: missionId, memberId, revision: 3, role: "mission-coordinator" }),
    INFINITE_MISSION_ASSIGNMENT: JSON.stringify({ missionId, memberId, revision: 3 }) };
  const envelope = createMissionReportEnvelope({ kind: "result", summary: "Every subtask finished" }, env);
  assert.deepEqual({ ...envelope, requestId: undefined }, { requestId: undefined, missionId, memberId, revision: 3, report: { kind: "result", summary: "Every subtask finished" } });
  assert.equal(createMissionReportEnvelope({ kind: "result", summary: "Every subtask finished" }, env).requestId, envelope.requestId, "A retried report keeps its identity");
  assert.throws(() => createMissionReportEnvelope({ kind: "review", verdict: "approved", summary: "A team report" }, env));
  assert.throws(() => createMissionReportEnvelope({ ...envelope, missionId: randomUUID() }, env), /does not match/);
  assert.throws(() => createMissionReportEnvelope({ kind: "result", summary: "No assignment" }, { ...env, INFINITE_MISSION_ASSIGNMENT: "" }), /unavailable/);

  const tools = async (extra: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("packages/host/src/team-mcp.ts")], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env, ...extra } });
    const lines = createInterface({ input: child.stdout });
    const replies: any[] = [];
    lines.on("line", line => replies.push(JSON.parse(line)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await waitFor(async () => replies.length, count => count === 2);
    child.kill("SIGKILL"); lines.close();
    return replies[1].result.tools.map((tool: { name: string }) => tool.name);
  };
  assert.deepEqual(await tools({}), ["mission_report"]);
  // Team members' launch config expands an unset mission assignment to an empty value.
  assert.deepEqual(await tools({ INFINITE_MISSION_ASSIGNMENT: "", INFINITE_TEAM_ASSIGNMENT: JSON.stringify({ runId: missionId, memberId, revision: 3, role: "implementer" }) }), ["report"]);
});

type FakeRun = { id: string; projectId: string; missionId: string; status: TeamView["status"]; revision: number; updatedAt: string;
  decisions: { id: string; memberId: string; revision: number; question: string; options: string[]; createdAt: string; answer?: string }[] };

/**
 * The real mission service over scripted coordinator sessions and subteams: each coordinator attempt
 * reports what the test tells it to, and each subteam is in whatever state the test sets.
 */
function scripted() {
  const root = realpathSync(mkdtempSync("/tmp/inf-mission-script-"));
  const repo = (name: string) => { const path = join(root, name); mkdirSync(path); return path; };
  const checks = [{ command: process.execPath, args: ["-e", "0"] }];
  const config: Config = { port: 0, origin: "http://127.0.0.1", keyFile: join(root, "key"), stateDir: join(root, "state"), runDir: join(root, "run"), tokens: [],
    environment: "local", enableDemo: false, maxSessions: 24, agents: { claude: { command: process.execPath, args: [] } },
    projects: [{ id: "api", name: "API", path: repo("api"), team: { checks } }, { id: "web", name: "Web", path: repo("web"), team: { checks } }],
    teams: { workspaceDir: join(root, "teams"), lineup } };
  const attempts: { sessionId: string; assignment: TeamAssignment; prompt: string }[] = [];
  const reports = new Map<string, MissionReport>();
  // Each coordinator session's journaled signals and the attention the real reducer derives from them.
  const signals = new Map<string, SignalEvent[]>(), attention = new Map<string, Attention>();
  const held = new Set<string>(), stops: string[] = [];
  const signal = (sessionId: string, data: Signal, at = new Date()) => {
    const journal = signals.get(sessionId)!;
    const event: SignalEvent = { seq: journal.length + 1, at: at.toISOString(), type: "signal", data: { ...data, source: "hook", provider: "claude" } };
    journal.push(event);
    attention.set(sessionId, applySignal(attention.get(sessionId)!, event));
  };
  const manager = {
    async createTeamSession(request: { requestId: string; prompt: string }, assignment: TeamAssignment) {
      if (!attempts.some(item => item.sessionId === request.requestId)) {
        attempts.push({ sessionId: request.requestId, assignment, prompt: request.prompt });
        signals.set(request.requestId, []); attention.set(request.requestId, initialAttention(new Date().toISOString(), true));
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
    async state(sessionId: string) { return { status: "running", attention: attention.get(sessionId) }; },
    async stopTeamSession(sessionId: string) { stops.push(sessionId); return { status: held.has(sessionId) ? "running" : "exited" }; },
  };
  const runs = new Map<string, FakeRun>(), standalone = new Set<string>(), failing = new Set<string>();
  let resumeBusy = false;
  const created: { request: CreateTeam; options?: { baseRunId?: string } }[] = [];
  const answers: { teamId: string; decisionId: string; text: string; by?: string }[] = [];
  const steers: { teamId: string; text: string }[] = [];
  const steerReceipts = new Map<string, string>();
  let steerLimit: boolean | Set<string> = false, steerBusy = false, loseSteerReply = false;
  const view = (run: FakeRun) => ({ ...structuredClone(run), title: run.id, tasks: [], usage: emptyRollup() }) as unknown as TeamView;
  const run = (id: string) => { const value = runs.get(id); if (!value) throw new TeamError(404, "team-not-found", "This team does not exist."); return value; };
  const set = (id: string, patch: Partial<FakeRun>) => Object.assign(run(id), patch, { updatedAt: new Date().toISOString() });
  const teams = {
    useMissionReservations(_lookup: (projectId: string, exceptMissionId?: string) => string | undefined) {},
    isActiveRun(id: string) {
      const current = runs.get(id);
      return Boolean(current && !["cancelled", "ready-for-review", "merged", "no-change"].includes(current.status));
    },
    async createForMission(request: CreateTeam, missionId: string, _lineup: TeamLineup, options?: { baseRunId?: string }) {
      if (runs.has(request.requestId)) return view(run(request.requestId));
      if (failing.has(request.projectId)) throw new TeamError(409, "team-start-failed", "The repository could not start a team run.");
      created.push({ request, options });
      runs.set(request.requestId, { id: request.requestId, projectId: request.projectId, missionId, status: "implementing", revision: 1, decisions: [], updatedAt: new Date().toISOString() });
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
    activeForProject: (projectId: string) => standalone.has(projectId) ||
      [...runs.values()].some(item => item.projectId === projectId && !["cancelled", "ready-for-review", "merged", "no-change"].includes(item.status)),
  };
  let removed = false;
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = { get: id => {
    if (id !== "shop" || removed) throw new TeamError(404, "project-group-not-found", "This project does not exist.");
    return { id, name: "Shop", implicit: false, revision: 1, createdAt: at, updatedAt: at,
      repos: [{ projectId: "api", name: "API", path: config.projects[0].path }, { projectId: "web", name: "Web", path: config.projects[1].path }] };
  } };
  const missions = new MissionService(config, randomBytes(32), manager as unknown as Manager, teams as unknown as TeamService, groups);
  missions.start();
  const attempt = async (n: number) => (await waitFor(async () => attempts[n - 1], value => Boolean(value), 20000))!;
  const parse = (prompt: string, label: string) => JSON.parse(prompt.split("\n").find(line => line.startsWith(label))!.slice(label.length));
  return {
    missions, runs, standalone, failing, created, answers, steers, set,
    /** Later steers of these subteams, or of every subteam, are refused at the steering limit. */
    limitSteering: (teamIds?: string[]) => { steerLimit = teamIds ? new Set(teamIds) : true; },
    /** Subteam steers are refused as busy until released. */
    holdSteers: (held: boolean) => { steerBusy = held; },
    /** The next steer is recorded by the subteam, but the mission sees a retryable error instead of its reply. */
    loseNextSteerReply: () => { loseSteerReply = true; },
    remove: () => { removed = true; },
    attempts: () => attempts.length,
    attempt,
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
const plan = (id: string, repoProjectId: string, dependsOn: string[] = []) =>
  ({ id, repoProjectId, title: `Subtask ${id}`, objective: `Do ${id}`, size: "solo" as const, parallelism: 1, dependsOn });
const teamOf = (mission: Mission, subtaskId: string) => mission.subtasks.find(item => item.id === subtaskId)?.teamId;

test("a coordinator result that predates owner direction is not applied, and a create retry outlives its group", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const request = { requestId: randomUUID(), groupId: "shop", objective: "Change the API", maxSubtasks: 8, maxMinutes: 30 };
    const { id } = await h.missions.create(request);
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const teamId = (await until(() => h.get(id), mission => Boolean(teamOf(mission, "a")))).subtasks[0].teamId!;

    // A subteam question the coordinator answers itself is recorded as the coordinator's answer in the subteam.
    const decisionId = randomUUID();
    h.set(teamId, { status: "needs-input", decisions: [{ id: decisionId, memberId: randomUUID(), revision: 1, question: "Which format?", options: [], createdAt: new Date().toISOString() }] });
    assert.equal((await h.messages(2)).find((message: { type: string }) => message.type === "child-decision").decisionId, decisionId);
    await h.report(2, { kind: "answer-child", subtaskId: "a", decisionId, text: "JSON" });
    await waitFor(async () => h.answers.length, count => count === 1, 20000);
    assert.deepEqual(h.answers[0], { teamId, decisionId, text: "JSON", by: "coordinator" });

    // The owner steers while the attempt that will report a result is already running.
    h.set(teamId, { status: "ready-for-review" });
    await h.attempt(3);
    const steered = await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Also update the changelog" });
    await h.report(3, { kind: "result", summary: "Done before reading the direction" });
    const fourth = await h.messages(4);
    assert.ok(fourth.some((message: { type: string; text?: string }) => message.type === "owner-direction" && message.text === "Also update the changelog"), "The direction is not dropped");
    assert.ok(fourth.some((message: { type: string; kind?: string }) => message.type === "refused" && message.kind === "result"));
    const pending = h.get(id);
    assert.notEqual(pending.status, "ready-for-review");
    assert.equal(pending.result, undefined);
    assert.ok(pending.events.some(event => /result was not applied: the owner sent direction/.test(event.text)));
    assert.ok(pending.revision >= steered.revision);
    await h.report(4, { kind: "result", summary: "Done, and the changelog subtask is not needed" });
    assert.equal((await until(() => h.get(id), mission => mission.status === "ready-for-review", 20000)).result?.summary, "Done, and the changelog subtask is not needed");

    // The retry returns the recorded mission even though its group no longer exists.
    h.remove();
    assert.equal((await h.missions.create(request)).id, id);
    await assert.rejects(h.missions.create({ ...request, requestId: randomUUID() }), (error: TeamError) => error.code === "project-group-not-found");
  } finally { h.close(); }
});

test("a result waits until blocked and stranded subtasks are cancelled, and each local cancel wakes the coordinator", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    h.failing.add("web");
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "API, web, then API again", subtasks: [plan("a", "api"), plan("b", "web"), plan("c", "api", ["b"])] });
    const started = await until(() => h.get(id), mission => Boolean(teamOf(mission, "a")) && mission.subtasks[1].status === "blocked");
    assert.equal((await h.messages(2)).find((message: { subtaskId?: string }) => message.subtaskId === "b").status, "blocked");
    h.set(teamOf(started, "a")!, { status: "ready-for-review" });
    await until(() => h.get(id), mission => mission.subtasks[0].status === "done");
    await h.report(2, { kind: "result", summary: "Reporting with a blocked subtask" });
    const refusal = (await h.messages(3)).find((message: { type: string }) => message.type === "refused");
    assert.equal(refusal.reason, "Subtasks b, c did not finish. Cancel each with cancel-subtask, dispatch a replacement, or report blocked.");
    assert.notEqual(h.get(id).status, "ready-for-review");

    // c never launched; cancelling it locally must still start the next attempt.
    await h.report(3, { kind: "cancel-subtask", subtaskId: "c", reason: "Its dependency is blocked" });
    assert.deepEqual((await h.messages(4)).filter((message: { type: string }) => message.type === "subtask-finished"),
      [{ type: "subtask-finished", subtaskId: "c", status: "cancelled", reason: "Cancelled before its subteam started." }]);
    await h.report(4, { kind: "cancel-subtask", subtaskId: "b", reason: "The web repository cannot start a run" });
    assert.equal((await h.messages(5)).find((message: { subtaskId?: string }) => message.subtaskId === "b").status, "cancelled");
    await h.report(5, { kind: "result", summary: "The API change is ready; the web change was cancelled" });
    const ready = await until(() => h.get(id), mission => mission.status === "ready-for-review", 20000);
    assert.deepEqual(ready.subtasks.map(subtask => subtask.status), ["done", "cancelled", "cancelled"]);
  } finally { h.close(); }
});

test("each subteam is titled by its subtask first, so a long mission title cannot make siblings identical", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const objective = "Add a /health endpoint to the api returning {ok:true} with a test, and make web call it and print the result";
    const { id } = await h.create(objective);
    await h.report(1, { kind: "dispatch", summary: "One change per repository", subtasks: [plan("api-health", "api"), plan("web-health", "web")] });
    await until(() => h.get(id), mission => Boolean(teamOf(mission, "api-health") && teamOf(mission, "web-health")));
    const titles = h.created.map(item => item.request.title).sort();
    assert.deepEqual(titles.map(title => title.split(" · ")[0]), ["Subtask api-health", "Subtask web-health"]);
    assert.ok(titles.every(title => title.length <= 100 && title.includes("Add a /health endpoint")));
  } finally { h.close(); }
});

test("a coordinator with nothing to decide waits without opening an owner question, but cannot wait when nothing would wake it", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const teamId = teamOf(await until(() => h.get(id), mission => Boolean(teamOf(mission, "a"))), "a")!;
    // Owner direction wakes the coordinator while the subteam is still running; there is nothing to decide.
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Keep the change small" });
    await h.report(2, { kind: "wait", summary: "The API subteam is still working; the direction is already in its objective" });
    const waiting = await until(() => h.get(id), mission => mission.events.some(event => /waiting for subteam progress/.test(event.text)));
    assert.deepEqual(waiting.decisions, [], "Waiting opens no owner decision");
    assert.equal(waiting.status, "working");
    await new Promise(done => setTimeout(done, 1500));
    assert.equal(h.attempts(), 2, "A wait starts no new attempt by itself");

    h.set(teamId, { status: "ready-for-review" });
    await h.report(3, { kind: "wait", summary: "Nothing to do" });
    const refusal = (await h.messages(4)).find((message: { type: string }) => message.type === "refused");
    assert.equal(refusal.kind, "wait");
    assert.match(refusal.reason, /no later attempt would start/);
    await h.report(4, { kind: "result", summary: "The API change is ready" });
    await until(() => h.get(id), mission => mission.status === "ready-for-review", 20000);
  } finally { h.close(); }
});

test("a coordinator that ends its turn without a report is replaced, so the last subtask's finish still reaches a new attempt", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One change per repository", subtasks: [plan("a", "api"), plan("b", "web")] });
    const started = await until(() => h.get(id), mission => Boolean(teamOf(mission, "a") && teamOf(mission, "b")));
    // A waiting coordinator is woken by owner input.
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Keep both changes small" });
    await h.report(2, { kind: "wait", summary: "Both subteams are working" });
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Mention the endpoint in the summary" });
    assert.ok((await h.messages(3)).some((message: { type: string }) => message.type === "owner-direction"));
    // The woken attempt ends its turn without reporting, while the last subtasks finish.
    h.set(teamOf(started, "a")!, { status: "ready-for-review" });
    h.set(teamOf(started, "b")!, { status: "ready-for-review" });
    await h.endTurn(3);
    const fourth = await h.messages(4);
    assert.ok(fourth.some((message: { type: string; kind?: string }) => message.type === "refused" && message.kind === "missing"), "The next attempt is told the previous one filed no report");
    assert.deepEqual(fourth.filter((message: { type: string }) => message.type === "subtask-finished").map((message: { subtaskId: string }) => message.subtaskId).sort(), ["a", "b"]);
    assert.ok(h.get(id).events.some(event => /missing report was refused: Your previous attempt ended without a mission report/.test(event.text)));
    await h.report(4, { kind: "result", summary: "Both repositories are ready; the endpoint is GET /health" });
    await until(() => h.get(id), mission => mission.status === "ready-for-review", 20000);
  } finally { h.close(); }
});

test("a subtask with two same-repository predecessors starts from the later run's head", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "Layered changes", subtasks: [plan("a", "api"), plan("a2", "api"), plan("w", "web", ["a"]), plan("b", "api", ["w", "a", "a2"])] });
    const first = await until(() => h.get(id), mission => Boolean(teamOf(mission, "a")));
    assert.equal(h.created[0].options, undefined, "The first subtask starts from the repository");
    assert.deepEqual(first.subtasks.find(subtask => subtask.id === "a2")?.dependsOn, ["a"]);
    assert.ok(first.events.some(event => /added same-repository dependencies/i.test(event.text) && event.text.includes("a2 depends on a")));
    h.set(teamOf(first, "a")!, { status: "ready-for-review" });
    const second = await until(() => h.get(id), mission => Boolean(teamOf(mission, "a2") && teamOf(mission, "w")));
    const options = (subtaskId: string) => h.created.find(item => item.request.requestId === teamOf(h.get(id), subtaskId))!.options;
    assert.deepEqual(options("a2"), { baseRunId: teamOf(second, "a") });
    assert.equal(options("w"), undefined, "Work in another repository is not a base");
    h.set(teamOf(second, "w")!, { status: "ready-for-review" });
    h.set(teamOf(second, "a2")!, { status: "ready-for-review" });
    await until(() => h.get(id), mission => Boolean(teamOf(mission, "b")));
    assert.deepEqual(options("b"), { baseRunId: teamOf(second, "a2") }, "b builds on a2, which already includes a");
    assert.match(h.created.at(-1)!.request.objective, /starts from the finished work of subtask a2/);
  } finally { h.close(); }
});

test("a no-change predecessor keeps the latest reviewed same-repository run as the base", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "Review an API change, then continue", subtasks: [
      plan("reviewed", "api"), plan("no-change", "api"), plan("after", "api"),
    ] });
    const first = await until(() => h.get(id), mission => Boolean(teamOf(mission, "reviewed")));
    const reviewedTeamId = teamOf(first, "reviewed")!;
    h.set(reviewedTeamId, { status: "ready-for-review" });

    const second = await until(() => h.get(id), mission => Boolean(teamOf(mission, "no-change")));
    const noChangeTeamId = teamOf(second, "no-change")!;
    h.set(noChangeTeamId, { status: "no-change" });

    const third = await until(() => h.get(id), mission => Boolean(teamOf(mission, "after")));
    const afterTeamId = teamOf(third, "after")!;
    assert.deepEqual(h.created.find(item => item.request.requestId === afterTeamId)?.options, { baseRunId: reviewedTeamId });
  } finally { h.close(); }
});

test("same-repository subtasks dispatched later are chained and start from the earlier subtask's head", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "Start the API change", subtasks: [plan("first", "api")] });
    const first = await until(() => h.get(id), mission => Boolean(teamOf(mission, "first")));
    const firstTeamId = teamOf(first, "first")!;

    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Add another API change after the first." });
    await h.attempt(2);
    await h.report(2, { kind: "dispatch", summary: "Follow up in the same repository", subtasks: [plan("second", "api"), plan("third", "api")] });
    const chained = await until(() => h.get(id), mission => Boolean(mission.subtasks.find(subtask => subtask.id === "third")));
    const second = chained.subtasks.find(subtask => subtask.id === "second")!;
    const third = chained.subtasks.find(subtask => subtask.id === "third")!;
    assert.deepEqual(second.dependsOn, ["first"]);
    assert.equal(second.status, "queued");
    assert.deepEqual(third.dependsOn, ["second"], "The second plan in this dispatch follows the first same-repository plan");
    assert.equal(third.status, "queued");
    assert.ok(chained.events.some(event => /added same-repository dependencies/i.test(event.text) &&
      event.text.includes("second depends on first") && event.text.includes("third depends on second")));

    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Continue with the accepted dependency chain." });
    const state = await h.state(3);
    assert.deepEqual(state.subtasks.find((subtask: { id: string }) => subtask.id === "second")?.dependsOn, ["first"]);
    assert.deepEqual(state.subtasks.find((subtask: { id: string }) => subtask.id === "third")?.dependsOn, ["second"]);

    h.set(firstTeamId, { status: "ready-for-review" });
    const launched = await until(() => h.get(id), mission => Boolean(teamOf(mission, "second")));
    const secondTeamId = teamOf(launched, "second")!;
    assert.deepEqual(h.created.find(item => item.request.requestId === secondTeamId)?.options, { baseRunId: firstTeamId });
    h.set(secondTeamId, { status: "ready-for-review" });
    const thirdLaunched = await until(() => h.get(id), mission => Boolean(teamOf(mission, "third")));
    const thirdTeamId = teamOf(thirdLaunched, "third")!;
    assert.deepEqual(h.created.find(item => item.request.requestId === thirdTeamId)?.options, { baseRunId: secondTeamId });
  } finally { h.close(); }
});

test("a coordinator cannot wait past a subteam decision it has not handled, or behind a repository only a paused run holds", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    h.runs.set("paused-web", { id: "paused-web", projectId: "web", missionId: "", status: "paused", revision: 1, decisions: [], updatedAt: new Date().toISOString() });
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "The API, then the web client", subtasks: [plan("a", "api"), plan("b", "web", ["a"])] });
    const teamId = teamOf(await until(() => h.get(id), mission => Boolean(teamOf(mission, "a"))), "a")!;
    const decisionId = randomUUID();
    h.set(teamId, { status: "needs-input", decisions: [{ id: decisionId, memberId: randomUUID(), revision: 1, question: "Which format?", options: [], createdAt: new Date().toISOString() }] });
    assert.ok((await h.messages(2)).some((message: { type: string }) => message.type === "child-decision"));
    // The decision message woke this attempt once; waiting past it would leave the subteam and the mission waiting on each other.
    await h.report(2, { kind: "wait", summary: "The API subteam is working" });
    const open = (await h.messages(3)).find((message: { type: string }) => message.type === "refused");
    assert.equal(open.kind, "wait");
    assert.equal(open.reason, `Decision ${decisionId} of subtask a is still open. Answer it with answer-child, ask the owner with question, or cancel the subtask.`);
    await h.report(3, { kind: "answer-child", subtaskId: "a", decisionId, text: "JSON" });
    await waitFor(async () => h.answers.length, count => count === 1, 20000);

    // Only a paused run outside the mission holds the web repository, so subtask b will not start by itself.
    h.set(teamId, { status: "ready-for-review" });
    const fourth = await h.messages(4);
    assert.ok(fourth.some((message: { type: string; subtaskId?: string }) => message.type === "subtask-finished" && message.subtaskId === "a"));
    assert.ok(fourth.some((message: { type: string; teamId?: string }) => message.type === "repository-held" && message.teamId === "paused-web"));
    assert.equal(h.get(id).subtasks[1].status, "queued");
    await h.report(4, { kind: "wait", summary: "Subtask b is queued" });
    const held = (await h.messages(5)).find((message: { type: string }) => message.type === "refused");
    assert.equal(held.kind, "wait");
    assert.match(held.reason, /no later attempt would start/);
  } finally { h.close(); }
});

test("a coordinator still working after an earlier turn-end is not stopped when its screen goes quiet", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.continueAfterTurnEnd(1);
    // The real reducer keeps the earlier turn-end, so a quiet screen reads the continuing turn as finished.
    assert.equal(await h.quietScreen(1), "turn-finished");
    await new Promise(done => setTimeout(done, 1500));
    assert.equal(await h.stops(1), 0, "The working coordinator is not stopped");
    assert.equal(h.attempts(), 1);
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const started = await until(() => h.get(id), mission => Boolean(teamOf(mission, "a")));
    assert.ok(!started.events.some(event => /missing report was refused/.test(event.text)));
  } finally { h.close(); }
});

test("a report filed while a missed-report stop is still pending is applied, not charged as missing", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.holdStop(1);
    await h.endTurn(1, new Date(Date.now() - 10000));
    // The host decided the turn ended without a report and asked to stop the session, which has not exited yet.
    await waitFor(() => h.stops(1), count => count > 0, 20000);
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    await new Promise(done => setTimeout(done, 1000));
    await h.releaseStop(1);
    const started = await until(() => h.get(id), mission => Boolean(teamOf(mission, "a")), 20000);
    assert.ok(!started.events.some(event => /missing report was refused/.test(event.text)));
    await new Promise(done => setTimeout(done, 1000));
    assert.equal(h.attempts(), 1, "The applied report leaves nothing to wake a new attempt");
  } finally { h.close(); }
});

test("a wait filed on the tick that resumes a paused subteam is accepted", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const teamId = teamOf(await until(() => h.get(id), mission => Boolean(teamOf(mission, "a"))), "a")!;
    await h.missions.pause(id, { requestId: randomUUID(), revision: h.get(id).revision });
    await until(() => h.get(id), mission => mission.subtasks[0].teamStatus === "paused");
    h.holdResume();
    await h.missions.resume(id, { requestId: randomUUID(), revision: h.get(id).revision });
    assert.ok((await h.messages(2)).some((message: { type: string }) => message.type === "resumed"));
    await h.holdStop(2);
    await h.report(2, { kind: "wait", summary: "The API subteam resumes" });
    await new Promise(done => setTimeout(done, 1000));
    assert.equal(h.runs.get(teamId)!.status, "paused", "The resume has not reached the subteam yet");
    await h.releaseStopAndResume(2);
    const waiting = await until(() => h.get(id), mission => mission.events.some(event => /waiting for subteam progress|wait report was refused/.test(event.text)), 20000);
    assert.ok(!waiting.events.some(event => /wait report was refused/.test(event.text)), "The resumed subteam is working, so the wait is accepted");
  } finally { h.close(); }
});

test("a coordinator cannot wait behind a repository that a paused run holds alongside a working one", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const at = new Date().toISOString();
    h.runs.set("paused-web", { id: "paused-web", projectId: "web", missionId: "", status: "paused", revision: 1, decisions: [], updatedAt: at });
    h.runs.set("busy-web", { id: "busy-web", projectId: "web", missionId: "", status: "implementing", revision: 1, decisions: [], updatedAt: at });
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One web change", subtasks: [plan("b", "web")] });
    await until(() => h.get(id), mission => mission.subtasks.length === 1);
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Keep it small" });
    // The working run will finish, but the paused one keeps the repository reserved after it.
    await h.report(2, { kind: "wait", summary: "Subtask b waits for the web repository" });
    const refusal = (await h.messages(3)).find((message: { type: string }) => message.type === "refused");
    assert.equal(refusal.kind, "wait");
    assert.match(refusal.reason, /no later attempt would start/);
  } finally { h.close(); }
});

test("a stopped coordinator is told once when only a paused run outside the mission holds a ready subtask's repository", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const at = new Date().toISOString();
    h.runs.set("paused-web", { id: "paused-web", projectId: "web", missionId: "", status: "paused", revision: 1, decisions: [], updatedAt: at });
    h.runs.set("busy-web", { id: "busy-web", projectId: "web", missionId: "", status: "implementing", revision: 1, decisions: [], updatedAt: at });
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One web change", subtasks: [plan("b", "web")] });
    await until(() => h.get(id), mission => mission.subtasks.length === 1);
    await new Promise(done => setTimeout(done, 1500));
    assert.equal(h.attempts(), 1, "A working holder will free the repository, so the coordinator is not woken");
    h.set("busy-web", { status: "ready-for-review" });
    const held = (await h.messages(2)).filter((message: { type: string }) => message.type === "repository-held");
    assert.deepEqual(held, [{ type: "repository-held", subtaskId: "b", repoProjectId: "web", teamId: "paused-web", teamStatus: "paused" }]);
    assert.equal(h.get(id).subtasks[0].status, "queued");
    await h.report(2, { kind: "question", question: "A paused run holds the web repository. Cancel it or resume it?", options: ["Cancel it", "Resume it"] });
    await until(() => h.get(id), mission => mission.status === "needs-input");
    await new Promise(done => setTimeout(done, 1500));
    assert.equal(h.attempts(), 2, "The same holder and status are reported once");
    // A new holder status is news.
    h.set("paused-web", { status: "blocked" });
    assert.ok((await h.messages(3)).some((message: { type: string; teamStatus?: string }) => message.type === "repository-held" && message.teamStatus === "blocked"));
  } finally { h.close(); }
});

test("subtasks wait for a repository that another mission or a run outside any mission is using", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    h.standalone.add("web");
    const first = await h.create(), second = await h.create();
    const firstAttempt = (await h.attempt(1)).assignment.runId === first.id ? 1 : 2;
    await h.report(firstAttempt, { kind: "dispatch", summary: "Both repositories", subtasks: [plan("x", "api"), plan("y", "web")] });
    const running = await until(() => h.get(first.id), mission => Boolean(teamOf(mission, "x")));
    await h.report(3 - firstAttempt, { kind: "dispatch", summary: "The API", subtasks: [plan("z", "api")] });
    await until(() => h.get(second.id), mission => mission.subtasks.length === 1);
    await new Promise(done => setTimeout(done, 1500));
    assert.equal(h.get(second.id).subtasks[0].status, "queued", "Another mission's API subteam holds the repository");
    assert.equal(h.get(first.id).subtasks[1].status, "queued", "A run outside any mission holds the web repository");
    assert.equal(h.created.length, 1);
    h.standalone.delete("web");
    await until(() => h.get(first.id), mission => Boolean(teamOf(mission, "y")));
    h.set(teamOf(running, "x")!, { status: "ready-for-review" });
    await until(() => h.get(second.id), mission => Boolean(teamOf(mission, "z")));
  } finally { h.close(); }
});

test("messages beyond one attempt's limit wait for the next, and open subteam decisions always reach the coordinator", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const teamId = teamOf(await until(() => h.get(id), mission => Boolean(teamOf(mission, "a"))), "a")!;
    const decision = (n: number) => ({ id: randomUUID(), memberId: randomUUID(), revision: 1, question: `Question ${n}?`, options: [], createdAt: new Date().toISOString() });
    const decisions = [decision(1)];
    h.set(teamId, { status: "needs-input", decisions });
    await h.attempt(2);
    // While attempt 2 runs, 14 more subteam questions and 20 owner directions arrive.
    for (let n = 2; n <= 15; n++) decisions.push(decision(n));
    h.set(teamId, { decisions });
    for (let n = 1; n <= 20; n++) await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: `Direction ${n}` });
    await new Promise(done => setTimeout(done, 1500));
    await h.report(2, { kind: "answer-child", subtaskId: "a", decisionId: decisions[0].id, text: "Yes" });
    const third = await h.messages(3);
    assert.equal(third.length, 30);
    assert.match((await h.attempt(3)).prompt, /4 more messages are waiting/);
    const open = (await h.state(3)).openChildDecisions;
    assert.deepEqual(open.map((item: { decisionId: string }) => item.decisionId), decisions.map(item => item.id), "Every unanswered subteam decision is listed from durable state");
    assert.equal(open[0].answerPendingBy, "coordinator");
    await h.report(3, { kind: "answer-child", subtaskId: "a", decisionId: decisions[1].id, text: "No" });
    const delivered = [...third, ...await h.messages(4)];
    assert.equal(delivered.length, 34);
    assert.deepEqual(delivered.filter((message: { type: string }) => message.type === "child-decision").map((message: { decisionId: string }) => message.decisionId).sort(),
      decisions.slice(1).map(item => item.id).sort());
    assert.equal(delivered.filter((message: { type: string }) => message.type === "owner-direction").length, 20);
    await waitFor(async () => h.answers.length, count => count === 2, 20000);
    assert.ok(h.answers.every(answer => answer.by === "coordinator"));
  } finally { h.close(); }
});

test("a coordinator forwards owner direction to a running subteam, held while it is paused and refused for queued work", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "API first, then web", subtasks: [plan("a", "api"), plan("b", "web", ["a"])] });
    const teamId = teamOf(await until(() => h.get(id), mission => Boolean(teamOf(mission, "a"))), "a")!;
    h.set(teamId, { status: "paused" });
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Return JSON, not text" });
    assert.ok((await h.messages(2)).some((message: { type: string }) => message.type === "owner-direction"));
    await h.report(2, { kind: "steer-subtask", subtaskId: "a", text: "The owner wants JSON responses" });
    await until(() => h.get(id), mission => mission.events.some(event => /sent direction to subtask a/.test(event.text)));
    await new Promise(done => setTimeout(done, 1200));
    assert.deepEqual(h.steers, [], "A paused subteam is not restarted by forwarded direction");
    h.set(teamId, { status: "implementing" });
    await until(() => h.steers, steers => steers.length === 1);
    assert.deepEqual(h.steers, [{ teamId, text: "The owner wants JSON responses" }]);
    await until(() => h.get(id), mission => mission.events.some(event => /Subtask a received the coordinator's direction/.test(event.text)));

    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Label the web button Check health" });
    await h.report(3, { kind: "steer-subtask", subtaskId: "b", text: "Label the button Check health" });
    await until(() => h.get(id), mission => mission.events.some(event => /steer-subtask report was refused: Subtask b has no running or blocked subteam/.test(event.text)));

    h.limitSteering();
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Also log each request" });
    await h.report(4, { kind: "steer-subtask", subtaskId: "a", text: "Log each request" });
    const refused = (await h.messages(5)).find((message: { type: string; kind?: string }) => message.type === "refused" && message.kind === "steer-subtask");
    assert.match(refused.reason, /steering limit/, "A subteam's refusal wakes the coordinator with the reason");
    assert.equal(h.steers.length, 1);
  } finally { h.close(); }
});

test("a steer whose reply was lost replays its request instead of steering the subteam twice", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const teamId = teamOf(await until(() => h.get(id), mission => Boolean(teamOf(mission, "a"))), "a")!;
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Return JSON" });
    h.loseNextSteerReply();
    await h.report(2, { kind: "steer-subtask", subtaskId: "a", text: "The owner wants JSON responses" });
    await until(() => h.get(id), mission => mission.events.some(event => /Subtask a received the coordinator's direction/.test(event.text)));
    await new Promise(done => setTimeout(done, 1200));
    assert.equal(h.steers.length, 1, "The retry replays the recorded request rather than sending a second direction");
    assert.equal(h.runs.get(teamId)!.revision, 2);
  } finally { h.close(); }
});

test("direction for a blocked subteam waits while the mission is paused, and is delivered after it resumes", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const teamId = teamOf(await until(() => h.get(id), mission => Boolean(teamOf(mission, "a"))), "a")!;
    h.set(teamId, { status: "blocked" });
    assert.ok((await h.messages(2)).some((message: { type: string; status?: string }) => message.type === "subtask-finished" && message.status === "blocked"));
    h.holdSteers(true);
    await h.report(2, { kind: "steer-subtask", subtaskId: "a", text: "Use the cached client; it is allowed" });
    await until(() => h.get(id), mission => mission.events.some(event => /sent direction to subtask a/.test(event.text)));
    await h.missions.pause(id, { requestId: randomUUID(), revision: h.get(id).revision });
    h.holdSteers(false);
    await new Promise(done => setTimeout(done, 1500));
    assert.deepEqual(h.steers, [], "A paused mission does not restart its blocked subteam");
    assert.equal(h.runs.get(teamId)!.status, "blocked");
    await h.missions.resume(id, { requestId: randomUUID(), revision: h.get(id).revision });
    await until(() => h.steers, steers => steers.length === 1);
    assert.equal(h.runs.get(teamId)!.status, "planning");
  } finally { h.close(); }
});

test("three directions in a row that subteams refuse block the mission like other refused reports", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    await until(() => h.get(id), mission => Boolean(teamOf(mission, "a")));
    h.limitSteering();
    await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: "Log each request" });
    for (const n of [2, 3, 4]) await h.report(n, { kind: "steer-subtask", subtaskId: "a", text: "Log each request" });
    const blocked = await until(() => h.get(id), mission => mission.status === "blocked", 20000);
    assert.match(blocked.reason ?? "", /refused three times in a row.*steering limit/);
  } finally { h.close(); }
});

test("a direction delivered between refused ones resets the refusal count in delivery order", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One change per repository", subtasks: [plan("a", "api"), plan("b", "web")] });
    const started = await until(() => h.get(id), mission => Boolean(teamOf(mission, "a") && teamOf(mission, "b")));
    h.limitSteering([teamOf(started, "a")!]);
    h.holdSteers(true);
    // Four directions queue while subteams are busy; they are then delivered in one tick as refused, delivered, refused, refused.
    for (const [n, subtaskId] of [[2, "a"], [3, "b"], [4, "a"], [5, "a"]] as const) {
      await h.missions.steer(id, { requestId: randomUUID(), revision: h.get(id).revision, text: `Direction ${n}` });
      await h.report(n, { kind: "steer-subtask", subtaskId, text: `Direction ${n}` });
      await until(() => h.get(id), mission => mission.events.filter(event => /sent direction to subtask/.test(event.text)).length === n - 1);
    }
    h.holdSteers(false);
    await until(() => h.steers, steers => steers.length === 1);
    await new Promise(done => setTimeout(done, 1500));
    assert.notEqual(h.get(id).status, "blocked", "Only two refusals follow the delivered direction");
    assert.equal(h.get(id).events.filter(event => /steer-subtask report was refused/.test(event.text)).length, 3);
  } finally { h.close(); }
});
