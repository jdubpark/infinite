import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GoalService } from "../packages/host/src/goals.js";
import { createGoalSchema, parseCreateGoal, type CreateGoal, type GoalCycle, type ProductGoal } from "../packages/host/src/goal-types.js";
import { createRoutineSchema } from "../packages/host/src/routine-types.js";
import { TeamError, type TeamService } from "../packages/host/src/teams.js";
import { emptyUsage } from "../packages/host/src/team-usage.js";
import { createTeamSchema, teamGoalContextSchema, type CreateTeam, type TeamGoalContext, type TeamLineup, type TeamView } from "../packages/host/src/team-types.js";
import type { ProjectSignal, SignalKind, SignalReader } from "../packages/host/src/signals/types.js";
import type { Project } from "../packages/host/src/types.js";
import type { LinearService } from "../packages/host/src/linear.js";
import type { LinearTrackingView } from "../packages/host/src/linear-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  evaluators: [{ id: "evaluator", label: "Evaluator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
};
const minute = 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T, accept: (value: T) => boolean, ms = 8000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const value = read();
    if (accept(value)) return value;
    if (performance.now() > end) throw new Error(`Timed out; last value: ${JSON.stringify(value)?.slice(0, 2000)}`);
    await sleep(20);
  }
}
const action = (goal: ProductGoal) => ({ requestId: randomUUID(), revision: goal.revision });

function stubTeams() {
  const views = new Map<string, TeamView>();
  const launches: { request: CreateTeam; context: TeamGoalContext; lineup: TeamLineup }[] = [];
  const cancels: string[] = [];
  const deliveryAttempts = new Set<string>();
  const usage = () => ({ total: emptyUsage(), byProfile: {}, byProvider: {}, unmeasuredMembers: 0, partialMembers: 0 });
  const service = {
    launches, cancels, deliveryAttempts,
    failNext: undefined as Error | "hang" | undefined,
    get(id: string) {
      const found = views.get(id);
      if (!found) throw new TeamError(404, "team-not-found", "The team was not found.");
      return structuredClone(found);
    },
    goalIdOf: (id: string) => views.get(id)?.goal?.id,
    hasDeliveryAttempt: (id: string) => deliveryAttempts.has(id),
    async createForGoal(request: CreateTeam, context: TeamGoalContext, selected: TeamLineup) {
      createTeamSchema.parse(request); teamGoalContextSchema.parse(context);
      const failure = service.failNext;
      service.failNext = undefined;
      if (failure === "hang") return new Promise<never>(() => {});
      if (failure) throw failure;
      const prior = views.get(request.requestId);
      if (prior) return structuredClone(prior);
      if (Date.now() >= Date.parse(context.deadlineAt)) throw new TeamError(409, "goal-deadline", "The goal reached its deadline.");
      launches.push(structuredClone({ request, context, lineup: selected }));
      const at = new Date().toISOString();
      views.set(request.requestId, { id: request.requestId, projectId: request.projectId, status: "planning", revision: 1, createdAt: at, updatedAt: at,
        goal: structuredClone(context), members: [], tasks: [], usage: usage(), branch: "main", baseCommit: "a".repeat(40) } as unknown as TeamView);
      return service.get(request.requestId);
    },
    settle(id: string, status: string, extra: Partial<TeamView> = {}, members = 0) {
      const view = views.get(id)!;
      Object.assign(view, { status, members: Array.from({ length: members }, () => ({ memberId: randomUUID(), role: "implementer", revision: 1, status: "stopped" })) }, extra);
    },
    async cancel(id: string) { cancels.push(id); service.settle(id, "cancelled"); return service.get(id); },
    async pause(id: string) { service.settle(id, "paused"); return service.get(id); },
    async resume(id: string) { service.settle(id, "planning"); return service.get(id); },
    async removeRun() {},
  };
  return service;
}

function fixture(t: TestContext, mode: "autonomous" | "supervised" = "autonomous") {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T00:00:00.000Z") });
  const f = schedulerFixture();
  f.config.teams = { ...f.config.teams!, lineup };
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] } as Project["team"];
  f.config.projects[0]!.autonomy = mode;
  const teams = stubTeams();
  const services: GoalService[] = [];
  const open = () => { const goals = new GoalService(f.config, f.key, teams as unknown as TeamService); services.push(goals); return goals; };
  const goals = open();
  t.after(() => { for (const service of services) service.close(); f.close(); });
  const advance = (minutes: number) => t.mock.timers.setTime(Date.now() + minutes * minute);
  return { f, teams, goals, open, advance };
}

