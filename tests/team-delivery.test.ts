import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, git, limitLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { TeamMember, TeamReport, TeamRun } from "../packages/host/src/team-types.js";
import { teamPrompt } from "../packages/host/src/team-prompts.js";

async function deliveryRecord(mode: "merge" | "pr", onMerged?: (projectId: string) => void) {
  const f = await fixture("delivery-fast", limitLineup, {}, { deliveryMode: mode, noServer: true });
  const teams = await f.openTeamService({ onMerged, start: false });
  const id = randomUUID(), memberId = randomUUID(), branch = "infinite/team-delivery-test";
  git(f.source, "checkout", "-b", branch);
  const root = join(f.host.config.teams!.workspaceDir, id);
  const workspace = join(root, "integration"), members = join(root, "members"), cwd = join(members, memberId);
  mkdirSync(members, { recursive: true });
  git(f.source, "clone", "--no-hardlinks", f.source, workspace);
  git(workspace, "remote", "remove", "origin");
  const headCommit = git(workspace, "rev-parse", "HEAD");
  git(workspace, "clone", "--no-hardlinks", workspace, cwd);
  git(cwd, "remote", "remove", "origin");
  const at = new Date().toISOString();
  const policy = structuredClone(f.host.config.projects[0]!.team!.delivery!);
  const member: TeamMember = { runId: id, memberId, revision: 1, role: "delivery", provider: "codex", sessionId: randomUUID(),
    title: "delivery: Implement a small feature", status: "reported", cwd, baseCommit: headCommit, prompt: "", cursor: 0, stopRequestId: randomUUID(), startedAt: at };
  const run: TeamRun = { id, projectId: "rehearsal", provider: "codex", title: "Implement a small feature", objective: "Record an owner-authorized delivery.",
    parallelism: 2, revision: 1, status: "delivering", createdAt: at, updatedAt: at, workspace, branch, baseCommit: headCommit, headCommit,
    tasks: [], members: [member], decisions: [], checks: [], steering: [], events: [], round: 0, delivery: policy,
    review: { verdict: "approved", summary: "Reviewed the exact integration head.", revision: 1 } };
  const stored = { run, fingerprint: "fixture", receipts: {}, prepared: true, root: f.host.config.teams!.workspaceDir,
    checkHead: headCommit, deliveryAttempt: { memberId, revision: 1, headCommit } };
  const internals = teams as unknown as { records: Map<string, typeof stored>; consume: (record: typeof stored, member: TeamMember) => void };
  internals.records.set(id, stored);
  return { f, teams, run, member, stored, headCommit, id, consume(report: TeamReport) { member.report = report; internals.consume(stored, member); } };
}

async function blockedDeliveryRecord() {
  const h = await deliveryRecord("merge");
  h.run.lineup = structuredClone(limitLineup);
  h.run.status = "blocked";
  h.run.reason = "Delivery was blocked before a confirmed remote result.";
  h.member.status = "stopped";
  h.member.report = { kind: "blocked", summary: "The provider denied workflow-file publication." };
  return h;
}

test("owner-authorized delivery waits for exact-head checks and review, survives API restart, and records one merge claim", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-hold", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const delivering = await waitFor(() => f.get(created.body.id), run => run.status === "delivering" && existsSync(join(f.receipts, "delivery-started.json")), 40000);
    assert.equal(delivering.review?.verdict, "approved");
    assert.ok(delivering.checks.length && delivering.checks.every(check => check.status === "passed"));
    const actor = delivering.members.find(member => member.role === "delivery")!;
    assert.equal(actor.baseCommit, delivering.headCommit);
    assert.equal(actor.modelProfile?.tier, "strong");
    assert.notEqual(actor.memberId, delivering.members.find(member => member.role === "reviewer")?.memberId);
    await f.host.stopApi(); await f.host.start();
    assert.equal((await f.get(delivering.id)).status, "delivering");
    writeFileSync(join(f.receipts, "delivery-release"), "continue");
    const merged = await f.settled(delivering.id);
    assert.equal(merged.status, "merged", JSON.stringify(merged));
    assert.equal(merged.deliveryReceipt?.headCommit, merged.headCommit);
    assert.equal(merged.deliveryReceipt?.pullRequestUrl, "https://github.com/example/app/pull/1");
    assert.equal(merged.members.filter(member => member.role === "delivery").length, 1);
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
    await f.host.stopApi(); await f.host.start();
    assert.deepEqual((await f.get(merged.id)).deliveryReceipt, merged.deliveryReceipt);
    const steer = await f.host.fetchApi(`/teams/${merged.id}/steer`, "controller", { requestId: randomUUID(), revision: merged.revision, text: "Try delivery again" });
    assert.equal(steer.status, 409);
    assert.equal(steer.body.code, "delivery-reconciliation-required");
  } finally { await f.close(); }
});

