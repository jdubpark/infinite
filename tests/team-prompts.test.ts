import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ENTRY_PARAGRAPH_LIMIT_BYTES, entryCommand, entryInstructions, refreshReportingInstructions, reportCommand, retargetPrompt, teamContext, teamPrompt } from "../packages/host/src/team-prompts.js";
import { teamReportSchema, type TeamBrief, type TeamModelProfile, type TeamRun, type TeamTask } from "../packages/host/src/team-types.js";

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
  const legacy = { kind: "question", question: "Which response format?", options: ["JSON", "Text"] };
  assert.deepEqual(teamReportSchema.parse(legacy), legacy, "Two legacy options do not infer approval mode");
  assert.deepEqual(teamReportSchema.parse({ ...legacy, options: [] }), { ...legacy, options: [] });
  assert.equal(teamReportSchema.safeParse({ ...legacy, answerMode: "approval" }).success, true);
  assert.equal(teamReportSchema.safeParse({ ...legacy, answerMode: "approval", options: ["Approve"] }).success, false);
  assert.equal(teamReportSchema.safeParse({ ...legacy, answerMode: "multiple" }).success, true);
  assert.equal(teamReportSchema.safeParse({ ...legacy, answerMode: "multiple", options: ["Only one"] }).success, false);
  assert.equal(teamReportSchema.safeParse({ ...legacy, answerMode: "single", options: ["One"] }).success, true);
  assert.equal(teamReportSchema.safeParse({ ...legacy, answerMode: "approval", options: ["Approve", "Deny", "Defer"] }).success, false);
});

test("team agent guidance distinguishes approval from choices and leaves authority with the owner", () => {
  const prompt = teamPrompt(largeRun(), "project-manager", undefined, undefined, "demo");
  assert.match(prompt, /when feasible, offer concrete selectable options/);
  assert.match(prompt, /answerMode "approval" only for a real authorization proposal/);
  assert.match(prompt, /first meaning approve and the second meaning deny/);
  assert.match(prompt, /two arbitrary options never imply approval/);
  assert.match(prompt, /Never choose or approve for the owner/);
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
const ENTRY_PROVIDERS = ["claude", "codex", "opencode"] as const;
const ENTRY_PROFILE: TeamModelProfile = { id: "fixture-profile", label: "Fixture profile", provider: "claude", model: "fixture-model", effort: "high" };
const CONTEXT_ACCESS_END = "even when their complete inline text is present.";

function smallRun(extra: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    projectId: "example-project",
    provider: "claude",
    title: "Entry prompt run",
    objective: "Preserve the owner-visible contract.",
    parallelism: 1,
    revision: 1,
    status: "implementing",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    workspace: "/home/dev/projects/example",
    branch: "infinite/team-entry",
    baseCommit: "a".repeat(40),
    tasks: [],
    members: [],
    decisions: [],
    checks: [],
    steering: [],
    events: [],
    round: 1,
    ...extra,
  } as TeamRun;
}

test("the entry paragraph is the only change and only with tools on", () => {
  for (const provider of ENTRY_PROVIDERS) {
    const paragraph = entryInstructions(provider);
    assert.ok(Buffer.byteLength(entryInstructions(provider, "\0"), "utf8") <= ENTRY_PARAGRAPH_LIMIT_BYTES, provider);
    if (provider === "codex") assert.ok(!paragraph.includes(entryCommand()));
    for (const role of ENTRY_ROLES_UNDER_TEST) {
      const off = teamPrompt(smallRun(), role, undefined, undefined, provider, ENTRY_PROFILE);
      const on = teamPrompt(smallRun({ blackboard: { tools: true } }), role, undefined, undefined, provider, ENTRY_PROFILE);
      assert.equal(on, off.replace(CONTEXT_ACCESS_END, `${CONTEXT_ACCESS_END}\n\n${paragraph}`), `${role} ${provider}`);
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

test("a retarget swaps the entry paragraph", () => {
  const prompt = teamPrompt(smallRun({ blackboard: { tools: true } }), "implementer", undefined, undefined, "claude", ENTRY_PROFILE);
  assert.ok(prompt.includes(entryInstructions("claude")));
  const retargeted = retargetPrompt(prompt, { provider: "codex", profile: { ...ENTRY_PROFILE, provider: "codex" } });
  assert.ok(retargeted);
  assert.equal(retargeted.split(entryInstructions("codex")).length - 1, 1);
  assert.equal(retargeted.includes(entryInstructions("claude")), false);
  const plain = teamPrompt(smallRun(), "implementer", undefined, undefined, "claude", ENTRY_PROFILE);
  assert.equal(refreshReportingInstructions(plain, "codex").includes(entryInstructions("codex")), false);
  assert.equal(refreshReportingInstructions(plain, "codex").includes(entryInstructions("claude")), false);
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

// Byte pins: the prompts and contexts of a goal run, with the switch off, equal the output at the base commit.
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
const PIN_PROMPTS_SHA256 = "d47d7a1e8fd478fb571e12c76b96714afecfec680d12b3cee5bc87d598859308";
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
