import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost, waitFor, type Host } from "./helpers.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamLineup, TeamView } from "../packages/host/src/team-types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { startLinearServer } from "./fixtures/linear-server.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

async function fixture(scenario: string, linear?: Awaited<ReturnType<typeof startLinearServer>>) {
  const root = realpathSync(mkdtempSync("/tmp/inf-goal-"));
  const source = join(root, "source"), receipts = join(root, "receipts");
  mkdirSync(join(source, "features"), { recursive: true }); mkdirSync(receipts, { mode: 0o700 });
  writeFileSync(join(source, "features/progress.json"), '{"completed":0}\n');
  writeFileSync(join(source, "check.mjs"), [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'const progress = JSON.parse(readFileSync("features/progress.json", "utf8"));',
    'assert.deepEqual(Object.keys(progress), ["completed"]);',
    'assert.ok(Number.isInteger(progress.completed) && progress.completed >= 1 && progress.completed <= 2);',
    ...(linear ? ['console.log("PRIVATE_CHECK_OUTPUT " + process.cwd());'] : []),
  ].join("\n"));
  git(source, "init", "--initial-branch=main"); git(source, "add", "features", "check.mjs");
  git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial goal fixture");
  const base = git(source, "rev-parse", "HEAD");
  const apiKeyFile = join(root, "linear-key");
  if (linear) writeFileSync(apiKeyFile, linear.apiKey, { mode: 0o600 });
  let host: Host;
  try {
    host = await startHost({ agents: {
      claude: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), scenario, receipts, "claude"] },
      codex: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), scenario, receipts, "codex"] },
    }, config: {
      teams: { workspaceDir: join(root, "teams"), lineup },
      ...(linear ? { linear: { apiKeyFile, endpoint: linear.endpoint } } : {}),
      projects: [{ id: "rehearsal", name: "Rehearsal", path: source, team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] },
        ...(linear ? { linear: { teamId: linear.teamId } } : {}) }],
    } });
  } catch (error) { rmSync(root, { recursive: true, force: true }); await linear?.close(); throw error; }
  const create = (): CreateGoal => ({ requestId: randomUUID(), projectId: "rehearsal", title: "Improve the progress flow",
    objective: "Build two small progress improvements using the existing data", successCriteria: "Two useful progress steps are available",
    nonGoals: ["Publishing or changing files outside the feature directory"], allowedPaths: ["features"],
    evidence: ["The fixture progress data starts at zero"], maxRuns: 2, maxMinutes: 5, maxMembers: 12, parallelism: 2 });
  const goal = async (id: string): Promise<ProductGoal> => {
    const response = await host.fetchApi(`/goals/${id}`); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  };
  const team = async (id: string): Promise<TeamView> => {
    const response = await host.fetchApi(`/teams/${id}`); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  };
  const settled = (id: string) => waitFor(() => goal(id), value => ["ready-for-review", "no-opportunity", "blocked", "limit-reached"].includes(value.status) && !value.activeTeamId, 90000);
  const held = (id: string) => waitFor(async () => {
    const value = await goal(id);
    const active = value.activeTeamId ? await team(value.activeTeamId) : undefined;
    return { goal: value, team: active };
  }, value => Boolean(value.team?.members.some(member => member.status === "running" && existsSync(join(receipts, `${member.memberId}.json`)))), 30000);
  const close = async () => {
    try {
      for (const value of (await host.fetchApi("/goals")).body.goals ?? [])
        if (value.status !== "cancelled") await host.fetchApi(`/goals/${value.id}/cancel`, "owner", { requestId: randomUUID(), revision: value.revision });
    } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
  };
  return { host, source, receipts, base, create, goal, team, settled, held, close };
}

