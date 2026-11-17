import { FILES_PLACEHOLDER, REPORT_PLACEHOLDER } from "./eval-config.js";
import type { CaseStatus, ParsedReport } from "./eval-report.js";

// Pure rules of validating one task: the round verdict, the focused argv, and the restore lists. No I/O.
// Only three runner reports can make a task valid. An exit code can reject, and a missing or invalid report is undecided.

export const HIDDEN_FILES_MAX = 100,
  EXPECTED_CASES_MAX = 5_000,
  FOCUSED_SECONDS = 600,
  SETUP_SECONDS = 600,
  GUARD_SECONDS = 600,
  PREPARE_SECONDS = 600,
  ATTEMPTS_MAX = 3;

export type RoundOutcome = { kind: "report"; report: ParsedReport } | { kind: "missing" } | { kind: "timeout" } | { kind: "setup-failed" };
export type RoundFacts = { R1?: RoundOutcome; guards?: "passed" | "failed"; B1?: RoundOutcome; R2?: RoundOutcome; B2?: RoundOutcome; R3?: RoundOutcome };
export type RoundVerdict =
  | { kind: "next"; step: "R1" | "guards" | "B1" | "R2" | "B2" | "R3" }
  | { kind: "valid"; expected: string[] }
  | { kind: "reject"; reason: "not-fail-to-pass" | "guard-failed" | "flaky" | "too-slow" | "reference-too-wide" }
  | { kind: "undecided"; cause: "report-missing" | "report-invalid" | "setup-failed" };

type Cases = ReadonlyMap<string, CaseStatus>;

/** The verdict of a round that produced no parsed report, or undefined when it did. */
function unparsed(outcome: RoundOutcome): RoundVerdict | undefined {
  if (outcome.kind === "timeout") return { kind: "reject", reason: "too-slow" };
  if (outcome.kind === "setup-failed") return { kind: "undecided", cause: "setup-failed" };
  if (outcome.kind === "missing") return { kind: "undecided", cause: "report-missing" };
  return outcome.report.state === "invalid" ? { kind: "undecided", cause: "report-invalid" } : undefined;
}

/** The cases of a round whose report parsed. The caller has checked `unparsed` first. */
function casesOf(outcome: RoundOutcome): Cases {
  if (outcome.kind !== "report" || outcome.report.state !== "parsed") throw new TypeError("A round without a parsed report has no cases.");
  return outcome.report.cases;
}

function passedOf(cases: Cases): Set<string> {
  return new Set([...cases].filter(([, status]) => status === "passed").map(([key]) => key));
}

/** The expected keys that a round does not pass: failed, skipped, or absent. */
function notPassedOf(expected: ReadonlySet<string>, cases: Cases): Set<string> {
  const passed = passedOf(cases);
  return new Set([...expected].filter(key => !passed.has(key)));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(key => b.has(key));
}

const next = (step: "R1" | "guards" | "B1" | "R2" | "B2" | "R3"): RoundVerdict => ({ kind: "next", step });
const reject = (reason: "not-fail-to-pass" | "guard-failed" | "flaky" | "reference-too-wide"): RoundVerdict => ({ kind: "reject", reason });

/**
 * The next step of a validation, or its verdict. E is the passed keys of R1. B1 and B2 must not pass the same nonempty
 * part of E, and R2 and R3 must pass exactly E. A round that the facts do not yet hold is the next step to run.
 */
export function nextRound(facts: RoundFacts): RoundVerdict {
  if (facts.R1 === undefined) return next("R1");
  const stopR1 = unparsed(facts.R1);
  if (stopR1) return stopR1;
  const expected = passedOf(casesOf(facts.R1));
  if (expected.size === 0) return reject("not-fail-to-pass");
  if (expected.size > EXPECTED_CASES_MAX) return reject("reference-too-wide");
  if (facts.guards === undefined) return next("guards");
  if (facts.guards === "failed") return reject("guard-failed");

  if (facts.B1 === undefined) return next("B1");
  const stopB1 = unparsed(facts.B1);
  if (stopB1) return stopB1;
  const failingB1 = notPassedOf(expected, casesOf(facts.B1));
  if (failingB1.size === 0) return reject("not-fail-to-pass");

  if (facts.R2 === undefined) return next("R2");
  const stopR2 = unparsed(facts.R2);
  if (stopR2) return stopR2;
  if (!sameSet(passedOf(casesOf(facts.R2)), expected)) return reject("flaky");

  if (facts.B2 === undefined) return next("B2");
  const stopB2 = unparsed(facts.B2);
  if (stopB2) return stopB2;
  if (!sameSet(notPassedOf(expected, casesOf(facts.B2)), failingB1)) return reject("flaky");

  if (facts.R3 === undefined) return next("R3");
  const stopR3 = unparsed(facts.R3);
  if (stopR3) return stopR3;
  if (!sameSet(passedOf(casesOf(facts.R3)), expected)) return reject("flaky");
  return { kind: "valid", expected: [...expected].sort() };
}

/** The focused test's arguments. Each `{files}` becomes one `./`-prefixed path, so no name reads as an option. */
export function focusedArgv(command: { command: string; args: string[] }, files: readonly string[], report: string): string[] {
  return command.args.flatMap(arg => (arg === FILES_PLACEHOLDER
    ? files.map(file => `./${file}`)
    : [arg.split(REPORT_PLACEHOLDER).join(report)]));
}

/** True when a grading path covers the file: equal to it, or under it. */
function covered(file: string, paths: readonly string[]): boolean {
  return paths.some(path => file === path || file.startsWith(`${path}/`));
}

/**
 * `present` is what the grader's diff printed. `focus` is the hidden files it printed; `restore` is the hidden files
 * and the task's files under a grading path, intersected with `present`. The host never adds a name the grader did not print.
 */
export function restoreLists(input: { present: readonly string[]; hiddenFiles: readonly string[]; files: readonly string[]; gradingPaths: readonly string[] }):
  { focus: string[]; restore: string[] } | { reject: "no-hidden-tests" | "reference-too-wide" } {
  const present = [...new Set(input.present)];
  const hidden = new Set(input.hiddenFiles);
  const focus = present.filter(name => hidden.has(name));
  if (focus.length === 0) return { reject: "no-hidden-tests" };
  if (focus.length > HIDDEN_FILES_MAX) return { reject: "reference-too-wide" };
  const listed = new Set(input.files.filter(file => covered(file, input.gradingPaths)));
  const restore = present.filter(name => hidden.has(name) || listed.has(name));
  return { focus, restore };
}