const standing = (extra: Partial<CreateGoal> = {}, cadenceMinutes = 30, wakeOn?: SignalKind[]): CreateGoal => ({
  requestId: randomUUID(), projectId: "fixture", title: "Keep the fixture healthy", objective: "Find and fix the most useful problem",
  successCriteria: "Each cycle leaves the fixture better", nonGoals: [], allowedPaths: ["."], evidence: [], maxMinutes: 5, maxMembers: 6, parallelism: 3,
  standing: { shape: "objective", cadenceMinutes, ...(wakeOn ? { wakeOn } : {}) }, ...extra } as CreateGoal);

test("a standing objective runs past ten cycles, renews its allowances per cycle, and passes only the 16 newest reviewed cycles", async t => {
  const { f, teams, goals, advance } = fixture(t);
  const created = await goals.create(standing());
  assert.equal(created.maxRuns, undefined);
  goals.start();
  const replacement: TeamLineup = { ...lineup, reviewer: { ...lineup.reviewer, id: "reviewer-next", label: "Next reviewer" } };
  for (let n = 1; n <= 18; n++) {
    const launch = await until(() => teams.launches[n - 1], Boolean);
    assert.equal(launch.context.cycle, n);
    assert.equal(launch.context.deadlineAt, new Date(Date.now() + 5 * minute).toISOString(), `Cycle ${n} gets its own time limit`);
    assert.equal(launch.context.maxMembers, 6, `Cycle ${n} gets the whole attempt allowance`);
    assert.equal(launch.lineup.reviewer.id, n >= 3 ? "reviewer-next" : "reviewer", `Cycle ${n} takes the host lineup current at its start`);
    teams.settle(launch.request.requestId, "ready-for-review", { brief: { title: `Feature ${n}`, expectedOutcome: `Outcome ${n}` } as TeamView["brief"] }, 4);
    await until(() => goals.get(created.id), goal => !goal.activeTeamId);
    if (n === 2) f.config.teams!.lineup = replacement;
    advance(30);
  }
  assert.equal(teams.launches[16]!.context.previousWork.length, 16, "A 17th cycle starts with 16 reviewed cycles behind it");
  assert.deepEqual(teams.launches[17]!.context.previousWork.map(entry => entry.split(":")[0]), Array.from({ length: 16 }, (_, index) => `Feature ${index + 2}`));
  const goal = goals.get(created.id);
  assert.equal(goal.status, "running");
  assert.equal(goal.memberCount, 18 * 4, "Member attempts still sum over every cycle");
  assert.equal(goal.cycles[2]!.lineup?.reviewer.id, "reviewer-next");
  assert.equal(goal.cycles[1]!.lineup?.reviewer.id, "reviewer");
});

test("a cycle past its time limit fails without stopping the goal; three failed cycles in a row pause it, and a resume resets the count", async t => {
  const { teams, goals, advance } = fixture(t);
  const created = await goals.create(standing());
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "blocked", { reason: "Configured checks failed." });
  await until(() => goals.get(created.id), goal => !goal.activeTeamId);
  advance(30);

  const second = await until(() => teams.launches[1], Boolean);
  advance(6);
  await until(() => teams.cancels, ids => ids.includes(second.request.requestId));
  const stopped = await until(() => goals.get(created.id), goal => !goal.activeTeamId);
  assert.equal(stopped.status, "running", "The cycle's time limit does not stop a standing goal");
  assert.deepEqual(stopped.cycles.map(cycle => cycle.class), ["failed", "failed"]);
  advance(30);

  const third = await until(() => teams.launches[2], Boolean);
  teams.settle(third.request.requestId, "blocked", { reason: "Configured checks failed." });
  const paused = await until(() => goals.get(created.id), goal => goal.status === "paused");
  assert.equal(paused.reasonCode, "repeated-failures");
  advance(120);
  await sleep(1200);
  assert.equal(teams.launches.length, 3, "No fourth cycle starts while the goal is paused");

  const resumed = await goals.resume(created.id, action(paused));
  assert.equal(resumed.status, "running");
  const fourth = await until(() => teams.launches[3], Boolean);
  teams.settle(fourth.request.requestId, "blocked", { reason: "Configured checks failed." });
  const after = await until(() => goals.get(created.id), goal => goal.cycles.length === 4 && goal.cycles[3]!.class !== undefined);
  assert.equal(after.status, "running", "The owner's resume reset the failure count");
});

