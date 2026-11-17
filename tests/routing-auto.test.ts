import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileIdentityKey, promptVersion } from "../packages/host/src/config-identity.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceTx } from "../packages/host/src/evidence/types.js";
import { outcomeModule, writeOutcome, type OutcomePayload, type OutcomeRow } from "../packages/host/src/outcome-store.js";
import { AUTO_LOG } from "../packages/host/src/routing-auto.js";
import { shareAllows } from "../packages/host/src/routing-guards.js";
import { pinRouting, type TeamRouting } from "../packages/host/src/routing-policy.js";
import { RoutingRecorder, type RouterStart } from "../packages/host/src/routing-recorder.js";
import { escalationFallback, scoutFallback, spareAttempts } from "../packages/host/src/routing-rules.js";
import {
  markPeriodEnded, PAYLOAD_LIMIT_BYTES, readProjectState, routingModule, setExplorePause, shareWindow, taskDecisions,
} from "../packages/host/src/routing-store.js";
import { decideAutoEscalation, decideAutoScout, type RouterEscalation, type RouterScout } from "../packages/host/src/routing-points.js";
import type { AutoDecision } from "../packages/host/src/routing-auto.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import type { TeamLineup, TeamModelProfile, TeamRun, TeamScout, TeamTask } from "../packages/host/src/team-types.js";
import type { TeamRunRouting } from "../packages/host/src/routing-types.js";
import { mixedLineup } from "./team-fixture.js";

const NOW = "2026-11-15T12:00:00.000Z";
const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
/** A period that ended 20 days ago, so an auto pin is taken. */
const ENDED = ago(20);
const PATHS = ["packages/host/src/a.ts"];
const AREA = "host";

const LINE = {
  unavailable: AUTO_LOG.unavailable,
  budget: AUTO_LOG.budget,
  tooLarge: AUTO_LOG.tooLarge,
  write: AUTO_LOG.write,
  failed: AUTO_LOG.failed,
  pin: AUTO_LOG.pin,
  uncovered: AUTO_LOG.uncovered,
};
const runLine = (task: string, label: string) => `Host routing could not choose a profile for task ${task}; it is assigned ${label}.`;

const ALL = (store: EvidenceStore) => {
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => NOW }));
  store.register(routingModule());
};

