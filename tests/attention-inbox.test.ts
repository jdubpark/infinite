import test from "node:test";
import assert from "node:assert/strict";
import { groupFor, groupSessions } from "../packages/attention/src/inbox.js";
import { initialAttention } from "../packages/attention/src/attention.js";
import type { Attention, AttentionState } from "../packages/attention/src/types.js";

const row = (id: string, state: AttentionState, since = "2026-10-04T12:00:00.000Z") => ({
  id,
  createdAt: "2026-10-04T10:00:00.000Z",
  attention: { ...initialAttention("t", false), state, since } as Attention,
});

test("one row per state comes back in the fixed order", () => {
  const groups = groupSessions([
    row("e", "exited"), row("f", "turn-finished"), row("w", "working"), row("n", "needs-you"),
  ]);
  assert.deepEqual(groups.map((g) => g.title), ["Needs you", "Working", "Finished", "Exited"]);
  assert.deepEqual(groups.map((g) => g.rows[0].id), ["n", "w", "f", "e"]);
});

test("empty groups are omitted", () => {
  const groups = groupSessions([row("w", "working"), row("i", "idle")]);
  assert.deepEqual(groups.map((g) => g.title), ["Working", "Finished"]);
  assert.deepEqual(groupSessions([]), []);
});

test("within a group the newer since comes first", () => {
  const [g] = groupSessions([
    row("old", "working", "2026-10-04T11:00:00.000Z"),
    row("new", "working", "2026-10-04T13:00:00.000Z"),
    row("mid", "working", "2026-10-04T12:00:00.000Z"),
  ]);
  assert.deepEqual(g.rows.map((r) => r.id), ["new", "mid", "old"]);
});

test("groupFor maps every state", () => {
  assert.equal(groupFor({ state: "idle" } as Attention), "Finished");
  assert.equal(groupFor({ state: "unavailable" } as Attention), "Exited");
  assert.equal(groupFor({ state: "recording-error" } as Attention), "Exited");
});
