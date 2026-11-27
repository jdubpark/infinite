import test from "node:test";
import assert from "node:assert/strict";
import {
  configRef,
  endingOfBlock,
  endingOfReport,
  gradeOf,
  isolationLabel,
  nextSlot,
  restoreSet,
  trialProfileKey,
  VOID_ATTEMPTS_MAX,
  type SlotRow,
} from "../packages/host/src/eval-trial-rules.js";
import { profileIdentity } from "../packages/host/src/run-events.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { ParsedReport } from "../packages/host/src/eval-report.js";

const parsed = (entries: Record<string, "passed" | "failed" | "skipped">): ParsedReport => ({
  state: "parsed",
  cases: new Map(Object.entries(entries)),
});

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

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

const base = { overwritten: 0, diff: null, isolation: "none" as const };

test("every ending grades as the design says", () => {
  const expected = ["a", "b"];
  const both = parsed({ a: "passed", b: "passed" });

  const resolved = gradeOf({ ...base, ending: "graded", expected, report: both, guard: "passed" });
  assert.equal(resolved.resolved, true, "a report passing both cases with a passed guard resolves");
  assert.equal(resolved.expectedPassed, 2);
  assert.equal(resolved.expectedTotal, 2);
  assert.equal(resolved.guardPassed, true);

  const guardFailed = gradeOf({ ...base, ending: "graded", expected, report: both, guard: "failed" });
  assert.equal(guardFailed.resolved, false, "a failed guard keeps the trial unresolved");
  assert.equal(guardFailed.guardPassed, false);

  const onlyA = gradeOf({ ...base, ending: "graded", expected, report: parsed({ a: "passed", b: "failed" }) });
  assert.equal(onlyA.expectedPassed, 1, "one passing case out of two counts one");
  assert.equal(onlyA.guardPassed, null, "an absent guard is null, not false");
  assert.equal(onlyA.resolved, false);

  const skipped = gradeOf({ ...base, ending: "graded", expected, report: parsed({ a: "passed", b: "skipped" }) });
  assert.equal(skipped.expectedPassed, 1, "a skipped case is not a passed case");
  assert.equal(skipped.resolved, false);

  const noGuard = gradeOf({ ...base, ending: "graded", expected, report: both });
  assert.equal(noGuard.expectedPassed, 2);
  assert.equal(noGuard.guardPassed, null, "no guard run is null");
  assert.equal(noGuard.resolved, false, "every case passing does not resolve without a guard");

  const noReport = gradeOf({ ...base, ending: "graded", expected, guard: "passed" });
  assert.equal(noReport.expectedPassed, null, "no parsed report is unknown, not zero");
  assert.equal(noReport.resolved, false);

  const timeout = gradeOf({ ...base, ending: "timeout", expected, report: both, guard: "passed" });
  assert.equal(timeout.expectedPassed, null, "a timeout has no grade");
  assert.equal(timeout.guardPassed, null);
  assert.equal(timeout.resolved, false);
  assert.equal(timeout.expectedTotal, 2);

  const empty = gradeOf({ ...base, ending: "graded", expected: [], report: parsed({}), guard: "passed" });
  assert.equal(empty.resolved, false, "a task with no expected cases never resolves");

  assert.equal(endingOfBlock("missing-agent-report"), "no-result", "a member that exits without a report is no-result");
  assert.equal(endingOfBlock("unknown-code"), "void-host", "an unknown block code is a host void");
  assert.equal(endingOfBlock("task-scope-violation"), "scope-violation");
  assert.equal(endingOfBlock("halted"), "void-owner");
  assert.equal(endingOfReport("escalate"), "escalated");
  assert.equal(endingOfReport("question"), "question");
  assert.equal(endingOfReport("blocked"), "blocked");
});

test("the restore set takes tests and grading paths from the reference", () => {
  const testPath = (path: string) => /\.test\.js$/.test(path);
  const result = restoreSet({
    referenceChanged: ["src/a.js", "tests/a.test.js"],
    resultChanged: ["src/a.js", "package.json", "tests/b.test.js"],
    hiddenFiles: ["tests/a.test.js"],
    gradingPaths: ["package.json"],
    testPath,
  });
  assert.deepEqual(result.restore, ["package.json", "tests/a.test.js", "tests/b.test.js"]);
  assert.equal(result.overwritten, 2, "the result overwrote the grading file and one test file");
});

test("a grading path covers its files and not a sibling that shares its prefix", () => {
  const result = restoreSet({
    referenceChanged: ["docs/x.md", "docs-old/y.md"],
    resultChanged: [],
    hiddenFiles: [],
    gradingPaths: ["docs"],
    testPath: () => false,
  });
  assert.deepEqual(result.restore, ["docs/x.md"], "docs/x.md is under docs; docs-old/y.md is not");
  assert.equal(result.overwritten, 0);
});

test("a hidden file is restored even when neither side changed it", () => {
  const result = restoreSet({
    referenceChanged: [],
    resultChanged: [],
    hiddenFiles: ["fixtures/hidden.json"],
    gradingPaths: [],
    testPath: () => false,
  });
  assert.deepEqual(result.restore, ["fixtures/hidden.json"]);
  assert.equal(result.overwritten, 0, "a hidden file nobody changed overwrites nothing");
});

