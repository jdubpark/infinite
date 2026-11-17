import test from "node:test";
import assert from "node:assert/strict";
import { INTENT_CONTEXT_BYTES, INTENT_PROMPT_BYTES, intentCheckerPrompt, intentContext } from "../packages/host/src/intent-prompt.js";
import { codexSandboxInstructions, profileInstructions, reportingInstructions, retargetPrompt } from "../packages/host/src/team-prompts.js";
import type { TeamMember, TeamModelProfile, TeamReport, TeamRun } from "../packages/host/src/team-types.js";
import type { ObjectiveRecord } from "../packages/host/src/objective-types.js";

// Sentinels are built at run time, so the source holds no secret-shaped or run-specific text.
const SENTINEL = ["intent", "sentinel", "run", "data"].join("-");
const CHECKER_PROFILE: TeamModelProfile = { id: "astra-high", label: "Astra checker", provider: "codex", model: "gpt-6-astra", effort: "high" };
const CLAUDE_PROFILE: TeamModelProfile = { id: "opus-xhigh", label: "Opus", provider: "claude", model: "claude-opus-5-5", effort: "xhigh" };
const RUN_ID = "00000000-0000-4000-8000-000000000021";
const CHECKS = [{ command: "npm", args: ["test"] }];

test("the checker's prompt holds no run data", () => {
  for (const provider of ["claude", "codex", "opencode"] as const) {
    const prompt = intentCheckerPrompt(provider, CHECKER_PROFILE);
    assert.ok(Buffer.byteLength(prompt, "utf8") <= INTENT_PROMPT_BYTES, `${provider}: at most 8 KiB`);
    assert.ok(prompt.includes(".git/infinite-team-context.json"), `${provider}: names the context file`);
    assert.ok(prompt.includes(profileInstructions(CHECKER_PROFILE)), `${provider}: carries the profile line`);
    assert.ok(prompt.includes(reportingInstructions(provider)), `${provider}: carries the reporting paragraph`);
    assert.notEqual(retargetPrompt(prompt, { provider: "claude", profile: CLAUDE_PROFILE }), undefined, `${provider}: retargets`);
    assert.equal(intentCheckerPrompt(provider).includes("Requested runtime profile"), false, `${provider}: no profile line without a profile`);
  }
  assert.equal(intentCheckerPrompt("codex", CHECKER_PROFILE).includes(codexSandboxInstructions), true, "the Codex prompt holds the sandbox guidance");
  assert.equal(intentCheckerPrompt("claude", CHECKER_PROFILE).includes(codexSandboxInstructions), false, "the Claude prompt does not");
});

const criterion = (id: string, origin: "owner" | "derived", extra: Record<string, unknown> = {}) => ({
  id, origin, statement: `Statement ${id}.`, check: { kind: "receipt", receipt: "checks-passed" }, producer: "host",
  threshold: { kind: "pass" }, state: "active", ...extra,
});
const RECORD = {
  schemaVersion: 1, owner: { kind: "run", runId: RUN_ID }, version: 3, digest: "digest",
  statement: { objective: "Ship the export.", directions: [{ id: "d1", text: "Keep CSV.", source: "steering", at: "2026-11-16T00:00:00.000Z" }] },
  definitions: [], constraints: { allowedPaths: [], excludedPaths: [], rules: [] }, nonGoals: [], ownerEvidence: [],
  criteria: [criterion("c0", "owner", { latest: { state: "met", verdictId: "v1" } }), criterion("c1", "derived", { derivedFrom: "Keep CSV." })],
  assumptions: [{ id: "a1", statement: "Rows are sorted.", status: "assumed", origin: "intent-check", criticality: "plan", refutedBy: "Unsorted rows.",
    test: { kind: "owner" }, evidence: [], proposals: [{ entryId: "e1", stance: "supports", summary: "Sorted.", authorRole: "scout" }] }],
  questions: [], rubricVersion: 1,
  log: [{ seq: 1, at: "2026-11-16T00:00:00.000Z", version: 2, actor: "intent-check", authority: "claim", op: "intent-check.applied", target: RUN_ID }],
} as unknown as ObjectiveRecord;

