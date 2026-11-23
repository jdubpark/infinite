import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { reviewedObservationsOf, type CheckObservation, type ObservationHolder } from "../packages/host/src/check-observations.js";
import { GoalService } from "../packages/host/src/goals.js";
import type { CreateGoal, GoalCycle, ProductGoal } from "../packages/host/src/goal-types.js";
import type { CycleMetrics, GoalMetrics } from "../packages/host/src/goal-metrics.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { TeamError, type TeamService } from "../packages/host/src/teams.js";
import { emptyUsage } from "../packages/host/src/team-usage.js";
import { createTeamSchema, teamGoalContextSchema, type CreateTeam, type TeamGoalContext, type TeamLineup, type TeamRun, type TeamView } from "../packages/host/src/team-types.js";
import type { Project } from "../packages/host/src/types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

/*
 * The goal service's use of reported numbers (goals.ts): it settles a cycle's entry from the team service's one read
 * when the cycle's run ends, prunes at every write, and reads the curve. The team service is a stub whose
 * `reviewedObservations` answers what the test sets; tests/goal-metrics-host.test.ts runs the real one.
 */

const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  evaluators: [{ id: "evaluator", label: "Evaluator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
};
const minute = 60_000;
const check = { command: process.execPath, args: ["-e", "0"] };
const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Polls on real timers; `Date` is mocked, so a Date-based timeout would never pass. */
async function until<T>(read: () => T, accept: (value: T) => boolean, ms = 8000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const value = read();
    if (accept(value)) return value;
    if (performance.now() > end) throw new Error(`Timed out; last value: ${JSON.stringify(value)?.slice(0, 2000)}`);
    await sleep(20);
  }
}

/** A team service stub with the goal's one read of reported numbers. */
function stubTeams() {
  const views = new Map<string, TeamView>();
  const launches: { request: CreateTeam; context: TeamGoalContext }[] = [];
  const observations = new Map<string, CheckObservation[] | undefined>();
  /** Run holders read through the real `reviewedObservationsOf`, as the team service reads its records. */
  const holders = new Map<string, ObservationHolder>();
  const usage = () => ({ total: emptyUsage(), byProfile: {}, byProvider: {}, unmeasuredMembers: 0, partialMembers: 0 });
  const service = {
    launches, observations, holders,
    get(id: string) {
      const found = views.get(id);
      if (!found) throw new TeamError(404, "team-not-found", "The team was not found.");
      return structuredClone(found);
    },
    goalIdOf: (id: string) => views.get(id)?.goal?.id,
    hasDeliveryAttempt: () => false,
    reviewedObservations: (id: string) => holders.has(id) ? reviewedObservationsOf(holders.get(id)) : structuredClone(observations.get(id)),
    async createForGoal(request: CreateTeam, context: TeamGoalContext) {
      createTeamSchema.parse(request); teamGoalContextSchema.parse(context);
      const prior = views.get(request.requestId);
      if (prior) return structuredClone(prior);
      launches.push(structuredClone({ request, context }));
      const at = new Date().toISOString();
      views.set(request.requestId, { id: request.requestId, projectId: request.projectId, status: "planning", revision: 1, createdAt: at, updatedAt: at,
        goal: structuredClone(context), members: [], tasks: [], usage: usage(), branch: "main", baseCommit: "c".repeat(40) } as unknown as TeamView);
      return service.get(request.requestId);
    },
    /** Ends a run. A running member keeps the goal attached, so its next step settles the run again. */
    settle(id: string, status: string, member: "running" | "stopped") {
      Object.assign(views.get(id)!, { status, members: [{ memberId: randomUUID(), role: "implementer", revision: 1, status: member }] });
    },
    async cancel(id: string) { service.settle(id, "cancelled", "stopped"); return service.get(id); },
    async pause(id: string) { service.settle(id, "paused", "stopped"); return service.get(id); },
    async resume(id: string) { service.settle(id, "planning", "stopped"); return service.get(id); },
    async removeRun() {},
  };
  return service;
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-23T00:00:00.000Z") });
  const f = schedulerFixture();
  f.config.teams = { ...f.config.teams!, lineup };
  f.config.projects[0]!.team = { checks: [check], objective: { prompts: "on" } } as Project["team"];
  f.config.projects[0]!.autonomy = "autonomous";
  // The launch needs a profile for each provider of the lineup; no agent runs.
  f.config.agents = { claude: { command: process.execPath, args: [] }, codex: { command: process.execPath, args: [] } } as typeof f.config.agents;
  const teams = stubTeams();
  const services: GoalService[] = [];
  const open = () => { const goals = new GoalService(f.config, f.key, teams as unknown as TeamService); services.push(goals); return goals; };
  t.after(() => { for (const service of services) service.close(); f.close(); });
  return { f, teams, open, advance: (minutes: number) => t.mock.timers.setTime(Date.now() + minutes * minute) };
}

