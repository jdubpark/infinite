import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptVersion } from "../packages/host/src/config-identity.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeModule, writeOutcome, type OutcomePayload, type OutcomeRow } from "../packages/host/src/outcome-store.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { routingExplain, routingStatus } from "../packages/host/src/routing-reads.js";
import { decisionKey, insertDecision, routingModule } from "../packages/host/src/routing-store.js";
import type { DecisionRow, RoutingPayload } from "../packages/host/src/routing-types.js";
import type { TeamModelProfile, TeamLineup } from "../packages/host/src/team-types.js";
import type { EvidenceStore as Store } from "../packages/host/src/evidence/store.js";
import { mixedLineup } from "./team-fixture.js";

const NOW = "2026-11-15T12:00:00.000Z";
const DAY_MS = 86_400_000;
const daysBefore = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

type Fixture = { root: string; path: string; key: Buffer; close: () => void };
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-reads-"));
  return { root, path: evidenceDatabasePath(join(root, "state")), key: randomBytes(32), close: () => rmSync(root, { recursive: true, force: true }) };
}

function open(f: Fixture): EvidenceStore {
  const store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => NOW }));
  store.register(routingModule());
  return store;
}

type Seed = { runId?: string; taskId?: string; revision?: number; ordinal?: number; projectId?: string; area?: string;
  decidedAt?: string; chosen?: string; coordinator?: string | null; greedy?: string; explore?: boolean };

/** One stored start decision. Its payload names the project, task, area, and feature map it was made for. */
function seed(store: EvidenceStore, spec: Seed): void {
  const runId = spec.runId ?? "run-1", taskId = spec.taskId ?? "task-1", revision = spec.revision ?? 1, ordinal = spec.ordinal ?? 1;
  const projectId = spec.projectId ?? "rehearsal", area = spec.area ?? "host", chosen = spec.chosen ?? "astra-xhigh";
  const payload: RoutingPayload = {
    projectId, taskId, area, featureMap: "default", coordinatorProfileId: spec.coordinator ?? null, knobs: ROUTING_DEFAULTS,
    costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" }, headroom: "not-modelled", chosenWeight: 0.5,
    current: [], candidates: [], elapsedMs: 1,
  };
  store.write(tx => {
    const taskKey = tx.index("task", taskId);
    const row: DecisionRow = {
      key: decisionKey(runId, revision, taskKey, "start", ordinal), runId, revision, taskKey, point: "start", ordinal,
      projectRef: tx.index("project", projectId), role: "implementer", areaRef: tx.index("area", area), kind: "feature",
      risk: "normal", featureVersion: 1, featureMapRef: tx.index("feature-map", "default"), mode: "shadow", algorithmVersion: 1,
      rewardVersion: 1, policyDigest: "d".repeat(64), seed: "s".repeat(64), basis: "sampled", chosenProfileId: chosen,
      chosenIdentity: "i".repeat(64), greedyProfileId: spec.greedy ?? chosen, coordinatorProfileId: spec.coordinator ?? null,
      explore: spec.explore ?? false, state: "recorded", memberId: null, decidedAt: spec.decidedAt ?? NOW,
    };
    insertDecision(tx, row, payload);
  });
}

/** A counting view of the store: every `db.open` the status makes goes through it. */
function counting(store: EvidenceStore): { store: Store; opens: () => number } {
  let opened = 0;
  const wrapped = {
    status: () => store.status(),
    read: <T>(fn: (db: Parameters<Parameters<Store["read"]>[0]>[0]) => T) => store.read(db => fn({
      ...db,
      open: (table: string, rowId: string, sealed: string) => { opened++; return db.open(table, rowId, sealed); },
    })),
  } as unknown as Store;
  return { store: wrapped, opens: () => opened };
}

function statusInput(overrides: Partial<Parameters<typeof routingStatus>[1]> = {}): Parameters<typeof routingStatus>[1] {
  return {
    projectId: "rehearsal", saved: undefined, autonomy: "supervised", lineup: mixedLineup, publishHeads: false, entryTools: false,
    now: NOW, ...overrides,
  };
}

