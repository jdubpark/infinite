import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileIdentityKey, promptVersion } from "../packages/host/src/config-identity.js";
import { advanceEpoch, configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceTx } from "../packages/host/src/evidence/types.js";
import { outcomeModule, writeOutcome, type OutcomePayload, type OutcomeRow } from "../packages/host/src/outcome-store.js";
import { AUTO_LOG } from "../packages/host/src/routing-auto.js";
import { pinRouting, type TeamRouting } from "../packages/host/src/routing-policy.js";
import { RoutingRecorder, type RouterEscalation, type RouterScout, type RouterStart } from "../packages/host/src/routing-recorder.js";
import { TIER_COSTS } from "../packages/host/src/routing-choice.js";
import { decisionSeed } from "../packages/host/src/routing-sample.js";
import { decisionKey, PAYLOAD_LIMIT_BYTES, routingModule, shadowProgress, taskDecisions } from "../packages/host/src/routing-store.js";
import { featureMapDigest, taskFeatures, type FeatureMap } from "../packages/host/src/task-features.js";
import type { RoutingPayload } from "../packages/host/src/routing-types.js";
import type { TeamLineup, TeamModelProfile, TeamRun, TeamScout, TeamTask } from "../packages/host/src/team-types.js";
import { mixedLineup } from "./team-fixture.js";

const NOW = "2026-11-15T12:00:00.000Z";
const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
const PATHS = ["packages/host/src/a.ts"];
const AREA = taskFeatures({ role: "implementer", paths: PATHS }).area;
const UNAVAILABLE = "Routing shadow decision skipped: the evidence store is unavailable.";
const FAILED = "Routing shadow decision failed.";
const TOO_LARGE = "Routing shadow decision skipped: its details are over the size limit.";

const ALL = (store: EvidenceStore) => {
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => NOW }));
  store.register(routingModule());
};

function withStore(fn: (store: EvidenceStore) => void, register: (store: EvidenceStore) => void = ALL): void {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-recorder-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: Buffer.alloc(32, 7) });
  try {
    register(store);
    fn(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const runOf = (lineup: TeamLineup, routing: TeamRun["routing"], id = "run-1", projectId = "rehearsal") =>
  ({ id, revision: 1, projectId, lineup, routing }) as unknown as TeamRun;
const taskOf = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending", ...extra }) as unknown as TeamTask;
const startOf = (run: TeamRun, task: TeamTask, extra: Partial<RouterStart> = {}): RouterStart =>
  ({ run, task, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set(), ...extra });
const recorder = (store: EvidenceStore, lines: string[] = [], clock?: () => number) =>
  new RoutingRecorder({ store, now: () => NOW, clock, log: line => lines.push(line) });
const rowsOf = (store: EvidenceStore, runId: string, taskId: string) => store.read(db => taskDecisions(db, runId, taskId)).rows;
const countRows = (store: EvidenceStore) => store.read(db => routingModule().counts!(db).decisions);
const effortOf = (profile: TeamModelProfile) => ("effort" in profile ? profile.effort : profile.variant) ?? null;
const identityOf = (profile: TeamModelProfile) => profileIdentityKey({ provider: profile.provider, model: profile.model, effort: effortOf(profile) });
const versionOf = (profile: TeamModelProfile, publishHeads = false, entryTools = false) =>
  promptVersion("implementer", profile.provider, profile, publishHeads, entryTools);

function config(tx: EvidenceTx, id: string, profile: TeamModelProfile, version: string): void {
  tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
    + "VALUES (?, ?, ?, ?, ?, 'g', 'k', 'off', 's', ?)", id, profile.provider, profile.model, effortOf(profile), version, NOW);
}

function integrated(spec: { id: string; profile: TeamModelProfile; configId: string; endedAt?: string; area?: string;
  projectId?: string; epoch?: number; failed?: boolean }): OutcomeRow {
  const payload: OutcomePayload = { projectId: spec.projectId ?? "rehearsal", taskId: "task-x", area: spec.area ?? AREA, featureMap: "default",
    rounds: { run: 1, attributed: 1, unknown: 0 }, limitEvents: 0, costCoverage: "none" };
  const endedAt = spec.endedAt ?? ago(2);
  return {
    outcomeId: `${spec.id}:m1`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: spec.id, revision: 1, memberId: "m1",
    sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: spec.profile.id, provider: spec.profile.provider,
    model: spec.profile.model, effort: effortOf(spec.profile), profileEpoch: spec.epoch ?? 1, configId: spec.configId, experimentRef: null,
    kind: null, risk: "normal", featureVersion: 1, disposition: spec.failed ? "stalled" : "integrated", exclusion: null, flags: [],
    integrated: spec.failed ? 0 : 1, accepted: spec.failed ? 0 : 1, acceptance: spec.failed ? null : 1, firstPass: spec.failed ? 0 : 1,
    held: spec.failed ? 0 : 1, startedAt: new Date(Date.parse(endedAt) - 3_600_000).toISOString(), endedAt,
    frozenAt: spec.failed ? null : endedAt, holdUntil: null, runDeletedAt: null, payload,
  };
}

test("a shadow start writes one recorded row with both picks", () => withStore(store => {
  const routing = pinRouting(undefined, "autonomous", mixedLineup);
  assert.ok(routing);
  const run = runOf(mixedLineup, routing);
  const lines: string[] = [];
  const rec = recorder(store, lines);
  rec.recordStart(startOf(run, taskOf("task-spark", { agentProfileId: "spark-high" })));
  rec.recordStart(startOf(run, taskOf("task-astra", { agentProfileId: "astra-xhigh" })));
  assert.deepEqual(lines, []);
  for (const [taskId, coordinator] of [["task-spark", "spark-high"], ["task-astra", "astra-xhigh"]] as const) {
    const rows = rowsOf(store, run.id, taskId);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.coordinatorProfileId, coordinator);
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
    assert.equal(row.payload?.projectId, "rehearsal");
    assert.equal(row.payload?.taskId, taskId);
  }
  const blind = store.read(db => db.index("task", "task-spark"));
  const row = rowsOf(store, run.id, "task-spark")[0]!;
  assert.equal(row.key, decisionKey(run.id, run.revision, blind, "start", 1));
  assert.equal(row.seed, decisionSeed(routing.digest, run.id, run.revision, blind, "start", 1));
  assert.notEqual(row.key, decisionKey(run.id, run.revision, "task-spark", "start", 1));
  assert.notEqual(row.seed, decisionSeed(routing.digest, run.id, run.revision, "task-spark", "start", 1));
  assert.equal(row.taskKey, blind);
}));

