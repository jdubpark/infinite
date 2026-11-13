import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath, eventProblem } from "../packages/host/src/evidence/store.js";
import { EvidenceError, type EvidenceModule, type EvidenceTx, type RunEvent } from "../packages/host/src/evidence/types.js";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-outbox-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture, key = f.key): EvidenceStore {
  return new EvidenceStore({ databasePath: f.path, vaultKey: key });
}

function probeModule(): EvidenceModule {
  return {
    name: "probe",
    version: 1,
    readVersion: 1,
    migrate(tx: EvidenceTx) {
      tx.exec(
        "CREATE TABLE IF NOT EXISTS probe_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        + "seq INTEGER NOT NULL, kind TEXT NOT NULL, who TEXT NOT NULL)",
      );
    },
  };
}

function insertProbe(tx: EvidenceTx, event: RunEvent, who: string) {
  tx.run("INSERT INTO probe_rows (seq, kind, who) VALUES (?, ?, ?)", event.seq, event.kind, who);
}

function ev(key: string, kind: string, overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    key,
    runId: "run-1",
    revision: 1,
    at: "2026-11-13T00:00:00.000Z",
    kind,
    data: {},
    ...overrides,
  };
}

function probeRows(store: EvidenceStore, who?: string): Array<{ seq: number; kind: string; who: string }> {
  return store.read(db => db.all<{ seq: number; kind: string; who: string }>(
    "SELECT seq, kind, who FROM probe_rows WHERE (? IS NULL OR who = ?) ORDER BY id",
    who ?? null,
    who ?? null,
  )).map(row => ({ ...row }));
}

function cursorOf(store: EvidenceStore, name: string): number | undefined {
  return store.read(db => db.get<{ seq: number }>("SELECT seq FROM projector_cursors WHERE name=?", name))?.seq;
}

function storedEvents(store: EvidenceStore, runId = "run-1"): RunEvent[] {
  return store.events({ runId, limit: 100 }).events;
}

test("a flush stores events and advances matching projectors once", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    outbox.registerProjector({
      name: "p-tasks",
      module: "probe",
      kinds: ["task.integrated"],
      project: (tx, event) => insertProbe(tx, event, "p-tasks"),
    });
    const batch = [ev("k-created", "run.created"), ev("k-integrated", "task.integrated", { taskId: "task-1" })];

    assert.deepEqual(outbox.flush(batch), { stored: true, refused: 0 });
    const events = storedEvents(store);
    assert.deepEqual(events.map(e => e.kind), ["run.created", "task.integrated"]);
    assert.deepEqual(probeRows(store), [{ seq: events[1].seq, kind: "task.integrated", who: "p-tasks" }]);
    assert.equal(cursorOf(store, "p-tasks"), events[1].seq);

    assert.deepEqual(outbox.flush(batch), { stored: true, refused: 0 });
    assert.equal(storedEvents(store).length, 2);
    assert.equal(probeRows(store).length, 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("an event stored before its projector existed is projected", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    assert.deepEqual(outbox.flush([ev("k-1", "task.integrated"), ev("k-2", "task.integrated")]), {
      stored: true,
      refused: 0,
    });
    outbox.registerProjector({
      name: "p-late",
      module: "probe",
      kinds: ["task.integrated"],
      project: (tx, event) => insertProbe(tx, event, "p-late"),
    });

    assert.deepEqual(outbox.advance(), { projected: 2, pending: false, blocked: [] });
    const seqs = storedEvents(store).map(e => e.seq);
    assert.deepEqual(probeRows(store).map(row => row.seq), seqs);

    store.write(tx => {
      store?.appendEvent(tx, ev("k-3", "task.integrated"));
    });
    assert.deepEqual(outbox.flush([ev("k-3", "task.integrated")]), { stored: true, refused: 0 });
    assert.equal(probeRows(store).length, 3);
  } finally {
    store?.close();
    f.close();
  }
});