const PAYLOAD_BASE: OutcomePayload = { projectId: "rehearsal", taskId: "task-x", area: "other", featureMap: "default",
  rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none" };

/** A counted implementer row of the start point, ended and integrated at NOW, under a stored configuration. */
function outcome(id: string, profile: TeamModelProfile, configId: string): OutcomeRow {
  const identity = profile.provider === "opencode"
    ? { provider: profile.provider, model: profile.model, effort: profile.variant ?? null }
    : { provider: profile.provider, model: profile.model, effort: profile.effort ?? null };
  return {
    outcomeId: `${id}:m1`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: id, revision: 1,
    memberId: "m1", sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: profile.id,
    provider: identity.provider, model: identity.model!, effort: identity.effort, profileEpoch: 1, configId,
    experimentRef: null, kind: null, risk: "normal", featureVersion: 1, disposition: "completed", exclusion: null, flags: [],
    integrated: 1, accepted: 1, acceptance: 1, firstPass: 1, held: null, startedAt: null, endedAt: NOW, frozenAt: NOW,
    holdUntil: null, runDeletedAt: null, payload: { ...PAYLOAD_BASE, projectId: "rehearsal" },
  };
}

test("status in off mode, without a lineup, and without an eligible profile", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const off = routingStatus(store, statusInput());
    assert.equal(off.mode, "off");
    assert.equal(off.knobs, null);
    assert.equal(off.covers.start, false);
    assert.equal(off.covers.reason, "off");
    assert.deepEqual(off.cells, []);

    const noLineup = routingStatus(store, statusInput({ saved: { mode: "shadow" }, lineup: undefined }));
    assert.equal(noLineup.mode, "shadow");
    assert.equal(noLineup.covers.reason, "no-lineup");

    const contributorsOnly: TeamLineup = { ...mixedLineup, implementers: [mixedLineup.implementers[0]!] };
    const none = routingStatus(store, statusInput({ saved: { mode: "shadow" }, lineup: contributorsOnly }));
    assert.equal(none.covers.reason, "no-eligible-profile");
    assert.equal(none.covers.start, false);
  } finally {
    store?.close();
    f.close();
  }
});

test("status counts shadow agreement and the shadow period", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    seed(store, { taskId: "t1", chosen: "a", coordinator: "a" });
    seed(store, { taskId: "t2", chosen: "a", coordinator: "b" });
    seed(store, { taskId: "t3", chosen: "b", coordinator: null });
    seed(store, { taskId: "t4", chosen: "a", coordinator: "a", decidedAt: daysBefore(31) });
    const status = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    assert.equal(status.shadow.decisions, 3);
    assert.equal(status.shadow.withCoordinator, 2);
    assert.equal(status.shadow.agreements, 1);
    assert.equal(status.period.decisions, 4);
    assert.equal(status.period.firstAt, daysBefore(31));
    assert.equal(status.period.targetDays, 14);
    assert.equal(status.period.targetDecisions, 50);

    for (let index = 0; index < 51; index++) seed(store, { projectId: "bulk", taskId: `bulk-${index}`, area: `bulk-${index}` });
    const bulk = routingStatus(store, statusInput({ projectId: "bulk", saved: { mode: "shadow" } }));
    assert.equal(bulk.period.decisions, 50);
    assert.equal(bulk.period.capped, true);
  } finally {
    store?.close();
    f.close();
  }
});