test("with allowContributor the contributor is a candidate and the basis is sampled", () => withStore(store => {
  const routing = pinRouting({ allowContributor: true }, "autonomous", mixedLineup);
  assert.ok(routing);
  const run = runOf(mixedLineup, routing, "run-sampled");
  recorder(store).recordStart(startOf(run, taskOf("task-a", { agentProfileId: "spark-high" })));
  const row = rowsOf(store, run.id, "task-a")[0]!;
  assert.equal(row.basis, "sampled");
  assert.ok(["spark-high", "astra-xhigh"].includes(row.chosenProfileId));
  assert.equal(row.seed.length, 64);
}));

test("a second start reuses the row whatever the store holds now", () => withStore(store => {
  const routing = pinRouting({ allowContributor: true }, "autonomous", mixedLineup);
  assert.ok(routing);
  const run = runOf(mixedLineup, routing);
  const task = taskOf("task-a", { agentProfileId: "spark-high" });
  const rec = recorder(store);
  const original = store.read.bind(store) as EvidenceStore["read"];
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
    rec.recordStart(startOf(run, task));
  } finally {
    (store as { read: EvidenceStore["read"] }).read = original;
  }
  assert.ok(evidenceStatements > 0, "the first start reads the evidence");
  const before = rowsOf(store, run.id, "task-a")[0]!;

  store.write(tx => {
    for (let index = 0; index < 30; index++) {
      writeOutcome(tx, integrated({ id: `late-${index}`, profile: mixedLineup.implementers[1]!, configId: "none", endedAt: NOW }));
    }
  });

  reads = 0;
  evidenceStatements = 0;
  (store as { read: EvidenceStore["read"] }).read = counting as EvidenceStore["read"];
  try {
    rec.recordStart(startOf(run, task));
  } finally {
    (store as { read: EvidenceStore["read"] }).read = original;
  }
  assert.equal(reads, 1);
  assert.equal(evidenceStatements, 0);
  assert.equal(countRows(store), 1);
  assert.deepEqual(rowsOf(store, run.id, "task-a")[0], before);
}));

test("the posterior counts the store's rows of each candidate, OpenCode included", () => withStore(store => {
  const openCode: TeamModelProfile = { id: "oc-high", label: "OpenCode", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high", tier: "light" };
  const astra = mixedLineup.implementers[1]!;
  const lineup: TeamLineup = { ...mixedLineup, implementers: [openCode, astra] };
  const routing = pinRouting(undefined, "autonomous", lineup);
  assert.ok(routing);
  const run = runOf(lineup, routing, "run-counts");
  store.write(tx => {
    config(tx, "cfg-oc", openCode, versionOf(openCode));
    config(tx, "cfg-astra", astra, versionOf(astra));
    for (let index = 0; index < 3; index++) writeOutcome(tx, integrated({ id: `oc-${index}`, profile: openCode, configId: "cfg-oc", area: "other" }));
    for (let index = 0; index < 2; index++) writeOutcome(tx, integrated({ id: `astra-${index}`, profile: astra, configId: "cfg-astra", area: "other" }));
  });
  recorder(store).recordStart(startOf(run, taskOf("task-a")));
  const payload = rowsOf(store, run.id, "task-a")[0]!.payload as RoutingPayload;
  const counted = (id: string) => payload.candidates.find(candidate => candidate.profileId === id)?.posterior?.rows.production;
  assert.equal(counted("oc-high"), 3);
  assert.equal(counted("astra-xhigh"), 2);
}));

test("without its evidence store the recorder logs the reason once and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-broken-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "evidence"), "not a directory");
    const broken = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: Buffer.alloc(32, 7) });
    const run = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup));
    const lines: string[] = [];
    const rec = recorder(broken, lines);
    assert.doesNotThrow(() => rec.recordStart(startOf(run, taskOf("task-a", { agentProfileId: "astra-xhigh" }))));
    assert.doesNotThrow(() => rec.recordStart(startOf(run, taskOf("task-b", { agentProfileId: "astra-xhigh" }))));
    assert.deepEqual(lines, [UNAVAILABLE]);
    broken.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each module missing on its own logs the unavailable line and writes no row", () => {
  const run = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup));
  const registrations: [string, (store: EvidenceStore) => void][] = [
    ["outcomes", store => { store.register(configurationModule()); store.register(routingModule()); }],
    ["configurations", store => { store.register(outcomeModule({ now: () => NOW })); store.register(routingModule()); }],
    ["routing", store => { store.register(configurationModule()); store.register(outcomeModule({ now: () => NOW })); }],
  ];
  for (const [missing, register] of registrations) {
    withStore(store => {
      const lines: string[] = [];
      const rec = recorder(store, lines);
      rec.recordStart(startOf(run, taskOf("task-c", { agentProfileId: "astra-xhigh" })));
      rec.recordStart(startOf(run, taskOf("task-d", { agentProfileId: "astra-xhigh" })));
      assert.deepEqual(lines, [UNAVAILABLE], `${missing} missing`);
      assert.equal(store.status().modules[missing], undefined, `${missing} is not registered`);
      assert.equal(store.status().modules.routing === "ready" ? countRows(store) : 0, 0);
    }, register);
  }
});

