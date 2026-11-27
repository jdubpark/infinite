import test from "node:test";
import assert from "node:assert/strict";
import { judgementReportSchema } from "../packages/host/src/judge-types.js";
import { hostEntrySources } from "../packages/host/src/evidence/host-entries.js";
import { teamContext } from "../packages/host/src/team-prompts.js";
import { lineupProfiles, teamLineupSchema, type TeamMember, type TeamModelProfile } from "../packages/host/src/team-types.js";
import { smallRun } from "./fixtures/team-prompt-run.js";

const DUEL_ID = "00000000-0000-4000-8000-0000000000d1";
const sample = { kind: "judgement", duelId: DUEL_ID, preferred: "A", rubric: { a: { correctness: 4, cleanliness: 4, extensibility: 4, docs: 4 }, b: { correctness: 3, cleanliness: 3, extensibility: 3, docs: 3 } }, summary: "A meets the criteria." };
const profile = (id: string, model = "model-a"): TeamModelProfile => ({ id, label: id, provider: "claude", model, effort: "high", tier: "strong" }) as TeamModelProfile;
const base = { coordinator: profile("coord"), integrator: profile("integ"), reviewer: profile("rev"), implementers: [profile("impl-a")] };
const withJudge = { ...base, judge: profile("zz-judge-profile", "model-j") };

test("a judgement report parses and refuses stray keys", () => {
  assert.doesNotThrow(() => judgementReportSchema.parse(sample));
  assert.throws(() => judgementReportSchema.parse({ ...sample, profile: "x" }));
  for (const score of [0, 6, 4.5]) assert.throws(() => judgementReportSchema.parse({ ...sample, rubric: { ...sample.rubric, a: { ...sample.rubric.a, docs: score } } }));
  assert.throws(() => judgementReportSchema.parse({ ...sample, summary: "   " }));
  assert.throws(() => judgementReportSchema.parse({ ...sample, summary: "x".repeat(2001) }));
});

test("the lineup takes a judge as its last key", () => {
  assert.equal(Object.keys(teamLineupSchema.parse({ ...withJudge, evaluators: [profile("ev")] })).at(-1), "judge");
});

test("a lineup without a judge has no judge key", () => {
  assert.equal(Object.hasOwn(teamLineupSchema.parse(base), "judge"), false);
});

test("a judge with a limit fallback is refused", () => {
  const result = teamLineupSchema.safeParse({ ...withJudge, judge: { ...withJudge.judge, limitFallback: "impl-a" } });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.issues.some(issue => issue.path.join(".") === "judge.limitFallback"));
});

test("a judge id that names another identity is refused", () => {
  const result = teamLineupSchema.safeParse({ ...base, judge: profile("impl-a", "other-model") });
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.issues.some(issue => issue.message === "A profile ID must identify the same provider, model, and effort throughout a lineup"));
});

test("lineupProfiles leaves the judge out", () => {
  assert.equal(lineupProfiles(teamLineupSchema.parse(withJudge)).some(p => p.id === "zz-judge-profile"), false);
});

test("the judge reports in no member list", () => {
  const member = { memberId: "00000000-0000-4000-8000-0000000000a1", revision: 1, role: "judge", status: "reported", baseCommit: "a".repeat(40), report: sample } as unknown as TeamMember;
  const run = smallRun({ members: [member] });
  assert.equal(hostEntrySources(run).some(source => source.includes(member.memberId)), false);
  assert.equal(teamContext(run).memberReports.some(item => item.memberId === member.memberId), false);
});