test("a projector failure rolls back its own batch only", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    let failing = true;
    let seen = 0;
    outbox.registerProjector({
      name: "p-a",
      module: "probe",
      kinds: ["task.integrated"],
      project(tx, event) {
        insertProbe(tx, event, "p-a");
        seen += 1;
        if (failing && seen === 2) throw new Error("projector refused the second event");
      },
    });
    outbox.registerProjector({
      name: "p-b",
      module: "probe",
      kinds: ["task.integrated"],
      project: (tx, event) => insertProbe(tx, event, "p-b"),
    });
    const batch = [ev("k-a", "task.integrated"), ev("k-b", "task.integrated"), ev("k-c", "task.integrated")];

    assert.deepEqual(outbox.flush(batch), { stored: true, refused: 0 });
    assert.equal(storedEvents(store).length, 3);
    assert.equal(probeRows(store, "p-b").length, 3);
    assert.deepEqual(probeRows(store, "p-a"), []);
    assert.equal(cursorOf(store, "p-a"), undefined);

    failing = false;
    assert.deepEqual(outbox.advance(), { projected: 3, pending: false, blocked: [] });
    const pa = probeRows(store, "p-a");
    assert.deepEqual(pa.map(row => row.seq), storedEvents(store).map(e => e.seq));
  } finally {
    store?.close();
    f.close();
  }
});

test("an unavailable module is skipped and catches up later", () => {
  const f = fixture();
  let brokenMigrates = false;
  const broken = (): EvidenceModule => ({
    name: "broken",
    version: 1,
    readVersion: 1,
    migrate() {
      if (!brokenMigrates) throw new Error("migration refused");
    },
  });
  const seen: number[] = [];
  const projector = {
    name: "p-broken",
    module: "broken",
    kinds: ["task.integrated"],
    project(_tx: EvidenceTx, event: RunEvent) {
      seen.push(event.seq);
    },
  };
  let first: EvidenceStore | undefined;
  let second: EvidenceStore | undefined;
  try {
    first = open(f);
    first.register(probeModule());
    first.register(broken());
    assert.equal(first.status().modules.broken, "unavailable");
    const outbox = new EventOutbox(first);
    outbox.registerProjector(projector);

    assert.deepEqual(outbox.flush([ev("k-1", "task.integrated")]), { stored: true, refused: 0 });
    assert.equal(storedEvents(first).length, 1);
    assert.deepEqual(outbox.advance(), { projected: 0, pending: true, blocked: [] });
    assert.deepEqual(seen, []);
    first.close();
    first = undefined;

    brokenMigrates = true;
    second = open(f);
    second.register(probeModule());
    second.register(broken());
    assert.equal(second.status().modules.broken, "ready");
    const reopened = new EventOutbox(second);
    reopened.registerProjector(projector);
    assert.deepEqual(reopened.advance(), { projected: 1, pending: false, blocked: [] });
    assert.equal(seen.length, 1);
  } finally {
    second?.close();
    first?.close();
    f.close();
  }
});

test("an unavailable store leaves events waiting and reads none of them", () => {
  const f = fixture();
  let reads = 0;
  const countedEvent = (key: string): OutboxEvent => ({
    key,
    runId: "run-1",
    revision: 1,
    at: "2026-11-13T00:00:00.000Z",
    data: {},
    get kind() {
      reads += 1;
      return "run.created";
    },
  });
  let ready: EvidenceStore | undefined;
  let wrong: EvidenceStore | undefined;
  try {
    ready = open(f);
    ready.register(probeModule());
    open(f).close();
    wrong = open(f, randomBytes(32));
    assert.equal(wrong.status().state, "unavailable");
    wrong.register(probeModule());
    const wrongOutbox = new EventOutbox(wrong);
    wrongOutbox.registerProjector({ name: "p-wrong", module: "probe", kinds: ["run.created"], project: () => undefined });
    assert.deepEqual(wrongOutbox.flush([countedEvent("k-1")]), { stored: false, refused: 0 });
    assert.deepEqual(wrongOutbox.advance(), { projected: 0, pending: true, blocked: [] });
    assert.equal(reads, 0);

    const closedOutbox = new EventOutbox(ready);
    closedOutbox.registerProjector({ name: "p-closed", module: "probe", kinds: ["run.created"], project: () => undefined });
    ready.close();
    assert.deepEqual(closedOutbox.flush([countedEvent("k-2")]), { stored: false, refused: 0 });
    assert.deepEqual(closedOutbox.advance(), { projected: 0, pending: true, blocked: [] });
    assert.equal(reads, 0);
  } finally {
    wrong?.close();
    ready?.close();
    f.close();
  }
});