test("a failed read is caught, logged once, and writes no row", () => withStore(store => {
  const run = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup));
  const lines: string[] = [];
  const rec = recorder(store, lines);
  const original = store.read.bind(store) as EvidenceStore["read"];
  (store as { read: EvidenceStore["read"] }).read = (() => { throw new Error("database is locked"); }) as EvidenceStore["read"];
  try {
    assert.doesNotThrow(() => rec.recordStart(startOf(run, taskOf("task-a"))));
    assert.doesNotThrow(() => rec.recordStart(startOf(run, taskOf("task-b"))));
  } finally {
    (store as { read: EvidenceStore["read"] }).read = original;
  }
  assert.deepEqual(lines, [FAILED]);
  assert.equal(countRows(store), 0);
}));

test("a payload over its limit logs its own line once and writes no row", () => withStore(store => {
  const routing = pinRouting(undefined, "autonomous", mixedLineup)!;
  const padded = { ...routing, knobs: { ...routing.knobs, padding: "x".repeat(PAYLOAD_LIMIT_BYTES) } } as unknown as typeof routing;
  const run = runOf(mixedLineup, padded, "run-large");
  const lines: string[] = [];
  const rec = recorder(store, lines);
  rec.recordStart(startOf(run, taskOf("task-a")));
  rec.recordStart(startOf(run, taskOf("task-b")));
  assert.deepEqual(lines, [TOO_LARGE]);
  assert.equal(countRows(store), 0);
}));

test("a decision over its budget writes no row", () => withStore(store => {
  const routing = pinRouting(undefined, "autonomous", mixedLineup);
  const run = runOf(mixedLineup, routing, "run-budget");
  const lines: string[] = [];
  const over = [0, 251];
  const rec = recorder(store, lines, () => over.shift() ?? 0);
  rec.recordStart(startOf(run, taskOf("task-a", { agentProfileId: "astra-xhigh" })));
  assert.equal(countRows(store), 0);
  assert.deepEqual(lines, ["Routing shadow decision skipped: it took longer than 250 ms."]);
  over.push(0, 251);
  rec.recordStart(startOf(run, taskOf("task-b", { agentProfileId: "astra-xhigh" })));
  assert.equal(countRows(store), 0);
  assert.equal(lines.length, 1, "the budget line is logged once per recorder");

  const within = [0, 249];
  recorder(store, [], () => within.shift() ?? 0).recordStart(startOf(run, taskOf("task-c", { agentProfileId: "astra-xhigh" })));
  assert.equal(countRows(store), 1);
  assert.equal(rowsOf(store, run.id, "task-c")[0]?.payload?.elapsedMs, 249);
}));

test("the budget allows exactly 250 ms, and a reused row logs nothing", () => withStore(store => {
  const run = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), "run-edge");
  const lines: string[] = [];
  const ticks = [0, 250];
  const rec = recorder(store, lines, () => ticks.shift() ?? 0);
  rec.recordStart(startOf(run, taskOf("task-a")));
  assert.equal(rowsOf(store, run.id, "task-a")[0]?.payload?.elapsedMs, 250);
  rec.recordStart(startOf(run, taskOf("task-a")));
  assert.equal(countRows(store), 1);
  assert.deepEqual(lines, []);
}));

test("an uncovered start writes no row", () => withStore(store => {
  const contributorOnly: TeamLineup = { ...mixedLineup, implementers: [mixedLineup.implementers[0]!] };
  const run = runOf(contributorOnly, pinRouting(undefined, "autonomous", contributorOnly), "run-uncovered");
  const lines: string[] = [];
  recorder(store, lines).recordStart(startOf(run, taskOf("task-a")));
  assert.equal(countRows(store), 0);
  assert.deepEqual(lines, []);

  let reads = 0;
  const original = store.read.bind(store) as EvidenceStore["read"];
  (store as { read: EvidenceStore["read"] }).read = fn => { reads += 1; return original(fn); };
  try {
    recorder(store, lines).recordStart(startOf(runOf(mixedLineup, undefined, "run-off"), taskOf("task-b")));
  } finally {
    (store as { read: EvidenceStore["read"] }).read = original;
  }
  assert.equal(reads, 0);
  assert.equal(countRows(store), 0);
  assert.deepEqual(lines, []);
}));

