import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptVersion } from "../packages/host/src/config-identity.js";
import { advanceEpoch, configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeModule, writeOutcome, type OutcomePayload, type OutcomeRow } from "../packages/host/src/outcome-store.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { routingExplain, routingStatus } from "../packages/host/src/routing-reads.js";
import { decisionKey, insertDecision, markPeriodEnded, routingModule, setExplorePause } from "../packages/host/src/routing-store.js";
import { profileIdentityKey } from "../packages/host/src/config-identity.js";
import type { EvidenceTx } from "../packages/host/src/evidence/types.js";
import type { DecisionRow, RoutingPayload, RoutingStatus } from "../packages/host/src/routing-types.js";
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
  decidedAt?: string; chosen?: string; coordinator?: string | null; greedy?: string; explore?: boolean;
  state?: DecisionRow["state"]; memberId?: string | null; identity?: string };

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
      chosenIdentity: spec.identity ?? "i".repeat(64), greedyProfileId: spec.greedy ?? chosen, coordinatorProfileId: spec.coordinator ?? null,
      explore: spec.explore ?? false, state: spec.state ?? "recorded", memberId: spec.memberId ?? null, decidedAt: spec.decidedAt ?? NOW,
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
    objectiveDigest: false, codeMode: false, now: NOW, ...overrides,
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


test("the status scores a shared identity at its eligible profile's cost", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    // A contributor and B share one identity; B is the eligible profile, so the identity costs what B's tier costs.
    const shared = { provider: "codex", model: "gpt-6-astra", effort: "xhigh" } as const;
    const contributor: TeamModelProfile = { id: "a-light", label: "A", ...shared, tier: "light", dataUse: "contributor" };
    const strong: TeamModelProfile = { id: "b-strong", label: "B", ...shared, tier: "strong", dataUse: "standard" };
    const light: TeamModelProfile = { id: "c-light", label: "C", provider: "codex", model: "gpt-6-astra", effort: "medium", tier: "light", dataUse: "standard" };
    const lineup: TeamLineup = { ...mixedLineup, implementers: [contributor, strong, light] };
    seed(store, { taskId: "t1", area: "host" });

    const status = routingStatus(store, statusInput({ lineup, saved: { mode: "shadow" } }));
    assert.equal(status.cells.length, 2, "one recorded cell and the new-task line");
    for (const line of status.cells) {
      const byId = Object.fromEntries(line.profiles.map(profile => [profile.profileId, profile]));
      assert.equal(byId["a-light"]!.removed, "contributor");
      assert.equal(byId["a-light"]!.costUsd, 2.2, "a removed profile shows its identity's cost");
      assert.equal(byId["b-strong"]!.costUsd, 2.2);
      assert.equal(byId["c-light"]!.costUsd, 0.4);
      assert.deepEqual(line.profiles.filter(profile => profile.greedy).map(profile => profile.profileId), ["c-light"]);
    }
  } finally {
    store?.close();
    f.close();
  }
});

/** A row of an earlier epoch: held, first pass, coordinator-chosen (half weight), ended now, in `projectId`. */
function earlierRow(id: string, profile: TeamModelProfile, projectId: string): OutcomeRow {
  return { ...outcome(id, profile, "cfg-none"), payload: { ...PAYLOAD_BASE, projectId, area: "other" }, profileEpoch: 2, held: 1, firstPass: 1 };
}


test("the status reports an earlier mass under the cap as its applied mass", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const astra = mixedLineup.implementers[1]!;
    store.write(tx => {
      for (let index = 0; index < 4; index++) writeOutcome(tx, earlierRow(`few-${index}`, astra, "rehearsal"));
    });
    // Four rows stay below the cap: the applied mass is the raw mass, 2.
    const status = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    const profile = status.cells[status.cells.length - 1]!.profiles.find(item => item.profileId === "astra-xhigh")!;
    assert.deepEqual(profile.earlier, { rows: 4, mass: 2, appliedMass: 2 });
  } finally {
    store?.close();
    f.close();
  }
});

