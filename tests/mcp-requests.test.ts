import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { scriptedMissionHarness } from "./mission-harness.js";
import { startIntakeLinearServer } from "./fixtures/intake-linear-server.js";
import { waitFor } from "./helpers.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { IntakeService } from "../packages/host/src/intake.js";
import { IntakeLinear } from "../packages/host/src/intake-linear.js";
import { LinearService } from "../packages/host/src/linear.js";
import { ProjectGroupService } from "../packages/host/src/project-groups.js";
import { McpRequestService } from "../packages/host/src/mcp-requests.js";
import { McpRequestError } from "../packages/host/src/mcp-types.js";
import type { Config } from "../packages/host/src/types.js";

// These tests protect sealed admission, scope revocation, and durable action receipts. A second in-memory
// tracker, an unguarded queued create, or a fresh request ID on replay would each violate an observable assertion.
async function setup(options: { afterLabel?: (config: Config) => void } = {}) {
  const linearServer = await startIntakeLinearServer();
  const h = scriptedMissionHarness({ configure(config) {
    config.linear = { apiKeyFile: linearServer.apiKeyFile, endpoint: linearServer.endpoint };
    config.intake = { linear: { teamIds: [linearServer.teamId], creatorId: linearServer.ownerId, label: "infinite", commentsMirrorToSlack: false, admitIssues: false },
      mission: { groupId: "shop", maxSubtasks: 2, maxMinutes: 30 }, maxActive: 1, requireSlackThread: true };
    config.mcp = { port: 0, origin: "https://connector.example.invalid/", connectors: [
      { id: "bot", name: "Delegated Bot", tokenHash: "a".repeat(64), projectIds: ["api", "web"] },
      { id: "other", name: "Other Bot", tokenHash: "b".repeat(64), projectIds: ["api", "web"] },
      { id: "limited", name: "Limited Bot", tokenHash: "c".repeat(64), projectIds: ["api"] },
    ] };
  } });
  const key = randomBytes(32);
  const groups = new ProjectGroupService(h.config, key);
  groups.create({ requestId: randomUUID(), name: "Shop", repos: ["api", "web"] });
  const linear = new LinearService(h.config, key);
  let store: IntakeStore, intake: IntakeService, api: McpRequestService;
  const open = () => {
    store = new IntakeStore(h.config, key);
    intake = new IntakeService(h.config, store, h.missions, new IntakeLinear({ request: async (operation, query, variables) => {
      const result = await linear.request(operation, query, variables);
      if (operation === "InfiniteIntakeLabel") options.afterLabel?.(h.config);
      return result;
    } }), { log: () => {} });
    api = new McpRequestService(h.config, store, intake, h.missions, groups);
  };
  open();
  return { h, groups, linearServer,
    get store() { return store; }, get intake() { return intake; }, get api() { return api; },
    restart() { intake.close(); open(); },
    async close() { intake.close(); linear.close(); h.close(); await linearServer.close(); },
  };
}
const request = (objective = "Update the API and web client") => ({ requestId: randomUUID(), projectId: "shop", objective });
const code = (expected: string) => (error: unknown) => error instanceof McpRequestError && error.code === expected;

test("parallel starts and restart reconcile one sealed request, Linear issue and mission", async () => {
  const ctx = await setup();
  try {
    const input = request("Private execution context should stay sealed");
    const [first, duplicate] = await Promise.all([Promise.resolve().then(() => ctx.api.startRequest("bot", input)), Promise.resolve().then(() => ctx.api.startRequest("bot", input))]);
    assert.deepEqual(first, duplicate);
    assert.deepEqual(first.availableActions, []);
    assert.equal(first.tracking.state, "pending");
    assert.equal(ctx.store.list().length, 1);
    assert.throws(() => ctx.api.startRequest("bot", { ...input, objective: "Different work" }), code("request-conflict"));
    ctx.linearServer.loseNextIssueResponse();
    await ctx.intake.poll();
    ctx.restart();
    const recovered = ctx.api.startRequest("bot", input);
    assert.equal(recovered.runId, first.runId);
    await ctx.intake.poll();
    await ctx.intake.poll();
    assert.equal(ctx.linearServer.allIssues().length, 1);
    assert.equal(ctx.h.missions.list().length, 1);
    assert.equal(ctx.api.getRequest("bot", first.runId).tracking.state, "linked");
    assert.equal(ctx.h.missions.get(first.runId).origin?.source?.id, "bot");
    assert.equal(ctx.h.missions.get(first.runId).objective, input.objective);
    assert.ok(!ctx.linearServer.allIssues()[0].description.includes(input.objective));
    assert.equal(ctx.store.list()[0].missionId, first.runId);
  } finally { await ctx.close(); }
});

