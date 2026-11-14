import test from "node:test";
import assert from "node:assert/strict";
import { attemptLabel, attemptsOf, foldAttempts, groupBoard, filterBoard, openMissionDecisions } from "../apps/mobile/src/features/board/model.ts";
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
