import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { blindIndex, canonicalJson, openRow, sealRow } from "../packages/host/src/evidence/crypto.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError, type EvidenceModule } from "../packages/host/src/evidence/types.js";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-evidence-"));
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

function hasCode(code: EvidenceError["code"]) {
  return (error: unknown) => error instanceof EvidenceError && error.code === code;
}

function probeModule(version: number, calls: number[] = []): EvidenceModule {
  return {
    name: "probe",
    version,
    readVersion: 1,
    migrate(tx, from) {
      calls.push(from);
      tx.exec("CREATE TABLE IF NOT EXISTS probe_rows (id TEXT PRIMARY KEY, run_id TEXT NOT NULL)");
    },
  };
}

function tableExists(store: EvidenceStore, table: string): boolean {
  return store.read(db => db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table) !== undefined);
}

test("a fresh store is ready, private, and in WAL mode", () => {
  const f = fixture();
  try {
    const store = open(f);
    assert.equal(store.status().state, "ready");
    assert.equal(store.status().modules.store, "ready");
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(f.path)).mode & 0o777, 0o700);
    const raw = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.deepEqual({ ...raw.prepare("PRAGMA journal_mode").get() }, { journal_mode: "wal" });
      assert.deepEqual({ ...raw.prepare("PRAGMA integrity_check").get() }, { integrity_check: "ok" });
    } finally {
      raw.close();
    }
    store.close();
  } finally {
    f.close();
  }
});

test("another vault key is refused", () => {
  const f = fixture();
  try {
    open(f).close();
    const store = open(f, randomBytes(32));
    assert.equal(store.status().state, "unavailable");
    assert.equal(store.status().reason, "key-check-failed");
    assert.throws(() => store.write(() => undefined), hasCode("unavailable"));
    assert.equal(store.tryWrite(() => undefined), false);
    store.close();
  } finally {
    f.close();
  }
});

test("an existing empty file is refused", () => {
  const f = fixture();
  try {
    open(f).close();
    rmSync(f.path);
    writeFileSync(f.path, "", { mode: 0o600 });
    const store = open(f);
    assert.equal(store.status().state, "unavailable");
    assert.equal(store.status().reason, "key-check-failed");
    assert.equal(statSync(f.path).size, 0);
    store.close();
    assert.equal(statSync(f.path).size, 0);
  } finally {
    f.close();
  }
});

test("the same key reopens the store", () => {
  const f = fixture();
  try {
    open(f).close();
    const store = open(f);
    assert.equal(store.status().state, "ready");
    assert.equal(store.status().reason, undefined);
    store.close();
  } finally {
    f.close();
  }
});

test("a wider file mode is narrowed", () => {
  const f = fixture();
  try {
    open(f).close();
    chmodSync(f.path, 0o644);
    const store = open(f);
    assert.equal(store.status().state, "ready");
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        assert.equal(statSync(`${f.path}${suffix}`).mode & 0o777, 0o600, `${suffix} is private`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    store.close();
  } finally {
    f.close();
  }
});

test("sealed rows hide their content and are bound to their row", () => {
  const key = randomBytes(32);
  const value = { note: "sealed-plain-marker", items: [1, "two", null, true] };
  const sealed = sealRow(key, "run_events", "row-1", value);
  assert.deepEqual(openRow(key, "run_events", "row-1", sealed), value);
  assert.equal(sealed.includes("sealed-plain-marker"), false);
  assert.throws(() => openRow(key, "run_events", "row-2", sealed));
  assert.throws(() => openRow(key, "store_meta", "row-1", sealed));
  assert.throws(() => openRow(randomBytes(32), "run_events", "row-1", sealed));
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: Number.NaN }));
  assert.throws(() => canonicalJson(new Date(0)));
});

test("blind indexes separate classes", () => {
  const key = randomBytes(32);
  assert.notEqual(blindIndex(key, "task", "a"), blindIndex(key, "area", "a"));
  assert.notEqual(blindIndex(key, "task", "a"), blindIndex(key, "project", "a"));
  assert.equal(blindIndex(key, "task", "a"), blindIndex(key, "task", "a"));
  assert.match(blindIndex(key, "task", "a"), /^[0-9a-f]{64}$/);
});

test("a module migrates once and records its version", () => {
  const f = fixture();
  try {
    const calls: number[] = [];
    const first = open(f);
    first.register(probeModule(1, calls));
    assert.equal(first.status().modules.probe, "ready");
    first.close();
    const second = open(f);
    second.register(probeModule(1, calls));
    assert.equal(second.status().modules.probe, "ready");
    assert.deepEqual(calls, [0]);
    const stored = second.read(db => db.get("SELECT version, read_version FROM schema_modules WHERE name='probe'"));
    assert.deepEqual({ ...stored }, { version: 1, read_version: 1 });
    assert.equal(tableExists(second, "probe_rows"), true);
    second.close();
  } finally {
    f.close();
  }
});

