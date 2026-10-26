import test from "node:test";
import assert from "node:assert/strict";
import { teamContext, teamPrompt } from "../packages/host/src/team-prompts.js";
import type { TeamRun, TeamTask } from "../packages/host/src/team-types.js";

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
    decisions: [{ id: "decision-1", memberId: "member-1", revision: 1, question: "Should existing callers keep the same response shape?", options: ["yes", "no"], answer: "Yes, preserve it.", answeredBy: "owner", createdAt: "2026-10-21T00:00:00.000Z" }],
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
  assert.equal(snapshot.authority.permissionsRevokedAt, run.permissionsRevokedAt, "the snapshot distinguishes pinned scope from revoked live authority");

  const implementerPrompt = teamPrompt(run, "implementer", run.tasks[0], undefined, "demo");
  assert.ok(implementerPrompt.includes(run.tasks[0].instructions), "implementers retain the complete task contract inline");
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
