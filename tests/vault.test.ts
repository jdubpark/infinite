import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../packages/host/src/types.js";
import { Journal, readEvents, seal, SEGMENT_SIZE, unseal, writeSealed, type JournalAppendMeta } from "../packages/host/src/vault.js";

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

type JournalEntry = { type: Event["type"]; data: Event["data"] };
type JournalInvariant = "seq-matches-disk" | "observer-exact-offsets" | "segment-boundaries" | "replay-parity";
type JournalMutantKind = "none" | "defer-seq-after-observer" | "report-final-segment-bytes" | "skip-segment-split" | "drop-last-batch-record";

class JournalInvariantError extends Error {
  constructor(readonly invariant: JournalInvariant, message: string) {
    super(`[${invariant}] ${message}`);
  }
}

interface SimJournal {
  seq: number;
  append(type: Event["type"], data: Event["data"]): Event;
  appendAll(type: Event["type"], items: readonly Event["data"][]): Event[];
}

function createMulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createSimJournal(
  directory: string,
  key: Buffer,
  sessionId: string,
  onAppend: (event: Event, meta: JournalAppendMeta) => void,
  mutant: JournalMutantKind,
): SimJournal {
  if (mutant === "none") return new Journal(directory, key, sessionId, { onAppend });
  if (mutant === "drop-last-batch-record") {
    const inner = new Journal(directory, key, sessionId, { onAppend });
    return {
      get seq() { return inner.seq; },
      append: (type, data) => inner.append(type, data),
      appendAll: (type, items) => inner.appendAll(type, items.length > 1 ? items.slice(0, -1) : items),
    };
  }
  const initial = new Journal(directory, key, sessionId);
  let seq = initial.seq;
  const appendAll = (type: Event["type"], items: readonly Event["data"][]): Event[] => {
    const at = new Date().toISOString();
    const first = seq;
    const events = items.map(
      (data, index): Event => ({ seq: first + index + 1, at, type, data }),
    );
    for (let start = 0; start < events.length; ) {
      const segment = Math.floor((events[start]!.seq - 1) / SEGMENT_SIZE);
      const end = mutant === "skip-segment-split" ? events.length : Math.min(events.length, (segment + 1) * SEGMENT_SIZE - first);
      const lines = events
        .slice(start, end)
        .map((event) => seal(key, `${sessionId}:${event.seq}`, event) + "\n");
      const bytes = Buffer.from(lines.join(""));
      const name = `${String(segment).padStart(10, "0")}.journal`;
      const fd = openSync(join(directory, name), "a", 0o600);
      let segmentBytes = 0;
      try {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
        fsyncSync(fd);
        segmentBytes = fstatSync(fd).size;
      } finally {
        closeSync(fd);
      }
      let size = segmentBytes - bytes.length;
      const notify = () => {
        for (let idx = start; idx < end; idx++) {
          size += Buffer.byteLength(lines[idx - start]!);
          seq = events[idx]!.seq;
          const reportedBytes = mutant === "report-final-segment-bytes" ? segmentBytes : size;
          onAppend(events[idx]!, { segment: name, bytes: reportedBytes });
        }
      };
      if (mutant === "defer-seq-after-observer") {
        notify();
        seq = events[end - 1]!.seq;
      } else {
        try {
          notify();
        } finally {
          seq = events[end - 1]!.seq;
        }
      }
      start = end;
    }
    return events;
  };
  return {
    get seq() { return seq; },
    append: (type, data) => appendAll(type, [data])[0]!,
    appendAll,
  };
}

function drainAllEvents(directory: string, key: Buffer, sessionId: string, limit: number, types?: Set<string>): Event[] {
  const out: Event[] = [];
  let cursor = 0;
  for (;;) {
    const page = readEvents(directory, key, sessionId, cursor, limit, types);
    out.push(...page.events);
    if (!page.more) return out;
    if (page.cursor <= cursor) throw new JournalInvariantError("replay-parity", `cursor stalled at ${cursor}`);
    cursor = page.cursor;
  }
}