test("a standing goal needs an autonomous project at creation and at each cycle boundary", async t => {
  const { f, teams, goals, advance } = fixture(t, "supervised");
  await assert.rejects(goals.create(standing()), (error: unknown) => error instanceof TeamError && error.code === "standing-requires-autonomy");
  assert.throws(() => createGoalSchema.parse({ ...standing(), maxRuns: 3 }), /no cycle limit/);
  const { requestId: _requestId, standing: shape, ...template } = standing();
  const routine = (goal: object) => ({ requestId: randomUUID(), goal: { ...goal, maxRuns: 1 }, intervalMinutes: 60, maxOccurrences: 2,
    startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  createRoutineSchema.parse(routine(template));
  assert.throws(() => createRoutineSchema.parse(routine({ ...template, standing: shape })), /standing/, "A routine's goal template refuses a standing shape");

  f.config.projects[0]!.autonomy = "autonomous";
  const created = await goals.create(standing());
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  f.config.projects[0]!.autonomy = "supervised";
  teams.settle(first.request.requestId, "ready-for-review");
  const paused = await until(() => goals.get(created.id), goal => goal.status === "paused");
  assert.equal(paused.reasonCode, "supervised-mode");
  await assert.rejects(goals.resume(created.id, action(paused)), (error: unknown) => error instanceof TeamError && error.code === "standing-requires-autonomy");

  f.config.projects[0]!.autonomy = "autonomous";
  await goals.resume(created.id, action(paused));
  advance(30);
  const second = await until(() => teams.launches[1], Boolean);
  assert.equal(second.context.parentRunId, first.request.requestId);
});

test("a halt that outlasts a cycle's window releases a standing goal back to its cadence, unless its project left autonomous mode", async t => {
  const { f, teams, goals, advance } = fixture(t);
  const created = await goals.create(standing());
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "ready-for-review");
  await until(() => goals.get(created.id), goal => goal.cycles.length === 1 && !goal.activeTeamId);

  const everything = () => true, none = () => undefined;
  const halt = { haltId: randomUUID(), reason: "Halted by the owner for the whole host." };
  assert.deepEqual((await goals.haltPause(halt, everything)).map(item => item.result), ["paused"]);
  advance(120);
  assert.equal(teams.launches.length, 1, "A halted goal starts no cycle");
  assert.deepEqual((await goals.haltResume(halt.haltId, none, false)).map(item => item.result), ["resumed"]);
  assert.equal(goals.get(created.id).status, "running");
  const second = await until(() => teams.launches[1], Boolean);
  assert.equal(second.context.parentRunId, first.request.requestId);
  teams.settle(second.request.requestId, "ready-for-review");
  await until(() => goals.get(created.id), goal => goal.cycles.length === 2 && !goal.activeTeamId);

  const later = { haltId: randomUUID(), reason: "Halted by the owner for the whole host." };
  await goals.haltPause(later, everything);
  f.config.projects[0]!.autonomy = "supervised";
  const [refused] = await goals.haltResume(later.haltId, none, false);
  assert.equal(refused?.result, "refused");
  assert.match(refused?.reason ?? "", /autonomous again/);
  const held = goals.get(created.id);
  assert.equal(held.status, "paused");
  advance(120);
  await sleep(100);
  assert.equal(teams.launches.length, 2, "No cycle starts while the goal stays paused");
  f.config.projects[0]!.autonomy = "autonomous";
  await goals.resume(created.id, action(held));
  await until(() => teams.launches[2], Boolean);
});

test("a standing goal folds cycles past the newest 50, never folds the next cycle's parent, and keeps every cycle's usage in its total", async t => {
  const { f, teams, open, advance } = fixture(t);
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * minute).toISOString();
  const total = { ...emptyUsage(), cost: 0.01, messages: 1 };
  const cycles: GoalCycle[] = Array.from({ length: 50 }, (_, index) => ({
    teamId: randomUUID(), cycle: index + 1, goalRevision: 1, status: index === 0 ? "ready-for-review" : "no-change", class: index === 0 ? "reviewed" : "no-change",
    startedAt: at(60 * (50 - index)), finishedAt: at(60 * (50 - index) - 10), settledAt: at(60 * (50 - index) - 10), memberCount: 2, autonomy: "autonomous",
    usage: { ...total, total, byProfile: { light: total }, byProvider: { codex: total }, unmeasuredMembers: 0, partialMembers: 0 },
  }));
  const { requestId, parallelism: _parallelism, ...fields } = parseCreateGoal(standing());
  const goal = { ...fields, id: requestId, parallelism: 4, revision: 1, status: "running", createdAt: at(3000), updatedAt: at(3000), deadlineAt: at(3000), ceilingAt: at(3000),
    lineup, autonomy: "autonomous", cycles, memberCount: 100, steering: [], events: [], outcomes: [] } as ProductGoal;
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  const goals = open();
  goals.start();

  const first = await until(() => teams.launches[0], Boolean);
  assert.equal(first.context.cycle, 51);
  assert.equal(first.context.parentRunId, cycles[0]!.teamId);
  const kept = await until(() => goals.get(goal.id), value => value.activeTeamId === first.request.requestId);
  assert.equal(kept.cycles.length, 51, "The newest 50 cycles and the parent of the next cycle stay");
  assert.equal(kept.cycleTotals, undefined);
  teams.settle(first.request.requestId, "no-change");
  await until(() => goals.get(goal.id), value => !value.activeTeamId);
  advance(30);

  const second = await until(() => teams.launches[1], Boolean);
  assert.equal(second.context.cycle, 52);
  assert.equal(second.context.parentRunId, cycles[0]!.teamId);
  const folded = await until(() => goals.get(goal.id), value => value.activeTeamId === second.request.requestId);
  assert.deepEqual(folded.cycles.slice(0, 2).map(cycle => cycle.cycle), [1, 3]);
  assert.equal(folded.cycles.length, 51);
  assert.deepEqual(folded.cycleTotals, { reviewed: 0, "no-change": 1, failed: 0, excluded: 0 });
  assert.equal(folded.usage?.total.cost, 0.5, "The goal total still includes the folded cycle");
  assert.equal(folded.usage?.total.messages, 50);
  assert.equal(folded.memberCount, 100);
  assert.equal(goals.retainsTeamRun(second.request.requestId), true, "The active cycle's run is retained");
  assert.equal(goals.retainsTeamRun(cycles[0]!.teamId), true, "The next cycle's parent is retained");
  assert.equal(goals.retainsTeamRun(cycles[2]!.teamId), false, "Older cycles follow the normal retention windows");
});