test("a goal reconciles lost Linear acknowledgements, gathers evidence, escalates scoped work, and chains two reviewed commits without claiming product success", { timeout: 180000 }, async () => {
  const linear = await startLinearServer();
  const f = await fixture("cycles", linear);
  try {
    const request = f.create();
    const me = await f.host.fetchApi("/me");
    assert.equal(me.status, 200);
    for (const secret of [linear.apiKey, f.host.config.linear!.apiKeyFile])
      assert.ok(!JSON.stringify(me.body).includes(secret), "The public configuration must omit the Linear key and its file path");
    assert.equal((await f.host.fetchApi("/goals", "controller", request)).status, 403);
    linear.dropNextResponse("InfiniteLinearIssueCreate");
    const created = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await waitFor(async () => linear.lostResponses.length, count => count === 1, 15000);
    assert.equal(linear.lostResponses[0].id, request.requestId);
    assert.equal(readdirSync(f.receipts).length, 0, "An uncertain issue creation must not admit a provider process");
    await f.host.stopApi(); linear.restore(); await f.host.start();
    const running = await f.held(created.body.id), first = running.team!;
    linear.editIssue(request.requestId, { state: { id: randomUUID(), name: "In Progress", type: "started" } });
    const outcome = { requestId: randomUUID(), revision: 1, result: "achieved", summary: "A user observed the requested outcome", evidence: "A user acceptance exercise confirmed both steps" };
    assert.equal((await f.host.fetchApi(`/goals/${request.requestId}/outcome`, "owner", outcome)).body.code, "goal-still-active");
    await f.host.stopApi(); await f.host.start();
    const retry = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, request.requestId);
    assert.equal(retry.body.activeTeamId, first.id);
    assert.equal((await f.team(first.id)).members.length, 1, "Restart must not duplicate the held coordinator");
    assert.equal((await f.host.fetchApi("/goals", "owner", { ...request, objective: "A different goal" })).status, 409);
    linear.dropNextResponse("InfiniteLinearCommentCreate", "Status: ready-for-review");
    writeFileSync(join(f.receipts, "release-first-plan"), "continue", { mode: 0o600 });
    await waitFor(async () => linear.lostResponses.length, count => count === 2, 60000);
    const lostComment = linear.comments.get(linear.lostResponses[1].id)!;
    assert.equal(lostComment.issue.id, first.id);
    assert.match(lostComment.body, /Status: ready-for-review/);
    await waitFor(async () => linear.calls.some(call => call.operation === "InfiniteLinearComment" && call.variables.filter?.id?.eq === lostComment.id), value => value, 15000);
    const withheld = await f.goal(request.requestId);
    assert.equal(withheld.cycles.length, 1, "An uncertain readiness comment must hold the next feature cycle");
    assert.equal(withheld.activeTeamId, first.id);
    assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 1);
    const admitted = readdirSync(f.receipts).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(f.receipts, name), "utf8")));
    assert.ok(admitted.every(receipt => receipt.runId === first.id), "No provider for a later feature may launch while the ready acknowledgement is unresolved");
    await f.host.stopApi(); linear.restore(); await f.host.start();
    const ready = await f.settled(request.requestId);
    assert.equal(ready.status, "ready-for-review", JSON.stringify(ready));
    assert.equal(ready.outcomes.length, 0, "Code and review evidence cannot establish the product outcome");
    assert.equal(ready.cycles.length, 2);
    const runs = await Promise.all(ready.cycles.map(cycle => f.team(cycle.teamId)));
    assert.ok(runs.every(run => run.status === "ready-for-review" && run.review?.verdict === "approved" && run.checks.length > 0 && run.checks.every(check => check.status === "passed")));
    assert.equal(runs[0].baseCommit, f.base);
    assert.equal(runs[1].baseCommit, runs[0].headCommit);
    assert.equal(runs[1].goal?.parentRunId, runs[0].id);
    assert.deepEqual(runs.map(run => JSON.parse(readFileSync(join(run.workspace, "features/progress.json"), "utf8")).completed), [1, 2]);
    assert.equal(git(runs[1].workspace, "rev-parse", `${runs[1].headCommit}^`), runs[0].headCommit);
    assert.deepEqual(git(runs[1].workspace, "diff", "--name-only", f.base, runs[1].headCommit!).split("\n"), ["features/progress.json"]);
    assert.equal(runs[0].discovery?.tasks.length, 2);
    assert.ok(runs[0].discovery?.tasks.every(task => task.status === "complete" && task.evidence?.length));
    const scouts = runs[0].members.filter(member => member.role === "scout");
    const receipts = scouts.map(member => JSON.parse(readFileSync(join(f.receipts, `${member.memberId}.json`), "utf8")));
    assert.equal(scouts.length, 2);
    assert.ok(Math.max(...receipts.map(value => value.startedAt)) <= Math.min(...receipts.map(value => value.finishedAt)), "Read-only scout processes overlap");
    for (const scout of scouts) assert.equal(git(scout.cwd, "status", "--porcelain"), "");
    assert.equal(runs[0].tasks[0].escalation?.toProfileId, "strong");
    const attempts = runs[0].members.filter(member => member.role === "implementer");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].cwd, attempts[1].cwd);
    assert.deepEqual(attempts.map(member => member.modelProfile?.id), ["light", "strong"]);
    assert.equal(JSON.parse(readFileSync(join(f.receipts, `${attempts[1].memberId}.json`), "utf8")).before.draft, "Step prepared by the light worker");
    assert.equal(ready.memberCount, runs.reduce((sum, run) => sum + run.members.length, 0));
    assert.equal(ready.usage.total.messages, ready.cycles.reduce((sum, cycle) => sum + (cycle.usage?.messages ?? 0), 0));
    assert.equal(ready.usage.unmeasuredMembers, ready.memberCount, "This lineup has no measured provider, so no member may appear as zero cost");
    assert.equal(ready.usage.total.cost, 0);
    assert.equal(runs[1].goal?.maxMembers, request.maxMembers - runs[0].members.length);
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
    assert.equal(git(f.source, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(f.source, "features/progress.json"), "utf8"), '{"completed":0}\n');
    const finalOutcome = { ...outcome, revision: ready.revision };
    assert.equal((await f.host.fetchApi(`/goals/${ready.id}/outcome`, "viewer", finalOutcome)).status, 403);
    const achieved = await f.host.fetchApi(`/goals/${ready.id}/outcome`, "controller", finalOutcome);
    assert.equal(achieved.status, 200, JSON.stringify(achieved.body));
    assert.equal(achieved.body.status, "achieved");
    await f.host.stopApi(); await f.host.start();
    const repeated = await f.host.fetchApi(`/goals/${ready.id}/outcome`, "controller", finalOutcome);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.outcomes.length, 1);
    assert.equal(repeated.body.status, "achieved");
    assert.equal((await f.host.fetchApi(`/goals/${ready.id}/outcome`, "controller", { ...finalOutcome, evidence: "Different evidence" })).status, 409);
    assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 2);
    const synced = await waitFor(async () => ({ goal: await f.goal(ready.id), teams: await Promise.all(ready.cycles.map(cycle => f.team(cycle.teamId))) }),
      value => value.goal.linear?.status === "synced" && value.teams.every(run => run.linear?.status === "synced"), 20000);
    assert.deepEqual([...linear.issues.keys()].sort(), [ready.id, ...ready.cycles.map(cycle => cycle.teamId)].sort());
    assert.equal(synced.goal.linear?.issue?.id, ready.id);
    for (const run of synced.teams) {
      assert.equal(run.linear?.issue?.id, run.id);
      assert.equal(linear.issues.get(run.id)?.parent?.id, ready.id);
      const evidence = [...linear.comments.values()].find(comment => comment.issue.id === run.id && /Status: ready-for-review/.test(comment.body));
      assert.ok(evidence, "Each reviewed feature must deliver its evidence to Linear");
      assert.match(evidence.body, /Checks passed: 1\/1/);
      assert.match(evidence.body, /Independent review: approved/);
    }
    for (const loss of linear.lostResponses)
      assert.equal(linear.calls.filter(call => call.operation === loss.operation && call.variables.input.id === loss.id).length, 1, "A committed write with a lost acknowledgement must reconcile its persisted ID after restart");
    assert.equal(linear.issues.get(ready.id)?.state.name, "In Progress", "A human workflow change must remain intact through subsequent agent admission and review");
    assert.ok(synced.teams.every(run => linear.issues.get(run.id)?.state.type === "unstarted" && linear.issues.get(run.id)?.state.name === "Todo"), "Reviewed code and recorded outcomes must not change the human-owned Linear state");
    const published = JSON.stringify([...linear.issues.values(), ...linear.comments.values()]);
    assert.ok(runs.every(run => run.checks.some(check => check.output.includes("PRIVATE_CHECK_OUTPUT"))), "The configured check must produce private output for the publication boundary to exclude");
    assert.ok(!published.includes("PRIVATE_CHECK_OUTPUT"), "Linear evidence must summarize checks without copying their raw output");
    for (const privateValue of [f.source, f.receipts, f.host.root, linear.apiKey, ...runs.map(run => run.workspace)])
      assert.ok(!published.includes(privateValue), "Linear evidence must omit runtime paths and credentials");
    const providerReceipts = readdirSync(f.receipts).filter(name => name.endsWith(".json"))
      .map(name => readFileSync(join(f.receipts, name), "utf8")).join("\n");
    for (const secret of [linear.apiKey, f.host.config.linear!.apiKeyFile])
      assert.ok(!providerReceipts.includes(secret), "Provider prompts and assignments must not receive the Linear credential");
    assert.deepEqual(linear.violations, []);
  } finally { try { await f.close(); } finally { await linear.close(); } }
});

