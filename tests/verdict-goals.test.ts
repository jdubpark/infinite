import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RunAssessment } from "../packages/host/src/verdict-types.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import { CONTINUE_EVENT, DELIVERY_HOLD_REASON, LATE_RECEIPT_EVENT, PROVISIONAL_EVENT, PROVISIONAL_REASON } from "../packages/host/src/goal-verdicts.js";
import { BRIEF, NOTE, SWITCHES, assessmentOf, criterion, finite, hostFixture, outcomeOf, standing, stubFixture, until } from "./fixtures/verdict-goals.js";

const AGENT_ASSESSMENT = "Agent assessment, provisional";
const refused = (code: string, status = 409) => (error: unknown) => error instanceof TeamError && error.status === status && error.code === code;
const action = (goal: ProductGoal) => ({ requestId: randomUUID(), revision: goal.revision });
const BRIEFED = { brief: BRIEF } as const;

test("acceptance 7: a provisional met stops the goal and continue resumes it", { timeout: 300000 }, async () => {
  const f = await hostFixture({ objective: { ...SWITCHES }, mode: "autonomous" });
  try {
    const created = await f.host.fetchApi("/goals", "owner", f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;

    const stopped = await f.stopped(id, value => value.stopReason === "provisional-met");
    assert.equal(stopped.status, "ready-for-review");
    assert.equal(stopped.reason, PROVISIONAL_REASON);
    assert.equal(stopped.cycles.length, 1);
    const first = stopped.cycles[0]!.assessment;
    assert.equal(first?.result, "met", JSON.stringify(stopped.cycles[0]));
    assert.equal(stopped.outcomes.length, 0, "An assessment records no owner outcome");
    assert.equal(stopped.events.filter(event => event.text === PROVISIONAL_EVENT).length, 1);
    const before = (await f.host.fetchApi(`/goals/${id}/record`, "viewer")).body;
    assert.equal(typeof before.version, "number", JSON.stringify(before));

    const summary = "Rank the founders by their sources";
    const answer = await f.host.fetchApi(`/goals/${id}/outcome`, "owner", outcomeOf(stopped, { summary, continue: true, verdictId: first!.verdictId }));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.status, "running");
    assert.equal(answer.body.stopReason, undefined);
    assert.equal(answer.body.outcomes.length, 1);
    assert.equal(answer.body.outcomes[0].result, "not-achieved");
    assert.equal(answer.body.outcomes[0].verdictId, first!.verdictId);
    assert.equal(answer.body.events.filter((event: { text: string }) => event.text === CONTINUE_EVENT).length, 1);
    const after = (await f.host.fetchApi(`/goals/${id}/record`, "viewer")).body;
    assert.equal(after.version, before.version + 1);
    assert.equal(after.record.statement.directions.at(-1).id, `s${answer.body.steering.at(-1).revision}`);
    assert.equal(after.record.statement.directions.at(-1).text, summary);
    assert.match(await f.prompt(id, 2, "project-manager"), new RegExp(`User direction: ${summary}`));

    const second = await f.stopped(id, value => value.cycles.length === 2 && value.stopReason === "provisional-met");
    assert.equal(second.status, "ready-for-review");
    assert.equal(second.cycles[1]!.assessment?.result, "met");
    const achieved = await f.host.fetchApi(`/goals/${id}/outcome`, "owner", outcomeOf(second, { result: "achieved", verdictId: first!.verdictId }));
    assert.equal(achieved.status, 200, JSON.stringify(achieved.body));
    assert.equal(achieved.body.status, "achieved");
    assert.equal(achieved.body.outcomes.length, 2);
    assert.equal(achieved.body.stopReason, undefined, "The owner's answer ends the provisional stop");
    assert.equal(achieved.body.reason, undefined);
  } finally { await f.close(); }
});