test("a newer stored module version makes that module unavailable", () => {
  const f = fixture();
  try {
    const first = open(f);
    first.register(probeModule(2));
    first.close();
    const calls: number[] = [];
    const second = open(f);
    second.register(probeModule(1, calls));
    assert.equal(second.status().modules.probe, "unavailable");
    assert.equal(second.status().state, "ready");
    assert.deepEqual(calls, []);
    const stored = second.read(db => db.get("SELECT version FROM schema_modules WHERE name='probe'"));
    assert.deepEqual({ ...stored }, { version: 2 });
    second.register({ name: "other", version: 1, readVersion: 1, migrate: () => undefined });
    assert.equal(second.status().modules.other, "ready");
    assert.throws(() => second.register(probeModule(1)), hasCode("invalid-module"));
    assert.throws(() => second.register({ ...probeModule(1), name: "store" }), hasCode("invalid-module"));
    second.close();
  } finally {
    f.close();
  }
});

test("a failing migration rolls back", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register({
      name: "broken",
      version: 1,
      readVersion: 1,
      migrate(tx) {
        tx.exec("CREATE TABLE broken_rows (id TEXT PRIMARY KEY)");
        throw new Error("migration failed on purpose");
      },
    });
    assert.equal(store.status().modules.broken, "unavailable");
    assert.equal(store.status().state, "ready");
    assert.equal(tableExists(store, "broken_rows"), false);
    assert.equal(store.read(db => db.get("SELECT name FROM schema_modules WHERE name='broken'")), undefined);
    store.close();
  } finally {
    f.close();
  }
});

test("a throwing write leaves nothing behind", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(probeModule(1));
    const failure = new Error("callback failed on purpose");
    assert.throws(() => store.write(tx => {
      tx.run("INSERT INTO probe_rows (id, run_id) VALUES (?, ?)", "row-1", "run-a");
      throw failure;
    }), (error: unknown) => error === failure);
    assert.equal(store.read(db => db.all("SELECT id FROM probe_rows")).length, 0);
    assert.throws(() => store.write(() => store.write(() => 1)), hasCode("nested-write"));
    assert.equal(store.write(tx => tx.run("INSERT INTO probe_rows (id, run_id) VALUES (?, ?)", "row-2", "run-a").changes), 1);
    assert.equal(store.read(db => db.all("SELECT id FROM probe_rows")).length, 1);
    store.close();
  } finally {
    f.close();
  }
});

test("a second connection waits and then succeeds", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(probeModule(1));
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec("PRAGMA busy_timeout=200");
      const insert = raw.prepare("INSERT INTO probe_rows (id, run_id) VALUES (?, ?)");
      store.write(tx => {
        tx.run("INSERT INTO probe_rows (id, run_id) VALUES (?, ?)", "store-row", "run-a");
        const started = Date.now();
        assert.throws(() => insert.run("raw-row", "run-a"), /locked|busy/i);
        assert.ok(Date.now() - started >= 150, "the second writer waits for its busy timeout");
      });
      assert.equal(insert.run("raw-row", "run-a").changes, 1);
      assert.deepEqual({ ...raw.prepare("PRAGMA integrity_check").get() }, { integrity_check: "ok" });
    } finally {
      raw.close();
    }
    const ids = store.read(db => db.all<{ id: string }>("SELECT id FROM probe_rows ORDER BY id")).map(row => row.id);
    assert.deepEqual(ids, ["raw-row", "store-row"]);
    store.close();
  } finally {
    f.close();
  }
});

test("an unwritable location leaves the host running", (t) => {
  const f = fixture();
  try {
    const warn = t.mock.method(console, "warn", () => undefined);
    const blocker = join(f.root, "not-a-directory");
    writeFileSync(blocker, "x");
    const store = new EvidenceStore({ databasePath: join(blocker, "evidence.sqlite3"), vaultKey: f.key });
    assert.equal(store.status().state, "unavailable");
    assert.equal(store.status().reason, "open-failed");
    assert.throws(() => store.write(() => undefined), hasCode("unavailable"));
    assert.equal(store.tryWrite(() => undefined), false);
    const lines = warn.mock.calls.map(call => call.arguments.map(String).join(" "));
    assert.ok(lines.length >= 1);
    for (const line of lines) assert.equal(line.includes(f.root), false, "a log line never names a path");
    store.close();
  } finally {
    f.close();
  }
});

type EventInput = Parameters<EvidenceStore["appendEvent"]>[1];

function event(overrides: Partial<EventInput> = {}): EventInput {
  return {
    key: "run-a:member.reported:1",
    runId: "run-a",
    revision: 1,
    at: "2026-11-13T10:00:00.000Z",
    kind: "member.reported",
    data: {},
    ...overrides,
  };
}

function eventRows(store: EvidenceStore): number {
  return store.read(db => db.get<{ count: number }>("SELECT count(*) AS count FROM run_events"))?.count ?? -1;
}

