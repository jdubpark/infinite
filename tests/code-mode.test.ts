import test from "node:test";
import assert from "node:assert/strict";
import { codeModeEnabled } from "../packages/host/src/code-mode.js";

test("Code Mode launch forms match the host switch", () => {
  const cases = [
    ["a plain interactive owner", "claude", { headless: false, served: false, excluded: false }, true],
    ["b interactive team member", "claude", { headless: false, served: false, excluded: false }, true],
    ["c served headless member", "claude", { headless: true, served: true, excluded: false }, true],
    ["d permission coordinator", "claude", { headless: true, served: false, excluded: true }, false],
    ["e mission coordinator", "claude", { headless: false, served: false, excluded: true }, false],
    ["f permission reviewer turn", "claude", { headless: false, served: false, excluded: true }, false],
    ["g unserved headless launch", "claude", { headless: true, served: false, excluded: false }, false],
    ["h cmux, helper and other-provider launch", "codex", { headless: false, served: false, excluded: true }, false],
  ] as const;
  for (const [form, provider, facts, expected] of cases)
    assert.equal(codeModeEnabled("all", provider, facts), expected, form);
  const interactive = { headless: false, served: false, excluded: false };
  const servedHeadless = { headless: true, served: true, excluded: false };
  assert.equal(codeModeEnabled("headless", "claude", servedHeadless), true);
  assert.equal(codeModeEnabled("headless", "claude", interactive), false);
  assert.equal(codeModeEnabled("off", "claude", interactive), false);
  assert.equal(codeModeEnabled("all", "claude", interactive, undefined, "eval"), false);
  assert.equal(codeModeEnabled("all", "claude", interactive, undefined, "production"), true);
  assert.equal(codeModeEnabled(undefined, "claude", interactive), false, "absent config is off");
});

test("native relaunch follows the recorded conversation mode", () => {
  assert.equal(codeModeEnabled("off", "claude", { headless: false, served: false, excluded: false }, true), true);
  assert.equal(codeModeEnabled("all", "claude", { headless: false, served: false, excluded: false }, false), false);
  assert.equal(codeModeEnabled("all", "claude", { headless: true, served: true, excluded: false }, false), false);
  assert.equal(codeModeEnabled("off", "claude", { headless: false, served: false, excluded: true }, true), false);
  assert.equal(codeModeEnabled("off", "claude", { headless: false, served: false, excluded: false }, true, "eval"), false);
  assert.equal(codeModeEnabled("off", "claude", { headless: false, served: false, excluded: false }, true, "production"), true);
  assert.equal(codeModeEnabled("off", "claude", { headless: true, served: true, excluded: false }, true), true);
  assert.equal(codeModeEnabled("all", "claude", { headless: true, served: false, excluded: false }, true), false);
});
