import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PermissionJournal,
  PermissionMarkConflict,
  permissionJournalModule,
  type PermissionDecision,
  type PermissionTier,
} from "../packages/host/src/evidence/permission-journal.js";
import type { EvidenceModule } from "../packages/host/src/evidence/types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-permission-journal-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture): EvidenceStore {
  const store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
  store.register(permissionJournalModule);
  return store;
}

function decision(overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    id: "decision-1",
    at: "2026-11-14T10:00:00.000Z",
    workspaceId: "workspace-1",
    projectId: "project-1",
    taskId: "task-1",
    assignment: "assignment-1",
    sessionId: "session-1",
    role: "worker",
    provider: "provider-a",
    family: "family-a",
    evidenceHash: "evidence-hash-1",
    reuseKey: "reuse-1",
    action: { tool: "shell", summary: "Run the focused check" },
    rules: [],
    tiers: [],
    verdict: "allow",
    ...overrides,
  };
}

function effectReject(id: string, overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return decision({
    id,
    verdict: "reject",
    code: "unsafe",
    ...overrides,
  });
}

function withJournal(run: (journal: PermissionJournal, store: EvidenceStore) => void): void {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    run(new PermissionJournal(store), store);
  } finally {
    store?.close();
    f.close();
  }
}

function tier(tierName: PermissionTier["tier"], start: string, end: string): PermissionTier {
  return { tier: tierName, profileId: `${tierName}-profile`, family: `${tierName}-family`, startedAt: start, endedAt: end };
}

test("append validates verdict fields and bounded extracted text", () => withJournal(journal => {
  assert.throws(() => journal.appendDecision(decision({ verdict: "reject", code: undefined })), TypeError);
  assert.throws(() => journal.appendDecision(effectReject("with-class", { interruptClass: "money" })), TypeError);
  assert.throws(() => journal.appendDecision(decision({ verdict: "owner" })), TypeError);
  assert.throws(() => journal.appendDecision(decision({ verdict: "owner", interruptClass: "money", code: "unsafe" })), TypeError);
  assert.throws(() => journal.appendDecision(decision({ verdict: "allow", code: "unsafe" })), TypeError);
  assert.throws(() => journal.appendDecision(decision({ verdict: "allow", interruptClass: "money" })), TypeError);
  assert.throws(() => journal.appendDecision(decision({ verdict: "reject", code: "not-a-code" as "unsafe" })), TypeError);
  assert.throws(() => journal.appendDecision(decision({
    action: { tool: "shell", summary: "s".repeat(2_001) },
  })), TypeError);
  assert.throws(() => journal.appendDecision(decision({ note: "n".repeat(2_001) })), TypeError);
  assert.throws(() => journal.appendDecision(decision({ at: "not-a-time" })), TypeError);
}));

test("same-id append is idempotent only for identical content", () => withJournal(journal => {
  const original = decision({ note: "owner-only context" });
  journal.appendDecision(original);
  journal.appendDecision({ ...original, action: { ...original.action } });
  assert.equal(journal.decisions().length, 1);
  assert.throws(() => journal.appendDecision({
    ...original,
    action: { ...original.action, summary: "different action" },
  }), /different content/);
  assert.equal(journal.decisions().length, 1);
}));

