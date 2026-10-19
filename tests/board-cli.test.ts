import assert from "node:assert/strict";
import test from "node:test";
import { boardLines, resolveMissionProject } from "../packages/host/src/board-cli.js";
import type { Board } from "../packages/host/src/mission-types.js";
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
