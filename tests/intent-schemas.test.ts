import test from "node:test";
import assert from "node:assert/strict";
import { INTENT_REPORT_LIMITS, intentCheckReportSchema } from "../packages/host/src/intent-report.js";
import { decisionAuthorityQuestion, lineupProfiles, recordDigestSchema, teamLineupSchema, teamProjectSchema, teamReportSchema } from "../packages/host/src/team-types.js";
import { objectivePromptsOn } from "../packages/host/src/objective-digest.js";

const assumption = { statement: "The export keeps its header row", refutedBy: "A header-less export in the fixture", test: { command: "export-check" } };
const ask = (n: number) => ({
  dimension: `dimension-${n}`, why: "The owner chooses the outcome", criticality: "outcome", disposition: "ask", assumption,
  question: { text: `Which outcome for item ${n}?`, options: ["Export", "Print"], default: "Export" },
});
const assume = (n: number) => ({ dimension: `detail-${n}`, why: "A detail the plan can settle", criticality: "detail", disposition: "assume", assumption });
const scout = (n: number) => ({ dimension: `scout-${n}`, why: "A fact the repository holds", criticality: "plan", disposition: "scout", assumption, scout: `Read the file for item ${n}` });
const report = (items: unknown[], extra: Record<string, unknown> = {}) => ({ kind: "intent-check", summary: "The plan misses one outcome.", items, ...extra });

/** A report at every bound: 16 items (3 scouts), 8 criteria, 24 out-of-scope ids, and a 4,000-character summary. */
const maximal = report([
  ...Array.from({ length: 6 }, (_, index) => ask(index)),
  ...Array.from({ length: 7 }, (_, index) => assume(index)),
  ...Array.from({ length: 3 }, (_, index) => scout(index)),
], {
  summary: "s".repeat(INTENT_REPORT_LIMITS.summaryChars),
  criteria: Array.from({ length: 8 }, (_, index) => ({ id: `c${index + 1}`, statement: `Criterion ${index + 1}` })),
  outOfScope: Array.from({ length: 24 }, (_, index) => `follow-up-${index}`),
});

test("the intent report is bounded and strict", async () => {
  assert.equal(teamReportSchema.safeParse(maximal).success, true, "a maximal report parses");
  assert.equal(intentCheckReportSchema.safeParse(maximal).success, true);
  // team-mcp.ts builds z.toJSONSchema over the report schema when it loads; loading it proves the schema converts.
  await assert.doesNotReject(import("../packages/host/src/team-mcp.js"));
  const refused: Array<[string, unknown]> = [
    ["17 items", report([...maximal.items, assume(99)])],
    ["a fourth scout", report([...Array.from({ length: 4 }, (_, index) => scout(index))])],
    ["a 201-byte dimension", report([{ ...ask(0), dimension: "d".repeat(INTENT_REPORT_LIMITS.dimensionBytes + 1) }])],
    ["an ask without a question", report([{ ...ask(0), question: undefined }])],
    ["a question with both default and interrupt", report([{ ...ask(0), question: { text: "Which?", options: [], default: "a", interrupt: "definition" } }])],
    ["a question with neither default nor interrupt", report([{ ...ask(0), question: { text: "Which?", options: [] } }])],
    ["a scout on an assume item", report([{ ...assume(0), scout: "Read it" }])],
    ["an unknown key", report([{ ...assume(0), extra: true }])],
    ["a test of 1,025 bytes", report([{ ...assume(0), assumption: { ...assumption, test: "x".repeat(1023) } }])],
    ["a missing test", report([{ ...assume(0), assumption: { statement: assumption.statement, refutedBy: assumption.refutedBy } }])],
  ];
  for (const [name, value] of refused) assert.equal(teamReportSchema.safeParse(value).success, false, `refuses ${name}`);
});

test("the intent check setting stands alone", () => {
  const checks = [{ command: "node", args: ["check.js"] }];
  for (const objective of [{ intentCheck: "off" }, { prompts: "off", intentCheck: "on" }, { prompts: "on" }])
    assert.equal(teamProjectSchema.safeParse({ checks, objective }).success, true, JSON.stringify(objective));
  for (const objective of [{ intentCheck: "maybe" }, { intentCheck: "on", extra: true }])
    assert.equal(teamProjectSchema.safeParse({ checks, objective }).success, false, JSON.stringify(objective));
  const bare = teamProjectSchema.parse({ checks });
  assert.equal(Object.hasOwn(bare, "objective"), false, "a project without the key parses with no objective key");
  assert.equal(objectivePromptsOn({ team: teamProjectSchema.parse({ checks, objective: { intentCheck: "on" } }) } as Parameters<typeof objectivePromptsOn>[0]), false);
});