test("a refused event is counted and does not block the others", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const outbox = new EventOutbox(store);
    const throwingKind = (key: string): OutboxEvent => ({
      key,
      runId: "run-1",
      revision: 1,
      at: "2026-11-13T00:00:00.000Z",
      data: {},
      get kind(): string {
        throw new Error("kind getter failed");
      },
    });

    const first = [
      ev("k-bad", "Bad Kind"),
      ev("k-large", "run.created", { data: { blob: "x".repeat(17 * 1024) } }),
      throwingKind("k-throws"),
      ev("k-good", "run.created"),
    ];
    assert.deepEqual(outbox.flush(first), { stored: true, refused: 3 });
    assert.deepEqual(storedEvents(store).map(e => e.key), ["k-good"]);

    assert.deepEqual(outbox.flush([ev("k-bad-2", "Bad Kind"), throwingKind("k-throws-2")]), {
      stored: true,
      refused: 2,
    });
    assert.deepEqual(storedEvents(store).map(e => e.key), ["k-good"]);
  } finally {
    store?.close();
    f.close();
  }
});

test("an event is read once and only by its known fields", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    const shapes: string[][] = [];
    outbox.registerProjector({
      name: "p-shape",
      module: "probe",
      kinds: ["run.created"],
      project(_tx, event) {
        shapes.push(Object.keys(event).sort());
      },
    });

    const reads: string[] = [];
    const proxied = new Proxy({ ...ev("k-proxy", "run.created") }, {
      get(target, property, receiver) {
        if (typeof property === "string") reads.push(property);
        return Reflect.get(target, property, receiver);
      },
    });
    assert.deepEqual(outbox.flush([proxied]), { stored: true, refused: 0 });
    assert.deepEqual(reads.sort(), ["at", "data", "key", "kind", "memberId", "revision", "runId", "taskId"]);

    let extraReads = 0;
    const withExtra: OutboxEvent = { ...ev("k-extra", "run.created") };
    Object.defineProperty(withExtra, "extra", {
      enumerable: true,
      get() {
        extraReads += 1;
        throw new Error("extra getter");
      },
    });

    let valueReads = 0;
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, "value", {
      enumerable: true,
      get() {
        valueReads += 1;
        return valueReads === 1 ? 1 : BigInt(valueReads);
      },
    });
    const withCountingData: OutboxEvent = { ...ev("k-value", "run.created"), data };

    assert.deepEqual(outbox.flush([withExtra, withCountingData]), { stored: true, refused: 0 });
    assert.equal(extraReads, 0);
    assert.equal(valueReads, 1);
    const events = storedEvents(store);
    assert.deepEqual(events.map(e => e.key), ["k-proxy", "k-extra", "k-value"]);
    assert.deepEqual(events[2].data, { value: 1 });
    const expected = ["at", "data", "key", "kind", "revision", "runId", "seq"];
    assert.deepEqual(shapes, [expected, expected, expected]);
  } finally {
    store?.close();
    f.close();
  }
});

test("a prefix projector receives its kinds", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    const received: string[] = [];
    outbox.registerProjector({
      name: "p-duel",
      module: "probe",
      kinds: ["duel."],
      project(tx, event) {
        received.push(event.kind);
        insertProbe(tx, event, "p-duel");
      },
    });

    assert.deepEqual(outbox.flush([
      ev("k-1", "duel.started"),
      ev("k-2", "duels.other"),
      ev("k-3", "run.created"),
      ev("k-4", "duel.resolved"),
    ]), { stored: true, refused: 0 });
    assert.deepEqual(received, ["duel.started", "duel.resolved"]);
  } finally {
    store?.close();
    f.close();
  }
});

