import test, { mock } from "node:test";
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
const forwardedEvent = "The coordinator forwarded the owner's review PRR_1 to subtask a.";
const until = (read: () => Mission, accepts: (mission: Mission) => boolean, timeout = 30000) => waitFor(async () => read(), accepts, timeout);
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const events = (mission: Mission) => mission.events.map(event => event.text);
const received = (mission: Mission) => events(mission).some(text => text.startsWith("Subtask a received the owner's review PRR_1"));
const plan = (id: string, repoProjectId: string) => ({ id, repoProjectId, title: `Subtask ${id}`, objective: `Do ${id}`, size: "solo" as const, parallelism: 1, dependsOn: [] });
const action = (h: Harness, id: string) => ({ requestId: randomUUID(), revision: h.get(id).revision });
const reviewMessages = (messages: MissionMessage[]) => messages.filter(message => message.type === "review-direction");
const reviewStates = (h: Harness, id: string) => (h.stored(id) as unknown as { reviews?: { state: string }[] }).reviews?.map(review => review.state);
const moveHead = (h: Harness, teamId: string) =>
  h.set(teamId, { revision: 2, pullRequest: { revision: 2, headCommit: MOVED, pullRequestUrl, summary: "Another delivery.", reportedAt: new Date().toISOString(), branch: "infinite/a" } });

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

async function forwardQueued(h: Harness, hold: boolean) {
  const { id, teamId, direction } = await delivered(h);
  await h.missions.reviewDirection(id, direction());
  await h.report(2, { kind: "wait", summary: "Reading the review." });
  if (hold) h.standalone.add("api");
  await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
  await until(() => h.get(id), mission => events(mission).includes(forwardedEvent));
  return { id, teamId, direction };
}

test("a review of a working mission's run reaches the coordinator once, and its forward steers the subteam once from the delivered commit", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await delivered(h);
    const revision = h.get(id).revision;
    assert.equal(await h.missions.reviewDirection(id, direction()), "applied");
    assert.equal(h.stored(id).mission.steering.length, 1, "the review is saved in the same change");
    assert.equal(await h.missions.reviewDirection(id, direction()), "applied", "a repeated request id answers from its receipt");
    let mission = h.get(id);
    assert.deepEqual([mission.status, mission.revision], ["working", revision + 1]);
    assert.deepEqual(mission.steering.map(item => [item.text, item.source]), [[requested, { kind: "github-review", id: "PRR_1", name: "Your GitHub review" }]], "one effect for one request id");
    assert.ok(events(mission).includes("The owner's review was delivered to the coordinator: changes requested on the pull request of subtask a (review PRR_1)."));

    await h.report(2, { kind: "wait", summary: "Reading the review." });
    assert.deepEqual(reviewMessages(await h.messages(3)), [{ type: "review-direction", subtaskId: "a", teamId, reviewId: "PRR_1", pullRequestUrl, text: requested }]);
    assert.match((await h.attempt(3)).prompt, /A steer-subtask report on that subtask continues its subteam from the delivered commit and updates the same pull request\./);

    h.loseNextSteerReply();
    await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
    mission = await until(() => h.get(id), received);
    assert.deepEqual(h.steers, [{ teamId, text: forwarded }], "the coordinator's words steer the subteam once, though the steer's reply was lost");
    assert.deepEqual(h.steerSources, ["coordinator"], "the forward reaches the subteam as the coordinator's direction, not as the owner's review");
    assert.deepEqual(h.githubChecks, ["PRR_1"], "GitHub is read once, before the steer; the replay reads the team's receipt instead");
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
    config.github = { reviewFeedback: { enabled: true, ownerLogin: "example-owner", pollMinutes: 5 } };
  } });
  const store = new IntakeStore(h.config, randomBytes(32));
  const intakeService = (config = h.config) => new IntakeService(config, store, h.missions, {} as IntakeLinear, { pollMs: 3600000, log: () => {} });
  const intake = intakeService();
  try {
    const { id, direction } = await delivered(h);
    const at = new Date().toISOString(), issueId = randomUUID();
    const record = { issueId, identifier: "ENG-1", url: "https://linear.example/ENG-1", title: "Add an endpoint", description: "", issueCreatedAt: at, issueUpdatedAt: at, state: "started" as const, rule: "label" as const,
      missionId: id, comments: {}, messages: [{ key: "started", kind: "started" as const, text: "Started.", createdAt: at, attempts: 1, status: "sent" as const, ts: "1.000100" }], questions: [], inbound: [], createdAt: at, updatedAt: at };
    store.create(record);
    store.create({ ...record, issueId: randomUUID(), identifier: "ENG-2", state: "finished", missionId: "finished-mission" });
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

    intake.close();
    assert.equal(await h.missions.reviewDirection(id, direction("PRR_2")), "applied");
    await h.attempt(4);
    await pause(1000);
    assert.equal(store.get(issueId)!.state, "finished", "a stopped intake service does not see the reopen");
    assert.deepEqual(reviewStates(h, id), ["superseded", "open"], "a newer review of the same pull request replaces the open one");
    const off = intakeService({ ...h.config, github: undefined });
    off.start();
    await off.poll();
    off.close();
    assert.equal(store.get(issueId)!.state, "finished", "with review feedback off, an intake pass does not look at finished records");
    const peeks: string[] = [], peek = h.missions.peek.bind(h.missions), update = store.update.bind(store);
    h.missions.peek = (missionId: string) => { peeks.push(missionId); return peek(missionId); };
    let broken = true;
    store.update = (changed: string, change: Parameters<typeof store.update>[1]) => {
      if (broken && changed === issueId) { broken = false; throw new Error("The intake record could not be written."); }
      return update(changed, change);
    };
    const later = intakeService();
    try {
      later.start();
      await later.poll();
      assert.equal(store.get(issueId)!.state, "finished", "a failed write leaves the record finished");
      await later.poll();
      assert.equal(store.get(issueId)!.state, "started", "the pass after a failed reopen looks at finished records again");
      const looked = peeks.filter(item => item === "finished-mission").length;
      await later.poll();
      assert.deepEqual([looked, peeks.filter(item => item === "finished-mission").length], [2, 2], "later passes leave finished records alone");
      const quiet = store.get(issueId)!.updatedAt;
      await pause(5);
      assert.equal(await h.missions.reviewDirection(id, direction("PRR_3")), "applied");
      assert.equal(store.get(issueId)!.updatedAt, quiet, "a change to a live mission leaves its started record alone");
    } finally { later.close(); }
  } finally { intake.close(); h.close(); }
});

