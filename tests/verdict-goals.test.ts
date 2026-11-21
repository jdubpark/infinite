import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RunAssessment } from "../packages/host/src/verdict-types.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import { CONTINUE_EVENT, PROVISIONAL_EVENT, PROVISIONAL_REASON } from "../packages/host/src/goal-verdicts.js";
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

    // Cycle 1's evaluator finds the goal's one criterion met: the goal stops for the owner, and no agent marks it achieved.
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

    // Not achieved, and continue: the goal runs again on a new record version that carries the owner's direction.
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

    // Cycle 2 stops the same way, and only the owner's outcome marks the goal achieved.
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

  // A goal that a deadline stopped, after a cycle that held an assessment and no provisional stop.
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

  // A goal that a provisional met stopped: an unknown verdict, then a spent allowance.
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

  // A met verdict never stops a standing goal: it records the assessment, and the next cycle comes at its cadence.
  const first = await settle(1, 2, 0);
  assert.equal(first.status, "running");
  assert.equal(first.stopReason, undefined);
  assert.equal(first.cycles[0]!.assessment?.result, "met");
  assert.equal(first.cycles[0]!.assessment?.progress, 2);
  assert.equal(first.failedCycles, 0);
  advance(30);

  // Three failing verdicts in a row (fewer criteria met, then no gain) pause it.
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

  // An owner's resume resets the count.
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

  // An excluded cycle leaves the count alone, whatever its assessment says.
  const excluded = await settle(2, "blocked", assessmentOf(0, 2), { blockCode: "provider-limit", reason: "The provider is limited." });
  assert.equal(excluded.cycles[1]!.class, "excluded");
  assert.equal(excluded.failedCycles, 1);

  // Quiet no-change cycles reset the count and never pause the goal.
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
    // Cycle 1's evaluator finds c1 met and c2 not met, and leaves a note on c2.
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

    // Every criterion is met in cycle 1, and the supervised goal goes on to cycle 2 as it does without verdicts.
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

    // An outcome without a verdictId records as today; a verdictId that names no assessment is refused.
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
