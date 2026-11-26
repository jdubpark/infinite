import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describeTeamWaitReasons, PROVIDER_INPUT_REASON, SESSION_SLOT_REASON } from "../packages/host/src/team-wait-reasons.js";
import { MEMBER_STALL_REASON } from "../packages/host/src/stall-recovery.js";
import type { ProviderLimit } from "../packages/host/src/provider-limits.js";
import type { TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";

const T0 = "2026-11-26T00:00:00.000Z";
const NOW_MS = Date.parse("2026-11-26T00:10:00.000Z");

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    runId: "run-1",
    memberId: randomUUID(),
    revision: 1,
    role: "implementer",
    provider: "codex",
    sessionId: randomUUID(),
    title: "implementer: task-a",
    status: "running",
    cwd: "/home/dev/projects/infinite/ws/m",
    baseCommit: "a".repeat(40),
    prompt: "do work",
    cursor: 0,
    stopRequestId: randomUUID(),
    startedAt: T0,
    lastActivityAt: T0,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    title: `Task ${id}`,
    instructions: "Do task",
    paths: ["src/a.ts"],
    dependsOn: [],
    revision: 1,
    status: "pending",
    ...overrides,
  };
}

function baseRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "run-1",
    projectId: "proj-1",
    provider: "codex",
    title: "Test run",
    objective: "Test wait reasons",
    parallelism: 1,
    revision: 1,
    status: "implementing",
    createdAt: T0,
    updatedAt: T0,
    workspace: "/home/dev/projects/infinite/ws",
    branch: "main",
    baseCommit: "a".repeat(40),
    tasks: [],
    members: [],
    decisions: [],
    checks: [],
    steering: [],
    events: [],
    round: 0,
    ...overrides,
  };
}

test("describeTeamWaitReasons reports worker-slot, dependency, and integration-order", () => {
  const mA = member({ memberId: "m-a", taskId: "task-a", status: "running" });
  const mB = member({
    memberId: "m-b",
    taskId: "task-b",
    status: "reported",
    reportedAt: "2026-11-26T00:05:00.000Z",
    exitConfirmedAt: "2026-11-26T00:05:01.000Z",
    report: { kind: "result", summary: "Done b" },
  });
  const run = baseRun({
    parallelism: 1,
    tasks: [
      task("task-a", { status: "running", memberId: "m-a" }),
      task("task-b", { status: "waiting", memberId: "m-b" }),
      task("task-c", { status: "pending", dependsOn: [] }),
      task("task-d", { status: "pending", dependsOn: ["task-a"] }),
    ],
    members: [mA, mB],
  });

  const reasons = describeTeamWaitReasons(run, [], NOW_MS);
  const slot = reasons.find((r) => r.kind === "worker-slot");
  assert.ok(slot);
  assert.equal(slot.taskId, "task-c");

  const dep = reasons.find((r) => r.kind === "dependency");
  assert.ok(dep);
  assert.equal(dep.taskId, "task-d");
  assert.deepEqual(dep.blockedByTaskIds, ["task-a"]);

  const order = reasons.find((r) => r.kind === "integration-order");
  assert.ok(order);
  assert.equal(order.taskId, "task-b");
  assert.equal(order.memberId, "m-b");
  assert.deepEqual(order.blockedByTaskIds, ["task-a"]);
  assert.equal(order.since, "2026-11-26T00:05:00.000Z");

  const sessionSlotRun = baseRun({ reason: SESSION_SLOT_REASON });
  const sessionSlotReasons = describeTeamWaitReasons(sessionSlotRun, [], NOW_MS);
  assert.equal(sessionSlotReasons[0]?.kind, "worker-slot");
  assert.equal(sessionSlotReasons[0]?.summary, SESSION_SLOT_REASON);
});

