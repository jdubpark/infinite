import test from "node:test";
import assert from "node:assert/strict";
import { INTENT_CONTEXT_BYTES, INTENT_FEEDBACK_BYTES, INTENT_PROMPT_BYTES, correctionFeedback, intentCheckerPrompt, intentContext } from "../packages/host/src/intent-prompt.js";
import { runRecord } from "../packages/host/src/objective-record.js";
import { applyIntentReport, intentApplied } from "../packages/host/src/objective-intent.js";
import type { IntentCheckReport, IntentItem } from "../packages/host/src/intent-report.js";
import { codexMemberToolInstructions, codexSandboxInstructions, contextAccessInstructions, profileInstructions, readOnlyWorkspaceInstructions, reportingInstructions, retargetPrompt } from "../packages/host/src/team-prompts.js";
import type { TeamDecision, TeamMember, TeamModelProfile, TeamReport, TeamRun } from "../packages/host/src/team-types.js";
import type { ObjectiveRecord } from "../packages/host/src/objective-types.js";

// Sentinels are built at run time, so the source holds no secret-shaped or run-specific text.
const SENTINEL = ["intent", "sentinel", "run", "data"].join("-");
const CHECKER_PROFILE: TeamModelProfile = { id: "astra-high", label: "Astra checker", provider: "codex", model: "gpt-6-astra", effort: "high" };
const CLAUDE_PROFILE: TeamModelProfile = { id: "opus-xhigh", label: "Opus", provider: "claude", model: "claude-opus-5-5", effort: "xhigh" };
const RUN_ID = "00000000-0000-4000-8000-000000000021";
const DECISION_ID = "00000000-0000-4000-8000-0000000000d1";
const CHECKS = [{ command: "npm", args: ["test"] }];

test("the checker's prompt holds no run data", () => {
  for (const provider of ["claude", "codex", "opencode"] as const) {
    const prompt = intentCheckerPrompt(provider, CHECKER_PROFILE);
    assert.ok(Buffer.byteLength(prompt, "utf8") <= INTENT_PROMPT_BYTES, `${provider}: at most 8 KiB`);
    assert.ok(prompt.includes(".git/infinite-team-context.json"), `${provider}: names the context file`);
    assert.ok(prompt.includes(profileInstructions(CHECKER_PROFILE)), `${provider}: carries the profile line`);
    assert.ok(prompt.includes(reportingInstructions(provider)), `${provider}: carries the reporting paragraph`);
    assert.notEqual(retargetPrompt(prompt, { provider: "claude", profile: CLAUDE_PROFILE, role: "intent-checker", entryTools: false }), undefined, `${provider}: retargets`);
    assert.equal(intentCheckerPrompt(provider).includes("Requested runtime profile"), false, `${provider}: no profile line without a profile`);
  }
  const codexPrompt = intentCheckerPrompt("codex", CHECKER_PROFILE);
  const claudePrompt = intentCheckerPrompt("claude", CLAUDE_PROFILE);
  const reportOnlyTools = codexMemberToolInstructions(false);
  assert.equal(codexPrompt.split(reportOnlyTools).length - 1, 1, "the Codex prompt has the report-only paragraph exactly once");
  assert.equal(claudePrompt.includes(reportOnlyTools), false, "the Claude prompt has no Codex report-only paragraph");
  assert.equal(codexPrompt.includes(codexSandboxInstructions), true, "the Codex prompt holds the sandbox guidance");
  assert.equal(claudePrompt.includes(codexSandboxInstructions), false, "the Claude prompt does not");
  assert.ok(Buffer.byteLength(codexPrompt, "utf8") <= INTENT_PROMPT_BYTES, "the Codex prompt fits 8 KiB");
  assert.ok(Buffer.byteLength(claudePrompt, "utf8") <= INTENT_PROMPT_BYTES, "the Claude prompt fits 8 KiB");
});

