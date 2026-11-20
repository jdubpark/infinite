import test from "node:test";
import assert from "node:assert/strict";
import type { Criterion } from "../packages/host/src/objective-types.js";
import {
  admit, type AdmissionFacts, type Decision, outcomeSource, type RunView, type SearchClass, type SearchEvent, searchPolicy,
  type SearchState, step, type TeamSearch,
} from "../packages/host/src/search-engine.js";

/*
 * Behaviour of the search engine (INF-336) against the acceptance items of
 * docs/superpowers/specs/2026-11-18-search-mode-design.md that a pure module decides. Expected values come from the
 * design's text: its allowance example (4 × 35 + 60 = 200 minutes), its window (2 × (20 + gateMinutes)), its reserve
 * example (eight attempts left, one open task, one challenger), and its rules. Event orders under random interleaving
 * are the simulator's (tests/search-engine-sim.test.ts).
 */

const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const BASE = "b".repeat(40);
const CHAMPION = "m-champion";
const CRITERION: Criterion = {
  id: "c1", origin: "owner", statement: "The parser test passes", check: { kind: "command", command: "digest-parser-test" },
  producer: "host", threshold: { kind: "pass" }, pinned: [{ path: "tests/parser.test.ts", blob: "a".repeat(40) }], state: "active",
};
/** In Part 2 order. Against an `anthropic` champion, three are eligible: openai, google, mistral. */
const CANDIDATES = [
  { profileId: "p-gpt", family: "openai", limited: false },
  { profileId: "p-claude-2", family: "anthropic", limited: false },
  { profileId: "p-gemini", family: "google", limited: false },
  { profileId: "p-mystery", limited: false },
  { profileId: "p-mistral", family: "mistral", limited: false },
];

function view(minutes: number, policy: TeamSearch = {}, over: Partial<RunView> = {}): RunView {
  return {
    now: at(minutes), policy: searchPolicy({ mode: "live", ...policy }), checkMinutes: 60, otherSearchWide: false,
    championFamily: "anthropic", candidates: CANDIDATES, spareWorkerSlots: 4, freeSessionSlots: 4, spareAttempts: 20, widened: [], ...over,
  };
}

type FactsPatch = { [K in keyof AdmissionFacts]?: AdmissionFacts[K] extends object ? Partial<AdmissionFacts[K]> : AdmissionFacts[K] };

/** The project's applied `start` decisions, oldest first: `oldest`, then `searches` searches among `total − 1` newer ones. */
const starts = (total: number, searches: number, oldest = false) => [oldest, ...Array.from({ length: total - 1 }, (_, index) => index < searches)];

/** Every condition holds unless a patch breaks one. */
function facts(patch: FactsPatch = {}, policy: TeamSearch = {}): AdmissionFacts {
  const base: AdmissionFacts = {
    id: "search-1", now: at(0), policy: searchPolicy({ mode: "live", ...policy }), checkMinutes: 60,
    routing: { mode: "auto", coversStart: true, revoked: false },
    run: { goalCycle: true, recordDigest: true, requiredChecks: ["digest-lint", "digest-parser-test"], searches: 0, wideSearch: false },
    task: { role: "implementer", risk: "normal", firstAttempt: true, criterionId: "c1", criterionShared: false, duel: false,
      exploratoryStart: false, baseCommit: BASE, decisionKey: "decision-1" },
    champion: { memberId: CHAMPION, profileId: "p-claude" },
    criterion: CRITERION,
    pins: { atBase: true, owned: false },
    project: { paused: false, starts: starts(40, 0) },
  };
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = value !== null && typeof value === "object" && !Array.isArray(value) && current !== null && typeof current === "object"
      ? { ...current, ...value } : value;
  }
  return out as AdmissionFacts;
}

/** A search and every decision it returned, stepped one event at a time. */
class Drive {
  all: Decision[] = [];
  last: Decision[] = [];
  constructor(public search: SearchState, private readonly policy: TeamSearch = {}) {}

  at(minutes: number, event: SearchEvent, over: Partial<RunView> = {}): Decision[] {
    const result = step(this.search, event, view(minutes, this.policy, over));
    this.search = result.search;
    this.last = result.decisions;
    this.all.push(...result.decisions);
    return result.decisions;
  }

