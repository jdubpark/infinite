import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { ENTRY_PARAGRAPH_LIMIT_BYTES, codexMemberToolInstructions, codexSandboxInstructions, contextAccessInstructions, entryCommand, entryInstructions, ownerDirectionLines, refreshReportingInstructions, reportCommand, reportingInstructions, retargetPrompt, teamContext, teamPrompt } from "../packages/host/src/team-prompts.js";
import { hostEntry } from "../packages/host/src/evidence/host-entries.js";
import { buildCapsule } from "../packages/host/src/eval-rules.js";
import { buildLaunch } from "../packages/host/src/launch.js";
import { outputSchemas } from "../packages/host/src/team-mcp-results.js";
import { schemaType, toolSignature } from "../packages/host/src/tool-signature.js";
import { recordedTeamReportSchema, teamReportSchema, type TeamBrief, type TeamMember, type TeamModelProfile, type TeamRun, type TeamScout, type TeamTask } from "../packages/host/src/team-types.js";
import type { TeamRunRouting, TeamRunRoutingAuto } from "../packages/host/src/routing-types.js";
import { ENTRY_PROFILE, ENTRY_PROVIDERS, smallRun } from "./fixtures/team-prompt-run.js";

// The host pins zod 4 (packages/host/package.json); the root install is zod 3, which lacks toJSONSchema.
const { z } = createRequire(new URL("../packages/host/package.json", import.meta.url))("zod") as typeof import("zod");

const PROMPT_LIMIT_BYTES = 80 * 1024;

function largeRun(): TeamRun {
  const objective = `Preserve the owner-visible contract and follow every listed constraint. ${"Confirm observable behavior before changing implementation. ".repeat(300)}`;
  const tasks: TeamTask[] = Array.from({ length: 3 }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `Implementation task ${index + 1}`,
    instructions: `Acceptance requires the task ${index + 1} behavior to remain correct.`,
    paths: [`src/task-${index + 1}.ts`],
    dependsOn: [],
    revision: 1,
    status: "integrated",
    summary: `Task ${index + 1} report. ${"Detailed observed result and limitations. ".repeat(300)}`,
  }));
  const checks = Array.from({ length: 10 }, (_, index) => ({
    command: { command: "npm", args: ["test", `--case=${index}`] },
    status: index === 8 ? "failed" as const : "passed" as const,
    startedAt: "2026-10-21T00:00:00.000Z",
    output: `Check ${index + 1} output. ${"Detailed test output and diagnostic evidence. ".repeat(300)}`,
    revision: 1,
  }));
  return {
    id: "run-id",
    projectId: "example-project",
    provider: "demo",
    title: "Bounded team context",
    objective,
    parallelism: 2,
    revision: 1,
    status: "reviewing",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    workspace: "/home/dev/projects/example",
    branch: "infinite/team-example",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    tasks,
    members: [],
    decisions: [],
    checks,
    steering: [{ text: "Owner direction: retain backwards compatibility.", revision: 1, at: "2026-10-21T00:00:00.000Z" }],
    decisions: [{ id: "decision-1", memberId: "member-1", revision: 1, question: "Should existing callers keep the same response shape?", options: ["yes", "no"], answerMode: "single", answer: "Yes, preserve it.", answeredBy: "owner", createdAt: "2026-10-21T00:00:00.000Z" }],
    events: [],
    round: 1,
    permissions: { mode: "coordinator", scope: "Only one-time checks for this task." },
    permissionsRevokedAt: "2026-10-21T00:15:00.000Z",
    verification: { checks: [{ command: "npm", args: ["test"] }] },
    linear: {
      status: "synced",
      checkedAt: "2026-10-21T00:00:00.000Z",
      issue: {
        id: "linear-issue-id",
        identifier: "INF-108",
        url: "https://linear.app/example/issue/INF-108",
        title: "Bounded team context",
        description: objective,
        state: { name: "In Progress", type: "started" },
        updatedAt: "2026-10-21T00:00:00.000Z",
      },
    },
    review: {
      verdict: "changes-requested",
      summary: `Repair feedback. ${"Preserve the observed failing check and report evidence. ".repeat(320)}`,
      revision: 1,
    },
  } as TeamRun;
}

test("review prompt bounds derived evidence while preserving objective and immutable scope", () => {
  const run = largeRun();
  const feedback = `${run.review!.summary}\n${"🧪".repeat(30000)}`;
  const prompt = teamPrompt(run, "reviewer", undefined, feedback, "demo");

  assert.ok(Buffer.byteLength(prompt, "utf8") <= PROMPT_LIMIT_BYTES);
  assert.ok(prompt.includes(run.objective));
  assert.equal(prompt.indexOf(run.objective), prompt.lastIndexOf(run.objective), "identical Linear description is represented once");
  assert.ok(prompt.includes("Owner direction: retain backwards compatibility."));
  assert.ok(prompt.includes('Owner answered "Should existing callers keep the same response shape?": Yes, preserve it.'));
  assert.ok(prompt.includes(JSON.stringify(run.verification)));
  assert.ok(prompt.includes("linear-issue-id") && prompt.includes("INF-108") && prompt.includes('"type":"started"'), "Linear identity, workflow status, and provenance remain inline");
  assert.match(prompt, /1 failed/);
  assert.match(prompt, /\.git\/infinite-team-context\.json/);
  assert.match(prompt, /full applicable current and historical task records, brief, feedback, and check outputs/);
  assert.ok(prompt.includes("🧪"), "the bounded feedback excerpt retains complete Unicode code points");
  for (let index = 0; index < prompt.length; index++) {
    const unit = prompt.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) assert.ok(prompt.charCodeAt(index + 1) >= 0xdc00 && prompt.charCodeAt(index + 1) <= 0xdfff, "no high surrogate is cut at the byte boundary");
    if (unit >= 0xdc00 && unit <= 0xdfff) assert.ok(prompt.charCodeAt(index - 1) >= 0xd800 && prompt.charCodeAt(index - 1) <= 0xdbff, "no low surrogate is cut at the byte boundary");
  }

  const snapshot = teamContext(run, feedback, { checks: [{ command: "npm", args: ["run", "check"] }] });
  assert.equal(snapshot.runId, run.id);
  assert.equal(snapshot.revision, run.revision);
  assert.equal(snapshot.headCommit, run.headCommit);
  assert.equal(snapshot.objective, run.objective);
  assert.equal(snapshot.linear?.issue?.description, run.objective, "the complete duplicate remains retrievable in the metadata snapshot");
  assert.equal(snapshot.tasks[0].summary, run.tasks[0].summary);
  assert.equal(snapshot.checks[8].output, run.checks[8].output);
  assert.equal(snapshot.feedback, feedback);
  assert.equal(snapshot.ownerAnswers[0].answer, "Yes, preserve it.");
  assert.equal(snapshot.ownerAnswers[0].answerMode, "single", "The selected mode stays in the authoritative coordinator context");
  assert.equal(snapshot.authority.permissionsRevokedAt, run.permissionsRevokedAt, "the snapshot distinguishes pinned scope from revoked live authority");

  const implementerPrompt = teamPrompt(run, "implementer", run.tasks[0], undefined, "demo");
  assert.ok(implementerPrompt.includes(run.tasks[0].instructions), "implementers retain the complete task contract inline");
});

