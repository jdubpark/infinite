import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptVersion } from "../packages/host/src/config-identity.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeModule, writeOutcome, type OutcomeRow, type OutcomePayload } from "../packages/host/src/outcome-store.js";
import { RoutingRecorder, type RouterStart } from "../packages/host/src/routing-recorder.js";
import { decisionKey, taskDecisions, routingModule } from "../packages/host/src/routing-store.js";
import { decisionSeed } from "../packages/host/src/routing-sample.js";
import { pinRouting } from "../packages/host/src/routing-policy.js";
import { taskFeatures } from "../packages/host/src/task-features.js";
import type { RoutingPayload } from "../packages/host/src/routing-types.js";
import type { TeamLineup, TeamModelProfile, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import { mixedLineup } from "./team-fixture.js";

const NOW = "2026-11-15T12:00:00.000Z";
const PATHS = ["packages/host/src/a.ts"];

type Fixture = { root: string; path: string; key: Buffer; close: () => void };
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-recorder-"));
  return { root, path: evidenceDatabasePath(join(root, "state")), key: randomBytes(32), close: () => rmSync(root, { recursive: true, force: true }) };
}

function open(f: Fixture): EvidenceStore {
  const store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => NOW }));
  store.register(routingModule());
  return store;
}

function runOf(lineup: TeamLineup, routing: TeamRun["routing"], id = "run-1"): TeamRun {
  return { id, revision: 1, projectId: "rehearsal", lineup, routing } as unknown as TeamRun;
}

function taskOf(id: string, agentProfileId?: string): TeamTask {
  return {
    id, title: id, instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending",
    ...(agentProfileId === undefined ? {} : { agentProfileId }),
  } as unknown as TeamTask;
}

function startOf(run: TeamRun, task: TeamTask, limited: RouterStart["limited"] = new Set()): RouterStart {
  return { run, task, publishHeads: false, entryTools: false, featureMap: undefined, limited };
}

/** The implementer's recorded decisions of a task, read back through the store. */
function decisionsOf(store: EvidenceStore, runId: string, taskId: string) {
  return store.read(db => taskDecisions(db, runId, taskId));
}

function countRows(store: EvidenceStore): number {
  return store.read(db => routingModule().counts!(db).decisions);
}

const PAYLOAD_BASE: OutcomePayload = { projectId: "rehearsal", taskId: "task-x", area: "host", featureMap: "default",
  rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none" };

/** A counted implementer row of the start point: completed, integrated, frozen, accepted, first pass. */
function outcome(spec: { id: string; provider: OutcomeRow["provider"]; model: string; effort: string | null; projectId?: string;
  area: string; configId?: string | null; endedAt?: string }): OutcomeRow {
  const payload: OutcomePayload = { ...PAYLOAD_BASE, projectId: spec.projectId ?? "rehearsal", area: spec.area };
  return {
    outcomeId: `${spec.id}:m1`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: spec.id, revision: 1,
    memberId: "m1", sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: "profile",
    provider: spec.provider, model: spec.model, effort: spec.effort, profileEpoch: 1, configId: spec.configId ?? null,
    experimentRef: null, kind: null, risk: "normal", featureVersion: 1, disposition: "completed", exclusion: null, flags: [],
    integrated: 1, accepted: 1, acceptance: 1, firstPass: 1, held: null, startedAt: null, endedAt: spec.endedAt ?? NOW,
    frozenAt: NOW, holdUntil: null, runDeletedAt: null, payload,
  };
}

function plainRecorder(store: EvidenceStore, lines: string[] = [], clock?: () => number) {
  return new RoutingRecorder({ store, now: () => NOW, clock, log: line => lines.push(line) });
}

test("a shadow start writes one recorded row with both picks", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const routing = pinRouting(undefined, "autonomous", mixedLineup);
    assert.ok(routing);
    const run = runOf(mixedLineup, routing);
    const recorder = plainRecorder(store);
    recorder.recordStart(startOf(run, taskOf("task-spark", "spark-high")));
    recorder.recordStart(startOf(run, taskOf("task-astra", "astra-xhigh")));

    const first = decisionsOf(store, run.id, "task-spark").rows;
    const second = decisionsOf(store, run.id, "task-astra").rows;
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    for (const [row, coordinator] of [[first[0]!, "spark-high"], [second[0]!, "astra-xhigh"]] as const) {
      assert.equal(row.coordinatorProfileId, coordinator);
      // The contributor profile is removed by the fixed rules, so the coordinator's pick is the only candidate.
      assert.equal(row.chosenProfileId, "astra-xhigh");
      assert.equal(row.greedyProfileId, "astra-xhigh");
      assert.equal(row.basis, "single-candidate");
      assert.equal(row.mode, "shadow");
      assert.equal(row.state, "recorded");
      assert.equal(row.memberId, null);
      assert.equal(row.policyDigest, routing.digest);
      assert.equal(row.algorithmVersion, 1);
      assert.equal(row.rewardVersion, 1);
      assert.equal(row.point, "start");
      assert.equal(row.ordinal, 1);
      assert.equal(row.revision, 1);
    }
    assert.equal(first[0]!.payload?.projectId, "rehearsal");
    assert.equal(first[0]!.payload?.taskId, "task-spark");
    // The key and the seed use the task's blind index, never its plain id.
    const blind = store.read(db => db.index("task", "task-spark"));
    assert.equal(first[0]!.key, decisionKey(run.id, run.revision, blind, "start", 1));
    assert.equal(first[0]!.seed, decisionSeed(routing.digest, run.id, run.revision, blind, "start", 1));
    assert.notEqual(first[0]!.key, decisionKey(run.id, run.revision, "task-spark", "start", 1));
    assert.notEqual(first[0]!.seed, decisionSeed(routing.digest, run.id, run.revision, "task-spark", "start", 1));
    assert.equal(first[0]!.taskKey, blind);
  } finally {
    store?.close();
    f.close();
  }
});

