import test from "node:test";
import assert from "node:assert/strict";
import { parseGhCommand } from "../scripts/github-proxy.mjs";
import { reviewFeedbackConfigSchema } from "../packages/host/src/config.js";
import { runRecord } from "../packages/host/src/objective-record.js";
import {
  REVIEW_TEXT_LIMIT, type ReviewIntake, type ReviewVerdict, intakeEndedByRemoval, intentStillCurrent, markReviewApplied, parsePullRequestView, pullRequestTarget,
  pullRequestViewArgs, recordReviewOutcome, reviewRequestId, reviewText, reviewVerdict,
} from "../packages/host/src/review-feedback.js";
import { ownerDirectionLines } from "../packages/host/src/team-prompts.js";
import { type TeamRun, githubReviewSource, teamMutationSchema } from "../packages/host/src/team-types.js";

const HEAD = "a".repeat(40), OLD = "b".repeat(40);
const ENABLED = "2026-11-01T00:00:00Z";
const OWNER = "owner-login";
const REPOSITORY = "example-org/example-repo";
const URL = `https://github.com/${REPOSITORY}/pull/7`;
const BRANCH = "infinite/team-run-1";

function delivered(change: (run: TeamRun) => void = () => {}): TeamRun {
  const run = {
    id: "11111111-1111-4111-8111-111111111111", objective: "Add the flag.", status: "ready-for-review", revision: 2, branch: BRANCH, steering: [], decisions: [],
    delivery: { mode: "pr", repository: REPOSITORY, baseBranch: "main" },
    pullRequest: { revision: 2, headCommit: HEAD, pullRequestUrl: URL, summary: "Opened.", reportedAt: ENABLED, branch: BRANCH },
  } as unknown as TeamRun;
  change(run);
  return run;
}
type Review = { id: string; author: { login: string } | null; state: string; submittedAt: string | null; body: string; commit: { oid: string } | null };
const review = (change: Partial<Review> = {}): Review => ({
  id: "PRR_1", author: { login: "Owner-Login" }, state: "CHANGES_REQUESTED", submittedAt: "2026-11-02T00:00:00Z", body: "Rename the flag.", commit: { oid: HEAD }, ...change,
});
const read = (reviews: Review[], change: Record<string, unknown> = {}) => parsePullRequestView(JSON.stringify({
  state: "OPEN", isCrossRepository: false, baseRefName: "main", headRefName: BRANCH, headRefOid: HEAD, reviews, ...change,
}));
const intake = (change: Partial<ReviewIntake> = {}): ReviewIntake => ({ intents: [], handled: [], accepted: 0, ...change });

