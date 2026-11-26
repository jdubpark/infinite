import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Prompt } from "@infinite/attention";
import type { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import type { FuseGate } from "../packages/host/src/fuse/types.js";
import { PULL_REQUEST_BRANCH_FIELDS, PULL_REQUEST_FIELDS, type ReviewIntake, reviewRequestId } from "../packages/host/src/review-feedback.js";
import type { TeamReviewFeedback } from "../packages/host/src/team-review-feedback.js";
import { permissionAuthorityHash, permissionEvidenceHash } from "../packages/host/src/team-permissions.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { MissionReview, type MissionReviewRecord, type ReviewForwardOp } from "../packages/host/src/mission-review.js";
import type { Mission, MissionSubtask } from "../packages/host/src/mission-types.js";
import type { MissionMessage } from "../packages/host/src/team-prompts.js";
import type { Manager } from "../packages/host/src/manager.js";
import { newWitness, type CensusResult, type HostProcesses } from "../packages/host/src/process-census.js";
import { COMMAND_STOP_UNCONFIRMED_REASON } from "../packages/host/src/team-workspace.js";
import { TeamService, type TeamServiceOptions } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Saved = { run: TeamRun; receipts: Record<string, string>; reviewIntake?: ReviewIntake };
type Review = { id: string; author: { login: string } | null; state: string; submittedAt: string; body: string; commit: { oid: string } };

const owner = "owner-login", repository = "example-org/example-repo", branch = "infinite/review-fixture";
const pullRequestUrl = `https://github.com/${repository}/pull/7`;
const requested = "Rename the flag to --strict and keep the old name as an alias.";
const ghRead = ["gh", "pr", "view", "7", "--json", PULL_REQUEST_FIELDS, "--repo", repository];
const ghBranchRead = ["gh", "pr", "view", "7", "--json", PULL_REQUEST_BRANCH_FIELDS, "--repo", repository];
const fakeGh = `const fs = require("node:fs"); const [dir, command, ...args] = process.argv.slice(1);
fs.appendFileSync(dir + "/commands.log", JSON.stringify([command, ...args]) + "\\n");
if (command !== "gh") process.exit(3);
if (fs.existsSync(dir + "/hold")) require("node:child_process").spawn(process.execPath, ["-e", "const fs = require('node:fs'), cell = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 30000; while (!fs.existsSync(process.argv[1] + '/release') && Date.now() < end) Atomics.wait(cell, 0, 0, 50);", dir], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();
if (fs.existsSync(dir + "/gate")) { const cell = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(dir + "/release")) Atomics.wait(cell, 0, 0, 20); }
process.stdout.write(fs.readFileSync(dir + "/pull-request.json", "utf8"));`;

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
    gate: () => writeFileSync(join(dir, "gate"), ""),
    hold: () => writeFileSync(join(dir, "hold"), ""),
    release: () => writeFileSync(join(dir, "release"), ""),
  };
}
async function until(ready: () => boolean) {
  for (let tries = 0; !ready(); tries++) {
    assert.ok(tries < 500, "the condition holds within 10 s");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const poller = (teams: TeamService) => (teams as unknown as { reviewFeedback: TeamReviewFeedback }).reviewFeedback;
const events = (saved: Saved) => saved.run.events.map(event => event.text);

type Census = { result: CensusResult; count: number; now: number };
const RUNNING: CensusResult = { ok: true, findings: [{ pid: 101, reason: "recorded-group" }] };
const ENDED: CensusResult = { ok: true, findings: [] };

function censusTeams(f: Fixture, seen: Census) {
  const processes: HostProcesses = { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async () => { seen.count++; return seen.result; } };
  return new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => seen.now, processes });
}

function stoppedCheck(revision: number) {
  return { id: randomUUID(), kind: "check", revision, witness: { ...newWitness(), processes: [{ pid: 101, start: "start-101" }], sessions: [101], groups: [101] },
    failure: { code: "command-stop-unconfirmed", reason: COMMAND_STOP_UNCONFIRMED_REASON, at: new Date().toISOString() } };
}

function hostStop(f: Fixture, stopAt: number) {
  let armed = false, writes = 0, restore: (() => void) | undefined;
  const entries = { retryable: () => false, mirror: () => {
    if (armed && ++writes === stopAt) restore = f.blockRecordWrites("team", f.run.id);
    return true;
  } };
  return { entries: entries as unknown as Blackboard, arm: () => { armed = true; }, stopped: () => restore !== undefined, restart: () => restore?.() };
}