test("a review's effect follows its mission's status: recorded while live, waiting while paused or blocked, refused once cancelled", { timeout: 120000 }, async () => {
  const rows: [string, (h: Harness, id: string) => Promise<unknown>, "applied" | "waiting" | "refused", Mission["status"]][] = [
    ["working", async () => {}, "applied", "working"],
    ["needs-input", async (h, id) => {
      await h.report(2, { kind: "question", question: "Which response format?", options: ["JSON", "Text"] });
      await until(() => h.get(id), mission => mission.status === "needs-input");
    }, "applied", "needs-input"],
    ["paused", (h, id) => h.missions.pause(id, action(h, id)), "waiting", "paused"],
    ["blocked by its coordinator", async (h, id) => {
      await h.report(2, { kind: "blocked", summary: "The API contract needs the owner." });
      await until(() => h.get(id), mission => mission.status === "blocked");
    }, "waiting", "blocked"],
    ["cancelled", (h, id) => h.missions.cancel(id, action(h, id)), "refused", "cancelled"],
  ];
  for (const [name, reach, effect, status] of rows) {
    const h = scripted();
    try {
      const { id, direction } = await delivered(h);
      await reach(h, id);
      if (effect === "refused") await assert.rejects(h.missions.reviewDirection(id, direction()), { code: "mission-cancelled" }, name);
      else {
        assert.equal(await h.missions.reviewDirection(id, direction()), effect, name);
        assert.equal(await h.missions.reviewDirection(id, direction()), effect, `${name}: a repeat answers the same`);
      }
      const mission = h.get(id);
      assert.equal(mission.status, status, `${name}: the status stays`);
      assert.deepEqual(mission.steering.map(item => item.source), effect === "applied" ? [{ kind: "github-review", id: "PRR_1", name: "Your GitHub review" }] : [], name);
      for (const seen of [mission, h.stored(id).mission])
        assert.equal(events(seen).filter(text => text.startsWith("A review is waiting:")).length, effect === "waiting" ? 1 : 0, `${name}: the waiting event, also as saved`);
    } finally { h.close(); }
  }
});

test("a review is refused for a run that is no longer the subtask's, for a reused request id, and while the mission's steering is full", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, direction } = await delivered(h);
    await assert.rejects(h.missions.reviewDirection(id, { ...direction(), runId: randomUUID() }), { code: "mission-review-subtask" });
    assert.equal(await h.missions.reviewDirection(id, direction()), "applied");
    await assert.rejects(h.missions.reviewDirection(id, { ...direction(), text: "Other words." }), { code: "request-conflict" });
    for (const text of ["a".repeat(4950), "b".repeat(4950)]) await h.missions.steer(id, { ...action(h, id), text });
    await assert.rejects(h.missions.reviewDirection(id, direction("PRR_2")), { code: "mission-steering-limit" });
    assert.equal(h.get(id).steering.length, 3);
  } finally { h.close(); }
});

