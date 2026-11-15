import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard, MEMBER_COUNT_SQL, type MemberPostRecord } from "../packages/host/src/evidence/blackboard.js";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import {
  ACTIVE_SCAN_SQL,
  ENTRY_NOTICE,
  RUN_SCAN_SQL,
  TASK_SCAN_SQL,
  addressedHeads,
  entryDigest,
  listForMember,
  getForMember,
  readMemberScope,
  type MemberList,
} from "../packages/host/src/evidence/entry-reads.js";
import { memberEntryId, memberEntryPostSchema, memberScopeOf, type MemberEntryPost, type MemberScope } from "../packages/host/src/evidence/member-entry.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";

type Fixture = { path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-entry-reads-"));
  return {
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture, key?: Buffer): EvidenceStore {
  return new EvidenceStore({ databasePath: f.path, vaultKey: key ?? f.key });
}

/** Opens a fresh store and a Blackboard on it, then closes the store. */
function withStore(fn: (f: Fixture, store: EvidenceStore, board: Blackboard) => void): void {
  const f = fixture();
  try {
    const store = open(f);
    try {
      fn(f, store, new Blackboard(store));
    } finally {
      store.close();
    }
  } finally {
    f.close();
  }
}

/** The fixture run with the blackboard switch pinned, the entry tools on four members, and tasks a and b with paths. */
function entryRun(): TeamRun {
  const run = hostEntryRun();
  run.blackboard = { tools: true };
  for (const member of run.members) {
    if ([hostEntryIds.pm, hostEntryIds.implA, hostEntryIds.implB, hostEntryIds.rev].includes(member.memberId)) {
      member.entryTools = true;
    }
  }
  const taskA = taskOf(run, "a");
  taskA.paths = ["src/a"];
  taskA.dependsOn = ["b"];
  taskOf(run, "b").paths = ["src/b"];
  return run;
}

function taskOf(run: TeamRun, id: string): TeamTask {
  const task = run.tasks.find(item => item.id === id);
  if (!task) throw new Error("fixture task missing");
  return task;
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

const SIZES = { launchSeq: 0, promptBytes: 1200, contextBytes: 4000 };
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

function blocker(summary: string, extra: Record<string, unknown> = {}): MemberEntryPost {
  return memberEntryPostSchema.parse({
    kind: "blocker",
    summary,
    paths: [],
    body: {
      cause: { status: "observed", detail: "The build fails" },
      proposedRecovery: "Retry after the fix",
      prevention: "Pin the version",
      validationEvidence: [{ sourceRef: "npm test", observation: "It fails" }],
    },
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

/** Stores one post and returns its entry id. */
function ingestOne(board: Blackboard, run: TeamRun, member: TeamMember, entry: MemberEntryPost): string {
  const record = post(member, entry);
  assert.equal(board.ingest(run, member, [record], []).stored, 1);
  return record.envelope.requestId;
}

type Seeded = {
  store: EvidenceStore;
  board: Blackboard;
  run: TeamRun;
  launchSeq: number;
  pm: TeamMember;
  implA: TeamMember;
  implB: TeamMember;
  rev: TeamMember;
  implA0: TeamMember;
  ids: Record<"D1" | "C1" | "C2" | "C3" | "K1" | "K2" | "H" | "Ib" | "F1" | "F0", string>;
};

/**
 * The world of the plan's Task 5 fixture. Mirrored entries first, then the launch of implA and the reviewer, then the
 * steering, the posts, the withdrawal, the integration of task b, and the findings, in that order.
 */
function seed(store: EvidenceStore, board: Blackboard): Seeded {
  const run = entryRun();
  const pm = memberOf(run, hostEntryIds.pm);
  const implA = memberOf(run, hostEntryIds.implA);
  const implB = memberOf(run, hostEntryIds.implB);
  const rev = memberOf(run, hostEntryIds.rev);
  assert.equal(board.mirror(run), true);

  const launchSeq = board.launchMark(run.id);
  if (launchSeq === undefined) throw new Error("no launch mark");
  assert.equal(board.recordLaunch(run, implA, { ...SIZES, launchSeq }), true);
  assert.equal(board.recordLaunch(run, rev, { ...SIZES, launchSeq }), true);

  run.steering.push({ text: "Use the new route", revision: 4, at: at(20) });
  assert.equal(board.mirror(run), true);
  const d1 = board.list(run.id, { kinds: ["direction"] }).entries.find(head => head.summary.includes("Use the new route"));
  if (!d1) throw new Error("steering entry missing");

  const c1 = ingestOne(board, run, implB, contract("C1 route", { paths: ["src/a/api.ts"] }));
  const c2 = ingestOne(board, run, implB, contract("C2 docs", { paths: ["docs"] }));
  const c3 = ingestOne(board, run, pm, contract("C3 plan"));
  const k1 = ingestOne(board, run, implB, blocker("K1 src", { paths: ["src"] }));
  const k2 = ingestOne(board, run, implB, blocker("K2 src a", { paths: ["src/a"] }));
  assert.equal(board.withdraw(run.id, k2), "withdrawn");

  const implA0 = sibling(implA);
  const h = ingestOne(board, run, implA0, handoff("H task a", "a"));

  Object.assign(taskOf(run, "b"), { status: "integrated", memberId: implB.memberId, commit: "e".repeat(40) });
  assert.equal(board.mirror(run), true);
  const ib = board.list(run.id, { kinds: ["integration"] }).entries.find(head => head.taskId === "b");
  if (!ib) throw new Error("integration entry missing");

  const f1 = ingestOne(board, run, rev, finding("F1 review", { paths: ["src/a"] }));
  const f0 = ingestOne(board, run, implA, finding("F0 own", { paths: ["src/a"] }));

  return {
    store,
    board,
    run,
    launchSeq,
    pm,
    implA,
    implB,
    rev,
    implA0,
    ids: { D1: d1.entryId, C1: c1, C2: c2, C3: c3, K1: k1, K2: k2, H: h, Ib: ib.entryId, F1: f1, F0: f0 },
  };
}

function scopeOf(store: EvidenceStore, member: TeamMember): MemberScope {
  const scope = store.read(db => readMemberScope(db, member.memberId));
  if (!scope) throw new Error("member scope missing");
  return scope;
}

function listOf(store: EvidenceStore, scope: MemberScope, query?: Parameters<typeof listForMember>[2]): MemberList {
  return store.read(db => listForMember(db, scope, query));
}

const HEAD_KEYS = new Set(["entryId", "seq", "at", "kind", "author", "authority", "authorRole", "taskId", "paths",
  "summary", "bodyBytes", "supersedes", "state"]);

test("the default list follows the six groups", () => {
  withStore((_f, store, board) => {
    const w = seed(store, board);
    const implAScope = scopeOf(store, w.implA);
    const reviewerScope = scopeOf(store, w.rev);
    assert.deepEqual(implAScope, memberScopeOf(w.run, w.implA, w.launchSeq));
    assert.deepEqual(reviewerScope, memberScopeOf(w.run, w.rev, w.launchSeq));

    assert.deepEqual(
      listOf(store, implAScope).heads.map(head => head.entryId),
      [w.ids.D1, w.ids.C3, w.ids.C1, w.ids.K1, w.ids.H, w.ids.Ib, w.ids.F1],
    );
    assert.deepEqual(
      listOf(store, reviewerScope).heads.map(head => head.entryId),
      [w.ids.D1, w.ids.C3, w.ids.C2, w.ids.C1, w.ids.K1, w.ids.F0],
    );
  });
});

test("every result carries the notice and no member identity", () => {
  withStore((_f, store, board) => {
    const w = seed(store, board);
    const scope = scopeOf(store, w.implA);
    const results: unknown[] = [
      listOf(store, scope),
      listOf(store, scope, { kinds: ["contract"] }),
      store.read(db => getForMember(db, scope, w.ids.C1)),
      board.memberDigest(w.run, w.rev, w.launchSeq),
    ];
    for (const result of results) {
      assert.ok(result !== undefined && typeof result === "object");
      assert.equal((result as { notice: string }).notice, ENTRY_NOTICE);
      const text = JSON.stringify(result);
      assert.equal(text.includes(w.run.id), false);
      for (const id of [w.implA.memberId, w.rev.memberId, w.implB.memberId]) assert.equal(text.includes(id), false);
    }
    for (const head of listOf(store, scope).heads) {
      for (const key of Object.keys(head)) assert.ok(HEAD_KEYS.has(key), key);
    }
  });
});

test("a filtered list pages in seq order within its limits", () => {
  withStore((_f, store, board) => {
    const w = seed(store, board);
    const scope = scopeOf(store, w.implA);

    assert.deepEqual(listOf(store, scope, { kinds: ["contract"] }).heads.map(head => head.entryId), [w.ids.C1, w.ids.C2, w.ids.C3]);

    const first = listOf(store, scope, { kinds: ["contract"], limit: 2 });
    assert.deepEqual(first.heads.map(head => head.entryId), [w.ids.C1, w.ids.C2]);
    assert.equal(first.more, true);
    assert.equal(first.cursor, first.heads[1].seq);
    assert.deepEqual(listOf(store, scope, { kinds: ["contract"], since: first.cursor }).heads.map(head => head.entryId), [w.ids.C3]);

    const task = listOf(store, scope, { taskId: "a" });
    assert.ok(task.heads.length > 0);
    for (const head of task.heads) assert.equal(head.taskId, "a");

    assert.deepEqual(listOf(store, scope, { path: "src/a" }).heads.map(head => head.entryId), [w.ids.C1, w.ids.K1, w.ids.F1, w.ids.F0]);

    for (let index = 0; index < 30; index += 1) {
      ingestOne(board, w.run, w.implB, contract(`${index}`.padEnd(240, "s")));
    }
    const long = listOf(store, scope, { kinds: ["contract"] });
    assert.equal(long.more, true);
    assert.ok(Buffer.byteLength(JSON.stringify(long), "utf8") <= 6144);
  });
});

test("a filtered list pages past the scan limit", () => {
  withStore((_f, store, board) => {
    const w = seed(store, board);
    const scope = scopeOf(store, w.implA);
    // A finding with a path no other entry has, posted last, so the only match lies past the first scan.
    const z = ingestOne(board, w.run, w.rev, finding("Z late", { paths: ["zz/new"] }));
    const zSeq = board.get(w.run.id, z)?.head.seq;
    if (zSeq === undefined) throw new Error("late finding missing");
    // The scan reads visible rows only, so the cap is the number of visible rows before it, and the match lies just past the first scan.
    // The scan cap is the number of rows before it, so the match lies just past the first scan.
    const before = store.read(db => db.get<{ n: number }>(
      "SELECT count(*) AS n FROM entries WHERE run_id=? AND scope='run' AND state!='withdrawn' AND seq < ?",
      w.run.id,
      zSeq,
    ));
    const scanRows = before?.n ?? 0;
    assert.ok(scanRows >= 4);

    const first = store.read(db => listForMember(db, scope, { path: "zz/new" }, scanRows));
    assert.deepEqual(first.heads, []);
    assert.equal(first.more, true);
    assert.ok(first.cursor !== undefined && first.cursor > 0 && first.cursor < zSeq);

    const second = store.read(db => listForMember(db, scope, { path: "zz/new", since: first.cursor }, scanRows));
    assert.deepEqual(second.heads.map(head => head.entryId), [z]);
    assert.equal(second.more, false);
  });
});

test("get serves visible entries and refuses large bodies", () => {
  withStore((_f, store, board) => {
    const w = seed(store, board);
    const scope = scopeOf(store, w.implA);
    const first = ingestOne(board, w.run, w.implA, contract("X old"));
    const second = ingestOne(board, w.run, w.implA, contract("Y new", { supersedes: first }));

    const c1 = store.read(db => getForMember(db, scope, w.ids.C1));
    assert.ok(c1 !== undefined && c1 !== "too-large");
    assert.equal((c1.body as { change: string }).change, "C1 route");
    assert.ok(store.read(db => getForMember(db, scope, w.ids.F0)) !== undefined);
    const old = store.read(db => getForMember(db, scope, first));
    assert.ok(old !== undefined && old !== "too-large");
    assert.equal(old.head.state, "superseded");
    assert.ok(store.read(db => getForMember(db, scope, second)) !== undefined);

    assert.equal(store.read(db => getForMember(db, scope, w.ids.K2)), undefined);
    assert.equal(store.read(db => getForMember(db, scope, randomUUID())), undefined);

    const other = { ...hostEntryRun(), id: randomUUID() };
    assert.equal(board.mirror(other), true);
    const otherId = board.list(other.id).entries[0].entryId;
    assert.equal(store.read(db => getForMember(db, scope, otherId)), undefined);

    const long = { ...hostEntryRun(), id: randomUUID() };
    long.checks[0].output = "x".repeat(70_000);
    assert.equal(board.mirror(long), true);
    const bigCheck = board.list(long.id, { kinds: ["check"] }).entries.find(head => head.bodyBytes > 64 * 1024);
    if (!bigCheck) throw new Error("large check entry missing");
    const longScope = memberScopeOf(long, memberOf(long, hostEntryIds.implA), 0);
    assert.equal(store.read(db => getForMember(db, longScope, bigCheck.entryId)), "too-large");
  });
});

test("an unreadable head is counted and left out", () => {
  withStore((_f, store, board) => {
    const w = seed(store, board);
    store.write(tx => {
      tx.run("UPDATE entries SET encrypted_head=encrypted_body WHERE entry_id=?", w.ids.C1);
    });
    const list = listOf(store, scopeOf(store, w.implA));
    assert.equal(list.heads.some(head => head.entryId === w.ids.C1), false);
    assert.equal(list.unreadable, 1);
  });
});

test("an oversized head is skipped and paging goes on", () => {
  withStore((_f, store, board) => {
    const w = seed(store, board);
    // The write path refuses a head this large, so the row is written directly. Its paths overlap implA's path src/a.
    const bigId = randomUUID();
    const bigPaths = Array.from({ length: 40 }, (_, index) => `src/a/${String(index).padStart(3, "0")}${"x".repeat(190)}`);
    store.write(tx => {
      tx.run(
        "INSERT INTO entries (entry_id, scope, run_id, mission_id, revision, at, kind, author, authority, author_member_id, "
        + "task_key, state, body_bytes, encrypted_head, encrypted_body) "
        + "VALUES (?, 'run', ?, NULL, 1, ?, 'contract', 'member', 'claim', ?, NULL, 'active', 20, ?, ?)",
        bigId,
        w.run.id,
        at(30),
        w.implB.memberId,
        tx.seal("entries", `${bigId}:head`, { authorRole: "implementer", paths: bigPaths, summary: "Oversized" }),
        tx.seal("entries", `${bigId}:body`, { interface: "x", change: "y", sources: [] }),
      );
    });
    const normal = ingestOne(board, w.run, w.implB, contract("N after the oversized head"));
    const bigSeq = store.read(db => db.get<{ seq: number }>("SELECT seq FROM entries WHERE entry_id=?", bigId))?.seq;
    const normalSeq = board.get(w.run.id, normal)?.head.seq;
    if (bigSeq === undefined || normalSeq === undefined) throw new Error("rows missing");
    assert.ok(bigSeq < normalSeq);

    const scope = scopeOf(store, w.implA);
    const defaults = listOf(store, scope);
    assert.ok(defaults.heads.some(head => head.entryId === normal));
    assert.equal(defaults.heads.some(head => head.entryId === bigId), false);
    assert.equal(defaults.unreadable, 1);

    const filtered = listOf(store, scope, { kinds: ["contract"] });
    assert.ok(filtered.heads.some(head => head.entryId === normal));
    assert.equal(filtered.heads.some(head => head.entryId === bigId), false);
    assert.equal(filtered.unreadable, 1);
    assert.equal(filtered.cursor, normalSeq, "the cursor is past both");
    assert.equal(filtered.more, false);

    const digest = board.memberDigest(w.run, w.implA, w.launchSeq);
    assert.ok(digest !== undefined && "heads" in digest);
    assert.ok(digest.heads.some(head => head.entryId === normal));
    assert.equal(digest.heads.some(head => head.entryId === bigId), false);
    assert.equal(digest.unreadable, 1);
  });
});

test("the digest fits 4,096 bytes and keeps the order", () => {
  const f = fixture();
  try {
    const store = open(f);
    const board = new Blackboard(store);
    const w = seed(store, board);
    for (let index = 0; index < 12; index += 1) {
      ingestOne(board, w.run, w.implB, contract(`digest-${index}`.padEnd(240, "d")));
    }

    const digest = board.memberDigest(w.run, w.rev, w.launchSeq);
    assert.ok(digest !== undefined && "counts" in digest);
    assert.equal(digest.notice, ENTRY_NOTICE);
    assert.equal(digest.counts.contract, 15);
    assert.equal(digest.more, true);
    assert.ok(digest.heads.length <= 8);
    assert.ok(Buffer.byteLength(canonicalJson(digest), "utf8") <= 4096);

    const full = listOf(store, scopeOf(store, w.rev)).heads.map(head => head.entryId);
    assert.deepEqual(digest.heads.map(head => head.entryId), full.slice(0, digest.heads.length));

    const plain: TeamMember = { ...w.rev };
    delete plain.entryTools;
    assert.equal(board.memberDigest(w.run, plain, w.launchSeq), undefined);
    store.close();

    const wrong = open(f, randomBytes(32));
    try {
      assert.deepEqual(new Blackboard(wrong).memberDigest(w.run, w.rev, w.launchSeq), { notice: ENTRY_NOTICE, state: "unavailable" });
    } finally {
      wrong.close();
    }
  } finally {
    f.close();
  }
});

/** Inserts `count` sealed run-scope rows straight into the store. Only the plain columns the reads use matter. */
function insertRows(
  store: EvidenceStore,
  runId: string,
  row: { kind: string; state: string; author: string; authority: string; authorMemberId?: string },
  count: number,
): void {
  store.write(tx => {
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      tx.run(
        "INSERT INTO entries (entry_id, scope, run_id, mission_id, revision, at, kind, author, authority, author_member_id, "
        + "task_key, state, body_bytes, encrypted_head, encrypted_body) "
        + "VALUES (?, 'run', ?, NULL, 1, ?, ?, ?, ?, ?, NULL, ?, 20, ?, ?)",
        id,
        runId,
        at(0),
        row.kind,
        row.author,
        row.authority,
        row.authorMemberId ?? null,
        row.state,
        tx.seal("entries", `${id}:head`, { paths: [], summary: `row ${index}` }),
        tx.seal("entries", `${id}:body`, { text: "row" }),
      );
    }
  });
}

/** The seq of the row at `position` (1-based) in the run's seq order. */
function seqAt(store: EvidenceStore, runId: string, position: number): number | undefined {
  return store.read(db => db.get<{ seq: number }>(
    "SELECT seq FROM entries WHERE run_id=? ORDER BY seq LIMIT 1 OFFSET ?",
    runId,
    position - 1,
  )?.seq);
}

/** A filtered list with an explicit scan cap, as the bounded-read tests need. */
function scan(store: EvidenceStore, scope: MemberScope, query: Parameters<typeof listForMember>[2], scanRows: number): MemberList {
  return store.read(db => listForMember(db, scope, query, scanRows));
}

test("a filtered list reads a bounded number of rows", () => {
  withStore((_f, store, board) => {
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const implB = memberOf(run, hostEntryIds.implB);
    const scope = memberScopeOf(run, implA, 0);
    insertRows(store, run.id, { kind: "report", state: "active", author: "host", authority: "receipt" }, 120);
    const contracts = [0, 1, 2].map(index => ingestOne(board, run, implB, contract(`bounded-${index}`)));

    const first = scan(store, scope, { kinds: ["contract"] }, 50);
    assert.deepEqual(first.heads, []);
    assert.equal(first.more, true);
    assert.equal(first.cursor, seqAt(store, run.id, 50));

    const second = scan(store, scope, { kinds: ["contract"], since: first.cursor }, 50);
    assert.deepEqual(second.heads, []);
    assert.equal(second.more, true);
    assert.equal(second.cursor, seqAt(store, run.id, 100));

    const third = scan(store, scope, { kinds: ["contract"], since: second.cursor }, 50);
    assert.deepEqual(third.heads.map(head => head.entryId), contracts);
    assert.equal(third.more, false);
  });
});

test("a filtered list over a withdrawn history reads a bounded number of rows", () => {
  withStore((_f, store, board) => {
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const implB = memberOf(run, hostEntryIds.implB);
    const scope = memberScopeOf(run, implA, 0);
    insertRows(store, run.id, { kind: "contract", state: "withdrawn", author: "member", authority: "claim", authorMemberId: randomUUID() }, 60);
    const live = [0, 1].map(index => ingestOne(board, run, implB, contract(`live-${index}`)));

    const first = scan(store, scope, { since: 0, limit: 5 }, 50);
    assert.deepEqual(first.heads, []);
    assert.equal(first.more, true);
    assert.equal(first.cursor, seqAt(store, run.id, 50));

    const second = scan(store, scope, { since: first.cursor, limit: 5 }, 50);
    assert.deepEqual(second.heads.map(head => head.entryId), live);
    assert.equal(second.more, false);
  });
});

test("the default list keeps an older member post behind many reports", () => {
  withStore((_f, store, board) => {
    const run = entryRun();
    const implA = memberOf(run, hostEntryIds.implA);
    const implB = memberOf(run, hostEntryIds.implB);
    const scope = memberScopeOf(run, implA, 0);
    const older = ingestOne(board, run, implB, contract("before the reports"));
    // A long run: more host reports after the post than the default window holds.
    insertRows(store, run.id, { kind: "report", state: "active", author: "host", authority: "receipt" }, 1_001);

    const list = listOf(store, scope);
    assert.deepEqual(list.heads.map(head => head.entryId), [older], "the post is still in the default list");
    assert.equal(list.more, false, "the window is not full: reports are not in it");
    const digest = store.read(db => entryDigest(addressedHeads(db, scope), 0));
    assert.ok("counts" in digest && digest.counts.contract === 1, "the launch digest counts it");
  });
});

test("member reads and the member count read through an index", () => {
  withStore((_f, store) => {
    const runId = randomUUID();
    const statements: [string, string, (string | number)[]][] = [
      [MEMBER_COUNT_SQL, "entries_member_kinds", [runId]],
      [ACTIVE_SCAN_SQL, "entries_active_by_run", [runId, 50]],
      [RUN_SCAN_SQL, "entries_by_run", [runId, 0, 51]],
      [TASK_SCAN_SQL, "entries_by_task", [runId, "task-key", 0, 51]],
    ];
    for (const [sql, index, params] of statements) {
      const lines = store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map(row => row.detail);
      const plan = lines.join(" | ");
      assert.ok(lines.some(line => line.includes(index)), `${index} missing from: ${plan}`);
      assert.equal(lines.some(line => /^SCAN entries(?! USING)/.test(line)), false, `bare scan in: ${plan}`);
      assert.equal(lines.some(line => line.includes("USE TEMP B-TREE")), false, `temp b-tree in: ${plan}`);
    }
  });
});