  /** A contestant reports a result, and its capture completes. */
  deliver(minutes: number, memberId: string, captured: Partial<Extract<SearchEvent, { kind: "captured" }>> = {}): void {
    this.at(minutes, { kind: "result", memberId });
    this.at(minutes + 1, { kind: "captured", memberId, commit: `commit-${memberId}`, tree: `tree-${memberId}`, scope: "ok", empty: false, ...captured });
  }

  member(memberId: string) {
    return this.search.contestants.find(c => c.memberId === memberId)!;
  }
}

function admitted(patch: FactsPatch = {}, policy: TeamSearch = {}): Drive {
  const admission = admit(facts(patch, policy));
  assert.equal(admission.admitted, true, "every condition holds");
  if (!admission.admitted) throw new Error("unreachable");
  return new Drive(admission.search, policy);
}

/** Admitted and armed: the base run failed at minute 5. */
function armed(policy: TeamSearch = {}, over: Partial<RunView> = {}): Drive {
  const drive = admitted({}, policy);
  drive.at(5, { kind: "base", outcome: "fail", ms: 60_000 }, over);
  return drive;
}

/** A launch's receipt: the challengers the spend fuse admitted, by member and profile. */
const receipt = (launch: number, ...members: [string, string][]): SearchEvent =>
  ({ kind: "started", launch, challengers: members.map(([memberId, profileId]) => ({ memberId, profileId })) });
const launch = (n: number, ...profileIds: string[]): Decision => ({ kind: "start-challengers", launch: n, profileIds, baseCommit: BASE });

/** Armed, then the champion's result failed its gate at minute 30 and two challengers (attempts 3) started. */
function widened(policy: TeamSearch = {}): Drive {
  const drive = armed(policy);
  drive.deliver(10, CHAMPION);
  drive.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 });
  const start = drive.last.find(d => d.kind === "start-challengers");
  assert.ok(start?.kind === "start-challengers", "the failed champion widens");
  drive.at(30, receipt(start.launch, ...start.profileIds.map((profileId, index): [string, string] => [`m-c${index + 1}`, profileId])));
  assert.equal(drive.search.state, "wide");
  return drive;
}

const kinds = (decisions: Decision[]) => decisions.map(d => d.kind);
const release = (state: "exhausted" | "abandoned", reason: string): Decision => ({ kind: "release", memberId: CHAMPION, state, reason });
const stop = (reason: string, ...memberIds: string[]): Decision => ({ kind: "stop", memberIds, reason });

test("live: a failing base run arms the search with one implementer; any other base end abandons it with production rows (acceptance 3, 18)", () => {
  const admission = admit(facts());
  assert.ok(admission.admitted);
  assert.deepEqual(admission.decisions, [{ kind: "base-run", commit: BASE }]);
  assert.equal(admission.search.state, "admitting");

  const armedSearch = new Drive(admission.search);
  armedSearch.at(5, { kind: "base", outcome: "fail", ms: 60_000 });
  assert.equal(armedSearch.search.state, "armed");
  assert.deepEqual(armedSearch.last, [], "under after-fail no challenger starts at arming");
  assert.equal(outcomeSource(armedSearch.search), "search");

  for (const [outcome, reason] of [["pass", "base-pass"], ["timeout", "base-timeout"], ["setup-failed", "base-setup"], ["yielded", "base-yielded"]] as const) {
    const drive: Drive = new Drive(admission.search);
    drive.at(5, { kind: "base", outcome, ms: 60_000 });
    assert.equal(drive.search.state, "abandoned", outcome);
    assert.equal(drive.search.endReason, reason);
    assert.deepEqual(drive.last, [{ kind: "stop-operations" }, release("abandoned", reason)], outcome);
    assert.equal(outcomeSource(drive.search), "production", `${outcome}: a search abandoned before it armed leaves production rows`);
  }
});

