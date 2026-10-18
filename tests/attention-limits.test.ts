import test from "node:test";
import assert from "node:assert/strict";
import { applySignal, detectLimit, initialAttention, parseResetTime, type SignalEvent } from "@infinite/attention";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const now = new Date("2026-10-17T20:00:00.000Z");
const fixture = (name: string) => readFileSync(resolve("tests/fixtures/screens", name), "utf8").split("\n");

test("Codex screen text stays inert until the real footer structure is verified", () => {
  assert.equal(detectLimit(fixture("codex-body-text-only.txt"), "codex", now), null);
  assert.equal(detectLimit(["You are out of credits", "normal status"], "codex", now), null);
  assert.equal(detectLimit(["The issue contains a note:", "usage limited"], "codex", now), null);
});

test("Claude screen limit notice parses the next reset occurrence in UTC", () => {
  const found = detectLimit(fixture("claude-usage-limit.txt"), "claude", now);
  assert.equal(found?.limit, "usage");
  assert.equal(found?.resetsAt, "2026-10-18T15:45:00.000Z");
  assert.equal(parseResetTime("resets Mon 12:00am", new Date("2026-10-18T23:00:00.000Z")), "2026-10-19T00:00:00.000Z");
  assert.equal(parseResetTime("resets 00:30", new Date("2026-10-31T23:00:00.000Z")), "2026-11-01T00:30:00.000Z");
  assert.equal(parseResetTime("resets Nov 31, 2026 00:30", now), undefined);
  assert.equal(parseResetTime("resets someday", now), undefined);
});

test("provider-limit attention preserves corroboration and clears only after a successful turn", () => {
  const initial = initialAttention("2026-10-17T20:00:00.000Z", false);
  const event = (seq: number, confidence: "single-source" | "corroborated", kind: "provider-limit" | "turn-end" = "provider-limit"): SignalEvent => ({
    seq, at: `2026-10-17T20:00:0${seq}.000Z`, type: "signal",
    data: kind === "provider-limit"
      ? { kind, source: "screen", provider: "codex", limit: "usage", confidence, message: "Usage limited" }
      : { kind, source: "protocol", provider: "codex", failed: false },
  });
  let attention = applySignal(initial, event(1, "single-source"));
  const firstObservedAt = attention.limit?.since;
  assert.equal(attention.state, "idle");
  attention = applySignal(attention, event(2, "corroborated"));
  assert.equal(attention.limit?.since, firstObservedAt);
  attention = applySignal(attention, event(3, "single-source"));
  assert.equal(attention.limit?.confidence, "corroborated");
  attention = applySignal(attention, event(4, "single-source", "turn-end"));
  assert.equal(attention.limit, undefined);
});

 test("an explicit same-weekday reset advances a week after its clock has passed", () => {
  assert.equal(parseResetTime("resets Mon 12:00pm", new Date("2026-10-19T16:00:00Z")), "2026-10-26T12:00:00.000Z");
});