test("a forward waits while another run holds the repository, then steers and clears the coordinator's refusals", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await delivered(h);
    await h.missions.reviewDirection(id, direction());
    await h.report(2, { kind: "cancel-subtask", subtaskId: "a", reason: "Reading the review first." });
    await waitFor(async () => h.refusals(id), count => count === 1);
    h.standalone.add("api");
    await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
    await until(() => h.get(id), mission => events(mission).includes(forwardedEvent));
    await pause(1500);
    assert.deepEqual([h.steers, h.githubChecks], [[], []], "nothing is read or steered while the repository is held");
    h.standalone.delete("api");
    await until(() => h.get(id), received);
    assert.deepEqual(h.steers, [{ teamId, text: forwarded }]);
    await waitFor(async () => h.refusals(id), count => count === 0);
  } finally { h.close(); }
});

test("a forward is not rebound to a subteam whose head moved, and does not run once GitHub supersedes the review", { timeout: 60000 }, async () => {
  for (const [name, change, reason] of [
    ["head moved", moveHead, "The subteam's run no longer waits for review at the reviewed revision and head."],
    ["superseded", (h: Harness) => h.readReview(async () => false), "GitHub no longer shows it as the owner's newest request for changes on the delivered head"],
    ["refused by the subteam", (h: Harness, teamId: string) => h.limitSteering([teamId]), "This team reached its steering limit."],
  ] as const) {
    const h = scripted();
    try {
      const { id, teamId } = await forwardQueued(h, true);
      change(h, teamId);
      h.standalone.delete("api");
      await until(() => h.get(id), mission => events(mission).some(text => text.startsWith("The owner's review PRR_1 of subtask a was not forwarded:")));
      assert.deepEqual(h.steers, [], `${name}: the subteam is not steered`);
      const told = () => {
        const saved = h.stored(id);
        return [...saved.attempts.flatMap(attempt => attempt.consumedInbox ?? []), ...saved.inbox].find(message => message.type === "refused" && message.kind === "steer-subtask");
      };
      const message = await waitFor(async () => told(), Boolean, 10000);
      assert.ok(message?.type === "refused" && message.reason.includes(reason), `${name}: the coordinator is told why`);
      assert.deepEqual(reviewStates(h, id), [name === "superseded" ? "superseded" : "refused"], name);
    } finally { h.close(); }
  }
});

test("a steer-subtask becomes the forward only from an attempt that saw the review, and only while the subteam waits at the reviewed head", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await delivered(h);
    await h.missions.reviewDirection(id, direction());
    await h.report(2, { kind: "steer-subtask", subtaskId: "a", text: "Add a changelog entry." });
    await until(() => h.get(id), mission => events(mission).some(text => text.startsWith("The coordinator's steer-subtask report for subtask a was not applied")));
    const messages: MissionMessage[] = await h.messages(3);
    assert.deepEqual(reviewMessages(messages).map(message => message.type === "review-direction" && message.reviewId), ["PRR_1"], "the next attempt reads the review");
    assert.ok(messages.some(message => message.type === "refused" && message.kind === "steer-subtask" && message.reason.includes("review of subtask a")));
    assert.ok(!events(h.get(id)).includes(forwardedEvent), "an attempt that started before the review does not spend it");

    moveHead(h, teamId);
    await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
    await until(() => h.get(id), mission => events(mission).some(text => text.startsWith("The coordinator's steer-subtask report was refused: The subteam's run no longer waits for review")));
    assert.ok(!events(h.get(id)).includes(forwardedEvent), "a forward to a moved head is refused before it is queued");
    assert.deepEqual(h.steers, []);
    await waitFor(async () => reviewStates(h, id), states => states?.[0] === "refused");
  } finally { h.close(); }
});

test("a steer-subtask to a subteam that runs again is ordinary direction, even while a review of its pull request is open", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await delivered(h);
    await h.missions.reviewDirection(id, direction());
    await h.report(2, { kind: "wait", summary: "Reading the review." });
    h.set(teamId, { status: "implementing" });
    await until(() => h.get(id), mission => mission.subtasks[0]?.status === "running");
    await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
    await until(() => h.get(id), mission => events(mission).includes("The coordinator sent direction to subtask a."));
    assert.ok(!events(h.get(id)).includes(forwardedEvent));
  } finally { h.close(); }
});