test("a standing goal resumes on its cadence after a restart and coalesces missed starts", async t => {
  const { teams, goals, open, advance } = fixture(t);
  const created = await goals.create(standing({}, 60));
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  advance(10);
  teams.settle(first.request.requestId, "ready-for-review");
  await until(() => goals.get(created.id), goal => goal.cycles[0]!.class === "reviewed");
  goals.close();

  advance(20);
  const restarted = open();
  restarted.start();
  await sleep(1200);
  assert.equal(teams.launches.length, 1, "The cadence still runs from the first cycle's start");
  advance(270);
  const second = await until(() => teams.launches[1], Boolean);
  assert.equal(second.context.cycle, 2);
  teams.settle(second.request.requestId, "no-change");
  await until(() => restarted.get(created.id), goal => goal.cycles[1]!.class === "no-change");
  await sleep(1200);
  assert.equal(teams.launches.length, 2, "Missed starts coalesce into one");
  advance(60);
  await until(() => teams.launches[2], Boolean);
});

test("a host signal starts the next cycle once before its cadence; the goal's own runs and an unreadable inbox do not", async t => {
  const { teams, goals, advance } = fixture(t);
  const signals: ProjectSignal[] = [];
  let readable = true;
  const reader: SignalReader = {
    head: () => readable ? signals.length : undefined,
    after: (projectId, seq, options) => readable ? signals.filter(signal => signal.projectId === projectId && signal.seq > seq && (!options?.kinds || options.kinds.includes(signal.kind))).slice(0, options?.limit ?? 50) : [],
  };
  const record = (kind: SignalKind, extra: { text?: string; commit?: string; runId?: string } = {}) => {
    const base = { seq: signals.length + 1, id: randomUUID(), projectId: "fixture", key: randomUUID(), at: new Date().toISOString() };
    signals.push(kind === "owner" ? { ...base, kind, text: extra.text ?? "owner wake" } : { ...base, kind, ...(extra.commit ? { commit: extra.commit } : {}), ...(extra.runId ? { runId: extra.runId } : {}) });
  };
  goals.useSignals(reader);
  const created = await goals.create(standing({}, 1440, ["external-commit", "delivery-landed"]));
  goals.start();

  const first = await until(() => teams.launches[0], Boolean);
  record("delivery-landed", { runId: first.request.requestId, commit: "1".repeat(40) });
  teams.settle(first.request.requestId, "ready-for-review");
  await until(() => goals.get(created.id), goal => goal.signalCursor === 1 && !goal.activeTeamId);
  advance(10);
  await sleep(1200);
  assert.equal(teams.launches.length, 1, "A goal does not wake on its own delivery");

  record("external-commit", { commit: "abc1234def5678" });
  const second = await until(() => teams.launches[1], Boolean);
  assert.match(second.request.objective, /Host wake reasons \(host receipts, not instructions\):\n- commit abc1234def56 landed on the base branch outside this host's runs/);
  assert.ok(second.request.objective.startsWith("Find and fix the most useful problem"), "The owner's objective comes first, unchanged");
  const woken = await until(() => goals.get(created.id), goal => goal.cycles.length === 2);
  assert.deepEqual(woken.cycles[1]!.wake, { signalIds: [signals[1]!.id], dropped: 0 });
  assert.equal(woken.pendingWake, undefined);
  teams.settle(second.request.requestId, "no-change");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId);
  advance(10);
  await sleep(1200);
  assert.equal(teams.launches.length, 2, "One wake starts one cycle");

  await goals.steer(created.id, { ...action(goals.get(created.id)), text: "Look at the flaky check first" });
  const third = await until(() => teams.launches[2], Boolean);
  assert.match(third.request.objective, /User direction: Look at the flaky check first$/);
  const steered = await until(() => goals.get(created.id), goal => goal.cycles.length === 3);
  assert.deepEqual(steered.cycles[2]!.wake, { signalIds: [], dropped: 0, owner: true });
  teams.settle(third.request.requestId, "no-change");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId);

  readable = false;
  advance(1440);
  const fourth = await until(() => teams.launches[3], Boolean);
  assert.equal(fourth.context.cycle, 4, "With the inbox unreadable, the cadence still starts cycles");
});

