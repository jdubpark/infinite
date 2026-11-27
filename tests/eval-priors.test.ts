import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { TrialConfiguration } from "../packages/host/src/eval-types.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { evalTrialsModule, type JobTrialRow } from "../packages/host/src/eval-trial-store.js";
import { configRef } from "../packages/host/src/eval-trial-rules.js";
import {
  areaNames,
  priorCells,
  PRIORS_SQL,
  readPriors,
  writePriors,
  type PriorTask,
} from "../packages/host/src/eval-priors.js";

const DAY_MS = 86_400_000;
const NOW = "2026-11-14T12:00:00.000Z";
const PROJECT_ID = "project-priors";
const PROFILE_A = { id: "profile-a", label: "A", provider: "claude", model: "model-a", effort: "high", tier: "strong" } as TeamModelProfile;
const PROFILE_B = { id: "profile-b", label: "B", provider: "codex", model: null, tier: "light" } as unknown as TeamModelProfile;
const CONFIG_A: TrialConfiguration = { profile: PROFILE_A, guidance: "as-of-base", knowledge: "none" };
const CONFIG_B: TrialConfiguration = { profile: PROFILE_B, guidance: "as-of-base", knowledge: "none" };
const CONFIGURATIONS = [CONFIG_A, CONFIG_B];
const REF_A = configRef(CONFIG_A);
const REF_B = configRef(CONFIG_B);
const PROJECT = { id: PROJECT_ID, team: { features: { areas: [{ id: "web" }, { id: "host" }] } } } as never;

function row(taskId: string, configRef: string, patch: Partial<JobTrialRow> = {}): JobTrialRow {
  return {
    taskId, configRef, slot: 0, attempt: 0, state: "final", ending: "graded", resolved: true, isolation: "isolated",
    configId: "cfg", profileEpoch: 1, promptVersion: "pv1", tokens: null, spentUsd: null, cost: null,
    startedAt: NOW, endedAt: NOW, reused: false, ...patch,
  };
}

function task(areaRef: string | null, patch: Partial<PriorTask> = {}): PriorTask {
  return { areaRef, kind: "fix", promptOrigin: "assignment", ...patch };
}

function ready() {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-priors-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, () => NOW));
  store.register(evalTrialsModule(store, () => NOW));
  return { store, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the export counts isolated valid trials by cell", () => {
  const tasks = new Map<string, PriorTask>([
    ["t1", task("area-1")], ["t2", task("area-1")], ["t3", task("area-2")], ["t4", task("area-1", { promptOrigin: null })],
  ]);
  const rows = [
    row("t1", REF_A), row("t1", REF_A, { slot: 1, resolved: false }), row("t2", REF_A, { resolved: false }),
    row("t3", REF_A),
    row("t1", REF_B),
    row("t1", REF_A, { slot: 2, isolation: "none" }),
    row("t2", REF_A, { slot: 1, ending: "void-host" }),
    row("t2", REF_A, { slot: 2, configId: null }),
    row("t4", REF_A),
    row("t1", REF_A, { slot: 3, state: "running" as never }),
    row("t9", REF_A),
  ];
  const cells = priorCells(CONFIGURATIONS, rows, tasks);
  assert.equal(cells.length, 3);
  const a1 = cells.find(c => c.configuration === 0 && c.areaRef === "area-1");
  assert.equal(a1?.tasks, 2);
  assert.equal(a1?.trials, 3);
  assert.equal(a1?.resolved, 1);
  assert.equal(a1?.profileId, "profile-a");
  assert.equal(a1?.model, "model-a");
  const a2 = cells.find(c => c.configuration === 0 && c.areaRef === "area-2");
  assert.equal(a2?.trials, 1);
  const b1 = cells.find(c => c.configuration === 1);
  assert.equal(b1?.trials, 1);
  assert.equal(b1?.model, null);
});

test("one row has one epoch and one prompt version", () => {
  const tasks = new Map([["t1", task("area-1")]]);
  const rows = [row("t1", REF_A), row("t1", REF_A, { slot: 1, profileEpoch: 2 }), row("t1", REF_A, { slot: 2, promptVersion: "pv2" })];
  const cells = priorCells(CONFIGURATIONS, rows, tasks);
  assert.equal(cells.length, 3);
  assert.deepEqual(cells.map(c => c.profileEpoch).sort(), [1, 1, 2]);
});

test("a repeated export writes nothing new", () => {
  const f = ready();
  try {
    const cells = priorCells(CONFIGURATIONS, [row("t1", REF_A), row("t1", REF_B)], new Map([["t1", task("area-1")]]));
    assert.equal(cells.length, 2);
    assert.equal(f.store.write(tx => writePriors(tx, { jobId: "job-1", projectId: PROJECT_ID, cells, at: NOW })), 2);
    assert.equal(f.store.write(tx => writePriors(tx, { jobId: "job-1", projectId: PROJECT_ID, cells, at: NOW })), 0);
    assert.equal(f.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_priors")?.n), 2);
    const expires = f.store.read(db => db.get<{ expires_at: string }>("SELECT expires_at FROM eval_priors LIMIT 1")?.expires_at);
    assert.equal(expires, new Date(Date.parse(NOW) + 365 * DAY_MS).toISOString());
  } finally {
    f.close();
  }
});

test("the priors read maps areas and keeps unknowns unknown", () => {
  const f = ready();
  try {
    const web = f.store.read(db => db.index("area", "web"));
    const gone = f.store.read(db => db.index("area", "removed-area"));
    const tasks = new Map<string, PriorTask>([
      ["t1", task(web)], ["t2", task(gone, { kind: null })], ["t3", task(null)],
    ]);
    const cells = priorCells(CONFIGURATIONS, [row("t1", REF_B), row("t2", REF_B), row("t3", REF_B)], tasks);
    f.store.write(tx => writePriors(tx, { jobId: "job-1", projectId: PROJECT_ID, cells, at: NOW }));
    const priors = f.store.read(db => readPriors(db, PROJECT));
    assert.equal(priors.length, 3);
    assert.deepEqual(priors.map(p => p.area).sort(), ["other", "other", "web"]);
    const unknownKind = priors.find(p => p.kind === null);
    assert.ok(unknownKind);
    assert.equal(unknownKind.profile.model, null);
    assert.equal(unknownKind.role, "implementer");
    assert.equal(unknownKind.source, "replay");
    assert.equal(unknownKind.jobId, "job-1");
    assert.equal(unknownKind.projectId, PROJECT_ID);
    const names = f.store.read(db => areaNames(db, PROJECT));
    assert.equal(names.get(web), "web");
    assert.equal([...names.values()].includes("root"), true);
    assert.equal([...names.values()].includes("mixed"), true);
  } finally {
    f.close();
  }
});

test("the hot statements read through an index", () => {
  const f = ready();
  try {
    const details = f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${PRIORS_SQL}`, "ref")).map(r => r.detail);
    assert.equal(details.some(d => d.includes("eval_priors_project")), true, details.join(" | "));
  } finally {
    f.close();
  }
});
