import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
  return {
    issueId,
    identifier: `INF-${issueId.slice(0, 3)}`,
    url: "https://example.invalid/issue",
    title: "Example issue",
    description: "Example description",
    issueCreatedAt,
    issueUpdatedAt: issueCreatedAt,
    state,
    ...(binding ? { thread: binding } : {}),
    comments: {},
    messages: [],
    questions: [],
    inbound: [],
    createdAt: issueCreatedAt,
    updatedAt: issueCreatedAt,
  };
}

test("the enable time is set once and survives a reopen", () => {
  const h = setup();
  try {
    const first = h.open().enabledAt();
    assert.equal(h.open().enabledAt(), first);
  } finally { h.close(); }
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
    got.state = "finished";
    assert.equal(store.get(A)!.state, "queued");
  } finally { h.close(); }
});

test("forThread prefers the newest unfinished record and never returns a skipped one", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(FINISHED, "2026-01-01T00:00:00.000Z", "finished", thread));
    store.create(record(STARTED, "2026-01-02T00:00:00.000Z", "started", thread));
    store.create(record(SKIPPED, "2026-01-03T00:00:00.000Z", "skipped"));
    assert.equal(store.forThread(thread)!.issueId, STARTED);
    store.update(STARTED, r => { r.state = "finished"; });
    assert.equal(store.forThread(thread)!.issueId, STARTED);
    assert.equal(store.forThread({ channelId: "C0000000000", threadTs: "1.000002" }), undefined);
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
    store.update(A, r => { r.state = "started"; });
    assert.equal(seen, "started");
    assert.equal(h.open().get(A)!.state, "started");
  } finally { h.close(); }
});

test("an issue ID that is not a UUID is refused", () => {
  const h = setup();
  try { assert.throws(() => h.open().create(record("../x"))); }
  finally { h.close(); }
});

test("update retains only the newest inbound entries and messages", () => {
  const h = setup();
  try {
    const store = h.open();
    store.create(record(A));
    store.update(A, r => {
      r.inbound = Array.from({ length: 201 }, (_, i) => ({
        eventId: `event-${i}`, ts: `${i}`, text: "inbound", receivedAt: "2026-01-01T00:00:00.000Z",
      }));
      r.messages = Array.from({ length: 401 }, (_, i) => ({
        key: `message-${i}`, kind: "status", text: "message", createdAt: "2026-01-01T00:00:00.000Z", status: "pending", attempts: 0,
      }));
    });
    const saved = store.get(A)!;
    assert.equal(saved.inbound.length, 200);
    assert.equal(saved.inbound[0]!.eventId, "event-1");
    assert.equal(saved.inbound.at(-1)!.eventId, "event-200");
    assert.equal(saved.messages.length, 400);
    assert.equal(saved.messages[0]!.key, "message-1");
    assert.equal(saved.messages.at(-1)!.key, "message-400");
  } finally { h.close(); }
});
