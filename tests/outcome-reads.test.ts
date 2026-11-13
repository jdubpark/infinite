import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellQueryRefused } from "../packages/host/src/outcome-cells.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError } from "../packages/host/src/evidence/types.js";
import { advanceEpoch, configurationModule } from "../packages/host/src/configuration-store.js";
import { currentEpochs, productionRows, queryCells } from "../packages/host/src/outcome-reads.js";
import {
  type OutcomeRow,
  outcomeModule,
  type OutcomePayload,
  selectOutcomes,
  writeOutcome,
} from "../packages/host/src/outcome-store.js";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-outcome-reads-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture): EvidenceStore {
  return new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
}

const NOW = "2026-11-13T00:00:00.000Z";

function payload(overrides: Partial<OutcomePayload> = {}): OutcomePayload {
  return {
    projectId: "alpha",
    taskId: "task-a",
    area: "packages/host",
    featureMap: "map-1",
    rounds: { run: 0, attributed: 0, unknown: 0 },
    limitEvents: 0,
    costCoverage: "none",
    ...overrides,
  };
}

function outcomeRow(overrides: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    outcomeId: "run-1:member-1",
    source: "production",
    projectRef: "",
    taskRef: "",
    areaRef: "",
    runId: "run-1",
    revision: 1,
    memberId: "member-1",
    sessionId: "session-1",
    attemptIndex: 1,
    inherited: false,
    role: "implementer",
    profileId: "profile-a",
    provider: "opencode",
    model: "model-one",
    effort: "high",
    profileEpoch: 1,
    configId: null,
    experimentRef: null,
    kind: "feature",
    risk: "low",
    featureVersion: 1,
    disposition: "completed",
    exclusion: null,
    flags: [],
    integrated: 1,
    accepted: 1,
    firstPass: 1,
    held: null,
    startedAt: "2026-11-13T10:00:00.000Z",
    endedAt: "2026-11-13T10:30:00.000Z",
    frozenAt: null,
    holdUntil: null,
    runDeletedAt: null,
    payload: payload(),
    ...overrides,
  };
}

/** A store with the `outcomes` module registered, as `outcome-store.test.ts` builds one. */
function readyStore(f: Fixture): EvidenceStore {
  const store = open(f);
  store.register(outcomeModule({ now: () => NOW }));
  return store;
}

test("rows are read by source and role, with their payload", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = readyStore(f);
    const production = outcomeRow({ outcomeId: "run-1:a", payload: payload({ projectId: "alpha" }) });
    const duel = outcomeRow({ outcomeId: "run-1:b", source: "duel", payload: payload({ projectId: "alpha" }) });
    const scout = outcomeRow({ outcomeId: "run-1:c", role: "scout", payload: payload({ projectId: "alpha" }) });
    store.write(tx => {
      writeOutcome(tx, production);
      writeOutcome(tx, duel);
      writeOutcome(tx, scout);
    });

    const result = queryCells(store, {
      use: "display",
      sources: ["production"],
      by: [],
      role: "implementer",
    }, { now: NOW });
    assert.equal(result.cells.length, 1);
    assert.equal(result.cells[0].attempts, 1);
    assert.equal(result.unreadable, 0);

    const rows = productionRows(store, "implementer");
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].outcomeId, "run-1:a");
    assert.equal(rows.rows[0].payload.projectId, "alpha");
    assert.equal(rows.unreadable, 0);
  } finally {
    store?.close();
    f.close();
  }
});

test("a project filter matches the blind index", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = readyStore(f);
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:a", payload: payload({ projectId: "alpha" }) }));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:b", payload: payload({ projectId: "beta" }) }));
    });

    const alpha = queryCells(store, {
      use: "display",
      sources: ["production"],
      by: [],
      role: "implementer",
      projectId: "alpha",
    }, { now: NOW });
    assert.equal(alpha.cells.length, 1);
    assert.equal(alpha.cells[0].attempts, 1);

    const plain = store.read(db => db.all<Record<string, unknown>>("SELECT * FROM outcomes"));
    assert.equal(plain.length, 2);
    for (const row of plain) {
      const { payload: _sealed, ...columns } = row;
      const text = JSON.stringify(columns);
      assert.equal(text.includes("alpha"), false);
      assert.equal(text.includes("beta"), false);
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("a window uses the end time, or the start time", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = readyStore(f);
    store.write(tx => {
      // Ended exactly at the window start: in.
      writeOutcome(tx, outcomeRow({
        outcomeId: "run-1:a",
        startedAt: "2026-11-05T00:00:00.000Z",
        endedAt: "2026-11-06T00:00:00.000Z",
      }));
      // Ended one millisecond before the window start: out.
      writeOutcome(tx, outcomeRow({
        outcomeId: "run-1:b",
        startedAt: "2026-11-05T00:00:00.000Z",
        endedAt: "2026-11-05T23:59:59.999Z",
      }));
      // Open, so the start time is the window's time: in.
      writeOutcome(tx, outcomeRow({
        outcomeId: "run-1:c",
        disposition: "open", integrated: null, accepted: null, firstPass: null, held: null,
        startedAt: "2026-11-10T00:00:00.000Z",
        endedAt: null,
      }));
      // Neither time: out of every window.
      writeOutcome(tx, outcomeRow({
        outcomeId: "run-1:d",
        startedAt: null,
        endedAt: null,
      }));
    });

    const ids = (since?: string) => store!.read(db => selectOutcomes(db, {
      sources: ["production"], role: "implementer", ...(since === undefined ? {} : { since }),
    })).rows.map(row => row.outcomeId);
    assert.deepEqual(ids("2026-11-06T00:00:00.000Z"), ["run-1:a", "run-1:c"]);
    assert.deepEqual(ids(), ["run-1:a", "run-1:b", "run-1:c", "run-1:d"]);

    // `queryCells` turns `days` into the same window, counted back from `now`.
    const query = { use: "display" as const, sources: ["production" as const], by: [], role: "implementer" as const };
    const windowed = queryCells(store, { ...query, days: 7 }, { now: NOW }).cells[0]!;
    assert.deepEqual([windowed.attempts, windowed.open], [1, 1]);
    const unwindowed = queryCells(store, query, { now: NOW }).cells[0]!;
    assert.deepEqual([unwindowed.attempts, unwindowed.open], [3, 1]);
  } finally {
    store?.close();
    f.close();
  }
});

