import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken } from "../packages/host/src/config.js";
import type { EvidenceStore } from "../packages/host/src/evidence/store.js";
import type { RunEvent } from "../packages/host/src/evidence/types.js";
import { computeInterruptedTaskMetrics, type InterruptedTaskReport } from "../packages/host/src/interrupted-task-metrics.js";
import { createApp } from "../packages/host/src/server.js";
import type { TeamContinuation, TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";

const COMMIT_A = "a".repeat(40);
const NOW_ISO = "2026-11-26T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

type StoredRun = {
  run: TeamRun;
  fingerprint: string;
  receipts: Record<string, string>;
  prepared: boolean;
  root: string;
};

type TeamInternals = {
  records: Map<string, StoredRun>;
  evidence: EvidenceStore;
  usage: { imported: boolean; tickFailed: boolean; close(): void; available(): boolean };
};

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
    title: "Regression run",
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

function teamInternals(host: ReturnType<typeof createApp>): TeamInternals {
  return host.teams as unknown as TeamInternals;
}

function seedBlockedRun(
  host: ReturnType<typeof createApp>,
  config: Config,
  options: { projectId: string; code: "agent-question" | "agent-blocked"; at: string; replay?: true },
): TeamRun {
  const runId = randomUUID();
  const memberId = `m-${runId.slice(0, 8)}`;
  const run = makeRun({
    id: runId,
    projectId: options.projectId,
    revision: 1,
    status: "blocked",
    blockCode: options.code,
    createdAt: options.at,
    updatedAt: options.at,
    ...(options.replay ? { replay: true } : {}),
    tasks: [
      makeTask("t-src", "running", [], 1),
      makeTask("t-other", "pending", [], 1),
    ],
    members: [
      makeMember({ runId, memberId, role: "implementer", revision: 1, taskId: "t-src" }),
    ],
  });
  const internals = teamInternals(host);
  internals.records.set(run.id, {
    run,
    fingerprint: "regression-fixture",
    receipts: {},
    prepared: true,
    root: config.teams!.workspaceDir,
  });
  internals.evidence.write(tx => {
    internals.evidence.appendEvent(tx, {
      key: `blk:${run.id}:1`,
      runId: run.id,
      revision: 1,
      at: options.at,
      kind: "run.blocked",
      data: { v: 1, code: options.code, sourceMemberId: memberId },
    });
  });
  return run;
}

async function withHost(
  t: TestContext,
  fn: (ctx: { host: ReturnType<typeof createApp>; config: Config; token: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "interrupted-metrics-reg-"));
  const runDir = mkdtempSync(join(tmpdir(), "interrupted-metrics-run-"));
  const alphaWorkspace = join(root, "workspace-alpha");
  const betaWorkspace = join(root, "workspace-beta");
  mkdirSync(alphaWorkspace, { recursive: true });
  mkdirSync(betaWorkspace, { recursive: true });
  const key = randomBytes(32);
  const token = randomBytes(32).toString("base64url");
  const config: Config = {
    port: 0,
    origin: "http://127.0.0.1",
    keyFile: join(root, "key"),
    stateDir: join(root, "state"),
    runDir,
    environment: "local",
    enableDemo: true,
    maxSessions: 4,
    agents: {},
    projects: [
      { id: "proj-alpha", name: "Alpha", path: alphaWorkspace },
      { id: "proj-beta", name: "Beta", path: betaWorkspace },
    ],
    tokens: [{ id: "owner", label: "Owner", role: "owner", hash: hashToken(token) }],
    teams: { workspaceDir: join(root, "teams") },
  };
  writeFileSync(config.keyFile, key, { mode: 0o600 });
  mkdirSync(join(config.stateDir, "desktop-uploads"), { recursive: true });
  let host: ReturnType<typeof createApp> | undefined;
  let listening = false;
  try {
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("The sandbox does not permit the loopback listener required by the HTTP route test.");
        return;
      }
      throw error;
    } finally {
      if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve()));
    }
    host = createApp(config, key);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      host!.server.once("error", fail);
      host!.server.listen(0, "127.0.0.1", () => {
        listening = true;
        host!.server.removeListener("error", fail);
        resolve();
      });
    });
    config.port = (host.server.address() as { port: number }).port;
    host.teams.close();
    host.goals.close();
    host.missions.close();
    await fn({ host, config, token });
  } finally {
    if (host) {
      await host.closeConnections();
      if (listening) await new Promise<void>(resolve => host!.server.close(() => resolve()));
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
}

test("GET /api/usage/interrupted-tasks succeeds through createApp when usage ledger is unavailable but evidence store is ready", { timeout: 15000 }, async t => {
  await withHost(t, async ({ host, config, token }) => {
    const recentAt = new Date(Date.now() - 60_000).toISOString();
    seedBlockedRun(host, config, { projectId: "proj-alpha", code: "agent-question", at: recentAt });

    const internals = teamInternals(host);
    internals.usage.close();
    internals.usage.imported = false;
    internals.usage.tickFailed = true;
    assert.equal(internals.usage.available(), false);
    assert.equal(internals.evidence.status().state, "ready");

    const headers = { Authorization: `Bearer ${token}` };
    const repairRes = await fetch(`http://127.0.0.1:${config.port}/api/usage/repair-loops`, { headers });
    assert.equal(repairRes.status, 503);
    assert.deepEqual(await repairRes.json(), { error: "The usage ledger is unavailable" });

    const interruptedRes = await fetch(`http://127.0.0.1:${config.port}/api/usage/interrupted-tasks`, { headers });
    assert.equal(interruptedRes.status, 200);
    const body = await interruptedRes.json() as InterruptedTaskReport;
    assert.equal(body.blocksCounted, 1);
    assert.equal(body.interruptedTasksTotal, 1);
    assert.deepEqual(body.bySourceCode, { "agent-question": 1, "agent-blocked": 0 });
  });
});

test("missing fromRevision on run.revision-advanced does not double-count matching continuation while malformed revision 1 stays distinct", () => {
  const recoveryContinuation: TeamContinuation = {
    revision: 1,
    requestId: "req-missing-from",
    at: "2026-11-25T10:00:00.000Z",
    reason: "Automatic PM recovery after agent-question: Which schema?",
    headCommit: COMMIT_A,
    tasks: [
      makeTask("t-src", "running", [], 1),
      makeTask("t-other", "pending", [], 1),
    ],
  };

  const matchedRun = makeRun({
    id: "run-missing-from-matched",
    revision: 2,
    continuations: [recoveryContinuation],
    members: [
      makeMember({ runId: "run-missing-from-matched", memberId: "m-src", role: "implementer", revision: 1, taskId: "t-src" }),
    ],
  });
  const matchedEvents: RunEvent[] = [
    makeEvent({
      seq: 1,
      runId: matchedRun.id,
      revision: 2,
      at: "2026-11-25T10:00:00.000Z",
      kind: "run.revision-advanced",
      data: { v: 1, cause: "automatic-recovery", baseChanged: false, sourceCode: "agent-question" },
    }),
  ];

  const matchedReport = computeInterruptedTaskMetrics([matchedRun], () => matchedEvents, { now: NOW_MS });
  assert.equal(matchedReport.unknownRecoveries, 1);
  assert.equal(matchedReport.recoveriesCounted, 0);
  const matchedUnknownSamples = matchedReport.samples.filter(sample => sample.kind === "recovery" && sample.unknown === true);
  assert.equal(matchedUnknownSamples.length, 1);
  assert.equal(matchedUnknownSamples[0]?.unknownReason, "missing-from-revision");
  assert.equal(matchedUnknownSamples[0]?.revision, 1);

  const malformedRun = makeRun({
    id: "run-missing-from-rev1",
    revision: 2,
    continuations: [recoveryContinuation],
    members: [
      makeMember({ runId: "run-missing-from-rev1", memberId: "m-src", role: "implementer", revision: 1, taskId: "t-src" }),
    ],
  });
  const malformedEvents: RunEvent[] = [
    makeEvent({
      seq: 1,
      runId: malformedRun.id,
      revision: 1,
      at: "2026-11-25T10:00:00.000Z",
      kind: "run.revision-advanced",
      data: { v: 1, cause: "automatic-recovery", baseChanged: false, sourceCode: "agent-question" },
    }),
  ];

  const malformedReport = computeInterruptedTaskMetrics([malformedRun], () => malformedEvents, { now: NOW_MS });
  assert.equal(malformedReport.unknownRecoveries, 2);
  assert.equal(malformedReport.recoveriesCounted, 0);
  const malformedReasons = malformedReport.samples
    .filter(sample => sample.kind === "recovery" && sample.unknown === true)
    .map(sample => sample.unknownReason)
    .sort();
  assert.deepEqual(malformedReasons, ["missing-from-revision", "missing-revision-advanced-event"]);
});

test("GET /api/usage/interrupted-tasks does not call teams.understandingRecords and excludes replay and other-project runs", { timeout: 15000 }, async t => {
  await withHost(t, async ({ host, config, token }) => {
    const recentAt = new Date(Date.now() - 60_000).toISOString();
    const targetRun = seedBlockedRun(host, config, { projectId: "proj-alpha", code: "agent-question", at: recentAt });
    seedBlockedRun(host, config, { projectId: "proj-alpha", code: "agent-blocked", at: recentAt, replay: true });
    seedBlockedRun(host, config, { projectId: "proj-beta", code: "agent-blocked", at: recentAt });

    let understandingRecordsCalls = 0;
    const originalUnderstandingRecords = host.teams.understandingRecords.bind(host.teams);
    host.teams.understandingRecords = () => {
      understandingRecordsCalls += 1;
      return originalUnderstandingRecords();
    };

    const res = await fetch(`http://127.0.0.1:${config.port}/api/usage/interrupted-tasks?project=proj-alpha&days=7`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as InterruptedTaskReport;
    assert.equal(body.projectId, "proj-alpha");
    assert.equal(body.windowDays, 7);
    assert.equal(body.blocksCounted, 1);
    assert.equal(body.interruptedTasksTotal, 1);
    assert.deepEqual(body.bySourceCode, { "agent-question": 1, "agent-blocked": 0 });
    assert.deepEqual(body.samples.map(sample => sample.runId), [targetRun.id]);
    assert.equal(understandingRecordsCalls, 0);
  });
});