test("decisions that answered one raised request count as one repeat, and a decision with no request digest counts alone", () => withJournal(journal => {
  const at = (minute: number) => `2026-11-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
  journal.appendDecision(effectReject("original", { requestDigest: "request-a" }));
  // The request that got the reject, decided again: no repeat of its own reject.
  journal.appendDecision(effectReject("original-again", { repeats: "original", requestDigest: "request-a", at: at(1) }));
  assert.equal(journal.repeatCount("assignment-1", "original"), 0);
  // One other request, decided three times: one repeat.
  for (const [index, id] of ["b-1", "b-2", "b-3"].entries()) {
    journal.appendDecision(effectReject(id, { repeats: "original", requestDigest: "request-b", at: at(2 + index) }));
  }
  assert.equal(journal.repeatCount("assignment-1", "original"), 1);
  assert.equal(journal.isLocked("assignment-1"), false);
  // A record of an earlier release has no digest. It counts as before, each on its own.
  journal.appendDecision(effectReject("old-1", { repeats: "original", at: at(5) }));
  assert.equal(journal.repeatCount("assignment-1", "original"), 2);
  assert.equal(journal.isLocked("assignment-1"), true);
  journal.appendDecision(effectReject("old-2", { repeats: "original", at: at(6) }));
  assert.equal(journal.repeatCount("assignment-1", "original"), 3);

  // After an unlock a request counted before it does not count again; a new request does.
  journal.unlock({ assignment: "assignment-1", at: at(7), by: "owner" });
  journal.appendDecision(effectReject("b-4", { repeats: "original", requestDigest: "request-b", at: at(8) }));
  assert.equal(journal.repeatCount("assignment-1", "original"), 0);
  journal.appendDecision(effectReject("c-1", { repeats: "original", requestDigest: "request-c", at: at(9) }));
  journal.appendDecision(effectReject("c-2", { repeats: "original", requestDigest: "request-c", at: at(10) }));
  assert.equal(journal.repeatCount("assignment-1", "original"), 1);
  // The digest is no column and no part of what a lookup returns.
  assert.equal("requestDigest" in journal.decision("c-1")!, false);
  // It is part of the content that an ID stands for.
  assert.throws(() => journal.appendDecision(effectReject("c-2", { repeats: "original", requestDigest: "request-d", at: at(10) })), /different content/);
  assert.throws(() => journal.appendDecision(effectReject("bad", { requestDigest: "" })), TypeError);

  // A reject of an earlier release has no digest, so its own request, decided again, still counts against it.
  journal.appendDecision(effectReject("old-original", { assignment: "assignment-2", at: at(11) }));
  journal.appendDecision(effectReject("old-original-again", { assignment: "assignment-2", repeats: "old-original", requestDigest: "request-e", at: at(12) }));
  assert.equal(journal.repeatCount("assignment-2", "old-original"), 1);
}));

test("model notes are sealed at rest and decrypted by decision lookup", () => {
  const f = fixture();
  let store = open(f);
  const journal = new PermissionJournal(store);
  const note = "sealed-note-with-unique-sentinel-7b214f";
  try {
    journal.appendDecision(decision({ id: "noted", verdict: "reject", code: "uncertain", note }));
    store.close();
    const rawDb = new DatabaseSync(f.path, { readOnly: true });
    try {
      const row = rawDb.prepare("SELECT note_sealed FROM permission_decisions WHERE id=?").get("noted") as { note_sealed: string };
      assert.notEqual(row.note_sealed, note);
      assert.equal(readFileSync(f.path).includes(Buffer.from(note)), false);
    } finally {
      rawDb.close();
    }
    store = open(f);
    assert.equal(new PermissionJournal(store).decision("noted")?.note, note);
  } finally {
    store.close();
    f.close();
  }
});

test("effect rejects persist across reopening and close by task or project", () => {
  const f = fixture();
  let store = open(f);
  try {
    let journal = new PermissionJournal(store);
    journal.appendDecision(effectReject("task-reject", { at: "2026-11-14T10:00:00.000Z" }));
    journal.appendDecision(effectReject("project-reject", {
      at: "2026-11-14T10:01:00.000Z", taskId: "task-2", projectId: "project-2",
    }));
    journal.appendDecision(decision({ id: "evidence-reject", at: "2026-11-14T10:02:00.000Z", verdict: "reject", code: "incomplete" }));
    assert.deepEqual(journal.openRejects("task-1").map(row => row.id), ["task-reject"]);
    store.close();

    store = open(f);
    journal = new PermissionJournal(store);
    assert.deepEqual(journal.openRejects("task-1").map(row => row.id), ["task-reject"]);
    journal.closeOpenRejects({ taskId: "task-1", at: "2026-11-14T10:03:00.000Z", reason: "task-ended" });
    assert.deepEqual(journal.openRejects("task-1"), []);
    assert.deepEqual(journal.openRejects("task-2").map(row => row.id), ["project-reject"]);
    journal.closeOpenRejects({ projectId: "project-2", at: "2026-11-14T10:04:00.000Z", reason: "direction-changed" });
    assert.deepEqual(journal.openRejects("task-2"), []);
    assert.throws(() => journal.closeOpenRejects({ at: "2026-11-14T10:05:00.000Z", reason: "task-ended" }), TypeError);
  } finally {
    store.close();
    f.close();
  }
});

test("reopen closes a reject and resets its repeat count, and the assignment keeps its reject history", () => withJournal(journal => {
  journal.appendDecision(effectReject("original"));
  journal.appendDecision(decision({ id: "evidence", verdict: "reject", code: "uncertain", assignment: "assignment-1" }));
  journal.appendDecision(effectReject("repeat-1", { repeats: "original", at: "2026-11-14T10:01:00.000Z" }));
  assert.equal(journal.repeatCount("assignment-1", "original"), 1);
  assert.equal(journal.hasRejectHistory("assignment-1"), true);
  journal.reopen({ decisionId: "original", at: "2026-11-14T10:02:00.000Z", by: "owner" });
  assert.deepEqual(journal.openRejects("task-1"), []);
  assert.equal(journal.repeatCount("assignment-1", "original"), 0);
  assert.equal(journal.replayEligible("original", { taskId: "task-1", requesterFamily: "family-a" }), false);
  assert.equal(journal.replayEligible("repeat-1", { taskId: "task-1", requesterFamily: "family-a" }), false);
  journal.reopen({ decisionId: "evidence", at: "2026-11-14T10:03:00.000Z", by: "owner" });
  assert.deepEqual(journal.evidenceRejects("assignment-1"), []);
  journal.unlock({ assignment: "assignment-1", at: "2026-11-14T10:03:30.000Z", by: "owner" });
  journal.closeOpenRejects({ taskId: "task-1", at: "2026-11-14T10:03:40.000Z", reason: "task-ended" });
  assert.equal(journal.hasRejectHistory("assignment-1"), true);
  assert.equal(journal.hasRejectHistory("another-assignment"), false);
  journal.appendDecision(decision({ id: "outage", assignment: "outage-only", verdict: "reject", code: "unavailable" }));
  assert.equal(journal.hasRejectHistory("outage-only"), false);
  assert.throws(() => journal.reopen({ decisionId: "missing", at: "2026-11-14T10:04:00.000Z", by: "owner" }), TypeError);
  assert.throws(() => journal.reopen({ decisionId: "allowed", at: "2026-11-14T10:04:00.000Z", by: "owner" }), TypeError);
  journal.appendDecision(decision({ id: "allowed" }));
}));

test("repeat references canonicalize and reject cross-task or closed citations", () => withJournal(journal => {
  journal.appendDecision(effectReject("original"));
  journal.appendDecision(effectReject("repeat-1", {
    at: "2026-11-14T10:01:00.000Z", repeats: "original",
  }));
  journal.appendDecision(effectReject("repeat-2", {
    at: "2026-11-14T10:02:00.000Z", repeats: "repeat-1",
  }));
  assert.equal(journal.decision("repeat-1")?.repeats, "original");
  assert.equal(journal.decision("repeat-2")?.repeats, "original");
  assert.equal(journal.repeatCount("assignment-1", "original"), 2);
  assert.throws(() => journal.appendDecision(effectReject("wrong-task", {
    taskId: "task-2", repeats: "original",
  })), TypeError);
  journal.appendDecision(effectReject("other", { id: "other", taskId: "task-2" }));
  assert.throws(() => journal.appendDecision(effectReject("cites-evidence", { repeats: "evidence" })), TypeError);
  journal.appendDecision(decision({ id: "evidence", taskId: "task-1", verdict: "reject", code: "uncertain" }));
  assert.throws(() => journal.appendDecision(effectReject("cites-evidence", { repeats: "evidence" })), TypeError);
  journal.closeOpenRejects({ taskId: "task-1", at: "2026-11-14T10:03:00.000Z", reason: "task-ended" });
  assert.throws(() => journal.appendDecision(effectReject("closed-citation", {
    at: "2026-11-14T10:04:00.000Z", repeats: "original",
  })), TypeError);
}));

test("a repeat inherits canonical open and reopen state and never blocks an older allow", () => withJournal(journal => {
  journal.appendDecision(effectReject("canonical", { at: "2026-11-14T10:00:00.000Z" }));
  journal.appendDecision(decision({ id: "allow-after-canonical", at: "2026-11-14T10:01:00.000Z" }));
  journal.appendDecision(effectReject("repeat-1", {
    at: "2026-11-14T10:02:00.000Z", repeats: "canonical", replayOf: "canonical",
  }));
  journal.appendDecision(effectReject("repeat-2", {
    at: "2026-11-14T10:03:00.000Z", repeats: "repeat-1", replayOf: "canonical",
  }));

  assert.deepEqual(journal.openRejects("task-1").map(row => row.id), ["canonical"]);
  assert.equal(journal.replayEligible("allow-after-canonical", { taskId: "task-1", requesterFamily: "family-a" }), true);
  journal.reopen({ decisionId: "canonical", at: "2026-11-14T10:04:00.000Z", by: "owner" });
  assert.deepEqual(journal.openRejects("task-1"), []);
  assert.equal(journal.replayEligible("repeat-1", { taskId: "task-1", requesterFamily: "family-a" }), false);
}));

test("closing a canonical reject closes its repeats for replay too", () => withJournal(journal => {
  journal.appendDecision(effectReject("canonical", { at: "2026-11-14T10:00:00.000Z" }));
  journal.appendDecision(effectReject("repeat", {
    at: "2026-11-14T10:01:00.000Z", repeats: "canonical", replayOf: "canonical",
  }));
  journal.closeOpenRejects({ taskId: "task-1", at: "2026-11-14T10:02:00.000Z", reason: "task-ended" });

  assert.deepEqual(journal.openRejects("task-1"), []);
  assert.equal(journal.replayEligible("repeat", { taskId: "task-1", requesterFamily: "family-a" }), false);
}));

test("a repeated open reject can lock the repeating assignment across assignments", () => withJournal(journal => {
  journal.appendDecision(effectReject("assignment-a-reject", { assignment: "assignment-a" }));
  journal.appendDecision(effectReject("assignment-b-repeat-1", {
    assignment: "assignment-b", at: "2026-11-14T10:01:00.000Z", repeats: "assignment-a-reject",
  }));
  journal.appendDecision(effectReject("assignment-b-repeat-2", {
    assignment: "assignment-b", at: "2026-11-14T10:02:00.000Z", repeats: "assignment-b-repeat-1",
  }));

  assert.equal(journal.repeatCount("assignment-b", "assignment-a-reject"), 2);
  assert.equal(journal.isLocked("assignment-b"), true);
  assert.equal(journal.isLocked("assignment-a"), false);
}));

test("a decision with repeats must itself be an effect reject", () => withJournal(journal => {
  journal.appendDecision(effectReject("canonical"));
  assert.throws(() => journal.appendDecision(decision({
    id: "owner-repeat", verdict: "owner", interruptClass: "money", repeats: "canonical",
  })), TypeError);
  assert.throws(() => journal.appendDecision(decision({
    id: "evidence-repeat", verdict: "reject", code: "uncertain", repeats: "canonical",
  })), TypeError);
}));

test("a raised query fills its limit past many newer unraised decisions", () => withJournal(journal => {
  const first = Date.parse("2026-11-14T09:00:00.000Z");
  journal.appendDecision(effectReject("raised-old", { at: new Date(first).toISOString(), rules: ["raise:settings"] }));
  for (let index = 0; index < 101; index++) {
    journal.appendDecision(decision({ id: `unraised-${index}`, at: new Date(first + (index + 1) * 60_000).toISOString() }));
  }
  journal.appendDecision(decision({ id: "raised-new", at: new Date(first + 200 * 60_000).toISOString(), rules: ["scope:workspace", "raise:destructive"] }));

  assert.deepEqual(journal.decisions({ raisedOnly: true, limit: 1 }).map(row => row.id), ["raised-new"]);
  assert.deepEqual(journal.decisions({ raisedOnly: true }).map(row => row.id), ["raised-new", "raised-old"]);
}));

test("a strong verdict replays only to a requester of another, known family; a replay record is judged as its source", () => withJournal(journal => {
  const strong = (family: string): PermissionTier[] => [
    tier("light", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z"),
    { ...tier("strong", "2026-11-14T10:00:02.000Z", "2026-11-14T10:00:04.000Z"), family },
  ];
  journal.appendDecision(decision({ id: "strong-allow", tiers: strong("family-b") }));
  journal.appendDecision(decision({ id: "strong-allow-replay", replayOf: "strong-allow", family: "family-a" }));
  journal.appendDecision(decision({ id: "strong-reject", verdict: "reject", code: "uncertain", tiers: strong("family-b") }));
  journal.appendDecision(decision({ id: "light-allow", tiers: [tier("light", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z")] }));

  for (const id of ["strong-allow", "strong-allow-replay", "strong-reject"]) {
    assert.equal(journal.replayEligible(id, { taskId: "task-1", requesterFamily: "family-a" }), true, id);
    assert.equal(journal.replayEligible(id, { taskId: "task-1", requesterFamily: "family-b" }), false, id);
    assert.equal(journal.replayEligible(id, { taskId: "task-1", requesterFamily: " Family-B " }), false, id);
    assert.equal(journal.replayEligible(id, { taskId: "task-1", requesterFamily: undefined }), false, id);
  }
  for (const family of ["family-b", undefined])
    assert.throws(() => journal.appendDecision(decision({ id: `refused-${family}`, replayOf: "strong-allow", family })), TypeError);
  assert.equal(journal.replayEligible("light-allow", { taskId: "task-1", requesterFamily: undefined }), true);
  assert.equal(journal.replayEligible("light-allow", { taskId: "task-1", requesterFamily: "light-family" }), true);
  assert.throws(() => journal.replayEligible("light-allow", { taskId: "task-1" } as never), TypeError);
}));

test("reopening a replay record reopens the reject it replays", () => withJournal(journal => {
  journal.appendDecision(decision({ id: "evidence", verdict: "reject", code: "uncertain" }));
  journal.appendDecision(decision({ id: "evidence-replay", verdict: "reject", code: "uncertain", replayOf: "evidence" }));
  assert.equal(journal.replayEligible("evidence-replay", { taskId: "task-1", requesterFamily: "family-a" }), true);

  journal.reopen({ decisionId: "evidence-replay", at: "2026-11-14T10:01:00.000Z", by: "owner" });
  for (const id of ["evidence", "evidence-replay"])
    assert.equal(journal.replayEligible(id, { taskId: "task-1", requesterFamily: "family-a" }), false, id);
}));

test("a replayed effect reject is a repeat of that reject whether or not the record says so", () => withJournal(journal => {
  journal.appendDecision(effectReject("reject"));
  journal.appendDecision(effectReject("other-reject", { code: "unrelated" }));
  journal.appendDecision(effectReject("replay-1", { replayOf: "reject" }));
  journal.appendDecision(effectReject("replay-2", { replayOf: "replay-1" }));

  assert.deepEqual([journal.decision("replay-2")?.replayOf, journal.decision("replay-2")?.repeats], ["reject", "reject"]);
  assert.equal(journal.repeatCount("assignment-1", "reject"), 2);
  assert.equal(journal.isLocked("assignment-1"), true);
  assert.deepEqual(journal.openRejects("task-1").map(row => row.id), ["reject", "other-reject"]);
  assert.throws(() => journal.appendDecision(effectReject("conflicting", { replayOf: "reject", repeats: "other-reject" })), TypeError);

  journal.reopen({ decisionId: "replay-2", at: "2026-11-14T10:01:00.000Z", by: "owner" });
  assert.deepEqual(journal.openRejects("task-1").map(row => row.id), ["other-reject"]);
  assert.equal(journal.isLocked("assignment-1"), false);
  for (const id of ["reject", "replay-1", "replay-2"])
    assert.equal(journal.replayEligible(id, { taskId: "task-1", requesterFamily: "family-a" }), false, id);
  assert.throws(() => journal.appendDecision(effectReject("after-reopen", { replayOf: "reject" })), TypeError);
}));

test("a replay record must stay in its task and carry the outcome it replays", () => withJournal(journal => {
  journal.appendDecision(effectReject("reject"));
  journal.appendDecision(decision({ id: "allow" }));
  journal.appendDecision(decision({ id: "owner", verdict: "owner", interruptClass: "money" }));
  journal.appendDecision(decision({ id: "outage", verdict: "reject", code: "unavailable" }));

  const refused: Array<Partial<PermissionDecision>> = [
    { taskId: "task-2", replayOf: "allow" },
    { replayOf: "missing" },
    { verdict: "reject", code: "uncertain", replayOf: "allow" },
    { verdict: "reject", code: "unrelated", replayOf: "reject" },
    { verdict: "owner", interruptClass: "money", replayOf: "owner" },
    { verdict: "reject", code: "unavailable", replayOf: "outage" },
    { replayOf: "allow", reuseKey: "another-request" },
    { replayOf: "allow", reuseKey: undefined },
    { replayOf: "allow", tiers: [tier("light", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z")] },
  ];
  for (const [index, overrides] of refused.entries())
    assert.throws(() => journal.appendDecision(decision({ id: `refused-${index}`, ...overrides })), TypeError, JSON.stringify(overrides));
  assert.equal(journal.decisions().length, 4);

  journal.appendDecision(decision({ id: "allow-replay", replayOf: "allow" }));
  journal.appendDecision(decision({ id: "allow-replay-2", replayOf: "allow-replay" }));
  assert.equal(journal.decision("allow-replay-2")?.replayOf, "allow", "a replay is stored against its source");
  assert.equal(journal.replayEligible("allow-replay-2", { taskId: "task-2", requesterFamily: "family-a" }), false);
}));

test("the journal's own order decides, also for equal timestamps and a clock that steps back", () => withJournal(journal => {
  const at = "2026-11-14T10:00:00.000Z", earlier = "2026-11-14T09:00:00.000Z";
  journal.appendDecision(decision({ id: "allow", at }));
  journal.appendDecision(effectReject("reject-after-allow", { at: earlier }));
  assert.equal(journal.replayEligible("allow", { taskId: "task-1", requesterFamily: "family-a" }), false);
  assert.throws(() => journal.appendDecision(decision({ id: "stale-allow-replay", at, replayOf: "allow" })), TypeError);

  journal.appendDecision(effectReject("repeat-1", { at, repeats: "reject-after-allow" }));
  journal.appendDecision(effectReject("repeat-2", { at, repeats: "reject-after-allow" }));
  assert.equal(journal.isLocked("assignment-1"), true);
  journal.unlock({ assignment: "assignment-1", at: earlier, by: "owner" });
  assert.equal(journal.repeatCount("assignment-1", "reject-after-allow"), 0);
  journal.appendDecision(effectReject("repeat-3", { at: earlier, repeats: "reject-after-allow" }));
  assert.equal(journal.repeatCount("assignment-1", "reject-after-allow"), 1);
  assert.equal(journal.isLocked("assignment-1"), false);

  journal.reopen({ decisionId: "reject-after-allow", at: earlier, by: "owner" });
  assert.deepEqual(journal.openRejects("task-1"), []);
  assert.equal(journal.repeatCount("assignment-1", "reject-after-allow"), 0);
  assert.equal(journal.replayEligible("allow", { taskId: "task-1", requesterFamily: "family-a" }), true);
}));

test("only repeated open rejects lock one assignment; unlock and reopen reset the count", () => withJournal(journal => {
  journal.appendDecision(effectReject("target"));
  journal.appendDecision(effectReject("repeat-1", { at: "2026-11-14T10:01:00.000Z", repeats: "target" }));
  journal.appendDecision(effectReject("repeat-2", { at: "2026-11-14T10:02:00.000Z", repeats: "target" }));
  assert.equal(journal.repeatCount("assignment-1", "target"), 2);
  assert.equal(journal.isLocked("assignment-1"), true);
  assert.equal(journal.isLocked("different-assignment"), false);

  for (let index = 1; index <= 3; index++) {
    journal.appendDecision(effectReject(`unrelated-${index}`, {
      assignment: "unrelated-assignment", at: `2026-11-14T10:0${index}:00.000Z`,
    }));
  }
  assert.equal(journal.isLocked("unrelated-assignment"), false);

  journal.appendDecision(effectReject("outage", {
    id: "outage", assignment: "outage-assignment", code: "unsafe",
  }));
  journal.appendDecision(effectReject("outage-repeat", {
    id: "outage-repeat", assignment: "outage-assignment", repeats: "outage",
    at: "2026-11-14T10:01:00.000Z",
  }));
  journal.appendDecision(decision({
    id: "unavailable", assignment: "outage-assignment", verdict: "reject", code: "unavailable",
    at: "2026-11-14T10:02:00.000Z",
  }));
  journal.appendDecision(decision({
    id: "locked", assignment: "outage-assignment", verdict: "reject", code: "locked",
    at: "2026-11-14T10:03:00.000Z",
  }));
  assert.equal(journal.repeatCount("outage-assignment", "outage"), 1);
  assert.equal(journal.isLocked("outage-assignment"), false);

  journal.unlock({ assignment: "assignment-1", at: "2026-11-14T10:03:00.000Z", by: "owner" });
  assert.equal(journal.repeatCount("assignment-1", "target"), 0);
  assert.equal(journal.isLocked("assignment-1"), false);
  journal.appendDecision(effectReject("repeat-after-unlock", {
    at: "2026-11-14T10:04:00.000Z", repeats: "target",
  }));
  journal.appendDecision(effectReject("repeat-after-unlock-2", {
    at: "2026-11-14T10:05:00.000Z", repeats: "target",
  }));
  assert.equal(journal.isLocked("assignment-1"), true);
  journal.reopen({ decisionId: "target", at: "2026-11-14T10:06:00.000Z", by: "owner" });
  assert.equal(journal.repeatCount("assignment-1", "target"), 0);
  assert.equal(journal.isLocked("assignment-1"), false);
}));

test("replay eligibility follows task rejects, owner reopening, and non-replayable host codes", () => withJournal(journal => {
  journal.appendDecision(decision({ id: "earlier-allow", taskId: "allow-task" }));
  assert.equal(journal.replayEligible("earlier-allow", { taskId: "allow-task", requesterFamily: "family-a" }), true);
  journal.appendDecision(effectReject("later-reject", { taskId: "allow-task", at: "2026-11-14T10:01:00.000Z" }));
  assert.equal(journal.replayEligible("earlier-allow", { taskId: "allow-task", requesterFamily: "family-a" }), false);
  journal.closeOpenRejects({ taskId: "allow-task", at: "2026-11-14T10:02:00.000Z", reason: "task-ended" });
  assert.equal(journal.replayEligible("earlier-allow", { taskId: "allow-task", requesterFamily: "family-a" }), true);
  assert.equal(journal.replayEligible("earlier-allow", { taskId: "another-task", requesterFamily: "family-a" }), false);

  journal.appendDecision(effectReject("ordinary-reject", { taskId: "reject-task" }));
  assert.equal(journal.replayEligible("ordinary-reject", { taskId: "reject-task", requesterFamily: "family-a" }), true);
  journal.reopen({ decisionId: "ordinary-reject", at: "2026-11-14T10:03:00.000Z", by: "owner" });
  assert.equal(journal.replayEligible("ordinary-reject", { taskId: "reject-task", requesterFamily: "family-a" }), false);
  journal.appendDecision(decision({ id: "owner-verdict", taskId: "owner-task", verdict: "owner", interruptClass: "money" }));
  assert.equal(journal.replayEligible("owner-verdict", { taskId: "owner-task", requesterFamily: "family-a" }), false);

  for (const code of ["unavailable", "locked", "needs-owner"] as const) {
    const id = `host-${code}`;
    journal.appendDecision(decision({ id, taskId: id, verdict: "reject", code }));
    assert.equal(journal.replayEligible(id, { taskId: id, requesterFamily: "family-a" }), false);
  }
}));

test("decision query filters and delivery history expose immutable records", () => withJournal(journal => {
  journal.appendDecision(decision({ id: "plain", at: "2026-11-14T10:00:00.000Z" }));
  journal.appendDecision(effectReject("raised", {
    id: "raised", at: "2026-11-14T10:01:00.000Z", rules: ["raise:destructive", "scope:workspace"],
  }));
  journal.appendDecision(decision({ id: "other-project", projectId: "project-2", sessionId: "session-2" }));
  assert.deepEqual(journal.decisions({ raisedOnly: true }).map(row => row.id), ["raised"]);
  assert.deepEqual(journal.decisions({ rejectedOnly: true, taskId: "task-1" }).map(row => row.id), ["raised"]);
  assert.deepEqual(journal.decisions({ projectId: "project-1", sessionId: "session-1", since: "2026-11-14T10:01:00.000Z" }).map(row => row.id), ["raised"]);
  assert.throws(() => journal.decisions({ limit: 501 }), TypeError);

  journal.appendDelivery({ decisionId: "raised", at: "2026-11-14T10:02:00.000Z", kind: "intent" });
  journal.appendDelivery({ decisionId: "raised", at: "2026-11-14T10:03:00.000Z", kind: "uncertain", detail: "dialog changed" });
  assert.deepEqual(journal.deliveries("raised").map(event => [event.kind, event.detail]), [
    ["intent", undefined], ["uncertain", "dialog changed"],
  ]);
  assert.throws(() => journal.appendDelivery({ decisionId: "missing", at: "2026-11-14T10:04:00.000Z", kind: "receipt" }), TypeError);
}));

test("rates count verdicts, final tiers, replays, median duration, and empty windows", () => withJournal(journal => {
  const start = "2026-11-14T10:00:00.000Z";
  const end = "2026-11-14T12:00:00.000Z";
  journal.appendDecision(decision({ id: "rate-allow-light", at: "2026-11-14T10:05:00.000Z", tiers: [
    tier("light", "2026-11-14T10:05:00.000Z", "2026-11-14T10:05:01.000Z"),
  ] }));
  journal.appendDecision(effectReject("rate-reject-strong", { id: "rate-reject-strong", at: "2026-11-14T10:15:00.000Z", taskId: "task-2", tiers: [
    tier("light", "2026-11-14T10:15:00.000Z", "2026-11-14T10:15:02.000Z"),
    tier("strong", "2026-11-14T10:15:03.000Z", "2026-11-14T10:15:05.000Z"),
  ] }));
  journal.appendDecision(decision({ id: "rate-owner", at: "2026-11-14T10:25:00.000Z", verdict: "owner", interruptClass: "money" }));
  journal.appendDecision(decision({ id: "rate-allow-replay", at: "2026-11-14T10:35:00.000Z", replayOf: "rate-allow-light" }));
  journal.appendDecision(decision({ id: "rate-reject-uncertain", at: "2026-11-14T10:45:00.000Z", verdict: "reject", code: "uncertain", tiers: [
    tier("light", "2026-11-14T10:45:00.000Z", "2026-11-14T10:45:01.000Z"),
    tier("strong", "2026-11-14T10:45:02.000Z", "2026-11-14T10:45:04.000Z"),
  ] }));

  assert.deepEqual(journal.rates({ scope: "workspace", id: "workspace-1", since: start, until: end }), {
    decisions: 5,
    perHour: 2.5,
    byVerdict: { allow: 2, reject: 2, owner: 1 },
    byTier: { none: 2, light: 1, strong: 2 },
    replays: 1,
    medianDecisionMs: 4_000,
  });
  assert.deepEqual(journal.rates({ scope: "host", since: "2026-11-15T00:00:00.000Z", until: "2026-11-15T01:00:00.000Z" }), {
    decisions: 0,
    perHour: 0,
    byVerdict: { allow: 0, reject: 0, owner: 0 },
    byTier: { none: 0, light: 0, strong: 0 },
    replays: 0,
    medianDecisionMs: null,
  });
}));

test("the owner log returns exactly the decisions each filter names, in pages that neither skip nor repeat", () => withJournal(journal => {
  const at = (minute: number) => `2026-11-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
  journal.appendDecision(decision({ id: "w1-allow", at: at(0) }));
  journal.appendDecision(effectReject("w1-reject-raised", { at: at(1), taskId: "task-r", rules: ["raise:destructive"] }));
  journal.appendDecision(decision({ id: "w1-owner-raised", at: at(2), verdict: "owner", interruptClass: "money", rules: ["class:money", "raise:payment"] }));
  journal.appendDecision(decision({ id: "w2-reject", at: at(3), workspaceId: "workspace-2", taskId: "task-2", verdict: "reject", code: "uncertain" }));
  journal.appendDecision(decision({ id: "w2-allow-raised", at: at(4), workspaceId: "workspace-2", taskId: "task-3", rules: ["raise:outside-root"] }));
  // An equal timestamp: the journal's own order puts the later record first.
  journal.appendDecision(decision({ id: "w1-allow-tie", at: at(4), taskId: "task-4" }));
  const ids = (query: Parameters<PermissionJournal["log"]>[0]) => journal.log(query).entries.map(entry => entry.id);

  const everything = ["w1-allow-tie", "w2-allow-raised", "w2-reject", "w1-owner-raised", "w1-reject-raised", "w1-allow"];
  assert.deepEqual(ids({}), everything);
  assert.deepEqual(ids({ rejectedOnly: true }), ["w2-reject", "w1-reject-raised"]);
  assert.deepEqual(ids({ raisedOnly: true }), ["w2-allow-raised", "w1-owner-raised", "w1-reject-raised"]);
  assert.deepEqual(ids({ workspaceId: "workspace-2" }), ["w2-allow-raised", "w2-reject"]);
  assert.deepEqual(ids({ since: at(2) }), ["w1-allow-tie", "w2-allow-raised", "w2-reject", "w1-owner-raised"]);
  assert.deepEqual(ids({ workspaceId: "workspace-1", rejectedOnly: true, raisedOnly: true, since: at(1) }), ["w1-reject-raised"]);
  assert.deepEqual(ids({ workspaceId: "workspace-3" }), []);

  const paged: string[] = [];
  let before: string | undefined;
  do {
    const page = journal.log({ limit: 2, raisedOnly: false, ...(before === undefined ? {} : { before }) });
    assert.ok(page.entries.length <= 2);
    paged.push(...page.entries.map(entry => entry.id));
    before = page.next;
  } while (before !== undefined);
  assert.deepEqual(paged, everything, "pages follow the journal order with no gap and no repeat");
  assert.throws(() => journal.log({ limit: 201 }), TypeError);
  assert.throws(() => journal.log({ before: "not-a-cursor" }), TypeError);
}));