function verifyJournalInvariants(
  directory: string,
  key: Buffer,
  sessionId: string,
  journal: SimJournal,
  model: readonly JournalEntry[],
  observed: readonly { event: Event; meta: JournalAppendMeta }[],
  context: string,
): void {
  const files = readdirSync(directory).filter((name) => /^\d{10}\.journal$/.test(name)).sort();
  const segmentLineSizes = new Map<string, number[]>();
  let diskCount = 0;
  for (let s = 0; s < files.length; s++) {
    const file = files[s]!;
    const expectedName = `${String(s).padStart(10, "0")}.journal`;
    if (file !== expectedName) {
      throw new JournalInvariantError("segment-boundaries", `${context}: expected segment ${expectedName}, got ${file}`);
    }
    const raw = readFileSync(join(directory, file), "utf8");
    if (!raw.endsWith("\n")) {
      throw new JournalInvariantError("segment-boundaries", `${context}: segment ${file} does not end with newline`);
    }
    const lines = raw.slice(0, -1).split("\n");
    const isLast = s === files.length - 1;
    if (isLast ? (lines.length < 1 || lines.length > SEGMENT_SIZE) : lines.length !== SEGMENT_SIZE) {
      throw new JournalInvariantError("segment-boundaries", `${context}: segment ${file} had invalid line count ${lines.length}`);
    }
    const cumulative: number[] = [];
    let running = 0;
    for (const line of lines) {
      running += Buffer.byteLength(`${line}\n`);
      cumulative.push(running);
    }
    segmentLineSizes.set(file, cumulative);
    diskCount += lines.length;
  }
  if (journal.seq !== diskCount) {
    throw new JournalInvariantError("seq-matches-disk", `${context}: journal.seq=${journal.seq} diverged from diskCount=${diskCount}`);
  }
  let reopened: Journal;
  try {
    reopened = new Journal(directory, key, sessionId);
  } catch (error) {
    throw new JournalInvariantError("replay-parity", `${context}: reopen failed: ${(error as Error).message}`);
  }
  if (reopened.seq !== journal.seq) {
    throw new JournalInvariantError("seq-matches-disk", `${context}: reopened.seq=${reopened.seq} !== journal.seq=${journal.seq}`);
  }
  let prevObservedSeq = 0;
  for (const record of observed) {
    const seq = record.event.seq;
    if (seq <= prevObservedSeq) {
      throw new JournalInvariantError("observer-exact-offsets", `${context}: non-monotonic observed seq ${seq} after ${prevObservedSeq}`);
    }
    prevObservedSeq = seq;
    const segIdx = Math.floor((seq - 1) / SEGMENT_SIZE);
    const expectedSeg = `${String(segIdx).padStart(10, "0")}.journal`;
    if (record.meta.segment !== expectedSeg) {
      throw new JournalInvariantError("observer-exact-offsets", `${context}: seq ${seq} reported segment ${record.meta.segment}, expected ${expectedSeg}`);
    }
    const lineIdx = (seq - 1) % SEGMENT_SIZE;
    const expectedBytes = segmentLineSizes.get(expectedSeg)?.[lineIdx];
    if (record.meta.bytes !== expectedBytes) {
      throw new JournalInvariantError("observer-exact-offsets", `${context}: seq ${seq} reported bytes=${record.meta.bytes}, expected ${expectedBytes}`);
    }
  }
  const replayed = drainAllEvents(directory, key, sessionId, 73);
  if (replayed.length !== model.length) {
    throw new JournalInvariantError("replay-parity", `${context}: replayed ${replayed.length} events, model has ${model.length}`);
  }
  for (let i = 0; i < model.length; i++) {
    const actual = replayed[i]!;
    const expected = model[i]!;
    if (actual.seq !== i + 1 || actual.type !== expected.type || JSON.stringify(actual.data) !== JSON.stringify(expected.data)) {
      throw new JournalInvariantError("replay-parity", `${context}: mismatch at seq ${i + 1}`);
    }
  }
  const signals = drainAllEvents(directory, key, sessionId, 17, new Set(["signal"]));
  const expectedSignalSeqs = model.flatMap((entry, i) => entry.type === "signal" ? [i + 1] : []);
  if (JSON.stringify(signals.map((event) => event.seq)) !== JSON.stringify(expectedSignalSeqs)) {
    throw new JournalInvariantError("replay-parity", `${context}: filtered signal replay mismatch`);
  }
}