test("projector registration is validated", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    const project = () => undefined;
    const base = { name: "p-valid", module: "probe", kinds: ["task.integrated"], project };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["name Bad Name", { ...base, name: "Bad Name" }],
      ["unknown module", { ...base, name: "p-missing", module: "missing" }],
      ["module store", { ...base, name: "p-store", module: "store" }],
      ["module event-outbox", { ...base, name: "p-outbox", module: "event-outbox" }],
      ["empty kinds", { ...base, name: "p-empty", kinds: [] }],
      ["65 kinds", { ...base, name: "p-many", kinds: Array.from({ length: 65 }, (_, i) => `k${i}.x`) }],
      ["kind Bad Kind", { ...base, name: "p-kind", kinds: ["Bad Kind"] }],
      ["prefix dot", { ...base, name: "p-dot", kinds: ["."] }],
      ["prefix duel..", { ...base, name: "p-double", kinds: ["duel.."] }],
      ["missing project", { ...base, name: "p-nofn", project: undefined }],
    ];
    for (const [label, projector] of cases) {
      assert.throws(() => outbox.registerProjector(projector as never), TypeError, label);
    }

    outbox.registerProjector({ ...base, name: "p-valid" });
    assert.throws(() => outbox.registerProjector({ ...base, name: "p-valid" }), TypeError, "repeated name");
    outbox.registerProjector({
      name: "p-sixty-four",
      module: "probe",
      kinds: Array.from({ length: 64 }, (_, i) => `k${i}.x`),
      project: () => undefined,
    });

    const f2 = fixture();
    let second: EvidenceStore | undefined;
    try {
      second = open(f2);
      second.register(probeModule());
      const ordered = new EventOutbox(second);
      ordered.registerProjector({
        name: "p-first",
        module: "probe",
        kinds: ["run.created"],
        project: (tx, event) => insertProbe(tx, event, "p-first"),
      });
      ordered.registerProjector({
        name: "p-second",
        module: "probe",
        kinds: ["run.created"],
        project: (tx, event) => insertProbe(tx, event, "p-second"),
      });
      assert.deepEqual(ordered.flush([ev("k-order", "run.created")]), { stored: true, refused: 0 });
      assert.deepEqual(probeRows(second).map(row => row.who), ["p-first", "p-second"]);
    } finally {
      second?.close();
      f2.close();
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("an async projector fails its own batch", async () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    outbox.registerProjector({
      name: "p-async",
      module: "probe",
      kinds: ["task.integrated"],
      project(tx, event) {
        insertProbe(tx, event, "p-async");
        return Promise.reject(new Error("late failure")) as unknown as void;
      },
    });

    assert.deepEqual(outbox.flush([ev("k-async", "task.integrated")]), { stored: true, refused: 0 });
    assert.equal(storedEvents(store).length, 1);
    assert.deepEqual(probeRows(store), []);
    assert.equal(cursorOf(store, "p-async"), undefined);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    store?.close();
    f.close();
  }
});

test("advance works in pages", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    const batch = Array.from({ length: 7 }, (_, i) => ev(`k-${i}`, "task.integrated"));
    assert.deepEqual(outbox.flush(batch), { stored: true, refused: 0 });
    outbox.registerProjector({
      name: "p-pages",
      module: "probe",
      kinds: ["task.integrated"],
      project: (tx, event) => insertProbe(tx, event, "p-pages"),
    });

    assert.deepEqual(outbox.advance(3), { projected: 3, pending: true, blocked: [] });
    assert.deepEqual(outbox.advance(3), { projected: 3, pending: true, blocked: [] });
    assert.deepEqual(outbox.advance(3), { projected: 1, pending: false, blocked: [] });
    assert.equal(probeRows(store).length, 7);

    store.write(tx => {
      for (let i = 0; i < 3; i += 1) store?.appendEvent(tx, ev(`k-more-${i}`, "task.integrated"));
    });
    assert.deepEqual(outbox.advance(0), { projected: 1, pending: true, blocked: [] });
    store.write(tx => {
      for (let i = 0; i < 501; i += 1) store?.appendEvent(tx, ev(`k-bulk-${i}`, "task.integrated"));
    });
    assert.deepEqual(outbox.advance(9999), { projected: 500, pending: true, blocked: [] });
    assert.deepEqual(outbox.advance(9999), { projected: 3, pending: false, blocked: [] });

    const before = cursorOf(store, "p-pages");
    store.write(tx => {
      for (let i = 0; i < 3; i += 1) store?.appendEvent(tx, ev(`k-other-${i}`, "run.created"));
    });
    assert.deepEqual(outbox.advance(10), { projected: 0, pending: false, blocked: [] });
    const last = store.read(db => db.get<{ seq: number }>("SELECT max(seq) AS seq FROM run_events"))?.seq;
    assert.notEqual(before, last);
    assert.equal(cursorOf(store, "p-pages"), last);
  } finally {
    store?.close();
    f.close();
  }
});