test("with allowContributor the contributor is a candidate and the basis is sampled", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const routing = pinRouting({ allowContributor: true }, "autonomous", mixedLineup);
    assert.ok(routing);
    const run = runOf(mixedLineup, routing, "run-sampled");
    plainRecorder(store).recordStart(startOf(run, taskOf("task-a", "spark-high")));
    const row = decisionsOf(store, run.id, "task-a").rows[0]!;
    assert.equal(row.basis, "sampled");
    assert.ok(["spark-high", "astra-xhigh"].includes(row.chosenProfileId));
    assert.equal(row.seed.length, 64);
  } finally {
    store?.close();
    f.close();
  }
});

test("a second start reuses the row whatever the store holds now", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const routing = pinRouting({ allowContributor: true }, "autonomous", mixedLineup);
    assert.ok(routing);
    const run = runOf(mixedLineup, routing);
    const task = taskOf("task-a", "spark-high");
    const recorder = plainRecorder(store);
    const original = store.read.bind(store) as EvidenceStore["read"];
    // Statements that read evidence: the outcome rows and the profile epochs. The key read is not one of them.
    let evidenceStatements = 0;
    let reads = 0;
    const counting = (fn: Parameters<EvidenceStore["read"]>[0]) => {
      reads += 1;
      return original(db => fn({
        ...db,
        get: (sql: string, ...params: never[]) => { if (/outcomes|profile_epochs/.test(sql)) evidenceStatements += 1; return db.get(sql, ...params); },
        all: (sql: string, ...params: never[]) => { if (/outcomes|profile_epochs/.test(sql)) evidenceStatements += 1; return db.all(sql, ...params); },
      } as typeof db));
    };
    (store as { read: EvidenceStore["read"] }).read = counting as EvidenceStore["read"];
    try {
      recorder.recordStart(startOf(run, task));
    } finally {
      (store as { read: EvidenceStore["read"] }).read = original;
    }
    assert.ok(evidenceStatements > 0, "the first start reads the evidence");
    const before = decisionsOf(store, run.id, "task-a").rows[0]!;

    // Thirty counted rows for the astra identity arrive between the two starts.
    store.write(tx => {
      for (let index = 0; index < 30; index++) {
        writeOutcome(tx, outcome({ id: `late-${index}`, provider: "codex", model: "gpt-6-astra", effort: "xhigh", area: "other", endedAt: NOW }));
      }
    });

    reads = 0;
    evidenceStatements = 0;
    (store as { read: EvidenceStore["read"] }).read = counting as EvidenceStore["read"];
    try {
      recorder.recordStart(startOf(run, task));
    } finally {
      (store as { read: EvidenceStore["read"] }).read = original;
    }
    // A reused row costs one read, the key read, and no evidence statement.
    assert.equal(reads, 1);
    assert.equal(evidenceStatements, 0);
    assert.equal(countRows(store), 1);
    const after = decisionsOf(store, run.id, "task-a").rows[0]!;
    assert.deepEqual(after, before);
  } finally {
    store?.close();
    f.close();
  }
});

