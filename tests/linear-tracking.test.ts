import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { startHost, waitFor } from "./helpers.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";
import { startLinearServer } from "./fixtures/linear-server.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { LinearService } from "../packages/host/src/linear.js";
import { fixture } from "./team-fixture.js";
import type { Config } from "../packages/host/src/types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

function startProjectLinearServer() {
  const apiKey = randomBytes(32).toString("hex"), teamId = randomUUID(), projectId = randomUUID();
  const issues = new Map<string, any>(), comments = new Map<string, any>(), calls: { operation: string; variables: any }[] = [];
  let clock = Date.now();
  const updatedAt = () => new Date(++clock).toISOString();
  const seedIssue = (input: { id: string; title: string; description: string; parentId?: string; projectId?: string }) => {
    const identifier = `TEST-${issues.size + 1}`;
    const issue = { id: input.id, identifier, url: `https://linear.app/example/issue/${identifier}`, title: input.title,
      description: input.description, updatedAt: updatedAt(), archivedAt: null, team: { id: teamId },
      project: input.projectId ? { id: input.projectId } : null, parent: input.parentId ? { id: input.parentId } : null,
      state: { id: randomUUID(), name: "Todo", type: "unstarted" } };
    issues.set(issue.id, issue); return issue;
  };
  const server = createServer(async (request, response) => {
    const reply = (status: number, data: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (request.method !== "POST" || request.url !== "/graphql" || request.headers.authorization !== apiKey) { reply(404, {}); return; }
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body), operation = parsed.operationName, variables = parsed.variables ?? {};
      calls.push({ operation, variables });
      let data: unknown;
      switch (operation) {
        case "InfiniteLinearIssue":
          data = { issue: issues.get(variables.id) ?? [...issues.values()].find(issue => issue.identifier === variables.id) ?? null }; break;
        case "InfiniteLinearIssues": {
          const ids = variables.filter?.id?.in;
          if (!Array.isArray(ids)) throw new Error("Issue reconciliation requires IDs");
          data = { issues: { nodes: ids.flatMap((id: string) => issues.has(id) ? [issues.get(id)] : []), pageInfo: { hasNextPage: false, endCursor: null } } }; break;
        }
        case "InfiniteLinearIssueCreate": {
          const input = variables.input;
          if (!input?.id || input.teamId !== teamId || input.projectId !== projectId) throw new Error("Issue creation omitted the configured project");
          if (issues.has(input.id)) throw new Error("Issue ID already exists");
          const issue = seedIssue({ id: input.id, title: input.title, description: input.description, parentId: input.parentId, projectId: input.projectId });
          data = { issueCreate: { success: true, issue } }; break;
        }
        case "InfiniteLinearComment": {
          const id = variables.filter?.id?.eq; data = { comments: { nodes: comments.has(id) ? [comments.get(id)] : [] } }; break;
        }
        case "InfiniteLinearCommentCreate": {
          const input = variables.input;
          if (!input?.id || !issues.has(input.issueId)) throw new Error("Comment creation has no known issue");
          const comment = { id: input.id, body: input.body, issue: { id: input.issueId } }; comments.set(comment.id, comment);
          data = { commentCreate: { success: true, comment } }; break;
        }
        default: throw new Error(`Unexpected GraphQL operation: ${operation}`);
      }
      reply(200, { data });
    } catch (error) { reply(200, { errors: [{ message: error instanceof Error ? error.message : "Invalid request" }] }); }
  });
  const listening = new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return listening.then(() => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Linear fixture needs a TCP address");
    return { apiKey, teamId, projectId, endpoint: `http://127.0.0.1:${address.port}/graphql`, issues, calls, seedIssue,
      async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
  });
}