test("a forward to a cancelled mission's subteam, or one whose steer fails unexpectedly, steers nothing", { timeout: 60000 }, async () => {
  for (const [name, stop, outcome] of [
    ["cancelled", (h: Harness, id: string) => h.missions.cancel(id, action(h, id)),
      (mission: Mission) => events(mission).includes("The owner's review PRR_1 of subtask a was not forwarded: The mission stopped before the forward reached the subteam.")],
    ["unexpected failure", async (h: Harness) => h.breakNextSteer(),
      (mission: Mission) => mission.status === "blocked" && mission.reason === "The mission could not advance. Its subteams and evidence remain available."],
  ] as const) {
    const h = scripted();
    try {
      const { id } = await forwardQueued(h, true);
      await stop(h, id);
      h.standalone.delete("api");
      await until(() => h.get(id), outcome);
      assert.deepEqual(h.steers, [], name);
    } finally { h.close(); }
  }
});

test("a forward held only by a paused run outside the mission names that run to the coordinator, and the coordinator cannot wait on it", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await delivered(h);
    await h.missions.reviewDirection(id, direction());
    await h.report(2, { kind: "wait", summary: "Reading the review." });
    h.runs.set("paused-api", { id: "paused-api", projectId: "api", missionId: "", status: "paused", revision: 1, decisions: [], updatedAt: new Date().toISOString() });
    await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
    const held = (await h.messages(4)).filter((message: MissionMessage) => message.type === "repository-held");
    assert.deepEqual(held, [{ type: "repository-held", subtaskId: "a", repoProjectId: "api", teamId: "paused-api", teamStatus: "paused", reviewId: "PRR_1" }]);
    assert.match((await h.attempt(4)).prompt, /A repository-held message with a reviewId means the forward of that review waits/);
    await h.report(4, { kind: "wait", summary: "Waiting for the forward." });
    await until(() => h.get(id), mission => events(mission).some(text => text.startsWith("The coordinator's wait report was refused: Nothing is running")));
    assert.deepEqual([h.steers, h.githubChecks], [[], []]);
    h.set("paused-api", { status: "cancelled" });
    await until(() => h.get(id), received);
    assert.deepEqual(h.steers, [{ teamId, text: forwarded }]);
  } finally { h.close(); }
});

test("a steer-subtask from an attempt whose messages stopped before the review is not the forward", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await delivered(h);
    const live = (h.missions as unknown as { records: Map<string, { inbox: MissionMessage[] }> }).records.get(id)!;
    for (let n = 0; n < 30; n++) live.inbox.push({ type: "refused", kind: "wait", reason: `Earlier refusal ${n}.` });
    await h.missions.reviewDirection(id, direction());
    await h.report(2, { kind: "wait", summary: "Waiting." });
    assert.deepEqual(reviewMessages(await h.messages(3)), [], "the review waits behind thirty earlier messages");
    await h.report(3, { kind: "steer-subtask", subtaskId: "a", text: "Add a changelog entry." });
    await until(() => h.get(id), mission => events(mission).some(text => text.startsWith("The coordinator's steer-subtask report for subtask a was not applied")));
    assert.equal(reviewMessages(await h.messages(4)).length, 1);
    await h.report(4, { kind: "steer-subtask", subtaskId: "a", text: forwarded });
    await until(() => h.get(id), received);
    assert.deepEqual(h.steers, [{ teamId, text: forwarded }]);
  } finally { h.close(); }
});

test("a slow GitHub read holds neither its mission's queue nor the scheduler, and a hold that starts during the read stops the steer", { timeout: 60000 }, async () => {
  const h = scripted();
  const promptly = <T>(work: Promise<T>, what: string) => Promise.race([work, pause(4000).then((): never => { throw new Error(`${what} waited for the GitHub read`); })]);
  const started = async (missionId: string) => {
    for (let n = 1; n <= h.attempts(); n++) if ((await h.attempt(n)).assignment.runId === missionId) return true;
    return false;
  };
  try {
    let answer: (current: boolean) => void = () => {};
    h.readReview(() => new Promise(done => { answer = done; }));
    const { id, teamId } = await forwardQueued(h, false);
    await waitFor(async () => h.githubChecks.length, count => count === 1);
    await pause(1200);
    assert.equal(h.githubChecks.length, 1, "one read at a time");
    h.standalone.add("api");
    const paused = await promptly(h.missions.pause(id, action(h, id)), "the owner's pause");
    const other = await h.create("Document the API");
    await promptly(waitFor(() => started(other.id), Boolean, 8000), "another mission's first attempt");
    await h.missions.resume(id, { requestId: randomUUID(), revision: paused.revision });
    answer(true);
    await pause(1500);
    assert.deepEqual([h.steers, h.githubChecks.length], [[], 1], "a read taken before the hold is not used while the repository is held");
    h.readReview(async () => true);
    h.standalone.delete("api");
    await until(() => h.get(id), received);
    assert.deepEqual([h.steers, h.githubChecks.length], [[{ teamId, text: forwarded }], 2], "GitHub is read again once the hold ends");
  } finally { h.close(); }
});

