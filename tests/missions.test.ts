import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { stopSessionWorkers, waitFor } from "./helpers.js";
import { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { MissionService, missionBoard, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import { createMissionReportEnvelope } from "../packages/host/src/team-report-client.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config } from "../packages/host/src/types.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";
import type { CreateMission, Mission } from "../packages/host/src/mission-types.js";

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