test("the owner's newest review starts work only when every rule of section 1 holds", () => {
  type Case = [name: string, expected: ReviewVerdict["kind"] | `skip:${string}` | `unwatched:${string}`, input: {
    run?: TeamRun; reviews?: Review[]; pr?: Record<string, unknown>; intake?: ReviewIntake;
  }];
  const cases: Case[] = [
    ["a changes-requested review by the owner on the delivered head", "start", {}],
    ["the owner's login compared without case", "start", { reviews: [review({ author: { login: "OWNER-LOGIN" } })] }],
    ["a review by another login", "quiet", { reviews: [review({ author: { login: "someone-else" } })] }],
    ["a review with no author", "quiet", { reviews: [review({ author: null })] }],
    ["a comment-only review by the owner", "quiet", { reviews: [review({ state: "COMMENTED" })] }],
    ["a pending review by the owner", "quiet", { reviews: [review({ state: "PENDING", submittedAt: null })] }],
    ["no review", "quiet", { reviews: [] }],
    ["a later approval cancels an earlier request", "skip:approved-seen",
      { reviews: [review(), review({ id: "PRR_2", state: "APPROVED", submittedAt: "2026-11-03T00:00:00Z", body: "" })] }],
    ["a later comment-only review cancels nothing", "start",
      { reviews: [review(), review({ id: "PRR_2", state: "COMMENTED", submittedAt: "2026-11-03T00:00:00Z" })] }],
    ["an equal time is ordered by review id", "start",
      { reviews: [review({ id: "PRR_b" }), review({ id: "PRR_a", state: "APPROVED" })] }],
    ["an equal time is ordered by review id, the other way", "skip:approved-seen",
      { reviews: [review({ id: "PRR_a" }), review({ id: "PRR_b", state: "APPROVED" })] }],
    ["a dismissed review", "skip:dismissed", { reviews: [review({ state: "DISMISSED" })] }],
    ["a review submitted when the switch was turned on", "skip:before-enable", { reviews: [review({ submittedAt: ENABLED })] }],
    ["a review submitted before the switch was turned on", "skip:before-enable", { reviews: [review({ submittedAt: "2026-10-30T00:00:00Z" })] }],
    ["a review of an earlier commit", "skip:stale-head", { reviews: [review({ commit: { oid: OLD } })] }],
    ["a review that names no commit", "skip:stale-head", { reviews: [review({ commit: null })] }],
    ["a pull request whose head moved past the delivered head", "skip:stale-head",
      { reviews: [review({ commit: { oid: OLD } })], pr: { headRefOid: OLD } }],
    ["a run steered past its delivered revision", "skip:stale-head", { run: delivered(run => { run.revision = 3; }) }],
    ["a review already applied", "known", { intake: intake({ handled: ["PRR_1"], accepted: 1 }) }],
    ["a review that already has an intent", "known",
      { intake: intake({ intents: [{ reviewId: "PRR_1", submittedAt: "", commit: HEAD, text: "", requestId: "", targetRevision: 2, state: "refused" }] }) }],
    ["an empty summary", "skip:no-text", { reviews: [review({ body: " \n " })] }],
    ["a run that accepted three reviews", "skip:limit", { intake: intake({ handled: ["x", "y", "z"], accepted: 3 }) }],
    ["a run that accepted two reviews", "start", { intake: intake({ handled: ["x", "y"], accepted: 2 }) }],
    ["a closed pull request", "unwatched:closed", { pr: { state: "CLOSED" } }],
    ["a merged pull request", "unwatched:merged", { pr: { state: "MERGED" } }],
    ["a pull request from a fork", "unwatched:fork", { pr: { isCrossRepository: true } }],
    ["a pull request on another base", "unwatched:base", { pr: { baseRefName: "release" } }],
    ["a pull request from another branch", "unwatched:branch", { pr: { headRefName: "elsewhere" } }],
    ["a run with no pull request", "unwatched:not-delivered", { run: delivered(run => { delete run.pullRequest; }) }],
    ["a goal's run", "unwatched:not-delivered", { run: delivered(run => { run.goal = { goalId: "g", cycle: 1 } as unknown as TeamRun["goal"]; }) }],
    ["a handoff's run", "unwatched:not-delivered", { run: delivered(run => { run.handoff = {} as TeamRun["handoff"]; }) }],
    ["a record without its branch, on the run's branch", "start", { run: delivered(run => { delete run.pullRequest!.branch; }) }],
    ["a record without its branch, on the branch its head was published to", "start", {
      run: delivered(run => { delete run.pullRequest!.branch; run.publication = { repository: REPOSITORY, branch: `${BRANCH}-aaaaaaaa`, commit: HEAD }; }),
      pr: { headRefName: `${BRANCH}-aaaaaaaa` } }],
    ["a record without its branch, on a branch the run never published its head to", "unwatched:branch", {
      run: delivered(run => { delete run.pullRequest!.branch; run.publication = { repository: REPOSITORY, branch: `${BRANCH}-bbbbbbbb`, commit: OLD }; }),
      pr: { headRefName: `${BRANCH}-bbbbbbbb` } }],
  ];
  for (const [name, expected, input] of cases) {
    const verdict = reviewVerdict({ run: input.run ?? delivered(), ...(input.intake ? { reviewIntake: input.intake } : {}) },
      read(input.reviews ?? [review()], input.pr), OWNER, ENABLED);
    const actual = verdict.kind === "skip" ? `skip:${verdict.outcome}` : verdict.kind === "unwatched" ? `unwatched:${verdict.reason}` : verdict.kind;
    assert.equal(actual, expected, name);
  }
});

test("a review that starts work names the branch the run delivered to", () => {
  const verdict = reviewVerdict({ run: delivered(run => { delete run.pullRequest!.branch; run.publication = { repository: REPOSITORY, branch: `${BRANCH}-aaaaaaaa`, commit: HEAD }; }) },
    read([review()], { headRefName: `${BRANCH}-aaaaaaaa` }), OWNER, ENABLED);
  assert.deepEqual(verdict.kind === "start" && { branch: verdict.branch, review: verdict.review.id }, { branch: `${BRANCH}-aaaaaaaa`, review: "PRR_1" });
});

