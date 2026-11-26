import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../packages/host/src/types.js";
import type { IntakeRecord, IntakeThread } from "../packages/host/src/intake-types.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FINISHED = "33333333-3333-4333-8333-333333333333";
const STARTED = "44444444-4444-4444-8444-444444444444";
const SKIPPED = "55555555-5555-4555-8555-555555555555";
const thread: IntakeThread = { channelId: "C0000000000", threadTs: "1.000001" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "intake-store-"));
  const config = { stateDir: join(root, "state") } as Config;
  const key = randomBytes(32);
  return {
    root,
    open: () => new IntakeStore(config, key),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function record(
  issueId: string,
  issueCreatedAt = "2026-01-01T00:00:00.000Z",
  state: IntakeRecord["state"] = "queued",
  binding?: IntakeThread,
): IntakeRecord {
  const base = {
    issueId,
    identifier: `INF-${issueId.slice(0, 3)}`,
    url: "https://example.invalid/issue",
    title: "Example issue",
    description: "Example description",
    issueCreatedAt,
    issueUpdatedAt: issueCreatedAt,
    comments: {},
    messages: [],
    questions: [],
    inbound: [],
    createdAt: issueCreatedAt,
    updatedAt: issueCreatedAt,
  };
  if (state === "skipped") return { ...base, state, skipReason: "creator-mismatch" };
  if (state === "queued") return { ...base, state, ...(binding ? { thread: binding } : {}) };
  return { ...base, state, rule: "rule", missionId: "mission-1", ...(binding ? { thread: binding } : {}) };
}

test("the enable time is set once and survives a reopen", () => {
  const h = setup();
  try {
    const first = h.open().enabledAt();
    assert.equal(h.open().enabledAt(), first);
  } finally { h.close(); }
});

test("a failed first enable-time write can be retried on the same store", () => {
  const h = setup();
  const intakeDirectory = join(h.root, "state", "intake");
  const metaFile = join(h.root, "state", "intake", "meta.sealed");
  const store = h.open();
  try {
    rmSync(intakeDirectory, { recursive: true });
    writeFileSync(intakeDirectory, "temporary filesystem blocker");
    assert.throws(() => store.enabledAt());
    rmSync(intakeDirectory, { force: true });

    const recovered = store.enabledAt();
    assert.ok(existsSync(metaFile), "the retry must publish sealed metadata");
    assert.equal(h.open().enabledAt(), recovered);
  } finally {
    rmSync(intakeDirectory, { recursive: true, force: true });
    h.close();
  }
});

test("records survive a reopen and come back oldest first", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(B, "2026-01-02T00:00:00.000Z"));
    store.create(record(A, "2026-01-01T00:00:00.000Z"));
    assert.deepEqual(h.open().list().map(item => item.issueId), [A, B]);
  } finally { h.close(); }
});

test("create refuses a second record for one issue", () => {
  const h = setup();
  try {
    const store = h.open();
    assert.throws(() => { store.create(record(A)); store.create(record(A)); }, /already has an intake record/);
  } finally { h.close(); }
});

test("a returned record is a copy", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(A));
    const got = store.get(A)!;
    Object.assign(got, { state: "finished" });
    assert.equal(store.get(A)!.state, "queued");
  } finally { h.close(); }
});

test("a Slack audience identity is immutable after record admission", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create({ ...record(A), slackAudienceId: "audience-a" });
    assert.throws(() => store.update(A, item => { item.slackAudienceId = "audience-b"; }), /audience identity cannot be changed/);
    assert.equal(store.get(A)!.slackAudienceId, "audience-a");

    store.create(record(B));
    assert.throws(() => store.update(B, item => { item.slackAudienceId = "audience-a"; }), /audience identity cannot be changed/);
    assert.equal(store.get(B)!.slackAudienceId, undefined, "historic unscoped records cannot be backfilled during replay");
  } finally { h.close(); }
});

