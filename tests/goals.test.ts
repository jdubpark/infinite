import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { startHost, waitFor, type Host } from "./helpers.js";
import { createGoalSchema, type CreateGoal, type ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamLineup, TeamView } from "../packages/host/src/team-types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { startLinearServer } from "./fixtures/linear-server.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { GoalService } from "../packages/host/src/goals.js";
import { TeamError } from "../packages/host/src/teams.js";

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
  const bootstrapGoal = scenario === "bootstrap-goal";
  try {
    host = await startHost({ agents: {
      claude: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), scenario, receipts, "claude"] },
      codex: { command: process.execPath, args: [resolve("tests/fixtures/goal-agent.mjs"), scenario, receipts, "codex"] },
    }, config: {
      teams: { workspaceDir: join(root, "teams"), lineup },
      ...(linear ? { linear: { apiKeyFile, endpoint: linear.endpoint } } : {}),
      projects: [{ id: "rehearsal", name: "Rehearsal", path: source, team: bootstrapGoal
        ? { checks: [], establishChecks: true }
        : { checks: [{ command: process.execPath, args: ["check.mjs"] }], ...(scenario === "delivery" ? { delivery: { mode: "merge" as const, repository: "example/app", baseBranch: "main", mergeMethod: "squash" as const } } : {}) },
        ...(linear ? { linear: { teamId: linear.teamId } } : {}) }],
    } });
  } catch (error) { rmSync(root, { recursive: true, force: true }); await linear?.close(); throw error; }
  const create = (): CreateGoal => ({ requestId: randomUUID(), projectId: "rehearsal", title: "Improve the progress flow",
    objective: "Build two small progress improvements using the existing data", successCriteria: "Two useful progress steps are available",
    nonGoals: [scenario === "delivery" ? "Changing files outside the feature directory" : "Publishing or changing files outside the feature directory"], allowedPaths: ["features"],
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
    // Serve the fixture's parent as the sync home and enroll a sibling teamwork folder through the API.
    const teamworkRoot = join(dirname(f.source), "teamwork");
    f.host.config.sync = { homeDir: dirname(f.source) };
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    const enrollment = (await f.host.fetchApi(`/projects/${f.host.config.projects[0].id}/team`, "owner")).body;
    const enrolled = await f.host.fetchApi(`/projects/${f.host.config.projects[0].id}/team`, "owner", { requestId: randomUUID(), revision: enrollment.revision, team: enrollment.team, teamwork: "teamwork" }, {}, "PUT");
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
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
    assert.ok(runs.every(run => run.workspace.startsWith(`${teamworkRoot}/`)), "Both the original run and goal continuation stay under the enrolled teamwork root");
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
    assert.ok(ready.cycles.length > 0 && ready.cycles.every(cycle => cycle.usage === undefined), "A cycle with no measured member carries no usage figure");
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

test("goal cycles retain their accepted verification when project configuration changes before continuation", { timeout: 120000 }, async () => {
  const f = await fixture("bootstrap-goal");
  try {
    const request = f.create();
    const created = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const held = await waitFor(async () => {
      const goal = await f.goal(request.requestId);
      const team = goal.activeTeamId ? await f.team(goal.activeTeamId) : undefined;
      return { goal, team };
    }, value => Boolean(value.team?.tasks.length && value.team.members.some(member => member.role === "implementer" && member.status === "running")), 30000);
    const first = held.team!;
    const accepted = first.verification;
    assert.ok(accepted?.checks?.length);
    assert.equal(first.establishChecks, true);

    f.host.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["check.mjs"] }] };
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.stopApi(); await f.host.start();
    assert.deepEqual((await f.team(first.id)).verification, accepted);
    writeFileSync(join(f.receipts, "release-first-implementation"), "continue", { mode: 0o600 });

    const finished = await f.settled(request.requestId);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.cycles.length, 2);
    const runs = await Promise.all(finished.cycles.map(cycle => f.team(cycle.teamId)));
    assert.deepEqual(runs[0].verification, accepted);
    assert.deepEqual(runs[1].verification, accepted);
    assert.equal(runs[1].establishChecks, true);
    assert.ok(runs.every(run => run.status === "ready-for-review" && run.review?.verdict === "approved"
      && run.checks.some(check => check.status === "passed")));
    assert.equal(runs[1].goal?.parentRunId, runs[0].id);
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

test("goal time ceilings must cover the time limit, and extensions default off", () => {
  const base = { requestId: randomUUID(), projectId: "rehearsal", title: "Improve", objective: "Improve progress", successCriteria: "Progress moves", allowedPaths: ["features"], maxMinutes: 60 };
  assert.throws(() => createGoalSchema.parse({ ...base, maxTotalMinutes: 30 }), /ceiling cannot be shorter/);
  const plain = createGoalSchema.parse(base);
  assert.equal(plain.extendMinutes, undefined);
  assert.equal("extendMinutes" in plain, false, "Legacy parsed requests keep their original fingerprint shape");
  assert.equal(plain.maxTotalMinutes, undefined);
  assert.equal(createGoalSchema.parse({ ...base, maxTotalMinutes: 60, extendMinutes: 15 }).extendMinutes, 15);
  assert.throws(() => createGoalSchema.parse({ ...base, extendMinutes: 241 }));
});

test("a legacy create fingerprint replays when extendMinutes is omitted", { timeout: 60000 }, async () => {
  const f = await fixture("cycles");
  try {
    const request = f.create(), created = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await f.host.stopApi();
    const key = readFileSync(f.host.config.keyFile), scope = `goal:${request.requestId}`;
    const file = join(f.host.config.stateDir, "goals", `${request.requestId}.sealed`);
    const stored = unseal<{ fingerprint: string }>(key, scope, readFileSync(file, "utf8"));
    stored.fingerprint = createHash("sha256").update(JSON.stringify(createGoalSchema.parse(request))).digest("hex");
    writeSealed(file, key, scope, stored);
    await f.host.start();
    const replay = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.id, request.requestId);
  } finally { await f.close(); }
});

