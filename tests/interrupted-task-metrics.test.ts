import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { EvidenceError, type RunEvent } from "../packages/host/src/evidence/types.js";
import { computeInterruptedTaskMetrics, type InterruptedTaskReport } from "../packages/host/src/interrupted-task-metrics.js";
import { formatInterruptedTaskReport, handleUsageInterruptedCommand } from "../packages/host/src/repair-metrics-cli.js";
import { registerRepairMetricsRoute } from "../packages/host/src/repair-metrics-routes.js";
import type { TeamContinuation, TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import { TeamService } from "../packages/host/src/teams.js";
import { prepareMemberWorkspace } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { mixedLineup } from "./team-fixture.js";

const COMMIT_A = "a".repeat(40);
const NOW_ISO = "2026-11-26T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function makeTask(id: string, status: TeamTask["status"], dependsOn: string[] = [], revision = 1): TeamTask {
  return {
    id,
    title: `Task ${id}`,
    instructions: `Implement ${id}`,
    paths: [`${id}.txt`],
    dependsOn,
    revision,
    status,
  };
}

function makeMember(partial: Partial<TeamMember> & Pick<TeamMember, "memberId" | "role">): TeamMember {
  return {
    runId: "run-1",
    revision: 1,
    sessionId: `sess-${partial.memberId}`,
    title: `${partial.role}: ${partial.memberId}`,
    status: "stopped",
    cwd: "/tmp/work",
    baseCommit: COMMIT_A,
    prompt: "prompt",
    cursor: 0,
    stopRequestId: `stop-${partial.memberId}`,
    ...partial,
  };
}

function makeRun(partial: Partial<TeamRun> & Pick<TeamRun, "id">): TeamRun {
  return {
    projectId: "proj-alpha",
    provider: "opencode",
    title: "Test run",
    objective: "Objective",
    parallelism: 4,
    revision: 1,
    status: "ready-for-review",
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:30:00.000Z",
    workspace: "/tmp/ws",
    branch: "main",
    baseCommit: COMMIT_A,
    headCommit: COMMIT_A,
    tasks: [],
    members: [],
    decisions: [],
    checks: [],
    steering: [],
    events: [],
    round: 0,
    ...partial,
  };
}

function makeEvent(partial: Partial<RunEvent> & Pick<RunEvent, "runId" | "revision" | "at" | "kind" | "data">): RunEvent {
  return {
    seq: 1,
    key: `${partial.kind}:${partial.runId}:${partial.revision}:${partial.at}`,
    ...partial,
  };
}

test("joins automatic recovery continuations with run.revision-advanced and excludes source, transitive dependents, and integrated tasks", () => {
  const continuation: TeamContinuation = {
    revision: 1,
    requestId: "req-1",
    at: "2026-11-25T10:15:00.000Z",
    reason: "Automatic PM recovery after agent-question: Which schema should we use?",
    headCommit: COMMIT_A,
    tasks: [
      makeTask("t-done", "integrated"),
      makeTask("t-src", "running"),
      makeTask("t-dep1", "pending", ["t-src"]),
      makeTask("t-dep2", "pending", ["t-dep1"]),
      makeTask("t-ind-run", "running"),
      makeTask("t-ind-pend", "pending", ["t-done"]),
      makeTask("t-cycle-a", "pending", ["t-src", "t-cycle-b"]),
      makeTask("t-cycle-b", "pending", ["t-cycle-a"]),
    ],
  };
  const run = makeRun({
    id: "run-rec-1",
    revision: 2,
    continuations: [continuation],
    members: [
      makeMember({ runId: "run-rec-1", memberId: "m-src", role: "implementer", revision: 1, taskId: "t-src" }),
    ],
  });
  const events: RunEvent[] = [
    makeEvent({
      seq: 10,
      runId: "run-rec-1",
      revision: 2,
      at: "2026-11-25T10:15:00.000Z",
      kind: "run.revision-advanced",
      data: {
        v: 1,
        cause: "automatic-recovery",
        fromRevision: 1,
        baseChanged: false,
        sourceCode: "agent-question",
        sourceMemberId: "m-src",
      },
    }),
  ];

  const report = computeInterruptedTaskMetrics([run], () => events, { now: NOW_MS });
  assert.equal(report.interruptedTasksTotal, 2);
  assert.equal(report.triggerMet, false);
  assert.equal(report.recoveriesCounted, 1);
  assert.equal(report.blocksCounted, 0);
  assert.equal(report.unknownRecoveries, 0);
  assert.equal(report.unknownBlocks, 0);
  assert.deepEqual(report.bySourceCode, { "agent-question": 2, "agent-blocked": 0 });
  assert.deepEqual(report.samples, [
    {
      runId: "run-rec-1",
      projectId: "proj-alpha",
      kind: "recovery",
      revision: 1,
      at: "2026-11-25T10:15:00.000Z",
      sourceCode: "agent-question",
      sourceMemberId: "m-src",
      sourceTaskId: "t-src",
      interruptedCount: 2,
    },
  ]);
});

