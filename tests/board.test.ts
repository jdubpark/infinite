import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startHost } from "./helpers.js";
import { missionBoard } from "../packages/host/src/missions.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { TeamView } from "../packages/host/src/team-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { Config } from "../packages/host/src/types.js";

const projects: Config["projects"] = [{ id: "api", name: "API", path: "/srv/repos/api" }, { id: "web", name: "Web", path: "/srv/repos/web" }];
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const mission = (status: Mission["status"], minute: number, extra: Partial<Mission> = {}) => ({
  id: randomUUID(), groupId: "shop", groupName: "Shop", repoProjectIds: ["api", "web"], title: `Mission ${status}`, objective: "Ship it", status,
  updatedAt: at(minute), subtasks: [], decisions: [], ...extra,
}) as unknown as Mission;
const team = (status: TeamView["status"], minute: number, extra: Partial<TeamView> = {}) => ({
  id: randomUUID(), projectId: "api", title: `Team ${status}`, status, revision: 1, updatedAt: at(minute), decisions: [], tasks: [], ...extra,
}) as unknown as TeamView;
const goal = (status: ProductGoal["status"], minute: number, extra: Partial<ProductGoal> = {}) => ({
  id: randomUUID(), projectId: "web", title: `Goal ${status}`, status, updatedAt: at(minute), cycles: [], ...extra,
}) as unknown as ProductGoal;

test("the board maps missions, standalone teams, and goals to columns and hides subteams and goal cycles", () => {
  const subteam = team("implementing", 50, { missionId: randomUUID() });
  const cycle = team("needs-input", 51, { goal: { id: randomUUID() } as TeamView["goal"] });
  const asking = team("needs-input", 3, { decisions: [{ id: randomUUID(), memberId: randomUUID(), revision: 1, question: "Which   format?\nPick one.", options: [], createdAt: at(3) }] });
  const missions = [
    mission("planning", 1), mission("working", 2, { subtasks: [
      { id: "a", repoProjectId: "api", title: "Endpoint", objective: "x", size: "solo", parallelism: 1, dependsOn: [], status: "running" },
      { id: "b", repoProjectId: "web", title: "Client", objective: "x", size: "solo", parallelism: 1, dependsOn: ["a"], status: "done" },
    ] }),
    mission("paused", 3, { reason: "Paused by the owner." }), mission("needs-input", 4, { decisions: [{ id: randomUUID(), question: "Ship on Friday?", options: [], createdAt: at(4) }] }),
    mission("blocked", 5, { reason: "The coordinator reported a blocker." }), mission("ready-for-review", 6, { result: { summary: "Both repositories are ready.", revision: 2, at: at(6) } }),
    mission("cancelled", 7),
  ];
  const teams = [subteam, cycle, asking, team("blocked", 8, { reason: "Checks failed." }), team("reviewing", 9), team("paused", 10), team("ready-for-review", 11),
    team("merged", 12), team("no-change", 13), team("cancelled", 14)];
  const goals = [goal("running", 15), goal("paused", 16), goal("needs-input", 17), goal("blocked", 18), goal("ready-for-review", 19),
    goal("no-opportunity", 20), goal("limit-reached", 21), goal("achieved", 22), goal("cancelled", 23)];
  const { items } = missionBoard(missions, teams, goals, projects);
  const column = (kind: string, status: string) => items.filter(item => item.kind === kind && item.status === status).map(item => item.column);

  assert.equal(items.length, missions.length + teams.length - 2 + goals.length);
  assert.ok(!items.some(item => item.id === subteam.id || item.id === cycle.id), "Subteams appear only inside their mission; goal cycles only through their goal");
  assert.deepEqual(["planning", "working", "paused", "needs-input", "blocked", "ready-for-review", "cancelled"].map(status => column("mission", status)),
    [["working"], ["working"], ["working"], ["needs-input"], ["needs-input"], ["review"], ["ended"]]);
  assert.deepEqual(["needs-input", "blocked", "reviewing", "paused", "ready-for-review", "merged", "no-change", "cancelled"].map(status => column("team", status)),
    [["needs-input"], ["needs-input"], ["working"], ["working"], ["review"], ["ended"], ["ended"], ["ended"]]);
  assert.deepEqual(["running", "paused", "needs-input", "blocked", "ready-for-review", "no-opportunity", "limit-reached", "achieved", "cancelled"].map(status => column("goal", status)),
    [["working"], ["working"], ["needs-input"], ["needs-input"], ["review"], ["ended"], ["ended"], ["ended"], ["ended"]]);

  const order = ["needs-input", "working", "review", "ended"];
  for (let index = 1; index < items.length; index++) {
    const previous = items[index - 1], current = items[index];
    const byColumn = order.indexOf(previous.column) - order.indexOf(current.column);
    assert.ok(byColumn < 0 || (byColumn === 0 && previous.updatedAt >= current.updatedAt), "Rows are grouped by column and newest-updated first");
  }
  const find = (title: string) => items.find(item => item.title === title)!;
  assert.equal(find("Mission needs-input").detail, "Ship on Friday?");
  assert.equal(find("Mission blocked").detail, "The coordinator reported a blocker.");
  assert.equal(find("Mission working").detail, "Running: Endpoint. 1 of 2 subtasks done");
  assert.deepEqual(find("Mission working").subtasks, { total: 2, running: 1, done: 1 });
  assert.equal(find("Mission working").projectName, "Shop");
  assert.equal(find("Mission working").groupId, "shop");
  assert.equal(find("Team needs-input").detail, "Which format? Pick one.");
  assert.equal(find("Team blocked").detail, "Checks failed.");
  assert.equal(find("Team reviewing").projectName, "API");
  assert.equal(find("Goal running").projectName, "Web");
});

test("the board and mission routes enforce roles and report an unconfigured host", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const board = await host.fetchApi("/board", "viewer");
    assert.equal(board.status, 200);
    assert.deepEqual(board.body, { items: [] });
    const request = { requestId: randomUUID(), groupId: "rehearsal", objective: "Add a feature" };
    assert.equal((await host.fetchApi("/missions", "controller", request)).status, 403);
    const refused = await host.fetchApi("/missions", "owner", request);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "missions-not-configured");
    assert.deepEqual((await host.fetchApi("/missions")).body, { missions: [] });
  } finally { await host.stop(); }
});