test("the applied earlier mass sums each level's capped mass", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const astra = mixedLineup.implementers[1]!;
    // A recorded cell: area host, kind feature, feature version 1, feature map default.
    seed(store, { area: "host" });
    // Forty earlier rows under another project (tenant level): raw mass 20 at half weight, capped to 10 (scale 0.5).
    // Four earlier rows in the cell: raw mass 2, under the cap (scale 1), so applied 2.
    const inCell = (id: string, projectId: string): OutcomeRow => ({
      ...earlierRow(id, astra, projectId), kind: "feature",
      payload: { ...PAYLOAD_BASE, projectId, area: "host", featureMap: "default" },
    });
    store.write(tx => {
      for (let index = 0; index < 40; index++) writeOutcome(tx, inCell(`tenant-${index}`, "elsewhere"));
      for (let index = 0; index < 4; index++) writeOutcome(tx, inCell(`cell-${index}`, "rehearsal"));
    });
    const status = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    const cell = status.cells.find(line => line.cell.scope === "cell")!;
    const profile = cell.profiles.find(item => item.profileId === "astra-xhigh")!;
    // Tenant and cell each take their own scale: 20 raw becomes 10, 2 stays 2, so 22 raw and 12 applied over 44 rows.
    assert.deepEqual(profile.earlier, { rows: 44, mass: 22, appliedMass: 12 });
  } finally {
    store?.close();
    f.close();
  }
});

/** A counted implementer row under a stored configuration. The default is the recorded cell: area host, kind feature. */
function integratedRow(spec: { id: string; profile: TeamModelProfile; configId: string; area?: string; kind?: string | null;
  endedAt?: string; firstPass?: 0 | 1 }): OutcomeRow {
  const base = outcome(spec.id, spec.profile, spec.configId);
  const endedAt = spec.endedAt ?? NOW;
  return {
    ...base, kind: spec.kind === undefined ? "feature" : spec.kind, disposition: "integrated", held: 1, firstPass: spec.firstPass ?? 1, startedAt: null,
    endedAt, frozenAt: endedAt,
    payload: { ...base.payload, area: spec.area ?? "host", featureMap: "default" },
  };
}

function configRow(tx: EvidenceTx, configId: string, profile: TeamModelProfile, version: string): void {
  tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
    + "VALUES (?, ?, ?, ?, ?, 'g', 'k', 'off', 's', ?)", configId, profile.provider, profile.model,
  profile.provider === "opencode" ? profile.variant ?? null : profile.effort ?? null, version, NOW);
}

const cellProfile = (status: RoutingStatus, id: string) => status.cells.find(line => line.cell.scope === "cell")!.profiles.find(profile => profile.profileId === id)!;
const newTaskProfile = (status: RoutingStatus, id: string) => status.cells.find(line => line.cell.scope === "new-task")!.profiles.find(profile => profile.profileId === id)!;

test("the earlier mass is the mass the posterior adds, at most 10 per level", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const astra = mixedLineup.implementers[1]!;
    seed(store, { area: "host" });
    store.write(tx => {
      configRow(tx, "old", astra, "an-earlier-version");
      // Forty rows in the cell and forty in the project, each of weight 0.5: a raw mass of 20 per level. The posterior
      // caps each level at 10, so the raw mass is 40 and the applied mass is 20.
      for (let index = 0; index < 40; index++) writeOutcome(tx, integratedRow({ id: `cell-${index}`, profile: astra, configId: "old" }));
      for (let index = 0; index < 40; index++) writeOutcome(tx, integratedRow({ id: `project-${index}`, profile: astra, configId: "old", area: "elsewhere/" }));
    });
    const status = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    assert.deepEqual(cellProfile(status, "astra-xhigh").earlier, { rows: 80, mass: 40, appliedMass: 20 });
  } finally {
    store?.close();
    f.close();
  }
});