test("joins unrecovered blocked runs with run.blocked and ignores non-qualifying blocks and replays", () => {
  const blockedRun = makeRun({
    id: "run-blk-1",
    status: "blocked",
    blockCode: "agent-blocked",
    updatedAt: "2026-11-25T11:00:00.000Z",
    tasks: [
      makeTask("t1", "integrated"),
      makeTask("t2", "running"),
      makeTask("t3", "pending", ["t2"]),
      makeTask("t4", "pending"),
      makeTask("t5", "waiting"),
    ],
    members: [
      makeMember({ runId: "run-blk-1", memberId: "m-blk", role: "implementer", revision: 1, taskId: "t2" }),
    ],
  });
  const otherBlocked = makeRun({
    id: "run-blk-other",
    status: "blocked",
    blockCode: "repair-limit",
    tasks: [makeTask("t1", "pending")],
  });
  const replayRun = makeRun({
    id: "run-replay",
    status: "blocked",
    blockCode: "agent-blocked",
    replay: { jobId: "j1", trialId: "tr1", purpose: "replay" },
    tasks: [makeTask("t1", "pending"), makeTask("t2", "pending")],
  });

  const eventsByRun: Record<string, RunEvent[]> = {
    "run-blk-1": [
      makeEvent({
        seq: 1,
        runId: "run-blk-1",
        revision: 1,
        at: "2026-11-25T11:00:00.000Z",
        kind: "run.blocked",
        data: { v: 1, code: "agent-blocked", sourceMemberId: "m-blk" },
      }),
    ],
    "run-blk-other": [
      makeEvent({
        seq: 2,
        runId: "run-blk-other",
        revision: 1,
        at: "2026-11-25T11:05:00.000Z",
        kind: "run.blocked",
        data: { v: 1, code: "repair-limit" },
      }),
    ],
  };

  const report = computeInterruptedTaskMetrics([blockedRun, otherBlocked, replayRun], runId => eventsByRun[runId] ?? [], { now: NOW_MS });
  assert.equal(report.interruptedTasksTotal, 2);
  assert.equal(report.blocksCounted, 1);
  assert.equal(report.unknownBlocks, 0);
  assert.deepEqual(report.bySourceCode, { "agent-question": 0, "agent-blocked": 2 });
  assert.equal(report.samples.length, 1);
  assert.equal(report.samples[0]!.kind, "block");
  assert.equal(report.samples[0]!.sourceTaskId, "t2");
  assert.equal(report.samples[0]!.interruptedCount, 2);
});