/** A fresh store with the modules `register` adds. A fixed vault key keeps the blind indexes stable. */
function withStore(fn: (store: EvidenceStore) => void, register: (store: EvidenceStore) => void = ALL): void {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-auto-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: Buffer.alloc(32, 7) });
  try {
    register(store);
    fn(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A store whose evidence directory is a file, so it opens unavailable. */
function withBrokenStore(fn: (store: EvidenceStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-auto-broken-"));
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

const runOf = (lineup: TeamLineup, routing: TeamRunRouting | undefined, id = "run-1", projectId = "rehearsal") =>
  ({ id, revision: 1, projectId, lineup, routing, tasks: [], members: [], events: [] }) as unknown as TeamRun;
const taskOf = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, instructions: "do it", paths: PATHS, dependsOn: [], revision: 1, status: "pending", ...extra }) as unknown as TeamTask;
const startOf = (run: TeamRun, task: TeamTask, extra: Partial<RouterStart> = {}): RouterStart =>
  ({ run, task, publishHeads: false, entryTools: false, objectiveDigest: false, featureMap: undefined, limited: new Set(), ...extra });
const recorder = (store: EvidenceStore, lines: string[] = [], clock?: () => number) =>
  new RoutingRecorder({ store, now: () => NOW, clock, log: line => lines.push(line) });
const rowsOf = (store: EvidenceStore, runId: string, taskId: string) => store.read(db => taskDecisions(db, runId, taskId)).rows;
const countRows = (store: EvidenceStore) => store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM routing_decisions")?.n ?? 0);
const effortOf = (profile: TeamModelProfile) => ("effort" in profile ? profile.effort : profile.variant) ?? null;
const identityOf = (profile: TeamModelProfile) => profileIdentityKey({ provider: profile.provider, model: profile.model, effort: effortOf(profile) });
const versionOf = (profile: TeamModelProfile) => promptVersion("implementer", profile.provider, profile, false, false);

/** Counts the store's `read` calls made while `fn` runs. */
function countReads(store: EvidenceStore, fn: () => void): number {
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
}

/** Counts the store's `tryWrite` calls made while `fn` runs. */
function countWrites(store: EvidenceStore, fn: () => void): number {
  const original = store.tryWrite.bind(store) as EvidenceStore["tryWrite"];
  let writes = 0;
  (store as { tryWrite: EvidenceStore["tryWrite"] }).tryWrite = ((callback: Parameters<EvidenceStore["tryWrite"]>[0]) => {
    writes += 1;
    return original(callback);
  }) as EvidenceStore["tryWrite"];
  try {
    fn();
  } finally {
    (store as { tryWrite: EvidenceStore["tryWrite"] }).tryWrite = original;
  }
  return writes;
}

function config(tx: EvidenceTx, id: string, profile: TeamModelProfile, version: string): void {
  tx.run("INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
    + "VALUES (?, ?, ?, ?, ?, 'g', 'k', 'off', 's', ?)", id, profile.provider, profile.model, effortOf(profile), version, NOW);
}

/** An implementer start that integrated, was held, and froze. */
function integrated(spec: { id: string; profile: TeamModelProfile; configId: string; endedAt?: string; area?: string }): OutcomeRow {
  const payload: OutcomePayload = { projectId: "rehearsal", taskId: "task-x", area: spec.area ?? AREA, featureMap: "default",
    rounds: { run: 1, attributed: 1, unknown: 0 }, limitEvents: 0, costCoverage: "none" };
  const endedAt = spec.endedAt ?? ago(2);
  return {
    outcomeId: `${spec.id}:m1`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: spec.id, revision: 1, memberId: "m1",
    sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: spec.profile.id, provider: spec.profile.provider,
    model: spec.profile.model, effort: effortOf(spec.profile), profileEpoch: 1, configId: spec.configId, experimentRef: null,
    kind: null, risk: "normal", featureVersion: 1, disposition: "integrated", exclusion: null, flags: [],
    integrated: 1, accepted: 1, acceptance: 1, firstPass: 1, held: 1, startedAt: new Date(Date.parse(endedAt) - 3_600_000).toISOString(),
    endedAt, frozenAt: endedAt, holdUntil: null, runDeletedAt: null, payload,
  };
}

test("an auto start writes one pending row and returns its choice", () => withStore(store => {
  const routing = pinRouting({ mode: "auto", allowContributor: true }, "supervised", mixedLineup, ENDED)!;
  assert.equal(routing.mode, "auto");
  const run = runOf(mixedLineup, routing, "run-auto-1");
  const a = taskOf("task-a", { agentProfileId: "spark-high" });
  const b = taskOf("task-b");
  run.tasks.push(a, b);
  const rec = recorder(store);
  const chosenA = rec.applyStart(startOf(run, a))!;
  const chosenB = rec.applyStart(startOf(run, b))!;
  assert.ok(chosenA && chosenB);

  const rowA = rowsOf(store, run.id, "task-a");
  assert.equal(rowA.length, 1, "one row for task a");
  const row = rowA[0]!;
  assert.equal(row.mode, "auto");
  assert.equal(row.state, "pending");
  assert.equal(row.memberId, null);
  assert.equal(row.coordinatorProfileId, "spark-high");
  assert.equal(row.policyDigest, routing.digest);
  assert.equal(row.chosenProfileId, chosenA.id);
  assert.equal(row.explore, false, "the first decision never explores");
  assert.equal(row.basis, "greedy-share", "an empty window refuses exploration");
  assert.deepEqual(a.routing, { profileId: chosenA.id, by: "router" });
  assert.deepEqual(row.payload?.guards, { pausedAt: null, spareAttempts: spareAttempts(run), share: { exploratory: 0, of: 0 } });

  const rowB = rowsOf(store, run.id, "task-b")[0]!;
  assert.equal(rowB.coordinatorProfileId, null);
  assert.equal(rowB.chosenProfileId, chosenB.id);
  assert.deepEqual(b.routing, { profileId: chosenB.id, by: "router" });
  assert.equal(countRows(store), 2);
}));

test("an off run and a shadow run apply no profile and read nothing", () => withStore(store => {
  const rec = recorder(store);
  const off = runOf(mixedLineup, pinRouting(undefined, "supervised", mixedLineup), "run-off");
  const shadow = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), "run-shadow");
  for (const run of [off, shadow]) {
    const task = taskOf("task-x");
    run.tasks.push(task);
    let chosen: TeamModelProfile | undefined = mixedLineup.implementers[0];
    const reads = countReads(store, () => { chosen = rec.applyStart(startOf(run, task)); });
    assert.equal(chosen, undefined);
    assert.equal(reads, 0);
    assert.equal(task.routing, undefined);
  }
  assert.equal(countRows(store), 0);
}));