test("an unreadable payload is counted", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = readyStore(f);
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:a" }));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:b" }));
    });
    store.write(tx => {
      tx.run("UPDATE outcomes SET payload=? WHERE outcome_id=?", "x", "run-1:a");
    });

    const rows = productionRows(store, "implementer");
    assert.deepEqual(rows.rows.map(row => row.outcomeId), ["run-1:b"]);
    assert.equal(rows.unreadable, 1);

    const result = queryCells(store, {
      use: "display",
      sources: ["production"],
      by: [],
      role: "implementer",
    }, { now: NOW });
    assert.equal(result.unreadable, 1);
    assert.equal(result.cells[0].attempts, 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("a refused query never reads", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    // No `outcomes` module is registered, so a read would fail with EvidenceError.
    store = open(f);
    assert.throws(
      () => queryCells(store!, {
        use: "decision",
        sources: ["legacy"],
        by: ["profile"],
        role: "implementer",
      }, { now: NOW }),
      (error: unknown) => error instanceof CellQueryRefused && error.code === "legacy-in-decision",
    );
  } finally {
    store?.close();
    f.close();
  }
});

test("a module that is not ready is unavailable", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    assert.throws(
      () => queryCells(store!, { use: "display", sources: ["production"], by: [], role: "implementer" }, { now: NOW }),
      (error: unknown) => error instanceof EvidenceError && error.code === "unavailable",
    );
    assert.throws(
      () => productionRows(store!, "implementer"),
      (error: unknown) => error instanceof EvidenceError && error.code === "unavailable",
    );
  } finally {
    store?.close();
    f.close();
  }

  // A store whose database path cannot open: its parent is a regular file.
  const blocked = fixture();
  let unopened: EvidenceStore | undefined;
  try {
    writeFileSync(join(blocked.root, "blocked"), "not a directory");
    unopened = new EvidenceStore({
      databasePath: join(blocked.root, "blocked", "evidence.sqlite3"),
      vaultKey: blocked.key,
    });
    unopened.register(outcomeModule({ now: () => NOW }));
    assert.throws(
      () => productionRows(unopened!, "implementer"),
      (error: unknown) => error instanceof EvidenceError && error.code === "unavailable",
    );
    assert.throws(
      () => queryCells(unopened!, { use: "display", sources: ["production"], by: [], role: "implementer" }, { now: NOW }),
      (error: unknown) => error instanceof EvidenceError && error.code === "unavailable",
    );
  } finally {
    unopened?.close();
    blocked.close();
  }
});

test("a deleted run's rows still count", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = readyStore(f);
    store.write(tx => {
      writeOutcome(tx, outcomeRow({
        outcomeId: "run-1:a",
        runDeletedAt: "2026-11-12T00:00:00.000Z",
        payload: payload({ projectId: "alpha" }),
      }));
    });

    const rows = productionRows(store, "implementer");
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].runDeletedAt, "2026-11-12T00:00:00.000Z");
  } finally {
    store?.close();
    f.close();
  }
});

test("cells come from the store", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = readyStore(f);
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:a", profileId: "profile-a" }));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:b", profileId: "profile-a" }));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:c", profileId: "profile-b" }));
    });

    const result = queryCells(store, {
      use: "display",
      sources: ["production"],
      by: ["profile"],
      role: "implementer",
    }, { now: NOW });
    assert.equal(result.cells.length, 2);
    const byProfile = Object.fromEntries(result.cells.map(cell => [cell.key.profile, cell.attempts]));
    assert.deepEqual(byProfile, { "profile-a": 2, "profile-b": 1 });
  } finally {
    store?.close();
    f.close();
  }
});

test("the current epoch comes from the store", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = readyStore(f);
    store.register(configurationModule());
    const identity = { provider: "opencode", model: "model-one", effort: "high" };
    assert.equal(currentEpochs(store, NOW)(identity), 1);
    advanceEpoch(store, { profile: identity, requestId: "request-1", now: "2026-11-12T00:00:00.000Z" });
    const lookup = currentEpochs(store, NOW);
    assert.equal(lookup(identity), 2);
    assert.equal(lookup({ ...identity, effort: null }), 1, "another identity keeps its own epoch");
    // An epoch that starts after `now` is not current yet.
    advanceEpoch(store, { profile: identity, requestId: "request-2", now: "2026-11-14T00:00:00.000Z" });
    assert.equal(currentEpochs(store, NOW)(identity), 2);
  } finally {
    store?.close();
    f.close();
  }

  const bare = fixture();
  let unready: EvidenceStore | undefined;
  try {
    unready = readyStore(bare);
    assert.throws(() => currentEpochs(unready!, NOW), (error: unknown) => error instanceof EvidenceError && error.code === "unavailable");
  } finally {
    unready?.close();
    bare.close();
  }
});