test("a cursor survives a restart", () => {
  const f = fixture();
  let first: EvidenceStore | undefined;
  let second: EvidenceStore | undefined;
  try {
    first = open(f);
    first.register(probeModule());
    const projectorFor = (outbox: EventOutbox) => outbox.registerProjector({
      name: "p-restart",
      module: "probe",
      kinds: ["task.integrated"],
      project: (tx, event) => insertProbe(tx, event, "p-restart"),
    });
    const outbox = new EventOutbox(first);
    projectorFor(outbox);
    assert.deepEqual(outbox.flush([ev("k-1", "task.integrated"), ev("k-2", "task.integrated")]), {
      stored: true,
      refused: 0,
    });
    assert.equal(probeRows(first).length, 2);
    first.close();
    first = undefined;

    second = open(f);
    second.register(probeModule());
    const reopened = new EventOutbox(second);
    projectorFor(reopened);
    assert.deepEqual(reopened.advance(), { projected: 0, pending: false, blocked: [] });
    assert.deepEqual(reopened.flush([ev("k-3", "task.integrated")]), { stored: true, refused: 0 });
    assert.deepEqual(probeRows(second).map(row => row.seq), storedEvents(second).map(e => e.seq));
    assert.equal(probeRows(second).length, 3);
  } finally {
    second?.close();
    first?.close();
    f.close();
  }
});

test("a changed definition blocks the projector", () => {
  const f = fixture();
  let first: EvidenceStore | undefined;
  let second: EvidenceStore | undefined;
  let third: EvidenceStore | undefined;
  try {
    first = open(f);
    first.register(probeModule());
    const original = new EventOutbox(first);
    original.registerProjector({ name: "p", module: "probe", kinds: ["run.created"], project: () => undefined });
    assert.deepEqual(original.flush([ev("k-task", "task.integrated")]), { stored: true, refused: 0 });
    first.close();
    first = undefined;

    let calls = 0;
    second = open(f);
    second.register(probeModule());
    const changed = new EventOutbox(second);
    changed.registerProjector({
      name: "p",
      module: "probe",
      kinds: ["task.integrated"],
      project: () => {
        calls += 1;
      },
    });
    assert.deepEqual(changed.advance(), { projected: 0, pending: true, blocked: [{ name: "p", reason: "definition-changed" }] });
    assert.deepEqual(changed.flush([ev("k-task-2", "task.integrated")]), { stored: true, refused: 0 });
    assert.equal(calls, 0);
    second.close();
    second = undefined;

    const sameKindsOtherModule = fixture();
    try {
      third = open(sameKindsOtherModule);
      third.register(probeModule());
      const seeded = new EventOutbox(third);
      seeded.registerProjector({ name: "p", module: "probe", kinds: ["task.integrated"], project: () => undefined });
      assert.deepEqual(seeded.flush([ev("k-seed", "task.integrated")]), { stored: true, refused: 0 });
      third.close();
      third = open(sameKindsOtherModule);
      third.register(probeModule());
      third.register({ name: "other", version: 1, readVersion: 1, migrate: () => undefined });
      const moved = new EventOutbox(third);
      moved.registerProjector({ name: "p", module: "other", kinds: ["task.integrated"], project: () => undefined });
      assert.deepEqual(moved.advance(), {
        projected: 0,
        pending: true,
        blocked: [{ name: "p", reason: "definition-changed" }],
      });
    } finally {
      third?.close();
      third = undefined;
      sameKindsOtherModule.close();
    }

    const reordered = fixture();
    try {
      third = open(reordered);
      third.register(probeModule());
      const sameSet = new EventOutbox(third);
      sameSet.registerProjector({
        name: "p-order",
        module: "probe",
        kinds: ["task.integrated", "run.created"],
        project: () => undefined,
      });
      assert.deepEqual(sameSet.flush([ev("k-order", "task.integrated")]), { stored: true, refused: 0 });
      third.close();
      third = open(reordered);
      third.register(probeModule());
      const again = new EventOutbox(third);
      again.registerProjector({
        name: "p-order",
        module: "probe",
        kinds: ["run.created", "task.integrated"],
        project: () => undefined,
      });
      assert.deepEqual(again.advance(), { projected: 0, pending: false, blocked: [] });
    } finally {
      third?.close();
      third = undefined;
      reordered.close();
    }
  } finally {
    third?.close();
    second?.close();
    first?.close();
    f.close();
  }
});