test("status cells come from recorded decisions, at most 50, then the new task line", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    for (let index = 0; index < 51; index++) {
      seed(store, { taskId: `task-${index}`, area: `area-${String(index).padStart(2, "0")}`, decidedAt: new Date(Date.parse(NOW) - index * 60_000).toISOString() });
    }
    const counter = counting(store);
    const status = routingStatus(counter.store, statusInput({ saved: { mode: "shadow" } }));
    assert.equal(status.cells.length, 51, "50 cells and the new task line");
    assert.equal(status.cellsCapped, true);
    assert.equal(status.unreadableCells, 0);
    const [first] = status.cells;
    assert.deepEqual(first!.cell, { scope: "cell", area: "area-00", taskKind: "feature", featureVersion: 1, featureMap: "default" });
    const last = status.cells[status.cells.length - 1]!;
    assert.deepEqual(last.cell, { scope: "new-task" });
    assert.ok(counter.opens() > 0 && counter.opens() <= 50, `opened ${counter.opens()} payloads`);

    // No outcome rows: unknown stays unknown. The prior mean shows, the level is none, and no count is a rate.
    for (const profile of last.profiles) {
      assert.equal(profile.mean, 0.5);
      assert.deepEqual(profile.interval, [0.025, 0.975]);
      assert.equal(profile.level, "none");
      assert.deepEqual(profile.rows, { production: 0, duel: 0 });
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("status counts the outcome rows of an OpenCode candidate and the others", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const openCode: TeamModelProfile = { id: "oc-high", label: "OpenCode", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high", tier: "light" };
    const astra = mixedLineup.implementers[1]!;
    const lineup: TeamLineup = { ...mixedLineup, implementers: [openCode, astra] };
    store.write(tx => {
      tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
        + "VALUES ('cfg-oc', 'opencode', 'meta/muse-spark-1.3-contributor', 'high', ?, 'g', 'k', 'r', 's', ?)", promptVersion("implementer", "opencode", openCode, false, false), NOW);
      tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
        + "VALUES ('cfg-astra', 'codex', 'gpt-6-astra', 'xhigh', ?, 'g', 'k', 'r', 's', ?)", promptVersion("implementer", "codex", astra, false, false), NOW);
      for (let index = 0; index < 3; index++) writeOutcome(tx, outcome(`oc-${index}`, openCode, "cfg-oc"));
      for (let index = 0; index < 2; index++) writeOutcome(tx, outcome(`astra-${index}`, astra, "cfg-astra"));
    });
    const status = routingStatus(store, statusInput({ lineup, saved: { mode: "shadow" } }));
    const projectLevel = status.cells[status.cells.length - 1]!;
    assert.deepEqual(projectLevel.cell, { scope: "new-task" });
    const counts = Object.fromEntries(projectLevel.profiles.map(profile => [profile.profileId, profile.rows.production]));
    assert.ok((counts["oc-high"] ?? 0) > 0, "the OpenCode candidate has counted rows");
    assert.equal(counts["oc-high"], 3);
    assert.equal(counts["astra-xhigh"], 2);
    assert.equal(projectLevel.profiles.find(profile => profile.profileId === "oc-high")!.level, "project");
  } finally {
    store?.close();
    f.close();
  }
});

test("explain decodes every decision of a task and hides blind indexes", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    seed(store, { runId: "run-explain", taskId: "task-x", revision: 1, chosen: "first" });
    seed(store, { runId: "run-explain", taskId: "task-x", revision: 2, chosen: "second" });
    seed(store, { runId: "run-explain", taskId: "task-y", revision: 1 });
    store.write(tx => tx.run("UPDATE routing_decisions SET encrypted_payload='not-sealed' WHERE run_id=? AND revision=2", "run-explain"));

    const explained = routingExplain(store, "run-explain", "task-x");
    assert.ok(explained);
    assert.deepEqual(explained.decisions.map(decision => decision.revision), [1, 2]);
    assert.equal(explained.decisions[0]!.chosenProfileId, "first");
    assert.equal(explained.decisions[0]!.payload?.taskId, "task-x");
    assert.equal(explained.decisions[1]!.payload, null, "a damaged payload gives null and the plain row still returns");
    for (const decision of explained.decisions) {
      for (const hidden of ["projectRef", "areaRef", "taskKey", "featureMapRef"]) assert.equal(hidden in decision, false, hidden);
    }
    assert.equal(explained.capped, false);
    assert.equal(routingExplain(store, "run-explain", "task-unknown"), undefined);
  } finally {
    store?.close();
    f.close();
  }
});

test("status and explain throw an unavailable error when the store has no routing module", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
    store.register(configurationModule());
    assert.throws(() => routingStatus(store!, statusInput({ saved: { mode: "shadow" } })), { name: "EvidenceError", code: "unavailable" });
    assert.throws(() => routingExplain(store!, "run-explain", "task-x"), { name: "EvidenceError", code: "unavailable" });
  } finally {
    store?.close();
    f.close();
  }
});

