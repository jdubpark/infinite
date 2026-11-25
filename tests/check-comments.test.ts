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
    assert.equal(isCheckedSourcePath("apps/macos/Sources/InfiniteAtomics/include/InfiniteAtomics.h"), true);
    assert.equal(isCheckedSourcePath("scripts/build.kts"), true);
    assert.equal(isCheckedSourcePath("docs/adr/0001-demo.md"), false);
  });

  test("ignores rendered JsxText while still counting comments inside JsxExpression", () => {
    assert.equal(summarizeFileComments("export const x = <pre>// not a comment</pre>;\n", "apps/web/src/Demo.tsx").blocks, 0);
    const mixed = summarizeFileComments("export const x = <pre>{/* real comment */}// not a comment</pre>;\n", "apps/web/src/Demo.tsx");
    assert.equal(mixed.blocks, 1);
    assert.equal(mixed.lines, 1);
    const multiline = summarizeFileComments("export const x = <pre>\n  // not a comment\n  /* also not */\n  {/* real */}\n</pre>;\n", "apps/web/src/Demo.tsx");
    assert.equal(multiline.blocks, 1);
  });

  test("skips shell here-document payloads including quoted apostrophes, headings, multiple heredocs, and tab-stripped delimiters", () => {
    const sh = [
      "#!/usr/bin/env bash",
      "cat <<'EOF'",
      "# Markdown heading",
      "don't treat this apostrophe as an open quote",
      "EOF",
      "# real shell comment",
      "cat <<-END <<\"NEXT\"",
      "\t# inside tabbed heredoc",
      "\tEND",
      "# inside second heredoc",
      "NEXT",
      "echo ok # trailing real comment",
    ].join("\n");
    const summary = summarizeFileComments(sh, "scripts/demo.sh");
    assert.equal(summary.blocks, 2);
    assert.equal(summary.lines, 2);
    assert.equal(summary.shedLines, 1);

    const hereString = [
      "grep foo <<< \"bar\"",
      "# comment after here-string",
    ].join("\n");
    assert.equal(summarizeFileComments(hereString, "scripts/demo.sh").blocks, 1);

    const arithmetic = [
      "bits=$((1 << shift))",
      "# comment after arithmetic shift",
      "(( (a << 2) > 0 ))",
      "# comment after compound arithmetic shift",
    ].join("\n");
    assert.equal(summarizeFileComments(arithmetic, "scripts/demo.sh").blocks, 2);

    const dotted = [
      "cat <<END.TXT",
      "# inside dotted heredoc",
      "END.TXT",
      "# comment after dotted heredoc",
      "cat <<$DYNAMIC",
      "# comment after unexpanded delimiter",
      "cat <<'UNCLOSED",
      "'",
      "# comment after unclosed quote closes",
    ].join("\n");
    assert.equal(summarizeFileComments(dotted, "scripts/demo.sh").blocks, 3);
  });

  test("checks .h C headers and ignores comments inside Kotlin triple-quoted raw strings", () => {
    assert.equal(summarizeFileComments("#ifndef DEMO_H\n#define DEMO_H\nint f(void);\n#endif\n", "include/demo.h").blocks, 0);
    assert.equal(summarizeFileComments("/* header prose */\nint f(void);\n", "include/demo.h").blocks, 1);

    const ktClean = 'val s = """He said "ok // ok" to me\\"""\n';
    assert.equal(summarizeFileComments(ktClean, "app/Demo.kt").blocks, 0);
    const ktsReal = 'val s = """/* not */ // not"""\n// real kotlin comment\n';
    assert.equal(summarizeFileComments(ktsReal, "build.gradle.kts").blocks, 1);
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