test("describeTeamWaitReasons reports owner-decision, deduplicated provider-prompt, provider-limit, and linear-sync", () => {
  const target = member({
    memberId: "m-1",
    taskId: "task-a",
    pendingLimit: true,
    provider: "claude",
    spinnerOnlySince: "2026-11-26T00:01:00.000Z",
  });
  const codexWorker = member({ memberId: "m-2", taskId: "task-b", provider: "codex" });
  const run = baseRun({
    status: "needs-input",
    linearTracking: true,
    linear: { status: "pending", reason: "Rate limit backoff", checkedAt: "2026-11-26T00:02:00.000Z" },
    members: [target, codexWorker],
    decisions: [
      {
        id: "dec-1",
        memberId: "m-1",
        revision: 1,
        question: "Keep old flag?",
        options: ["Yes", "No"],
        createdAt: "2026-11-26T00:03:00.000Z",
      },
    ],
    permissionDecisions: [
      {
        id: "perm-old",
        revision: 1,
        policyHash: "p",
        targetMemberId: "m-1",
        targetSessionId: target.sessionId,
        targetCwd: target.cwd,
        promptId: 1,
        promptHash: "h",
        evidenceHash: "e",
        prompt: { id: 1, kind: "permission", title: "Run check", options: [], acceptsText: false, source: "screen" },
        option: 0,
        expiresAt: "2026-11-26T01:00:00.000Z",
        answerRequestId: "req-1",
        status: "reviewing",
      },
      {
        id: "perm-latest",
        revision: 1,
        policyHash: "p",
        targetMemberId: "m-1",
        targetSessionId: target.sessionId,
        targetCwd: target.cwd,
        promptId: 2,
        promptHash: "h2",
        evidenceHash: "e2",
        prompt: { id: 2, kind: "permission", title: "Run check", options: [], acceptsText: false, source: "screen" },
        option: 0,
        expiresAt: "2026-11-26T01:00:00.000Z",
        answerRequestId: "req-2",
        status: "escalated",
      },
    ],
  });

  const limits: ProviderLimit[] = [
    {
      provider: "codex",
      detectedAt: "2026-11-26T00:04:00.000Z",
      resetsAt: "2026-11-26T02:00:00.000Z",
      expiresAt: "2026-11-26T02:00:00.000Z",
      sessionId: "s-other",
      runId: "run-1",
      confidence: "corroborated",
    },
  ];

  const reasons = describeTeamWaitReasons(run, limits, NOW_MS);
  const linear = reasons.find((r) => r.kind === "linear-sync");
  assert.ok(linear);
  assert.equal(linear.since, "2026-11-26T00:02:00.000Z");

  const ownerDec = reasons.find((r) => r.kind === "owner-decision");
  assert.ok(ownerDec);
  assert.equal(ownerDec.decisionId, "dec-1");
  assert.equal(ownerDec.memberId, "m-1");
  assert.equal(ownerDec.taskId, "task-a");

  const prompts = reasons.filter((r) => r.kind === "provider-prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.decisionId, "perm-latest");
  assert.equal(prompts[0]?.memberId, "m-1");

  assert.equal(reasons.some((r) => r.kind === "spinner-only" && r.memberId === "m-1"), false);

  const activeLimit = reasons.find((r) => r.kind === "provider-limit" && r.resetsAt !== undefined);
  assert.ok(activeLimit);
  assert.equal(activeLimit.resetsAt, "2026-11-26T02:00:00.000Z");
  assert.equal(activeLimit.memberId, "m-2");

  const pendingLimit = reasons.find((r) => r.kind === "provider-limit" && r.memberId === "m-1");
  assert.ok(pendingLimit);

  const mixedLineupRun = baseRun({
    provider: "codex",
    members: [member({ memberId: "m-claude", provider: "claude" })],
  });
  assert.equal(describeTeamWaitReasons(mixedLineupRun, limits, NOW_MS).some((r) => r.kind === "provider-limit"), false);

  const fallbackPromptRun = baseRun({ reason: PROVIDER_INPUT_REASON });
  assert.equal(describeTeamWaitReasons(fallbackPromptRun, [], NOW_MS)[0]?.kind, "provider-prompt");
});

test("describeTeamWaitReasons handles spinner-only, stalled, blocked gating, and terminal/paused runs", () => {
  const spinnerMember = member({
    memberId: "m-spin",
    taskId: "task-spin",
    spinnerOnlySince: "2026-11-26T00:01:00.000Z",
  });
  const stallingMember = member({
    memberId: "m-stall",
    taskId: "task-stall",
    stalledAt: "2026-11-26T00:08:00.000Z",
    spinnerOnlySince: "2026-11-26T00:02:00.000Z",
  });
  const activeRun = baseRun({ members: [spinnerMember, stallingMember] });
  const activeReasons = describeTeamWaitReasons(activeRun, [], NOW_MS);

  const spin = activeReasons.find((r) => r.kind === "spinner-only");
  assert.ok(spin);
  assert.equal(spin.memberId, "m-spin");

  const stalled = activeReasons.find((r) => r.kind === "stalled");
  assert.ok(stalled);
  assert.equal(stalled.memberId, "m-stall");

  const blockedStallRun = baseRun({
    status: "blocked",
    blockCode: "member-stalled",
    reason: MEMBER_STALL_REASON,
    linearTracking: true,
    linear: { status: "blocked", reason: "Issue cancelled" },
    decisions: [{ id: "d1", memberId: "m-b1", revision: 1, question: "Q?", options: ["A"], createdAt: T0 }],
    members: [member({ memberId: "m-b1", taskId: "task-1", status: "stopped", stalledAt: "2026-11-26T00:09:00.000Z", spinnerOnlySince: T0 })],
  });
  const blockedReasons = describeTeamWaitReasons(blockedStallRun, [
    { provider: "codex", detectedAt: T0, expiresAt: "2026-11-26T02:00:00.000Z", sessionId: "s", runId: "run-1", confidence: "corroborated" },
  ], NOW_MS);
  assert.deepEqual(blockedReasons.map((r) => r.kind), ["stalled"]);
  assert.equal(blockedReasons[0]?.memberId, "m-b1");

  const blockedLimitRun = baseRun({
    status: "blocked",
    blockCode: "provider-limit",
    provider: "codex",
  });
  const blockedLimitReasons = describeTeamWaitReasons(blockedLimitRun, [
    { provider: "codex", detectedAt: T0, expiresAt: "2026-11-26T02:00:00.000Z", sessionId: "s", runId: "run-1", confidence: "corroborated" },
  ], NOW_MS);
  assert.deepEqual(blockedLimitReasons.map((r) => r.kind), ["provider-limit"]);

  const blockedLinearRun = baseRun({
    linearTracking: true,
    linear: { status: "blocked", reason: "Issue cancelled" },
  });
  assert.equal(describeTeamWaitReasons(blockedLinearRun, [], NOW_MS).some((r) => r.kind === "linear-sync"), false);

  for (const status of ["paused", "ready-for-review", "merged", "no-change", "cancelled"] as const) {
    assert.deepEqual(describeTeamWaitReasons(baseRun({ status, members: [spinnerMember] }), [], NOW_MS), []);
  }

  const deferredRun = baseRun({
    parallelism: 1,
    tasks: [
      task("task-deferred", { status: "running", memberId: "m-cap" }),
      task("task-ready", { status: "pending", dependsOn: [] }),
    ],
    members: [member({ memberId: "m-cap", taskId: "task-deferred", status: "queued", pendingCapacity: true })],
  });
  const deferredReasons = describeTeamWaitReasons(deferredRun, [], NOW_MS);
  assert.equal(deferredReasons.filter((r) => r.kind === "worker-slot").length, 1);
  assert.equal(deferredReasons[0]?.memberId, "m-cap");
});

test("describeTeamWaitReasons orders urgent reasons first and clips long interpolated text", () => {
  const stalled = member({ memberId: "m-stall", taskId: "task-1", stalledAt: "2026-11-26T00:08:00.000Z" });
  const run = baseRun({
    parallelism: 1,
    linearTracking: true,
    linear: { status: "pending", reason: `Linear\n  backoff   ${"z".repeat(400)}` },
    members: [stalled],
    tasks: [
      task("task-1", { status: "running", memberId: "m-stall" }),
      task("task-2", { status: "pending", dependsOn: [] }),
    ],
    decisions: [
      { id: "d-long", memberId: "m-stall", revision: 1, question: `Should\n\nwe   ${"q".repeat(4000)}`, options: ["Yes"], createdAt: T0 },
    ],
  });
  const reasons = describeTeamWaitReasons(run, [], NOW_MS);
  assert.deepEqual(reasons.map((r) => r.kind), ["owner-decision", "stalled", "worker-slot", "linear-sync"]);
  for (const reason of reasons) {
    assert.ok(reason.summary.length <= 240);
    assert.ok(!/[\r\n]/.test(reason.summary));
  }
  assert.ok(reasons[0]!.summary.endsWith("..."));
  assert.ok(reasons[3]!.summary.endsWith("..."));
});
