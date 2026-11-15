import test from "node:test";
import assert from "node:assert/strict";
import { attemptLabel, attemptsOf, foldAttempts, groupBoard, filterBoard, missionControls, missionExtendChoices, missionLeftLabel, missionStatusLabel, missionStoppedAtLimit, missionTimeLeftMs, openMissionDecisions } from "../apps/mobile/src/features/board/model.ts";
import type { BoardItem, Mission } from "../apps/mobile/src/api/client.ts";

const item = (overrides: Partial<BoardItem> = {}): BoardItem => ({
  kind: "mission", id: "mission", title: "Mission", projectName: "Project", groupId: "project",
  column: "working", status: "working", detail: "Planning work", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
});
const attempt = (number: number, superseded: boolean, overrides: Partial<BoardItem> = {}) =>
  item({ id: `run-${number}`, attempt: { workId: "work", number, of: 3, superseded }, ...overrides });

test("the board keeps its four sections and orders each section newest first", () => {
  const groups = groupBoard([
    item({ id: "older", updatedAt: "2026-10-01T00:00:00.000Z" }),
    item({ id: "need", column: "needs-input", updatedAt: "2026-10-03T00:00:00.000Z" }),
    item({ id: "newer", updatedAt: "2026-10-04T00:00:00.000Z" }),
    item({ id: "ended", column: "ended" }),
  ]);
  assert.deepEqual(groups.map(group => group.title), ["Needs input", "Working", "Ready for review", "Ended"]);
  assert.deepEqual(groups.map(group => group.items.map(row => row.id)), [["need"], ["newer", "older"], [], ["ended"]]);
});

test("project filtering retains only items belonging to that group", () => {
  const rows = [item({ id: "a", groupId: "a" }), item({ id: "b", groupId: "b" }), item({ id: "standalone", groupId: undefined })];
  assert.deepEqual(filterBoard(rows, "a").map(row => row.id), ["a"]);
  assert.deepEqual(filterBoard(rows).map(row => row.id), ["a", "b", "standalone"]);
  const team = item({ id: "team-run", kind: "team", groupId: "project" });
  assert.deepEqual(filterBoard([...rows, team], "project").map(row => row.id), ["team-run"]);
});

test("superseded attempts fold behind the newest, and a live older attempt keeps its row", () => {
  const superseded = [attempt(1, true, { status: "blocked", detail: "Blocked" }), attempt(2, true, { column: "ended", status: "cancelled" }), attempt(3, false)];
  assert.deepEqual(groupBoard(superseded)[1]!.items.map(row => row.id), ["run-3"]);
  assert.deepEqual(groupBoard(superseded).flatMap(group => group.items).length, 1);
  const live = [attempt(1, false, { status: "blocked" }), attempt(2, true, { column: "ended", status: "cancelled" }), attempt(3, false)];
  assert.deepEqual(groupBoard(live).flatMap(group => group.items).map(row => row.id).sort(), ["run-1", "run-3"]);
  assert.deepEqual(foldAttempts([item({ id: "plain" }), attempt(2, true)]).map(row => row.id), ["plain"]);
  assert.equal(attemptLabel(attempt(2, false)), "Attempt 2 of 3");
  assert.equal(attemptLabel(item({ id: "plain" })), undefined);
});

test("an item's attempts come back oldest first, and an item with one start has none", () => {
  const rows = [attempt(3, false), attempt(1, true), attempt(2, true), item({ id: "other", attempt: { workId: "other", number: 1, of: 2, superseded: false } })];
  assert.deepEqual(attemptsOf(rows, rows[0]!).map(row => row.id), ["run-1", "run-2", "run-3"]);
  assert.deepEqual(attemptsOf(rows, item({ id: "plain" })), []);
});

test("mission decisions remain open until an answer is recorded", () => {
  const mission = {
    decisions: [
      { id: "open", question: "Which?", options: ["A"], createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "answered", question: "Done?", options: [], createdAt: "2026-10-01T00:00:00.000Z", answer: "Yes" },
    ],
  } as Mission;
  assert.deepEqual(openMissionDecisions(mission).map(decision => decision.id), ["open"]);
});

const now = Date.parse("2026-10-01T00:00:00.000Z");
const controlMission = (status: Mission["status"], overrides: Partial<Mission> = {}) =>
  ({ status, deadlineAt: "2026-10-02T00:00:00.000Z", maxMinutes: 240, ...overrides }) as Mission;

test("the owner of a fresh mission can extend it while it runs, waits, or is paused", () => {
  for (const status of ["planning", "working", "needs-input", "paused"] as const) {
    assert.equal(missionControls(controlMission(status), "owner", true, now).extend, true, status);
  }
  assert.equal(missionControls(controlMission("blocked", { stopReason: "deadline" }), "owner", true, now).extend, true);
});

