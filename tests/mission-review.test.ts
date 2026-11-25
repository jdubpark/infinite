import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";
import { scriptedMissionHarness as scripted } from "./mission-harness.js";
import { reviewRequestId } from "../packages/host/src/review-feedback.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { IntakeService } from "../packages/host/src/intake.js";
import type { IntakeLinear } from "../packages/host/src/intake-linear.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { MissionMessage } from "../packages/host/src/team-prompts.js";

type Harness = ReturnType<typeof scripted>;

const HEAD = "a".repeat(40), MOVED = "b".repeat(40);
const pullRequestUrl = "https://github.com/example-org/example-api/pull/7";
const requested = "Rename the flag to --strict and keep the old name as an alias.";
const forwarded = "The owner asks for --strict with the old name kept as an alias.";
const until = (read: () => Mission, accepts: (mission: Mission) => boolean, timeout = 30000) => waitFor(async () => read(), accepts, timeout);
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const events = (mission: Mission) => mission.events.map(event => event.text);
const plan = (id: string, repoProjectId: string) => ({ id, repoProjectId, title: `Subtask ${id}`, objective: `Do ${id}`, size: "solo" as const, parallelism: 1, dependsOn: [] });

async function delivered(h: Harness) {
  const { id } = await h.create();
  await h.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
  const teamId = (await until(() => h.get(id), mission => Boolean(mission.subtasks[0]?.teamId))).subtasks[0]!.teamId!;
  h.set(teamId, { status: "ready-for-review", pullRequest: { revision: 1, headCommit: HEAD, pullRequestUrl, summary: "Added the flag.", reportedAt: new Date().toISOString(), branch: "infinite/a" } });
  await until(() => h.get(id), mission => mission.subtasks[0]?.status === "done");
  await h.attempt(2);
  const direction = (reviewId = "PRR_1") => ({ requestId: reviewRequestId(teamId, reviewId), runId: teamId, subtaskId: "a", reviewId, pullRequestUrl, text: requested, revision: 1, headCommit: HEAD });
  return { id, teamId, direction };
}

const reviewMessages = (messages: MissionMessage[]) => messages.filter(message => message.type === "review-direction");

test("a review of a working mission's run reaches the coordinator once, and its forward steers the subteam once from the delivered commit", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await delivered(h);
    assert.equal(await h.missions.reviewDirection(id, direction()), "applied");
    assert.equal(await h.missions.reviewDirection(id, direction()), "applied", "a repeated request id answers from its receipt");
    let mission = h.get(id);
    assert.equal(mission.status, "working");
    assert.deepEqual(mission.steering.map(item => [item.text, item.source]), [[requested, { kind: "github-review", id: "PRR_1", name: "Your GitHub review" }]], "one effect for one request id");
    assert.ok(events(mission).includes("The owner's review was delivered to the coordinator: changes requested on the pull request of subtask a (review PRR_1)."));

    await h.report(2, { kind: "wait", summary: "Reading the review." });
    assert.deepEqual(reviewMessages(await h.messages(3)), [{ type: "review-direction", subtaskId: "a", teamId, reviewId: "PRR_1", pullRequestUrl, text: requested }]);
    assert.match((await h.attempt(3)).prompt, /A steer-subtask report on that subtask continues its subteam from the delivered commit and updates the same pull request\./);

    h.loseNextSteerReply();
    await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
    mission = await until(() => h.get(id), current => events(current).some(text => text.startsWith("Subtask a received the owner's review PRR_1")));
    assert.deepEqual(h.steers, [{ teamId, text: forwarded }], "the coordinator's words steer the subteam once, though the steer's reply was lost");
    assert.deepEqual(h.githubChecks, ["PRR_1"], "GitHub is read once, immediately before the steer; the replay reads the team's receipt instead");
    assert.equal(h.runs.get(teamId)!.revision, 2);
    assert.equal(mission.subtasks[0]!.status, "running", "the subtask follows its subteam");

    h.set(teamId, { status: "ready-for-review", pullRequest: { revision: 2, headCommit: MOVED, pullRequestUrl, summary: "Renamed the flag.", reportedAt: new Date().toISOString(), branch: "infinite/a" } });
    await h.report(4, { kind: "steer-subtask", subtaskId: "a", text: "Once more." });
    await until(() => h.get(id), current => events(current).some(text => /steer-subtask report was refused: Subtask a has no running or blocked subteam/.test(text)));
    assert.equal(h.steers.length, 1, "the review's authorization works once");
  } finally { h.close(); }
});