test("a second start reuses the pending row and the task's routing", () => withStore(store => {
  const routing = pinRouting({ mode: "auto", allowContributor: true }, "supervised", mixedLineup, ENDED)!;
  const run = runOf(mixedLineup, routing, "run-reuse");
  const a = taskOf("task-a", { agentProfileId: "spark-high" });
  run.tasks.push(a);
  const rec = recorder(store);
  const first = rec.applyStart(startOf(run, a))!;
  const before = rowsOf(store, run.id, "task-a")[0]!;

  // Thirty counted rows for the astra identity arrive between the two starts, so a fresh decision would differ.
  store.write(tx => {
    for (let index = 0; index < 30; index++) {
      writeOutcome(tx, integrated({ id: `late-${index}`, profile: mixedLineup.implementers[1]!, configId: "none", endedAt: NOW }));
    }
  });

  // A lost save: the task's routing is gone, but the row is still there.
  delete a.routing;
  let second: TeamModelProfile | undefined;
  // The stored row answers the read, so the start writes nothing.
  assert.equal(countWrites(store, () => { second = rec.applyStart(startOf(run, a)); }), 0);
  assert.equal(second!.id, first.id);
  assert.equal(countRows(store), 1);
  assert.deepEqual(rowsOf(store, run.id, "task-a")[0], before);
  assert.deepEqual(a.routing, { profileId: first.id, by: "router" });

  // With the task's routing kept, the start reads nothing at all.
  const reads = countReads(store, () => rec.applyStart(startOf(run, a)));
  assert.equal(reads, 0);
}));

test("every failure starts the fallback profile with one run line", () => {
  // The unavailable store: a is assigned its pick only when the pick passes, else astra; b is astra.
  withBrokenStore(store => {
    // The default profile is the first implementer that passes rules 1 and 2: astra, or spark when contributors are allowed.
  for (const [allowContributor, expectedA, expectedB] of [[false, "astra-xhigh", "astra-xhigh"], [true, "spark-high", "spark-high"]] as const) {
      const routing = pinRouting({ mode: "auto", allowContributor }, "supervised", mixedLineup, ENDED)!;
      const run = runOf(mixedLineup, routing, `run-unavailable-${allowContributor}`);
      const a = taskOf("a", { agentProfileId: "spark-high" });
      const b = taskOf("b");
      run.tasks.push(a, b);
      const lines: string[] = [];
      const rec = recorder(store, lines);
      const pa = rec.applyStart(startOf(run, a))!;
      const pb = rec.applyStart(startOf(run, b))!;
      assert.equal(pa.id, expectedA);
      assert.equal(pb.id, expectedB);
      assert.deepEqual(a.routing, { profileId: expectedA, by: "fallback" });
      assert.deepEqual(b.routing, { profileId: expectedB, by: "fallback" });
      assert.deepEqual(run.events.map(event => event.text), [runLine("a", pa.label), runLine("b", pb.label)]);
      assert.deepEqual(lines, [LINE.unavailable], "one log line per reason");
    }
  });

  withStore(store => {
    const routing = pinRouting({ mode: "auto" }, "supervised", mixedLineup, ENDED)!;
    const run = runOf(mixedLineup, routing, "run-budget");
    const a = taskOf("a", { agentProfileId: "astra-xhigh" });
    const b = taskOf("b");
    run.tasks.push(a, b);
    const lines: string[] = [];
    // Each decision reads the clock twice: 0 at its start, 251 at its end.
    let tick = 0;
    const rec = recorder(store, lines, () => (tick++ % 2 === 0 ? 0 : 251));
    const pa = rec.applyStart(startOf(run, a))!;
    const pb = rec.applyStart(startOf(run, b))!;
    assert.equal(pa.id, "astra-xhigh");
    assert.equal(pb.id, "astra-xhigh");
    assert.equal(a.routing?.by, "fallback");
    assert.equal(countRows(store), 0, "a decision over budget writes no row");
    assert.deepEqual(lines, [LINE.budget]);
    assert.equal(run.events.length, 2);
  });

  withStore(store => {
    const routing = pinRouting({ mode: "auto" }, "supervised", mixedLineup, ENDED)!;
    const padded = { ...routing, knobs: { ...routing.knobs, padding: "x".repeat(PAYLOAD_LIMIT_BYTES) } } as unknown as TeamRunRouting;
    const run = runOf(mixedLineup, padded, "run-large");
    const a = taskOf("a", { agentProfileId: "astra-xhigh" });
    run.tasks.push(a);
    const lines: string[] = [];
    const rec = recorder(store, lines);
    assert.equal(rec.applyStart(startOf(run, a))?.id, "astra-xhigh");
    assert.equal(a.routing?.by, "fallback");
    assert.equal(countRows(store), 0);
    assert.deepEqual(lines, [LINE.tooLarge]);
  });

  withStore(store => {
    const routing = pinRouting({ mode: "auto" }, "supervised", mixedLineup, ENDED)!;
    const run = runOf(mixedLineup, routing, "run-write");
    const a = taskOf("a", { agentProfileId: "astra-xhigh" });
    run.tasks.push(a);
    const lines: string[] = [];
    const rec = recorder(store, lines);
    (store as { tryWrite: unknown }).tryWrite = () => false;
    assert.equal(rec.applyStart(startOf(run, a))?.id, "astra-xhigh");
    assert.equal(a.routing?.by, "fallback");
    assert.deepEqual(lines, [LINE.write]);
    assert.equal(run.events.length, 1);
  });

  withStore(store => {
    const routing = pinRouting({ mode: "auto" }, "supervised", mixedLineup, ENDED)!;
    const run = runOf(mixedLineup, routing, "run-read");
    const a = taskOf("a", { agentProfileId: "astra-xhigh" });
    run.tasks.push(a);
    const lines: string[] = [];
    const rec = recorder(store, lines);
    (store as { read: unknown }).read = () => { throw new Error("database is locked"); };
    assert.equal(rec.applyStart(startOf(run, a))?.id, "astra-xhigh");
    assert.equal(a.routing?.by, "fallback");
    assert.deepEqual(lines, [LINE.failed]);
    assert.equal(run.events.length, 1);
  });
});

