import test, { mock } from "node:test";
import assert from "node:assert/strict";
import crypto, { randomBytes, randomUUID } from "node:crypto";
import fs, {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { initialAttention } from "@infinite/attention";
import { ContextTouches, type TouchSource } from "../packages/host/src/context-touches.js";
import { Manager } from "../packages/host/src/manager.js";
import {
  journalTipSeq,
  probeJournalTip,
  readIndexedEvents,
  readSignalEvents,
  readSignalIndex,
  readSignalIndexState,
  SIGNAL_INDEX_DIR,
  SIGNAL_INDEX_STATE_FILE,
  SIGNAL_SEGMENT_SIZE,
  SignalIndex,
  type EventPage,
  type EventPageReader,
} from "../packages/host/src/signal-index.js";
import type { Config, Event, WorkerState } from "../packages/host/src/types.js";
import {
  Journal,
  MAX_EVENT_PAGE_BYTES,
  readEvents,
  seal,
  SEGMENT_SIZE,
  unseal,
  writeSealed,
} from "../packages/host/src/vault.js";
import { inProcessHost, startHost, waitFor } from "./helpers.js";

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
  return { kind: "tool-start", source: "hook", provider: "claude", tool, toolUseId: id, input, quiet: false };
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

function withIoCounters<T>(
  eventsDir: string,
  fn: (counts: { journalReads: number; decipherCalls: number; readdirCalls: number }) => T,
): T {
  const counts = { journalReads: 0, decipherCalls: 0, readdirCalls: 0 };
  const origRead = fs.readFileSync;
  const origReaddir = fs.readdirSync;
  const origDecipher = crypto.createDecipheriv;
  const readSpy = mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    const path = String(args[0]);
    if (path.startsWith(eventsDir) && path.endsWith(".journal")) counts.journalReads++;
    return origRead.apply(fs, args);
  }) as typeof fs.readFileSync);
  const readdirSpy = mock.method(fs, "readdirSync", ((...args: Parameters<typeof fs.readdirSync>) => {
    counts.readdirCalls++;
    return origReaddir.apply(fs, args);
  }) as typeof fs.readdirSync);
  const decipherSpy = mock.method(
    crypto,
    "createDecipheriv",
    ((...args: Parameters<typeof crypto.createDecipheriv>) => {
      counts.decipherCalls++;
      return origDecipher.apply(crypto, args);
    }) as typeof crypto.createDecipheriv,
  );
  syncBuiltinESMExports();
  try {
    return fn(counts);
  } finally {
    readSpy.mock.restore();
    readdirSpy.mock.restore();
    decipherSpy.mock.restore();
    syncBuiltinESMExports();
  }
}

