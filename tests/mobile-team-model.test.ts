import test from "node:test";
import assert from "node:assert/strict";
import { goalControls, goalGroup, groupRuns, newer, openDecisions, taskKind, teamControls, teamGroup, teamKind, type ProductGoal, type TeamTask, type TeamView } from "../apps/mobile/src/features/teams/model.ts";
import { age, initials } from "../apps/mobile/src/status.ts";
import { runRequests } from "../apps/mobile/src/store/requests.ts";

const team = (overrides: Partial<TeamView> = {}) => ({
  id: "team", projectId: "rehearsal", provider: "demo", title: "Team", objective: "Build it", parallelism: 2,
  revision: 2, status: "implementing", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z",
  workspace: "/srv/team", branch: "infinite/team", baseCommit: "base", tasks: [], members: [], decisions: [], checks: [],
  steering: [], events: [], round: 0, ...overrides,
}) as TeamView;
const goal = (overrides: Partial<ProductGoal> = {}) => ({
  id: "goal", projectId: "rehearsal", title: "Goal", objective: "Improve it", successCriteria: "Measured", nonGoals: [], allowedPaths: ["."],
  evidence: [], maxRuns: 3, maxMinutes: 60, maxMembers: 24, parallelism: 3, revision: 1, status: "running",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deadlineAt: "2026-01-01T01:00:00.000Z",
  cycles: [], memberCount: 1, steering: [], events: [], outcomes: [], activeTeamId: "team", ...overrides,
}) as ProductGoal;