test("project discovery and queued mutation are scoped without leaking private records", async () => {
  const ctx = await setup();
  try {
    assert.deepEqual(ctx.api.listProjects("limited"), { projects: [] });
    assert.deepEqual(ctx.api.listProjects("bot"), { projects: [{ id: "shop", name: "Shop" }] });
    assert.throws(() => ctx.api.startRequest("limited", request()), code("request-unavailable"));
    const started = ctx.api.startRequest("bot", request());
    assert.throws(() => ctx.api.getRequest("other", started.runId), code("request-unavailable"));
    assert.throws(() => ctx.api.getRequest("limited", started.runId), code("request-unavailable"));
    await assert.rejects(ctx.api.replyToRequest("bot", { runId: started.runId, requestId: randomUUID(), revision: 1, text: "Continue" }), code("request-not-started"));
    for (const action of ["pause", "resume", "cancel"] as const)
      await assert.rejects(ctx.api.controlRequest("bot", { runId: started.runId, requestId: randomUUID(), revision: 1, action }), code("request-not-started"));
    assert.equal(ctx.h.missions.list().length, 0);
    assert.deepEqual(ctx.api.getRequest("bot", started.runId).availableActions, []);
  } finally { await ctx.close(); }
});

test("revocation and group changes hold queued execution, including after restart with no admission callback", async () => {
  const ctx = await setup();
  try {
    const started = ctx.api.startRequest("bot", request());
    ctx.h.config.mcp!.connectors[0].projectIds = ["api"];
    await ctx.intake.poll();
    assert.equal(ctx.linearServer.allIssues().length, 0, "revoked scope prevents filing");
    assert.throws(() => ctx.api.getRequest("bot", started.runId), code("request-unavailable"));
    ctx.h.config.mcp!.connectors[0].projectIds = ["api", "web"];
    ctx.linearServer.unavailable(true);
    await ctx.intake.poll();
    ctx.linearServer.unavailable(false);
    const group = ctx.groups.get("shop");
    ctx.groups.update("shop", { requestId: randomUUID(), revision: group.revision, repos: ["api"] });
    await ctx.intake.poll();
    assert.equal(ctx.linearServer.allIssues().length, 0, "changed group prevents filing against different repositories");
    const changed = ctx.groups.get("shop");
    ctx.groups.update("shop", { requestId: randomUUID(), revision: changed.revision, repos: ["api", "web"] });
    // With valid current scope, a restarted intake still needs its connector admission service.
    const bareLinear = new LinearService(ctx.h.config, randomBytes(32));
    const bare = new IntakeService(ctx.h.config, ctx.store, ctx.h.missions, new IntakeLinear(bareLinear), { log: () => {} });
    await bare.poll(); bare.close(); bareLinear.close();
    assert.equal(ctx.h.missions.list().length, 0);
    assert.equal(ctx.store.list()[0].state, "queued");
  } finally { await ctx.close(); }
});

test("scope revoked while Linear resolves the label prevents the issue write", async () => {
  const ctx = await setup({ afterLabel: config => { config.mcp!.connectors[0].projectIds = ["api"]; } });
  try {
    ctx.api.startRequest("bot", request());
    await ctx.intake.poll();
    assert.equal(ctx.linearServer.allIssues().length, 0, "authorization is checked after label resolution and before issue creation");
    assert.equal(ctx.h.missions.list().length, 0);
    assert.equal(ctx.store.list()[0].state, "queued");
  } finally { await ctx.close(); }
});

test("a tracked max-active request cannot launch after its connector is removed", async () => {
  const ctx = await setup();
  try {
    const first = ctx.api.startRequest("bot", request());
    await ctx.intake.poll();
    const second = ctx.api.startRequest("bot", request("Second objective"));
    await ctx.intake.poll();
    assert.equal(ctx.api.getRequest("bot", second.runId).tracking.state, "linked");
    assert.equal(ctx.api.getRequest("bot", second.runId).status, "queued");
    await ctx.h.missions.cancel(first.runId, { requestId: randomUUID(), revision: ctx.h.missions.get(first.runId).revision });
    ctx.h.config.mcp!.connectors = ctx.h.config.mcp!.connectors.filter(connector => connector.id !== "bot");
    ctx.restart();
    await ctx.intake.poll();
    assert.equal(ctx.h.missions.peek(second.runId), undefined);
    assert.throws(() => ctx.api.getRequest("bot", second.runId), code("request-unavailable"));
  } finally { await ctx.close(); }
});

