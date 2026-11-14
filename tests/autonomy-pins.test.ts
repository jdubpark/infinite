import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autonomyOf, type AutonomyMode } from "../packages/host/src/autonomy.js";
import { GoalService } from "../packages/host/src/goals.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { Project } from "../packages/host/src/types.js";
import type { CreateTeam, TeamGoalContext, TeamLineup, TeamRun, TeamView } from "../packages/host/src/team-types.js";
import { emptyUsage } from "../packages/host/src/team-usage.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { createTeamSchema, teamGoalContextSchema, teamLineupSchema } from "../packages/host/src/team-types.js";
import { waitFor } from "./helpers.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

/** The scheduler fixture with a configured project, lineup, and provider profiles. */
function teamFixture() {
  const f = schedulerFixture();
  f.config.agents = { demo: { command: process.execPath, args: [] }, claude: { command: "claude", args: [] }, codex: { command: "codex", args: [] } };
  f.config.teams = { ...f.config.teams!, lineup };
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] } as Project["team"];
  return f;
}

const teamRequest = (): CreateTeam => ({ requestId: randomUUID(), projectId: "fixture", provider: "claude", title: "Inspect the fixture", objective: "Ask before choosing work", parallelism: 1 } as CreateTeam);

const goalContext = (id: string): TeamGoalContext => ({ id, revision: 1, cycle: 1, successCriteria: "The owner has evidence", nonGoals: [], allowedPaths: ["."], evidence: [],
  previousWork: [], deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), maxMembers: 4, extendMinutes: 0, ceilingAt: new Date(Date.now() + 60 * 60000).toISOString() } as TeamGoalContext);

test("a standalone run and a mission subteam pin the project's current mode", async () => {
  const f = teamFixture();
  const teams = f.openTeam();
  try {
    f.config.projects[0]!.autonomy = "autonomous";
    const mission = await teams.createForMission(teamRequest(), randomUUID(), lineup);
    assert.equal(mission.autonomy, "autonomous");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", mission.id).run.autonomy, "autonomous");

    delete f.config.projects[0]!.autonomy;
    const standalone = await teams.create(teamRequest());
    assert.equal(standalone.autonomy, "supervised");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", standalone.id).run.autonomy, "supervised");
  } finally { teams.close(); f.close(); }
});

test("a goal run pins the mode its cycle passes", async () => {
  const f = teamFixture();
  const teams = f.openTeam();
  try {
    f.config.projects[0]!.autonomy = "supervised";
    const pinned = await teams.createForGoal(teamRequest(), goalContext(randomUUID()), lineup, false, "autonomous");
    assert.equal(pinned.autonomy, "autonomous");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", pinned.id).run.autonomy, "autonomous");

    const defaulted = await teams.createForGoal(teamRequest(), goalContext(randomUUID()), lineup);
    assert.equal(defaulted.autonomy, "supervised");
  } finally { teams.close(); f.close(); }
});

test("the mode is not part of a run request's identity", async () => {
  const f = teamFixture();
  const teams = f.openTeam();
  try {
    const request = teamRequest(), context = goalContext(randomUUID());
    f.config.projects[0]!.autonomy = "supervised";
    const first = await teams.createForGoal(request, context, lineup, false, "supervised");
    f.config.projects[0]!.autonomy = "autonomous";
    const replay = await teams.createForGoal(request, context, lineup, false, "autonomous");
    assert.equal(replay.id, first.id);
    assert.equal(replay.autonomy, "supervised");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", first.id).run.autonomy, "supervised");
  } finally { teams.close(); f.close(); }
});

test("a mode change applies from the next run", async () => {
  const f = teamFixture();
  const teams = f.openTeam();
  try {
    f.config.projects[0]!.autonomy = "autonomous";
    const first = await teams.create(teamRequest());
    f.config.projects[0]!.autonomy = "supervised";
    const second = await teams.create(teamRequest());
    assert.equal(f.readRecord<{ run: TeamRun }>("team", first.id).run.autonomy, "autonomous");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", second.id).run.autonomy, "supervised");
  } finally { teams.close(); f.close(); }
});

test("a run recorded before this slice reads as supervised and is not rewritten", () => {
  const f = teamFixture();
  f.config.projects[0]!.autonomy = "autonomous";
  // Runs written since the capacity ceiling existed carry it; the constructor migrates only runs without one.
  f.run.parallelismCeiling = 4;
  f.writeTeam();
  const file = join(f.config.stateDir, "teams", `${f.run.id}.sealed`), before = readFileSync(file);
  const teams = f.openTeam();
  try {
    assert.equal(autonomyOf(teams.get(f.run.id)), "supervised");
    assert.equal("autonomy" in f.readRecord<{ run: TeamRun }>("team", f.run.id).run, false);
    assert.deepEqual(readFileSync(file), before, "Loading and reading a pre-slice run must not rewrite its sealed bytes");
  } finally { teams.close(); f.close(); }
});

