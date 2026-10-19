import assert from "node:assert/strict";
import test from "node:test";
import {
  appendBoardComposer, answerPinnedMissionDecision, boardItemIdentity, boardLines,
  createBoardInputParser, MissionSubmitter, orderedBoardItems, parseBoardInputChunk, pinOpenMissionDecision,
  reconcileBoardCursor, resolveMissionProject,
} from "../packages/host/src/board-cli.js";
import type { Board, Mission } from "../packages/host/src/mission-types.js";
import type { ProjectGroup, ProjectGroupList } from "../packages/host/src/project-group-types.js";

const project = (id: string, name: string, implicit = false): ProjectGroup => ({
  id, name, repos: [{ projectId: implicit ? id : `${id}-repo`, name: `${name} repo`, path: "repo" }],
  implicit, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});
const projects: ProjectGroupList = { groups: [project("product", "Product"), project("docs", "Docs", true)], suggestions: [] };
const board: Board = { items: [
  { kind: "mission", id: "m1", title: "A long mission title that should be shortened", groupId: "product", projectName: "Product", column: "needs-input", status: "needs-input", detail: "Waiting for a decision", updatedAt: "2026-10-19T00:00:00.000Z", subtasks: { total: 3, running: 1, done: 1 } },
  { kind: "team", id: "t1", title: "Implement feature", projectName: "Docs", column: "working", status: "working", detail: "Writing code", updatedAt: "2026-10-19T00:00:00.000Z" },
  { kind: "mission", id: "m2", title: "Review change", groupId: "product", projectName: "Product", column: "review", status: "ready-for-review", detail: "Finished", updatedAt: "2026-10-19T00:00:00.000Z" },
  { kind: "team", id: "t2", title: "Merged work", projectName: "Docs", column: "ended", status: "merged", detail: "Merged", updatedAt: "2026-10-19T00:00:00.000Z" },
] };

const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

test("board rendering groups columns, collapses ended rows, and shows the targeted composer", () => {
  const output = plain(boardLines(board, projects.groups, 0, "product", "", 80, Date.parse("2026-10-19T00:00:00.000Z")));
  assert.ok(output.indexOf("Needs input") < output.indexOf("Working"));
  assert.ok(output.indexOf("Working") < output.indexOf("Ready for review"));
  assert.match(output, /Ended 1 \(collapsed\)/);
  assert.match(output, /Project: Product/);
  assert.match(output, /❯ describe a task for a new mission/);
  assert.match(output, /Waiting for a …/);
});

test("mission rows show dim subtask progress and align ages to the terminal edge", () => {
  const width = 48;
  const rendered = boardLines(board, projects.groups, 0, "product", "", width, Date.parse("2026-10-19T00:00:00.000Z"));
  const output = plain(rendered);
  assert.ok(rendered.some(line => line.includes("\x1b[2m1/3\x1b[0m")));

  const rows = output.split("\n").filter(line => /A long mission|Implement feature|Review change/.test(line));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.length, width);
    assert.ok(row.endsWith("now"));
  }
  assert.match(rows[0]!, /1\/3/);
  assert.doesNotMatch(rows[1]!, /\d+\/\d+/);
});

test("board rendering truncates rows at narrow widths and handles empty sections", () => {
  const onlyWorking: Board = { items: board.items.filter(item => item.column === "working") };
  const output = plain(boardLines(onlyWorking, projects.groups, 0, "docs", "Draft", 28, Date.parse("2026-10-19T00:00:00.000Z")));
  const row = output.split("\n").find(line => line.includes("Implement"));
  assert.ok(row);
  assert.equal(row.length, 28);
  assert.ok(row.endsWith("now"));
  assert.match(row, /…/);
  assert.equal((output.match(/Nothing here/g) ?? []).length, 2);
  assert.match(output, /Ended 0 \(collapsed\)/);
  assert.match(output, /❯ Draft/);
  assert.match(output, /Project: Docs/);
});

test("mission project resolves through the current Git-root binding", () => {
  let boundDirectory = "";
  const selected = resolveMissionProject(projects, undefined, "/checkout/repo", directory => {
    boundDirectory = directory;
    return "product-repo";
  });
  assert.equal(boundDirectory, "/checkout/repo");
  assert.equal(selected.id, "product");
  assert.equal(resolveMissionProject(projects, "docs", "/unused", () => undefined).implicit, true);
  assert.throws(() => resolveMissionProject(projects, undefined, "/checkout/unbound", () => undefined), /No repository project is bound/);
});