test("runs created before a project is mapped stay unlinked through restart, list, and get", { timeout: 90000 }, async () => {
  const linear = await startLinearServer();
  const root = mkdtempSync(join(tmpdir(), "infinite-linear-history-"));
  const source = join(root, "source"), receipts = join(root, "receipts");
  mkdirSync(join(source, "features"), { recursive: true }); mkdirSync(receipts, { mode: 0o700 });
  writeFileSync(join(source, "features/progress.json"), '{"completed":0}\n');
  writeFileSync(join(source, "check.mjs"), 'import assert from "node:assert/strict";\nassert.ok(true);\n');
  git(source, "init", "--initial-branch=main"); git(source, "add", "features", "check.mjs");
  git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
  const apiKeyFile = join(root, "linear-key"); writeFileSync(apiKeyFile, linear.apiKey, { mode: 0o600 });
  const host = await startHost({ agents: {
    claude: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "no-change", receipts, "claude"] },
    codex: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "no-change", receipts, "codex"] },
  }, config: {
    teams: { workspaceDir: join(root, "teams"), lineup },
    projects: [{ id: "rehearsal", name: "Rehearsal", path: source, team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] } }],
  } });
  try {
    const goalId = randomUUID();
    const created = await host.fetchApi("/goals", "owner", { requestId: goalId, projectId: "rehearsal", title: "Review progress", objective: "Review the progress fixture", successCriteria: "Record whether more work is justified", allowedPaths: ["features"], maxMinutes: 5 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await waitFor(async () => {
      const response = await host.fetchApi(`/goals/${goalId}`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    }, value => Boolean(value.activeTeamId), 30000);
    const teamList = await host.fetchApi("/teams");
    assert.equal(teamList.status, 200);
    assert.ok(teamList.body.teams.some((run: { goal?: { id: string } }) => run.goal?.id === goalId), "The goal must have an actual feature run to exercise team tracking");

    host.config.linear = { apiKeyFile, endpoint: linear.endpoint };
    host.config.projects[0].linear = { teamId: linear.teamId };
    writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config));
    await host.stopApi(); await host.start();

    const listedGoals = await host.fetchApi("/goals");
    assert.equal(listedGoals.status, 200);
    const listedGoal = listedGoals.body.goals.find((goal: { id: string }) => goal.id === goalId);
    assert.ok(listedGoal);
    assert.equal(listedGoal.linear, undefined);
    const fetchedGoal = await host.fetchApi(`/goals/${goalId}`);
    assert.equal(fetchedGoal.status, 200);
    assert.equal(fetchedGoal.body.linear, undefined);
    const listedTeams = await host.fetchApi("/teams");
    assert.equal(listedTeams.status, 200);
    const historicalTeam = listedTeams.body.teams.find((run: { goal?: { id: string } }) => run.goal?.id === goalId);
    assert.ok(historicalTeam);
    assert.equal(historicalTeam.linear, undefined);
    const fetchedTeam = await host.fetchApi(`/teams/${historicalTeam.id}`);
    assert.equal(fetchedTeam.status, 200);
    assert.equal(fetchedTeam.body.linear, undefined);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.deepEqual([...linear.issues.keys()], [], "Enabling a mapping must not create issues for historical goal or team records");

    const newGoalId = randomUUID();
    const mappedCreate = await host.fetchApi("/goals", "owner", { requestId: newGoalId, projectId: "rehearsal", title: "Review a new progress change", objective: "Review a newly approved progress change", successCriteria: "Record whether work is justified", allowedPaths: ["features"], maxMinutes: 5 });
    assert.equal(mappedCreate.status, 200, JSON.stringify(mappedCreate.body));
    await waitFor(async () => linear.issues.has(newGoalId), Boolean, 15000);
  } finally {
    await host.stop(); await linear.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("new goal and child issues use the configured Linear project and reject mismatched existing issues", { timeout: 90000 }, async () => {
  const linear = await startProjectLinearServer();
  const root = mkdtempSync(join(tmpdir(), "infinite-linear-project-"));
  const source = join(root, "source"), receipts = join(root, "receipts");
  mkdirSync(join(source, "features"), { recursive: true }); mkdirSync(receipts, { mode: 0o700 });
  writeFileSync(join(source, "features/progress.json"), '{"completed":0}\n');
  writeFileSync(join(source, "check.mjs"), 'import assert from "node:assert/strict";\nassert.ok(true);\n');
  git(source, "init", "--initial-branch=main"); git(source, "add", "features", "check.mjs");
  git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
  const apiKeyFile = join(root, "linear-key"); writeFileSync(apiKeyFile, linear.apiKey, { mode: 0o600 });
  const host = await startHost({ agents: {
    claude: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "no-change", receipts, "claude"] },
    codex: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "no-change", receipts, "codex"] },
  }, config: {
    teams: { workspaceDir: join(root, "teams"), lineup },
    linear: { apiKeyFile, endpoint: linear.endpoint },
    projects: [{ id: "rehearsal", name: "Rehearsal", path: source,
      team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] },
      linear: { teamId: linear.teamId, projectId: linear.projectId } }],
  } });
  try {
    const goalId = randomUUID();
    const created = await host.fetchApi("/goals", "owner", { requestId: goalId, projectId: "rehearsal", title: "Review progress", objective: "Review the progress fixture", successCriteria: "Record whether more work is justified", allowedPaths: ["features"], maxMinutes: 5 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const pipeline = await waitFor(async () => ({ issues: [...linear.issues.values()], goal: (await host.fetchApi(`/goals/${goalId}`)).body,
      teams: (await host.fetchApi("/teams")).body.teams }), value => value.issues.length >= 2, 30000);
    const goalIssue = linear.issues.get(goalId)!;
    const childIssue = pipeline.issues.find(issue => issue.parent?.id === goalId);
    assert.ok(childIssue, "A goal must create a linked feature issue");
    assert.equal(goalIssue.project.id, linear.projectId);
    assert.equal(childIssue.project.id, linear.projectId);
    const creates = linear.calls.filter(call => call.operation === "InfiniteLinearIssueCreate");
    assert.equal(creates.length, 2);
    assert.ok(creates.every(call => call.variables.input.projectId === linear.projectId), "Both issueCreate payloads must include the configured project ID");

    const otherProject = randomUUID();
    const mismatch = linear.seedIssue({ id: randomUUID(), title: "Existing issue", description: "Existing approved scope", projectId: otherProject });
    const mismatchGoal = await host.fetchApi("/goals", "owner", { requestId: randomUUID(), projectId: "rehearsal", linearIssueId: mismatch.id,
      title: "Review another task", objective: "Review the existing linked issue", successCriteria: "Use its approved scope", allowedPaths: ["features"], maxMinutes: 5 });
    assert.equal(mismatchGoal.status, 200, JSON.stringify(mismatchGoal.body));
    const blocked = await waitFor(async () => (await host.fetchApi(`/goals/${mismatchGoal.body.id}`)).body,
      goal => goal.linear?.status === "blocked", 15000);
    assert.match(blocked.linear.reason, /different team, project, or parent/);
    assert.equal(linear.calls.filter(call => call.operation === "InfiniteLinearIssueCreate" && call.variables.input.id === mismatchGoal.body.id).length, 0,
      "A mismatched existing issue must block rather than create a replacement");

    const unassigned = linear.seedIssue({ id: randomUUID(), title: "Unassigned issue", description: "Existing approved scope" });
    const unassignedGoal = await host.fetchApi("/goals", "owner", { requestId: randomUUID(), projectId: "rehearsal", linearIssueId: unassigned.id,
      title: "Review an unassigned issue", objective: "Review the existing unassigned issue", successCriteria: "Use its approved scope", allowedPaths: ["features"], maxMinutes: 5 });
    assert.equal(unassignedGoal.status, 200, JSON.stringify(unassignedGoal.body));
    const unassignedBlocked = await waitFor(async () => (await host.fetchApi(`/goals/${unassignedGoal.body.id}`)).body,
      goal => goal.linear?.status === "blocked", 15000);
    assert.match(unassignedBlocked.linear.reason, /different team, project, or parent/);
  } finally {
    await host.stop(); await linear.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("legacy tracking baselines survive restart while changed requirements still block", { timeout: 90000 }, async () => {
  const linear = await startLinearServer();
  const root = mkdtempSync(join(tmpdir(), "infinite-linear-baseline-"));
  const source = join(root, "source"), receipts = join(root, "receipts");
  mkdirSync(join(source, "features"), { recursive: true }); mkdirSync(receipts, { mode: 0o700 });
  writeFileSync(join(source, "features/progress.json"), '{"completed":0}\n');
  writeFileSync(join(source, "check.mjs"), 'import assert from "node:assert/strict";\nassert.ok(true);\n');
  git(source, "init", "--initial-branch=main"); git(source, "add", "features", "check.mjs");
  git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
  const apiKeyFile = join(root, "linear-key"); writeFileSync(apiKeyFile, linear.apiKey, { mode: 0o600 });
  const host = await startHost({ agents: {
    claude: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "no-change", receipts, "claude"] },
    codex: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), "no-change", receipts, "codex"] },
  }, config: {
    teams: { workspaceDir: join(root, "teams"), lineup }, linear: { apiKeyFile, endpoint: linear.endpoint },
    projects: [{ id: "rehearsal", name: "Rehearsal", path: source, team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] }, linear: { teamId: linear.teamId } }],
  } });
  try {
    const goalId = randomUUID();
    const created = await host.fetchApi("/goals", "owner", { requestId: goalId, projectId: "rehearsal", title: "Review progress", objective: "Review the progress fixture", successCriteria: "Record whether more work is justified", allowedPaths: ["features"], maxMinutes: 5 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await waitFor(async () => linear.issues.get(goalId), Boolean, 15000);
    const issue = linear.issues.get(goalId)!;
    const canonical = (value: string | null) => (value ?? "").replace(/\r\n/g, "\n").trim();
    const oldBaseline = createHash("sha256").update(JSON.stringify({ title: issue.title, description: canonical(issue.description), teamId: issue.team.id, parentId: issue.parent?.id ?? null })).digest("hex");
    await host.stopApi();
    const recordPath = join(host.config.stateDir, "linear", `goal-${goalId}.sealed`), key = readFileSync(host.config.keyFile);
    const recordKey = `linear:goal:${goalId}`;
    const stored = unseal<{ baseline?: string } & Record<string, unknown>>(key, recordKey, readFileSync(recordPath, "utf8"));
    stored.baseline = oldBaseline;
    writeSealed(recordPath, key, recordKey, stored);

    await host.start();
    const unchanged = await waitFor(async () => (await host.fetchApi(`/goals/${goalId}`)).body,
      goal => goal.linear?.status === "synced", 15000);
    assert.equal(unchanged.linear.issue.id, goalId, "A pre-project baseline must remain valid when the issue is unchanged");

    await host.stopApi();
    linear.editIssue(goalId, { description: `${issue.description}\nChanged approved scope` });
    await host.start();
    const changed = await waitFor(async () => (await host.fetchApi(`/goals/${goalId}`)).body,
      goal => goal.linear?.status === "blocked", 15000);
    assert.match(changed.linear.reason, /requirements or parent changed/);
  } finally {
    await host.stop(); await linear.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("a blocked run's issue gets its reason, next step and a Blocked label until the run moves again", { timeout: 60000 }, async () => {
  const linear = await startLinearServer();
  const root = mkdtempSync(join(tmpdir(), "inf-linear-flag-"));
  let service: LinearService | undefined;
  try {
    const apiKeyFile = join(root, "linear-key");
    writeFileSync(apiKeyFile, linear.apiKey, { mode: 0o600 });
    const config = { stateDir: join(root, "state"), linear: { apiKeyFile, endpoint: linear.endpoint },
      projects: [{ id: "flagged", name: "Flagged", path: root, linear: { teamId: linear.teamId } }] } as unknown as Config;
    service = new LinearService(config, randomBytes(32));
    const run = { id: randomUUID(), projectId: "flagged", title: "Smart alarm", objective: "Stop alarms once I am awake.", status: "implementing",
      revision: 3, members: [], checks: [], steering: [], decisions: [] } as unknown as TeamRun;
    service.updateTeam(run, true); service.start();
    await waitFor(async () => service!.getTeam(run.id)?.status, status => status === "synced", 15000);
    const issueId = service.getTeam(run.id)!.issue!.id;
    const applied = () => [...(linear.issueLabels.get(issueId) ?? [])].map(id => linear.labels.get(id)!.name);

    run.status = "blocked"; run.reason = "An agent showed no activity twice on the same assignment. Its workspace was preserved.";
    service.updateTeam(run, true);
    assert.ok(![...linear.comments.values()].some(comment => comment.body.includes("Status: blocked")), "The blocked evidence waits for the host's resume answer");
    service.updateTeam(run, true, true);
    await waitFor(async () => applied(), names => names.includes("Blocked"), 15000);
    const blocked = [...linear.comments.values()].find(comment => comment.body.includes("Status: blocked"))!;
    assert.match(blocked.body, /Reason: An agent showed no activity twice on the same assignment\./);
    assert.match(blocked.body, new RegExp(`Next step: run \`infinite team resume ${run.id}\` to replan`));
    assert.equal(linear.labels.size, 1, "The label is created once in the run's team");

    run.status = "planning"; run.revision = 4; run.reason = undefined;
    service.updateTeam(run, true, false);
    await waitFor(async () => applied(), names => names.length === 0, 15000);
    assert.equal(linear.labels.size, 1);

    // The cached label was deleted in Linear: the next block looks it up again instead of failing until restart.
    linear.labels.clear();
    run.status = "blocked"; run.revision = 5; run.reason = "The host restarted during a workspace or verification operation.";
    service.updateTeam(run, true, false);
    await waitFor(async () => applied(), names => names.includes("Blocked"), 15000);
    assert.equal(linear.labels.size, 1, "A replacement label is created once");

    // A rate-limited label request backs off only the label; other evidence keeps flowing.
    linear.rateLimitLabelLookups(true);
    const lookups = linear.calls.filter(call => call.operation === "InfiniteLinearLabels").length;
    const second = { ...run, id: randomUUID(), title: "Second run", status: "implementing", revision: 1, reason: undefined } as unknown as TeamRun;
    service.updateTeam(second, true);
    await waitFor(async () => service!.getTeam(second.id)?.status, status => status === "synced", 15000);
    second.status = "blocked"; second.reason = "An agent exceeded its one-hour runtime limit. Its workspace was preserved.";
    (service as unknown as { labels: Map<string, string> }).labels.clear();
    service.updateTeam(second, true, true);
    await waitFor(async () => linear.calls.filter(call => call.operation === "InfiniteLinearLabels").length, count => count > lookups, 15000);
    second.status = "paused"; second.revision = 2;
    service.updateTeam(second, true, false);
    await waitFor(async () => [...linear.comments.values()].some(comment => comment.issue.id === service!.getTeam(second.id)!.issue!.id && comment.body.includes("Status: paused")), Boolean, 15000);
    assert.equal(service.getTeam(second.id)?.status, "synced");
    linear.rateLimitLabelLookups(false);

    // A rate-limited change on a cached label keeps its delay: no recovery lookup, no immediate retry.
    linear.rateLimitLabelChanges(true);
    const third = { ...run, id: randomUUID(), title: "Third run", status: "implementing", revision: 1, reason: undefined } as unknown as TeamRun;
    service.updateTeam(third, true);
    await waitFor(async () => service!.getTeam(third.id)?.status, status => status === "synced", 15000);
    (service as unknown as { labels: Map<string, string> }).labels.set(linear.teamId, [...linear.labels.keys()][0]);
    const before = { lookups: linear.calls.filter(call => call.operation === "InfiniteLinearLabels").length, adds: linear.calls.filter(call => call.operation === "InfiniteLinearIssueAddLabel").length };
    third.status = "blocked"; third.reason = "An agent exceeded its one-hour runtime limit. Its workspace was preserved.";
    service.updateTeam(third, true, true);
    await waitFor(async () => linear.calls.filter(call => call.operation === "InfiniteLinearIssueAddLabel").length, count => count > before.adds, 15000);
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(linear.calls.filter(call => call.operation === "InfiniteLinearIssueAddLabel").length, before.adds + 1, "The rate-limited add waits for its delay");
    assert.equal(linear.calls.filter(call => call.operation === "InfiniteLinearLabels").length, before.lookups, "A rate limit is not mistaken for a deleted label");
    linear.rateLimitLabelChanges(false);

    // A label failure never gates execution: tracking stays synced while the label waits to retry.
    linear.failLabelLookups(true);
    const fresh = new LinearService({ ...config, stateDir: join(root, "isolated-state") } as Config, randomBytes(32));
    const other = { ...run, id: randomUUID(), title: "Another run", status: "implementing", revision: 1 } as unknown as TeamRun;
    fresh.updateTeam(other, true); fresh.start();
    await waitFor(async () => fresh.getTeam(other.id)?.status, status => status === "synced", 15000);
    other.status = "blocked"; other.reason = "The Linear issue changed.";
    fresh.updateTeam(other, true, false);
    await waitFor(async () => linear.calls.filter(call => call.operation === "InfiniteLinearLabels").length, count => count >= 2, 15000);
    await waitFor(async () => fresh.getTeam(other.id)?.status, status => status === "synced", 15000);
    await waitFor(async () => [...linear.comments.values()].find(comment => comment.issue.id === fresh.getTeam(other.id)!.issue!.id && comment.body.includes("Status: blocked")), Boolean, 15000);
    assert.equal(linear.issueLabels.get(fresh.getTeam(other.id)!.issue!.id)?.size ?? 0, 0, "A failed lookup leaves the issue unlabelled until a later retry");
    assert.match([...linear.comments.values()].find(comment => comment.issue.id === fresh.getTeam(other.id)!.issue!.id && comment.body.includes("Status: blocked"))!.body,
      /Next step: inspect the run's evidence, then start a new run to continue\./);
    fresh.close();
    assert.deepEqual(linear.violations, []);
  } finally { service?.close(); await linear.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a run that blocks while no client is reading still gets its reason and next step on Linear", { timeout: 120000 }, async () => {
  const linear = await startLinearServer();
  const f = await fixture("unreported");
  try {
    const apiKeyFile = join(f.host.root, "linear-key");
    writeFileSync(apiKeyFile, linear.apiKey, { mode: 0o600 });
    f.host.config.linear = { apiKeyFile, endpoint: linear.endpoint };
    f.host.config.projects[0].linear = { teamId: linear.teamId };
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.stopApi(); await f.host.start();
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    // No list or get from here on: only the scheduler can supply the blocked evidence.
    const blocked = await waitFor(async () => [...linear.comments.values()].find(comment => comment.body.includes("Status: blocked")), Boolean, 90000);
    assert.match(blocked!.body, /Reason: An agent exited without a valid structured report\./);
    assert.match(blocked!.body, /Next step: inspect the run's evidence, then start a new run to continue\./);
    await waitFor(async () => [...linear.issueLabels.values()].some(applied => applied.size > 0), Boolean, 15000);
  } finally { await f.close(); await linear.close(); }
});
