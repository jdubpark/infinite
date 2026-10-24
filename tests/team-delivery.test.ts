import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, git, limitLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";
import { TeamError, type TeamService } from "../packages/host/src/teams.js";
import { teamDeliveryReconcileSchema, type TeamDeliveryReconcile, type TeamMember, type TeamReport, type TeamRun } from "../packages/host/src/team-types.js";
import { unseal } from "../packages/host/src/vault.js";
import type { ProjectSourceService, ProjectSourceStatus } from "../packages/host/src/project-source.js";
import { teamPrompt } from "../packages/host/src/team-prompts.js";

type DeliveryStored = {
  run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean; root: string;
  checkHead?: string; halt?: string; deliveryAttempt?: { memberId: string; revision: number; headCommit: string };
  pending?: { id: string; kind: "result" | "member" | "check" | "prepare"; revision: number;
    source?: { memberId: string; role: TeamMember["role"]; cwd: string; baseCommit: string; headCommit: string; workspace: "member" | "integration" };
    failure?: { code?: string; reason: string; at: string } };
};
const deliveryInternals = (teams: TeamService) => teams as unknown as {
  records: Map<string, DeliveryStored>; commands: Map<string, AbortController>;
  save(stored: DeliveryStored): void; step(stored: DeliveryStored): Promise<void>; consume(stored: DeliveryStored, member: TeamMember): void;
};

async function deliveryRecord(mode: "merge" | "pr", onMerged?: (projectId: string) => void,
  source?: Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status"> | ((fixture: Awaited<ReturnType<typeof fixture>>) => Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status">)) {
  const f = await fixture("delivery-fast", limitLineup, {}, { deliveryMode: mode, noServer: true });
  const id = randomUUID(), memberId = randomUUID(), branch = "infinite/team-delivery-test";
  git(f.source, "checkout", "-b", branch);
  const sourceService = typeof source === "function" ? source(f) : source;
  const teams = await f.openTeamService({ onMerged, ...(sourceService ? { source: sourceService } : {}), start: false });
  const root = join(f.host.config.teams!.workspaceDir, id);
  const workspace = join(root, "integration"), members = join(root, "members"), cwd = join(members, memberId);
  mkdirSync(members, { recursive: true, mode: 0o700 });
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
  const stored: DeliveryStored = { run, fingerprint: "fixture", receipts: {}, prepared: true, root: f.host.config.teams!.workspaceDir,
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

async function failedMovedBaseDeliveryRecord() {
  let mirror = "", moved = "";
  let fetchMoved: (() => void) | undefined;
  let source!: Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status">;
  const sourceFactory = (f: Awaited<ReturnType<typeof fixture>>): Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status"> => {
    mirror = join(f.host.root, "source-mirror.git");
    git(f.source, "clone", "--bare", f.source, mirror);
    fetchMoved = () => { git(mirror, "fetch", f.source, "main:refs/heads/main"); };
    source = {
      refresh: async () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: moved }),
      mirrorPath: () => mirror,
      isGithub: () => true,
      status: () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: moved }),
    } as Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status">;
    return source;
  };
  const h = await deliveryRecord("pr", undefined, sourceFactory);
  try {
    const f = h.f;
    git(f.source, "checkout", "main");
    git(f.source, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Move base");
    moved = git(f.source, "rev-parse", "HEAD");
    h.run.lineup = structuredClone(limitLineup);
    h.run.status = "delivering";
    h.run.review = { verdict: "approved", summary: "Reviewed the exact integration head.", revision: h.run.revision };
    h.stored.checkHead = h.headCommit;
    h.member.status = "reported";
    const report: TeamReport = { kind: "delivery-reconciliation", headCommit: h.headCommit, repository: "example/app", branch: h.run.branch,
      baseHeadCommit: moved, disposition: "no-publication", summary: "Inspected the branch and pull requests; nothing was published." };
    h.consume(report);
    const failureCode = await waitFor(() => Promise.resolve(h.stored.pending?.failure?.code), code => Boolean(code), 10000);
    assert.equal(failureCode, "workspace-operation-failed", JSON.stringify({ pending: h.stored.pending, run: h.run.status, reason: h.run.reason }));
    assert.equal(h.run.deliveryRecovery?.attempts, 1);
    h.member.status = "stopped";
    deliveryInternals(h.teams).save(h.stored);
    return { ...h, moved, source, useMirror: () => fetchMoved!() };
  } catch (error) { await h.f.close(); throw error; }
}