test("an advanced epoch makes that identity's rows earlier, OpenCode by its variant", () => withStore(store => {
  const openCode: TeamModelProfile = { id: "oc-high", label: "OpenCode", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high", tier: "light" };
  const astra = mixedLineup.implementers[1]!;
  const lineup: TeamLineup = { ...mixedLineup, implementers: [openCode, astra] };
  store.write(tx => {
    config(tx, "cfg-oc", openCode, versionOf(openCode));
    config(tx, "cfg-astra", astra, versionOf(astra));
    for (let index = 0; index < 3; index++) writeOutcome(tx, integrated({ id: `oc-${index}`, profile: openCode, configId: "cfg-oc" }));
    for (let index = 0; index < 2; index++) writeOutcome(tx, integrated({ id: `astra-${index}`, profile: astra, configId: "cfg-astra" }));
  });
  advanceEpoch(store, { profile: { provider: "opencode", model: openCode.model, effort: "high" },
    requestId: "6b0f4d0e-8a43-4d2c-9a37-3f1f0e3b9a11", now: ago(1) });
  const run = runOf(lineup, pinRouting(undefined, "autonomous", lineup), "run-epoch");
  recorder(store).recordStart(startOf(run, taskOf("task-a")));
  const payload = rowsOf(store, run.id, "task-a")[0]!.payload!;
  assert.deepEqual(payload.current.map(entry => [entry.identity, entry.epoch]), [[identityOf(openCode), 2], [identityOf(astra), 1]]);
  const posteriorOf = (id: string) => payload.candidates.find(candidate => candidate.profileId === id)!.posterior!;
  assert.deepEqual([posteriorOf("oc-high").rows.production, posteriorOf("oc-high").earlierRows], [0, 3]);
  assert.deepEqual([posteriorOf("astra-xhigh").rows.production, posteriorOf("astra-xhigh").earlierRows], [2, 0]);
}));

test("the objective digest flag chooses the prompt version the row records", () => withStore(store => {
  const astra = mixedLineup.implementers[1]!;
  const plain = versionOf(astra), withRecord = promptVersion("implementer", astra.provider, astra, false, false, true);
  assert.notEqual(plain, withRecord, "the record digest changes the prompt version");
  const run = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), "run-objective");
  recorder(store).recordStart(startOf(run, taskOf("task-a", { agentProfileId: "astra-xhigh" }), { objectiveDigest: true }));
  const payload = rowsOf(store, run.id, "task-a")[0]!.payload!;
  assert.deepEqual(payload.current.map(entry => entry.promptVersion), [withRecord]);
}));

test("publishHeads and entryTools choose the prompt version the row is counted against", () => withStore(store => {
  const astra = mixedLineup.implementers[1]!;
  store.write(tx => {
    config(tx, "cfg-heads", astra, versionOf(astra, true, true));
    for (let index = 0; index < 2; index++) writeOutcome(tx, integrated({ id: `heads-${index}`, profile: astra, configId: "cfg-heads" }));
  });
  const run = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), "run-heads");
  recorder(store).recordStart(startOf(run, taskOf("task-a"), { publishHeads: true, entryTools: true }));
  const payload = rowsOf(store, run.id, "task-a")[0]!.payload!;
  assert.deepEqual(payload.current.map(entry => entry.promptVersion), [versionOf(astra, true, true)]);
  assert.equal(payload.candidates.find(candidate => candidate.profileId === "astra-xhigh")!.posterior!.rows.production, 2);
}));

test("a limited provider changes the screening: with every eligible provider limited the default profile is chosen", () => withStore(store => {
  const run = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), "run-limited");
  const lines: string[] = [];
  recorder(store, lines).recordStart(startOf(run, taskOf("task-a"), { limited: new Set(["codex"]) }));
  const row = rowsOf(store, run.id, "task-a")[0];
  assert.deepEqual([row?.basis, row?.chosenProfileId, row?.greedyProfileId, lines], ["default-all-limited", "astra-xhigh", "astra-xhigh", []]);
}));

test("the row and payload record the choice, the refs, the time, the current configurations, and tier costs", () => withStore(store => {
  const routing = pinRouting({ allowContributor: true }, "autonomous", mixedLineup)!;
  const run = runOf(mixedLineup, routing, "run-fields");
  const rec = recorder(store);
  const explored = new Set<boolean>();
  for (let index = 0; index < 16; index++) {
    rec.recordStart(startOf(run, taskOf(`task-${index}`, { agentProfileId: "spark-high" })));
    const row = rowsOf(store, run.id, `task-${index}`)[0]!;
    assert.equal(row.basis, "sampled");
    assert.equal(row.explore, row.chosenProfileId !== row.greedyProfileId);
    explored.add(row.explore);
    const chosen = mixedLineup.implementers.find(profile => profile.id === row.chosenProfileId)!;
    assert.equal(row.chosenIdentity, identityOf(chosen));
    assert.equal(row.decidedAt, NOW);
    const refs = store.read(db => [db.index("project", "rehearsal"), db.index("area", AREA), db.index("feature-map", "default")]);
    assert.deepEqual([row.projectRef, row.areaRef, row.featureMapRef], refs);
    const payload = row.payload!;
    assert.equal(payload.coordinatorProfileId, "spark-high");
    assert.deepEqual(payload.current, mixedLineup.implementers.map(profile => ({ identity: identityOf(profile), epoch: 1, promptVersion: versionOf(profile) })));
    assert.deepEqual(payload.candidates.map(candidate => candidate.costUsd), mixedLineup.implementers.map(profile => TIER_COSTS[profile.tier ?? "light"]));
  }
  assert.deepEqual([...explored].sort(), [false, true], "some starts explore and some do not");
}));