test("review prompt defines the quality bar and asks for acceptance evidence only with a brief", () => {
  const run = largeRun();
  const ordinary = teamPrompt(run, "reviewer", undefined, undefined, "demo");
  assert.match(ordinary, /Quality bar: do not approve merely because behavior looks correct/);
  assert.match(ordinary, /a file pushed from under 1,000 lines to over 1,000/);
  assert.match(ordinary, /special-case branch or flag added to a shared flow/);
  assert.match(ordinary, /near-copy of an existing helper/);
  assert.match(ordinary, /The rubric's cleanliness score must assess this bar/);
  assert.match(ordinary, /high-conviction findings ordered by structural impact/);
  assert.doesNotMatch(ordinary, /exactly one acceptance entry per criterion/);
  assert.doesNotMatch(ordinary, /"acceptance":\[/);

  const brief: TeamBrief = { title: "Evidence-backed change", problem: "The reviewed behavior needs a concrete check.",
    evidence: [{ source: "Repository inspection", observation: "The behavior has two acceptance criteria." }],
    dataShape: "No persistent data change.", acceptance: ["The first behavior is correct.", "The second behavior is correct."],
    expectedOutcome: "Reviewers can verify both behaviors.", uiChanges: false };
  const goalRun = { ...run, brief };
  const withBrief = teamPrompt(goalRun, "reviewer", undefined, undefined, "demo");
  assert.match(withBrief, /exactly one acceptance entry per criterion, numbered from 1 in brief order/);
  assert.match(withBrief, /could not check a criterion from observed evidence, mark it "inconclusive"/);
  assert.match(withBrief, /Any "not-verified" or "inconclusive" criterion requires verdict "changes-requested"/);
  assert.match(withBrief, /"acceptance":\[\{"criterion":1,"verdict":"verified","evidence":"Observed check output or runnable behavior"\},\{"criterion":2,"verdict":"verified","evidence":"Observed check output or runnable behavior"\}\]/);
});

test("implementer context retains narrative history while withholding task ratings and review rubrics", () => {
  const run = largeRun();
  run.tasks[0].ownerRating = { score: 1, note: "Owner scoring evidence", at: "2026-10-21T00:00:00.000Z" };
  const score = { score: 1, why: "Reviewer scoring evidence" };
  run.tasks[0].rubric = { version: 1, correctness: score, cleanliness: score, extensibility: score, docs: score, reviewerProfileId: "reviewer" };
  run.continuations = [{ revision: 1, requestId: "prior", at: "2026-10-21T00:00:00.000Z", reason: "Retain prior work", headCommit: run.headCommit!, tasks: run.tasks }];
  run.members = [{ memberId: "reviewer", revision: 1, role: "reviewer", report: { kind: "review", verdict: "approved", summary: "Useful narrative evidence", rubric: [{ taskId: run.tasks[0].id, correctness: score, cleanliness: score, extensibility: score, docs: score }] } } as TeamRun["members"][number]];
  const snapshot = teamContext(run, undefined, undefined, "implementer");
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.tasks[0].ownerRating, undefined);
  assert.equal(snapshot.tasks[0].rubric, undefined);
  assert.equal(snapshot.continuations[0].tasks[0].ownerRating, undefined);
  assert.equal(snapshot.continuations[0].tasks[0].rubric, undefined);
  assert.equal("rubric" in snapshot.memberReports[0].report!, false);
  assert.ok(serialized.includes("Useful narrative evidence"));
  assert.equal(snapshot.tasks[0].instructions, run.tasks[0].instructions);
  assert.equal(snapshot.continuations[0].tasks[0].summary, run.tasks[0].summary);
  assert.match(JSON.stringify(teamContext(run)), /"ownerRating"/);
});

test("a distinct Linear issue description remains complete inline", () => {
  const run = largeRun();
  const description = `Additional owner-visible issue requirement. ${"Preserve its full provenance. ".repeat(120)}`;
  const distinct = { ...run, linear: { ...run.linear!, issue: { ...run.linear!.issue!, description } } } as TeamRun;
  const prompt = teamPrompt(distinct, "implementer", distinct.tasks[0], undefined, "demo");

  assert.ok(Buffer.byteLength(prompt, "utf8") <= PROMPT_LIMIT_BYTES);
  assert.ok(prompt.includes(description), "only a semantically duplicate issue description may be removed");
});

test("ordinary prompts reference complete authoritative text when Unicode would exceed the cap", () => {
  const ownerDirection = `Owner direction: keep all established interfaces stable. ${"🧭".repeat(18000)}`;
  const run = { ...largeRun(), objective: `Follow all owner constraints. ${"🧭".repeat(22000)}`, steering: [{ text: ownerDirection, revision: 1, at: "2026-10-21T00:00:00.000Z" }] } as TeamRun;
  const prompt = teamPrompt(run, "implementer", run.tasks[0], undefined, "demo");

  assert.ok(Buffer.byteLength(prompt, "utf8") <= PROMPT_LIMIT_BYTES);
  assert.doesNotMatch(prompt, /Objective:\nFollow all owner constraints\./);
  assert.match(prompt, /full objective, owner steering, and owner answers are stored at \.git\/infinite-team-context\.json/);
  assert.match(prompt, /SHA-256 [a-f0-9]{64}/);
  assert.ok(!prompt.includes("🧭🧭"), "the authoritative objective is referenced as a whole instead of excerpted");
  assert.ok(!prompt.includes(ownerDirection), "owner steering is also referenced as a whole instead of excerpted");
  assert.ok(teamContext(run).ownerSteering[0].text === ownerDirection);
});

test("project-manager context preserves recovery and continuation evidence within its prompt budget", () => {
  const run = largeRun();
  const continuedTask: TeamTask = { ...run.tasks[0], id: "prior-task", status: "blocked", summary: "Prior task failed its acceptance check." };
  const recovery = { attempts: 1, status: "planning" as const, source: { code: "agent-blocked", memberId: "worker", revision: 1, reason: `Shared return contract needs repair. ${"界".repeat(30000)}`, at: "2026-10-21T00:00:00.000Z" } };
  const continued = { ...run, recovery, continuations: [{ revision: 1, requestId: "request-id", at: "2026-10-21T00:00:00.000Z", reason: "Continue with the unresolved task.", headCommit: "c".repeat(40), tasks: [continuedTask] }] } as TeamRun;
  const prompt = teamPrompt(continued, "project-manager", undefined, undefined, "demo");

  assert.match(prompt, /Recent continuation evidence/);
  assert.match(prompt, /prior-task \(blocked\)/);
  assert.match(prompt, /Prior task failed its acceptance check/);
  assert.match(prompt, /full continuation task and review history there before replanning/);
  assert.equal(teamContext(continued).continuations[0].tasks[0].summary, continuedTask.summary);
  assert.deepEqual(teamContext(continued).recovery, recovery);
  assert.match(prompt, /Automatic recovery attempt 1 of 2/);
  assert.match(prompt, /Shared return contract needs repair/);
  assert.ok(Buffer.byteLength(prompt) <= PROMPT_LIMIT_BYTES);
});

test("permission recovery steps stay in sealed team context and remain advisory in PM and coordinator prompts", () => {
  const run = largeRun();
  const request = { id: "permission-request", revision: 1, targetMemberId: "member", targetSessionId: "session", promptId: 12,
    promptHash: "a".repeat(64), evidenceHash: "b".repeat(64), targetCwd: "/home/dev/projects/example", policyHash: "c".repeat(64),
    expiresAt: "2026-10-21T00:05:00.000Z", status: "exhausted" as const, rounds: 2, latestDecisionId: "decision" };
  const step = { id: "step-1", requestId: request.id, decisionId: "decision", at: "2026-10-21T00:02:00.000Z",
    cause: "The coordinator could not establish the target command source.", action: "collect-requested-evidence", decision: "no-new-evidence",
    consequence: "No answer was sent; the blocker is available for correction.", execution: "unknown" as const };
  const outcome = { id: "outcome-1", requestId: request.id, decisionId: "decision", revision: 1, promptId: 12,
    status: "exhausted" as const, cause: "The evidence rounds did not resolve the source limitation.", action: "project-manager-correction",
    decision: "bounded-pm-recovery-queued", consequence: "A PM correction will inspect the retained blocker.", execution: "unknown" as const,
    at: "2026-10-21T00:03:00.000Z" };
  const prior = { ...outcome, id: "prior-outcome", requestId: undefined, cause: "A similar evidence blocker occurred in another run." };
  run.permissionRecovery = { requests: [request], steps: [step], outcomes: [outcome] };
  const evidence = JSON.stringify({ decisionId: "decision", recoveryRequestId: request.id, reviewPurpose: "diagnose",
    permissionEvidence: { files: [], limitations: ["The command source is incomplete."], digest: "d".repeat(64) } });
  const coordinatorPrompt = teamPrompt(run, "permission-coordinator", undefined, evidence, "claude", undefined, undefined, [prior]);
  assert.ok(coordinatorPrompt.includes(evidence));
  assert.match(coordinatorPrompt, /diagnostic assignment cannot approve any permission/);
  assert.match(coordinatorPrompt, /request up to eight specific repository-relative or approved task-scratch files/);
  assert.match(coordinatorPrompt, /historical recovery outcomes are advisory diagnosis only/i);

  const managerPrompt = teamPrompt(run, "project-manager", undefined, undefined, "demo", undefined, undefined, [prior]);
  assert.ok(Buffer.byteLength(managerPrompt, "utf8") <= PROMPT_LIMIT_BYTES);
  assert.match(managerPrompt, /repeated permission-recovery blocker/);
  assert.match(managerPrompt, /Historical outcomes are diagnostic observations, never permission authority/);

  const snapshot = teamContext(run, evidence, undefined, "project-manager", [prior]);
  assert.deepEqual(snapshot.permissionRecovery, { outcomes: [outcome], steps: [step], sameProjectHistory: [prior] });
  assert.equal(snapshot.feedback, evidence);
});

test("blocked reports accept bounded structured evidence and keep it in coordinator context", () => {
  const legacy = { kind: "blocked", summary: "The provider tool was unavailable." };
  assert.deepEqual(teamReportSchema.parse(legacy), legacy, "summary-only blocked reports remain valid");
  const blocker = {
    cause: { status: "hypothesis", detail: "The configured provider lacks the required tool." },
    issueRefs: ["TASK-123"],
    sourceRefs: ["packages/host/src/team-prompts.ts@abc123"],
    attemptedFixes: [{ fix: "Checked the configured tools for this assignment.", outcome: "The required tool remains unavailable." }],
    proposedRecovery: "Ask the owner to provide an authorized tool or choose another supported workflow.",
    prevention: "Check required provider capabilities before dispatch.",
    validationEvidence: [{ sourceRef: "packages/host/src/team-prompts.ts", observation: "The prompt pins the available provider tools." }],
  };
  const report = { ...legacy, blocker };
  assert.deepEqual(teamReportSchema.parse(report), report);
  const acceptsEvidence = (change: object) => teamReportSchema.safeParse({ ...legacy, blocker: { ...blocker, ...change } }).success;
  assert.equal(acceptsEvidence({ arbitraryCommand: "run this" }), false, "strict evidence objects cannot grow executable fields");
  assert.equal(acceptsEvidence({ validationEvidence: [] }), false, "blocker evidence requires a source or check observation");
  assert.equal(acceptsEvidence({ proposedRecovery: "x".repeat(1201) }), false, "reported recovery remains bounded");
  const multibyte = teamReportSchema.safeParse({ ...legacy, blocker: { ...blocker, validationEvidence: Array.from({ length: 8 }, () => ({ sourceRef: "界".repeat(500), observation: "界".repeat(1000) })) } });
  assert.ok(!multibyte.success && multibyte.error.issues.some(issue => issue.message === "Blocker evidence must fit within 12 KiB of UTF-8 JSON"),
    "the UTF-8 payload is capped even when every field is within its character limit");

  const run = largeRun();
  run.status = "blocked";
  run.reason = report.summary;
  run.members = [{ memberId: "blocked-worker", revision: run.revision, role: "implementer", status: "stopped", baseCommit: run.baseCommit,
    report: teamReportSchema.parse(report) } as TeamRun["members"][number]];
  assert.deepEqual(teamContext(run).memberReports[0].report, report, "the durable context snapshot retains structured blocker evidence");
  const prompt = (role: "project-manager" | "reviewer" | "implementer") => teamPrompt(run, role, undefined, undefined, "demo");
  const sharedKnowledge = /Shared knowledge: when the workflow is available/;
  assert.match(prompt("project-manager"), sharedKnowledge);
  assert.match(prompt("reviewer"), sharedKnowledge);
  assert.doesNotMatch(prompt("implementer"), sharedKnowledge, "only planning and review roles receive the shared-knowledge rule");
  assert.match(prompt("project-manager"), /inspect prior structured blocker evidence before recovery/);
  assert.match(prompt("project-manager"), /A report, continuation, or claimed fix is not a verified resolution/);
  assert.match(prompt("implementer"), /may add "blocker":\{"cause"/, "workers see the structured blocked example");
});

test("team question modes preserve legacy behavior and validate selectable semantics", () => {
  // A recorded question from a member started before recommendations were required; the mode rules are the tool's too.
  const legacy = { kind: "question", question: "Which response format?", options: ["JSON", "Text"] };
  assert.deepEqual(recordedTeamReportSchema.parse(legacy), legacy, "Two legacy options do not infer approval mode");
  assert.deepEqual(recordedTeamReportSchema.parse({ ...legacy, options: [] }), { ...legacy, options: [] });
  assert.equal(recordedTeamReportSchema.safeParse({ ...legacy, answerMode: "approval" }).success, true);
  assert.equal(recordedTeamReportSchema.safeParse({ ...legacy, answerMode: "approval", options: ["Approve"] }).success, false);
  assert.equal(recordedTeamReportSchema.safeParse({ ...legacy, answerMode: "multiple" }).success, true);
  assert.equal(recordedTeamReportSchema.safeParse({ ...legacy, answerMode: "multiple", options: ["Only one"] }).success, false);
  assert.equal(recordedTeamReportSchema.safeParse({ ...legacy, answerMode: "single", options: ["One"] }).success, true);
  assert.equal(recordedTeamReportSchema.safeParse({ ...legacy, answerMode: "approval", options: ["Approve", "Deny", "Defer"] }).success, false);
});

test("team agent guidance distinguishes approval from choices and leaves authority with the owner", () => {
  const prompt = teamPrompt(largeRun(), "project-manager", undefined, undefined, "demo");
  assert.match(prompt, /when feasible, offer concrete selectable options/);
  assert.match(prompt, /answerMode "approval" only for a real authorization proposal/);
  assert.match(prompt, /first meaning approve and the second meaning deny/);
  assert.match(prompt, /two arbitrary options never imply approval/);
  assert.match(prompt, /"recommendation":\{"answers":\["\.\.\."\],"reason":"\.\.\."\}/);
  assert.match(prompt, /Every question carries your recommendation: copy option text exactly .* A recommendation never decides anything\. Never choose or approve for the owner\./);
});

test("permission evidence stays complete inline and an over-budget review fails closed", () => {
  const objective = "Run the exact assigned unit check.";
  const run = { ...largeRun(), objective, linear: undefined, tasks: [], checks: [], steering: [] } as TeamRun;
  const evidence = `Recorded permission evidence 🧪 ${"x".repeat(60000)}`;
  const prompt = teamPrompt(run, "permission-coordinator", undefined, evidence, "demo");

  assert.ok(Buffer.byteLength(prompt, "utf8") <= PROMPT_LIMIT_BYTES);
  assert.ok(prompt.includes(evidence), "permission evidence is never compacted into a repository pointer");
  assert.throws(() => teamPrompt(run, "permission-coordinator", undefined, "x".repeat(100000), "demo"), error =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === "team-prompt-too-large" && /permission request unanswered/.test(String((error as Error).message))));
});

test("the project manager may label kind and raise risk", () => {
  const run = largeRun();
  const manager = teamPrompt(run, "project-manager");
  assert.match(manager, /"risk":"elevated"/);
  assert.match(manager, /feature, fix, refactor, test, docs, or investigation/);
  const implementer = teamPrompt(run, "implementer", run.tasks[0]);
  assert.doesNotMatch(implementer, /"risk":"elevated"/);
  assert.doesNotMatch(implementer, /feature, fix, refactor, test, docs, or investigation/);
});

test("a member context never carries the feature map or the eval block", () => {
  const features = { areas: [{ id: "host", paths: ["packages/host"] }], elevatedTokens: ["ledger"] };
  const eval_ = { capture: true, excludeAreas: ["web"] };
  const checks = [{ command: "npm", args: ["test"] }];
  const base = largeRun();
  const objective = { prompts: "on" as const };
  const run = { ...base, handoff: {
    sourceSessionId: "session", checkpointHead: base.baseCommit, deadlineAt: "2026-11-13T12:00:00.000Z", maxMembers: 1,
    project: { checks, features, eval: eval_, objective },
  } } as unknown as TeamRun;
  const snapshot = teamContext(run, undefined, { checks, features, eval: eval_, objective } as Parameters<typeof teamContext>[2], "implementer");
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /"features"/);
  assert.doesNotMatch(serialized, /"elevatedTokens"/);
  assert.doesNotMatch(serialized, /"eval"/);
  assert.doesNotMatch(serialized, /"excludeAreas"/);
  assert.doesNotMatch(serialized, /"prompts"/, "the objective switch is private settings too");
  assert.match(serialized, /"checks"/, "the configured checks are still present");
  assert.ok((snapshot.authority.handoff as { project?: unknown } | undefined)?.project, "the handoff project is still present");
});