test("a recorded cell counts its own rows, and the new-task line counts the project level", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const astra = mixedLineup.implementers[1]!;
    seed(store, { area: "host" });
    store.write(tx => {
      configRow(tx, "now", astra, promptVersion("implementer", "codex", astra, false, false));
      for (let index = 0; index < 30; index++) writeOutcome(tx, integratedRow({ id: `cell-${index}`, profile: astra, configId: "now" }));
    });
    const status = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    const cell = cellProfile(status, "astra-xhigh");
    assert.deepEqual([cell.level, cell.rows.production, newTaskProfile(status, "astra-xhigh").level], ["cell", 30, "project"]);
    for (const profile of status.cells.flatMap(line => line.profiles)) assert.ok(profile.interval[0] >= 0 && profile.interval[1] <= 1, `interval ${profile.interval}`);
    // Beta(16, 1) has an upper bound above 1 before the clip.
    assert.equal(cell.interval[1], 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("the objective digest flag reads the version a goal cycle's start carries, and counts only with the flag", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const astra = mixedLineup.implementers[1]!;
    seed(store, { area: "host" });
    store.write(tx => {
      configRow(tx, "record", astra, promptVersion("implementer", "codex", astra, false, false, true));
      for (let index = 0; index < 30; index++) writeOutcome(tx, integratedRow({ id: `record-${index}`, profile: astra, configId: "record" }));
    });
    const withFlag = cellProfile(routingStatus(store, statusInput({ saved: { mode: "shadow" }, objectiveDigest: true })), "astra-xhigh");
    const withoutFlag = cellProfile(routingStatus(store, statusInput({ saved: { mode: "shadow" }, objectiveDigest: false })), "astra-xhigh");
    assert.deepEqual([withFlag.rows.production, withFlag.earlier.rows], [30, 0]);
    assert.deepEqual([withoutFlag.rows.production, withoutFlag.earlier.rows], [0, 30]);
  } finally {
    store?.close();
    f.close();
  }
});

test("the Code Mode flag reads the version a Claude member started in Code Mode carries, and no other provider's", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const claude: TeamModelProfile = { id: "haiku-medium", label: "Claude implementer", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
    const astra = mixedLineup.implementers[1]!;
    const lineup: TeamLineup = { ...mixedLineup, implementers: [claude, astra] };
    seed(store, { area: "host" });
    store.write(tx => {
      configRow(tx, "program-rule", claude, promptVersion("implementer", "claude", claude, false, false, false, true));
      configRow(tx, "astra-plain", astra, promptVersion("implementer", "codex", astra, false, false));
      for (let index = 0; index < 30; index++) {
        writeOutcome(tx, integratedRow({ id: `program-${index}`, profile: claude, configId: "program-rule" }));
        writeOutcome(tx, integratedRow({ id: `astra-${index}`, profile: astra, configId: "astra-plain" }));
      }
    });
    const read = (codeMode: boolean) => routingStatus(store!, statusInput({ saved: { mode: "shadow" }, lineup, codeMode }));
    const on = read(true), off = read(false);
    assert.deepEqual([cellProfile(on, "haiku-medium").rows.production, cellProfile(on, "haiku-medium").earlier.rows], [30, 0]);
    assert.deepEqual([cellProfile(off, "haiku-medium").rows.production, cellProfile(off, "haiku-medium").earlier.rows], [0, 30]);
    assert.deepEqual([cellProfile(on, "astra-xhigh").rows.production, cellProfile(on, "astra-xhigh").earlier.rows], [30, 0]);
    // The other provider's evidence reads the same. Which profile the greedy pick names depends on the Claude candidate too.
    const evidenceOf = (status: RoutingStatus) => { const { greedy: _pick, ...evidence } = cellProfile(status, "astra-xhigh"); return evidence; };
    assert.deepEqual(evidenceOf(on), evidenceOf(off));
  } finally {
    store?.close();
    f.close();
  }
});

test("a cell whose newest payload does not open is left out and counted", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    seed(store, { taskId: "t1" });
    store.write(tx => tx.run("UPDATE routing_decisions SET encrypted_payload='not-sealed'"));
    const status = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    assert.deepEqual([status.cells.map(line => line.cell.scope), status.unreadableCells], [["new-task"], 1]);
  } finally {
    store?.close();
    f.close();
  }
});

test("greedy agreements count the greedy pick, and explore counts the exploratory starts", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    seed(store, { taskId: "t1", chosen: "a", greedy: "b", coordinator: "a", explore: true });
    seed(store, { taskId: "t2", chosen: "a", greedy: "a", coordinator: "a" });
    seed(store, { taskId: "t3", chosen: "b", greedy: "b", coordinator: "c" });
    const status = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    assert.deepEqual([status.shadow.withCoordinator, status.shadow.agreements, status.shadow.greedyAgreements], [3, 2, 1]);
    assert.deepEqual(status.explore, { exploratory: 1, of: 3, guards: "risk-only", pausedAt: null });
  } finally {
    store?.close();
    f.close();
  }
});