test("pull-request delivery records the reviewed pull request and ends ready for review", { timeout: 30000 }, async () => {
  const h = await deliveryRecord("pr");
  try {
    const prompt = teamPrompt(h.run, "delivery");
    assert.match(prompt, /do not merge/i);
    assert.match(prompt, /never force-push/i);
    assert.match(prompt, /denied action must not be retried through another tool or credential/i);
    assert.match(prompt, /missing required capabilities are a blocker/i);
    h.consume({ kind: "pull-request", headCommit: h.headCommit, pullRequestUrl: "https://github.com/example/app/pull/1", summary: "Opened the reviewed head for owner review." });
    const ready = await waitFor(() => Promise.resolve(h.teams.get(h.id)), run => ["ready-for-review", "blocked"].includes(run.status), 10000);
    assert.equal(ready.status, "ready-for-review", JSON.stringify(ready));
    assert.equal(ready.pullRequest?.headCommit, ready.headCommit);
    assert.equal(ready.pullRequest?.pullRequestUrl, "https://github.com/example/app/pull/1");
    assert.equal(ready.deliveryReceipt, undefined);
    assert.ok(ready.events.some(event => event.text === "The delivery agent reported an open pull request for the reviewed commit. Review and merge it on GitHub; the host refreshes the project after the merge."));
    assert.deepEqual(await h.teams.bundle(ready.id), { workspace: ready.workspace, branch: ready.branch, head: ready.headCommit });
  } finally { await h.f.close(); }
});

test("delivery reports must match the pinned merge or pull-request mode", { timeout: 30000 }, async () => {
  for (const [mode, kind] of [["pr", "delivery"], ["merge", "pull-request"]] as const) {
    const h = await deliveryRecord(mode);
    try {
      const report: TeamReport = kind === "delivery"
        ? { kind: "delivery", headCommit: h.headCommit, pullRequestUrl: "https://github.com/example/app/pull/1", mergeCommit: h.headCommit, summary: "Wrong report mode." }
        : { kind: "pull-request", headCommit: h.headCommit, pullRequestUrl: "https://github.com/example/app/pull/1", summary: "Wrong report mode." };
      assert.throws(() => h.consume(report), error => error instanceof TeamError && error.status === 409 && error.code === "delivery-mode-mismatch");
      assert.equal(h.run.pullRequest, undefined);
      assert.equal(h.run.deliveryReceipt, undefined);
    } finally { await h.f.close(); }
  }
});

