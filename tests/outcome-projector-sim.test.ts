import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { EventOutbox, type EventProjector, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceDb, RunEvent } from "../packages/host/src/evidence/types.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { levels, rowExclusion, roundCounts, type RowState, scanGap } from "../packages/host/src/outcome-rules.js";
import { linksOf, rowSignals } from "../packages/host/src/outcome-signals.js";
import { OUTCOME_KINDS, outcomeModule, readSummary, runOutcomes } from "../packages/host/src/outcome-store.js";
import { runEventKey } from "../packages/host/src/run-events.js";
import { bump, type Counts, type Rand, rand, RunScript } from "./outcome-sim-script.js";

/*
 * A seeded fault simulator for the outcome ledger projector (INF-309). Each seed scripts three team runs the way
 * TeamService emits their events (tests/outcome-sim-script.ts states each order it keeps or breaks), delivers them to
 * the real evidence store, outbox and projectors on temporary SQLite files under faults, and checks the invariants
 * below after every delivery, from the stored state alone. A failure names its seed and step. Line numbers in this
 * header are those of the sources as they stood when the simulator was written.
 *
 * What it checks, and what it does not: scheduling and stored-state consistency under restarts, replays, rollbacks,
 * gaps and the emitter's orders. It does not check that a handler applies the right rule. P1's reference store runs
 * every handler it compares against; P5 and P6 recount with production's helpers or a copy of their logic; P7 checks
 * gap propagation only where a gap is already recorded. Rule semantics stay with tests/outcome-projector.test.ts,
 * tests/outcome-rules.test.ts and tests/outcome-signals.test.ts. For example, an empty repair answer that leaves its
 * round "answered", or a repair answer that keeps another base's links pending, passes every invariant (INF-316).
 *
 * Faults: a restart after the store took a flush and before any projection (close, then reopen the same path with the
 * same key and register everything again); the sealed outbox flushed again after that restart; a projector that throws
 * mid-page, so the page rolls back; dropped events followed by ledger.gap; one key delivered again with other data.
 *
 * Invariants, checked after every step:
 * P1 The tables equal those of a reference store that holds the same events at the same seqs and projected each one
 *    in seq order up to the live cursors, with no outbox, paging, restart or rollback. Both stores run the same
 *    projector, so this is a differential check of one projector under two schedules, not an independent model.
 * P2 Projecting an event again right after itself changes no table: "every write is a set or a recount, so a replayed
 *    page writes the same rows" (outcome-projector.ts:64). The reference projects every event twice in a row and
 *    compares. Replaying the whole log onto the final state is not promised: a replayed run.settled freezes a row that
 *    integrated after the settle.
 * P3 A row that was integrated or completed keeps that disposition (outcome-rules.ts:66-72). The scripts send a new
 *    member.stopped after an integration or a completion when a drain stops a consumed member again after its journal
 *    read threw (teams.ts:3292-3304). A drain can also emit a member's report again, under a key the store already
 *    holds, so the store keeps the first event (teams.ts:4850-4853; the repeated-key fault). P3 also fails when any
 *    handler rewrites a stored disposition; the precedence table itself stays with tests/outcome-rules.test.ts.
 * P4 Once frozenAt is set, frozenAt, acceptance and the last review never change: "a later steer or continuation ...
 *    changes no frozen row" (spec part 4, Freeze; outcome-projector.ts:329, 508-528).
 * P5 Each row's levels, exclusion, round counts and scan-gap flag equal levels(), rowExclusion(), roundCounts() and
 *    scanGap() over its stored disposition, acceptance, links and signals (outcome-signals.ts:133-164).
 * P6 A settled summary's attempts equal its run's rows counted by disposition (outcome-projector.ts:530, 547-559).
 *    While the run rests settled, with no run.revision-advanced and no event of a later revision after its last
 *    run.settled, its rounds equal its round states and links counted as roundTotals documents
 *    (outcome-projector.ts:424-428; recounted at 419 and 531).
 * P7 When a summary has gap, every row and member result of its run has gap; no gap flag is ever removed.
 * P8 last_seq <= the outcomes cursor <= the highest stored seq; the cursor never moves back, a page that throws keeps
 *    it, and the final drain projects every stored event (evidence/outbox.ts:210-275).
 */

