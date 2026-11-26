import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describeTeamWaitReasons, PROVIDER_INPUT_REASON, SESSION_SLOT_REASON } from "../packages/host/src/team-wait-reasons.js";
import { MEMBER_STALL_REASON } from "../packages/host/src/stall-recovery.js";
import type { ProviderLimit } from "../packages/host/src/provider-limits.js";
import type { TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

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
  const codexWorker = member({ memberId: "m-2", sessionId: "s-other", taskId: "task-b", provider: "codex" });
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

test("describeTeamWaitReasons scopes permission prompts, attributes provider limits only to affected members, and aligns discovery slots", () => {
  const mActive = member({ memberId: "m-active", sessionId: "s-active", taskId: "task-a", spinnerOnlySince: "2026-11-26T00:05:00.000Z" });
  const closedPromptRun = baseRun({
    members: [mActive],
    permissionDecisions: [
      {
        id: "perm-closed",
        revision: 1,
        policyHash: "p",
        targetMemberId: "m-active",
        targetSessionId: "s-active",
        targetCwd: mActive.cwd,
        promptId: 1,
        promptHash: "h1",
        evidenceHash: "e1",
        prompt: { id: 1, kind: "permission", title: "Old prompt", options: [], acceptsText: false, source: "screen" },
        option: 0,
        expiresAt: "2026-11-26T01:00:00.000Z",
        answerRequestId: "req-1",
        status: "escalated",
        promptClosedAt: "2026-11-26T00:04:00.000Z",
      },
      {
        id: "perm-old-session",
        revision: 1,
        policyHash: "p",
        targetMemberId: "m-active",
        targetSessionId: "s-previous",
        targetCwd: mActive.cwd,
        promptId: 2,
        promptHash: "h2",
        evidenceHash: "e2",
        prompt: { id: 2, kind: "permission", title: "Old session prompt", options: [], acceptsText: false, source: "screen" },
        option: 0,
        expiresAt: "2026-11-26T01:00:00.000Z",
        answerRequestId: "req-2",
        status: "escalated",
      },
    ],
  });
  const closedReasons = describeTeamWaitReasons(closedPromptRun, [], NOW_MS);
  assert.equal(closedReasons.some((r) => r.kind === "provider-prompt"), false);
  assert.equal(closedReasons.some((r) => r.kind === "spinner-only" && r.memberId === "m-active"), true);

  const liveFilteredRun = baseRun({
    members: [mActive],
    permissionDecisions: [
      {
        id: "perm-live",
        revision: 1,
        policyHash: "p",
        targetMemberId: "m-active",
        targetSessionId: "s-active",
        targetCwd: mActive.cwd,
        promptId: 3,
        promptHash: "h3",
        evidenceHash: "e3",
        prompt: { id: 3, kind: "permission", title: "Prompt", options: [], acceptsText: false, source: "screen" },
        option: 0,
        expiresAt: "2026-11-26T01:00:00.000Z",
        answerRequestId: "req-3",
        status: "escalated",
      },
    ],
  });
  assert.equal(
    describeTeamWaitReasons(liveFilteredRun, [], NOW_MS, { livePrompts: new Map([["s-active", null]]) }).some(
      (r) => r.kind === "provider-prompt",
    ),
    false,
  );
  assert.equal(
    describeTeamWaitReasons(liveFilteredRun, [], NOW_MS, { livePrompts: new Map([["s-active", { id: 3, hash: "h3" }]]) }).some(
      (r) => r.kind === "provider-prompt" && r.decisionId === "perm-live",
    ),
    true,
  );

  const globalCodexLimit: ProviderLimit[] = [
    {
      provider: "codex",
      detectedAt: "2026-11-26T00:04:00.000Z",
      resetsAt: "2026-11-26T02:00:00.000Z",
      expiresAt: "2026-11-26T02:00:00.000Z",
      sessionId: "s-other-team",
      runId: "run-other",
      confidence: "corroborated",
    },
  ];
  const unaffectedRun = baseRun({
    id: "run-2",
    provider: "codex",
    members: [member({ memberId: "m-healthy", sessionId: "s-healthy", provider: "codex", status: "running" })],
  });
  assert.equal(describeTeamWaitReasons(unaffectedRun, globalCodexLimit, NOW_MS).some((r) => r.kind === "provider-limit"), false);

  const mixedDeferredRun = baseRun({
    id: "run-3",
    provider: "codex",
    members: [
      member({ memberId: "m-running", sessionId: "s-running", taskId: "task-1", provider: "codex", status: "running" }),
      member({ memberId: "m-def-1", sessionId: "s-def-1", taskId: "task-2", provider: "codex", status: "queued", pendingLimit: true }),
      member({ memberId: "m-def-2", sessionId: "s-def-2", taskId: "task-3", provider: "codex", status: "queued", pendingLimit: true }),
    ],
  });
  const deferredLimitReasons = describeTeamWaitReasons(mixedDeferredRun, globalCodexLimit, NOW_MS).filter((r) => r.kind === "provider-limit");
  assert.deepEqual(
    deferredLimitReasons.map((r) => r.memberId),
    ["m-def-1", "m-def-2"],
  );
  assert.ok(deferredLimitReasons.every((r) => r.resetsAt === "2026-11-26T02:00:00.000Z"));

  const discoveryDeferredLimit = baseRun({
    status: "discovering",
    parallelism: 1,
    discovery: {
      revision: 1,
      summary: "Explore",
      tasks: [
        { id: "sc-1", title: "Scout 1", instructions: "Read 1", status: "running", memberId: "m-sc-1" },
        { id: "sc-2", title: "Scout 2", instructions: "Read 2", status: "pending" },
      ],
    },
    members: [member({ memberId: "m-sc-1", role: "scout", taskId: "sc-1", status: "queued", pendingLimit: true })],
  });
  assert.equal(describeTeamWaitReasons(discoveryDeferredLimit, [], NOW_MS).some((r) => r.kind === "worker-slot"), false);

  const discoveryDeferredCapacity = baseRun({
    status: "discovering",
    parallelism: 1,
    discovery: {
      revision: 1,
      summary: "Explore",
      tasks: [
        { id: "sc-1", title: "Scout 1", instructions: "Read 1", status: "running", memberId: "m-sc-1" },
        { id: "sc-2", title: "Scout 2", instructions: "Read 2", status: "pending" },
      ],
    },
    members: [member({ memberId: "m-sc-1", role: "scout", taskId: "sc-1", status: "queued", pendingCapacity: true })],
  });
  const capReasons = describeTeamWaitReasons(discoveryDeferredCapacity, [], NOW_MS).filter((r) => r.kind === "worker-slot");
  assert.equal(capReasons.length, 1);
  assert.equal(capReasons[0]?.memberId, "m-sc-1");

  const discoveryFull = baseRun({
    status: "discovering",
    parallelism: 1,
    discovery: {
      revision: 1,
      summary: "Explore",
      tasks: [
        { id: "sc-1", title: "Scout 1", instructions: "Read 1", status: "running", memberId: "m-sc-1" },
        { id: "sc-2", title: "Scout 2", instructions: "Read 2", status: "pending" },
      ],
    },
    members: [member({ memberId: "m-sc-1", role: "scout", taskId: "sc-1", status: "running" })],
  });
  const fullReasons = describeTeamWaitReasons(discoveryFull, [], NOW_MS).filter((r) => r.kind === "worker-slot");
  assert.equal(fullReasons.length, 1);
  assert.equal(fullReasons[0]?.taskId, "sc-2");
});

test("TeamService restores active stage and stall detection after owner answers a PM question and retires obsolete escalated prompts", async () => {
  const f = schedulerFixture();
  try {
    const pm1 = f.run.members[0]!;
    const decisionId = randomUUID();
    pm1.status = "waiting";
    pm1.report = { kind: "question", question: "Use strict mode?", options: ["Yes", "No"] };
    f.run.status = "needs-input";
    f.run.decisions = [{ id: decisionId, memberId: pm1.memberId, revision: 1, question: "Use strict mode?", options: ["Yes", "No"], createdAt: T0 }];
    f.writeTeam();

    const teams = f.openTeam();
    const scheduler = teams as unknown as {
      record(id: string): { run: TeamRun; pending?: unknown };
      step(stored: { run: TeamRun; pending?: unknown }): Promise<void>;
    };
    await teams.answer(f.run.id, decisionId, { requestId: randomUUID(), revision: 1, text: "Yes" });
    const stored = scheduler.record(f.run.id);
    await scheduler.step(stored);
    assert.equal(stored.run.status, "planning");
    assert.equal(stored.run.members.length, 2);
    const pm2 = stored.run.members[1]!;
    assert.equal(pm2.status, "queued");

    await scheduler.step(stored);
    assert.equal(pm2.status, "running");
    assert.equal(stored.run.status, "planning");

    const quietAt = new Date(Date.now() - 10 * 60_000).toISOString();
    pm2.startedAt = quietAt;
    pm2.lastActivityAt = quietAt;
    stored.run.permissionDecisions = [
      {
        id: randomUUID(),
        revision: 1,
        policyHash: "p",
        targetMemberId: pm2.memberId,
        targetSessionId: pm2.sessionId,
        targetCwd: pm2.cwd,
        promptId: 42,
        promptHash: "h42",
        evidenceHash: "e42",
        prompt: { id: 42, kind: "permission", title: "Old prompt", options: [], acceptsText: false, source: "screen" },
        option: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        answerRequestId: randomUUID(),
        status: "escalated",
      },
    ];
    await scheduler.step(stored);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (stored.pending || stored.run.members.length < 3)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await teams.idle();

    const view = teams.get(f.run.id);
    assert.equal(view.members.length, 3);
    assert.equal(view.members[2]?.stalledSourceMemberId, pm2.memberId);
    assert.ok(view.permissionDecisions?.[0]?.promptClosedAt);
    assert.equal(view.waitReasons?.some((r) => r.kind === "provider-prompt"), false);
  } finally {
    f.close();
  }
});