function runJournalSimulation(seeds: readonly number[], mutant: JournalMutantKind) {
  const coverage = {
    singleAppends: 0,
    batchAppends: 0,
    emptyBatches: 0,
    segmentRotations: 0,
    multiSegmentBatches: 0,
    observerThrows: 0,
    appendsAfterObserverThrow: 0,
    reopens: 0,
  };
  const types: Event["type"][] = ["message", "output", "signal"];
  for (const seed of seeds) {
    const rng = createMulberry32(seed);
    const directory = mkdtempSync(join(tmpdir(), `inf-vault-sim-${seed}-`));
    const key = randomBytes(32);
    const sessionId = `vault-sim-${seed}`;
    try {
      const model: JournalEntry[] = [];
      const observed: { event: Event; meta: JournalAppendMeta }[] = [];
      let throwOnSeq: number | undefined;
      let threwSeq: number | undefined;
      let threwBefore = false;
      const onAppend = (event: Event, meta: JournalAppendMeta) => {
        observed.push({ event, meta });
        if (throwOnSeq !== undefined && event.seq === throwOnSeq) {
          throwOnSeq = undefined;
          threwSeq = event.seq;
          throw new Error(`injected observer throw at seq ${event.seq}`);
        }
      };
      let journal = createSimJournal(directory, key, sessionId, onAppend, mutant);
      let nextId = 0;
      const makeData = (): Event["data"] => {
        const id = nextId++;
        return { id, text: `payload-${seed}-${id}-${"x".repeat(Math.floor(rng() * 24))}` };
      };
      for (let step = 0; step < 18; step++) {
        const context = `seed=${seed} step=${step} mutant=${mutant}`;
        const roll = rng();
        if (step === 6 || step === 13 || roll < 0.12) {
          journal = createSimJournal(directory, key, sessionId, onAppend, mutant);
          coverage.reopens++;
          verifyJournalInvariants(directory, key, sessionId, journal, model, observed, `${context} reopen`);
          continue;
        }
        if (step === 2) {
          assert.deepEqual(journal.appendAll("message", []), []);
          coverage.emptyBatches++;
          verifyJournalInvariants(directory, key, sessionId, journal, model, observed, `${context} empty`);
          continue;
        }
        const beforeSeq = journal.seq;
        const beforeSeg = beforeSeq === 0 ? 0 : Math.floor((beforeSeq - 1) / SEGMENT_SIZE);
        const remaining = (Math.floor(beforeSeq / SEGMENT_SIZE) + 1) * SEGMENT_SIZE - beforeSeq;
        if (step === 1 || roll < 0.3) {
          const type = types[Math.floor(rng() * types.length)]!;
          const entry: JournalEntry = { type, data: makeData() };
          const shouldThrow = step === 9 || (!threwBefore && step === 4);
          throwOnSeq = shouldThrow ? beforeSeq + 1 : undefined;
          threwSeq = undefined;
          if (shouldThrow) {
            assert.throws(() => journal.append(entry.type, entry.data), /injected observer throw/);
            coverage.observerThrows++;
            threwBefore = true;
          } else {
            journal.append(entry.type, entry.data);
            if (threwBefore) coverage.appendsAfterObserverThrow++;
          }
          model.push(entry);
          coverage.singleAppends++;
        } else {
          const forceCross = step === 5 || step === 11;
          const size = forceCross ? Math.min(remaining + 3, 270) : 2 + Math.floor(rng() * 90);
          const batchType = types[Math.floor(rng() * types.length)]!;
          const items = Array.from({ length: size }, makeData);
          const entries: JournalEntry[] = items.map((data) => ({ type: batchType, data }));
          const shouldThrow = step === 5 ? false : (step === 3 || step === 11 || (size >= 3 && rng() < 0.25));
          const throwOffset = shouldThrow ? (step === 3 ? 0 : Math.floor(rng() * Math.min(size, remaining))) : -1;
          throwOnSeq = throwOffset >= 0 ? beforeSeq + 1 + throwOffset : undefined;
          threwSeq = undefined;
          if (shouldThrow) {
            assert.throws(() => journal.appendAll(batchType, items), /injected observer throw/);
            coverage.observerThrows++;
            threwBefore = true;
            assert.ok(threwSeq !== undefined);
            const committedEnd = Math.min(beforeSeq + entries.length, Math.ceil(threwSeq / SEGMENT_SIZE) * SEGMENT_SIZE);
            model.push(...entries.slice(0, committedEnd - beforeSeq));
          } else {
            journal.appendAll(batchType, items);
            model.push(...entries);
            if (threwBefore) coverage.appendsAfterObserverThrow++;
            if (beforeSeq > 0 && Math.floor((beforeSeq + size - 1) / SEGMENT_SIZE) > Math.floor((beforeSeq - 1) / SEGMENT_SIZE)) {
              coverage.multiSegmentBatches++;
            }
          }
          coverage.batchAppends++;
        }
        const afterSeg = model.length === 0 ? 0 : Math.floor((model.length - 1) / SEGMENT_SIZE);
        if (afterSeg > beforeSeg) coverage.segmentRotations++;
        verifyJournalInvariants(directory, key, sessionId, journal, model, observed, context);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return coverage;
}

test("seeded durable-state journal simulator enforces invariants across batches, rotations, observer throws, and reopens", { timeout: 60000 }, (t) => {
  const onlySeed = process.env.VAULT_SIM_SEED ? Number(process.env.VAULT_SIM_SEED) : undefined;
  const seeds = onlySeed !== undefined ? [onlySeed] : [47501, 47502, 47503, 47504];
  const started = performance.now();
  const coverage = runJournalSimulation(seeds, "none");
  t.diagnostic(`vault journal sim: seeds=${JSON.stringify(seeds)} in ${(performance.now() - started).toFixed(0)}ms ${JSON.stringify(coverage)}`);
  for (const [metric, count] of Object.entries(coverage)) {
    assert.ok(count > 0, `expected non-zero simulator coverage for ${metric}, got ${count}`);
  }

  const mutants: { mutant: JournalMutantKind; invariant: JournalInvariant }[] = [
    { mutant: "defer-seq-after-observer", invariant: "seq-matches-disk" },
    { mutant: "report-final-segment-bytes", invariant: "observer-exact-offsets" },
    { mutant: "skip-segment-split", invariant: "segment-boundaries" },
    { mutant: "drop-last-batch-record", invariant: "replay-parity" },
  ];
  for (const { mutant, invariant } of mutants) {
    let caught: unknown;
    try {
      runJournalSimulation([seeds[0]!], mutant);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof JournalInvariantError, `mutant ${mutant} must fail with JournalInvariantError, got ${String(caught)}`);
    assert.equal(caught.invariant, invariant, `mutant ${mutant} failed wrong invariant: ${caught.message}`);
    t.diagnostic(`mutant ${mutant} caught by ${caught.invariant}: ${caught.message}`);
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
