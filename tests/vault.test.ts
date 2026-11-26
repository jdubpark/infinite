import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, readEvents, SEGMENT_SIZE, unseal, writeSealed, type JournalAppendMeta } from "../packages/host/src/vault.js";

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

test("appendAll crosses segment boundaries with exact cumulative byte metadata and durable replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "inf-vault-batch-"));
  const key = randomBytes(32);
  try {
    const observed: { seq: number; meta: JournalAppendMeta }[] = [];
    const journal = new Journal(directory, key, "session-batch", {
      onAppend: (event, meta) => observed.push({ seq: event.seq, meta }),
    });
    const initial = Array.from({ length: SEGMENT_SIZE - 2 }, (_, i) => ({ text: `m-${i}` }));
    const first = journal.appendAll("message", initial);
    assert.equal(first.length, SEGMENT_SIZE - 2);
    const crossing = journal.appendAll("message", [
      { text: "before-edge" },
      { text: "at-edge" },
      { text: "after-edge-1" },
      { text: "after-edge-2" },
    ]);
    assert.deepEqual(crossing.map((event) => event.seq), [SEGMENT_SIZE - 1, SEGMENT_SIZE, SEGMENT_SIZE + 1, SEGMENT_SIZE + 2]);
    assert.equal(journal.seq, SEGMENT_SIZE + 2);
    assert.equal(observed.length, SEGMENT_SIZE + 2);
    const seg0 = readFileSync(join(directory, "0000000000.journal"));
    const seg1 = readFileSync(join(directory, "0000000001.journal"));
    const seg0Last = observed[SEGMENT_SIZE - 1]!;
    assert.equal(seg0Last.meta.segment, "0000000000.journal");
    assert.equal(seg0Last.meta.bytes, seg0.length);
    const seg1First = observed[SEGMENT_SIZE]!;
    const seg1Last = observed[SEGMENT_SIZE + 1]!;
    assert.equal(seg1First.meta.segment, "0000000001.journal");
    assert.ok(seg1First.meta.bytes > 0 && seg1First.meta.bytes < seg1Last.meta.bytes);
    assert.equal(seg1Last.meta.segment, "0000000001.journal");
    assert.equal(seg1Last.meta.bytes, seg1.length);
    const seg1Lines = seg1.toString("utf8").trimEnd().split("\n");
    assert.equal(seg1First.meta.bytes, Buffer.byteLength(`${seg1Lines[0]}\n`));
    const reopened = new Journal(directory, key, "session-batch");
    assert.equal(reopened.seq, SEGMENT_SIZE + 2);
    const page = readEvents(directory, key, "session-batch", SEGMENT_SIZE - 2, 10);
    assert.deepEqual(page.events.map((event) => event.data.text), ["before-edge", "at-edge", "after-edge-1", "after-edge-2"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