type FailedDeliveryRecord = Awaited<ReturnType<typeof failedMovedBaseDeliveryRecord>>;
function bindDeliveryRecord(h: FailedDeliveryRecord, stored: DeliveryStored) {
  const memberId = h.member.memberId;
  h.stored = stored; h.run = stored.run;
  h.member = h.run.members.find(member => member.memberId === memberId)!;
  deliveryInternals(h.teams).records.set(h.id, stored);
}
async function restartDeliveryRecord(h: FailedDeliveryRecord) {
  h.teams.close(); await h.teams.idle();
  h.teams = await h.f.openTeamService({ source: h.source, start: false });
  bindDeliveryRecord(h, deliveryInternals(h.teams).records.get(h.id)!);
  // One real stop-draining step clears the restart halt. Keep the scheduler off so no test agent launches.
  if (h.stored.halt) await deliveryInternals(h.teams).step(h.stored);
  assert.equal(h.stored.halt, undefined);
}
function failedDeliveryRequest(h: FailedDeliveryRecord): TeamDeliveryReconcile & { failedOperation: NonNullable<TeamDeliveryReconcile["failedOperation"]> } {
  return { requestId: randomUUID(), revision: h.run.revision, text: "Reinspect current remote state before acting.", failedOperation: {
    pendingId: h.stored.pending!.id, headCommit: h.headCommit,
    attestation: { boundary: "delivery-preparation", processesStopped: true, text: "The prior delivery preparation process has exited." },
  } };
}
function persistedDelivery(h: FailedDeliveryRecord) {
  return unseal<DeliveryStored>(readFileSync(h.f.host.config.keyFile), `team:${h.id}`,
    readFileSync(join(h.f.host.config.stateDir, "teams", `${h.id}.sealed`), "utf8"));
}
function withoutUpdatedAt(stored: DeliveryStored) {
  const copy = structuredClone(stored);
  copy.run.updatedAt = "ignored save timestamp";
  // Sealed JSON omits optional undefined fields present on the in-memory object.
  return JSON.parse(JSON.stringify(copy));
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

test("a no-publication capability failure gets one bounded inspection and no duplicate pull request", { timeout: 120000 }, async () => {
  const f = await fixture("delivery-capability-failure", limitLineup, {}, { deliveryMode: "pr" });
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const initial = await waitFor(() => f.get(created.body.id), run =>
      run.status === "delivering" && existsSync(join(f.receipts, "delivery-started.json")), 90000);
    writeFileSync(join(f.receipts, "delivery-branch"), initial.branch!, { mode: 0o600 });
    writeFileSync(join(f.receipts, "delivery-base-head"), initial.baseCommit!, { mode: 0o600 });
    writeFileSync(join(f.receipts, "delivery-release"), "release", { mode: 0o600 });

    const blocked = await f.settled(initial.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.equal(blocked.id, initial.id, "the retry remains in the original run");
    assert.equal(blocked.revision, initial.revision, "a capability failure does not create a new implementation revision");
    assert.equal(blocked.deliveryRecovery?.status, "exhausted");
    assert.equal(blocked.deliveryRecovery?.attempts, 2, "the bounded inspection and one retry consume at most two recovery attempts");
    assert.equal(blocked.deliveryRecovery?.disposition, "no-publication");
    assert.equal(blocked.deliveryRecovery?.headCommit, initial.headCommit);
    assert.equal(blocked.deliveryRecovery?.baseHeadCommit, initial.baseCommit);
    assert.equal(blocked.deliveryReceipt, undefined);
    assert.equal(blocked.pullRequest, undefined);

    const attempts = readFileSync(join(f.receipts, "delivery-attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const inspections = readFileSync(join(f.receipts, "delivery-reconciliations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(inspections.length, 1, "one exact remote inspection is recorded");
    assert.deepEqual([inspections[0].headCommit, inspections[0].repository, inspections[0].branch, inspections[0].baseHeadCommit],
      [initial.headCommit, "example/app", initial.branch, initial.baseCommit]);
    assert.equal(inspections[0].disposition, "no-publication");
    assert.equal(attempts.filter((item: { reconciling: boolean }) => item.reconciling).length, 1);
    assert.equal(attempts.filter((item: { reconciling: boolean }) => !item.reconciling).length, 2,
      "the same failed capability is retried once and does not create a duplicate PR attempt");
    assert.equal(new Set(attempts.map((item: { head: string }) => item.head)).size, 1,
      "both delivery attempts remain pinned to the same independently reviewed head");
  } finally {
    writeFileSync(join(f.receipts, "delivery-release"), "release", { mode: 0o600 });
    await f.close();
  }
});

test("a matching no-publication inspection allows same-head repair before checks, review, and one PR", { timeout: 150000 }, async () => {
  const f = await fixture("delivery-capability-repair", limitLineup, {}, { deliveryMode: "pr" });
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const initial = await waitFor(() => f.get(created.body.id), run =>
      run.status === "delivering" && existsSync(join(f.receipts, "delivery-started.json")), 90000);
    writeFileSync(join(f.receipts, "delivery-branch"), initial.branch!, { mode: 0o600 });
    writeFileSync(join(f.receipts, "delivery-base-head"), initial.baseCommit!, { mode: 0o600 });
    writeFileSync(join(f.receipts, "delivery-release"), "release", { mode: 0o600 });

    const finished = await f.settled(initial.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.id, initial.id, "inspection and repair stay in the original run");
    assert.equal(finished.revision, initial.revision, "scoped repair rechecks the same work revision");
    assert.notEqual(finished.headCommit, initial.headCommit, "the integrator repair is captured as a new checked head");
    assert.equal(finished.pullRequest?.headCommit, finished.headCommit);
    assert.equal(finished.deliveryReceipt, undefined, "PR mode never records a merge receipt");
    assert.equal(finished.deliveryRecovery?.status, "complete");
    assert.equal(finished.deliveryRecovery?.attempts, 2, "the inspection and same-head retry use the two recovery reservations");
    assert.equal(finished.deliveryRecovery?.disposition, "no-publication");

    const initialAttempt = finished.members.find(member => member.memberId === initial.members.find(item => item.role === "delivery")?.memberId);
    assert.equal(initialAttempt?.report?.kind, "blocked");
    const inspection = finished.members.find(member => member.report?.kind === "delivery-reconciliation");
    assert.ok(inspection?.report?.kind === "delivery-reconciliation");
    assert.equal(inspection.report.headCommit, initial.headCommit);
    assert.equal(inspection.report.baseHeadCommit, initial.baseCommit);
    assert.equal(inspection.report.disposition, "no-publication");
    const repairAttempt = finished.members.find(member => member.report?.kind === "delivery-repair");
    assert.ok(repairAttempt?.report?.kind === "delivery-repair");
    assert.equal(repairAttempt.report.headCommit, initial.headCommit, "delivery repair is pinned to the inspected same head");
    assert.equal(repairAttempt.baseCommit, initial.headCommit);
    const integrator = finished.members.find(member => member.role === "integrator" && member.report?.kind === "result");
    assert.ok(integrator);
    assert.equal(integrator.baseCommit, initial.headCommit);
    assert.match(integrator.report?.kind === "result" ? integrator.report.summary : "", /repair/i);
    assert.equal(readFileSync(join(finished.workspace, "repair.txt"), "utf8"), `${integrator.memberId}\n`);

    const checks = finished.checks.filter(check => check.revision === finished.revision && check.headCommit === finished.headCommit);
    assert.ok(checks.length > 0 && checks.every(check => check.status === "passed" && check.headCommit === finished.headCommit),
      "required checks pass against the repaired head");
    assert.ok(finished.checks.some(check => check.revision === finished.revision && check.headCommit === initial.headCommit),
      "the blocked delivery's original checked head remains in the run history");
    const reviewer = finished.members.find(member => member.role === "reviewer" && member.revision === finished.revision && member.baseCommit === finished.headCommit);
    assert.equal(reviewer?.modelProfile?.tier, "strong");
    assert.equal(reviewer?.report?.kind, "review");
    assert.ok(checks.every(check => Date.parse(check.finishedAt!) < Date.parse(reviewer!.startedAt!)), "checks finish before independent review starts");
    const publisher = finished.members.find(member => member.role === "delivery" && member.report?.kind === "pull-request");
    assert.equal(publisher?.modelProfile?.tier, "strong");
    assert.equal(publisher?.baseCommit, finished.headCommit);
    assert.equal(publisher?.report?.kind, "pull-request");
    assert.ok(Date.parse(reviewer!.reportedAt!) < Date.parse(publisher!.startedAt!), "the final delivery starts after review evidence");
    assert.equal(finished.members.filter(member => member.report?.kind === "pull-request").length, 1,
      "exactly one publication outcome is reported for the repaired head");

    const inspections = readFileSync(join(f.receipts, "delivery-reconciliations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(inspections.length, 1);
    assert.deepEqual([inspections[0].headCommit, inspections[0].repository, inspections[0].branch, inspections[0].baseHeadCommit, inspections[0].disposition],
      [initial.headCommit, "example/app", initial.branch, initial.baseCommit, "no-publication"]);
    const attempts = readFileSync(join(f.receipts, "delivery-attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(attempts.filter((item: { reconciling: boolean }) => item.reconciling).length, 1);
    assert.equal(attempts.length, 4, "one blocked attempt, one inspection, one same-head repair retry, and one final PR attempt");
    assert.deepEqual(attempts.map((item: { head: string }) => item.head), [initial.headCommit, initial.headCommit, initial.headCommit, finished.headCommit]);
  } finally {
    writeFileSync(join(f.receipts, "delivery-release"), "release", { mode: 0o600 });
    await f.close();
  }
});

test("an existing matching pull request is reused for bounded merge-policy delivery", { timeout: 30000 }, async () => {
  const h = await blockedDeliveryRecord();
  try {
    h.run.status = "delivering";
    h.consume({ kind: "delivery-reconciliation", headCommit: h.headCommit, repository: "example/app", branch: h.run.branch!,
      baseHeadCommit: h.run.baseCommit!, disposition: "pull-request", remoteHeadCommit: h.headCommit,
      pullRequestUrl: "https://github.com/example/app/pull/1", summary: "The matching reviewed PR exists and has not merged." });
    const next = await waitFor(() => Promise.resolve(h.teams.get(h.id)), run => run.members.length > 1 || run.status === "blocked", 15000);
    assert.notEqual(next.status, "blocked", next.reason);
    assert.equal(next.deliveryRecovery?.attempts, 1);
    assert.equal(next.deliveryReceipt, undefined, "an open PR is not a merge receipt");
    assert.equal(next.pullRequest, undefined, "merge policy still requires guarded merge delivery");
    assert.equal(next.members.length, 2, "one coordinator continues the existing PR");
    assert.equal(next.members[1].role, "delivery");
    assert.equal(next.members[1].baseCommit, h.headCommit);
  } finally { await h.f.close(); }
});

test("automatic delivery inspection stops on dirty integration", { timeout: 90000 }, async () => {
  const f = await fixture("delivery-capability-failure", limitLineup, {}, { deliveryMode: "pr" });
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const initial = await waitFor(() => f.get(created.body.id), run =>
      run.status === "delivering" && existsSync(join(f.receipts, "delivery-started.json")), 90000);
    writeFileSync(join(initial.workspace, "untracked-delivery-change"), "preserve this change\n");
    writeFileSync(join(f.receipts, "delivery-branch"), initial.branch!, { mode: 0o600 });
    writeFileSync(join(f.receipts, "delivery-base-head"), initial.baseCommit!, { mode: 0o600 });
    writeFileSync(join(f.receipts, "delivery-release"), "release", { mode: 0o600 });

    const blocked = await f.settled(initial.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.equal(blocked.id, initial.id);
    assert.equal(blocked.members.filter(member => member.role === "delivery").length, 1, "no reconciliation or retry worker launches");
    assert.equal(existsSync(join(f.receipts, "delivery-reconciliations.jsonl")), false, "no remote inspection is requested");
    const attempts = readFileSync(join(f.receipts, "delivery-attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(attempts.length, 1, "only the original publication attempt runs");
    assert.equal(readFileSync(join(initial.workspace, "untracked-delivery-change"), "utf8"), "preserve this change\n");
    assert.match(blocked.reason ?? "", /dirty|changed|read-only/i);
  } finally {
    writeFileSync(join(f.receipts, "delivery-release"), "release", { mode: 0o600 });
    await f.close();
  }
});

test("automatic delivery recovery refuses a changed publication policy", { timeout: 30000 }, async () => {
  const h = await blockedDeliveryRecord();
  try {
    h.f.host.config.projects[0]!.team!.delivery!.repository = "example/changed";
    const prior = { revision: h.run.revision, members: h.run.members.length, attempt: structuredClone(h.stored.deliveryAttempt), events: h.run.events.length };
    h.consume({ kind: "blocked", summary: "The provider lacks the publication capability; no publication was attempted." });
    assert.equal(h.run.status, "blocked");
    assert.equal(h.run.revision, prior.revision);
    assert.equal(h.run.members.length, prior.members, "a changed owner policy must not start a reconciliation member");
    assert.deepEqual(h.stored.deliveryAttempt, prior.attempt);
    assert.equal(h.run.deliveryRecovery, undefined);
    assert.equal(h.run.events.length, prior.events + 1);
  } finally { await h.f.close(); }
});

test("a moved README base with no publication is reconciled, rechecked, strongly reviewed, and published once", { timeout: 180000 }, async () => {
  const f = await fixture("delivery-base-recovery", limitLineup, {}, { deliveryMode: "pr" });
  let teams: Awaited<ReturnType<typeof f.openTeamService>> | undefined;
  try {
    const mirror = join(f.host.root, "source-mirror.git");
    git(f.source, "clone", "--bare", f.source, mirror);
    let sourceStatus: ProjectSourceStatus = { mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: git(f.source, "rev-parse", "HEAD") };
    const source: Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status"> = {
      refresh: async () => sourceStatus,
      mirrorPath: () => mirror,
      isGithub: projectId => projectId === "rehearsal",
      status: () => sourceStatus,
    };
    teams = await f.openTeamService({ source });
    const created = await teams.create(f.create());
    const initial = await waitFor(() => Promise.resolve(teams!.get(created.id)), run =>
      run.status === "blocked" || run.status === "delivering" && existsSync(join(f.receipts, "delivery-started.json")), 120000);
    if (initial.status !== "delivering") {
      const missing = await Promise.all(initial.members.filter(member => member.role === "implementer" && !member.report).map(async member =>
        ({ memberId: member.memberId, status: member.status, session: (await f.host.fetchApi(`/sessions/${member.sessionId}`)).body })));
      assert.equal(initial.status, "delivering", JSON.stringify({ run: initial, missing }));
    }
    const oldWorkspace = initial.workspace;
    const oldHead = initial.headCommit;
    const oldBase = initial.baseCommit;
    assert.equal(git(oldWorkspace, "status", "--porcelain"), "");

    writeFileSync(join(f.source, "README.md"), `${readFileSync(join(f.source, "README.md"), "utf8")}Upstream moved README footer\n`);
    git(f.source, "add", "README.md");
    git(f.source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Move the README base");
    const movedBase = git(f.source, "rev-parse", "HEAD");
    git(mirror, "fetch", "--no-tags", "--", f.source, "+refs/heads/main:refs/heads/main");
    sourceStatus = { ...sourceStatus, mirrorHead: movedBase };
    writeFileSync(join(f.receipts, "delivery-branch"), initial.branch!, { mode: 0o600 });
    writeFileSync(join(f.receipts, "delivery-base-head"), movedBase, { mode: 0o600 });
    writeFileSync(join(f.receipts, "delivery-release"), "release", { mode: 0o600 });

    const finished = await waitFor(() => Promise.resolve(teams!.get(created.id)), run =>
      run.status === "ready-for-review" || run.status === "blocked", 150000);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.id, initial.id, "baseline recovery keeps one durable run");
    assert.ok(finished.revision > initial.revision, "a moved baseline requires fresh implementation and review evidence");
    assert.equal(finished.baseCommit, movedBase);
    assert.notEqual(finished.headCommit, oldHead);
    assert.equal(finished.branch, initial.branch);
    assert.equal(finished.pullRequest?.headCommit, finished.headCommit);
    assert.equal(finished.deliveryReceipt, undefined, "PR-only policy never records a merge claim");
    assert.equal(finished.deliveryRecovery?.status, "complete");
    assert.equal(finished.deliveryRecovery?.attempts, 2, "the initial remote inspection and fresh-base reconciliation consume the two recovery allowances");
    assert.equal(finished.deliveryRecovery?.disposition, "no-publication");
    assert.equal(finished.deliveryRecovery?.baseHeadCommit, movedBase);

    const currentChecks = finished.checks.filter(check => check.revision === finished.revision);
    assert.ok(currentChecks.length > 0 && currentChecks.every(check => check.status === "passed" && check.headCommit === finished.headCommit),
      "all required checks pass against the new reviewed head");
    const reviewer = finished.members.find(member => member.role === "reviewer" && member.revision === finished.revision);
    const publisher = finished.members.find(member => member.role === "delivery" && member.report?.kind === "pull-request");
    assert.equal(reviewer?.modelProfile?.tier, "strong");
    assert.equal(reviewer?.baseCommit, finished.headCommit);
    assert.equal(publisher?.modelProfile?.tier, "strong");
    assert.equal(publisher?.baseCommit, finished.headCommit);
    assert.equal(publisher?.report?.kind, "pull-request");

    const readme = git(finished.workspace, "show", "HEAD:README.md");
    assert.match(readme, /Upstream moved README footer/);
    assert.match(readme, /Team update revision/);
    assert.equal(finished.members.filter(member => member.revision === finished.revision && member.role === "project-manager").length, 0,
      "validated baseline import proceeds to verification without planning unrelated replacement work");
    for (const name of ["a.txt", "b.txt"])
      assert.equal(readFileSync(join(finished.workspace, name), "utf8"), readFileSync(join(oldWorkspace, name), "utf8"),
        `${name} retains the reviewed implementation after baseline reconciliation`);
    const integrator = finished.members.find(member => member.role === "integrator" && member.revision === initial.revision + 1);
    assert.equal(integrator?.report?.kind, "result");
    for (const name of ["a.txt", "b.txt"])
      assert.equal(readFileSync(join(integrator!.cwd, name), "utf8"), readFileSync(join(oldWorkspace, name), "utf8"),
        `${name} is imported from the preserved integration workspace before new implementation starts`);
    const importedReadme = readFileSync(join(integrator!.cwd, "README.md"), "utf8");
    assert.match(importedReadme, /Upstream moved README footer/);
    assert.match(importedReadme, /Team update revision/);
    assert.match(git(oldWorkspace, "show", "HEAD:README.md"), /Team update revision/);
    assert.ok(existsSync(oldWorkspace), "the original integration workspace remains available as recovery evidence");
    assert.equal(git(oldWorkspace, "rev-parse", "HEAD"), oldHead, "automatic rebase preserves the old integration head");

    const inspections = readFileSync(join(f.receipts, "delivery-reconciliations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(inspections.length, 1);
    assert.equal(inspections[0].headCommit, oldHead);
    assert.equal(inspections[0].baseHeadCommit, movedBase);
    assert.equal(inspections[0].disposition, "no-publication");
    const finalDeliveries = finished.members.filter(member => member.report?.kind === "pull-request");
    assert.equal(finalDeliveries.length, 1, "only one pull request is reported for the recovered reviewed head");
  } finally {
    writeFileSync(join(f.receipts, "delivery-release"), "release", { mode: 0o600 });
    await f.close();
  }
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

test("attested reconciliation clears only a settled moved-base preparation failure and preserves its receipt", { timeout: 90000 }, async () => {
  const h = await failedMovedBaseDeliveryRecord();
  try {
    const pending = structuredClone(h.stored.pending!);
    const previousReport = structuredClone(h.member.report);
    const originalWorkspace = h.run.workspace;
    await restartDeliveryRecord(h);
    assert.deepEqual(h.stored.pending, pending, "the structured failure survives the generic restart reason");
    assert.deepEqual(h.teams.get(h.id).pendingOperation, { id: pending.id, kind: "result", revision: 1, failed: true,
      failureCode: "workspace-operation-failed", sourceMemberId: h.member.memberId, sourceRole: "delivery" });
    const plain = { requestId: randomUUID(), revision: h.run.revision, text: "Inspect remote delivery state again." };
    const beforePlain = structuredClone(h.stored);
    await assert.rejects(h.teams.reconcileDelivery(h.id, plain), error => error instanceof TeamError && error.code === "delivery-reconciliation-unavailable");
    assert.deepEqual(h.stored, beforePlain);
    const request = failedDeliveryRequest(h);
    const internals = deliveryInternals(h.teams), save = internals.save;
    const saves: DeliveryStored[] = [];
    internals.save = function (stored) { save.call(this, stored); saves.push(persistedDelivery(h)); };
    try {
      await h.teams.reconcileDelivery(h.id, request);
      await waitFor(() => Promise.resolve(h.teams.get(h.id)), view => !view.pendingOperation && view.members.length === 2, 10000);
    } finally { internals.save = save; }
    assert.equal(saves[0]?.pending?.kind, "member", "the first durable reconciliation write already reserves member preparation");
    assert.notEqual(saves[0]?.pending?.id, pending.id);
    assert.equal(saves[0]?.run.deliveryOperationReconciliations?.[0]?.pendingId, pending.id);
    assert.ok(saves[0]?.receipts[request.requestId], "the request receipt and replacement intent are saved together");
    const prepared = h.teams.get(h.id);
    assert.equal(prepared.revision, 1);
    assert.equal(prepared.headCommit, h.headCommit);
    assert.equal(prepared.members.length, 2);
    const fresh = prepared.members.find(member => member.memberId !== h.member.memberId)!;
    assert.equal(fresh.role, "delivery");
    assert.equal(fresh.status, "queued");
    assert.equal(fresh.modelProfile?.tier, "strong");
    assert.equal(h.stored.deliveryAttempt?.memberId, fresh.memberId);
    assert.equal(h.stored.pending, undefined);
    assert.deepEqual(h.member.report, previousReport);
    assert.equal(h.member.status, "stopped");
    assert.equal(h.run.deliveryRecovery?.attempts, 1);
    assert.equal(h.run.recovery?.attempts, 1);
    assert.equal(h.run.deliveryRecovery?.status, "planning");
    assert.equal(h.run.deliveryOperationReconciliations?.length, 1);
    assert.deepEqual(h.run.deliveryOperationReconciliations?.[0], {
      requestId: request.requestId, pendingId: pending.id, pendingKind: "result", revision: 1, headCommit: h.headCommit,
      source: { memberId: h.member.memberId, role: "delivery" }, failure: pending.failure, report: previousReport,
      recoveryAttempts: 1, attestation: request.failedOperation.attestation, at: h.run.deliveryOperationReconciliations![0]!.at,
    });
    const freshRecord = h.run.members.find(member => member.memberId === fresh.memberId)!;
    assert.match(freshRecord.contextFeedback ?? "", /historical, not current remote evidence/);
    assert.match(freshRecord.contextFeedback ?? "", /Prior delivery report/);
    assert.match(freshRecord.contextFeedback ?? "", /Operator process-quiescence claim, not host-verified/);
    assert.ok(freshRecord.contextFeedback?.includes(pending.failure!.at));
    assert.match(freshRecord.contextFeedback ?? "", /pinned base head/);
    assert.match(freshRecord.contextFeedback ?? "", /never create a duplicate pull request/);
    assert.match(freshRecord.contextFeedback ?? "", /has not authorized a new credential/);
    assert.ok(prepared.events.some(event => event.text.includes(pending.id) && event.text.includes("workspace-operation-failed")));
    assert.equal(prepared.members.some(member => member.role === "integrator"), false);
    assert.equal(prepared.pullRequest, undefined);
    assert.equal(existsSync(join(h.f.receipts, "delivery-started.json")), false);
    const receipt = structuredClone(h.run.deliveryOperationReconciliations);
    await restartDeliveryRecord(h);
    assert.deepEqual(h.run.deliveryOperationReconciliations, receipt, "old failure evidence survives another disk restart");
    await h.teams.reconcileDelivery(h.id, request);
    assert.equal(h.run.members.length, 2, "response-loss replay returns the saved result without queueing another member");
    await assert.rejects(h.teams.reconcileDelivery(h.id, { ...request, text: "Different request intent." }),
      error => error instanceof TeamError && error.code === "request-conflict");
    await assert.rejects(h.teams.reconcileDelivery(h.id, { ...request, failedOperation: { ...request.failedOperation,
      attestation: { ...request.failedOperation.attestation, text: "A different operator claim." } } }),
    error => error instanceof TeamError && error.code === "request-conflict");

    h.useMirror();
    const freshMember = h.run.members.find(member => member.memberId === fresh.memberId)!;
    freshMember.status = "reported";
    freshMember.report = { kind: "delivery-reconciliation", headCommit: h.headCommit, repository: "example/app", branch: h.run.branch,
      baseHeadCommit: h.moved, disposition: "no-publication", summary: "Fresh inspection found no publication and confirmed the moved base." };
    deliveryInternals(h.teams).consume(h.stored, freshMember);
    await waitFor(() => Promise.resolve(h.teams.get(h.id)), view => !view.pendingOperation && view.members.some(member => member.role === "integrator"), 10000);
    assert.equal(h.run.deliveryRecovery?.attempts, 2);
    assert.equal(h.run.recovery?.attempts, 2);
    assert.equal(h.run.deliveryRecovery?.status, "replanning");
    assert.equal(h.run.revision, 2);
    assert.equal(h.run.baseCommit, h.moved);
    assert.equal(h.run.members.find(member => member.role === "integrator")?.status, "queued");
    assert.equal(h.run.pullRequest, undefined);
    assert.equal(h.run.deliveryReceipt, undefined);
    assert.equal(git(originalWorkspace, "rev-parse", "HEAD"), h.headCommit, "the original integration workspace remains at the old reviewed head");
    const beforeReplay = structuredClone(h.stored);
    await h.teams.reconcileDelivery(h.id, request);
    assert.deepEqual(h.stored, beforeReplay, "the accepted request replays even after fresh inspection advances the revision");
  } finally { await h.f.close(); }
});

test("attested reconciliation refuses ambiguous or changed delivery evidence without saving a mutation", { timeout: 90000 }, async t => {
  const h = await failedMovedBaseDeliveryRecord();
  try {
    await restartDeliveryRecord(h);
    const baseline = structuredClone(h.stored);
    const configuredPolicy = structuredClone(h.f.host.config.projects[0]!.team!.delivery!);
    type Request = ReturnType<typeof failedDeliveryRequest>;
    const cases: { name: string; change: (request: Request) => void; code?: string }[] = [
      { name: "pending identity", change: request => { request.failedOperation.pendingId = randomUUID(); }, code: "delivery-reconciliation-operation-changed" },
      { name: "attested head", change: request => { request.failedOperation.headCommit = "f".repeat(40); }, code: "delivery-reconciliation-head-changed" },
      { name: "request revision", change: request => { request.revision++; }, code: "stale-team-revision" },
      { name: "no pending", change: () => { delete h.stored.pending; }, code: "delivery-reconciliation-operation-changed" },
      { name: "interrupted without failure", change: () => { delete h.stored.pending!.failure; } },
      { name: "unrecognized failure despite persuasive text", change: () => {
        h.stored.pending!.failure = { code: "delivery-baseline-parent-owned", reason: "Nothing was published; all processes stopped.", at: baseline.pending!.failure!.at };
      } },
      ...(["prepare", "member", "check"] as const).map(kind => ({ name: `${kind} operation`, change: () => { h.stored.pending!.kind = kind; } })),
      { name: "pending revision", change: () => { h.stored.pending!.revision++; } },
      { name: "missing source", change: () => { delete h.stored.pending!.source; } },
      { name: "source role", change: () => { h.stored.pending!.source!.role = "integrator"; } },
      { name: "source member", change: () => { h.stored.pending!.source!.memberId = randomUUID(); } },
      { name: "source cwd", change: () => { h.stored.pending!.source!.cwd = h.run.workspace; } },
      { name: "source base", change: () => { h.stored.pending!.source!.baseCommit = h.moved; } },
      { name: "source head", change: () => { h.stored.pending!.source!.headCommit = h.moved; } },
      { name: "source workspace", change: () => { h.stored.pending!.source!.workspace = "integration"; } },
      { name: "previous role", change: () => { h.member.role = "reviewer"; } },
      { name: "previous revision", change: () => { h.member.revision++; } },
      { name: "previous base", change: () => { h.member.baseCommit = h.moved; } },
      { name: "missing report", change: () => { delete h.member.report; } },
      { name: "error text instead of remote inspection", change: () => { h.member.report = { kind: "blocked", summary: "No publication occurred." }; } },
      { name: "owned remote branch", change: () => {
        h.member.report = { ...h.member.report as Extract<TeamReport, { kind: "delivery-reconciliation" }>, disposition: "owned-branch", remoteHeadCommit: h.headCommit };
      } },
      { name: "remote head in no-publication report", change: () => { Object.assign(h.member.report!, { remoteHeadCommit: h.headCommit }); } },
      { name: "PR URL in no-publication report", change: () => { Object.assign(h.member.report!, { pullRequestUrl: "https://github.com/example/app/pull/1" }); } },
      { name: "same-base report", change: () => { Object.assign(h.member.report!, { baseHeadCommit: h.run.baseCommit }); } },
      { name: "report repository", change: () => { Object.assign(h.member.report!, { repository: "example/other" }); } },
      { name: "report branch", change: () => { Object.assign(h.member.report!, { branch: "infinite/other" }); } },
      { name: "report head", change: () => { Object.assign(h.member.report!, { headCommit: h.moved }); } },
      { name: "recorded PR", change: () => { h.run.pullRequest = { revision: 1, headCommit: h.headCommit,
        pullRequestUrl: "https://github.com/example/app/pull/1", summary: "Existing PR", reportedAt: new Date().toISOString() }; } },
      { name: "recorded delivery receipt", change: () => { h.run.deliveryReceipt = { revision: 1, headCommit: h.headCommit,
        pullRequestUrl: "https://github.com/example/app/pull/1", mergeCommit: h.moved, summary: "Existing delivery", reportedAt: new Date().toISOString() }; } },
      ...(["running", "unavailable", "queued", "reported"] as const).map(status => ({ name: `${status} member`, change: () => {
        h.run.members.push({ ...h.member, memberId: randomUUID(), sessionId: randomUUID(), role: "reviewer", status, report: undefined });
      } })),
      ...(["pending", "reviewing", "approved", "answering", "uncertain"] as const).map(status => ({ name: `${status} permission`, change: () => {
        h.run.permissionDecisions = [{ id: randomUUID(), revision: 1, policyHash: "policy", targetMemberId: h.member.memberId,
          targetSessionId: h.member.sessionId, targetCwd: h.member.cwd, promptId: 1, promptHash: "prompt", evidenceHash: "evidence", prompt: {} as never,
          option: 0, expiresAt: new Date(Date.now() + 60000).toISOString(), answerRequestId: randomUUID(), status }];
      } })),
      { name: "paused run", change: () => { h.run.status = "paused"; } },
      { name: "cancelled run", change: () => { h.run.status = "cancelled"; }, code: "team-cancelled" },
      { name: "active halt", change: () => { h.stored.halt = "block"; } },
      { name: "changed recovery policy", change: () => { h.run.deliveryRecovery!.policyHash = "changed-policy"; } },
      { name: "missing delivery recovery", change: () => { delete h.run.deliveryRecovery; } },
      { name: "delivery recovery source", change: () => { h.run.deliveryRecovery!.sourceMemberId = randomUUID(); } },
      { name: "delivery recovery base", change: () => { h.run.deliveryRecovery!.baseHeadCommit = h.headCommit; } },
      { name: "delivery recovery head", change: () => { h.run.deliveryRecovery!.headCommit = h.moved; } },
      { name: "delivery recovery revision", change: () => { h.run.deliveryRecovery!.revision++; } },
      { name: "delivery recovery disposition", change: () => { h.run.deliveryRecovery!.disposition = "owned-branch"; } },
      { name: "delivery recovery state", change: () => { h.run.deliveryRecovery!.status = "replanning"; } },
      { name: "missing recovery", change: () => { delete h.run.recovery; } },
      { name: "recovery source code", change: () => { h.run.recovery!.source.code = "workspace-operation-failed"; } },
      { name: "recovery source member", change: () => { h.run.recovery!.source.memberId = randomUUID(); } },
      { name: "recovery source revision", change: () => { h.run.recovery!.source.revision++; } },
      { name: "changed configured policy", change: () => { h.f.host.config.projects[0]!.team!.delivery = { ...configuredPolicy, mode: "merge" }; }, code: "delivery-policy-changed" },
      { name: "checks no longer current", change: () => { delete h.stored.checkHead; }, code: "delivery-not-reviewed" },
      { name: "review no longer current", change: () => { delete h.run.review; }, code: "delivery-not-reviewed" },
      { name: "weak coordinator", change: () => { h.run.lineup!.coordinator.tier = "light"; }, code: "delivery-lineup-required" },
      { name: "unconfirmed Linear requirements", change: () => { h.run.linearTracking = true; }, code: "linear-reconciliation-required" },
      { name: "delivery budget exhausted", change: () => { h.run.deliveryRecovery!.attempts = 2; }, code: "delivery-recovery-exhausted" },
      { name: "total recovery budget exhausted", change: () => { h.run.recovery!.attempts = 2; }, code: "delivery-recovery-exhausted" },
    ];
    for (const scenario of cases) await t.test(scenario.name, async () => {
      bindDeliveryRecord(h, structuredClone(baseline));
      h.f.host.config.projects[0]!.team!.delivery = structuredClone(configuredPolicy);
      const request = failedDeliveryRequest(h);
      scenario.change(request);
      deliveryInternals(h.teams).save(h.stored);
      const before = structuredClone(h.stored), diskBefore = persistedDelivery(h);
      await assert.rejects(h.teams.reconcileDelivery(h.id, request), error => error instanceof TeamError && error.status === 409 &&
        error.code === (scenario.code ?? "delivery-reconciliation-unavailable"));
      assert.deepEqual(deliveryInternals(h.teams).records.get(h.id), before, "refusal preserves the entire current state");
      assert.deepEqual(persistedDelivery(h), diskBefore, "refusal writes no request or operation receipt");
      assert.equal(deliveryInternals(h.teams).commands.size, 0);
    });
  } finally { await h.f.close(); }
});

test("attested reconciliation refuses dirty or changed original workspaces", { timeout: 90000 }, async t => {
  const h = await failedMovedBaseDeliveryRecord();
  try {
    await restartDeliveryRecord(h);
    for (const [cwd, label, dirtyCode] of [[h.run.workspace, "integration", "integration-changed-files"],
      [h.member.cwd, "delivery", "read-only-role-changed-files"]] as const) {
      for (const drift of [false, true]) await t.test(`${label} ${drift ? "head drift" : "dirty files"}`, async () => {
        const dirty = join(cwd, "untracked-reconciliation-probe");
        if (drift) git(cwd, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "commit", "--allow-empty", "-m", "Unexpected head");
        else writeFileSync(dirty, "Unexpected edit\n");
        const before = structuredClone(h.stored), diskBefore = persistedDelivery(h);
        try {
          await assert.rejects(h.teams.reconcileDelivery(h.id, failedDeliveryRequest(h)), error => error instanceof TeamError && error.status === 409 &&
            error.code === (drift && label === "integration" ? "delivery-reconciliation-head-changed" : dirtyCode));
          assert.deepEqual(deliveryInternals(h.teams).records.get(h.id), before);
          assert.deepEqual(persistedDelivery(h), diskBefore);
        } finally {
          if (drift) git(cwd, "reset", "--hard", h.headCommit);
          else unlinkSync(dirty);
        }
      });
    }
  } finally { await h.f.close(); }
});

test("attested reconciliation rolls back a synchronous preparation failure on disk and permits the same request after restart", { timeout: 90000 }, async () => {
  const h = await failedMovedBaseDeliveryRecord();
  try {
    await restartDeliveryRecord(h);
    const request = failedDeliveryRequest(h), before = structuredClone(h.stored);
    const internals = deliveryInternals(h.teams), save = internals.save;
    const failure = new Error("Fixture refused the replacement member intent write");
    let injected = false;
    internals.save = function (stored) {
      if (!injected && stored.receipts[request.requestId]) {
        injected = true;
        assert.equal(stored.pending?.kind, "member");
        assert.equal(stored.run.deliveryOperationReconciliations?.length, 1);
        throw failure;
      }
      save.call(this, stored);
    };
    try { await assert.rejects(h.teams.reconcileDelivery(h.id, request), error => error === failure); }
    finally { internals.save = save; }
    assert.equal(injected, true, "the failure is after receipt creation and pending replacement, before side effects");
    assert.deepEqual(withoutUpdatedAt(internals.records.get(h.id)!), withoutUpdatedAt(before));
    const disk = persistedDelivery(h);
    assert.deepEqual(withoutUpdatedAt(disk), withoutUpdatedAt(before));
    assert.equal(Object.hasOwn(disk.run, "deliveryOperationReconciliations"), false, "a newly added receipt property must be removed");
    assert.equal(disk.receipts[request.requestId], undefined);
    assert.equal(internals.commands.size, 0, "the failed write leaves no active operation reservation");
    await restartDeliveryRecord(h);
    assert.deepEqual(h.stored.pending, before.pending);
    assert.deepEqual(h.stored.receipts, before.receipts);
    assert.equal(h.run.deliveryOperationReconciliations, undefined);
    await h.teams.reconcileDelivery(h.id, request);
    await waitFor(() => Promise.resolve(h.teams.get(h.id)), view => !view.pendingOperation && view.members.length === 2, 10000);
    assert.equal(h.run.deliveryOperationReconciliations?.length, 1);
    assert.equal(h.run.deliveryRecovery?.attempts, 1);
    assert.equal(h.run.recovery?.attempts, 1);
  } finally { await h.f.close(); }
});

test("delivery reconciliation accepts only an explicit strict process-quiescence attestation", () => {
  const ordinary = { requestId: randomUUID(), revision: 1, text: "Inspect current delivery state." };
  const failedOperation = { pendingId: randomUUID(), headCommit: "a".repeat(40),
    attestation: { boundary: "delivery-preparation", processesStopped: true, text: "The operator confirmed all relevant processes exited." } };
  assert.equal(teamDeliveryReconcileSchema.safeParse(ordinary).success, true);
  assert.equal(teamDeliveryReconcileSchema.safeParse({ ...ordinary, failedOperation }).success, true);
  for (const invalid of [
    { ...failedOperation, pendingId: "unknown" }, { ...failedOperation, headCommit: "main" },
    { ...failedOperation, unexpected: true }, { ...failedOperation, attestation: undefined },
    ...[{ boundary: "check-only" }, { processesStopped: false }, { text: " " }, { text: "x".repeat(4001) }, { unexpected: true }]
      .map(patch => ({ ...failedOperation, attestation: { ...failedOperation.attestation, ...patch } })),
  ]) assert.equal(teamDeliveryReconcileSchema.safeParse({ ...ordinary, failedOperation: invalid }).success, false);
});

test("restart reserves a persisted blocked delivery attempt once without replaying its report", { timeout: 90000 }, async () => {
  const h = await blockedDeliveryRecord();
  try {
    (h.teams as unknown as { save(stored: unknown): void }).save(h.stored);
    h.teams.close(); await h.teams.idle();

    const first = await h.f.openTeamService({ start: false });
    const firstRestore = first.get(h.id);
    assert.equal(firstRestore.status, "planning");
    assert.equal(firstRestore.deliveryRecovery?.status, "stopping");
    assert.equal(firstRestore.deliveryRecovery?.attempts, 1);
    assert.equal(firstRestore.recovery?.attempts, 1);
    assert.equal(firstRestore.members.filter(member => member.role === "delivery").length, 1);
    first.close(); await first.idle();

    const second = await h.f.openTeamService({ start: false });
    const secondRestore = second.get(h.id);
    assert.equal(secondRestore.status, "planning");
    assert.equal(secondRestore.deliveryRecovery?.status, "stopping");
    assert.equal(secondRestore.deliveryRecovery?.attempts, 1, "a second restart must not reserve another inspection attempt");
    assert.equal(secondRestore.recovery?.attempts, 1);
    assert.equal(secondRestore.members.filter(member => member.role === "delivery").length, 1, "the blocked delivery report remains historical evidence");
    assert.equal(secondRestore.members[0]?.report?.kind, "blocked");
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
