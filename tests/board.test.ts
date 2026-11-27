import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHost } from "./helpers.js";
import { missionBoard } from "../packages/host/src/missions.js";
import { boardItemSchema, type Mission } from "../packages/host/src/mission-types.js";
import { ProjectGroupService } from "../packages/host/src/project-groups.js";
import type { TeamView } from "../packages/host/src/team-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { Config } from "../packages/host/src/types.js";

const projects: Config["projects"] = [{ id: "api", name: "API", path: "/srv/repos/api" }, { id: "web", name: "Web", path: "/srv/repos/web" }, { id: "docs", name: "Docs", path: "/srv/repos/docs" }];
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const mission = (status: Mission["status"], minute: number, extra: Partial<Mission> = {}) => ({
  id: randomUUID(), groupId: "shop", groupName: "Shop", repoProjectIds: ["api", "web"], title: `Mission ${status}`, objective: "Ship it", status,
  createdAt: at(minute), updatedAt: at(minute), subtasks: [], decisions: [], ...extra,
}) as unknown as Mission;
const team = (status: TeamView["status"], minute: number, extra: Partial<TeamView> = {}) => ({
  id: randomUUID(), projectId: "api", title: `Team ${status}`, status, revision: 1, createdAt: at(minute), updatedAt: at(minute), decisions: [], tasks: [], ...extra,
}) as unknown as TeamView;
const goal = (status: ProductGoal["status"], minute: number, extra: Partial<ProductGoal> = {}) => ({
  id: randomUUID(), projectId: "web", title: `Goal ${status}`, status, createdAt: at(minute), updatedAt: at(minute), cycles: [], ...extra,
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
  const legacy = mission("working", 30, { groupId: "api", groupName: "API", repoProjectIds: ["api"], title: "Legacy mission" });
  const legacyRow = missionBoard([legacy], [], [], projects, containing).items[0]!;
  assert.equal(legacyRow.groupId, "shop");
  assert.equal(legacyRow.projectName, "Shop");
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
  assert.equal(find("Mission working").detail, "Running: Endpoint");
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
  assert.equal(find("Unmapped team").groupId, "unmapped:project:docs");
  for (const row of items) assert.equal(boardItemSchema.safeParse(row).success, true, `board item ${row.id} matches schema`);
});

test("mission and team board details emit clean structured status without redundant subtask count suffixes", () => {
  const subtask = (id: string, title: string, status: Mission["subtasks"][number]["status"]) => ({
    id, repoProjectId: "api", title, objective: "x", size: "solo" as const, parallelism: 1, dependsOn: [], status,
  });
  const missions = [
    mission("planning", 1, { title: "Zero subtasks", subtasks: [] }),
    mission("working", 2, { title: "Only cancelled", subtasks: [subtask("c", "Dropped", "cancelled")] }),
    mission("working", 3, { title: "One running", subtasks: [subtask("a", "API", "running")] }),
    mission("working", 4, { title: "Two running", subtasks: [subtask("a", "API", "running"), subtask("b", "Web", "running")] }),
    mission("working", 5, { title: "One queued", subtasks: [subtask("a", "API", "queued")] }),
    mission("working", 6, { title: "One done", subtasks: [subtask("a", "API", "done")] }),
    mission("working", 7, { title: "Mixed idle", subtasks: [subtask("a", "API", "done"), subtask("b", "Web", "queued"), subtask("c", "Docs", "queued")] }),
    mission("ready-for-review", 8, { title: "Ready", result: { summary: "All checks pass.", revision: 1, at: at(8) }, subtasks: [subtask("a", "API", "done")] }),
    mission("paused", 9, { title: "Paused", reason: "Paused by owner.", subtasks: [subtask("a", "API", "running")] }),
    mission("blocked", 10, { title: "Blocked", reason: "Missing secret.", subtasks: [subtask("a", "API", "blocked")] }),
    mission("cancelled", 11, { title: "Cancelled", reason: "No longer needed.", subtasks: [subtask("a", "API", "cancelled")] }),
  ];
  const task = (id: string, status: TeamView["tasks"][number]["status"]) => ({
    id, title: id, instructions: "do", paths: ["a.ts"], dependsOn: [], revision: 1, status,
  });
  const teams = [
    team("implementing", 12, { title: "Team zero tasks", tasks: [] }),
    team("implementing", 13, { title: "Team one task pending", tasks: [task("a", "running")] }),
    team("implementing", 14, { title: "Team one task integrated", tasks: [task("a", "integrated")] }),
    team("implementing", 15, { title: "Team multiple tasks", tasks: [task("a", "integrated"), task("b", "running")] }),
    team("verifying", 16, { title: "Team verifying", tasks: [task("a", "integrated")] }),
  ];
  const { items } = missionBoard(missions, teams, [], projects, () => undefined);
  const byTitle = new Map(items.map(item => [item.title, item]));

  assert.equal(byTitle.get("Zero subtasks")!.detail, "Planning subtasks");
  assert.deepEqual(byTitle.get("Zero subtasks")!.subtasks, { total: 0, running: 0, done: 0 });
  assert.equal(byTitle.get("Only cancelled")!.detail, "Planning subtasks");
  assert.deepEqual(byTitle.get("Only cancelled")!.subtasks, { total: 0, running: 0, done: 0 });
  assert.equal(byTitle.get("One running")!.detail, "Running: API");
  assert.deepEqual(byTitle.get("One running")!.subtasks, { total: 1, running: 1, done: 0 });
  assert.equal(byTitle.get("Two running")!.detail, "Running: API, Web");
  assert.deepEqual(byTitle.get("Two running")!.subtasks, { total: 2, running: 2, done: 0 });
  assert.equal(byTitle.get("One queued")!.detail, "");
  assert.deepEqual(byTitle.get("One queued")!.subtasks, { total: 1, running: 0, done: 0 });
  assert.equal(byTitle.get("One done")!.detail, "");
  assert.deepEqual(byTitle.get("One done")!.subtasks, { total: 1, running: 0, done: 1 });
  assert.equal(byTitle.get("Mixed idle")!.detail, "");
  assert.deepEqual(byTitle.get("Mixed idle")!.subtasks, { total: 3, running: 0, done: 1 });
  assert.equal(byTitle.get("Ready")!.detail, "All checks pass.");
  assert.equal(byTitle.get("Paused")!.detail, "Paused by owner.");
  assert.equal(byTitle.get("Blocked")!.detail, "Missing secret.");
  assert.equal(byTitle.get("Cancelled")!.detail, "No longer needed.");
  assert.equal(byTitle.get("Team zero tasks")!.detail, "Implementing");
  assert.equal(byTitle.get("Team one task pending")!.detail, "Implementing: 0 of 1 task integrated");
  assert.equal(byTitle.get("Team one task integrated")!.detail, "Implementing: 1 of 1 task integrated");
  assert.equal(byTitle.get("Team multiple tasks")!.detail, "Implementing: 1 of 2 tasks integrated");
  assert.equal(byTitle.get("Team verifying")!.detail, "Running checks");
  for (const row of items) {
    assert.doesNotMatch(row.detail, /\d+ of \d+ subtasks? done/);
    assert.equal(boardItemSchema.safeParse(row).success, true);
  }
});