test("a goal with no justified change records evidence without starting implementation or claiming success", { timeout: 45000 }, async () => {
  const f = await fixture("no-change");
  try {
    const created = await f.host.fetchApi("/goals", "owner", { ...f.create(), maxRuns: 3 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const stopped = await f.settled(created.body.id);
    assert.equal(stopped.status, "no-opportunity", JSON.stringify(stopped));
    assert.equal(stopped.cycles.length, 1);
    assert.equal(stopped.outcomes.length, 0);
    const run = await f.team(stopped.cycles[0].teamId);
    assert.equal(run.status, "no-change");
    assert.equal(run.noChange?.evidence[0].source, "features/progress.json");
    assert.equal(run.members.length, 1);
    assert.equal(run.tasks.length, 0); assert.equal(run.checks.length, 0); assert.equal(run.review, undefined);
    assert.equal(run.headCommit, f.base);
    assert.equal(git(run.workspace, "status", "--porcelain"), "");
    assert.equal((await f.host.fetchApi(`/goals/${stopped.id}/resume`, "owner", { requestId: randomUUID(), revision: stopped.revision })).status, 409);
  } finally { await f.close(); }
});

test("Linear edits, closure, and missing issues block provider launches and preserve bounded refresh after restart", { timeout: 120000 }, async () => {
  for (const change of ["edited", "closed", "missing"] as const) {
    const linear = await startLinearServer();
    const linked = linear.seedIssue({ title: "Improve the progress flow", description: "Build only the approved scoped progress steps" });
    const f = await fixture("cycles", linear);
    try {
      const request = { ...f.create(), linearIssueId: change === "edited" ? linked.identifier : linked.id };
      const created = await f.host.fetchApi("/goals", "owner", request);
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const held = await f.held(request.requestId), first = held.team!;
      assert.equal(first.members.length, 1);
      assert.equal(held.goal.linear?.issue?.id, linked.id, "Both identifiers and UUIDs must bind the canonical issue");
      assert.equal(first.linear?.issue?.id, first.id);
      const snapshots = { objective: held.goal.objective, allowedPaths: held.goal.allowedPaths };
      if (change === "edited") linear.editIssue(linked.id, { description: "Also change files outside the approved feature directory" });
      else if (change === "closed") linear.editIssue(linked.id, { state: { id: randomUUID(), name: "Done", type: "completed" } });
      else linear.issues.delete(linked.id);
      // The coordinator's next report requests two scouts. Their admission must
      // recheck Linear even though the ordinary refresh interval has not elapsed.
      writeFileSync(join(f.receipts, "release-first-plan"), "continue", { mode: 0o600 });
      const blocked = await waitFor(async () => ({ goal: await f.goal(request.requestId), team: await f.team(first.id) }),
        value => value.goal.status === "blocked" && value.goal.linear?.status === "blocked"
          && value.team.members.every(member => ["stopped", "waiting"].includes(member.status)), 30000);
      assert.equal(blocked.goal.cycles.length, 1);
      assert.deepEqual({ objective: blocked.goal.objective, allowedPaths: blocked.goal.allowedPaths }, snapshots, "Remote edits cannot expand the local approval");
      assert.equal(blocked.team.members.filter(member => member.startedAt).length, 1);
      assert.equal(blocked.team.checks.length, 0);
      assert.equal(blocked.team.review, undefined);
      const parentReads = () => linear.calls.filter(call => call.operation === "InfiniteLinearIssues" && call.variables.filter?.id?.in?.includes(linked.id)).length;
      await f.host.stopApi();
      const beforeRestart = parentReads();
      await f.host.start();
      const recovered = await f.goal(request.requestId);
      assert.equal(recovered.status, "blocked");
      assert.equal(recovered.linear?.status, "blocked");
      assert.equal(recovered.cycles.length, 1);
      if (change === "missing") {
        await waitFor(async () => { await f.goal(request.requestId); return parentReads(); }, count => count > beforeRestart, 5000);
        const observed = parentReads(), until = Date.now() + 1600;
        // Exercise repeated UI reads across more than three bridge pump slots.
        // A confirmed absence is fresh evidence, not a reason to poll forever.
        while (Date.now() < until) {
          await f.goal(request.requestId); await f.team(first.id);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(parentReads(), observed, "A confirmed missing issue must not be fetched again on every pump while the UI reads its blocked state");
      }
      const receipts = readdirSync(f.receipts).filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(readFileSync(join(f.receipts, name), "utf8")));
      assert.deepEqual(receipts.map(receipt => receipt.role), ["project-manager"], "No scout, implementer, or later coordinator process may launch after the Linear gate closes");
      assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 1);
      assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
      assert.equal(git(f.source, "status", "--porcelain"), "");
      assert.deepEqual(linear.violations, []);
    } finally { try { await f.close(); } finally { await linear.close(); } }
  }
});

test("goal scope and required UI evidence block plans or approvals at their real execution boundaries", { timeout: 90000 }, async () => {
  for (const scenario of ["scope", "ui-evidence"]) {
    const f = await fixture(scenario);
    try {
      const created = await f.host.fetchApi("/goals", "owner", f.create());
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const stopped = await f.settled(created.body.id);
      assert.equal(stopped.status, "blocked", JSON.stringify(stopped));
      assert.equal(stopped.cycles.length, 1);
      const run = await f.team(stopped.cycles[0].teamId);
      assert.equal(run.review, undefined);
      if (scenario === "scope") {
        assert.match(run.reason ?? "", /outside the approved goal scope/);
        assert.equal(run.members.length, 1); assert.equal(run.tasks.length, 0); assert.equal(run.checks.length, 0);
      } else {
        assert.match(run.reason ?? "", /Approval of UI changes requires/);
        assert.equal(run.brief?.uiChanges, true);
        assert.ok(run.checks.length > 0 && run.checks.every(check => check.status === "passed"));
        assert.equal(run.members.find(member => member.role === "reviewer")?.report?.kind, "review");
      }
      assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
      assert.equal(git(f.source, "status", "--porcelain"), "");
    } finally { await f.close(); }
  }
});

test("goal pause and cancellation survive restart without allowing child controls or another feature launch", { timeout: 60000 }, async () => {
  const f = await fixture("cycles");
  try {
    const request = f.create();
    const created = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const held = await f.held(created.body.id), child = held.team!;
    for (const action of ["pause", "resume", "cancel", "steer"]) {
      const denied = await f.host.fetchApi(`/teams/${child.id}/${action}`, "owner", { requestId: randomUUID(), revision: child.revision,
        ...(action === "steer" ? { text: "Bypass the goal" } : {}) });
      assert.equal(denied.status, 409); assert.equal(denied.body.code, "goal-owned-team");
    }
    const pause = { requestId: randomUUID(), revision: held.goal.revision };
    const paused = await f.host.fetchApi(`/goals/${request.requestId}/pause`, "owner", pause);
    assert.equal(paused.status, 200);
    await waitFor(() => f.team(child.id), run => run.status === "paused" && run.reason === undefined && run.members.every(member => member.status === "stopped"), 15000);
    await f.host.stopApi(); await f.host.start();
    const recovered = await f.host.fetchApi(`/goals/${request.requestId}/pause`, "owner", pause);
    assert.equal(recovered.status, 200); assert.equal(recovered.body.status, "paused");
    assert.equal(recovered.body.cycles.length, 1);
    const cancel = { requestId: randomUUID(), revision: recovered.body.revision };
    assert.equal((await f.host.fetchApi(`/goals/${request.requestId}/cancel`, "owner", cancel)).status, 200);
    await waitFor(() => f.goal(request.requestId), goal => goal.status === "cancelled" && !goal.activeTeamId, 15000);
    writeFileSync(join(f.receipts, "release-first-plan"), "continue", { mode: 0o600 });
    await f.host.stopApi(); await f.host.start();
    const repeated = await f.host.fetchApi(`/goals/${request.requestId}/cancel`, "owner", cancel);
    assert.equal(repeated.status, 200); assert.equal(repeated.body.status, "cancelled");
    assert.equal(repeated.body.cycles.length, 1);
    assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 1);
    assert.equal((await f.team(child.id)).members.length, 1);
    assert.equal((await f.host.fetchApi(`/goals/${request.requestId}/resume`, "owner", { requestId: randomUUID(), revision: repeated.body.revision })).status, 409);
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  } finally { await f.close(); }
});

