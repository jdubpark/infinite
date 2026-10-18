import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseTeamBrief, orderedTeamMembers, teamLogsText, teamMonitorText, teamSummaryText, teamWatchCommand, teamWatchFrame, teamWatchScreen, visibleScreen, wrapText } from "../packages/host/src/team-watch.ts";
import { chooseBrief, monitorMembers, summarySessionId, type BriefingView } from "../apps/web/src/team-monitor.ts";
import { chooseBrief as choosePhoneBrief, orderedMembers, plainScreen } from "../apps/mobile/src/features/teams/summary.ts";

const team = {
  id: "team-1",
  status: "planning",
  title: "Smart alarm",
  projectId: "workspace",
  workspace: "/work/integration",
  branch: "infinite/team-1",
  revision: 2,
  reason: "Still planning",
  members: [
    { memberId: "old", sessionId: "s-old", role: "project-manager", revision: 1, title: "First plan", status: "stopped", stoppedReason: "hour limit" },
    { memberId: "pm", sessionId: "s-pm", role: "project-manager", revision: 2, title: "Second plan", status: "running" },
    { memberId: "impl", sessionId: "s-impl", role: "implementer", revision: 2, title: "Alarm stop", status: "waiting", taskId: "task-1" },
  ],
  tasks: [{ status: "pending" }, { status: "running" }],
  decisions: [{ id: "q1", question: "Which signal means awake?", answer: undefined }],
  events: [{ text: "Coordinator started the fresh plan" }],
};

test("the watch card shows current members and stays stable when nothing changed", () => {
  const first = teamMonitorText(team);
  assert.match(first, /Coordinator {2}running {2}Second plan/);
  assert.match(first, /Implementer {2}waiting {2}Alarm stop · task-1/);
  assert.doesNotMatch(first, /First plan/);
  assert.match(first, /Tasks {2}1 pending · 1 running/);
  assert.match(first, /Which signal means awake/);
  assert.equal(teamWatchFrame(first, teamMonitorText(team), false), null);
  assert.equal(teamWatchFrame(first, teamMonitorText({ ...team, status: "implementing" }), false)?.includes("implementing"), true);
  assert.equal(teamWatchFrame(first, first, true)?.startsWith("\x1b[H\x1b[J"), true);
});

test("the team summary prefers the coordinator brief and lists the live member first", () => {
  const members = team.members;
  assert.equal(monitorMembers(members, 2)[0].memberId, "pm");
  assert.equal(orderedTeamMembers(team)[0].memberId, "pm");
  assert.equal(orderedMembers(members, 2)[0].memberId, "pm");
  assert.equal(summarySessionId(members, 2), "s-pm");
  const ready: BriefingView = { state: "ready", summary: { engine: "jevcode", text: "flat", at: "2026-10-18T00:00:00.000Z", repository: { generatedAt: "2026-10-18T00:00:00.000Z", brief: { summary: "Coordinator brief" } } } };
  const newer: BriefingView = { state: "ready", summary: { text: "Implementer brief", at: "2026-10-18T01:00:00.000Z" } };
  const pending: BriefingView = { state: "pending" };
  const rows = [{ sessionId: "s-pm", status: ready }, { sessionId: "s-impl", status: newer }];
  assert.equal(chooseBrief(rows, "s-pm")?.status.summary?.repository?.brief?.summary, "Coordinator brief");
  assert.equal(chooseTeamBrief(rows, "s-pm")?.status.summary?.repository?.brief?.summary, "Coordinator brief");
  assert.equal(choosePhoneBrief(rows, "s-pm")?.status.summary?.repository?.brief?.summary, "Coordinator brief");
  assert.equal(chooseBrief([{ sessionId: "s-pm", status: pending }, { sessionId: "s-impl", status: newer }], "s-pm")?.sessionId, "s-impl");
  assert.equal(chooseTeamBrief([{ sessionId: "s-pm", status: pending }, { sessionId: "s-impl", status: newer }], "s-pm")?.sessionId, "s-impl");
  assert.equal(choosePhoneBrief([{ sessionId: "s-pm", status: pending }, { sessionId: "s-impl", status: newer }], "s-pm")?.sessionId, "s-impl");
  assert.equal(chooseBrief([{ sessionId: "s-pm", status: pending }], "s-pm")?.status.state, "pending");
});