test("the feature map and the task's risk reach the decision", () => withStore(store => {
  const map: FeatureMap = { areas: [{ id: "host", paths: ["packages/host"] }] };
  const run = runOf(mixedLineup, pinRouting({ allowContributor: true }, "autonomous", mixedLineup), "run-map");
  recorder(store).recordStart(startOf(run, taskOf("task-a", { risk: "elevated" }), { featureMap: map }));
  const row = rowsOf(store, run.id, "task-a")[0]!;
  assert.deepEqual([row.payload?.area, row.payload?.featureMap, row.risk, row.basis], ["host", featureMapDigest(map), "elevated", "greedy-risk"]);
  assert.equal(row.featureMapRef, store.read(db => db.index("feature-map", featureMapDigest(map))));
}));

test("a row ended 30 days ago counts at the half-life weight times the chosen weight", () => withStore(store => {
  const astra = mixedLineup.implementers[1]!;
  store.write(tx => {
    config(tx, "cfg-astra", astra, versionOf(astra));
    writeOutcome(tx, integrated({ id: "month", profile: astra, configId: "cfg-astra", endedAt: ago(30) }));
  });
  const run = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), "run-month");
  recorder(store).recordStart(startOf(run, taskOf("task-a")));
  const posterior = rowsOf(store, run.id, "task-a")[0]!.payload!.candidates.find(candidate => candidate.profileId === "astra-xhigh")!.posterior!;
  assert.equal(posterior.rows.production, 1);
  assert.equal(posterior.reward.find(record => record.level === "cell")!.observed.success, 0.25);
}));

test("two profiles of one identity share the first one's prompt version", () => withStore(store => {
  const astra = mixedLineup.implementers[1]!;
  const twin: TeamModelProfile = { ...astra, id: "astra-twin", label: "Astra twin", tier: "strong" };
  const lineup: TeamLineup = { ...mixedLineup, implementers: [astra, twin] };
  const run = runOf(lineup, pinRouting(undefined, "autonomous", lineup), "run-twin");
  recorder(store).recordStart(startOf(run, taskOf("task-a")));
  const payload = rowsOf(store, run.id, "task-a")[0]!.payload!;
  assert.notEqual(versionOf(astra), versionOf(twin));
  assert.deepEqual(payload.current, [{ identity: identityOf(astra), epoch: 1, promptVersion: versionOf(astra) }]);
  assert.deepEqual(payload.candidates.map(candidate => candidate.costUsd), [TIER_COSTS.light, TIER_COSTS.light]);
}));

test("the same run and task at revision 2 writes a second row, and each row keeps its own revision", () => withStore(store => {
  const routing = pinRouting({ allowContributor: true }, "autonomous", mixedLineup);
  const run1 = runOf(mixedLineup, routing, "run-replan");
  const run2 = { ...run1, revision: 2 } as unknown as TeamRun;
  const task = taskOf("task-a", { agentProfileId: "spark-high" });
  const rec = recorder(store);
  rec.recordStart(startOf(run1, task));
  rec.recordStart(startOf(run2, task));
  const rows = store.read(db => taskDecisions(db, "run-replan", "task-a")).rows;
  assert.deepEqual(rows.map(row => row.revision), [1, 2]);
  assert.equal(rows[0]!.key, decisionKey("run-replan", 1, rows[0]!.taskKey, "start", 1));
  assert.equal(rows[1]!.key, decisionKey("run-replan", 2, rows[1]!.taskKey, "start", 1));
  assert.notEqual(rows[0]!.key, rows[1]!.key);
  assert.equal(countRows(store), 2);
}));

test("a strong profile is costed at the strong tier default", () => withStore(store => {
  const strong: TeamModelProfile = { ...mixedLineup.implementers[1]!, tier: "strong" };
  const lineup: TeamLineup = { ...mixedLineup, implementers: [strong] };
  const run = runOf(lineup, pinRouting(undefined, "autonomous", lineup), "run-strong");
  recorder(store).recordStart(startOf(run, taskOf("task-a")));
  const payload = rowsOf(store, run.id, "task-a")[0]!.payload!;
  assert.deepEqual([payload.candidates[0]!.costUsd, payload.costs.strongUsd], [TIER_COSTS.strong, TIER_COSTS.strong]);
}));