test("an extension policy extends an active goal only while its team shows activity, stops at the ceiling, and an owner can extend a stopped goal", { timeout: 180000 }, async () => {
  const f = await fixture("cycles");
  try {
    const request = { ...f.create(), maxMinutes: 5, extendMinutes: 5, maxTotalMinutes: 60 };
    const created = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const held = await f.held(request.requestId), child = held.team!;
    const key = readFileSync(f.host.config.keyFile);
    const goalScope = `goal:${request.requestId}`, goalFile = join(f.host.config.stateDir, "goals", `${request.requestId}.sealed`);
    const teamScope = `team:${child.id}`, teamFile = join(f.host.config.stateDir, "teams", `${child.id}.sealed`);
    // Recreate a team deadline that auto-extended before GoalService mirrored it.
    await f.host.stopApi();
    const priorGoal = unseal<{ goal: ProductGoal }>(key, goalScope, readFileSync(goalFile, "utf8"));
    const priorTeam = unseal<{ run: { goal: { deadlineAt: string; ceilingAt?: string } } }>(key, teamScope, readFileSync(teamFile, "utf8"));
    const goalDeadline = new Date(Date.now() + 10 * 60000).toISOString();
    const teamDeadline = new Date(Date.now() + 20 * 60000).toISOString();
    const teamCeiling = new Date(Date.now() + 60 * 60000).toISOString();
    priorGoal.goal.deadlineAt = goalDeadline; priorGoal.goal.ceilingAt = teamCeiling;
    priorTeam.run.goal.deadlineAt = teamDeadline; priorTeam.run.goal.ceilingAt = teamCeiling;
    writeSealed(goalFile, key, goalScope, priorGoal); writeSealed(teamFile, key, teamScope, priorTeam);
    await f.host.start();
    const manual = { requestId: randomUUID(), revision: created.body.revision, minutes: 30 };
    const manualExtension = await f.host.fetchApi(`/goals/${request.requestId}/extend`, "owner", manual);
    assert.equal(manualExtension.status, 200, JSON.stringify(manualExtension.body));
    const extendedTeam = await f.team(child.id);
    assert.ok(Date.parse(manualExtension.body.deadlineAt) >= Date.parse(teamDeadline) + 30 * 60000, "Owner time starts after the later team deadline");
    assert.equal(manualExtension.body.deadlineAt, extendedTeam.goal!.deadlineAt, "Goal and team retain the same effective extension");
    // Move both saved deadlines into the past while the held member is still running.
    const expire = async (ceilingAt?: string) => {
      await f.host.stopApi();
      const past = new Date(Date.now() - 1000).toISOString();
      const storedGoal = unseal<{ goal: ProductGoal }>(key, goalScope, readFileSync(goalFile, "utf8"));
      storedGoal.goal.deadlineAt = past; if (ceilingAt) storedGoal.goal.ceilingAt = ceilingAt;
      writeSealed(goalFile, key, goalScope, storedGoal);
      const storedTeam = unseal<{ run: { goal: { deadlineAt: string; ceilingAt?: string } } }>(key, teamScope, readFileSync(teamFile, "utf8"));
      storedTeam.run.goal.deadlineAt = past; if (ceilingAt) storedTeam.run.goal.ceilingAt = ceilingAt;
      writeSealed(teamFile, key, teamScope, storedTeam);
      await f.host.start();
    };
    await expire();
    const extended = await waitFor(() => f.team(child.id), run => Date.parse(run.goal!.deadlineAt) > Date.now(), 30000);
    assert.notEqual(extended.status, "blocked", JSON.stringify(extended));
    assert.ok(extended.events.some(event => event.text.includes("extension policy")), JSON.stringify(extended.events));
    const following = await waitFor(() => f.goal(request.requestId), value => value.status === "running" && value.deadlineAt === extended.goal!.deadlineAt, 30000);
    assert.ok(following.events.some(event => event.text.includes("extended the time limit")), "The goal must record the team's extension");

    // A non-owner cannot extend, even a stopped goal.
    await expire(new Date(Date.now() - 1000).toISOString());
    const stopped = await f.settled(request.requestId);
    assert.equal(stopped.status, "limit-reached", JSON.stringify(stopped));
    assert.equal(stopped.stopReason, "deadline");
    // A team-origin deadline may leave a different display reason; structured state governs eligibility.
    await f.host.stopApi();
    const stoppedRecord = unseal<{ goal: ProductGoal }>(key, goalScope, readFileSync(goalFile, "utf8"));
    stoppedRecord.goal.reason = "The active team reached its deadline.";
    writeSealed(goalFile, key, goalScope, stoppedRecord);
    const lastTeamId = stopped.cycles.at(-1)!.teamId, lastTeamScope = `team:${lastTeamId}`;
    const lastTeamFile = join(f.host.config.stateDir, "teams", `${lastTeamId}.sealed`);
    const stoppedTeam = unseal<{ run: { stopReason?: string } }>(key, lastTeamScope, readFileSync(lastTeamFile, "utf8"));
    stoppedTeam.run.stopReason = "deadline";
    writeSealed(lastTeamFile, key, lastTeamScope, stoppedTeam);
    await f.host.start();
    const body = { requestId: randomUUID(), revision: stopped.revision, minutes: 30 };
    assert.equal((await f.host.fetchApi(`/goals/${request.requestId}/extend`, "controller", body)).status, 403);
    const owner = await f.host.fetchApi(`/goals/${request.requestId}/extend`, "owner", body);
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    assert.equal(owner.body.status, "running");
    assert.ok(Date.parse(owner.body.deadlineAt) > Date.now());
    assert.ok(Date.parse(owner.body.ceilingAt) >= Date.parse(owner.body.deadlineAt), "The owner extension must raise the ceiling to cover the new deadline");
    assert.ok(owner.body.events.some(event => event.text === "The owner extended the time limit by 30 minutes."));
    const replay = await f.host.fetchApi(`/goals/${request.requestId}/extend`, "owner", body);
    assert.equal(replay.status, 200, "An identical extension retry is acknowledged without a second extension");
    assert.equal(replay.body.revision, owner.body.revision);
  } finally { await f.close(); }
});