test("phone team controls follow the documented roles and goal ownership", () => {
  assert.deepEqual(teamControls(team(), "owner", true), { answer: true, steer: true, pause: true, resume: false, cancel: true });
  assert.deepEqual(teamControls(team(), "controller", true), { answer: true, steer: true, pause: false, resume: false, cancel: false });
  assert.deepEqual(teamControls(team(), "viewer", true), { answer: false, steer: false, pause: false, resume: false, cancel: false });
  // A goal-owned team is steered and stopped from its goal; its decisions stay answerable here.
  assert.deepEqual(teamControls(team({ goal: { id: "goal", revision: 1, cycle: 1 } }), "owner", true), { answer: true, steer: false, pause: false, resume: false, cancel: false });
  // A stale view offers nothing until a poll succeeds.
  assert.deepEqual(teamControls(team(), "owner", false), { answer: false, steer: false, pause: false, resume: false, cancel: false });
  assert.deepEqual(teamControls(team({ status: "paused" }), "owner", true), { answer: false, steer: true, pause: false, resume: true, cancel: true });
  // A team blocked by a member's runtime limit resumes from its preserved integration commit.
  assert.deepEqual(teamControls(team({ status: "blocked", resumable: true }), "owner", true), { answer: true, steer: true, pause: false, resume: true, cancel: true });
  assert.equal(teamControls(team({ status: "blocked", resumable: true }), "controller", true).resume, false);
  // Delivery is a separate phase: decisions remain answerable, steering stops, and an owner can still pause an in-flight publisher.
  assert.deepEqual(teamControls(team({ status: "delivering" }), "owner", true), { answer: true, steer: false, pause: true, resume: false, cancel: true });
  // A merge receipt is an agent claim; steering and pausing stop, while decisions stay answerable.
  assert.deepEqual(teamControls(team({ status: "merged" }), "owner", true), { answer: true, steer: false, pause: false, resume: false, cancel: true });
  const receipt = { revision: 2, headCommit: "a".repeat(40), pullRequestUrl: "https://github.com/owner/repo/pull/12", mergeCommit: "b".repeat(40), summary: "Merged", reportedAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(teamControls(team({ status: "paused", deliveryReceipt: receipt }), "owner", true), { answer: false, steer: false, pause: false, resume: false, cancel: true });
  assert.deepEqual(teamControls(team({ status: "blocked", deliveryReceipt: receipt }), "owner", true), { answer: true, steer: false, pause: false, resume: false, cancel: true });
  for (const status of ["blocked", "ready-for-review", "no-change"] as const) assert.equal(teamControls(team({ status }), "owner", true).pause, false, status);
  assert.deepEqual(teamControls(team({ status: "cancelled" }), "owner", true), { answer: false, steer: false, pause: false, resume: false, cancel: false });
});

test("phone goal controls allow an outcome only after the goal has stopped", () => {
  const beforeDeadline = Date.parse("2026-01-01T00:30:00.000Z");
  assert.deepEqual(goalControls(goal(), "owner", true), { steer: true, pause: true, resume: false, cancel: true, outcome: false });
  assert.deepEqual(goalControls(goal(), "controller", true), { steer: true, pause: false, resume: false, cancel: false, outcome: false });
  assert.deepEqual(goalControls(goal({ status: "paused" }), "owner", true, beforeDeadline), { steer: false, pause: false, resume: true, cancel: true, outcome: false });
  // Pausing does not extend the deadline; the host refuses to resume an expired goal.
  assert.equal(goalControls(goal({ status: "paused" }), "owner", true, Date.parse("2026-01-01T01:00:00.000Z")).resume, false);
  // The cycle may still be stopping after cancellation; the outcome waits for it.
  assert.equal(goalControls(goal({ status: "cancelled" }), "owner", true).outcome, false);
  assert.deepEqual(goalControls(goal({ status: "ready-for-review", activeTeamId: undefined }), "controller", true), { steer: false, pause: false, resume: false, cancel: false, outcome: true });
  assert.equal(goalControls(goal({ status: "ready-for-review", activeTeamId: undefined }), "viewer", true).outcome, false);
});

test("a late poll cannot replace a newer recorded revision, and only current questions are open", () => {
  const recorded = team({ revision: 3, updatedAt: "2026-01-01T00:02:00.000Z" });
  assert.equal(newer(recorded, team()), recorded);
  const later = team({ revision: 3, updatedAt: "2026-01-01T00:03:00.000Z" });
  assert.equal(newer(recorded, later), later);
  assert.equal(newer(null, recorded), recorded);
  const decisions = [
    { id: "old", memberId: "m", revision: 1, question: "Earlier?", options: [], createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "answered", memberId: "m", revision: 2, question: "Done?", options: [], createdAt: "2026-01-01T00:00:00.000Z", answer: "Yes" },
    { id: "open", memberId: "m", revision: 2, question: "Which?", options: ["A"], createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(openDecisions(team({ decisions })).map(decision => decision.id), ["open"]);
});

test("an unconfirmed run request stays pending for an identical retry until the host answers it", () => {
  const key = "machine/team/run";
  const first = runRequests.begin(key, { requestId: "first", revision: 2, path: "/teams/run/steer", label: "Direction", fields: { text: "Keep the layout" } });
  // A second send while the first is unconfirmed resends the original request, not a new one.
  assert.equal(runRequests.begin(key, { requestId: "second", revision: 3, path: "/teams/run/pause", label: "Pause", fields: {} }), first);
  runRequests.fail(key, "first", "The host did not respond.");
  assert.equal(runRequests.read(key).pending, first);
  // A late answer for a different request cannot settle this one.
  assert.equal(runRequests.complete(key, "second", { id: "run" }), false);
  assert.equal(runRequests.read(key).pending, first);
  assert.equal(runRequests.complete(key, "first", { id: "run" }, "Direction recorded"), true);
  assert.equal(runRequests.read(key).pending, undefined);
  // A refusal clears the request so the person decides again against the refreshed run.
  runRequests.begin(key, { requestId: "third", revision: 3, path: "/teams/run/pause", label: "Pause", fields: {} });
  runRequests.fail(key, "third", "This team is not running and cannot be paused.", true);
  assert.equal(runRequests.read(key).pending, undefined);
  runRequests.clearMachine("machine");
});

const task = (id: string, status: TeamTask["status"], dependsOn: string[] = []) => ({ id, title: id, instructions: "", paths: [], dependsOn, status }) as TeamTask;
const question = { id: "q", memberId: "m", revision: 2, question: "Which?", options: [], createdAt: "2026-01-01T00:00:00.000Z" };

test("phone run lists put work waiting on a person first and fold stopped runs together", () => {
  assert.equal(teamGroup(team({ status: "needs-input" })), "attention");
  assert.equal(teamGroup(team({ status: "blocked" })), "attention");
  // An open question pulls a working run into Needs you; a cancelled run's questions can no longer be answered.
  assert.equal(teamGroup(team({ decisions: [question] })), "attention");
  assert.equal(teamGroup(team({ status: "cancelled", decisions: [question] })), "closed");
  assert.equal(teamGroup(team({ status: "no-change" })), "closed");
  assert.equal(teamGroup(team({ status: "merged" })), "review");
  assert.equal(teamGroup(team({ status: "paused" })), "active");
  assert.equal(goalGroup(goal({ status: "limit-reached" })), "attention");
  assert.equal(goalGroup(goal({ status: "achieved" })), "closed");
  const runs = [team({ id: "a", status: "cancelled" }), team({ id: "b" }), team({ id: "c", status: "needs-input" }), team({ id: "d" })];
  assert.deepEqual(groupRuns(runs, teamGroup).map(group => [group.group, group.items.map(item => item.id)]), [["attention", ["c"]], ["active", ["b", "d"]], ["closed", ["a"]]]);
});

test("phone status icons show plan progress without reading a full ring as completion", () => {
  assert.deepEqual(teamKind(team({ tasks: [task("t1", "integrated"), task("t2", "integrated"), task("t3", "running"), task("t4", "pending")] })), { kind: "progress", fraction: 0.5 });
  // Planning has no tasks yet, but started work still shows a quarter.
  assert.deepEqual(teamKind(team({ status: "planning" })), { kind: "progress", fraction: 0.25 });
  assert.equal(teamKind(team({ status: "ready-for-review" })).kind, "review");
  assert.equal(teamKind(team({ status: "paused", decisions: [question] })).kind, "paused");
  assert.equal(teamKind(team({ decisions: [question] })).kind, "attention");
  const tasks = [task("t1", "integrated"), task("t2", "pending", ["t1"]), task("t3", "pending", ["t2"]), task("t4", "waiting")];
  assert.deepEqual(tasks.map(item => taskKind(item, tasks)), ["done", "todo", "backlog", "paused"]);
});

test("phone avatars and ages stay short and stable", () => {
  assert.equal(initials("Opus 5.5 xhigh"), "O5");
  assert.equal(initials("DeepSeek V4.1 Flash high"), "DS");
  assert.equal(initials("Muse Spark 1.3 Contributor"), "MS");
  assert.equal(initials("Codex"), "Co");
  assert.equal(initials("  "), "?");
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  assert.equal(age("2026-01-01T11:59:30.000Z", now), "now");
  assert.equal(age("2026-01-01T11:15:00.000Z", now), "45m");
  assert.equal(age("2026-01-01T09:00:00.000Z", now), "3h");
  assert.equal(age("2025-12-30T12:00:00.000Z", now), "2d");
  assert.equal(age("not a date", now), "");
});