test("eight candidates with integrated rows at all three levels stay within the payload limit", () => withStore(store => {
  const pad = (text: string, length: number) => `${text}-${"x".repeat(length)}`.slice(0, length);
  const projectId = pad("project", 80);
  const taskId = pad("t", 40);
  const implementers: TeamModelProfile[] = Array.from({ length: 8 }, (_, index) => ({
    id: pad(`impl${index}`, 40), label: pad(`Implementer ${index}`, 100), provider: "codex", model: pad(`gpt-impl-${index}`, 120),
    effort: "xhigh", tier: index % 2 ? "strong" : "light",
  }));
  const lineup: TeamLineup = { ...mixedLineup, implementers };
  store.write(tx => {
    for (const [index, profile] of implementers.entries()) {
      config(tx, `cfg-${index}`, profile, versionOf(profile));
      const levels = [["cell", {}], ["project", { area: "elsewhere/" }], ["tenant", { projectId: "other" }]] as const;
      for (const [level, where] of levels) {
        for (let k = 0; k < 7; k++) {
          writeOutcome(tx, integrated({ id: `${index}-${level}-${k}`, profile, configId: `cfg-${index}`,
            endedAt: ago(1.37 * (k + 1) + index * 3.1), projectId, ...where }));
        }
      }
    }
  });
  const run = runOf(lineup, pinRouting(undefined, "autonomous", lineup), "run-eight", projectId);
  const lines: string[] = [];
  recorder(store, lines).recordStart(startOf(run, taskOf(taskId)));
  const row = rowsOf(store, run.id, taskId)[0];
  assert.deepEqual(lines, []);
  assert.ok(row?.payload, "one row");
  assert.ok(row.payload.candidates.every(candidate => candidate.posterior!.rows.production > 0 && candidate.posterior!.level === "cell"));
  const bytes = Buffer.byteLength(JSON.stringify(row.payload), "utf8");
  assert.ok(bytes <= PAYLOAD_LIMIT_BYTES, `payload is ${bytes} bytes`);
}));

test("a shadow decision counts an applied row in full, and an auto pin records no shadow row", () => withStore(store => {
  const astra = mixedLineup.implementers[1]!;
  store.write(tx => {
    config(tx, "cfg-astra", astra, versionOf(astra));
    writeOutcome(tx, integrated({ id: "applied-run", profile: astra, configId: "cfg-astra", endedAt: ago(2) }));
  });
  const tenantSuccess = (runId: string, taskId: string) => {
    const payload = rowsOf(store, runId, taskId)[0]!.payload as RoutingPayload;
    const candidate = payload.candidates.find(item => item.profileId === "astra-xhigh")!;
    return candidate.posterior!.reward.find(level => level.level === "cell")!.observed.success;
  };

  recorder(store).recordStart(startOf(runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), "run-base"), taskOf("task-base")));
  const before = tenantSuccess("run-base", "task-base");
  assert.ok(before > 0);

  const appliedTask = taskOf("task-applied");
  const applied = { ...runOf(mixedLineup, pinRouting({ mode: "auto" }, "supervised", mixedLineup, ago(20)), "applied-run"), tasks: [appliedTask], members: [] } as unknown as TeamRun;
  recorder(store).applyStart(startOf(applied, appliedTask));
  store.write(tx => { tx.run("UPDATE routing_decisions SET state='applied', member_id='m1' WHERE run_id=?", "applied-run"); });
  recorder(store).recordStart(startOf(runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), "run-after"), taskOf("task-after")));
  const after = tenantSuccess("run-after", "task-after");
  assert.ok(Math.abs(after - 2 * before) < 1e-12, `applied success ${after} is twice the half-weight ${before}`);

  const rows = countRows(store);
  const autoRun = runOf(mixedLineup, pinRouting({ mode: "auto", allowContributor: true }, "supervised", mixedLineup, ago(20)), "run-auto-skip");
  let reads = 0;
  const original = store.read.bind(store) as EvidenceStore["read"];
  (store as { read: EvidenceStore["read"] }).read = ((fn: Parameters<EvidenceStore["read"]>[0]) => { reads += 1; return original(fn); }) as EvidenceStore["read"];
  try {
    recorder(store).recordStart(startOf(autoRun, taskOf("task-skip")));
  } finally {
    (store as { read: EvidenceStore["read"] }).read = original;
  }
  assert.equal(reads, 0);
  assert.equal(countRows(store), rows);
}));