test("a champion result that arrives during the base run waits for it, then is gated or released as the base run decided (Part 3, acceptance 11)", () => {
  const drive = admitted();
  drive.at(3, { kind: "result", memberId: CHAMPION });
  assert.deepEqual(drive.last, [], "nothing is captured before the base run ends");
  assert.equal(drive.search.holdUntil, at(3 + 200), "the allowance counts the open base run: 4 × 35 + 60 minutes");
  const passing = new Drive(drive.search);
  const held = new Drive(drive.search);
  drive.at(5, { kind: "base", outcome: "fail", ms: 60_000 });
  assert.deepEqual(drive.last, [{ kind: "capture", memberId: CHAMPION }]);
  passing.at(5, { kind: "base", outcome: "pass", ms: 60_000 });
  assert.deepEqual(passing.last, [{ kind: "stop-operations" }, release("abandoned", "base-pass")]);

  held.at(203, { kind: "tick" });
  assert.deepEqual([held.search.state, held.search.endReason], ["exhausted", "hold"], "at holdUntil the search is exhausted, also before it armed");
  assert.deepEqual(held.last, [{ kind: "stop-operations" }, release("exhausted", "hold")]);
  assert.equal(outcomeSource(held.search), "production", "it never armed");
});

test("after-fail: a passing champion integrates and no second implementer ever starts (acceptance 6)", () => {
  const drive = armed();
  drive.at(10, { kind: "result", memberId: CHAMPION });
  assert.deepEqual(drive.last, [{ kind: "capture", memberId: CHAMPION }]);
  drive.at(11, { kind: "captured", memberId: CHAMPION, commit: "commit-champion", tree: "tree-champion", scope: "ok", empty: false });
  assert.deepEqual(drive.last, [{ kind: "gate", memberId: CHAMPION, commit: "commit-champion" }]);
  drive.at(30, { kind: "gated", memberId: CHAMPION, outcome: "pass", ms: 1000 });
  assert.equal(drive.search.state, "resolved");
  assert.equal(drive.search.class, "champion-pass");
  assert.deepEqual(drive.last, [{ kind: "stop-operations" }, { kind: "integrate", memberId: CHAMPION }]);
  assert.ok(!kinds(drive.all).includes("start-challengers"));
});

test("after-fail: a failed champion widens to challengers of new families from its base commit, and none without its family (acceptance 6)", () => {
  const drive = armed();
  drive.deliver(10, CHAMPION);
  drive.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 });
  assert.deepEqual(drive.last, [launch(1, "p-gpt", "p-gemini")], "Part 2 order, skipping the champion's family and the unknown one, up to attempts − 1");
  assert.ok(!kinds(drive.all).includes("integrate"), "the failed result is not integrated");

  const unknown = armed({}, { championFamily: undefined });
  unknown.deliver(10, CHAMPION);
  unknown.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 }, { championFamily: undefined });
  assert.equal(unknown.search.state, "exhausted");
  assert.deepEqual(unknown.last, [{ kind: "stop-operations" }, release("exhausted", "no-challenger")]);
});

test("together: challengers start at arming when conditions 9 to 12 hold; otherwise the search stays armed and widens on a failure (acceptance 7)", () => {
  const drive = armed({ start: "together" });
  assert.deepEqual(drive.last, [launch(1, "p-gpt", "p-gemini")]);

  const crowded = armed({ start: "together" }, { spareWorkerSlots: 0 });
  assert.equal(crowded.search.state, "armed");
  assert.deepEqual(crowded.last, []);
  crowded.deliver(10, CHAMPION);
  crowded.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 });
  assert.deepEqual(crowded.last, [launch(1, "p-gpt", "p-gemini")]);
});

test("the first result to pass in capture order wins; the others stop and a waiting capture is never gated (acceptance 8)", () => {
  const drive = widened({ attempts: 4 });
  assert.deepEqual(drive.search.contestants.map(c => c.profileId), ["p-claude", "p-gpt", "p-gemini", "p-mistral"]);
  drive.at(40, { kind: "result", memberId: "m-c1" });
  drive.at(41, { kind: "result", memberId: "m-c2" });
  drive.at(42, { kind: "captured", memberId: "m-c2", commit: "commit-c2", tree: "tree-c2", scope: "ok", empty: false });
  assert.deepEqual(drive.last, [{ kind: "gate", memberId: "m-c2", commit: "commit-c2" }], "captures, not results, set the gate order");
  drive.at(43, { kind: "captured", memberId: "m-c1", commit: "commit-c1", tree: "tree-c1", scope: "ok", empty: false });
  assert.deepEqual(drive.last, [], "one gate run at a time");
  drive.at(50, { kind: "gated", memberId: "m-c2", outcome: "pass", ms: 1000 });
  assert.equal(drive.search.winner, "m-c2");
  assert.equal(drive.search.class, "rescued");
  assert.deepEqual(drive.last, [{ kind: "stop-operations" }, stop("host", "m-c3"), { kind: "integrate", memberId: "m-c2" }]);

  const after = drive.search;
  const decided = drive.all.length;
  drive.at(55, { kind: "gated", memberId: "m-c1", outcome: "pass", ms: 1000 });
  drive.at(56, { kind: "resume" });
  assert.equal(drive.all.length, decided, "no gate run after the pass, also after a restart");
  assert.deepEqual(drive.search, after);
  assert.equal(drive.member("m-c1").gate, undefined);

  const failedFirst = widened();
  failedFirst.deliver(40, "m-c1");
  failedFirst.deliver(42, "m-c2");
  failedFirst.at(50, { kind: "gated", memberId: "m-c1", outcome: "timeout", ms: 900_000 });
  assert.deepEqual(failedFirst.last, [{ kind: "gate", memberId: "m-c2", commit: "commit-m-c2" }], "a failed gate moves to the next capture");
  failedFirst.at(60, { kind: "gated", memberId: "m-c2", outcome: "pass", ms: 1000 });
  assert.equal(failedFirst.search.winner, "m-c2");
});

