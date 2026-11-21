import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import type { FuseGate } from "../packages/host/src/fuse/types.js";
import { PULL_REQUEST_FIELDS, type ReviewIntake, reviewRequestId } from "../packages/host/src/review-feedback.js";
import type { TeamReviewFeedback } from "../packages/host/src/team-review-feedback.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Saved = { run: TeamRun; receipts: Record<string, string>; reviewIntake?: ReviewIntake };
type Review = { id: string; author: { login: string } | null; state: string; submittedAt: string; body: string; commit: { oid: string } };

const owner = "owner-login", repository = "example-org/example-repo", branch = "infinite/review-fixture";
const pullRequestUrl = `https://github.com/${repository}/pull/7`;
const requested = "Rename the flag to --strict and keep the old name as an alias.";
const ghRead = ["gh", "pr", "view", "7", "--json", PULL_REQUEST_FIELDS, "--repo", repository];
/**
 * The fake `gh`, run through the teams command prefix: it logs every command and prints the pull request the test wrote.
 * Field names follow GitHub's documented `gh pr view --json` output; they are not checked against a real review here.
 */
const fakeGh = `const fs = require("node:fs"); const [dir, command, ...args] = process.argv.slice(1);
fs.appendFileSync(dir + "/commands.log", JSON.stringify([command, ...args]) + "\\n");
if (command !== "gh") process.exit(3);
if (fs.existsSync(dir + "/gate")) { const cell = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(dir + "/release")) Atomics.wait(cell, 0, 0, 20); }
process.stdout.write(fs.readFileSync(dir + "/pull-request.json", "utf8"));`;