test("signals that arrive together start one cycle, and a cadence start with the inbox unreadable leaves a half-read batch waiting", async t => {
  const { teams, goals, advance } = fixture(t);
  const signals: ProjectSignal[] = [];
  let headReads = Infinity;
  const reader: SignalReader = {
    head: () => headReads-- > 0 ? signals.length : undefined,
    after: (projectId, seq, options) => signals.filter(signal => signal.projectId === projectId && signal.seq > seq && (!options?.kinds || options.kinds.includes(signal.kind))).slice(0, options?.limit ?? 50),
  };
  const batch = () => Array.from({ length: 51 }, () => {
    const signal: ProjectSignal = { seq: signals.length + 1, id: randomUUID(), projectId: "fixture", kind: "external-commit", key: randomUUID(), at: new Date().toISOString() };
    signals.push(signal);
    return signal;
  });
  goals.useSignals(reader);
  const created = await goals.create(standing({}, 1440, ["external-commit"]));
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "no-change");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId);
  advance(10);

  const together = batch();
  await until(() => teams.launches[1], Boolean);
  const woken = await until(() => goals.get(created.id), goal => goal.cycles.length === 2);
  assert.deepEqual(woken.cycles[1]!.wake, { signalIds: together.slice(-20).map(signal => signal.id), dropped: 31 });
  assert.equal(woken.signalCursor, 51);
  assert.equal(woken.pendingWake, undefined);
  teams.settle(woken.cycles[1]!.teamId, "no-change");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId);
  advance(10);
  await sleep(1200);
  assert.equal(teams.launches.length, 2, "The rest of the batch starts no second cycle");

  const halfRead = batch();
  headReads = 2;
  await until(() => goals.get(created.id), goal => goal.signalCursor === 101);
  await sleep(1200);
  assert.equal(teams.launches.length, 2, "A wake that may be half a batch starts nothing");
  advance(1440);
  await until(() => teams.launches[2], Boolean);
  const scheduled = await until(() => goals.get(created.id), goal => goal.cycles.length === 3);
  assert.equal(scheduled.cycles[2]!.wake, undefined);
  assert.equal(scheduled.pendingWake?.signals.length, 20);
  assert.doesNotMatch(teams.launches[2]!.request.objective, /Host wake reasons/);

  headReads = Infinity;
  teams.settle(scheduled.cycles[2]!.teamId, "no-change");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId && goal.signalCursor === 102);
  advance(10);
  await until(() => teams.launches[3], Boolean);
  const whole = await until(() => goals.get(created.id), goal => goal.cycles.length === 4);
  assert.deepEqual(whole.cycles[3]!.wake, { signalIds: halfRead.slice(-20).map(signal => signal.id), dropped: 31 });
  assert.equal(whole.pendingWake, undefined);
});

test("a cycle whose reported merge the host did not validate blocks the goal before another cycle starts", async t => {
  const { teams, goals, advance } = fixture(t);
  const created = await goals.create(standing());
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "blocked", { reason: "The delivered tree differs from the reviewed tree.", deliveryReceipt: { revision: 1, headCommit: "b".repeat(40),
    pullRequestUrl: "https://github.com/example/app/pull/1", mergeCommit: "c".repeat(40), summary: "Merged", reportedAt: new Date().toISOString() } });
  const blocked = await until(() => goals.get(created.id), goal => goal.status === "blocked");
  assert.equal(blocked.reasonCode, "external-operation");
  advance(60);
  await sleep(1200);
  assert.equal(teams.launches.length, 1, "Starting from the older parent would redo work that may have landed");
});

