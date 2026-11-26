import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLifecycle,
  applySignal,
  detectPrompt,
  evaluateScreenActivity,
  initialAttention,
  substantiveScreenFingerprint,
  type Attention,
  type SignalEvent,
} from "@infinite/attention";
import { WorkerScreenActivity } from "../packages/host/src/worker-screen-activity.js";

test("substantiveScreenFingerprint ignores Braille, circle, ASCII spinners, timers, status tickers, and trailing spaces", () => {
  const brailleFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].map(
    (glyph, idx) => [
      `${glyph} Thinking… (${idx + 1}s · ↓ ${100 + idx * 50} tokens)   `,
      `claude-opus-4-6 | ${1200 + idx * 100} tokens | $0.0${idx + 1} | 00:0${idx}  `,
    ],
  );
  const fps = brailleFrames.map((lines) => substantiveScreenFingerprint(lines, "claude"));
  for (const fp of fps) {
    assert.equal(fp, fps[0]);
  }

  const circleA = substantiveScreenFingerprint(["◐ Working (1m 23s)  "], "codex");
  const circleB = substantiveScreenFingerprint(["◓ Working (1m 24s)    "], "codex");
  assert.equal(circleA, circleB);

  const asciiFrames = ["|", "/", "-", "\\"].map((spin) =>
    substantiveScreenFingerprint([`${spin} Running suite 00:42`], "opencode"),
  );
  for (const fp of asciiFrames) {
    assert.equal(fp, asciiFrames[0]);
  }

  const codexStatusA = substantiveScreenFingerprint(
    ["• Working (12s • esc to interrupt)", "gpt-5-codex · 42% context left · 1.2k tokens · $0.04"],
    "codex",
  );
  const codexStatusB = substantiveScreenFingerprint(
    ["◦ Working (19s • esc to interrupt)", "gpt-5-codex · 41% context left · 1.9k tokens · $0.08"],
    "codex",
  );
  assert.equal(codexStatusA, codexStatusB);
});

test("substantiveScreenFingerprint changes on genuine new lines or text", () => {
  const base = substantiveScreenFingerprint(["⠋ Working (12s)", "Step 1 complete"], "claude");
  const addedLine = substantiveScreenFingerprint(["⠙ Working (13s)", "Step 1 complete", "Step 2: editing worker.ts"], "claude");
  const changedValue = substantiveScreenFingerprint(["⠹ Working (14s)", "+ const total = 42;"], "claude");
  const changedValue2 = substantiveScreenFingerprint(["⠸ Working (15s)", "+ const total = 43;"], "claude");
  assert.notEqual(base, addedLine);
  assert.notEqual(changedValue, changedValue2);
});

test("evaluateScreenActivity tracks spinner-only duration without reporting substantiveChange", () => {
  const t0 = Date.parse("2026-11-26T00:00:00.000Z");
  const s1 = evaluateScreenActivity(undefined, ["⠋ Thinking (1s)"], "claude", true, t0);
  assert.equal(s1.substantiveChange, true);
  assert.equal(s1.spinnerOnly, false);
  assert.equal(s1.spinnerOnlySince, undefined);

  const s2 = evaluateScreenActivity(s1.nextState, ["⠙ Thinking (2s)"], "claude", true, t0 + 1000);
  assert.equal(s2.substantiveChange, false);
  assert.equal(s2.spinnerOnly, true);
  assert.equal(s2.spinnerOnlySince, new Date(t0 + 1000).toISOString());
  assert.equal(s2.nextState.lastSubstantiveAtMs, t0);

  const s3 = evaluateScreenActivity(s2.nextState, ["⠹ Thinking (3s)"], "claude", true, t0 + 5000);
  assert.equal(s3.substantiveChange, false);
  assert.equal(s3.spinnerOnly, true);
  assert.equal(s3.spinnerOnlySince, new Date(t0 + 1000).toISOString());
  assert.equal(s3.nextState.lastSubstantiveAtMs, t0);

  const s4 = evaluateScreenActivity(s3.nextState, ["⠸ Thinking (4s)", "Created src/fix.ts"], "claude", true, t0 + 6000);
  assert.equal(s4.substantiveChange, true);
  assert.equal(s4.spinnerOnly, false);
  assert.equal(s4.spinnerOnlySince, undefined);
  assert.equal(s4.nextState.lastSubstantiveAtMs, t0 + 6000);
});