/** A run delivered as a pull request at revision 1 and ready for review, with review feedback switched as asked. */
function delivered(f: Fixture, enabled = true) {
  const dir = join(f.config.stateDir, "fake-github"), head = f.run.baseCommit;
  mkdirSync(dir, { recursive: true });
  f.config.teams!.commandPrefix = { command: process.execPath, args: ["-e", fakeGh, dir] };
  f.config.github = { reviewFeedback: { enabled, ownerLogin: owner, pollMinutes: 5 } };
  Object.assign(f.run, { status: "ready-for-review", delivery: { mode: "pr", repository, baseBranch: "main" },
    pullRequest: { revision: 1, headCommit: head, pullRequestUrl, summary: "Delivered the flag.", reportedAt: new Date().toISOString(), branch } });
  f.writeTeam();
  const later = new Date(Date.now() + 60_000).toISOString();
  return {
    head,
    review: (id: string, login: string, state: string, body = requested, submittedAt = later): Review => ({ id, author: { login }, state, submittedAt, body, commit: { oid: head } }),
    show: (reviews: Review[], extra: object = {}) => writeFileSync(join(dir, "pull-request.json"),
      JSON.stringify({ state: "OPEN", isCrossRepository: false, baseRefName: "main", headRefName: branch, headRefOid: head, reviews, ...extra })),
    commands: (): string[][] => existsSync(join(dir, "commands.log")) ? readFileSync(join(dir, "commands.log"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    /** Holds every later read until `release`. */
    gate: () => writeFileSync(join(dir, "gate"), ""),
    release: () => writeFileSync(join(dir, "release"), ""),
  };
}
/** Waits until `ready` holds, checking every 20 ms for at most 10 s. */
async function until(ready: () => boolean) {
  for (let tries = 0; !ready(); tries++) {
    assert.ok(tries < 500, "the condition holds within 10 s");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const poller = (teams: TeamService) => (teams as unknown as { reviewFeedback: TeamReviewFeedback }).reviewFeedback;
const events = (saved: Saved) => saved.run.events.map(event => event.text);

/** Stops the host after its `stopAt`-th team record write once armed: later writes of the record fail, as if the process died. */
function hostStop(f: Fixture, stopAt: number) {
  let armed = false, writes = 0, restore: (() => void) | undefined;
  const entries = { retryable: () => false, mirror: () => {
    if (armed && ++writes === stopAt) restore = f.blockRecordWrites("team", f.run.id);
    return true;
  } };
  return { entries: entries as unknown as Blackboard, arm: () => { armed = true; }, stopped: () => restore !== undefined, restart: () => restore?.() };
}

test("one changes-requested review by the owner starts exactly one follow-up, and a repeat of that review starts none", async () => {
  const f = schedulerFixture();
  try {
    const gh = delivered(f);
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
    const teams = f.openTeam(), feedback = poller(teams);
    await feedback.start();
    assert.deepEqual(gh.commands(), [], "startup only drains saved intents; it reads no pull request");
    await feedback.poll();

    let saved = f.readRecord<Saved>("team", f.run.id);
    assert.deepEqual(gh.commands(), [ghRead], "one read, through the operation the GitHub proxy allows under pr");
    assert.equal(saved.run.revision, 2);
    assert.equal(saved.run.status, "planning");
    assert.deepEqual(saved.run.steering.map(item => [item.text, item.revision, item.source]), [[requested, 2, { kind: "github-review", id: "PRR_1", name: "Your GitHub review" }]]);
    assert.ok(saved.receipts[reviewRequestId(f.run.id, "PRR_1")], "the steer saved its receipt under the review's request id");
    assert.deepEqual(saved.reviewIntake?.intents.map(intent => [intent.reviewId, intent.state, intent.targetRevision]), [["PRR_1", "applied", 1]]);
    assert.deepEqual([saved.reviewIntake?.handled, saved.reviewIntake?.accepted], [["PRR_1"], 1]);
    assert.deepEqual(saved.run.reviewFeedback?.map(entry => [entry.reviewId, entry.state, entry.outcome]), [["PRR_1", "CHANGES_REQUESTED", "applied"]]);
    assert.ok(events(saved).includes("Owner (GitHub review) steering recorded. Earlier reports cannot satisfy the new revision."));
    assert.ok(events(saved).includes("The owner requested changes on the pull request (review PRR_1). The run continues from its delivered commit at revision 2."));

    // The steered run is planning, so later polls read nothing and steer nothing.
    await feedback.poll();
    assert.equal(gh.commands().length, 1);
    teams.close();

    // The follow-up delivers to the same pull request at revision 2 while GitHub still shows the same review as newest.
    const record = f.readRecord<Saved & Record<string, unknown>>("team", f.run.id);
    Object.assign(record.run, { status: "ready-for-review", pullRequest: { ...record.run.pullRequest!, revision: 2 } });
    f.writeRecord("team", f.run.id, record);
    const again = f.openTeam(), repeat = poller(again);
    await repeat.start();
    await repeat.poll();
    await repeat.poll();
    saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(gh.commands().length, 3, "the delivered run is watched again");
    assert.equal(saved.run.revision, 2, "the same review starts no second follow-up");
    assert.equal(saved.run.steering.length, 1);
    assert.equal(saved.reviewIntake?.accepted, 1);
  } finally { f.close(); }
});

test("a review by another login, an approval, and a plain comment start nothing", async () => {
  for (const [name, author, state, outcome] of [["another login", "someone-else", "CHANGES_REQUESTED", undefined], ["an approval", owner, "APPROVED", "approved-seen"],
    ["a plain comment", owner, "COMMENTED", undefined]] as const) {
    const f = schedulerFixture();
    try {
      const gh = delivered(f);
      gh.show([gh.review("PRR_1", author, state)]);
      const teams = f.openTeam(), feedback = poller(teams);
      await feedback.start();
      await feedback.poll();
      await feedback.poll();
      const saved = f.readRecord<Saved>("team", f.run.id);
      assert.equal(gh.commands().length, 2, `${name}: the run stays watched`);
      assert.equal(saved.run.revision, 1, `${name} starts no follow-up`);
      assert.deepEqual(saved.run.steering, []);
      assert.equal(saved.run.status, "ready-for-review");
      assert.deepEqual(saved.reviewIntake?.intents ?? [], []);
      assert.deepEqual(saved.run.reviewFeedback?.map(entry => entry.outcome), outcome ? [outcome] : undefined, `${name} is shown only when it is the owner's counted review`);
    } finally { f.close(); }
  }
});

test("with the switch off the host reads no pull request and writes nothing", async () => {
  const f = schedulerFixture();
  try {
    const gh = delivered(f, false);
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
    const before = f.readRecord<Saved>("team", f.run.id);
    const teams = f.openTeam(), feedback = poller(teams);
    assert.equal(feedback.start(), undefined);
    await feedback.poll();
    assert.deepEqual(gh.commands(), []);
    assert.deepEqual(f.readRecord<Saved>("team", f.run.id), before);
    assert.equal(existsSync(join(f.config.stateDir, "teams", "review-feedback.sealed")), false, "no switch record is written while the switch was never on");
  } finally { f.close(); }
});

test("a review submitted before the switch was last turned on starts nothing", async () => {
  const f = schedulerFixture();
  try {
    const gh = delivered(f);
    const wait = () => new Promise(resolve => setTimeout(resolve, 20));
    await poller(f.openTeam()).start();
    await wait();
    const between = new Date().toISOString();
    await wait();
    // Off, then on again: only reviews after the second switch-on count.
    f.config.github!.reviewFeedback!.enabled = false;
    poller(f.openTeam()).start();
    f.config.github!.reviewFeedback!.enabled = true;
    const teams = f.openTeam(), feedback = poller(teams);
    await feedback.start();
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED", requested, between)]);
    await feedback.poll();
    const saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(saved.run.revision, 1);
    assert.deepEqual(saved.run.reviewFeedback?.map(entry => [entry.reviewId, entry.outcome]), [["PRR_1", "before-enable"]]);
  } finally { f.close(); }
});

test("whichever record write a review's steer stops after, the restarted host steers exactly once", async () => {
  const requestId = (f: Fixture) => reviewRequestId(f.run.id, "PRR_1");
  let stops = 0;
  for (let stopAt = 1; ; stopAt++) {
    assert.ok(stopAt <= 6, "a review makes a bounded number of record writes");
    const f = schedulerFixture();
    try {
      const gh = delivered(f);
      gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
      const stop = hostStop(f, stopAt), first = poller(f.openTeam({ entries: stop.entries }));
      await first.start();
      stop.arm();
      await first.poll();
      if (!stop.stopped()) break;
      stops++;
      stop.restart();
      const left = f.readRecord<Saved>("team", f.run.id), intent = left.reviewIntake?.intents[0];
      // Write 1 saves the intent; write 2 is the steer's permission invalidation; write 3 is the steer with its receipt; write 4 acknowledges it.
      const expected = ([["pending", false], ["pending", false], ["pending", true], ["applied", true]] as const)[stopAt - 1];
      assert.deepEqual([intent?.state, Boolean(left.receipts[requestId(f)])], expected);
      const readsBefore = gh.commands().length, second = poller(f.openTeam());
      await second.start();
      assert.equal(gh.commands().length - readsBefore, stopAt <= 2 ? 1 : 0,
        stopAt === 3 ? "an intent whose steer took effect is acknowledged from its receipt without reading GitHub" : `after write ${stopAt} the drain reads GitHub only for an intent without a receipt`);
      await second.poll();
      const saved = f.readRecord<Saved>("team", f.run.id);
      assert.equal(saved.run.revision, 2, `a stop after write ${stopAt} steers exactly once`);
      assert.deepEqual(saved.run.steering.map(item => item.text), [requested]);
      assert.deepEqual(saved.reviewIntake?.intents.map(item => item.state), ["applied"]);
      assert.deepEqual([saved.reviewIntake?.handled, saved.reviewIntake?.accepted], [["PRR_1"], 1]);
      assert.equal(events(saved).filter(text => text.startsWith("The owner requested changes on the pull request")).length, 1);
    } finally { f.close(); }
  }
  assert.equal(stops, 4, "the intent, the steer's two writes and the acknowledgement");
});

test("a review that GitHub supersedes while the owner's halt holds it starts nothing", async () => {
  const f = schedulerFixture();
  try {
    const gh = delivered(f);
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
    let halted = true;
    const teams = f.openTeam(), feedback = poller(teams);
    teams.useFuse({ held: () => halted ? { reason: "halt" } : undefined } as unknown as FuseGate);
    await feedback.start();
    await feedback.poll();
    let saved = f.readRecord<Saved>("team", f.run.id);
    assert.deepEqual(saved.reviewIntake?.intents.map(intent => intent.state), ["pending"], "the review is accepted as an intent, but its steer waits for the halt");
    assert.equal(saved.run.revision, 1);
    await feedback.poll();
    assert.equal(gh.commands().length, 1, "a held intent is not read again while the halt holds it");

    // The owner approves the pull request during the halt; once it lifts, the saved intent no longer holds.
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED"), { ...gh.review("PRR_2", owner, "APPROVED", "Looks good."), submittedAt: new Date(Date.now() + 120_000).toISOString() }]);
    halted = false;
    await feedback.poll();
    saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(saved.run.revision, 1, "the superseded review starts nothing");
    assert.deepEqual(saved.run.steering, []);
    assert.equal(saved.receipts[reviewRequestId(f.run.id, "PRR_1")], undefined);
    assert.deepEqual(saved.reviewIntake?.intents.map(intent => [intent.reviewId, intent.state]), [["PRR_1", "superseded"]]);
    assert.deepEqual(saved.run.reviewFeedback?.map(entry => [entry.reviewId, entry.outcome]), [["PRR_1", "superseded"], ["PRR_2", "approved-seen"]]);
    assert.ok(events(saved).includes("The owner's review PRR_1 was not applied: GitHub no longer shows this review as the owner's newest request for changes on the delivered head."));
  } finally { f.close(); }
});

test("a held review whose pull request is retargeted before the halt lifts starts nothing", async () => {
  for (const [name, change, reason] of [["another base branch", { baseRefName: "release" }, "base"], ["another head branch", { headRefName: "renamed-branch" }, "branch"]] as const) {
    const f = schedulerFixture();
    try {
      const gh = delivered(f), review = gh.review("PRR_1", owner, "CHANGES_REQUESTED");
      gh.show([review]);
      let halted = true;
      const teams = f.openTeam(), feedback = poller(teams);
      teams.useFuse({ held: () => halted ? { reason: "halt" } : undefined } as unknown as FuseGate);
      await feedback.start();
      await feedback.poll();
      assert.deepEqual(f.readRecord<Saved>("team", f.run.id).reviewIntake?.intents.map(intent => intent.state), ["pending"]);

      gh.show([review], change);
      halted = false;
      await feedback.poll();
      const saved = f.readRecord<Saved>("team", f.run.id);
      assert.equal(saved.run.revision, 1, `a pull request moved to ${name} starts nothing`);
      assert.deepEqual(saved.run.steering, []);
      assert.deepEqual(saved.reviewIntake?.intents.map(intent => [intent.reviewId, intent.state, intent.text]), [["PRR_1", "superseded", requested]], "the accepted text stays as read");
      assert.deepEqual(saved.run.reviewFeedback?.map(entry => [entry.reviewId, entry.outcome]), [["PRR_1", "superseded"]]);
      assert.ok(events(saved).includes("The owner's review PRR_1 was not applied: GitHub shows the pull request on another base or head branch than the one this run delivered to."));
      assert.equal(saved.reviewIntake?.ended?.reason, reason, "the run then leaves the watched set");
    } finally { f.close(); }
  }
});

test("a steer on a pull request recorded without its branch is refused until a read of GitHub records the branch", async () => {
  const f = schedulerFixture();
  try {
    const gh = delivered(f);
    // A record made before the branch was kept: the delivered head was published to the branch the pull request uses.
    delete f.run.pullRequest!.branch;
    f.run.publication = { repository, branch, commit: gh.head, publishedAt: new Date().toISOString() };
    f.writeTeam();
    const teams = f.openTeam(), request = { requestId: randomUUID(), revision: 1, text: "Keep the old flag name as an alias." };
    await assert.rejects(teams.steer(f.run.id, request), { code: "delivery-branch-unknown" });
    let saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(saved.run.pullRequest?.branch, undefined, "no branch is guessed or saved without a read of GitHub");
    assert.equal(saved.run.revision, 1);

    // The poller's first read that GitHub confirms records the branch, even when no review counts yet.
    gh.show([]);
    const feedback = poller(teams);
    await feedback.start();
    await feedback.poll();
    assert.equal(f.readRecord<Saved>("team", f.run.id).run.pullRequest?.branch, branch);
    const steered = await teams.steer(f.run.id, request);
    assert.equal(steered.revision, 2);
    saved = f.readRecord<Saved>("team", f.run.id);
    assert.deepEqual([saved.run.pullRequest?.branch, saved.run.pullRequest?.revision], [branch, 1]);
  } finally { f.close(); }
});

test("polls that arrive while a pass is slow coalesce into one more pass", async () => {
  for (const phase of ["watch", "startup drain"] as const) {
    const f = schedulerFixture();
    try {
      const gh = delivered(f), review = gh.review("PRR_1", owner, "CHANGES_REQUESTED");
      let feedback: TeamReviewFeedback, first: Promise<void> | undefined, before: number;
      if (phase === "watch") {
        gh.show([]);
        feedback = poller(f.openTeam());
        await feedback.start();
        before = gh.commands().length;
        gh.gate();
        first = feedback.poll();
      } else {
        // A review accepted under a halt is drained by the next host; GitHub has since shown a newer approval.
        gh.show([review]);
        const held = f.openTeam(), heldFeedback = poller(held);
        held.useFuse({ held: () => ({ reason: "halt" }) } as unknown as FuseGate);
        await heldFeedback.start();
        await heldFeedback.poll();
        await held.close();
        gh.show([review, { ...gh.review("PRR_2", owner, "APPROVED", "Looks good."), submittedAt: new Date(Date.now() + 120_000).toISOString() }]);
        before = gh.commands().length;
        gh.gate();
        feedback = poller(f.openTeam());
        first = feedback.start();
      }
      await until(() => gh.commands().length === before + 1);
      const more = [feedback.poll(), feedback.poll(), feedback.poll()];
      gh.release();
      await Promise.all([first, ...more]);
      assert.equal(gh.commands().length - before, 2, `${phase}: three requests during a slow pass run one more pass`);
    } finally { f.close(); }
  }
});

test("closing the host while a pull request read runs saves nothing and steers nothing", async () => {
  for (const phase of ["watch", "drain"] as const) {
    const f = schedulerFixture();
    try {
      const gh = delivered(f);
      gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
      let halted = phase === "drain";
      const teams = f.openTeam(), feedback = poller(teams);
      teams.useFuse({ held: () => halted ? { reason: "halt" } : undefined } as unknown as FuseGate);
      await feedback.start();
      // For the drain, the review is first accepted under a halt, so the read in flight is the check before its steer.
      if (phase === "drain") { await feedback.poll(); halted = false; }
      const before = f.readRecord<Saved>("team", f.run.id), reads = gh.commands().length;
      gh.gate();
      const pass = feedback.poll();
      await until(() => gh.commands().length === reads + 1);
      let idle = false;
      const idled = teams.idle().then(() => { idle = true; });
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(idle, false, `${phase}: idle waits for the read in flight`);
      const closed = teams.close();
      gh.release();
      await Promise.all([pass, closed, idled]);
      await teams.idle();
      assert.deepEqual(f.readRecord<Saved>("team", f.run.id), before, `${phase}: nothing is saved after close`);
      assert.equal(gh.commands().length, reads + 1);
    } finally { f.close(); }
  }
});