test("continue is refused outside a provisional stop", { timeout: 60000 }, async t => {
  const { teams, goals, advance } = stubFixture(t);
  goals.start();

  const timed = await goals.create(finite());
  const one = await until(() => teams.launches[0], Boolean, "cycle 1 of the deadline goal");
  const notMet = assessmentOf(1, 1);
  teams.settle(one.request.requestId, "ready-for-review", { ...BRIEFED, assessment: notMet }, 4);
  const two = await until(() => teams.launches[1], Boolean, "cycle 2 of the deadline goal");
  advance(6);
  await until(() => teams.cancels, ids => ids.includes(two.request.requestId), "the deadline to cancel cycle 2");
  const limited = await until(() => goals.get(timed.id), goal => goal.status === "limit-reached" && !goal.activeTeamId, "the deadline stop");
  assert.equal(limited.stopReason, "deadline");
  assert.equal(limited.cycles[0]!.assessment?.verdictId, notMet.verdictId);
  const unchanged = (goal: ProductGoal) => JSON.stringify(goals.get(goal.id));
  const frozen = unchanged(limited);
  await assert.rejects(goals.outcome(limited.id, { ...outcomeOf(limited, { continue: true, verdictId: notMet.verdictId }) } as never), refused("goal-not-provisional"));
  assert.equal(unchanged(limited), frozen, "A refused continue changes nothing");

  const stopping = await goals.create(finite());
  const three = await until(() => teams.launches[2], Boolean, "cycle 1 of the provisional goal");
  const met = assessmentOf(2, 0);
  teams.settle(three.request.requestId, "ready-for-review", { ...BRIEFED, assessment: met }, 4);
  const provisional = await until(() => goals.get(stopping.id), goal => goal.stopReason === "provisional-met" && !goal.activeTeamId, "the provisional stop");
  assert.equal(provisional.status, "ready-for-review");
  const held = unchanged(provisional);
  await assert.rejects(goals.outcome(provisional.id, outcomeOf(provisional, { continue: true, verdictId: randomUUID() }) as never), refused("verdict-not-found"));
  assert.equal(unchanged(provisional), held, "An unknown verdict changes nothing");
  advance(6);
  await assert.rejects(goals.outcome(provisional.id, outcomeOf(provisional, { continue: true, verdictId: met.verdictId }) as never), refused("goal-limit-reached"));
  assert.equal(unchanged(provisional), held, "A spent allowance changes nothing");
  assert.equal(teams.launches.length, 3, "No cycle started for a refused continue");
});

test("a standing goal records met and counts verdict failures", { timeout: 60000 }, async t => {
  const { teams, goals, advance } = stubFixture(t);
  const created = await goals.create(standing());
  goals.start();
  const settle = async (n: number, met: number, notMet: number) => {
    const launch = await until(() => teams.launches[n - 1], Boolean, `cycle ${n}`);
    teams.settle(launch.request.requestId, "ready-for-review", { ...BRIEFED, assessment: assessmentOf(met, notMet) }, 4);
    return until(() => goals.get(created.id), goal => !goal.activeTeamId && goal.cycles.length === n && goal.cycles[n - 1]!.class !== undefined, `cycle ${n} to settle`);
  };

  const first = await settle(1, 2, 0);
  assert.equal(first.status, "running");
  assert.equal(first.stopReason, undefined);
  assert.equal(first.cycles[0]!.assessment?.result, "met");
  assert.equal(first.cycles[0]!.assessment?.progress, 2);
  assert.equal(first.failedCycles, 0);
  advance(30);

  const second = await settle(2, 1, 1);
  assert.equal(second.cycles[1]!.class, "reviewed", "A failing verdict keeps the cycle's class");
  assert.equal(second.cycles[1]!.assessment?.progress, -1);
  assert.equal(second.failedCycles, 1);
  advance(30);
  const third = await settle(3, 1, 1);
  assert.equal(third.failedCycles, 2);
  assert.equal(third.status, "running");
  advance(30);
  await settle(4, 1, 1);
  const paused = await until(() => goals.get(created.id), goal => goal.status === "paused", "the pause after three failing verdicts");
  assert.equal(paused.reasonCode, "repeated-failures");
  assert.equal(paused.cycles.length, 4);
  advance(30);

  const resumed = await goals.resume(created.id, action(paused));
  assert.equal(resumed.status, "running");
  assert.equal(resumed.failedCycles, 0);
  const fifth = await settle(5, 1, 1);
  assert.equal(fifth.status, "running", "One failing verdict after the resume does not pause the goal");
  assert.equal(fifth.failedCycles, 1);
});

