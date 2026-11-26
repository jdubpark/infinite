import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ContextTouches, type TouchSource } from "../packages/host/src/context-touches.js";
import { Manager } from "../packages/host/src/manager.js";
import {
  journalTipSeq,
  readIndexedEvents,
  readSignalEvents,
  readSignalIndex,
  readSignalIndexState,
  SIGNAL_INDEX_FILE,
  SIGNAL_INDEX_STATE_FILE,
  SignalIndex,
  type EventPage,
  type EventPageReader,
} from "../packages/host/src/signal-index.js";
import type { Config, Event } from "../packages/host/src/types.js";
import { Journal, MAX_EVENT_PAGE_BYTES, readEvents, seal, SEGMENT_SIZE, writeSealed } from "../packages/host/src/vault.js";
import { startHost, waitFor } from "./helpers.js";

const SIGNAL_ONLY = new Set(["signal"]);
const TEST_CWD = "/home/dev/projects/example";

function makeManager(root: string, key: Buffer): Manager {
  const stateDir = join(root, "state");
  const runDir = join(root, "run");
  const keyFile = join(root, "key");
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(keyFile, key, { mode: 0o600 });
  return new Manager(
    {
      port: 0,
      origin: "http://127.0.0.1:0",
      stateDir,
      runDir,
      keyFile,
      environment: "local",
      enableDemo: true,
      maxSessions: 8,
      tokens: [],
      projects: [],
      agents: {},
    } as Config,
    key,
  );
}

function writeSessionMeta(stateDir: string, key: Buffer, id: string, provider: "claude" | "codex" = "claude") {
  const sessionDir = join(stateDir, "sessions", id);
  mkdirSync(sessionDir, { recursive: true });
  writeSealed(join(sessionDir, "meta.sealed"), key, `${id}:meta`, {
    session: {
      id,
      provider,
      title: "Signal index fixture",
      projectId: "proj-1",
      cwd: TEST_CWD,
      createdAt: "2026-11-26T00:00:00.000Z",
      status: "running",
      contextVersion: 0,
      context: "",
      initialPrompt: "",
    },
    fingerprint: "signal-index-fixture",
  });
  return sessionDir;
}

function drainPages(read: (after: number, limit: number) => EventPage, after = 0, limit = 200) {
  const events: Event[] = [];
  let cursor = after;
  let pages = 0;
  for (;;) {
    const page = read(cursor, limit);
    pages++;
    assert.ok(page.events.length <= Math.max(0, limit), `page exceeded limit=${limit}: got ${page.events.length}`);
    for (const event of page.events) {
      assert.ok(event.seq > cursor, `event seq ${event.seq} must exceed cursor ${cursor}`);
    }
    events.push(...page.events);
    if (page.more) {
      assert.ok(page.cursor > cursor, `cursor must advance when more=true (after=${cursor}, cursor=${page.cursor})`);
      cursor = page.cursor;
    } else {
      assert.ok(page.cursor >= cursor, `final cursor ${page.cursor} must be >= ${cursor}`);
      cursor = page.cursor;
      break;
    }
    assert.ok(pages < 2000, "pagination did not terminate");
  }
  return { events, cursor, pages };
}

function toolStartData(tool: string, input: Record<string, unknown>, id: string): Record<string, unknown> {
  return {
    kind: "tool-start",
    source: "hook",
    provider: "claude",
    tool,
    toolUseId: id,
    input,
    quiet: false,
  };
}

function poisonOutputLineInSegment(eventsDir: string, segmentIndex: number, lineIndex: number) {
  const file = join(eventsDir, `${String(segmentIndex).padStart(10, "0")}.journal`);
  const lines = readFileSync(file, "utf8").split("\n");
  assert.ok(lineIndex < lines.length - 1, `missing line ${lineIndex} in segment ${segmentIndex}`);
  lines[lineIndex] = JSON.stringify({ v: 1, n: "AAAAAAAAAAAAAAAA", c: "AAAA", t: "AAAAAAAAAAAAAAAAAAAAAA==" });
  writeFileSync(file, lines.join("\n"));
}

function appendBulkJournalEvents(
  eventsDir: string,
  signalIndex: SignalIndex,
  key: Buffer,
  sessionId: string,
  items: { type: Event["type"]; data: Event["data"] }[],
): Event[] {
  mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
  const segmentBuffers = new Map<number, string[]>();
  const created: Event[] = [];
  let seq = journalTipSeq(eventsDir);
  for (const item of items) {
    seq += 1;
    const event: Event = { seq, at: "2026-11-26T00:00:00.000Z", type: item.type, data: item.data };
    const seg = Math.floor((seq - 1) / SEGMENT_SIZE);
    let bucket = segmentBuffers.get(seg);
    if (!bucket) {
      bucket = [];
      segmentBuffers.set(seg, bucket);
    }
    bucket.push(`${seal(key, `${sessionId}:${seq}`, event)}\n`);
    created.push(event);
  }
  for (const [seg, lines] of [...segmentBuffers.entries()].sort((a, b) => a[0] - b[0])) {
    const file = join(eventsDir, `${String(seg).padStart(10, "0")}.journal`);
    appendFileSync(file, lines.join(""), { mode: 0o600 });
  }
  for (const event of created) signalIndex.observe(event);
  signalIndex.checkpoint(seq);
  return created;
}

