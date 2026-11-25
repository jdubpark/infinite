import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { goalOutcomeSchema, type GoalCycle, type GoalAssessment, type ProductGoal } from "../packages/host/src/goal-types.js";
import {
  CONTINUE_EVENT,
  DELIVERY_HOLD_MS,
  DELIVERY_HOLD_REASON,
  LATE_RECEIPT_EVENT,
  PROVISIONAL_EVENT,
  PROVISIONAL_REASON,
  assertVerdictAnswer,
  continueGoal,
  answerProvisional,
  criteriaRowsFor,
  cycleVerdict,
  deliveryHold,
  owedStop,
  lateVerdict,
  provisionalStop,
  verdictFailed,
  verdictIdsOf,
} from "../packages/host/src/goal-verdicts.js";
import { createGoalObjective, correctGoalObjective, goalObjectiveView, type GoalHolder } from "../packages/host/src/objective-goals.js";
import { recordDigest, type ObjectiveRecord } from "../packages/host/src/objective-types.js";
import type { VerdictDetail } from "../packages/host/src/team-verdicts.js";
import type { RunAssessment } from "../packages/host/src/verdict-types.js";
import type { Project } from "../packages/host/src/types.js";
import { TeamError } from "../packages/host/src/team-workspace.js";

const AT = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const HEAD = "a".repeat(40);

function assessment(overrides: Partial<RunAssessment> = {}): RunAssessment {
  return {
    verdictId: randomUUID(), revision: 1, head: HEAD, kind: "reviewed", result: "met",
    counts: { met: 1, notMet: 0, inconclusive: 0, pendingOwner: 0 }, criteria: [{ id: "c0", state: "met" }], at: AT, ...overrides,
  };
}
const withMet = (met: number, overrides: Partial<RunAssessment> = {}) =>
  assessment({ counts: { met, notMet: 0, inconclusive: 0, pendingOwner: 0 }, ...overrides });

function cycle(number: number, overrides: Partial<GoalCycle> = {}): GoalCycle {
  return { teamId: `team-${number}`, cycle: number, goalRevision: 1, status: "ready-for-review", startedAt: AT, memberCount: 1, ...overrides };
}

function goal(overrides: Record<string, unknown> = {}): ProductGoal {
  return {
    id: randomUUID(), projectId: "fixture", title: "Rank sources", objective: "Find ranked sources",
    successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["research"], evidence: [],
    maxRuns: 3, maxMinutes: 60, maxTotalMinutes: 60, maxMembers: 4, parallelism: 2,
    revision: 1, status: "running", createdAt: AT, updatedAt: AT,
    deadlineAt: "2026-01-01T01:00:00.000Z", ceilingAt: "2026-01-01T01:00:00.000Z",
    lineup: {}, memberCount: 1, cycles: [], steering: [], events: [], outcomes: [], autonomy: "autonomous",
    ...overrides,
  } as unknown as ProductGoal;
}

const team = (overrides: Record<string, unknown> = {}) => ({ id: "team-1", revision: 1, assessment: undefined as RunAssessment | undefined, ...overrides });