test("the guards make exploratory picks greedy in a real store, and the payload records them", () => withStore(store => {
  const routing = pinRouting({ mode: "auto", allowContributor: true }, "supervised", mixedLineup, ENDED)!;
  // Ten applied, non-exploratory starts fill the window.
  const seed = runOf(mixedLineup, routing, "run-seed");
  const seedRec = recorder(store);
  for (let index = 0; index < 10; index++) {
    const task = taskOf(`seed-${index}`);
    seed.tasks.push(task);
    seedRec.applyStart(startOf(seed, task));
  }
  store.write(tx => { tx.run("UPDATE routing_decisions SET state='applied', member_id='m', explore=0 WHERE run_id=?", seed.id); });

  const rec = recorder(store);
  const starts: { run: TeamRun; row: ReturnType<typeof rowsOf>[number] }[] = [];
  const start = (index: number) => {
    const run = runOf(mixedLineup, routing, `run-${index}`);
    const task = taskOf("task-a", { agentProfileId: "spark-high" });
    run.tasks.push(task);
    const before = store.read(db => shareWindow(db, "rehearsal", routing.knobs.exploreWindow, NOW));
    rec.applyStart(startOf(run, task));
    const row = rowsOf(store, run.id, "task-a")[0]!;
    starts.push({ run, row });
    return { before, row };
  };

  // Unpaused: some starts explore, and each exploratory one satisfies the share before it was taken.
  const unpaused = Array.from({ length: 50 }, (_, index) => start(index));
  const explored = unpaused.filter(item => item.row.explore);
  assert.ok(explored.length > 0, "some unpaused starts explore");
  for (const { before, row } of explored) {
    assert.equal(row.basis, "sampled");
    assert.ok(shareAllows(before, routing.knobs.maxExploreShare), "the share held at that start");
  }
  for (const { row } of unpaused) assert.equal(row.payload?.guards?.pausedAt, null);

  // Paused: no start explores, and every start that would have explored is greedy-paused.
  store.write(tx => { setExplorePause(tx, "rehearsal", NOW, NOW); });
  const paused = Array.from({ length: 50 }, (_, index) => start(100 + index));
  assert.equal(paused.filter(item => item.row.explore).length, 0);
  assert.ok(paused.some(item => item.row.basis === "greedy-paused"), "a paused start would have explored");
  for (const { row } of paused) {
    assert.ok(row.basis === "greedy-paused" || (row.basis === "sampled" && row.chosenProfileId === row.greedyProfileId));
    assert.equal(row.payload?.guards?.pausedAt, NOW);
  }
  // Every payload holds the spare attempts of its run.
  for (const { run, row } of starts) {
    assert.equal(row.payload?.guards?.spareAttempts, spareAttempts(run));
  }
  assert.equal(store.read(db => readProjectState(db, "rehearsal")).explorePausedAt, NOW);
}));