const POINT_LINEUP: TeamLineup = {
  ...mixedLineup,
  implementers: [
    mixedLineup.implementers[0]!,
    mixedLineup.implementers[1]!,
    { id: "haiku-light", label: "Haiku implementer", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" },
    { id: "opus-strong", label: "Opus implementer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  ],
  escalations: [
    { id: "opus-escalation", label: "Opus escalation", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
    { id: "astra-escalation", label: "Astra escalation", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" },
    { id: "sonnet-escalation", label: "Sonnet escalation", provider: "claude", model: "claude-sonnet-5-5", effort: "high", tier: "strong" },
    { id: "spark-escalation", label: "Spark escalation", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high", tier: "strong", dataUse: "contributor" },
  ],
};
const ASTRA_E = POINT_LINEUP.escalations![1]!;
const SONNET_E = POINT_LINEUP.escalations![2]!;
const ASTRA_I = POINT_LINEUP.implementers[1]!;
const ENDED = ago(20);
const POINTS_PIN = { mode: "auto", points: ["start", "escalation", "scout"] } as unknown as TeamRouting;
const AUTO_UNAVAILABLE = AUTO_LOG.unavailable;

const pointRun = (lineup: TeamLineup, routing: TeamRun["routing"], id: string) =>
  ({ id, revision: 1, projectId: "rehearsal", lineup, routing, events: [], tasks: [], members: [] }) as unknown as TeamRun;
const escalationInput = (run: TeamRun, task: TeamTask, ownProfileId: string | undefined, namedProfileId?: string): RouterEscalation =>
  ({ ...startOf(run, task), ownProfileId, namedProfileId });
const scoutOf = (id: string, agentProfileId?: string) =>
  ({ id, title: id, instructions: "look", ...(agentProfileId === undefined ? {} : { agentProfileId }) }) as unknown as TeamScout;
const scoutInput = (run: TeamRun, scout: TeamScout): RouterScout => ({ run, scout, featureMap: undefined, limited: new Set() });
const countReads = (store: EvidenceStore, fn: () => void): number => {
  const original = store.read.bind(store) as EvidenceStore["read"];
  let reads = 0;
  (store as { read: EvidenceStore["read"] }).read = ((callback: Parameters<EvidenceStore["read"]>[0]) => {
    reads += 1;
    return original(callback);
  }) as EvidenceStore["read"];
  try {
    fn();
  } finally {
    (store as { read: EvidenceStore["read"] }).read = original;
  }
  return reads;
};

function withBrokenStore(fn: (store: EvidenceStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-recorder-broken-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "evidence"), "not a directory");
    const broken = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: Buffer.alloc(32, 7) });
    try {
      fn(broken);
    } finally {
      broken.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedPointRows(store: EvidenceStore): void {
  const escalated = (spec: Parameters<typeof integrated>[0]): OutcomeRow => {
    const row = integrated(spec);
    return { ...row, payload: { ...row.payload, replaces: { memberId: "m0", cause: "escalation" } } };
  };
  store.write(tx => {
    for (let index = 0; index < 10; index++) writeOutcome(tx, escalated({ id: `esc-sonnet-${index}`, profile: SONNET_E, configId: "none", endedAt: NOW }));
    for (let index = 0; index < 10; index++) writeOutcome(tx, integrated({ id: `start-astra-${index}`, profile: ASTRA_E, configId: "none", endedAt: NOW }));
  });
}

test("a shadow pin of version 2 records the new points, and a version-1 pin records none", () => {
  withStore(store => {
    const shadow = pinRouting({ mode: "shadow", points: ["start", "escalation", "scout"] } as unknown as TeamRouting, "supervised", POINT_LINEUP);
    assert.equal(shadow?.algorithmVersion, 2);
    const run = pointRun(POINT_LINEUP, shadow, "run-shadow-points");
    const lines: string[] = [];
    const rec = recorder(store, lines);
    assert.equal(rec.routeEscalation(escalationInput(run, taskOf("task-s"), "astra-xhigh", "sonnet-escalation")), undefined);
    assert.equal(rec.routeScout(scoutInput(run, scoutOf("scout-s", "astra-xhigh"))), undefined);
    assert.deepEqual(lines, []);

    const [escalation] = rowsOf(store, run.id, "task-s");
    assert.equal(rowsOf(store, run.id, "task-s").length, 1);
    assert.equal(escalation?.point, "escalation");
    assert.equal(escalation?.mode, "shadow");
    assert.equal(escalation?.state, "recorded");
    assert.equal(escalation?.coordinatorProfileId, "sonnet-escalation");
    assert.equal(escalation?.algorithmVersion, 2);
    assert.equal(escalation?.memberId, null);
    const [scout] = rowsOf(store, run.id, "scout-s");
    assert.equal(rowsOf(store, run.id, "scout-s").length, 1);
    assert.equal(scout?.point, "scout");
    assert.equal(scout?.role, "scout");
    assert.equal(scout?.state, "recorded");
    assert.equal(scout?.coordinatorProfileId, "astra-xhigh");
    assert.equal(store.read(db => shadowProgress(db, "rehearsal")).decisions, 0);

    const before = countRows(store);
    const v1 = pinRouting({ mode: "shadow", points: ["start"] } as unknown as TeamRouting, "supervised", POINT_LINEUP);
    assert.equal(v1?.algorithmVersion, 1);
    const old = pointRun(POINT_LINEUP, v1, "run-shadow-v1");
    const v1Rec = recorder(store, lines);
    assert.equal(v1Rec.routeEscalation(escalationInput(old, taskOf("task-v1"), "astra-xhigh", "sonnet-escalation")), undefined);
    assert.equal(v1Rec.routeScout(scoutInput(old, scoutOf("scout-v1", "astra-xhigh"))), undefined);
    assert.equal(countRows(store), before, "a version-1 pin writes no row at a new point");
    const older = pointRun(POINT_LINEUP, { ...shadow!, algorithmVersion: 1 }, "run-shadow-older");
    assert.equal(v1Rec.routeEscalation(escalationInput(older, taskOf("task-older"), "astra-xhigh", "sonnet-escalation")), undefined);
    assert.equal(v1Rec.routeScout(scoutInput(older, scoutOf("scout-older", "astra-xhigh"))), undefined);
    assert.equal(countRows(store), before, "a version-1 pin that lists the new points writes no row at them");
    const scoutOnly = pinRouting({ mode: "shadow", points: ["start", "scout"] } as unknown as TeamRouting, "supervised", POINT_LINEUP);
    assert.equal(scoutOnly?.algorithmVersion, 2);
    const partial = pointRun(POINT_LINEUP, scoutOnly, "run-shadow-scout-only");
    assert.equal(v1Rec.routeEscalation(escalationInput(partial, taskOf("task-partial"), "astra-xhigh")), undefined);
    assert.equal(countRows(store), before, "an escalation the pin does not list writes no row");
    assert.deepEqual(lines, []);
  });

  withBrokenStore(store => {
    const shadow = pinRouting({ mode: "shadow", points: ["start", "escalation", "scout"] } as unknown as TeamRouting, "supervised", POINT_LINEUP);
    const run = pointRun(POINT_LINEUP, shadow, "run-shadow-broken");
    const lines: string[] = [];
    const rec = recorder(store, lines);
    assert.doesNotThrow(() => rec.routeEscalation(escalationInput(run, taskOf("task-b"), "astra-xhigh", "sonnet-escalation")));
    assert.doesNotThrow(() => rec.routeScout(scoutInput(run, scoutOf("scout-b", "astra-xhigh"))));
    assert.deepEqual(lines, [UNAVAILABLE]);
  });
});

test("an auto run routes covered points, a revoked run falls back without a run line, and an uncovered run follows today's path", () => withStore(store => {
  seedPointRows(store);
  const routing = pinRouting(POINTS_PIN, "supervised", POINT_LINEUP, ENDED)!;
  const lines: string[] = [];
  const rec = recorder(store, lines);

  const run = pointRun(POINT_LINEUP, routing, "run-covered");
  assert.deepEqual(rec.routeEscalation(escalationInput(run, taskOf("task-e"), "astra-xhigh")), SONNET_E);
  const scout = scoutOf("scout-1");
  assert.deepEqual(rec.routeScout(scoutInput(run, scout)), ASTRA_I);
  assert.deepEqual(scout.routing, { profileId: "astra-xhigh", by: "router" });
  const rowsCovered = countRows(store);
  assert.equal(countReads(store, () => { assert.deepEqual(rec.routeScout(scoutInput(run, scout)), ASTRA_I); }), 0);
  assert.equal(countRows(store), rowsCovered);
  assert.deepEqual(run.events, [], "a router pick writes no run line");
  assert.deepEqual(lines, []);

  const revoked = { ...pointRun(POINT_LINEUP, routing, "run-revoked"), routingRevokedAt: NOW } as unknown as TeamRun;
  assert.deepEqual(rec.routeEscalation(escalationInput(revoked, taskOf("task-r"), "astra-xhigh")), ASTRA_E);
  const revokedScout = scoutOf("scout-r");
  assert.deepEqual(rec.routeScout(scoutInput(revoked, revokedScout)), ASTRA_I);
  assert.deepEqual(revokedScout.routing, { profileId: "astra-xhigh", by: "fallback" });
  assert.equal(rec.routeEscalation(escalationInput(revoked, taskOf("task-r2"), "astra-xhigh", "sonnet-escalation")), undefined);
  assert.equal(rec.routeScout(scoutInput(revoked, scoutOf("scout-r2", "haiku-light"))), undefined);
  assert.equal(countRows(store), rowsCovered, "the revoked fallbacks write no row");
  assert.deepEqual(revoked.events, [], "a revoked fallback writes no run line");
  assert.deepEqual(lines, []);

  const onlyOpus = { ...POINT_LINEUP, escalations: [POINT_LINEUP.escalations![0]!] };
  const uncovered = pointRun(onlyOpus, pinRouting(POINTS_PIN, "supervised", onlyOpus, ENDED), "run-uncovered");
  assert.equal(rec.routeEscalation(escalationInput(uncovered, taskOf("task-u"), "astra-xhigh")), undefined);
  const sonnetOnly = { ...POINT_LINEUP, escalations: [SONNET_E] };
  const ownOnly = pointRun(sonnetOnly, pinRouting(POINTS_PIN, "supervised", sonnetOnly, ENDED), "run-own-only");
  assert.equal(rec.routeEscalation(escalationInput(ownOnly, taskOf("task-o"), SONNET_E.id)), undefined);
  const v1 = pointRun(POINT_LINEUP, pinRouting({ mode: "auto", points: ["start"] } as unknown as TeamRouting, "supervised", POINT_LINEUP, ENDED), "run-v1");
  assert.equal(rec.routeEscalation(escalationInput(v1, taskOf("task-v"), "astra-xhigh")), undefined);
  assert.equal(countRows(store), rowsCovered, "an uncovered run writes no row");
  assert.deepEqual(lines, []);
}));

test("a fallback at a new point writes one run line and logs once per reason", () => withBrokenStore(store => {
  const routing = pinRouting(POINTS_PIN, "supervised", POINT_LINEUP, ENDED)!;
  const run = pointRun(POINT_LINEUP, routing, "run-broken");
  const lines: string[] = [];
  const rec = recorder(store, lines);
  assert.deepEqual(rec.routeEscalation(escalationInput(run, taskOf("task-a"), "astra-xhigh")), ASTRA_E);
  assert.deepEqual(rec.routeEscalation(escalationInput(run, taskOf("task-b"), "astra-xhigh")), ASTRA_E);
  assert.deepEqual(lines, [AUTO_UNAVAILABLE], "the escalation fallback logs its reason");
  const scoutA = scoutOf("scout-a");
  assert.deepEqual(rec.routeScout(scoutInput(run, scoutA)), ASTRA_I);
  assert.deepEqual(rec.routeScout(scoutInput(run, scoutOf("scout-b"))), ASTRA_I);
  assert.deepEqual(scoutA.routing, { profileId: "astra-xhigh", by: "fallback" });
  assert.deepEqual(run.events.map(event => event.text), [
    `Host routing could not choose an escalation profile for task task-a; it is assigned ${ASTRA_E.label}.`,
    `Host routing could not choose an escalation profile for task task-b; it is assigned ${ASTRA_E.label}.`,
    `Host routing could not choose a profile for scout scout-a; it is assigned ${ASTRA_I.label}.`,
    `Host routing could not choose a profile for scout scout-b; it is assigned ${ASTRA_I.label}.`,
  ]);
  assert.deepEqual(lines, [AUTO_UNAVAILABLE]);
}));