test("cycle verdicts copy the current revision and compute progress", () => {
  const current = assessment({ revision: 2 });
  const copied = cycleVerdict(goal({ cycles: [cycle(1)] }), cycle(1), team({ revision: 2, assessment: current }));
  assert.equal(copied.assessment?.verdictId, current.verdictId);
  assert.equal(copied.assessment?.progress, 1);
  const stale = assessment({ revision: 1 });
  const held = cycle(1, { assessment: { ...stale, progress: 1 } });
  const dropped = cycleVerdict(goal({ cycles: [held] }), held, team({ revision: 2, assessment: stale }));
  assert.equal(Object.hasOwn(dropped, "assessment"), true);
  assert.equal(dropped.assessment, undefined);
  const gone = cycleVerdict(goal({ cycles: [held] }), held, team({ revision: 2 }));
  assert.equal(gone.assessment, undefined);
  assert.equal(Object.hasOwn(gone, "assessment"), true);
  const plain = cycle(1);
  assert.equal(Object.keys(cycleVerdict(goal({ cycles: [plain] }), plain, team({ revision: 2, assessment: stale }))).length, 0);
  assert.equal(Object.keys(cycleVerdict(goal({ cycles: [plain] }), plain, team({ revision: 2 }))).length, 0);
  assert.equal(Object.hasOwn(dropped, "supersededVerdictIds"), true);
  assert.equal(dropped.supersededVerdictIds, undefined);
  assert.equal(Object.hasOwn(gone, "supersededVerdictIds"), true);
  const fresh = cycleVerdict(goal({ cycles: [plain] }), plain, team({ revision: 2, assessment: current }));
  assert.deepEqual(Object.keys(fresh), ["assessment"]);
  const same = cycle(1, { assessment: { ...current, progress: 1 }, supersededVerdictIds: ["old"] });
  const again = cycleVerdict(goal({ cycles: [same] }), same, team({ revision: 2, assessment: current }));
  assert.deepEqual(Object.keys(again), ["assessment"]);
  const first = assessment({ revision: 1 });
  const base = cycle(1, { assessment: { ...first, progress: 1 }, supersededVerdictIds: ["a", "b"] });
  const later = assessment({ revision: 1 });
  const replaced = cycleVerdict(goal({ cycles: [base] }), base, team({ assessment: later }));
  assert.equal(replaced.assessment?.verdictId, later.verdictId);
  assert.deepEqual(replaced.supersededVerdictIds, ["a", "b", first.verdictId]);
  const full = cycle(1, { assessment: { ...first, progress: 1 }, supersededVerdictIds: ["a", "b", "c", "d"] });
  assert.deepEqual(cycleVerdict(goal({ cycles: [full] }), full, team({ assessment: later })).supersededVerdictIds, ["b", "c", "d", first.verdictId]);
  const moved = cycleVerdict(goal({ cycles: [base] }), base, team({ assessment: assessment({ head: "b".repeat(40) }) }));
  assert.equal(Object.hasOwn(moved, "supersededVerdictIds"), true);
  assert.equal(moved.supersededVerdictIds, undefined);
  assert.equal(moved.assessment?.head, "b".repeat(40));
  assert.deepEqual(verdictIdsOf(cycle(1)), []);
  assert.deepEqual(verdictIdsOf(base), [first.verdictId, "b", "a"]);
  const late = (held: GoalCycle, assessed: RunAssessment | undefined, revision = 1) => lateVerdict(goal({ cycles: [held] }), held, team({ revision, assessment: assessed }));
  assert.equal(late(base, later)?.assessment.verdictId, later.verdictId);
  assert.deepEqual(late(base, later)?.supersededVerdictIds, ["a", "b", first.verdictId]);
  assert.equal(late(base, undefined), undefined);
  assert.equal(late(base, later, 2), undefined);
  assert.equal(late(plain, later), undefined);
  assert.equal(late(base, first), undefined);
  assert.equal(late(base, assessment({ head: "b".repeat(40) })), undefined);
  assert.equal(late(cycle(1, { assessment: { ...first, progress: 1 } }), assessment({ revision: 2 }), 2), undefined);
  const progress: number[] = [];
  const cycles: GoalCycle[] = [];
  for (const [index, met] of [1, 3, 3].entries()) {
    const next = cycle(index + 1);
    const result = cycleVerdict(goal({ cycles }), next, team({ id: next.teamId, assessment: withMet(met) }));
    assert.ok(result.assessment);
    progress.push(result.assessment.progress);
    next.assessment = result.assessment;
    cycles.push(next);
  }
  assert.deepEqual(progress, [1, 2, 0]);
});