const ENTRY_ROLES_UNDER_TEST = ["project-manager", "scout", "implementer", "integrator", "reviewer"] as const;
const CONTEXT_ACCESS_END = "even when their complete inline text is present.";
const MEMBER_ROLES_UNDER_TEST = ["permission-coordinator", ...ENTRY_ROLES_UNDER_TEST, "delivery"] as const;
const entryToolRoles = new Set<string>(ENTRY_ROLES_UNDER_TEST);

/** Every property name a declared schema carries, at any depth, so a schema change cannot hide a field from the prompt. */
function declaredFieldNames(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const properties = typeof node.properties === "object" && node.properties !== null ? node.properties as Record<string, unknown> : {};
  const members = [node.items, ...(Array.isArray(node.anyOf) ? node.anyOf : []), ...(Array.isArray(node.oneOf) ? node.oneOf : [])];
  return [...Object.keys(properties), ...Object.values(properties).flatMap(declaredFieldNames), ...members.flatMap(declaredFieldNames)];
}

test("the entry paragraph is the only change and only with tools on", () => {
  for (const provider of ENTRY_PROVIDERS) {
    const paragraph = entryInstructions(provider);
    assert.ok(Buffer.byteLength(entryInstructions(provider, "\0"), "utf8") <= ENTRY_PARAGRAPH_LIMIT_BYTES, provider);
    if (provider === "codex") assert.ok(!paragraph.includes(entryCommand()));
    for (const role of ENTRY_ROLES_UNDER_TEST) {
      const off = teamPrompt(smallRun(), role, undefined, undefined, provider, ENTRY_PROFILE);
      const on = teamPrompt(smallRun({ blackboard: { tools: true } }), role, undefined, undefined, provider, ENTRY_PROFILE);
      const withEntry = off.replace(CONTEXT_ACCESS_END, `${CONTEXT_ACCESS_END}\n\n${paragraph}`);
      const expected = provider === "codex" && entryToolRoles.has(role)
        ? withEntry.replace(codexMemberToolInstructions(false), codexMemberToolInstructions(true))
        : withEntry;
      assert.equal(on, expected, `${role} ${provider}`);
    }
    for (const role of ["delivery", "permission-coordinator"] as const) {
      assert.equal(
        teamPrompt(smallRun({ blackboard: { tools: true } }), role, undefined, undefined, provider, ENTRY_PROFILE),
        teamPrompt(smallRun(), role, undefined, undefined, provider, ENTRY_PROFILE),
        `${role} ${provider}`,
      );
    }
  }
});

test("planning and rewrite-review guidance is limited to its role across providers", () => {
  const improvementPlan = "When the objective requests an improvement such as faster, smaller, cheaper, or more reliable, include the measured baseline, a numeric target, and the command that measures both in the plan.";
  const generatedRewriteReview = "For a rewrite or port, confirm the new behavior was compared with the original using generated inputs, not only hand-picked examples.";
  for (const provider of ENTRY_PROVIDERS) {
    const profile = { ...ENTRY_PROFILE, provider };
    for (const role of MEMBER_ROLES_UNDER_TEST) {
      const prompt = teamPrompt(smallRun(), role, undefined, undefined, provider, profile);
      assert.equal(prompt.split(improvementPlan).length - 1, role === "project-manager" ? 1 : 0, `${role} ${provider} planning guidance`);
      assert.equal(prompt.split(generatedRewriteReview).length - 1, role === "reviewer" ? 1 : 0, `${role} ${provider} rewrite-review guidance`);
    }
  }
});