test("a deadline-stopped child resumes the goal in a new cycle after an owner extends during shutdown", { timeout: 120000 }, async () => {
  const f = await fixture("goal-slow-stop");
  try {
    const request = f.create(), created = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const held = await f.held(request.requestId), child = held.team!;
    const key = readFileSync(f.host.config.keyFile), goalScope = `goal:${request.requestId}`, teamScope = `team:${child.id}`;
    const goalFile = join(f.host.config.stateDir, "goals", `${request.requestId}.sealed`), teamFile = join(f.host.config.stateDir, "teams", `${child.id}.sealed`);
    await f.host.stopApi();
    const storedGoal = unseal<{ goal: ProductGoal }>(key, goalScope, readFileSync(goalFile, "utf8"));
    const storedTeam = unseal<{ run: { status: string; reason?: string; goal: { deadlineAt: string; ceilingAt?: string } }; halt?: string }>(key, teamScope, readFileSync(teamFile, "utf8"));
    storedGoal.goal.deadlineAt = new Date(Date.now() - 1000).toISOString();
    storedGoal.goal.status = "limit-reached"; storedGoal.goal.stopReason = "deadline"; storedGoal.goal.deadlineContinuation = true;
    storedGoal.goal.reason = "The approved time limit has expired.";
    storedTeam.run.status = "cancelled"; storedTeam.run.reason = "The goal reached its deadline."; storedTeam.halt = "cancel";
    storedTeam.run.goal.deadlineAt = storedGoal.goal.deadlineAt;
    writeSealed(goalFile, key, goalScope, storedGoal); writeSealed(teamFile, key, teamScope, storedTeam);
    await f.host.start();
    const stopping = await waitFor(() => f.goal(request.requestId), value => value.status === "limit-reached" && value.activeTeamId === child.id, 15000);
    assert.equal(stopping.stopReason, "deadline");
    const action = { requestId: randomUUID(), revision: stopping.revision, minutes: 30 };
    const extended = await f.host.fetchApi(`/goals/${request.requestId}/extend`, "owner", action);
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    assert.equal(extended.body.status, "running");
    assert.equal(extended.body.deadlineContinuation, true);
    const continued = await waitFor(() => f.goal(request.requestId), value => value.cycles.length === 2 && value.activeTeamId !== child.id, 30000);
    assert.equal(continued.cycles[0].teamId, child.id);
    assert.ok(continued.activeTeamId, "A fresh team cycle replaces the cancelled child");
  } finally { await f.close(); }
});

