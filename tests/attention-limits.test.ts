import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectLimit, parseResetTime } from "../packages/attention/src/limits.js";
import { applySignal } from "../packages/attention/src/attention.js";
import type { Attention, SignalEvent } from "../packages/attention/src/types.js";

const screen = (name: string) =>
  readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), "utf8").split("\n");
const now = new Date("2026-10-17T20:00:00Z"); // a Saturday

test("parseResetTime returns the next occurrence after now, in UTC", () => {
  assert.equal(parseResetTime("resets 3:45pm", now), "2026-10-18T15:45:00.000Z");
  assert.equal(parseResetTime("resets 9:00pm", now), "2026-10-17T21:00:00.000Z");
  assert.equal(parseResetTime("resets Mon 12:00am", now), "2026-10-19T00:00:00.000Z");
  assert.equal(parseResetTime("Try again at Oct 18, 2026 3:45 PM", now), "2026-10-18T15:45:00.000Z");
  assert.equal(parseResetTime("resets 12:30pm", now), "2026-10-18T12:30:00.000Z");
  assert.equal(parseResetTime("no time here", now), undefined);
});

test("codex status row with usage limited detects a usage limit and its reset", () => {
  assert.deepEqual(
    { ...detectLimit(screen("codex-usage-limited"), "codex", now), message: undefined },
    { limit: "usage", resetsAt: "2026-10-18T15:45:00.000Z", message: undefined },
  );
  assert.ok(detectLimit(screen("codex-usage-limited"), "codex", now)?.message);
});

test("codex body text alone never triggers", () => {
  assert.equal(detectLimit(screen("codex-body-text-only"), "codex", now), null);
});

test("codex out-of-credits body with the status row reports credits", () => {
  const lines = [
    "You're out of credits. Your workspace is out of credits. Add credits to continue using Codex.",
    "› Ask Codex to do anything",
    "  usage limited · gpt-5-codex",
  ];
  assert.equal(detectLimit(lines, "codex", now)?.limit, "credits");
});

test("claude session limit line is detected anywhere on the screen", () => {
  const found = detectLimit(screen("claude-usage-limit"), "claude", now);
  assert.equal(found?.limit, "usage");
  assert.equal(found?.resetsAt, "2026-10-18T15:45:00.000Z");
  assert.equal(detectLimit(["You've hit your weekly limit · resets Mon 12:00am"], "claude", now)?.resetsAt, "2026-10-19T00:00:00.000Z");
  assert.equal(detectLimit(["fine"], "claude", now), null);
  assert.equal(detectLimit(screen("claude-usage-limit"), "grok", now), null);
});

const att = (): Attention => ({
  state: "working", since: "t0", source: "hook", now: "", lastActivityAt: "t0", hooks: "active", hookErrors: 0, sawTurnEnd: false,
});
const limitEvent = (confidence: "single-source" | "corroborated", at: string): SignalEvent => ({
  seq: 1, at, type: "signal",
  data: { kind: "provider-limit", limit: "usage", confidence, message: "m", source: "hook", provider: "claude" },
});

test("provider-limit sets attention.limit without changing state; corroborated is not downgraded", () => {
  const a = applySignal(att(), limitEvent("single-source", "t1"));
  assert.equal(a.state, "working");
  assert.equal(a.limit?.confidence, "single-source");
  assert.equal(a.limit?.since, "t1");
  const b = applySignal(a, limitEvent("corroborated", "t2"));
  assert.equal(b.limit?.confidence, "corroborated");
  const c = applySignal(b, limitEvent("single-source", "t3"));
  assert.equal(c.limit?.confidence, "corroborated");
  assert.equal(c.limit?.since, "t2");
});

test("codex phrase outside the status row segment never triggers", () => {
  assert.equal(detectLimit(["› why does the footer say usage limited?", "  gpt-5-codex · ~/workspace"], "codex", now), null);
  assert.equal(detectLimit(["$ cat docs/teams.md", "Codex shows usage limited in its status row", "$"], "codex", now), null);
  assert.equal(detectLimit(["", "Codex shows usage limited in its status row", ""], "codex", now), null);
  assert.equal(detectLimit(["› ask", "  gpt-5-codex · ~/workspace-usage limited-notes"], "codex", now), null);
});

test("codex status row with usage limited as its own segment detects", () => {
  assert.equal(detectLimit(["› ask", "  gpt-5-codex · ~/workspace · usage limited"], "codex", now)?.limit, "usage");
  assert.equal(detectLimit(["› ask", "  gpt-5-codex | Usage Limited"], "codex", now)?.limit, "usage");
});

test("codex reset time comes from the newest Try again at line", () => {
  const lines = [
    "Usage limit reached. Try again at Oct 17, 2026 9:00 PM",
    "Usage limit reached. Try again at Oct 18, 2026 3:45 PM",
    "› ask",
    "  gpt-5-codex · usage limited",
  ];
  assert.equal(detectLimit(lines, "codex", now)?.resetsAt, "2026-10-18T15:45:00.000Z");
});