test("a scope violation fails its contestant without a run or a block, and the search goes on (acceptance 9)", () => {
  const drive = armed();
  drive.deliver(10, CHAMPION, { scope: "violation" });
  assert.deepEqual(drive.member(CHAMPION).gate, { result: "fail-scope", ms: 0, at: at(11) });
  assert.deepEqual(kinds(drive.last), ["start-challengers"], "no gate run, no release");

  const wide = widened();
  wide.deliver(40, "m-c1", { scope: "violation" });
  assert.equal(wide.search.state, "wide", "the other challenger still works");
  assert.deepEqual(wide.last, []);
  wide.deliver(45, "m-c2", { empty: true });
  assert.equal(wide.member("m-c2").gate?.result, "fail-empty");
  assert.equal(wide.search.state, "exhausted");
});

test("every result failing, the wait, and the hold each end the search as exhausted and release the task (acceptance 10, 11)", () => {
  const allFail = widened();
  allFail.deliver(40, "m-c1");
  allFail.at(45, { kind: "gated", memberId: "m-c1", outcome: "fail", ms: 1000 });
  assert.equal(allFail.search.state, "wide");
  allFail.at(50, { kind: "left", memberId: "m-c2", reason: "stall" });
  assert.deepEqual(allFail.last, [stop("stall", "m-c2"), { kind: "stop-operations" }, release("exhausted", "all-failed")]);
  assert.equal(allFail.search.class, "none");

  // The champion failed at 30, so the wait ends at 90. m-c2's result was captured before then and is still gated.
  const wait = widened();
  wait.deliver(80, "m-c2");
  wait.at(91, { kind: "tick" });
  assert.deepEqual(wait.last, [stop("wait", "m-c1")]);
  assert.equal(wait.search.state, "wide");
  wait.at(100, { kind: "gated", memberId: "m-c2", outcome: "fail", ms: 1000 });
  assert.deepEqual(wait.last, [{ kind: "stop-operations" }, release("exhausted", "wait")]);

  // The champion's result arrived at 10, so the hold ends at 10 + 3 × 35 + 60 = 175, before the wait (150 + 60).
  const hold = armed();
  hold.deliver(10, CHAMPION);
  hold.at(150, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 });
  hold.at(150, receipt(1, ["m-c1", "p-gpt"], ["m-c2", "p-gemini"]));
  hold.deliver(160, "m-c1");
  assert.deepEqual(hold.last, [{ kind: "gate", memberId: "m-c1", commit: "commit-m-c1" }]);
  const steered = new Drive(hold.search);
  hold.at(175, { kind: "tick" });
  assert.deepEqual([hold.search.state, hold.search.endReason], ["exhausted", "hold"]);
  assert.deepEqual(hold.last, [{ kind: "stop-operations" }, stop("host", "m-c2"), release("exhausted", "hold")]);
  const released = hold.search;
  hold.at(180, { kind: "gated", memberId: "m-c1", outcome: "pass", ms: 1000 });
  assert.deepEqual(hold.search, released, "a gate run that closes after the hold changes nothing");
  assert.deepEqual(hold.last, []);
  steered.at(175, { kind: "halt", reason: "steer" });
  assert.deepEqual([steered.search.state, steered.search.endReason], ["exhausted", "hold"], "the hold that passed applies before a halt in the same step");
});

