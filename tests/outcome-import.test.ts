import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError, type EvidenceTx } from "../packages/host/src/evidence/types.js";
import { importLegacy, LegacyImportRefused } from "../packages/host/src/outcome-import.js";
import { type LegacyOutcome, legacyOutcomeId, legacyRow } from "../packages/host/src/outcome-legacy.js";
import { productionRows, queryCells } from "../packages/host/src/outcome-reads.js";
import { CellQueryRefused } from "../packages/host/src/outcome-cells.js";
import {
  legacyLineCount,
  type OutcomePayload,
  type OutcomeRow,
  outcomeModule,
  readLegacyLines,
  readOutcome,
  sweepExpiredOutcomes,
  writeOutcome,
} from "../packages/host/src/outcome-store.js";
import { scorecardFromRows } from "../packages/host/src/scorecard.js";

const NOW = "2026-11-13T12:00:00.000Z";
const RECORDED = "2026-11-01T00:00:00.000Z";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-outcome-import-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A store with the `outcomes` and `configurations` modules, as the host registers them. */
function open(f: Fixture): EvidenceStore {
  const store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => NOW }));
  return store;
}

function line(id: string, overrides: Partial<LegacyOutcome> = {}): LegacyOutcome {
  return {
    id,
    projectId: "alpha",
    profile: { provider: "claude", model: "claude-x" },
    result: "accepted",
    attempts: 1,
    recordedAt: RECORDED,
    ...overrides,
  };
}

const LIMIT = { cap: 3 };
const OPTIONS = { now: NOW };

function refOf(store: EvidenceStore, id: string): string {
  return store.read(db => db.index("legacy", id));
}

/** Every raw row of both legacy tables. Equal output means equal bytes. */
function raw(store: EvidenceStore) {
  return store.read(db => ({
    outcomes: db.all("SELECT * FROM outcomes ORDER BY outcome_id"),
    lines: db.all("SELECT * FROM legacy_lines ORDER BY line_ref"),
  }));
}

/**
 * A store whose `write` fails at the `n`th `INSERT INTO outcomes` of the write. The failure is injected in the test
 * only. The product code is unchanged.
 */
function cutAt(store: EvidenceStore, n: number): EvidenceStore {
  let seen = 0;
  const write = (fn: (tx: EvidenceTx) => unknown) => store.write(tx => fn(Object.assign(Object.create(tx), {
    run: (...args: Parameters<EvidenceTx["run"]>) => {
      if (args[0].startsWith("INSERT INTO outcomes")) {
        seen += 1;
        if (seen === n) throw new Error("cut in the middle of the batch");
      }
      return tx.run(...args);
    },
  }) as EvidenceTx));
  return { status: () => store.status(), read: fn => store.read(fn), write } as unknown as EvidenceStore;
}