test("the greedy mark is the choice's greedy pick, removed profiles are marked, and cost and rescue are the profile's own", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const a: TeamModelProfile = { id: "codex-a", label: "Codex A", provider: "codex", model: "gpt-a-1", effort: "high" };
    const b: TeamModelProfile = { id: "codex-b", label: "Codex B", provider: "codex", model: "gpt-b-1", effort: "high", tier: "strong" };
    const lineup: TeamLineup = { ...mixedLineup, implementers: [mixedLineup.implementers[0]!, a, { ...b, tier: undefined }] };
    seed(store, { taskId: "t1" });
    // With equal priors and costs the greedy pick is codex-a, the first eligible profile.
    const marks = routingStatus(store, statusInput({ lineup, saved: { mode: "shadow" } })).cells[0]!.profiles.map(profile => [profile.profileId, profile.removed ?? null, profile.greedy]);
    assert.deepEqual(marks, [["spark-high", "contributor", false], ["codex-a", null, true], ["codex-b", null, false]]);
    store.write(tx => {
      configRow(tx, "b", b, promptVersion("implementer", "codex", b, false, false));
      for (let index = 0; index < 4; index++) writeOutcome(tx, integratedRow({ id: `b-${index}`, profile: b, configId: "b", firstPass: 0 }));
    });
    const strong = cellProfile(routingStatus(store, statusInput({ lineup: { ...mixedLineup, implementers: [b] }, saved: { mode: "shadow" } })), "codex-b");
    assert.equal(strong.costUsd, 2.2);
    // Integrated but not first pass: the reward keeps the mean at 0.5, and the rescue falls.
    assert.ok(strong.rescue < strong.mean, `rescue ${strong.rescue}, mean ${strong.mean}`);
  } finally {
    store?.close();
    f.close();
  }
});

test("status uses the run flags' prompt version, the current epoch, and 180 days of rows", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const astra = mixedLineup.implementers[1]!;
    seed(store, { taskId: "t1" });
    store.write(tx => {
      configRow(tx, "heads", astra, promptVersion("implementer", "codex", astra, true, true));
      for (let index = 0; index < 3; index++) writeOutcome(tx, integratedRow({ id: `old-${index}`, profile: astra, configId: "heads", endedAt: daysBefore(30) }));
    });
    const flags = { publishHeads: true, entryTools: true };
    assert.equal(cellProfile(routingStatus(store, statusInput({ ...flags, saved: { mode: "shadow" } })), "astra-xhigh").rows.production, 3);
    advanceEpoch(store, { profile: { provider: "codex", model: astra.model, effort: "xhigh" }, requestId: "0b4c3b52-6c43-4f0a-9d4c-8e2f9a6b1c07", now: daysBefore(1) });
    const demoted = cellProfile(routingStatus(store, statusInput({ ...flags, saved: { mode: "shadow" } })), "astra-xhigh");
    assert.deepEqual([demoted.rows.production, demoted.earlier.rows], [0, 3]);
  } finally {
    store?.close();
    f.close();
  }
});

test("status cells read only the last 30 days of decisions", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    seed(store, { taskId: "t-old", area: "legacy", decidedAt: daysBefore(40) });
    seed(store, { taskId: "t-new", area: "current", decidedAt: daysBefore(2) });
    const status = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    const areas = status.cells.map(entry => entry.cell.scope === "cell" ? entry.cell.area : entry.cell.scope);
    assert.ok(areas.includes("current"), "the in-window cell is shown");
    assert.ok(!areas.includes("legacy"), "a cell with no decision in 30 days is not shown");
  } finally {
    store?.close();
    f.close();
  }
});

test("the status reports the requested mode, the source, the defaults, the start point, and the explain cap", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const auto = routingStatus(store, statusInput({ saved: { mode: "auto", successValueUsd: 8 } }));
    assert.deepEqual([auto.mode, auto.requested, auto.source, auto.defaults.includes("successValueUsd"), auto.defaults.includes("points")], ["shadow", "auto", "saved", false, true]);
    // A saved mode decides; a saved policy without a mode in an autonomous project takes the autonomous default's mode.
    assert.equal(auto.modeSource, "saved");
    const noMode = routingStatus(store, statusInput({ autonomy: "autonomous", saved: { successValueUsd: 8 } }));
    assert.deepEqual([noMode.source, noMode.requested, noMode.modeSource], ["saved", "shadow", "autonomous-default"]);
    assert.equal(routingStatus(store, statusInput({ saved: { mode: "shadow" } })).modeSource, "saved");
    const escalationOnly = routingStatus(store, statusInput({ saved: { mode: "shadow", points: ["escalation"] } }));
    assert.deepEqual([escalationOnly.covers, escalationOnly.cells], [{ start: false, reason: "no-start-point" }, []]);
    for (let revision = 1; revision <= 21; revision++) seed(store, { taskId: "t1", revision });
    assert.equal(routingExplain(store, "run-1", "t1")?.capped, true);
  } finally {
    store?.close();
    f.close();
  }
});