test("honesty invariant counts missing events, missing sourceMemberId, unmapped members, and missing snapshots as unknown rather than zero", () => {
  const missingEventRun = makeRun({
    id: "run-missing-event",
    revision: 2,
    continuations: [
      {
        revision: 1,
        requestId: "r1",
        at: "2026-11-25T09:00:00.000Z",
        reason: "Automatic PM recovery after agent-question: Need decision",
        headCommit: COMMIT_A,
        tasks: [makeTask("t1", "running"), makeTask("t2", "pending")],
      },
    ],
  });
  const missingSourceMemberIdRun = makeRun({
    id: "run-missing-member-id",
    revision: 2,
    continuations: [
      {
        revision: 1,
        requestId: "r2",
        at: "2026-11-25T09:10:00.000Z",
        reason: "Automatic PM recovery after agent-blocked: Stuck",
        headCommit: COMMIT_A,
        tasks: [],
      },
    ],
  });
  const unmappedMemberRun = makeRun({
    id: "run-unmapped",
    revision: 2,
    continuations: [
      {
        revision: 1,
        requestId: "r3",
        at: "2026-11-25T09:20:00.000Z",
        reason: "Automatic PM recovery after agent-question: Need choice",
        headCommit: COMMIT_A,
        tasks: [makeTask("t1", "running")],
      },
    ],
    members: [
      makeMember({ runId: "run-unmapped", memberId: "m-no-task", role: "implementer", revision: 1 }),
    ],
  });
  const missingSnapshotRun = makeRun({
    id: "run-missing-snapshot",
    revision: 2,
    continuations: [
      {
        revision: 0,
        requestId: "r0",
        at: "2026-11-25T08:00:00.000Z",
        reason: "Owner continued",
        headCommit: COMMIT_A,
        tasks: [],
      },
    ],
  });
  const blockedMissingAttribution = makeRun({
    id: "run-blocked-unknown",
    status: "blocked",
    blockCode: "agent-blocked",
    updatedAt: "2026-11-25T09:30:00.000Z",
    tasks: [makeTask("t1", "running"), makeTask("t2", "pending")],
  });
  const pmRecoveryEmptyTasks = makeRun({
    id: "run-pm-empty",
    revision: 2,
    continuations: [
      {
        revision: 1,
        requestId: "r4",
        at: "2026-11-25T09:40:00.000Z",
        reason: "Automatic PM recovery after agent-blocked: PM blocked before tasks",
        headCommit: COMMIT_A,
        tasks: [],
      },
    ],
    members: [
      makeMember({ runId: "run-pm-empty", memberId: "m-pm", role: "project-manager", revision: 1 }),
    ],
  });

  const eventsByRun: Record<string, RunEvent[]> = {
    "run-missing-event": [],
    "run-missing-member-id": [
      makeEvent({
        seq: 1,
        runId: "run-missing-member-id",
        revision: 2,
        at: "2026-11-25T09:10:00.000Z",
        kind: "run.revision-advanced",
        data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-blocked" },
      }),
    ],
    "run-unmapped": [
      makeEvent({
        seq: 2,
        runId: "run-unmapped",
        revision: 2,
        at: "2026-11-25T09:20:00.000Z",
        kind: "run.revision-advanced",
        data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-question", sourceMemberId: "m-no-task" },
      }),
    ],
    "run-missing-snapshot": [
      makeEvent({
        seq: 3,
        runId: "run-missing-snapshot",
        revision: 2,
        at: "2026-11-25T09:25:00.000Z",
        kind: "run.revision-advanced",
        data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-question", sourceMemberId: "m1" },
      }),
    ],
    "run-blocked-unknown": [
      makeEvent({
        seq: 4,
        runId: "run-blocked-unknown",
        revision: 1,
        at: "2026-11-25T09:30:00.000Z",
        kind: "run.blocked",
        data: { v: 1, code: "agent-blocked" },
      }),
    ],
    "run-pm-empty": [
      makeEvent({
        seq: 5,
        runId: "run-pm-empty",
        revision: 2,
        at: "2026-11-25T09:40:00.000Z",
        kind: "run.revision-advanced",
        data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-blocked", sourceMemberId: "m-pm" },
      }),
    ],
  };

  const report = computeInterruptedTaskMetrics(
    [missingEventRun, missingSourceMemberIdRun, unmappedMemberRun, missingSnapshotRun, blockedMissingAttribution, pmRecoveryEmptyTasks],
    runId => eventsByRun[runId] ?? [],
    { now: NOW_MS },
  );

  assert.equal(report.interruptedTasksTotal, 0);
  assert.equal(report.recoveriesCounted, 1);
  assert.equal(report.blocksCounted, 0);
  assert.equal(report.unknownRecoveries, 4);
  assert.equal(report.unknownBlocks, 1);
  assert.equal(report.samples.filter(sample => sample.unknown).length, 5);
});

