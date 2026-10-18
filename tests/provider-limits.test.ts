import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderLimits, switchesMember, type LimitRow, type LimitSessions } from "../packages/host/src/provider-limits.js";

const at = (hhmm: string, day = 18) => `2026-10-${day}T${hhmm}:00.000Z`;
function store() {
  const dir = mkdtempSync(join(tmpdir(), "inf-limits-"));
  const file = join(dir, "provider-limits.sealed"), key = randomBytes(32);
  return { file, key, open: () => new ProviderLimits(file, key), close: () => rmSync(dir, { recursive: true, force: true }) };
}
/** A manager stand-in: journals of signal events read with a cursor. */
function sessions(journals: Record<string, { at: string; data: Record<string, unknown> }[]>, pageSize = Infinity): LimitSessions {
  return {
    events: (id, after, limit) => {
      const all = (journals[id] ?? []).map((event, index) => ({ ...event, seq: index + 1 }));
      // A manager page also ends early at its byte cap, so a page can hold fewer events than asked.
      const events = all.filter(event => event.seq > after).slice(0, Math.min(limit, pageSize));
      return { events, cursor: events.at(-1)?.seq ?? after, more: all.length > after + events.length };
    },
  };
}
const claudeLimit = { kind: "provider-limit", limit: "usage", confidence: "corroborated", message: "You've hit your session limit", source: "screen", provider: "claude" };
/** A Claude `Stop` hook, as the worker journals it. */
const claudeStop = { kind: "turn-end", source: "hook", provider: "claude" };

test("a corroborated limit lasts until its stated reset, at most a day, or 15 minutes without one, across restarts", () => {
  const s = store();
  try {
    const limits = s.open();
    limits.observe({ provider: "claude", detectedAt: at("10:00"), resetsAt: at("15:45"), sessionId: "s1", runId: "r1", confidence: "corroborated" });
    limits.observe({ provider: "codex", detectedAt: at("10:00"), resetsAt: at("10:00", 21), sessionId: "s2", confidence: "corroborated" });
    limits.observe({ provider: "opencode", detectedAt: at("10:00"), sessionId: "s3", confidence: "corroborated" });
    const reopened = s.open();
    assert.deepEqual(reopened.active(new Date(at("10:05"))).map(limit => [limit.provider, limit.expiresAt]),
      [["claude", at("15:45")], ["codex", at("10:00", 19)], ["opencode", at("10:15")]]);
    assert.equal(reopened.active(new Date(at("10:05")))[0].runId, "r1");
    assert.deepEqual([...reopened.limited(new Date(at("10:20")))], ["claude", "codex"]);
    assert.deepEqual([...reopened.limited(new Date(at("15:45")))], ["codex"]);
    reopened.observe({ provider: "claude", detectedAt: at("09:00"), sessionId: "old", confidence: "corroborated" });
    assert.equal(s.open().active(new Date(at("10:05")))[0].sessionId, "s1", "An older observation does not replace a newer entry");
  } finally { s.close(); }
});

test("a cleared limit stays cleared until a newer observation", () => {
  const s = store();
  try {
    const limits = s.open();
    limits.observe({ provider: "claude", detectedAt: at("10:00"), resetsAt: at("15:45"), sessionId: "s1", confidence: "corroborated" });
    limits.clear("claude", at("10:30"));
    limits.observe({ provider: "claude", detectedAt: at("10:00"), resetsAt: at("15:45"), sessionId: "s1", confidence: "corroborated" });
    assert.deepEqual(s.open().active(new Date(at("10:31"))), [], "The cleared observation cannot re-create its entry, even after restart");
    s.open().observe({ provider: "claude", detectedAt: at("10:40"), sessionId: "s2", confidence: "corroborated" });
    assert.equal(s.open().active(new Date(at("10:41")))[0].sessionId, "s2");
  } finally { s.close(); }
});