test("the summary card reads the coordinator brief and the log card returns to it", () => {
  const detailed = {
    ...team,
    objective: "Stop the alarm once the person is up and moving.",
    decisions: [
      { id: "q1", question: "Which signal means awake?", answer: undefined, revision: 2 },
      { id: "old", question: "Keep the first plan?", answer: undefined, revision: 1 },
    ],
  };
  const ready: BriefingView = { state: "ready", summary: { engine: "jevcode", text: "flat", at: "2026-10-18T00:00:00.000Z", repository: { generatedAt: "2026-10-18T00:00:00.000Z", brief: {
    summary: "Coordinator brief",
    architecture: [{ text: "The scheduler owns the alarm" }],
    review: [{ priority: "high", area: "alarm gate", why: "It decides when the alarm stops", question: "Does rolling over count?" }],
    changes: [{ text: "Alarm stop waits for movement" }],
    unknowns: ["No device run is recorded"],
  } } } };
  const newer: BriefingView = { state: "ready", summary: { text: "Implementer brief", at: "2026-10-18T01:00:00.000Z" } };
  const summary = teamSummaryText(detailed, [{ sessionId: "s-pm", status: ready }, { sessionId: "s-impl", status: newer }], "", true);
  assert.match(summary, /Stop the alarm once the person is up and moving/);
  assert.match(summary, /Coordinator brief/);
  assert.match(summary, /Alarm stop waits for movement/);
  assert.match(summary, /not completion or approval/);
  assert.doesNotMatch(summary, /Implementer brief/);
  assert.doesNotMatch(summary, /Keep the first plan/);
  // The person's open decision comes before the brief, with the command that answers it.
  assert.ok(summary.indexOf("Which signal means awake") < summary.indexOf("Coordinator brief"));
  assert.match(summary, /infinite team answer team-1 q1 "YOUR ANSWER"/);
  // Sections follow the briefing contract: outcome, system shape, ranked review questions, changes, gaps.
  const order = ["Coordinator brief", "SYSTEM SHAPE", "REVIEW FIRST", "WHAT CHANGED", "GAPS AND UNKNOWNS"].map(text => summary.indexOf(text));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(!order.includes(-1));
  assert.match(summary, /1\. \[high\] alarm gate\n\s+It decides when the alarm stops\n\s+Ask: Does rolling over count\?/);
  assert.match(summary.split("\n").at(-1)!, /^l logs · q quit$/);
  assert.match(teamSummaryText(detailed, [{ sessionId: "s-pm", status: ready }]).split("\n").at(-1)!, /infinite team status team-1 --logs/);
  const empty = teamSummaryText(detailed, [{ sessionId: "s-pm", status: { state: "empty" } }], "", true);
  assert.match(empty, /Press a to ask Jevcode/);
  assert.match(empty.split("\n").at(-1)!, /a ask Jevcode/);
  assert.doesNotMatch(teamSummaryText(detailed, [{ sessionId: "s-pm", status: { state: "pending" } }], "", true), /ask Jevcode/);
  const screen = "\u001b[32mplanning the stop\u001b[0m\nnext step";
  assert.match(visibleScreen(screen), /planning the stop\nnext step/);
  assert.equal(plainScreen(screen), "planning the stop\nnext step");
  assert.doesNotMatch(visibleScreen(screen), /32m/);
  const agents = orderedTeamMembers(detailed).filter(member => member.sessionId);
  const logs = teamLogsText(detailed, agents, detailed.members[1], screen, [{ at: "10:00", text: "Coordinator started" }], "", true);
  assert.match(logs, /review logs · agent 1 of 3/);
  assert.match(logs, /\[Coordinator running\]/);
  assert.match(logs, /Implementer waiting/);
  assert.match(logs, /Coordinator stopped r1/);
  assert.match(logs, /planning the stop/);
  assert.match(logs.split("\n").at(-1)!, /^←→ agent · s summary · q quit$/);
});

test("watch keys switch views and agents, scroll, and detach", () => {
  assert.equal(teamWatchCommand("l"), "logs");
  assert.equal(teamWatchCommand("b"), "summary");
  assert.equal(teamWatchCommand("s"), "summary");
  assert.equal(teamWatchCommand("n"), "next");
  assert.equal(teamWatchCommand("p"), "prev");
  assert.equal(teamWatchCommand("\u001b[C"), "next");
  assert.equal(teamWatchCommand("\u001b[D"), "prev");
  assert.equal(teamWatchCommand("\u001b[A"), "up");
  assert.equal(teamWatchCommand("\u001b[B"), "down");
  assert.equal(teamWatchCommand("j"), "down");
  assert.equal(teamWatchCommand(" "), "pageDown");
  assert.equal(teamWatchCommand("\u001b[5~"), "pageUp");
  assert.equal(teamWatchCommand("\u001b[H"), "top");
  assert.equal(teamWatchCommand("G"), "bottom");
  assert.equal(teamWatchCommand("a"), "ask");
  assert.equal(teamWatchCommand("q"), "detach");
  assert.equal(teamWatchCommand("\u0003ln"), "detach");
  assert.equal(teamWatchCommand("ln"), "next");
  // The final byte of an escape sequence is not read as a separate key.
  assert.equal(teamWatchCommand("l\u001bOB"), "down");
  assert.equal(teamWatchCommand("x"), null);
});

test("a full-screen frame wraps the card, scrolls its body, and pins the key bar", () => {
  assert.deepEqual(wrapText("  • one two three four five six", 20), ["  • one two three", "    four five six"]);
  assert.deepEqual(wrapText("short", 20), ["short"]);
  const card = [...Array.from({ length: 30 }, (_, index) => `line ${index + 1}`), "", "l logs · q quit"].join("\n");
  const visible = (frame: string) => frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
  const top = teamWatchScreen(card, { rows: 10, columns: 40, offset: 0, color: false });
  const lines = visible(top.frame);
  assert.equal(lines.length, 10);
  assert.equal(lines[0], "line 1");
  assert.equal(lines.at(-1), "l logs · q quit · ↑↓ scroll 1-8 of 30");
  const end = teamWatchScreen(card, { rows: 10, columns: 40, offset: 999, color: false });
  assert.equal(end.offset, 22);
  assert.equal(visible(end.frame)[0], "line 23");
  assert.doesNotMatch(visible(teamWatchScreen("one\n\nl logs", { rows: 10, columns: 40, offset: 0, color: false }).frame).at(-1)!, /scroll/);
});