test("every board item carries a canonical groupId matching project groups even when distinct projects share a display name", () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-board-groups-"));
  const eastPath = join(root, "east"), westPath = join(root, "west");
  mkdirSync(eastPath); mkdirSync(westPath);
  try {
    const duplicateProjects: Config["projects"] = [
      { id: "app-east", name: "App", path: eastPath },
      { id: "app-west", name: "App", path: westPath },
    ];
    const groups = new ProjectGroupService({ stateDir: join(root, "state"), projects: duplicateProjects } as Config, randomBytes(32));
    const listed = groups.list().groups;
    assert.deepEqual(listed.map(group => ({ id: group.id, name: group.name })), [
      { id: "app-east", name: "App" },
      { id: "app-west", name: "App" },
    ]);
    const memberships = groups.membershipSnapshot();
    const { items } = missionBoard(
      [
        mission("working", 1, { id: "m-east", title: "East mission", groupId: "app-east", groupName: "App", repoProjectIds: ["app-east"] }),
        mission("working", 2, { id: "m-west", title: "West mission", groupId: "app-west", groupName: "App", repoProjectIds: ["app-west"] }),
      ],
      [
        team("implementing", 3, { id: "t-east", projectId: "app-east", title: "East team" }),
        team("implementing", 4, { id: "t-west", projectId: "app-west", title: "West team" }),
        team("implementing", 5, { id: "t-retired", projectId: "retired-repo", title: "Retired team" }),
      ],
      [
        goal("running", 6, { id: "g-east", projectId: "app-east", title: "East goal" }),
        goal("running", 7, { id: "g-west", projectId: "app-west", title: "West goal" }),
        goal("running", 8, { id: "g-retired", projectId: "retired-repo", title: "Retired goal" }),
      ],
      duplicateProjects,
      id => memberships.get(id),
    );

    const groupIds = new Set(listed.map(group => group.id));
    const byId = new Map(items.map(item => [item.id, item]));
    for (const id of ["m-east", "t-east", "g-east"]) {
      assert.equal(byId.get(id)!.groupId, "app-east");
      assert.equal(byId.get(id)!.projectName, "App");
      assert.ok(groupIds.has(byId.get(id)!.groupId));
    }
    for (const id of ["m-west", "t-west", "g-west"]) {
      assert.equal(byId.get(id)!.groupId, "app-west");
      assert.equal(byId.get(id)!.projectName, "App");
      assert.ok(groupIds.has(byId.get(id)!.groupId));
    }
    assert.equal(byId.get("t-retired")!.groupId, "unmapped:project:retired-repo");
    assert.equal(byId.get("g-retired")!.groupId, "unmapped:project:retired-repo");
    assert.deepEqual(items.filter(item => item.groupId === "app-east").map(item => item.id).sort(), ["g-east", "m-east", "t-east"]);
    assert.deepEqual(items.filter(item => item.groupId === "app-west").map(item => item.id).sort(), ["g-west", "m-west", "t-west"]);
    for (const row of items) assert.equal(boardItemSchema.safeParse(row).success, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retired projects stay in a disjoint unmapped groupId namespace and never leak into a new group that recycles the slug", () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-board-recycled-slug-"));
  const billingPath = join(root, "billing");
  mkdirSync(billingPath);
  try {
    const liveProjects: Config["projects"] = [{ id: "billing-service", name: "Billing", path: billingPath }];
    const groups = new ProjectGroupService({ stateDir: join(root, "state"), projects: liveProjects } as Config, randomBytes(32));
    const recycled = groups.create({ requestId: randomUUID(), name: "API", repos: ["billing-service"] });
    assert.equal(recycled.id, "api");

    const memberships = groups.membershipSnapshot();
    const sharedObjective = "Harden endpoint validation";
    const { items } = missionBoard(
      [
        mission("blocked", 1, { id: "m-retired", title: "Retired API mission", groupId: "api", groupName: "Old API", repoProjectIds: ["api"], objective: sharedObjective }),
        mission("working", 2, { id: "m-live", title: "New API mission", groupId: recycled.id, groupName: recycled.name, repoProjectIds: ["billing-service"], objective: sharedObjective }),
      ],
      [
        team("ready-for-review", 3, { id: "t-retired", projectId: "api", title: "Retired API team" }),
        team("implementing", 4, { id: "t-live", projectId: "billing-service", title: "New API team" }),
      ],
      [
        goal("blocked", 5, { id: "g-retired", projectId: "api", title: "Retired API goal" }),
        goal("running", 6, { id: "g-live", projectId: "billing-service", title: "New API goal" }),
      ],
      liveProjects,
      id => memberships.get(id),
    );

    const byId = new Map(items.map(item => [item.id, item]));
    assert.equal(byId.get("m-retired")!.groupId, "unmapped:group:api");
    assert.equal(byId.get("t-retired")!.groupId, "unmapped:project:api");
    assert.equal(byId.get("g-retired")!.groupId, "unmapped:project:api");
    assert.equal(byId.get("m-retired")!.attempt, undefined, "a retired mission does not merge attempts with a live mission whose new group recycled the slug");
    assert.equal(byId.get("m-live")!.attempt, undefined);
    assert.deepEqual(items.filter(item => item.groupId === recycled.id).map(item => item.id).sort(), ["g-live", "m-live", "t-live"]);
    for (const row of items) assert.equal(boardItemSchema.safeParse(row).success, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the board numbers repeated attempts of the same work and marks stopped older ones superseded", () => {
  const containing = () => undefined;
  const objective = "Rework the project page";
  const first = mission("cancelled", 1, { objective }), second = mission("blocked", 2, { objective: `  Rework the\n project page ` }), third = mission("blocked", 3, { objective });
  const other = mission("working", 4, { objective: "A different mission" });
  const elsewhere = mission("blocked", 5, { objective, groupId: "docs", groupName: "Docs", repoProjectIds: ["docs"] });
  const running = team("implementing", 6, { objective }), rerun = team("blocked", 7, { objective });
  const goals = [goal("blocked", 8, { objective } as Partial<ProductGoal>), goal("blocked", 9, { objective } as Partial<ProductGoal>)];
  const { items } = missionBoard([third, other, first, elsewhere, second], [rerun, running], goals, projects, containing);
  const attempt = (id: string) => items.find(item => item.id === id)!.attempt;

  assert.deepEqual([first, second, third].map(item => { const { workId: _workId, ...rest } = attempt(item.id)!; return rest; }),
    [{ number: 1, of: 3, superseded: true }, { number: 2, of: 3, superseded: true }, { number: 3, of: 3, superseded: false }]);
  assert.equal(new Set([first, second, third].map(item => attempt(item.id)!.workId)).size, 1);
  assert.equal(attempt(other.id), undefined, "A single start is not an attempt");
  assert.equal(attempt(elsewhere.id), undefined, "The same objective in another project is separate work");
  assert.deepEqual([running, rerun].map(item => { const { workId: _workId, ...rest } = attempt(item.id)!; return rest; }),
    [{ number: 1, of: 2, superseded: false }, { number: 2, of: 2, superseded: false }]);
  assert.notEqual(attempt(running.id)!.workId, attempt(third.id)!.workId, "A run and a mission with one objective are separate work");
  assert.ok(goals.every(item => attempt(item.id) === undefined), "Goals repeat by design and are not attempts");
  assert.equal(items.find(item => item.id === third.id)!.createdAt, at(3));
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
    const extension = { requestId: randomUUID(), revision: 1, minutes: 10 };
    const missionId = randomUUID();
    assert.equal((await host.fetchApi(`/missions/${missionId}/extend`, "controller", extension)).status, 403);
    assert.notEqual((await host.fetchApi(`/missions/${missionId}/extend`, "owner", extension)).status, 403, "The extension route is available only after owner authorization");
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