test("a goal recorded before this slice is not rewritten at load", async () => {
  const f = teamFixture();
  f.config.projects[0]!.autonomy = "autonomous";
  const goal = goalRecord(f);
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  const file = join(f.config.stateDir, "goals", `${goal.id}.sealed`), before = readFileSync(file);
  const teams = stubTeams();
  let goals: GoalService | undefined;
  try {
    goals = new GoalService(f.config, f.key, teams as unknown as TeamService);
    assert.equal(autonomyOf((await goals.get(goal.id)).goal ?? {}), "supervised");
    assert.deepEqual(readFileSync(file), before, "Loading a pre-slice goal must not rewrite its sealed bytes");
  } finally { goals?.close(); f.close(); }
});

test("a goal launch prepared before this slice replays without a conflict", async () => {
  const f = teamFixture();
  f.config.projects[0]!.autonomy = "autonomous";
  const runId = randomUUID(), request: CreateTeam = { ...teamRequest(), requestId: runId, useConfiguredLineup: true } as CreateTeam;
  const context = goalContext(randomUUID());
  // The fingerprint the code before this slice computed: the parsed request and the creation context
  // (goal, then lineup, in that key order), with no autonomy key anywhere in the formula.
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const fingerprint = digest({ request: createTeamSchema.parse(request), goal: teamGoalContextSchema.parse(context), lineup: teamLineupSchema.parse(lineup) });
  const run = { ...structuredClone(f.run), id: runId, provider: "claude" as const, title: request.title, objective: request.objective, parallelismCeiling: 1 } as TeamRun;
  delete (run as { autonomy?: unknown }).autonomy;
  f.writeRecord("team", runId, { run, prepared: true, fingerprint, receipts: {} });
  const goal = goalRecord(f);
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture", launch: { request, context } });
  const teams = f.openTeam();
  let goals: GoalService | undefined;
  try {
    goals = new GoalService(f.config, f.key, teams);
    goals.start();
    const recorded = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", goal.id), value => value.goal.cycles.length === 1, 5000);
    assert.notEqual(recorded.goal.status, "blocked", recorded.goal.reason);
    assert.equal(recorded.goal.cycles[0]!.teamId, runId);
    assert.equal(recorded.goal.cycles[0]!.autonomy, "supervised");
    assert.equal(autonomyOf(recorded.goal.cycles[0]!), "supervised");
    const replayed = teams.get(runId);
    assert.equal(replayed.id, runId);
    assert.equal(autonomyOf(replayed), "supervised");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", runId).run.autonomy, undefined);
  } finally { goals?.close(); teams.close(); f.close(); }
});

/** A stub team service: records each goal launch and returns views whose status the test sets. */
function stubTeams() {
  const views = new Map<string, TeamView>();
  const launches: { cycle: number; autonomy: AutonomyMode | undefined }[] = [];
  const view = (id: string, status: string) => ({ id, status, createdAt: new Date().toISOString(), members: [],
    usage: { total: emptyUsage(), byProfile: {}, byProvider: {}, unmeasuredMembers: 0 } }) as unknown as TeamView;
  const service = {
    launches,
    settle: (id: string, status: string) => { views.set(id, view(id, status)); },
    get(id: string) {
      const found = views.get(id);
      if (!found) throw new TeamError(404, "team-not-found", "The team was not found.");
      return structuredClone(found);
    },
    async createForGoal(request: CreateTeam, context: TeamGoalContext, _lineup: TeamLineup, _linearTracking: boolean, autonomy?: AutonomyMode) {
      launches.push({ cycle: context.cycle, autonomy });
      const started = view(request.requestId, "running");
      views.set(started.id, started);
      return structuredClone(started);
    },
    async removeRun() {},
  };
  return service;
}

/** A goal record as the goal service writes it, without a launch unless the test adds one. */
function goalRecord(f: ReturnType<typeof teamFixture>, extra: Partial<ProductGoal> = {}): ProductGoal {
  const at = new Date().toISOString(), deadlineAt = new Date(Date.now() + 60 * 60000).toISOString();
  return { id: randomUUID(), projectId: "fixture", title: "Inspect the fixture", objective: "Choose scoped work", successCriteria: "The owner has evidence",
    nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 3, maxMinutes: 60, maxMembers: 24, parallelism: 1, revision: 1, status: "running",
    createdAt: at, updatedAt: at, deadlineAt, ceilingAt: deadlineAt, lineup: f.config.teams!.lineup!, cycles: [], memberCount: 0, steering: [], events: [], outcomes: [],
    ...extra } as ProductGoal;
}

const goalRequest = (): CreateGoal => ({ requestId: randomUUID(), projectId: "fixture", title: "Improve the fixture", objective: "Choose scoped work",
  successCriteria: "The owner has evidence", nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 3, maxMinutes: 60, maxMembers: 24, parallelism: 3 });