test("a finite goal keeps today's request fingerprint, record, retention, and cycle limit", async t => {
  const input = { requestId: randomUUID(), projectId: "fixture", title: "Improve the fixture", objective: "Choose scoped work", successCriteria: "The owner has evidence" };
  assert.equal(JSON.stringify(parseCreateGoal(input)), JSON.stringify({ ...input, nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 3, maxMinutes: 60, maxMembers: 24, parallelism: 3 }));

  const { f, teams, goals } = fixture(t);
  const created = await goals.create({ ...input, requestId: randomUUID(), maxRuns: 2 } as CreateGoal);
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "ready-for-review");
  const second = await until(() => teams.launches[1], Boolean);
  assert.equal(goals.retainsTeamRun(first.request.requestId), true, "A live finite goal retains every cycle's run");
  teams.settle(second.request.requestId, "ready-for-review");
  const done = await until(() => goals.get(created.id), goal => goal.status === "ready-for-review");
  assert.equal(done.cycles.length, 2);
  const stored = f.readRecord<{ goal: ProductGoal }>("goal", created.id).goal as unknown as Record<string, unknown>;
  for (const key of ["standing", "cycleTotals", "foldedUsage", "foldedMembers", "failedCycles", "reasonCode", "signalCursor", "pendingWake", "nextCycleAt"])
    assert.equal(key in stored, false, `A finite goal record has no ${key}`);
  for (const cycle of stored.cycles as Record<string, unknown>[])
    for (const key of ["class", "settledAt", "lineup", "wake", "deadlineStop"]) assert.equal(key in cycle, false, `A finite cycle has no ${key}`);
});

type SavedLaunch = { launch?: { request: CreateTeam; context: TeamGoalContext; wake?: unknown } };

test("a launch whose run was never created passes the mode gate again after a restart, then starts with a fresh window", async t => {
  const { f, teams, goals, open, advance } = fixture(t);
  teams.failNext = "hang";
  const created = await goals.create(standing());
  goals.start();
  const saved = await until(() => f.readRecord<SavedLaunch>("goal", created.id).launch, Boolean);
  goals.close();

  advance(10);
  f.config.projects[0]!.autonomy = "supervised";
  const restarted = open();
  restarted.start();
  const paused = await until(() => restarted.get(created.id), goal => goal.status === "paused");
  assert.equal(paused.reasonCode, "supervised-mode");
  assert.equal(teams.launches.length, 0, "No run starts after the project's authority was withdrawn");
  assert.equal(f.readRecord<SavedLaunch>("goal", created.id).launch, undefined);

  f.config.projects[0]!.autonomy = "autonomous";
  await restarted.resume(created.id, action(paused));
  const first = await until(() => teams.launches[0], Boolean);
  assert.ok(Date.parse(saved.context.deadlineAt) < Date.now());
  assert.equal(first.context.deadlineAt, new Date(Date.now() + 5 * minute).toISOString(), "The unstarted cycle gets a fresh window");
  assert.equal(first.context.cycle, 1);
});

test("a restart past an unstarted cycle's window and creation failures that pass with time do not end a standing goal", async t => {
  const { f, teams, goals, open, advance } = fixture(t);
  teams.failNext = "hang";
  const created = await goals.create(standing());
  goals.start();
  await until(() => f.readRecord<SavedLaunch>("goal", created.id).launch, Boolean);
  goals.close();
  advance(10);
  const restarted = open();
  restarted.start();
  const first = await until(() => teams.launches[0], Boolean);
  assert.equal(first.context.deadlineAt, new Date(Date.now() + 5 * minute).toISOString());
  teams.settle(first.request.requestId, "ready-for-review");
  await until(() => restarted.get(created.id), goal => goal.cycles[0]!.class === "reviewed");

  teams.failNext = new TeamError(507, "host-storage-low", "The team workspace volume is low on space.");
  advance(30);
  const waiting = await until(() => restarted.get(created.id), goal => /could not be created/.test(goal.reason ?? ""));
  assert.equal(waiting.status, "running");
  await sleep(1200);
  assert.equal(teams.launches.length, 1, "The retry waits a minute");
  advance(1);
  const second = await until(() => teams.launches[1], Boolean);
  assert.equal(second.context.cycle, 2);
  const started = await until(() => restarted.get(created.id), goal => goal.activeTeamId === second.request.requestId);
  assert.equal(started.reason, undefined);

  teams.settle(second.request.requestId, "ready-for-review");
  await until(() => restarted.get(created.id), goal => !goal.activeTeamId);
  teams.failNext = new TeamError(409, "provider-not-configured", "Every selected team provider must be configured and available on this host.");
  advance(30);
  await until(() => restarted.get(created.id), goal => goal.status === "blocked");
});