test("status needs the outcomes and configurations modules, and explain needs only routing", () => {
  const sets: [string, (store: EvidenceStore) => void][] = [
    ["no outcomes", store => { store.register(configurationModule()); store.register(routingModule()); }],
    ["no configurations", store => { store.register(outcomeModule({ now: () => NOW })); store.register(routingModule()); }],
  ];
  for (const [name, register] of sets) {
    const f = fixture();
    let store: EvidenceStore | undefined;
    try {
      store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
      register(store);
      assert.throws(() => routingStatus(store!, statusInput({ saved: { mode: "shadow" } })), { name: "EvidenceError", code: "unavailable" }, name);
      assert.equal(routingExplain(store, "run-1", "t1"), undefined, name);
    } finally {
      store?.close();
      f.close();
    }
  }
});

test("status reports auto, the period end, and the pause", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const empty = routingStatus(store, statusInput({ saved: { mode: "auto" } }));
    assert.deepEqual([empty.mode, empty.requested, empty.period.endsAt, empty.period.endedAt, empty.share, empty.auto], ["shadow", "auto", null, null, null, null]);
    assert.deepEqual([empty.explore.pausedAt, routingStatus(store, statusInput({ saved: { mode: "shadow" } })).explore.pausedAt], [null, null]);

    for (let index = 0; index < 50; index++) seed(store, { taskId: `t-${index}`, decidedAt: daysBefore(15) });
    // The first start is 15 days old, so the end is its 14 days: a day ago. Nothing is stored yet.
    const unstored = routingStatus(store, statusInput({ saved: { mode: "auto" } }));
    assert.deepEqual([unstored.mode, unstored.period.decisions, unstored.period.endedAt, unstored.period.stored], ["auto", 50, daysBefore(1), false]);

    // A stored end is the one the status shows, and it never moves.
    store.write(tx => markPeriodEnded(tx, "rehearsal", daysBefore(2), NOW));
    const stored = routingStatus(store, statusInput({ saved: { mode: "auto" } }));
    assert.deepEqual([stored.mode, stored.period.endedAt, stored.period.stored], ["auto", daysBefore(2), true]);

    // Exploration is paused for the project in both modes, and the pause is not a configuration change.
    store.write(tx => setExplorePause(tx, "rehearsal", NOW, NOW));
    assert.equal(routingStatus(store, statusInput({ saved: { mode: "auto" } })).explore.pausedAt, NOW);
    assert.equal(routingStatus(store, statusInput({ saved: { mode: "shadow" } })).explore.pausedAt, NOW);
    store.write(tx => setExplorePause(tx, "rehearsal", null, NOW));
    assert.equal(routingStatus(store, statusInput({ saved: { mode: "auto" } })).explore.pausedAt, null);

    // The autonomous default: no saved policy, 50 recorded starts, the first 15 days ago, gives auto.
    for (let index = 0; index < 50; index++) seed(store, { projectId: "fresh", taskId: `f-${index}`, decidedAt: daysBefore(15) });
    const fresh = routingStatus(store, statusInput({ projectId: "fresh", autonomy: "autonomous", saved: undefined }));
    assert.deepEqual([fresh.mode, fresh.period.endedAt, fresh.period.stored], ["auto", daysBefore(1), false]);
    // Without a lineup that covers the start point, the default does not pin auto, so the status says shadow.
    const contributorsOnly: TeamLineup = { ...mixedLineup, implementers: [mixedLineup.implementers[0]!] };
    const uncovered = routingStatus(store, statusInput({ projectId: "fresh", autonomy: "autonomous", saved: undefined, lineup: contributorsOnly }));
    assert.deepEqual([uncovered.mode, uncovered.covers.reason], ["shadow", "no-eligible-profile"]);
    // A supervised project without a policy stays off, whatever its rows say.
    assert.equal(routingStatus(store, statusInput({ projectId: "fresh" })).mode, "off");
  } finally {
    store?.close();
    f.close();
  }
});