test("the pin is auto only after the stored period end, and refuses without coverage", () => withStore(store => {
  const lines: string[] = [];
  const pinner = new RoutingRecorder({ store, now: () => NOW, log: line => lines.push(line) });
  const saved: TeamRouting = { mode: "auto" };
  const contributorOnly: TeamLineup = { ...mixedLineup, implementers: [mixedLineup.implementers[0]!] };

  // Recorded starts decided at `at`. The first 49 leave the period open.
  const recordStarts = (prefix: string, count: number, at: string, projectId = "rehearsal") => {
    const shadowRun = runOf(mixedLineup, pinRouting(undefined, "autonomous", mixedLineup), `run-rec-${prefix}`, projectId);
    const recording = new RoutingRecorder({ store, now: () => at, log: () => undefined });
    for (let index = 0; index < count; index++) {
      recording.recordStart(startOf(shadowRun, taskOf(`${prefix}-${index}`, { agentProfileId: "astra-xhigh" })));
    }
  };

  // Fifty recorded starts 5 days ago meet the count, but the end, the first start plus 14 days, has not passed.
  recordStarts("early", 50, ago(5), "early");
  assert.deepEqual(pinner.pin(saved, "supervised", mixedLineup, "early"), pinRouting(saved, "supervised", mixedLineup));
  assert.equal(store.read(db => readProjectState(db, "early")).periodEndedAt, null, "no end is stored before it passes");

  recordStarts("a", 49, ago(15));
  assert.deepEqual(pinner.pin(saved, "supervised", mixedLineup, "rehearsal"), pinRouting(saved, "supervised", mixedLineup));
  assert.deepEqual(store.read(db => readProjectState(db, "rehearsal")), { periodEndedAt: null, explorePausedAt: null });

  // The 50th recorded start, 15 days ago, ends the period at its first start plus 14 days.
  recordStarts("a-last", 1, ago(15));
  const firstPin = pinner.pin(saved, "supervised", mixedLineup, "rehearsal") as Extract<TeamRunRouting, { mode: "auto" }>;
  assert.equal(firstPin.mode, "auto");
  assert.equal(firstPin.periodEndedAt, ago(1));
  assert.equal(firstPin.digest, pinRouting(saved, "supervised", mixedLineup, ago(1))!.digest);
  assert.equal(store.read(db => readProjectState(db, "rehearsal")).periodEndedAt, ago(1));

  // Retention removes the first 20 rows. The stored end does not move.
  store.write(tx => { tx.run("DELETE FROM routing_decisions WHERE key IN (SELECT key FROM routing_decisions ORDER BY decided_at, key LIMIT 20)"); });
  const secondPin = pinner.pin(saved, "supervised", mixedLineup, "rehearsal") as Extract<TeamRunRouting, { mode: "auto" }>;
  assert.equal(secondPin.periodEndedAt, ago(1));

  // A saved auto with no implementer that passes the fixed rules refuses.
  assert.throws(() => pinner.pin(saved, "supervised", contributorOnly, "rehearsal"), (error: unknown) =>
    error instanceof TeamError && error.status === 409 && error.code === "routing-no-eligible-profile");

  // The autonomous default never refuses: it pins shadow, logs its line once, and pins shadow over an all-contributor lineup.
  const defaultPin = pinner.pin(undefined, "autonomous", contributorOnly, "rehearsal");
  assert.deepEqual(defaultPin, pinRouting(undefined, "autonomous", contributorOnly));
  pinner.pin(undefined, "autonomous", contributorOnly, "rehearsal");
  assert.deepEqual(lines, [LINE.uncovered]);

  // A saved shadow, a supervised project without a policy, and a saved policy read no store.
  assert.equal(countReads(store, () => pinner.pin({ mode: "shadow" }, "autonomous", mixedLineup, "rehearsal")), 0);
  assert.equal(countReads(store, () => pinner.pin(undefined, "supervised", mixedLineup, "rehearsal")), 0);
}));

test("the pin is shadow when the routing module is missing, and logs its line once", () => {
  withStore(store => {
    const lines: string[] = [];
    const pinner = new RoutingRecorder({ store, now: () => NOW, log: line => lines.push(line) });
    const saved: TeamRouting = { mode: "auto" };
    assert.deepEqual(pinner.pin(saved, "supervised", mixedLineup, "rehearsal"), pinRouting(saved, "supervised", mixedLineup));
    pinner.pin(saved, "supervised", mixedLineup, "rehearsal");
    assert.deepEqual(lines, [LINE.pin]);
  }, store => { store.register(configurationModule()); store.register(outcomeModule({ now: () => NOW })); });
});

test("a stored period end is read from the table, and markPeriodEnded keeps the first write", () => withStore(store => {
  store.write(tx => { markPeriodEnded(tx, "rehearsal", ago(3), NOW); });
  store.write(tx => { markPeriodEnded(tx, "rehearsal", ago(1), NOW); });
  assert.equal(store.read(db => readProjectState(db, "rehearsal")).periodEndedAt, ago(3));
}));