test("pausing a launch whose run was never created keeps its wake for the resume", async t => {
  const { f, teams, goals, open, advance } = fixture(t);
  const signals: ProjectSignal[] = [];
  const reader: SignalReader = { head: () => signals.length, after: (projectId, seq) => signals.filter(signal => signal.projectId === projectId && signal.seq > seq) };
  goals.useSignals(reader);
  const created = await goals.create(standing({}, 1440, ["external-commit"]));
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "no-change");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId);
  advance(10);
  teams.failNext = "hang";
  signals.push({ seq: 1, id: randomUUID(), projectId: "fixture", kind: "external-commit", key: "commit", at: new Date().toISOString(), commit: "abc1234def5678" });
  await until(() => f.readRecord<SavedLaunch>("goal", created.id).launch?.wake, Boolean);
  goals.close();

  const restarted = open();
  restarted.useSignals(reader);
  await restarted.pause(created.id, action(restarted.get(created.id)));
  restarted.start();
  const held = await until(() => restarted.get(created.id), goal => goal.pendingWake !== undefined);
  assert.equal(held.status, "paused");
  assert.equal(held.signalCursor, 1);
  assert.deepEqual(held.pendingWake?.signals.map(signal => signal.id), [signals[0]!.id]);
  assert.equal(f.readRecord<SavedLaunch>("goal", created.id).launch, undefined);

  await restarted.resume(created.id, action(held));
  const woken = await until(() => teams.launches[1], Boolean);
  assert.match(woken.request.objective, /- commit abc1234def56 landed on the base branch outside this host's runs/, "The resume acts on the saved signal, a day before the cadence");
});

test("a delivery member that never launched leaves no open operation; a recorded delivery attempt blocks the goal", async t => {
  const { teams, goals, advance } = fixture(t);
  const created = await goals.create(standing());
  goals.start();
  const delivery = () => [{ memberId: randomUUID(), role: "delivery", revision: 1, status: "stopped" }] as TeamView["members"];
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "blocked", { reason: "The cycle reached its time limit.", members: delivery() });
  const settled = await until(() => goals.get(created.id), goal => goal.cycles[0]!.class !== undefined);
  assert.equal(settled.status, "running", "A queued delivery member is not a delivery attempt");
  advance(30);

  const second = await until(() => teams.launches[1], Boolean);
  teams.deliveryAttempts.add(second.request.requestId);
  teams.settle(second.request.requestId, "blocked", { reason: "The delivery agent stopped.", members: delivery() });
  const blocked = await until(() => goals.get(created.id), goal => goal.status === "blocked");
  assert.equal(blocked.reasonCode, "external-operation");
});

test("a cycle woken by an owner signal records owner, as steering does", async t => {
  const { teams, goals, advance } = fixture(t);
  const signals: ProjectSignal[] = [];
  const reader: SignalReader = { head: () => signals.length, after: (projectId, seq) => signals.filter(signal => signal.projectId === projectId && signal.seq > seq) };
  goals.useSignals(reader);
  const created = await goals.create(standing({}, 1440, ["owner"]));
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "no-change");
  await until(() => goals.get(created.id), goal => !goal.activeTeamId);
  advance(10);

  signals.push({ seq: 1, id: randomUUID(), projectId: "fixture", kind: "owner", key: randomUUID(), at: new Date().toISOString(), text: "Check the login page" });
  const second = await until(() => teams.launches[1], Boolean);
  assert.match(second.request.objective, /User direction: Check the login page$/);
  const woken = await until(() => goals.get(created.id), goal => goal.cycles.length === 2);
  assert.deepEqual(woken.cycles[1]!.wake, { signalIds: [signals[0]!.id], dropped: 0, owner: true });
});

test("a paused or halted standing goal shows no next cycle time, and shows one again after it resumes", async t => {
  const { teams, goals } = fixture(t);
  const created = await goals.create(standing());
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "no-change");
  const between = await until(() => goals.get(created.id), goal => !goal.activeTeamId && goal.cycles[0]!.class !== undefined);
  const due = new Date(Date.now() + 30 * minute).toISOString();
  assert.equal(between.nextCycleAt, due);

  const paused = await goals.pause(created.id, action(between));
  assert.equal(goals.get(created.id).nextCycleAt, undefined, "A paused goal starts no cycle");
  await goals.resume(created.id, action(paused));
  assert.equal(goals.get(created.id).nextCycleAt, due);

  const halt = { haltId: randomUUID(), reason: "Halted by the owner for the whole host." };
  await goals.haltPause(halt, () => true);
  assert.equal(goals.get(created.id).status, "paused");
  assert.equal(goals.get(created.id).nextCycleAt, undefined, "A halted goal starts no cycle");
  await goals.haltResume(halt.haltId, () => undefined, false);
  assert.equal(goals.get(created.id).nextCycleAt, due);
});

