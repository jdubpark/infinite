import test from "node:test";
import assert from "node:assert/strict";
import { missionControls, missionExtendChoices, missionExtensionConfirmation, missionLeftLabel, missionShowsReason, missionStateLabel, missionStopLine, missionTimeLeftMs } from "../apps/web/src/mission-model";
import type { MissionStatus } from "../apps/web/src/mission-model";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const future = new Date(NOW + 60_000).toISOString();
const past = new Date(NOW - 60_000).toISOString();
const statuses: MissionStatus[] = ["planning", "working", "needs-input", "paused", "blocked", "ready-for-review", "cancelled"];

test("mission controls follow owner, freshness, state, and deadline", () => {
  const expected: Record<MissionStatus, { extend: boolean; pause: boolean; resume: boolean; cancel: boolean }> = {
    planning: { extend: true, pause: true, resume: false, cancel: true },
    working: { extend: true, pause: true, resume: false, cancel: true },
    "needs-input": { extend: true, pause: true, resume: false, cancel: true },
    paused: { extend: true, pause: false, resume: true, cancel: true },
    blocked: { extend: false, pause: false, resume: false, cancel: true },
    "ready-for-review": { extend: false, pause: false, resume: false, cancel: false },
    cancelled: { extend: false, pause: false, resume: false, cancel: false },
  };
  for (const status of statuses) {
    assert.deepEqual(missionControls({ status, deadlineAt: future }, "owner", true, NOW), expected[status], status);
  }
  assert.deepEqual(missionControls({ status: "blocked", stopReason: "deadline", deadlineAt: past }, "owner", true, NOW),
    { extend: true, pause: false, resume: false, cancel: true }, "a deadline-stopped mission can be extended");
  assert.deepEqual(missionControls({ status: "paused", deadlineAt: past }, "owner", true, NOW),
    { extend: true, pause: false, resume: false, cancel: true }, "an expired paused mission can be extended but not resumed");
  assert.deepEqual(missionControls({ status: "paused", deadlineAt: past, clockStoppedAt: new Date(NOW - 120_000).toISOString() }, "owner", true, NOW),
    { extend: true, pause: false, resume: true, cancel: true }, "a paused mission keeps its frozen time while the clock is stopped");
  assert.deepEqual(missionControls({ status: "working", deadlineAt: future }, "controller", true, NOW),
    { extend: false, pause: false, resume: false, cancel: false }, "controllers are read-only");
  assert.deepEqual(missionControls({ status: "working", deadlineAt: future }, "owner", false, NOW),
    { extend: false, pause: false, resume: false, cancel: false }, "stale views are read-only");
});

test("mission extension choices include the mission limit once and in order", () => {
  assert.deepEqual(missionExtendChoices(240), [
    { minutes: 60, label: "+1 h", ownLimit: false },
    { minutes: 240, label: "+4 h (its limit)", ownLimit: true },
    { minutes: 360, label: "+6 h", ownLimit: false },
    { minutes: 1440, label: "+24 h", ownLimit: false },
  ]);
  assert.deepEqual(missionExtendChoices(1440), [
    { minutes: 60, label: "+1 h", ownLimit: false },
    { minutes: 360, label: "+6 h", ownLimit: false },
    { minutes: 1440, label: "+24 h (its limit)", ownLimit: true },
  ]);
  assert.deepEqual(missionExtendChoices(90), [
    { minutes: 60, label: "+1 h", ownLimit: false },
    { minutes: 90, label: "+90 min (its limit)", ownLimit: true },
    { minutes: 360, label: "+6 h", ownLimit: false },
    { minutes: 1440, label: "+24 h", ownLimit: false },
  ]);
  assert.deepEqual(missionExtendChoices(60), [
    { minutes: 60, label: "+1 h (its limit)", ownLimit: true },
    { minutes: 360, label: "+6 h", ownLimit: false },
    { minutes: 1440, label: "+24 h", ownLimit: false },
  ]);
});

test("mission state labels distinguish a time-limit stop", () => {
  const labels: Record<MissionStatus, string> = {
    planning: "Planning",
    working: "Working",
    "needs-input": "Needs your input",
    paused: "Paused",
    blocked: "Blocked",
    "ready-for-review": "Ready for review",
    cancelled: "Cancelled",
  };
  for (const status of statuses) {
    assert.equal(missionStateLabel({ status }), labels[status], status);
  }
  assert.equal(missionStateLabel({ status: "blocked", stopReason: "deadline" }), "Stopped at time limit");
});

