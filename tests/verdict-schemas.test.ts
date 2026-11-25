import test from "node:test";
import assert from "node:assert/strict";
import { VERDICT_LIMITS, criteriaRowsSchema, runAssessmentSchema, verdictReportSchema } from "../packages/host/src/verdict-types.js";
import { teamGoalContextSchema, teamProjectSchema, teamReportSchema } from "../packages/host/src/team-types.js";

const criterion = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `c${n}`,
  state: "met",
  evidence: Array.from({ length: 8 }, (_, index) => `${"h".repeat(399)}${index}`),
  note: "n".repeat(500),
  ...extra,
});
const report = (criteria: unknown[], extra: Record<string, unknown> = {}) => ({ kind: "verdict", result: "met", criteria, ...extra });
const maximal = report(Array.from({ length: 8 }, (_, index) => criterion(index + 1)));

test("the verdict report is strict and bounded", () => {
  assert.equal(VERDICT_LIMITS.criteria, 8);
  assert.equal(verdictReportSchema.safeParse(maximal).success, true, "a maximal report parses");
  assert.equal(teamReportSchema.safeParse(maximal).success, true, "the report tool accepts it");
  const refused: Array<[string, unknown]> = [
    ["9 criteria", report(Array.from({ length: 9 }, (_, index) => criterion(index + 1)))],
    ["no criteria", report([])],
    ["9 handles", report([criterion(1, { evidence: Array.from({ length: 9 }, () => "h") })])],
    ["a 401-character handle", report([criterion(1, { evidence: ["h".repeat(401)] })])],
    ["an empty handle", report([criterion(1, { evidence: [""] })])],
    ["a 501-byte note", report([criterion(1, { note: "n".repeat(501) })])],
    ["a note of 251 two-byte characters", report([criterion(1, { note: "é".repeat(251) })])],
    ["an empty note", report([criterion(1, { note: "" })])],
    ["two criteria with one id", report([criterion(1), criterion(1)])],
    ["an id outside the record's rule", report([criterion(1, { id: "C1" })])],
    ["an unknown key", report([criterion(1)], { extra: true })],
    ["an unknown criterion key", report([criterion(1, { extra: true })])],
    ["state pending-owner", report([criterion(1, { state: "pending-owner" })])],
    ["result achieved", report([criterion(1)], { result: "achieved" })],
  ];
  for (const [name, value] of refused) {
    assert.equal(verdictReportSchema.safeParse(value).success, false, `${name} is refused`);
    assert.equal(teamReportSchema.safeParse(value).success, false, `${name} is refused by the report tool`);
  }
  assert.equal(verdictReportSchema.safeParse(report([criterion(1, { note: "é".repeat(250) })])).success, true, "250 two-byte characters are 500 bytes");
});

const context = {
  id: "00000000-0000-4000-8000-000000000001", revision: 1, cycle: 2, successCriteria: "The export keeps its header row.",
  nonGoals: ["No new formats"], allowedPaths: ["src"], evidence: [], previousWork: [],
  deadlineAt: "2030-01-01T00:00:00.000Z", maxMembers: 4,
};
const BASE_CONTEXT = '{"id":"00000000-0000-4000-8000-000000000001","revision":1,"cycle":2,"successCriteria":"The export keeps its header row.","nonGoals":["No new formats"],"allowedPaths":["src"],"evidence":[],"previousWork":[],"deadlineAt":"2030-01-01T00:00:00.000Z","maxMembers":4}';
const row = (n: number, extra: Record<string, unknown> = {}) => ({ criterion: `c${n}`, status: "met", check: "tests-pass", ...extra });

test("the evaluator setting and the run fields stand alone", () => {
  const project = (objective: unknown) => teamProjectSchema.safeParse({ checks: [], establishChecks: true, objective });
  const base = project(undefined);
  assert.equal(base.success, true, "the project parses without an objective");
  assert.equal(project({ evaluator: "on" }).success, true);
  assert.equal(project({ evaluator: "off", register: "on" }).success, true);
  assert.equal(project({ evaluator: "maybe" }).success, false);
  const parsed = teamProjectSchema.parse({ checks: [], establishChecks: true, objective: { evaluator: "on" } });
  assert.equal(parsed.objective?.evaluator, "on");
  assert.equal(teamProjectSchema.parse({ checks: [], establishChecks: true, objective: { register: "on" } }).objective?.evaluator, undefined, "no default");
  assert.equal(JSON.stringify(teamGoalContextSchema.parse(context)), BASE_CONTEXT, "a context without criteria is as it was");
  assert.equal(teamGoalContextSchema.safeParse({ ...context, criteria: [row(1), row(2, { status: "pending-owner" })] }).success, true);
  assert.equal(criteriaRowsSchema.safeParse([row(1)]).success, true);
  const refused: Array<[string, unknown]> = [
    ["9 rows", Array.from({ length: 9 }, (_, index) => row(index + 1))],
    ["a 121-byte label", [row(1, { check: "c".repeat(121) })]],
    ["a label of 61 two-byte characters", [row(1, { check: "é".repeat(61) })]],
    ["a row with a note", [row(1, { note: "text" })]],
    ["an empty array", []],
    ["an unknown status", [row(1, { status: "achieved" })]],
  ];
  for (const [name, criteria] of refused) assert.equal(teamGoalContextSchema.safeParse({ ...context, criteria }).success, false, `${name} is refused in a context`);
  const assessment = {
    verdictId: "00000000-0000-4000-8000-000000000002", revision: 1, head: "a".repeat(40), kind: "reviewed", result: "met",
    counts: { met: 1, notMet: 0, inconclusive: 0, pendingOwner: 1 },
    criteria: [{ id: "c1", state: "met" }, { id: "c2", state: "pending-owner" }], at: "2030-01-01T00:00:00.000Z",
  };
  assert.equal(runAssessmentSchema.safeParse(assessment).success, true);
  assert.equal(runAssessmentSchema.safeParse({ ...assessment, note: "text" }).success, false, "a key outside the type is refused");
  assert.equal(runAssessmentSchema.safeParse({ ...assessment, reason: "other" }).success, false);
});
