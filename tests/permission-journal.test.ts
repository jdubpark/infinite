import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PermissionJournal,
  permissionJournalModule,
  type PermissionDecision,
  type PermissionTier,
} from "../packages/host/src/evidence/permission-journal.js";
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

test("the journal's own order decides, also for equal timestamps and a clock that steps back", () => withJournal(journal => {
  const at = "2026-11-14T10:00:00.000Z", earlier = "2026-11-14T09:00:00.000Z";
  journal.appendDecision(decision({ id: "allow", at }));
  journal.appendDecision(effectReject("reject-after-allow", { at: earlier }));
  assert.equal(journal.replayEligible("allow", { taskId: "task-1", requesterFamily: "family-a" }), false);

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
  journal.appendDecision(effectReject("rate-reject-strong", { id: "rate-reject-strong", at: "2026-11-14T10:15:00.000Z", tiers: [
    tier("light", "2026-11-14T10:15:00.000Z", "2026-11-14T10:15:02.000Z"),
    tier("strong", "2026-11-14T10:15:03.000Z", "2026-11-14T10:15:05.000Z"),
  ] }));
  journal.appendDecision(decision({ id: "rate-owner", at: "2026-11-14T10:25:00.000Z", verdict: "owner", interruptClass: "money" }));
  journal.appendDecision(decision({ id: "rate-allow-strong", at: "2026-11-14T10:35:00.000Z", replayOf: "rate-allow-light", tiers: [
    tier("strong", "2026-11-14T10:35:00.000Z", "2026-11-14T10:35:02.000Z"),
  ] }));
  journal.appendDecision(decision({ id: "rate-reject-light", at: "2026-11-14T10:45:00.000Z", verdict: "reject", code: "uncertain", tiers: [
    tier("light", "2026-11-14T10:45:00.000Z", "2026-11-14T10:45:04.000Z"),
  ] }));

  assert.deepEqual(journal.rates({ scope: "workspace", id: "workspace-1", since: start, until: end }), {
    decisions: 5,
    perHour: 2.5,
    byVerdict: { allow: 2, reject: 2, owner: 1 },
    byTier: { none: 1, light: 2, strong: 2 },
    replays: 1,
    medianDecisionMs: 3_000,
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