test("filters by windowDays and projectId and computes triggerMet at threshold 10", () => {
  const tasks = Array.from({ length: 11 }, (_, idx) => makeTask(`t${idx}`, idx === 0 ? "running" : "pending"));
  const runInProject = makeRun({
    id: "run-in",
    projectId: "proj-a",
    status: "blocked",
    blockCode: "agent-question",
    updatedAt: "2026-11-24T10:00:00.000Z",
    tasks,
    members: [makeMember({ runId: "run-in", memberId: "m0", role: "implementer", revision: 1, taskId: "t0" })],
  });
  const runOld = makeRun({
    id: "run-old",
    projectId: "proj-a",
    status: "blocked",
    blockCode: "agent-question",
    updatedAt: "2026-10-01T10:00:00.000Z",
    tasks,
    members: [makeMember({ runId: "run-old", memberId: "m0", role: "implementer", revision: 1, taskId: "t0" })],
  });
  const runOtherProject = makeRun({
    id: "run-other",
    projectId: "proj-b",
    status: "blocked",
    blockCode: "agent-blocked",
    updatedAt: "2026-11-24T10:00:00.000Z",
    tasks,
    members: [makeMember({ runId: "run-other", memberId: "m0", role: "implementer", revision: 1, taskId: "t0" })],
  });

  const eventsByRun: Record<string, RunEvent[]> = {
    "run-in": [makeEvent({ runId: "run-in", revision: 1, at: "2026-11-24T10:00:00.000Z", kind: "run.blocked", data: { v: 1, code: "agent-question", sourceMemberId: "m0" } })],
    "run-old": [makeEvent({ runId: "run-old", revision: 1, at: "2026-10-01T10:00:00.000Z", kind: "run.blocked", data: { v: 1, code: "agent-question", sourceMemberId: "m0" } })],
    "run-other": [makeEvent({ runId: "run-other", revision: 1, at: "2026-11-24T10:00:00.000Z", kind: "run.blocked", data: { v: 1, code: "agent-blocked", sourceMemberId: "m0" } })],
  };

  const report = computeInterruptedTaskMetrics([runInProject, runOld, runOtherProject], runId => eventsByRun[runId] ?? [], {
    projectId: "proj-a",
    days: 7,
    now: NOW_MS,
  });
  assert.equal(report.windowDays, 7);
  assert.equal(report.projectId, "proj-a");
  assert.equal(report.interruptedTasksTotal, 10);
  assert.equal(report.triggerThreshold, 10);
  assert.equal(report.triggerMet, true);
  assert.equal(report.blocksCounted, 1);
});

test("GET /api/usage/interrupted-tasks validates query and maps unavailable evidence store to 503", async () => {
  const run = makeRun({
    id: "run-route",
    projectId: "proj-http",
    status: "blocked",
    blockCode: "agent-question",
    tasks: [makeTask("t0", "running"), makeTask("t1", "pending")],
    members: [makeMember({ runId: "run-route", memberId: "m0", role: "implementer", revision: 1, taskId: "t0" })],
  });
  const app = express();
  let evidenceDown = false;
  registerRepairMetricsRoute(app, {
    runs: () => [run],
    memberUsage: () => ({ measured: false, coverage: "none" }),
    events: () => {
      if (evidenceDown) throw new EvidenceError("unavailable", "down");
      return [
        makeEvent({
          runId: "run-route",
          revision: 1,
          at: "2026-11-25T10:00:00.000Z",
          kind: "run.blocked",
          data: { v: 1, code: "agent-question", sourceMemberId: "m0" },
        }),
      ];
    },
    now: () => NOW_MS,
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    return void res.status(400).json({ error: "Invalid request" });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/usage/interrupted-tasks?project=proj-http&days=7`);
    assert.equal(ok.status, 200);
    const body = await ok.json() as InterruptedTaskReport;
    assert.equal(body.windowDays, 7);
    assert.equal(body.projectId, "proj-http");
    assert.equal(body.interruptedTasksTotal, 1);

    assert.equal((await fetch(`http://127.0.0.1:${port}/api/usage/interrupted-tasks?project=INVALID`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/usage/interrupted-tasks?days=0`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/usage/interrupted-tasks?days=367`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/usage/interrupted-tasks?extra=1`)).status, 400);

    evidenceDown = true;
    const down = await fetch(`http://127.0.0.1:${port}/api/usage/interrupted-tasks`);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { code: "evidence-unavailable", error: "The evidence store is unavailable." });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  const missingEventsApp = express();
  registerRepairMetricsRoute(missingEventsApp, {
    runs: () => [],
    memberUsage: () => ({ measured: false, coverage: "none" }),
  });
  const missingServer = missingEventsApp.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => missingServer.once("listening", resolve));
  const missingPort = (missingServer.address() as { port: number }).port;
  try {
    const down = await fetch(`http://127.0.0.1:${missingPort}/api/usage/interrupted-tasks`);
    assert.equal(down.status, 503);
  } finally {
    await new Promise<void>(resolve => missingServer.close(() => resolve()));
  }
});

