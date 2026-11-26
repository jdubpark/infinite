import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError, type EvidenceModule } from "../packages/host/src/evidence/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import { computeOutcomeCost, sessionCostOf, syncOutcomeCosts } from "../packages/host/src/outcome-cost.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { buildRollup } from "../packages/host/src/outcome-rollup.js";
import {
  outcomeModule,
  readOutcome,
  selectRoutingEvidence,
  writeOutcome,
  type OutcomePayload,
  type OutcomeRow,
  type RollupRecords,
} from "../packages/host/src/outcome-store.js";
import { runEventKey } from "../packages/host/src/run-events.js";
import type { Config } from "../packages/host/src/types.js";
import type { UsageRecord } from "../packages/host/src/usage.js";
import { UsageService, type SessionUsage, type UnmeasuredUsage, type UsageSessionRow } from "../packages/host/src/usage-service.js";
import { usageModule, writeRecord, writeSession } from "../packages/host/src/usage-store.js";

function measured(coverage: "partial" | "complete", unpriced = 0, amounts: { input: number; cost: number } = { input: 10, cost: 0.5 }): SessionUsage {
  return {
    measured: true, coverage, cost: amounts.cost, messages: 2,
    tokens: { input: amounts.input, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 4 },
    pricing: { configured: 2 - unpriced, catalog: 0, provider: 0, unknown: unpriced },
  };
}

test("a session's cost is complete only with complete coverage and every step priced", () => {
  assert.deepEqual(sessionCostOf(measured("complete")), { usd: 0.5, tokens: 24, complete: true });
  assert.deepEqual(sessionCostOf(measured("partial")), { usd: 0.5, tokens: 24, complete: false });
  assert.deepEqual(sessionCostOf(measured("complete", 1)), { usd: 0.5, tokens: 24, complete: false });
});

test("no measurement is no cost, and an unreadable ledger fails the read", () => {
  const unmeasured: UnmeasuredUsage = { measured: false, coverage: "none" };
  assert.equal(sessionCostOf(unmeasured), undefined);
  assert.throws(
    () => sessionCostOf({ measured: false, coverage: "none", unavailable: true }),
    (error: unknown) => error instanceof EvidenceError && error.code === "unavailable",
  );
});