test("WorkerScreenActivity prevents spinner redraws from counting as freshOutput or blocking idle, and updates hookless lastActivityAt on real output", () => {
  const t0 = Date.parse("2026-11-26T01:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  let att: Attention = initialAttention(iso(t0), true);
  const tracker = new WorkerScreenActivity(3000, t0);

  tracker.noteRawOutput(t0 + 100);
  const r1 = tracker.evaluate(att, ["⠋ Working (1s)", "› "], "codex", true, t0 + 100);
  att = r1.attention;
  assert.equal(r1.substantiveChange, true);
  assert.equal(r1.freshOutput, true);
  assert.equal(att.lastActivityAt, iso(t0 + 100));
  assert.equal(att.spinnerOnlySince, undefined);

  tracker.noteRawOutput(t0 + 2000);
  const r2 = tracker.evaluate(att, ["⠙ Working (3s)", "› "], "codex", true, t0 + 2000);
  att = r2.attention;
  assert.equal(r2.substantiveChange, false);
  assert.equal(r2.freshOutput, false);
  assert.equal(r2.idle, false);
  assert.equal(att.lastActivityAt, iso(t0 + 100));
  assert.equal(att.spinnerOnlySince, iso(t0 + 2000));

  tracker.noteRawOutput(t0 + 3500);
  const r3 = tracker.evaluate(att, ["⠹ Working (5s)", "› "], "codex", true, t0 + 3500);
  att = r3.attention;
  assert.equal(r3.substantiveChange, false);
  assert.equal(r3.freshOutput, false);
  assert.equal(r3.idle, true);
  assert.equal(att.lastActivityAt, iso(t0 + 100));
  assert.equal(att.spinnerOnlySince, iso(t0 + 2000));

  tracker.noteRawOutput(t0 + 4000);
  const r4 = tracker.evaluate(att, ["⠸ Working (6s)", "Applied patch to worker.ts"], "codex", false, t0 + 4000);
  att = r4.attention;
  assert.equal(r4.substantiveChange, true);
  assert.equal(r4.freshOutput, true);
  assert.equal(r4.idle, false);
  assert.equal(att.lastActivityAt, iso(t0 + 4000));
  assert.equal(att.spinnerOnlySince, undefined);

  const hookedBase: Attention = { ...att, hooks: "active", lastActivityAt: iso(t0 + 4000) };
  tracker.noteRawOutput(t0 + 5000);
  const r5 = tracker.evaluate(hookedBase, ["Running npm test"], "claude", false, t0 + 5000);
  assert.equal(r5.substantiveChange, true);
  assert.equal(r5.attention.lastActivityAt, iso(t0 + 4000));
});

test("applySignal and applyLifecycle clear spinnerOnlySince and prompt detection still works behind spinners", () => {
  const t0 = Date.parse("2026-11-26T02:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  let att: Attention = initialAttention(iso(t0), true);
  const tracker = new WorkerScreenActivity(3000, t0);

  tracker.noteRawOutput(t0 + 100);
  att = tracker.evaluate(att, ["⠋ Thinking (1s)"], "claude", false, t0 + 100).attention;
  tracker.noteRawOutput(t0 + 1000);
  att = tracker.evaluate(att, ["⠙ Thinking (2s)"], "claude", false, t0 + 1000).attention;
  assert.equal(att.spinnerOnlySince, iso(t0 + 1000));

  const sig: SignalEvent = {
    seq: 1,
    at: iso(t0 + 2000),
    type: "signal",
    data: { kind: "tool-start", tool: "Read", input: { file_path: "a.ts" }, quiet: false, source: "hook", provider: "claude" },
  };
  att = applySignal(att, sig);
  assert.equal(att.spinnerOnlySince, undefined);
  assert.equal(att.lastActivityAt, iso(t0 + 2000));

  const quietAfterSignal = tracker.evaluate(att, ["⠹ Thinking (3s)"], "claude", false, t0 + 3000);
  assert.equal(quietAfterSignal.attention.spinnerOnlySince, undefined);

  const withSpinnerAgain: Attention = { ...att, spinnerOnlySince: iso(t0 + 4000) };
  const exited = applyLifecycle(withSpinnerAgain, "exited", iso(t0 + 5000));
  assert.equal(exited.spinnerOnlySince, undefined);

  const detected = detectPrompt(
    [
      "⠋ Working (10s)",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
    ],
    "claude",
  );
  assert.ok(detected);
  assert.equal(detected.kind, "permission");
});