test("only a successful turn after the entry and after that session's own latest limit clears it", async () => {
  const s = store();
  try {
    const limits = s.open();
    const now = new Date(at("11:00"));
    const limited: LimitRow = { id: "limited", provider: "claude", attention: { limit: { confidence: "corroborated", since: at("10:00"), resetsAt: at("15:45") } } };
    const other: LimitRow = { id: "other", provider: "claude", attention: {} };
    const codex: LimitRow = { id: "codex", provider: "codex", attention: {} };
    const journals: Record<string, { at: string; data: Record<string, unknown> }[]> = {
      limited: [{ at: at("10:00"), data: claudeLimit }],
      other: [
        { at: at("09:50"), data: claudeStop },
        { at: at("10:05"), data: claudeStop },
        { at: at("10:10"), data: { ...claudeLimit, confidence: "single-source", source: "hook" } },
        { at: at("10:11"), data: { ...claudeStop, failed: true } },
      ],
      codex: [{ at: at("10:20"), data: { kind: "turn-end", source: "protocol", provider: "codex" } }],
    };
    const rows = [limited, other, codex], manager = sessions(journals);
    await limits.reconcile(manager, rows, now);
    assert.deepEqual(limits.active(now).map(limit => [limit.provider, limit.sessionId, limit.runId, limit.expiresAt]), [["claude", "limited", undefined, at("15:45")]],
      "A non-team session's corroborated limit is recorded; older, failed, superseded, and other-provider turns do not clear it");
    journals.other.push({ at: at("10:12"), data: claudeStop });
    await limits.reconcile(manager, rows, now);
    assert.deepEqual(limits.active(now), [], "A later successful turn of that provider clears the entry");
    await limits.reconcile(manager, rows, now);
    assert.deepEqual(s.open().active(now), [], "The limited session's old observation does not restore it");
  } finally { s.close(); }
});

test("a clear waits until the session's journal has been read to its end", async () => {
  const s = store();
  try {
    const limits = s.open();
    const now = new Date(at("11:00"));
    limits.observe({ provider: "claude", detectedAt: at("10:00"), resetsAt: at("15:45"), sessionId: "limited", confidence: "corroborated" });
    const journals: Record<string, { at: string; data: Record<string, unknown> }[]> = {
      other: [{ at: at("10:12"), data: claudeStop }, { at: at("10:13"), data: { ...claudeLimit, confidence: "single-source", source: "hook" } }],
    };
    const rows: LimitRow[] = [{ id: "other", provider: "claude", attention: {} }], manager = sessions(journals, 1);
    await limits.reconcile(manager, rows, now);
    assert.equal(limits.active(now).length, 1, "A successful turn followed by an unread page does not clear yet");
    await limits.reconcile(manager, rows, now);
    assert.equal(limits.active(now).length, 1, "The unread page held a newer limit for that session");
    journals.other.push({ at: at("10:14"), data: claudeStop });
    await limits.reconcile(manager, rows, now);
    assert.deepEqual(limits.active(now), []);
  } finally { s.close(); }
});

test("a Codex terminal turn end does not clear an entry; a native turn end does", async () => {
  const s = store();
  try {
    const limits = s.open();
    const now = new Date(at("11:00"));
    limits.observe({ provider: "codex", detectedAt: at("10:00"), resetsAt: at("15:45"), sessionId: "limited", confidence: "corroborated" });
    const journals: Record<string, { at: string; data: Record<string, unknown> }[]> = {
      codex: [
        { at: at("10:05"), data: { kind: "turn-end", source: "osc", provider: "codex" } },
        { at: at("10:06"), data: { kind: "turn-end", source: "hook", provider: "codex" } },
      ],
    };
    const rows: LimitRow[] = [{ id: "codex", provider: "codex", attention: {} }], manager = sessions(journals);
    await limits.reconcile(manager, rows, now);
    assert.equal(limits.active(now).length, 1, "OSC, Stop hook, and notify turn ends cannot say the turn failed");
    journals.codex.push({ at: at("10:07"), data: { kind: "turn-end", source: "protocol", provider: "codex" } });
    await limits.reconcile(manager, rows, now);
    assert.deepEqual(limits.active(now), [], "A native adapter's turn end carries the turn status");
  } finally { s.close(); }
});

test("a corroborated observation or a Claude hook switches a member; a single-source screen match does not", () => {
  assert.equal(switchesMember(claudeLimit), true);
  assert.equal(switchesMember({ ...claudeLimit, confidence: "single-source", source: "hook" }), true);
  assert.equal(switchesMember({ ...claudeLimit, confidence: "single-source", source: "screen" }), false);
  assert.equal(switchesMember({ ...claudeLimit, provider: "codex", confidence: "single-source", source: "screen" }), false);
  assert.equal(switchesMember({ ...claudeLimit, provider: "codex", source: "protocol" }), true);
  assert.equal(switchesMember({ kind: "turn-end", confidence: "corroborated" }), false);
});
