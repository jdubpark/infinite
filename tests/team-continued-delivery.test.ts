import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, git, limitLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { TeamReport } from "../packages/host/src/team-types.js";
import { deliveryRecord } from "./fixtures/team-delivery-record.js";

// INF-324 step 2: a run steered after it delivered a pull request works again and updates that same pull request.

const PULL_REQUEST = "https://github.com/example/app/pull/7";

/** The commits a bare remote's branch pointed at, newest first. The remote logs every ref update. */
const branchHistory = (remote: string, branch: string) => git(remote, "reflog", "show", "--format=%H", `refs/heads/${branch}`).split("\n").filter(Boolean);

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
    // The host publishes each integrated head of a first delivery to the run's branch.
    const delivery1 = branchHistory(remote, branch);
    assert.equal(delivery1[0], first);

    const steered = await f.host.fetchApi(`/teams/${id}/steer`, "owner", { requestId: randomUUID(), revision: delivered.revision, text: "Use the compact label in both files." });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    assert.equal(steered.body.revision, 2);

    // Revision 2's first implementer blocks; the project manager's recovery replans it as revision 3.
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
    // A delivery recovery that ran before the first delivery leaves its record complete.
    h.run.deliveryRecovery = { attempts: 1, status: "complete", revision: 1, headCommit: h.headCommit, policyHash: "recorded", sourceMemberId: h.member.memberId };
    const steered = await h.teams.steer(h.id, { requestId: randomUUID(), revision: 1, text: "Use the compact label." });
    assert.equal(steered.revision, 2);
    assert.equal(h.run.deliveryRecovery, undefined);
    assert.equal(h.run.deliveryRecoveryAttempts, 1, "the recovery limit stays cumulative");
    assert.equal(h.run.pullRequest?.revision, 1, "the owner keeps the link");

    // The continued revision passed its checks and review at the same head; its delivery member reports.
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
