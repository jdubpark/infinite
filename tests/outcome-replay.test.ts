import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configId } from "../packages/host/src/config-identity.js";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { applyCheck, applyScan } from "../packages/host/src/outcome-signals.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import {
  outcomeModule,
  readMemberResult,
  readOutcome,
  readScanState,
  readSummary,
  selectOutcomes,
  selectRoutingEvidence,
} from "../packages/host/src/outcome-store.js";
import { runEventKey } from "../packages/host/src/run-events.js";

const PROJECT = "example";
const REPO = "example-repo";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const COMMIT = "c".repeat(40);
const MERGE = "m".repeat(40);
const SCAN_HEAD = "5".repeat(40);
const HEX_A = "a".repeat(64);
const HEX_B = "e".repeat(64);
const DIFF = { added: 3, removed: 1, files: 1, docs: false, tests: true };
const FEATURES = { role: "implementer", area: "core", kind: null, risk: "normal", featureVersion: 1, featureMap: "default" };
const SINCE = "2026-11-13T00:00:00.000Z";
const PROFILE = { provider: "claude", model: "m-1", effort: null };

const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;

type Harness = {
  store: EvidenceStore;
  outbox: EventOutbox;
  flush(events: readonly OutboxEvent[]): void;
  close(): void;
};

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "infinite-outcome-replay-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => at(59) }));
  const outbox = new EventOutbox(store);
  outbox.registerProjector(configurationProjector());
  outbox.registerProjector(outcomeProjector(store));
  return {
    store,
    outbox,
    flush(events) {
      const result = outbox.flush(events);
      assert.equal(result.stored, true);
      assert.equal(result.refused, 0);
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let counter = 0;

function ev(kind: string, runId: string, time: string, fields: {
  revision?: number; memberId?: string; taskId?: string; data?: Record<string, unknown>; parts?: (string | number)[];
} = {}): OutboxEvent {
  counter += 1;
  return {
    key: runEventKey(kind, runId, [counter, ...(fields.parts ?? [])]),
    runId,
    revision: fields.revision ?? 1,
    at: time,
    kind,
    ...(fields.memberId === undefined ? {} : { memberId: fields.memberId }),
    ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
    data: { v: 1, ...(fields.data ?? {}) },
  };
}

function runEvents(runId: string, purpose: "work" | "replay" | "gate", trialId?: string): OutboxEvent[] {
  const shape = purpose === "work" ? "team" : "trial";
  const components = { profile: PROFILE, promptVersion: HEX_A, guidance: HEX_B, knowledge: "none" as const, routing: "off" as const, shape };
  return [
    ev("run.created", runId, at(0), { data: { projectId: PROJECT, purpose, ...(trialId === undefined ? {} : { trialId }) } }),
    ev("run.prepared", runId, at(0), { data: { baseCommit: BASE } }),
    ev("task.planned", runId, at(1), { taskId: "a", revision: 1, data: { profileId: "impl", paths: ["a.txt"], features: FEATURES } }),
    ev("member.started", runId, at(2), {
      memberId: "m1", taskId: "a", revision: 1,
      data: {
        role: "implementer", purpose, sessionId: `session-${runId}`, startedAt: at(2), baseCommit: BASE,
        provider: "claude", profileId: "profile-m-1", model: "m-1",
      },
    }),
    ev("member.configured", runId, at(3), {
      memberId: "m1", taskId: "a",
      data: { configId: configId(components), provider: "claude", model: "m-1", promptVersion: HEX_A, guidance: HEX_B, knowledge: "none", routing: "off", shape },
    }),
    ev("member.reported", runId, at(4), { memberId: "m1", taskId: "a", data: { role: "implementer", reportKind: "result" } }),
    ev("task.integrated", runId, at(5), {
      memberId: "m1", taskId: "a",
      data: { commit: COMMIT, headCommit: HEAD, baseCommit: BASE, memberBaseCommit: BASE, diff: DIFF },
    }),
    ev("review.recorded", runId, at(6), {
      memberId: "reviewer-1",
      data: { verdict: "approved", headCommit: HEAD, baseCommit: BASE, reviewer: { provider: "claude", profileId: "rev", model: "r-1" } },
    }),
    ev("run.settled", runId, at(7), { parts: ["ready-for-review"], data: { status: "ready-for-review", summary: {
      tasks: 1, integrated: 1, members: 1, round: 1, checks: 0, recoveries: 0, decisionsByOwner: 0,
      decisionsByCoordinator: 0, steering: 0, permissionEscalations: 0, continuations: 0,
    } } }),
  ];
}

function land(h: Harness, runId: string): void {
  const result = h.store.write(tx => applyScan(tx, {
    projectId: PROJECT, repository: REPO, baseBranch: "main", head: SCAN_HEAD, commits: 1, gap: null,
    expectedSeq: readScanState(tx, tx.index("project", PROJECT))?.seq ?? 0,
    landings: [{ runId, commit: MERGE, method: "merge-commit", position: 0 }], reverts: [], holdDays: 30, at: at(8),
  }));
  assert.equal(result.applied, true);
}

function reviewerStart(runId: string): OutboxEvent {
  return ev("member.started", runId, at(3), {
    memberId: "rv1", taskId: "a",
    data: { role: "reviewer", purpose: "work", sessionId: `review-${runId}`, startedAt: at(3), provider: "claude", profileId: "rev", model: "r-1" },
  });
}

function closeWindow(h: Harness): void {
  const result = h.store.write(tx => applyCheck(tx, {
    projectId: PROJECT, head: SCAN_HEAD, at: "2026-12-13T10:09:00.000Z",
    expectedSeq: readScanState(tx, tx.index("project", PROJECT))?.seq ?? 0,
  }));
  assert.equal(result.applied, true);
}

function rowOf(store: EvidenceStore, runId: string) {
  return store.read(db => readOutcome(db, `${runId}:m1`));
}

test("a replay run writes replay rows", () => {
  const h = harness();
  try {
    h.flush([...runEvents("run-replay", "replay", "trial-1"), reviewerStart("run-replay")]);
    const summary = h.store.read(db => readSummary(db, "run-replay"));
    assert.equal(summary?.source, "replay");
    assert.equal(summary?.payload.trialId, "trial-1");
    const row = rowOf(h.store, "run-replay");
    assert.equal(row?.source, "replay");
    assert.equal(row?.experimentRef, "trial-1");
    assert.equal(row?.integrated, 1);
    assert.equal(row?.accepted, null);
    assert.equal(row?.firstPass, null);
    assert.equal(row?.held, null);
    land(h, "run-replay");
    const landed = rowOf(h.store, "run-replay");
    assert.ok(landed?.holdUntil, "the landing gave the row its window");
    assert.equal(landed?.accepted, null);
    assert.equal(landed?.firstPass, null);
    assert.equal(landed?.held, null);
    closeWindow(h);
    assert.equal(rowOf(h.store, "run-replay")?.held, null);
    assert.equal(rowOf(h.store, "run-replay")?.accepted, null);
    const result = h.store.read(db => readMemberResult(db, "run-replay:rv1"));
    assert.equal(result?.source, "replay");
  } finally {
    h.close();
  }
});

test("a gate run writes replay rows with its trial id", () => {
  const h = harness();
  try {
    h.flush(runEvents("run-gate", "gate", "trial-g"));
    const summary = h.store.read(db => readSummary(db, "run-gate"));
    assert.equal(summary?.source, "replay");
    assert.equal(summary?.payload.trialId, "trial-g");
    const row = rowOf(h.store, "run-gate");
    assert.equal(row?.source, "replay");
    assert.equal(row?.experimentRef, "trial-g");
    assert.equal(row?.accepted, null);
    assert.equal(row?.firstPass, null);
  } finally {
    h.close();
  }
});

test("replay rows never reach routing or the scorecard", () => {
  const h = harness();
  try {
    h.flush([...runEvents("run-prod", "work"), ...runEvents("run-replay", "replay", "trial-1")]);
    const production = h.store.read(db => selectOutcomes(db, { sources: ["production"], role: "implementer" }));
    const productionIds = production.rows.map(row => row.outcomeId);
    assert.ok(productionIds.includes("run-prod:m1"), "the production row is read");
    assert.equal(productionIds.includes("run-replay:m1"), false);
    const routing = h.store.read(db => selectRoutingEvidence(db, PROFILE, "start", SINCE));
    const routed = routing.map(row => row.outcomeId);
    assert.ok(routed.includes("run-prod:m1"), "the production row informs routing");
    assert.equal(routed.includes("run-replay:m1"), false);
  } finally {
    h.close();
  }
});

test("a production run keeps production rows", () => {
  const h = harness();
  try {
    h.flush([...runEvents("run-prod", "work"), reviewerStart("run-prod")]);
    const summary = h.store.read(db => readSummary(db, "run-prod"));
    assert.equal(summary?.source, "production");
    assert.equal(summary?.payload.trialId, undefined);
    const row = rowOf(h.store, "run-prod");
    assert.equal(row?.source, "production");
    assert.equal(row?.experimentRef, null);
    assert.equal(row?.integrated, 1);
    assert.equal(row?.accepted, 1);
    assert.equal(row?.firstPass, 1);
    land(h, "run-prod");
    const landed = rowOf(h.store, "run-prod");
    assert.equal(landed?.accepted, 1);
    assert.equal(landed?.holdUntil !== null, true);
    closeWindow(h);
    assert.equal(rowOf(h.store, "run-prod")?.held, 1);
    assert.equal(h.store.read(db => readMemberResult(db, "run-prod:rv1"))?.source, "production");
  } finally {
    h.close();
  }
});