test("extend is withheld from blocked missions without a stop reason, ended missions, non-owners, and stale views", () => {
  assert.equal(missionControls(controlMission("blocked"), "owner", true, now).extend, false);
  assert.equal(missionControls(controlMission("cancelled"), "owner", true, now).extend, false);
  assert.equal(missionControls(controlMission("ready-for-review"), "owner", true, now).extend, false);
  assert.equal(missionControls(controlMission("working"), "controller", true, now).extend, false);
  assert.equal(missionControls(controlMission("blocked", { stopReason: "deadline" }), "viewer", true, now).extend, false);
  assert.equal(missionControls(controlMission("working"), "owner", false, now).extend, false);
  assert.equal(missionControls(controlMission("blocked", { stopReason: "deadline" }), "owner", false, now).extend, false);
});

test("a deadline stop is recognised only while the mission is blocked", () => {
  assert.equal(missionStoppedAtLimit(controlMission("blocked", { stopReason: "deadline" })), true);
  assert.equal(missionStoppedAtLimit(controlMission("blocked")), false);
  assert.equal(missionStoppedAtLimit(controlMission("paused", { stopReason: "deadline" })), false);
});

test("extend choices add the mission's own limit in ascending order and mark it", () => {
  const labels = (maxMinutes: number) => missionExtendChoices(maxMinutes).map(choice => choice.label);
  assert.deepEqual(labels(240), ["+1 h", "+4 h (its limit)", "+6 h", "+24 h"]);
  assert.deepEqual(labels(1440), ["+1 h", "+6 h", "+24 h (its limit)"]);
  assert.deepEqual(labels(90), ["+1 h", "+90 min (its limit)", "+6 h", "+24 h"]);
  assert.deepEqual(labels(60), ["+1 h (its limit)", "+6 h", "+24 h"]);
  assert.deepEqual(missionExtendChoices(90).map(choice => choice.minutes), [60, 90, 360, 1440]);
  assert.deepEqual(missionExtendChoices(90).map(choice => choice.ownLimit), [false, true, false, false]);
});

test("a deadline stop reads as stopped at the time limit, and other blocked missions stay blocked", () => {
  assert.equal(missionStatusLabel("blocked", "deadline"), "Stopped at time limit");
  assert.equal(missionStatusLabel("blocked"), "Blocked");
});

test("resume follows the time left, which an intake mission's stopped clock keeps", () => {
  // The deadline has passed, but the clock stopped before it did, so the owner can still resume.
  const stopped = controlMission("paused", { deadlineAt: "2026-09-30T23:00:00.000Z", clockStoppedAt: "2026-09-30T22:30:00.000Z" });
  assert.equal(missionControls(stopped, "owner", true, now).resume, true);
  const spent = controlMission("paused", { deadlineAt: "2026-09-30T22:30:00.000Z", clockStoppedAt: "2026-09-30T22:30:00.000Z" });
  assert.equal(missionControls(spent, "owner", true, now).resume, false);
  const overdue = controlMission("paused", { deadlineAt: "2026-09-30T22:00:00.000Z", clockStoppedAt: "2026-09-30T22:30:00.000Z" });
  assert.equal(missionControls(overdue, "owner", true, now).resume, false);
  assert.equal(missionControls(controlMission("paused", { deadlineAt: "2026-09-30T23:00:00.000Z" }), "owner", true, now).resume, false);
  assert.equal(missionControls(controlMission("paused"), "owner", true, now).resume, true);
});

test("time left counts up to the stopped clock when an intake mission has one", () => {
  const deadlineAt = "2026-10-01T02:00:00.000Z";
  assert.equal(missionTimeLeftMs({ deadlineAt }, now), 2 * 60 * 60000);
  assert.equal(missionTimeLeftMs({ deadlineAt, clockStoppedAt: "2026-10-01T00:30:00.000Z" }, now), 90 * 60000);
});

test("time left reads in hours and minutes, rounded down", () => {
  assert.equal(missionLeftLabel(0), "less than a minute");
  assert.equal(missionLeftLabel(59 * 1000), "less than a minute");
  assert.equal(missionLeftLabel(45 * 60000), "45 min");
  assert.equal(missionLeftLabel(2 * 60 * 60000), "2 h");
  assert.equal(missionLeftLabel(135 * 60000), "2 h 15 min");
});

test("each extend choice has a spoken label that marks the mission's own limit", () => {
  assert.deepEqual(missionExtendChoices(240).map(choice => choice.spoken), ["Extend by 1 hour", "Extend by 4 hours, its limit", "Extend by 6 hours", "Extend by 24 hours"]);
  assert.deepEqual(missionExtendChoices(60).map(choice => choice.spoken), ["Extend by 1 hour, its limit", "Extend by 6 hours", "Extend by 24 hours"]);
});