test("paused goals mirror a later team deadline before checking expiry", { timeout: 90000 }, async () => {
  const f = await fixture("cycles");
  try {
    const request = f.create(), created = await f.host.fetchApi("/goals", "owner", request);
    const held = await f.held(request.requestId), child = held.team!;
    const pause = await f.host.fetchApi(`/goals/${request.requestId}/pause`, "owner", { requestId: randomUUID(), revision: created.body.revision });
    assert.equal(pause.status, 200, JSON.stringify(pause.body));
    await waitFor(async () => ({ goal: await f.goal(request.requestId), team: await f.team(child.id) }), value => value.goal.status === "paused" && value.team.status === "paused", 15000);
    const key = readFileSync(f.host.config.keyFile), goalScope = `goal:${request.requestId}`, teamScope = `team:${child.id}`;
    const goalFile = join(f.host.config.stateDir, "goals", `${request.requestId}.sealed`), teamFile = join(f.host.config.stateDir, "teams", `${child.id}.sealed`);
    await f.host.stopApi();
    const storedGoal = unseal<{ goal: ProductGoal }>(key, goalScope, readFileSync(goalFile, "utf8"));
    const storedTeam = unseal<{ run: { goal: { deadlineAt: string; ceilingAt?: string; extendMinutes?: number } } }>(key, teamScope, readFileSync(teamFile, "utf8"));
    storedGoal.goal.deadlineAt = new Date(Date.now() - 1000).toISOString();
    storedGoal.goal.extendMinutes = 5;
    const teamDeadline = new Date(Date.now() + 20 * 60000).toISOString(), ceilingAt = new Date(Date.now() + 60 * 60000).toISOString();
    storedGoal.goal.ceilingAt = ceilingAt;
    storedTeam.run.goal.deadlineAt = teamDeadline; storedTeam.run.goal.extendMinutes = 5; storedTeam.run.goal.ceilingAt = ceilingAt;
    writeSealed(goalFile, key, goalScope, storedGoal); writeSealed(teamFile, key, teamScope, storedTeam);
    await f.host.start();
    const mirrored = await waitFor(() => f.goal(request.requestId), value => Date.parse(value.deadlineAt) > Date.now(), 15000);
    assert.equal(mirrored.status, "paused");
    assert.equal(mirrored.deadlineAt, teamDeadline);
    assert.equal((await f.team(child.id)).status, "paused", "Expiry must not cancel the later-deadline paused team");
  } finally { await f.close(); }
});