test("a goal records its start mode and every cycle keeps it", async () => {
  const f = teamFixture();
  const teams = stubTeams();
  let goals: GoalService | undefined;
  try {
    f.config.projects[0]!.autonomy = "autonomous";
    goals = new GoalService(f.config, f.key, teams as unknown as TeamService);
    const created = await goals.create(goalRequest());
    assert.equal(created.autonomy, "autonomous");
    goals.start();

    const first = await waitFor(() => teams.launches, value => value.length === 1, 5000);
    assert.equal(first[0]!.autonomy, "autonomous");
    const firstCycle = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", created.id), value => value.goal.cycles.length === 1, 5000);
    assert.equal(firstCycle.goal.cycles[0]!.autonomy, "autonomous");

    f.config.projects[0]!.autonomy = "supervised";
    teams.settle(firstCycle.goal.cycles[0]!.teamId, "ready-for-review");
    const second = await waitFor(() => teams.launches, value => value.length === 2, 5000);
    assert.equal(second[1]!.autonomy, "autonomous");
    const secondCycle = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", created.id), value => value.goal.cycles.length === 2, 5000);
    assert.equal(secondCycle.goal.cycles[1]!.autonomy, "autonomous");
    assert.equal(secondCycle.goal.autonomy, "autonomous");
  } finally { goals?.close(); f.close(); }
});

test("a goal created under supervised keeps supervised cycles after the project turns autonomous", async () => {
  const f = teamFixture();
  const teams = stubTeams();
  let goals: GoalService | undefined;
  try {
    f.config.projects[0]!.autonomy = "supervised";
    goals = new GoalService(f.config, f.key, teams as unknown as TeamService);
    const created = await goals.create(goalRequest());
    assert.equal(created.autonomy, "supervised");
    goals.start();

    const first = await waitFor(() => teams.launches, value => value.length === 1, 5000);
    assert.equal(first[0]!.autonomy, "supervised");
    const firstCycle = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", created.id), value => value.goal.cycles.length === 1, 5000);

    f.config.projects[0]!.autonomy = "autonomous";
    teams.settle(firstCycle.goal.cycles[0]!.teamId, "ready-for-review");
    const second = await waitFor(() => teams.launches, value => value.length === 2, 5000);
    assert.equal(second[1]!.autonomy, "supervised");
    const secondCycle = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", created.id), value => value.goal.cycles.length === 2, 5000);
    assert.equal(secondCycle.goal.cycles[1]!.autonomy, "supervised");
    assert.equal(secondCycle.goal.autonomy, "supervised");
  } finally { goals?.close(); f.close(); }
});

test("a prepared launch keeps its mode across a change and a restart", async () => {
  const f = teamFixture();
  const teams = stubTeams();
  let goals: GoalService | undefined;
  try {
    f.config.projects[0]!.autonomy = "supervised";
    const goal = goalRecord(f, { autonomy: "autonomous" });
    const request: CreateTeam = { ...teamRequest(), requestId: randomUUID(), useConfiguredLineup: true } as CreateTeam;
    f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture", launch: { request, context: goalContext(goal.id), autonomy: "autonomous" } });
    goals = new GoalService(f.config, f.key, teams as unknown as TeamService);
    goals.start();

    const launched = await waitFor(() => teams.launches, value => value.length === 1, 5000);
    assert.equal(launched[0]!.autonomy, "autonomous");
    const recorded = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", goal.id), value => value.goal.cycles.length === 1, 5000);
    assert.equal(recorded.goal.cycles[0]!.autonomy, "autonomous");
  } finally { goals?.close(); f.close(); }
});

test("a goal recorded before this slice stays supervised", async () => {
  const f = teamFixture();
  const teams = stubTeams();
  let goals: GoalService | undefined;
  try {
    f.config.projects[0]!.autonomy = "autonomous";
    const goal = goalRecord(f);
    const request: CreateTeam = { ...teamRequest(), requestId: randomUUID(), useConfiguredLineup: true } as CreateTeam;
    f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture", launch: { request, context: goalContext(goal.id) } });
    goals = new GoalService(f.config, f.key, teams as unknown as TeamService);
    goals.start();

    const first = await waitFor(() => teams.launches, value => value.length === 1, 5000);
    assert.equal(first[0]!.autonomy, "supervised");
    const firstCycle = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", goal.id), value => value.goal.cycles.length === 1, 5000);
    teams.settle(firstCycle.goal.cycles[0]!.teamId, "ready-for-review");
    const second = await waitFor(() => teams.launches, value => value.length === 2, 5000);
    assert.equal(second[1]!.autonomy, "supervised");
    const recorded = f.readRecord<{ goal: ProductGoal }>("goal", goal.id).goal;
    assert.equal(autonomyOf(recorded), "supervised");
    assert.equal(recorded.cycles[1]!.autonomy, "supervised");
  } finally { goals?.close(); f.close(); }
});