test("a provisional stop needs an autonomous finite goal and a met reviewed verdict", () => {
  const good = assessment();
  const stop = (overrides: Record<string, unknown>, assessed: RunAssessment | null = good, revision = 1) =>
    provisionalStop(goal({ cycles: [cycle(1)], ...overrides }), team({ revision, assessment: assessed ?? undefined }));
  assert.equal(stop({}), true);
  assert.equal(stop({ autonomy: "supervised" }), false);
  assert.equal(stop({ autonomy: undefined }), false);
  assert.equal(stop({ standing: { shape: "objective", cadenceMinutes: 60 } }), false);
  assert.equal(stop({}, assessment({ kind: "no-change" })), false);
  assert.equal(stop({}, assessment({ result: "not-met" })), false);
  assert.equal(stop({}, assessment({ result: "inconclusive" })), false);
  assert.equal(stop({}, good, 2), false);
  assert.equal(stop({}, null), false);
  assert.equal(provisionalStop(goal({ cycles: [] }), team({ assessment: good })), false);
  const stopOf = (overrides: Record<string, unknown> = {}, held: RunAssessment | null = good, busy = false, newest = true, extra: Partial<GoalCycle> = {}) => {
    const target = cycle(1, { ...(held === null ? {} : { assessment: { ...held, progress: 1 } }), ...extra });
    return owedStop(goal({ cycles: newest ? [target] : [target, cycle(2)], ...overrides }), busy);
  };
  const answered = (verdictId?: string) => ({ outcomes: [{ result: "not-achieved", summary: "s", evidence: "e", at: AT, revision: 1, ...(verdictId === undefined ? {} : { verdictId }) }] });
  assert.equal(stopOf(), true);
  assert.equal(stopOf({ status: "paused" }), false);
  assert.equal(stopOf({ activeTeamId: "team-1" }), false);
  assert.equal(stopOf({}, good, true), false);
  assert.equal(stopOf({}, good, false, false), false);
  assert.equal(stopOf({ autonomy: "supervised" }), false);
  assert.equal(stopOf({ standing: { shape: "objective", cadenceMinutes: 60 } }), false);
  assert.equal(stopOf({}, assessment({ kind: "no-change" })), false);
  assert.equal(stopOf({}, assessment({ result: "not-met" })), false);
  assert.equal(stopOf({}, null), false);
  assert.equal(stopOf(answered(good.verdictId)), false);
  assert.equal(stopOf(answered("earlier"), good, false, true, { supersededVerdictIds: ["earlier"] }), false);
  assert.equal(stopOf(answered()), true);
  assert.equal(stopOf(answered(randomUUID())), true);
});

const FINISHED = Date.parse("2026-01-01T00:00:00.000Z");
const inconclusive = assessment({ result: "inconclusive", counts: { met: 0, notMet: 0, inconclusive: 1, pendingOwner: 0 } });
const detailOf = (reasons: (string | undefined)[], overrides: Record<string, unknown> = {}) => ({
  verdictId: inconclusive.verdictId, revision: 1, head: HEAD,
  criteria: reasons.map((reason, index) => ({ id: `c${index}`, state: "inconclusive", ...(reason === undefined ? {} : { reason }) })),
  ...overrides,
}) as unknown as Pick<VerdictDetail, "verdictId" | "revision" | "head" | "criteria">;