const profile = (id: string, tier: "light" | "strong" = "strong") => ({ id, label: id, provider: "claude", model: "opus", effort: "high", tier });
const base = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "opus", effort: "xhigh", tier: "strong" },
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "sonnet", effort: "high", tier: "light" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "codex", model: "astra", effort: "high", tier: "strong" },
  implementers: [{ id: "implementer", label: "Implementer", provider: "claude", model: "sonnet", effort: "medium", tier: "light" }],
  escalations: [{ id: "escalation", label: "Escalation", provider: "claude", model: "opus", effort: "xhigh", tier: "strong" }],
  permissionReviewer: { id: "permission", label: "Permission", provider: "claude", model: "haiku", effort: "low", tier: "light" },
};
/** The lineup's JSON from the base commit, before the evaluators slot existed. */
const PINNED_LINEUP = '{"coordinator":{"id":"coordinator","label":"Coordinator","provider":"claude","model":"opus","effort":"xhigh","tier":"strong"},"integrator":{"id":"integrator","label":"Integrator","provider":"claude","model":"sonnet","effort":"high","tier":"light"},"reviewer":{"id":"reviewer","label":"Reviewer","provider":"codex","model":"astra","effort":"high","tier":"strong"},"implementers":[{"id":"implementer","label":"Implementer","provider":"claude","model":"sonnet","effort":"medium","tier":"light"}],"escalations":[{"id":"escalation","label":"Escalation","provider":"claude","model":"opus","effort":"xhigh","tier":"strong"}],"permissionReviewer":{"id":"permission","label":"Permission","provider":"claude","model":"haiku","effort":"low","tier":"light"}}';

test("evaluators are strong, unique, and last", () => {
  const withEvaluators = (evaluators: unknown[]) => ({ ...base, evaluators });
  assert.equal(teamLineupSchema.safeParse(withEvaluators([profile("e1"), profile("e2"), profile("e3"), profile("e4"), profile("e5")])).success, false, "five evaluators are refused");
  assert.equal(teamLineupSchema.safeParse(withEvaluators([profile("e1"), profile("e2", "light")])).success, false, "a light evaluator is refused");
  assert.equal(teamLineupSchema.safeParse(withEvaluators([profile("e1"), profile("e1")])).success, false, "two evaluators with one id are refused");
  const parsed = teamLineupSchema.parse(withEvaluators([profile("e1")]));
  assert.equal(Object.keys(parsed).at(-1), "evaluators", "evaluators is the lineup's last key");
  assert.equal(JSON.stringify(teamLineupSchema.parse(base)), PINNED_LINEUP, "a lineup without the slot keeps its fingerprint string");
  assert.equal(lineupProfiles(parsed).at(-1)?.id, "e1", "lineupProfiles ends with the evaluators");
  const reuse = teamLineupSchema.safeParse(withEvaluators([base.reviewer]));
  assert.equal(reuse.success, true, "an evaluator that reuses the reviewer's id and identity parses");
});

test("a digest criterion may be marked derived", () => {
  const digest = (derived: unknown) => ({
    version: 1,
    criteria: [
      { id: "c0", statement: "", check: "tests", producer: "owner" },
      { id: "c1", statement: "The export keeps its header row", check: "tests", producer: "evaluator", derived },
    ],
  });
  assert.equal(recordDigestSchema.safeParse(digest(true)).success, true);
  assert.equal(recordDigestSchema.safeParse(digest(false)).success, false, "derived false is refused");
  assert.equal(recordDigestSchema.safeParse(digest("yes")).success, false, "derived yes is refused");
  assert.equal(decisionAuthorityQuestion({ question: "Which outcome?", intentQuestions: ["q1", "q2"] }), "The intent check's questions q1, q2");
  assert.equal(decisionAuthorityQuestion({ question: "Which outcome?" }), "Which outcome?");
});