test("at the wait, a result that still waits for its capture does not hold the search open, and is never gated (rule 7, acceptance 10)", () => {
  // The champion failed at 30, so the wait ends at 90.
  const drive = widened();
  drive.at(85, { kind: "result", memberId: "m-c1" });
  assert.deepEqual(drive.last, [{ kind: "capture", memberId: "m-c1" }]);
  drive.at(90, { kind: "tick" });
  assert.deepEqual([drive.search.state, drive.search.endReason], ["exhausted", "wait"]);
  assert.deepEqual(drive.last, [stop("wait", "m-c2"), { kind: "stop-operations" }, release("exhausted", "wait")]);

  const gating = widened();
  gating.deliver(80, "m-c2");
  gating.at(85, { kind: "result", memberId: "m-c1" });
  gating.at(90, { kind: "tick" });
  assert.equal(gating.search.state, "wide", "m-c2's capture, made before the wait, is still gated");
  gating.at(91, { kind: "captured", memberId: "m-c1", commit: "commit-m-c1", tree: "tree-m-c1", scope: "ok", empty: false });
  gating.at(92, { kind: "resume" });
  assert.deepEqual(gating.last, [{ kind: "gate", memberId: "m-c2", commit: "commit-m-c2" }], "a restart after the wait captures nothing again");
  gating.at(95, { kind: "gated", memberId: "m-c2", outcome: "fail", ms: 1000 });
  assert.deepEqual(gating.last, [{ kind: "stop-operations" }, release("exhausted", "wait")], "the capture after the wait is not gated");
  assert.equal(gating.member("m-c1").gate, undefined);
});

test("a launch's receipt: members acknowledged after the end or the wait are stopped; repeated and unknown receipts change nothing (rules 4, 6, 8)", () => {
  // The champion's result arrived at 10, so the hold ends at 175; it fails at 174, and the receipt arrives at 175.
  const crossing = armed();
  crossing.deliver(10, CHAMPION);
  crossing.at(174, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 });
  assert.deepEqual(crossing.last, [launch(1, "p-gpt", "p-gemini")]);
  crossing.at(175, receipt(1, ["m-c1", "p-gpt"], ["m-c2", "p-gemini"]));
  assert.deepEqual([crossing.search.state, crossing.search.endReason], ["exhausted", "hold"]);
  assert.deepEqual(crossing.last, [{ kind: "stop-operations" }, release("exhausted", "hold"), stop("host", "m-c1", "m-c2")]);
  const ended = crossing.search;
  crossing.at(176, receipt(1, ["m-c1", "p-gpt"], ["m-c2", "p-gemini"]));
  assert.deepEqual([crossing.last, crossing.search], [[], ended], "a repeated receipt stops nothing twice");

  // The champion failed at 30, so the wait ends at 90; the receipt arrives at 95.
  const afterWait = armed();
  afterWait.deliver(10, CHAMPION);
  afterWait.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 });
  afterWait.at(95, receipt(1, ["m-c1", "p-gpt"]));
  assert.deepEqual([afterWait.search.state, afterWait.search.endReason], ["exhausted", "wait"]);
  assert.deepEqual(afterWait.last, [{ kind: "stop-operations" }, release("exhausted", "wait"), stop("host", "m-c1")]);

  const won = widened();
  won.deliver(40, "m-c1");
  won.at(50, { kind: "gated", memberId: "m-c1", outcome: "pass", ms: 1000 });
  assert.equal(won.search.winner, "m-c1");
  const resolved = won.search;
  won.at(60, receipt(1, ["m-c1", "p-gpt"], ["m-c2", "p-gemini"]));
  assert.deepEqual([won.last, won.search], [[], resolved], "a repeated receipt never stops the winner");
  won.at(61, receipt(7, ["m-x", "p-mistral"]));
  assert.deepEqual([won.last, won.search], [[], resolved], "a receipt of a launch the search never made changes nothing");

  const open = armed();
  const before = open.search;
  open.at(6, receipt(1, ["m-x", "p-gpt"]));
  open.at(7, { kind: "result", memberId: "m-ghost" });
  open.at(8, { kind: "left", memberId: "m-ghost", reason: "stall" });
  assert.deepEqual([open.all, open.search], [[], before], "events of a launch or a member the search does not know change nothing");

  // Under together the launch at arming is still out when the champion fails: no second launch; the receipt decides.
  const inFlight = armed({ start: "together" });
  inFlight.deliver(10, CHAMPION);
  inFlight.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 });
  assert.deepEqual(inFlight.last, [], "one launch at a time");
  inFlight.at(31, receipt(1));
  assert.deepEqual([inFlight.search.state, inFlight.search.endReason], ["exhausted", "no-challenger"], "the fuse refused every challenger");
});