test("mission time left uses the stopped clock when present", () => {
  const deadlineAt = "2026-11-15T12:30:00.000Z";
  assert.equal(missionTimeLeftMs({ deadlineAt }, NOW), 30 * 60_000);
  assert.equal(missionTimeLeftMs({ deadlineAt, clockStoppedAt: "2026-11-15T12:10:00.000Z" }, NOW), 20 * 60_000);
});

test("mission time-left labels use hours and minutes", () => {
  assert.equal(missionLeftLabel(90 * 60_000), "1 h 30 min");
  assert.equal(missionLeftLabel(120 * 60_000), "2 h");
  assert.equal(missionLeftLabel(45 * 60_000), "45 min");
  assert.equal(missionLeftLabel(60_000), "1 min");
  assert.equal(missionLeftLabel(59_999), "less than a minute");
  assert.equal(missionLeftLabel(30_000), "less than a minute");
});

test("extension confirmation uses remaining time for a stopped clock and stop time otherwise", () => {
  const deadlineAt = "2026-11-15T12:30:00.000Z";
  assert.equal(missionExtensionConfirmation({ deadlineAt, clockStoppedAt: "2026-11-15T12:10:00.000Z" }, NOW, () => "formatted"),
    "Time extension recorded. The clock is stopped with 20 min left.");
  assert.equal(missionExtensionConfirmation({ deadlineAt: "2026-11-15T12:00:00.000Z", clockStoppedAt: "2026-11-15T12:00:01.000Z" }, NOW, () => "formatted"),
    "Time extension recorded. The mission's time limit has passed.");
  assert.equal(missionExtensionConfirmation({ deadlineAt }, NOW, () => "formatted " + deadlineAt),
    "Time extension recorded. The mission now stops formatted " + deadlineAt + ".");
});

test("deadline stop reason is omitted while other mission reasons remain visible", () => {
  assert.equal(missionShowsReason({ status: "blocked", stopReason: "deadline", reason: "Deadline reached" }), false);
  assert.equal(missionShowsReason({ status: "blocked", reason: "Waiting on a dependency" }), true);
  assert.equal(missionShowsReason({ status: "paused", reason: "Owner requested pause" }), true);
});

test("mission stop-time lines match live, stopped, and terminal states", () => {
  const formatDate = (value: string) => "formatted " + value;
  const deadlineAt = new Date(NOW + 30 * 60_000).toISOString();
  assert.equal(missionStopLine({ status: "blocked", stopReason: "deadline", deadlineAt }, NOW, formatDate),
    "Stopped at its time limit. Its work is kept. Extend to continue, or cancel.");
  assert.equal(missionStopLine({ status: "working", deadlineAt }, NOW, formatDate), "Stops formatted " + deadlineAt);
  assert.equal(missionStopLine({ status: "needs-input", deadlineAt, clockStoppedAt: new Date(NOW - 10 * 60_000).toISOString() }, NOW, formatDate),
    "Clock stopped while it waits · 40 min left");
  assert.equal(missionStopLine({ status: "planning", deadlineAt: past }, NOW, formatDate),
    "Its time limit has passed. Extend to continue.");
  const stoppedAfterDeadline = new Date(Date.parse(past) + 1_000).toISOString();
  assert.equal(missionStopLine({ status: "paused", deadlineAt: past, clockStoppedAt: stoppedAfterDeadline }, NOW, formatDate),
    "Its time limit has passed. Extend to continue.", "a stopped clock after the deadline leaves no time to resume");
  assert.equal(missionTimeLeftMs({ deadlineAt: past, clockStoppedAt: stoppedAfterDeadline }, NOW), -1_000);
  for (const status of ["cancelled", "ready-for-review"] as const) {
    assert.equal(missionStopLine({ status, deadlineAt: past }, NOW, formatDate), undefined, status);
  }
  assert.equal(missionStopLine({ status: "blocked", deadlineAt: past }, NOW, formatDate), undefined,
    "a non-deadline blocked mission cannot be extended");
});