test("auto status counts each state and the share, and weighs applied rows in full", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const astra = mixedLineup.implementers[1]!;
    const identity = profileIdentityKey({ provider: "codex", model: astra.model, effort: "xhigh" });
    store.write(tx => markPeriodEnded(tx, "rehearsal", daysBefore(1), NOW));
    for (let index = 0; index < 2; index++) seed(store, { taskId: `pending-${index}`, state: "pending" });
    for (let index = 0; index < 3; index++) seed(store, { runId: `run-applied-${index}`, taskId: `applied-${index}`, state: "applied", memberId: "m1", identity });
    seed(store, { taskId: "released", state: "released" });
    for (let index = 0; index < 4; index++) seed(store, { taskId: `recorded-${index}` });

    const status = routingStatus(store, statusInput({ saved: { mode: "auto" } }));
    assert.equal(status.mode, "auto");
    assert.deepEqual([status.auto!.pending, status.auto!.applied, status.auto!.released], [2, 3, 1]);
    assert.deepEqual([status.auto!.windowDays, status.auto!.capped], [30, false]);
    assert.equal(status.shadow.decisions, 4);
    assert.deepEqual([status.share!.of, status.share!.window, status.share!.limit], [5, 50, 0.2]);
    assert.deepEqual([status.explore.guards, status.explore.of], ["applied", 5]);
    // In shadow, none of the state counts exist.
    const shadow = routingStatus(store, statusInput({ saved: { mode: "shadow" } }));
    assert.deepEqual([shadow.share, shadow.auto, shadow.explore.guards], [null, null, "risk-only"]);

    // Past the 500-row read limit, the auto counts are capped. One transaction writes the rows, so the test stays fast.
    store.write(tx => markPeriodEnded(tx, "bulk-auto", daysBefore(1), NOW));
    const payload: RoutingPayload = {
      projectId: "bulk-auto", taskId: "bulk", area: "host", featureMap: "default", coordinatorProfileId: null, knobs: ROUTING_DEFAULTS,
      costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" }, headroom: "not-modelled", chosenWeight: 0.5,
      current: [], candidates: [], elapsedMs: 1,
    };
    store.write(tx => {
      for (let index = 0; index < 501; index++) {
        const taskKey = tx.index("task", `bulk-${index}`);
        insertDecision(tx, {
          key: decisionKey("run-bulk", 1, taskKey, "start", 1), runId: "run-bulk", revision: 1, taskKey, point: "start", ordinal: 1,
          projectRef: tx.index("project", "bulk-auto"), role: "implementer", areaRef: tx.index("area", "host"), kind: "feature",
          risk: "normal", featureVersion: 1, featureMapRef: tx.index("feature-map", "default"), mode: "auto", algorithmVersion: 1,
          rewardVersion: 1, policyDigest: "d".repeat(64), seed: "s".repeat(64), basis: "sampled", chosenProfileId: "astra-xhigh",
          chosenIdentity: "i".repeat(64), greedyProfileId: "astra-xhigh", coordinatorProfileId: null, explore: false,
          state: "pending", memberId: null, decidedAt: NOW,
        }, payload);
      }
    });
    const capped = routingStatus(store, statusInput({ projectId: "bulk-auto", saved: { mode: "auto" } }));
    assert.deepEqual([capped.mode, capped.auto!.pending, capped.auto!.capped], ["auto", 500, true]);
  } finally {
    store?.close();
    f.close();
  }
});

test("an applied first-pass row weighs in full in the profile's mean", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const astra = mixedLineup.implementers[1]!;
    const identity = profileIdentityKey({ provider: "codex", model: astra.model, effort: "xhigh" });
    store.write(tx => {
      markPeriodEnded(tx, "rehearsal", daysBefore(1), NOW);
      configRow(tx, "now", astra, promptVersion("implementer", "codex", astra, false, false));
      writeOutcome(tx, integratedRow({ id: "run-a", profile: astra, configId: "now" }));
    });
    seed(store, { runId: "run-a", taskId: "a-task", state: "applied", memberId: "m1", identity });
    const withApplied = newTaskProfile(routingStatus(store, statusInput({ saved: { mode: "auto" } })), "astra-xhigh").mean;
    store.write(tx => tx.run("UPDATE routing_decisions SET state='recorded', member_id=NULL WHERE run_id='run-a'"));
    const withoutApplied = newTaskProfile(routingStatus(store, statusInput({ saved: { mode: "auto" } })), "astra-xhigh").mean;
    assert.ok(withApplied > withoutApplied, `${withApplied} > ${withoutApplied}`);
  } finally {
    store?.close();
    f.close();
  }
});