test("a restart at rest repeats the launch that waits for its receipt, under its number, and nothing once it arrived (acceptance 16)", () => {
  const drive = armed({ start: "together" });
  drive.at(6, { kind: "resume" });
  assert.deepEqual(drive.last, [launch(1, "p-gpt", "p-gemini")]);
  drive.at(7, receipt(1, ["m-c1", "p-gpt"], ["m-c2", "p-gemini"]));
  assert.equal(drive.search.state, "wide");
  drive.at(8, { kind: "resume" });
  assert.deepEqual(drive.last, []);
});

test("a stalled champion is stopped without a replacement and released only when the search ends (acceptance 10)", () => {
  const drive = armed();
  drive.at(20, { kind: "left", memberId: CHAMPION, reason: "stall" });
  assert.deepEqual(drive.last, [stop("stall", CHAMPION), launch(1, "p-gpt", "p-gemini")]);
  assert.equal(drive.search.holdUntil, at(20 + 165));
  assert.equal(drive.search.waitUntil, at(20 + 60));
  drive.at(20, receipt(1, ["m-c1", "p-gpt"], ["m-c2", "p-gemini"]));
  drive.at(30, { kind: "left", memberId: "m-c1", reason: "limit" });
  assert.ok(!kinds(drive.all).includes("release"));
  drive.at(40, { kind: "left", memberId: "m-c2", reason: "permission" });
  assert.deepEqual(drive.last.at(-1), release("exhausted", "all-failed"));
});

test("a champion's question abandons the search, stops every challenger, and the attempts keep source search (acceptance 12, 18)", () => {
  const drive = armed({ start: "together" });
  drive.at(5, receipt(1, ["m-c1", "p-gpt"], ["m-c2", "p-gemini"]));
  drive.at(20, { kind: "left", memberId: CHAMPION, reason: "question" });
  assert.equal(drive.search.state, "abandoned");
  assert.deepEqual(drive.last, [{ kind: "stop-operations" }, stop("host", "m-c1", "m-c2"), release("abandoned", "champion-question")]);
  assert.equal(outcomeSource(drive.search), "search");
  assert.equal(drive.search.class, "none");
});

test("together: a challenger that passes while the champion works wins as challenger-first and stops the champion (Part 8)", () => {
  const drive = armed({ start: "together" });
  drive.at(5, receipt(1, ["m-c1", "p-gpt"], ["m-c2", "p-gemini"]));
  drive.deliver(20, "m-c1");
  drive.at(30, { kind: "gated", memberId: "m-c1", outcome: "pass", ms: 1000 });
  assert.equal(drive.search.class, "challenger-first");
  assert.deepEqual(drive.last, [{ kind: "stop-operations" }, stop("host", CHAMPION, "m-c2"), { kind: "integrate", memberId: "m-c1" }]);
});

test("the reserve: no challenger below spareAttempts 3; eight attempts left and one open task start one challenger, not two (acceptance 13)", () => {
  const none = armed();
  none.deliver(10, CHAMPION);
  none.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 }, { spareAttempts: 3 });
  assert.deepEqual(none.last, [{ kind: "stop-operations" }, release("exhausted", "no-challenger")]);

  // spareAttempts = 8 left − 1 open task − 3 = 4, so one challenger keeps it at 3.
  const one = armed({ attempts: 4 });
  one.deliver(10, CHAMPION);
  one.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 }, { spareAttempts: 8 - 1 - 3 });
  assert.deepEqual(one.last, [launch(1, "p-gpt")]);
});