test("a carried Claude intent-checker prompt gets the fresh Codex guidance without entry signatures", () => {
  const fresh = intentCheckerPrompt("codex", CHECKER_PROFILE);
  const carried = retargetPrompt(intentCheckerPrompt("claude", CLAUDE_PROFILE), {
    provider: "codex", profile: CHECKER_PROFILE, role: "intent-checker", entryTools: false,
  });
  assert.ok(carried, "the carried prompt retargets");

  const guidance = `${codexSandboxInstructions}\n\n${codexMemberToolInstructions(false)}`;
  const contextInstructions = contextAccessInstructions();
  const contextBoundaryBlock = (prompt: string) => {
    const contextIndex = prompt.indexOf(contextInstructions);
    assert.notEqual(contextIndex, -1, "the context instructions are present");
    const blockEnd = contextIndex - 2;
    return prompt.slice(blockEnd - guidance.length, blockEnd);
  };
  assert.equal(contextBoundaryBlock(fresh), guidance, "fresh Codex guidance is directly before context access");
  assert.equal(contextBoundaryBlock(carried), guidance, "retargeted Codex guidance is directly before context access");
  assert.equal(contextBoundaryBlock(carried), contextBoundaryBlock(fresh), "fresh and carried guidance blocks match");
  assert.doesNotMatch(carried, /entry_(?:list|get|post)\(/, "intent checker has no entry signatures");
});

test("retargeting a legacy Codex intent-checker prompt replaces only the old live sandbox paragraph", () => {
  const legacy = intentCheckerPrompt("claude", CHECKER_PROFILE)
    .replace(readOnlyWorkspaceInstructions, `${readOnlyWorkspaceInstructions}\n\n${codexSandboxInstructions}`)
    .replace(reportingInstructions("claude"), reportingInstructions("codex"));
  const notes = `\n\nQuoted checker guidance:\n\n${codexSandboxInstructions}\n\nEnd of quote.`;
  for (const [provider, profile] of [["codex", CHECKER_PROFILE], ["claude", CLAUDE_PROFILE]] as const) {
    const carried = retargetPrompt(legacy + notes, { provider, profile, role: "intent-checker", entryTools: false });
    assert.ok(carried, `${provider}: the legacy prompt retargets`);
    assert.equal(carried.split(codexSandboxInstructions).length - 1, provider === "codex" ? 2 : 1, provider);
    assert.equal(carried, intentCheckerPrompt(provider, profile) + notes, provider);
  }
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

test("the checker's context holds the record, the plan, and this revision's findings, and nothing else", () => {
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
  const revised = intentContext({ run: { ...runFixture(), revision: 3 }, record: RECORD, planMember, mode: "autonomous", criteriaDue: true, checks: CHECKS });
  assert.deepEqual(revised?.findings, [], "an earlier revision's findings are not this plan's");

  // A member's assumption is member text, so it never reaches the checker; the room left still counts it.
  const memberStatement = ["member", "assumption", "statement"].join("-");
  const withMember = { ...RECORD, assumptions: [...RECORD.assumptions,
    { ...RECORD.assumptions[0]!, id: "a2", origin: "member", statement: memberStatement, refutedBy: `${memberStatement} refuted` }] } as ObjectiveRecord;
  const screened = intentContext({ run: runFixture(), record: withMember, planMember, mode: "autonomous", criteriaDue: true, checks: CHECKS });
  assert.deepEqual(screened?.record.assumptions.map(item => item.id), ["a1"], "a member's assumption is left out");
  assert.equal(JSON.stringify(screened).includes(memberStatement), false, "and its text with it");
  assert.equal(screened?.limits.assumptionsLeft, 30);
});

test("a checker context over 1 MiB is not built", () => {
  const huge = { ...planMember, report: { ...PLAN_REPORT, summary: "x".repeat(INTENT_CONTEXT_BYTES + 1) } } as unknown as TeamMember;
  assert.equal(intentContext({ run: runFixture(), record: RECORD, planMember: huge, mode: "autonomous", criteriaDue: false, checks: CHECKS }), undefined);
});

test("the corrected plan's feedback is bounded and labelled", () => {
  const run = { id: RUN_ID, objective: "Find ranked sources for the research brief.", steering: [] } as unknown as TeamRun;
  const record = runRecord(run, "2026-11-17T09:00:00.000Z", "run-handle");
  assert.equal(typeof record, "object", "the fixture record is built");
  // Sixteen assumptions of 500-byte statements: with an 8,000-character answer they cannot all fit in 16 KiB.
  const assume = (index: number): IntentItem => ({
    dimension: `detail ${index}`, why: "A detail the plan can carry.", criticality: "plan", disposition: "assume",
    assumption: { statement: `${String(index).padStart(3, "0")} ${"s".repeat(496)}`, refutedBy: "a counter example", test: { kind: "owner" } },
  }) as IntentItem;
  const report: IntentCheckReport = {
    kind: "intent-check", summary: "Sixteen items.", items: Array.from({ length: 16 }, (_, index) => assume(index)),
  };
  const applied = applyIntentReport(record as ObjectiveRecord, report, {
    runId: RUN_ID, revision: 1, checkerMemberId: "intent-checker-1", decisionId: DECISION_ID, mode: "supervised", goal: false, configured: [], at: "2026-11-17T09:00:01.000Z",
  });
  const entry = intentApplied(applied.record, "intent-checker-1");
  assert.ok(entry, "the applied entry is written");
  const decision = {
    id: DECISION_ID, memberId: "intent-checker-1", revision: 1, question: "The intent check's questions", options: [],
    createdAt: "2026-11-17T09:00:01.000Z", answer: "y".repeat(8000), answeredBy: "owner",
  } as unknown as TeamDecision;

  const text = correctionFeedback(applied.record, entry!, decision);
  assert.ok(Buffer.byteLength(text, "utf8") <= INTENT_FEEDBACK_BYTES, "at most 16 KiB");
  assert.ok(text.startsWith(`The intent check held your plan against the objective record (version ${applied.record.version}).`), "the lead sentence");
  assert.ok(text.includes("- a1 [plan, assumed]: 000 "), "an assumption line with its criticality and status");
  assert.ok(text.includes("(refuted by: a counter example)"), "the refutation");
  assert.ok(/\d+ more items are in the objective record\./.test(text), "the items past the limit are counted");
  assert.ok(text.includes(`User answered: ${"y".repeat(100)}`), "the owner's answer carries its label");
  assert.ok(text.endsWith("Your earlier plan and the checker's report are in memberReports of the context file."), "the closing instruction");
});