type Holder = { goal: ProductGoal; metrics?: GoalMetrics };
const finite = (): CreateGoal => ({ requestId: randomUUID(), projectId: "fixture", title: "Make the fixture faster", objective: "Reduce the measured time",
  successCriteria: "The measured time falls", nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 2, maxMinutes: 60, maxMembers: 6, parallelism: 2 } as CreateGoal);
const standing = (): CreateGoal => ({ ...finite(), maxRuns: undefined, maxMinutes: 5, standing: { shape: "objective", cadenceMinutes: 30 } } as unknown as CreateGoal);
const observed = (head: string, revision: number, values: [name: string, value: number][]): CheckObservation[] =>
  values.map(([name, value]) => ({ command: commandDigest(check), name, revision, round: 0, head, at: new Date().toISOString(), state: "value", value }));
const curve = (goals: GoalService, id: string) => goals.metrics(id).series.map(series => [series.name, series.points.map(point => [point.cycle, point.value])]);

test("a finite goal sets a cycle's entry at a reviewed end, replaces it when the run ends again, and removes it without a reviewed head", async t => {
  const { f, teams, open } = fixture(t);
  const goals = open();
  const created = await goals.create(finite());
  goals.start();
  const first = (await until(() => teams.launches[0], Boolean)).request.requestId;
  teams.observations.set(first, observed(HEAD_A, 1, [["svc_speed", 10], ["svc_size", 2]]));
  teams.settle(first, "ready-for-review", "running");
  await until(() => curve(goals, created.id), value => value.length === 2);
  // Both series' newest point is the same check, so the identity digest orders them; the test reads them by name.
  assert.deepEqual(curve(goals, created.id).sort(), [["svc_size", [[1, 2]]], ["svc_speed", [[1, 10]]]]);
  const stored = f.readRecord<Holder>("goal", created.id);
  assert.deepEqual(stored.metrics?.entries.map(entry => [entry.run, entry.revision, entry.head, entry.values.length]), [[first, 1, HEAD_A, 2]]);
  assert.equal(JSON.stringify(stored.goal).includes("svc_speed"), false, "the entry is beside the goal, not in it");
  assert.equal(JSON.stringify(goals.get(created.id)).includes("svc_speed"), false, "the goal view has no entry");
  assert.equal(JSON.stringify(goals.list()).includes("svc_speed"), false, "the goal list has no entry");

  teams.observations.set(first, observed(HEAD_B, 2, [["svc_speed", 8]]));
  await until(() => curve(goals, created.id), value => value.length === 1);
  assert.deepEqual(curve(goals, created.id), [["svc_speed", [[1, 8]]]], "a later revision's fewer values replace the entry whole");

  teams.observations.set(first, undefined);
  await until(() => curve(goals, created.id), value => value.length === 0);
  assert.equal("metrics" in f.readRecord<Holder>("goal", created.id), false, "no reviewed head removes the entry, uncounted");
  assert.equal(goals.metrics(created.id).dropped, 0);

  teams.observations.set(first, observed(HEAD_B, 2, [["svc_speed", 8]]));
  teams.settle(first, "ready-for-review", "stopped");
  const second = (await until(() => teams.launches[1], Boolean)).request.requestId;
  teams.observations.set(second, observed(HEAD_A, 1, [["svc_speed", 6]]));
  teams.settle(second, "ready-for-review", "stopped");
  await until(() => goals.get(created.id), goal => goal.status === "ready-for-review" && !goal.activeTeamId);
  assert.deepEqual(curve(goals, created.id), [["svc_speed", [[1, 8], [2, 6]]]]);
  const view = goals.metrics(created.id);
  assert.deepEqual([view.series[0]?.configured, view.series[0]?.label], [true, `${process.execPath} -e 0`]);

  const restarted = (goals.close(), open());
  assert.deepEqual(restarted.metrics(created.id), view, "the curve is the same after a restart");
  assert.throws(() => restarted.metrics(randomUUID()), (error: unknown) => error instanceof TeamError && error.status === 404);
});

