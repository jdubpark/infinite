import assert from "node:assert/strict";
import test from "node:test";
import { missionReportSchema, recordedMissionReportSchema } from "../packages/host/src/mission-types.js";
import { questionProblem, recommendationOutcome, RECOMMENDATION_REQUIRED } from "../packages/host/src/question-recommendation.js";
import { recordedTeamReportSchema, teamReportSchema } from "../packages/host/src/team-types.js";

const question = { kind: "question", question: "Which store?", options: ["SQLite", "Files"] };
const recommended = { ...question, recommendation: { answers: ["SQLite"], reason: "One writer, and reads stay indexed." } };

test("the report tool requires a recommendation; the journal still reads a question without one", () => {
  for (const [tool, recorded] of [[teamReportSchema, recordedTeamReportSchema], [missionReportSchema, recordedMissionReportSchema]] as const) {
    // A member whose prompt predates recommendations reads only the refusal, so it names the shape to send.
    assert.deepEqual(tool.safeParse(question).error?.issues.map(issue => [issue.path.join("."), issue.message]), [["recommendation", RECOMMENDATION_REQUIRED]]);
    assert.equal(tool.safeParse(recommended).success, true);
    assert.equal(recorded.safeParse(question).success, true);
    assert.equal(recorded.safeParse(recommended).success, true);
  }
});

test("a recommendation names options exactly, and one option unless the question takes several", () => {
  const problem = (options: string[], answers: string[], mode?: "approval" | "single" | "multiple" | "inherited") =>
    questionProblem({ options, recommendation: { answers, reason: "r" } }, mode)?.path;
  assert.equal(problem(["A", "B"], ["A"]), undefined);
  assert.equal(problem(["A", "B"], ["a"]), "recommendation");
  assert.equal(problem(["A", "B"], ["A", "B"]), "recommendation");
  assert.equal(problem(["A", "B"], ["A", "B"], "multiple"), undefined);
  assert.equal(problem(["A", "B"], ["A", "A"], "multiple"), "recommendation");
  assert.equal(problem([], ["Keep the flag off"]), undefined);
  assert.equal(problem([], ["One", "Two"]), "recommendation");
  assert.equal(problem(["A"], ["A"], "approval"), "options");
  // A forwarded mission question without a mode takes the subteam decision's mode, so the count waits for the host.
  assert.equal(problem(["A", "B"], ["A", "B"], "inherited"), undefined);
  const forwarded = { ...question, childDecisionId: "0b0e4a53-2f43-4a6c-9d57-0e6f6a6f1f10", subtaskId: "api",
    recommendation: { answers: ["SQLite", "Files"], reason: "Both are needed." } };
  assert.equal(missionReportSchema.safeParse(forwarded).success, true);
  assert.equal(missionReportSchema.safeParse({ ...forwarded, answerMode: "single" }).success, false);
});

test("an answer is recorded as matched, different, or other", () => {
  const one = { answers: ["SQLite"], reason: "r" }, both = { answers: ["SQLite", "Files"], reason: "r" };
  const options = ["SQLite", "Files", "Memory"];
  assert.equal(recommendationOutcome(options, one, "SQLite"), "matched");
  assert.equal(recommendationOutcome(options, one, " SQLite\n"), "matched");
  assert.equal(recommendationOutcome(options, one, "Files"), "different");
  assert.equal(recommendationOutcome(options, one, "Neither, use Postgres"), "other");
  // A multiple selection arrives as numbered lines, in the order chosen.
  assert.equal(recommendationOutcome(options, both, "1. Files\n2. SQLite"), "matched");
  assert.equal(recommendationOutcome(options, both, "1. SQLite"), "different");
  assert.equal(recommendationOutcome(options, both, "1. SQLite\n2. SQLite"), "different");
  assert.equal(recommendationOutcome(options, one, "1. SQLite\nand keep a backup"), "other");
  // An option may span lines, and two options may differ only in a space: the exact text decides.
  const spanning = ["Keep\nboth", "Drop", "Drop "];
  assert.equal(recommendationOutcome(spanning, { answers: ["Keep\nboth", "Drop"], reason: "r" }, "1. Keep\nboth\n2. Drop"), "matched");
  assert.equal(recommendationOutcome(spanning, { answers: ["Drop"], reason: "r" }, "Drop "), "different");
  assert.equal(recommendationOutcome(spanning, { answers: ["Drop"], reason: "r" }, "Drop"), "matched");
  // Free text matches only word for word: the host does not judge whether words agree.
  const free = { answers: ["Keep the flag off"], reason: "r" };
  assert.equal(recommendationOutcome([], free, "Keep the flag off"), "matched");
  assert.equal(recommendationOutcome([], free, "Leave it off for now"), "other");
});