/** The points lineup: spark is a contributor, astra has no tier, haiku is light, opus is strong and on the reviewer's model. */
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
const POINTS_PIN = { mode: "auto", points: ["start", "escalation", "scout"] } as unknown as TeamRouting;
const routingOf = () => pinRouting(POINTS_PIN, "supervised", POINT_LINEUP, ENDED)!;
const TASK = taskOf("task-e");
const SCOUT = ({ id: "scout-1", title: "scout", instructions: "look" }) as unknown as TeamScout;
const escalationOf = (run: TeamRun, task: TeamTask, ownProfileId: string | undefined, namedProfileId?: string): RouterEscalation =>
  ({ ...startOf(run, task), ownProfileId, namedProfileId });
const scoutOf = (run: TeamRun, scout: TeamScout): RouterScout => ({ run, scout, featureMap: undefined, limited: new Set() });

/** An integrated implementer row that replaced a member by escalation, so its point is `escalation`. */
const escalated = (spec: Parameters<typeof integrated>[0]): OutcomeRow => {
  const row = integrated(spec);
  return { ...row, payload: { ...row.payload, replaces: { memberId: "m0", cause: "escalation" } } };
};

test("an escalation decision is greedy over escalation evidence only, and writes one pending row", () => {
  withStore(store => {
    const routing = pinRouting(POINTS_PIN, "supervised", POINT_LINEUP, ENDED)!;
    assert.equal(routing.algorithmVersion, 2);
    const run = runOf(POINT_LINEUP, routing, "run-escalation");
    const task = taskOf("task-e");
    run.tasks.push(task);
    store.write(tx => {
      for (let index = 0; index < 10; index++) writeOutcome(tx, escalated({ id: `esc-sonnet-${index}`, profile: SONNET_E, configId: "none", endedAt: NOW }));
      // Start rows for astra-escalation's identity do not count at the escalation point.
      for (let index = 0; index < 10; index++) writeOutcome(tx, integrated({ id: `start-astra-${index}`, profile: ASTRA_E, configId: "none", endedAt: NOW }));
    });

    assert.deepEqual(decideAutoEscalation(store, escalationOf(run, task, "astra-xhigh"), () => NOW, () => 0), { profile: SONNET_E, by: "router" });
    const rows = rowsOf(store, run.id, "task-e");
    assert.equal(rows.length, 1, "one row for the escalation");
    const row = rows[0]!;
    assert.equal(row.point, "escalation");
    assert.equal(row.ordinal, 1);
    assert.equal(row.role, "implementer");
    assert.equal(row.mode, "auto");
    assert.equal(row.algorithmVersion, 2);
    assert.equal(row.state, "pending");
    assert.equal(row.basis, "greedy-point");
    assert.equal(row.explore, false);
    assert.match(row.seed, /^[0-9a-f]{64}$/);
    assert.equal(row.chosenProfileId, SONNET_E.id);
    assert.equal(row.greedyProfileId, SONNET_E.id);
    assert.equal(row.chosenIdentity, identityOf(SONNET_E));
    assert.equal(row.coordinatorProfileId, null);
    assert.equal(row.memberId, null);
    assert.equal(row.payload?.guards, undefined, "an escalation reads no guard");
    assert.deepEqual(
      row.payload?.candidates.map(candidate => [candidate.profileId, candidate.removed]),
      [["opus-escalation", "reviewer-model"], ["astra-escalation", undefined], ["sonnet-escalation", undefined], ["spark-escalation", "contributor"]],
    );
    assert.equal(countRows(store), 1);
  });

  // With no evidence, the two candidates tie and the first in lineup order wins.
  withStore(fresh => {
    const routing = pinRouting(POINTS_PIN, "supervised", POINT_LINEUP, ENDED)!;
    const run = runOf(POINT_LINEUP, routing, "run-tie");
    const task = taskOf("task-tie");
    run.tasks.push(task);
    assert.deepEqual(decideAutoEscalation(fresh, escalationOf(run, task, "astra-xhigh"), () => NOW, () => 0), { profile: ASTRA_E, by: "router" });
  });

  // Own profile sonnet-escalation, with the same evidence: the pick is astra-escalation, and sonnet is not a candidate.
  withStore(store => {
    const routing = pinRouting(POINTS_PIN, "supervised", POINT_LINEUP, ENDED)!;
    store.write(tx => {
      for (let index = 0; index < 10; index++) writeOutcome(tx, escalated({ id: `esc-sonnet-${index}`, profile: SONNET_E, configId: "none", endedAt: NOW }));
      for (let index = 0; index < 10; index++) writeOutcome(tx, integrated({ id: `start-astra-${index}`, profile: ASTRA_E, configId: "none", endedAt: NOW }));
    });
    const run = runOf(POINT_LINEUP, routing, "run-escalation-own");
    const task = taskOf("task-own");
    run.tasks.push(task);
    assert.deepEqual(decideAutoEscalation(store, escalationOf(run, task, SONNET_E.id), () => NOW, () => 0), { profile: ASTRA_E, by: "router" });
    const row = rowsOf(store, run.id, "task-own")[0]!;
    assert.equal(row.payload?.candidates.some(candidate => candidate.profileId === SONNET_E.id), false);

    // A named escalation profile does not steer the pick. The row records it beside the router's pick.
    const named = taskOf("task-named");
    run.tasks.push(named);
    assert.deepEqual(decideAutoEscalation(store, escalationOf(run, named, "astra-xhigh", ASTRA_E.id), () => NOW, () => 0), { profile: SONNET_E, by: "router" });
    const namedRow = rowsOf(store, run.id, "task-named")[0]!;
    assert.equal(namedRow.chosenProfileId, SONNET_E.id);
    assert.equal(namedRow.coordinatorProfileId, ASTRA_E.id);
  });
});