test("deleting a run counts every matching event when the cursor is not trusted", (t) => {
  t.mock.method(console, "warn", () => undefined);
  const lostOf = (store: EvidenceStore) => store.describe().counts["event-outbox.lost"];
  const cursorRow = (store: EvidenceStore, name: string) =>
    store.read(db => db.get<{ seq: number; definition: string }>("SELECT seq, definition FROM projector_cursors WHERE name=?", name));

  const aboveWater = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(aboveWater);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    outbox.registerProjector({
      name: "p-cursor",
      module: "probe",
      kinds: ["task.integrated"],
      project: (tx, event) => insertProbe(tx, event, "p-cursor"),
    });
    assert.deepEqual(outbox.flush([ev("k-base", "run.created", { runId: "run-base" })]), { stored: true, refused: 0 });
    store.write(tx => tx.run("UPDATE projector_cursors SET seq = 100 WHERE name = 'p-cursor'"));
    assert.deepEqual(outbox.flush([ev("k-x", "task.integrated", { runId: "run-x" })]), { stored: true, refused: 0 });
    assert.equal(lostOf(store), 0);
    assert.equal(store.deleteRun("run-x"), true);
    assert.equal(lostOf(store), 1, "a matching event above an untrusted cursor is counted");
    store.close();
    store = undefined;
  } finally {
    store?.close();
    aboveWater.close();
  }

  const otherDefinition = fixture();
  try {
    let first: EvidenceStore | undefined = open(otherDefinition);
    first.register(probeModule());
    const seedStore = first;
    seedStore.write(tx => {
      seedStore.appendEvent(tx, ev("k-d1", "run.created", { runId: "run-d" }));
      seedStore.appendEvent(tx, ev("k-d2", "run.created", { runId: "run-d" }));
    });
    const seeded = new EventOutbox(first);
    seeded.registerProjector({ name: "p-def", module: "probe", kinds: ["task.integrated"], project: () => undefined });
    assert.deepEqual(seeded.flush([ev("k-seed", "task.integrated", { runId: "run-d" })]), { stored: true, refused: 0 });
    first.close();
    first = undefined;

    store = open(otherDefinition);
    store.register(probeModule());
    const changed = new EventOutbox(store);
    changed.registerProjector({ name: "p-def", module: "probe", kinds: ["run.created"], project: () => undefined });
    const before = cursorRow(store, "p-def");
    assert.equal(lostOf(store), 0);
    assert.equal(store.deleteRun("run-d"), true);
    assert.equal(lostOf(store), 2, "both matching events are counted under the registered definition");
    assert.deepEqual(cursorRow(store, "p-def"), before, "the stored seq and definition do not change");
  } finally {
    store?.close();
    otherDefinition.close();
  }
});

test("a blocked projector is logged once", (t) => {
  const f = fixture();
  const warn = t.mock.method(console, "warn", () => undefined);
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    outbox.registerProjector({ name: "p-once", module: "probe", kinds: ["task.integrated"], project: () => undefined });
    assert.deepEqual(outbox.flush([ev("k-once", "task.integrated")]), { stored: true, refused: 0 });
    store.write(tx => tx.run("UPDATE projector_cursors SET seq = 100 WHERE name = 'p-once'"));
    warn.mock.resetCalls();
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(outbox.advance(), {
        projected: 0,
        pending: true,
        blocked: [{ name: "p-once", reason: "cursor-ahead" }],
      });
    }
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(String(warn.mock.calls[0].arguments[0]).includes("p-once"), true);
  } finally {
    store?.close();
    f.close();
  }
});