test("appending one key twice yields one row and the same seq", () => {
  const f = fixture();
  try {
    const store = open(f);
    const first = store.write(tx => store.appendEvent(tx, event({ data: { attempt: 1 } })));
    const second = store.write(tx => store.appendEvent(tx, event({ data: { attempt: 2 } })));
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.seq, first.seq);
    assert.equal(eventRows(store), 1);
    assert.deepEqual(store.events({ limit: 10 }).events.map(item => item.data), [{ attempt: 1 }]);
    store.close();
  } finally {
    f.close();
  }
});

test("an event round-trips and its content is not in the file", () => {
  const f = fixture();
  try {
    const store = open(f);
    const appended = event({
      key: "run-a:evidence-key-marker",
      memberId: "member-1",
      taskId: "wire-settings-form",
      data: { note: "evidence-plain-marker", nested: { count: 2 } },
    });
    store.write(tx => store.appendEvent(tx, appended));
    const [stored] = store.events({ runId: "run-a", limit: 10 }).events;
    assert.equal(stored.key, appended.key);
    assert.equal(stored.kind, appended.kind);
    assert.equal(stored.runId, "run-a");
    assert.equal(stored.revision, 1);
    assert.equal(stored.at, appended.at);
    assert.equal(stored.memberId, "member-1");
    assert.equal(stored.taskId, "wire-settings-form");
    assert.deepEqual(stored.data, appended.data);
    store.close();
    for (const suffix of ["", "-wal"]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(`${f.path}${suffix}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const marker of ["wire-settings-form", "evidence-plain-marker", "evidence-key-marker"]) {
        assert.equal(bytes.includes(Buffer.from(marker)), false, `${marker} is not stored in plain text`);
      }
    }
  } finally {
    f.close();
  }
});

test("events filter and page", () => {
  const f = fixture();
  try {
    const store = open(f);
    const plan: Array<[string, string]> = [
      ["run-a", "member.reported"],
      ["run-a", "check.finished"],
      ["run-b", "member.reported"],
      ["run-a", "member.reported"],
      ["run-b", "check.finished"],
    ];
    const seqs = store.write(tx => plan.map(([runId, kind], index) => {
      return store.appendEvent(tx, event({ key: `event-${index}`, runId, kind })).seq;
    }));
    assert.deepEqual(store.events({ runId: "run-a", limit: 10 }).events.map(item => item.seq), [seqs[0], seqs[1], seqs[3]]);
    assert.deepEqual(store.events({ kinds: ["check.finished"], limit: 10 }).events.map(item => item.seq), [seqs[1], seqs[4]]);
    assert.deepEqual(store.events({ runId: "run-b", kinds: ["check.finished"], limit: 10 }).events.map(item => item.seq), [seqs[4]]);
    assert.deepEqual(store.events({ after: seqs[2], limit: 10 }).events.map(item => item.seq), [seqs[3], seqs[4]]);

    const page = store.events({ limit: 2 });
    assert.equal(page.events.length, 2);
    assert.equal(page.more, true);
    assert.equal(page.cursor, seqs[1]);
    const rest = store.events({ after: page.cursor, limit: 10 });
    assert.deepEqual(rest.events.map(item => item.seq), [seqs[2], seqs[3], seqs[4]]);
    assert.equal(rest.more, false);
    assert.equal(rest.cursor, seqs[4]);
    assert.deepEqual(store.events({ runId: "run-missing", after: 7, limit: 10 }), { events: [], cursor: 7, more: false });
    assert.deepEqual(store.events({ runId: "run-missing", limit: 10 }), { events: [], cursor: 0, more: false });

    store.write(tx => {
      for (let index = 0; index < 500; index++) store.appendEvent(tx, event({ key: `bulk-${index}`, runId: "run-c" }));
    });
    const clamped = store.events({ limit: 100000 });
    assert.equal(clamped.events.length, 500);
    assert.equal(clamped.more, true);
    assert.equal(store.events({ limit: 0 }).events.length, 1);
    assert.throws(() => store.events({ kinds: Array.from({ length: 33 }, (_, index) => `kind.k${index}`), limit: 10 }),
      hasCode("invalid-event"));
    store.close();
  } finally {
    f.close();
  }
});

test("invalid events are refused", () => {
  const f = fixture();
  try {
    const store = open(f);
    const invalid: Array<Partial<EventInput>> = [
      { kind: "Member.reported" },
      { kind: "member" },
      { kind: `member.${"x".repeat(58)}` },
      { key: "" },
      { key: "k".repeat(513) },
      { revision: 0 },
      { revision: 1.5 },
      { at: "not a date" },
      { runId: "" },
      { data: [] as unknown as Record<string, unknown> },
    ];
    assert.equal(`member.${"x".repeat(58)}`.length, 65);
    for (const overrides of invalid) {
      assert.throws(() => store.write(tx => store.appendEvent(tx, event(overrides))), hasCode("invalid-event"), JSON.stringify(overrides));
    }
    assert.equal(eventRows(store), 0);
    store.close();
  } finally {
    f.close();
  }
});

test("an oversized event is refused whole", () => {
  const f = fixture();
  try {
    const store = open(f);
    const sized = (bytes: number) => {
      const data = { p: "x".repeat(bytes - '{"p":""}'.length) };
      assert.equal(Buffer.byteLength(canonicalJson(data)), bytes);
      return data;
    };
    assert.throws(() => store.write(tx => store.appendEvent(tx, event({ key: "too-large", data: sized(16385) }))), hasCode("event-too-large"));
    assert.equal(eventRows(store), 0);
    const exact = sized(16384);
    store.write(tx => store.appendEvent(tx, event({ key: "exact", data: exact })));
    assert.deepEqual(store.events({ limit: 10 }).events.map(item => item.data), [exact]);
    store.close();
  } finally {
    f.close();
  }
});

test("hasEvent reports a stored key", () => {
  const f = fixture();
  try {
    const store = open(f);
    assert.equal(store.hasEvent("run-a:member.reported:1"), false);
    store.write(tx => store.appendEvent(tx, event()));
    assert.equal(store.hasEvent("run-a:member.reported:1"), true);
    assert.equal(store.hasEvent("run-a:member.reported:2"), false);
    store.close();
  } finally {
    f.close();
  }
});

function hookedModule(deleted: string[] = []): EvidenceModule {
  return {
    ...probeModule(1),
    deleteRun(tx, runId) {
      deleted.push(runId);
      tx.run("DELETE FROM probe_rows WHERE run_id=?", runId);
    },
    runIds(db) {
      return db.all<{ run_id: string }>("SELECT DISTINCT run_id FROM probe_rows").map(row => row.run_id);
    },
    counts(db) {
      return { rows: db.get<{ count: number }>("SELECT count(*) AS count FROM probe_rows")?.count ?? 0 };
    },
  };
}

function addProbeRow(store: EvidenceStore, id: string, runId: string): void {
  store.write(tx => tx.run("INSERT INTO probe_rows (id, run_id) VALUES (?, ?)", id, runId));
}

function probeRuns(store: EvidenceStore): string[] {
  return store.read(db => db.all<{ run_id: string }>("SELECT run_id FROM probe_rows ORDER BY run_id")).map(row => row.run_id);
}

test("deleting a run removes its events and calls module hooks", () => {
  const f = fixture();
  try {
    const store = open(f);
    const deleted: string[] = [];
    store.register(hookedModule(deleted));
    store.write(tx => {
      for (const runId of ["run-a", "run-b"]) {
        for (const index of [1, 2]) store.appendEvent(tx, event({ key: `${runId}:${index}`, runId }));
      }
    });
    addProbeRow(store, "row-a", "run-a");
    addProbeRow(store, "row-b", "run-b");
    assert.equal(store.deleteRun("run-a"), true);
    assert.deepEqual(deleted, ["run-a"]);
    assert.equal(store.events({ runId: "run-a", limit: 10 }).events.length, 0);
    assert.equal(store.events({ runId: "run-b", limit: 10 }).events.length, 2);
    assert.deepEqual(probeRuns(store), ["run-b"]);
    store.close();

    const refused = open(f, randomBytes(32));
    assert.equal(refused.status().state, "unavailable");
    assert.equal(refused.deleteRun("run-b"), false);
    refused.close();
  } finally {
    f.close();
  }
});

test("the sweep removes runs with no live record", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(hookedModule());
    store.write(tx => {
      for (const runId of ["keep", "gone-1", "gone-2"]) store.appendEvent(tx, event({ key: `${runId}:1`, runId }));
    });
    assert.equal(store.sweep(id => id === "keep"), 2);
    assert.equal(store.events({ limit: 10 }).events.every(item => item.runId === "keep"), true);
    assert.equal(store.events({ runId: "keep", limit: 10 }).events.length, 1);

    addProbeRow(store, "row-module-only", "module-only");
    addProbeRow(store, "row-keep", "keep");
    assert.equal(store.sweep(id => id === "keep"), 1);
    assert.deepEqual(probeRuns(store), ["keep"]);
    assert.equal(store.sweep(() => {
      throw new Error("liveness unknown");
    }), 0, "a failing liveness check keeps the run");
    assert.equal(store.events({ runId: "keep", limit: 10 }).events.length, 1);
    store.close();
    assert.equal(store.sweep(() => false), 0, "a closed store sweeps nothing");
  } finally {
    f.close();
  }
});

test("describe reports sizes and counts", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(hookedModule());
    store.write(tx => {
      for (const index of [1, 2, 3]) store.appendEvent(tx, event({ key: `describe:${index}` }));
    });
    addProbeRow(store, "row-1", "run-a");
    addProbeRow(store, "row-2", "run-a");
    const described = store.describe();
    assert.equal(described.state, "ready");
    assert.deepEqual(described.modules, { store: "ready", probe: "ready" });
    assert.equal(described.events, 3);
    assert.ok(described.fileBytes > 0);
    assert.equal(described.fileBytes, statSync(f.path).size);
    assert.ok(described.walBytes > 0, "committed writes wait in the WAL until a checkpoint");
    assert.equal(described.walBytes, statSync(`${f.path}-wal`).size);
    assert.deepEqual(described.counts, { "probe.rows": 2 });
    store.close();

    const refused = open(f, randomBytes(32));
    const unavailable = refused.describe();
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.reason, "key-check-failed");
    assert.equal(unavailable.events, 0);
    assert.deepEqual(unavailable.counts, {});
    refused.close();
  } finally {
    f.close();
  }
});

test("a leftover temporary file is removed only when its builder has exited", () => {
  const f = fixture();
  try {
    const directory = dirname(f.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    assert.ok(typeof exited === "number" && exited > 0);
    const temp = (pid: number) => `evidence.sqlite3.creating-${pid}-${randomUUID()}`;
    const stale = temp(exited);
    const running = temp(process.pid);
    // Process 1 runs under another user, so probing it fails with EPERM, which means it runs.
    const otherUser = process.getuid?.() === 0 ? undefined : temp(1);
    const kept = [running, ...(otherUser ? [otherUser] : [])];
    for (const name of [stale, `${stale}-journal`, ...kept]) writeFileSync(join(directory, name), "half-built", { mode: 0o600 });
    const store = open(f);
    assert.equal(store.status().state, "ready");
    const names = readdirSync(directory);
    assert.equal(names.includes(stale), false);
    assert.equal(names.includes(`${stale}-journal`), false);
    for (const name of kept) assert.equal(names.includes(name), true, "a builder that may still run keeps its file");
    const expected = new Set(["evidence.sqlite3", "evidence.sqlite3-shm", "evidence.sqlite3-wal", ...kept]);
    assert.equal(names.includes("evidence.sqlite3"), true);
    assert.deepEqual(names.filter(name => !expected.has(name)), [], "the build leaves no temporary file or journal of its own");
    store.close();
  } finally {
    f.close();
  }
});

test("two stores opened one after the other on one path share the file", () => {
  const f = fixture();
  try {
    const first = open(f);
    const inode = statSync(f.path).ino;
    const second = open(f);
    assert.equal(first.status().state, "ready");
    assert.equal(second.status().state, "ready");
    assert.equal(statSync(f.path).ino, inode, "the second store opens the existing file");
    first.write(tx => first.appendEvent(tx, event()));
    assert.equal(second.hasEvent("run-a:member.reported:1"), true);
    second.write(tx => second.appendEvent(tx, event({ key: "run-a:member.reported:2" })));
    assert.equal(first.events({ limit: 10 }).events.length, 2);
    assert.deepEqual(readdirSync(dirname(f.path)).filter(name => name.includes(".creating-")), []);
    first.close();
    second.close();
  } finally {
    f.close();
  }
});

test("a module that deletes run rows must list its runs", () => {
  const f = fixture();
  try {
    const store = open(f);
    const withoutList: EvidenceModule = { name: "no-list", version: 1, readVersion: 1, migrate: () => undefined, deleteRun: () => undefined };
    assert.throws(() => store.register(withoutList), hasCode("invalid-module"));
    store.register({ ...withoutList, runIds: () => [] });
    assert.equal(store.status().modules["no-list"], "ready");
    store.close();
  } finally {
    f.close();
  }
});

test("an async module hook fails and commits nothing", async () => {
  const f = fixture();
  try {
    const first = open(f);
    first.register({
      name: "async-migrate",
      version: 1,
      readVersion: 1,
      async migrate(tx) {
        tx.exec("CREATE TABLE async_early (id TEXT)");
        await Promise.resolve();
        tx.exec("CREATE TABLE async_late (id TEXT)");
      },
    });
    assert.equal(first.status().modules["async-migrate"], "unavailable");
    first.register({
      ...hookedModule(),
      async deleteRun(tx, runId) {
        tx.run("DELETE FROM probe_rows WHERE run_id=?", runId);
        await Promise.resolve();
      },
    });
    first.write(tx => first.appendEvent(tx, event({ key: "async:1", runId: "run-a" })));
    addProbeRow(first, "row-a", "run-a");
    assert.equal(first.deleteRun("run-a"), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tableExists(first, "async_early"), false);
    assert.equal(tableExists(first, "async_late"), false);
    assert.equal(first.events({ runId: "run-a", limit: 10 }).events.length, 1);
    assert.deepEqual(probeRuns(first), ["run-a"]);
    first.close();

    const second = open(f);
    second.register({
      name: "async-read",
      version: 1,
      readVersion: 1,
      migrate: () => undefined,
      async runIds() {
        throw new Error("listed too late");
      },
      async counts() {
        throw new Error("counted too late");
      },
    });
    assert.equal(second.sweep(() => false), 1, "only the run in run_events is swept");
    assert.deepEqual(second.describe().counts, {});
    await new Promise(resolve => setImmediate(resolve));
    second.close();
  } finally {
    f.close();
  }
});

test("a locked database stops the sweep after one attempt", (t) => {
  const f = fixture();
  try {
    t.mock.method(console, "warn", () => undefined);
    const store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key, busyTimeoutMs: 50 });
    const defaultTimeout = open(f);
    store.write(tx => {
      for (const runId of ["gone-1", "gone-2", "gone-3"]) store.appendEvent(tx, event({ key: `${runId}:1`, runId }));
    });
    const attempts = t.mock.method(store, "write");
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec("BEGIN IMMEDIATE");
      assert.equal(store.sweep(() => false), 0);
      assert.equal(attempts.mock.callCount(), 1);
      const started = Date.now();
      assert.equal(defaultTimeout.tryWrite(() => undefined), false);
      assert.ok(Date.now() - started < 2000, "the default busy timeout fails fast");
      raw.exec("ROLLBACK");
    } finally {
      raw.close();
    }
    assert.equal(eventRows(store), 3);
    assert.equal(store.sweep(() => false), 3);
    assert.equal(eventRows(store), 0);
    store.close();
    defaultTimeout.close();
    assert.throws(() => new EvidenceStore({ databasePath: f.path, vaultKey: f.key, busyTimeoutMs: -1 }), TypeError);
  } finally {
    f.close();
  }
});

test("a delete that fails for one run does not stop the sweep", (t) => {
  const f = fixture();
  try {
    t.mock.method(console, "warn", () => undefined);
    const store = open(f);
    store.register({
      ...hookedModule(),
      deleteRun(tx, runId) {
        if (runId === "run-a") throw new Error("this run's rows cannot be removed");
        tx.run("DELETE FROM probe_rows WHERE run_id=?", runId);
      },
    });
    store.write(tx => {
      for (const runId of ["run-a", "run-b"]) store.appendEvent(tx, event({ key: `${runId}:1`, runId }));
    });
    assert.equal(store.sweep(() => false), 1);
    assert.deepEqual(store.events({ limit: 10 }).events.map(item => item.runId), ["run-a"]);
    assert.equal(store.sweep(() => false), 0, "the failing run stays for the next sweep");
    store.close();
  } finally {
    f.close();
  }
});

test("a reader that cannot open reports the store unavailable", { skip: process.getuid?.() === 0 }, (t) => {
  const f = fixture();
  try {
    t.mock.method(console, "warn", () => undefined);
    const store = open(f);
    store.write(tx => store.appendEvent(tx, event()));
    chmodSync(f.path, 0o200);
    try {
      const described = store.describe();
      assert.equal(described.state, "unavailable");
      assert.equal(described.reason, "reader-unavailable");
      assert.equal(described.events, 0);
      assert.equal(Object.values(described.modules).every(state => state === "unavailable"), true);
      assert.throws(() => store.read(db => db.get("SELECT 1 AS one")), hasCode("unavailable"));
      assert.throws(() => store.events({ limit: 10 }), hasCode("unavailable"));
      assert.throws(() => store.hasEvent("run-a:member.reported:1"), hasCode("unavailable"));
    } finally {
      chmodSync(f.path, 0o600);
    }
    assert.equal(store.describe().state, "ready", "the reader opens once the file is readable again");
    assert.equal(store.hasEvent("run-a:member.reported:1"), true);
    store.close();
  } finally {
    f.close();
  }
});

test("log lines hold only fixed tokens", (t) => {
  const f = fixture();
  try {
    const warn = t.mock.method(console, "warn", () => undefined);
    const marker = "log-marker-from-a-caller";
    const hostile = () => Object.assign(new Error(marker), { name: marker, code: marker, errstr: marker });
    const store = open(f);
    store.register({ name: "hostile", version: 1, readVersion: 1, migrate: () => { throw hostile(); } });
    store.register({
      name: "hostile-read",
      version: 1,
      readVersion: 1,
      migrate: () => undefined,
      runIds: () => { throw hostile(); },
      counts: () => { throw hostile(); },
    });
    assert.equal(store.tryWrite(() => { throw hostile(); }), false);
    store.write(tx => store.appendEvent(tx, event()));
    assert.equal(store.sweep(() => false), 1);
    store.describe();
    store.close();
    const lines = warn.mock.calls.map(call => call.arguments.map(String).join(" "));
    assert.ok(lines.length >= 4, "every failure above logs a line");
    for (const line of lines) assert.equal(line.includes(marker), false, line);
  } finally {
    f.close();
  }
});

test("statements cannot cross the transaction boundary", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(probeModule(1));
    const ids = () => store.read(db => db.all<{ id: string }>("SELECT id FROM probe_rows ORDER BY id")).map(row => row.id);
    assert.throws(() => store.read(db => db.get("INSERT INTO probe_rows (id, run_id) VALUES ('read', 'run-a') RETURNING id")));
    assert.deepEqual(ids(), []);
    const refused = [
      "COMMIT",
      "  rollback",
      "END TRANSACTION",
      "BEGIN IMMEDIATE",
      "SAVEPOINT inner",
      "RELEASE inner",
      "PRAGMA journal_mode=DELETE",
      "ATTACH DATABASE 'other.sqlite3' AS other",
      "DETACH other",
      "VACUUM",
      "/* note */ COMMIT",
      "-- note\nCOMMIT",
      "; COMMIT",
    ];
    for (const sql of refused) {
      assert.throws(() => store.write(tx => tx.exec(sql)), hasCode("invalid-statement"), sql);
      assert.throws(() => store.write(tx => tx.run(sql)), hasCode("invalid-statement"), sql);
      assert.throws(() => store.write(tx => tx.get(sql)), hasCode("invalid-statement"), sql);
      assert.throws(() => store.write(tx => tx.all(sql)), hasCode("invalid-statement"), sql);
      assert.throws(() => store.read(db => db.get(sql)), hasCode("invalid-statement"), sql);
    }

    // `exec` runs every statement in its text. A later COMMIT or ROLLBACK ends the transaction and fails the write.
    assert.throws(() => store.write(tx => tx.exec("CREATE TABLE t(id); COMMIT;")), hasCode("invalid-statement"));
    assert.equal(tableExists(store, "t"), false, "the refusal comes before any statement runs");
    assert.throws(() => store.write(tx => {
      tx.exec("INSERT INTO probe_rows (id, run_id) VALUES ('rolled-back', 'run-a'); ROLLBACK");
      tx.run("INSERT INTO probe_rows (id, run_id) VALUES ('outside-the-write', 'run-a')");
    }), hasCode("invalid-statement"));
    assert.deepEqual(ids(), [], "the callback stops before a statement can run outside the transaction");

    store.write(tx => {
      tx.run("INSERT INTO probe_rows (id, run_id) VALUES ('COMMIT; ROLLBACK', 'run-a')");
      tx.exec("/* COMMIT */ INSERT INTO probe_rows (id, run_id) VALUES ('commented', 'run-a'); -- COMMIT");
      tx.exec("CREATE TABLE probe_log (id TEXT); "
        + "CREATE TRIGGER probe_logged AFTER INSERT ON probe_rows BEGIN "
        + "INSERT INTO probe_log (id) SELECT CASE WHEN NEW.id = 'skip' THEN 'skipped' ELSE NEW.id END; END;");
      tx.run("INSERT INTO probe_rows (id, run_id) VALUES ('after-trigger', 'run-a')");
    });
    assert.deepEqual(ids(), ["COMMIT; ROLLBACK", "after-trigger", "commented"]);
    assert.deepEqual(store.read(db => db.all<{ id: string }>("SELECT id FROM probe_log")).map(row => row.id), ["after-trigger"]);
    store.close();
  } finally {
    f.close();
  }
});

test("closing the store during a write keeps the file intact", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(probeModule(1));
    store.write(tx => tx.run("INSERT INTO probe_rows (id, run_id) VALUES ('kept', 'run-a')"));
    assert.throws(() => store.write(tx => {
      tx.run("INSERT INTO probe_rows (id, run_id) VALUES ('lost', 'run-a')");
      store.close();
      tx.run("INSERT INTO probe_rows (id, run_id) VALUES ('late', 'run-a')");
    }), hasCode("unavailable"));
    assert.equal(store.status().reason, "closed");
    const raw = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.deepEqual({ ...raw.prepare("PRAGMA integrity_check").get() }, { integrity_check: "ok" });
    } finally {
      raw.close();
    }
    const reopened = open(f);
    assert.equal(reopened.status().state, "ready");
    const ids = reopened.read(db => db.all<{ id: string }>("SELECT id FROM probe_rows ORDER BY id")).map(row => row.id);
    assert.deepEqual(ids, ["kept"]);
    reopened.close();
  } finally {
    f.close();
  }
});

function notesModule(): EvidenceModule {
  return {
    name: "notes",
    version: 1,
    readVersion: 1,
    migrate: tx => tx.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)"),
  };
}

function notes(store: EvidenceStore): string[] {
  return store.read(db => db.all<{ note: string }>("SELECT note FROM probe ORDER BY id")).map(row => row.note);
}

test("a later statement cannot commit the store's transaction", (t) => {
  const f = fixture();
  try {
    const warn = t.mock.method(console, "warn", () => undefined);
    const store = open(f);
    const written = store.tryWrite(tx => {
      store.appendEvent(tx, event({ key: "commit-probe:1" }));
      tx.exec("SELECT 1; COMMIT;");
    });
    assert.equal(written, false);
    assert.equal(warn.mock.calls.some(call => String(call.arguments[0]).includes("invalid-statement")), true);
    assert.equal(store.hasEvent("commit-probe:1"), false);
    assert.deepEqual(store.events({ limit: 10 }).events, []);
    assert.equal(store.tryWrite(tx => {
      store.appendEvent(tx, event({ key: "commit-probe:2" }));
    }), true);
    assert.deepEqual(store.events({ limit: 10 }).events.map(item => item.key), ["commit-probe:2"]);
    store.close();
  } finally {
    f.close();
  }
});

test("a later statement cannot restart the store's transaction", (t) => {
  const f = fixture();
  try {
    t.mock.method(console, "warn", () => undefined);
    const store = open(f);
    const written = store.tryWrite(tx => {
      store.appendEvent(tx, event({ key: "restart-probe:1" }));
      tx.exec("SELECT 1; ROLLBACK; BEGIN IMMEDIATE;");
    });
    assert.equal(written, false);
    assert.equal(store.hasEvent("restart-probe:1"), false);
    assert.deepEqual(store.events({ limit: 10 }).events, []);
    assert.equal(store.tryWrite(tx => {
      store.appendEvent(tx, event({ key: "restart-probe:2" }));
    }), true);
    assert.deepEqual(store.events({ limit: 10 }).events.map(item => item.key), ["restart-probe:2"]);
    store.close();
  } finally {
    f.close();
  }
});

test("transaction control is refused in every position and spelling", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(probeModule(1));
    const refused = [
      "select 1;\n  commit",
      "SELECT 1; /* x */ END TRANSACTION",
      "SELECT 1; -- note\nROLLBACK",
      "SELECT 1; SAVEPOINT a",
      "SELECT 1; RELEASE a",
      "SELECT 1; ATTACH DATABASE ':memory:' AS other",
      "SELECT 1; PRAGMA journal_mode=DELETE",
      "SELECT 1; VACUUM",
      "SELECT 1; ﻿COMMIT",
      // SQLite reads `$a(;...)` as one Tcl-style parameter, so its `;` ends nothing. The form is refused.
      "SELECT $a(;CREATE/**/TRIGGER); END;",
    ];
    for (const sql of refused) {
      const sentinel = new Error("roll the write back");
      assert.throws(() => store.write(tx => {
        store.appendEvent(tx, event({ key: `spelling:${sql}` }));
        assert.throws(() => tx.exec(sql), hasCode("invalid-statement"), sql);
        tx.run("INSERT INTO probe_rows (id, run_id) VALUES (?, 'run-a')", sql);
        assert.equal(tx.get<{ count: number }>("SELECT count(*) AS count FROM probe_rows")?.count, 1, sql);
        throw sentinel;
      }), (error: unknown) => error === sentinel, sql);
      assert.deepEqual(store.events({ limit: 10 }).events, [], sql);
      assert.equal(store.read(db => db.get<{ count: number }>("SELECT count(*) AS count FROM probe_rows"))?.count, 0, sql);
    }
    store.close();
  } finally {
    f.close();
  }
});

test("inert text that looks like transaction control is accepted", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(notesModule());
    const written = store.tryWrite(tx => {
      tx.exec("INSERT INTO probe (note) VALUES ('a; COMMIT; b')");
      tx.exec("INSERT INTO probe (note) VALUES ('it''s; ROLLBACK')");
      tx.exec("SELECT 1; -- ; COMMIT\nSELECT 2;");
      tx.exec("SELECT 1; /* ; COMMIT; */ SELECT 2;");
      tx.exec("SELECT 1; -- a carriage return does not end this comment\r COMMIT");
      tx.exec("SELECT \"x; ROLLBACK\" FROM (SELECT 1 AS \"x; ROLLBACK\")");
      tx.exec("SELECT [y; COMMIT] FROM (SELECT 1 AS [y; COMMIT])");
      tx.exec("SELECT `z; END` FROM (SELECT 1 AS `z; END`)");
    });
    assert.equal(written, true);
    assert.deepEqual(notes(store), ["a; COMMIT; b", "it's; ROLLBACK"]);
    store.close();
  } finally {
    f.close();
  }
});

test("a trigger with CASE and END is accepted, and control after it is refused", () => {
  const f = fixture();
  try {
    const store = open(f);
    store.register(notesModule());
    const trigger = "CREATE TRIGGER probe_case AFTER INSERT ON probe BEGIN SELECT CASE WHEN NEW.id > 0 THEN 1 ELSE 0 END; "
      + "UPDATE probe SET note = 'seen' WHERE id = NEW.id; END;";
    assert.equal(store.tryWrite(tx => tx.exec(trigger)), true);
    assert.equal(store.tryWrite(tx => tx.run("INSERT INTO probe (note) VALUES ('new')")), true);
    assert.deepEqual(notes(store), ["seen"]);

    assert.throws(() => store.write(tx => {
      tx.run("INSERT INTO probe (note) VALUES ('lost')");
      tx.exec(`${trigger} COMMIT;`);
    }), hasCode("invalid-statement"));
    assert.deepEqual(notes(store), ["seen"], "nothing from the refused write is stored");

    for (const temp of ["TEMP", "TEMPORARY"]) {
      const sql = `CREATE ${temp} TRIGGER probe_${temp.toLowerCase()} AFTER INSERT ON probe BEGIN `
        + "SELECT CASE WHEN NEW.id > 0 THEN 1 ELSE 0 END; END;";
      assert.equal(store.tryWrite(tx => tx.exec(sql)), true, temp);
    }
    store.close();
  } finally {
    f.close();
  }
});