test("only GitHub's documented pull request fields are read, and anything else is refused", () => {
  const parsed = read([review({ commit: { oid: HEAD.toUpperCase() } })], { headRefOid: HEAD.toUpperCase(), extra: 1 });
  assert.equal(parsed.headRefOid, HEAD);
  assert.equal(parsed.reviews[0]!.commit?.oid, HEAD);
  assert.throws(() => parsePullRequestView("not json"));
  assert.throws(() => read([review()], { reviews: undefined }));
  assert.throws(() => read([review()], { headRefOid: "main" }));
  assert.throws(() => read([review()], { state: "DRAFT" }));
  assert.throws(() => read([review({ commit: { oid: "HEAD" } })]));
});

test("the one read of a pull request is a read the GitHub proxy allows under the pr operation with no refs", () => {
  const target = pullRequestTarget(delivered());
  assert.deepEqual(target, { repository: REPOSITORY, number: 7 });
  const claims = { repo: REPOSITORY, ops: ["pr"], refs: [] };
  const parsed = parseGhCommand(pullRequestViewArgs(target!), claims);
  assert.equal(parsed.resolve, false, "a read is not resolved as a write");
  assert.equal(parsed.stdin, false);
  assert.throws(() => parseGhCommand(pullRequestViewArgs(target!), { ...claims, ops: [] }), /pr-not-granted/);
  assert.equal(pullRequestTarget(delivered(run => { run.pullRequest!.pullRequestUrl = "https://github.com/other-org/example-repo/pull/7"; })), undefined);
  assert.equal(pullRequestTarget(delivered(run => { run.pullRequest!.pullRequestUrl = `${URL}/files`; })), undefined);
});

test("a saved intent holds only while its review is still the owner's newest request on the unmoved head and branches", () => {
  const intent = { reviewId: "PRR_1", commit: HEAD, submittedAt: "2026-11-02T00:00:00Z" }, run = delivered();
  assert.equal(intentStillCurrent(intent, run, read([review()]), OWNER, ENABLED), true);
  assert.equal(intentStillCurrent(intent, run, read([review(), review({ id: "PRR_2", state: "APPROVED", submittedAt: "2026-11-03T00:00:00Z" })]), OWNER, ENABLED), false);
  assert.equal(intentStillCurrent(intent, run, read([review({ state: "DISMISSED" })]), OWNER, ENABLED), false);
  assert.equal(intentStillCurrent(intent, run, read([review()], { headRefOid: OLD }), OWNER, ENABLED), false);
  assert.equal(intentStillCurrent(intent, run, read([review()], { state: "CLOSED" }), OWNER, ENABLED), false);
  assert.equal(intentStillCurrent(intent, run, read([review()], { baseRefName: "release" }), OWNER, ENABLED), false, "the pull request was retargeted");
  assert.equal(intentStillCurrent(intent, run, read([review()], { headRefName: "renamed-branch" }), OWNER, ENABLED), false, "the head branch is not the recorded one");
  assert.equal(intentStillCurrent(intent, delivered(item => { delete item.pullRequest!.branch; }), read([review()]), OWNER, ENABLED), false, "no recorded branch, no steer");
  assert.equal(intentStillCurrent(intent, run, read([review()]), OWNER, "2026-11-05T00:00:00Z"), false, "the switch was turned on again after the review");
});

test("the review text and request id are a valid steer, and a long summary is cut with a note and the link", () => {
  const short = reviewText("  Rename the flag.  ", URL);
  assert.equal(short, "Rename the flag.");
  const long = reviewText("x".repeat(20000), URL);
  assert.ok(long.length <= REVIEW_TEXT_LIMIT);
  assert.ok(long.endsWith(`Read the rest on the pull request: ${URL}]`));
  const requestId = reviewRequestId("run-1", "PRR_1");
  assert.equal(requestId, reviewRequestId("run-1", "PRR_1"), "a replay is the same request");
  assert.notEqual(requestId, reviewRequestId("run-1", "PRR_2"));
  assert.notEqual(requestId, reviewRequestId("run-2", "PRR_1"));
  assert.doesNotThrow(() => teamMutationSchema.parse({ requestId, revision: 2, text: long }));
});

