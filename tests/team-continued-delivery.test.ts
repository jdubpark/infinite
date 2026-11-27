import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, git, limitLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";
import { TeamError } from "../packages/host/src/teams.js";
import { PULL_REQUEST_BRANCH_FIELDS } from "../packages/host/src/review-feedback.js";
import type { TeamReport } from "../packages/host/src/team-types.js";
import { deliveryInternals, deliveryRecord } from "./fixtures/team-delivery-record.js";

const PULL_REQUEST = "https://github.com/example/app/pull/7";

const branchHistory = (remote: string, branch: string) => git(remote, "reflog", "show", "--format=%H", `refs/heads/${branch}`).split("\n").filter(Boolean);

function stubGh(stateDir: string, mode: { exitCode: number; stdout?: string; stderr?: string; startedFile?: string; waitForFile?: string }) {
  const dir = join(stateDir, `fake-gh-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "response.json"), JSON.stringify(mode));
  const script = `const fs = require("node:fs"); const { spawnSync } = require("node:child_process");
const [dir, command, ...args] = process.argv.slice(1);
if (command === "gh") {
  fs.appendFileSync(dir + "/gh.log", JSON.stringify([command, ...args]) + "\\n");
  const response = JSON.parse(fs.readFileSync(dir + "/response.json", "utf8"));
  if (response.startedFile) fs.writeFileSync(response.startedFile, "started");
  const finish = () => {
    if (response.stdout) process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(response.stderr);
    process.exit(response.exitCode);
  };
  if (response.waitForFile) {
    const timer = setInterval(() => {
      if (fs.existsSync(response.waitForFile)) { clearInterval(timer); finish(); }
    }, 25);
  } else {
    finish();
  }
} else {
  const child = spawnSync(command, args, { stdio: "inherit" });
  process.exit(child.status ?? 1);
}`;
  const ghCalls = (): string[][] => existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { commandPrefix: { command: process.execPath, args: ["-e", script, dir] }, ghCalls, dir };
}

test("a steer on a delivered pull request recovers a blocked member, publishes only a checkpoint before review, and updates the same pull request", { timeout: 240000 }, async () => {
  const f = await fixture("delivery-continued", limitLineup, {}, { deliveryMode: "pr" });
  try {
    const remote = join(f.host.root, "publication-remote.git");
    git(f.source, "clone", "--bare", f.source, remote);
    git(remote, "config", "core.logAllRefUpdates", "always");
    writeFileSync(join(f.receipts, "delivery-remote"), remote);
    f.host.config.projects[0]!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
    f.host.config.source = { ...f.host.config.source, remoteOverrides: { rehearsal: remote } };
    Object.assign(f.host.config.teams!, { publishHeads: true });
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();

    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const delivered = await f.settled(created.body.id);
    assert.equal(delivered.status, "ready-for-review", JSON.stringify(delivered));
    const id = delivered.id, branch = delivered.branch, first = delivered.headCommit!;
    assert.equal(delivered.pullRequest?.revision, 1);
    assert.equal(delivered.pullRequest?.branch, branch, "the pull request report records the branch delivery was granted");
    const delivery1 = branchHistory(remote, branch);
    assert.equal(delivery1[0], first);

    const steered = await f.host.fetchApi(`/teams/${id}/steer`, "owner", { requestId: randomUUID(), revision: delivered.revision, text: "Use the compact label in both files." });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    assert.equal(steered.body.revision, 2);

    const held = await waitFor(() => f.get(id), run => run.status === "blocked" || existsSync(join(f.receipts, "delivery-started-3.json")), 180000);
    assert.notEqual(held.status, "blocked", JSON.stringify({ reason: held.reason, recovery: held.recovery, events: held.events.slice(-6) }));
    const delivery = JSON.parse(readFileSync(join(f.receipts, "delivery-started-3.json"), "utf8")) as { head: string; branch: string; continued: boolean; prompt: string };
    const view = await f.get(id);
    assert.deepEqual([view.recovery?.source.code, view.recovery?.attempts, view.revision], ["agent-blocked", 1, 3], "the blocked member was recovered by the project manager");
    assert.deepEqual([view.review?.verdict, view.review?.revision], ["approved", 3]);
    const checkpoint = `${branch}-${view.headCommit!.slice(0, 8)}`;
    assert.deepEqual([view.publication?.branch, view.publication?.commit], [checkpoint, view.headCommit]);
    assert.equal(git(remote, "rev-parse", `refs/heads/${checkpoint}`), view.headCommit);
    assert.deepEqual(branchHistory(remote, branch), delivery1, "nothing reaches the pull request's branch before the review passes");
    assert.deepEqual([delivery.branch, delivery.head, delivery.continued], [branch, view.headCommit, true], "delivery pushes to the pull request's own branch");
    assert.ok(delivery.prompt.includes(`This run continues its pull request ${PULL_REQUEST} on branch ${branch}`));
    assert.ok(delivery.prompt.includes(`${checkpoint} as a checkpoint`));
    assert.ok(delivery.prompt.includes(`If the branch exists, allow only an unchanged head or a fast-forward from a head recorded for this run, its earlier repair heads or the head it delivered to its pull request: ${JSON.stringify([first])}.`),
      "one push rule names the delivered head");
    assert.ok(!delivery.prompt.includes("a fast-forward from an earlier repair head recorded for this run"));
    assert.ok(!delivery.prompt.includes('report the "no-publication" disposition.'), "the prompt does not offer clean-base recovery");

    writeFileSync(join(f.receipts, "delivery-continued-release"), "continue");
    const updated = await waitFor(() => f.get(id), run => ["ready-for-review", "blocked"].includes(run.status), 60000);
    assert.equal(updated.status, "ready-for-review", JSON.stringify(updated.events.slice(-6)));
    assert.deepEqual([updated.pullRequest?.revision, updated.pullRequest?.headCommit, updated.pullRequest?.pullRequestUrl, updated.pullRequest?.branch],
      [3, updated.headCommit, PULL_REQUEST, branch]);
    assert.deepEqual(branchHistory(remote, branch), [updated.headCommit, ...delivery1], "the reviewed head reached the same branch once, by delivery");
    git(remote, "merge-base", "--is-ancestor", first, updated.headCommit!);
    assert.equal(updated.members.filter(member => member.role === "delivery").length, 2);
  } finally {
    writeFileSync(join(f.receipts, "delivery-continued-release"), "continue after test cleanup");
    await f.close();
  }
});

test("a continued delivery reports only its recorded pull request, and a steer keeps an earlier delivery recovery's count but not its record", { timeout: 60000 }, async () => {
  const h = await deliveryRecord("pr");
  try {
    const at = new Date().toISOString();
    h.run.lineup = structuredClone(limitLineup);
    h.run.status = "ready-for-review"; h.stored.deliveryAttempt = undefined; h.member.status = "stopped";
    h.run.pullRequest = { revision: 1, headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST, summary: "Opened for review.", reportedAt: at, branch: h.run.branch };
    h.run.deliveryRecovery = { attempts: 1, status: "complete", revision: 1, headCommit: h.headCommit, policyHash: "recorded", sourceMemberId: h.member.memberId };
    const steered = await h.teams.steer(h.id, { requestId: randomUUID(), revision: 1, text: "Use the compact label." });
    assert.equal(steered.revision, 2);
    assert.equal(h.run.deliveryRecovery, undefined);
    assert.equal(h.run.deliveryRecoveryAttempts, 1, "the recovery limit stays cumulative");
    assert.equal(h.run.pullRequest?.revision, 1, "the owner keeps the link");

    Object.assign(h.run, { status: "delivering", review: { verdict: "approved", summary: "Reviewed again.", revision: 2 } });
    Object.assign(h.member, { revision: 2, status: "reported" });
    h.stored.checkHead = h.headCommit; h.stored.halt = undefined;
    h.stored.deliveryAttempt = { memberId: h.member.memberId, revision: 2, headCommit: h.headCommit };
    const inspection = { kind: "delivery-reconciliation", headCommit: h.headCommit, repository: "example/app", branch: h.run.branch, baseHeadCommit: h.headCommit,
      summary: "Inspected the remote." } as const;
    const refused = (report: TeamReport, code: string) =>
      assert.throws(() => h.consume(report), error => error instanceof TeamError && error.code === code, `${report.kind} ${"disposition" in report ? report.disposition : ""}`);
    refused({ ...inspection, disposition: "no-publication" }, "delivery-pull-request-recorded");
    refused({ ...inspection, disposition: "owned-branch", remoteHeadCommit: h.headCommit }, "delivery-pull-request-recorded");
    refused({ ...inspection, disposition: "pull-request", remoteHeadCommit: h.headCommit, pullRequestUrl: "https://github.com/example/app/pull/8" }, "delivery-pull-request-recorded");
    refused({ ...inspection, branch: `${h.run.branch}-checkpoint`, disposition: "pull-request", remoteHeadCommit: h.headCommit, pullRequestUrl: PULL_REQUEST }, "delivery-reconciliation-stale");
    refused({ kind: "pull-request", headCommit: h.headCommit, pullRequestUrl: "https://github.com/example/app/pull/8", summary: "Opened another." }, "delivery-target-mismatch");
    assert.equal(h.run.pullRequest?.revision, 1, "a refused report records nothing");

    h.consume({ kind: "pull-request", headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST.replace("example/app", "Example/App"), summary: "Updated the pull request." });
    const ready = await waitFor(() => Promise.resolve(h.teams.get(h.id)), run => ["ready-for-review", "blocked"].includes(run.status), 10000);
    assert.equal(ready.status, "ready-for-review", JSON.stringify(ready.events.slice(-4)));
    assert.deepEqual([ready.pullRequest?.revision, ready.pullRequest?.branch], [2, h.run.branch]);
  } finally { await h.f.close(); }
});

test("a failed delivery in a continued revision blocks for the owner instead of recovering by itself", { timeout: 60000 }, async () => {
  for (const continued of [false, true]) {
    const h = await deliveryRecord("pr");
    try {
      h.run.lineup = structuredClone(limitLineup);
      if (continued) {
        h.run.pullRequest = { revision: 1, headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST, summary: "Opened for review.", reportedAt: new Date().toISOString(), branch: h.run.branch };
        h.run.revision = 2; h.run.review!.revision = 2; h.member.revision = 2; h.stored.deliveryAttempt!.revision = 2;
      }
      h.member.status = "stopped";
      h.consume({ kind: "blocked", summary: "The provider refused the push." });
      if (continued) {
        assert.equal(h.run.status, "blocked", "the owner decides what a continued delivery does next");
        assert.equal(h.run.deliveryRecovery, undefined);
      } else assert.equal(h.run.deliveryRecovery?.status, "stopping", "a first delivery inspects the remote by itself");
    } finally { await h.f.close(); }
  }
});

test("a run continued from a pull request recorded without its branch blocks at delivery instead of delivering to its checkpoint", { timeout: 60000 }, async () => {
  const h = await deliveryRecord("pr");
  try {
    const gh = stubGh(h.f.host.config.stateDir, { exitCode: 1, stderr: "Could not resolve to a PullRequest" });
    h.f.host.config.teams!.commandPrefix = gh.commandPrefix;
    const checkpoint = `${h.run.branch}-${h.headCommit.slice(0, 8)}`;
    Object.assign(h.run, { lineup: structuredClone(limitLineup), revision: 2, status: "reviewing",
      pullRequest: { revision: 1, headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST, summary: "Opened for review.", reportedAt: new Date().toISOString() },
      publication: { repository: h.run.delivery!.repository, branch: checkpoint, commit: h.headCommit, publishedAt: new Date().toISOString() },
      tasks: [{ id: "a", title: "a", instructions: "Change the label.", paths: ["src/a.ts"], dependsOn: [], revision: 2, status: "integrated", commit: h.headCommit }],
      review: { verdict: "approved", summary: "Reviewed the continued head.", revision: 2 } });
    h.member.status = "stopped"; h.stored.deliveryAttempt = undefined; h.stored.checkHead = h.headCommit;
    await deliveryInternals(h.teams).step(h.stored);
    await h.teams.idle();
    assert.deepEqual(gh.ghCalls(), [["gh", "pr", "view", "7", "--json", PULL_REQUEST_BRANCH_FIELDS, "--repo", "example/app"]]);
    assert.deepEqual([h.run.status, h.run.blockCode], ["blocked", "delivery-branch-unknown"], JSON.stringify(h.run.events.slice(-3)));
    assert.match(h.run.reason ?? "", /recorded before the host kept its branch/);
    assert.deepEqual(h.run.members.filter(member => member.role === "delivery" && member.revision === 2), [], "no delivery is granted the checkpoint");
    assert.equal(h.stored.deliveryAttempt, undefined);
    assert.equal(h.run.pullRequest?.branch, undefined);
  } finally { await h.f.close(); }
});

test("redelivering a legacy pull request missing its branch resolves and persists the branch on demand, then reuses it", { timeout: 60000 }, async () => {
  const h = await deliveryRecord("pr");
  try {
    const gh = stubGh(h.f.host.config.stateDir, { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, baseRefName: "main", headRefName: h.run.branch }) });
    h.f.host.config.teams!.commandPrefix = gh.commandPrefix;
    const checkpoint = `${h.run.branch}-${h.headCommit.slice(0, 8)}`;
    Object.assign(h.run, { lineup: structuredClone(limitLineup), revision: 2, status: "reviewing",
      pullRequest: { revision: 1, headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST, summary: "Opened for review.", reportedAt: new Date().toISOString() },
      publication: { repository: h.run.delivery!.repository, branch: checkpoint, commit: h.headCommit, publishedAt: new Date().toISOString() },
      tasks: [{ id: "a", title: "a", instructions: "Change the label.", paths: ["src/a.ts"], dependsOn: [], revision: 2, status: "integrated", commit: h.headCommit }],
      review: { verdict: "approved", summary: "Reviewed the continued head.", revision: 2 } });
    h.member.status = "stopped"; h.stored.deliveryAttempt = undefined; h.stored.checkHead = h.headCommit;
    const internals = deliveryInternals(h.teams);
    await internals.step(h.stored);
    const queued = await waitFor(
      () => Promise.resolve(h.run.members.filter(member => member.role === "delivery" && member.revision === 2)),
      members => members.length === 1,
      10000,
    );

    assert.deepEqual(gh.ghCalls(), [["gh", "pr", "view", "7", "--json", PULL_REQUEST_BRANCH_FIELDS, "--repo", "example/app"]]);
    assert.equal(h.run.pullRequest?.branch, h.run.branch);
    assert.equal(h.run.status, "delivering", JSON.stringify(h.run.events.slice(-4)));
    assert.equal(queued.length, 1);
    assert.ok(queued[0]!.prompt.includes(`This run continues its pull request ${PULL_REQUEST} on branch ${h.run.branch}`));

    const persisted = await h.teams.steer(h.id, { requestId: randomUUID(), revision: 2, text: "Adjust spacing." });
    assert.equal(persisted.revision, 3);
    assert.equal(persisted.pullRequest?.branch, h.run.branch);
    assert.equal(gh.ghCalls().length, 1, "subsequent steer reuses the persisted branch without another gh lookup");
  } finally { await h.f.close(); }
});

test("launching a restored unlaunched delivery member resolves a legacy pull request branch before rebuilding its prompt", { timeout: 60000 }, async () => {
  const h = await deliveryRecord("pr");
  try {
    const gh = stubGh(h.f.host.config.stateDir, { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, baseRefName: "main", headRefName: h.run.branch }) });
    h.f.host.config.teams!.commandPrefix = gh.commandPrefix;
    const at = new Date().toISOString();
    const checkpoint = `${h.run.branch}-${h.headCommit.slice(0, 8)}`;
    Object.assign(h.run, { lineup: structuredClone(limitLineup), revision: 2, status: "delivering",
      pullRequest: { revision: 1, headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST, summary: "Opened for review.", reportedAt: at },
      publication: { repository: h.run.delivery!.repository, branch: checkpoint, commit: h.headCommit, publishedAt: at },
      tasks: [{ id: "a", title: "a", instructions: "Change the label.", paths: ["src/a.ts"], dependsOn: [], revision: 2, status: "integrated", commit: h.headCommit }],
      review: { verdict: "approved", summary: "Reviewed the continued head.", revision: 2 } });
    Object.assign(h.member, { revision: 2, status: "queued", prompt: "Legacy delivery prompt before branch was persisted." });
    delete h.member.startedAt;
    h.stored.deliveryAttempt = undefined;
    h.stored.checkHead = h.headCommit;

    let launchedPrompt = "";
    let launchedRefs: string[] | undefined;
    const manager = (h.teams as unknown as {
      manager: {
        list: () => Promise<{ status: string }[]>;
        createTeamSession: (
          request: { prompt: string },
          assignment: unknown,
          cwd: string,
          profile: unknown,
          root: string,
          trusted: unknown,
          header: unknown,
          github?: { refs?: string[] },
        ) => Promise<{ status: string }>;
      };
    }).manager;
    manager.createTeamSession = async (request, _assignment, _cwd, _profile, _root, _trusted, _header, github) => {
      launchedPrompt = request.prompt;
      launchedRefs = github?.refs;
      return { status: "running" };
    };

    await deliveryInternals(h.teams).step(h.stored);
    await h.teams.idle();

    assert.deepEqual(gh.ghCalls(), [["gh", "pr", "view", "7", "--json", PULL_REQUEST_BRANCH_FIELDS, "--repo", "example/app"]]);
    assert.equal(h.run.pullRequest?.branch, h.run.branch);
    assert.equal(h.run.status, "delivering", JSON.stringify(h.run.events.slice(-4)));
    assert.equal(h.member.status, "running");
    assert.deepEqual(launchedRefs, [`refs/heads/${h.run.branch}`]);
    assert.ok(launchedPrompt.includes(`This run continues its pull request ${PULL_REQUEST} on branch ${h.run.branch}`));
    assert.ok(launchedPrompt.includes(`${checkpoint} as a checkpoint`));
  } finally { await h.f.close(); }
});

test("launching a restored queued delivery member rebuilds a stale pre-branch prompt even when pullRequest.branch is already saved", { timeout: 60000 }, async () => {
  const h = await deliveryRecord("pr");
  try {
    const gh = stubGh(h.f.host.config.stateDir, { exitCode: 1, stderr: "gh should not be invoked when branch is already persisted" });
    h.f.host.config.teams!.commandPrefix = gh.commandPrefix;
    const at = new Date().toISOString();
    Object.assign(h.run, { lineup: structuredClone(limitLineup), revision: 2, status: "delivering",
      pullRequest: { revision: 1, headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST, summary: "Opened for review.", reportedAt: at, branch: h.run.branch },
      publication: undefined,
      tasks: [{ id: "a", title: "a", instructions: "Change the label.", paths: ["src/a.ts"], dependsOn: [], revision: 2, status: "integrated", commit: h.headCommit }],
      review: { verdict: "approved", summary: "Reviewed the continued head.", revision: 2 } });
    Object.assign(h.member, { revision: 2, status: "queued", prompt: "Stale pre-branch prompt persisted before crash." });
    delete h.member.startedAt;
    h.stored.deliveryAttempt = undefined;
    h.stored.checkHead = h.headCommit;

    let launchedPrompt = "";
    let launchedRefs: string[] | undefined;
    const manager = (h.teams as unknown as {
      manager: {
        createTeamSession: (
          request: { prompt: string },
          assignment: unknown,
          cwd: string,
          profile: unknown,
          root: string,
          trusted: unknown,
          header: unknown,
          github?: { refs?: string[] },
        ) => Promise<{ status: string }>;
      };
    }).manager;
    manager.createTeamSession = async (request, _assignment, _cwd, _profile, _root, _trusted, _header, github) => {
      launchedPrompt = request.prompt;
      launchedRefs = github?.refs;
      return { status: "running" };
    };

    await deliveryInternals(h.teams).step(h.stored);

    assert.deepEqual(gh.ghCalls(), []);
    assert.equal(h.member.status, "running");
    assert.deepEqual(launchedRefs, [`refs/heads/${h.run.branch}`]);
    assert.ok(launchedPrompt.includes(`This run continues its pull request ${PULL_REQUEST} on branch ${h.run.branch}`));
  } finally { await h.f.close(); }
});

test("aborting an in-flight legacy branch lookup on host shutdown leaves the run unblocked and retryable", { timeout: 60000 }, async () => {
  const h = await deliveryRecord("pr");
  try {
    const startedFile = join(h.f.host.config.stateDir, "gh-abort-started");
    const waitForFile = join(h.f.host.config.stateDir, "gh-abort-never");
    const gh = stubGh(h.f.host.config.stateDir, { exitCode: 0, stdout: "{}", startedFile, waitForFile });
    h.f.host.config.teams!.commandPrefix = gh.commandPrefix;
    Object.assign(h.run, { lineup: structuredClone(limitLineup), revision: 2, status: "reviewing",
      pullRequest: { revision: 1, headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST, summary: "Opened for review.", reportedAt: new Date().toISOString() },
      tasks: [{ id: "a", title: "a", instructions: "Change the label.", paths: ["src/a.ts"], dependsOn: [], revision: 2, status: "integrated", commit: h.headCommit }],
      review: { verdict: "approved", summary: "Reviewed the continued head.", revision: 2 } });
    h.member.status = "stopped"; h.stored.deliveryAttempt = undefined; h.stored.checkHead = h.headCommit;

    await deliveryInternals(h.teams).step(h.stored);
    await waitFor(() => Promise.resolve(existsSync(startedFile)), started => started, 10000);
    await h.teams.close();

    assert.equal(h.run.status, "reviewing");
    assert.equal(h.run.blockCode, undefined);
    assert.equal(h.run.pullRequest?.branch, undefined);
    assert.equal(h.stored.deliveryAttempt, undefined);
  } finally { await h.f.close(); }
});

test("a slow legacy branch lookup runs off the scheduler tick without stalling another team or owner pause", { timeout: 60000 }, async () => {
  const h = await deliveryRecord("pr");
  try {
    const startedFile = join(h.f.host.config.stateDir, "gh-slow-started");
    const releaseFile = join(h.f.host.config.stateDir, "gh-slow-release");
    const gh = stubGh(h.f.host.config.stateDir, {
      exitCode: 0,
      stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, baseRefName: "main", headRefName: h.run.branch }),
      startedFile,
      waitForFile: releaseFile,
    });
    h.f.host.config.teams!.commandPrefix = gh.commandPrefix;
    Object.assign(h.run, { lineup: structuredClone(limitLineup), revision: 2, status: "reviewing",
      pullRequest: { revision: 1, headCommit: h.headCommit, pullRequestUrl: PULL_REQUEST, summary: "Opened for review.", reportedAt: new Date().toISOString() },
      tasks: [{ id: "a", title: "a", instructions: "Change the label.", paths: ["src/a.ts"], dependsOn: [], revision: 2, status: "integrated", commit: h.headCommit }],
      review: { verdict: "approved", summary: "Reviewed the continued head.", revision: 2 } });
    h.member.status = "stopped"; h.stored.deliveryAttempt = undefined; h.stored.checkHead = h.headCommit;

    const otherId = randomUUID();
    const otherStored = structuredClone(h.stored);
    otherStored.run.id = otherId;
    otherStored.run.status = "paused";
    otherStored.run.pullRequest = undefined;
    const internals = deliveryInternals(h.teams);
    internals.records.set(otherId, otherStored);
    let otherSteps = 0;
    const originalStep = internals.step.bind(h.teams);
    internals.step = async stored => {
      if (stored.run.id === otherId) { otherSteps += 1; return; }
      return originalStep(stored);
    };

    h.teams.start();
    await waitFor(() => Promise.resolve(existsSync(startedFile)), started => started, 10000);
    await waitFor(() => Promise.resolve(otherSteps), count => count >= 2, 10000);
    const paused = await h.teams.pause(h.id, { requestId: randomUUID(), revision: 2 });
    assert.equal(paused.status, "paused", "owner pause completes without waiting on slow gh pr view");
    assert.equal(existsSync(releaseFile), false, "pause completed while gh pr view was still running");

    writeFileSync(releaseFile, "go");
    await h.teams.idle();
    assert.equal(h.run.status, "paused", "completion revalidation does not unpause or block a paused run");
    assert.equal(h.run.pullRequest?.branch, undefined);
  } finally {
    await h.teams.close();
    await h.f.close();
  }
});