test("a completed merge report invokes the source refresh callback once", { timeout: 30000 }, async () => {
  const refreshed: string[] = [];
  const callbackStatuses: string[] = [];
  let h: Awaited<ReturnType<typeof deliveryRecord>> | undefined;
  h = await deliveryRecord("merge", projectId => {
    refreshed.push(projectId);
    callbackStatuses.push(h?.teams.get(h.id).status ?? "missing");
  });
  try {
    const tree = git(h.member.cwd, "rev-parse", `${h.headCommit}^{tree}`);
    const mergeCommit = git(h.member.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-p", h.headCommit, "-m", "Synthetic merge");
    git(h.member.cwd, "update-ref", "refs/heads/synthetic-merge", mergeCommit);
    h.consume({ kind: "delivery", headCommit: h.headCommit, pullRequestUrl: "https://github.com/example/app/pull/1", mergeCommit, summary: "Merged the reviewed head." });
    const merged = await waitFor(() => Promise.resolve(h!.teams.get(h!.id)), run => ["merged", "blocked"].includes(run.status), 10000);
    assert.equal(merged.status, "merged", JSON.stringify(merged));
    assert.deepEqual(refreshed, ["rehearsal"]);
    assert.deepEqual(callbackStatuses, ["merged"]);
  } finally { await h.f.close(); }
});

test("delivery rejects foreign targets, stale heads, changed files, and invalid merged baselines", { timeout: 120000 }, async () => {
  for (const [scenario, reason] of [["delivery-foreign", /configured repository/], ["delivery-stale", /reviewed commit/], ["delivery-dirty", /read-only member workspace/], ["delivery-baseline-changed", /beyond the reviewed tree/], ["delivery-baseline-tree", /must identify a commit/]] as const) {
    const f = await fixture(scenario, limitLineup);
    try {
      const created = await f.host.fetchApi("/teams", "owner", f.create());
      const blocked = await f.settled(created.body.id);
      assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
      assert.match(blocked.reason ?? "", reason);
      if (scenario.startsWith("delivery-baseline-")) assert.ok(blocked.deliveryReceipt, "A merge claim survives blocked baseline reconciliation");
      else assert.equal(blocked.deliveryReceipt, undefined);
    } finally { await f.close(); }
  }
});

test("delivery repairs repeat checks and independent review before a new delivery attempt", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-repair", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const merged = await f.settled(created.body.id);
    assert.equal(merged.status, "merged", JSON.stringify(merged));
    assert.equal(merged.round, 1);
    const actors = merged.members.filter(member => member.role === "delivery");
    assert.equal(actors.length, 2);
    assert.notEqual(actors[0].baseCommit, actors[1].baseCommit);
    assert.equal(merged.members.filter(member => member.role === "reviewer").length, 2);
    assert.equal(merged.deliveryReceipt?.headCommit, actors[1].baseCommit);
    assert.equal(merged.checks.filter(check => check.status === "passed").length, 2);
  } finally { await f.close(); }
});

test("an exited delivery without a receipt is not merged or replayed by steering", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-unreported", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    await waitFor(() => f.get(created.body.id), run => run.status === "delivering" && existsSync(join(f.receipts, "delivery-started.json")), 40000);
    writeFileSync(join(f.receipts, "delivery-release"), "exit without receipt");
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reason ?? "", /without a valid structured report/);
    assert.equal(blocked.deliveryReceipt, undefined);
    await f.host.stopApi(); await f.host.start();
    const retry = await f.host.fetchApi(`/teams/${blocked.id}/steer`, "owner", { requestId: randomUUID(), revision: blocked.revision, text: "Retry" });
    assert.equal(retry.status, 409);
    const receipts = readdirSync(f.receipts).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(f.receipts, name), "utf8")));
    assert.equal(receipts.filter(receipt => receipt.role === "delivery").length, 1);
  } finally { await f.close(); }
});