test("the next slot does not depend on the order of the rows", () => {
  const tasks = ["t1", "t2", "t3"];
  const configRefs = ["c1", "c2", "c3"];
  const rows: SlotRow[] = [
    { taskId: "t1", configRef: "c1", slot: 0, attempt: 0, state: "final", ending: "void-host" },
    { taskId: "t1", configRef: "c1", slot: 0, attempt: 1, state: "final", ending: "void-limit" },
    { taskId: "t1", configRef: "c1", slot: 1, attempt: 0, state: "final", ending: "graded" },
    { taskId: "t1", configRef: "c2", slot: 0, attempt: 0, state: "running", ending: null },
    { taskId: "t2", configRef: "c1", slot: 0, attempt: 0, state: "final", ending: "no-result" },
    { taskId: "t2", configRef: "c3", slot: 2, attempt: 0, state: "final", ending: "void-owner" },
    { taskId: "t3", configRef: "c2", slot: 1, attempt: 0, state: "final", ending: "graded" },
  ];
  const input = { tasks, configRefs, trialsPerTask: 3, rows };
  const expected = { taskId: "t1", configRef: "c1", slot: 0, attempt: 2 };
  assert.deepEqual(nextSlot(input), expected, "two voids on t1/c1/0 leave attempt 2 there");

  const random = mulberry32(20261117);
  for (let round = 0; round < 200; round += 1) {
    const order = shuffled(rows, random);
    assert.deepEqual(nextSlot({ ...input, rows: order }), expected, `shuffle ${round} changed the slot`);
  }

  assert.deepEqual(
    nextSlot({ tasks: ["t1"], configRefs: ["c1", "c2"], trialsPerTask: 1, rows: [] }),
    { taskId: "t1", configRef: "c1", slot: 0, attempt: 0 },
    "with no rows: the first task, slot 0, the first configuration, attempt 0",
  );

  const graded: SlotRow = { taskId: "t", configRef: "c1", slot: 0, attempt: 0, state: "final", ending: "graded" };
  assert.deepEqual(
    nextSlot({ tasks: ["t"], configRefs: ["c1", "c2"], trialsPerTask: 2, rows: [graded] }),
    { taskId: "t", configRef: "c2", slot: 0, attempt: 0 },
    "slot comes before configuration: t/c2/0 follows the graded t/c1/0",
  );
});

test("a void trial runs again at most twice", () => {
  const voidRow = (attempt: number, ending: SlotRow["ending"] = "void-host"): SlotRow =>
    ({ taskId: "t", configRef: "c", slot: 0, attempt, state: "final", ending });

  assert.equal(VOID_ATTEMPTS_MAX, 3);
  const twoVoids = nextSlot({ tasks: ["t"], configRefs: ["c"], trialsPerTask: 2, rows: [voidRow(0), voidRow(1)] });
  assert.deepEqual(twoVoids, { taskId: "t", configRef: "c", slot: 0, attempt: 2 }, "two voids leave attempt 2");

  const threeVoids = nextSlot({
    tasks: ["t"],
    configRefs: ["c"],
    trialsPerTask: 2,
    rows: [voidRow(0), voidRow(1), voidRow(2)],
  });
  assert.deepEqual(threeVoids, { taskId: "t", configRef: "c", slot: 1, attempt: 0 }, "a third void moves on to the next slot");
});

test("the isolation label needs every probe", () => {
  const ready = { state: "ready", fetch: "refused" };
  assert.equal(isolationLabel({ probe: ready, sourceClean: true }), "isolated");
  assert.equal(isolationLabel({ probe: { state: "ready", fetch: "open" }, sourceClean: true }), "none");
  assert.equal(isolationLabel({ probe: ready, sourceClean: false }), "none");
  assert.equal(isolationLabel({ probe: { state: "busy", fetch: "refused" }, sourceClean: true }), "none");
});

test("the configuration reference is stable for one profile and changes with it", () => {
  const profile = { id: "claude-fast", label: "Fast", provider: "claude" as const, model: "claude-haiku-5-5", effort: "low" as const, tier: "light" as const, dataUse: "standard" as const };
  const configuration = { profile, guidance: "as-of-base" as const, knowledge: "none" as const };
  const ref = configRef(configuration);
  assert.match(ref, /^[0-9a-f]{64}$/, "a SHA-256 hex digest");
  assert.equal(configRef({ ...configuration, profile: { ...profile, label: "Renamed" } }), ref, "the label is not part of the identity");
  assert.notEqual(configRef({ ...configuration, profile: { ...profile, effort: "high" } }), ref, "effort is part of the identity");
});

test("the profile key matches the outcome ledger's", () => {
  const claude = { id: "p1", label: "A", provider: "claude", model: "model-a", effort: "high", tier: "strong" } as TeamModelProfile;
  const opencode = { id: "p2", label: "B", provider: "opencode", model: "model-b", variant: "max", tier: "light" } as TeamModelProfile;
  const bare = { id: "p3", label: "C", provider: "claude", tier: "light" } as unknown as TeamModelProfile;
  for (const profile of [claude, opencode, bare]) {
    const identity = profileIdentity(profile, profile.provider);
    assert.deepEqual(trialProfileKey(profile), { provider: identity.provider, model: identity.model ?? null, effort: identity.effort ?? null });
  }
  assert.deepEqual(trialProfileKey(claude), { provider: "claude", model: "model-a", effort: "high" });
  assert.deepEqual(trialProfileKey(opencode), { provider: "opencode", model: "model-b", effort: "max" });
  assert.deepEqual(trialProfileKey(bare), { provider: "claude", model: null, effort: null });
});
