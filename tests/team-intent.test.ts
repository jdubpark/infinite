import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTENT_EVENTS, TeamIntent, intentCheckDue } from "../packages/host/src/team-intent.js";
import type { IntentHolder, IntentHost, IntentCheckState } from "../packages/host/src/team-intent.js";
import { goalRecord, runRecord } from "../packages/host/src/objective-record.js";
import type { GoalRecordPort } from "../packages/host/src/objective-intent.js";
import { INTENT_DEFAULTS_ANSWER, intentApplied, skipIntentCheck } from "../packages/host/src/objective-intent.js";
import type { IntentCheckReport, IntentItem } from "../packages/host/src/intent-report.js";
import type { ObjectiveRecord } from "../packages/host/src/objective-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamCommand, TeamDecision, TeamLineup, TeamMember, TeamModelProfile, TeamReport, TeamRole, TeamRun } from "../packages/host/src/team-types.js";
import type { Project, Provider } from "../packages/host/src/types.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import { objectiveError } from "../packages/host/src/objective-record.js";

// Every identifier and secret-shaped value is built here at run time, so the source holds no real credential.
const SECRET = "gh" + "p_" + "a".repeat(36);
const RUN_ID = "00000000-0000-4000-8000-0000000000a1";
const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const AT = "2026-11-17T09:00:00.000Z";
const OBJECTIVE = "Find ranked sources for the research brief.";
const BASE = "a".repeat(40);
const CHECK: TeamCommand = { command: "npm", args: ["run", "lint"] };
const UNCONFIGURED: TeamCommand = { command: "make", args: ["other"] };