test("admission counts the first failed condition, in order 1 to 7 (acceptance 14)", () => {
  const cases: [string, FactsPatch, number][] = [
    ["routing off", { routing: { mode: "shadow" } }, 1],
    ["routing revoked", { routing: { revoked: true } }, 1],
    ["an elevated-risk task", { task: { risk: "elevated" } }, 2],
    ["not a goal cycle run", { run: { goalCycle: false } }, 2],
    ["a derived criterion", { criterion: { ...CRITERION, origin: "derived" } }, 3],
    ["a criterion that pins no file", { criterion: { ...CRITERION, pinned: [] } }, 3],
    ["a command that is not a required check", { run: { requiredChecks: ["digest-lint"] } }, 3],
    ["a criterion another task names", { task: { criterionShared: true } }, 3],
    ["a pinned file changed before the base", { pins: { atBase: false } }, 4],
    ["a pinned file the task owns", { pins: { owned: true } }, 4],
    ["an exploratory start", { task: { exploratoryStart: true } }, 5],
    ["two searches already", { run: { searches: 2 } }, 6],
    ["another search is wide", { run: { wideSearch: true } }, 6],
    ["5 of 41 is over 0.1", { project: { starts: starts(40, 4) } }, 7],
    ["the allowance does not fit before the deadline", { run: { deadline: at(199) } }, 7],
    ["an elevated task in a revoked run", { routing: { revoked: true }, task: { risk: "elevated" } }, 1],
  ];
  for (const [name, patch, condition] of cases) assert.deepEqual(admit(facts(patch)), { admitted: false, condition }, name);
  assert.deepEqual(admit(facts({}, { mode: "off" })), { admitted: false, condition: 1 }, "mode off");
  assert.equal(admit(facts({ run: { deadline: at(200) } })).admitted, true, "200 minutes fit: 4 gate runs of 35 and the wait");
  assert.equal(admit(facts({ project: { starts: starts(40, 3) } })).admitted, true, "4 of 41 stays at or below 0.1");
  const measure = admit(facts({ run: { deadline: at(10) }, project: { starts: starts(40, 39, true) } }, { mode: "measure" }));
  assert.ok(measure.admitted, "the share and the live allowance do not limit measure (acceptance 4)");
  assert.deepEqual(measure.decisions, [], "measure runs its base run at the boundary");
});

test("the share counts the newest 99 applied start decisions and the new search: a window of 100 never passes the share (condition 7)", () => {
  // 24 searches among the newest 99, the oldest decision production: one more makes 25 of 100.
  assert.deepEqual(admit(facts({ project: { starts: starts(100, 24) } }, { share: 0.249 })), { admitted: false, condition: 7 });
  assert.equal(admit(facts({ project: { starts: starts(100, 24) } }, { share: 0.25 })).admitted, true, "25 of 100 is 0.25");
  assert.equal(admit(facts({ project: { starts: [...Array<boolean>(30).fill(true), ...Array<boolean>(99).fill(false)] } })).admitted, true,
    "searches older than the newest 99 decisions do not count");
  assert.deepEqual(admit(facts({ project: { starts: [] } })), { admitted: false, condition: 7 }, "a first decision alone is a share of 1");
});

test("no challenger starts when every free worker slot has a ready task, and the search is exhausted (acceptance 14)", () => {
  const drive = armed();
  drive.deliver(10, CHAMPION);
  drive.at(30, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 }, { spareWorkerSlots: 0 });
  assert.deepEqual(drive.last, [{ kind: "stop-operations" }, release("exhausted", "no-challenger")]);
});

test("the brake: an end that leaves 10 widened searches with 1 rescue emits the pause; only the owner's pause state refuses admission (acceptance 17)", () => {
  const history = (rescued: number, total = 10): SearchClass[] =>
    Array.from({ length: total }, (_, index) => (index < rescued ? "rescued" : "none"));
  assert.deepEqual(admit(facts({ project: { paused: true } })), { admitted: false, condition: 6 }, "a pause with no widened search");
  assert.deepEqual(admit(facts({ project: { paused: true } }, { mode: "measure" })), { admitted: false, condition: 6 });

  const drive = widened();
  drive.at(40, { kind: "left", memberId: "m-c1", reason: "stall" });
  drive.at(41, { kind: "left", memberId: "m-c2", reason: "stall" }, { widened: history(1, 9) });
  assert.deepEqual(drive.last.at(-1), { kind: "pause" });
  const engaged = widened();
  engaged.at(40, { kind: "left", memberId: "m-c1", reason: "stall" });
  engaged.at(41, { kind: "left", memberId: "m-c2", reason: "stall" }, { widened: ["rescued", ...history(1)] });
  assert.deepEqual(engaged.last.at(-1), { kind: "pause" }, "only the last 10 count, and an engaged brake pauses again");
  const enough = widened();
  enough.at(40, { kind: "left", memberId: "m-c1", reason: "stall" });
  enough.at(41, { kind: "left", memberId: "m-c2", reason: "stall" }, { widened: history(2, 9) });
  assert.ok(!kinds(enough.last).includes("pause"), "2 rescues in the last 10");
});

