import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evaluateCommentRatchet, extractComments, isCheckedSourcePath, summarizeFileComments } from "../scripts/check-comments.mjs";

describe("check-comments extractor", () => {
  test("detects TypeScript line, block, and JSDoc comments while ignoring strings, regexes, and JSX text", () => {
    const source = [
      "const url = 'https://example.com//not-a-comment';",
      "const re = /foo\\/\\*bar\\*\\//g;",
      "const tpl = `hello /* not a comment */ ${1 + 2} // also not`;",
      "// first line",
      "// second line",
      "export function add(a: number, b: number) {",
      "  return a + b; // trailing inline",
      "}",
      "/** doc comment",
      " * line two",
      " */",
      "export const value = 1;",
    ].join("\n");

    const summary = summarizeFileComments(source, "packages/example/src/demo.ts");
    assert.equal(summary.blocks, 3);
    assert.equal(summary.lines, 6);
    assert.equal(summary.shedLines, 5);
  });

  test("exempts narrow toolchain directives while rejecting @ts-ignore and multiline eslint-disable prose bypasses", () => {
    const tsSource = [
      "#!/usr/bin/env node",
      "/// <reference types=\"node\" />",
      "// @ts-expect-error negative compile test",
      "// eslint-disable-next-line react-hooks/exhaustive-deps",
      "/* eslint-disable",
      "   hidden prose bypass */",
      "// @ts-ignore untyped import",
      "// ordinary comment",
      "export const ok = true;",
    ].join("\n");
    const tsSummary = summarizeFileComments(tsSource, "scripts/demo.ts");
    assert.equal(tsSummary.blocks, 2);
    assert.equal(tsSummary.lines, 4);

    const swiftSource = [
      "// swift-tools-version: 6.0",
      "let raw = #\"not // a comment /* either */\"#",
      "let interp = \"key: \\(dict[\"a\"] ?? \"\") // still inside string\"",
      "let multi = \"\"\"",
      "// inside multiline string",
      "\"\"\"",
      "/* outer /* nested */ comment */",
      "// real swift comment",
      "let x = 1",
    ].join("\n");
    const swiftSummary = summarizeFileComments(swiftSource, "apps/macos/Package.swift");
    assert.equal(swiftSummary.blocks, 2);
    assert.equal(swiftSummary.lines, 2);
  });

  test("handles shell parameter expansions, shellcheck directives, and python multiline strings without false positives", () => {
    const shSource = [
      "#!/usr/bin/env bash",
      "# shellcheck disable=SC2034",
      "len=${#HOME}",
      "val=${var#*=}",
      "base=${path##*/}",
      "msg=\"# inside quotes\"",
      "word=foo#bar",
      "# real shell comment",
      "echo $len # trailing shell comment",
    ].join("\n");
    const shSummary = summarizeFileComments(shSource, "scripts/demo.sh");
    assert.equal(shSummary.blocks, 2);
    assert.equal(shSummary.lines, 2);
    assert.equal(shSummary.shedLines, 1);

    const pySource = [
      "#!/usr/bin/env python3",
      "DOC = \"\"\"",
      "# not a comment inside triple quotes",
      "\"\"\"",
      "# real python comment",
      "x = 1",
    ].join("\n");
    const pySummary = summarizeFileComments(pySource, "scripts/demo.py");
    assert.equal(pySummary.blocks, 1);
    assert.equal(pySummary.lines, 1);
  });

  test("excludes declaration files and generated or vendor directories on POSIX and Windows paths", () => {
    assert.equal(isCheckedSourcePath("packages/host/src/index.ts"), true);
    assert.equal(isCheckedSourcePath("packages/host/src/index.d.ts"), false);
    assert.equal(isCheckedSourcePath("packages/host/dist/index.js"), false);
    assert.equal(isCheckedSourcePath("packages\\host\\dist\\index.js"), false);
    assert.equal(isCheckedSourcePath("apps/macos/Sources/Core.swift"), true);
    assert.equal(isCheckedSourcePath("docs/adr/0001-demo.md"), false);
  });
});

describe("check-comments ratchet", () => {
  test("bans comments in new files, blocks growth in baselined files, and ratchets downward", () => {
    const counts = new Map([
      ["packages/a/new.ts", { blocks: 1, lines: 2, shedLines: 2, details: [] }],
      ["packages/a/grew.ts", { blocks: 3, lines: 5, shedLines: 5, details: [] }],
      ["packages/a/shrank.ts", { blocks: 1, lines: 2, shedLines: 2, details: [] }],
      ["packages/a/cleaned.ts", { blocks: 0, lines: 0, shedLines: 0, details: [] }],
      ["packages/a/same.ts", { blocks: 2, lines: 4, shedLines: 4, details: [] }],
    ]);
    const recorded = {
      "packages/a/grew.ts": 3,
      "packages/a/shrank.ts": 6,
      "packages/a/cleaned.ts": 4,
      "packages/a/same.ts": 4,
      "packages/a/deleted.ts": 2,
    };

    const result = evaluateCommentRatchet(counts, recorded);
    assert.equal(result.failures.length, 2);
    assert.match(result.failures[0], /packages\/a\/new\.ts.*0 comments/);
    assert.match(result.failures[1], /packages\/a\/grew\.ts grew from 3 to 5/);
    assert.equal(result.atBaseline, 1);
    assert.deepEqual(result.next, {
      "packages/a/grew.ts": 3,
      "packages/a/shrank.ts": 2,
      "packages/a/same.ts": 4,
    });
    assert.equal(extractComments("export const clean = 1;\n", "a.ts").length, 0);
  });
});
