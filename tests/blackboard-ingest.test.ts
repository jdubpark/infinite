import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Blackboard, type MemberPostRecord } from "../packages/host/src/evidence/blackboard.js";
import { getForMember, listForMember, readMemberScope } from "../packages/host/src/evidence/entry-reads.js";
import { MEMBER_ENTRY_KINDS } from "../packages/host/src/evidence/entry-types.js";
import { memberEntryId, memberEntryPostSchema, type MemberEntryPost } from "../packages/host/src/evidence/member-entry.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError, type EvidenceTx } from "../packages/host/src/evidence/types.js";
import type { TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";

type Fixture = { path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-blackboard-ingest-"));
  return {
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

/** Opens a fresh store and a Blackboard on it, then closes the store. */
function withBoard(fn: (store: EvidenceStore, board: Blackboard) => void): void {
  const f = fixture();
  try {
    const store = open(f);
    try {
      fn(store, new Blackboard(store));
    } finally {
      store.close();
    }
  } finally {
    f.close();
  }
}

function rowCount(store: EvidenceStore, runId?: string): number {
  return store.read(db => {
    const row = runId === undefined
      ? db.get<{ n: number }>("SELECT count(*) AS n FROM entries")
      : db.get<{ n: number }>("SELECT count(*) AS n FROM entries WHERE run_id=?", runId);
    return row?.n ?? 0;
  });
}

/** The fixture run with the blackboard switch pinned and the entry tools on the three posting members. */
function entryRun(): TeamRun {
  const run = hostEntryRun();
  run.blackboard = { tools: true };
  for (const member of run.members) {
    if ([hostEntryIds.pm, hostEntryIds.implA, hostEntryIds.implB].includes(member.memberId)) member.entryTools = true;
  }
  return run;
}

function memberOf(run: TeamRun, memberId: string): TeamMember {
  const member = run.members.find(item => item.memberId === memberId);
  if (!member) throw new Error("fixture member missing");
  return member;
}

/** A second member of the same role and task, with its own id and the entry tools. */
function sibling(member: TeamMember): TeamMember {
  return { ...member, memberId: randomUUID(), entryTools: true };
}

const SIZES = { launchSeq: 8, promptBytes: 1200, contextBytes: 4000 };
const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;

function contract(summary: string, extra: Record<string, unknown> = {}): MemberEntryPost {
  return memberEntryPostSchema.parse({
    kind: "contract",
    summary,
    paths: [],
    body: { interface: "Shared route", change: summary },
    ...extra,
  });
}

function finding(summary: string, extra: Record<string, unknown> = {}): MemberEntryPost {
  return memberEntryPostSchema.parse({
    kind: "finding",
    summary,
    paths: [],
    body: { items: [{ source: "npm test", observation: summary }] },
    ...extra,
  });
}

function handoff(summary: string, taskId: string): MemberEntryPost {
  return memberEntryPostSchema.parse({
    kind: "handoff",
    summary,
    paths: [],
    taskId,
    body: { done: [summary], remaining: [], commands: [] },
  });
}

/** A post record for `member`'s binding, unless the options name another binding. */
function post(
  member: TeamMember,
  entry: MemberEntryPost,
  options: { at?: string; memberId?: string; revision?: number; requestId?: string } = {},
): MemberPostRecord {
  const binding = {
    runId: member.runId,
    memberId: options.memberId ?? member.memberId,
    revision: options.revision ?? member.revision,
  };
  return {
    seq: 0,
    at: options.at ?? at(10),
    envelope: { op: "post", ...binding, requestId: options.requestId ?? memberEntryId(binding, entry), entry },
  };
}

/** The stored (entry_id, state) pairs of the run, sorted by entry id, so list order does not matter. */
function stateTable(board: Blackboard, runId: string): [string, string][] {
  return board.list(runId, { limit: 100 }).entries
    .map(entry => [entry.entryId, entry.state] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sortPairs(pairs: [string, string][]): [string, string][] {
  return [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The six orders of three items, as indexes. */
const ORDERS: number[][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/** Phase 2's version 1 statements, copied as they were shipped. */
const VERSION_1_SCHEMA = [
  "CREATE TABLE entries ("
  + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
  + "entry_id TEXT NOT NULL UNIQUE, "
  + "scope TEXT NOT NULL, "
  + "run_id TEXT NOT NULL, "
  + "mission_id TEXT, "
  + "revision INTEGER NOT NULL, "
  + "at TEXT NOT NULL, "
  + "kind TEXT NOT NULL, "
  + "author TEXT NOT NULL, "
  + "authority TEXT NOT NULL, "
  + "author_member_id TEXT, "
  + "task_key TEXT, "
  + "state TEXT NOT NULL DEFAULT 'active', "
  + "body_bytes INTEGER NOT NULL, "
  + "encrypted_head TEXT NOT NULL, "
  + "encrypted_body TEXT)",
  "CREATE INDEX entries_by_run ON entries (run_id, seq)",
  "CREATE INDEX entries_by_task ON entries (run_id, task_key, seq)",
  "CREATE INDEX entries_by_mission ON entries (mission_id, seq) WHERE mission_id IS NOT NULL",
  "CREATE TABLE member_scopes ("
  + "member_id TEXT PRIMARY KEY, "
  + "run_id TEXT NOT NULL, "
  + "mission_id TEXT, "
  + "role TEXT NOT NULL, "
  + "launch_seq INTEGER NOT NULL, "
  + "prompt_bytes INTEGER NOT NULL, "
  + "context_bytes INTEGER NOT NULL, "
  + "digest_bytes INTEGER NOT NULL, "
  + "served_bytes INTEGER NOT NULL DEFAULT 0, "
  + "list_calls INTEGER NOT NULL DEFAULT 0, "
  + "get_calls INTEGER NOT NULL DEFAULT 0, "
  + "encrypted_scope TEXT NOT NULL)",
  "CREATE INDEX member_scopes_by_run ON member_scopes (run_id)",
];

const VERSION_1_COLUMNS = "seq, entry_id, scope, run_id, mission_id, revision, at, kind, author, authority, "
  + "author_member_id, task_key, state, body_bytes, encrypted_head, encrypted_body";

test("a version 1 store migrates to version 2", () => {
  const f = fixture();
  try {
    const first = open(f);
    first.register({
      name: "blackboard",
      version: 1,
      readVersion: 1,
      migrate(tx: EvidenceTx, from: number) {
        if (from >= 1) return;
        for (const statement of VERSION_1_SCHEMA) tx.exec(statement);
      },
    });
    const id = randomUUID();
    first.write(tx => {
      tx.run(
        "INSERT INTO entries (entry_id, scope, run_id, mission_id, revision, at, kind, author, authority, author_member_id, "
        + "task_key, state, body_bytes, encrypted_head, encrypted_body) VALUES (?, 'run', ?, NULL, 5, ?, 'report', 'host', "
        + "'receipt', NULL, NULL, 'active', 12, ?, ?)",
        id,
        hostEntryIds.run,
        at(0),
        tx.seal("entries", `${id}:head`, { paths: [], summary: "a version one row" }),
        tx.seal("entries", `${id}:body`, { text: "a version one body" }),
      );
    });
    const before = first.read(db => db.all<Record<string, unknown>>(`SELECT ${VERSION_1_COLUMNS} FROM entries`));
    assert.equal(before.length, 1);
    first.close();

    const reopened = open(f);
    const board = new Blackboard(reopened);
    assert.equal(reopened.status().modules.blackboard, "ready");
    const versions = reopened.read(db => db.get<{ version: number; read_version: number }>(
      "SELECT version, read_version FROM schema_modules WHERE name='blackboard'",
    ));
    assert.deepEqual({ ...versions }, { version: 2, read_version: 2 });
    const entryColumns = reopened.read(db => db.all<{ name: string }>("SELECT name FROM pragma_table_info('entries')"));
    assert.ok(entryColumns.some(column => column.name === "supersedes"));
    const scopeColumns = reopened.read(db => db.all<{ name: string }>("SELECT name FROM pragma_table_info('member_scopes')"));
    assert.ok(scopeColumns.some(column => column.name === "read_seq"));
    const after = reopened.read(db => db.all<Record<string, unknown>>(`SELECT ${VERSION_1_COLUMNS} FROM entries`));
    assert.deepEqual(after, before);
    assert.equal(board.list(hostEntryIds.run).entries.length, 1);
    reopened.close();
  } finally {
    f.close();
  }
});

test("posts are stored once as member claims", () => {
  withBoard((store, board) => {
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const posts = [
      post(implA, contract("contract-marker")),
      post(implA, finding("finding-marker")),
      post(implA, handoff("handoff-marker", "a")),
    ];
    assert.deepEqual(board.ingest(run, implA, posts, []), { result: "stored", stored: 3, dropped: 0, invalid: 0 });

    const page = board.list(run.id, { kinds: [...MEMBER_ENTRY_KINDS] });
    assert.equal(page.entries.length, 3);
    for (const head of page.entries) {
      assert.equal(head.author, "member");
      assert.equal(head.authority, "claim");
      assert.equal(head.authorRole, "implementer");
    }
    assert.equal(page.entries.find(head => head.kind === "handoff")?.taskId, "a");

    assert.deepEqual(board.ingest(run, implA, posts, []), { result: "stored", stored: 3, dropped: 0, invalid: 0 });
    assert.equal(rowCount(store), 3);

    const rows = store.read(db => db.all<Record<string, unknown>>("SELECT * FROM entries"));
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (column.startsWith("encrypted_")) continue;
        assert.equal(String(value).includes("contract-marker"), false, column);
      }
    }
  });
});

test("a post that does not match its member stores nothing", () => {
  withBoard((store, board) => {
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const implB = memberOf(run, hostEntryIds.implB);
    const pm = memberOf(run, hostEntryIds.pm);
    const rev = memberOf(run, hostEntryIds.rev);
    const cases: [TeamMember, MemberPostRecord][] = [
      [implA, post(implB, contract("another-member"))],
      [implA, post(implA, contract("another-revision"), { revision: implA.revision + 1 })],
      [implA, post(implA, contract("another-request"), { requestId: randomUUID() })],
      [pm, post(pm, finding("pm-finding"))],
      [implA, post(implA, handoff("task-b-handoff", "b"))],
      [rev, post(rev, finding("reviewer-without-tools"))],
    ];
    for (const [member, record] of cases) {
      assert.deepEqual(board.ingest(run, member, [record], []), { result: "stored", stored: 0, dropped: 0, invalid: 1 });
    }
    assert.equal(rowCount(store), 0);
    assert.equal(store.describe().counts["blackboard.invalid"], 6);
  });
});

test("the run holds at most 400 member entries", () => {
  withBoard((store, board) => {
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const implB = memberOf(run, hostEntryIds.implB);
    assert.equal(board.mirror(run), true);
    insertHostRows(store, run.id, 50);

    const first = Array.from({ length: 200 }, (_, index) => post(implA, contract(`first-${index}`)));
    const second = Array.from({ length: 199 }, (_, index) => post(implA, contract(`second-${index}`)));
    assert.equal(board.ingest(run, implA, first, []).stored, 200);
    assert.equal(board.ingest(run, implA, second, []).stored, 199);

    const third = [0, 1, 2].map(index => post(implB, contract(`third-${index}`)));
    assert.deepEqual(board.ingest(run, implB, third, []), { result: "stored", stored: 1, dropped: 2, invalid: 0 });
    assert.equal(store.describe().counts["blackboard.dropped"], 2);
    assert.equal(rowCount(store, run.id), 8 + 50 + 400);
    assert.deepEqual(board.ingest(run, implB, [post(implB, contract("fourth"))], []), { result: "stored", stored: 0, dropped: 1, invalid: 0 });
  });
});

/** Inserts `count` sealed host report rows into the run, the rows a member count must not read as members. */
function insertHostRows(store: EvidenceStore, runId: string, count: number): void {
  store.write(tx => {
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      tx.run(
        "INSERT INTO entries (entry_id, scope, run_id, mission_id, revision, at, kind, author, authority, author_member_id, "
        + "task_key, state, body_bytes, encrypted_head, encrypted_body) "
        + "VALUES (?, 'run', ?, NULL, 1, ?, 'report', 'host', 'receipt', NULL, NULL, 'active', 12, ?, ?)",
        id,
        runId,
        at(0),
        tx.seal("entries", `${id}:head`, { paths: [], summary: `host row ${index}` }),
        tx.seal("entries", `${id}:body`, { text: "host row" }),
      );
    }
  });
}

test("handoffs keep the latest for each task in every order", () => {
  const run = entryRun();
  const implA = memberOf(run, hostEntryIds.implA);
  const members = [implA, sibling(implA), sibling(implA)];
  const handoffs = members.map((member, index) => post(member, handoff(`handoff-${index}`, "a"), { at: at(index) }));
  const expected = sortPairs([
    [handoffs[0].envelope.requestId, "superseded"],
    [handoffs[1].envelope.requestId, "superseded"],
    [handoffs[2].envelope.requestId, "active"],
  ]);

  for (const order of ORDERS) {
    withBoard((_store, board) => {
      for (const index of order) {
        assert.equal(board.ingest(run, members[index], [handoffs[index]], []).stored, 1);
      }
      assert.deepEqual(stateTable(board, run.id), expected, `order ${order.join(",")}`);
    });
  }

  // Three handoffs of one member in one call resolve the same way.
  const same = [0, 1, 2].map(index => post(implA, handoff(`same-${index}`, "a"), { at: at(index) }));
  withBoard((_store, board) => {
    assert.equal(board.ingest(run, implA, same, []).stored, 3);
    assert.deepEqual(stateTable(board, run.id), sortPairs([
      [same[0].envelope.requestId, "superseded"],
      [same[1].envelope.requestId, "superseded"],
      [same[2].envelope.requestId, "active"],
    ]));
  });
});

test("a supersede chain resolves the same in every order", () => {
  const run = entryRun();
  const implA = memberOf(run, hostEntryIds.implA);
  const implB = memberOf(run, hostEntryIds.implB);
  const a = post(implA, contract("chain-a"), { at: at(0) });
  const idA = a.envelope.requestId;
  const b = post(implA, contract("chain-b", { supersedes: idA }), { at: at(1) });
  const idB = b.envelope.requestId;
  const c = post(implA, contract("chain-c", { supersedes: idB }), { at: at(2) });
  const chain = [a, b, c];
  const expected = sortPairs([[idA, "superseded"], [idB, "superseded"], [c.envelope.requestId, "active"]]);

  for (const order of ORDERS) {
    withBoard((_store, board) => {
      for (const index of order) assert.equal(board.ingest(run, implA, [chain[index]], []).stored, 1);
      assert.deepEqual(stateTable(board, run.id), expected, `order ${order.join(",")}`);
    });
  }

  withBoard((_store, board) => {
    assert.equal(board.ingest(run, implA, [a], []).stored, 1);
    // Another member's contract of another task, and a finding of another kind, name A and leave it active.
    assert.equal(board.ingest(run, implB, [post(implB, contract("b-names-a", { supersedes: idA }))], []).stored, 1);
    assert.equal(board.ingest(run, implA, [post(implA, finding("finding-names-a", { supersedes: idA }))], []).stored, 1);
    assert.deepEqual(stateTable(board, run.id).find(([id]) => id === idA), [idA, "active"]);
  });
});

test("read receipts count once", () => {
  withBoard((_store, board) => {
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    assert.equal(board.recordLaunch(run, implA, SIZES), true);

    assert.equal(board.ingest(run, implA, [], [
      { seq: 4, op: "list", servedBytes: 300 },
      { seq: 5, op: "get", servedBytes: 1000 },
    ]).result, "stored");
    let usage = board.contextUsage(run.id)[0];
    assert.equal(usage.listCalls, 1);
    assert.equal(usage.getCalls, 1);
    assert.equal(usage.servedBytes, 1300);

    assert.equal(board.ingest(run, implA, [], [
      { seq: 4, op: "list", servedBytes: 300 },
      { seq: 5, op: "get", servedBytes: 1000 },
      { seq: 6, op: "list", servedBytes: 200 },
    ]).result, "stored");
    usage = board.contextUsage(run.id)[0];
    assert.equal(usage.listCalls, 2);
    assert.equal(usage.getCalls, 1);
    assert.equal(usage.servedBytes, 1500);
  });
});

test("a failed ingest holds the run", () => {
  const f = fixture();
  try {
    const store = open(f, { busyTimeoutMs: 0 });
    let clock = 1_000_000;
    const board = new Blackboard(store, { now: () => clock });
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const record = post(implA, contract("held-marker"));

    const blocker = new DatabaseSync(f.path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      assert.deepEqual(board.ingest(run, implA, [record], []), { result: "failed", stored: 0, dropped: 0, invalid: 0 });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    assert.equal(rowCount(store), 0);

    clock += 59_000;
    assert.deepEqual(board.ingest(run, implA, [record], []), { result: "held", stored: 0, dropped: 0, invalid: 0 });
    assert.equal(rowCount(store), 0);

    clock += 2_000;
    assert.equal(board.ingest(run, implA, [record], []).result, "stored");
    assert.equal(rowCount(store), 1);
    store.close();
  } finally {
    f.close();
  }
});

test("withdraw hides nothing from the owner and changes state once", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const record = post(implA, contract("withdraw-marker"));
    const id = record.envelope.requestId;
    assert.equal(board.ingest(run, implA, [record], []).stored, 1);

    assert.equal(board.withdraw(run.id, id), "withdrawn");
    assert.equal(board.withdraw(run.id, id), "unchanged");
    assert.equal(board.withdraw(run.id, randomUUID()), undefined);
    assert.equal(board.withdraw(randomUUID(), id), undefined);

    const got = board.get(run.id, id);
    assert.equal(got?.head.state, "withdrawn");
    assert.equal((got?.body as { change: string }).change, "withdraw-marker");

    // The later post comes from the entry's own author, so the supersede rule would apply to an active entry.
    assert.equal(board.ingest(run, implA, [post(implA, contract("later", { supersedes: id }))], []).stored, 1);
    assert.equal(board.get(run.id, id)?.head.state, "withdrawn");

    // A later handoff of the same task supersedes only an active handoff, so the withdrawn one stays withdrawn.
    const first = post(implA, handoff("withdrawn-handoff", "a"));
    const firstId = first.envelope.requestId;
    assert.equal(board.ingest(run, implA, [first], []).stored, 1);
    assert.equal(board.withdraw(run.id, firstId), "withdrawn");
    const later = post(implA, handoff("later-handoff", "a"), { at: at(20) });
    const laterId = later.envelope.requestId;
    assert.equal(board.ingest(run, implA, [later], []).stored, 1);
    assert.equal(board.get(run.id, firstId)?.head.state, "withdrawn");
    assert.equal(board.get(run.id, laterId)?.head.state, "active");

    // A reader of the same task sees the later handoff, never the withdrawn one. The author's own posts are not listed to it.
    const reader = sibling(implA);
    assert.equal(board.mirror(run), true);
    const launchSeq = board.launchMark(run.id);
    if (launchSeq === undefined) throw new Error("no launch mark");
    assert.equal(board.recordLaunch(run, reader, { launchSeq, promptBytes: 1200, contextBytes: 4000 }), true);
    const scope = store.read(db => readMemberScope(db, reader.memberId));
    if (scope === undefined) throw new Error("member scope missing");
    const listed = store.read(db => listForMember(db, scope, undefined)).heads.map(head => head.entryId);
    assert.ok(listed.includes(laterId));
    assert.equal(listed.includes(firstId), false);
    assert.equal(store.read(db => getForMember(db, scope, firstId)), undefined);
    store.close();

    const wrong = open(f, { key: randomBytes(32) });
    try {
      const unavailable = new Blackboard(wrong);
      assert.throws(() => unavailable.withdraw(run.id, id), (error: unknown) => error instanceof EvidenceError && error.code === "unavailable");
    } finally {
      wrong.close();
    }
  } finally {
    f.close();
  }
});
