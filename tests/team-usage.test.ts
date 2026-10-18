import test from "node:test";
import assert from "node:assert/strict";
import { addRollups, emptyRollup, emptyUsage, type UsageRollup } from "../packages/host/src/team-usage.js";
import type { UsageTotals } from "../packages/host/src/usage.js";

const totals = (cost: number, messages: number, pricing: Partial<UsageTotals["pricing"]>, input = 0): UsageTotals =>
  ({ ...emptyUsage(), cost, messages, tokens: { ...emptyUsage().tokens, input }, pricing: { configured: 0, provider: 0, unknown: 0, ...pricing } });

test("merging cycle rollups adds overlapping keys, keeps distinct ones, and sums unmeasured members exactly", () => {
  const a: UsageRollup = {
    total: totals(0.002, 2, { configured: 2 }, 1000),
    byProfile: { ds: totals(0.002, 2, { configured: 2 }, 1000) },
    byProvider: { opencode: totals(0.002, 2, { configured: 2 }, 1000) },
    unmeasuredMembers: 2,
  };
  const b: UsageRollup = {
    total: totals(0.6, 3, { provider: 2, unknown: 1 }, 50),
    byProfile: { ds: totals(0.5, 2, { provider: 2 }, 30), spark: totals(0.1, 1, { unknown: 1 }, 20) },
    byProvider: { opencode: totals(0.6, 3, { provider: 2, unknown: 1 }, 50) },
    unmeasuredMembers: 3,
  };
  const merged = addRollups([a, b]);
  assert.equal(merged.total.cost, 0.602);
  assert.equal(merged.total.messages, 5);
  assert.equal(merged.total.tokens.input, 1050);
  assert.equal(merged.byProfile.ds.messages, 4);
  assert.equal(merged.byProfile.ds.cost, 0.502);
  assert.deepEqual(merged.byProfile.ds.pricing, { configured: 2, provider: 2, unknown: 0 });
  assert.equal(merged.byProfile.spark.messages, 1);
  assert.equal(merged.byProvider.opencode?.messages, 5);
  assert.deepEqual(merged.total.pricing, { configured: 2, provider: 2, unknown: 1 });
  assert.equal(merged.unmeasuredMembers, 5);
  assert.equal(a.byProfile.ds.messages, 2, "Merging must not mutate its inputs");
});

test("a rollup for unreadable usage reports zero totals and counts every member as unmeasured", () => {
  const empty = emptyRollup(4);
  assert.equal(empty.unmeasuredMembers, 4);
  assert.deepEqual(empty.total, emptyUsage());
  assert.deepEqual(empty.byProfile, {});
  assert.deepEqual(empty.byProvider, {});
  assert.equal(addRollups([empty, emptyRollup(1)]).unmeasuredMembers, 5);
});