function extensionFixture() {
  const f = schedulerFixture(), at = new Date().toISOString();
  const goal: ProductGoal = { id: randomUUID(), projectId: f.run.projectId, title: "Inspect the fixture", objective: "Choose scoped work",
    successCriteria: "The owner has evidence", nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 2, maxMinutes: 60,
    maxMembers: 4, parallelism: 1, revision: 1, status: "running", createdAt: at, updatedAt: at,
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), lineup, activeTeamId: f.run.id, memberCount: 1,
    cycles: [{ teamId: f.run.id, cycle: 1, goalRevision: 1, status: "planning", startedAt: at, memberCount: 1 }],
    steering: [], events: [], outcomes: [] };
  f.run.goal = { id: goal.id, revision: 1, cycle: 1, successCriteria: goal.successCriteria, nonGoals: [], allowedPaths: ["."], evidence: [], previousWork: [], deadlineAt: goal.deadlineAt, maxMembers: 1 };
  const request = { requestId: randomUUID(), revision: 1, minutes: 30 };
  const intent = { ...request, fingerprint: createHash("sha256").update(JSON.stringify({ action: "extend", ...request })).digest("hex"), teamId: f.run.id };
  return { ...f, goal, request, intent,
    writeGoal: (extra: object = {}) => f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture", ...extra }),
  };
}

for (const recovering of [false, true])
test(`a member-limit extension rejection ${recovering ? "during recovery" : "reaches its caller and"} cannot strand a cancelled goal`, async () => {
  const f = extensionFixture();
  let goals: GoalService | undefined;
  try {
    // The child stopped before the goal reflected the member limit.
    f.run.status = "blocked"; f.run.stopReason = "member-limit"; f.run.members[0].status = "stopped";
    f.writeTeam(); f.writeGoal(recovering ? { extensionIntent: f.intent } : {});
    const teams = f.openTeam();
    goals = new GoalService(f.config, f.key, teams);
    if (!recovering) {
      await assert.rejects(goals.extend(f.goal.id, f.request), (error: unknown) => error instanceof TeamError && error.code === "team-stopped-at-limit");
      assert.equal(f.readRecord<{ extensionIntent?: unknown }>("goal", f.goal.id).extensionIntent, undefined);
    }
    await goals.cancel(f.goal.id, { requestId: randomUUID(), revision: 1 });
    goals.start();
    const reconciled = await waitFor(async () => goals!.get(f.goal.id), goal => !goal.activeTeamId);
    assert.equal(reconciled.status, "cancelled");
    assert.equal(reconciled.cycles[0].status, "blocked");
    assert.ok(reconciled.events.some(event => /extension.*rejected/i.test(event.text)));
    if (!recovering) assert.ok(reconciled.events.some(event => /extension.*member limit/i.test(event.text)));
    assert.equal(f.readRecord<{ extensionIntent?: unknown }>("goal", f.goal.id).extensionIntent, undefined);
  } finally { goals?.close(); f.close(); }
});

