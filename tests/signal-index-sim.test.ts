import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ContextTouches, type TouchSource } from "../packages/host/src/context-touches.js";
import {
  journalTipSeq,
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
import type { Event } from "../packages/host/src/types.js";
import { Journal, readEvents, seal, writeSealed } from "../packages/host/src/vault.js";

const SIGNAL_ONLY = new Set(["signal"]);
const TEST_CWD = "/home/dev/projects/example";

function toolStartData(tool: string, input: Record<string, unknown>, id: string): Record<string, unknown> {
  return { kind: "tool-start", source: "hook", provider: "claude", tool, toolUseId: id, input, quiet: false };
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
    perStepVerifications: 0,
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
    const sigDir = join(sessionDir, SIGNAL_INDEX_DIR);
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

      const verifyParity = async (fullMatrix = false, expectZeroTail = false) => {
        const tip = journalTipSeq(eventsDir);
        const checks: [number, number][] = fullMatrix
          ? [
              [0, 1],
              [0, 2],
              [0, 200],
              [Math.floor(tip / 2), 2],
              [Math.max(0, tip - 1), 5],
              [tip, 200],
            ]
          : [
              [0, 200],
              [Math.floor(tip / 2), 2],
            ];
        for (const [after, limit] of checks) {
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
        coverage.perStepVerifications++;
        if (fullMatrix) {
          const gotTouches = await simTouches.session(source);
          const wantTouches = await oracleTouches.session(source);
          assert.deepEqual(gotTouches, wantTouches, `seed=${seed} ContextTouches parity mismatch`);
          coverage.incrementalPolls++;
        }
      };

      const steps = 18;
      for (let step = 0; step < steps; step++) {
        const roll = rng();
        if (roll < 0.32) {
          const isBurst = rng() < 0.20;
          const ev = journal.append("output", { text: isBurst ? "O".repeat(12 * 1024) : `out-${step}\n` });
          if (!faulted) signalIndex.observe(ev);
          coverage.outputs++;
          if (isBurst) coverage.largeOutputBursts++;
          await verifyParity(false, false);
          if (!faulted && rng() < 0.60) {
            signalIndex.checkpoint(journal.seq);
            coverage.checkpoints++;
            await verifyParity(false, true);
          }
        } else if (roll < 0.40) {
          const ev = journal.append("lifecycle", { status: "running", step });
          if (!faulted) signalIndex.observe(ev);
          coverage.nonSignalEvents++;
          await verifyParity(false, false);
        } else if (roll < 0.84) {
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
              const existing = readSignalIndex(sigDir, key, id);
              const segIdx = existing.segments.length ? existing.segments.at(-1)!.index : 0;
              const startSeq = existing.segments.length ? existing.segments.at(-1)!.startSeq : ev.seq;
              const lineIdx = existing.entries.length % SIGNAL_SEGMENT_SIZE;
              const name = `${String(segIdx).padStart(10, "0")}-${String(startSeq).padStart(12, "0")}.sealed`;
              mkdirSync(sigDir, { recursive: true, mode: 0o700 });
              appendFileSync(
                join(sigDir, name),
                `${seal(key, `${id}:signal:${segIdx}:${startSeq}:${lineIdx}`, ev)}\n`,
              );
              writeSealed(stateFile, key, `${id}:signal-index-state`, {
                v: 1,
                coveredSeq: ev.seq,
                count: existing.entries.length + 1,
                segmentCount: segIdx + 1,
                lastSegment: name,
                lastSegmentLines: lineIdx + 1,
                lastSignalSeq: ev.seq,
              });
            } else {
              signalIndex.observe(ev);
            }
            coverage.appendFailThenLaterSignal++;
          } else if (!faulted) {
            const fault = rng();
            if (fault < 0.10) {
              faulted = true;
              coverage.crashAfterJournal++;
            } else if (fault < 0.20) {
              signalIndex.observe(ev);
              const lastSegName = readdirSync(sigDir).sort().at(-1)!;
              appendFileSync(join(sigDir, lastSegName), "{\"v\":1,\"n\":\"torn");
              faulted = true;
              coverage.tornSignalIndex++;
            } else if (fault < 0.36) {
              signalIndex.observe(ev);
              await verifyParity(false, true);
              journal = new Journal(eventsDir, key, id);
              signalIndex = new SignalIndex(sessionDir, key, id, journal.seq);
              assert.equal(signalIndex.isDisabled, false, "clean signal-at-tip crash without checkpoint must recover enabled");
              coverage.crashAfterSignalBeforeState++;
            } else if (fault < 0.48) {
              missedAppend = true;
              faulted = true;
              if (!opts.allowIndexAppendAfterMiss) signalIndex.invalidate();
            } else if (fault < 0.62 && existsSync(sigDir)) {
              signalIndex.observe(ev);
              const afterEv = journal.append("output", { text: "after-trunc-target\n" });
              signalIndex.observe(afterEv);
              signalIndex.checkpoint(journal.seq);
              const lastSegName = readdirSync(sigDir).sort().at(-1)!;
              const segPath = join(sigDir, lastSegName);
              const lines = readFileSync(segPath, "utf8").split("\n").filter(Boolean);
              if (lines.length >= 2) {
                writeFileSync(segPath, `${lines.slice(0, lines.length - 1).join("\n")}\n`);
                faulted = true;
                coverage.truncatedSignalIndex++;
              }
            } else {
              signalIndex.observe(ev);
            }
          }
          await verifyParity(false, false);
        } else {
          await verifyParity(true, false);
          if (!faulted && rng() < 0.5) {
            signalIndex.checkpoint(journal.seq);
            coverage.checkpoints++;
          }
          journal = new Journal(eventsDir, key, id);
          signalIndex = new SignalIndex(sessionDir, key, id, journal.seq);
          if (signalIndex.isDisabled) faulted = true;
          coverage.restarts++;
          await verifyParity(false, false);
        }
      }

      await verifyParity(true, false);
      if (!faulted && !signalIndex.isDisabled && signalIndex.coveredSeq === journal.seq) {
        signalIndex.checkpoint(journal.seq);
        coverage.checkpoints++;
        await verifyParity(true, true);
      }

      rmSync(sigDir, { recursive: true, force: true });
      rmSync(stateFile, { force: true });
      await verifyParity(true, false);
      coverage.legacyNoIndex++;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return coverage;
}

test("seeded durable-state simulator verifies per-step invariants across faults and catches named broken mutants", { timeout: 90_000 }, async () => {
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
    const index = readSignalIndex(join(sessionDir, SIGNAL_INDEX_DIR), key, sessionId);
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
    const index = readSignalIndex(join(sessionDir, SIGNAL_INDEX_DIR), key, sessionId);
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
    "trusting state coveredSeq when signals entry count mismatches must fail on truncated index",
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