test("a verdict counts toward the failure stop only on a reviewed cycle", { timeout: 60000 }, async t => {
  const { teams, goals, advance } = stubFixture(t);
  const created = await goals.create(standing());
  goals.start();
  const settle = async (n: number, status: string, assessment: RunAssessment, extra: Record<string, unknown> = {}) => {
    const launch = await until(() => teams.launches[n - 1], Boolean, `cycle ${n}`);
    teams.settle(launch.request.requestId, status, { ...BRIEFED, assessment, ...extra }, 4);
    const settled = await until(() => goals.get(created.id), goal => !goal.activeTeamId && goal.cycles.length === n && goal.cycles[n - 1]!.class !== undefined, `cycle ${n} to settle`);
    advance(30);
    return settled;
  };
  const quiet = (): RunAssessment => ({ ...assessmentOf(0, 0), kind: "no-change", result: "inconclusive" });

  const failing = await settle(1, "ready-for-review", assessmentOf(0, 2));
  assert.equal(failing.cycles[0]!.class, "reviewed");
  assert.equal(failing.failedCycles, 1);

  const excluded = await settle(2, "blocked", assessmentOf(0, 2), { blockCode: "provider-limit", reason: "The provider is limited." });
  assert.equal(excluded.cycles[1]!.class, "excluded");
  assert.equal(excluded.failedCycles, 1);

  for (let n = 3; n <= 5; n++) {
    const quietly = await settle(n, "no-change", quiet(), { reason: "No further work is justified." });
    assert.equal(quietly.cycles[n - 1]!.class, "no-change");
    assert.equal(quietly.failedCycles, 0, `Quiet cycle ${n} resets the count`);
    assert.equal(quietly.status, "running");
  }
});

test("acceptance 10 end to end", { timeout: 300000 }, async () => {
  const f = await hostFixture({ objective: { ...SWITCHES }, mode: "autonomous" });
  try {
    f.verdictFile(1, { kind: "verdict", result: "not-met", criteria: ["c0", "c1", "c2"].map(id => ({ id, state: id === "c2" ? "not-met" : "met",
      evidence: ["file:features/progress.json"], ...(id === "c2" ? { note: NOTE } : {}) })) });
    const created = await f.host.fetchApi("/goals", "owner", f.create({ maxRuns: 2, criteria: [criterion("Every source is named", "sources"), criterion("Every claim is checked", "claims")] } as never));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;

    const manager = await f.prompt(id, 2, "project-manager");
    assert.ok(manager.includes(AGENT_ASSESSMENT), "The rows are labelled an agent assessment");
    assert.match(manager, /- c2: not-met \(judgement:claims\)/);
    assert.match(manager, /- c1: met \(judgement:sources\)/);
    assert.ok(!manager.includes(NOTE), "No note reaches a prompt");
    for (const hidden of ["threshold", "notMet", "pendingOwner", "gpt-6-astra"]) assert.ok(!manager.includes(hidden), `The coordinator's prompt holds no ${hidden}`);
    const implementer = await f.prompt(id, 2, "implementer");
    assert.ok(!implementer.includes(AGENT_ASSESSMENT), "No other role's prompt holds a row");
    assert.ok(!implementer.includes("not-met"), "The implementer's prompt holds no verdict");

    const goal = await f.stopped(id, value => value.cycles.length === 2);
    assert.equal(goal.cycles[0]!.assessment?.result, "not-met");
    assert.equal(goal.cycles[0]!.assessment?.counts.notMet, 1);
    assert.equal(goal.stopReason, "provisional-met", "Cycle 2 held no verdict file, so every criterion was met");
  } finally { await f.close(); }
});

