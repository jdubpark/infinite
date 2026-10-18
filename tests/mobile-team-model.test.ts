import test from "node:test";
import assert from "node:assert/strict";
import { goalControls, newer, openDecisions, teamControls, type ProductGoal, type TeamView } from "../apps/mobile/src/features/teams/model.ts";
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
