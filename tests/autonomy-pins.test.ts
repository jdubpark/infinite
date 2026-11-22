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
import { unseal } from "../packages/host/src/vault.js";

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
    const first = await teams.create({ ...teamRequest(), useConfiguredLineup: true } as CreateTeam);
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

test("a goal recorded before this slice keeps its fields at load", async () => {
  const f = teamFixture();
  f.config.projects[0]!.autonomy = "autonomous";
  const goal = goalRecord(f);
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  const file = join(f.config.stateDir, "goals", `${goal.id}.sealed`);
  const teams = stubTeams();
  let goals: GoalService | undefined;
  try {
    goals = new GoalService(f.config, f.key, teams as unknown as TeamService);
    assert.equal(autonomyOf((await goals.get(goal.id)).goal ?? {}), "supervised");
    // The migration writes the record once at load, so the bytes change; the goal's fields must not.
    const sealed = unseal<{ goal: ProductGoal; receipts: unknown; fingerprint: unknown }>(f.key, `goal:${goal.id}`, readFileSync(file, "utf8"));
    assert.deepEqual(sealed.goal, goal, "the goal keeps its fields at load");
    assert.deepEqual(sealed.receipts, {});
    assert.equal(sealed.fingerprint, "fixture");
    assert.equal("autonomy" in sealed.goal, false, "the goal holds no autonomy key");
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

/** The host lineup with no evaluator of another family: Claude coordinates and reviews, and no escalation is strong. */
const { escalations: _strongEscalation, ...unreadyLineup } = lineup;
const unready: TeamLineup = unreadyLineup;
const noEvaluatorEvent = "This run starts supervised: no lineup profile of a model family other than the coordinator's can evaluate it.";
const noLineupEvent = "This run starts supervised: it has no lineup, so no evaluator of another model family can check it.";
const goalNoEvaluatorEvent = "This goal starts supervised: no lineup profile of a model family other than the coordinator's can evaluate it.";
const standingNoEvaluator = "A standing goal needs an evaluator: no lineup profile of a model family other than the coordinator's can evaluate it. Add one to the lineup's evaluators, or start a finite goal.";
const standingRequest = (): CreateGoal => ({ requestId: randomUUID(), projectId: "fixture", title: "Keep the fixture healthy", objective: "Choose scoped work",
  successCriteria: "The owner has evidence", nonGoals: [], allowedPaths: ["."], evidence: [], maxMinutes: 5, maxMembers: 6, parallelism: 3,
  standing: { shape: "objective", cadenceMinutes: 30 } } as CreateGoal);
const eventsWith = (events: { text: string }[], text: string) => events.filter(event => event.text === text).length;
const runEvents = (f: ReturnType<typeof teamFixture>, id: string) => f.readRecord<{ run: TeamRun }>("team", id).run.events;
test("a lineup without an eligible evaluator starts new runs and goals supervised", async () => {
  const f = teamFixture();
  const teams = f.openTeam();
  let goals: GoalService | undefined;
  try {
    f.config.projects[0]!.autonomy = "autonomous";
    f.config.teams = { ...f.config.teams!, lineup: unready };
    // The mission comes first: a mission cannot start while a standalone run of the project is active.
    const mission = await teams.createForMission(teamRequest(), randomUUID(), unready);
    assert.equal(mission.autonomy, "supervised");
    assert.equal(eventsWith(runEvents(f, mission.id), noEvaluatorEvent), 1);

    const configured = await teams.create({ ...teamRequest(), useConfiguredLineup: true } as CreateTeam);
    assert.equal(configured.autonomy, "supervised");
    assert.equal(eventsWith(runEvents(f, configured.id), noEvaluatorEvent), 1);

    const single = await teams.create(teamRequest());
    assert.equal(single.autonomy, "supervised");
    assert.equal(eventsWith(runEvents(f, single.id), noLineupEvent), 1);

    goals = new GoalService(f.config, f.key, stubTeams() as unknown as TeamService);
    const goal = await goals.create(goalRequest());
    assert.equal(goal.autonomy, "supervised");
    assert.equal(eventsWith(f.readRecord<{ goal: ProductGoal }>("goal", goal.id).goal.events, goalNoEvaluatorEvent), 1);
    await assert.rejects(goals.create(standingRequest()), (error: unknown) =>
      error instanceof TeamError && error.code === "standing-requires-autonomy" && error.message === standingNoEvaluator);

    f.config.teams = { ...f.config.teams!, lineup };
    const ready = await teams.create({ ...teamRequest(), useConfiguredLineup: true } as CreateTeam);
    assert.equal(ready.autonomy, "autonomous");
    assert.equal(eventsWith(runEvents(f, ready.id), noEvaluatorEvent), 0);
  } finally { goals?.close(); teams.close(); f.close(); }
});

test("pins already taken never move", async () => {
  const f = teamFixture();
  let teams = f.openTeam();
  let goals: GoalService | undefined;
  try {
    f.config.projects[0]!.autonomy = "autonomous";
    const run = await teams.create({ ...teamRequest(), useConfiguredLineup: true } as CreateTeam);
    assert.equal(run.autonomy, "autonomous");
    // The host lineup loses its evaluator; the pinned run stays autonomous through a pause and a reload.
    f.config.teams = { ...f.config.teams!, lineup: unready };
    const paused = await teams.pause(run.id, { requestId: randomUUID(), revision: run.revision });
    assert.equal(paused.autonomy, "autonomous");
    teams.close();
    teams = f.openTeam();
    assert.equal(autonomyOf(teams.get(run.id)), "autonomous");
    // A goal cycle's run takes its goal's pin, whatever the lineup now gives, and logs no start event.
    const cycle = await teams.createForGoal(teamRequest(), goalContext(randomUUID()), unready, false, "autonomous");
    assert.equal(cycle.autonomy, "autonomous");
    assert.equal(eventsWith(runEvents(f, cycle.id), noEvaluatorEvent), 0);

    // A goal created autonomous keeps autonomous in its next cycle after the lineup loses its evaluator.
    f.config.teams = { ...f.config.teams!, lineup };
    const stub = stubTeams();
    goals = new GoalService(f.config, f.key, stub as unknown as TeamService);
    const created = await goals.create(goalRequest());
    assert.equal(created.autonomy, "autonomous");
    goals.start();
    const first = await waitFor(() => stub.launches, value => value.length === 1, 5000);
    assert.equal(first[0]!.autonomy, "autonomous");
    const firstCycle = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", created.id), value => value.goal.cycles.length === 1, 5000);
    f.config.teams = { ...f.config.teams!, lineup: unready };
    stub.settle(firstCycle.goal.cycles[0]!.teamId, "ready-for-review");
    const second = await waitFor(() => stub.launches, value => value.length === 2, 5000);
    assert.equal(second[1]!.autonomy, "autonomous");
    const secondCycle = await waitFor(() => f.readRecord<{ goal: ProductGoal }>("goal", created.id), value => value.goal.cycles.length === 2, 5000);
    assert.equal(secondCycle.goal.cycles[1]!.autonomy, "autonomous");
  } finally { goals?.close(); teams.close(); f.close(); }
});

test("each new run pins the intent check by mode and setting", async () => {
  const f = teamFixture();
  const teams = f.openTeam();
  try {
    f.config.projects[0]!.autonomy = "autonomous";
    const mission = await teams.createForMission(teamRequest(), randomUUID(), lineup);
    assert.equal(mission.intentCheck, "off");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", mission.id).run.intentCheck, "off");

    const autonomous = await teams.create({ ...teamRequest(), useConfiguredLineup: true } as CreateTeam);
    assert.equal(autonomous.intentCheck, "on");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", autonomous.id).run.intentCheck, "on");

    f.config.projects[0]!.team!.objective = { intentCheck: "off" };
    const disabled = await teams.create({ ...teamRequest(), useConfiguredLineup: true } as CreateTeam);
    assert.equal(disabled.intentCheck, "off");

    f.config.projects[0]!.autonomy = "supervised";
    const supervisedOff = await teams.create(teamRequest());
    assert.equal(supervisedOff.intentCheck, "off");
    f.config.projects[0]!.team!.objective = { intentCheck: "on" };
    const supervisedOn = await teams.create(teamRequest());
    assert.equal(supervisedOn.intentCheck, "on");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", supervisedOn.id).run.intentCheck, "on");

    delete f.config.projects[0]!.team!.objective;
    const goalOn = await teams.createForGoal(teamRequest(), goalContext(randomUUID()), lineup, false, "autonomous");
    assert.equal(goalOn.intentCheck, "on");
    const goalOff = await teams.createForGoal(teamRequest(), goalContext(randomUUID()), lineup);
    assert.equal(goalOff.intentCheck, "off");

    // A replayed request returns the run with the pin it was created with, not the pin the current settings give.
    const request = { ...teamRequest(), useConfiguredLineup: true } as CreateTeam;
    f.config.projects[0]!.autonomy = "autonomous";
    const first = await teams.create(request);
    assert.equal(first.intentCheck, "on");
    f.config.projects[0]!.autonomy = "supervised";
    f.config.projects[0]!.team!.objective = { intentCheck: "off" };
    const replay = await teams.create(request);
    assert.equal(replay.id, first.id);
    assert.equal(replay.intentCheck, "on");
  } finally { teams.close(); f.close(); }
});

test("each new run pins the register by setting", async () => {
  const f = teamFixture();
  const teams = f.openTeam();
  try {
    f.config.projects[0]!.team!.objective = { register: "on" };
    const mission = await teams.createForMission(teamRequest(), randomUUID(), lineup);
    assert.equal(mission.register, undefined, "a mission subteam never pins the register");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", mission.id).run.register, undefined);

    const standalone = await teams.create(teamRequest());
    assert.equal(standalone.register, "on");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", standalone.id).run.register, "on");

    f.config.projects[0]!.team!.objective = { register: "off" };
    const off = await teams.create(teamRequest());
    assert.equal(off.register, undefined, "the setting off pins nothing");
    assert.equal("register" in f.readRecord<{ run: TeamRun }>("team", off.id).run, false);
  } finally { teams.close(); f.close(); }
});

test("each new run pins verdicts by setting", async () => {
  const f = teamFixture();
  const teams = f.openTeam();
  const saved = (id: string) => f.readRecord<{ run: TeamRun }>("team", id).run;
  try {
    // With both keys on, a mission subteam never pins verdicts.
    f.config.projects[0]!.team!.objective = { evaluator: "on", register: "on" };
    const mission = await teams.createForMission(teamRequest(), randomUUID(), lineup);
    assert.equal(mission.verdicts, undefined, "a mission subteam never pins verdicts");
    assert.equal("verdicts" in saved(mission.id), false);

    // The evaluator key alone, and the register key alone, pin nothing.
    f.config.projects[0]!.team!.objective = { evaluator: "on" };
    const evaluatorOnly = await teams.create(teamRequest());
    assert.equal(evaluatorOnly.verdicts, undefined, "the evaluator key needs the register key");
    f.config.projects[0]!.team!.objective = { register: "on" };
    const registerOnly = await teams.create(teamRequest());
    assert.equal(registerOnly.verdicts, undefined, "the register key needs the evaluator key");
    assert.equal("verdicts" in saved(registerOnly.id), false);

    // Both keys on: a standalone run pins it.
    f.config.projects[0]!.team!.objective = { evaluator: "on", register: "on" };
    const standalone = await teams.create(teamRequest());
    assert.equal(standalone.verdicts, "on");
    assert.equal(saved(standalone.id).verdicts, "on");

    // The evaluator key off pins nothing even with the register on.
    f.config.projects[0]!.team!.objective = { evaluator: "off", register: "on" };
    const off = await teams.create(teamRequest());
    assert.equal(off.verdicts, undefined);
    assert.equal("verdicts" in saved(off.id), false);
  } finally { teams.close(); f.close(); }
});