test("a log entry carries its timings, delivery events, owner controls and the model's note", () => withJournal(journal => {
  journal.appendDecision(effectReject("timed", {
    rules: ["raise:destructive"], note: "the model's reason",
    tiers: [tier("light", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z"), tier("strong", "2026-11-14T10:00:02.000Z", "2026-11-14T10:00:05.000Z")],
  }));
  journal.appendDelivery({ decisionId: "timed", at: "2026-11-14T10:00:06.000Z", kind: "intent" });
  journal.appendDelivery({ decisionId: "timed", at: "2026-11-14T10:00:07.000Z", kind: "receipt" });
  journal.appendDecision(effectReject("still-open", { taskId: "task-open" }));
  journal.appendDecision(effectReject("task-closed", { taskId: "task-closed" }));
  journal.closeOpenRejects({ taskId: "task-closed", at: "2026-11-14T10:01:00.000Z", reason: "task-ended" });
  journal.reopen({ decisionId: "timed", at: "2026-11-14T10:02:00.000Z", by: "owner-device" });

  const timed = journal.logEntry("timed")!;
  assert.equal(timed.note, "the model's reason");
  assert.equal(timed.raised, true);
  assert.equal(timed.durationMs, 5_000);
  assert.deepEqual(timed.deliveries.map(event => event.kind), ["intent", "receipt"]);
  assert.deepEqual(timed.controls, [{ kind: "reopen", at: "2026-11-14T10:02:00.000Z" }]);
  assert.equal(timed.rejectState, "reopened");
  assert.equal(journal.logEntry("still-open")!.rejectState, "open");
  assert.deepEqual(journal.logEntry("task-closed")!.controls, [{ kind: "close", at: "2026-11-14T10:01:00.000Z", reason: "task-ended" }]);
  assert.equal(journal.logEntry("task-closed")!.rejectState, "closed");
  assert.equal(journal.logEntry("missing"), undefined);
}));

test("a mark changes no decision, replay or lock, and a later mark never rewrites an earlier one", () => withJournal(journal => {
  journal.appendDecision(decision({ id: "allowed", taskId: "task-a", note: "model note" }));
  journal.appendDecision(effectReject("rejected", { taskId: "task-r", assignment: "seat" }));
  journal.appendDecision(effectReject("repeat-1", { taskId: "task-r", assignment: "seat", at: "2026-11-14T10:01:00.000Z", repeats: "rejected" }));
  journal.appendDecision(effectReject("repeat-2", { taskId: "task-r", assignment: "seat", at: "2026-11-14T10:02:00.000Z", repeats: "rejected" }));
  const snapshot = () => ({
    allowed: journal.decision("allowed"),
    rejected: journal.decision("rejected"),
    allowReplays: journal.replayEligible("allowed", { taskId: "task-a", requesterFamily: "family-a" }),
    rejectReplays: journal.replayEligible("rejected", { taskId: "task-r", requesterFamily: "family-a" }),
    locked: journal.isLocked("seat"),
    repeats: journal.repeatCount("seat", "rejected"),
    open: journal.openRejects("task-r").map(row => row.id),
    history: journal.hasRejectHistory("seat"),
    decisions: journal.decisions({ limit: 500 }),
  });
  const before = snapshot();
  assert.deepEqual([before.allowReplays, before.rejectReplays, before.locked, before.open], [true, true, true, ["rejected"]]);

  const firstInput = {
    requestId: "8d0f7f1e-4d8e-4b2a-9d55-0d3c9f6a1b01", decisionId: "rejected", at: "2026-11-14T11:00:00.000Z",
    by: "owner-device", label: "wrong" as const, note: "The build directory belongs to the session.",
  };
  const first = journal.mark(firstInput);
  const second = journal.mark({ ...firstInput, requestId: "8d0f7f1e-4d8e-4b2a-9d55-0d3c9f6a1b02", at: "2026-11-14T11:05:00.000Z", note: "Still wrong." });
  journal.mark({ ...firstInput, requestId: "8d0f7f1e-4d8e-4b2a-9d55-0d3c9f6a1b03", decisionId: "allowed", note: "Should not have run." });
  assert.deepEqual(snapshot(), before, "a mark is a record only");
  assert.deepEqual(journal.marks("rejected"), [first, second], "the second mark is a row of its own");

  assert.deepEqual(journal.mark(firstInput), first, "a retried request id returns the recorded mark");
  assert.equal(journal.marks("rejected").length, 2);
  assert.throws(() => journal.mark({ ...firstInput, note: "Another text." }), PermissionMarkConflict);
  assert.throws(() => journal.mark({ ...firstInput, requestId: "8d0f7f1e-4d8e-4b2a-9d55-0d3c9f6a1b04", decisionId: "missing" }), TypeError);
  assert.throws(() => journal.mark({ ...firstInput, requestId: "8d0f7f1e-4d8e-4b2a-9d55-0d3c9f6a1b05", note: "   " }), TypeError);
  assert.deepEqual(journal.marks("rejected").map(mark => mark.note), [first.note, second.note]);
  assert.deepEqual(journal.logEntry("rejected")!.marks, [first, second]);
}));

test("replay candidates are exactly the marked-wrong decisions and the reopened rejects, with the label each implies", () => withJournal(journal => {
  journal.appendDecision(decision({ id: "wrong-allow", taskId: "task-1", note: "model note" }));
  journal.appendDecision(effectReject("reopened-reject", { taskId: "task-2" }));
  journal.appendDecision(effectReject("wrong-reject", { taskId: "task-3" }));
  journal.appendDecision(decision({ id: "wrong-owner", taskId: "task-4", verdict: "owner", interruptClass: "money" }));
  journal.appendDecision(effectReject("closed-reject", { taskId: "task-5" }));
  journal.appendDecision(decision({ id: "plain-allow", taskId: "task-6" }));
  journal.appendDecision(effectReject("reopened-and-marked", { taskId: "task-7", note: "another model note" }));
  let n = 0;
  const mark = (decisionId: string) => journal.mark({
    requestId: `6f1c2b7a-0000-4000-8000-${String(++n).padStart(12, "0")}`, decisionId,
    at: `2026-11-14T11:${String(n).padStart(2, "0")}:00.000Z`, by: "owner-device", label: "wrong", note: `mark ${n}`,
  });
  mark("wrong-allow");
  journal.reopen({ decisionId: "reopened-reject", at: "2026-11-14T11:10:00.000Z", by: "owner-device" });
  mark("wrong-reject");
  mark("wrong-reject");
  mark("wrong-owner");
  journal.closeOpenRejects({ taskId: "task-5", at: "2026-11-14T11:20:00.000Z", reason: "task-ended" });
  journal.unlock({ assignment: "assignment-1", at: "2026-11-14T11:21:00.000Z", by: "owner-device" });
  journal.reopen({ decisionId: "reopened-and-marked", at: "2026-11-14T11:22:00.000Z", by: "owner-device" });
  mark("reopened-and-marked");

  const page = journal.replayCandidates();
  assert.deepEqual(page.candidates.map(candidate => [candidate.decisionId, candidate.label, candidate.sources]), [
    ["reopened-and-marked", "should-allow", ["marked-wrong", "reopened"]],
    ["wrong-owner", "should-allow", ["marked-wrong"]],
    ["wrong-reject", "should-allow", ["marked-wrong"]],
    ["reopened-reject", "should-allow", ["reopened"]],
    ["wrong-allow", "should-reject", ["marked-wrong"]],
  ], "newest owner act first; closed, unlocked and unmarked decisions are not candidates");
  assert.equal(page.next, undefined);
  assert.deepEqual(page.candidates.find(candidate => candidate.decisionId === "wrong-reject")!.marks.map(entry => entry.note), ["mark 2", "mark 3"]);
  assert.ok(page.candidates.every(candidate => !("note" in candidate.decision)), "no model note is offered as case evidence");
  assert.doesNotMatch(JSON.stringify(page), /model note/);

  const firstTwo = journal.replayCandidates({ limit: 2 });
  assert.deepEqual(firstTwo.candidates.map(candidate => candidate.decisionId), ["reopened-and-marked", "wrong-owner"]);
  assert.deepEqual(journal.replayCandidates({ limit: 2, before: firstTwo.next }).candidates.map(candidate => candidate.decisionId),
    ["wrong-reject", "reopened-reject"]);
}));

test("a session is flagged above three times its workspace's median session-hour, and never at or below twenty", () => withJournal(journal => {
  let n = 0;
  const burst = (sessionId: string, workspaceId: string, count: number, start: string) => {
    for (let index = 0; index < count; index++) {
      journal.appendDecision(decision({
        id: `rate-${++n}`, sessionId, workspaceId, taskId: `task-${sessionId}`, assignment: sessionId,
        at: new Date(Date.parse(start) + index * 1_000).toISOString(),
      }));
    }
  };
  // workspace-1 session-hours: 4, 6 and 10, so the median is 6 and the floor of 20 sets the threshold.
  burst("base-a", "workspace-1", 4, "2026-11-13T09:00:00.000Z");
  burst("base-b", "workspace-1", 6, "2026-11-13T10:00:00.000Z");
  burst("base-c", "workspace-1", 10, "2026-11-12T10:00:00.000Z");
  // Eight days back is outside the baseline. Counted, these hours would lift the median to 25.
  for (const hour of ["06", "07", "08"]) burst("old", "workspace-1", 40, `2026-11-06T${hour}:10:00.000Z`);
  // workspace-2 session-hours: three of 10, so three times the median, 30, is the threshold.
  for (const hour of ["06", "07", "08"]) burst("busy-base", "workspace-2", 10, `2026-11-13T${hour}:00:00.000Z`);
  // The last hour.
  burst("fast", "workspace-1", 21, "2026-11-14T11:30:00.000Z");
  burst("at-floor", "workspace-1", 20, "2026-11-14T11:20:00.000Z");
  burst("busy-normal", "workspace-2", 25, "2026-11-14T11:10:00.000Z");
  burst("busy-at-threshold", "workspace-2", 30, "2026-11-14T11:15:00.000Z");
  burst("busy-fast", "workspace-2", 31, "2026-11-14T11:05:00.000Z");

  assert.deepEqual(journal.rateFlags({ now: "2026-11-14T12:00:00.000Z" }), [
    { sessionId: "busy-fast", workspaceId: "workspace-2", lastHour: 31, baselineMedian: 10, threshold: 30 },
    { sessionId: "fast", workspaceId: "workspace-1", lastHour: 21, baselineMedian: 6, threshold: 20 },
  ]);
  assert.deepEqual(journal.rateFlags({ now: "2026-11-14T14:00:00.000Z" }), [], "the flag looks at the last hour only");
}));

/** The journal schema as hosts before owner marks created it. Frozen here on purpose: it is what is on disk. */
const journalVersion1: EvidenceModule = {
  name: "permission-journal",
  version: 1,
  readVersion: 1,
  migrate(tx) {
    tx.exec("CREATE TABLE IF NOT EXISTS permission_journal_order (seq INTEGER PRIMARY KEY AUTOINCREMENT)");
    tx.exec(
      "CREATE TABLE IF NOT EXISTS permission_decisions ("
      + "seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, at_ms INTEGER NOT NULL, workspace_id TEXT NOT NULL, "
      + "project_id TEXT NOT NULL, task_id TEXT NOT NULL, assignment TEXT NOT NULL, session_id TEXT NOT NULL, "
      + "role TEXT, provider TEXT NOT NULL, family TEXT, evidence_hash TEXT NOT NULL, reuse_key TEXT, "
      + "action_tool TEXT NOT NULL, action_summary TEXT NOT NULL, rules_json TEXT NOT NULL, tiers_json TEXT NOT NULL, "
      + "verdict TEXT NOT NULL, code TEXT, interrupt_class TEXT, note_sealed TEXT, input_sealed TEXT NOT NULL, "
      + "replay_of TEXT, repeats TEXT, raised INTEGER NOT NULL, last_tier TEXT NOT NULL, duration_ms INTEGER)",
    );
    tx.exec("CREATE TABLE IF NOT EXISTS permission_deliveries (seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT)");
    tx.exec(
      "CREATE TABLE IF NOT EXISTS permission_journal_controls (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL, by TEXT, "
      + "decision_id TEXT, assignment TEXT, task_id TEXT, project_id TEXT, reason TEXT)",
    );
  },
};

test("the journal opens a store that a host before owner marks created, and keeps its records", () => {
  const f = fixture();
  try {
    const earlier = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
    earlier.register(journalVersion1);
    const old = new PermissionJournal(earlier);
    old.appendDecision(effectReject("before-upgrade", { note: "sealed before the upgrade" }));
    old.appendDelivery({ decisionId: "before-upgrade", at: "2026-11-14T10:00:01.000Z", kind: "intent" });
    old.reopen({ decisionId: "before-upgrade", at: "2026-11-14T10:01:00.000Z", by: "owner-device" });
    earlier.close();

    const store = open(f);
    try {
      assert.equal(store.status().modules["permission-journal"], "ready");
      const journal = new PermissionJournal(store);
      assert.equal(journal.decision("before-upgrade")?.note, "sealed before the upgrade");
      assert.equal(journal.replayEligible("before-upgrade", { taskId: "task-1", requesterFamily: "family-a" }), false, "the reopen survived");
      const mark = journal.mark({
        requestId: "2b8e6f0c-1a3d-4c5e-8f7a-9b0c1d2e3f40", decisionId: "before-upgrade", at: "2026-11-14T11:00:00.000Z",
        by: "owner-device", label: "wrong", note: "Marked after the upgrade.",
      });
      const entry = journal.logEntry("before-upgrade")!;
      assert.deepEqual(entry.marks, [mark]);
      assert.deepEqual(entry.deliveries.map(event => event.kind), ["intent"]);
      assert.equal(entry.rejectState, "reopened");
    } finally {
      store.close();
    }
    const database = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.deepEqual({ ...database.prepare("SELECT version FROM schema_modules WHERE name='permission-journal'").get() }, { version: 2 });
    } finally {
      database.close();
    }
  } finally {
    f.close();
  }
});