test("an applied extension receipt replays after the child reaches its member limit", async () => {
  const f = extensionFixture();
  let goals: GoalService | undefined;
  try {
    f.writeTeam(); f.writeGoal({ extensionIntent: f.intent });
    const teams = f.openTeam();
    const receipt = await teams.extendGoalTime(f.run.id, f.request.requestId, f.request.minutes, f.goal.deadlineAt, f.goal.deadlineAt);
    teams.close();
    // Crash after the real team receipt was saved but before the goal acknowledged it.
    const stored = f.readRecord<{ run: TeamView }>("team", f.run.id);
    stored.run.status = "blocked"; stored.run.stopReason = "member-limit"; stored.run.members[0].status = "stopped";
    f.writeRecord("team", f.run.id, stored);
    const restored = f.openTeam();
    goals = new GoalService(f.config, f.key, restored); goals.start();
    const recovered = await waitFor(async () => goals!.get(f.goal.id), goal => goal.revision === 2 && !goal.activeTeamId);
    assert.equal(recovered.status, "limit-reached");
    assert.equal(recovered.deadlineAt, receipt.deadlineAt);
    assert.equal(restored.get(f.run.id).goal!.deadlineAt, receipt.deadlineAt);
    const replay = await goals.extend(f.goal.id, f.request);
    assert.equal(replay.deadlineAt, receipt.deadlineAt);
    assert.equal(replay.events.filter(event => event.text === "The owner extended the time limit by 30 minutes.").length, 1);
  } finally { goals?.close(); f.close(); }
});

for (const failedWrite of ["team", "goal"] as const)
test(`an extension cannot acknowledge an unpersisted ${failedWrite} receipt after a failed save`, async t => {
  const f = extensionFixture();
  let goals: GoalService | undefined, unblock: (() => void) | undefined;
  try {
    f.writeTeam(); f.writeGoal();
    const teams = f.openTeam(), extend = teams.extendGoalTime.bind(teams);
    const interrupted = failedWrite === "goal" ? t.mock.method(teams, "extendGoalTime", async (...args: Parameters<typeof extend>) => {
      const result = await extend(...args);
      unblock = f.blockRecordWrites("goal", f.goal.id);
      return result;
    }) : undefined;
    if (failedWrite === "team") unblock = f.blockRecordWrites("team", f.run.id);
    goals = new GoalService(f.config, f.key, teams);
    await assert.rejects(goals.extend(f.goal.id, f.request));
    unblock!(); unblock = undefined; interrupted?.mock.restore();
    const retried = await goals.extend(f.goal.id, f.request);
    assert.ok(Date.parse(retried.deadlineAt) > Date.parse(f.goal.deadlineAt));
    const durableTeam = f.readRecord<{ run: TeamView }>("team", f.run.id);
    const durableGoal = f.readRecord<{ goal: ProductGoal; receipts: Record<string, string>; extensionIntent?: unknown }>("goal", f.goal.id);
    assert.equal(durableTeam.run.goal!.deadlineAt, retried.deadlineAt, "A successful retry must survive a team restart");
    assert.equal(durableGoal.goal.deadlineAt, retried.deadlineAt, "A successful retry must survive a goal restart");
    assert.equal(durableGoal.receipts[f.request.requestId], f.intent.fingerprint);
    assert.equal(durableGoal.extensionIntent, undefined);
  } finally { unblock?.(); goals?.close(); f.close(); }
});

