import test from "node:test";
import assert from "node:assert/strict";
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
  };
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