// OUTCOME_SIM_SEED=N runs that seed alone; OUTCOME_SIM_SEEDS=N runs N seeds from OUTCOME_SIM_BASE (default 1). The
// count floors describe the default corpus, so they apply only to it; any other seed set prints its counts and checks
// the invariants alone.
const DEFAULT_SEEDS = 30;
const ONLY = process.env.OUTCOME_SIM_SEED;
const COUNT = Number(process.env.OUTCOME_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.OUTCOME_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "OUTCOME_SIM_SEED, OUTCOME_SIM_SEEDS and OUTCOME_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const DELETED_AT = "2026-11-14T00:00:00.000Z";
const OUTCOME_KIND_SET: ReadonlySet<string> = new Set(OUTCOME_KINDS);

/** Each save flushes what the run's outbox holds: one to four events. */
function batches(r: Rand, events: readonly OutboxEvent[]): OutboxEvent[][] {
  const out: OutboxEvent[][] = [];
  for (let at = 0; at < events.length;) {
    const size = r.int(1, 4);
    out.push(events.slice(at, at + size));
    at += size;
  }
  return out;
}

/** The live host: a store at one path and key, both modules, an outbox, and both projectors, as `server.ts` wires them. */
class Live {
  store!: EvidenceStore;
  outbox!: EventOutbox;
  fired = 0;
  private failAt = 0;
  private seen = 0;

  constructor(private readonly path: string, private readonly key: Buffer) {
    this.open();
  }

  private open(): void {
    this.store = new EvidenceStore({ databasePath: this.path, vaultKey: Buffer.from(this.key) });
    this.store.register(configurationModule());
    this.store.register(outcomeModule({ now: () => DELETED_AT }));
    this.outbox = new EventOutbox(this.store);
    this.outbox.registerProjector(configurationProjector());
    const inner = outcomeProjector(this.store, { log: () => undefined });
    this.outbox.registerProjector({
      name: inner.name, module: inner.module, kinds: inner.kinds,
      project: (tx, event) => {
        if (this.failAt > 0 && ++this.seen === this.failAt) {
          this.failAt = 0;
          this.fired += 1;
          throw new Error("injected projector failure");
        }
        inner.project(tx, event);
      },
    });
  }

  /** The next projected events count from one; the `at`-th one throws, so its whole page rolls back. */
  arm(at: number): void {
    this.failAt = at;
    this.seen = 0;
  }

  /** A process restart: close, then open the same path with the same key and register everything again. */
  restart(): void {
    this.store.close();
    this.open();
  }

  flush(events: readonly OutboxEvent[]): void {
    const result = this.outbox.flush(events);
    assert.equal(result.stored, true, "the store takes every flush");
    assert.equal(result.refused, 0, "the store refuses no scripted event");
  }

  cursor(name: string): number {
    return this.store.read(db => db.get<{ seq: number }>("SELECT seq FROM projector_cursors WHERE name=?", name)?.seq ?? 0);
  }
}

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Snapshot = { tables: Tables; cursor: number; lastSeq: number; maxSeq: number };

/** Every table the two projectors write, in a stable order. Sealed payloads are compared opened. */
const TABLES: readonly (readonly [table: string, order: string, sealedBy?: string])[] = [
  ["outcomes", "outcome_id", "outcome_id"],
  ["run_summaries", "run_id", "run_id"],
  ["member_results", "result_id", "result_id"],
  ["outcome_signals", "signal_id", "signal_id"],
  ["outcome_rounds", "run_id, revision, round"],
  ["outcome_round_links", "outcome_id, revision, round"],
  ["outcome_state", "key"],
  ["configurations", "config_id"],
];

/** The tables, or one run's rows of them. Both stores share the vault key, so their blind indexes compare equal. */
function tablesOf(db: EvidenceDb, runId?: string): Tables {
  const tables: Tables = {};
  for (const [table, order, sealedBy] of TABLES) {
    if (runId !== undefined && table === "configurations") continue;
    const scoped = runId !== undefined && table !== "outcome_state";
    tables[table] = db.all<Row>(`SELECT * FROM ${table}${scoped ? " WHERE run_id=?" : ""} ORDER BY ${order}`, ...(scoped ? [runId] : []))
      .map(row => (sealedBy ? { ...row, payload: db.open(table, String(row[sealedBy]), String(row.payload)) } : { ...row }));
  }
  return tables;
}

function storedEvents(read: (after: number) => { events: RunEvent[]; cursor: number; more: boolean }, after: number): RunEvent[] {
  const events: RunEvent[] = [];
  for (let page = read(after); ; page = read(page.cursor)) {
    events.push(...page.events);
    if (!page.more) return events;
  }
}

/**
 * The reference for P1 and P2. It copies the live store's stored events with their seqs, and projects them in seq
 * order, calling the configurations projector and then the outcomes projector directly, never through an outbox.
 */
class Reference {
  readonly store: EvidenceStore;
  private readonly config = configurationProjector();
  private readonly outcomes: EventProjector;
  private copied = 0;
  private configured = 0;
  private projected = 0;

  constructor(path: string, key: Buffer) {
    this.store = new EvidenceStore({ databasePath: path, vaultKey: Buffer.from(key) });
    this.store.register(configurationModule());
    this.store.register(outcomeModule({ now: () => DELETED_AT }));
    this.outcomes = outcomeProjector(this.store, { log: () => undefined });
  }

  catchUp(live: EvidenceStore, configTo: number, outcomesTo: number, where: string): void {
    const fresh = storedEvents(after => live.events({ after, limit: 500 }), this.copied);
    this.store.write(tx => {
      for (const { seq, ...event } of fresh) {
        // A repeated key's refused insert still uses up a seq in the live store (SQLite AUTOINCREMENT), so skip the same seqs.
        if (tx.run("UPDATE sqlite_sequence SET seq=? WHERE name='run_events'", seq - 1).changes === 0) {
          tx.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('run_events', ?)", seq - 1);
        }
        if (this.store.appendEvent(tx, event).seq !== seq) assert.fail(`${where}: the reference store issued another seq for ${seq}`);
      }
      for (const event of storedEvents(after => this.store.eventsIn(tx, { after, limit: 500 }), Math.min(this.configured, this.projected))) {
        if (event.kind === "member.configured" && event.seq > this.configured && event.seq <= configTo) this.config.project(tx, event);
        if (!OUTCOME_KIND_SET.has(event.kind) || event.seq <= this.projected || event.seq > outcomesTo) continue;
        this.outcomes.project(tx, event);
        const once = tablesOf(tx, event.runId);
        this.outcomes.project(tx, event);
        same(where, `P2: projecting ${event.kind} (seq ${event.seq}) again changed`, tablesOf(tx, event.runId), once);
      }
    });
    this.copied = fresh.at(-1)?.seq ?? this.copied;
    this.configured = Math.max(this.configured, configTo);
    this.projected = Math.max(this.projected, outcomesTo);
  }
}

function fail(where: string, message: string): never {
  return assert.fail(`${where}: ${message}`);
}

/** assert.deepStrictEqual, with the seed, step and reproduce line in front of its diff. */
function same(where: string, label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (error) {
    (error as Error).message = `${where}: ${label}\n${(error as Error).message}`;
    throw error;
  }
}

const flagsOf = (row: Row) => String(row.flags ?? "").split(",").filter(Boolean);
const sortedCounts = (counts: object) => Object.entries(counts).filter(([, n]) => n !== 0).sort(([a], [b]) => (a < b ? -1 : 1));

/**
 * A run's rounds as the roundTotals docstring defines them: attributed when a link is attributed; else unknown when
 * the round is not resolved or a link is pending or unknown; else unattributed (outcome-projector.ts:424-428).
 */
function roundTotals(db: EvidenceDb, runId: string) {
  const totals = { total: 0, attributed: 0, unattributed: 0, unknown: 0 };
  for (const round of db.all<Row>("SELECT revision, round, state FROM outcome_rounds WHERE run_id=?", runId)) {
    const states = db.all<Row>("SELECT state FROM outcome_round_links WHERE run_id=? AND revision=? AND round=?", runId, Number(round.revision), Number(round.round))
      .map(link => link.state);
    totals.total += 1;
    if (states.includes("attributed")) totals.attributed += 1;
    else if (round.state !== "resolved" || states.some(state => state === "pending" || state === "unknown")) totals.unknown += 1;
    else totals.unattributed += 1;
  }
  return totals;
}

/** P1 to P8 over the live store after one step. Returns the snapshot the next step compares against. */
function check(live: Live, reference: Reference, prev: Snapshot | undefined, where: string): Snapshot {
  const cursor = live.cursor("outcomes");
  reference.catchUp(live.store, live.cursor("configurations"), cursor, where);
  const now: Snapshot = live.store.read(db => ({
    tables: tablesOf(db),
    cursor,
    lastSeq: db.get<{ value: number }>("SELECT value FROM outcome_state WHERE key='last_seq'")?.value ?? 0,
    maxSeq: db.get<{ seq: number | null }>("SELECT max(seq) AS seq FROM run_events")?.seq ?? 0,
  }));
  if (!(now.lastSeq <= now.cursor && now.cursor <= now.maxSeq)) {
    fail(where, `P8: last_seq ${now.lastSeq}, outcomes cursor ${now.cursor}, highest seq ${now.maxSeq}`);
  }
  if (prev && now.cursor < prev.cursor) fail(where, `P8: the outcomes cursor moved back from ${prev.cursor} to ${now.cursor}`);
  same(where, "P1: the live tables differ from the reference projection", now.tables, reference.store.read(db => tablesOf(db)));

  const rows = new Map(now.tables.outcomes!.map(row => [String(row.outcome_id), row]));
  for (const old of prev?.tables.outcomes ?? []) {
    const row = rows.get(String(old.outcome_id));
    if (!row) fail(where, `P3: row ${String(old.outcome_id)} disappeared`);
    if ((old.disposition === "integrated" || old.disposition === "completed") && row.disposition !== old.disposition) {
      fail(where, `P3: row ${String(row.outcome_id)} went from ${String(old.disposition)} to ${String(row.disposition)}`);
    }
    const frozen = (item: Row) => [item.frozen_at, item.acceptance, (item.payload as { lastReview?: string }).lastReview];
    if (old.frozen_at !== null && !isDeepStrictEqual(frozen(row), frozen(old))) {
      fail(where, `P4: frozen row ${String(row.outcome_id)} changed [frozenAt, acceptance, lastReview] ${JSON.stringify(frozen(old))} -> ${JSON.stringify(frozen(row))}`);
    }
  }
  for (const table of ["outcomes", "member_results", "run_summaries"]) {
    const ids = (row: Row) => String(row.outcome_id ?? row.result_id ?? row.run_id);
    const current = new Map(now.tables[table]!.map(row => [ids(row), row]));
    for (const old of prev?.tables[table] ?? []) {
      if (flagsOf(old).includes("gap") && !flagsOf(current.get(ids(old)) ?? {}).includes("gap")) fail(where, `P7: ${table} ${ids(old)} lost its gap flag`);
    }
  }

  live.store.read(db => {
    for (const summary of now.tables.run_summaries!) {
      const runId = String(summary.run_id);
      const runRows = runOutcomes(db, runId);
      for (const row of runRows) {
        const links = linksOf(db, row.outcomeId);
        const signals = rowSignals(db, row).signals;
        const state: RowState = { role: row.role, disposition: row.disposition, accepted: row.acceptance ?? null, links, signals };
        same(where, `P5: row ${row.outcomeId} (${row.disposition}) has derived fields`, {
          integrated: row.integrated, accepted: row.accepted, firstPass: row.firstPass, held: row.held, exclusion: row.exclusion,
          rounds: row.payload.rounds, scanGap: row.flags.includes("scan-gap"),
        }, { ...levels(state), exclusion: rowExclusion(row.disposition, signals) ?? null, rounds: roundCounts(links), scanGap: scanGap(state) });
      }
      const stored = readSummary(db, runId)!;
      if (stored.settledAt !== null) {
        const counted: Record<string, number> = {};
        for (const row of runRows) bump(counted, row.disposition);
        same(where, `P6: the settled summary of ${runId} counts attempts`, sortedCounts(stored.payload.attempts), sortedCounts(counted));
        // A dropped run.revision-advanced leaves its revision's later events behind, so they count as an advance too.
        const settle = db.get<Row>("SELECT seq, revision FROM run_events WHERE run_id=? AND kind='run.settled' AND seq<=? ORDER BY seq DESC LIMIT 1", runId, cursor);
        const moved = settle && db.get<Row>("SELECT 1 AS found FROM run_events WHERE run_id=? AND seq>? AND seq<=? AND (revision>? OR kind='run.revision-advanced')",
          runId, Number(settle.seq), cursor, Number(settle.revision));
        if (settle && !moved) {
          same(where, `P6: the settled summary of ${runId} counts rounds`, stored.payload.rounds, roundTotals(db, runId));
        }
      }
      if (stored.flags.includes("gap")) {
        const results = now.tables.member_results!.filter(row => row.run_id === runId);
        const missing = [...runRows.filter(row => !row.flags.includes("gap")).map(row => row.outcomeId),
          ...results.filter(row => !flagsOf(row).includes("gap")).map(row => String(row.result_id))];
        if (missing.length > 0) fail(where, `P7: the summary of ${runId} has gap, and ${missing.join(", ")} lack it`);
      }
    }
  });
  return now;
}

/** Delivers one save's events under one fault drawn for it. Returns the fault's name for the step's label. */
function deliver(r: Rand, live: Live, batch: OutboxEvent[], rest: OutboxEvent[][], delivered: OutboxEvent[], counts: Counts): string {
  const draw = r.next();
  if (draw < 0.12) {
    // The flush stored its events and the process ended before any projection ran.
    live.store.write(tx => { for (const event of batch) live.store.appendEvent(tx, event); });
    delivered.push(...batch);
    live.restart();
    bump(counts, "fault:restart");
    if (r.chance(0.5)) {
      // The sealed record still holds the outbox, so the new process sends it again (teams.ts:668).
      live.flush(batch);
      bump(counts, "fault:sealed-outbox-again");
      return "restart, then the sealed outbox again";
    }
    if (r.chance(0.5)) {
      for (let guard = 0; guard < 200 && live.outbox.advance(r.int(1, 3)).pending; guard += 1) bump(counts, "fault:small-page");
      return "restart, then small pages";
    }
    return "restart, stored and not projected";
  }
  const matching = batch.filter(event => OUTCOME_KIND_SET.has(event.kind)).length;
  if (draw < 0.24 && matching > 0) {
    const before = live.cursor("outcomes");
    const fired = live.fired;
    const at = matching >= 2 ? r.int(2, matching) : 1;
    live.arm(at);
    live.flush(batch);
    delivered.push(...batch);
    assert.equal(live.fired, fired + 1, "the injected failure fired");
    if (live.cursor("outcomes") !== before) fail("rollback", `P8: a page that threw moved the outcomes cursor from ${before}`);
    bump(counts, "fault:rollback");
    if (at >= 2) bump(counts, "fault:rollback-mid-page");
    return `the projector throws at matching event ${at} of its page`;
  }
  if (draw < 0.26) {
    // Past the outbox cap the oldest waiting events are dropped; a stored flush is followed by ledger.gap (teams.ts:957-960, 1012-1018).
    const waiting = [...batch, ...rest.splice(0, r.int(0, 2)).flat()];
    const dropped = r.int(1, Math.max(1, waiting.length - 1));
    const kept = waiting.slice(dropped);
    if (kept.length > 0) live.flush(kept);
    delivered.push(...kept);
    const last = waiting.at(-1)!;
    live.flush([{
      key: runEventKey("ledger.gap", last.runId, [waiting[0]!.at]), runId: last.runId, revision: last.revision,
      at: new Date(Date.parse(last.at) + 1).toISOString(), kind: "ledger.gap", data: { v: 1, dropped },
    }]);
    bump(counts, "fault:gap");
    bump(counts, "fault:dropped-event", dropped);
    return `${dropped} dropped, then ledger.gap`;
  }
  live.flush(batch);
  delivered.push(...batch);
  const reported = delivered.filter(event => event.kind === "member.reported");
  if (draw < 0.34 && reported.length > 0) {
    // A drain can read a second report envelope of a member: its event repeats the stored key with other data (teams.ts:3298, 4852).
    const first = r.pick(reported);
    live.flush([{ ...first, at: new Date(Date.parse(first.at) + 500).toISOString(), data: { ...first.data, reportKind: "question" } }]);
    bump(counts, "fault:repeated-key");
    return "a repeated key with other data";
  }
  return "flush";
}

function simulate(seed: number, counts: Counts): void {
  const r = rand(seed);
  let tick = 0;
  const clock = () => new Date(T0 + 1000 * tick++).toISOString();
  const runIds = ["run-a", "run-b", "run-c"];
  const queues = runIds.map(runId => batches(r, new RunScript(r, runId, clock, counts).script()));
  const key = createHash("sha256").update(`outcome-sim:${seed}`).digest();
  const delivered: OutboxEvent[] = [];
  const reproduce = `reproduce with OUTCOME_SIM_SEED=${seed}`;
  let root: string | undefined, live: Live | undefined, reference: Reference | undefined;
  let prev: Snapshot | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "infinite-outcome-sim-"));
    live = new Live(evidenceDatabasePath(join(root, "live")), key);
    reference = new Reference(evidenceDatabasePath(join(root, "reference")), key);
    for (let step = 1; queues.some(queue => queue.length > 0); step += 1) {
      const queue = r.pick(queues.filter(item => item.length > 0));
      const fault = deliver(r, live, queue.shift()!, queue, delivered, counts);
      prev = check(live, reference, prev, `seed ${seed} step ${step} (${fault}); ${reproduce}`);
    }
    for (let guard = 0; guard < 100 && live.outbox.advance().pending; guard += 1);
    const where = `seed ${seed} final drain; ${reproduce}`;
    const last = check(live, reference, prev, where);
    if (last.cursor !== last.maxSeq) fail(where, `P8: the outcomes cursor ${last.cursor} stopped short of the highest seq ${last.maxSeq}`);
    for (const { kind, n } of live.store.read(db => db.all<{ kind: string; n: number }>("SELECT kind, count(*) AS n FROM run_events GROUP BY kind"))) {
      bump(counts, `kind:${kind}`, n);
    }
    bump(counts, "rows:frozen", last.tables.outcomes!.filter(row => row.frozen_at !== null).length);
    for (const summary of last.tables.run_summaries!) if (summary.settled_at !== null) bump(counts, "runs:settled");
    bump(counts, "rows:member-results", last.tables.member_results!.length);
  } finally {
    live?.store.close();
    reference?.store.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Floors for the default corpus, so a generator that silently stops producing a case fails: every outcome event
 * kind, every fault and every reorder ran at least 10 times there, and each floor is about half of that count.
 * Held completions after a cancel's settle are floored together, as reorder:completion-after-settle, and the late
 * run.prepared also alone: a run cancels at most once, so the five held kinds share the cancels, and alone the repair
 * answer, the review and the scout completion ran under 10 times (7, 3 and 8). The diagnostic shows each kind.
 * block:member-stalled is a path, not a kind, fault or reorder: a second stall of one assignment ran 6 times.
 */
const FLOORS: Readonly<Record<string, number>> = {
  "kind:run.created": 44, "kind:run.prepared": 43, "kind:member.started": 355, "kind:member.configured": 248,
  "kind:member.reported": 300, "kind:member.stopped": 117, "kind:task.integrated": 54, "kind:scout.completed": 35,
  "kind:task.escalated": 7, "kind:review.recorded": 23, "kind:review.tree": 13, "kind:repair.started": 17,
  "kind:repair.integrated": 17, "kind:repair.paths": 13, "kind:delivery.recorded": 7, "kind:rating.recorded": 7,
  "kind:run.blocked": 14, "kind:run.revision-advanced": 37, "kind:run.settled": 39, "kind:run.deleted": 14, "kind:ledger.gap": 21,
  "fault:restart": 92, "fault:sealed-outbox-again": 45, "fault:small-page": 19, "fault:rollback": 65, "fault:rollback-mid-page": 41,
  "fault:gap": 21, "fault:dropped-event": 35, "fault:repeated-key": 49,
  "reorder:report-after-stop": 5, "reorder:completion-after-halt": 7, "reorder:completion-after-settle": 20,
  "reorder:enrichment-after-settle": 52, "reorder:stop-without-start": 10, "reorder:stop-after-consumed": 20,
  "after-settle:member.stopped": 17, "after-settle:run.prepared": 5, "block:member-stalled": 3,
  "runs:settled": 35, "rows:frozen": 42, "rows:member-results": 144,
};

test("the outcome projector keeps its invariants under seeded faults", t => {
  const counts: Counts = {};
  const warn = console.warn;
  // The store logs each injected failure once per store instance; the counts below report what ran.
  console.warn = () => undefined;
  const started = performance.now();
  try {
    for (const seed of SEEDS) simulate(seed, counts);
  } finally {
    console.warn = warn;
  }
  const perSeed = (performance.now() - started) / SEEDS.length;
  t.diagnostic(`outcome sim: ${SEEDS.length} seeds from ${SEEDS[0]}, ${perSeed.toFixed(0)} ms per seed, ${JSON.stringify(Object.fromEntries(sortedCounts(counts)))}`);
  if (!DEFAULT_CORPUS) return;
  for (const [name, floor] of Object.entries(FLOORS)) {
    assert.ok((counts[name] ?? 0) >= floor, `${name} ran ${counts[name] ?? 0} times, under its floor of ${floor}: the generator stopped producing it`);
  }
});

test("a repair answer with no commit after a cancel settle recounts the summary's rounds", () => {
  // The smallest list without a gap, reduced from simulator seed 18 with EMPTY_REPAIR_AFTER_SETTLE on. Production emits
  // this order when the integrator's operation finished before an owner cancel: the cancel saves run.settled, then the
  // queued completion emits repair.integrated, with no commit when nothing changed (teams.ts:2279-2292, 2695-2704, 5575).
  const base = "b".repeat(40), head = "c".repeat(40);
  const event = (second: number, kind: string, parts: (string | number)[], ids: { memberId?: string; taskId?: string }, data: Row): OutboxEvent => ({
    key: runEventKey(kind, "run-d", parts), runId: "run-d", revision: 1, at: new Date(T0 + second * 1000).toISOString(), kind, ...ids, data: { v: 1, ...data },
  });
  let root: string | undefined, live: Live | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "infinite-outcome-sim-"));
    live = new Live(evidenceDatabasePath(root), createHash("sha256").update("outcome-sim:directed").digest());
    live.flush([
      event(0, "run.created", [], {}, { projectId: "example", purpose: "work" }),
      event(1, "member.started", ["m1"], { memberId: "m1", taskId: "a" }, { role: "implementer", startedAt: new Date(T0 + 1000).toISOString(), baseCommit: base, provider: "claude", model: "m-1" }),
      event(2, "task.integrated", [1, "a"], { memberId: "m1", taskId: "a" }, { commit: head, headCommit: head, baseCommit: base }),
      event(3, "repair.started", [1, 1], {}, { round: 1, cause: "review", headCommit: head }),
      event(4, "run.settled", [1, "cancelled", "t"], {}, { status: "cancelled" }),
      event(5, "repair.integrated", [1, 1], { memberId: "g1" }, { round: 1, headCommit: head, baseCommit: base }),
    ]);
    // Shown: { total: 1, attributed: 0, unattributed: 0, unknown: 1 }; the round is resolved and its one link is clear.
    live.store.read(db => assert.deepEqual(readSummary(db, "run-d")!.payload.rounds, roundTotals(db, "run-d")));
  } finally {
    live?.store.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});