test("CLI formatter and handleUsageInterruptedCommand format summary, unknowns, and JSON", async () => {
  const sampleReport: InterruptedTaskReport = {
    windowDays: 14,
    since: "2026-11-12T12:00:00.000Z",
    until: NOW_ISO,
    projectId: "proj-a",
    triggerThreshold: 10,
    interruptedTasksTotal: 3,
    triggerMet: false,
    recoveriesCounted: 1,
    blocksCounted: 0,
    unknownRecoveries: 1,
    unknownBlocks: 0,
    bySourceCode: { "agent-question": 3, "agent-blocked": 0 },
    samples: [
      {
        runId: "run-12345678",
        projectId: "proj-a",
        kind: "recovery",
        revision: 1,
        at: "2026-11-25T10:00:00.000Z",
        sourceCode: "agent-question",
        sourceMemberId: "m1",
        sourceTaskId: "t1",
        interruptedCount: 3,
      },
      {
        runId: "run-87654321",
        projectId: "proj-a",
        kind: "recovery",
        revision: 2,
        at: "2026-11-24T10:00:00.000Z",
        sourceCode: "agent-blocked",
        interruptedCount: 0,
        unknown: true,
        unknownReason: "missing-source-member",
      },
    ],
  };

  const formatted = formatInterruptedTaskReport(sampleReport).join("\n");
  assert.match(formatted, /Interrupted tasks · last 14d · project proj-a/);
  assert.match(formatted, /Counted 3 interrupted tasks \(trigger threshold 10: not met\)/);
  assert.match(formatted, /Sources: agent-question 3, agent-blocked 0/);
  assert.match(formatted, /1 recoveries counted \(1 unknown\)/);
  assert.match(formatted, /Warning: 1 recovery\/block events lacked attribution/);
  assert.match(formatted, /unknown\s+2026-11-24T10:00:00\.000Z\s+\(missing-source-member\)/);

  const calls: string[] = [];
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    await handleUsageInterruptedCommand([], { "--project": "proj-a", "--days": "14" }, {
      json: async <T>(path: string) => { calls.push(path); return sampleReport as unknown as T; },
    });
    assert.deepEqual(calls, ["/usage/interrupted-tasks?project=proj-a&days=14"]);
    assert.ok(logs.some(line => line.includes("Interrupted tasks · last 14d")));

    logs.length = 0;
    await handleUsageInterruptedCommand([], { "--json": true }, {
      json: async <T>(path: string) => { calls.push(path); return sampleReport as unknown as T; },
    });
    assert.deepEqual(JSON.parse(logs.join("\n")), sampleReport);
  } finally {
    console.log = origLog;
  }

  await assert.rejects(() => handleUsageInterruptedCommand(["extra"], {}, { json: async () => sampleReport as never }), /Usage: infinite usage interrupted/);
  await assert.rejects(() => handleUsageInterruptedCommand([], { "--days": "0" }, { json: async () => sampleReport as never }), /between 1 and 366/);
  await assert.rejects(() => handleUsageInterruptedCommand([], { "--project": "BAD!" }, { json: async () => sampleReport as never }), /Project ID must match/);
});