test("large output-heavy, zero-signal, unchanged-tip, and 520-signal journals bound output reads to zero and signal decrypts to one segment", async () => {
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
    const sigFiles = readdirSync(join(sessionDir, SIGNAL_INDEX_DIR)).sort();
    assert.equal(sigFiles.length, 1);
    assert.equal(statSync(join(sessionDir, SIGNAL_INDEX_DIR)).mode & 0o777, 0o700);
    assert.equal(statSync(join(sessionDir, SIGNAL_INDEX_DIR, sigFiles[0])).mode & 0o777, 0o600);
    assert.equal(statSync(join(sessionDir, SIGNAL_INDEX_STATE_FILE)).mode & 0o777, 0o600);

    let tailCalls = 0;
    const countingTail: EventPageReader = (after, limit, types) => {
      tailCalls++;
      return readEvents(eventsDir, key, id, after, limit, types);
    };
    const indexedPage = withIoCounters(eventsDir, counts => {
      const page = readSignalEvents(sessionDir, key, id, 0, 200, countingTail);
      assert.equal(counts.journalReads, 0, "unchanged covered poll must read 0 bytes from newest output segment");
      assert.ok(counts.decipherCalls <= 6, `expected <= 6 decrypts for 3-signal read, got ${counts.decipherCalls}`);
      return page;
    });
    assert.equal(tailCalls, 0);
    assert.equal(indexedPage.more, false);
    assert.equal(indexedPage.cursor, lastSeq);
    assert.deepEqual(indexedPage.events, [sig1, sig2, sig3]);

    const fullScan = drainPages((after, limit) => readEvents(eventsDir, key, id, after, limit, SIGNAL_ONLY), 0, 200);
    assert.ok(fullScan.pages > 8, `unindexed scan must span > 8 pages on multi-MB output (saw ${fullScan.pages})`);
    assert.deepEqual(fullScan.events, indexedPage.events);
    assert.equal(fullScan.cursor, indexedPage.cursor);

    const unindexedTouches = new ContextTouches({
      read: (sessionId, after) => readEvents(join(stateDir, "sessions", sessionId, "events"), key, sessionId, after, 200, SIGNAL_ONLY),
      areas: () => undefined,
    });
    const source: TouchSource = { sessionId: id, cwd: TEST_CWD, provider: "claude", projectId: "proj-1" };
    assert.equal((await unindexedTouches.session(source)).complete, false);

    const lastSegFile = join(eventsDir, `${String(Math.floor((lastSeq - 1) / SEGMENT_SIZE)).padStart(10, "0")}.journal`);
    const lastSegSize = statSync(lastSegFile).size;
    writeFileSync(lastSegFile, "X".repeat(lastSegSize));
    poisonOutputLineInSegment(eventsDir, 0, 5);
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
    assert.equal(managerReadCalls, 1);
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
    assert.equal(existsSync(join(zeroDir, SIGNAL_INDEX_DIR)), false);
    assert.equal(existsSync(join(zeroDir, SIGNAL_INDEX_STATE_FILE)), true);
    const zeroLastSegFile = join(zeroEventsDir, `${String(Math.floor((zeroLastSeq - 1) / SEGMENT_SIZE)).padStart(10, "0")}.journal`);
    writeFileSync(zeroLastSegFile, "Z".repeat(statSync(zeroLastSegFile).size));
    poisonOutputLineInSegment(zeroEventsDir, 0, 1);

    let zeroTailCalls = 0;
    const zeroPage = withIoCounters(zeroEventsDir, counts => {
      const page = readSignalEvents(zeroDir, key, zeroId, 0, 200, (after, limit, types) => {
        zeroTailCalls++;
        return readEvents(zeroEventsDir, key, zeroId, after, limit, types);
      });
      assert.equal(counts.journalReads, 0, "zero-signal covered poll must read 0 output segment bytes");
      assert.equal(counts.decipherCalls, 1, "zero-signal covered poll decrypts only signals-state.sealed");
      return page;
    });
    assert.equal(zeroTailCalls, 0);
    assert.deepEqual(zeroPage, { events: [], cursor: zeroLastSeq, more: false });

    const heavyId = randomUUID();
    const heavyDir = writeSessionMeta(stateDir, key, heavyId);
    const heavyEventsDir = join(heavyDir, "events");
    const heavyIndex = new SignalIndex(heavyDir, key, heavyId, 0);
    const heavyItems: { type: Event["type"]; data: Event["data"] }[] = [];
    for (let i = 0; i < 520; i++) {
      heavyItems.push({ type: "output", data: { text: `out-${i}\n` } });
      heavyItems.push({ type: "signal", data: toolStartData("Read", { file_path: `src/f${i}.ts` }, `h-${i}`) });
    }
    heavyItems.push({ type: "output", data: { text: "after-520\n" } });
    const heavyCreated = appendBulkJournalEvents(heavyEventsDir, heavyIndex, key, heavyId, heavyItems);
    const heavySignals = heavyCreated.filter(e => e.type === "signal");
    const heavyLastSeq = heavyCreated.at(-1)!.seq;
    const heavySegNames = readdirSync(join(heavyDir, SIGNAL_INDEX_DIR)).sort();
    assert.equal(heavySegNames.length, Math.ceil(520 / SIGNAL_SEGMENT_SIZE));

    for (let s = 0; s < heavySegNames.length - 1; s++) {
      const segPath = join(heavyDir, SIGNAL_INDEX_DIR, heavySegNames[s]);
      const segLines = readFileSync(segPath, "utf8").split("\n");
      segLines[0] = JSON.stringify({ v: 1, n: "AAAAAAAAAAAAAAAA", c: "AAAA", t: "AAAAAAAAAAAAAAAAAAAAAA==" });
      writeFileSync(segPath, segLines.join("\n"));
    }
    const nearTipAfter = heavySignals[518].seq;
    let heavyTailCalls = 0;
    const nearTipPage = withIoCounters(heavyEventsDir, counts => {
      const page = readSignalEvents(heavyDir, key, heavyId, nearTipAfter, 1, (after, limit, types) => {
        heavyTailCalls++;
        return readEvents(heavyEventsDir, key, heavyId, after, limit, types);
      });
      assert.equal(counts.journalReads, 0);
      assert.ok(
        counts.decipherCalls <= SIGNAL_SEGMENT_SIZE,
        `near-tip limit=1 poll over 520 signals must decrypt <= ${SIGNAL_SEGMENT_SIZE} entries (got ${counts.decipherCalls})`,
      );
      return page;
    });
    assert.equal(heavyTailCalls, 0);
    assert.deepEqual(nearTipPage, { events: [heavySignals[519]], cursor: heavyLastSeq, more: false });

    const boundaryAfter = heavySignals[SIGNAL_SEGMENT_SIZE * (heavySegNames.length - 1) - 1].seq;
    const boundaryPage = withIoCounters(heavyEventsDir, counts => {
      const page = readSignalEvents(heavyDir, key, heavyId, boundaryAfter, 1, (after, limit, types) => {
        heavyTailCalls++;
        return readEvents(heavyEventsDir, key, heavyId, after, limit, types);
      });
      assert.equal(counts.journalReads, 0);
      assert.ok(counts.decipherCalls <= 6, `segment-boundary skip should decrypt <= 6 entries (got ${counts.decipherCalls})`);
      return page;
    });
    assert.equal(heavyTailCalls, 0);
    assert.deepEqual(boundaryPage.events, [heavySignals[SIGNAL_SEGMENT_SIZE * (heavySegNames.length - 1)]]);
    assert.equal(boundaryPage.more, true);

    const idlePage = withIoCounters(heavyEventsDir, counts => {
      const page = readSignalEvents(heavyDir, key, heavyId, heavySignals[519].seq, 1, (after, limit, types) => {
        heavyTailCalls++;
        return readEvents(heavyEventsDir, key, heavyId, after, limit, types);
      });
      assert.equal(counts.journalReads, 0);
      assert.ok(counts.decipherCalls <= 2, `idle near-tip poll should decrypt <= 2 entries (got ${counts.decipherCalls})`);
      return page;
    });
    assert.equal(heavyTailCalls, 0);
    assert.deepEqual(idlePage, { events: [], cursor: heavyLastSeq, more: false });

    const caughtUpHeavy = withIoCounters(heavyEventsDir, counts => {
      const page = readSignalEvents(heavyDir, key, heavyId, heavyLastSeq, 200, (after, limit, types) => {
        heavyTailCalls++;
        return readEvents(heavyEventsDir, key, heavyId, after, limit, types);
      });
      assert.equal(counts.readdirCalls, 0, "caught-up idle poll must not call readdirSync on events/ or signals/");
      assert.equal(counts.journalReads, 0);
      assert.equal(counts.decipherCalls, 1);
      return page;
    });
    assert.equal(heavyTailCalls, 0);
    assert.deepEqual(caughtUpHeavy, { events: [], cursor: heavyLastSeq, more: false });

    const caughtUpOutput = withIoCounters(eventsDir, counts => {
      const page = readSignalEvents(sessionDir, key, id, lastSeq, 200, countingTail);
      assert.equal(counts.readdirCalls, 0, "caught-up idle poll on multi-MB output session must make 0 readdirSync calls");
      assert.equal(counts.journalReads, 0);
      assert.equal(counts.decipherCalls, 1);
      return page;
    });
    assert.equal(tailCalls, 0);
    assert.deepEqual(caughtUpOutput, { events: [], cursor: lastSeq, more: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pagination parity, strict MAX_EVENT_PAGE_BYTES across index-tail boundary, and HTTP /events?types=signal for regular and cmux sessions", { timeout: 30_000 }, async () => {
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
      onAppend: (event, meta) => {
        signalIndex?.observe(event, meta);
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

    for (const limit of [1, 2, 3, 200]) {
      for (const after of [0, s1.seq - 1, s1.seq, s2.seq, s3.seq, journal.seq, journal.seq + 50]) {
        const expected = drainPages((from, count) => readEvents(eventsDir, key, id, from, count, SIGNAL_ONLY), after, limit);
        const actual = drainPages((from, count) => manager.events(id, from, count, SIGNAL_ONLY), after, limit);
        assert.deepEqual(actual.events, expected.events, `events mismatch for after=${after} limit=${limit}`);
        assert.equal(actual.cursor, expected.cursor, `cursor mismatch for after=${after} limit=${limit}`);
      }
    }

    assert.deepEqual(manager.events(id, -5, 10, SIGNAL_ONLY), readEvents(eventsDir, key, id, -5, 10, SIGNAL_ONLY));
    assert.deepEqual(manager.events(id, 0, 0, SIGNAL_ONLY), { events: [], cursor: 0, more: true });
    assert.throws(() => readIndexedEvents(sessionDir, randomBytes(32), id, 0, 200, SIGNAL_ONLY));
    assert.throws(() => readIndexedEvents(sessionDir, key, "other-session", 0, 200, SIGNAL_ONLY));

    const budgetId = randomUUID();
    const budgetDir = writeSessionMeta(stateDir, key, budgetId);
    const budgetEventsDir = join(budgetDir, "events");
    let budgetIndex: SignalIndex | undefined;
    const budgetJournal = new Journal(budgetEventsDir, key, budgetId, {
      onAppend: (event, meta) => {
        budgetIndex?.observe(event, meta);
      },
    });
    budgetIndex = new SignalIndex(budgetDir, key, budgetId, budgetJournal.seq);
    const chunk200k = "B".repeat(160 * 1024);
    const b1 = budgetJournal.append("signal", toolStartData("Write", { file_path: "src/b1.ts", blob: chunk200k }, "b1"));
    const b2 = budgetJournal.append("signal", toolStartData("Write", { file_path: "src/b2.ts", blob: chunk200k }, "b2"));
    budgetIndex.checkpoint(budgetJournal.seq);
    budgetIndex.invalidate();
    const b3 = budgetJournal.append("signal", toolStartData("Write", { file_path: "src/b3.ts", blob: chunk200k }, "b3"));
    const b4 = budgetJournal.append("signal", toolStartData("Write", { file_path: "src/b4.ts", blob: chunk200k }, "b4"));

    const collected: Event[] = [];
    let cursor = 0;
    let pageCount = 0;
    for (;;) {
      const page = manager.events(budgetId, cursor, 200, SIGNAL_ONLY);
      pageCount++;
      const pageSealedBytes = page.events.reduce(
        (sum, ev) => sum + seal(key, `${budgetId}:${ev.seq}`, ev).length,
        0,
      );
      if (page.events.length > 1) {
        assert.ok(
          pageSealedBytes <= MAX_EVENT_PAGE_BYTES,
          `page ${pageCount} exceeded MAX_EVENT_PAGE_BYTES (${pageSealedBytes} > ${MAX_EVENT_PAGE_BYTES})`,
        );
      }
      collected.push(...page.events);
      cursor = page.cursor;
      if (!page.more) break;
    }
    assert.ok(pageCount >= 2, "indexed + unindexed large signals must split across pages");
    assert.deepEqual(collected.map(e => e.seq), [b1.seq, b2.seq, b3.seq, b4.seq]);

    const tailCapId = randomUUID();
    const tailCapDir = writeSessionMeta(stateDir, key, tailCapId);
    const tailCapEvents = join(tailCapDir, "events");
    const tailCapJournal = new Journal(tailCapEvents, key, tailCapId);
    const blob300k = "U".repeat(300 * 1024);
    const u1 = tailCapJournal.append("signal", toolStartData("Write", { file_path: "src/u1.ts", blob: blob300k }, "u1"));
    const u2 = tailCapJournal.append("signal", toolStartData("Write", { file_path: "src/u2.ts", blob: blob300k }, "u2"));
    assert.equal(readEvents(tailCapEvents, key, tailCapId, 0, 200, SIGNAL_ONLY).events.length, 2);
    const capPage1 = readSignalEvents(tailCapDir, key, tailCapId, 0, 200);
    assert.deepEqual(capPage1, { events: [u1], cursor: u1.seq, more: true });
    const capPage2 = readSignalEvents(tailCapDir, key, tailCapId, capPage1.cursor, 200);
    assert.deepEqual(capPage2, { events: [u2], cursor: u2.seq, more: false });

    const cmuxCli = join(root, "cmux-stub.mjs");
    writeFileSync(
      cmuxCli,
      `#!${process.execPath}\nconst m=process.argv[3];if(m==='system.tree')console.log('{"windows":[]}');else if(m==='vault.sessions')console.log('{"sessions":[]}');else console.log('{"items":[]}');\n`,
    );
    chmodSync(cmuxCli, 0o700);
    const hooksDir = join(root, "cmux-hooks");
    mkdirSync(hooksDir, { recursive: true });
    let regId = "";
    let regSig!: Event;
    let regLastSeq = 0;
    let cmuxId = "";
    let cmuxSig!: Event;
    let cmuxLastSeq = 0;
    const host = await inProcessHost({
      configure: cfg => {
        cfg.cmux = { enabled: true, command: cmuxCli, hooksDir };
        const hostKey = readFileSync(cfg.keyFile);

        regId = randomUUID();
        const regDir = writeSessionMeta(cfg.stateDir, hostKey, regId);
        const regEvents = join(regDir, "events");
        const regIndex = new SignalIndex(regDir, hostKey, regId, 0);
        const regItems: { type: Event["type"]; data: Event["data"] }[] = [];
        for (let i = 0; i < 600; i++) regItems.push({ type: "output", data: { text: `r-${i}-${"Q".repeat(2048)}\n` } });
        regItems.push({ type: "signal", data: toolStartData("Read", { file_path: "src/http-reg.ts" }, "hr1") });
        for (let i = 0; i < 600; i++) regItems.push({ type: "output", data: { text: `r2-${i}-${"Q".repeat(2048)}\n` } });
        const regCreated = appendBulkJournalEvents(regEvents, regIndex, hostKey, regId, regItems);
        regSig = regCreated.find(e => e.type === "signal")!;
        regLastSeq = regCreated.at(-1)!.seq;
        poisonOutputLineInSegment(regEvents, 0, 3);
        assert.throws(() => readEvents(regEvents, hostKey, regId, 0, 200, SIGNAL_ONLY));

        cmuxId = randomUUID();
        const cmuxDir = join(cfg.stateDir, "cmux", cmuxId);
        const cmuxEvents = join(cmuxDir, "events");
        mkdirSync(cmuxDir, { recursive: true });
        const now = "2026-11-26T00:00:00.000Z";
        writeSealed(join(cmuxDir, "meta.sealed"), hostKey, `cmux:${cmuxId}:meta`, {
          session: {
            id: cmuxId,
            provider: "claude",
            title: "Cmux indexed signals",
            projectId: "rehearsal",
            projectRoot: cfg.projects[0].path,
            cwd: cfg.projects[0].path,
            createdAt: now,
            status: "exited",
            contextVersion: 0,
            context: "",
            initialPrompt: "",
            backend: "cmux",
            runtime: { id: randomUUID(), location: "local", transport: "cmux" },
          },
          screen: "",
          attention: initialAttention(now, false),
          receipts: {},
        });
        const cmuxIndex = new SignalIndex(cmuxDir, hostKey, cmuxId, 0);
        const cmuxItems: { type: Event["type"]; data: Event["data"] }[] = [];
        for (let i = 0; i < 600; i++) cmuxItems.push({ type: "output", data: { text: `c-${i}-${"W".repeat(2048)}\n` } });
        cmuxItems.push({ type: "signal", data: { kind: "prompt-open", source: "host", provider: "claude" } });
        for (let i = 0; i < 600; i++) cmuxItems.push({ type: "output", data: { text: `c2-${i}-${"W".repeat(2048)}\n` } });
        const cmuxCreated = appendBulkJournalEvents(cmuxEvents, cmuxIndex, hostKey, cmuxId, cmuxItems);
        cmuxSig = cmuxCreated.find(e => e.type === "signal")!;
        cmuxLastSeq = cmuxCreated.at(-1)!.seq;
        poisonOutputLineInSegment(cmuxEvents, 0, 2);
        assert.throws(() => readEvents(cmuxEvents, hostKey, cmuxId, 0, 200, SIGNAL_ONLY));
      },
    });
    try {
      const regRes = await host.fetchApi(`/sessions/${regId}/events?types=signal`, "viewer");
      assert.equal(regRes.status, 200);
      assert.deepEqual(regRes.body, { events: [regSig], cursor: regLastSeq, more: false });

      const cmuxRes = await host.fetchApi(`/sessions/${cmuxId}/events?types=signal`, "viewer");
      assert.equal(cmuxRes.status, 200);
      assert.deepEqual(cmuxRes.body, { events: [cmuxSig], cursor: cmuxLastSeq, more: false });
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy zero-probe fallback, tip-read error fallback, torn segment, crash gap, append failure, and rollback purge", () => {
  const root = mkdtempSync("/tmp/inf-sigidx-faults-");
  const key = randomBytes(32);
  try {
    const legacyId = randomUUID();
    const legacyDir = join(root, legacyId);
    const legacyEvents = join(legacyDir, "events");
    const legacyJournal = new Journal(legacyEvents, key, legacyId);
    legacyJournal.append("output", { text: "old-1\n" });
    const legacySig = legacyJournal.append("signal", toolStartData("Read", { file_path: "src/legacy.ts" }, "l1"));
    legacyJournal.append("output", { text: "old-2\n" });
    const legacyPage = withIoCounters(legacyEvents, counts => {
      const page = readSignalEvents(legacyDir, key, legacyId, 0, 200);
      assert.equal(counts.journalReads, 1, "legacy fallback must not pre-read journal tip before readEvents");
      return page;
    });
    assert.deepEqual(legacyPage, { events: [legacySig], cursor: legacyJournal.seq, more: false });
    assert.equal(new SignalIndex(legacyDir, key, legacyId, legacyJournal.seq).isDisabled, true);

    const errId = randomUUID();
    const errDir = join(root, errId);
    const errEvents = join(errDir, "events");
    const errIndex = new SignalIndex(errDir, key, errId, 0);
    const errItems: { type: Event["type"]; data: Event["data"] }[] = [];
    for (let i = 0; i < 9; i++) errItems.push({ type: "output", data: { text: `e-${i}\n` } });
    errItems.push({ type: "signal", data: toolStartData("Read", { file_path: "src/prefix.ts" }, "e1") });
    for (let i = 10; i < SEGMENT_SIZE; i++) errItems.push({ type: "output", data: { text: `e-${i}\n` } });
    errItems.push({ type: "output", data: { text: "seg-1-line-0\n" } });
    const errCreated = appendBulkJournalEvents(errEvents, errIndex, key, errId, errItems);
    const errSig = errCreated.find(e => e.type === "signal")!;
    const seg1Path = join(errEvents, "0000000001.journal");
    rmSync(seg1Path, { force: true });
    mkdirSync(seg1Path);
    assert.equal(probeJournalTip(errEvents).kind, "error");
    const prefixPage = readSignalEvents(errDir, key, errId, 0, 1);
    assert.deepEqual(prefixPage, { events: [errSig], cursor: errSig.seq, more: true });
    assert.throws(() => readSignalEvents(errDir, key, errId, 0, 200));

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
    assert.deepEqual(tailStarts, [coveredBeforeCrash]);

    const reopenedAfterCrash = new SignalIndex(crashDir, key, crashId, crashJournal.seq);
    assert.equal(reopenedAfterCrash.isDisabled, true);
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
      onAppend: (event, meta) => {
        tornIndex?.observe(event, meta);
      },
    });
    tornIndex = new SignalIndex(tornDir, key, tornId, tornJournal.seq);
    const t1 = tornJournal.append("signal", toolStartData("Read", { file_path: "src/t1.ts" }, "t1"));
    for (let i = 0; i < 10; i++) tornJournal.append("output", { text: `o-${i}\n` });
    tornIndex.checkpoint(tornJournal.seq);
    const t2 = tornJournal.append("signal", toolStartData("Edit", { file_path: "src/t2.ts" }, "t2"));
    const tornSeg = readdirSync(join(tornDir, SIGNAL_INDEX_DIR)).sort().at(-1)!;
    appendFileSync(join(tornDir, SIGNAL_INDEX_DIR, tornSeg), "{\"v\":1,\"n\":\"torn");
    const parsedTorn = readSignalIndex(join(tornDir, SIGNAL_INDEX_DIR), key, tornId);
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
    assert.deepEqual(tornTailStarts, [t2.seq]);

    const failId = randomUUID();
    const failDir = join(root, failId);
    const failEventsDir = join(failDir, "events");
    mkdirSync(failDir, { recursive: true });
    writeFileSync(join(failDir, SIGNAL_INDEX_DIR), "not-a-directory");
    let failIndex: SignalIndex | undefined;
    const failJournal = new Journal(failEventsDir, key, failId, {
      onAppend: (event, meta) => {
        failIndex?.observe(event, meta);
      },
    });
    failIndex = new SignalIndex(failDir, key, failId, failJournal.seq);
    assert.equal(failIndex.isDisabled, true);
    const f1 = failJournal.append("signal", toolStartData("Read", { file_path: "src/f1.ts" }, "f1"));
    assert.deepEqual(readSignalEvents(failDir, key, failId, 0, 200).events, [f1]);

    const rollbackId = randomUUID();
    const rollbackDir = join(root, rollbackId);
    const rollbackEvents = join(rollbackDir, "events");
    const rollbackIndex = new SignalIndex(rollbackDir, key, rollbackId, 0);
    const rbItems: { type: Event["type"]; data: Event["data"] }[] = [];
    rbItems.push({ type: "signal", data: toolStartData("Read", { file_path: "src/kept.ts" }, "rb-kept") });
    for (let i = 0; i < SEGMENT_SIZE - 1; i++) rbItems.push({ type: "output", data: { text: `rb-${i}\n` } });
    rbItems.push({ type: "output", data: { text: "lost-257\n" } });
    rbItems.push({ type: "signal", data: toolStartData("Edit", { file_path: "src/ghost.ts" }, "rb-ghost") });
    rbItems.push({ type: "output", data: { text: "lost-259\n" } });
    rbItems.push({ type: "output", data: { text: "lost-260\n" } });
    const rbCreated = appendBulkJournalEvents(rollbackEvents, rollbackIndex, key, rollbackId, rbItems);
    const keptSig = rbCreated[0];
    rmSync(join(rollbackEvents, "0000000001.journal"), { force: true });

    let reopenedRbIndex: SignalIndex | undefined;
    const reopenedRbJournal = new Journal(rollbackEvents, key, rollbackId, {
      onAppend: (event, meta) => {
        reopenedRbIndex?.observe(event, meta);
      },
    });
    assert.equal(reopenedRbJournal.seq, SEGMENT_SIZE);
    reopenedRbIndex = new SignalIndex(rollbackDir, key, rollbackId, reopenedRbJournal.seq);
    assert.equal(reopenedRbIndex.isDisabled, true);
    assert.equal(existsSync(join(rollbackDir, SIGNAL_INDEX_DIR)), false, "stale signals/ must be purged on rollback reopen");
    assert.equal(existsSync(join(rollbackDir, SIGNAL_INDEX_STATE_FILE)), false, "stale signals-state.sealed must be purged on rollback reopen");

    for (let i = 0; i < 5; i++) reopenedRbJournal.append("output", { text: `regrown-${i}\n` });
    const freshSig = reopenedRbJournal.append("signal", toolStartData("Read", { file_path: "src/fresh.ts" }, "rb-fresh"));
    for (let i = 0; i < 5; i++) reopenedRbJournal.append("output", { text: `regrown-after-${i}\n` });
    assert.ok(reopenedRbJournal.seq > rbCreated.at(-1)!.seq);
    const regrownPage = drainPages((after, limit) => readSignalEvents(rollbackDir, key, rollbackId, after, limit), 0, 200);
    assert.deepEqual(regrownPage.events, [keptSig, freshSig]);
    assert.equal(regrownPage.cursor, reopenedRbJournal.seq);

    const gapId = randomUUID();
    const gapDir = join(root, gapId);
    const gapEvents = join(gapDir, "events");
    const gapIndex = new SignalIndex(gapDir, key, gapId, 0);
    const gapItems: { type: Event["type"]; data: Event["data"] }[] = [];
    for (let i = 0; i < SEGMENT_SIZE; i++) gapItems.push({ type: "output", data: { text: `g-${i}\n` } });
    gapItems.push({ type: "signal", data: toolStartData("Read", { file_path: "src/seg1.ts" }, "gap-257") });
    const gapCreated = appendBulkJournalEvents(gapEvents, gapIndex, key, gapId, gapItems);
    const gapSig = gapCreated.at(-1)!;
    assert.equal(gapSig.seq, SEGMENT_SIZE + 1);
    rmSync(join(gapEvents, "0000000000.journal"), { force: true });
    assert.equal(probeJournalTip(gapEvents).kind, "error");
    assert.deepEqual(readSignalEvents(gapDir, key, gapId, SEGMENT_SIZE, 200), {
      events: [gapSig],
      cursor: gapSig.seq,
      more: false,
    });

    const stickyId = randomUUID();
    const stickyDir = join(root, stickyId);
    const stickyEvents = join(stickyDir, "events");
    const stickyIndex = new SignalIndex(stickyDir, key, stickyId, 0);
    const stickyCreated = appendBulkJournalEvents(stickyEvents, stickyIndex, key, stickyId, rbItems);
    const stickyKept = stickyCreated[0];
    rmSync(join(stickyEvents, "0000000001.journal"), { force: true });
    const origRm = fs.rmSync;
    const origOpen = fs.openSync;
    const rmFail = mock.method(fs, "rmSync", ((...args: Parameters<typeof fs.rmSync>) => {
      if (String(args[0]).includes(SIGNAL_INDEX_DIR)) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      return origRm.apply(fs, args);
    }) as typeof fs.rmSync);
    syncBuiltinESMExports();
    let reopenedStickyJournal!: Journal;
    let reopenedStickyIndex!: SignalIndex;
    try {
      reopenedStickyJournal = new Journal(stickyEvents, key, stickyId);
      reopenedStickyIndex = new SignalIndex(stickyDir, key, stickyId, reopenedStickyJournal.seq);
    } finally {
      rmFail.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(reopenedStickyIndex.isDisabled, true);
    assert.equal(existsSync(join(stickyDir, SIGNAL_INDEX_DIR)), true);
    assert.deepEqual(readSignalIndexState(join(stickyDir, SIGNAL_INDEX_STATE_FILE), key, stickyId), { disabled: true });
    for (let i = 0; i < 5; i++) reopenedStickyJournal.append("output", { text: `sticky-${i}\n` });
    const stickyFresh = reopenedStickyJournal.append("signal", toolStartData("Read", { file_path: "src/sticky.ts" }, "sf"));
    for (let i = 0; i < 5; i++) reopenedStickyJournal.append("output", { text: `sticky-after-${i}\n` });
    assert.ok(reopenedStickyJournal.seq > stickyCreated.at(-1)!.seq);
    const stickyPage = drainPages((after, limit) => readSignalEvents(stickyDir, key, stickyId, after, limit), 0, 200);
    assert.deepEqual(stickyPage.events, [stickyKept, stickyFresh]);
    assert.equal(stickyPage.cursor, reopenedStickyJournal.seq);
    assert.equal(new SignalIndex(stickyDir, key, stickyId, reopenedStickyJournal.seq).isDisabled, true);

    const hardId = randomUUID();
    const hardDir = join(root, hardId);
    const hardEvents = join(hardDir, "events");
    const hardIndex = new SignalIndex(hardDir, key, hardId, 0);
    appendBulkJournalEvents(hardEvents, hardIndex, key, hardId, rbItems);
    rmSync(join(hardEvents, "0000000001.journal"), { force: true });
    const hardJournal = new Journal(hardEvents, key, hardId);
    const hardRmFail = mock.method(fs, "rmSync", ((...args: Parameters<typeof fs.rmSync>) => {
      if (String(args[0]).includes(SIGNAL_INDEX_DIR)) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      return origRm.apply(fs, args);
    }) as typeof fs.rmSync);
    const hardOpenFail = mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).includes(SIGNAL_INDEX_STATE_FILE)) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return origOpen.apply(fs, args);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => new SignalIndex(hardDir, key, hardId, hardJournal.seq), /Failed to invalidate stale signal index sidecars/);
    } finally {
      hardRmFail.mock.restore();
      hardOpenFail.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real worker writes segmented signals and state, survives poisoned output on /context and /events?types=signal, and deletes cleanly", { timeout: 60_000 }, async () => {
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
    const hostKey = readFileSync(host.config.keyFile);
    const sessionDir = join(host.config.stateDir, "sessions", sessionId);
    await waitFor(
      async () => ((await host.fetchApi(`/sessions/${sessionId}`)).body as { status?: string }).status,
      status => status === "exited",
      30_000,
    );
    await waitFor(
      async () => {
        const saved = unseal<WorkerState>(hostKey, `${sessionId}:status`, readFileSync(join(sessionDir, "status.sealed"), "utf8"));
        if (!saved.workerPid) return false;
        try {
          process.kill(saved.workerPid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      },
      gone => gone === true,
      15_000,
    );

    const sigDir = join(sessionDir, SIGNAL_INDEX_DIR);
    const stateFile = join(sessionDir, SIGNAL_INDEX_STATE_FILE);
    assert.equal(existsSync(sigDir), true);
    assert.equal(existsSync(stateFile), true);
    assert.equal(statSync(sigDir).mode & 0o777, 0o700);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);

    const indexed = readSignalIndex(sigDir, hostKey, sessionId);
    assert.equal(indexed.intact, true);
    assert.ok(indexed.entries.length >= 3);
    const state = readSignalIndexState(stateFile, hostKey, sessionId);
    assert.ok(state && !state.disabled);
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

    const httpSignals = await host.fetchApi(`/sessions/${sessionId}/events?types=signal`, "viewer");
    assert.equal(httpSignals.status, 200);
    assert.equal((httpSignals.body as { events: Event[] }).events.length, indexed.entries.length);

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

    const removed = await host.fetchApi(`/sessions/${sessionId}`, "owner", undefined, {}, "DELETE");
    assert.equal(removed.status, 200);
    assert.equal(existsSync(sessionDir), false);
    assert.equal(existsSync(sigDir), false);
    assert.equal(existsSync(stateFile), false);
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an automatic checkpoint inside one appendAll batch records that event's own journal size", () => {
  const root = mkdtempSync("/tmp/inf-sigidx-batch-");
  const key = randomBytes(32);
  try {
    let index: SignalIndex | undefined;
    const events = join(root, "events");
    const journal = new Journal(events, key, "s1", { onAppend: (event, meta) => index?.observe(event, meta) });
    index = new SignalIndex(root, key, "s1", 0);
    for (let i = 0; i < 99; i++) journal.append("output", { text: "x" });
    journal.append("signal", { kind: "s" } as never);
    for (let i = 0; i < 255; i++) journal.append("output", { text: "x" });
    journal.appendAll("output", Array.from({ length: 10 }, () => ({ text: "y" })));
    assert.equal(journal.seq, 365);
    const state = readSignalIndexState(join(root, SIGNAL_INDEX_STATE_FILE), key, "s1");
    assert.ok(state && !("disabled" in state));
    const tip = probeJournalTip(events, state as never);
    assert.equal(tip.kind === "error" ? -1 : tip.seq, 365);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