test("measure: the base run and the gate run at the boundary, inside the window, and nothing else changes (acceptance 4, 5)", () => {
  const policy: TeamSearch = { mode: "measure" };
  const drive = admitted({}, policy);
  drive.at(10, { kind: "result", memberId: CHAMPION });
  drive.at(12, { kind: "integrated", memberId: CHAMPION, commit: "commit-champion", tree: "tree-champion", empty: false });
  drive.at(20, { kind: "boundary", searches: 1 });
  assert.deepEqual(drive.last, [{ kind: "base-run", commit: BASE }]);
  assert.equal(drive.search.holdUntil, at(20 + 70), "the window is two gate runs of 20 + 15 minutes");
  drive.at(30, { kind: "base", outcome: "fail", ms: 60_000 });
  assert.deepEqual(drive.last, [{ kind: "gate", memberId: CHAMPION, commit: "commit-champion" }]);
  drive.at(50, { kind: "gated", memberId: CHAMPION, outcome: "pass", ms: 1000 });
  assert.equal(drive.search.state, "measured");
  assert.equal(drive.search.class, undefined);
  assert.equal(outcomeSource(drive.search), "production");
  assert.deepEqual(kinds(drive.all), ["base-run", "gate", "stop-operations"], "no capture, challenger, integration or release");

  const short = admitted({}, policy);
  short.at(12, { kind: "integrated", memberId: CHAMPION, commit: "commit-champion", tree: "tree-champion", empty: false });
  short.at(20, { kind: "boundary", searches: 2 }, { checkMinutes: 10 });
  assert.equal(short.search.holdUntil, at(20 + 140), "the window counts gateMinutes, also when the check limit is shorter");

  const late = admitted({}, policy);
  late.at(12, { kind: "integrated", memberId: CHAMPION, commit: "commit-champion", tree: "tree-champion", empty: false });
  late.at(20, { kind: "boundary", searches: 1 }, { deadline: at(20 + 70 + 59) });
  assert.deepEqual([late.search.state, late.search.endReason], ["abandoned", "deadline"], "the window and one check command must fit");

  const window = admitted({}, policy);
  window.at(12, { kind: "integrated", memberId: CHAMPION, commit: "commit-champion", tree: "tree-champion", empty: false });
  window.at(20, { kind: "boundary", searches: 1 });
  window.at(30, { kind: "base", outcome: "fail", ms: 60_000 });
  window.at(90, { kind: "tick" });
  assert.deepEqual([window.search.state, window.search.endReason], ["abandoned", "window"]);
  assert.deepEqual(window.last, [{ kind: "stop-operations" }], "the open gate run is stopped");

  const stalled = admitted({}, policy);
  stalled.at(15, { kind: "left", memberId: CHAMPION, reason: "stall" });
  assert.deepEqual([stalled.search.state, stalled.search.endReason], ["abandoned", "champion-stall"]);
  stalled.at(40, { kind: "boundary", searches: 1 });
  assert.deepEqual(stalled.last, [], "no measurement runs for the replacement's result");
});

test("PROPOSED: a host clock that steps back records nothing earlier than the record already holds", () => {
  const drive = armed();
  drive.at(30, { kind: "result", memberId: CHAMPION });
  drive.at(20, { kind: "captured", memberId: CHAMPION, commit: "commit-champion", tree: "tree-champion", scope: "ok", empty: false });
  drive.at(10, { kind: "gated", memberId: CHAMPION, outcome: "fail", ms: 1000 });
  assert.equal(drive.member(CHAMPION).gate?.at, at(30));
  assert.equal(drive.search.waitUntil, at(30 + 60), "the wait counts from the latest moment recorded");
  assert.equal(drive.search.holdUntil, at(30 + 165));
});