test("a standing goal settles each cycle, and its pause and an objective correction keep the entries", async t => {
  const { f, teams, open, advance } = fixture(t);
  const goals = open();
  const created = await goals.create(standing());
  goals.start();
  const first = (await until(() => teams.launches[0], Boolean)).request.requestId;
  teams.observations.set(first, observed(HEAD_A, 1, [["svc_speed", 10]]));
  teams.settle(first, "ready-for-review", "stopped");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId);
  advance(30);
  const second = (await until(() => teams.launches[1], Boolean)).request.requestId;
  teams.settle(second, "blocked", "stopped");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId && goal.cycles.length === 2);
  assert.deepEqual(curve(goals, created.id), [["svc_speed", [[1, 10]]]], "the blocked cycle without a reviewed head is a gap");
  const entries = () => f.readRecord<Holder>("goal", created.id).metrics?.entries.map(entry => entry.run);
  assert.deepEqual(entries(), [first]);

  const paused = await goals.pause(created.id, { requestId: randomUUID(), revision: goals.get(created.id).revision });
  assert.equal(paused.status, "paused");
  assert.deepEqual(entries(), [first], "the pause's write keeps the entry");
  const corrected = await goals.correctObjective(created.id, { requestId: randomUUID(), version: 1,
    ops: [{ op: "criterion.add", criterion: { statement: "The time falls", check: { kind: "judgement", item: "time" }, threshold: { kind: "pass" } } }] });
  assert.equal(corrected.version, 2);
  assert.deepEqual(entries(), [first], "the correction's write keeps the entry");
  assert.deepEqual(curve(goals, created.id), [["svc_speed", [[1, 10]]]]);
});

/** `count` reviewed cycles that no run backs any more, as a long-lived goal holds them; each with one entry of one value. */
function history(count: number, from = 1) {
  const at = new Date().toISOString();
  const cycles: GoalCycle[] = Array.from({ length: count }, (_, index) => ({ teamId: randomUUID(), cycle: from + index, goalRevision: 1,
    status: "ready-for-review", startedAt: at, finishedAt: at, memberCount: 0, class: "reviewed", settledAt: at }));
  const entries: CycleMetrics[] = cycles.map((cycle, index) => ({ run: cycle.teamId, revision: 1, head: HEAD_A, more: 0,
    values: [{ command: commandDigest(check), name: "svc_speed", value: from + index, at }] }));
  return { cycles, entries };
}

test("the load write prunes a stored file past 50 entries and with orphans, counting each removal", async t => {
  const { f, open } = fixture(t);
  const goals = open();
  const created = await goals.create(finite());
  goals.close();
  const stored = f.readRecord<Holder>("goal", created.id);
  const { cycles, entries } = history(55);
  stored.goal.cycles = cycles;
  stored.goal.status = "paused";
  const orphans = history(2, 100).entries;
  stored.metrics = { entries: [...entries].reverse().concat(orphans), dropped: 1 };
  f.writeRecord("goal", created.id, stored);

  const restarted = open();
  const written = f.readRecord<Holder>("goal", created.id).metrics!;
  assert.deepEqual(written.entries.map(entry => entry.run), cycles.slice(5).map(cycle => cycle.teamId), "the newest 50 in cycle order, written at load");
  assert.equal(written.dropped, 1 + 5 + 2);
  const view = restarted.metrics(created.id);
  assert.deepEqual([view.series.length, view.series[0]?.points.length, view.series[0]?.points[0]?.cycle, view.dropped], [1, 50, 6, 8]);
});