for (const action of ["pause", "steer", "cancel"] as const)
for (const applied of [false, true])
test(`extension recovery after ${action} ${applied ? "reconciles an applied receipt" : "rejects unapplied stale work"}`, async t => {
  const f = extensionFixture();
  let goals: GoalService | undefined;
  try {
    f.writeTeam(); f.writeGoal();
    const teams = f.openTeam(), extend = teams.extendGoalTime.bind(teams);
    const interrupted = t.mock.method(teams, "extendGoalTime", async (...args: Parameters<typeof extend>) => {
      if (applied) await extend(...args);
      throw new Error("Extension acknowledgement interrupted");
    });
    goals = new GoalService(f.config, f.key, teams);
    await assert.rejects(goals.extend(f.goal.id, f.request), /interrupted/);
    interrupted.mock.restore();
    const control = { requestId: randomUUID(), revision: 1, text: "Keep the existing scope" };
    if (action === "steer") await goals.steer(f.goal.id, control);
    else await goals[action](f.goal.id, { requestId: control.requestId, revision: control.revision });
    goals.start();
    await waitFor(async () => f.readRecord<{ extensionIntent?: unknown; control?: unknown }>("goal", f.goal.id), stored => !stored.extensionIntent && !stored.control);
    const current = goals.get(f.goal.id), child = teams.get(f.run.id);
    assert.equal(current.status, action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "running");
    assert.equal(current.deadlineAt, child.goal!.deadlineAt);
    if (applied) {
      const replay = await goals.extend(f.goal.id, f.request);
      assert.ok(Date.parse(replay.deadlineAt) > Date.parse(f.goal.deadlineAt));
      assert.equal(replay.revision, 3, "Record the applied extension without overwriting the newer control");
      assert.equal(replay.events.filter(event => event.text === "The owner extended the time limit by 30 minutes.").length, 1);
    } else {
      assert.equal(current.deadlineAt, f.goal.deadlineAt, "A newer owner action must prevent a stale extension side effect");
      assert.equal(current.revision, 2);
      assert.ok(current.events.some(event => /extension.*(rejected|abandoned)/i.test(event.text)));
    }
  } finally { goals?.close(); f.close(); }
});