test("a cursor beyond the event sequence blocks the projector", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);
    let calls = 0;
    outbox.registerProjector({
      name: "p-ahead",
      module: "probe",
      kinds: ["task.integrated"],
      project: (tx, event) => {
        calls += 1;
        insertProbe(tx, event, "p-ahead");
      },
    });
    assert.deepEqual(outbox.flush([ev("k-1", "task.integrated")]), { stored: true, refused: 0 });
    assert.equal(calls, 1);
    store.write(tx => tx.run("UPDATE projector_cursors SET seq = 100 WHERE name = 'p-ahead'"));
    assert.deepEqual(outbox.advance(), {
      projected: 0,
      pending: true,
      blocked: [{ name: "p-ahead", reason: "cursor-ahead" }],
    });
    assert.equal(calls, 1);
    store.close();
    store = undefined;

    const deleted = fixture();
    let old: EvidenceStore | undefined;
    try {
      old = open(deleted);
      old.register(probeModule());
      const runOutbox = new EventOutbox(old);
      runOutbox.registerProjector({
        name: "p-old",
        module: "probe",
        kinds: ["run.created"],
        project: (tx, event) => insertProbe(tx, event, "p-old"),
      });
      assert.deepEqual(runOutbox.flush([ev("k-old", "run.created", { runId: "run-old" })]), {
        stored: true,
        refused: 0,
      });
      assert.equal(old.deleteRun("run-old"), true);
      assert.deepEqual(runOutbox.advance(), { projected: 0, pending: false, blocked: [] });
    } finally {
      old?.close();
      deleted.close();
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("deleting a run records the events a projector never saw", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    store.write(tx => {
      store?.appendEvent(tx, ev("k-run-1", "task.integrated", { runId: "run-1" }));
      store?.appendEvent(tx, ev("k-run-2", "task.integrated", { runId: "run-1" }));
      store?.appendEvent(tx, ev("k-run-3", "run.created", { runId: "run-1" }));
    });
    const outbox = new EventOutbox(store);
    outbox.registerProjector({
      name: "p-loss",
      module: "probe",
      kinds: ["task.integrated"],
      project: (tx, event) => insertProbe(tx, event, "p-loss"),
    });

    assert.equal(store.deleteRun("run-1"), true);
    assert.equal(store.describe().counts["event-outbox.lost"], 2);
    assert.deepEqual(outbox.advance(), { projected: 0, pending: false, blocked: [] });

    assert.deepEqual(outbox.flush([ev("k-run-4", "task.integrated", { runId: "run-2" })]), {
      stored: true,
      refused: 0,
    });
    assert.equal(probeRows(store, "p-loss").length, 1);
    assert.equal(store.deleteRun("run-2"), true);
    assert.equal(store.describe().counts["event-outbox.lost"], 2);
  } finally {
    store?.close();
    f.close();
  }
});

test("a second outbox on one store is refused", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    new EventOutbox(store);
    assert.throws(() => new EventOutbox(store as EvidenceStore), TypeError);
  } finally {
    store?.close();
    f.close();
  }
});

test("an empty flush is a no-op", () => {
  const calls: string[] = [];
  const stub = new Proxy({}, {
    get(_target, property) {
      return (...args: unknown[]) => {
        calls.push(String(property));
        void args;
        if (property === "status") return { state: "ready", modules: { store: "ready" } };
        return undefined;
      };
    },
  }) as unknown as EvidenceStore;

  const outbox = new EventOutbox(stub);
  const afterConstruction = calls.length;
  assert.deepEqual(outbox.flush([]), { stored: true, refused: 0 });
  assert.equal(calls.length, afterConstruction);
});