test("a delivery hold waits at most ten minutes for a receipt a goal can still get", () => {
  assert.equal(DELIVERY_HOLD_MS, 600_000);
  assert.match(DELIVERY_HOLD_REASON, /10 minutes/);
  assert.match(LATE_RECEIPT_EVENT, /delivery receipt/);
  type Hold = { goal?: Record<string, unknown>; cycle?: Partial<GoalCycle>; held?: RunAssessment | null; nowMs?: number; scanned?: boolean; detail?: ReturnType<typeof detailOf> | null };
  const hold = (input: Hold = {}) => {
    const held = input.held === undefined ? inconclusive : input.held;
    const target = cycle(1, { status: "merged", finishedAt: AT, ...(held === null ? {} : { assessment: { ...held, progress: 0 } }), ...input.cycle });
    const detail = input.detail === undefined ? detailOf(["before-delivery"]) : input.detail ?? undefined;
    return deliveryHold(goal({ cycles: [target], ...input.goal }), { nowMs: input.nowMs ?? FINISHED + 1000, scanned: input.scanned ?? true, ...(detail === undefined ? {} : { detail }) });
  };
  assert.equal(hold(), true);
  assert.equal(hold({ nowMs: FINISHED }), true);
  assert.equal(hold({ nowMs: FINISHED + 599_999 }), true);
  assert.equal(hold({ nowMs: FINISHED + 600_000 }), false);
  assert.equal(hold({ nowMs: FINISHED - 1 }), false);
  assert.equal(hold({ goal: { autonomy: "supervised" } }), false);
  assert.equal(hold({ goal: { standing: { shape: "objective", cadenceMinutes: 60 } } }), false);
  assert.equal(hold({ scanned: false }), false);
  assert.equal(hold({ cycle: { status: "ready-for-review" } }), false);
  assert.equal(hold({ cycle: { finishedAt: undefined } }), false);
  assert.equal(hold({ held: null }), false);
  assert.equal(hold({ held: assessment({ kind: "no-change", result: "inconclusive" }) }), false);
  assert.equal(hold({ held: assessment({ result: "not-met" }) }), false);
  assert.equal(hold({ held: assessment({ result: "inconclusive", counts: { met: 0, notMet: 1, inconclusive: 1, pendingOwner: 0 } }) }), false);
  assert.equal(hold({ detail: null }), false);
  assert.equal(hold({ detail: detailOf(["before-delivery"], { revision: 2 }) }), false);
  assert.equal(hold({ detail: detailOf(["before-delivery"], { head: "b".repeat(40) }) }), false);
  assert.equal(hold({ detail: detailOf(["before-delivery", "no-receipt"]) }), false);
  assert.equal(hold({ detail: detailOf([undefined]) }), false);
  assert.equal(hold({ detail: detailOf([]) }), false, "a verdict with no criterion waits for nothing");
  assert.equal(hold({ detail: detailOf(["no-receipt"], { verdictId: randomUUID() }) }), true, "the team is finishing a late verdict");
  assert.equal(hold({ detail: detailOf(["no-receipt"], { verdictId: randomUUID(), head: "b".repeat(40) }) }), false);
});

test("verdict failures follow the result and the progress", () => {
  const failed = (result: RunAssessment["result"], progress: number) => verdictFailed({ assessment: { ...assessment({ result }), progress } });
  assert.equal(failed("not-met", 0), true);
  assert.equal(failed("inconclusive", -1), true);
  assert.equal(failed("met", 0), false);
  assert.equal(failed("not-met", 1), false);
  assert.equal(verdictFailed({}), false);
});

const outcome = (overrides: Record<string, unknown> = {}) => ({
  requestId: randomUUID(), revision: 1, result: "not-achieved" as const, summary: "Keep going", evidence: "Not yet", ...overrides,
});

function stopped(overrides: Record<string, unknown> = {}) {
  const held: GoalAssessment = { ...assessment(), progress: 1 };
  return { held, goal: goal({ status: "blocked", stopReason: "provisional-met", cycles: [cycle(1, { assessment: held })], ...overrides }) };
}

function refusal(subject: ProductGoal, body: Record<string, unknown>, nowMs = NOW): string {
  const before = JSON.stringify(subject);
  try { assertVerdictAnswer(subject, goalOutcomeSchema.parse(body), nowMs); }
  catch (error) {
    assert.ok(error instanceof TeamError);
    assert.equal(error.status, 409);
    assert.equal(JSON.stringify(subject), before);
    return error.code;
  }
  return "none";
}

