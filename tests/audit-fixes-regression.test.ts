import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalBarrier } from "../packages/host/src/terminal-size.js";
import { ANCHOR_SETTLE_MS, CommandFence } from "../packages/host/src/team-command-fence.js";
import { MissionReview, type ReviewForwardOp } from "../packages/host/src/mission-review.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import { collectSharedPool, registerSharedPoolScope } from "../packages/host/src/workspace-pool-gc.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { BASELINE_FILE } from "../packages/host/src/fuse/baseline.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import { IntakeService } from "../packages/host/src/intake.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { slackAudienceIdentity } from "../packages/host/src/intake-audience.js";
import { GoalMetricsPanel } from "../apps/web/src/goal-metrics";
import { goalControls, type ProductGoal } from "../apps/mobile/src/features/teams/model.ts";
import type { Config } from "../packages/host/src/types.js";
import type { Stored } from "../packages/host/src/teams.js";

(globalThis as { React?: unknown }).React = React;

test("TerminalBarrier.run defers its timeout one turn so a callback finishing right after a stall succeeds", async () => {
  const barrier = new TerminalBarrier();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let scheduled: (() => void) | undefined;
  let drainDone: (() => void) | undefined;
  globalThis.setTimeout = ((fn: () => void) => {
    scheduled = fn;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    const promise = barrier.run(
      () => {},
      done => { drainDone = done; },
      () => "ok",
    );
    assert.ok(scheduled);
    assert.ok(drainDone);
    scheduled();
    drainDone();
    assert.equal(await promise, "ok");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("CommandFence.refresh skips unforced census inside ANCHOR_SETTLE_MS for prefixed stopped commands", async () => {
  let now = 100_000;
  let censusCalls = 0;
  const runId = randomUUID();
  const pendingId = randomUUID();
  const stored = {
    run: {
      id: runId,
      workspace: "/tmp/infinite-test-run/integration",
      status: "blocked",
      reason: "blocked",
      events: [],
    },
    pending: {
      id: pendingId,
      kind: "check",
      revision: 1,
      witness: { boot: "boot-1", pids: [42], groups: [42], sessions: [] },
      failure: { code: "command-stop-unconfirmed", reason: "stopped", at: new Date(now - 500).toISOString() },
    },
  } as unknown as Stored;
  const records = new Map([[runId, stored]]);
  const fence = new CommandFence({
    records,
    commands: new Map(),
    config: { teams: { commandPrefix: ["sudo", "-n"] } } as unknown as Config,
    save: () => {},
    event: () => {},
    enqueue: async (_id, task) => await task(),
    options: {
      now: () => now,
      processes: {
        table: () => [],
        census: async () => {
          censusCalls += 1;
          return { ok: true, findings: [] };
        },
      },
    },
  }, () => undefined);

  assert.equal(await fence.refresh(stored, false, false), undefined);
  assert.equal(censusCalls, 0);

  now += ANCHOR_SETTLE_MS;
  assert.equal(await fence.refresh(stored, false, false), "ended");
  assert.equal(censusCalls, 1);
});

test("MissionReview.applyForward preserves its cached review read across paused, stopping, and operation-running steers", async () => {
  let stillCurrentCalls = 0;
  const steerCodes = ["team-paused", "members-stopping", "team-operation-running"];
  let steerCalls = 0;
  const requestId = randomUUID();
  const teamId = randomUUID();
  const missionId = randomUUID();
  const stored = {
    mission: {
      id: missionId,
      status: "working",
      revision: 1,
      maxMinutes: 60,
      steering: [],
      subtasks: [{ id: "s1", repoProjectId: "p1", teamId, status: "running" }],
    },
    receipts: {},
    inbox: [],
    notes: [],
    notified: [],
    ops: { push: () => 1 },
    refusals: 0,
    reviews: [{
      state: "forwarding" as const,
      forwardRequestId: requestId,
      requestId: randomUUID(),
      runId: teamId,
      subtaskId: "s1",
      reviewId: "rev-1",
      pullRequestUrl: "https://github.com/example/repo/pull/1",
      revision: 1,
      headCommit: "a".repeat(40),
      at: new Date().toISOString(),
    }],
  };
  const review = new MissionReview({
    records: new Map([[missionId, stored]]),
    teams: {
      get: () => ({ id: teamId, status: "ready-for-review", headCommit: "a".repeat(40), revision: 1, pullRequest: { revision: 1, headCommit: "a".repeat(40) } }) as never,
      steer: async () => {
        const code = steerCodes[steerCalls++];
        if (code) throw new TeamError(409, code, code);
        return {} as never;
      },
    },
    enqueue: async (_id, task) => await task(),
    save: () => {},
    event: () => {},
    follow: () => {},
    held: () => false,
    reportHeld: () => {},
    steeringFull: () => false,
  });
  review.connect({
    receipt: () => false,
    stillCurrent: async () => {
      stillCurrentCalls += 1;
      return true;
    },
  });
  const op: ReviewForwardOp = { kind: "review-forward", subtaskId: "s1", teamId, requestId, text: "Fix review" };

  assert.equal(await review.applyForward(stored, op), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stillCurrentCalls, 1);

  assert.equal(await review.applyForward(stored, op), true);
  assert.equal(await review.applyForward(stored, op), true);
  assert.equal(await review.applyForward(stored, op), true);
  assert.equal(stillCurrentCalls, 1);

  assert.equal(await review.applyForward(stored, op), false);
  assert.equal(stillCurrentCalls, 1);
  assert.equal(stored.reviews[0]?.state, "forwarded");
});

test("collectSharedPool completes cleanly when a registered scope disappears or lacks refs during scan", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-pool-gc-race-")));
  try {
    const shared = join(root, "shared");
    const blobs = join(shared, "blobs");
    const vanished = join(root, "vanished-scope");
    const emptyScope = join(root, "empty-scope");
    for (const dir of [shared, blobs, vanished, emptyScope]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    await registerSharedPoolScope(shared, vanished);
    await registerSharedPoolScope(shared, emptyScope);
    rmSync(vanished, { recursive: true, force: true });

    const result = await collectSharedPool({ sharedPoolDirectory: shared, graceMs: 0 });
    assert.equal(result.status, "completed");
    assert.equal(result.prunedDeadScopes, 1);
    assert.equal(result.scannedScopes, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FuseService records writeFailedAt when startup baseline write fails", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-fuse-load-")));
  const key = randomBytes(32);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(stateDir), vaultKey: key });
  const now = Date.parse("2026-11-27T12:00:00.000Z");
  try {
    mkdirSync(join(stateDir, BASELINE_FILE));
    const config = {
      stateDir,
      projects: [{ id: "p1", name: "P1", path: join(root, "p1") }],
    } as unknown as Config;
    const fuse = new FuseService({ config, key, store, sessionExists: () => false, now: () => now });
    assert.equal(fuse.view().writeFailedAt, new Date(now).toISOString());
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("IntakeService uses snapshotRecordAllowed for synchronous scans and re-checks uncached audience in async deliver", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-intake-snap-")));
  try {
    const key = randomBytes(32);
    const config = {
      stateDir: root,
      projects: [{ id: "p1", name: "P1", path: join(root, "p1") }],
      intake: {
        maxActive: 4,
        linear: { teamIds: ["T1"], label: "infinite", admitIssues: false, commentsMirrorToSlack: false },
        mission: { groupId: "g1" },
        slack: {
          teamId: "T-SLACK",
          ownerUserId: "U-OWNER",
          organizationScope: { workspaces: [{ projectId: "p1", path: join(root, "p1"), repository: "example/repo" }] },
        },
      },
    } as unknown as Config;
    const store = new IntakeStore(config, key);
    const audienceId = slackAudienceIdentity(config);
    let snapshotCalls = 0;
    let snapshotChecks = 0;
    let directCalls = 0;
    let allowDirect = true;
    const deliveredIssues: string[] = [];
    const intake = new IntakeService(
      config,
      store,
      { onChange: () => () => {}, peek: () => undefined, create: async () => { throw new Error("unused"); }, pause: async () => ({}) } as never,
      {
        candidates: async () => ({ issues: [], capped: false }),
        states: async () => new Map(),
        comment: async (issueId: string) => {
          deliveredIssues.push(issueId);
          allowDirect = false;
        },
      } as never,
      {
        audience: {
          recordAllowed: () => { directCalls += 1; return allowDirect; },
          snapshotRecordAllowed: () => {
            snapshotCalls += 1;
            return () => {
              snapshotChecks += 1;
              return true;
            };
          },
        },
      },
    );
    const issueIds = Array.from({ length: 4 }, () => randomUUID());
    const base = {
      slackAudienceId: audienceId,
      identifier: "INF-1", url: "https://linear.app/x/issue/INF-1", title: "T", description: "D",
      issueCreatedAt: new Date().toISOString(), issueUpdatedAt: new Date().toISOString(),
      state: "finished" as const, rule: "label", missionId: randomUUID(),
      messages: [], questions: [], inbound: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    for (let i = 0; i < issueIds.length; i += 1) {
      store.create({
        ...base,
        issueId: issueIds[i],
        comments: i < 2 ? { outcome: { id: randomUUID(), body: "done", delivered: false, attempts: 0 } } : {},
      });
    }
    assert.equal(intake.list().length, 4);
    assert.equal(snapshotCalls, 1);
    assert.equal(snapshotChecks, 4);
    assert.equal(directCalls, 0);

    await intake.poll();
    assert.ok(snapshotCalls >= 3);
    assert.deepEqual(deliveredIssues, [issueIds[0]]);
    assert.equal(directCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GoalMetricsPanel renders remote-unavailable notice cleanly and mobile goalControls allows resuming paused standing goals past deadlineAt", () => {
  const html = renderToStaticMarkup(createElement(GoalMetricsPanel, { metrics: null, error: "", remoteUnavailable: true, cycles: [1, 2] }));
  assert.ok(html.includes("unavailable over remote access"));
  assert.ok(!html.includes("goal-metric-error"));

  const standingGoal = {
    id: randomUUID(),
    projectId: "p1",
    title: "Standing goal",
    objective: "Keep healthy",
    successCriteria: "Checks stay green",
    nonGoals: [],
    allowedPaths: ["."],
    evidence: [],
    standing: { shape: "objective" as const, cadenceMinutes: 60 },
    maxMinutes: 60,
    maxMembers: 24,
    parallelism: 2,
    revision: 2,
    status: "paused" as const,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T01:00:00.000Z",
    deadlineAt: "2026-11-26T02:00:00.000Z",
    lineup: {} as ProductGoal["lineup"],
    cycles: [],
    memberCount: 0,
    steering: [],
    events: [],
    outcomes: [],
  };
  const controls = goalControls(standingGoal, "owner", true, Date.parse("2026-11-27T12:00:00.000Z"));
  assert.equal(controls.resume, true);
});