test("goal budgets stop every worker and prevent further work when attempts are exhausted or a saved deadline expires during downtime", { timeout: 120000 }, async () => {
  for (const budget of ["member-limit", "deadline"] as const) {
    const f = await fixture("cycles");
    try {
      const request = { ...f.create(), maxMembers: budget === "member-limit" ? 4 : 12 };
      const created = await f.host.fetchApi("/goals", "owner", request);
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const held = await f.held(request.requestId), child = held.team!;
      assert.equal(child.members.length, 1);
      assert.equal(child.members[0].role, "project-manager");
      if (budget === "member-limit") {
        writeFileSync(join(f.receipts, "release-first-plan"), "continue", { mode: 0o600 });
      } else {
        await f.host.stopApi();
        const key = readFileSync(f.host.config.keyFile);
        const file = join(f.host.config.stateDir, "goals", `${request.requestId}.sealed`);
        const scope = `goal:${request.requestId}`;
        const stored = unseal<{ goal: ProductGoal }>(key, scope, readFileSync(file, "utf8"));
        // Recover an elapsed persisted deadline without waiting five minutes or
        // changing the live worker's still-future execution deadline.
        stored.goal.deadlineAt = new Date(Date.now() - 1000).toISOString();
        writeSealed(file, key, scope, stored);
        await f.host.start();
      }
      const stopped = await f.settled(request.requestId);
      const run = await f.team(child.id);
      const expectedRoles = budget === "member-limit" ? ["project-manager", "project-manager", "scout", "scout"] : ["project-manager"];
      assert.equal(stopped.status, "limit-reached", JSON.stringify(stopped));
      assert.equal(stopped.activeTeamId, undefined);
      assert.equal(stopped.cycles.length, 1);
      assert.equal(stopped.memberCount, expectedRoles.length);
      assert.equal(stopped.outcomes.length, 0);
      assert.deepEqual(run.members.map(member => member.role).sort(), expectedRoles);
      assert.ok(run.members.every(member => member.status === "stopped"));
      assert.equal(run.checks.length, 0); assert.equal(run.review, undefined);
      assert.equal(run.headCommit, f.base);
      const receipts = readdirSync(f.receipts).filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(readFileSync(join(f.receipts, name), "utf8")));
      assert.deepEqual(receipts.map(receipt => receipt.role).sort(), expectedRoles, "Every admitted attempt must correspond to an actual worker process");
      for (const member of run.members) {
        const session = await f.host.fetchApi(`/sessions/${member.sessionId}`);
        assert.equal(session.status, 200, JSON.stringify(session.body));
        assert.equal(session.body.status, "exited", "A cleared active team must not leave its worker running");
      }
      if (budget === "member-limit") {
        assert.equal(run.stopReason, "member-limit");
        assert.ok(run.discovery?.tasks.every(task => task.status === "complete"));
        assert.equal(run.tasks.length, 1);
        assert.equal(run.tasks[0].status, "pending", "Scouts and both coordinators consume the budget before implementation");
      } else {
        assert.equal(run.status, "cancelled");
        assert.equal(run.goal?.deadlineAt, child.goal?.deadlineAt);
        assert.ok(Date.parse(run.goal!.deadlineAt) > Date.now(), "The Goal service must enforce its saved deadline independently of the child deadline");
        assert.equal(run.members[0].report, undefined);
        assert.equal(run.tasks.length, 0);
      }
      await f.host.stopApi(); await f.host.start();
      const recovered = await f.goal(request.requestId);
      assert.equal(recovered.status, "limit-reached");
      assert.equal(recovered.activeTeamId, undefined);
      assert.equal(recovered.cycles.length, 1);
      assert.equal(recovered.memberCount, expectedRoles.length);
      assert.equal(recovered.outcomes.length, 0);
      assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 1);
      assert.equal((await f.team(child.id)).members.length, expectedRoles.length);
      assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
      assert.equal(git(f.source, "status", "--porcelain"), "");
    } finally { await f.close(); }
  }
});
