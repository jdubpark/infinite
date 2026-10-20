import test from "node:test";
import assert from "node:assert/strict";
import { appendDictation } from "../apps/web/src/dictation-text.js";

test("appendDictation joins text, ignores empty input, and reports clipped characters", () => {
  assert.deepEqual(appendDictation("existing", "  next words  ", 30), { text: "existing next words", dropped: 0 });
  assert.deepEqual(appendDictation("existing\n", "next", 30), { text: "existing\nnext", dropped: 0 });
  assert.deepEqual(appendDictation("existing", "   ", 30), { text: "existing", dropped: 0 });
  assert.deepEqual(appendDictation("draft", " speech", 9), { text: "draft spe", dropped: 3 });
  assert.deepEqual(appendDictation("full", " words", 4), { text: "full", dropped: 5 });
});