test("the outcome rules refuse a wrong verdict answer", () => {
  const { held, goal: ok } = stopped();
  const bodyOf = (subject: ProductGoal) => outcome({ verdictId: subject.cycles[0]!.assessment!.verdictId, continue: true });
  const body = bodyOf(ok);
  assert.equal(refusal(ok, body), "none");
  assert.equal(refusal(ok, outcome({ verdictId: randomUUID() })), "verdict-not-found");
  assert.equal(refusal(ok, outcome({ verdictId: randomUUID(), continue: true })), "verdict-not-found");
  const wrongReason = stopped({ stopReason: "deadline" }).goal;
  assert.equal(refusal(wrongReason, bodyOf(wrongReason)), "goal-not-provisional");
  const other = { ...assessment(), progress: 1 };
  assert.equal(refusal(stopped({ cycles: [cycle(1, { assessment: held }), cycle(2, { assessment: other })] }).goal, body), "goal-not-provisional");
  assert.equal(refusal(ok, body, Date.parse("2026-01-01T01:00:00.000Z")), "goal-limit-reached");
  const limited = (overrides: Record<string, unknown>) => {
    const subject = stopped(overrides).goal;
    return refusal(subject, bodyOf(subject));
  };
  assert.equal(limited({ ceilingAt: "2026-01-01T00:05:00.000Z" }), "goal-limit-reached");
  assert.equal(limited({ memberCount: 4 }), "goal-limit-reached");
  assert.equal(limited({ maxRuns: 1 }), "goal-limit-reached", "The feature-run limit is spent");
  assert.equal(limited({ maxRuns: 2 }), "none", "One run below the limit still continues");
  assert.equal(limited({ steering: Array.from({ length: 20 }, () => ({ text: "d", revision: 1, at: AT })) }), "goal-steering-limit");
  assert.equal(limited({ objective: "x".repeat(24_001) }), "goal-steering-limit");
  const earlier = randomUUID();
  const replaced = stopped({}).goal;
  replaced.cycles[0]!.supersededVerdictIds = [earlier];
  assert.equal(refusal(replaced, outcome({ verdictId: earlier })), "none");
  assert.equal(refusal(replaced, outcome({ verdictId: earlier, continue: true })), "none");
  replaced.cycles.push(cycle(2, { assessment: { ...assessment(), progress: 1 } }));
  assert.equal(refusal(replaced, outcome({ verdictId: earlier, continue: true })), "goal-not-provisional");
  assert.equal(goalOutcomeSchema.safeParse(outcome({ verdictId: held.verdictId, continue: true, result: "achieved" })).success, false);
  assert.equal(goalOutcomeSchema.safeParse(outcome({ continue: true })).success, false);
  assert.equal(goalOutcomeSchema.safeParse(outcome({ verdictId: held.verdictId })).success, true);
  assert.equal(goalOutcomeSchema.safeParse(outcome()).success, true);
});

const judgement = (statement: string) => ({ statement, check: { kind: "judgement" as const, item: "sources" }, threshold: { kind: "pass" as const } });
const artifact = (statement: string, path: string) => ({ statement, check: { kind: "artifact" as const, path }, threshold: { kind: "pass" as const } });

function holderWith(subject: ProductGoal, criteria: (ReturnType<typeof judgement> | ReturnType<typeof artifact>)[] = []): GoalHolder {
  const holder: GoalHolder = { goal: subject };
  const built = createGoalObjective(holder, AT, { inputs: criteria, context: { configured: [], requestId: randomUUID(), at: AT } });
  assert.equal(built, "built");
  return holder;
}

test("continue appends one direction and restarts the goal", () => {
  const { goal: subject } = stopped({ reason: PROVISIONAL_REASON });
  const holder = holderWith(subject);
  const before = goalObjectiveView(holder).record.version;
  const body = goalOutcomeSchema.parse(outcome({ verdictId: subject.cycles[0]!.assessment!.verdictId, continue: true, summary: "Add sources" }));
  continueGoal(holder, body, AT);
  assert.equal(subject.steering.length, 1);
  assert.equal(subject.steering[0]!.text, "Add sources");
  assert.equal(subject.steering[0]!.revision, 1);
  assert.equal(subject.status, "running");
  assert.equal(subject.stopReason, undefined);
  assert.equal(subject.reason, undefined);
  assert.equal(subject.outcomes.length, 0);
  assert.notEqual(subject.status, "achieved");
  const view = goalObjectiveView(holder);
  const record = view.record;
  assert.equal(record.version, before + 1);
  const last = view.log.at(-1)!;
  assert.equal(last.op, "direction.appended");
  assert.equal(record.statement.directions.at(-1)?.id, "s1");
  assert.equal(typeof PROVISIONAL_EVENT, "string");
  assert.equal(typeof CONTINUE_EVENT, "string");
});

test("an owner outcome ends a provisional stop and only that", () => {
  const { goal: subject } = stopped({ status: "ready-for-review", reason: PROVISIONAL_REASON });
  answerProvisional(subject);
  assert.equal(subject.stopReason, undefined);
  assert.equal(subject.reason, undefined);
  assert.equal(subject.status, "ready-for-review");
  const timed = stopped({ status: "limit-reached", stopReason: "deadline", reason: "Time is up." }).goal;
  answerProvisional(timed);
  assert.equal(timed.stopReason, "deadline");
  assert.equal(timed.reason, "Time is up.");
});

