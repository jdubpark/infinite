import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHost } from "./helpers.js";
import { missionBoard } from "../packages/host/src/missions.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { TeamView } from "../packages/host/src/team-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { Config } from "../packages/host/src/types.js";

const projects: Config["projects"] = [{ id: "api", name: "API", path: "/srv/repos/api" }, { id: "web", name: "Web", path: "/srv/repos/web" }, { id: "docs", name: "Docs", path: "/srv/repos/docs" }];
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
      { id: "c", repoProjectId: "web", title: "Dropped", objective: "x", size: "solo", parallelism: 1, dependsOn: [], status: "cancelled" },
    ] }),
    mission("paused", 3, { reason: "Paused by the owner." }), mission("needs-input", 4, { decisions: [{ id: randomUUID(), question: "Ship on Friday?", options: [], createdAt: at(4) }] }),
    mission("blocked", 5, { reason: "The coordinator reported a blocker." }), mission("ready-for-review", 6, { result: { summary: "Both repositories are ready.", revision: 2, at: at(6) } }),
    mission("cancelled", 7),
  ];
  const teams = [subteam, cycle, asking, team("working", 7, { id: "unmapped-team", projectId: "docs", title: "Unmapped team" }), team("blocked", 8, { reason: "Checks failed." }), team("reviewing", 9), team("paused", 10), team("ready-for-review", 11),
    team("merged", 12), team("no-change", 13), team("cancelled", 14)];
  const goals = [goal("running", 15), goal("paused", 16), goal("needs-input", 17), goal("blocked", 18), goal("ready-for-review", 19),
    goal("no-opportunity", 20), goal("limit-reached", 21), goal("achieved", 22), goal("cancelled", 23)];
  const containing = (projectId: string) => ["api", "web"].includes(projectId) ? { id: "shop", name: "Shop" } : undefined;
  const { items } = missionBoard(missions, teams, goals, projects, containing);
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
  assert.equal(find("Team needs-input").projectName, "Shop");
  assert.equal(find("Team needs-input").groupId, "shop");
  assert.equal(find("Team blocked").detail, "Checks failed.");
  assert.equal(find("Team reviewing").projectName, "Shop");
  assert.equal(find("Team reviewing").groupId, "shop");
  assert.equal(find("Goal running").projectName, "Shop");
  assert.equal(find("Goal running").groupId, "shop");
  assert.equal(find("Unmapped team").projectName, "Docs");
  assert.ok(!Object.hasOwn(find("Unmapped team"), "groupId"));
});

test("a member stopped on a provider prompt moves its run, mission, or goal to needs-input, and an ended mission drops its open question", () => {
  const waiting = "A provider needs user input. Open the member session to respond; the team will not approve it.";
  const prompted = team("implementing", 1, { missionId: randomUUID(), reason: waiting });
  const standalone = team("implementing", 2, { reason: waiting });
  const goalRun = team("implementing", 3, { goal: { id: randomUUID() } as TeamView["goal"], reason: waiting });
  const finished = team("ready-for-review", 4, { reason: waiting });
  const open = [{ id: randomUUID(), question: "Ship on Friday?", options: [], createdAt: at(5) }];
  const missions = [
    mission("working", 5, { title: "Prompted", subtasks: [{ id: "a", repoProjectId: "api", title: "Endpoint", objective: "x", size: "solo", parallelism: 1, dependsOn: [], status: "running", teamId: prompted.id }] }),
    mission("cancelled", 6, { title: "Ended", reason: "Cancelled by the owner.", decisions: open,
      subtasks: [{ id: "b", repoProjectId: "web", title: "Client", objective: "x", size: "solo", parallelism: 1, dependsOn: [], status: "running", teamId: prompted.id }] }),
  ] as Mission[];
  const goals = [goal("running", 7, { title: "Prompted goal", activeTeamId: goalRun.id }), goal("cancelled", 8, { title: "Cancelled goal", activeTeamId: goalRun.id })];
  const { items } = missionBoard(missions, [prompted, standalone, goalRun, finished], goals, projects, () => undefined);
  const find = (title: string) => items.find(item => item.title === title)!;
  assert.equal(find("Prompted").column, "needs-input");
  assert.equal(find("Prompted").detail, `Subtask a: ${waiting}`);
  assert.equal(find(standalone.title).column, "needs-input");
  assert.equal(find(standalone.title).detail, waiting);
  assert.equal(find("Prompted goal").column, "needs-input");
  assert.equal(find(finished.title).column, "review", "A finished run no longer waits on a provider prompt");
  assert.equal(find("Ended").column, "ended", "A cancelled mission stays ended while its subteam's cancel is still cascading");
  assert.equal(find("Cancelled goal").column, "ended");
  assert.equal(find("Ended").detail, "Cancelled by the owner.", "An ended mission takes no answers, so its question is not its caption");
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

test("mission controls are owner-only and a create retry returns the recorded mission after its group is deleted", { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-mission-routes-")), repo = join(root, "repo"), receipts = join(root, "receipts");
  mkdirSync(repo); mkdirSync(receipts, { mode: 0o700 });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo, stdio: "ignore" });
  const strong = { provider: "claude" as const, model: "claude-opus-5-5", effort: "xhigh" as const, tier: "strong" as const };
  // The coordinator fixture holds until released, so the mission stays live while the routes are exercised.
  const host = await startHost({ config: {
    agents: { claude: { command: process.execPath, args: [resolve("tests/fixtures/mission-agent.mjs"), "mission", receipts, "claude"] } },
    projects: [{ id: "repo", name: "Repo", path: repo, team: { checks: [{ command: process.execPath, args: ["-e", "0"] }] } }],
    teams: { workspaceDir: join(root, "teams"), lineup: { coordinator: { id: "coordinator", label: "Coordinator", ...strong },
      implementers: [{ id: "light", label: "Light", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
      integrator: { id: "integrator", label: "Integrator", ...strong }, reviewer: { id: "reviewer", label: "Reviewer", ...strong } } },
  } });
  try {
    const group = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Shop", repos: ["repo"] });
    assert.equal(group.status, 200);
    const request = { requestId: randomUUID(), groupId: group.body.id, objective: "Add a feature" };
    const created = await host.fetchApi("/missions", "owner", request);
    assert.equal(created.status, 200);
    const id = created.body.id;
    const steer = { requestId: randomUUID(), revision: created.body.revision, text: "Keep it small" };
    assert.equal((await host.fetchApi(`/missions/${id}/steer`, "controller", steer)).status, 403);
    assert.equal((await host.fetchApi(`/missions/${id}/answer/${randomUUID()}`, "controller", steer)).status, 403);
    for (const action of ["pause", "resume", "cancel"])
      assert.equal((await host.fetchApi(`/missions/${id}/${action}`, "controller", { requestId: randomUUID(), revision: created.body.revision })).status, 403);
    assert.equal((await host.fetchApi(`/missions/${id}/steer`, "owner", steer)).status, 200);

    const removed = await host.fetchApi(`/project-groups/${group.body.id}`, "owner", { requestId: randomUUID(), revision: group.body.revision }, undefined, "DELETE");
    assert.equal(removed.status, 200);
    const replayed = await host.fetchApi("/missions", "owner", request);
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.id, id, "The retry returns the recorded mission instead of re-running admission");
    assert.equal((await host.fetchApi("/missions", "owner", { ...request, requestId: randomUUID() })).status, 404);
    assert.equal((await host.fetchApi(`/missions/${id}/cancel`, "owner", { requestId: randomUUID(), revision: replayed.body.revision })).status, 200);
  } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
});
