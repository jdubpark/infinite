import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClientArgs } from "../packages/host/src/client.js";
import type { EntryHead } from "../packages/host/src/evidence/entry-types.js";
import {
  applyBoardCommand,
  boardFocusOffset,
  boardKindFilter,
  createTeamBoardState,
  teamBoardText,
} from "../packages/host/src/team-watch-board.js";

const team = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "verifying",
  title: "Repair trace",
  objective: "Keep the repair trace honest.",
  revision: 2,
  goal: {
    successCriteria: "Checks pass on repaired commit",
    record: {
      criteria: [{ id: "c0", statement: "", check: "Tests pass", producer: "host" }],
    },
  },
  assessment: {
    result: "inconclusive",
    criteria: [{ id: "c0", state: "inconclusive" }],
  },
  tasks: [
    { id: "t1", title: "Fix gate", status: "integrated", criterionRefs: { objectiveVersion: 1, criteria: ["c0"] } },
  ],
  members: [
    { memberId: "m-impl", sessionId: "s-1", role: "implementer", revision: 2, status: "stopped", taskId: "t1" },
    { memberId: "m-int", sessionId: "s-2", role: "integrator", revision: 2, status: "running", taskId: "t1" },
  ],
  decisions: [
    { id: "q1", revision: 2, question: "Allow broader migration?", options: ["Yes", "No"] },
  ],
};

const entries: EntryHead[] = [
  {
    entryId: "e-check-fail",
    seq: 11,
    scope: "run",
    runId: team.id,
    revision: 2,
    at: "2026-11-26T01:00:00.000Z",
    kind: "check",
    author: "host",
    authority: "receipt",
    headCommit: "aaaaaaa111111111111111111111111111111111",
    paths: [],
    summary: "check failed (exit 1): npm test",
    bodyBytes: 256,
    state: "active",
  },
  {
    entryId: "e-report",
    seq: 24,
    scope: "run",
    runId: team.id,
    revision: 2,
    at: "2026-11-26T01:05:00.000Z",
    kind: "report",
    author: "member",
    authority: "claim",
    authorMemberId: "m-int",
    authorRole: "integrator",
    taskId: "t1",
    headCommit: "bbbbbbb222222222222222222222222222222222",
    paths: [],
    summary: "result: repaired test assertion",
    bodyBytes: 180,
    supersedes: "e-check-fail",
    state: "active",
  },
];

test("teamBoardText renders pinned decisions, overview, roster, entries, and detail pane", () => {
  let state = createTeamBoardState();
  const initial = teamBoardText(team, entries, state, null, "12:00:00", true, 100);
  assert.match(initial, /DECISIONS FOR YOU \(1\)/);
  assert.match(initial, /Allow broader migration\?/);
  assert.match(initial, /1\/1 tasks integrated · provisional: inconclusive/);
  assert.match(initial, /Active \(1\) Integrator running\(t1\) · Finished \(1\)/);
  assert.match(initial, /seq 11.*\[Host receipt\].*check.*aaaaaaa/);
  assert.match(initial, /> seq 24.*\[Agent claim\].*report.*Integrator.*t1.*bbbbbbb/);

  const opened = applyBoardCommand(state, "enter", entries);
  state = opened.state;
  assert.equal(state.detailOpen, true);
  assert.equal(opened.needDetail, "e-report");

  const withDetail = teamBoardText(
    team,
    entries,
    state,
    {
      head: entries[1]!,
      body: { report: { verdict: "approved", summary: "Repaired test assertion" }, headCommit: entries[1]!.headCommit },
    },
    "12:00:05",
    true,
    100,
  );
  assert.match(withDetail, /ENTRY DETAIL · seq 24 · e-report/);
  assert.match(withDetail, /Supersedes: e-check-fail/);
  assert.match(withDetail, /Verdict: approved/);
});