test("an applied escalation of the router's counts at full weight at the escalation point", () => withStore(store => {
  const routing = routingOf();
  const decide = (runId: string) => {
    const run = runOf(POINT_LINEUP, routing, runId);
    const task = taskOf(`task-${runId}`);
    run.tasks.push(task);
    return decideAutoEscalation(store, escalationOf(run, task, "astra-xhigh"), () => NOW, () => 0);
  };
  // With no evidence yet, the router picks astra four times. Those runs then integrate, as do six sonnet escalations.
  for (let index = 0; index < 4; index++) assert.deepEqual(decide(`esc-astra-${index}`), { profile: ASTRA_E, by: "router" });
  store.write(tx => {
    for (let index = 0; index < 4; index++) writeOutcome(tx, escalated({ id: `esc-astra-${index}`, profile: ASTRA_E, configId: "none", endedAt: NOW }));
    for (let index = 0; index < 6; index++) writeOutcome(tx, escalated({ id: `esc-sonnet-${index}`, profile: SONNET_E, configId: "none", endedAt: NOW }));
  });
  // Pending, the astra rows weigh 4 x 0.5 against sonnet's 6 x 0.5.
  assert.deepEqual(decide("run-pending"), { profile: SONNET_E, by: "router" });
  // Applied with their members, they weigh 4 x 1 against 6 x 0.5.
  store.write(tx => { tx.run("UPDATE routing_decisions SET state='applied', member_id='m1' WHERE run_id LIKE 'esc-astra-%'"); });
  assert.deepEqual(decide("run-applied"), { profile: ASTRA_E, by: "router" });
}));

test("a scout decision reads no outcome and writes one pending row", () => withStore(store => {
  const routing = pinRouting(POINTS_PIN, "supervised", POINT_LINEUP, ENDED)!;
  const run = runOf(POINT_LINEUP, routing, "run-scout");
  // Twenty integrated starts for the astra identity would move a posterior. A scout reads none of them.
  store.write(tx => {
    for (let index = 0; index < 20; index++) writeOutcome(tx, integrated({ id: `scout-start-${index}`, profile: POINT_LINEUP.implementers[1]!, configId: "none", endedAt: NOW }));
  });
  let chosen: AutoDecision | undefined;
  let reads = 0;
  assert.equal(countWrites(store, () => {
    reads = countReads(store, () => { chosen = decideAutoScout(store, scoutOf(run, SCOUT), () => NOW, () => 0); });
  }), 1, "one insert");
  assert.equal(reads, 1, "one read");
  assert.deepEqual(chosen, { profile: POINT_LINEUP.implementers[1], by: "router" }, "the cheapest candidate, astra, wins the tie with haiku");

  const rows = rowsOf(store, run.id, "scout-1");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.point, "scout");
  assert.equal(row.role, "scout");
  assert.equal(row.state, "pending");
  assert.equal(row.basis, "greedy-point");
  assert.equal(row.coordinatorProfileId, null);
  assert.equal(row.payload?.guards, undefined);
  assert.deepEqual(row.payload?.current, []);
  assert.deepEqual(
    row.payload?.candidates.map(candidate => [candidate.profileId, candidate.costUsd, candidate.posterior]),
    [["spark-high", undefined, undefined], ["astra-xhigh", 0.4, undefined], ["haiku-light", 0.4, undefined]],
  );
  assert.equal(countRows(store), 1);
}));