test("create detaches stored state from the input record and nested references", () => {
  const h = setup();
  try {
    const store = h.open();
    const input = record(A);
    const externalThread = { ...thread };
    if (input.state === "queued") input.thread = externalThread;
    store.create(input);

    Object.assign(input, { state: "finished" });
    externalThread.channelId = "C0000000001";
    assert.equal(store.get(A)!.state, "queued");
    const saved = store.get(A)!;
    assert.deepEqual(saved.state !== "skipped" ? saved.thread : undefined, thread);
  } finally { h.close(); }
});

test("update detaches stored state from callback and nested references", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(A));
    const externalThread = { ...thread };
    let retained: IntakeRecord | undefined;
    let notifications = 0;
    store.onChange(() => { notifications += 1; });
    store.update(A, changed => {
      retained = changed;
      Object.assign(changed, { state: "started", rule: "rule", missionId: "mission-1", thread: externalThread });
    });

    const afterUpdate = store.get(A)!;
    Object.assign(retained!, { state: "finished" });
    if (retained!.state !== "skipped") retained!.thread!.threadTs = "2.000002";
    externalThread.channelId = "C0000000001";

    const afterAliasMutation = store.get(A)!;
    assert.equal(afterAliasMutation.state, "started");
    assert.deepEqual(afterAliasMutation.thread, thread);
    assert.equal(afterAliasMutation.updatedAt, afterUpdate.updatedAt);
    assert.equal(notifications, 1);
    const reopened = h.open().get(A)!;
    assert.equal(reopened.state, "started");
    if (reopened.state === "started") assert.deepEqual(reopened.thread, thread);
  } finally { h.close(); }
});

test("boundTo lists a thread's records oldest first and never a skipped one", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(STARTED, "2026-01-02T00:00:00.000Z", "started", thread));
    store.create(record(FINISHED, "2026-01-01T00:00:00.000Z", "finished", thread));
    store.create({ ...record(SKIPPED, "2026-01-03T00:00:00.000Z", "skipped"), thread } as IntakeRecord);
    store.create(record(A, "2026-01-04T00:00:00.000Z", "queued", { channelId: "C0000000000", threadTs: "1.000002" }));
    assert.deepEqual(store.boundTo(thread).map(item => item.issueId), [FINISHED, STARTED]);
    assert.deepEqual(store.boundTo({ channelId: "C0000000001", threadTs: "1.000001" }), []);
  } finally { h.close(); }
});

test("update notifies listeners after the write, and a throwing listener loses nothing", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(A));
    store.onChange(() => { throw new Error("listener"); });
    let seen: string | undefined;
    store.onChange(r => { seen = h.open().get(A)?.state; });
    store.update(A, r => { Object.assign(r, { state: "started", rule: "rule", missionId: "mission-1" }); });
    assert.equal(seen, "started");
    assert.equal(h.open().get(A)!.state, "started");
  } finally { h.close(); }
});

test("an issue ID that is not a UUID is refused", () => {
  const h = setup();
  try { assert.throws(() => h.open().create(record("../x"))); }
  finally { h.close(); }
});

type Message = IntakeRecord["messages"][number];
const message = (key: string, kind: Message["kind"], status: Message["status"] = "sent"): Message => {
  const base = { key, kind, text: "message", createdAt: "2026-01-01T00:00:00.000Z", attempts: 1 };
  if (status === "sent") return { ...base, status, ts: "1.000001" };
  if (status === "failed") return { ...base, status, error: "failed" };
  return { ...base, status };
};
const inbound = (eventId: string, handled: boolean): IntakeRecord["inbound"][number] =>
  ({ eventId, ts: eventId, text: "inbound", receivedAt: "2026-01-01T00:00:00.000Z", ...(handled ? { handledAt: "2026-01-01T00:00:01.000Z" } : {}) });