test("a cancelled goal's reason says it was cancelled once no team is stopping", async t => {
  const { teams, goals } = fixture(t);
  const stopping = "The goal is stopping its active team. Existing work will remain available.";
  const cancelled = "The owner cancelled this goal. Existing work remains available.";
  const idle = await goals.create(standing());
  goals.start();
  const first = await until(() => teams.launches[0], Boolean);
  teams.settle(first.request.requestId, "no-change");
  const between = await until(() => goals.get(idle.id), goal => !goal.activeTeamId && goal.cycles[0]!.class !== undefined);
  const stopped = await goals.cancel(idle.id, action(between));
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.reason, cancelled);

  const busy = await goals.create(standing());
  const run = await until(() => teams.launches[1], Boolean);
  const active = await until(() => goals.get(busy.id), goal => goal.activeTeamId === run.request.requestId);
  assert.equal((await goals.cancel(busy.id, action(active))).reason, stopping);
  const settled = await until(() => goals.get(busy.id), goal => !goal.activeTeamId);
  assert.equal(settled.reason, cancelled);
});

test("pausing a goal with an active team says the owner paused it once the team has paused, and keeps the team for the resume", async t => {
  const { teams, goals } = fixture(t);
  const created = await goals.create(standing());
  goals.start();
  const run = await until(() => teams.launches[0], Boolean);
  const active = await until(() => goals.get(created.id), goal => goal.activeTeamId === run.request.requestId);
  assert.equal((await goals.pause(created.id, action(active))).reason, "The goal is stopping its active team. Existing work will remain available.");
  const paused = await until(() => goals.get(created.id), goal => goal.reason === "The owner paused this goal. No new work starts until it resumes.");
  assert.equal(paused.status, "paused");
  assert.equal(paused.activeTeamId, run.request.requestId, "The paused team stays attached for the resume");
  assert.equal((await goals.resume(created.id, action(paused))).status, "running");
  await until(() => goals.get(created.id), goal => goal.reason === undefined && goal.activeTeamId === run.request.requestId);
});

test("while Linear tracking holds new work, the goal shows the tracking reason after its prefix and adds nothing to it", async t => {
  const { f, teams } = fixture(t);
  type View = LinearTrackingView & { retryAt?: string };
  const rateLimited = "Linear is rate-limiting this host's requests. Tracking retries at 2026-11-14T00:20:00Z; execution waits until Linear confirms current requirements.";
  let view: View = { status: "pending", reason: rateLimited, retryAt: "2026-11-14T00:20:00Z" };
  const linear = { updateGoal: () => structuredClone(view), getGoal: () => undefined } as unknown as LinearService;
  const goals = new GoalService(f.config, f.key, teams as unknown as TeamService, linear);
  t.after(() => goals.close());
  const created = await goals.create(standing());
  const { standing: _standing, ...template } = standing();
  const finite = await goals.create({ ...template, requestId: randomUUID(), maxRuns: 2 } as CreateGoal);
  goals.start();
  const held = await until(() => [goals.get(created.id), goals.get(finite.id)], all => all.every(goal => goal.reason !== undefined));
  for (const goal of held) {
    assert.equal(goal.status, "running");
    assert.equal(goal.reason, `New work waits for Linear tracking: ${rateLimited}`, "The tracking reason already names the retry time; nothing is added");
  }
  assert.equal(teams.launches.length, 0);

  view = { status: "error", reason: "Linear could not be reached." };
  await until(() => goals.get(created.id), goal => goal.reason === "New work waits for Linear tracking: Linear could not be reached.");

  view = { status: "synced", issue: { id: randomUUID(), identifier: "INF-1", url: "https://linear.example.invalid/issue/INF-1", title: "Goal", description: null, state: { name: "Todo", type: "unstarted" }, updatedAt: "2026-11-14T00:00:00.000Z" } };
  await until(() => teams.launches.length, count => count === 2);
  const started = await until(() => [goals.get(created.id), goals.get(finite.id)], all => all.every(goal => goal.activeTeamId !== undefined));
  for (const goal of started) assert.equal(goal.reason, undefined, "The tracking reason clears once work starts");
});

test("a standing goal refuses an objective over 24,000 bytes; a finite goal keeps its character limit", async t => {
  const { goals } = fixture(t);
  await assert.rejects(goals.create(standing({ objective: "\uAC00".repeat(9000) })),
    (error: unknown) => error instanceof TeamError && error.code === "standing-objective-too-large");
  await goals.create(standing({ objective: "\uAC00".repeat(8000) }));
  const { standing: _standing, ...finite } = standing({ objective: "\uAC00".repeat(9000) });
  await goals.create(finite as CreateGoal);
});