test("the run view keeps one entry per review, newest 20, and an applied review counts toward the limit once", () => {
  const run = delivered();
  assert.equal(recordReviewOutcome(run, { id: "PRR_1", state: "CHANGES_REQUESTED", submittedAt: ENABLED }, "no-text", ENABLED), true);
  assert.equal(recordReviewOutcome(run, { id: "PRR_1", state: "CHANGES_REQUESTED", submittedAt: ENABLED }, "no-text", ENABLED), false);
  assert.equal(recordReviewOutcome(run, { id: "PRR_1", state: "CHANGES_REQUESTED", submittedAt: ENABLED }, "accepted", ENABLED), true);
  assert.deepEqual(run.reviewFeedback?.map(entry => [entry.reviewId, entry.outcome]), [["PRR_1", "accepted"]]);
  for (let index = 0; index < 25; index++) recordReviewOutcome(run, { id: `R${index}`, state: "APPROVED", submittedAt: ENABLED }, "approved-seen", ENABLED);
  assert.equal(run.reviewFeedback?.length, 20);
  assert.equal(run.reviewFeedback?.[19]?.reviewId, "R24");
  assert.ok(!JSON.stringify(run.reviewFeedback).includes("Rename"), "the view carries no review text");

  const held = intake({ handled: Array.from({ length: 20 }, (_, index) => `H${index}`) });
  const intent = { reviewId: "PRR_1", submittedAt: ENABLED, commit: HEAD, text: "t", requestId: reviewRequestId("run-1", "PRR_1"), targetRevision: 2, state: "pending" as const };
  held.intents.push(intent);
  markReviewApplied(held, intent);
  assert.equal(intent.state, "applied");
  assert.equal(held.accepted, 1);
  assert.equal(held.handled.length, 20);
  assert.equal(held.handled[19], "PRR_1");
});

test("a review's steering is the owner's direction: prompts carry it as such and the objective record takes it", () => {
  const at = "2026-11-02T00:00:00.000Z";
  const run = delivered(run => {
    run.revision = 3;
    run.steering = [{ text: "Rename the flag.", revision: 3, at, source: githubReviewSource("PRR_1") }];
  });
  assert.deepEqual(ownerDirectionLines(run), ["Rename the flag."]);
  const record = runRecord(run, at, "handle");
  assert.notEqual(record, "source-invalid");
  assert.deepEqual(record !== "source-invalid" && record.statement.directions.map(item => [item.id, item.text]), [["s3", "Rename the flag."]]);

  const connector = delivered(run => { run.steering = [{ text: "From Slack.", revision: 2, at, source: { kind: "connector", id: "c", name: "Slack" } }]; });
  assert.deepEqual(ownerDirectionLines(connector), [], "connector steering stays agent direction");
});

test("a workspace removal ends intake only for a pull request the switched-on host was watching", () => {
  const ended = "Review feedback is no longer taken for this pull request: the run's workspace was removed. Start a new mission for further changes.";
  assert.equal(intakeEndedByRemoval(delivered(), undefined, true), ended);
  assert.equal(intakeEndedByRemoval(delivered(), undefined, false), undefined, "with the switch off a removal records what it did before");
  assert.equal(intakeEndedByRemoval(delivered(run => { run.status = "planning"; }), undefined, true), undefined);
  assert.equal(intakeEndedByRemoval(delivered(), intake({ ended: { at: ENABLED, reason: "closed" } }), true), undefined);
});

test("review feedback is off unless configured, and switching it on needs the owner's GitHub login", () => {
  assert.deepEqual(reviewFeedbackConfigSchema.parse({}), { enabled: false, pollMinutes: 5 });
  assert.equal(reviewFeedbackConfigSchema.safeParse({ enabled: true }).success, false);
  assert.equal(reviewFeedbackConfigSchema.safeParse({ enabled: true, ownerLogin: "not a login" }).success, false);
  assert.equal(reviewFeedbackConfigSchema.safeParse({ enabled: true, ownerLogin: OWNER, extra: 1 }).success, false);
  assert.deepEqual(reviewFeedbackConfigSchema.parse({ enabled: true, ownerLogin: OWNER }), { enabled: true, ownerLogin: OWNER, pollMinutes: 5 });
});