test("started replies and controls preserve revision guards and replay receipts across restart", async () => {
  const ctx = await setup();
  try {
    const started = ctx.api.startRequest("bot", request());
    await ctx.intake.poll();
    const initial = ctx.api.getRequest("bot", started.runId);
    const direction = { runId: initial.runId, requestId: randomUUID(), revision: initial.revision!, text: "Use the existing API contract" };
    const [first, duplicate] = await Promise.all([ctx.api.replyToRequest("bot", direction), ctx.api.replyToRequest("bot", direction)]);
    assert.equal(first.revision, initial.revision! + 1);
    assert.equal(duplicate.revision, first.revision);
    assert.equal(ctx.h.missions.get(initial.runId).steering.length, 1);
    ctx.restart();
    assert.equal((await ctx.api.replyToRequest("bot", direction)).revision, first.revision);
    await assert.rejects(ctx.api.replyToRequest("bot", { ...direction, text: "Conflicting content" }), code("request-conflict"));
    await assert.rejects(ctx.api.replyToRequest("bot", { ...direction, requestId: randomUUID() }), code("stale-mission-revision"));
    const pause = { runId: first.runId, requestId: randomUUID(), revision: first.revision!, action: "pause" as const };
    const paused = await ctx.api.controlRequest("bot", pause);
    assert.equal(paused.status, "paused");
    ctx.restart();
    assert.equal((await ctx.api.controlRequest("bot", pause)).revision, paused.revision);
    await assert.rejects(ctx.api.controlRequest("bot", { ...pause, action: "cancel" }), code("request-conflict"));
    assert.equal(ctx.h.missions.get(initial.runId).status, "paused");
    const queuedResume = ctx.api.controlRequest("bot", { runId: paused.runId, requestId: randomUUID(), revision: paused.revision!, action: "resume" });
    ctx.h.config.mcp!.connectors[0].projectIds = ["api"];
    await assert.rejects(queuedResume, code("request-unavailable"));
    assert.equal(ctx.h.missions.get(initial.runId).revision, paused.revision, "revocation inside the mission queue prevents a durable action");
  } finally { await ctx.close(); }
});

test("question IDs and safe views come from the owned mission and result remains an agent report", { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    const started = ctx.api.startRequest("bot", request());
    await ctx.intake.poll();
    await ctx.h.report(1, { kind: "question", question: `Inspect ${ctx.h.config.projects[0].path}/private.txt?`, options: ["Yes", "No"] });
    await waitFor(async () => ctx.h.missions.get(started.runId), mission => mission.status === "needs-input");
    const view = ctx.api.getRequest("bot", started.runId);
    assert.ok(!JSON.stringify(view).includes(ctx.h.config.projects[0].path));
    assert.deepEqual(Object.keys(view.questions[0]).sort(), ["id", "options", "question"]);
    const answer = { runId: view.runId, requestId: randomUUID(), revision: view.revision!, decisionId: view.questions[0].id, text: "Yes" };
    await assert.rejects(ctx.api.replyToRequest("bot", { ...answer, decisionId: randomUUID() }), code("decision-not-found"));
    const accepted = await ctx.api.replyToRequest("bot", answer);
    ctx.restart();
    assert.equal((await ctx.api.replyToRequest("bot", answer)).revision, accepted.revision);
    assert.equal(ctx.h.missions.get(view.runId).decisions[0].answeredBy, "connector");
    await assert.rejects(ctx.api.replyToRequest("bot", { ...answer, requestId: randomUUID() }), code("decision-answered"));
    await ctx.h.report(2, { kind: "dispatch", summary: "Apply the answer", subtasks: [{ id: "api-check", repoProjectId: "api", title: "Inspect API", objective: "Apply the accepted answer", size: "solo", parallelism: 1, dependsOn: [] }] });
    const dispatched = await waitFor(async () => ctx.h.missions.get(view.runId), mission => Boolean(mission.subtasks[0]?.teamId));
    ctx.h.set(dispatched.subtasks[0].teamId!, { status: "ready-for-review" });
    await ctx.h.report(3, { kind: "result", summary: `Inspected ${ctx.h.config.projects[0].path}/private.txt` });
    await waitFor(async () => ctx.h.missions.get(view.runId), mission => mission.status === "ready-for-review");
    const result = ctx.api.getRequest("bot", view.runId);
    assert.equal(result.result?.kind, "agent-report");
    assert.ok(!JSON.stringify(result).includes(ctx.h.config.projects[0].path));
    await ctx.intake.poll();
    const comments = ctx.linearServer.comments(ctx.store.list()[0].issueId);
    assert.ok(comments.every(comment => !comment.body.includes("private.txt")), "tracking receipts must not copy connector context or reports");
  } finally { await ctx.close(); }
});