test("transient extension recovery reports one failure, later recovers, and permits cancellation", async t => {
  const f = extensionFixture();
  let goals: GoalService | undefined;
  try {
    f.writeTeam(); f.writeGoal();
    const teams = f.openTeam();
    const attempts = t.mock.method(teams, "extendGoalTime", async () => { throw new Error("Team storage temporarily unavailable"); });
    goals = new GoalService(f.config, f.key, teams);
    await assert.rejects(goals.extend(f.goal.id, f.request), /temporarily unavailable/);
    goals.start();
    await waitFor(async () => attempts.mock.callCount(), count => count >= 2);
    attempts.mock.restore();
    const recovered = await waitFor(async () => goals!.get(f.goal.id), goal => goal.revision === 2);
    assert.equal(recovered.events.filter(event => /time extension.*retry/i.test(event.text)).length, 1);
    assert.ok(recovered.events.some(event => /time extension.*recovered/i.test(event.text)));
    assert.equal(teams.get(f.run.id).goal!.deadlineAt, recovered.deadlineAt);
    assert.equal((await goals.extend(f.goal.id, f.request)).revision, 2);
    await goals.cancel(f.goal.id, { requestId: randomUUID(), revision: 2 });
    teams.start();
    const cancelled = await waitFor(async () => goals!.get(f.goal.id), goal => !goal.activeTeamId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(teams.get(f.run.id).status, "cancelled");
    assert.equal(f.readRecord<{ extensionIntent?: unknown }>("goal", f.goal.id).extensionIntent, undefined);
  } finally { goals?.close(); f.close(); }
});

test("persistent extension recovery is visible, bounded across restart, and releases the extension gate", async t => {
  const f = extensionFixture();
  let goals: GoalService | undefined;
  try {
    f.writeTeam(); f.writeGoal();
    const teams = f.openTeam();
    const attempts = t.mock.method(teams, "extendGoalTime", async () => { throw new Error("Team storage temporarily unavailable"); });
    goals = new GoalService(f.config, f.key, teams);
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(goals.extend(f.goal.id, f.request), /temporarily unavailable/);
    assert.equal(goals.get(f.goal.id).events.filter(event => /time extension.*retry/i.test(event.text)).length, 1);
    goals.close(); goals = new GoalService(f.config, f.key, teams); goals.start();
    await waitFor(async () => f.readRecord<{ extensionIntent?: unknown }>("goal", f.goal.id), stored => !stored.extensionIntent);
    assert.equal(attempts.mock.callCount(), 3, "A restart must not reset the three-failure recovery budget");
    const abandoned = goals.get(f.goal.id);
    assert.ok(abandoned.events.some(event => /extension.*abandoned.*3/i.test(event.text)));
    assert.equal(abandoned.deadlineAt, f.goal.deadlineAt);
    attempts.mock.restore();
    const retried = await goals.extend(f.goal.id, { ...f.request, requestId: randomUUID() });
    assert.ok(Date.parse(retried.deadlineAt) > Date.parse(f.goal.deadlineAt));
  } finally { goals?.close(); f.close(); }
});

test("a saved extension intent reapplies the same target after a restart", { timeout: 90000 }, async () => {
  const f = await fixture("cycles");
  try {
    const request = f.create(), created = await f.host.fetchApi("/goals", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const held = await f.held(request.requestId), child = held.team!;
    const key = readFileSync(f.host.config.keyFile), goalScope = `goal:${request.requestId}`;
    const goalFile = join(f.host.config.stateDir, "goals", `${request.requestId}.sealed`);
    await f.host.stopApi();
    const stored = unseal<{ goal: ProductGoal; extensionIntent?: Record<string, unknown> }>(key, goalScope, readFileSync(goalFile, "utf8"));
    const body = { requestId: randomUUID(), revision: created.body.revision, minutes: 30 };
    const fingerprint = createHash("sha256").update(JSON.stringify({ action: "extend", ...body })).digest("hex");
    const targetDeadlineAt = new Date(Date.now() + 30 * 60000).toISOString();
    stored.extensionIntent = { ...body, fingerprint, teamId: child.id, targetDeadlineAt, targetCeilingAt: targetDeadlineAt };
    writeSealed(goalFile, key, goalScope, stored);
    await f.host.start();
    const recovered = await waitFor(() => f.goal(request.requestId), value => value.events.some(event => event.text === "The owner extended the time limit by 30 minutes."), 15000);
    assert.equal(recovered.deadlineAt, targetDeadlineAt);
    const replay = await f.host.fetchApi(`/goals/${request.requestId}/extend`, "owner", body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.deadlineAt, targetDeadlineAt, "Retry uses the persisted target instead of adding minutes again");
    assert.equal(replay.body.revision, recovered.revision);
    assert.equal((await f.team(child.id)).goal!.deadlineAt, targetDeadlineAt);
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


test("a goal continues from merged feature receipts without claiming product achievement", { timeout: 120000 }, async () => {
  const linear = await startLinearServer();
  const f = await fixture("delivery", linear);
  try {
    const created = await f.host.fetchApi("/goals", "owner", f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const completed = await f.settled(created.body.id);
    assert.equal(completed.status, "ready-for-review", JSON.stringify(completed));
    assert.equal(completed.outcomes.length, 0);
    assert.deepEqual(completed.cycles.map(cycle => cycle.status), ["merged", "merged"]);
    const first = await f.team(completed.cycles[0].teamId), second = await f.team(completed.cycles[1].teamId);
    assert.equal(second.baseCommit, first.deliveryReceipt?.mergeCommit);
    assert.notEqual(second.baseCommit, first.headCommit);
    assert.ok(first.deliveryReceipt && second.deliveryReceipt);
    await waitFor(async () => [...linear.comments.values()], comments => comments.filter(comment => comment.body.includes("Delivery agent reported a merged pull request")).length === 2, 15000);
    assert.ok([...linear.comments.values()].filter(comment => comment.body.includes("Delivery agent reported a merged pull request")).every(comment => comment.body.includes("agent-reported delivery evidence")));
  } finally { await f.close(); await linear.close(); }
});
