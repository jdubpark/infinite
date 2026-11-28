import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { teamContext, teamPrompt } from "../packages/host/src/team-prompts.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { ENTRY_PROFILE, smallRun } from "./fixtures/team-prompt-run.js";

const GOAL_ROLES = ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker", "evaluator"] as const;
const GOAL_BASE = { id: "00000000-0000-4000-8000-000000000021", revision: 1, cycle: 2, successCriteria: "Fixture success criteria.", nonGoals: [], allowedPaths: ["."], evidence: [], previousWork: [],
  deadlineAt: "2026-12-01T00:00:00.000Z", maxMembers: 2 };
const GOAL_RECORD = { version: 3, criteria: [
  { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" as const },
  { id: "c2", statement: "A second criterion.", check: "citation-form:research/founders/shortlist.json", producer: "host" as const },
], register: { assumptions: [], questions: [] } };
const ROW_NOTE = "SECRET-NOTE-TEXT";
function goalRunFor(extra: Record<string, unknown>, autonomy?: "autonomous"): TeamRun {
  return smallRun({ goal: { ...GOAL_BASE, ...extra }, ...(autonomy ? { autonomy } : {}) } as Partial<TeamRun>);
}
function renderFor(run: TeamRun, role: (typeof GOAL_ROLES)[number]): { prompt: string; context: string } {
  const prompt = teamPrompt(run, role, undefined, undefined, "claude", ENTRY_PROFILE, { checks: [{ command: "npm", args: ["run", "check"] }] }, [], true);
  const context = JSON.stringify(teamContext(run, undefined, { checks: [{ command: "npm", args: ["run", "check"] }] }, role));
  return { prompt, context };
}
function digestOf(text: string): string { return createHash("sha256").update(text).digest("hex"); }
const GOAL_VARIANTS: { name: string; run: () => TeamRun }[] = [
  { name: "plain", run: () => goalRunFor({}) },
  { name: "record", run: () => goalRunFor({ record: GOAL_RECORD }, "autonomous") },
];
const BASE_DIGESTS: Record<string, string> = {
  "plain/permission-coordinator/prompt": "ec013bfcbe048e6847387109b92ba6bdebc8761f768171f1180f6b57549403d8",
  "plain/permission-coordinator/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "plain/project-manager/prompt": "b2afbc87c0ccfb4f7a9c81ed0a8d430e6907c225cb2a4a91db5c0f424bd57e82",
  "plain/project-manager/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "plain/scout/prompt": "c6ecda96715d61439cac26d3bde52f32e06fc6370e81a4c1344c277e3c3b6d72",
  "plain/scout/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "plain/implementer/prompt": "70848f3dd6a7e93bfb9ab871cee85cbdeac7060b5db1c5648ebd69fe12826b51",
  "plain/implementer/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "plain/integrator/prompt": "66ae0b27467aab2bcc91f901329c9d211663604cfc07dd2a0e3950dad05a5f19",
  "plain/integrator/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "plain/reviewer/prompt": "3dcf4ef4071e90ff55858649b596befe4e9f3b6d0879f66503c29069888ff1fa",
  "plain/reviewer/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "plain/delivery/prompt": "46791f2b9bddf9530f4f000c0ac17f6390e00b28feecd726bd4b052fad941a30",
  "plain/delivery/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "plain/intent-checker/prompt": "af5d9d08447eadc1b2ca4fcab5c7c97f4a537bb004bda2b59341eccc084cc0d0",
  "plain/intent-checker/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "plain/evaluator/prompt": "fbd9be63c4af4242a45faa72700dd58488c9d8348eea8344d1e17f5a8095a9e5",
  "plain/evaluator/context": "fe5cbf60907dd895160083e5e2cd2c86fe494f10b1ceab7772b84274daab570d",
  "record/permission-coordinator/prompt": "bf3ffce927b7c457f22e989374d17187031861e52f2131ecf80726affe94336f",
  "record/permission-coordinator/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f",
  "record/project-manager/prompt": "c96ca567692d330842dfa21bcca798f59c77c1145a616adbcd38788393393a20",
  "record/project-manager/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f",
  "record/scout/prompt": "aba8430c810edb0cc7f4b7268f792cf815e6c472fce1c59c32691c5918c0b13c",
  "record/scout/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f",
  "record/implementer/prompt": "b10aa6addc7f95bd4f44dbee642a11a5b28ac6aa3c3fb4c7c5ac463c9699f690",
  "record/implementer/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f",
  "record/integrator/prompt": "976c4233ee1ff02382a9c0de9e68ee21783e7c727913db35969e0bbc80bf975c",
  "record/integrator/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f",
  "record/reviewer/prompt": "db7f97b0e4f5ee457629062659126fa7ffd7639dda42626f1be12dca0f61b514",
  "record/reviewer/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f",
  "record/delivery/prompt": "41a27a09953c370eee7c37b0e0d27be3a97c80281e08eb6e4b7cc094552918be",
  "record/delivery/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f",
  "record/intent-checker/prompt": "5648f8a056e019e98210ad1e7e2b6fe4addf8f9a141209d3368f543e70248c20",
  "record/intent-checker/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f",
  "record/evaluator/prompt": "be4b0b57e248be61bc25ba40ac57f7533e0020c12837785b0bf9b4e43e1cb617",
  "record/evaluator/context": "391a0bcfff56a8606174793eaf8804dbad07f987e916ab6835ee2778fe22e44f"
};

const autonomousQuestionInstruction = "In autonomous mode, non-approval questions with a recommendation proceed on the proposed default";
const withoutAutonomousQuestionInstruction = (text: string) => text.split("\n\n").filter(paragraph => !paragraph.startsWith(autonomousQuestionInstruction)).join("\n\n");

test("without criteria rows the prompts are byte for byte", () => {
  const seen: Record<string, string> = {};
  for (const variant of GOAL_VARIANTS) {
    for (const role of GOAL_ROLES) {
      const rendered = renderFor(variant.run(), role);
      const shouldAutonomousQuestion = variant.name === "record" && role === "project-manager";
      assert.equal(rendered.prompt.includes(autonomousQuestionInstruction), shouldAutonomousQuestion, `${variant.name}/${role}/autonomous-question`);
      const prompt = shouldAutonomousQuestion ? withoutAutonomousQuestionInstruction(rendered.prompt) : rendered.prompt;
      seen[`${variant.name}/${role}/prompt`] = digestOf(prompt);
      seen[`${variant.name}/${role}/context`] = digestOf(rendered.context);
    }
  }
  if (process.env.PIN_PRINT) console.log(`PINNED ${JSON.stringify(seen, null, 2)}`);
  assert.equal(Object.keys(BASE_DIGESTS).length, 36, "the base digests are pinned");
  for (const key of Object.keys(seen)) assert.equal(seen[key], BASE_DIGESTS[key], key);
});

test("criteria rows reach only the coordinator", () => {
  const rows = [
    { criterion: "c2", status: "not-met", check: "citation-form:research/founders/shortlist.json" },
    { criterion: "c3", status: "met", check: "command:npm test" },
  ];
  const run = goalRunFor({ record: GOAL_RECORD, criteria: rows }, "autonomous");
  for (const role of GOAL_ROLES) {
    const rendered = renderFor(run, role);
    for (const [kind, text] of [["prompt", rendered.prompt], ["context", rendered.context]] as const) {
      if (role === "project-manager") {
        if (kind === "prompt") {
          assert.ok(text.includes("Agent assessment, provisional"), "prompt: the label");
          assert.ok(text.includes("c2: not-met (citation-form:research/founders/shortlist.json)"), "prompt: the row");
          assert.ok(text.includes("c3: met (command:npm test)"), "prompt: the second row");
          assert.equal(text.includes('"criteria":[{"criterion"'), false, "prompt: no raw rows JSON");
        } else {
          assert.ok(text.includes('"criterion":"c2","status":"not-met","check":"citation-form:research/founders/shortlist.json"'), "context: the row");
        }
      } else {
        assert.equal(text.includes("Agent assessment, provisional"), false, `${role} ${kind}: no label`);
        assert.equal(text.includes("c2: not-met"), false, `${role} ${kind}: no row`);
        assert.equal(text.includes('"criterion":"c2"'), false, `${role} ${kind}: no raw row`);
        assert.equal(text.includes("c3: met"), false, `${role} ${kind}: no second row`);
      }
      assert.equal(text.includes(ROW_NOTE), false, `${role} ${kind}: no note`);
      assert.equal(/threshold|failing entries|evaluator-contradicted/i.test(text) && role !== "project-manager", false, `${role} ${kind}: no verdict terms`);
    }
  }
  const manager = renderFor(run, "project-manager");
  assert.equal(/threshold|profile|score/i.test(manager.prompt.split("Agent assessment, provisional")[1]?.split("\n\n")[0] ?? ""), false, "the rows hold no number or profile");
});

test("only a project manager with a pinned goal record gets task criterion mapping instructions", () => {
  const run = goalRunFor({ record: GOAL_RECORD });
  const manager = renderFor(run, "project-manager").prompt;
  assert.ok(manager.includes('"objectiveVersion":3'), "the PM gets the host-pinned objective revision");
  assert.ok(manager.includes("every task, including each prerequisite"), "prerequisite tasks need direct references");
  assert.ok(manager.includes("Dependencies set task order and do not provide transitive criterion coverage"));
  assert.ok(manager.includes("not evidence that a criterion is satisfied"), "mapping cannot manufacture satisfaction");
  assert.ok(manager.includes("other criteria may remain open"), "a cycle may target a subset");

  for (const role of GOAL_ROLES.filter(role => role !== "project-manager"))
    assert.equal(renderFor(run, role).prompt.includes("Task criterion references for this goal plan"), false, `${role}: no planning-only instruction`);
  assert.equal(renderFor(goalRunFor({}), "project-manager").prompt.includes("Task criterion references for this goal plan"), false, "no record keeps old prompt behavior");
});

test("the evaluator's member report never reaches a context file", () => {
  const run = goalRunFor({ record: GOAL_RECORD }, "autonomous");
  run.members = [
    { memberId: "m-eval", revision: 1, role: "evaluator", status: "completed", baseCommit: "a".repeat(40), report: { kind: "verdict", note: ROW_NOTE } },
    { memberId: "m-impl", revision: 1, role: "implementer", status: "completed", baseCommit: "a".repeat(40) },
  ] as unknown as TeamRun["members"];
  const snapshot = teamContext(run, undefined, undefined, "project-manager");
  const roles = snapshot.memberReports.map(item => item.role);
  assert.equal(roles.includes("evaluator"), false, "no evaluator entry");
  assert.equal(roles.includes("implementer"), true, "other members stay");
  assert.equal(JSON.stringify(snapshot).includes(ROW_NOTE), false, "the note is nowhere");
});

test("team-prompts imports no verdict storage", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(resolve("packages/host/src/team-prompts.ts"), "utf8");
  const imports = source.split("\n").filter(line => /^import /.test(line));
  assert.ok(imports.length > 0);
  for (const line of imports) {
    assert.equal(/verdict-store|outcome-store|verdict-prompt/.test(line), false, line);
  }
});
