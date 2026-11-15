import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../packages/host/src/server.js";
import { hashToken } from "../packages/host/src/config.js";
import type { McpRequestView } from "../packages/host/src/mcp-types.js";
import type { Config } from "../packages/host/src/types.js";
import { inProcessHost, stopSessionWorkers, waitFor } from "./helpers.js";
import { git, lineup } from "./mission-harness.js";
import { startIntakeLinearServer } from "./fixtures/intake-linear-server.js";

test("MCP starts one tracked mission, delivers a delegated answer, and retains its report across restart", { timeout: 240_000 }, async () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-mcp-e2e-"));
  const receipts = join(root, "receipts");
  mkdirSync(receipts, { mode: 0o700 });
  const repos = ["api", "web"].map(id => {
    const path = join(root, id);
    mkdirSync(path);
    writeFileSync(join(path, "check.mjs"), `import { existsSync } from "node:fs";\nif (!existsSync("${id}.txt")) process.exit(1);\n`);
    git(path, "init", "--initial-branch=main");
    git(path, "add", "check.mjs");
    git(path, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
    return { id, name: id.toUpperCase(), path, team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] } };
  });
  const linear = await startIntakeLinearServer();
  const token = randomBytes(32).toString("base64url");
  const agent = { command: process.execPath, args: [resolve("tests/fixtures/mission-agent.mjs"), "mission", receipts, "claude"] };
  const host = await inProcessHost({ configure: (config: Config) => {
    config.agents = { claude: agent, codex: agent };
    config.projects = repos;
    config.teams = { workspaceDir: join(root, "teams"), lineup };
    config.linear = { apiKeyFile: linear.apiKeyFile, endpoint: linear.endpoint };
    config.intake = {
      linear: { teamIds: [linear.teamId], creatorId: linear.ownerId, label: "infinite", admitIssues: false },
      mission: { groupId: "api", maxSubtasks: 8, maxMinutes: 30 }, maxActive: 1, requireSlackThread: false,
    };
    config.mcp = { port: 0, origin: "https://connector.example", connectors: [{ id: "assistant", name: "Assistant", tokenHash: hashToken(token), projectIds: ["api", "web"] }] };
  } });
  let active: ReturnType<typeof createApp> = host;
  let client: Client | undefined;
  const connect = async () => {
    assert.ok(active.mcpServer);
    await new Promise<void>(resolve => active.mcpServer!.listen(0, "127.0.0.1", resolve));
    const port = (active.mcpServer.address() as { port: number }).port;
    client = new Client({ name: "request-workflow-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
  };
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const response = await client!.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    assert.ok(response.structuredContent, "The public tool returns structured content");
    return response.structuredContent as T;
  };
  const stop = async () => {
    await client?.close(); client = undefined;
    await active.closeConnections();
    await active.missions.idle();
    await active.teams.idle();
    await stopSessionWorkers(host.config);
    await new Promise<void>(resolve => active.server.close(() => resolve()));
  };
  try {
    const group = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Shop", repos: ["api", "web"] });
    assert.equal(group.status, 200, JSON.stringify(group.body));
    writeFileSync(join(receipts, "release-dispatch"), "go", { mode: 0o600 });
    writeFileSync(join(receipts, "release-web-question"), "go", { mode: 0o600 });
    await connect();
    const projects = await call<{ projects: { id: string; name: string }[] }>("list_projects", {});
    assert.ok(projects.projects.some(project => project.id === group.body.id));

    const request = { requestId: randomUUID(), projectId: group.body.id, title: "Build the endpoint and client", objective: "Build the endpoint and web client using the agreed response format." };
    const queued = await call<McpRequestView>("start_request", request);
    assert.equal(queued.status, "queued");
    assert.deepEqual(queued.tracking, { state: "pending" });
    assert.deepEqual(queued.availableActions, []);
    const repeated = await call<McpRequestView>("start_request", request);
    assert.equal(repeated.runId, queued.runId);
    const get = () => call<McpRequestView>("get_request", { runId: queued.runId });
    const question = await waitFor(get, view => view.status === "needs-input" && view.questions.length === 1, 120_000);
    assert.equal(question.tracking.state, "linked");
    assert.equal(question.tracking.identifier, "TEST-1");
    assert.equal(question.tracking.url, linear.allIssues()[0].url);
    assert.equal(question.questions[0].question, "The API subteam asks: Which response format should the endpoint use?");
    assert.deepEqual(question.questions[0].options, ["JSON", "Text"]);

    const answer = { runId: queued.runId, requestId: randomUUID(), revision: question.revision!, decisionId: question.questions[0].id, text: "JSON" };
    await call<McpRequestView>("reply_to_request", answer);
    await call<McpRequestView>("reply_to_request", answer);
    const finished = await waitFor(get, view => view.status === "ready-for-review", 120_000);
    assert.deepEqual(finished.result, { kind: "agent-report", summary: "The API and the web client were each reviewed in their own repository." });
    const mission = active.missions.get(queued.runId);
    assert.equal(mission.origin?.source?.kind, "connector");
    const answered = mission.decisions.filter(decision => decision.answer);
    assert.equal(answered.length, 1, "The retried reply records one answer");
    assert.equal(answered[0].source?.kind, "connector");
    const apiTeamId = mission.subtasks.find(subtask => subtask.repoProjectId === "api")!.teamId;
    const child = active.teams.get(apiTeamId!);
    assert.equal(child.decisions[0].answer, "JSON");
    assert.equal(child.decisions[0].source?.kind, "connector");
    const apiWorker = readdirSync(receipts).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(receipts, name), "utf8")))
      .find(receipt => receipt.role === "implementer" && receipt.runId === apiTeamId);
    assert.ok(apiWorker, "The API child ran an implementer");
    assert.match(apiWorker.prompt, /Connector \(Assistant\) answered "Which response format should the endpoint use\?": JSON/,
      "The actual child implementer receives the delegated answer with connector attribution");
    assert.equal(readFileSync(join(apiWorker.cwd, "api.txt"), "utf8"), "JSON\n", "The child applied the delegated answer in its isolated workspace");
    assert.ok(child.checks.length > 0 && child.checks.every(check => check.status === "passed"));
    assert.equal(linear.allIssues().length, 1);

    await stop();
    active = createApp(host.config, readFileSync(host.config.keyFile));
    await new Promise<void>(resolve => active.server.listen(0, "127.0.0.1", resolve));
    await connect();
    const recovered = await call<McpRequestView>("start_request", request);
    assert.equal(recovered.runId, queued.runId);
    assert.equal(recovered.status, "ready-for-review");
    assert.deepEqual(recovered.tracking, finished.tracking);
    assert.deepEqual(recovered.result, finished.result);
    assert.equal(active.missions.list().length, 1, "Restart and duplicate delivery retain one mission");
    assert.equal(linear.allIssues().length, 1, "Restart and duplicate delivery retain one tracker issue");
  } finally {
    await stop();
    await new Promise(resolve => setTimeout(resolve, 1700));
    await linear.close();
    rmSync(host.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