test("flush and advance never throw", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(probeModule());
    const outbox = new EventOutbox(store);

    assert.equal(typeof outbox.flush("not a list" as unknown as OutboxEvent[]).stored, "boolean");
    assert.deepEqual(outbox.flush([null as unknown as OutboxEvent]), { stored: true, refused: 1 });

    const lengthThrows = new Proxy([ev("k-length", "run.created")], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("length getter failed");
        return Reflect.get(target, property, receiver);
      },
    });
    assert.equal(typeof outbox.flush(lengthThrows as unknown as OutboxEvent[]).stored, "boolean");
    const revocable = Proxy.revocable([ev("k-revoked", "run.created")], {});
    revocable.revoke();
    assert.equal(typeof outbox.flush(revocable.proxy as unknown as OutboxEvent[]).stored, "boolean");

    outbox.registerProjector({
      name: "p-string",
      module: "probe",
      kinds: ["run.created"],
      project() {
        throw "not an Error";
      },
    });
    assert.deepEqual(outbox.flush([ev("k-string", "run.created")]), { stored: true, refused: 0 });
    assert.equal(typeof outbox.advance().pending, "boolean");

    let nested: unknown;
    outbox.registerProjector({
      name: "p-nested",
      module: "probe",
      kinds: ["task.integrated"],
      project() {
        nested = outbox.flush([ev("k-nested", "run.created")]);
      },
    });
    assert.deepEqual(outbox.flush([ev("k-outer", "task.integrated")]), { stored: true, refused: 0 });
    assert.deepEqual(nested, { stored: false, refused: 0 });

    store.close();
    assert.equal(typeof outbox.flush([ev("k-closed", "run.created")]).stored, "boolean");
    assert.equal(typeof outbox.advance().pending, "boolean");
  } finally {
    store?.close();
    f.close();
  }

  let broken = false;
  const stub = {
    status() {
      if (broken) throw new Error("status failed");
      return { state: "ready", modules: { store: "ready", probe: "ready" } };
    },
    register() {
      return undefined;
    },
    tryWrite() {
      return true;
    },
  } as unknown as EvidenceStore;
  const stubOutbox = new EventOutbox(stub);
  stubOutbox.registerProjector({ name: "p-stub", module: "probe", kinds: ["run.created"], project: () => undefined });
  broken = true;
  assert.deepEqual(stubOutbox.flush([ev("k-stub", "run.created")]), { stored: false, refused: 0 });
  assert.deepEqual(stubOutbox.advance(), { projected: 0, pending: true, blocked: [] });
});

test("the event check matches appendEvent", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const refusals: Array<[string, OutboxEvent, string, string]> = [
      ["bad kind", ev("k-kind", "Bad Kind"), "invalid-event", "The event envelope is invalid."],
      ["non-object data", ev("k-data", "run.created", { data: "text" as unknown as Record<string, unknown> }),
        "invalid-event", "The event envelope is invalid."],
      ["cyclic data", ev("k-cycle", "run.created", { data: cyclic }), "invalid-event",
        "Event data must be a JSON object."],
      ["oversized data", ev("k-big", "run.created", { data: { blob: "x".repeat(17 * 1024) } }), "event-too-large",
        "Event data is larger than 16 KiB."],
    ];
    for (const [label, event, code, message] of refusals) {
      assert.equal(eventProblem(event), code, label);
      assert.throws(
        () => store?.write(tx => {
          store?.appendEvent(tx, event);
        }),
        (error: unknown) => error instanceof EvidenceError && error.code === code && error.message === message,
        label,
      );
    }

    const valid = ev("k-valid", "run.created", { data: { note: "kept" }, memberId: "member-1", taskId: "task-1" });
    assert.equal(eventProblem(valid), undefined);
    store.write(tx => {
      store?.appendEvent(tx, valid);
    });
    const readBack = storedEvents(store).find(e => e.key === "k-valid");
    assert.equal(readBack?.kind, "run.created");
    assert.deepEqual(readBack?.data, { note: "kept" });
    assert.equal(readBack?.memberId, "member-1");
    assert.equal(readBack?.taskId, "task-1");

    let reads = 0;
    const counted: Record<string, unknown> = {};
    Object.defineProperty(counted, "value", {
      enumerable: true,
      get() {
        reads += 1;
        return reads;
      },
    });
    store.write(tx => {
      store?.appendEvent(tx, ev("k-count", "run.created", { data: counted }));
    });
    assert.equal(storedEvents(store).find(e => e.key === "k-count")?.data.value, 2);
  } finally {
    store?.close();
    f.close();
  }
});