test("escalation replacement sets contextFeedback preserving prior feedback and escalation note", async () => {
  const f = schedulerFixture();
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  try {
    const escalation = { id: "astra-escalation", label: "Astra escalation", provider: "codex" as const, model: "gpt-6-astra", effort: "xhigh" as const, tier: "strong" as const };
    f.run.lineup = { ...structuredClone(mixedLineup), escalations: [escalation] };
    const memberId = randomUUID();
    const cwd = await prepareMemberWorkspace(f.run.workspace, memberId, f.run.baseCommit, f.config.teams?.commandPrefix);
    const profile = f.run.lineup.implementers[0]!;
    f.run.headCommit = f.run.baseCommit;
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    const member: TeamMember = {
      ...f.run.members[0]!,
      memberId,
      role: "implementer",
      taskId: "a",
      cwd,
      provider: "opencode",
      modelProfile: profile,
      contextFeedback: "Earlier coordinator feedback",
      status: "stopped",
      report: { kind: "escalate", reason: "Needs the stronger model", agentProfileId: escalation.id },
    };
    f.state.status = "exited";
    f.run.members = [member];
    f.writeTeam();

    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = teams as unknown as {
      record(id: string): { run: TeamRun; pending?: unknown };
      consume(stored: { run: TeamRun; pending?: unknown }, member: TeamMember): void;
    };
    const stored = scheduler.record(f.run.id);
    scheduler.consume(stored, member);
    const deadline = Date.now() + 5000;
    while (stored.pending !== undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(stored.pending, undefined);
    await teams.idle();

    const sealed = f.readRecord<{ run: TeamRun }>("team", f.run.id);
    const next = sealed.run.members.find(item => item.memberId !== memberId)!;
    assert.ok(next, "replacement member exists");
    assert.equal(
      next.contextFeedback,
      "Earlier coordinator feedback\n\nThe previous implementer requested escalation: Needs the stronger model. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.",
    );
  } finally {
    store.close();
    f.close();
  }
});

test("attributes scout discovery recoveries and blocks with zero tasks as zero interrupted tasks rather than unknown", () => {
  const scoutRecovery = makeRun({
    id: "run-scout-rec",
    revision: 2,
    continuations: [
      {
        revision: 1,
        requestId: "r-scout",
        at: "2026-11-25T10:00:00.000Z",
        reason: "Automatic PM recovery after agent-question: Which service owns auth?",
        headCommit: COMMIT_A,
        tasks: [],
      },
    ],
    members: [
      makeMember({ runId: "run-scout-rec", memberId: "m-scout-1", role: "scout", revision: 1, taskId: "scout-auth" }),
    ],
  });
  const scoutBlocked = makeRun({
    id: "run-scout-blk",
    revision: 1,
    status: "blocked",
    blockCode: "agent-blocked",
    updatedAt: "2026-11-25T10:05:00.000Z",
    tasks: [],
    members: [
      makeMember({ runId: "run-scout-blk", memberId: "m-scout-2", role: "scout", revision: 1, taskId: "scout-db" }),
    ],
  });
  const danglingImplementer = makeRun({
    id: "run-impl-dangling",
    revision: 2,
    continuations: [
      {
        revision: 1,
        requestId: "r-impl",
        at: "2026-11-25T10:10:00.000Z",
        reason: "Automatic PM recovery after agent-blocked: Dangling task",
        headCommit: COMMIT_A,
        tasks: [],
      },
    ],
    members: [
      makeMember({ runId: "run-impl-dangling", memberId: "m-impl", role: "implementer", revision: 1, taskId: "missing-task" }),
    ],
  });

  const eventsByRun: Record<string, RunEvent[]> = {
    "run-scout-rec": [
      makeEvent({
        seq: 1,
        runId: "run-scout-rec",
        revision: 2,
        at: "2026-11-25T10:00:00.000Z",
        kind: "run.revision-advanced",
        data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-question", sourceMemberId: "m-scout-1" },
      }),
    ],
    "run-scout-blk": [
      makeEvent({
        seq: 2,
        runId: "run-scout-blk",
        revision: 1,
        at: "2026-11-25T10:05:00.000Z",
        kind: "run.blocked",
        data: { v: 1, code: "agent-blocked", sourceMemberId: "m-scout-2" },
      }),
    ],
    "run-impl-dangling": [
      makeEvent({
        seq: 3,
        runId: "run-impl-dangling",
        revision: 2,
        at: "2026-11-25T10:10:00.000Z",
        kind: "run.revision-advanced",
        data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-blocked", sourceMemberId: "m-impl" },
      }),
    ],
  };

  const report = computeInterruptedTaskMetrics([scoutRecovery, scoutBlocked, danglingImplementer], runId => eventsByRun[runId] ?? [], { now: NOW_MS });
  assert.equal(report.interruptedTasksTotal, 0);
  assert.equal(report.recoveriesCounted, 1);
  assert.equal(report.blocksCounted, 1);
  assert.equal(report.unknownRecoveries, 1);
  assert.equal(report.unknownBlocks, 0);
  const scoutSamples = report.samples.filter(sample => sample.runId.startsWith("run-scout-"));
  assert.equal(scoutSamples.length, 2);
  assert.ok(scoutSamples.every(sample => !sample.unknown && sample.interruptedCount === 0));
  const danglingSample = report.samples.find(sample => sample.runId === "run-impl-dangling");
  assert.equal(danglingSample?.unknown, true);
  assert.equal(danglingSample?.unknownReason, "unmapped-source-task");
});

test("counts unattributed blocked runs with empty tasks and rev > 1 missing continuations as unknown", () => {
  const missingEventEmpty = makeRun({
    id: "run-blk-no-event-empty",
    status: "blocked",
    blockCode: "agent-question",
    updatedAt: "2026-11-25T10:10:00.000Z",
    tasks: [],
  });
  const missingMemberEmpty = makeRun({
    id: "run-blk-no-member-empty",
    status: "blocked",
    blockCode: "agent-blocked",
    updatedAt: "2026-11-25T10:15:00.000Z",
    tasks: [],
  });
  const rev2MissingContinuations = makeRun({
    id: "run-rev2-empty-continuations",
    revision: 2,
    status: "ready-for-review",
    continuations: [],
  });

  const eventsByRun: Record<string, RunEvent[]> = {
    "run-blk-no-event-empty": [],
    "run-blk-no-member-empty": [
      makeEvent({
        seq: 1,
        runId: "run-blk-no-member-empty",
        revision: 1,
        at: "2026-11-25T10:15:00.000Z",
        kind: "run.blocked",
        data: { v: 1, code: "agent-blocked" },
      }),
    ],
    "run-rev2-empty-continuations": [
      makeEvent({
        seq: 2,
        runId: "run-rev2-empty-continuations",
        revision: 2,
        at: "2026-11-25T10:20:00.000Z",
        kind: "run.revision-advanced",
        data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-question", sourceMemberId: "m1" },
      }),
    ],
  };

  const report = computeInterruptedTaskMetrics(
    [missingEventEmpty, missingMemberEmpty, rev2MissingContinuations],
    runId => eventsByRun[runId] ?? [],
    { now: NOW_MS },
  );
  assert.equal(report.blocksCounted, 0);
  assert.equal(report.recoveriesCounted, 0);
  assert.equal(report.unknownBlocks, 2);
  assert.equal(report.unknownRecoveries, 1);
  assert.equal(report.samples.find(sample => sample.runId === "run-blk-no-event-empty")?.unknownReason, "missing-blocked-event");
  assert.equal(report.samples.find(sample => sample.runId === "run-blk-no-member-empty")?.unknownReason, "missing-source-member");
  assert.equal(report.samples.find(sample => sample.runId === "run-rev2-empty-continuations")?.unknownReason, "missing-continuation-snapshot");
});

test("counts earlier automatic-recovery and later run.blocked on the same run once each without double-counting", () => {
  const run = makeRun({
    id: "run-rec-then-blk",
    revision: 2,
    status: "blocked",
    blockCode: "agent-blocked",
    updatedAt: "2026-11-25T11:00:00.000Z",
    continuations: [
      {
        revision: 1,
        requestId: "req-1",
        at: "2026-11-25T10:00:00.000Z",
        reason: "Automatic PM recovery after agent-question: Pick API",
        headCommit: COMMIT_A,
        tasks: [
          makeTask("t1", "running", [], 1),
          makeTask("t2", "pending", [], 1),
          makeTask("t3", "pending", ["t1"], 1),
        ],
      },
    ],
    tasks: [
      makeTask("t1", "integrated", [], 2),
      makeTask("t2", "running", [], 2),
      makeTask("t4", "pending", [], 2),
    ],
    members: [
      makeMember({ runId: "run-rec-then-blk", memberId: "m1", role: "implementer", revision: 1, taskId: "t1" }),
      makeMember({ runId: "run-rec-then-blk", memberId: "m2", role: "implementer", revision: 2, taskId: "t2" }),
    ],
  });
  const events: RunEvent[] = [
    makeEvent({
      seq: 1,
      runId: "run-rec-then-blk",
      revision: 2,
      at: "2026-11-25T10:00:00.000Z",
      kind: "run.revision-advanced",
      data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-question", sourceMemberId: "m1" },
    }),
    makeEvent({
      seq: 2,
      runId: "run-rec-then-blk",
      revision: 2,
      at: "2026-11-25T11:00:00.000Z",
      kind: "run.blocked",
      data: { v: 1, code: "agent-blocked", sourceMemberId: "m2" },
    }),
  ];

  const report = computeInterruptedTaskMetrics([run], () => events, { now: NOW_MS });
  assert.equal(report.recoveriesCounted, 1);
  assert.equal(report.blocksCounted, 1);
  assert.equal(report.unknownRecoveries, 0);
  assert.equal(report.unknownBlocks, 0);
  assert.equal(report.interruptedTasksTotal, 2);
  assert.deepEqual(report.bySourceCode, { "agent-question": 1, "agent-blocked": 1 });
  assert.deepEqual(report.samples.map(sample => ({ kind: sample.kind, revision: sample.revision, interruptedCount: sample.interruptedCount })), [
    { kind: "block", revision: 2, interruptedCount: 1 },
    { kind: "recovery", revision: 1, interruptedCount: 1 },
  ]);
});

test("GET /api/usage/interrupted-tasks paginates real EvidenceStore events independently of usage readable()", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-interrupted-store-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    const run = makeRun({
      id: "run-store-page",
      projectId: "proj-store",
      revision: 2,
      status: "blocked",
      blockCode: "agent-blocked",
      updatedAt: "2026-11-25T11:00:00.000Z",
      continuations: [
        {
          revision: 1,
          requestId: "req-store",
          at: "2026-11-25T10:00:00.000Z",
          reason: "Automatic PM recovery after agent-question: Pick API",
          headCommit: COMMIT_A,
          tasks: [makeTask("t1", "running", [], 1), makeTask("t2", "pending", [], 1)],
        },
      ],
      tasks: [makeTask("t1", "integrated", [], 2), makeTask("t2", "running", [], 2), makeTask("t3", "pending", [], 2)],
      members: [
        makeMember({ runId: "run-store-page", memberId: "m1", role: "implementer", revision: 1, taskId: "t1" }),
        makeMember({ runId: "run-store-page", memberId: "m2", role: "implementer", revision: 2, taskId: "t2" }),
      ],
    });

    store.write(tx => {
      for (let i = 0; i < 505; i += 1) {
        store.appendEvent(tx, {
          key: `steer:run-store-page:${i}`,
          runId: "run-store-page",
          revision: 1,
          at: "2026-11-25T09:00:00.000Z",
          kind: "run.revision-advanced",
          data: { v: 1, cause: "steer", fromRevision: 0, baseChanged: false },
        });
      }
      store.appendEvent(tx, {
        key: "rec:run-store-page:1",
        runId: "run-store-page",
        revision: 2,
        at: "2026-11-25T10:00:00.000Z",
        kind: "run.revision-advanced",
        data: { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "agent-question", sourceMemberId: "m1" },
      });
      store.appendEvent(tx, {
        key: "blk:run-store-page:2",
        runId: "run-store-page",
        revision: 2,
        at: "2026-11-25T11:00:00.000Z",
        kind: "run.blocked",
        data: { v: 1, code: "agent-blocked", sourceMemberId: "m2" },
      });
    });

    const app = express();
    registerRepairMetricsRoute(app, {
      runs: () => [],
      interruptedRuns: () => [run],
      memberUsage: () => ({ measured: false, coverage: "none" }),
      evidence: store,
      readable: () => false,
      now: () => NOW_MS,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/api/usage/interrupted-tasks?project=proj-store`);
      assert.equal(ok.status, 200);
      const body = await ok.json() as InterruptedTaskReport;
      assert.equal(body.recoveriesCounted, 1);
      assert.equal(body.blocksCounted, 1);
      assert.equal(body.interruptedTasksTotal, 2);
      assert.deepEqual(body.bySourceCode, { "agent-question": 1, "agent-blocked": 1 });

      store.close();
      const down = await fetch(`http://127.0.0.1:${port}/api/usage/interrupted-tasks`);
      assert.equal(down.status, 503);
      assert.deepEqual(await down.json(), { code: "evidence-unavailable", error: "The evidence store is unavailable." });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