test("the posterior counts the store's rows of each candidate, OpenCode included", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const openCode: TeamModelProfile = { id: "oc-high", label: "OpenCode", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high", tier: "light" };
    const astra = mixedLineup.implementers[1]!;
    const lineup: TeamLineup = { ...mixedLineup, implementers: [openCode, astra] };
    const routing = pinRouting(undefined, "autonomous", lineup);
    assert.ok(routing);
    const run = runOf(lineup, routing, "run-counts");
    const version = (profile: TeamModelProfile) => promptVersion("implementer", profile.provider, profile, false, false);
    store.write(tx => {
      tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
        + "VALUES ('cfg-oc', 'opencode', 'meta/muse-spark-1.3-contributor', 'high', ?, 'g', 'k', 'r', 's', ?)", version(openCode), NOW);
      tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
        + "VALUES ('cfg-astra', 'codex', 'gpt-6-astra', 'xhigh', ?, 'g', 'k', 'r', 's', ?)", version(astra), NOW);
      for (let index = 0; index < 3; index++) {
        writeOutcome(tx, outcome({ id: `oc-${index}`, provider: "opencode", model: "meta/muse-spark-1.3-contributor", effort: "high", area: "other", configId: "cfg-oc" }));
      }
      for (let index = 0; index < 2; index++) {
        writeOutcome(tx, outcome({ id: `astra-${index}`, provider: "codex", model: "gpt-6-astra", effort: "xhigh", area: "other", configId: "cfg-astra" }));
      }
    });
    plainRecorder(store).recordStart(startOf(run, taskOf("task-a")));
    const payload = decisionsOf(store, run.id, "task-a").rows[0]!.payload as RoutingPayload;
    const counted = (id: string) => payload.candidates.find(candidate => candidate.profileId === id)?.posterior?.rows.production;
    assert.equal(counted("oc-high"), 3);
    assert.equal(counted("astra-xhigh"), 2);
  } finally {
    store?.close();
    f.close();
  }
});

test("without its modules the recorder writes nothing and never throws", () => {
  const f = fixture();
  try {
    // The evidence directory is a file, so the store opens unavailable.
    mkdirSync(join(f.root, "state"), { recursive: true });
    writeFileSync(join(f.root, "state", "evidence"), "not a directory");
    const broken = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
    const routing = pinRouting(undefined, "autonomous", mixedLineup);
    const run = runOf(mixedLineup, routing);
    const lines: string[] = [];
    const recorder = plainRecorder(broken, lines);
    assert.doesNotThrow(() => recorder.recordStart(startOf(run, taskOf("task-a"))));
    assert.doesNotThrow(() => recorder.recordStart(startOf(run, taskOf("task-b"))));
    assert.deepEqual(lines, ["Routing shadow decision skipped: the evidence store is unavailable."]);
    broken.close();

    // Stores with one or two of the modules.
    const partial = fixture();
    try {
      for (const register of [
        (store: EvidenceStore) => { store.register(configurationModule()); store.register(routingModule()); },
        (store: EvidenceStore) => { store.register(outcomeModule({ now: () => NOW })); store.register(routingModule()); },
        (store: EvidenceStore) => { store.register(configurationModule()); store.register(outcomeModule({ now: () => NOW })); },
      ]) {
        const store = new EvidenceStore({ databasePath: partial.path, vaultKey: partial.key });
        register(store);
        const log: string[] = [];
        const partialRecorder = plainRecorder(store, log);
        assert.doesNotThrow(() => partialRecorder.recordStart(startOf(run, taskOf("task-c"))));
        assert.doesNotThrow(() => partialRecorder.recordStart(startOf(run, taskOf("task-d"))));
        assert.equal(log.length, 1);
        store.close();
        rmSync(partial.path, { force: true });
      }
    } finally {
      partial.close();
    }
  } finally {
    f.close();
  }
});