test("Codex tool guidance follows provider, role, and available entry tools", () => {
  for (const provider of ENTRY_PROVIDERS) {
    const profile = { ...ENTRY_PROFILE, provider };
    for (const role of MEMBER_ROLES_UNDER_TEST) for (const toolsOn of [false, true]) {
      const run = smallRun(toolsOn ? { blackboard: { tools: true } } : {});
      const prompt = teamPrompt(run, role, undefined, undefined, provider, profile);
      const codexMember = provider === "codex" && role !== "permission-coordinator";
      const hasEntryTools = toolsOn && entryToolRoles.has(role);
      assert.equal(prompt.split(codexSandboxInstructions).length - 1, codexMember ? 1 : 0, `${role} ${provider} sandbox`);
      assert.equal(prompt.split(codexMemberToolInstructions(hasEntryTools)).length - 1, codexMember ? 1 : 0, `${role} ${provider} signatures`);
      if (codexMember && hasEntryTools) {
        assert.match(prompt, /entry_list\(/, `${role} Codex entry list`);
        assert.match(prompt, /entry_get\(/, `${role} Codex entry get`);
        assert.match(prompt, /entry_post\(/, `${role} Codex entry post`);
      }
    }
  }
});

const TOOL_FAILURE = " Each type is the result of a successful call. When a tool reports a failure the call does not throw: its result has isError true and the reason in content[0].text, and no structuredContent. Check isError before you read structuredContent, and print the reason.";

test("Codex tool signatures name the callable form and carry the declared result shape", () => {
  const tools = [
    { name: "report", schema: outputSchemas.report },
    { name: "entry_list", schema: outputSchemas.entry_list },
    { name: "entry_get", schema: outputSchemas.entry_get },
    { name: "entry_post", schema: outputSchemas.entry_post },
  ] as const;
  const paragraph = codexMemberToolInstructions(true);
  // The types come from the schemas, so a schema change grows every Codex member prompt: these bounds make that a decision.
  assert.ok(Buffer.byteLength(paragraph, "utf8") < 2700, "the rule with the entry tools stays under 2,700 bytes");
  assert.ok(Buffer.byteLength(codexMemberToolInstructions(false), "utf8") < 1100, "the rule with the report tool alone stays under 1,100 bytes");
  assert.ok(paragraph.startsWith("Working rule for tools: when you call tools through exec, do the reading, filtering, counting and comparing inside the program, and print only the result you need for your next decision. Do not print whole tool results."));
  assert.doesNotMatch(paragraph, /session record keeps each nested call/);
  assert.doesNotMatch(paragraph, /\n/);
  assert.match(paragraph, /When a program lists or reads items, print how many it listed, read, and matched/);
  assert.match(paragraph, /Read the context file with a shell call inside a program, and select only the fields needed for your next decision\./);
  assert.match(paragraph, /Tool signatures inside exec \(generated from the tools' declared schemas, no lookup needed\): await tools\.mcp__infinite_team__report\(/);
  // The types are successful results, so the rule also says what a failed call returns.
  assert.ok(paragraph.endsWith(TOOL_FAILURE), "the rule ends with what a failed call returns");
  const sentences = paragraph.slice(0, -TOOL_FAILURE.length).split("await tools.").slice(1).map(sentence => `await tools.${sentence}`.trim());
  assert.deepEqual(sentences.map(sentence => /^await tools\.mcp__infinite_team__(\w+)\(/.exec(sentence)?.[1]), tools.map(tool => tool.name));
  for (const [index, { name, schema }] of tools.entries()) {
    const sentence = sentences[index]!;
    assert.ok(sentence.endsWith(` returns { structuredContent: ${schemaType(schema)} }.`), `${name} result type is generated from its schema`);
    for (const field of declaredFieldNames(schema)) assert.match(sentence, new RegExp(`[{,] ${field}\\??: `), `${name} signature carries ${field}`);
  }
  assert.doesNotMatch(codexMemberToolInstructions(false), /entry_(?:list|get|post)\(/);
});

test("Codex tool signatures list only the tools a member can call", () => {
  const count = (text: string) => text.split("await tools.mcp__infinite_team__").length - 1;
  const reportOnly = codexMemberToolInstructions(false);
  assert.equal(count(reportOnly), 1);
  assert.ok(reportOnly.endsWith(`await tools.mcp__infinite_team__report({ report }) returns { structuredContent: { requestId: string, runId: string, memberId: string, revision: number, message: string } }.${TOOL_FAILURE}`));
  assert.equal(count(codexMemberToolInstructions(true)), 4);
});

test("tool signature types render each schema form from the declared schema", () => {
  const schema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      count: { type: "integer" },
      ratio: { type: "number" },
      ok: { type: "boolean" },
      kind: { type: "string", enum: ["a", "b", "c"] },
      fixed: { const: "x" },
      tags: { type: "array", items: { type: "string" } },
      items: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      choice: { anyOf: [{ type: "string" }, { type: "number" }] },
      nested: { type: "object", properties: { inner: { type: "boolean" }, note: { type: "string" } }, required: ["inner"] },
      any: {},
      extra: { type: "string" },
      unlisted: { type: "array", items: { type: "string", enum: ["p", "q"] } },
    },
    required: ["id", "count", "ratio", "ok", "kind", "fixed", "tags", "items", "choice", "nested", "any"],
  };
  assert.equal(schemaType(schema), '{ id: string, count: number, ratio: number, ok: boolean, kind: "a"|"b"|"c", fixed: "x", tags: string[], items: Array<{ name: string }>, choice: string|number, nested: { inner: boolean, note?: string }, any: unknown, extra?: string, unlisted?: ("p"|"q")[] }');
  assert.equal(schemaType({}), "unknown");
  assert.equal(schemaType({ type: "object" }), "unknown");
  assert.equal(schemaType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }), "(string|number)[]");
  assert.equal(schemaType({ anyOf: [{ type: "string" }, { type: "null" }] }), "string|null");
  assert.equal(schemaType({ type: ["string", "null"] }), "string|null");
  assert.equal(toolSignature("demo_server", "echo", "{ text }", { type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
    "await tools.mcp__demo_server__echo({ text }) returns { structuredContent: { text: string } }.");
});

test("tool signature types follow the schemas the host's zod writes", () => {
  // The expected text is written from the zod definition, not from the renderer.
  const result = z.object({
    id: z.string().uuid(),
    note: z.string().nullable(),
    count: z.number().int().nonnegative(),
    kind: z.enum(["a", "b"]).optional(),
    fixed: z.literal("pending"),
    either: z.union([z.string(), z.number()]),
    rows: z.array(z.object({ name: z.string(), done: z.boolean() }).strict()),
    tags: z.array(z.enum(["x", "y"])),
    scores: z.record(z.string(), z.number()),
    anything: z.unknown(),
    when: z.string().nullable().optional(),
  }).strict();
  assert.equal(schemaType(z.toJSONSchema(result, { target: "draft-7", io: "output" })),
    '{ id: string, note: string|null, count: number, kind?: "a"|"b", fixed: "pending", either: string|number, rows: Array<{ name: string, done: boolean }>, tags: ("x"|"y")[], scores: unknown, anything: unknown, when?: string|null }');
});

test("Codex tool signatures name the server the Codex launch configures", () => {
  const launch = buildLaunch("codex", { command: "codex", args: [] }, "task", { url: "http://127.0.0.1:1", token: "t" }, "/repo/hook-relay.js", { claude: true, codex: true }, true, undefined, undefined, undefined, true);
  const servers = new Set(launch.args.flatMap(arg => /^mcp_servers\.([A-Za-z0-9_]+)\./.exec(arg)?.[1] ?? []));
  assert.equal(servers.size, 1, "a Codex member launch configures one MCP server");
  const [server] = servers;
  const called = [...codexMemberToolInstructions(true).matchAll(/await tools\.mcp__(.+?)__(?:report|entry_list|entry_get|entry_post)\(/g)].map(match => match[1]);
  assert.deepEqual(called, [server, server, server, server]);
});

test("Codex argument signatures match registered MCP input schemas", { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/team-mcp.ts")], {
    cwd: process.cwd(), env: { ...process.env, INFINITE_TEAM_ENTRY_TOOLS: "1", INFINITE_HANDOFF_SESSION: "", INFINITE_MISSION_ASSIGNMENT: "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  type ReplyWaiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
  const pending = new Map<number, ReplyWaiter>();
  const asRecord = (value: unknown): Record<string, unknown> => {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", line => {
    let message: unknown;
    try { message = JSON.parse(line) as unknown; } catch { return; }
    const reply = message !== null && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : undefined;
    if (reply && typeof reply.id === "number") pending.get(reply.id)?.resolve(reply);
    if (reply && typeof reply.id === "number") pending.delete(reply.id);
  });
  child.stderr?.resume();
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("team-mcp exited before replying"));
    pending.clear();
  });
  let requestId = 0;
  const rpc = (method: string, params: unknown = {}) => new Promise<unknown>((resolveReply, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve: resolveReply, reject });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    const initialized = asRecord(await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "team prompt test", version: "1" } }));
    assert.equal(asRecord(initialized.result).protocolVersion, "2025-11-25");
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listing = asRecord(asRecord(await rpc("tools/list")).result);
    assert.ok(Array.isArray(listing.tools));
    const registered = new Map((listing.tools as unknown[]).map(value => {
      const tool = asRecord(value);
      return [tool.name as string, tool] as const;
    }));
    const names = ["report", "entry_list", "entry_get", "entry_post"];
    const signatures = [...codexMemberToolInstructions(true).matchAll(/await tools\.mcp__infinite_team__([a-z_]+)\(([^)]*)\) returns/g)];
    assert.deepEqual(signatures.map(match => match[1]), names);
    for (const [index, name] of names.entries()) {
      const tool = registered.get(name);
      assert.ok(tool, `${name} is listed`);
      const schema = asRecord(tool.inputSchema);
      const properties = asRecord(schema.properties);
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
      const actual = Object.keys(properties).map(argument => ({ name: argument, optional: !required.has(argument) })).sort((a, b) => a.name.localeCompare(b.name));
      const args = signatures[index]![2]!.trim().replace(/^\{|\}$/g, "").split(",").map(argument => argument.trim()).filter(Boolean)
        .map(argument => ({ name: argument.replace(/\?$/, ""), optional: argument.endsWith("?") })).sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(args, actual, `${name} handwritten arguments match tools/list`);
    }
    // What the rule says of a tool error is what the member server answers: an error result with a reason as text and
    // no structuredContent. This is the server's contract; how a provider hands the result to a program is not tested here.
    const failed = asRecord(asRecord(await rpc("tools/call", { name: "entry_get", arguments: {} })).result);
    assert.equal(failed.isError, true);
    assert.equal("structuredContent" in failed, false);
    assert.ok(Array.isArray(failed.content));
    const [first] = failed.content as unknown[];
    const reason = asRecord(first).text;
    assert.ok(typeof reason === "string" && reason.trim().length > 0, "the error result carries a reason");
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
    child.stdin!.end();
    await exited;
    lines.close();
  }
});