test("a roll-up leaves a partly covered session out of its sums and counts it as left out", () => {
  const row = (memberId: string, sessionId: string): OutcomeRow => ({
    outcomeId: `run-1:${memberId}`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: "run-1", revision: 1, memberId, sessionId,
    attemptIndex: 1, inherited: false, role: "implementer", profileId: "profile-a", provider: "opencode", model: "model-one", effort: null, profileEpoch: 1,
    configId: null, experimentRef: null, kind: null, risk: "unknown", featureVersion: 1, disposition: "integrated", exclusion: null, flags: [],
    integrated: 1, accepted: 1, firstPass: 1, held: null, startedAt: "2026-11-13T10:00:00.000Z", endedAt: "2026-11-13T10:30:00.000Z", frozenAt: null,
    holdUntil: null, runDeletedAt: null,
    payload: { projectId: "example", taskId: "task-a", area: "core", featureMap: "default", rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none" },
  });
  const records: RollupRecords = { runIds: ["run-1"], summaries: [], rows: [row("m1", "whole"), row("m2", "part")], members: [],
    unreadable: { summaries: 0, rows: 0, members: 0 }, unindexed: 0 };
  const usage: Record<string, SessionUsage> = { whole: measured("complete"), part: measured("partial", 0, { input: 986, cost: 7 }) };
  const rollup = buildRollup(records, { target: { kind: "goal", id: "goal-1" }, known: true, assessment: null, cost: sessionId => sessionCostOf(usage[sessionId]!) });
  assert.deepEqual(rollup.cost, { sessions: 2, complete: 1, noSession: 0, tokens: 24, spentUsd: 0.5 });
});

test("sessionCostOf carries complete listUsd separately from metered spent cost", () => {
  const subscription: SessionUsage = {
    measured: true,
    coverage: "complete",
    cost: 0,
    messages: 2,
    tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    pricing: { configured: 0, catalog: 0, provider: 0, unknown: 2 },
    list: { usd: 0.75, unpriced: 0 },
  };
  assert.deepEqual(sessionCostOf(subscription), { usd: 0, tokens: 1500, complete: false, listUsd: 0.75 });
  assert.equal(sessionCostOf({ ...subscription, list: { usd: 0.75, unpriced: 1 } })?.listUsd, undefined);
  assert.equal(sessionCostOf({ ...subscription, coverage: "partial" })?.listUsd, undefined);
  assert.equal(sessionCostOf({ ...subscription, messages: 0 })?.listUsd, undefined);
});

const NOW = "2026-11-15T12:00:00.000Z";
const PRICES: NonNullable<Config["usage"]>["prices"] = {
  "deepseek/deepseek-flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  "anthropic/claude-sonnet": { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
};

function usageRecord(over: Partial<UsageRecord>): UsageRecord {
  return {
    provider: "opencode",
    providerId: "deepseek",
    modelId: "deepseek-flash",
    messageId: "msg-1",
    partId: "part-1",
    modelSource: "reported",
    completedAt: "2026-11-15T11:30:00.000Z",
    tokens: { input: 1_000_000, output: 100_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    reportedCost: 0,
    ...over,
  };
}

function sampleOutcome(over: Partial<OutcomeRow> = {}): OutcomeRow {
  const payload: OutcomePayload = {
    projectId: "example",
    taskId: "task-1",
    area: "core",
    featureMap: "default",
    rounds: { run: 1, attributed: 1, unknown: 0 },
    limitEvents: 0,
    costCoverage: "none",
    ...(over.payload ?? {}),
  };
  return {
    outcomeId: "run-1:m1",
    source: "production",
    projectRef: "",
    taskRef: "",
    areaRef: "",
    runId: "run-1",
    revision: 1,
    memberId: "m1",
    sessionId: "sess-1",
    attemptIndex: 1,
    inherited: false,
    role: "implementer",
    profileId: "impl-a",
    provider: "opencode",
    model: "deepseek/deepseek-flash",
    effort: null,
    profileEpoch: 1,
    configId: null,
    experimentRef: null,
    kind: null,
    risk: "normal",
    featureVersion: 1,
    disposition: "integrated",
    exclusion: null,
    flags: [],
    integrated: 1,
    accepted: 1,
    acceptance: 1,
    firstPass: 1,
    held: 1,
    startedAt: "2026-11-15T11:00:00.000Z",
    endedAt: "2026-11-15T11:45:00.000Z",
    frozenAt: "2026-11-15T11:45:00.000Z",
    holdUntil: null,
    runDeletedAt: null,
    ...over,
    payload,
  };
}

test("computeOutcomeCost and syncOutcomeCosts persist listUsd for complete priced usage and keep partial or unpriced null", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-outcome-cost-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(usageModule);

    store.write(tx => {
      writeSession(tx, {
        sessionId: "sess-metered",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-1", memberId: "m1", taskId: "task-1", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "sess-metered", usageRecord({}));

      writeSession(tx, {
        sessionId: "sess-sub",
        provider: "claude",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-2", memberId: "m1", taskId: "task-2", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "sess-sub", usageRecord({
        provider: "claude",
        providerId: "anthropic",
        modelId: "claude-sonnet",
        tokens: { input: 200_000, output: 100_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }));

      writeSession(tx, {
        sessionId: "sess-partial",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-3", memberId: "m1", taskId: "task-3", role: "implementer", revision: 1 },
      }, { coverage: "partial", reason: "running", cursor: 1, seen: 1, refused: 0, exited: false });
      writeRecord(tx, "sess-partial", usageRecord({}));

      writeSession(tx, {
        sessionId: "sess-unpriced",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-4", memberId: "m1", taskId: "task-4", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "sess-unpriced", usageRecord({ modelId: "unknown-model", reportedCost: 0 }));

      writeOutcome(tx, sampleOutcome({ outcomeId: "run-1:m1", runId: "run-1", sessionId: "sess-metered", provider: "opencode" }));
      writeOutcome(tx, sampleOutcome({ outcomeId: "run-2:m1", runId: "run-2", sessionId: "sess-sub", provider: "claude", model: "claude-sonnet" }));
      writeOutcome(tx, sampleOutcome({ outcomeId: "run-3:m1", runId: "run-3", sessionId: "sess-partial", provider: "opencode" }));
      writeOutcome(tx, sampleOutcome({ outcomeId: "run-4:m1", runId: "run-4", sessionId: "sess-unpriced", provider: "opencode" }));
    });

    assert.deepEqual(
      store.read(db => computeOutcomeCost(db, { runId: "run-1", memberId: "m1", sessionId: "sess-metered", provider: "opencode" }, PRICES)),
      { costCoverage: "complete", tokens: 1_100_000, listUsd: 1.2, spentUsd: 1.2 },
    );
    assert.deepEqual(
      store.read(db => computeOutcomeCost(db, { runId: "run-2", memberId: "m1", sessionId: "sess-sub", provider: "claude" }, PRICES)),
      { costCoverage: "complete", tokens: 300_000, listUsd: 2.1 },
    );
    assert.deepEqual(
      store.read(db => computeOutcomeCost(db, { runId: "run-3", memberId: "m1", sessionId: "sess-partial", provider: "opencode" }, PRICES)),
      { costCoverage: "partial" },
    );
    assert.deepEqual(
      store.read(db => computeOutcomeCost(db, { runId: "run-4", memberId: "m1", sessionId: "sess-unpriced", provider: "opencode" }, PRICES)),
      { costCoverage: "partial", tokens: 1_100_000 },
    );

    assert.deepEqual(syncOutcomeCosts(store, PRICES), { updated: 4, scanned: 4, done: true });
    const updated = store.read(db => ({
      metered: readOutcome(db, "run-1:m1"),
      sub: readOutcome(db, "run-2:m1"),
      partial: readOutcome(db, "run-3:m1"),
      unpriced: readOutcome(db, "run-4:m1"),
      meteredEvidence: selectRoutingEvidence(db, { provider: "opencode", model: "deepseek/deepseek-flash", effort: null }, "start", "2026-11-01T00:00:00.000Z"),
      subEvidence: selectRoutingEvidence(db, { provider: "claude", model: "claude-sonnet", effort: null }, "start", "2026-11-01T00:00:00.000Z"),
    }));
    assert.equal(updated.metered?.payload.costCoverage, "complete");
    assert.equal(updated.metered?.payload.listUsd, 1.2);
    assert.equal(updated.metered?.payload.spentUsd, 1.2);
    assert.equal(updated.sub?.payload.costCoverage, "complete");
    assert.equal(updated.sub?.payload.listUsd, 2.1);
    assert.equal(updated.sub?.payload.spentUsd, undefined);
    assert.equal(updated.partial?.payload.costCoverage, "partial");
    assert.equal(updated.partial?.payload.listUsd, undefined);
    assert.equal(updated.unpriced?.payload.costCoverage, "partial");
    assert.equal(updated.unpriced?.payload.listUsd, undefined);

    const byId = new Map(updated.meteredEvidence.map(row => [row.outcomeId, row.listUsd]));
    assert.equal(byId.get("run-1:m1"), 1.2);
    assert.equal(byId.get("run-3:m1"), null);
    assert.equal(byId.get("run-4:m1"), null);
    assert.equal(updated.subEvidence[0]?.listUsd, 2.1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outcomeProjector and UsageService.tick populate outcomes.list_usd in either order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-outcome-tick-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    const eventsBySession: Record<string, { seq: number; type: string; at: string; data: Record<string, unknown> }[]> = {
      "sess-live": [
        {
          seq: 1,
          type: "usage",
          at: "2026-11-15T11:10:00.000Z",
          data: {
            kind: "usage",
            provider: "opencode",
            providerId: "deepseek",
            modelId: "deepseek-flash",
            messageId: "m-1",
            partId: "p-1",
            modelSource: "reported",
            completedAt: "2026-11-15T11:10:00.000Z",
            tokens: { input: 500_000, output: 250_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            reportedCost: 0,
          },
        },
      ],
    };
    const rows: UsageSessionRow[] = [
      {
        id: "sess-live",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        lastActiveAt: "2026-11-15T11:15:00.000Z",
        status: "exited",
        measured: true,
        teamModelProfile: { id: "impl-a", label: "Impl A", provider: "opencode", model: "deepseek/deepseek-flash" },
        team: { runId: "run-live", memberId: "m1", taskId: "task-live", role: "implementer", revision: 1 },
      } as unknown as UsageSessionRow,
    ];
    const manager = {
      list: async () => rows,
      events: (id: string, after: number) => {
        const list = (eventsBySession[id] ?? []).filter(entry => entry.seq > after);
        return { events: list, cursor: list.at(-1)?.seq ?? after, more: false };
      },
    } as unknown as Manager;
    const config = { stateDir: dir, usage: { prices: PRICES, accounts: {} } } as unknown as Config;
    const usage = new UsageService(config, key, manager, store);
    const outbox = new EventOutbox(store);
    outbox.registerProjector(configurationProjector());
    outbox.registerProjector(outcomeProjector(store, { prices: PRICES }));

    const base = "a".repeat(40);
    const commit = "b".repeat(40);
    const ev = (kind: string, n: number, at: string, extra: Partial<OutboxEvent> = {}): OutboxEvent => ({
      key: runEventKey(kind, "run-live", [n]),
      runId: "run-live",
      revision: 1,
      at,
      kind,
      data: { v: 1, ...(extra.data ?? {}) },
      ...(extra.memberId ? { memberId: extra.memberId } : {}),
      ...(extra.taskId ? { taskId: extra.taskId } : {}),
    });
    outbox.flush([
      ev("run.created", 1, "2026-11-15T11:00:00.000Z", { data: { projectId: "example", purpose: "work" } }),
      ev("run.prepared", 2, "2026-11-15T11:00:00.000Z", { data: { baseCommit: base } }),
      ev("task.planned", 3, "2026-11-15T11:01:00.000Z", {
        taskId: "task-live",
        data: { profileId: "impl-a", paths: ["src/a.ts"], features: { role: "implementer", area: "core", kind: null, risk: "normal", featureVersion: 1, featureMap: "default" } },
      }),
      ev("member.started", 4, "2026-11-15T11:02:00.000Z", {
        memberId: "m1",
        taskId: "task-live",
        data: { role: "implementer", purpose: "work", sessionId: "sess-live", startedAt: "2026-11-15T11:02:00.000Z", baseCommit: base, provider: "opencode", profileId: "impl-a", model: "deepseek/deepseek-flash" },
      }),
      ev("task.integrated", 5, "2026-11-15T11:15:00.000Z", {
        memberId: "m1",
        taskId: "task-live",
        data: { commit, role: "implementer" },
      }),
    ]);

    assert.equal(store.read(db => readOutcome(db, "run-live:m1")?.payload.listUsd), undefined);
    await usage.tick();

    const afterTick = store.read(db => ({
      row: readOutcome(db, "run-live:m1"),
      evidence: selectRoutingEvidence(db, { provider: "opencode", model: "deepseek/deepseek-flash", effort: null }, "start", "2026-11-01T00:00:00.000Z"),
    }));
    assert.equal(afterTick.row?.payload.costCoverage, "complete");
    assert.equal(afterTick.row?.payload.listUsd, 1);
    assert.equal(afterTick.row?.payload.spentUsd, 1);
    assert.equal(afterTick.evidence[0]?.listUsd, 1);
    assert.equal(usage.session("sess-live").measured, true);
    const liveSession = usage.session("sess-live");
    assert.equal(liveSession.measured && liveSession.list?.usd, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outcomeModule v4 to v5 migration backfills list_usd from complete payloads only", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-outcome-v5-"));
  const key = randomBytes(32);
  const path = evidenceDatabasePath(dir);
  const v4: EvidenceModule = {
    name: "outcomes",
    version: 4,
    readVersion: 2,
    migrate(tx) {
      tx.exec(
        "CREATE TABLE outcomes ("
        + "outcome_id TEXT PRIMARY KEY, source TEXT NOT NULL, project_ref TEXT NOT NULL, task_ref TEXT NOT NULL, "
        + "run_id TEXT NOT NULL, revision INTEGER NOT NULL, member_id TEXT NOT NULL, session_id TEXT, "
        + "attempt_index INTEGER NOT NULL, inherited INTEGER NOT NULL, role TEXT NOT NULL, profile_id TEXT NOT NULL, "
        + "provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, profile_epoch INTEGER NOT NULL, config_id TEXT, "
        + "experiment_ref TEXT, area_ref TEXT NOT NULL, kind TEXT, risk TEXT NOT NULL, feature_version INTEGER NOT NULL, "
        + "disposition TEXT NOT NULL, exclusion TEXT, flags TEXT NOT NULL, integrated INTEGER, accepted INTEGER, "
        + "acceptance REAL, first_pass INTEGER, held INTEGER, started_at TEXT, ended_at TEXT, frozen_at TEXT, "
        + "hold_until TEXT, run_deleted_at TEXT, payload TEXT NOT NULL, goal_ref TEXT, mission_ref TEXT, "
        + "point TEXT, feature_map_ref TEXT, owner_score INTEGER)",
      );
      tx.exec("CREATE TABLE run_summaries (run_id TEXT PRIMARY KEY, source TEXT NOT NULL, project_ref TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT, block_code TEXT, flags TEXT NOT NULL, created_at TEXT, settled_at TEXT, approved_at TEXT, run_deleted_at TEXT, payload TEXT NOT NULL, goal_ref TEXT, mission_ref TEXT)");
      tx.exec("CREATE TABLE member_results (result_id TEXT PRIMARY KEY, source TEXT NOT NULL, project_ref TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, member_id TEXT NOT NULL, session_id TEXT, role TEXT NOT NULL, profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, profile_epoch INTEGER NOT NULL, config_id TEXT, report_kind TEXT, disposition TEXT NOT NULL, flags TEXT NOT NULL, started_at TEXT, ended_at TEXT, run_deleted_at TEXT, payload TEXT NOT NULL)");
      tx.exec("CREATE TABLE signals (signal_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, outcome_id TEXT, kind TEXT NOT NULL, author TEXT NOT NULL, authority TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL)");
      tx.exec("CREATE TABLE landing_scans (project_ref TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, checked_at TEXT NOT NULL, commits INTEGER NOT NULL, gap TEXT, payload TEXT NOT NULL, PRIMARY KEY (project_ref, seq))");
      tx.exec("CREATE TABLE landing_state (project_ref TEXT PRIMARY KEY, seq INTEGER NOT NULL, payload TEXT NOT NULL)");
      tx.exec("CREATE TABLE outcome_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      tx.exec("CREATE TABLE legacy_lines (file_key TEXT NOT NULL, line_number INTEGER NOT NULL, state TEXT NOT NULL, line_hash TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY (file_key, line_number))");
      tx.exec("CREATE INDEX outcomes_by_route ON outcomes (source, role, point, provider, model, effort, ended_at, outcome_id)");
    },
  };
  let store: EvidenceStore | undefined;
  try {
    store = new EvidenceStore({ databasePath: path, vaultKey: key });
    store.register(v4);
    const basePayload: OutcomePayload = {
      projectId: "example", taskId: "t1", area: "core", featureMap: "default",
      rounds: { run: 1, attributed: 1, unknown: 0 }, limitEvents: 0, costCoverage: "complete", listUsd: 0.65,
    };
    const insert = (id: string, sealed: string) => {
      store!.write(tx => {
        tx.run(
          "INSERT INTO outcomes (outcome_id, source, project_ref, task_ref, run_id, revision, member_id, session_id, "
          + "attempt_index, inherited, role, profile_id, provider, model, effort, profile_epoch, config_id, experiment_ref, "
          + "area_ref, kind, risk, feature_version, disposition, exclusion, flags, integrated, accepted, acceptance, "
          + "first_pass, held, started_at, ended_at, frozen_at, hold_until, run_deleted_at, payload, goal_ref, mission_ref, "
          + "point, feature_map_ref, owner_score) VALUES (?, 'production', 'p', 't', ?, 1, 'm1', NULL, 1, 0, 'implementer', "
          + "'impl', 'codex', 'm-1', 'high', 1, NULL, NULL, 'a', NULL, 'normal', 1, 'integrated', NULL, '[]', 1, 1, 1, 1, 1, "
          + "?, ?, ?, NULL, NULL, ?, NULL, NULL, 'start', 'fm', NULL)",
          id, id.split(":")[0]!, NOW, NOW, NOW, sealed,
        );
      });
    };
    store.write(tx => {
      tx.run(
        "INSERT INTO outcomes (outcome_id, source, project_ref, task_ref, run_id, revision, member_id, session_id, "
        + "attempt_index, inherited, role, profile_id, provider, model, effort, profile_epoch, config_id, experiment_ref, "
        + "area_ref, kind, risk, feature_version, disposition, exclusion, flags, integrated, accepted, acceptance, "
        + "first_pass, held, started_at, ended_at, frozen_at, hold_until, run_deleted_at, payload, goal_ref, mission_ref, "
        + "point, feature_map_ref, owner_score) VALUES (?, 'production', 'p', 't', 'r1', 1, 'm1', NULL, 1, 0, 'implementer', "
        + "'impl', 'codex', 'm-1', 'high', 1, NULL, NULL, 'a', NULL, 'normal', 1, 'integrated', NULL, '[]', 1, 1, 1, 1, 1, "
        + "?, ?, ?, NULL, NULL, ?, NULL, NULL, 'start', 'fm', NULL)",
        "r1:m1", NOW, NOW, NOW, tx.seal("outcomes", "r1:m1", basePayload),
      );
      tx.run(
        "INSERT INTO outcomes (outcome_id, source, project_ref, task_ref, run_id, revision, member_id, session_id, "
        + "attempt_index, inherited, role, profile_id, provider, model, effort, profile_epoch, config_id, experiment_ref, "
        + "area_ref, kind, risk, feature_version, disposition, exclusion, flags, integrated, accepted, acceptance, "
        + "first_pass, held, started_at, ended_at, frozen_at, hold_until, run_deleted_at, payload, goal_ref, mission_ref, "
        + "point, feature_map_ref, owner_score) VALUES (?, 'production', 'p', 't', 'r2', 1, 'm1', NULL, 1, 0, 'implementer', "
        + "'impl', 'codex', 'm-1', 'high', 1, NULL, NULL, 'a', NULL, 'normal', 1, 'integrated', NULL, '[]', 1, 1, 1, 1, 1, "
        + "?, ?, ?, NULL, NULL, ?, NULL, NULL, 'start', 'fm', NULL)",
        "r2:m1", NOW, NOW, NOW, tx.seal("outcomes", "r2:m1", { ...basePayload, costCoverage: "partial", listUsd: 9.99 }),
      );
    });
    insert("r3:m1", "unreadable");
    store.close();

    store = new EvidenceStore({ databasePath: path, vaultKey: key });
    store.register(outcomeModule({ now: () => NOW }));
    assert.equal(store.status().modules.outcomes, "ready");
    const migrated = store.read(db => Object.fromEntries(
      db.all<{ outcome_id: string; list_usd: number | null }>("SELECT outcome_id, list_usd FROM outcomes ORDER BY outcome_id")
        .map(item => [item.outcome_id, item.list_usd]),
    ));
    assert.deepEqual(migrated, { "r1:m1": 0.65, "r2:m1": null, "r3:m1": null });
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider-reported spend is never promoted to listUsd, and mixed-coverage multi-session attempts stay partial", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-outcome-cost-distinction-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    const usage = new UsageService({ stateDir: dir, usage: { prices: PRICES, accounts: {} } } as unknown as Config, key, {} as Manager, store);

    store.write(tx => {
      writeSession(tx, {
        sessionId: "sess-reported",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-rep", memberId: "m1", taskId: "t-rep", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "sess-reported", usageRecord({ modelId: "unlisted-model", reportedCost: 0.75 }));

      writeSession(tx, {
        sessionId: "sess-multi-a",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-multi", memberId: "m1", taskId: "t-multi", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "sess-multi-a", usageRecord({}));
      writeSession(tx, {
        sessionId: "sess-multi-b",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:05:00.000Z",
        team: { runId: "run-multi", memberId: "m1", taskId: "t-multi", role: "implementer", revision: 1 },
      }, { coverage: "none", reason: "unsupported", cursor: 0, seen: 0, refused: 0, exited: true });

      writeOutcome(tx, sampleOutcome({ outcomeId: "run-rep:m1", runId: "run-rep", sessionId: "sess-reported", provider: "opencode" }));
      writeOutcome(tx, sampleOutcome({ outcomeId: "run-multi:m1", runId: "run-multi", sessionId: "sess-multi-a", provider: "opencode" }));
    });

    assert.deepEqual(
      store.read(db => computeOutcomeCost(db, { runId: "run-rep", memberId: "m1", sessionId: "sess-reported", provider: "opencode" }, PRICES)),
      { costCoverage: "partial", tokens: 1_100_000, spentUsd: 0.75 },
    );
    assert.deepEqual(
      store.read(db => computeOutcomeCost(db, { runId: "run-multi", memberId: "m1", sessionId: "sess-multi-a", provider: "opencode" }, PRICES)),
      { costCoverage: "partial" },
    );

    assert.deepEqual(syncOutcomeCosts(store, PRICES), { updated: 2, scanned: 2, done: true });
    const rows = store.read(db => ({
      rep: readOutcome(db, "run-rep:m1"),
      multi: readOutcome(db, "run-multi:m1"),
      sql: Object.fromEntries(db.all<{ outcome_id: string; list_usd: number | null }>("SELECT outcome_id, list_usd FROM outcomes").map(r => [r.outcome_id, r.list_usd])),
    }));
    assert.equal(rows.rep?.payload.costCoverage, "partial");
    assert.equal(rows.rep?.payload.listUsd, undefined);
    assert.equal(rows.rep?.payload.spentUsd, 0.75);
    assert.equal(rows.multi?.payload.costCoverage, "partial");
    assert.equal(rows.multi?.payload.listUsd, undefined);
    assert.deepEqual(rows.sql, { "run-rep:m1": null, "run-multi:m1": null });

    const session = usage.session("sess-reported");
    assert.equal(session.measured, true);
    if (session.measured) {
      assert.equal(session.cost, 0.75);
      assert.equal(session.pricing.provider, 1);
      assert.deepEqual(session.list, { usd: 0, unpriced: 1 });
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaying an enlarged usage record refreshes the original owner's already-costed outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-outcome-replay-owner-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    const eventsBySession: Record<string, { seq: number; type: string; at: string; data: Record<string, unknown> }[]> = {
      "sess-orig": [
        {
          seq: 1,
          type: "usage",
          at: "2026-11-15T11:10:00.000Z",
          data: {
            kind: "usage",
            provider: "claude",
            providerId: "anthropic",
            modelId: "claude-sonnet",
            messageId: "shared-msg",
            partId: "p1",
            modelSource: "reported",
            completedAt: "2026-11-15T11:10:00.000Z",
            tokens: { input: 500_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            reportedCost: 0,
          },
        },
        {
          seq: 2,
          type: "usage-coverage",
          at: "2026-11-15T11:11:00.000Z",
          data: { coverage: "complete", finalDrain: "complete" },
        },
      ],
      "sess-replay": [],
    };
    const listed: UsageSessionRow[] = [
      {
        id: "sess-orig",
        provider: "claude",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        lastActiveAt: "2026-11-15T11:11:00.000Z",
        status: "exited",
        team: { runId: "run-orig", memberId: "m1", taskId: "t-orig", role: "implementer", revision: 1 },
      } as unknown as UsageSessionRow,
    ];
    const manager = {
      list: async () => listed,
      events: (id: string, after: number) => {
        const list = (eventsBySession[id] ?? []).filter(entry => entry.seq > after);
        return { events: list, cursor: list.at(-1)?.seq ?? after, more: false };
      },
    } as unknown as Manager;
    const usage = new UsageService({ stateDir: dir, usage: { prices: PRICES, accounts: {} } } as unknown as Config, key, manager, store);

    store.write(tx => {
      writeOutcome(tx, sampleOutcome({ outcomeId: "run-orig:m1", runId: "run-orig", sessionId: "sess-orig", provider: "claude", model: "claude-sonnet" }));
    });
    await usage.tick();
    assert.equal(store.read(db => readOutcome(db, "run-orig:m1")?.payload.listUsd), 1.5);

    eventsBySession["sess-replay"] = [
      {
        seq: 1,
        type: "usage",
        at: "2026-11-15T11:20:00.000Z",
        data: {
          kind: "usage",
          provider: "claude",
          providerId: "anthropic",
          modelId: "claude-sonnet",
          messageId: "shared-msg",
          partId: "p1",
          modelSource: "reported",
          completedAt: "2026-11-15T11:10:00.000Z",
          tokens: { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          reportedCost: 0,
        },
      },
      {
        seq: 2,
        type: "usage-coverage",
        at: "2026-11-15T11:21:00.000Z",
        data: { coverage: "complete", finalDrain: "complete" },
      },
    ];
    listed.push({
      id: "sess-replay",
      provider: "claude",
      projectId: "example",
      createdAt: "2026-11-15T11:15:00.000Z",
      lastActiveAt: "2026-11-15T11:21:00.000Z",
      status: "exited",
      team: { runId: "run-replay", memberId: "m1", taskId: "t-replay", role: "implementer", revision: 1 },
    } as unknown as UsageSessionRow);

    await usage.tick();
    assert.equal(store.read(db => readOutcome(db, "run-orig:m1")?.payload.listUsd), 3);
    assert.equal(
      store.read(db => db.get<{ list_usd: number | null }>("SELECT list_usd FROM outcomes WHERE outcome_id='run-orig:m1'")?.list_usd),
      3,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncOutcomeCosts pages past unpriceable rows across batches and restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-outcome-cost-paging-"));
  const key = randomBytes(32);
  const path = evidenceDatabasePath(dir);
  let store: EvidenceStore | undefined;
  try {
    store = new EvidenceStore({ databasePath: path, vaultKey: key });
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(usageModule);

    store.write(tx => {
      for (const id of ["run-1", "run-2", "run-3"]) {
        writeOutcome(tx, sampleOutcome({ outcomeId: `${id}:m1`, runId: id, sessionId: `missing-${id}` }));
      }
      writeSession(tx, {
        sessionId: "sess-4",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-4", memberId: "m1", taskId: "task-4", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "sess-4", usageRecord({}));
      writeOutcome(tx, sampleOutcome({ outcomeId: "run-4:m1", runId: "run-4", sessionId: "sess-4" }));
    });

    assert.deepEqual(syncOutcomeCosts(store, PRICES, { limit: 2 }), { updated: 0, scanned: 2, done: false });
    assert.equal(store.read(db => readOutcome(db, "run-4:m1")?.payload.listUsd), undefined);

    store.close();
    store = new EvidenceStore({ databasePath: path, vaultKey: key });
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(usageModule);

    assert.deepEqual(syncOutcomeCosts(store, PRICES, { limit: 2 }), { updated: 1, scanned: 2, done: false });
    assert.equal(store.read(db => readOutcome(db, "run-4:m1")?.payload.listUsd), 1.2);
    assert.deepEqual(syncOutcomeCosts(store, PRICES, { limit: 2 }), { updated: 0, scanned: 0, done: true });
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undrained running sessions stay partial until exited and Codex cacheWrite leaves listUsd null", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-outcome-drain-codex-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(usageModule);

    const prices = {
      ...PRICES,
      "openai/gpt-5.4": { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
    };
    store.write(tx => {
      writeSession(tx, {
        sessionId: "sess-undrained",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-drain", memberId: "m1", taskId: "t-drain", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: false });
      writeRecord(tx, "sess-undrained", usageRecord({}));
      writeOutcome(tx, sampleOutcome({ outcomeId: "run-drain:m1", runId: "run-drain", sessionId: "sess-undrained", provider: "opencode" }));

      writeSession(tx, {
        sessionId: "sess-codex-cw",
        provider: "codex",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-cw", memberId: "m1", taskId: "t-cw", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
      writeRecord(tx, "sess-codex-cw", usageRecord({
        provider: "codex",
        providerId: "openai",
        modelId: "gpt-5.4",
        tokens: { input: 500_000, output: 100_000, reasoning: 0, cacheRead: 0, cacheWrite: 10_000 },
        reportedCost: 0,
      }));
      writeOutcome(tx, sampleOutcome({ outcomeId: "run-cw:m1", runId: "run-cw", sessionId: "sess-codex-cw", provider: "codex", model: "gpt-5.4" }));
    });

    assert.deepEqual(
      store.read(db => computeOutcomeCost(db, { runId: "run-drain", memberId: "m1", sessionId: "sess-undrained", provider: "opencode" }, prices)),
      { costCoverage: "partial" },
    );
    assert.deepEqual(
      store.read(db => computeOutcomeCost(db, { runId: "run-cw", memberId: "m1", sessionId: "sess-codex-cw", provider: "codex" }, prices)),
      { costCoverage: "partial", tokens: 610_000 },
    );
    assert.deepEqual(syncOutcomeCosts(store, prices), { updated: 2, scanned: 2, done: true });
    assert.deepEqual(
      store.read(db => db.all<{ outcome_id: string; list_usd: number | null }>("SELECT outcome_id, list_usd FROM outcomes ORDER BY outcome_id").map(r => [r.outcome_id, r.list_usd])),
      [["run-cw:m1", null], ["run-drain:m1", null]],
    );

    store.write(tx => {
      writeSession(tx, {
        sessionId: "sess-undrained",
        provider: "opencode",
        projectId: "example",
        createdAt: "2026-11-15T11:00:00.000Z",
        team: { runId: "run-drain", memberId: "m1", taskId: "t-drain", role: "implementer", revision: 1 },
      }, { coverage: "complete", cursor: 1, seen: 1, refused: 0, exited: true });
    });
    assert.deepEqual(syncOutcomeCosts(store, prices, { reset: true }), { updated: 1, scanned: 2, done: true });
    const afterDrain = store.read(db => readOutcome(db, "run-drain:m1"));
    assert.equal(afterDrain?.payload.costCoverage, "complete");
    assert.equal(afterDrain?.payload.listUsd, 1.2);
    assert.equal(afterDrain?.payload.spentUsd, 1.2);
    assert.equal(afterDrain?.payload.tokens, 1_100_000);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