test("mission submission retries the same request after an uncertain response and ignores a double submit", async () => {
  const calls: { path: string; body: unknown }[] = [];
  let resolveFirst!: (value: Mission) => void;
  const accepted = { id: "mission-1" } as Mission;
  const api = {
    json: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      if (calls.length === 1) return await new Promise<Mission>(resolve => { resolveFirst = resolve; });
      return accepted;
    },
  };
  const submitter = new MissionSubmitter(api as never);
  const first = submitter.submit("product", "Fix the board");
  assert.deepEqual(await submitter.submit("product", "Fix the board"), { kind: "in-flight" });
  assert.equal(calls.length, 1);
  resolveFirst(accepted);
  assert.deepEqual(await first, { kind: "started", mission: accepted });

  const retryCalls: { path: string; body: unknown }[] = [];
  let attempt = 0;
  const retryApi = {
    json: async (path: string, body?: unknown) => {
      retryCalls.push({ path, body });
      if (attempt++ === 0) throw Object.assign(new Error("socket closed"), { status: 503 });
      return accepted;
    },
  };
  const retry = new MissionSubmitter(retryApi as never);
  assert.deepEqual(await retry.submit("product", "Fix the board"), { kind: "uncertain" });
  assert.equal(retry.hasPending, true);
  assert.deepEqual(await retry.submit("product", "Different composer text"), { kind: "started", mission: accepted });
  assert.deepEqual(retryCalls[1], retryCalls[0]);
  assert.equal((retryCalls[0]!.body as { requestId: string }).requestId, (retryCalls[1]!.body as { requestId: string }).requestId);
  assert.equal(retry.hasPending, false);

  const refusal = new MissionSubmitter({ json: async (_path: string, body?: unknown) => {
    assert.equal((body as { objective: string }).objective, "Invalid request");
    throw Object.assign(new Error("Validation refused"), { status: 422 });
  } } as never);
  assert.deepEqual(await refusal.submit("product", "Invalid request"), { kind: "refused", message: "Validation refused" });
  assert.equal(refusal.hasPending, false);
});

const mission = (revision: number, decisions: Mission["decisions"]): Mission => ({
  id: "mission-1", groupId: "product", groupName: "Product", repoProjectIds: ["product-repo"],
  title: "A mission", objective: "Do work", maxSubtasks: 8, maxMinutes: 240,
  deadlineAt: "2026-10-20T00:00:00.000Z", revision, status: "needs-input",
  createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z",
  lineup: {} as Mission["lineup"], subtasks: [], decisions, steering: [], events: [],
});
const decision = (id: string, answer?: string): Mission["decisions"][number] => ({
  id, question: `Question ${id}`, options: [], createdAt: "2026-10-19T00:00:00.000Z", ...(answer ? { answer } : {}),
});

test("answer submission stays pinned to the decision and revision observed when answer mode starts", async () => {
  const observed = mission(7, [decision("decision-a"), decision("decision-b")]);
  const pin = pinOpenMissionDecision(observed);
  assert.deepEqual(pin, { missionId: "mission-1", decisionId: "decision-a", revision: 7 });
  const calls: { path: string; body?: unknown }[] = [];
  const latest = mission(9, [decision("decision-b"), decision("decision-a")]);
  const api = {
    json: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      return path === "/missions/mission-1" ? latest : undefined;
    },
  };
  assert.equal(await answerPinnedMissionDecision(api as never, pin!, "My answer"), "answered");
  assert.deepEqual(calls[1], {
    path: "/missions/mission-1/answer/decision-a",
    body: { requestId: (calls[1]!.body as { requestId: string }).requestId, revision: 7, text: "My answer" },
  });
  assert.equal(typeof (calls[1]!.body as { requestId: string }).requestId, "string");

  const staleApi = { json: async (path: string) => path === "/missions/mission-1" ? mission(10, [decision("decision-a", "already answered")]) : undefined };
  assert.equal(await answerPinnedMissionDecision(staleApi as never, pin!, "Too late"), "stale");
  const changedRowCalls: string[] = [];
  const changedRowApi = { json: async (path: string) => { changedRowCalls.push(path); return latest; } };
  assert.equal(await answerPinnedMissionDecision(changedRowApi as never, pin!, "Moved", () => false), "stale");
  assert.deepEqual(changedRowCalls, ["/missions/mission-1"]);
});

test("selection follows its item across board reordering and uses rendered section order", () => {
  const first: Board = { items: [board.items[1]!, board.items[0]!, { ...board.items[0]!, id: "m3", title: "Another mission" }] };
  const rows = orderedBoardItems(first);
  const selected = rows[1]!;
  assert.equal(selected.id, "m3");
  const reordered: Board = { items: [first.items[2]!, first.items[0]!, first.items[1]!] };
  const cursor = reconcileBoardCursor(reordered, selected, 1);
  assert.equal(boardItemIdentity(orderedBoardItems(reordered)[cursor]), "mission:m3");
  const rendered = boardLines(reordered, projects.groups, cursor, "product", "", 48, Date.parse("2026-10-19T00:00:00.000Z"));
  assert.ok(rendered.some(line => line.startsWith("\x1b[7m") && line.includes("Another mission")));
});

test("pasted input chunks append printable text and turn embedded newlines into spaces", () => {
  const tokens = parseBoardInputChunk("\u001b[200~first line\r\nsecond line\u001b[201~");
  assert.deepEqual(tokens, [{ type: "text", text: "first line second line", pasted: true }]);
  const composer = tokens.reduce((value, token) => token.type === "text" ? appendBoardComposer(value, token.text) : value, "");
  assert.equal(composer, "first line second line");
  assert.deepEqual(parseBoardInputChunk("\u001b[Axyz"), [
    { type: "key", key: "up" }, { type: "text", text: "xyz", pasted: false },
  ]);
  assert.deepEqual(parseBoardInputChunk("\u001b[200~q\u001b[201~"), [{ type: "text", text: "q", pasted: true }]);

  const parse = createBoardInputParser();
  assert.deepEqual(parse("\u001b[200~first"), [{ type: "text", text: "first", pasted: true }]);
  assert.deepEqual(parse("\r"), [{ type: "text", text: " ", pasted: true }]);
  assert.deepEqual(parse("second\u001b[201~"), [{ type: "text", text: "second", pasted: true }]);
  assert.deepEqual(parse("\u001b["), []);
  assert.deepEqual(parse("A"), [{ type: "key", key: "up" }]);
});