test("a retarget swaps the entry paragraph", () => {
  const prompt = teamPrompt(smallRun({ blackboard: { tools: true } }), "implementer", undefined, undefined, "claude", ENTRY_PROFILE);
  assert.ok(prompt.includes(entryInstructions("claude")));
  const retargeted = retargetPrompt(prompt, { provider: "codex", profile: { ...ENTRY_PROFILE, provider: "codex" }, role: "implementer", entryTools: true });
  assert.ok(retargeted);
  assert.equal(retargeted.split(entryInstructions("codex")).length - 1, 1);
  assert.equal(retargeted.includes(entryInstructions("claude")), false);
  assert.equal(retargeted.split(codexSandboxInstructions).length - 1, 1);
  assert.equal(retargeted.split(codexMemberToolInstructions(true)).length - 1, 1);
  const codexAgain = retargetPrompt(retargeted, { provider: "codex", profile: { ...ENTRY_PROFILE, provider: "codex" }, role: "implementer", entryTools: true });
  assert.ok(codexAgain);
  assert.equal(codexAgain.split(codexSandboxInstructions).length - 1, 1);
  assert.equal(codexAgain.split(codexMemberToolInstructions(true)).length - 1, 1);
  const back = retargetPrompt(codexAgain, { provider: "claude", profile: ENTRY_PROFILE, role: "implementer", entryTools: true });
  assert.ok(back);
  assert.equal(back.includes(codexSandboxInstructions), false);
  assert.equal(back.includes(codexMemberToolInstructions(true)), false);
  const backAgain = retargetPrompt(back, { provider: "claude", profile: ENTRY_PROFILE, role: "implementer", entryTools: true });
  assert.ok(backAgain);
  assert.equal(backAgain.includes(codexSandboxInstructions), false);
  assert.equal(backAgain.includes(codexMemberToolInstructions(true)), false);
  const plain = teamPrompt(smallRun(), "implementer", undefined, undefined, "claude", ENTRY_PROFILE);
  assert.equal(refreshReportingInstructions(plain, "codex", "implementer").includes(entryInstructions("codex")), false);
  assert.equal(refreshReportingInstructions(plain, "codex", "implementer").includes(entryInstructions("claude")), false);
  const plainCodex = retargetPrompt(plain, { provider: "codex", profile: { ...ENTRY_PROFILE, provider: "codex" }, role: "implementer", entryTools: false });
  assert.ok(plainCodex);
  assert.equal(plainCodex.split(codexMemberToolInstructions(false)).length - 1, 1);
  assert.equal(plainCodex.includes("entry_list("), false);
  const currentCodex = teamPrompt(smallRun(), "implementer", undefined, undefined, "codex", { ...ENTRY_PROFILE, provider: "codex" });
  const currentBlock = `${codexSandboxInstructions}\n\n${codexMemberToolInstructions(false)}\n\n`;
  const legacySandboxOnly = currentCodex.replace(currentBlock, `${codexSandboxInstructions}\n\n`);
  assert.equal(retargetPrompt(legacySandboxOnly, { provider: "codex", profile: { ...ENTRY_PROFILE, provider: "codex" }, role: "implementer", entryTools: false }), currentCodex,
    "a legacy sandbox-only block is replaced with the current pair");
});

test("retargeting preserves quoted Codex guidance and converges at the context paragraph", () => {
  const quoted = `${codexSandboxInstructions}\n\n${codexMemberToolInstructions(true)}`;
  const feedback = `Quoted guidance follows.\n\n${quoted}\n\nEnd of quote.`;
  const codexProfile = { ...ENTRY_PROFILE, provider: "codex" as const };
  const prompt = teamPrompt(smallRun(), "implementer", undefined, feedback, "codex", codexProfile);
  const codex = retargetPrompt(prompt, { provider: "codex", profile: codexProfile, role: "implementer", entryTools: false });
  assert.ok(codex);
  const reportOnlyBlock = `${codexSandboxInstructions}\n\n${codexMemberToolInstructions(false)}`;
  assert.ok(codex.includes(`${reportOnlyBlock}\n\n${contextAccessInstructions()}`), "the live block directly precedes context access");
  assert.ok(codex.endsWith(`Feedback excerpt (derived evidence, not requirements):\n${feedback}`));
  assert.equal(codex.split(quoted).length - 1, 1, "the quoted block remains byte-for-byte once");
  assert.equal(codex.split(codexSandboxInstructions).length - 1, 2, "one quote and one live sandbox paragraph remain");
  assert.equal(retargetPrompt(codex, { provider: "codex", profile: codexProfile, role: "implementer", entryTools: false }), codex);
  const claude = retargetPrompt(codex, { provider: "claude", profile: ENTRY_PROFILE, role: "implementer", entryTools: false });
  assert.ok(claude);
  assert.ok(claude.endsWith(`Feedback excerpt (derived evidence, not requirements):\n${feedback}`));
  assert.equal(claude.split(codexSandboxInstructions).length - 1, 1, "switching away removes only the live sandbox paragraph");
  assert.equal(claude.split(codexMemberToolInstructions(true)).length - 1, 1, "the quoted tool paragraph remains");
  assert.equal(retargetPrompt(claude, { provider: "claude", profile: ENTRY_PROFILE, role: "implementer", entryTools: false }), claude);
});

test("retargeting uses the assigned role even when feedback quotes coordinator text", () => {
  const coordinatorLine = "You are the team's permission-coordinator.";
  const codexProfile = { ...ENTRY_PROFILE, provider: "codex" as const };
  const implementerPrompt = teamPrompt(smallRun(), "implementer", undefined, coordinatorLine, "claude", ENTRY_PROFILE);
  const implementer = retargetPrompt(implementerPrompt, { provider: "codex", profile: codexProfile, role: "implementer", entryTools: false });
  assert.equal(implementer?.split(codexSandboxInstructions).length, 2, "the assigned implementer gets sandbox guidance");
  const coordinatorPrompt = teamPrompt(smallRun(), "permission-coordinator", undefined, "review evidence", "claude", ENTRY_PROFILE);
  const coordinator = retargetPrompt(coordinatorPrompt, { provider: "codex", profile: codexProfile, role: "permission-coordinator", entryTools: false });
  assert.doesNotMatch(coordinator!, /Codex sandbox guidance:/);
});