function approvedDecision(f: Fixture) {
  const member = f.run.members[0]!, permissions = { mode: "coordinator" as const, scope: "Approve one-time runs of accepted checks.", maxDecisions: 3 };
  const prompt: Prompt = { id: 1, kind: "permission", source: "screen", hash: "a".repeat(64), pinned: true, acceptsText: false,
    title: "Would you like to run the following command?", detail: "Environment: local\n$ npm run check",
    options: [{ index: 0, label: "Yes, proceed (y)", role: "accept" }, { index: 1, label: "No (esc)", role: "reject" }] };
  f.run.permissions = permissions;
  f.run.permissionDecisions = [{ id: randomUUID(), revision: 1, targetMemberId: member.memberId, targetSessionId: member.sessionId, targetCwd: member.cwd,
    policyHash: createHash("sha256").update(JSON.stringify(permissions)).digest("hex"), promptId: prompt.id, promptHash: prompt.hash!,
    evidenceHash: permissionEvidenceHash(prompt), prompt, option: 0, authorityHash: permissionAuthorityHash(permissions, []),
    expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), answerRequestId: randomUUID(), coordinatorMemberId: randomUUID(), status: "approved" }];
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

    await feedback.poll();
    assert.equal(gh.commands().length, 1);
    teams.close();

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

test("a mission run's review goes to its mission's coordinator instead of steering the run, and only while the switch is on", async () => {
  for (const enabled of [false, true]) {
    const f = schedulerFixture();
    try {
      f.run.missionId = "mission-1";
      const gh = delivered(f, enabled);
      gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
      const before = f.readRecord<Saved>("team", f.run.id), directed: unknown[] = [], receipts = new Set<string>();
      let answer: "waiting" | "applied" = "waiting";
      const teams = f.openTeam(), feedback = poller(teams);
      await feedback.start();
      await feedback.poll();
      assert.deepEqual(gh.commands(), [], "a mission run is not read before its missions are connected");
      const port = teams.useMissionReviews({ target: () => ({ missionId: "mission-1", subtaskId: "a" }), applied: (_mission, requestId) => receipts.has(requestId),
        direct: async (missionId, direction) => {
          directed.push([missionId, direction]);
          if (answer === "applied") receipts.add(direction.requestId);
          return answer;
        } });
      await feedback.poll();
      if (!enabled) {
        assert.deepEqual([gh.commands(), directed], [[], []], "with the switch off a mission run is not read and its mission hears nothing");
        assert.deepEqual(f.readRecord<Saved>("team", f.run.id), before);
        continue;
      }
      const direction = { requestId: reviewRequestId(f.run.id, "PRR_1"), runId: f.run.id, subtaskId: "a", reviewId: "PRR_1", pullRequestUrl, text: requested, revision: 1, headCommit: gh.head };
      assert.deepEqual(directed, [["mission-1", direction]]);
      assert.deepEqual(f.readRecord<Saved>("team", f.run.id).reviewIntake?.intents.map(intent => intent.state), ["pending"], "a paused mission leaves the review waiting");

      answer = "applied";
      await feedback.poll();
      const saved = f.readRecord<Saved>("team", f.run.id);
      assert.deepEqual(directed, [["mission-1", direction], ["mission-1", direction]]);
      assert.deepEqual([saved.reviewIntake?.intents.map(intent => intent.state), saved.run.reviewFeedback?.map(entry => entry.outcome)], [["applied"], ["applied"]]);
      assert.deepEqual([saved.run.revision, saved.run.status, saved.run.steering], [1, "ready-for-review", []], "the run waits for its coordinator's forward");
      assert.equal(events(saved).some(text => text.startsWith("The owner requested changes on the pull request")), false);

      assert.equal(await port.stillCurrent(f.run.id, "PRR_1"), true);
      gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED"), gh.review("PRR_2", owner, "APPROVED", "", new Date(Date.now() + 120_000).toISOString())]);
      assert.equal(await port.stillCurrent(f.run.id, "PRR_1"), false, "an approval after the review makes it stale for the forward");
      gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
      f.config.github!.reviewFeedback!.enabled = false;
      assert.equal(await port.stillCurrent(f.run.id, "PRR_1"), false, "with the switch off no forward goes ahead");
    } finally { f.close(); }
  }
});