const project = (team: Record<string, unknown> | undefined) => ({ team }) as unknown as Pick<Project, "team">;
const onProject = project({ checks: [], objective: { prompts: "on", register: "on", evaluator: "on" } });

function latestIs(holder: GoalHolder, verdictOf: (id: string) => string | undefined) {
  const { digest: _digest, ...body } = holder.objectiveRecord as ObjectiveRecord;
  const criteria = body.criteria.map(item => {
    const { latest: _latest, ...rest } = item;
    const verdictId = verdictOf(item.id);
    return verdictId === undefined ? rest : { ...rest, latest: { state: "met" as const, verdictId } };
  });
  const next = { ...body, criteria };
  holder.objectiveRecord = { ...next, digest: recordDigest(next) };
}

function rowsFixture(overrides: Record<string, unknown> = {}) {
  const subject = goal(overrides);
  const holder = holderWith(subject, [judgement("Sources ranked"), artifact("Reasons given", `research/${"x".repeat(190)}.json`), judgement("Old criterion")]);
  const rated = assessment({ criteria: [{ id: "c0", state: "met" }, { id: "c1", state: "not-met" }, { id: "c2", state: "inconclusive" }, { id: "c3", state: "pending-owner" }] });
  subject.cycles = [cycle(1, { assessment: { ...rated, progress: 1 } })];
  latestIs(holder, () => rated.verdictId);
  return { subject, holder, rated };
}

test("criteria rows follow the latest verdict, the record, and the switches", () => {
  const { subject, holder } = rowsFixture();
  const rows = criteriaRowsFor(holder, onProject).criteria;
  assert.ok(rows);
  assert.deepEqual(rows.map(row => row.criterion), ["c0", "c1", "c2", "c3"]);
  assert.deepEqual(rows.map(row => row.status), ["met", "not-met", "inconclusive", "pending-owner"]);
  assert.ok(rows.every(row => Buffer.byteLength(row.check) <= 120));
  assert.ok(Buffer.byteLength(rows[2]!.check) >= 100);
  assert.equal(subject.cycles.length, 1);
  const retired = correctGoalObjective(holder, { requestId: randomUUID(), version: goalObjectiveView(holder).record.version, ops: [{ op: "criterion.retire", id: "c3" }] }, { configured: [], requestId: randomUUID(), at: AT });
  holder.objectiveRecord = retired;
  const after = criteriaRowsFor(holder, onProject).criteria;
  assert.deepEqual(after?.map(row => row.criterion), ["c0", "c1", "c2"]);
});

test("a criterion whose latest verdict is not the assessment's gives no row", () => {
  const { holder, rated } = rowsFixture();
  latestIs(holder, id => (id === "c1" ? undefined : id === "c2" ? randomUUID() : rated.verdictId));
  const rows = criteriaRowsFor(holder, onProject).criteria;
  assert.ok(rows);
  assert.deepEqual(rows.map(row => row.criterion), ["c0", "c3"]);
});

test("criteria rows are empty when a switch, the mode, the verdict, or the record is missing", () => {
  const { subject, holder } = rowsFixture();
  const none = (value: { criteria?: unknown[] }) => assert.equal(value.criteria, undefined);
  for (const objective of [{ prompts: "off", evaluator: "on" }, { prompts: "on", evaluator: "off" }, { prompts: "on" }])
    none(criteriaRowsFor(holder, project({ checks: [], objective })));
  none(criteriaRowsFor(holder, project(undefined)));
  none(criteriaRowsFor(holder, undefined));
  subject.autonomy = "supervised";
  none(criteriaRowsFor(holder, onProject));
  subject.autonomy = "autonomous";
  const kept = subject.cycles;
  subject.cycles = [cycle(1)];
  none(criteriaRowsFor(holder, onProject));
  subject.cycles = kept;
  assert.ok(criteriaRowsFor(holder, onProject).criteria);
  holder.objectiveRecord = { broken: true };
  none(criteriaRowsFor(holder, onProject));
});