const CLAUDE: TeamModelProfile = { id: "opus-xhigh", label: "Opus", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" } as TeamModelProfile;
const SONNET: TeamModelProfile = { id: "sonnet-high", label: "Sonnet", provider: "claude", model: "claude-sonnet-5-5", effort: "high", tier: "strong" } as TeamModelProfile;
const ASTRA: TeamModelProfile = { id: "astra-high", label: "Astra", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" } as TeamModelProfile;
const LINEUP = { coordinator: CLAUDE, reviewer: ASTRA, implementers: [], evaluators: [ASTRA] } as unknown as TeamLineup;
const SAME_FAMILY_LINEUP = { coordinator: CLAUDE, reviewer: SONNET, implementers: [], evaluators: [SONNET] } as unknown as TeamLineup;

const PLAN_REPORT = (): TeamReport => ({ kind: "plan", summary: "Rank the sources.", tasks: [] }) as unknown as TeamReport;

function runOf(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: RUN_ID, projectId: "research", objective: OBJECTIVE, revision: 1, status: "planning", autonomy: "autonomous",
    intentCheck: "on", lineup: LINEUP, decisions: [], members: [], tasks: [], checks: [], steering: [], createdAt: AT, updatedAt: AT,
    ...overrides,
  } as unknown as TeamRun;
}

function holderOf(run: TeamRun = runOf()): IntentHolder {
  return { run };
}

let sequence = 0;
function memberOf(run: TeamRun, role: TeamRole, extra: Partial<TeamMember> = {}): TeamMember {
  sequence += 1;
  return {
    runId: run.id, memberId: `${role}-${sequence}`, role, revision: run.revision, title: role, status: "queued", cwd: "/unused",
    baseCommit: BASE, prompt: "", sessionId: `session-${sequence}`, stopRequestId: "", cursor: 0,
    modelProfile: role === "intent-checker" ? ASTRA : CLAUDE, ...extra,
  } as unknown as TeamMember;
}

/** A project manager whose plan passed today's checks, in the holder's run. */
function planOf(holder: IntentHolder, revision = holder.run.revision): TeamMember {
  const member = memberOf(holder.run, "project-manager", { revision, status: "reported", report: PLAN_REPORT() });
  holder.run.members.push(member);
  return member;
}

type Pending = { perform: (signal: AbortSignal) => Promise<boolean | undefined>; complete: (clean: boolean | undefined) => void; member: TeamMember };
type Prepared = { role: string; feedback?: string; prebuilt?: { prompt: string; profile: TeamModelProfile }; member: TeamMember };

/** Records every host call. Operations stay pending until `settle` runs them, as the real result operation does. */
class FakeHost implements IntentHost {
  readonly events: string[] = [];
  readonly prepared: Prepared[] = [];
  readonly consumed: string[] = [];
  readonly holds: boolean[] = [];
  readonly blocks: unknown[] = [];
  readonly pending: Pending[] = [];
  saves = 0;
  operations = 0;
  readonly limitedSet = new Set<Provider>();
  private readonly cwd: string;
  private readonly baseCommit: string;
  private readonly config: Project | undefined;
  private intent?: TeamIntent;
  /** Replaces `hold` as the result callback of a consumed plan, so a test can observe each hold. */
  onConsume?: (holder: IntentHolder, member: TeamMember) => boolean;

  constructor(options: { cwd?: string; baseCommit?: string; checks?: TeamCommand[] } = {}) {
    this.cwd = options.cwd ?? "/unused";
    this.baseCommit = options.baseCommit ?? BASE;
    this.config = { team: { checks: options.checks ?? [CHECK] } } as unknown as Project;
  }

  /** Consuming a held plan runs the result callback, which calls `hold` and records whether the plan was held. */
  attach(intent: TeamIntent): void {
    this.intent = intent;
  }

  prepare(holder: IntentHolder, role: "project-manager" | "intent-checker", feedback: string | undefined,
    onPrepared: (member: TeamMember) => void, prebuilt?: { prompt: string; profile: TeamModelProfile }): void {
    const member = memberOf(holder.run, role, {
      cwd: this.cwd, baseCommit: this.baseCommit, modelProfile: prebuilt?.profile ?? CLAUDE, status: "queued",
    });
    holder.run.members.push(member);
    this.prepared.push({ role, feedback, prebuilt, member });
    onPrepared(member);
  }
  consume(holder: IntentHolder, member: TeamMember): void {
    this.consumed.push(member.memberId);
    this.holds.push(this.onConsume ? this.onConsume(holder, member) : this.intent!.hold(holder, member));
  }
  operation(_holder: IntentHolder, perform: (signal: AbortSignal) => Promise<boolean | undefined>, complete: (clean: boolean | undefined) => void, member: TeamMember): void {
    this.operations += 1;
    this.pending.push({ perform, complete, member });
  }
  save(_holder: IntentHolder): void { this.saves += 1; }
  event(_holder: IntentHolder, text: string): void { this.events.push(text); }
  block(_holder: IntentHolder, error: unknown): void { this.blocks.push(error); }
  project(_run: TeamRun): Project | undefined { return this.config; }
  limited(): Set<Provider> { return this.limitedSet; }
  prefix(): TeamCommand | undefined { return undefined; }
}

function hostAndIntent(options: { cwd?: string; baseCommit?: string; checks?: TeamCommand[] } = {}): { host: FakeHost; intent: TeamIntent } {
  const host = new FakeHost(options);
  const intent = new TeamIntent(host);
  host.attach(intent);
  return { host, intent };
}

/** Runs every pending result operation. `clean` stands for the read-only check's outcome; the check itself is tested separately. */
function settle(host: FakeHost, clean = true): void {
  for (const op of host.pending.splice(0)) op.complete(clean);
}

/** The checker reports as the host stores it: screened, then consumed. */
function reportChecker(intent: TeamIntent, holder: IntentHolder, member: TeamMember, report: TeamReport): void {
  member.report = report;
  member.status = "reported";
  member.report = intent.screen(holder, member, report);
  intent.consume(holder, member);
}

/** A held plan of the current revision, then the checker launched: the state is `checking`. */
function checkingFixture(run: Partial<TeamRun> = {}, options: { cwd?: string; baseCommit?: string } = {}) {
  const holder = holderOf(runOf(run));
  const { host, intent } = hostAndIntent(options);
  const pm = planOf(holder);
  assert.equal(intent.hold(holder, pm), true, "the plan is held");
  assert.equal(intent.step(holder), true, "the checker is prepared");
  const checker = host.prepared.at(-1)!.member;
  assert.equal(holder.intentCheck?.status, "checking");
  return { holder, host, intent, pm, checker };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Fixtures in the style of tests/objective-intent.test.ts.
const OWNER_TEST = { kind: "owner" };
function askItem(dimension: string, options: { criticality?: IntentItem["criticality"]; def?: string } = {}): IntentItem {
  return {
    dimension, why: `${dimension} changes the result`, criticality: options.criticality ?? "outcome", disposition: "ask",
    assumption: { statement: `${dimension} is the default`, refutedBy: "the owner names another", test: OWNER_TEST },
    question: { text: `Which ${dimension}?`, options: [], default: options.def ?? "the stated default" },
  } as IntentItem;
}
function assumeItem(dimension: string, test: unknown = OWNER_TEST): IntentItem {
  return {
    dimension, why: `${dimension} is settled`, criticality: "detail", disposition: "assume",
    assumption: { statement: `${dimension} holds`, refutedBy: "a counter example", test },
  } as IntentItem;
}
function checkReport(items: IntentItem[], extra: Partial<IntentCheckReport> = {}): IntentCheckReport {
  return { kind: "intent-check", summary: "The plan leaves items open.", items, ...extra };
}

function goalFixture(): ProductGoal {
  return {
    id: GOAL_ID, objective: OBJECTIVE, successCriteria: "A ranked shortlist", nonGoals: [], allowedPaths: ["research"],
    evidence: ["notes.md"], steering: [],
  } as unknown as ProductGoal;
}

/** A goal's record in memory, as GoalService keeps it, behind the port the check reads and writes. */
function goalPort(record: ObjectiveRecord): GoalRecordPort & { store: { record: ObjectiveRecord }; failing: boolean } {
  const port = {
    store: { record },
    failing: false,
    read: () => ({ kind: "ready" as const, record: port.store.record }),
    write: (_goalId: string, expectedVersion: number, next: ObjectiveRecord) => {
      if (port.failing) throw new Error("the goal record could not be saved");
      if (port.store.record.version !== expectedVersion) throw objectiveError("objective-version-stale");
      port.store = { record: next };
    },
  };
  return port;
}

/** A standalone run's record with its log filled to the share, so no further entry fits. */
function fullLog(record: ObjectiveRecord): ObjectiveRecord {
  let full = record;
  for (;;) {
    const next = skipIntentCheck(full, { runId: RUN_ID, revision: 1, reason: "checker-failed", at: AT });
    if (next === undefined) return full;
    full = next;
  }
}

function stateOf(holder: IntentHolder): IntentCheckState {
  assert.ok(holder.intentCheck, "the check has a state");
  return holder.intentCheck;
}

test("the gate reads the run's pin", () => {
  for (const pin of ["off", undefined] as const) {
    for (const autonomy of ["autonomous", "supervised"] as const) {
      const run = runOf({ intentCheck: pin, autonomy });
      assert.equal(intentCheckDue(run), false, `pin ${String(pin)} ${autonomy} is not due`);
      const { host, intent } = hostAndIntent();
      const holder = holderOf(run);
      const pm = planOf(holder);
      assert.equal(intent.hold(holder, pm), false, `pin ${String(pin)} ${autonomy}: the plan is accepted`);
      assert.equal(holder.intentCheck, undefined, "no state is written");
      assert.equal(holder.objectiveRecord, undefined, "no record is built");
      assert.deepEqual(host.events, [], "no event");
      assert.equal(host.saves, 0, "nothing is saved");
      assert.deepEqual(host.prepared, [], "no checker is prepared");
      assert.equal(intent.step(holder), false, "step starts nothing");
    }
  }
  assert.equal(intentCheckDue(runOf({ intentCheck: "on", autonomy: "supervised" })), true);
  assert.equal(intentCheckDue(runOf({ intentCheck: "on", autonomy: "autonomous" })), true);
});

test("a plan is held once per revision", () => {
  const holder = holderOf();
  const { host, intent } = hostAndIntent();
  const pm = planOf(holder);
  assert.equal(intent.hold(holder, pm), true);
  assert.equal(stateOf(holder).status, "queued");
  assert.deepEqual(host.events, [INTENT_EVENTS.held]);
  assert.equal(intent.hold(holder, pm), true, "a second hold of the same plan still holds");
  assert.deepEqual(host.events, [INTENT_EVENTS.held], "and adds no event");

  // A newer plan of the same revision moves the held plan to it, and adds no event.
  const newer = planOf(holder);
  assert.equal(intent.hold(holder, newer), true, "a newer plan of the revision is held");
  assert.equal(stateOf(holder).planMemberId, newer.memberId, "planMemberId moves to the newer plan");
  assert.deepEqual(host.events, [INTENT_EVENTS.held], "and adds no event");

  intent.step(holder);
  reportChecker(intent, holder, host.prepared[0]!.member, checkReport([assumeItem("scope")]));
  settle(host);
  assert.equal(stateOf(holder).status, "accepting");
  assert.ok(host.events.includes(INTENT_EVENTS.accepted), "the accepted event is written");

  intent.step(holder);
  assert.deepEqual(host.consumed, [newer.memberId], "the newer held plan is consumed once");
  assert.deepEqual(host.holds, [false], "its hold accepts it");
  assert.equal(stateOf(holder).status, "done");
  assert.equal(intent.hold(holder, pm), false, "after done, a hold accepts");
  assert.equal(stateOf(holder).status, "done");

  holder.run.revision = 2;
  const next = planOf(holder, 2);
  assert.equal(intent.hold(holder, next), true, "a new revision is held");
  assert.equal(stateOf(holder).revision, 2);
  assert.equal(stateOf(holder).status, "queued");
  assert.equal(host.events.filter(text => text === INTENT_EVENTS.held).length, 2, "one held event per revision");

  // A revision change while the check waits releases the older revision's question, and the new plan is held at once.
  const waitingRun = checkingFixture({ autonomy: "supervised" });
  reportChecker(waitingRun.intent, waitingRun.holder, waitingRun.checker, checkReport([askItem("scope")]));
  settle(waitingRun.host);
  assert.equal(stateOf(waitingRun.holder).status, "waiting");
  waitingRun.holder.run.revision = 2;
  const replanned = planOf(waitingRun.holder, 2);
  assert.equal(waitingRun.intent.hold(waitingRun.holder, replanned), true, "the new revision's plan is held");
  assert.equal(stateOf(waitingRun.holder).revision, 2);
  assert.equal(stateOf(waitingRun.holder).status, "queued");
  assert.equal(waitingRun.host.events.filter(text => text === INTENT_EVENTS.released.replanned).length, 1, "one replanned release");
  assert.equal((waitingRun.holder.objectiveRecord as ObjectiveRecord).questions[0]!.waits, false, "the question no longer waits");
});

test("a report applies once", () => {
  const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" });
  reportChecker(intent, holder, checker, checkReport([askItem("scope")]));
  // The state a restart would find if it had been saved while the result operation was pending.
  const checkingState = clone(stateOf(holder));
  settle(host);
  assert.equal(stateOf(holder).status, "waiting");
  const decisionId = stateOf(holder).decisionId;

  // A restart after the answer was recorded: the stored report is consumed again and changes nothing.
  const restarted = clone(holder);
  const restartedBefore = clone(restarted);
  intent.consume(restarted, checker);
  assert.equal(host.pending.length, 0, "no second operation starts");
  assert.deepEqual(clone(restarted), restartedBefore, "the state is unchanged");

  // A restart where the record holds the applied entry but the state and its decision were not saved: completing the report finds the entry.
  const unsaved = clone(holder);
  unsaved.intentCheck = checkingState;
  unsaved.run.decisions = [];
  intent.consume(unsaved, checker);
  settle(host);
  const applied = (holder.objectiveRecord as ObjectiveRecord).log.filter(entry => entry.op === "intent-check.applied");
  assert.equal(applied.length, 1, "one applied entry");
  assert.equal(stateOf(unsaved).status, "waiting", "the restarted state follows the entry");
  assert.equal(stateOf(unsaved).decisionId, decisionId, "with the same decision");
  assert.equal(unsaved.run.decisions.length, 1, "the decision is pushed once, from the entry");
  assert.equal(holder.run.decisions.length, 1, "and the first run kept its one decision");
  assert.ok(intentApplied(holder.objectiveRecord as ObjectiveRecord, checker.memberId));
});

test("the checker cannot block, ask, or post", () => {
  const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" });
  reportChecker(intent, holder, checker, { kind: "question", question: "Which scope?", options: [] } as unknown as TeamReport);
  assert.equal(stateOf(holder).failures, 1, "a question counts a failure");
  assert.equal(host.operations, 0, "the question starts no operation");
  assert.equal(host.blocks.length, 0, "it never blocks");
  assert.deepEqual(host.consumed, [], "it never reaches the plan's consume");
  assert.equal(holder.run.decisions.length, 0, "it opens no decision");
  assert.equal(stateOf(holder).status, "queued", "the check replaces the checker");

  intent.step(holder);
  const replacement = host.prepared.at(-1)!.member;
  reportChecker(intent, holder, replacement, { kind: "blocked", summary: "No access." } as unknown as TeamReport);
  assert.equal(host.blocks.length, 0, "a blocked report never calls block");
  assert.equal(stateOf(holder).status, "accepting", "the second failure skips");
  assert.equal(stateOf(holder).reason, "checker-failed");

  // A report from another member, or from a checker of an earlier revision, changes nothing.
  const { holder: other, host: otherHost, intent: otherIntent } = checkingFixture({ autonomy: "supervised" });
  const stranger = memberOf(other.run, "intent-checker", { revision: other.run.revision, report: checkReport([assumeItem("x")]), status: "reported" });
  other.run.members.push(stranger);
  const before = clone(other);
  otherIntent.consume(other, stranger);
  assert.equal(otherHost.operations, 0, "a checker that is not current starts nothing");
  assert.deepEqual(clone(other), before, "and the state is unchanged");
  assert.equal(otherIntent.failed(other, stranger), true, "a stopped stranger is handled");
  assert.equal(stateOf(other).failures, 0, "and counts nothing");
});

test("failures are bounded", () => {
  // A stall, then a replacement on a provider that is now limited: nothing else is eligible, so the check skips.
  const first = checkingFixture({ autonomy: "supervised" });
  first.checker.status = "stopped";
  assert.equal(first.intent.failed(first.holder, first.checker), true);
  assert.equal(stateOf(first.holder).failures, 1);
  assert.equal(stateOf(first.holder).status, "queued");
  assert.ok(first.host.events.includes(INTENT_EVENTS.replaced));
  first.host.limitedSet.add("codex");
  assert.equal(first.intent.step(first.holder), true);
  assert.equal(stateOf(first.holder).status, "accepting", "no replacement on a limited provider");
  assert.equal(stateOf(first.holder).reason, "no-eligible-profile");
  assert.equal(first.host.prepared.length, 1, "no replacement is prepared");

  // Two failures: a skip with its one event and one log entry, and the held plan accepted.
  const second = checkingFixture({ autonomy: "supervised" });
  reportChecker(second.intent, second.holder, second.checker, { kind: "blocked", summary: "No access." } as unknown as TeamReport);
  second.intent.step(second.holder);
  reportChecker(second.intent, second.holder, second.host.prepared.at(-1)!.member, { kind: "result", summary: "Done." } as unknown as TeamReport);
  assert.equal(stateOf(second.holder).status, "accepting");
  assert.equal(stateOf(second.holder).reason, "checker-failed");
  assert.ok(second.host.events.includes(INTENT_EVENTS.skipped["checker-failed"]));
  const skips = (second.holder.objectiveRecord as ObjectiveRecord).log.filter(entry => entry.op === "intent-check.skipped");
  assert.equal(skips.length, 1, "one skip entry");
  second.intent.step(second.holder);
  assert.deepEqual(second.host.holds, [false], "the held plan is consumed again and accepted");
  assert.equal(stateOf(second.holder).status, "skipped");
});

test("a checker that changes its workspace counts a failure", async () => {
  const repo = makeRepo();
  try {
    const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" }, { cwd: repo.dir, baseCommit: repo.baseCommit });
    reportChecker(intent, holder, checker, checkReport([assumeItem("scope")]));
    const [op] = host.pending;
    assert.equal(await op!.perform(new AbortController().signal), true, "a clean workspace passes the read-only check");
    writeFileSync(join(repo.dir, "notes.md"), "changed by the checker\n");
    assert.equal(await op!.perform(new AbortController().signal), false, "a changed file fails it");
    settle(host, false);
    assert.equal(stateOf(holder).failures, 1, "the changed file is one failure");
    assert.equal(stateOf(holder).status, "queued");
    assert.equal(holder.run.decisions.length, 0, "and it applies nothing");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a stop during the read-only check is not a checker failure, and a stopped run takes no report", async () => {
  const repo = makeRepo();
  try {
    // A pause, cancel, halt, block, or recovery aborts the check: no answer, so no failure, no event, and the state waits for the new revision.
    const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" }, { cwd: repo.dir, baseCommit: repo.baseCommit });
    reportChecker(intent, holder, checker, checkReport([assumeItem("scope")]));
    const [op] = host.pending.splice(0);
    const aborted = new AbortController();
    aborted.abort();
    const clean = await op!.perform(aborted.signal);
    assert.equal(clean, undefined, "an aborted check gives no answer");
    const events = host.events.length;
    op!.complete(clean);
    assert.deepEqual({ status: stateOf(holder).status, failures: stateOf(holder).failures }, { status: "checking", failures: 0 });
    assert.equal(host.events.length, events, "an aborted check writes no event");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
  // A clean check that completes after the run stopped writes nothing and leaves no question waiting on it.
  for (const status of ["paused", "cancelled", "blocked"] as const) {
    const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" });
    reportChecker(intent, holder, checker, checkReport([askItem("scope", { def: "the stated default" })]));
    holder.run.status = status;
    if (status === "cancelled") intent.release(holder, "cancelled");
    const record = clone(holder.objectiveRecord);
    settle(host, true);
    assert.equal(stateOf(holder).status, "checking", status);
    assert.equal(holder.run.decisions.length, 0, `${status}: no question waits on a stopped run`);
    assert.deepEqual(holder.objectiveRecord, record, `${status}: the record is unchanged`);
  }
});

test("waiting meets answers", () => {
  for (const scenario of ["defaults", "text", "connector"] as const) {
    const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" });
    reportChecker(intent, holder, checker, checkReport([askItem("scope", { def: "the stated default" })]));
    settle(host);
    assert.equal(stateOf(holder).status, "waiting", scenario);
    assert.equal(holder.run.status, "needs-input", scenario);
    // A resume sets the run back to planning; the waiting state restores needs-input on the next step.
    holder.run.status = "planning";
    assert.equal(intent.step(holder), true, `${scenario}: a waiting step still owns the run`);
    assert.equal(holder.run.status, "needs-input", `${scenario}: the step restores needs-input`);
    const decision = holder.run.decisions[0] as TeamDecision;
    assert.equal(decision.intentQuestions?.length, 1, scenario);
    assert.equal(intent.answerNote(holder, decision), INTENT_EVENTS.answered, scenario);

    const answer = scenario === "defaults" ? INTENT_DEFAULTS_ANSWER : scenario === "text" ? "Rank by recency." : "Rank by citations.";
    Object.assign(decision, { answer, answeredBy: scenario === "connector" ? "connector" : "owner", answeredAt: AT });
    if (scenario === "defaults") assert.ok(decision.options.includes(INTENT_DEFAULTS_ANSWER), "the decision offers the defaults");

    assert.equal(intent.step(holder), true, scenario);
    assert.equal(stateOf(holder).status, "correcting", scenario);
    const corrected = host.prepared.at(-1)!;
    assert.equal(corrected.role, "project-manager", scenario);
    const label = scenario === "connector" ? "Connector" : "User";
    assert.ok(corrected.feedback?.includes(`${label} answered: ${answer}`), `${scenario}: the feedback holds the answer with its label`);

    const record = holder.objectiveRecord as ObjectiveRecord;
    const question = record.questions[0]!;
    if (scenario === "defaults") assert.equal(question.state, "default-kept");
    if (scenario === "text") {
      assert.equal(question.state, "answered");
      assert.equal(record.statement.directions.length, 1, "the answer is a direction");
    }
    if (scenario === "connector") {
      assert.equal(question.waits, false, "the release ends the wait");
      assert.equal(question.state, "open", "and keeps the state");
      assert.equal(record.statement.directions.length, 0, "a delegate's answer is no direction");
    }
    assert.equal(intent.step(holder), false, "with the correction prepared, the project manager starts");

    const plan = corrected.member;
    plan.report = PLAN_REPORT();
    assert.equal(intent.hold(holder, plan), false, `${scenario}: the corrected plan is accepted`);
    assert.equal(stateOf(holder).status, "done", scenario);
  }
});

test("a skip never loses the plan", () => {
  // No evaluator of another family than the coordinator's.
  const noProfile = holderOf(runOf({ lineup: SAME_FAMILY_LINEUP }));
  const noProfileHost = hostAndIntent();
  assert.equal(noProfileHost.intent.hold(noProfile, planOf(noProfile)), false);
  assert.equal(stateOf(noProfile).reason, "no-eligible-profile");
  assert.equal(noProfileHost.host.events.at(-1), INTENT_EVENTS.skipped["no-eligible-profile"]);
  assert.deepEqual(noProfileHost.host.prepared, [], "no checker is launched");

  // An unreadable record.
  const unreadable = holderOf();
  unreadable.objectiveRecord = "not a record";
  const unreadableHost = hostAndIntent();
  assert.equal(unreadableHost.intent.hold(unreadable, planOf(unreadable)), false);
  assert.equal(stateOf(unreadable).reason, "record-unavailable");
  assert.equal(unreadableHost.host.events.at(-1), INTENT_EVENTS.skipped["record-unavailable"]);
  assert.deepEqual(unreadableHost.host.prepared, []);

  // A full log: nothing more is written, and no checker starts.
  const full = holderOf();
  const fullRecord = fullLog(runRecord(full.run, AT, "run-handle") as ObjectiveRecord);
  full.objectiveRecord = fullRecord;
  const fullHost = hostAndIntent();
  assert.equal(fullHost.intent.hold(full, planOf(full)), false);
  assert.equal(stateOf(full).reason, "log-full");
  assert.equal(fullHost.host.events.at(-1), INTENT_EVENTS.skipped["log-full"]);
  assert.equal((full.objectiveRecord as ObjectiveRecord).log.length, fullRecord.log.length, "the skip is not logged");
  assert.deepEqual(fullHost.host.prepared, []);

  // A context over 1 MiB: the checker is stopped before it launches, and the plan is accepted.
  const large = checkingFixture({ autonomy: "supervised" });
  large.pm.report = { kind: "plan", summary: "x".repeat(1100 * 1024), tasks: [] } as unknown as TeamReport;
  assert.equal(large.intent.context(large.holder, large.checker), null, "no context is built");
  assert.equal(large.checker.status, "stopped");
  assert.equal(stateOf(large.holder).reason, "context-too-large");
  assert.equal(large.host.events.at(-1), INTENT_EVENTS.skipped["context-too-large"]);
  large.intent.step(large.holder);
  assert.deepEqual(large.host.holds, [false], "the plan is consumed again and accepted");
  assert.equal(stateOf(large.holder).status, "skipped");
});

test("the decision cap blocks before anything is written", () => {
  const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" });
  const decisions = Array.from({ length: 40 }, (_, index) => ({ id: `d${index}`, memberId: "old", revision: 0, question: "old", options: [], createdAt: AT }));
  holder.run.decisions.push(...(decisions as unknown as TeamDecision[]));
  const versionBefore = (holder.objectiveRecord as ObjectiveRecord).version;
  const digestBefore = (holder.objectiveRecord as ObjectiveRecord).digest;
  reportChecker(intent, holder, checker, checkReport([askItem("scope")]));
  settle(host);
  assert.equal(host.blocks.length, 1);
  assert.ok(host.blocks[0] instanceof TeamError);
  assert.equal((host.blocks[0] as TeamError).code, "team-decision-limit");
  assert.equal((holder.objectiveRecord as ObjectiveRecord).version, versionBefore, "the record's version is unchanged");
  assert.equal((holder.objectiveRecord as ObjectiveRecord).digest, digestBefore, "and its digest");
  assert.equal(holder.run.decisions.length, 40, "no decision is pushed");
  assert.equal(stateOf(holder).status, "checking");
});

test("a checker plan report counts a failure and starts no project manager", () => {
  const { holder, host, intent, pm, checker } = checkingFixture({ autonomy: "supervised" });
  reportChecker(intent, holder, checker, PLAN_REPORT());
  assert.equal(stateOf(holder).failures, 1, "the plan report is a failure");
  assert.equal(stateOf(holder).status, "queued");
  assert.equal(host.operations, 0, "it starts no operation");
  assert.deepEqual(host.consumed, [], "the host never consumes it");
  assert.equal(host.prepared.filter(item => item.role === "project-manager").length, 0, "no project manager starts");

  intent.step(holder);
  const replacement = host.prepared.at(-1)!.member;
  assert.equal(replacement.role, "intent-checker", "the replacement is a checker");
  reportChecker(intent, holder, replacement, { kind: "result", summary: "Done." } as unknown as TeamReport);
  assert.equal(stateOf(holder).reason, "checker-failed");
  assert.equal(host.prepared.filter(item => item.role === "project-manager").length, 0, "still no project manager");
  assert.deepEqual(host.consumed, [], "the host has not consumed anything yet");

  intent.step(holder);
  assert.deepEqual(host.consumed, [pm.memberId], "the held plan is consumed once, after the skip");
  assert.deepEqual(host.holds, [false]);
});

test("a second pass in checking with the checker present starts nothing", () => {
  const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" });
  const prepared = host.prepared.length;
  assert.equal(intent.step(holder), true);
  assert.equal(intent.step(holder), true);
  checker.status = "reported";
  checker.report = checkReport([assumeItem("scope")]);
  assert.equal(intent.step(holder), true, "a reported checker still owns the step");
  assert.equal(host.operations, 0, "nothing is applied by the step");
  intent.consume(holder, checker);
  assert.equal(host.operations, 1, "the consume runs the operation");
  assert.equal(intent.step(holder), true, "a pending operation still owns the step");
  assert.equal(intent.step(holder), true);
  assert.equal(host.prepared.length, prepared, "no checker or project manager is prepared");
});

test("a release that fails stops nothing", () => {
  // Standalone run: the log is full, so the release, the older revision's release, and the new hold cannot write.
  const { holder, host, intent, checker } = checkingFixture({ autonomy: "supervised" });
  reportChecker(intent, holder, checker, checkReport([askItem("scope")]));
  settle(host);
  const waiting = clone(stateOf(holder));
  holder.objectiveRecord = fullLog(holder.objectiveRecord as ObjectiveRecord);
  const unrecorded = () => host.events.filter(text => text === INTENT_EVENTS.releaseUnrecorded).length;

  assert.doesNotThrow(() => intent.release(holder, "cancelled"));
  assert.equal(unrecorded(), 1, "one event for the failed release");
  assert.deepEqual(stateOf(holder), waiting, "the state is as a successful release leaves it");
  assert.equal((holder.objectiveRecord as ObjectiveRecord).questions[0]!.waits, true, "the question keeps waiting");

  holder.run.revision = 2;
  assert.doesNotThrow(() => intent.step(holder));
  assert.equal(intent.step(holder), false, "an older revision's step does not hold the run");
  assert.equal(holder.intentCheck, undefined, "the older state is dropped");
  assert.equal(unrecorded(), 2, "one event for that release too");

  const next = planOf(holder, 2);
  assert.doesNotThrow(() => intent.hold(holder, next));
  assert.equal(stateOf(holder).status, "skipped", "a full log skips the new revision");
  assert.equal(stateOf(holder).reason, "log-full");

  // Goal run: the record's write fails, so the release changes nothing and the cancel goes on.
  const goalRun = runOf({ autonomy: "supervised", goal: { id: GOAL_ID } as unknown as TeamRun["goal"] });
  const port = goalPort(goalRecord(goalFixture(), AT, "created") as ObjectiveRecord);
  const goal = holderOf(goalRun);
  const goalHost = hostAndIntent();
  goalHost.intent.goals = port;
  const goalPm = planOf(goal);
  assert.equal(goalHost.intent.hold(goal, goalPm), true);
  goalHost.intent.step(goal);
  reportChecker(goalHost.intent, goal, goalHost.host.prepared.at(-1)!.member, checkReport([askItem("scope")]));
  settle(goalHost.host);
  assert.equal(stateOf(goal).status, "waiting");
  port.failing = true;
  const before = port.store.record;
  assert.doesNotThrow(() => goalHost.intent.release(goal, "cancelled"));
  assert.equal(port.store.record, before, "the goal record is unchanged");
  assert.equal(goalHost.host.events.filter(text => text === INTENT_EVENTS.releaseUnrecorded).length, 1);
  assert.equal(stateOf(goal).status, "waiting");
});

test("the stored report is screened", () => {
  const { holder, host, intent, checker } = checkingFixture({ autonomy: "autonomous" });
  const report = checkReport([
    assumeItem(`secret ${SECRET}`),
    assumeItem("shape", { kind: "bogus" }),
    assumeItem("command", { kind: "command", run: UNCONFIGURED, refutesOn: "fail" }),
    assumeItem("kept"),
  ], {
    criteria: [{ derivedFrom: "text the objective does not hold", statement: "A statement.", check: { kind: "judgement", item: "x" }, threshold: { kind: "pass" } }],
    outOfScope: [SECRET],
  });
  const kept = intent.screen(holder, checker, report);
  assert.equal(kept.kind, "intent-check");
  assert.equal((kept as IntentCheckReport).items.length, 1, "only the kept item is stored");
  assert.ok(!JSON.stringify(kept).includes(SECRET), "the secret is not stored");
  assert.deepEqual(stateOf(holder).screened, { shape: 1, secret: 2, quote: 1, command: 1 }, "the counts are kept on the state");

  checker.report = kept;
  intent.consume(holder, checker);
  settle(host);
  const applied = intentApplied(holder.objectiveRecord as ObjectiveRecord, checker.memberId)!;
  const dropped = (applied.after as { inline: { dropped: Record<string, number> } }).inline.dropped;
  assert.equal(dropped.secret, 2, "the applied entry counts the secret drops");
  assert.equal(dropped.shape, 1);
  assert.equal(dropped.command, 1);
  assert.equal(dropped.quote, 1);

  const question = screenedBlock(intent, holder, checker, { kind: "question", question: `Use ${SECRET}?`, options: [] });
  assert.equal(question.kind, "blocked");
  assert.equal(question.summary, "The intent checker sent a question report instead of an intent check; its text is withheld.");
  assert.ok(!JSON.stringify(question).includes(SECRET));
  const plan = screenedBlock(intent, holder, checker, { kind: "plan", summary: SECRET, tasks: [] });
  assert.equal(plan.summary, "The intent checker sent a plan report instead of an intent check; its text is withheld.");

  // A checker that is not current stores its report screened, and sets no counts.
  const earlier = memberOf(holder.run, "intent-checker", { revision: holder.run.revision });
  const before = stateOf(holder).screened;
  const stored = intent.screen(holder, earlier, checkReport([assumeItem(`secret ${SECRET}`)]));
  assert.ok(!JSON.stringify(stored).includes(SECRET), "an earlier checker's report is screened too");
  assert.equal(stateOf(holder).screened, before, "and sets no counts");
  const earlierBlock = intent.screen(holder, earlier, { kind: "question", question: SECRET, options: [] } as unknown as TeamReport);
  assert.equal(earlierBlock.kind, "blocked", "an earlier checker's question is blocked too");
});

/** The stored form of a non-intent report from the checker: screen, as the host calls it. */
function screenedBlock(intent: TeamIntent, holder: IntentHolder, member: TeamMember, report: unknown): TeamReport {
  return intent.screen(holder, member, report as TeamReport) as TeamReport & { summary: string };
}

// A seeded run of random event orders. Each seed is a fixed sequence, so a failure names its seed.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("seeded event orders keep the invariants", () => {
  const SEEDS = 200;
  const STEPS = 60;
  // What the seeds reached in total: a run that never accepts, asks, or applies would pass the invariants trivially.
  const reached = { accepted: 0, decisions: 0, applied: 0, answered: 0 };
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const rng = mulberry32(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
    const goal = rng() < 0.5;
    const autonomy = pick(["autonomous", "supervised"] as const);
    const run = runOf({ autonomy, ...(goal ? { goal: { id: GOAL_ID } as unknown as TeamRun["goal"] } : {}) });
    const port = goal ? goalPort(goalRecord(goalFixture(), AT, "created") as ObjectiveRecord) : undefined;
    const context = { holder: holderOf(run) };
    const { host, intent } = hostAndIntent();
    intent.goals = port;
    const acceptedRevisions = new Map<number, number>();
    const leaked = new Set<string>();
    let currentStep = -1;
    const recordOf = (): ObjectiveRecord | undefined => (port ? port.store.record : context.holder.objectiveRecord as ObjectiveRecord | undefined);
    const where = (what: string) => `seed ${seed} step ${currentStep} (${what})`;

    // Every consume is a result callback: the hold decides, and a plan that it accepts is counted once per revision.
    const deliver = (holder: IntentHolder, member: TeamMember): boolean => {
      const decisionBefore = holder.intentCheck?.decisionId;
      const held = intent.hold(holder, member);
      if (held) return true;
      const waiting = recordOf()?.questions.some(question => question.waits && question.decisionId === decisionBefore) ?? false;
      assert.equal(waiting, false, where("a plan is accepted while its question waits"));
      acceptedRevisions.set(holder.run.revision, (acceptedRevisions.get(holder.run.revision) ?? 0) + 1);
      return false;
    };
    host.onConsume = deliver;

    for (let step = 0; step < STEPS; step += 1) {
      currentStep = step;
      const holder = context.holder;
      const choice = pick(["plan", "step", "step", "report", "settle", "settle", "fail", "release", "answer", "revision", "cancel", "restart", "plan", "answer"] as const);
      const checkers = holder.run.members.filter(member => member.role === "intent-checker");
      if (choice === "plan") {
        const correction = holder.intentCheck?.status === "correcting" && holder.intentCheck.correctedMemberId
          ? holder.run.members.find(member => member.memberId === holder.intentCheck?.correctedMemberId)
          : undefined;
        if (!acceptedRevisions.has(holder.run.revision) || correction) {
          const member = correction ?? planOf(holder);
          member.report = PLAN_REPORT();
          member.status = "reported";
          deliver(holder, member);
        }
      } else if (choice === "step") {
        intent.step(holder);
      } else if (choice === "report") {
        const current = checkers.filter(member => member.revision === holder.run.revision);
        if (current.length === 0) continue;
        const member = pick(current);
        const kind = pick(["valid", "valid", "waiting", "invalid", "other"] as const);
        const items: IntentItem[] = [];
        const count = 1 + Math.floor(rng() * 3);
        for (let index = 0; index < count; index += 1) {
          items.push(rng() < 0.5 ? askItem(`dim-${seed}-${step}-${index}`, { criticality: pick(["outcome", "plan", "detail"] as const) }) : assumeItem(`dim-${seed}-${step}-${index}`));
        }
        const report = kind === "invalid" ? { kind: "question", question: "What?", options: [] } : kind === "other" ? { kind: "blocked", summary: "No." }
          : kind === "waiting" ? checkReport([askItem(`ask-${seed}-${step}`)]) : checkReport(items);
        reportChecker(intent, holder, member, report as unknown as TeamReport);
      } else if (choice === "settle") {
        for (const op of host.pending.splice(0)) op.complete(rng() < 0.85);
      } else if (choice === "fail") {
        const current = checkers.length > 0 ? pick(checkers) : undefined;
        if (current) {
          current.status = "stopped";
          intent.failed(holder, current);
        }
      } else if (choice === "release") {
        const decisionId = holder.intentCheck?.decisionId;
        if (port && rng() < 0.5) {
          port.failing = true;
          if (decisionId) leaked.add(decisionId);
          intent.release(holder, "cancelled");
          port.failing = false;
        } else {
          intent.release(holder, "cancelled");
        }
      } else if (choice === "answer") {
        const decision = holder.run.decisions.findLast(item => item.answer === undefined && item.id === holder.intentCheck?.decisionId);
        if (decision) {
          const owner = rng() < 0.7;
          decision.answer = owner && rng() < 0.5 ? INTENT_DEFAULTS_ANSWER : `Answer ${step}.`;
          decision.answeredBy = owner ? "owner" : "connector";
          decision.answeredAt = AT;
        }
      } else if (choice === "revision") {
        holder.run.revision += 1;
        intent.step(holder);
      } else if (choice === "cancel") {
        intent.release(holder, "cancelled");
      } else {
        // A restart: the holder and its record survive as JSON, pending operations are lost, and a stored report is consumed again.
        context.holder = clone(holder);
        host.pending.length = 0;
        const reported = context.holder.run.members.find(member => member.role === "intent-checker" && member.memberId === context.holder.intentCheck?.checkerMemberId && member.report !== undefined);
        if (reported) intent.consume(context.holder, reported);
      }

      // Invariants after every event.
      const current = context.holder;
      const decisionsPerRevision = new Map<number, number>();
      for (const decision of current.run.decisions) decisionsPerRevision.set(decision.revision, (decisionsPerRevision.get(decision.revision) ?? 0) + 1);
      for (const [revision, count] of decisionsPerRevision) assert.ok(count <= 1, where(`${count} decisions in revision ${revision}`));
      const checkersPerRevision = new Map<number, number>();
      for (const member of current.run.members) if (member.role === "intent-checker") checkersPerRevision.set(member.revision, (checkersPerRevision.get(member.revision) ?? 0) + 1);
      for (const [revision, count] of checkersPerRevision) assert.ok(count <= 2, where(`${count} checkers in revision ${revision}`));
      for (const [revision, count] of acceptedRevisions) assert.ok(count <= 1, where(`${count} accepted plans in revision ${revision}`));
      const record = recordOf();
      const currentDecision = current.intentCheck?.decisionId;
      for (const question of record?.questions ?? []) {
        if (!question.waits) continue;
        const allowed = (currentDecision !== undefined && question.decisionId === currentDecision) || (question.decisionId !== undefined && leaked.has(question.decisionId));
        assert.ok(allowed, where(`question ${question.id} waits on ${String(question.decisionId)}`));
      }
    }
    reached.accepted += [...acceptedRevisions.values()].reduce((sum, count) => sum + count, 0);
    reached.decisions += context.holder.run.decisions.length;
    reached.answered += context.holder.run.decisions.filter(decision => decision.answer !== undefined).length;
    const finalRecord = recordOf();
    reached.applied += finalRecord?.log.filter(entry => entry.op === "intent-check.applied").length ?? 0;
  }
  assert.ok(reached.accepted > 0, `the seeds accept plans: ${JSON.stringify(reached)}`);
  assert.ok(reached.decisions > 0 && reached.answered > 0, `the seeds open and answer decisions: ${JSON.stringify(reached)}`);
  assert.ok(reached.applied > 0, `the seeds apply checker reports: ${JSON.stringify(reached)}`);
});

/** A temporary repository with one commit, for the read-only check. Removed by the caller. */
function makeRepo(): { dir: string; baseCommit: string } {
  const dir = mkdtempSync(join(tmpdir(), "intent-readonly-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "fixture@localhost");
  git("config", "user.name", "test");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "fixture");
  return { dir, baseCommit: git("rev-parse", "HEAD") };
}
