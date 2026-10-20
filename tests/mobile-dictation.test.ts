import test from "node:test";
import assert from "node:assert/strict";
import { appendDictation } from "../apps/mobile/src/dictation/text.ts";

test("dictation appends with one space unless the draft is empty or already ends in whitespace", () => {
  assert.deepEqual(appendDictation("", "  Add a retry  ", 100), { text: "Add a retry", dropped: 0 });
  assert.deepEqual(appendDictation("Ship it", "soon", 100), { text: "Ship it soon", dropped: 0 });
  assert.deepEqual(appendDictation("Ship it\n", "soon", 100), { text: "Ship it\nsoon", dropped: 0 });
  assert.deepEqual(appendDictation("Ship it", "   ", 100), { text: "Ship it", dropped: 0 });
});

test("dictation clips only the addition and reports the characters it dropped", () => {
  assert.deepEqual(appendDictation("abc", "defgh", 7), { text: "abc def", dropped: 2 });
  assert.deepEqual(appendDictation("abc", "defgh", 6), { text: "abc de", dropped: 3 });
  assert.deepEqual(appendDictation("abc", "defgh", 100), { text: "abc defgh", dropped: 0 });
});

test("dictation leaves a draft at its limit unchanged and reports the whole addition as dropped", () => {
  assert.deepEqual(appendDictation("abcdef", "gh", 6), { text: "abcdef", dropped: 2 });
  assert.deepEqual(appendDictation("abcdef ", "gh", 7), { text: "abcdef ", dropped: 2 });
});
