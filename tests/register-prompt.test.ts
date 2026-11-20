import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ASK_SENTENCE, PROPOSE_SENTENCE, REGISTER_LEAD, registerText, scopeSentence } from "../packages/host/src/register-prompt.js";
import { entryCommand, reportCommand, teamPrompt } from "../packages/host/src/team-prompts.js";
import type { RegisterDigest, TeamMember, TeamModelProfile, TeamRun } from "../packages/host/src/team-types.js";

const PROFILE: TeamModelProfile = { id: "fixture-profile", label: "Fixture profile", provider: "claude", model: "fixture-model", effort: "high" };
const CHECKS = [{ command: "npm", args: ["test"] }];
const ROLES = ["project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "permission-coordinator"] as const;
const PROVIDERS = ["claude", "codex", "opencode"] as const;

const RECORD = { version: 2, criteria: [
  { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" as const },
  { id: "c1", statement: "The export keeps CSV.", check: "command:npm test", producer: "host" as const },
] };
const REGISTER: RegisterDigest = {
  assumptions: [{ id: "a1", status: "unchecked", criticality: "plan", statement: "Rows are sorted." }],
  questions: [{ id: "q1", text: "Which delimiter does the owner want?" }],
};

function runFor(options: { autonomy?: "supervised" | "autonomous"; entry?: boolean; record?: unknown } = {}): TeamRun {
  const lineupProfile = PROFILE;
  const goal = {
    id: "00000000-0000-4000-8000-000000000012", revision: 1, cycle: 1, successCriteria: "Owner success text.",
    nonGoals: ["Do not change billing."], allowedPaths: ["src"], evidence: [], previousWork: [],
    deadlineAt: "2026-12-01T00:00:00.000Z", maxMembers: 2, ...(options.record === undefined ? {} : { record: options.record }),
  };
  return {
    id: "00000000-0000-4000-8000-000000000011", projectId: "example-project", provider: "claude", title: "Register prompt run",
    objective: "Preserve the owner-visible contract.", parallelism: 1, revision: 1, status: "discovering",
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", workspace: "/home/dev/projects/example",
    branch: "infinite/register-prompt", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), autonomy: options.autonomy ?? "supervised",
    lineup: { coordinator: lineupProfile, integrator: lineupProfile, reviewer: lineupProfile, implementers: [lineupProfile] },
    goal, tasks: [], members: [], decisions: [], checks: [], steering: [], events: [], round: 1,
    ...(options.entry ? { blackboard: { tools: true } } : {}),
  } as unknown as TeamRun;
}
const withRegister = (options: Parameters<typeof runFor>[0] = {}) => runFor({ ...options, record: { ...RECORD, register: REGISTER } });
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// The report and entry commands hold this installation's paths; the pin replaces them, as tests/team-prompts.test.ts does.
const placeholdered = (text: string) => text.split(reportCommand()).join("<report-command>").split(entryCommand()).join("<entry-command>");
const promptOf = (run: TeamRun, role: TeamMember["role"]) =>
  teamPrompt(run, role, undefined, undefined, "claude", PROFILE, { checks: CHECKS }, [], true);

// Byte pin: a goal run without a register keeps every prompt byte. The value is this tree's output before Task 12,
// moved once from 96ea12db when INF-323 added the recommendation to the question format line, the only change.
const PIN_PROMPTS_SHA256 = "a4ff6934ae47f73f01d005a42bd9e89a5f33b44c559b5e03ea3f8e45a4f0d3f8";

test("without the register the goal section is byte for byte", () => {
  const prompts: string[] = [];
  for (const record of [undefined, RECORD]) {
    for (const autonomy of ["supervised", "autonomous"] as const) {
      for (const entry of [false, true]) {
        for (const role of ROLES) {
          for (const provider of PROVIDERS) {
            prompts.push(placeholdered(teamPrompt(runFor({ autonomy, entry, record }), role, undefined, undefined, provider, PROFILE, { checks: CHECKS }, [], true)));
          }
        }
      }
    }
  }
  assert.equal(sha256(prompts), PIN_PROMPTS_SHA256, "every role, provider, mode, entry-tool setting, and record shape without a register");
});

test("the register reaches the goal section with its lead line", () => {
  const prompt = promptOf(withRegister(), "implementer");
  const text = registerText(REGISTER);
  assert.ok(text.startsWith(`${REGISTER_LEAD}:\n`), "registerText opens with the lead line");
  assert.equal(prompt.split(REGISTER_LEAD).length, 2, "the lead line appears once");
  assert.equal(prompt.split(JSON.stringify(REGISTER)).length, 2, "the register JSON appears once");
  assert.equal(prompt.split(text).length, 2, "the lead and the JSON appear as one block");
  const criteria = JSON.stringify(RECORD.criteria.map(item => item.id === "c0" ? { ...item, statement: "Owner success text." } : item));
  assert.ok(prompt.indexOf(criteria) > -1, "the criteria JSON is present");
  assert.ok(prompt.indexOf(criteria) < prompt.indexOf(REGISTER_LEAD), "the register follows the criteria JSON");
});

test("the scope sentence follows the mode, the register, and the role", () => {
  const autonomous = withRegister({ autonomy: "autonomous", entry: true });
  assert.equal(scopeSentence(autonomous, "implementer"), PROPOSE_SENTENCE, "an implementer with entry tools proposes");
  assert.equal(scopeSentence(autonomous, "scout"), PROPOSE_SENTENCE, "a scout with entry tools proposes");
  assert.equal(scopeSentence(autonomous, "project-manager"), ASK_SENTENCE, "the project manager posts no finding");
  assert.equal(scopeSentence(withRegister({ autonomy: "autonomous" }), "reviewer"), ASK_SENTENCE, "a reviewer without entry tools asks");
  assert.equal(scopeSentence(withRegister({ autonomy: "supervised", entry: true }), "implementer"), ASK_SENTENCE, "a supervised run asks");
  assert.equal(scopeSentence(runFor({ autonomy: "autonomous", entry: true, record: RECORD }), "implementer"), ASK_SENTENCE, "a digest without a register asks");

  const prompt = promptOf(autonomous, "implementer");
  assert.equal(prompt.split(PROPOSE_SENTENCE).length, 2, "the propose sentence appears once in the prompt");
  assert.equal(prompt.includes(ASK_SENTENCE), false, "the ask sentence is replaced");
  const project = promptOf(autonomous, "project-manager");
  assert.equal(project.includes(PROPOSE_SENTENCE), false, "the project manager gets no propose sentence");
  assert.equal(project.split(ASK_SENTENCE).length, 2, "the project manager keeps the ask sentence");
});