test("the step's write prunes the 51st entry its settlement adds", async t => {
  const { f, teams, open } = fixture(t);
  const goals = open();
  const created = await goals.create(standing());
  goals.start();
  const run = (await until(() => teams.launches[0], Boolean)).request.requestId;
  await until(() => f.readRecord<Holder>("goal", created.id).goal.activeTeamId, Boolean);
  goals.close();
  const stored = f.readRecord<Holder>("goal", created.id);
  const { cycles, entries } = history(50);
  const active = stored.goal.cycles.at(-1)!;
  stored.goal.cycles = [...cycles, { ...active, cycle: 51 }];
  stored.metrics = { entries, dropped: 0 };
  f.writeRecord("goal", created.id, stored);

  const restarted = open();
  restarted.start();
  teams.observations.set(run, observed(HEAD_B, 1, [["svc_speed", 51]]));
  teams.settle(run, "ready-for-review", "stopped");
  const written = await until(() => f.readRecord<Holder>("goal", created.id).metrics!, metrics => metrics.entries.some(entry => entry.run === run));
  assert.deepEqual(written.entries.map(entry => entry.run), [...cycles.slice(1).map(cycle => cycle.teamId), run]);
  assert.equal(written.dropped, 1);
});

/** Values of a shape this version never writes, as a later release could leave them before a rollback. */
const FOREIGN: readonly [string, unknown][] = [["null", null], ["{}", {}], ["[null]", [null]], ["{ v: 2 }", { v: 2 }]];
const EMPTY = { series: [], omittedSeries: 0, omittedValues: 0, dropped: 0 };

for (const [label, value] of FOREIGN) {
  test(`the goal service starts over a stored metrics value of another shape, keeps it through a settlement, and reads the empty curve: ${label}`, async t => {
    const { f, teams, open } = fixture(t);
    const created = await open().create(finite());
    const stored = f.readRecord<{ goal: ProductGoal; metrics?: unknown }>("goal", created.id);
    stored.metrics = value;
    f.writeRecord("goal", created.id, stored);
    const raw = () => f.readRecord<{ metrics?: unknown }>("goal", created.id).metrics;

    let goals: GoalService | undefined;
    assert.doesNotThrow(() => { goals = open(); }, "the service starts");
    assert.deepEqual(raw(), value, "the start writes nothing over it");
    assert.deepEqual(goals!.metrics(created.id), EMPTY);
    goals!.start();
    const run = (await until(() => teams.launches[0], Boolean)).request.requestId;
    teams.observations.set(run, observed(HEAD_A, 1, [["svc_speed", 10]]));
    teams.settle(run, "ready-for-review", "stopped");
    await until(() => teams.launches[1], Boolean);
    assert.deepEqual(raw(), value, "the settlement and its write leave it as stored");
    assert.deepEqual(goals!.metrics(created.id), EMPTY);
  });

  test(`a goal step reads a run's stored observations of another shape as no numbers and goes on: ${label}`, async t => {
    const { f, teams, open } = fixture(t);
    const goals = open();
    const created = await goals.create(finite());
    goals.start();
    const run = (await until(() => teams.launches[0], Boolean)).request.requestId;
    const reviewed = { verdict: "approved" as const, summary: "Approved.", revision: 1 };
    teams.holders.set(run, { run: { revision: 1, headCommit: HEAD_A, review: reviewed, checks: [{ command: check, status: "passed", startedAt: new Date().toISOString(),
      output: "", revision: 1, round: 0, headCommit: HEAD_A }] } as unknown as TeamRun, checkHead: HEAD_A, checkObservations: value });
    teams.settle(run, "ready-for-review", "stopped");
    await until(() => teams.launches[1], Boolean);
    const goal = goals.get(created.id);
    assert.equal(goal.status, "running", JSON.stringify(goal.reason));
    assert.equal("metrics" in f.readRecord<Holder>("goal", created.id), false, "the run gave no numbers, so the goal keeps no entry");
    assert.deepEqual(goals.metrics(created.id), EMPTY);
  });
}