test("large output-heavy and zero-signal journals answer manager.events and ContextTouches with zero output decryptions", async () => {
  const root = mkdtempSync("/tmp/inf-sigidx-large-");
  const key = randomBytes(32);
  try {
    const manager = makeManager(root, key);
    const stateDir = join(root, "state");

    const id = randomUUID();
    const sessionDir = writeSessionMeta(stateDir, key, id);
    const eventsDir = join(sessionDir, "events");
    const signalIndex = new SignalIndex(sessionDir, key, id, 0);

    const payload = "X".repeat(3072);
    const items: { type: Event["type"]; data: Event["data"] }[] = [
      { type: "lifecycle", data: { status: "running", pid: 101 } },
    ];
    for (let i = 0; i < 600; i++) items.push({ type: "output", data: { text: `${i}:${payload}\n` } });
    items.push({ type: "signal", data: toolStartData("Read", { file_path: "src/a.ts" }, "t1") });
    for (let i = 0; i < 900; i++) items.push({ type: "output", data: { text: `${i}:${payload}\n` } });
    items.push({ type: "signal", data: toolStartData("Edit", { file_path: "src/b.ts" }, "t2") });
    for (let i = 0; i < 900; i++) items.push({ type: "output", data: { text: `${i}:${payload}\n` } });
    items.push({ type: "signal", data: toolStartData("Bash", { command: "graphify query 'routes'" }, "t3") });
    for (let i = 0; i < 700; i++) items.push({ type: "output", data: { text: `${i}:${payload}\n` } });
    const created = appendBulkJournalEvents(eventsDir, signalIndex, key, id, items);
    const sig1 = created.find(e => e.type === "signal" && e.data.toolUseId === "t1")!;
    const sig2 = created.find(e => e.type === "signal" && e.data.toolUseId === "t2")!;
    const sig3 = created.find(e => e.type === "signal" && e.data.toolUseId === "t3")!;
    const lastSeq = created.at(-1)!.seq;

    assert.ok(lastSeq > 3100);
    assert.equal(journalTipSeq(eventsDir), lastSeq);
    assert.equal(statSync(join(sessionDir, SIGNAL_INDEX_FILE)).mode & 0o777, 0o600);
    assert.equal(statSync(join(sessionDir, SIGNAL_INDEX_STATE_FILE)).mode & 0o777, 0o600);

    let tailCalls = 0;
    const countingTail: EventPageReader = (after, limit, types) => {
      tailCalls++;
      return readEvents(eventsDir, key, id, after, limit, types);
    };
    const tIndexedStart = performance.now();
    const indexedPage = readSignalEvents(sessionDir, key, id, 0, 200, countingTail);
    const indexedMs = performance.now() - tIndexedStart;
    assert.equal(tailCalls, 0, "covered signal read must not scan or decrypt any journal output segments");
    assert.equal(indexedPage.more, false);
    assert.equal(indexedPage.cursor, lastSeq);
    assert.deepEqual(indexedPage.events, [sig1, sig2, sig3]);

    const tScanStart = performance.now();
    const fullScan = drainPages((after, limit) => readEvents(eventsDir, key, id, after, limit, SIGNAL_ONLY), 0, 200);
    const fullScanMs = performance.now() - tScanStart;
    assert.ok(fullScan.pages > 8, `unindexed scan must span > 8 pages on multi-MB output (saw ${fullScan.pages})`);
    assert.deepEqual(fullScan.events, indexedPage.events);
    assert.equal(fullScan.cursor, indexedPage.cursor);
    assert.ok(indexedMs < fullScanMs, `indexed read (${indexedMs.toFixed(2)}ms) should be faster than full scan (${fullScanMs.toFixed(2)}ms)`);

    const unindexedTouches = new ContextTouches({
      read: (sessionId, after) => readEvents(join(stateDir, "sessions", sessionId, "events"), key, sessionId, after, 200, SIGNAL_ONLY),
      areas: () => undefined,
    });
    const source: TouchSource = { sessionId: id, cwd: TEST_CWD, provider: "claude", projectId: "proj-1" };
    const unindexedResult = await unindexedTouches.session(source);
    assert.equal(unindexedResult.complete, false, "unindexed ContextTouches exhausts its 8-page budget on heavy output");

    poisonOutputLineInSegment(eventsDir, 0, 5);
    poisonOutputLineInSegment(eventsDir, Math.floor((lastSeq - 1) / SEGMENT_SIZE), 0);
    assert.throws(() => readEvents(eventsDir, key, id, 0, 200, SIGNAL_ONLY));

    let managerReadCalls = 0;
    const indexedTouches = new ContextTouches({
      read: (sessionId, after) => {
        managerReadCalls++;
        return manager.events(sessionId, after, 200, SIGNAL_ONLY);
      },
      areas: () => undefined,
    });
    const indexedResult = await indexedTouches.session(source);
    assert.equal(managerReadCalls, 1, "indexed ContextTouches completes in one read call");
    assert.equal(indexedResult.complete, true);
    assert.equal(indexedResult.observable, true);
    assert.equal(indexedResult.graphQueries, 1);
    assert.deepEqual(
      indexedResult.files.map(file => [file.path, file.reads, file.edits]),
      [["src/b.ts", 0, 1], ["src/a.ts", 1, 0]],
    );

    const zeroId = randomUUID();
    const zeroDir = writeSessionMeta(stateDir, key, zeroId);
    const zeroEventsDir = join(zeroDir, "events");
    const zeroIndex = new SignalIndex(zeroDir, key, zeroId, 0);
    const zeroItems: { type: Event["type"]; data: Event["data"] }[] = [
      { type: "lifecycle", data: { status: "running", pid: 202 } },
    ];
    for (let i = 0; i < 2000; i++) zeroItems.push({ type: "output", data: { text: `${i}:${payload}\n` } });
    const zeroCreated = appendBulkJournalEvents(zeroEventsDir, zeroIndex, key, zeroId, zeroItems);
    const zeroLastSeq = zeroCreated.at(-1)!.seq;

    assert.equal(existsSync(join(zeroDir, SIGNAL_INDEX_FILE)), false);
    assert.equal(existsSync(join(zeroDir, SIGNAL_INDEX_STATE_FILE)), true);
    poisonOutputLineInSegment(zeroEventsDir, 0, 1);
    poisonOutputLineInSegment(zeroEventsDir, Math.floor((zeroLastSeq - 1) / SEGMENT_SIZE), 0);

    let zeroTailCalls = 0;
    const zeroPage = readSignalEvents(zeroDir, key, zeroId, 0, 200, (after, limit, types) => {
      zeroTailCalls++;
      return readEvents(zeroEventsDir, key, zeroId, after, limit, types);
    });
    assert.equal(zeroTailCalls, 0, "zero-signal output-heavy journal must perform 0 tail scans");
    assert.deepEqual(zeroPage, { events: [], cursor: zeroLastSeq, more: false });

    const zeroTouches = await indexedTouches.session({ ...source, sessionId: zeroId });
    assert.deepEqual(zeroTouches, {
      sessionId: zeroId,
      observable: false,
      complete: true,
      graphQueries: 0,
      files: [],
      truncated: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pagination parity across limits, boundaries, oversized signal payloads, and incremental ContextTouches polls", async () => {
  const root = mkdtempSync("/tmp/inf-sigidx-page-");
  const key = randomBytes(32);
  try {
    const manager = makeManager(root, key);
    const stateDir = join(root, "state");
    const id = randomUUID();
    const sessionDir = writeSessionMeta(stateDir, key, id);
    const eventsDir = join(sessionDir, "events");
    let signalIndex: SignalIndex | undefined;
    const journal = new Journal(eventsDir, key, id, {
      onAppend: event => {
        signalIndex?.observe(event);
      },
    });
    signalIndex = new SignalIndex(sessionDir, key, id, journal.seq);

    const source: TouchSource = { sessionId: id, cwd: TEST_CWD, provider: "claude", projectId: "proj-1" };
    const polledCursors: number[] = [];
    const touches = new ContextTouches({
      read: (sessionId, after) => {
        polledCursors.push(after);
        return manager.events(sessionId, after, 2, SIGNAL_ONLY);
      },
      areas: () => undefined,
    });

    journal.append("output", { text: "boot\n" });
    const s1 = journal.append("signal", toolStartData("Read", { file_path: "src/one.ts" }, "t1"));
    journal.append("output", { text: "mid-1\n" });
    const s2 = journal.append("signal", toolStartData("Edit", { file_path: "src/two.ts" }, "t2"));
    journal.append("output", { text: "mid-2\n" });
    const s3 = journal.append("signal", toolStartData("Read", { file_path: "src/one.ts" }, "t3"));
    journal.append("output", { text: "tail-1\n" });
    signalIndex.checkpoint(journal.seq);

    const firstPoll = await touches.session(source);
    assert.equal(firstPoll.complete, true);
    assert.deepEqual(
      firstPoll.files.map(file => [file.path, file.reads, file.edits]),
      [["src/one.ts", 2, 0], ["src/two.ts", 0, 1]],
    );
    assert.deepEqual(polledCursors, [0, s2.seq]);

    for (let i = 0; i < 30; i++) journal.append("output", { text: `quiet-${i}\n` });
    signalIndex.checkpoint(journal.seq);
    const secondPoll = await touches.session(source);
    assert.equal(secondPoll.complete, true);
    assert.equal(polledCursors.at(-1), s3.seq + 1);

    const s4 = journal.append("signal", toolStartData("Write", { file_path: "src/three.ts", blob: "Z".repeat(420 * 1024) }, "t4"));
    const s5 = journal.append("signal", toolStartData("Write", { file_path: "src/four.ts", blob: "Y".repeat(420 * 1024) }, "t5"));
    journal.append("output", { text: "after-big\n" });
    signalIndex.checkpoint(journal.seq);

    const bigPage1 = manager.events(id, s3.seq, 200, SIGNAL_ONLY);
    assert.ok(MAX_EVENT_PAGE_BYTES < 560 * 1024);
    assert.deepEqual(bigPage1.events.map(e => e.seq), [s4.seq]);
    assert.equal(bigPage1.cursor, s4.seq);
    assert.equal(bigPage1.more, true);
    const bigPage2 = manager.events(id, bigPage1.cursor, 200, SIGNAL_ONLY);
    assert.deepEqual(bigPage2.events.map(e => e.seq), [s5.seq]);
    assert.equal(bigPage2.cursor, journal.seq);
    assert.equal(bigPage2.more, false);

    const thirdPoll = await touches.session(source);
    assert.equal(thirdPoll.complete, true);
    assert.deepEqual(
      thirdPoll.files.map(file => file.path),
      ["src/four.ts", "src/three.ts", "src/one.ts", "src/two.ts"],
    );

    for (const limit of [1, 2, 3, 200]) {
      for (const after of [0, s1.seq - 1, s1.seq, s2.seq, s3.seq, s4.seq, journal.seq, journal.seq + 50]) {
        const expected = drainPages((from, count) => readEvents(eventsDir, key, id, from, count, SIGNAL_ONLY), after, limit);
        const actual = drainPages((from, count) => manager.events(id, from, count, SIGNAL_ONLY), after, limit);
        assert.deepEqual(actual.events, expected.events, `events mismatch for after=${after} limit=${limit}`);
        assert.equal(actual.cursor, expected.cursor, `cursor mismatch for after=${after} limit=${limit}`);
      }
    }

    assert.deepEqual(manager.events(id, -5, 10, SIGNAL_ONLY), readEvents(eventsDir, key, id, -5, 10, SIGNAL_ONLY));
    assert.deepEqual(manager.events(id, 0, 0, SIGNAL_ONLY), { events: [], cursor: 0, more: true });
    assert.deepEqual(
      manager.events(id, 0, 200, new Set(["output", "signal"])).events.length > 5,
      true,
    );
    assert.throws(() => readIndexedEvents(sessionDir, randomBytes(32), id, 0, 200, SIGNAL_ONLY));
    assert.throws(() => readIndexedEvents(sessionDir, key, "other-session", 0, 200, SIGNAL_ONLY));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy fallback, torn trailing line, crash gap, append failure invalidation, and restart gap fail-closed recovery", () => {
  const root = mkdtempSync("/tmp/inf-sigidx-faults-");
  const key = randomBytes(32);
  try {
    const legacyId = randomUUID();
    const legacyDir = join(root, legacyId);
    const legacyJournal = new Journal(join(legacyDir, "events"), key, legacyId);
    legacyJournal.append("output", { text: "old-1\n" });
    const legacySig = legacyJournal.append("signal", toolStartData("Read", { file_path: "src/legacy.ts" }, "l1"));
    legacyJournal.append("output", { text: "old-2\n" });
    assert.deepEqual(readSignalEvents(legacyDir, key, legacyId, 0, 200), {
      events: [legacySig],
      cursor: legacyJournal.seq,
      more: false,
    });
    const legacyReopen = new SignalIndex(legacyDir, key, legacyId, legacyJournal.seq);
    assert.equal(legacyReopen.isDisabled, true);

    const crashId = randomUUID();
    const crashDir = join(root, crashId);
    const crashEventsDir = join(crashDir, "events");
    const crashJournal = new Journal(crashEventsDir, key, crashId);
    const crashIndex = new SignalIndex(crashDir, key, crashId, crashJournal.seq);
    const record = (type: Event["type"], data: Event["data"], indexIt = true) => {
      const ev = crashJournal.append(type, data);
      if (indexIt) crashIndex.observe(ev);
      return ev;
    };
    for (let i = 0; i < 40; i++) record("output", { text: `pre-${i}\n` });
    const c1 = record("signal", toolStartData("Read", { file_path: "src/c1.ts" }, "c1"));
    for (let i = 0; i < 40; i++) record("output", { text: `mid-${i}\n` });
    crashIndex.checkpoint(crashJournal.seq);
    const coveredBeforeCrash = crashJournal.seq;
    const c2 = record("signal", toolStartData("Edit", { file_path: "src/c2.ts" }, "c2"), false);
    record("output", { text: "post-crash\n" }, false);

    const tailStarts: number[] = [];
    const recovered = drainPages(
      (after, limit) =>
        readSignalEvents(crashDir, key, crashId, after, limit, (from, count, types) => {
          tailStarts.push(from);
          return readEvents(crashEventsDir, key, crashId, from, count, types);
        }),
      0,
      200,
    );
    assert.deepEqual(recovered.events, [c1, c2]);
    assert.equal(recovered.cursor, crashJournal.seq);
    assert.deepEqual(tailStarts, [coveredBeforeCrash], "recovery scans only the uncovered tail");

    const reopenedAfterCrash = new SignalIndex(crashDir, key, crashId, crashJournal.seq);
    assert.equal(reopenedAfterCrash.isDisabled, true, "reopening over an uncovered crash gap must stay disabled");
    const c3 = crashJournal.append("signal", toolStartData("Read", { file_path: "src/c3.ts" }, "c3"));
    assert.equal(reopenedAfterCrash.observe(c3), false);
    assert.deepEqual(
      drainPages((after, limit) => readSignalEvents(crashDir, key, crashId, after, limit), 0, 200).events,
      [c1, c2, c3],
    );

    const tornId = randomUUID();
    const tornDir = join(root, tornId);
    const tornEventsDir = join(tornDir, "events");
    let tornIndex: SignalIndex | undefined;
    const tornJournal = new Journal(tornEventsDir, key, tornId, {
      onAppend: event => {
        tornIndex?.observe(event);
      },
    });
    tornIndex = new SignalIndex(tornDir, key, tornId, tornJournal.seq);
    const t1 = tornJournal.append("signal", toolStartData("Read", { file_path: "src/t1.ts" }, "t1"));
    for (let i = 0; i < 10; i++) tornJournal.append("output", { text: `o-${i}\n` });
    tornIndex.checkpoint(tornJournal.seq);
    const t2 = tornJournal.append("signal", toolStartData("Edit", { file_path: "src/t2.ts" }, "t2"));
    appendFileSync(join(tornDir, SIGNAL_INDEX_FILE), "{\"v\":1,\"n\":\"torn");
    const parsedTorn = readSignalIndex(join(tornDir, SIGNAL_INDEX_FILE), key, tornId);
    assert.equal(parsedTorn.intact, false);
    assert.deepEqual(parsedTorn.entries, [t1, t2]);

    const t3 = tornJournal.append("signal", toolStartData("Read", { file_path: "src/t3.ts" }, "t3"));
    const tornTailStarts: number[] = [];
    const tornRecovered = drainPages(
      (after, limit) =>
        readSignalEvents(tornDir, key, tornId, after, limit, (from, count, types) => {
          tornTailStarts.push(from);
          return readEvents(tornEventsDir, key, tornId, from, count, types);
        }),
      0,
      200,
    );
    assert.deepEqual(tornRecovered.events, [t1, t2, t3]);
    assert.deepEqual(tornTailStarts, [t2.seq], "torn trailing line still reuses valid prefix up to t2");

    const failId = randomUUID();
    const failDir = join(root, failId);
    const failEventsDir = join(failDir, "events");
    mkdirSync(join(failDir, SIGNAL_INDEX_FILE), { recursive: true });
    let failIndex: SignalIndex | undefined;
    const failJournal = new Journal(failEventsDir, key, failId, {
      onAppend: event => {
        failIndex?.observe(event);
      },
    });
    failIndex = new SignalIndex(failDir, key, failId, failJournal.seq);
    assert.equal(failIndex.isDisabled, true);
    const f1 = failJournal.append("signal", toolStartData("Read", { file_path: "src/f1.ts" }, "f1"));
    assert.deepEqual(readSignalEvents(failDir, key, failId, 0, 200).events, [f1]);

    const midFailId = randomUUID();
    const midFailDir = join(root, midFailId);
    const midFailEventsDir = join(midFailDir, "events");
    const midFailJournal = new Journal(midFailEventsDir, key, midFailId);
    const midFailIndex = new SignalIndex(midFailDir, key, midFailId, midFailJournal.seq);
    const m1 = midFailJournal.append("signal", toolStartData("Read", { file_path: "src/m1.ts" }, "m1"));
    assert.equal(midFailIndex.observe(m1), true);
    const mOut = midFailJournal.append("output", { text: "before-fail\n" });
    assert.equal(midFailIndex.observe(mOut), true);
    assert.equal(midFailIndex.checkpoint(midFailJournal.seq), true);
    rmSync(join(midFailDir, SIGNAL_INDEX_FILE), { force: true });
    mkdirSync(join(midFailDir, SIGNAL_INDEX_FILE), { recursive: true });
    const m2 = midFailJournal.append("signal", toolStartData("Edit", { file_path: "src/m2.ts" }, "m2"));
    assert.equal(midFailIndex.observe(m2), false);
    assert.equal(midFailIndex.isDisabled, true);
    rmSync(join(midFailDir, SIGNAL_INDEX_FILE), { recursive: true, force: true });
    const m3 = midFailJournal.append("signal", toolStartData("Read", { file_path: "src/m3.ts" }, "m3"));
    assert.equal(midFailIndex.observe(m3), false, "disabled index never resumes appending later signals");
    assert.equal(midFailIndex.checkpoint(midFailJournal.seq), false);
    assert.equal(readSignalIndexState(join(midFailDir, SIGNAL_INDEX_STATE_FILE), key, midFailId)?.coveredSeq, mOut.seq);
    assert.deepEqual(
      drainPages((after, limit) => readSignalEvents(midFailDir, key, midFailId, after, limit), 0, 200).events,
      [m1, m2, m3],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real worker writes signals.sealed and signals-state.sealed, serves /context without output scans, and manager.remove deletes them", { timeout: 60_000 }, async () => {
  const root = mkdtempSync("/tmp/inf-sigidx-worker-");
  const agentScript = join(root, "heavy-touch-agent.mjs");
  writeFileSync(
    agentScript,
    [
      "const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));",
      "let count = 0;",
      "const tool = (tool_name, tool_input) => fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {",
      "  method: 'POST',",
      "  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}` },",
      "  body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: `t${++count}` }),",
      "}).catch(() => {});",
      "await sleep(250);",
      "for (let i = 0; i < 200; i++) process.stdout.write(`BURST_${i}_${'A'.repeat(2500)}\\n`);",
      "await tool('Read', { file_path: 'src/worker-a.ts' });",
      "for (let i = 0; i < 200; i++) process.stdout.write(`BURST2_${i}_${'B'.repeat(2500)}\\n`);",
      "await tool('Edit', { file_path: 'src/worker-b.ts', old_string: 'x', new_string: 'y' });",
      "await tool('Bash', { command: 'graphify query auth' });",
      "process.stdout.write('WORKER_DONE\\n');",
      "setTimeout(() => process.exit(0), 200);",
    ].join("\n"),
  );
  const host = await startHost({
    agents: { claude: { command: process.execPath, args: [agentScript] } },
    config: { attention: { idleAfterMs: 3000, hooks: { claude: true, codex: true } } },
  });
  try {
    const sessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", {
      requestId: sessionId,
      provider: "claude",
      projectId: "rehearsal",
      title: "Heavy touch worker",
      prompt: "run",
    });
    await waitFor(
      async () => ((await host.fetchApi(`/sessions/${sessionId}`)).body as { status?: string }).status,
      status => status === "exited",
      30_000,
    );
    const hostKey = readFileSync(host.config.keyFile);
    const sessionDir = join(host.config.stateDir, "sessions", sessionId);
    const sigFile = join(sessionDir, SIGNAL_INDEX_FILE);
    const stateFile = join(sessionDir, SIGNAL_INDEX_STATE_FILE);
    assert.equal(existsSync(sigFile), true);
    assert.equal(existsSync(stateFile), true);
    assert.equal(statSync(sigFile).mode & 0o777, 0o600);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);

    const indexed = readSignalIndex(sigFile, hostKey, sessionId);
    assert.equal(indexed.intact, true);
    assert.ok(indexed.entries.length >= 3);
    const state = readSignalIndexState(stateFile, hostKey, sessionId);
    assert.ok(state);
    assert.equal(state.coveredSeq, journalTipSeq(join(sessionDir, "events")));
    assert.equal(state.count, indexed.entries.length);

    const workerEventsDir = join(sessionDir, "events");
    const firstOutput = readEvents(workerEventsDir, hostKey, sessionId, 0, 50).events.find(e => e.type === "output");
    assert.ok(firstOutput);
    poisonOutputLineInSegment(
      workerEventsDir,
      Math.floor((firstOutput.seq - 1) / SEGMENT_SIZE),
      (firstOutput.seq - 1) % SEGMENT_SIZE,
    );
    assert.throws(() => readEvents(workerEventsDir, hostKey, sessionId, 0, 200, SIGNAL_ONLY));

    const touches = (await host.fetchApi(`/sessions/${sessionId}/context`, "viewer")).body as {
      observable: boolean;
      complete: boolean;
      graphQueries: number;
      files: { path: string; reads: number; edits: number }[];
    };
    assert.equal(touches.observable, true);
    assert.equal(touches.complete, true);
    assert.equal(touches.graphQueries, 1);
    assert.deepEqual(
      touches.files.map(file => [file.path, file.reads, file.edits]).sort(),
      [["src/worker-a.ts", 1, 0], ["src/worker-b.ts", 0, 1]],
    );

    const removed = await waitFor(
      async () => host.fetchApi(`/sessions/${sessionId}`, "owner", undefined, {}, "DELETE"),
      res => res.status === 200,
      10_000,
    );
    assert.equal(removed.status, 200);
    assert.equal(existsSync(sessionDir), false);
    assert.equal(existsSync(sigFile), false);
    assert.equal(existsSync(stateFile), false);
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type SignalPageReader = (
  sessionDir: string,
  key: Buffer,
  sessionId: string,
  after: number,
  limit: number,
  readTail?: EventPageReader,
) => EventPage;

async function runDurableSignalSimulation(
  reader: SignalPageReader,
  seeds: readonly number[],
  opts: { allowIndexAppendAfterMiss?: boolean } = {},
) {
  const coverage = {
    outputs: 0,
    largeOutputBursts: 0,
    nonSignalEvents: 0,
    signals: 0,
    checkpoints: 0,
    zeroTailCoveredReads: 0,
    incrementalPolls: 0,
    crashAfterJournal: 0,
    tornSignalIndex: 0,
    crashAfterSignalBeforeState: 0,
    truncatedSignalIndex: 0,
    appendFailThenLaterSignal: 0,
    restarts: 0,
    legacyNoIndex: 0,
  };

  for (const seed of seeds) {
    const rng = mulberry32(seed);
    const root = mkdtempSync(`/tmp/inf-sigsim-${seed}-`);
    const id = randomUUID();
    const key = randomBytes(32);
    const sessionDir = join(root, id);
    const eventsDir = join(sessionDir, "events");
    const sigFile = join(sessionDir, SIGNAL_INDEX_FILE);
    const stateFile = join(sessionDir, SIGNAL_INDEX_STATE_FILE);
    mkdirSync(sessionDir, { recursive: true });
    try {
      let journal = new Journal(eventsDir, key, id);
      let signalIndex = new SignalIndex(sessionDir, key, id, journal.seq);
      const source: TouchSource = { sessionId: id, cwd: TEST_CWD, provider: "claude", projectId: "proj-1" };
      const simTouches = new ContextTouches({
        read: (sessionId, after) => reader(sessionDir, key, sessionId, after, 3),
        areas: () => undefined,
        maxReads: 64,
      });
      const oracleTouches = new ContextTouches({
        read: (_sessionId, after) => readEvents(eventsDir, key, id, after, 3, SIGNAL_ONLY),
        areas: () => undefined,
        maxReads: 256,
      });
      let missedAppend = false;
      let faulted = false;
      let toolSeq = 0;

      const verifyAll = async (expectZeroTail = false) => {
        const tip = journalTipSeq(eventsDir);
        const candidates = [0, Math.floor(tip / 2), Math.max(0, tip - 1), tip];
        for (const limit of [1, 2, 5, 200]) {
          for (const after of candidates) {
            let tailCalls = 0;
            const actual = drainPages(
              (from, count) =>
                reader(sessionDir, key, id, from, count, (tailFrom, tailCount, types) => {
                  tailCalls++;
                  return readEvents(eventsDir, key, id, tailFrom, tailCount, types);
                }),
              after,
              limit,
            );
            const expected = drainPages(
              (from, count) => readEvents(eventsDir, key, id, from, count, SIGNAL_ONLY),
              after,
              limit,
            );
            assert.deepEqual(actual.events, expected.events, `seed=${seed} after=${after} limit=${limit}`);
            assert.equal(actual.cursor, expected.cursor, `seed=${seed} cursor after=${after} limit=${limit}`);
            if (expectZeroTail && after === 0 && limit === 200) {
              assert.equal(tailCalls, 0, `seed=${seed} expected 0 tail calls when fully covered`);
              coverage.zeroTailCoveredReads++;
            }
          }
        }
        const gotTouches = await simTouches.session(source);
        const wantTouches = await oracleTouches.session(source);
        assert.deepEqual(gotTouches, wantTouches, `seed=${seed} ContextTouches parity mismatch`);
        coverage.incrementalPolls++;
      };

      const steps = 22;
      for (let step = 0; step < steps; step++) {
        const roll = rng();
        if (roll < 0.36) {
          const isBurst = rng() < 0.20;
          const ev = journal.append("output", {
            text: isBurst ? "O".repeat(64 * 1024) : `out-${step}\n`,
          });
          if (!faulted) signalIndex.observe(ev);
          coverage.outputs += 1;
          if (isBurst) coverage.largeOutputBursts++;
          if (!faulted && rng() < 0.65) {
            signalIndex.checkpoint(journal.seq);
            coverage.checkpoints++;
          }
        } else if (roll < 0.46) {
          const ev = journal.append("lifecycle", { status: "running", step });
          if (!faulted) signalIndex.observe(ev);
          coverage.nonSignalEvents++;
        } else if (roll < 0.78) {
          toolSeq++;
          const fileIdx = toolSeq % 6;
          const ev = journal.append(
            "signal",
            toolSeq % 3 === 0
              ? toolStartData("Bash", { command: "graphify query sym" }, `t-${toolSeq}`)
              : toolStartData(toolSeq % 2 === 0 ? "Edit" : "Read", { file_path: `src/f${fileIdx}.ts` }, `t-${toolSeq}`),
          );
          coverage.signals++;
          if (missedAppend) {
            if (opts.allowIndexAppendAfterMiss) {
              const raw = existsSync(sigFile) ? readFileSync(sigFile, "utf8") : "";
              const idx = raw ? raw.trimEnd().split("\n").length : 0;
              appendFileSync(sigFile, `${seal(key, `${id}:signal:${idx}`, ev)}\n`);
              writeSealed(stateFile, key, `${id}:signal-index-state`, { v: 1, coveredSeq: ev.seq, count: idx + 1 });
            } else {
              signalIndex.observe(ev);
            }
            coverage.appendFailThenLaterSignal++;
          } else if (!faulted) {
            const fault = rng();
            if (fault < 0.12) {
              faulted = true;
              coverage.crashAfterJournal++;
            } else if (fault < 0.24) {
              signalIndex.observe(ev);
              appendFileSync(sigFile, "{\"v\":1,\"n\":\"torn");
              faulted = true;
              coverage.tornSignalIndex++;
            } else if (fault < 0.36) {
              signalIndex.observe(ev);
              coverage.crashAfterSignalBeforeState++;
            } else if (fault < 0.50) {
              missedAppend = true;
              faulted = true;
              if (!opts.allowIndexAppendAfterMiss) signalIndex.invalidate();
            } else if (fault < 0.62 && existsSync(sigFile)) {
              signalIndex.observe(ev);
              const afterEv = journal.append("output", { text: "after-trunc-target\n" });
              signalIndex.observe(afterEv);
              signalIndex.checkpoint(journal.seq);
              const lines = readFileSync(sigFile, "utf8").split("\n").filter(Boolean);
              if (lines.length >= 2) {
                writeFileSync(sigFile, `${lines.slice(0, lines.length - 1).join("\n")}\n`);
                faulted = true;
                coverage.truncatedSignalIndex++;
              }
            } else {
              signalIndex.observe(ev);
            }
          }
        } else if (roll < 0.88) {
          journal = new Journal(eventsDir, key, id);
          signalIndex = new SignalIndex(sessionDir, key, id, journal.seq);
          if (signalIndex.isDisabled) faulted = true;
          coverage.restarts++;
        } else {
          const clean = !faulted && !signalIndex.isDisabled && signalIndex.coveredSeq === journal.seq;
          if (clean) {
            signalIndex.checkpoint(journal.seq);
            coverage.checkpoints++;
          }
          await verifyAll(clean);
        }
      }

      const finalClean = !faulted && !signalIndex.isDisabled && signalIndex.coveredSeq === journal.seq;
      if (finalClean) {
        signalIndex.checkpoint(journal.seq);
        coverage.checkpoints++;
      }
      await verifyAll(finalClean);

      rmSync(sigFile, { force: true });
      rmSync(stateFile, { force: true });
      await verifyAll(false);
      coverage.legacyNoIndex++;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return coverage;
}

test("seeded durable-state simulator verifies signal index invariants across faults and catches named broken mutants", { timeout: 60_000 }, async () => {
  const seeds = Array.from({ length: 24 }, (_, index) => 2001 + index);
  const coverage = await runDurableSignalSimulation(readSignalEvents, seeds);
  for (const [metric, count] of Object.entries(coverage)) {
    assert.ok(count > 0, `expected non-zero simulator coverage for ${metric}, got ${count}`);
  }

  await assert.rejects(
    () => runDurableSignalSimulation(readSignalEvents, seeds, { allowIndexAppendAfterMiss: true }),
    "continuing to append signals after a missed append must be caught",
  );

  const indexOnlyNoTailMutant: SignalPageReader = (sessionDir, key, sessionId, after, limit) => {
    const index = readSignalIndex(join(sessionDir, SIGNAL_INDEX_FILE), key, sessionId);
    const tip = journalTipSeq(join(sessionDir, "events"));
    const matching = index.entries.filter(entry => entry.seq > after);
    const page = matching.slice(0, limit);
    return {
      events: page,
      cursor: matching.length > page.length ? page.at(-1)!.seq : Math.max(after, tip),
      more: matching.length > page.length,
    };
  };
  await assert.rejects(
    () => runDurableSignalSimulation(indexOnlyNoTailMutant, seeds),
    "index-only mutant without journal tail scan must fail on crash/torn/legacy faults",
  );

  const trustStateCountMismatchMutant: SignalPageReader = (sessionDir, key, sessionId, after, limit, readTail) => {
    const eventsDir = join(sessionDir, "events");
    const fallback: EventPageReader =
      readTail ?? ((from, count, types) => readEvents(eventsDir, key, sessionId, from, count, types));
    const tip = journalTipSeq(eventsDir);
    if (tip === 0 || after >= tip) return { events: [], cursor: after, more: false };
    const index = readSignalIndex(join(sessionDir, SIGNAL_INDEX_FILE), key, sessionId);
    const state = readSignalIndexState(join(sessionDir, SIGNAL_INDEX_STATE_FILE), key, sessionId);
    const covered = Math.max(
      index.entries.at(-1)?.seq ?? 0,
      index.intact && state && state.coveredSeq <= tip ? state.coveredSeq : 0,
    );
    if (covered <= after) return fallback(after, limit, SIGNAL_ONLY);
    const matching = index.entries.filter(entry => entry.seq > after);
    const page = matching.slice(0, limit);
    if (matching.length > page.length) return { events: page, cursor: page.at(-1)!.seq, more: true };
    if (covered >= tip) return { events: page, cursor: tip, more: false };
    const tail = fallback(covered, limit - page.length, SIGNAL_ONLY);
    return { events: [...page, ...tail.events], cursor: tail.cursor, more: tail.more };
  };
  await assert.rejects(
    () => runDurableSignalSimulation(trustStateCountMismatchMutant, seeds),
    "trusting state coveredSeq when signals.sealed entry count mismatches must fail on truncated index",
  );

  const inclusiveAfterBoundaryMutant: SignalPageReader = (sessionDir, key, sessionId, after, limit, readTail) =>
    readSignalEvents(sessionDir, key, sessionId, Math.max(0, after - 1), limit, readTail);
  await assert.rejects(
    () => runDurableSignalSimulation(inclusiveAfterBoundaryMutant, seeds),
    "inclusive after boundary mutant must fail cursor and duplicate invariants",
  );

  const cursorOvershootMutant: SignalPageReader = (sessionDir, key, sessionId, after, limit, readTail) => {
    const page = readSignalEvents(sessionDir, key, sessionId, after, limit, readTail);
    if (page.more) {
      return { ...page, cursor: Math.max(page.cursor, journalTipSeq(join(sessionDir, "events"))) };
    }
    return page;
  };
  await assert.rejects(
    () => runDurableSignalSimulation(cursorOvershootMutant, seeds),
    "overshooting cursor to tip when more=true must fail event parity",
  );
});
