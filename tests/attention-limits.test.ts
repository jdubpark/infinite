import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectLimit, parseResetTime } from "../packages/attention/src/limits.js";
import { applySignal, recoveryTurnEnd } from "../packages/attention/src/attention.js";
import type { Attention, SignalData, SignalEvent } from "../packages/attention/src/types.js";

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

test("a successful turn-end clears attention.limit; a failed one keeps it", () => {
  const limited = applySignal(att(), limitEvent("corroborated", "t1"));
  const end = (failed?: boolean): SignalEvent => ({
    seq: 2, at: "t2", type: "signal",
    data: { kind: "turn-end", ...(failed ? { failed } : {}), source: "hook", provider: "claude" },
  });
  assert.equal(applySignal(limited, end(true)).limit?.confidence, "corroborated");
  assert.equal(applySignal(limited, end()).limit, undefined);
});

test("only a turn-end that can report failure clears attention.limit", () => {
  const limited = applySignal(att(), limitEvent("corroborated", "t1"));
  const end = (source: SignalData["source"], provider: SignalData["provider"], failed?: boolean): SignalEvent => ({
    seq: 2, at: "t2", type: "signal",
    data: { kind: "turn-end", ...(failed ? { failed } : {}), source, provider },
  });
  assert.equal(applySignal(limited, end("osc", "codex")).limit?.confidence, "corroborated", "A Codex OSC turn complete cannot say the turn failed");
  assert.equal(applySignal(limited, end("hook", "codex")).limit?.confidence, "corroborated", "Nor can a Codex Stop hook or notify");
  assert.equal(applySignal(limited, end("hook", "claude")).limit, undefined, "A Claude Stop hook is distinct from StopFailure");
  assert.equal(applySignal(limited, end("protocol", "codex")).limit, undefined, "A native adapter carries the turn status");
  assert.equal(applySignal(limited, end("protocol", "codex", true)).limit?.confidence, "corroborated");
  assert.deepEqual(
    [end("hook", "claude"), end("hook", "claude", true), end("protocol", "opencode"), end("osc", "codex"), end("hook", "codex"), end("screen", "claude")].map((e) => recoveryTurnEnd(e.data)),
    [true, false, true, false, false, false],
  );
  assert.equal(recoveryTurnEnd({ kind: "notice", type: "quota_auto_resume_fired", source: "hook", provider: "claude" }), false);
});

test("a quota_auto_resume_fired notice clears attention.limit; other notices keep it", () => {
  const limited = applySignal(att(), limitEvent("corroborated", "t1"));
  const notice = (type: string): SignalEvent => ({
    seq: 2, at: "t2", type: "signal",
    data: { kind: "notice", type, source: "hook", provider: "claude" },
  });
  assert.equal(applySignal(limited, notice("quota_auto_resume_fired")).limit, undefined);
  assert.equal(applySignal(limited, notice("idle_prompt")).limit?.confidence, "corroborated");
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