test("a result that arrives with the forward's steer is refused while the steered subteam runs", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    let answer: (current: boolean) => void = () => {};
    h.readReview(() => new Promise(done => { answer = done; }));
    const { id } = await forwardQueued(h, false);
    await waitFor(async () => h.githubChecks.length, count => count === 1);
    await h.missions.steer(id, { ...action(h, id), text: "Keep the old flag documented." });
    await h.attempt(4);
    answer(true);
    await h.report(4, { kind: "result", summary: "Renamed the flag." });
    await until(() => h.get(id), received);
    await until(() => h.get(id), mission => events(mission).some(text => text.startsWith("The coordinator's result report was refused:")));
    assert.notEqual(h.get(id).status, "ready-for-review");
  } finally { h.close(); }
});

test("while a forward is on its way the coordinator may wait but cannot report a result", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await forwardQueued(h, true);
    await h.missions.steer(id, { ...action(h, id), text: "Keep the old flag documented." });
    await h.report(4, { kind: "wait", summary: "Waiting for the forward." });
    await until(() => h.get(id), mission => events(mission).filter(text => text === "The coordinator is waiting for subteam progress, owner input, or a follow-up.").length === 2);
    await h.missions.steer(id, { ...action(h, id), text: "Mention the alias in the changelog." });
    await h.report(5, { kind: "result", summary: "Renamed the flag." });
    await until(() => h.get(id), mission => events(mission).some(text => text.endsWith("The owner's review is still on its way to its subtask. Wait for that subteam before reporting a result.")));
    assert.equal(h.get(id).status, "working");
    h.standalone.delete("api");
    await until(() => h.get(id), received);
  } finally { h.close(); }
});

test("a queued forward survives restarts and steers once, also when the steer's reply is lost", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id, teamId, direction } = await forwardQueued(h, true);
    await h.restart();
    assert.equal(await h.missions.reviewDirection(id, direction()), "applied", "the review's receipt survives the restart");
    h.loseNextSteerReply();
    h.standalone.delete("api");
    await waitFor(async () => h.steers.length, count => count === 1);
    await h.restart();
    const mission = await until(() => h.get(id), received);
    assert.deepEqual([h.steers, h.githubChecks], [[{ teamId, text: forwarded }], ["PRR_1"]]);
    assert.equal(events(mission).filter(text => text.startsWith("Subtask a received")).length, 1);
    assert.equal(mission.steering.length, 1);
  } finally { h.close(); }
});

test("a failed GitHub read keeps the forward and is retried a minute later", { timeout: 60000 }, async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const h = scripted();
  try {
    h.readReview(async () => { throw new Error("GitHub could not be read."); });
    const { id, teamId } = await forwardQueued(h, false);
    await waitFor(async () => h.githubChecks.length, count => count === 1);
    await pause(1500);
    assert.deepEqual([h.githubChecks.length, h.steers], [1, []], "a failed read is not retried at once and steers nothing");
    assert.ok(!events(h.get(id)).some(text => text.includes("was not forwarded")), "a failed read does not end the forward");
    h.readReview(async () => true);
    mock.timers.tick(61_000);
    await until(() => h.get(id), received);
    assert.deepEqual([h.githubChecks.length, h.steers], [2, [{ teamId, text: forwarded }]]);
  } finally { h.close(); mock.timers.reset(); }
});

test("at its time limit a mission keeps a new review waiting and holds a queued forward until the owner extends it", { timeout: 60000 }, async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const h = scripted();
  try {
    const { id, teamId, direction } = await forwardQueued(h, true);
    mock.timers.tick(31 * 60000);
    const blocked = await until(() => h.get(id), mission => mission.stopReason === "deadline");
    assert.equal(await h.missions.reviewDirection(id, direction("PRR_2")), "waiting");
    h.standalone.delete("api");
    await pause(1500);
    assert.deepEqual([h.steers, h.githubChecks], [[], []], "nothing is read or steered while the mission is blocked at its time limit");
    await h.missions.extend(id, { requestId: randomUUID(), revision: blocked.revision, minutes: 20 });
    await until(() => h.get(id), received);
    assert.deepEqual(h.steers, [{ teamId, text: forwarded }]);
  } finally { h.close(); mock.timers.reset(); }
});