test("a mission run that no mission lists is neither steered nor sent to a mission", async () => {
  const f = schedulerFixture();
  try {
    f.run.missionId = "mission-1";
    const gh = delivered(f);
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
    const teams = f.openTeam(), feedback = poller(teams), directed: unknown[] = [];
    teams.useMissionReviews({ target: () => undefined, applied: () => false, direct: async (missionId, direction) => {
      directed.push([missionId, direction]);
      return "applied";
    } });
    await feedback.start();
    await feedback.poll();
    const saved = f.readRecord<Saved>("team", f.run.id);
    assert.deepEqual([saved.run.revision, saved.run.steering, saved.reviewIntake?.intents ?? [], directed], [1, [], [], []]);
  } finally { f.close(); }
});

test("a restarted host acknowledges a mission run's review from its mission's receipt without reading GitHub", async () => {
  const f = schedulerFixture();
  try {
    f.run.missionId = "mission-1";
    const gh = delivered(f);
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
    const receipts = new Set<string>(), directed: string[] = [];
    const destination = { target: () => ({ missionId: "mission-1", subtaskId: "a" }), applied: (_mission: string, requestId: string) => receipts.has(requestId),
      direct: async (_mission: string, direction: { requestId: string }) => {
        directed.push(direction.requestId);
        receipts.add(direction.requestId);
        return "waiting" as const;
      } };
    const first = f.openTeam();
    first.useMissionReviews(destination);
    await poller(first).start();
    await poller(first).poll();
    assert.deepEqual(f.readRecord<Saved>("team", f.run.id).reviewIntake?.intents.map(intent => intent.state), ["pending"], "the mission's reply was lost");
    const reads = gh.commands().length, second = f.openTeam();
    second.useMissionReviews(destination);
    await poller(second).start();
    const saved = f.readRecord<Saved>("team", f.run.id);
    assert.deepEqual([saved.reviewIntake?.intents.map(intent => intent.state), gh.commands().length - reads, directed.length], [["applied"], 0, 1]);
  } finally { f.close(); }
});