test("update retains the newest inbound entries, and past 400 messages drops only the oldest replies", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(A));
    const composed = ["ack", "started", "q:decision-1", "result:1#1", "result:1#2", "status:blocked:3", "edit-note"];
    store.update(A, r => {
      r.inbound = Array.from({ length: 201 }, (_, i) => inbound(`event-${i}`, true));
      r.messages = [...composed.map(key => message(key, "status")), ...Array.from({ length: 400 }, (_, i) => message(`reply:event-${i}`, "reply"))];
    });
    const saved = store.get(A)!;
    assert.equal(saved.inbound.length, 200);
    assert.equal(saved.inbound[0]!.eventId, "event-1");
    assert.equal(saved.inbound.at(-1)!.eventId, "event-200");
    assert.equal(saved.messages.length, 400);
    assert.deepEqual(saved.messages.slice(0, composed.length).map(item => item.key), composed, "Composed messages are never trimmed");
    assert.equal(saved.messages[composed.length]!.key, "reply:event-7", "The oldest replies go first");
    assert.equal(saved.messages.at(-1)!.key, "reply:event-399");
  } finally { h.close(); }
});

test("trimming keeps a pending reply and drops older sent and failed replies in its place", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(A));
    const retried: Message = { key: "reply:retried", kind: "reply", text: "message", createdAt: "2026-01-01T00:00:00.000Z", status: "pending", attempts: 1, error: "Slack request failed: ratelimited", nextAttemptAt: "2026-01-01T00:00:05.000Z" };
    store.update(A, r => {
      r.messages = [message("ack", "ack"), message("reply:failed", "reply", "failed"), message("reply:pending", "reply", "pending"), retried,
        ...Array.from({ length: 400 }, (_, i) => message(`reply:event-${i}`, "reply"))];
    });
    const keys = store.get(A)!.messages.map(item => item.key);
    assert.equal(keys.length, 400);
    assert.deepEqual(keys.slice(0, 4), ["ack", "reply:pending", "reply:retried", "reply:event-3"], "Older sent and failed replies go first");
    assert.equal(keys.at(-1), "reply:event-399");
  } finally { h.close(); }
});

test("trimming never drops an unhandled inbound entry, and stays above the caps when nothing more may go", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(A));
    store.update(A, r => { r.inbound = [inbound("unhandled", false), ...Array.from({ length: 201 }, (_, i) => inbound(`event-${i}`, true))]; });
    const ids = store.get(A)!.inbound.map(item => item.eventId);
    assert.equal(ids.length, 200);
    assert.deepEqual(ids.slice(0, 2), ["unhandled", "event-2"], "The oldest handled entries go in its place");

    store.create(record(B));
    store.update(B, r => {
      r.inbound = Array.from({ length: 205 }, (_, i) => inbound(`open-${i}`, false));
      r.messages = [...Array.from({ length: 401 }, (_, i) => message(`status:blocked:${i}`, "status")), message("reply:new", "reply", "pending")];
    });
    const saved = store.get(B)!;
    assert.equal(saved.inbound.length, 205, "Unhandled entries all stay");
    assert.equal(saved.messages.length, 402, "Composed messages and a pending reply all stay");
    assert.equal(saved.messages.at(-1)!.key, "reply:new");
  } finally { h.close(); }
});

test("create notifies listeners after the write, and a throwing listener loses nothing", () => {
  const h = setup();
  try {
    const store = h.open();
    store.onChange(() => { throw new Error("listener"); });
    const seen: { issueId: string; onDisk: boolean; state: string }[] = [];
    store.onChange(r => {
      seen.push({ issueId: r.issueId, onDisk: h.open().get(A)?.state === "queued", state: r.state });
      Object.assign(r, { state: "finished" });
    });
    store.create(record(A));
    assert.deepEqual(seen, [{ issueId: A, onDisk: true, state: "queued" }], "A new record reaches listeners once, after the write");
    assert.equal(h.open().get(A)!.state, "queued", "A listener's change to its copy is not stored");
    assert.equal(store.get(A)!.state, "queued");
  } finally { h.close(); }
});