test("a decision over its budget writes no row", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const routing = pinRouting(undefined, "autonomous", mixedLineup);
    const run = runOf(mixedLineup, routing, "run-budget");
    const lines: string[] = [];
    const over = [0, 251];
    const recorder = plainRecorder(store, lines, () => over.shift() ?? 0);
    recorder.recordStart(startOf(run, taskOf("task-a", "astra-xhigh")));
    assert.equal(countRows(store), 0);
    assert.deepEqual(lines, ["Routing shadow decision skipped: it took longer than 250 ms."]);
    over.push(0, 251);
    recorder.recordStart(startOf(run, taskOf("task-b", "astra-xhigh")));
    assert.equal(countRows(store), 0);
    assert.equal(lines.length, 1, "the budget line is logged once per recorder");

    const within = [0, 249];
    plainRecorder(store, [], () => within.shift() ?? 0).recordStart(startOf(run, taskOf("task-c", "astra-xhigh")));
    assert.equal(countRows(store), 1);
    const row = decisionsOf(store, run.id, "task-c").rows[0]!;
    assert.equal(row.payload?.elapsedMs, 249);
  } finally {
    store?.close();
    f.close();
  }
});

test("an uncovered start writes no row", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const contributorOnly: TeamLineup = { ...mixedLineup, implementers: [mixedLineup.implementers[0]!] };
    const run = runOf(contributorOnly, pinRouting(undefined, "autonomous", contributorOnly), "run-uncovered");
    const lines: string[] = [];
    plainRecorder(store, lines).recordStart(startOf(run, taskOf("task-a")));
    assert.equal(countRows(store), 0);
    assert.deepEqual(lines, []);

    // A run without a pinned policy reads nothing: the store is not even asked for a read.
    let reads = 0;
    const original = store.read.bind(store) as EvidenceStore["read"];
    (store as { read: EvidenceStore["read"] }).read = fn => { reads += 1; return original(fn); };
    try {
      plainRecorder(store, lines).recordStart(startOf(runOf(mixedLineup, undefined, "run-off"), taskOf("task-b")));
    } finally {
      (store as { read: EvidenceStore["read"] }).read = original;
    }
    assert.equal(reads, 0);
    assert.equal(countRows(store), 0);
    assert.deepEqual(lines, []);
  } finally {
    store?.close();
    f.close();
  }
});

test("the payload stays within its limit with eight candidates", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const implementers: TeamModelProfile[] = Array.from({ length: 8 }, (_, index) => ({
      id: `impl-${index + 1}`, label: `Implementer ${index + 1}`, provider: "codex", model: `gpt-impl-${index + 1}`, effort: "high", tier: "light",
    }));
    const lineup: TeamLineup = { ...mixedLineup, implementers };
    const routing = pinRouting(undefined, "autonomous", lineup);
    const run = runOf(lineup, routing, "run-eight");
    const task = taskOf("task-a");
    const area = taskFeatures({ role: "implementer", paths: PATHS }).area;
    store.write(tx => {
      for (const [index, profile] of implementers.entries()) {
        const model = profile.provider === "codex" ? profile.model : "";
        writeOutcome(tx, outcome({ id: `cell-${index}`, provider: "codex", model, effort: "high", area }));
        writeOutcome(tx, outcome({ id: `project-${index}`, provider: "codex", model, effort: "high", area: "elsewhere" }));
        writeOutcome(tx, outcome({ id: `tenant-${index}`, provider: "codex", model, effort: "high", area, projectId: "other" }));
      }
    });
    plainRecorder(store).recordStart(startOf(run, task));
    assert.equal(countRows(store), 1);
    const row = decisionsOf(store, run.id, "task-a").rows[0]!;
    assert.ok(row.payload);
    assert.equal(row.payload.candidates.filter(candidate => candidate.posterior !== undefined).length, 8);
    assert.ok(JSON.stringify(row.payload).length < 16 * 1024, `payload is ${JSON.stringify(row.payload).length} bytes`);
  } finally {
    store?.close();
    f.close();
  }
});