test("a coordinator's forward of a mission run's review reads GitHub once more and steers the run once, also when the mission's save was lost", async () => {
  const f = schedulerFixture();
  try {
    f.run.missionId = "mission-1";
    const gh = delivered(f), forwarded = "The owner asks for --strict with the old name kept as an alias.";
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
    const subtask = { id: "a", title: "Subtask a", objective: "Do a", repoProjectId: f.run.projectId, size: "solo", parallelism: 1, dependsOn: [], status: "done", teamId: f.run.id } as unknown as MissionSubtask;
    const stored = { mission: { id: "mission-1", status: "working", revision: 1, maxMinutes: 30, steering: [], subtasks: [subtask] } as unknown as Mission,
      receipts: {} as Record<string, string>, inbox: [] as MissionMessage[], notes: [] as MissionMessage[], notified: [] as string[], ops: [] as ReviewForwardOp[], refusals: 0, reviews: undefined as MissionReviewRecord[] | undefined };
    const connect = (teams: TeamService, record: typeof stored) => {
      const review = new MissionReview({ records: new Map([["mission-1", record]]), teams, enqueue: async (_id, task) => task(), save: () => {}, event: () => {},
        follow: () => {}, held: () => false, steeringFull: () => false });
      review.connect(teams.useMissionReviews(review));
      return review;
    };
    const settle = async (review: MissionReview<typeof stored>, record: typeof stored) => {
      for (let passes = 0; await review.applyForward(record, record.ops[0]!); passes++) {
        assert.ok(passes < 250, "the forward settles within 5 s");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const teams = f.openTeam(), review = connect(teams, stored), feedback = poller(teams);
    await feedback.start();
    await feedback.poll();
    assert.deepEqual(stored.inbox.splice(0).map(message => message.type), ["review-direction"]);
    assert.deepEqual(review.queueForward(stored, subtask, forwarded, true), { kind: "queued" });
    const lost = structuredClone(stored), reads = gh.commands().length;
    await settle(review, stored);
    let saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(gh.commands().length - reads, 1, "GitHub is read once more before the steer");
    assert.deepEqual([saved.run.revision, saved.run.steering.map(item => [item.text, item.source])], [2, [[forwarded, "coordinator"]]]);
    assert.deepEqual(stored.reviews?.map(item => item.state), ["forwarded"]);

    const restarted = f.openTeam();
    await settle(connect(restarted, lost), lost);
    saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(saved.run.revision, 2, "the restarted mission finds the run's receipt and steers nothing more");
    assert.deepEqual(lost.reviews?.map(item => item.state), ["forwarded"]);
    assert.equal(gh.commands().length - reads, 1);
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
      const expected = ([["pending", false], ["pending", true], ["applied", true]] as const)[stopAt - 1];
      assert.deepEqual([intent?.state, Boolean(left.receipts[requestId(f)])], expected);
      const readsBefore = gh.commands().length, second = poller(f.openTeam());
      await second.start();
      assert.equal(gh.commands().length - readsBefore, stopAt === 1 ? 1 : 0,
        stopAt === 2 ? "an intent whose steer took effect is acknowledged from its receipt without reading GitHub" : `after write ${stopAt} the drain reads GitHub only for an intent without a receipt`);
      await second.poll();
      const saved = f.readRecord<Saved>("team", f.run.id);
      assert.equal(saved.run.revision, 2, `a stop after write ${stopAt} steers exactly once`);
      assert.deepEqual(saved.run.steering.map(item => item.text), [requested]);
      assert.deepEqual(saved.reviewIntake?.intents.map(item => item.state), ["applied"]);
      assert.deepEqual([saved.reviewIntake?.handled, saved.reviewIntake?.accepted], [["PRR_1"], 1]);
      assert.equal(events(saved).filter(text => text.startsWith("The owner requested changes on the pull request")).length, 1);
    } finally { f.close(); }
  }
  assert.equal(stops, 3, "the intent, the steer and the acknowledgement; the steer's earlier save of an unchanged record writes nothing");
});

for (const superseded of [false, true]) {
  test(superseded ? "a review that GitHub supersedes while the host is stopped between its steer's permission withdrawal and the steer's write starts nothing, and the decision stays withdrawn with a true reason"
    : "a host stop between a review steer's permission withdrawal and the steer's write leaves the decision withdrawn, and the restarted host steers exactly once", async () => {
    const f = schedulerFixture();
    try {
      approvedDecision(f);
      const gh = delivered(f), changes = gh.review("PRR_1", owner, "CHANGES_REQUESTED"), withdrawn = [["stale", "A steer started before the permission request could be answered."]];
      const decisions = (saved: Saved) => saved.run.permissionDecisions?.map(decision => [decision.status, decision.reason]);
      gh.show([changes]);
      const stop = hostStop(f, 2), first = poller(f.openTeam({ entries: stop.entries }));
      await first.start();
      stop.arm();
      await first.poll();
      assert.ok(stop.stopped(), "the review's intent and its steer's permission withdrawal are two record writes");
      stop.restart();
      const left = f.readRecord<Saved>("team", f.run.id);
      assert.deepEqual([left.run.revision, left.reviewIntake?.intents.map(intent => intent.state), left.receipts[reviewRequestId(f.run.id, "PRR_1")]], [1, ["pending"], undefined],
        "the host stopped after the withdrawal and before the steer's own write");
      assert.deepEqual(decisions(left), withdrawn);
      if (superseded) gh.show([changes, gh.review("PRR_2", owner, "APPROVED", "Looks good.", new Date(Date.now() + 120_000).toISOString())]);
      const reads = gh.commands().length, second = poller(f.openTeam());
      await second.start();
      assert.equal(gh.commands().length - reads, 1, "the restarted host reads GitHub once before it acts on an intent without a receipt");
      await second.poll();
      const saved = f.readRecord<Saved>("team", f.run.id);
      assert.equal(saved.run.revision, superseded ? 1 : 2, superseded ? "a superseded review starts nothing" : "the restarted host steers exactly once");
      assert.deepEqual(saved.run.steering.map(item => item.text), superseded ? [] : [requested]);
      assert.deepEqual(saved.reviewIntake?.intents.map(intent => intent.state), [superseded ? "superseded" : "applied"]);
      assert.deepEqual(decisions(saved), withdrawn, "the host does not restore the withdrawn decision, and its reason does not say the revision changed");
      assert.equal(f.permissionAnswers(), 0, "no provider answer is sent for the withdrawn decision");
    } finally { f.close(); }
  });
}

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
    delete f.run.pullRequest!.branch;
    f.run.publication = { repository, branch, commit: gh.head, publishedAt: new Date().toISOString() };
    f.writeTeam();
    const teams = f.openTeam(), request = { requestId: randomUUID(), revision: 1, text: "Keep the old flag name as an alias." };
    await assert.rejects(teams.steer(f.run.id, request), { code: "delivery-branch-unknown" });
    let saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(saved.run.pullRequest?.branch, undefined, "no branch is guessed or saved without a read of GitHub");
    assert.equal(saved.run.revision, 1);

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

test("the host start registers the review poll on the source timer, and close removes it", async () => {
  const f = schedulerFixture();
  const listeners = new Set<() => void>();
  const source = { onTick: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  let teams: TeamService | undefined;
  try {
    const gh = delivered(f);
    gh.show([]);
    teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { source: source as unknown as TeamServiceOptions["source"] });
    teams.start();
    assert.equal(listeners.size, 1, "start registers one listener on the source timer");
    for (const listener of listeners) listener();
    await until(() => gh.commands().some(command => command[0] === "gh"));
    assert.deepEqual(gh.commands().filter(command => command[0] === "gh"), [ghRead], "a tick past the interval reads the watched pull request once");
    await teams.close();
    assert.equal(listeners.size, 0, "close removes it");
  } finally { await teams?.close(); f.close(); }
});

test("close settles within its bound while a process the host cannot stop holds the read open", { timeout: 30000 }, async () => {
  const f = schedulerFixture();
  const gh = delivered(f);
  try {
    gh.show([]);
    const teams = f.openTeam(), feedback = poller(teams);
    await feedback.start();
    gh.gate(); gh.hold();
    const pass = feedback.poll();
    await until(() => gh.commands().length === 1);
    const started = Date.now();
    await teams.close();
    await pass;
    assert.ok(Date.now() - started < 12_000, `close took ${Date.now() - started} ms`);
    await teams.idle();
  } finally { gh.release(); f.close(); }
});

test("steering a legacy pull request without a branch resolves and persists the branch on demand even with review feedback off, then reuses it", async () => {
  const f = schedulerFixture();
  try {
    const gh = delivered(f, false);
    delete f.run.pullRequest!.branch;
    f.run.publication = { repository, branch, commit: gh.head, publishedAt: new Date().toISOString() };
    f.writeTeam();
    gh.show([]);
    const teams = f.openTeam();

    const first = await teams.steer(f.run.id, { requestId: randomUUID(), revision: 1, text: "Keep the old flag name as an alias." });
    assert.equal(first.revision, 2);
    assert.equal(first.pullRequest?.branch, branch);
    assert.deepEqual(gh.commands(), [ghBranchRead], "one read-only gh pr view resolves the missing branch");
    let saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(saved.run.pullRequest?.branch, branch);
    assert.equal(saved.run.revision, 2);

    const second = await teams.steer(f.run.id, { requestId: randomUUID(), revision: 2, text: "Document the alias in help output." });
    assert.equal(second.revision, 3);
    assert.equal(second.pullRequest?.branch, branch);
    assert.deepEqual(gh.commands(), [ghBranchRead], "subsequent steering reuses the persisted branch without calling gh again");
    saved = f.readRecord<Saved>("team", f.run.id);
    assert.equal(saved.run.revision, 3);
  } finally { f.close(); }
});

test("on-demand legacy pull request branch lookup fails cleanly without corrupting the run", async () => {
  type FailureCase = { name: string; setup: (f: Fixture, gh: ReturnType<typeof delivered>) => void; expectedCommands: number; match: RegExp };
  const cases: FailureCase[] = [
    { name: "gh lookup failure", setup: () => {}, expectedCommands: 1, match: /failed/ },
    { name: "invalid branch name", setup: (_f, gh) => gh.show([], { headRefName: "../escape" }), expectedCommands: 1, match: /invalid head branch/ },
    { name: "fork pull request", setup: (_f, gh) => gh.show([], { isCrossRepository: true }), expectedCommands: 1, match: /comes from a fork/ },
    { name: "closed pull request", setup: (_f, gh) => gh.show([], { state: "CLOSED" }), expectedCommands: 1, match: /was closed/ },
    { name: "unowned head branch", setup: (_f, gh) => gh.show([], { headRefName: "someone-elses-branch" }), expectedCommands: 1, match: /not on the branch this run delivered to/ },
    { name: "cross-repo pull request URL", setup: (f, gh) => { f.run.pullRequest!.pullRequestUrl = "https://github.com/other-org/example-repo/pull/7"; gh.show([]); }, expectedCommands: 0, match: /does not match the pinned delivery repository/ },
  ];
  for (const item of cases) {
    const f = schedulerFixture();
    try {
      const gh = delivered(f, false);
      delete f.run.pullRequest!.branch;
      f.run.publication = { repository, branch, commit: gh.head, publishedAt: new Date().toISOString() };
      item.setup(f, gh);
      f.writeTeam();
      const before = f.readRecord<Saved>("team", f.run.id);
      const teams = f.openTeam();
      const requestId = randomUUID();
      await assert.rejects(
        teams.steer(f.run.id, { requestId, revision: 1, text: "Keep the alias." }),
        error => error instanceof Error && (error as { code?: string }).code === "delivery-branch-unknown" && item.match.test(error.message),
        item.name,
      );
      assert.equal(gh.commands().length, item.expectedCommands, item.name);
      const after = f.readRecord<Saved>("team", f.run.id);
      assert.deepEqual(after, before, `${item.name}: run stays uncorrupted on disk`);
      assert.equal(after.receipts[requestId], undefined, `${item.name}: no steer receipt recorded`);
    } finally { f.close(); }
  }
});

test("a review whose steer meets a stopped command that may still run waits with one event, and steers the run once after the command ended", async () => {
  const f = schedulerFixture();
  const seen: Census = { result: RUNNING, count: 0, now: Date.now() };
  let teams: TeamService | undefined;
  try {
    const gh = delivered(f), submittedAt = new Date(Date.now() + 60_000).toISOString();
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED", requested, submittedAt)]);
    Object.assign(f.run, { status: "blocked", blockCode: "command-stop-unconfirmed", reason: COMMAND_STOP_UNCONFIRMED_REASON });
    const intent = { reviewId: "PRR_1", submittedAt, commit: gh.head, text: requested, requestId: reviewRequestId(f.run.id, "PRR_1"), targetRevision: 1, state: "pending" };
    f.writeTeam({ pending: stoppedCheck(1), reviewIntake: { intents: [intent], handled: [], accepted: 1 } });
    teams = censusTeams(f, seen);
    (teams as unknown as { records: Map<string, { halt?: string }> }).records.get(f.run.id)!.halt = undefined;
    const service = teams, steer = service.steer.bind(service);
    let steers = 0;
    service.steer = (...args: Parameters<TeamService["steer"]>) => { steers++; return steer(...args); };
    const feedback = poller(service);
    await feedback.start();
    await feedback.poll();
    await feedback.poll();
    let saved = f.readRecord<Saved>("team", f.run.id);
    assert.deepEqual(saved.reviewIntake?.intents.map(item => item.state), ["pending"], "the review waits instead of being refused");
    const waits = events(saved).filter(text => text.startsWith("The owner's review PRR_1 waits for this run."));
    assert.equal(waits.length, 1, JSON.stringify(events(saved).slice(-4)));
    assert.ok(waits[0]!.includes(`The stopped command of team run ${f.run.id} may still be running.`), waits[0]);
    assert.ok(steers >= 2, `the review tried its steer on each pass: ${steers}`);
    assert.equal(seen.count, 1, "retries within 30 seconds reuse the census");
    assert.equal(saved.run.steering.length, 0);

    seen.result = ENDED;
    seen.now += 31_000;
    await feedback.poll();
    await feedback.poll();
    saved = f.readRecord<Saved>("team", f.run.id);
    assert.deepEqual(saved.reviewIntake?.intents.map(item => item.state), ["applied"]);
    assert.deepEqual(saved.run.steering.map(item => item.text), [requested], "the review steered the run once");
    assert.equal(saved.run.revision, 2);
  } finally {
    await teams?.close();
    f.close();
  }
});

test("a coordinator's forward that meets a stopped command that may still run waits with one event, no refusal and one GitHub read a minute, and steers the run once after the command ended", async () => {
  const f = schedulerFixture();
  const seen: Census = { result: RUNNING, count: 0, now: Date.now() };
  let teams: TeamService | undefined;
  try {
    f.run.missionId = "mission-1";
    const gh = delivered(f), forwarded = "The owner asks for --strict with the old name kept as an alias.";
    gh.show([gh.review("PRR_1", owner, "CHANGES_REQUESTED")]);
    const subtask = { id: "a", title: "Subtask a", objective: "Do a", repoProjectId: f.run.projectId, size: "solo", parallelism: 1, dependsOn: [], status: "done", teamId: f.run.id } as unknown as MissionSubtask;
    const stored = { mission: { id: "mission-1", status: "working", revision: 1, maxMinutes: 30, steering: [], subtasks: [subtask] } as unknown as Mission,
      receipts: {} as Record<string, string>, inbox: [] as MissionMessage[], notes: [] as MissionMessage[], notified: [] as string[], ops: [] as ReviewForwardOp[], refusals: 0, reviews: undefined as MissionReviewRecord[] | undefined };
    const recorded: string[] = [];
    const service = teams = censusTeams(f, seen);
    const review = new MissionReview({ records: new Map([["mission-1", stored]]), teams: service, enqueue: async (_id, task) => task(), save: () => {},
      event: (_record, text) => { recorded.push(text); }, follow: () => {}, held: () => false, steeringFull: () => false });
    review.connect(service.useMissionReviews(review));
    const feedback = poller(service);
    await feedback.start();
    await feedback.poll();
    assert.deepEqual(stored.inbox.splice(0).map(message => message.type), ["review-direction"]);
    assert.deepEqual(review.queueForward(stored, subtask, forwarded, true), { kind: "queued" });
    (service as unknown as { records: Map<string, { pending?: unknown }> }).records.get(f.run.id)!.pending = stoppedCheck(1);
    const steer = service.steer.bind(service), clock = Date.now.bind(Date), reads = gh.commands().length;
    let steers = 0, skew = 0;
    service.steer = (...args: Parameters<TeamService["steer"]>) => { steers++; return steer(...args); };
    mock.method(Date, "now", () => clock() + skew);
    const tickUntil = async (steered: number) => {
      for (let passes = 0; steers < steered; passes++) {
        assert.ok(passes < 500, `the forward tries its steer ${steered} times within 10 s`);
        assert.equal(await review.applyForward(stored, stored.ops[0]!), true, `the forward waits: ${recorded.at(-1)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await tickUntil(10);
    assert.equal(gh.commands().length - reads, 1, "ten steer attempts within a minute follow one GitHub read");
    skew = 61_000;
    await tickUntil(11);
    assert.equal(gh.commands().length - reads, 2, "a read older than a minute is taken again before the next steer");
    const waits = recorded.filter(text => text.startsWith("The owner's review PRR_1 for subtask a waits for its subteam."));
    assert.equal(waits.length, 1, JSON.stringify(recorded.slice(-4)));
    assert.ok(waits[0]!.includes(`The stopped command of team run ${f.run.id} may still be running.`), waits[0]);
    assert.deepEqual(stored.reviews?.map(item => item.state), ["forwarding"]);
    assert.equal(stored.refusals, 0);
    assert.deepEqual(stored.inbox, [], "the coordinator is not told of a refusal");
    assert.equal(seen.count, 1, "retries within 30 seconds reuse the census");

    seen.result = ENDED;
    seen.now += 31_000;
    for (let passes = 0; await review.applyForward(stored, stored.ops[0]!); passes++) {
      assert.ok(passes < 500, "the forward settles within 10 s");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const saved = f.readRecord<Saved>("team", f.run.id);
    assert.deepEqual([saved.run.revision, saved.run.steering.map(item => [item.text, item.source])], [2, [[forwarded, "coordinator"]]], "the forward steered the run once");
    assert.deepEqual(stored.reviews?.map(item => item.state), ["forwarded"]);
    assert.equal(gh.commands().length - reads, 2, "the steer used the read taken within the last minute");
  } finally {
    mock.restoreAll();
    await teams?.close();
    f.close();
  }
});