test("a supervised goal shows the verdict and changes nothing", { timeout: 300000 }, async () => {
  const f = await hostFixture({ objective: { ...SWITCHES }, mode: "supervised" });
  try {
    const created = await f.host.fetchApi("/goals", "owner", f.create({ maxRuns: 2, criteria: [criterion("Every source is named", "sources")] } as never));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;

    const manager = await f.prompt(id, 2, "project-manager");
    assert.ok(!manager.includes(AGENT_ASSESSMENT), "No rows reach a supervised goal's next cycle");
    const goal = await f.stopped(id, value => value.cycles.length === 2);
    assert.equal(goal.cycles[0]!.assessment?.result, "met", "The verdict is shown");
    assert.ok(goal.cycles.every(cycle => cycle.assessment !== undefined));
    assert.notEqual(goal.stopReason, "provisional-met");
    assert.ok(!goal.events.some(event => event.text === PROVISIONAL_EVENT), "A met verdict stops nothing");
    assert.ok((goal.failedCycles ?? 0) === 0, "The failure count is as today");
  } finally { await f.close(); }
});

test("an owner outcome without continue ends the provisional stop and keeps the goal stopped", { timeout: 60000 }, async t => {
  const { teams, goals } = stubFixture(t);
  const created = await goals.create(finite());
  goals.start();
  const launch = await until(() => teams.launches[0], Boolean, "cycle 1");
  const met = assessmentOf(2, 0);
  teams.settle(launch.request.requestId, "ready-for-review", { ...BRIEFED, assessment: met }, 4);
  const provisional = await until(() => goals.get(created.id), goal => goal.stopReason === "provisional-met" && !goal.activeTeamId, "the provisional stop");
  assert.equal(provisional.reason, PROVISIONAL_REASON);
  const answered = await goals.outcome(created.id, outcomeOf(provisional, { verdictId: met.verdictId }) as never);
  assert.equal(answered.status, "ready-for-review");
  assert.equal(answered.stopReason, undefined);
  assert.equal(answered.reason, undefined);
  assert.equal(answered.outcomes.length, 1);
});