test("applyBoardCommand navigates entries, cycles kind filter on p, toggles follow on f, and jumps on o", () => {
  let state = createTeamBoardState();
  const jump = applyBoardCommand(state, "openMember", entries);
  assert.equal(jump.jumpToMemberId, "m-int");

  const up = applyBoardCommand(state, "up", entries);
  state = up.state;
  assert.equal(state.follow, false);
  assert.equal(state.selectedEntryId, "e-check-fail");

  const filtered = applyBoardCommand(state, "prev", entries);
  state = filtered.state;
  assert.equal(boardKindFilter(state), "check");
  const renderedFiltered = teamBoardText(team, entries, state, null, "", true, 100);
  assert.match(renderedFiltered, /BLACKBOARD ENTRIES \(1 of 2\) · filter check/);

  const followed = applyBoardCommand(state, "follow", entries);
  state = followed.state;
  assert.equal(state.follow, true);
});

test("boardFocusOffset scrolls selected entry and expanded detail into a 24-row viewport", () => {
  const many: EntryHead[] = Array.from({ length: 20 }, (_, index) => ({
    entryId: `e-${index + 1}`,
    seq: index + 1,
    scope: "run",
    runId: team.id,
    revision: 2,
    at: "2026-11-26T01:00:00.000Z",
    kind: "check",
    author: "host",
    authority: "receipt",
    paths: [],
    summary: `entry summary ${index + 1}`,
    bodyBytes: 100,
    state: "active",
  }));
  const state = createTeamBoardState();
  const card = teamBoardText(team, many, state, null, "12:00:00", true, 100);
  assert.match(card.split("\n").at(-1)!, /o member logs · l logs/);
  const offset = boardFocusOffset(card, 24, 100, 0, false);
  assert.ok(offset > 0, `expected non-zero scroll offset for bottom entry in 24-row viewport, got ${offset}`);

  const opened = applyBoardCommand(state, "enter", many).state;
  const withDetail = teamBoardText(
    team,
    many,
    opened,
    { head: many[many.length - 1]!, body: { status: "passed", output: "line 1\nline 2\nline 3" } },
    "12:00:00",
    true,
    100,
  );
  const detailOffset = boardFocusOffset(withDetail, 24, 100, 0, true);
  assert.ok(detailOffset >= offset, `expected detail offset ${detailOffset} >= ${offset}`);
});

test("parseClientArgs supports --board on team watch and rejects invalid combinations", () => {
  const parsed = parseClientArgs(["team", "watch", team.id, "--board"]);
  assert.equal(parsed.options["--board"], true);
  assert.throws(() => parseClientArgs(["team", "watch", team.id, "--board", "--logs"]), /either --board or --logs/);
  assert.throws(() => parseClientArgs(["team", "watch", team.id, "--board", "--json"]), /either --board or --json/);
  assert.throws(() => parseClientArgs(["list", "--board"]), /--board applies to infinite team watch/);
});

test("teamBoardText renders WAIT REASONS and annotates stalled and spinner-only roster members", () => {
  const waitingTeam = {
    ...team,
    members: [
      { memberId: "m-spin", sessionId: "s-1", role: "implementer", revision: 2, status: "running", taskId: "t1", spinnerOnlySince: "2026-11-26T01:02:00.000Z" },
      { memberId: "m-stall", sessionId: "s-2", role: "integrator", revision: 2, status: "running", taskId: "t2", stalledAt: "2026-11-26T01:04:00.000Z" },
    ],
    waitReasons: [
      { kind: "spinner-only", memberId: "m-spin", summary: "Spinner redraws without screen changes." },
      { kind: "worker-slot", taskId: "t3", summary: "Waiting for worker slot (2/2)." },
    ],
  };
  const rendered = teamBoardText(waitingTeam, entries, createTeamBoardState(), null, "12:00:00", true, 100);
  assert.match(rendered, /WAIT REASONS \(2\)/);
  assert.match(rendered, /\[spinner-only\] Spinner redraws without screen changes\./);
  assert.match(rendered, /\[worker-slot\] Waiting for worker slot \(2\/2\)\./);
  assert.match(rendered, /Implementer running\(t1\) \[spinner-only\]/);
  assert.match(rendered, /Integrator running\(t2\) \[stalled\]/);
});