test("owner delivery reconciliation refuses unsafe prior attempts without changing team state", { timeout: 90000 }, async () => {
  const scenarios = ["dirty", "head-drift", "active-member", "uncertain-permission", "wrong-role"] as const;
  for (const scenario of scenarios) {
    const h = await blockedDeliveryRecord();
    try {
      if (scenario === "dirty") writeFileSync(join(h.run.workspace, "untracked-reconciliation-probe"), "dirty\n");
      if (scenario === "head-drift") git(h.run.workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Drift from reviewed head");
      if (scenario === "active-member") h.run.members.push({ ...h.member, memberId: randomUUID(), sessionId: randomUUID(), role: "reviewer", status: "running", report: undefined });
      if (scenario === "uncertain-permission") h.run.permissionDecisions = [{ id: randomUUID(), revision: h.run.revision, policyHash: "policy", targetMemberId: h.member.memberId,
        targetSessionId: h.member.sessionId, targetCwd: h.member.cwd, promptId: 1, promptHash: "prompt", evidenceHash: "evidence", prompt: {} as never,
        option: 0, expiresAt: new Date(Date.now() + 60000).toISOString(), answerRequestId: randomUUID(), status: "uncertain" }];
      if (scenario === "wrong-role") h.member.role = "reviewer";
      const before = { revision: h.run.revision, status: h.run.status, members: h.run.members.length, attempt: structuredClone(h.stored.deliveryAttempt), events: h.run.events.length };
      await assert.rejects(h.teams.reconcileDelivery(h.id, { requestId: randomUUID(), revision: h.run.revision, text: "Inspect current remote state before any delivery action." }),
        error => error instanceof TeamError && error.status === 409);
      assert.equal(h.run.revision, before.revision, scenario);
      assert.equal(h.run.status, before.status, scenario);
      assert.equal(h.run.members.length, before.members, scenario);
      assert.deepEqual(h.stored.deliveryAttempt, before.attempt, scenario);
      assert.equal(h.run.events.length, before.events, scenario);
    } finally { await h.f.close(); }
  }
});

test("owner delivery reconciliation starts one strong worker at the pinned head and retains the prior report", { timeout: 90000 }, async () => {
  const h = await blockedDeliveryRecord();
  try {
    const priorAttempt = structuredClone(h.stored.deliveryAttempt);
    const priorReport = structuredClone(h.member.report);
    const request = { requestId: randomUUID(), revision: h.run.revision, text: "Check the branch, PR, and CI state before doing anything." };
    await h.teams.reconcileDelivery(h.id, request);
    const prepared = await waitFor(() => Promise.resolve(h.teams.get(h.id)), run => run.members.length === 2 && run.members.some(member => member.memberId !== h.member.memberId && member.status === "queued"), 10000);
    const fresh = h.run.members.find(member => member.memberId !== h.member.memberId)!;
    assert.equal(fresh.role, "delivery");
    assert.equal(fresh.revision, h.run.revision);
    assert.equal(fresh.baseCommit, h.headCommit);
    assert.equal(fresh.modelProfile?.tier, "strong");
    assert.notEqual(fresh.memberId, h.member.memberId);
    assert.equal(h.stored.deliveryAttempt?.memberId, fresh.memberId);
    assert.equal(h.stored.deliveryAttempt?.headCommit, priorAttempt?.headCommit);
    assert.deepEqual(h.member.report, priorReport);
    assert.equal(h.member.status, "stopped");
    assert.match(fresh.contextFeedback ?? "", /Check the branch, PR, and CI state before doing anything/);
    assert.match(fresh.contextFeedback ?? "", /Prior blocked report/);
    assert.match(fresh.contextFeedback ?? "", /never create a duplicate pull request/);
    assert.ok(prepared.events.some(event => event.text.includes(h.member.memberId) && event.text.includes(h.headCommit)));
    assert.equal(existsSync(join(h.f.receipts, "delivery-started.json")), false, "reconciliation queues a worker but does not publish directly");

    await h.teams.reconcileDelivery(h.id, request);
    assert.equal(h.run.members.length, 2, "an idempotent retry must not queue another delivery member");
    assert.equal(h.stored.deliveryAttempt?.memberId, fresh.memberId);
  } finally { await h.f.close(); }
});

test("failed checks never launch delivery and a weak lineup cannot opt into merge", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-failed-check", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.members.some(member => member.role === "delivery"), false);
  } finally { await f.close(); }
  const weak = await fixture("delivery-stale");
  try {
    const refused = await weak.host.fetchApi("/teams", "owner", weak.create());
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "delivery-lineup-required");
  } finally { await weak.close(); }
});
