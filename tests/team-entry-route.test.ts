import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BLACKBOARD_READ_VERSION, Blackboard, type MemberPostRecord } from "../packages/host/src/evidence/blackboard.js";
import { ENTRY_NOTICE } from "../packages/host/src/evidence/entry-reads.js";
import { EvidenceReader } from "../packages/host/src/evidence/reader.js";
import { memberEntryEnvelopeSchema, memberEntryId, memberEntryPostSchema, type MemberEntryPost } from "../packages/host/src/evidence/member-entry.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { egressCredential } from "../packages/host/src/egress.js";
import { mintGithubGrant } from "../packages/host/src/github-grants.js";
import { HookPayloadError, type HookReply } from "../packages/host/src/hooks.js";
import { ENTRY_REFUSALS, MAX_ATTEMPT_POSTS, createEntryRoute } from "../packages/host/src/team-entry-route.js";
import type { TeamAssignment, TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";

const MARKER = "entry-marker-7f3a";
const TOKEN = `hook-${randomBytes(16).toString("hex")}`;
const URL_OWN = "http://127.0.0.1:41234/hook";
const ISSUED = randomBytes(32).toString("hex");
const SIZES = { launchSeq: 0, promptBytes: 1200, contextBytes: 4000 };
const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;

type Appended = { type: string; data: Record<string, unknown> };
type Harness = {
  handle: (body: unknown) => HookReply;
  appended: Appended[];
  flags: { running: boolean; reported: boolean };
};
type World = {
  store: EvidenceStore;
  board: Blackboard;
  run: TeamRun;
  path: string;
  key: Buffer;
  readers: EvidenceReader[];
  harness: (member: TeamMember, options?: { entryTools?: boolean }) => Harness;
  close: () => void;
};

function entryRun(): TeamRun {
  const run = hostEntryRun();
  run.blackboard = { tools: true };
  for (const member of run.members) {
    if ([hostEntryIds.pm, hostEntryIds.implA, hostEntryIds.implB, hostEntryIds.rev].includes(member.memberId)) {
      member.entryTools = true;
    }
  }
  taskOf(run, "a").paths = ["src/a"];
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

function sibling(member: TeamMember): TeamMember {
  return { ...member, memberId: randomUUID(), entryTools: true };
}

function contract(summary: string, extra: Record<string, unknown> = {}): MemberEntryPost {
  return memberEntryPostSchema.parse({ kind: "contract", summary, paths: [], body: { interface: "Shared route", change: summary }, ...extra });
}

function finding(summary: string): MemberEntryPost {
  return memberEntryPostSchema.parse({ kind: "finding", summary, paths: [], body: { items: [{ source: "npm test", observation: summary }] } });
}

function handoff(summary: string, extra: Record<string, unknown> = {}): MemberEntryPost {
  return memberEntryPostSchema.parse({ kind: "handoff", summary, paths: [], taskId: "a", body: { done: [summary], remaining: [], commands: [] }, ...extra });
}

function bindingOf(member: TeamMember) {
  return { runId: member.runId, memberId: member.memberId, revision: member.revision };
}

function postRequest(member: TeamMember, entry: MemberEntryPost, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const binding = bindingOf(member);
  return { op: "post", ...binding, requestId: memberEntryId(binding, entry), entry, ...extra };
}

function listRequest(member: TeamMember, query?: Record<string, unknown>): Record<string, unknown> {
  return { op: "list", ...bindingOf(member), ...(query === undefined ? {} : { query }) };
}

function getRequest(member: TeamMember, entryId: string): Record<string, unknown> {
  return { op: "get", ...bindingOf(member), entryId };
}

function ingestPost(board: Blackboard, run: TeamRun, member: TeamMember, entry: MemberEntryPost): string {
  const requestId = memberEntryId(bindingOf(member), entry);
  const record: MemberPostRecord = { seq: 0, at: at(10), envelope: { op: "post", ...bindingOf(member), requestId, entry } };
  assert.equal(board.ingest(run, member, [record], []).stored, 1);
  return requestId;
}

function world(options: { checkOutput?: string } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "infinite-entry-route-"));
  const path = evidenceDatabasePath(join(root, "state"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: path, vaultKey: key });
  const board = new Blackboard(store);
  const run = entryRun();
  if (options.checkOutput !== undefined) run.checks[0].output = options.checkOutput;
  assert.equal(board.mirror(run), true);
  const launchSeq = board.launchMark(run.id);
  if (launchSeq === undefined) throw new Error("no launch mark");
  assert.equal(board.recordLaunch(run, memberOf(run, hostEntryIds.implA), { ...SIZES, launchSeq }), true);
  const readers: EvidenceReader[] = [];
  const harness = (member: TeamMember, harnessOptions: { entryTools?: boolean } = {}): Harness => {
    const reader = new EvidenceReader({ databasePath: path, vaultKey: key, modules: { blackboard: BLACKBOARD_READ_VERSION } });
    readers.push(reader);
    const appended: Appended[] = [];
    const flags = { running: true, reported: false };
    const assignment: TeamAssignment = {
      runId: member.runId,
      memberId: member.memberId,
      revision: member.revision,
      role: member.role,
      ...(member.taskId === undefined ? {} : { taskId: member.taskId }),
      ...(harnessOptions.entryTools === false ? {} : { entryTools: true as const }),
    };
    const entry = createEntryRoute({
      team: assignment,
      own: () => ({ token: TOKEN, url: URL_OWN, credentials: [ISSUED] }),
      reader: () => reader,
      running: () => flags.running,
      reported: () => flags.reported,
      append: (type, data) => { appended.push({ type, data }); },
    });
    return { handle: body => entry.handle(body), appended, flags };
  };
  return {
    store, board, run, path, key, readers, harness,
    close: () => {
      for (const reader of readers) reader.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function refused(h: Harness, body: unknown): { status: number; text: string } {
  const before = h.appended.length;
  try {
    h.handle(body);
  } catch (error) {
    assert.ok(error instanceof HookPayloadError, `expected a refusal, got ${String(error)}`);
    assert.equal(h.appended.length, before, "a refused call appends nothing");
    return { status: error.status, text: error.message };
  }
  throw new Error("expected a refusal");
}

test("a post is checked, journaled, and answered with its id", () => {
  const w = world();
  try {
    const implA = memberOf(w.run, hostEntryIds.implA);
    const h = w.harness(implA);
    const entry = contract("C1 route");
    const request = postRequest(implA, entry);
    const answer = h.handle(request);
    assert.deepEqual(answer, { entry: { entryId: memberEntryId(bindingOf(implA), entry), state: "pending" } });
    assert.equal(h.appended.length, 1);
    assert.equal(h.appended[0].type, "team-entry");
    assert.deepEqual(h.appended[0].data, memberEntryEnvelopeSchema.parse(request));
    assert.deepEqual(h.handle(request), answer);
    assert.equal(h.appended.length, 1, "a repeated post appends nothing");
  } finally {
    w.close();
  }
});

test("supersede follows the rule", () => {
  const w = world();
  try {
    const implA = memberOf(w.run, hostEntryIds.implA);
    const implB = memberOf(w.run, hostEntryIds.implB);
    const x = ingestPost(w.board, w.run, implA, contract("X route"));
    const f = ingestPost(w.board, w.run, implB, finding("F route"));
    const h = w.harness(implA);
    assert.ok(h.handle(postRequest(implA, contract("Y route", { supersedes: x }))).entry, "a contract may supersede its own earlier contract");
    assert.deepEqual(refused(h, postRequest(implA, contract("Z route", { supersedes: f }))),
      { status: 403, text: ENTRY_REFUSALS["entry-supersede-forbidden"] });
    assert.deepEqual(refused(h, postRequest(implA, contract("W route", { supersedes: randomUUID() }))),
      { status: 404, text: ENTRY_REFUSALS["entry-not-found"] });
    const launchB = w.board.launchMark(w.run.id);
    if (launchB === undefined) throw new Error("no launch mark");
    assert.equal(w.board.recordLaunch(w.run, implB, { ...SIZES, launchSeq: launchB }), true);
    const hB = w.harness(implB);
    assert.deepEqual(refused(hB, postRequest(implB, contract("V route", { taskId: "b", supersedes: x }))),
      { status: 403, text: ENTRY_REFUSALS["entry-supersede-forbidden"] }, "a contract of another member and task is not superseded");
    assert.equal(hB.appended.length, 0, "the refused supersede appends no journal event");
  } finally {
    w.close();
  }
});

test("refusals are fixed and carry no member text", () => {
  const w = world({ checkOutput: "o".repeat(70_000) });
  try {
    const implA = memberOf(w.run, hostEntryIds.implA);
    const rev = memberOf(w.run, hostEntryIds.rev);
    const h = w.harness(implA);
    const check = (actual: { status: number; text: string }, status: number, text: string) => {
      assert.deepEqual(actual, { status, text });
      assert.equal(JSON.stringify(actual).includes(MARKER), false, "no refusal holds the marker");
    };

    check(refused(w.harness(implA, { entryTools: false }), postRequest(implA, contract(MARKER))), 403, ENTRY_REFUSALS["entry-tools-off"]);
    check(refused(h, { ...postRequest(implA, contract("big")), padding: `${MARKER}${"x".repeat(17000)}` }), 413, ENTRY_REFUSALS["entry-too-large"]);
    check(refused(h, { op: "post", ...bindingOf(implA), requestId: randomUUID(), entry: { kind: "contract", summary: `${MARKER}\n`, paths: [], body: { interface: "a", change: MARKER } } }),
      400, "entry-invalid at entry.summary: the request does not match the entry schema.");
    check(refused(h, { ...postRequest(implA, contract(MARKER)), runId: MARKER }), 403, ENTRY_REFUSALS["entry-binding"]);
    h.flags.reported = true;
    check(refused(h, postRequest(implA, contract(MARKER))), 409, ENTRY_REFUSALS["entry-closed"]);
    h.flags.reported = false;
    check(refused(h, { op: "post", ...bindingOf(implA), requestId: randomUUID(), entry: {
      kind: "handoff", summary: "big", paths: [], taskId: "a",
      body: { done: Array.from({ length: 12 }, () => "d".repeat(500)), remaining: Array.from({ length: 12 }, () => "r".repeat(500)), notes: `${MARKER}${"n".repeat(3900)}`, commands: [] },
    } }), 413, "entry-too-large: an entry body is at most 12 KiB.");
    check(refused(h, postRequest(implA, contract(MARKER), { requestId: randomUUID() })), 400, ENTRY_REFUSALS["entry-id-mismatch"]);
    check(refused(w.harness(rev), postRequest(rev, contract(MARKER))), 403, ENTRY_REFUSALS["entry-kind-forbidden"]);
    check(refused(h, postRequest(implA, contract(MARKER, { taskId: "b" }))), 403, ENTRY_REFUSALS["entry-task-forbidden"]);
    const token = `gh${"p_"}${"a".repeat(36)}`;
    check(refused(h, postRequest(implA, contract(`${MARKER} ${token}`))), 422, "entry-secret at entry.summary: this field looks like an access token. Remove it and post again.");
    const grant = mintGithubGrant(randomBytes(32), { sub: "session", sid: "session-1", project: "project-1", repo: "owner/repository", ops: ["fetch"] });
    const proxy = egressCredential(randomBytes(32), "project-1", "session-1", Math.floor(Date.now() / 1000) + 3600);
    const inChange = (value: string) => postRequest(implA, memberEntryPostSchema.parse({ kind: "contract", summary: "ok", paths: [], body: { interface: "Shared route", change: `${MARKER} ${value}` } }));
    check(refused(h, inChange(ISSUED)), 422, "entry-secret at entry.body.change: this field looks like a credential the host gave this session. Remove it and post again.");
    check(refused(h, inChange(grant)), 422, "entry-secret at entry.body.change: this field looks like an access token. Remove it and post again.");
    check(refused(h, inChange(`HTTPS_PROXY=http://${proxy.username}:${proxy.password}@127.0.0.1:9`)), 422, "entry-secret at entry.body.change: this field looks like an access token. Remove it and post again.");
    check(refused(h, postRequest(implA, contract(MARKER, { supersedes: randomUUID() }))), 404, ENTRY_REFUSALS["entry-not-found"]);
    const other = ingestPost(w.board, w.run, memberOf(w.run, hostEntryIds.implB), finding(MARKER));
    check(refused(h, postRequest(implA, contract(MARKER, { supersedes: other }))), 403, ENTRY_REFUSALS["entry-supersede-forbidden"]);
    check(refused(h, getRequest(implA, randomUUID())), 404, ENTRY_REFUSALS["entry-not-found"]);
    const checkEntry = w.board.list(w.run.id, { kinds: ["check"] }).entries[0];
    check(refused(h, getRequest(implA, checkEntry.entryId)), 413, "entry-too-large: this entry's body is over 64 KiB and is not served in this phase.");
    assert.equal(h.appended.length, 0, "no refused call journaled a post or a read");
  } finally {
    w.close();
  }
});

test("caps hold per attempt", () => {
  const w = world({ checkOutput: "o".repeat(60 * 1024) });
  try {
    const implA = memberOf(w.run, hostEntryIds.implA);
    const posts = w.harness(implA);
    for (let index = 0; index < MAX_ATTEMPT_POSTS; index += 1) posts.handle(postRequest(implA, contract(`C-${index} route`)));
    assert.equal(posts.appended.length, MAX_ATTEMPT_POSTS);
    assert.deepEqual(refused(posts, postRequest(implA, contract("C-21 route"))), { status: 429, text: ENTRY_REFUSALS["entry-post-limit"] });

    const bytes = w.harness(implA);
    for (let index = 0; index < 5; index += 1) {
      const entry = memberEntryPostSchema.parse({
        kind: "handoff", summary: `B-${index}`, paths: [], taskId: "a",
        body: { done: Array.from({ length: 12 }, (_, line) => `${index}-${line}-${"d".repeat(490)}`), remaining: Array.from({ length: 12 }, () => "r".repeat(480)), commands: [] },
      });
      bytes.handle(postRequest(implA, entry));
    }
    assert.equal(bytes.appended.length, 5);
    assert.deepEqual(refused(bytes, postRequest(implA, memberEntryPostSchema.parse({
      kind: "handoff", summary: "B-6", paths: [], taskId: "a",
      body: { done: Array.from({ length: 12 }, () => "d".repeat(490)), remaining: Array.from({ length: 12 }, () => "r".repeat(480)), commands: [] },
    }))), { status: 429, text: ENTRY_REFUSALS["entry-post-limit"] });

    const lists = w.harness(implA);
    for (let index = 0; index < 200; index += 1) lists.handle(listRequest(implA, { kinds: ["direction"], limit: 1 }));
    assert.equal(lists.appended.length, 200);
    assert.deepEqual(refused(lists, listRequest(implA, { kinds: ["direction"], limit: 1 })), { status: 429, text: ENTRY_REFUSALS["entry-read-limit"] });

    const gets = w.harness(implA);
    const checkEntry = w.board.list(w.run.id, { kinds: ["check"] }).entries[0];
    for (let index = 0; index < 4; index += 1) gets.handle(getRequest(implA, checkEntry.entryId));
    assert.equal(gets.appended.length, 4);
    assert.deepEqual(refused(gets, getRequest(implA, checkEntry.entryId)), { status: 429, text: ENTRY_REFUSALS["entry-read-limit"] });
  } finally {
    w.close();
  }
});

test("reads follow the member's scope", () => {
  const w = world();
  try {
    const implA = memberOf(w.run, hostEntryIds.implA);
    const h = w.harness(implA);
    const implB = memberOf(w.run, hostEntryIds.implB);
    const addressed = ingestPost(w.board, w.run, implB, contract("C route", { paths: ["src/a/api.ts"] }));

    const otherRun = { ...entryRun(), id: randomUUID() };
    otherRun.members = otherRun.members.map(member => ({ ...member, runId: otherRun.id }));
    assert.equal(w.board.mirror(otherRun), true);
    const foreignIds = new Set(w.board.list(otherRun.id).entries.map(head => head.entryId));
    assert.ok(foreignIds.size > 0);

    const list = h.handle(listRequest(implA)).entry as { notice: string; heads: Array<{ entryId: string }> };
    assert.equal(list.notice, ENTRY_NOTICE);
    assert.ok(list.heads.some(head => head.entryId === addressed), "a contract on implA's path reaches implA");
    assert.equal(list.heads.some(head => foreignIds.has(head.entryId)), false, "the default list holds no head of another run");
    const directions = h.handle(listRequest(implA, { kinds: ["direction"] })).entry as { heads: Array<{ entryId: string }> };
    assert.ok(directions.heads.length > 0);
    assert.equal(directions.heads.some(head => foreignIds.has(head.entryId)), false, "a filtered list holds no head of another run");

    const foreign = w.board.list(otherRun.id, { kinds: ["direction"] }).entries[0];
    const foreignText = refused(h, getRequest(implA, foreign.entryId));
    const randomText = refused(h, getRequest(implA, randomUUID()));
    assert.deepEqual(foreignText, { status: 404, text: ENTRY_REFUSALS["entry-not-found"] });
    assert.deepEqual(randomText, foreignText);

    const reader = w.harness(implA);
    const deleted = w.store.deleteRun(w.run.id);
    assert.equal(deleted, true);
    assert.deepEqual(refused(reader, listRequest(implA)), { status: 503, text: ENTRY_REFUSALS["entry-unavailable"] });
  } finally {
    w.close();
  }

  const raised = world();
  try {
    const implA = memberOf(raised.run, hostEntryIds.implA);
    raised.store.close();
    const db = new DatabaseSync(raised.path);
    db.prepare("UPDATE schema_modules SET read_version=3 WHERE name='blackboard'").run();
    db.close();
    const h = raised.harness(implA);
    assert.deepEqual(refused(h, listRequest(implA)), { status: 503, text: ENTRY_REFUSALS["entry-unavailable"] });
  } finally {
    raised.close();
  }
});

test("a forged or replaced binding is refused", () => {
  const w = world();
  try {
    const implA = memberOf(w.run, hostEntryIds.implA);
    const predecessor = sibling(implA);
    const h = w.harness(implA);
    const entry = contract("forged route");
    assert.deepEqual(refused(h, postRequest(predecessor, entry)), { status: 403, text: ENTRY_REFUSALS["entry-binding"] });
    assert.deepEqual(refused(h, postRequest({ ...implA, revision: implA.revision + 1 }, entry)), { status: 403, text: ENTRY_REFUSALS["entry-binding"] });
    assert.deepEqual(refused(h, listRequest(predecessor)), { status: 403, text: ENTRY_REFUSALS["entry-binding"] });

    const off = w.harness(implA, { entryTools: false });
    assert.deepEqual(refused(off, postRequest(implA, entry)), { status: 403, text: ENTRY_REFUSALS["entry-tools-off"] });
    assert.deepEqual(refused(off, listRequest(implA)), { status: 403, text: ENTRY_REFUSALS["entry-tools-off"] });
    assert.deepEqual(refused(off, getRequest(implA, randomUUID())), { status: 403, text: ENTRY_REFUSALS["entry-tools-off"] });

    h.flags.running = false;
    assert.deepEqual(refused(h, postRequest(implA, entry)), { status: 409, text: ENTRY_REFUSALS["entry-closed"] });
    assert.deepEqual(refused(h, listRequest(implA)), { status: 409, text: ENTRY_REFUSALS["entry-closed"] });
    assert.deepEqual(refused(h, getRequest(implA, randomUUID())), { status: 409, text: ENTRY_REFUSALS["entry-closed"] });
    h.flags.running = true;

    h.flags.reported = true;
    assert.deepEqual(refused(h, postRequest(implA, entry)), { status: 409, text: ENTRY_REFUSALS["entry-closed"] });
    assert.deepEqual(refused(h, listRequest(implA)), { status: 409, text: ENTRY_REFUSALS["entry-closed"] });
    assert.deepEqual(refused(h, getRequest(implA, randomUUID())), { status: 409, text: ENTRY_REFUSALS["entry-closed"] });
  } finally {
    w.close();
  }
});