test("a review reopens a mission at ready-for-review with a new working window, and its intake record starts again", { timeout: 60000 }, async () => {
  const h = scripted({ configure: config => {
    config.intake = { linear: { teamIds: ["team"], creatorId: "creator", label: "infinite", commentsMirrorToSlack: false, admitIssues: false },
      mission: { groupId: "shop", maxSubtasks: 8, maxMinutes: 30 }, maxActive: 3, requireSlackThread: false } as typeof config.intake;
  } });
  const store = new IntakeStore(h.config, randomBytes(32));
  const intake = new IntakeService(h.config, store, h.missions, {} as IntakeLinear, { pollMs: 3600000, log: () => {} });
  try {
    const { id, direction } = await delivered(h);
    const at = new Date().toISOString(), issueId = randomUUID();
    store.create({ issueId, identifier: "ENG-1", url: "https://linear.example/ENG-1", title: "Add an endpoint", description: "", issueCreatedAt: at, issueUpdatedAt: at, state: "started", rule: "label",
      missionId: id, comments: {}, messages: [{ key: "started", kind: "started", text: "Started.", createdAt: at, attempts: 1, status: "sent", ts: "1.000100" }], questions: [], inbound: [], createdAt: at, updatedAt: at });
    intake.start();
    await h.report(2, { kind: "result", summary: "Added the flag." });
    const finished = await until(() => h.get(id), mission => mission.status === "ready-for-review");
    const earlier = store.get(issueId)!;
    assert.equal(earlier.state, "finished");
    assert.match(earlier.comments.outcome!.body, /Added the flag\./);

    const before = Date.now();
    assert.equal(await h.missions.reviewDirection(id, direction()), "applied");
    const reopened = h.get(id);
    assert.equal(reopened.status, "working");
    assert.equal(reopened.result, undefined);
    assert.deepEqual(reopened.earlierResults, [finished.result]);
    const window = Date.parse(reopened.deadlineAt) - before;
    assert.ok(window >= 30 * 60000 - 1000 && window <= 30 * 60000 + 5000, "the mission gets its original maxMinutes once");
    assert.equal(reopened.steering.at(-1)!.source && typeof reopened.steering.at(-1)!.source === "object" && reopened.steering.at(-1)!.source!.kind, "github-review");
    const started = store.get(issueId)!;
    assert.equal(started.state, "started", "the intake record starts again in the same change");
    assert.deepEqual([started.messages, started.comments.outcome!.id], [earlier.messages, earlier.comments.outcome!.id], "earlier messages and the earlier outcome are kept");

    assert.deepEqual(reviewMessages(await h.messages(3)).map(message => message.type), ["review-direction"]);
    await h.report(3, { kind: "result", summary: "Kept the flag as it is; the alias already exists." });
    await until(() => h.get(id), mission => mission.status === "ready-for-review");
    const again = store.get(issueId)!;
    assert.equal(again.state, "finished");
    assert.match(again.comments.outcome!.body, /the alias already exists/, "the next result records its own outcome");
  } finally { intake.close(); h.close(); }
});

test("a review waits while its mission is paused or blocked and is refused once the mission is cancelled", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, direction } = await delivered(h);
    await h.missions.pause(id, { requestId: randomUUID(), revision: h.get(id).revision });
    assert.equal(await h.missions.reviewDirection(id, direction()), "waiting");
    assert.equal(await h.missions.reviewDirection(id, direction()), "waiting");
    let mission = h.get(id);
    assert.deepEqual(mission.steering, []);
    assert.equal(events(mission).filter(text => text.startsWith("A review is waiting:")).length, 1, "the mission's event says once that a review waits");

    await h.missions.resume(id, { requestId: randomUUID(), revision: h.get(id).revision });
    assert.equal(await h.missions.reviewDirection(id, direction()), "applied", "the waiting review applies when the mission is live again");

    await h.report(2, { kind: "blocked", summary: "The API contract needs the owner." });
    await until(() => h.get(id), current => current.status === "blocked");
    assert.equal(await h.missions.reviewDirection(id, direction("PRR_2")), "waiting");

    await h.missions.cancel(id, { requestId: randomUUID(), revision: h.get(id).revision });
    await assert.rejects(h.missions.reviewDirection(id, direction("PRR_2")), { code: "mission-cancelled" });
    mission = h.get(id);
    assert.equal(mission.steering.length, 1);
  } finally { h.close(); }
});

test("a forward waits while another run holds the repository, and then steers", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await delivered(h);
    await h.missions.reviewDirection(id, direction());
    await h.report(2, { kind: "wait", summary: "Reading the review." });
    h.standalone.add("api");
    await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
    await until(() => h.get(id), mission => events(mission).includes("The coordinator forwarded the owner's review PRR_1 to subtask a."));
    await pause(1500);
    assert.deepEqual([h.steers, h.githubChecks], [[], []], "nothing is read or steered while the repository is held");
    h.standalone.delete("api");
    await until(() => h.get(id), mission => events(mission).some(text => text.startsWith("Subtask a received the owner's review PRR_1")));
    assert.deepEqual(h.steers, [{ teamId, text: forwarded }]);
  } finally { h.close(); }
});

test("a forward is not rebound to a subteam whose head moved, and does not run once GitHub supersedes the review", { timeout: 60000 }, async () => {
  for (const [name, change, reason] of [
    ["head moved", (h: Harness, teamId: string) => h.set(teamId, { revision: 2, pullRequest: { revision: 2, headCommit: MOVED, pullRequestUrl, summary: "Another delivery.", reportedAt: new Date().toISOString(), branch: "infinite/a" } }),
      "The subteam's run no longer waits for review at the reviewed revision and head."],
    ["superseded", (h: Harness) => h.reviewCurrent(false), "GitHub no longer shows it as the owner's newest request for changes on the delivered head"],
  ] as const) {
    const h = scripted();
    try {
      const { id, teamId, direction } = await delivered(h);
      await h.missions.reviewDirection(id, direction());
      await h.report(2, { kind: "wait", summary: "Reading the review." });
      h.standalone.add("api");
      await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
      await until(() => h.get(id), mission => events(mission).includes("The coordinator forwarded the owner's review PRR_1 to subtask a."));
      change(h, teamId);
      h.standalone.delete("api");
      await until(() => h.get(id), mission => events(mission).some(text => text.startsWith("The owner's review PRR_1 of subtask a was not forwarded:")));
      assert.deepEqual(h.steers, [], `${name}: the subteam is not steered`);
      const told = (await h.messages(4)).find((message: MissionMessage) => message.type === "refused" && message.kind === "steer-subtask");
      assert.ok(told && "reason" in told && told.reason.includes(reason), `${name}: the coordinator is told why`);
    } finally { h.close(); }
  }
});