const member = (id: string, role: TeamMember["role"], report?: TeamReport) => ({ memberId: id, role, title: id, status: "reported", report }) as unknown as TeamMember;
const PLAN_REPORT = {
  kind: "plan", summary: "Plan the CSV export.", parallelism: 2,
  tasks: [{ id: "t1", title: "Export", instructions: "Write the export.", agentProfileId: "astra-xhigh", paths: ["src/export.ts"], dependsOn: [] }],
  verification: { checks: [{ command: "npm", args: ["test"] }] },
} as unknown as TeamReport;
const planMember = member("m-plan", "project-manager", PLAN_REPORT);

function runFixture(): TeamRun {
  const members = [
    member("m-impl", "implementer", { kind: "result", summary: SENTINEL } as TeamReport),
    member("m-scout-1", "scout", { kind: "findings", summary: "Finding one.", evidence: [] } as unknown as TeamReport),
    member("m-scout-2", "scout", { kind: "findings", summary: "Finding two.", evidence: [] } as unknown as TeamReport),
  ];
  return {
    id: RUN_ID, revision: 2, projectId: "project", title: "Export", objective: "Ship the export.", status: "planning", provider: "claude",
    members, steering: [], decisions: [], tasks: [],
    routing: { mode: "auto", pin: SENTINEL }, blackboard: { tools: true, digest: SENTINEL },
    discovery: { revision: 2, summary: "Scouts done.", tasks: [
      { id: "s1", title: "Scout one", instructions: "Read the export.", agentProfileId: "astra-xhigh", status: "complete", memberId: "m-scout-1" },
      { id: "s2", title: "Scout two", instructions: "Read the tests.", agentProfileId: "astra-xhigh", status: "complete", memberId: "m-scout-2" },
    ] },
  } as unknown as TeamRun;
}

test("the checker's context holds the record, the plan, and the findings, and nothing else", () => {
  const context = intentContext({ run: runFixture(), record: RECORD, planMember, mode: "autonomous", criteriaDue: true, checks: CHECKS });
  assert.ok(context, "a context is built");
  assert.equal(context.kind, "intent-check");
  assert.equal("log" in context.record, false, "the record has no log");
  assert.equal("latest" in context.record.criteria[0]!, false, "a criterion has no latest");
  assert.equal("proposals" in context.record.assumptions[0]!, false, "an assumption has no proposals");
  assert.equal(context.record.criteria.length, 2, "every criterion is kept");
  assert.equal("agentProfileId" in context.plan.tasks[0]!, false, "a task has no agentProfileId");
  assert.equal("parallelism" in context.plan, false, "the plan has no parallelism");
  assert.equal(context.plan.summary, "Plan the CSV export.");
  assert.deepEqual(context.plan.verification, { checks: [{ command: "npm", args: ["test"] }] });
  assert.deepEqual(context.findings.map(finding => [finding.scoutId, finding.title]), [["s1", "Scout one"], ["s2", "Scout two"]]);
  assert.deepEqual(context.checks, CHECKS);
  assert.equal(context.limits.assumptionsLeft, 31);
  assert.equal(context.limits.criteriaLeft, 6);
  assert.equal(JSON.stringify(context).includes(SENTINEL), false, "no implementer report, routing pin, or blackboard flag");
});

test("a checker context over 1 MiB is not built", () => {
  const huge = { ...planMember, report: { ...PLAN_REPORT, summary: "x".repeat(INTENT_CONTEXT_BYTES + 1) } } as unknown as TeamMember;
  assert.equal(intentContext({ run: runFixture(), record: RECORD, planMember: huge, mode: "autonomous", criteriaDue: false, checks: CHECKS }), undefined);
});
