import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError } from "../packages/host/src/evidence/types.js";
import type { TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-blackboard-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture, options: { key?: Buffer; busyTimeoutMs?: number } = {}): EvidenceStore {
  return new EvidenceStore({
    databasePath: f.path,
    vaultKey: options.key ?? f.key,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  });
}

function rowCount(store: EvidenceStore, table: "entries" | "member_scopes", runId?: string): number {
  return store.read(db => {
    const row = runId === undefined
      ? db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
      : db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE run_id=?`, runId);
    return row?.n ?? 0;
  });
}

function memberOf(run: TeamRun, memberId: string): TeamMember {
  const member = run.members.find(item => item.memberId === memberId);
  if (!member) throw new Error("fixture member missing");
  return member;
}

const SIZES = { launchSeq: 8, promptBytes: 1200, contextBytes: 4000 };

test("the module registers once and creates its tables", () => {
  const f = fixture();
  try {
    const store = open(f);
    new Blackboard(store);
    assert.equal(store.status().modules.blackboard, "ready");
    const names = store.read(db => db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
    ).map(row => row.name));
    for (const name of ["entries", "member_scopes", "entries_by_run", "entries_by_task", "entries_by_mission", "member_scopes_by_run"]) {
      assert.ok(names.includes(name), name);
    }
    assert.throws(() => new Blackboard(store), TypeError);
    store.close();

    const reopened = open(f);
    new Blackboard(reopened);
    const version = reopened.read(db => db.get<{ version: number }>(
      "SELECT version FROM schema_modules WHERE name='blackboard'",
    )?.version);
    assert.equal(version, 1);
    reopened.close();
  } finally {
    f.close();
  }
});

test("mirror stores each source once", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const run = hostEntryRun();
    assert.equal(board.mirror(run), true);
    const page = board.list(run.id, {});
    assert.equal(page.entries.length, 8);
    const seqs = page.entries.map(entry => entry.seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
    assert.equal(new Set(seqs).size, seqs.length);
    assert.equal(board.mirror(run), true);
    assert.equal(rowCount(store, "entries"), 8);
    const highest = Math.max(...seqs);
    store.close();

    const reopened = open(f);
    const again = new Blackboard(reopened);
    assert.equal(again.mirror(run), true);
    assert.equal(rowCount(reopened, "entries"), 8);
    assert.equal(again.launchMark(run.id), highest);
    reopened.close();
  } finally {
    f.close();
  }
});

test("no run text reaches a plain column or the file", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const run = hostEntryRun();
    run.tasks[0].id = "wire-settings-form";
    run.tasks[0].changedPaths = { paths: ["src/path-marker.ts"], truncated: false };
    run.checks[0].output = "check-output-marker";
    memberOf(run, hostEntryIds.implA).report = { kind: "result", summary: "entry-plain-marker" };
    assert.equal(board.mirror(run), true);

    const markers = ["wire-settings-form", "entry-plain-marker", "check-output-marker", "src/path-marker.ts"];
    // The WAL holds the written pages only while the store is open, so it is read before the close.
    const wal = readFileSync(`${f.path}-wal`);
    assert.ok(wal.length > 0, "the write is in the WAL");
    for (const marker of markers) assert.equal(wal.includes(marker), false, `WAL: ${marker}`);
    store.close();
    const file = readFileSync(f.path);
    for (const marker of markers) assert.equal(file.includes(marker), false, `file: ${marker}`);

    const raw = new DatabaseSync(f.path, { readOnly: true });
    try {
      const rows = raw.prepare("SELECT task_key, entry_id FROM entries").all() as { task_key: string | null; entry_id: string }[];
      assert.equal(rows.length, 8);
      for (const row of rows) {
        assert.ok(row.task_key === null || /^[0-9a-f]{64}$/.test(row.task_key));
        assert.match(row.entry_id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    } finally {
      raw.close();
    }
  } finally {
    f.close();
  }
});

test("a sealed body never opens as a head", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const run = hostEntryRun();
    assert.equal(board.mirror(run), true);
    store.write(tx => {
      tx.run("UPDATE entries SET encrypted_head = encrypted_body WHERE seq = (SELECT MIN(seq) FROM entries)");
    });
    assert.throws(() => board.list(run.id, {}));
    store.close();
  } finally {
    f.close();
  }
});

test("list filters and pages", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const run = hostEntryRun();
    board.mirror(run);

    const checks = board.list(run.id, { kinds: ["check"] });
    assert.equal(checks.entries.length, 1);

    const byTask = board.list(run.id, { taskId: "a" });
    assert.deepEqual(byTask.entries.map(entry => entry.kind).sort(), ["integration", "report"]);
    assert.equal(byTask.entries.find(entry => entry.kind === "report")?.authorRole, "implementer");

    const first = board.list(run.id, { limit: 3 });
    assert.equal(first.entries.length, 3);
    assert.equal(first.more, true);
    assert.equal(first.cursor, first.entries[2].seq);

    const second = board.list(run.id, { limit: 3, since: first.cursor });
    assert.equal(second.entries.length, 3);
    assert.ok(second.entries[0].seq > first.cursor);

    assert.equal(board.list(run.id, { limit: 1000 }).entries.length, 8);
    store.close();
  } finally {
    f.close();
  }
});

test("get serves only the run's own entry", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const run = hostEntryRun();
    board.mirror(run);
    const [first] = board.list(run.id, { limit: 1 }).entries;
    const found = board.get(run.id, first.entryId);
    assert.ok(found);
    assert.equal(found.head.entryId, first.entryId);
    assert.equal(typeof found.body, "object");
    assert.equal(board.get(randomUUID(), first.entryId), undefined);
    assert.equal(board.get(run.id, randomUUID()), undefined);
    store.close();
  } finally {
    f.close();
  }
});

test("an oversized or unserializable body is refused and counted", () => {
  const f = fixture();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const run = hostEntryRun();
    run.checks[0].output = "x".repeat(1_100_000);
    (memberOf(run, hostEntryIds.rev).report as unknown as Record<string, unknown>).weight = 2n;

    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    assert.equal(board.mirror(run), true, "a refused body leaves nothing to store");
    const firstRound = warnings.length;
    assert.equal(firstRound, 2);
    assert.equal(board.list(run.id, { limit: 100 }).entries.length, 6);
    assert.equal(store.describe().counts["blackboard.refused"], 2);

    assert.equal(board.mirror(run), true);
    assert.equal(warnings.length, firstRound);
    assert.equal(rowCount(store, "entries"), 6);
    store.close();
  } finally {
    console.warn = originalWarn;
    f.close();
  }
});

test("a failed write waits a minute before it retries", () => {
  const f = fixture();
  try {
    const store = open(f, { busyTimeoutMs: 0 });
    let clock = 1_000_000;
    const board = new Blackboard(store, { now: () => clock });
    const run = hostEntryRun();
    const blocker = new DatabaseSync(f.path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      assert.equal(board.mirror(run), false);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    clock += 59_000;
    assert.equal(board.mirror(run), false);
    assert.equal(rowCount(store, "entries"), 0);
    clock += 2_000;
    assert.equal(board.mirror(run), true);
    assert.equal(rowCount(store, "entries"), 8);
    store.close();
  } finally {
    f.close();
  }
});

test("a failed write also holds back launch sizes", () => {
  const f = fixture(), g = fixture();
  try {
    // A failed mirror write holds back the run's launch sizes for the same minute.
    const store = open(f, { busyTimeoutMs: 0 });
    let clock = 1_000_000;
    const board = new Blackboard(store, { now: () => clock });
    const run = hostEntryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const blocker = new DatabaseSync(f.path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      assert.equal(board.mirror(run), false);
      assert.equal(board.recordLaunch(run, implA, SIZES), false);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    // The lock is gone, so a write would succeed now. The run still waits out its minute.
    clock += 59_000;
    assert.equal(board.recordLaunch(run, implA, SIZES), false);
    assert.equal(rowCount(store, "member_scopes"), 0);
    clock += 2_000;
    assert.equal(board.recordLaunch(run, implA, SIZES), true);
    assert.equal(rowCount(store, "member_scopes"), 1);
    store.close();

    // A failed launch write starts the same minute for the run's mirror.
    const second = open(g, { busyTimeoutMs: 0 });
    let later = 1_000_000;
    const other = new Blackboard(second, { now: () => later });
    const lock = new DatabaseSync(g.path);
    try {
      lock.exec("BEGIN IMMEDIATE");
      assert.equal(other.recordLaunch(run, implA, SIZES), false);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    later += 59_000;
    assert.equal(other.mirror(run), false);
    assert.equal(rowCount(second, "entries"), 0);
    later += 2_000;
    assert.equal(other.mirror(run), true);
    second.close();
  } finally {
    f.close();
    g.close();
  }
});

test("the retry pass pauses after its own failed write", () => {
  const f = fixture(), g = fixture();
  try {
    const store = open(f, { busyTimeoutMs: 0 });
    let clock = 1_000_000;
    const board = new Blackboard(store, { now: () => clock });
    const run = hostEntryRun();
    assert.equal(board.retryable(), true);
    const blocker = new DatabaseSync(f.path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      assert.equal(board.retry(run), "failed");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    assert.equal(board.retryable(), false);
    clock += 59_000;
    assert.equal(board.retryable(), false);
    clock += 2_000;
    assert.equal(board.retryable(), true);
    assert.equal(board.retry(run), "done");
    assert.equal(rowCount(store, "entries"), 8);
    // A value that is not a run record cannot be helped by a retry.
    assert.equal(board.retry(null as never), "done");
    assert.equal(board.retryable(), true);
    store.close();
    assert.equal(board.retryable(), false, "a closed store is not retryable");

    open(g).close();
    const wrong = open(g, { key: randomBytes(32) });
    assert.equal(new Blackboard(wrong).retryable(), false);
    wrong.close();
  } finally {
    f.close();
    g.close();
  }
});

test("a failed save write holds back only its own run", () => {
  const f = fixture();
  try {
    const store = open(f, { busyTimeoutMs: 0 });
    let clock = 1_000_000;
    const board = new Blackboard(store, { now: () => clock });
    const run = hostEntryRun();
    const other = { ...hostEntryRun(), id: randomUUID() };
    const blocker = new DatabaseSync(f.path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      assert.equal(board.mirror(run), false);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    assert.equal(board.held(run.id), true);
    assert.equal(board.held(other.id), false);
    // A save that fails says nothing about the other runs, so the retry pass goes on.
    assert.equal(board.retryable(), true);
    assert.equal(board.retry(run), "more", "a held run is not written");
    assert.equal(rowCount(store, "entries"), 0);
    assert.equal(board.retry(other), "done");
    clock += 61_000;
    assert.equal(board.held(run.id), false);
    assert.equal(board.retry(run), "done");
    store.close();
  } finally {
    f.close();
  }
});

test("an unavailable store answers nothing and writes nothing", () => {
  const f = fixture();
  try {
    open(f).close();
    const store = open(f, { key: randomBytes(32) });
    const board = new Blackboard(store);
    const run = hostEntryRun();
    assert.equal(board.mirror(run), false);
    assert.equal(board.launchMark(run.id), undefined);
    assert.equal(board.recordLaunch(run, memberOf(run, hostEntryIds.implA), SIZES), false);
    assert.throws(() => board.list(run.id, {}), (error: unknown) =>
      error instanceof EvidenceError && error.code === "unavailable");
    store.close();
  } finally {
    f.close();
  }
});

test("launch sizes are kept per member", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const run = hostEntryRun();
    const other = { ...hostEntryRun(), id: randomUUID() };
    board.mirror(other);
    assert.equal(board.launchMark(run.id), 0);
    board.mirror(run);
    const highest = Math.max(...board.list(run.id, {}).entries.map(entry => entry.seq));
    assert.equal(board.launchMark(run.id), highest);

    const implA = memberOf(run, hostEntryIds.implA);
    assert.equal(board.recordLaunch(run, implA, { ...SIZES, launchSeq: 8 }), true);
    assert.deepEqual(board.contextUsage(run.id), [{
      memberId: hostEntryIds.implA,
      role: "implementer",
      launchSeq: 8,
      promptBytes: 1200,
      contextBytes: 4000,
      digestBytes: 0,
      servedBytes: 0,
      listCalls: 0,
      getCalls: 0,
    }]);

    assert.equal(board.recordLaunch(run, implA, { ...SIZES, contextBytes: 4100 }), true);
    const usage = board.contextUsage(run.id);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].contextBytes, 4100);

    const scope = store.read(db => db.get<{ encrypted_scope: string }>(
      "SELECT encrypted_scope FROM member_scopes WHERE member_id=?",
      hostEntryIds.implA,
    ));
    assert.deepEqual(
      scope === undefined ? undefined : openScope(store, hostEntryIds.implA, scope.encrypted_scope),
      { taskId: "a", paths: ["a.txt"] },
    );

    const implB = memberOf(run, hostEntryIds.implB);
    assert.equal(board.recordLaunch(run, implB, { launchSeq: undefined, promptBytes: 1, contextBytes: 1 }), false);
    assert.equal(board.contextUsage(run.id).length, 1);
    store.close();
  } finally {
    f.close();
  }
});

test("deleting a run removes its entries and scopes", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const a = hostEntryRun();
    const b = { ...hostEntryRun(), id: randomUUID() };
    board.mirror(a);
    board.mirror(b);
    board.recordLaunch(a, { ...memberOf(a, hostEntryIds.implA), memberId: randomUUID() }, SIZES);
    board.recordLaunch(b, { ...memberOf(b, hostEntryIds.implA), memberId: randomUUID() }, SIZES);

    assert.equal(store.deleteRun(a.id), true);
    assert.equal(board.list(a.id, {}).entries.length, 0);
    assert.deepEqual(board.contextUsage(a.id), []);
    assert.equal(board.list(b.id, {}).entries.length, 8);
    assert.equal(board.contextUsage(b.id).length, 1);

    assert.equal(board.mirror(a), true);
    assert.equal(board.list(a.id, {}).entries.length, 8);

    const c = randomUUID();
    board.recordLaunch({ ...a, id: c }, { ...memberOf(a, hostEntryIds.implA), memberId: randomUUID() }, SIZES);
    assert.equal(store.sweep(id => id === b.id), 2);
    assert.equal(board.list(a.id, {}).entries.length, 0);
    assert.deepEqual(board.contextUsage(c), []);
    assert.equal(board.list(b.id, {}).entries.length, 8);
    assert.equal(board.contextUsage(b.id).length, 1);
    store.close();
  } finally {
    f.close();
  }
});

test("mirror never throws", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    assert.equal(board.mirror(null as never), false);
    const broken = { ...hostEntryRun(), members: "not-an-array" as never };
    assert.equal(board.mirror(broken), false);
    store.close();
    assert.equal(board.mirror(hostEntryRun()), false);
  } finally {
    f.close();
  }
});

/** Opens one sealed member scope with the store's key, through the store's own reader. */
function openScope(store: EvidenceStore, memberId: string, sealed: string): unknown {
  return store.read(db => db.open("member_scopes", memberId, sealed));
}