test("a batch imports and a replay changes nothing", () => {
  const f = fixture();
  const store = open(f);
  try {
    const batch = [line("A"), line("B"), line("C")];
    const first = importLegacy(store, { dryRun: false, lines: batch }, OPTIONS);
    assert.deepEqual(first.outcomes, ["imported", "imported", "imported"]);
    assert.equal(store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes WHERE source='legacy'"))?.n, 3);
    assert.equal(store.read(db => legacyLineCount(db)), 3);

    const before = raw(store);
    const again = importLegacy(store, { dryRun: false, lines: batch }, OPTIONS);
    assert.deepEqual(again.outcomes, ["repeated", "repeated", "repeated"]);
    assert.equal(again.removed, 0);
    assert.deepEqual(raw(store), before);
  } finally {
    store.close();
    f.close();
  }
});

test("the same id with another body is refused, and the rest of the batch imports", () => {
  const f = fixture();
  const store = open(f);
  try {
    importLegacy(store, { dryRun: false, lines: [line("A")] }, OPTIONS);
    const idA = legacyOutcomeId(refOf(store, "A"));
    const before = store.read(db => db.all("SELECT * FROM outcomes WHERE outcome_id=?", idA));

    const result = importLegacy(store, { dryRun: false, lines: [line("A", { attempts: 2 }), line("C")] }, OPTIONS);
    assert.deepEqual(result.outcomes, ["changed", "imported"]);
    assert.deepEqual(store.read(db => db.all("SELECT * FROM outcomes WHERE outcome_id=?", idA)), before);
    assert.notEqual(store.read(db => readOutcome(db, legacyOutcomeId(refOf(store, "C")))), undefined);
  } finally {
    store.close();
    f.close();
  }
});

test("a superseded line is dropped in either order across batches", () => {
  // Compares what the test can compare across two stores: each store has its own key, so blind indexes differ.
  // The compared facts are the line states by operator id (state, hash, time), the row of each operator id, and the
  // count of rows.
  const snapshot = (store: EvidenceStore) => store.read(db => {
    const refs = { A: db.index("legacy", "A"), B: db.index("legacy", "B") };
    const states = readLegacyLines(db, [refs.A, refs.B]);
    const rowOf = (ref: string) => readOutcome(db, legacyOutcomeId(ref))?.payload.legacy?.id ?? null;
    return {
      states: { A: states.get(refs.A) ?? null, B: states.get(refs.B) ?? null },
      rows: { A: rowOf(refs.A), B: rowOf(refs.B) },
      count: db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes")?.n,
    };
  });
  const forward = fixture();
  const reverse = fixture();
  const first = open(forward);
  const second = open(reverse);
  try {
    importLegacy(first, { dryRun: false, lines: [line("A")] }, OPTIONS);
    const dropped = importLegacy(first, { dryRun: false, lines: [line("B", { supersedes: "A" })] }, OPTIONS);
    assert.deepEqual([dropped.outcomes, dropped.removed], [["imported"], 1]);

    assert.deepEqual(importLegacy(second, { dryRun: false, lines: [line("B", { supersedes: "A" })] }, OPTIONS).outcomes, ["imported"]);
    assert.deepEqual(importLegacy(second, { dryRun: false, lines: [line("A")] }, OPTIONS).outcomes, ["superseded"]);

    // An edit of the dropped line is refused, as an edit of a stored line is: the first body the host saw stays.
    assert.deepEqual(importLegacy(first, { dryRun: false, lines: [line("A", { attempts: 2 })] }, OPTIONS).outcomes, ["changed"]);
    assert.deepEqual(importLegacy(first, { dryRun: false, lines: [line("A")] }, OPTIONS).outcomes, ["superseded"]);

    const forwardState = snapshot(first);
    assert.deepEqual(forwardState.rows, { A: null, B: "B" });
    assert.equal(forwardState.states.A?.state, "superseded");
    assert.equal(forwardState.states.B?.state, "imported");
    assert.deepEqual(snapshot(second), forwardState);
  } finally {
    first.close();
    second.close();
    forward.close();
    reverse.close();
  }
});

test("a chain keeps its last line in every order across batches", () => {
  // B replaced A, and C replaced B. Each store has its own key, so the facts are compared by operator id.
  const chain = [
    line("A", { recordedAt: "2026-11-01T00:00:00.000Z" }),
    line("B", { supersedes: "A", recordedAt: "2026-11-02T00:00:00.000Z" }),
    line("C", { supersedes: "B", recordedAt: "2026-11-03T00:00:00.000Z" }),
  ];
  const ids = ["A", "B", "C"];
  const snapshot = (store: EvidenceStore) => store.read(db => {
    const refs = ids.map(id => db.index("legacy", id));
    const states = readLegacyLines(db, refs);
    return {
      states: ids.map((id, index) => [id, states.get(refs[index]!) ?? null]),
      rows: ids.map((id, index) => [id, readOutcome(db, legacyOutcomeId(refs[index]!))?.payload.legacy?.id ?? null]),
      count: db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes")?.n,
    };
  });
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let expected: ReturnType<typeof snapshot> | undefined;
  for (const order of orders) {
    const f = fixture();
    const store = open(f);
    try {
      let removed = 0;
      for (const index of order) removed += importLegacy(store, { dryRun: false, lines: [chain[index]!] }, OPTIONS).removed;
      const got = snapshot(store);
      assert.deepEqual(got.rows, [["A", null], ["B", null], ["C", "C"]], order.join(" "));
      assert.equal(got.count, 1, order.join(" "));
      assert.deepEqual(got.states.map(([id, state]) => [id, (state as { state: string } | null)?.state]),
        [["A", "superseded"], ["B", "superseded"], ["C", "imported"]], order.join(" "));
      // A row is removed once for each line that was stored before the line that replaced it arrived.
      assert.equal(removed, order.indexOf(0) < order.indexOf(1) ? (order.indexOf(1) < order.indexOf(2) ? 2 : 1) : (order.indexOf(1) < order.indexOf(2) ? 1 : 0), order.join(" "));
      if (expected === undefined) expected = got;
      else assert.deepEqual(got, expected, order.join(" "));
    } finally {
      store.close();
      f.close();
    }
  }
});

test("a batch cut in the middle writes nothing", () => {
  const f = fixture();
  const store = open(f);
  try {
    const batch = [line("A"), line("B"), line("C")];
    assert.throws(() => importLegacy(cutAt(store, 2), { dryRun: false, lines: batch }, OPTIONS), /cut in the middle/);
    assert.equal(store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes")?.n), 0);
    assert.equal(store.read(db => legacyLineCount(db)), 0);

    const result = importLegacy(store, { dryRun: false, lines: batch }, OPTIONS);
    assert.deepEqual(result.outcomes, ["imported", "imported", "imported"]);
    assert.equal(store.read(db => legacyLineCount(db)), 3);
  } finally {
    store.close();
    f.close();
  }
});

test("a dry run reports and writes nothing", () => {
  const f = fixture();
  const store = open(f);
  try {
    const batch = [line("A"), line("B", { supersedes: "A" })];
    const before = raw(store);
    const dry = importLegacy(store, { dryRun: true, lines: batch }, OPTIONS);
    assert.deepEqual(raw(store), before);

    const real = importLegacy(store, { dryRun: false, lines: batch }, OPTIONS);
    assert.deepEqual(dry.outcomes, real.outcomes);
    assert.equal(dry.removed, real.removed);
    assert.equal(real.removed, 1);
    assert.equal(dry.dryRun, true);
    assert.equal(real.dryRun, false);
  } finally {
    store.close();
    f.close();
  }
});

test("an unavailable store or module writes nothing", () => {
  const f = fixture();
  try {
    // A store without the `outcomes` module.
    const bare = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
    try {
      assert.throws(
        () => importLegacy(bare, { dryRun: false, lines: [line("A")] }, OPTIONS),
        error => error instanceof EvidenceError && error.code === "unavailable",
      );
    } finally {
      bare.close();
    }

    // A closed store.
    const closed = open(f);
    closed.close();
    assert.throws(
      () => importLegacy(closed, { dryRun: false, lines: [line("A")] }, OPTIONS),
      error => error instanceof EvidenceError && error.code === "unavailable",
    );

    const check = open(f);
    try {
      assert.equal(check.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes")?.n), 0);
      assert.equal(check.read(db => legacyLineCount(db)), 0);
    } finally {
      check.close();
    }
  } finally {
    f.close();
  }
});

test("a stored line that does not open stops the batch", () => {
  const f = fixture();
  const store = open(f);
  try {
    importLegacy(store, { dryRun: false, lines: [line("A")] }, OPTIONS);
    const refA = refOf(store, "A");
    store.write(tx => tx.run("UPDATE legacy_lines SET payload=? WHERE line_ref=?", "x", refA));

    assert.throws(
      () => importLegacy(store, { dryRun: false, lines: [line("A"), line("C")] }, OPTIONS),
      error => error instanceof EvidenceError && error.code === "unavailable",
    );
    assert.equal(store.read(db => readOutcome(db, legacyOutcomeId(refOf(store, "C")))), undefined);
    assert.equal(store.read(db => legacyLineCount(db)), 1);
  } finally {
    store.close();
    f.close();
  }
});

test("an id that collides with a stored row is refused", () => {
  const f = fixture();
  const store = open(f);
  try {
    const ref = refOf(store, "A");
    const base: OutcomeRow = legacyRow(line("A"), ref);
    const payload: OutcomePayload = { ...base.payload };
    delete payload.legacy;
    const production: OutcomeRow = { ...base, source: "production", memberId: "m1", runId: "run-1", payload };
    store.write(tx => writeOutcome(tx, production));

    const result = importLegacy(store, { dryRun: false, lines: [line("A")] }, OPTIONS);
    assert.deepEqual(result.outcomes, ["conflict"]);
    assert.equal(store.read(db => readOutcome(db, legacyOutcomeId(ref)))?.source, "production");
    assert.equal(store.read(db => legacyLineCount(db)), 0);
  } finally {
    store.close();
    f.close();
  }
});

test("the host caps legacy lines", () => {
  const f = fixture();
  const store = open(f);
  try {
    importLegacy(store, { dryRun: false, lines: [line("A"), line("B")] }, { ...OPTIONS, ...LIMIT });
    const before = raw(store);

    const newLines = { dryRun: false, lines: [line("C"), line("D")] };
    assert.throws(
      () => importLegacy(store, newLines, { ...OPTIONS, ...LIMIT }),
      error => error instanceof LegacyImportRefused && error.code === "legacy-limit",
    );
    assert.throws(
      () => importLegacy(store, { ...newLines, dryRun: true }, { ...OPTIONS, ...LIMIT }),
      error => error instanceof LegacyImportRefused && error.code === "legacy-limit",
    );
    assert.deepEqual(raw(store), before);

    const mixed = importLegacy(store, { dryRun: false, lines: [line("A"), line("B"), line("E")] }, { ...OPTIONS, ...LIMIT });
    assert.deepEqual(mixed.outcomes, ["repeated", "repeated", "imported"]);
    assert.equal(store.read(db => legacyLineCount(db)), 3);
  } finally {
    store.close();
    f.close();
  }
});

test("the configured retention decides what is expired", () => {
  const f = fixture();
  const store = open(f);
  try {
    // RECORDED is 12 days and 12 hours before NOW.
    const short = importLegacy(store, { dryRun: false, lines: [line("A")] }, { ...OPTIONS, retentionDays: 12 });
    assert.deepEqual(short.outcomes, ["expired"]);
    assert.equal(store.read(db => legacyLineCount(db)), 0);
    assert.equal(store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes")?.n), 0);

    assert.deepEqual(importLegacy(store, { dryRun: false, lines: [line("A")] }, { ...OPTIONS, retentionDays: 13 }).outcomes, ["imported"]);
    assert.deepEqual(importLegacy(store, { dryRun: false, lines: [line("B")] }, OPTIONS).outcomes, ["imported"], "the default keeps it");
  } finally {
    store.close();
    f.close();
  }
});

test("legacy rows stay out of production readers", () => {
  const f = fixture();
  const store = open(f);
  try {
    importLegacy(store, {
      dryRun: false,
      lines: [line("X"), line("Y", { result: "rejected" })],
    }, OPTIONS);

    assert.deepEqual(productionRows(store, "implementer").rows, []);
    assert.deepEqual(queryCells(store, { use: "display", sources: ["production"], by: [], role: "implementer" }, { now: NOW }).cells, []);

    const legacy = queryCells(store, { use: "display", sources: ["legacy"], by: ["profile"], role: "implementer" }, { now: NOW }).cells;
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0]?.key.source, "legacy");
    assert.equal(legacy[0]?.key.profile, "(legacy)");
    assert.equal(legacy[0]?.key.epoch, "0");
    assert.deepEqual(legacy[0]?.sources, ["legacy"]);

    assert.throws(
      () => queryCells(store, { use: "decision", sources: ["legacy"], by: ["profile"], role: "implementer" }, { now: NOW }),
      CellQueryRefused,
    );

    assert.deepEqual(scorecardFromRows(productionRows(store, "implementer").rows, { role: "implementer", label: () => undefined }).rows, []);

    assert.equal(sweepExpiredOutcomes(store, NOW), 0);
    assert.equal(store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes WHERE source='legacy'"))?.n, 2);
  } finally {
    store.close();
    f.close();
  }
});

test("no plain column holds operator text", () => {
  const f = fixture();
  const store = open(f);
  const operatorText = ["op-2026-10-01-oauth", "alpha", "oauth fix", "review-x", "op-old"];
  try {
    importLegacy(store, {
      dryRun: false,
      lines: [line("op-2026-10-01-oauth", {
        projectId: "alpha",
        label: "oauth fix",
        reviewerModel: "review-x",
        supersedes: "op-old",
      })],
    }, OPTIONS);

    const plain = JSON.stringify(raw(store));
    for (const text of operatorText) assert.equal(plain.includes(text), false, `a plain column holds ${text}`);

    const row = store.read(db => readOutcome(db, legacyOutcomeId(refOf(store, "op-2026-10-01-oauth"))));
    assert.deepEqual(
      [row?.payload.legacy?.id, row?.payload.projectId, row?.payload.legacy?.label, row?.payload.legacy?.reviewerModel, row?.payload.legacy?.supersedes],
      ["op-2026-10-01-oauth", "alpha", "oauth fix", "review-x", "op-old"],
    );
  } finally {
    store.close();
    f.close();
  }
});
