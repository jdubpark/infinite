import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, readEvents, unseal, writeSealed } from "../packages/host/src/vault.js";

test("encrypted replay crosses segment boundaries and rejects wrong keys and record substitution", () => {
  const directory = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  try {
    const journal = new Journal(directory, key, "session-a");
    for (let i = 0; i < 260; i++)
      journal.append("output", { text: `private record ${i}` });
    const page = readEvents(directory, key, "session-a", 254, 4);
    assert.deepEqual(
      page.events.map((e) => e.data.text),
      [
        "private record 254",
        "private record 255",
        "private record 256",
        "private record 257",
      ],
    );
    assert.equal(page.cursor, 258);
    assert.equal(page.more, true);
    assert.throws(() => readEvents(directory, randomBytes(32), "session-a"));
    assert.throws(() => readEvents(directory, key, "different-session"));
    const file = join(directory, "0000000000.journal");
    const lines = readFileSync(file, "utf8").split("\n");
    [lines[0], lines[1]] = [lines[1], lines[0]];
    writeFileSync(file, lines.join("\n"));
    assert.throws(() => readEvents(directory, key, "session-a"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readEvents filters by type while advancing the cursor past skipped records", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  try {
    const journal = new Journal(join(dir, "events"), key, "s1");
    journal.append("output", { text: "a" });
    journal.append("signal", {
      kind: "turn-start",
      source: "hook",
      provider: "demo",
    });
    journal.append("output", { text: "b" });
    journal.append("lifecycle", { status: "exited" });
    const types = new Set(["signal", "lifecycle"]);
    const page = readEvents(join(dir, "events"), key, "s1", 0, 10, types);
    assert.deepEqual(
      page.events.map((e) => e.seq),
      [2, 4],
    );
    assert.equal(page.cursor, 4);
    assert.equal(page.more, false);
    const first = readEvents(join(dir, "events"), key, "s1", 0, 1, types);
    assert.deepEqual(
      first.events.map((e) => e.seq),
      [2],
    );
    assert.equal(first.cursor, 2);
    assert.equal(first.more, true);
    const rest = readEvents(
      join(dir, "events"),
      key,
      "s1",
      first.cursor,
      10,
      types,
    );
    assert.deepEqual(
      rest.events.map((e) => e.seq),
      [4],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed sealed write leaves no temporary file", () => {
  const directory = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  try {
    const target = join(directory, "record.sealed");
    mkdirSync(target);
    for (let index = 0; index < 3; index++) assert.throws(() => writeSealed(target, key, "scope", { index }));
    assert.deepEqual(readdirSync(directory), ["record.sealed"]);
    const file = join(directory, "other.sealed");
    writeSealed(file, key, "scope", { ok: true });
    assert.deepEqual(unseal(key, "scope", readFileSync(file, "utf8")), { ok: true });
    assert.deepEqual(readdirSync(directory).sort(), ["other.sealed", "record.sealed"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one appendAll batch crossing two segment boundaries writes each event once and reports its segment", () => {
  const directory = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  try {
    const seen: { seq: number; segment: string }[] = [];
    const journal = new Journal(directory, key, "session-b", {
      onAppend: (event, meta) => seen.push({ seq: event.seq, segment: meta.segment }),
    });
    for (let i = 0; i < 990; i++) journal.append("output", { text: `lead ${i}` });
    seen.length = 0;
    const events = journal.appendAll(
      "output",
      Array.from({ length: 300 }, (_, i) => ({ text: `batch ${i}` })),
    );
    assert.equal(events.length, 300);
    assert.equal(journal.seq, 1290);
    const read = readEvents(directory, key, "session-b", 0, 5000).events;
    assert.deepEqual(
      read.map((e) => e.seq),
      Array.from({ length: 1290 }, (_, i) => i + 1),
    );
    assert.deepEqual(
      seen.map((e) => e.seq),
      Array.from({ length: 300 }, (_, i) => 991 + i),
    );
    for (const entry of seen)
      assert.equal(entry.segment, `${String(Math.floor((entry.seq - 1) / 256)).padStart(10, "0")}.journal`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("appendAll hands onAppend each event with its own size, after the data is on disk, with seq already at that event", () => {
  const directory = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  try {
    const calls: { seq: number; segment: string; bytes: number; onDisk: number; journalSeq: number }[] = [];
    const journal: Journal = new Journal(directory, key, "session-c", {
      onAppend: (event, meta) =>
        calls.push({
          seq: event.seq,
          segment: meta.segment,
          bytes: meta.bytes,
          onDisk: statSync(join(directory, meta.segment)).size,
          journalSeq: journal.seq,
        }),
    });
    for (let i = 0; i < 250; i++) journal.append("output", { text: "x" });
    calls.length = 0;
    journal.appendAll("output", Array.from({ length: 12 }, (_, i) => ({ text: "y".repeat(i + 1) })));
    assert.equal(calls.length, 12);
    const previous = new Map<string, number>();
    for (const call of calls) {
      assert.equal(call.journalSeq, call.seq);
      assert.ok(call.onDisk >= call.bytes);
      const lines = readFileSync(join(directory, call.segment), "utf8").split("\n");
      const upTo = lines
        .slice(0, call.seq - Math.floor((call.seq - 1) / 256) * 256)
        .reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
      assert.equal(call.bytes, upTo);
      assert.ok(call.bytes > (previous.get(call.segment) ?? 0));
      previous.set(call.segment, call.bytes);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a batch that fails in its second segment leaves the first segment readable and refuses every later append", () => {
  const directory = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  const journal = new Journal(directory, key, "latch");
  journal.appendAll("output", Array.from({ length: 250 }, (_, index) => ({ text: String(index) })));
  mkdirSync(join(directory, "0000000001.journal"));
  assert.throws(() => journal.appendAll("output", Array.from({ length: 20 }, () => ({ text: "x" }))), { code: "EISDIR" });
  assert.equal(journal.seq, 256);
  rmdirSync(join(directory, "0000000001.journal"));
  assert.throws(() => journal.append("output", { text: "later" }), /Journal closed/);
  assert.equal(journal.seq, 256);
  const events = readEvents(directory, key, "latch", 0, 1000).events;
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: 256 }, (_, index) => index + 1));
});

test("a hook that throws midway through a segment leaves the sequence at that segment's last event", () => {
  const directory = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  const journal = new Journal(directory, key, "hook", { onAppend: event => { if (event.seq === 3) throw new Error("hook failed"); } });
  assert.throws(() => journal.appendAll("output", Array.from({ length: 10 }, (_, index) => ({ text: String(index) }))), /hook failed/);
  assert.equal(journal.seq, 10);
  assert.equal(journal.append("output", { text: "next" }).seq, 11);
  assert.deepEqual(readEvents(directory, key, "hook", 0, 100).events.map(event => event.seq), Array.from({ length: 11 }, (_, index) => index + 1));
});