test("a second decision for one key reuses its row, even when its payload does not open", () => withStore(store => {
  const routing = pinRouting(POINTS_PIN, "supervised", POINT_LINEUP, ENDED)!;
  const run = runOf(POINT_LINEUP, routing, "run-repeat");
  const task = taskOf("task-repeat");
  run.tasks.push(task);
  store.write(tx => {
    for (let index = 0; index < 10; index++) writeOutcome(tx, escalated({ id: `repeat-sonnet-${index}`, profile: SONNET_E, configId: "none", endedAt: NOW }));
  });
  assert.deepEqual(decideAutoEscalation(store, escalationOf(run, task, "astra-xhigh"), () => NOW, () => 0), { profile: SONNET_E, by: "router" });
  assert.deepEqual(decideAutoScout(store, scoutOf(run, SCOUT), () => NOW, () => 0), { profile: POINT_LINEUP.implementers[1], by: "router" });

  // Thirty astra escalations would flip a fresh decision. The stored row is the answer, and its payload no longer opens.
  store.write(tx => {
    for (let index = 0; index < 30; index++) writeOutcome(tx, escalated({ id: `repeat-astra-${index}`, profile: ASTRA_E, configId: "none", endedAt: NOW }));
    tx.run("UPDATE routing_decisions SET encrypted_payload='not-sealed' WHERE run_id=?", run.id);
  });
  assert.deepEqual(decideAutoEscalation(store, escalationOf(run, task, "astra-xhigh"), () => NOW, () => 0), { profile: SONNET_E, by: "router" });
  assert.deepEqual(decideAutoScout(store, scoutOf(run, SCOUT), () => NOW, () => 0), { profile: POINT_LINEUP.implementers[1], by: "router" });
  assert.equal(countRows(store), 2, "one row per key");

  const [escalation] = rowsOf(store, run.id, "task-repeat");
  assert.equal(escalation?.chosenProfileId, SONNET_E.id);
  assert.equal(escalation?.payload, null, "the unreadable payload reads as null; the plain row still returns");
  assert.equal(rowsOf(store, run.id, "scout-1")[0]?.payload, null);
}));

test("every failure at a new point gives the fallback and its reason", () => {
  const padded = { ...routingOf(), knobs: { ...routingOf().knobs, padding: "x".repeat(PAYLOAD_LIMIT_BYTES) } } as unknown as TeamRunRouting;
  const decide = (kind: "escalation" | "scout", store: EvidenceStore, run: TeamRun, clock: () => number = () => 0): AutoDecision | undefined =>
    kind === "escalation"
      ? decideAutoEscalation(store, escalationOf(run, TASK, "astra-xhigh"), () => NOW, clock)
      : decideAutoScout(store, scoutOf(run, SCOUT), () => NOW, clock);
  const fallbackOf = (kind: "escalation" | "scout", run: TeamRun): TeamModelProfile | undefined =>
    kind === "escalation" ? escalationFallback(run, "astra-xhigh", undefined) : scoutFallback(run, SCOUT);
  const missingRouting = (store: EvidenceStore) => { store.register(configurationModule()); store.register(outcomeModule({ now: () => NOW })); };

  for (const kind of ["escalation", "scout"] as const) {
    const run = runOf(POINT_LINEUP, routingOf(), `run-fail-${kind}`);
    const expected = fallbackOf(kind, run)!;
    assert.ok(expected, "a fallback exists");

    withBrokenStore(store => assert.deepEqual(decide(kind, store, run), { profile: expected, by: "fallback", reason: "unavailable" }));
    withStore(store => assert.deepEqual(decide(kind, store, run), { profile: expected, by: "fallback", reason: "unavailable" }), missingRouting);

    withStore(store => {
      let tick = 0;
      assert.deepEqual(decide(kind, store, run, () => (tick++ % 2 === 0 ? 0 : 251)), { profile: expected, by: "fallback", reason: "budget" });
      assert.equal(countRows(store), 0, "a decision over budget writes no row");
    });

    const large = runOf(POINT_LINEUP, padded, `run-large-${kind}`);
    withStore(store => {
      assert.deepEqual(decide(kind, store, large), { profile: fallbackOf(kind, large)!, by: "fallback", reason: "tooLarge" });
      assert.equal(countRows(store), 0);
    });

    withStore(store => {
      (store as { tryWrite: unknown }).tryWrite = () => false;
      assert.deepEqual(decide(kind, store, run), { profile: expected, by: "fallback", reason: "write" });
    });

    withStore(store => {
      (store as { read: unknown }).read = () => { throw new Error("database is locked"); };
      assert.deepEqual(decide(kind, store, run), { profile: expected, by: "fallback", reason: "failed" });
    });
  }
});
