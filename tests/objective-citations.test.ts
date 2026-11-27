import test from "node:test";
import assert from "node:assert/strict";
import { parseCitation, qualifyingEntries, quotePresent } from "../packages/host/src/objective-citations.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "0123456789abcdef".repeat(4);

test("citations parse by form only", () => {
  assert.deepStrictEqual(parseCitation("src/a.ts"), { kind: "repository", path: "src/a.ts" });
  assert.deepStrictEqual(parseCitation("src/a.ts#L7"), { kind: "repository", path: "src/a.ts", lines: { from: 7, to: 7 } });
  assert.deepStrictEqual(parseCitation("src/a.ts#L10-L24"), { kind: "repository", path: "src/a.ts", lines: { from: 10, to: 24 } });
  assert.deepStrictEqual(parseCitation(`src/a.ts@${SHA1}`), { kind: "repository", path: "src/a.ts", commit: SHA1 });
  assert.deepStrictEqual(parseCitation(`docs/b.md#L1-L2@${SHA256}`), { kind: "repository", path: "docs/b.md", lines: { from: 1, to: 2 }, commit: SHA256 });

  assert.deepStrictEqual(parseCitation("https://Example.com/x"), { kind: "outside", host: "example.com" });

  const refused = [
    "../a",
    "/abs",
    ".",
    ".git/config",
    "a.ts#L0",
    "a.ts#L5-L4",
    "a.ts#L1-L10001",
    `src/a.ts@${SHA1.toUpperCase()}`,
    "http://example.com/x",
    "ftp://example.com/x",
    "a".repeat(301),
    "a".repeat(2001),
    `https://a.example/${"x".repeat(2001 - "https://a.example/".length)}`,
  ];
  for (const text of refused) assert.equal(parseCitation(text), undefined, `refused: ${text.slice(0, 40)}`);
});

test("qualifying entries count form-valid citations, one per outside host", () => {
  assert.equal(qualifyingEntries([{ sources: ["a.md#L1-L2", "https://a.example/1"] }], 2), 1);
  assert.equal(qualifyingEntries([{ sources: ["https://a.example/1", "https://a.example/2"] }], 2), 0);
  assert.equal(qualifyingEntries(["a.md", null, {}, { sources: "a.md" }, { sources: ["a.md", 5] }], 2), 0);
  const late = ["a.md", ...Array.from({ length: 31 }, () => "../x"), "b.md"];
  assert.equal(late.length, 33);
  assert.equal(qualifyingEntries([{ sources: late }], 2), 0);
  const inside = ["a.md", ...Array.from({ length: 30 }, () => "../x"), "b.md"];
  assert.equal(inside.length, 32);
  assert.equal(qualifyingEntries([{ sources: inside }], 2), 1);
});

test("a quote is present only in the cited lines after whitespace folding", () => {
  const text = "a\r\n  b   c\nd";
  assert.equal(quotePresent(text, "b c", { from: 2, to: 2 }), true);
  assert.equal(quotePresent(text, "b c"), true);
  assert.equal(quotePresent(text, "b c", { from: 3, to: 3 }), false);
  assert.equal(quotePresent(text, "b c", { from: 4, to: 9 }), false);
  assert.equal(quotePresent(text, "d", { from: 2, to: 2 }), false, "a quote after the cited lines is absent");
  assert.equal(quotePresent(text, "b \n  c", { from: 2, to: 2 }), true, "the quote folds its whitespace too");
  assert.equal(quotePresent(text, " \n "), false, "a quote that folds to nothing is never present");
});