test("without verdicts a goal is as today", { timeout: 300000 }, async () => {
  const { evaluator: _evaluator, ...without } = SWITCHES;
  const f = await hostFixture({ objective: { ...without }, mode: "autonomous" });
  try {
    f.verdictFile(1, { kind: "verdict", result: "not-met", criteria: [{ id: "c0", state: "not-met", evidence: [] }] });
    const created = await f.host.fetchApi("/goals", "owner", f.create({ maxRuns: 2 }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;

    const manager = await f.prompt(id, 2, "project-manager");
    assert.ok(!manager.includes(AGENT_ASSESSMENT), "No rows reach cycle 2's context");
    assert.ok(!manager.includes("Agent assessment"));
    const goal = await f.stopped(id, value => value.cycles.length === 2);
    assert.equal(goal.cycles.length, 2);
    assert.ok(goal.cycles.every(cycle => !("assessment" in cycle)), "No cycle holds an assessment");
    assert.notEqual(goal.stopReason, "provisional-met");
    assert.ok(!goal.events.some(event => event.text === PROVISIONAL_EVENT));
    assert.ok(!goal.events.some(event => event.text === LATE_RECEIPT_EVENT || event.text === DELIVERY_HOLD_REASON), "No hold and no late receipt reach a goal without verdicts");
    assert.ok(goal.cycles.every(cycle => !("supersededVerdictIds" in cycle)));

    const stray = await f.host.fetchApi(`/goals/${id}/outcome`, "owner", outcomeOf(goal, { verdictId: randomUUID() }));
    assert.equal(stray.status, 409, JSON.stringify(stray.body));
    assert.equal(stray.body.code, "verdict-not-found");
    const recorded = await f.host.fetchApi(`/goals/${id}/outcome`, "owner", outcomeOf(goal, { result: "achieved" }));
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    assert.equal(recorded.body.status, "achieved");
    assert.equal(recorded.body.outcomes.length, 1);
    assert.ok(!("verdictId" in recorded.body.outcomes[0]));
  } finally { await f.close(); }
});

const HEAD = "a".repeat(40);
const waiting = (): RunAssessment => ({ verdictId: randomUUID(), revision: 1, head: HEAD, kind: "reviewed", result: "inconclusive",
  counts: { met: 1, notMet: 0, inconclusive: 1, pendingOwner: 0 }, criteria: [{ id: "c0", state: "met" }, { id: "c1", state: "inconclusive" }], at: new Date().toISOString() });
const detailOf = (assessment: RunAssessment, reason: string) => ({ verdictId: assessment.verdictId, revision: 1, head: HEAD,
  criteria: assessment.criteria.map(item => ({ id: item.id, producer: "host", state: item.state, ...(item.state === "inconclusive" ? { reason } : {}) })) }) as never;
const count = (goal: ProductGoal, text: string) => goal.events.filter(event => event.text === text).length;

test("a goal holds its next launch for a delivery receipt and stops provisional-met when it arrives", { timeout: 60000 }, async t => {
  const { teams, goals } = stubFixture(t, "autonomous", true);
  const created = await goals.create(finite({ maxMinutes: 240 }));
  goals.start();
  const launch = await until(() => teams.launches[0], Boolean, "cycle 1");
  const teamId = launch.request.requestId;
  const first = waiting();
  teams.settle(teamId, "merged", { ...BRIEFED, assessment: first }, 4);
  teams.detail(teamId, detailOf(first, "before-delivery"));

  const held = await until(() => goals.get(created.id), goal => goal.reason === DELIVERY_HOLD_REASON, "the hold");
  assert.equal(held.status, "running");
  await new Promise(done => setTimeout(done, 1300));
  assert.equal(count(goals.get(created.id), DELIVERY_HOLD_REASON), 1);
  assert.equal(teams.launches.length, 1);

  const late = assessmentOf(2, 0);
  teams.settle(teamId, "merged", { assessment: late });
  const stopped = await until(() => goals.get(created.id), goal => goal.status === "ready-for-review", "the stop at the goal's own step");
  assert.equal(stopped.stopReason, "provisional-met");
  assert.equal(stopped.reason, PROVISIONAL_REASON);
  assert.equal(stopped.cycles[0]!.assessment?.verdictId, late.verdictId);
  assert.deepEqual(stopped.cycles[0]!.supersededVerdictIds, [first.verdictId]);
  assert.equal(count(stopped, LATE_RECEIPT_EVENT), 1);
  assert.equal(count(stopped, PROVISIONAL_EVENT), 1);
  assert.equal(teams.launches.length, 1);
  assert.equal(teams.cancels.length, 0);

  const reverted = assessmentOf(1, 1);
  teams.settle(teamId, "merged", { assessment: reverted });
  await goals.syncReceipts();
  const after = goals.get(created.id);
  assert.equal(after.cycles[0]!.assessment?.verdictId, reverted.verdictId);
  assert.deepEqual(after.cycles[0]!.supersededVerdictIds, [first.verdictId, late.verdictId]);
  assert.equal(after.stopReason, "provisional-met");
  assert.equal(after.reason, PROVISIONAL_REASON);
  assert.equal(count(after, PROVISIONAL_EVENT), 1);
  const answered = await goals.outcome(created.id, outcomeOf(after, { verdictId: first.verdictId }) as never);
  assert.equal(answered.outcomes.length, 1, "The owner's answer names an earlier id and is accepted");
});

test("a hold that does not apply launches as today", { timeout: 120000 }, async t => {
  const { teams, goals, advance, config } = stubFixture(t, "autonomous", true);
  const cycleTwo = async (id: string, assessment: RunAssessment | undefined, reason: string, extra: Partial<RunAssessment> = {}) => {
    const launch = await until(() => teams.launches.filter(item => item.context.id === id)[0], Boolean, "cycle 1");
    const given = assessment === undefined ? undefined : { ...assessment, ...extra };
    teams.settle(launch.request.requestId, "merged", { ...BRIEFED, ...(given ? { assessment: given } : {}) }, 4);
    if (given) teams.detail(launch.request.requestId, detailOf(given, reason));
    await until(() => teams.launches.filter(item => item.context.id === id).length, length => length === 2, "cycle 2");
    const goal = goals.get(id);
    assert.notEqual(goal.reason, DELIVERY_HOLD_REASON);
    assert.equal(count(goal, DELIVERY_HOLD_REASON), 0);
    await goals.cancel(id, action(goal));
  };
  const start = async () => { const goal = await goals.create(finite({ maxMinutes: 240 })); goals.start(); return goal.id; };

  await cycleTwo(await start(), waiting(), "evaluator-unavailable");
  await cycleTwo(await start(), waiting(), "before-delivery", { counts: { met: 0, notMet: 1, inconclusive: 1, pendingOwner: 0 } });
  const quiet = await start();
  await cycleTwo(quiet, undefined, "");
  const unread = JSON.stringify(goals.get(quiet));
  await goals.syncReceipts();
  assert.equal(JSON.stringify(goals.get(quiet)), unread, "A goal without a verdict is neither read nor saved");

  config.projects[0]!.autonomy = "supervised";
  await cycleTwo(await start(), waiting(), "before-delivery");
  config.projects[0]!.autonomy = "autonomous";
  config.projects[0]!.source = { mode: "laptop" };
  await cycleTwo(await start(), waiting(), "before-delivery");
  config.projects[0]!.source = { mode: "github", repository: "example/fixture", baseBranch: "main" };

  const id = await start();
  const launch = await until(() => teams.launches.filter(item => item.context.id === id)[0], Boolean, "cycle 1");
  const open = waiting();
  teams.settle(launch.request.requestId, "merged", { ...BRIEFED, assessment: open }, 4);
  teams.detail(launch.request.requestId, detailOf(open, "before-delivery"));
  await until(() => goals.get(id).reason, reason => reason === DELIVERY_HOLD_REASON, "the hold");
  advance(9);
  await new Promise(done => setTimeout(done, 1200));
  assert.equal(teams.launches.filter(item => item.context.id === id).length, 1, "Nine minutes in, the goal still waits");
  advance(2);
  await until(() => teams.launches.filter(item => item.context.id === id).length, length => length === 2, "the launch after the hold");
  const released = goals.get(id);
  assert.notEqual(released.reason, DELIVERY_HOLD_REASON);
  assert.equal(count(released, DELIVERY_HOLD_REASON), 1);
});

test("a late receipt changes only the cycle in every other goal state", { timeout: 120000 }, async t => {
  const { teams, goals } = stubFixture(t, "autonomous", true);
  const start = async (extra = {}) => { const goal = await goals.create(finite({ maxMinutes: 240, ...extra })); goals.start(); return goal.id; };
  const firstOf = async (id: string, assessment: RunAssessment, n = 1) => {
    const launch = await until(() => teams.launches.filter(item => item.context.id === id)[n - 1], Boolean, `cycle ${n}`);
    teams.settle(launch.request.requestId, "merged", { ...BRIEFED, assessment }, 4);
    return launch.request.requestId;
  };
  const unchanged = (after: ProductGoal, before: ProductGoal) => {
    assert.equal(after.status, before.status);
    assert.equal(after.reason, before.reason);
    assert.equal(after.stopReason, before.stopReason);
    assert.equal(after.activeTeamId, before.activeTeamId);
  };

  const limited = await start({ maxRuns: 1 });
  const first = waiting();
  const limitedTeam = await firstOf(limited, first);
  const atLimit = await until(() => goals.get(limited), goal => goal.status === "ready-for-review" && !goal.activeTeamId, "the run limit");
  const late = assessmentOf(2, 0);
  teams.settle(limitedTeam, "merged", { assessment: late });
  await goals.syncReceipts();
  const changed = goals.get(limited);
  assert.equal(changed.cycles[0]!.assessment?.verdictId, late.verdictId);
  assert.deepEqual(changed.cycles[0]!.supersededVerdictIds, [first.verdictId]);
  unchanged(changed, atLimit);
  assert.equal(count(changed, PROVISIONAL_EVENT), 0);
  const achieved = await goals.outcome(limited, outcomeOf(changed, { result: "achieved" }) as never);
  const third = assessmentOf(1, 1);
  teams.settle(limitedTeam, "merged", { assessment: third });
  await goals.syncReceipts();
  const afterAchieved = goals.get(limited);
  assert.equal(afterAchieved.cycles[0]!.assessment?.verdictId, third.verdictId);
  assert.equal(afterAchieved.status, "achieved");
  assert.equal(afterAchieved.outcomes.length, achieved.outcomes.length);

  const running = await start({ maxRuns: 3 });
  const oldTeam = await firstOf(running, waiting());
  await until(() => teams.launches.filter(item => item.context.id === running).length, length => length === 2, "cycle 2");
  const busy = goals.get(running);
  const newer = assessmentOf(2, 0);
  teams.settle(oldTeam, "merged", { assessment: newer });
  await goals.syncReceipts();
  const olderChanged = goals.get(running);
  assert.equal(olderChanged.cycles[0]!.assessment?.verdictId, newer.verdictId);
  unchanged(olderChanged, busy);
  assert.equal(teams.launches.filter(item => item.context.id === running).length, 2);
  await goals.cancel(running, action(olderChanged));

  const paused = await start({ maxRuns: 3 });
  const pausedFirst = waiting();
  const pausedTeam = await firstOf(paused, pausedFirst);
  teams.detail(pausedTeam, detailOf(pausedFirst, "before-delivery"));
  await until(() => goals.get(paused).reason, reason => reason === DELIVERY_HOLD_REASON, "the hold");
  const pausedGoal = await goals.pause(paused, action(goals.get(paused)));
  teams.settle(pausedTeam, "merged", { assessment: assessmentOf(2, 0) });
  await goals.syncReceipts();
  const stillPaused = goals.get(paused);
  assert.equal(stillPaused.cycles[0]!.assessment?.result, "met");
  unchanged(stillPaused, pausedGoal);
  assert.equal(stillPaused.status, "paused");
  assert.equal(teams.launches.filter(item => item.context.id === paused).length, 1);
  await goals.resume(paused, action(stillPaused));
  const resumed = await until(() => goals.get(paused), goal => goal.status !== "running" || teams.launches.filter(item => item.context.id === paused).length > 1, "the stop after the resume");
  assert.equal(resumed.status, "ready-for-review");
  assert.equal(resumed.stopReason, "provisional-met");
  assert.equal(count(resumed, PROVISIONAL_EVENT), 1);
  assert.equal(teams.launches.filter(item => item.context.id === paused).length, 1, "A cycle that turned met while the goal was paused stops it at the resume");

  const active = await start({ maxRuns: 3 });
  const activeTeam = (await until(() => teams.launches.filter(item => item.context.id === active)[0], Boolean, "cycle 1")).request.requestId;
  const stopping = [{ memberId: randomUUID(), role: "implementer", revision: 1, status: "running" }] as never;
  const activeFirst = waiting();
  teams.settle(activeTeam, "merged", { ...BRIEFED, assessment: activeFirst, members: stopping });
  await until(() => goals.get(active).cycles[0]?.assessment?.verdictId, id => id === activeFirst.verdictId, "the first verdict of an active team");
  const activeLate = assessmentOf(1, 1);
  teams.settle(activeTeam, "merged", { assessment: activeLate, members: stopping });
  const copied = await until(() => goals.get(active), goal => goal.cycles[0]?.assessment?.verdictId === activeLate.verdictId, "the late verdict of an active team");
  assert.deepEqual(copied.cycles[0]!.supersededVerdictIds, [activeFirst.verdictId]);
  assert.equal(count(copied, LATE_RECEIPT_EVENT), 1);
  assert.equal(copied.activeTeamId, activeTeam);
  await goals.cancel(active, action(copied));

  const standingGoal = await goals.create(standing());
  const standingTeam = await firstOf(standingGoal.id, waiting());
  const idle = await until(() => goals.get(standingGoal.id), goal => !goal.activeTeamId && goal.cycles[0]?.class !== undefined, "the standing cycle");
  teams.settle(standingTeam, "merged", { assessment: assessmentOf(2, 0) });
  await goals.syncReceipts();
  const standingAfter = goals.get(standingGoal.id);
  assert.equal(standingAfter.cycles[0]!.assessment?.result, "met");
  unchanged(standingAfter, idle);
  assert.equal(standingAfter.status, "running");
  assert.equal(count(standingAfter, PROVISIONAL_EVENT), 0);
  await goals.cancel(standingGoal.id, action(standingAfter));

  const gone = assessmentOf(2, 0);
  teams.settle(limitedTeam, "merged", { assessment: gone });
  teams.forget(limitedTeam);
  await goals.syncReceipts();
  assert.equal(goals.get(limited).cycles[0]!.assessment?.verdictId, third.verdictId);
});