test("retargeted signatures use assignment entry tools despite a quoted entry paragraph", () => {
  const quoted = entryInstructions("codex");
  const codexProfile = { ...ENTRY_PROFILE, provider: "codex" as const };
  const reportOnlyPrompt = teamPrompt(smallRun(), "implementer", undefined, quoted, "claude", ENTRY_PROFILE);
  const reportOnly = retargetPrompt(reportOnlyPrompt, { provider: "codex", profile: codexProfile, role: "implementer", entryTools: false });
  assert.ok(reportOnly);
  assert.ok(reportOnly.includes(`${codexSandboxInstructions}\n\n${codexMemberToolInstructions(false)}\n\n${contextAccessInstructions()}`));
  assert.ok(reportOnly.endsWith(`Feedback excerpt (derived evidence, not requirements):\n${quoted}`));
  assert.doesNotMatch(reportOnly, /entry_(?:list|get|post)\(/);
  const entryPrompt = teamPrompt(smallRun({ blackboard: { tools: true } }), "implementer", undefined, undefined, "claude", ENTRY_PROFILE);
  const entryEnabled = retargetPrompt(entryPrompt, { provider: "codex", profile: codexProfile, role: "implementer", entryTools: true });
  assert.ok(entryEnabled);
  assert.ok(entryEnabled.includes(`${codexSandboxInstructions}\n\n${codexMemberToolInstructions(true)}\n\n${contextAccessInstructions()}`));
  assert.equal(entryEnabled.split(codexMemberToolInstructions(true)).length - 1, 1, "the actual entry-enabled assignment gets four signatures");
});

test("retargeting falls back to the reporting paragraph when context access is absent", () => {
  const prompt = teamPrompt(smallRun(), "implementer", undefined, undefined, "claude", ENTRY_PROFILE).replace(contextAccessInstructions(), "");
  const codexProfile = { ...ENTRY_PROFILE, provider: "codex" as const };
  const codex = retargetPrompt(prompt, { provider: "codex", profile: codexProfile, role: "implementer", entryTools: false });
  assert.ok(codex?.includes(`${codexSandboxInstructions}\n\n${codexMemberToolInstructions(false)}\n\n${reportingInstructions("codex")}`));
  const claude = retargetPrompt(codex!, { provider: "claude", profile: ENTRY_PROFILE, role: "implementer", entryTools: false });
  assert.ok(claude);
  assert.doesNotMatch(claude, /Codex sandbox guidance:/);
});

test("a member context never carries the feature map, the eval block, or routing", () => {
  const routing = { mode: "shadow", successValueUsd: 8 };
  const base = largeRun();
  const checks = [{ command: "npm", args: ["test"] }];
  const project = { checks, features: { areas: [{ id: "host", paths: ["packages/host"] }] }, eval: { capture: true } };
  const plain = { ...base, handoff: { sourceSessionId: "session", checkpointHead: base.baseCommit, deadlineAt: "2026-11-13T12:00:00.000Z", maxMembers: 1, project } } as unknown as TeamRun;
  // The run's own pinned policy, as a shadow run carries it, alongside the project's saved one.
  const pinned = { mode: "shadow", requested: "shadow", source: "saved", knobs: { points: ["start"], cascade: false, successValueUsd: 8, maxExploreShare: 0.2, exploreWindow: 50, minSpareAttempts: 4, allowContributor: false, listWeight: 0.25, headroomWeight: 1 }, defaults: [], algorithmVersion: 1, rewardVersion: 1, digest: "d".repeat(64) };
  const withRouting = { ...base, routing: pinned, handoff: { sourceSessionId: "session", checkpointHead: base.baseCommit, deadlineAt: "2026-11-13T12:00:00.000Z", maxMembers: 1, project: { ...project, routing } } } as unknown as TeamRun;
  const configuredPlain = project as Parameters<typeof teamContext>[2];
  const configuredWith = { ...project, routing } as unknown as Parameters<typeof teamContext>[2];
  const roles = ["project-manager", "scout", "implementer", "integrator", "reviewer"] as const;
  for (const role of roles) {
    const snapshot = teamContext(withRouting, undefined, configuredWith, role);
    assert.deepEqual(snapshot, teamContext(plain, undefined, configuredPlain, role), `${role} context changes with routing`);
    assert.doesNotMatch(JSON.stringify(snapshot), /"routing":/);
    const prompt = teamPrompt(withRouting, role, role === "implementer" ? withRouting.tasks[0] : undefined, undefined, "demo", undefined, configuredWith);
    assert.equal(prompt, teamPrompt(plain, role, role === "implementer" ? plain.tasks[0] : undefined, undefined, "demo", undefined, configuredPlain), `${role} prompt changes with routing`);
  }
});

// Moved from 31fd3fb3 because INF-343 adds planning and rewrite-review guidance across providers; contexts stay byte-identical.
const PIN_ROLES = ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery"] as const;
const PIN_CHECKS = [{ command: "npm", args: ["test"] }];
const PIN_GOAL = { id: "00000000-0000-4000-8000-000000000012", revision: 1, cycle: 1, successCriteria: "Owner success text.", nonGoals: ["Do not change billing."], allowedPaths: ["src"], evidence: [], previousWork: [], deadlineAt: "2026-12-01T00:00:00.000Z", maxMembers: 2 } as NonNullable<TeamRun["goal"]>;
const PIN_LINEUP = { coordinator: ENTRY_PROFILE, integrator: ENTRY_PROFILE, reviewer: ENTRY_PROFILE, implementers: [ENTRY_PROFILE] } as TeamRun["lineup"];
const goalRun = (extra: Partial<TeamRun> = {}) => smallRun({ status: "discovering", goal: PIN_GOAL, lineup: PIN_LINEUP, ...extra });
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const placeholdered = (text: string) => text.split(reportCommand()).join("<report-command>").split(entryCommand()).join("<entry-command>");
function pinnedPrompts() {
  const run = goalRun();
  const entryRun = { ...run, blackboard: { tools: true } } as TeamRun;
  return [run, entryRun].flatMap(item => PIN_ROLES.flatMap(role => ENTRY_PROVIDERS.map(provider =>
    placeholdered(teamPrompt(item, role, undefined, undefined, provider, ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true)))));
}
function pinnedContexts() {
  const run = goalRun();
  return PIN_ROLES.map(role => JSON.stringify(teamContext(run, "Owner feedback excerpt.", { checks: PIN_CHECKS }, role), null, 2));
}
// INF-383 moved this pin to 36869333: the Codex working rule's signature sentences now name the callable form and the
// nested result type, generated from the declared schemas, and the rule says what a failed call returns. No other
// prompt or context byte changed.
const PIN_PROMPTS_SHA256 = "3686933351c62af2577448bf68a95620e0d78e732ea5b103cb2b257164631ef8";
const PIN_CONTEXTS_SHA256 = "9ee8fe8ac898e2d70ddbb012ba398387d526294ea61739fb7aad4385b7a7412b";

test("the switch off keeps every prompt and context byte", () => {
  assert.equal(sha256(pinnedPrompts()), PIN_PROMPTS_SHA256, "every role and provider, with and without entry tools");
  assert.equal(sha256(pinnedContexts()), PIN_CONTEXTS_SHA256, "the full context file of every role");
});

// The owner's record digest: the same record criteria, c0 carrying the success text in the prompt only.
const PIN_RECORD = { version: 2, criteria: [
  { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" as const },
  { id: "c1", statement: "The billing page shows the new total.", check: "command:npm test", producer: "host" as const },
] };

test("the record digest replaces the success text and nothing else", () => {
  const { successCriteria, ...goalWithoutText } = PIN_GOAL;
  const withRecord = goalRun({ goal: { ...PIN_GOAL, record: PIN_RECORD } as TeamRun["goal"] });
  const without = goalRun();
  const criteria = PIN_RECORD.criteria.map(item => item.id === "c0" ? { ...item, statement: successCriteria } : item);
  const oldSection = `Approved goal context (immutable for this run):\n${JSON.stringify(PIN_GOAL)}\n`;
  const newSection = `Approved goal context (immutable for this run):\n${JSON.stringify(goalWithoutText)}\nSuccess criteria from the owner's objective record, version 2. Each names how it is checked; c0 is the owner's success text:\n${JSON.stringify(criteria)}\n`;
  for (const role of PIN_ROLES) {
    for (const provider of ENTRY_PROVIDERS) {
      const base = teamPrompt(without, role, undefined, undefined, provider, ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true);
      const next = teamPrompt(withRecord, role, undefined, undefined, provider, ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true);
      assert.equal(base.split(oldSection).length, 2, `${role} ${provider}: the goal section appears once without a record`);
      assert.equal(next, base.replace(oldSection, newSection), `${role} ${provider}: only the goal section changes`);
      assert.equal(next.split(successCriteria).length, 2, `${role} ${provider}: c0's text appears once`);
    }
  }
  const context = teamContext(withRecord, undefined, { checks: PIN_CHECKS }, "implementer");
  const plain = teamContext(without, undefined, { checks: PIN_CHECKS }, "implementer");
  assert.deepEqual(context, { ...plain, authority: { ...plain.authority, goal: { ...PIN_GOAL, record: PIN_RECORD } } });
});

// INF-280 step 2: `auto` prompts. Off and shadow runs keep their bytes; no member reads a routing value.
const AUTO_SPARK: TeamModelProfile = { id: "spark-high", label: "Spark implementer", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high", tier: "light", dataUse: "contributor" };
const AUTO_ASTRA: TeamModelProfile = { id: "astra-xhigh", label: "Astra implementer", provider: "codex", model: "gpt-6-astra", effort: "xhigh" };
const AUTO_LINEUP = { coordinator: ENTRY_PROFILE, integrator: ENTRY_PROFILE, reviewer: { id: "opus-reviewer", label: "Opus reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh" }, implementers: [AUTO_SPARK, AUTO_ASTRA] } as TeamRun["lineup"];
const AUTO_KNOBS = { points: ["start"], cascade: false, successValueUsd: 8, maxExploreShare: 0.2, exploreWindow: 50, minSpareAttempts: 4, allowContributor: false, listWeight: 0.25, headroomWeight: 1 };
const AUTO_DIGEST = sha256("auto-policy-digest-for-prompt-tests");
const AUTO_PIN = { mode: "auto", requested: "auto", source: "autonomous-default", knobs: AUTO_KNOBS, defaults: [], algorithmVersion: 1, rewardVersion: 1, digest: AUTO_DIGEST, periodEndedAt: "2026-11-01T00:00:00.000Z" } as unknown as TeamRunRoutingAuto;
const SHADOW_PIN = (requested: "shadow" | "auto") => ({ mode: "shadow", requested, source: "saved", knobs: AUTO_KNOBS, defaults: [], algorithmVersion: 1, rewardVersion: 1, digest: AUTO_DIGEST }) as unknown as TeamRunRouting;
const HOST_ASSIGNS = "The host assigns each plan task's worker profile; omit agentProfileId from plan tasks. Coordinator, integrator, and reviewer profiles are fixed. Do not invent profile IDs, model names, effort settings, or executable arguments.";
const SCOUT_POOL_SENTENCE = `Choose each scout's agentProfileId from this approved scout pool: ${JSON.stringify([AUTO_ASTRA])}.`;
const ROUTING_VALUE_WORDS = /"routing":|routingRevokedAt|maxExploreShare|exploreWindow|minSpareAttempts|allowContributor|listWeight|headroomWeight|successValueUsd/;
const autoRunWith = (extra: Partial<TeamRun> = {}) => smallRun({ lineup: AUTO_LINEUP, routing: AUTO_PIN, ...extra });
const coordinatorPrompt = (run: TeamRun) => teamPrompt(run, "project-manager", undefined, undefined, "claude", ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true);

test("off and shadow prompts and contexts are byte-equal to main", () => {
  for (const requested of ["shadow", "auto"] as const) {
    const plain = smallRun({ lineup: AUTO_LINEUP });
    const pinned = smallRun({ lineup: AUTO_LINEUP, routing: SHADOW_PIN(requested) });
    for (const role of PIN_ROLES) {
      const prompt = (run: TeamRun) => teamPrompt(run, role, undefined, undefined, "claude", ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true);
      assert.equal(prompt(pinned), prompt(plain), `${role} prompt with a ${requested} pin`);
      assert.equal(JSON.stringify(teamContext(pinned, undefined, { checks: PIN_CHECKS }, role)), JSON.stringify(teamContext(plain, undefined, { checks: PIN_CHECKS }, role)), `${role} context with a ${requested} pin`);
    }
  }
});

test("an auto coordinator is told the host assigns profiles", () => {
  const prompt = coordinatorPrompt(autoRunWith());
  assert.equal(prompt.split(HOST_ASSIGNS).length, 2, "the assignment sentence appears once");
  assert.doesNotMatch(prompt, /Every task MUST include agentProfileId/);
  assert.match(prompt, /"instructions":"\.\.\.","paths"/, "the plan example omits agentProfileId");
  assert.equal(prompt.split(SCOUT_POOL_SENTENCE).length, 2, "the scout pool names only the rule-1 profile");
  assert.doesNotMatch(prompt, /spark-high/);
  assert.doesNotMatch(prompt, ROUTING_VALUE_WORDS);
  assert.equal(prompt.slice(0, 4000).includes(AUTO_DIGEST), false, "the policy digest stays out of the first 4,000 characters");
  assert.equal(prompt.includes(AUTO_DIGEST), false, "the policy digest stays out of the prompt");
});

test("a revoked run and an auto implementer see only the profiles that pass", () => {
  const revoked = autoRunWith({ routingRevokedAt: "2026-11-02T00:00:00.000Z" });
  const prompt = coordinatorPrompt(revoked);
  assert.ok(prompt.includes(`Every task MUST include agentProfileId from this approved worker pool: ${JSON.stringify([AUTO_ASTRA])}. Prefer light`), "the revoked run lists the rule-1 and rule-2 pool");
  assert.doesNotMatch(prompt, /The host assigns each plan task's worker profile/);
  assert.match(prompt, /"instructions":"\.\.\.",\"agentProfileId\":"astra-xhigh"/, "the revoked plan example names the first eligible profile");
  assert.ok(prompt.includes(SCOUT_POOL_SENTENCE), "the revoked explore text names the rule-1 scout pool");
  const escalation = (run: TeamRun) => teamPrompt(run, "implementer", undefined, undefined, "claude", ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true);
  const withEscalations = (routing: TeamRun["routing"], escalations: TeamModelProfile[], routingRevokedAt?: string) =>
    smallRun({ lineup: { ...AUTO_LINEUP, escalations } as TeamRun["lineup"], routing, routingRevokedAt });
  assert.ok(escalation(withEscalations(AUTO_PIN, [AUTO_SPARK, AUTO_ASTRA])).includes(`to this approved pool: ${JSON.stringify([AUTO_ASTRA])}.`), "an auto implementer escalates to the strong profile only");
  assert.ok(escalation(withEscalations(AUTO_PIN, [AUTO_SPARK, AUTO_ASTRA], "2026-11-02T00:00:00.000Z")).includes(`to this approved pool: ${JSON.stringify([AUTO_ASTRA])}.`), "a revoked run escalates to the strong profile only");
  assert.doesNotMatch(escalation(withEscalations(AUTO_PIN, [AUTO_SPARK])), /request one explicit escalation/, "no escalation paragraph without a rule-1 escalation profile");
  assert.ok(escalation(withEscalations(undefined, [AUTO_SPARK, AUTO_ASTRA])).includes(`to this approved pool: ${JSON.stringify([AUTO_SPARK, AUTO_ASTRA])}.`), "an off run escalates to every approved profile");
});

test("a member context never carries a task's routing, in any role or snapshot", () => {
  const routing = { profileId: "astra-xhigh", by: "router" };
  const task = { id: "task-1", title: "Change the reader", instructions: "Read the file.", paths: ["src/reader.ts"], dependsOn: [], revision: 1, status: "pending" };
  const scout = { id: "scout-1", title: "Inspect the flow", instructions: "Find the entry point.", agentProfileId: AUTO_ASTRA.id, status: "complete", summary: "Found it." };
  const continuation = { revision: 1, requestId: "request-1", at: "2026-11-02T00:00:00.000Z", reason: "Repair", headCommit: "b".repeat(40), tasks: [{ ...task, status: "integrated" }] };
  const plain = autoRunWith({ routingRevokedAt: "2026-11-02T00:00:00.000Z", tasks: [task], discovery: { revision: 1, summary: "Found it.", tasks: [scout] }, continuations: [continuation] } as unknown as Partial<TeamRun>);
  const tagged = {
    ...plain,
    tasks: (plain.tasks ?? []).map(item => ({ ...item, routing })),
    discovery: { ...plain.discovery!, tasks: plain.discovery!.tasks.map(item => ({ ...item, routing })) },
    continuations: ((plain as TeamRun & { continuations: (typeof continuation)[] }).continuations).map(item => ({ ...item, tasks: item.tasks.map(next => ({ ...next, routing })) })),
  } as unknown as TeamRun;
  for (const role of ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer"] as const) {
    const snapshot = JSON.stringify(teamContext(tagged, undefined, { checks: PIN_CHECKS }, role));
    assert.doesNotMatch(snapshot, /"routing":/, `${role} context`);
    assert.doesNotMatch(snapshot, /routingRevokedAt/, `${role} context`);
    assert.equal(snapshot, JSON.stringify(teamContext(plain, undefined, { checks: PIN_CHECKS }, role)), `${role} context matches the run without routing`);
  }
  const inline = teamPrompt(tagged, "implementer", tagged.tasks[0], undefined, "codex", AUTO_ASTRA, { checks: PIN_CHECKS }, [], true);
  assert.doesNotMatch(inline, /"routing":/, "the inline implementer task");
  assert.equal(inline, teamPrompt(plain, "implementer", plain.tasks[0], undefined, "codex", AUTO_ASTRA, { checks: PIN_CHECKS }, [], true));
});

// INF-292 step 4: the escalation target and the scout rule. Off, shadow, and version-1 runs keep step 2's bytes.
const HOST_SCOUT_SENTENCE = "The host assigns each scout's profile; omit agentProfileId from scouts.";
const HOST_ESCALATION = `If this task exceeds your reasoning capacity or the approach is failing, you may request one explicit escalation. The host selects the stronger profile. Report {"kind":"escalate","reason":"What failed or requires deeper reasoning; identify partial edits and remaining work"}. The host checks your partial edits, stops you, and continues in the same working copy. If this task already records an escalation, ask a material user question or report blocked; do not switch models yourself.`;
const POINTS_PIN = { ...AUTO_PIN, algorithmVersion: 2, knobs: { ...AUTO_KNOBS, points: ["start", "escalation", "scout"] } } as unknown as TeamRunRoutingAuto;
const OPUS_ESCALATION: TeamModelProfile = { id: "opus-escalation", label: "Opus escalation", provider: "claude", model: "claude-opus-5-5", effort: "xhigh" };
const AUTO_ESCALATIONS = [AUTO_SPARK, AUTO_ASTRA, OPUS_ESCALATION];
const ESCALATION_LINEUP = { ...AUTO_LINEUP, escalations: AUTO_ESCALATIONS } as TeamRun["lineup"];

test("off, shadow, and version-1 prompts and contexts are byte-equal to step 2", () => {
  const shadowV2 = { ...SHADOW_PIN("shadow"), algorithmVersion: 2, knobs: { ...AUTO_KNOBS, points: ["start", "escalation", "scout"] } } as unknown as TeamRunRouting;
  const step2 = smallRun({ lineup: ESCALATION_LINEUP });
  const shadowRun = smallRun({ lineup: ESCALATION_LINEUP, routing: shadowV2 });
  const v1Run = smallRun({ lineup: ESCALATION_LINEUP, routing: { ...POINTS_PIN, algorithmVersion: 1 } as TeamRunRouting });
  const step2Auto = smallRun({ lineup: ESCALATION_LINEUP, routing: AUTO_PIN });
  for (const role of PIN_ROLES) {
    const prompt = (run: TeamRun) => teamPrompt(run, role, undefined, undefined, "claude", AUTO_ASTRA, { checks: PIN_CHECKS }, [], true);
    const context = (run: TeamRun) => JSON.stringify(teamContext(run, undefined, { checks: PIN_CHECKS }, role));
    assert.equal(prompt(shadowRun), prompt(step2), `${role} prompt with a version-2 shadow pin`);
    assert.equal(context(shadowRun), context(step2), `${role} context with a version-2 shadow pin`);
    assert.equal(prompt(v1Run), prompt(step2Auto), `${role} prompt with a version-1 points pin`);
    assert.equal(context(v1Run), context(step2Auto), `${role} context with a version-1 points pin`);
  }
  const revoked = smallRun({ lineup: ESCALATION_LINEUP, routing: POINTS_PIN, routingRevokedAt: "2026-11-02T00:00:00.000Z" });
  assert.equal(coordinatorPrompt(revoked).includes(HOST_SCOUT_SENTENCE), false, "a revoked run names no host-selected scout");
  assert.equal(teamPrompt(revoked, "implementer", undefined, undefined, "claude", AUTO_SPARK, { checks: PIN_CHECKS }, [], true).includes(HOST_ESCALATION), false, "a revoked run names no host-selected escalation");
});

test("a covered run tells the coordinator and the implementer that the host selects, with no routing value", () => {
  const run = smallRun({ lineup: ESCALATION_LINEUP, routing: POINTS_PIN });
  const coordinator = coordinatorPrompt(run);
  const implementer = teamPrompt(run, "implementer", undefined, undefined, "claude", AUTO_SPARK, { checks: PIN_CHECKS }, [], true);
  assert.equal(coordinator.split(HOST_SCOUT_SENTENCE).length, 2, "the host-selects scout sentence appears once");
  assert.equal(coordinator.includes(SCOUT_POOL_SENTENCE), false, "the scout pool sentence is replaced");
  assert.doesNotMatch(coordinator, /"agentProfileId"/, "the explore example names no profile");
  assert.equal(implementer.split(HOST_ESCALATION).length, 2, "the host-selects escalation paragraph appears once");
  assert.equal(implementer.includes("to this approved pool:"), false, "the escalation paragraph lists no pool");
  assert.doesNotMatch(implementer, /"agentProfileId"/, "the escalation paragraph names no profile");
  for (const prompt of [coordinator, implementer]) {
    assert.doesNotMatch(prompt, ROUTING_VALUE_WORDS, "no routing value word");
    assert.doesNotMatch(prompt.slice(0, 4000), ROUTING_VALUE_WORDS, "no routing value word in the first 4,000 characters");
    assert.equal(prompt.includes(AUTO_DIGEST), false, "the policy digest stays out of the prompt");
    assert.equal(prompt.slice(0, 4000).includes(AUTO_DIGEST), false, "the policy digest stays out of the first 4,000 characters");
  }
});

test("every escalation profile on the reviewer's model keeps today's escalation prompt", () => {
  const prompt = (run: TeamRun, modelProfile: TeamModelProfile) => teamPrompt(run, "implementer", undefined, undefined, "claude", modelProfile, { checks: PIN_CHECKS }, [], true);
  const onlyOpus = { ...AUTO_LINEUP, escalations: [OPUS_ESCALATION] } as TeamRun["lineup"];
  const pinnedOpus = smallRun({ lineup: onlyOpus, routing: POINTS_PIN });
  const autoOpus = smallRun({ lineup: onlyOpus, routing: AUTO_PIN });
  assert.equal(prompt(pinnedOpus, AUTO_SPARK), prompt(autoOpus, AUTO_SPARK), "the implementer prompt equals the same run under the version-1 pin");
  assert.ok(prompt(pinnedOpus, AUTO_SPARK).includes(`to this approved pool: ${JSON.stringify([OPUS_ESCALATION])}`), "the reviewer's model stays in today's pool listing");
  const mixedLineup = { ...AUTO_LINEUP, escalations: [AUTO_ASTRA, OPUS_ESCALATION] } as TeamRun["lineup"];
  const mixedPinned = smallRun({ lineup: mixedLineup, routing: POINTS_PIN });
  const mixedAuto = smallRun({ lineup: mixedLineup, routing: AUTO_PIN });
  assert.equal(prompt(mixedPinned, AUTO_ASTRA), prompt(mixedAuto, AUTO_ASTRA), "an implementer whose only other candidate is the reviewer's model keeps today's paragraph");
  assert.equal(prompt(mixedPinned, AUTO_SPARK).includes(HOST_ESCALATION), true, "an implementer with a rule-1 and rule-2 candidate gets the host-selects paragraph");
});

test("a scout's inline assignment never carries its routing", () => {
  const run = smallRun({ lineup: ESCALATION_LINEUP, routing: POINTS_PIN });
  const scout = { id: "inspect-flow", title: "Inspect the current flow", instructions: "A bounded research question", agentProfileId: AUTO_ASTRA.id, status: "pending" };
  const tagged = { ...scout, routing: { profileId: AUTO_ASTRA.id, by: "router" } } as unknown as TeamScout;
  const prompt = (item: TeamScout) => teamPrompt(run, "scout", item, undefined, "codex", AUTO_ASTRA, { checks: PIN_CHECKS }, [], true);
  assert.doesNotMatch(prompt(tagged), /"routing":/, "the scout prompt carries no routing");
  assert.equal(prompt(tagged), prompt(scout as unknown as TeamScout), "the scout prompt equals the same scout without routing");
});

// INF-282 step 3: a derived criterion is marked in the goal section; an intent decision prints fixed text and its ids.
test("derived criteria are marked in the goal section", () => {
  const derived = { ...PIN_RECORD, criteria: [...PIN_RECORD.criteria, { id: "c2", statement: "The export lists every order.", check: "command:npm test", producer: "host" as const, derived: true }] };
  const marked = goalRun({ goal: { ...PIN_GOAL, record: derived } as TeamRun["goal"] });
  const plain = goalRun({ goal: { ...PIN_GOAL, record: PIN_RECORD } as TeamRun["goal"] });
  for (const role of PIN_ROLES) {
    const prompt = teamPrompt(marked, role, undefined, undefined, "claude", ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true);
    assert.equal(prompt.split("c0 is the owner's success text; a criterion marked derived came from the intent check and the owner has not confirmed it:").length, 2, `${role}: one conditional sentence`);
    assert.equal(prompt.split("\"derived\":true").length, 2, `${role}: only c2 is marked`);
    assert.match(prompt, /"id":"c2".*"derived":true/, `${role}: c2 carries the marker`);
    assert.doesNotMatch(teamPrompt(plain, role, undefined, undefined, "claude", ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true), /came from the intent check/, `${role}: no digest criterion, no sentence`);
  }
});

const INTENT_SENTINEL = ["intent", "question", "sentinel"].join("-");
const INTENT_DECISIONS = [
  { id: "d-owner", memberId: "m-plan", revision: 2, question: `The intent check needs your answer. 1. ${INTENT_SENTINEL} one`, options: [], createdAt: "2026-11-16T00:00:00.000Z",
    answer: "Use the stated defaults", answeredBy: "owner", answeredAt: "2026-11-16T00:01:00.000Z", intentQuestions: ["q1", "q2"] },
  { id: "d-connector", memberId: "m-plan", revision: 2, question: `The intent check needs your answer. 2. ${INTENT_SENTINEL} two`, options: [], createdAt: "2026-11-16T00:00:00.000Z",
    answer: "Go with the default", answeredBy: "connector", answeredAt: "2026-11-16T00:02:00.000Z", intentQuestions: ["q1", "q2"] },
] as TeamRun["decisions"];

test("an intent decision's question reaches no authority surface", () => {
  const run = smallRun({ decisions: INTENT_DECISIONS });
  const ids = "The intent check's questions q1, q2";
  assert.equal(ownerDirectionLines(run).join("\n").includes(INTENT_SENTINEL), false, "owner direction lines");
  assert.deepEqual(ownerDirectionLines(run), [`Owner answered "${ids}": Use the stated defaults`]);
  for (const role of PIN_ROLES) for (const provider of ENTRY_PROVIDERS) {
    const prompt = teamPrompt(run, role, undefined, undefined, provider, ENTRY_PROFILE, { checks: PIN_CHECKS }, [], true);
    assert.equal(prompt.includes(INTENT_SENTINEL), false, `${role} ${provider}: no checker text in a prompt`);
    assert.ok(prompt.includes(ids), `${role} ${provider}: the ids print`);
  }
  const context = teamContext(run, undefined, { checks: PIN_CHECKS }, "implementer");
  assert.equal(JSON.stringify(context).includes(INTENT_SENTINEL), false, "the context holds no checker text");
  assert.match(JSON.stringify(context.ownerAnswers), /The intent check's questions q1, q2/);
  assert.match(JSON.stringify(context.agentAnswers), /The intent check's questions q1, q2/);
  const entry = JSON.stringify(hostEntry(run, "answer:d-owner", "2026-11-16T00:03:00.000Z"));
  assert.equal(entry.includes(INTENT_SENTINEL), false, "the blackboard direction entry holds no checker text");
  assert.match(entry, /The intent check's questions q1, q2/);
  const capsule = buildCapsule(run, { id: "t1", title: "Task", instructions: "Do it.", paths: ["src"] } as unknown as TeamTask, { startedAt: "2026-11-16T00:05:00.000Z" } as unknown as TeamMember);
  assert.ok(capsule, "a capsule is built");
  assert.equal(JSON.stringify(capsule).includes(INTENT_SENTINEL), false, "the eval capsule holds no checker text");
  assert.match(JSON.stringify(capsule), /The intent check's questions q1, q2/);
  const legacy = smallRun({ decisions: [{ id: "d-legacy", memberId: "m-plan", revision: 1, question: "Which path?", options: [], createdAt: "2026-11-16T00:00:00.000Z",
    answer: "Use A", answeredBy: "owner", answeredAt: "2026-11-16T00:01:00.000Z" }] as TeamRun["decisions"] });
  assert.deepEqual(ownerDirectionLines(legacy), ['Owner answered "Which path?": Use A'], "a decision without intentQuestions prints as today");
});

test("a continued delivery prompt allows one set of earlier heads, and no other sentence narrows or widens it", () => {
  const delivered = "d".repeat(40), repaired = "e".repeat(40), reviewed = "f".repeat(40), branch = "infinite/team-entry";
  const repair = { runId: "00000000-0000-4000-8000-000000000011", memberId: "m-repair", revision: 2, role: "delivery", sessionId: "s-repair", title: "delivery", status: "stopped",
    cwd: "/home/dev/projects/example", baseCommit: repaired, prompt: "", cursor: 0, stopRequestId: "x", report: { kind: "delivery-repair", headCommit: repaired, summary: "CI failed." } } as TeamMember;
  // Delivered A at revision 1; revision 2 pushed B, which needed a repair; C is the reviewed commit now.
  const run = smallRun({ revision: 2, status: "delivering", headCommit: reviewed, members: [repair], delivery: { mode: "pr", repository: "example/app", baseBranch: "main" },
    pullRequest: { revision: 1, headCommit: delivered, pullRequestUrl: "https://github.com/example/app/pull/7", summary: "Opened.", reportedAt: "2026-11-01T00:00:00.000Z", branch } });
  const prompt = teamPrompt(run, "delivery");
  const rule = `If the branch exists, allow only an unchanged head or a fast-forward from a head recorded for this run, its earlier repair heads or the head it delivered to its pull request: ${JSON.stringify([repaired, delivered])}.`;
  const push = `Push ${branch} to the pinned repository only if its remote head is unchanged or is a fast-forward from one of the heads listed above.`;
  assert.deepEqual(prompt.match(/[^.]*fast-forward[^.]*\./g)?.map(sentence => sentence.trim()), [rule, push], "every push rule names the same set");
  assert.ok(!/neither|nor the reviewed commit/.test(prompt), "no sentence blocks a head the rule allows");
  assert.equal(prompt.split(delivered).length - 1, 2, "the delivered head appears in the rule and in the sentence that names the pull request");
});
