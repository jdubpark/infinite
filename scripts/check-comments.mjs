#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const BASELINE_PATH = "scripts/comments-baseline.json";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const C_LIKE_EXTENSIONS = new Set([".swift", ".c", ".h", ".kt", ".kts"]);
const HASH_EXTENSIONS = new Set([".py", ".sh"]);
const ALL_EXTENSIONS = new Set([...TS_EXTENSIONS, ...C_LIKE_EXTENSIONS, ...HASH_EXTENSIONS]);
const SKIPPED_SEGMENTS = new Set(["node_modules", "vendor", "generated", "dist", ".build"]);

const TS_DIRECTIVE_RE = /^(?:\/\/\/\s*<reference\b[^\n]*\/>\s*$|\/\/\s*@ts-expect-error(?:\s|$)|\/\/\s*eslint-disable-next-line(?:\s+[A-Za-z0-9_@/-]+(?:\s*,\s*[A-Za-z0-9_@/-]+)*)?\s*$)/;
const SWIFT_DIRECTIVE_RE = /^\/\/\s*swift-tools-version:\s*\d+(?:\.\d+)*\s*$/;
const SHELL_DIRECTIVE_RE = /^#\s*shellcheck\s+disable=[^\n]+$/;

export function isCheckedSourcePath(filePath) {
  if (!ALL_EXTENSIONS.has(extname(filePath)) || filePath.endsWith(".d.ts")) return false;
  return !filePath.split(/[/\\]/).some((segment) => SKIPPED_SEGMENTS.has(segment));
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

function extractTsComments(text, filePath) {
  const ext = extname(filePath);
  const scriptKind =
    ext === ".tsx" ? ts.ScriptKind.TSX :
    ext === ".jsx" ? ts.ScriptKind.JSX :
    ext === ".js" || ext === ".mjs" || ext === ".cjs" ? ts.ScriptKind.JS :
    ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false, scriptKind);
  const seen = new Map();
  const jsxTextSpans = [];

  function addRanges(ranges) {
    if (!ranges) return;
    for (const range of ranges) {
      if (!seen.has(range.pos)) seen.set(range.pos, range);
    }
  }

  function visit(node) {
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxTextSpans.push([node.pos, node.end]);
      return;
    }
    addRanges(ts.getLeadingCommentRanges(text, node.pos));
    addRanges(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(sourceFile)) visit(child);
  }
  visit(sourceFile);

  const isInsideJsxText = (pos) => jsxTextSpans.some(([start, end]) => pos >= start && pos < end);
  const starts = lineStartsOf(text);
  const sorted = [...seen.values()].sort((a, b) => a.pos - b.pos);
  const comments = [];
  for (const range of sorted) {
    if (isInsideJsxText(range.pos)) continue;
    const rawText = text.slice(range.pos, range.end);
    if (range.pos === 0 && rawText.startsWith("#!")) continue;
    const startLine = offsetToLine(starts, range.pos);
    const endLine = offsetToLine(starts, Math.max(range.pos, range.end - 1));
    const before = text.slice(starts[startLine - 1], range.pos);
    const lineEnd = text.indexOf("\n", range.end);
    const after = text.slice(range.end, lineEnd === -1 ? text.length : lineEnd);
    comments.push({
      start: range.pos,
      end: range.end,
      startLine,
      endLine,
      kind: range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block",
      fullLineOnly: before.trim() === "" && after.trim() === "",
      text: rawText,
    });
  }
  return comments;
}

function skipSwiftInterpolation(text, startIndex) {
  let i = startIndex;
  const n = text.length;
  let depth = 1;
  while (i < n && depth > 0) {
    const ch = text[i];
    if (ch === "(") { depth += 1; i += 1; }
    else if (ch === ")") { depth -= 1; i += 1; }
    else if (ch === "#") {
      const nextIdx = trySkipSwiftRawString(text, i);
      if (nextIdx !== -1) i = nextIdx;
      else i += 1;
    } else if (ch === '"') {
      const triple = text[i + 1] === '"' && text[i + 2] === '"';
      i = skipSwiftQuotedString(text, i, triple);
    } else {
      i += 1;
    }
  }
  return i;
}

function trySkipSwiftRawString(text, startIndex) {
  const n = text.length;
  let hashes = 0;
  while (startIndex + hashes < n && text[startIndex + hashes] === "#") hashes += 1;
  if (hashes === 0 || text[startIndex + hashes] !== '"') return -1;
  const triple = text[startIndex + hashes + 1] === '"' && text[startIndex + hashes + 2] === '"';
  const closeDelim = (triple ? '"""' : '"') + "#".repeat(hashes);
  const interpDelim = "\\" + "#".repeat(hashes) + "(";
  let i = startIndex + hashes + (triple ? 3 : 1);
  while (i < n) {
    if (text.startsWith(closeDelim, i)) return i + closeDelim.length;
    if (text.startsWith(interpDelim, i)) {
      i = skipSwiftInterpolation(text, i + interpDelim.length);
      continue;
    }
    i += 1;
  }
  return n;
}

function skipSwiftQuotedString(text, startIndex, triple) {
  const n = text.length;
  let i = startIndex + (triple ? 3 : 1);
  while (i < n) {
    if (triple && text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') return i + 3;
    if (!triple && text[i] === '"') return i + 1;
    if (text[i] === "\\") {
      if (text[i + 1] === "(") {
        i = skipSwiftInterpolation(text, i + 2);
      } else {
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return n;
}

function extractCLikeComments(text, ext) {
  const isSwift = ext === ".swift";
  const isKotlin = ext === ".kt" || ext === ".kts";
  const starts = lineStartsOf(text);
  const comments = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (isSwift && ch === "#") {
      const nextIdx = trySkipSwiftRawString(text, i);
      if (nextIdx !== -1) { i = nextIdx; continue; }
    }
    if (isSwift && ch === '"') {
      const triple = next === '"' && text[i + 2] === '"';
      i = skipSwiftQuotedString(text, i, triple);
      continue;
    }
    if (isKotlin && ch === '"' && next === '"' && text[i + 2] === '"') {
      i += 3;
      while (i < n && !(text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"')) i += 1;
      i += 3;
      continue;
    }
    if (!isSwift && ch === '"') {
      i += 1;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (!isSwift && ch === "'") {
      i += 1;
      while (i < n && text[i] !== "'") i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < n && text[i] !== "\n") i += 1;
      const end = i;
      const startLine = offsetToLine(starts, start);
      const before = text.slice(starts[startLine - 1], start);
      comments.push({
        start,
        end,
        startLine,
        endLine: startLine,
        kind: "line",
        fullLineOnly: before.trim() === "",
        text: text.slice(start, end),
      });
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if ((isSwift || isKotlin) && text[i] === "/" && text[i + 1] === "*") { depth += 1; i += 2; }
        else if (text[i] === "*" && text[i + 1] === "/") { depth -= 1; i += 2; }
        else i += 1;
      }
      const end = i;
      const startLine = offsetToLine(starts, start);
      const endLine = offsetToLine(starts, Math.max(start, end - 1));
      const before = text.slice(starts[startLine - 1], start);
      const lineEnd = text.indexOf("\n", end);
      const after = text.slice(end, lineEnd === -1 ? n : lineEnd);
      comments.push({
        start,
        end,
        startLine,
        endLine,
        kind: "block",
        fullLineOnly: before.trim() === "" && after.trim() === "",
        text: text.slice(start, end),
      });
      continue;
    }
    i += 1;
  }
  return comments;
}

function extractPythonComments(text) {
  const starts = lineStartsOf(text);
  const comments = [];
  let i = 0;
  const n = text.length;
  if (text.startsWith("#!")) {
    const nl = text.indexOf("\n");
    i = nl === -1 ? n : nl + 1;
  }
  while (i < n) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const triple = text[i + 1] === ch && text[i + 2] === ch;
      if (triple) {
        i += 3;
        while (i < n && !(text[i] === ch && text[i + 1] === ch && text[i + 2] === ch)) {
          i += text[i] === "\\" ? 2 : 1;
        }
        i += 3;
      } else {
        i += 1;
        while (i < n && text[i] !== ch && text[i] !== "\n") {
          i += text[i] === "\\" ? 2 : 1;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "#") {
      const start = i;
      while (i < n && text[i] !== "\n") i += 1;
      const end = i;
      const startLine = offsetToLine(starts, start);
      const before = text.slice(starts[startLine - 1], start);
      comments.push({
        start,
        end,
        startLine,
        endLine: startLine,
        kind: "line",
        fullLineOnly: before.trim() === "",
        text: text.slice(start, end),
      });
      continue;
    }
    i += 1;
  }
  return comments;
}

function parseHeredocOperator(line, index) {
  if (line[index] !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") return null;
  let k = index + 2;
  const stripTabs = line[k] === "-";
  if (stripTabs) k += 1;
  while (k < line.length && (line[k] === " " || line[k] === "\t")) k += 1;
  const rest = line.slice(k);
  const match = /^(?:'([A-Za-z_][A-Za-z0-9_-]*)'|"([A-Za-z_][A-Za-z0-9_-]*)"|\\?([A-Za-z_][A-Za-z0-9_-]*))/.exec(rest);
  if (!match) return null;
  const delimiter = match[1] ?? match[2] ?? match[3];
  return { delimiter, stripTabs, nextIndex: k + match[0].length };
}

function extractShellComments(text) {
  const starts = lineStartsOf(text);
  const comments = [];
  const lines = text.split("\n");
  let inSingle = false;
  let inDouble = false;
  let paramDepth = 0;
  const pendingHeredocs = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (pendingHeredocs.length > 0) {
      const target = pendingHeredocs[0];
      const candidate = (target.stripTabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "");
      if (candidate === target.delimiter) pendingHeredocs.shift();
      continue;
    }
    if (idx === 0 && line.startsWith("#!")) continue;
    for (let j = 0; j < line.length; j += 1) {
      const c = line[j];
      if (!inSingle && c === "\\") { j += 1; continue; }
      if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (!inSingle) {
        if (c === "$" && line[j + 1] === "{") { paramDepth += 1; j += 1; continue; }
        if (paramDepth > 0 && c === "}") { paramDepth -= 1; continue; }
      }
      if (!inSingle && !inDouble && paramDepth === 0 && c === "<" && line[j + 1] === "<") {
        const heredoc = parseHeredocOperator(line, j);
        if (heredoc) {
          pendingHeredocs.push({ delimiter: heredoc.delimiter, stripTabs: heredoc.stripTabs });
          j = heredoc.nextIndex - 1;
          continue;
        }
      }
      if (c === "#" && !inSingle && !inDouble && paramDepth === 0) {
        const prev = j === 0 ? "" : line[j - 1];
        if (j === 0 || /[\s;|&()]/.test(prev)) {
          const before = line.slice(0, j);
          comments.push({
            start: starts[idx] + j,
            end: starts[idx] + line.length,
            startLine: idx + 1,
            endLine: idx + 1,
            kind: "line",
            fullLineOnly: before.trim() === "",
            text: line.slice(j),
          });
          break;
        }
      }
    }
  }
  return comments;
}

function isAllowedDirective(item, ext) {
  const trimmed = item.text.trim();
  if (item.startLine === 1 && trimmed.startsWith("#!")) return true;
  if (TS_EXTENSIONS.has(ext)) return TS_DIRECTIVE_RE.test(trimmed);
  if (ext === ".swift") return item.startLine === 1 && SWIFT_DIRECTIVE_RE.test(trimmed);
  if (ext === ".sh") return SHELL_DIRECTIVE_RE.test(trimmed);
  return false;
}

export function extractComments(text, filePath) {
  const ext = extname(filePath);
  let raw = [];
  if (TS_EXTENSIONS.has(ext)) raw = extractTsComments(text, filePath);
  else if (C_LIKE_EXTENSIONS.has(ext)) raw = extractCLikeComments(text, ext);
  else if (ext === ".py") raw = extractPythonComments(text);
  else if (ext === ".sh") raw = extractShellComments(text);

  const filtered = raw.filter((item) => !isAllowedDirective(item, ext));

  const blocks = [];
  for (const item of filtered) {
    const previous = blocks[blocks.length - 1];
    if (
      previous &&
      previous.kind === "line" &&
      item.kind === "line" &&
      previous.fullLineOnly &&
      item.fullLineOnly &&
      item.startLine === previous.endLine + 1
    ) {
      previous.endLine = item.endLine;
      previous.end = item.end;
      previous.lines.push(item.text);
    } else {
      blocks.push({
        startLine: item.startLine,
        endLine: item.endLine,
        start: item.start,
        end: item.end,
        kind: item.kind,
        fullLineOnly: item.fullLineOnly,
        lines: item.kind === "block" ? item.text.split("\n") : [item.text],
      });
    }
  }
  return blocks;
}

export function summarizeFileComments(text, filePath) {
  const blocks = extractComments(text, filePath);
  let lines = 0;
  let shedLines = 0;
  for (const block of blocks) {
    const span = block.endLine - block.startLine + 1;
    lines += span;
    if (block.fullLineOnly) shedLines += span;
  }
  return { blocks: blocks.length, lines, shedLines, details: blocks };
}

export function evaluateCommentRatchet(counts, recorded) {
  const failures = [];
  const notes = [];
  const next = {};
  let atBaseline = 0;

  for (const [filePath, stat] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!Object.hasOwn(recorded, filePath) && stat.lines > 0) {
      failures.push(
        `${filePath} has ${stat.lines} comment line(s) across ${stat.blocks} block(s); new or previously cleaned files must have 0 comments. Delete tautologies/stale comments, file a Linear issue for excuses, or move decision records to docs/adr/.`,
      );
    }
  }

  for (const filePath of Object.keys(recorded).sort()) {
    const was = recorded[filePath];
    const stat = counts.get(filePath);
    if (stat === undefined) {
      notes.push(`${filePath} is no longer counted (deleted, renamed, or excluded).`);
      continue;
    }
    if (stat.lines > was) {
      failures.push(
        `${filePath} grew from ${was} to ${stat.lines} comment line(s) (baseline in ${BASELINE_PATH}). Remove new comments or move architectural rationale into docs/adr/.`,
      );
    } else if (stat.lines === 0) {
      notes.push(`${filePath} now has 0 comments (was ${was} line(s)).`);
    } else if (stat.lines < was) {
      notes.push(`${filePath} shrank from ${was} to ${stat.lines} comment line(s).`);
    } else {
      atBaseline += 1;
    }
    if (stat.lines > 0) next[filePath] = Math.min(was, stat.lines);
  }

  return { failures, notes, next, atBaseline };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const update = args.has("--update");
  const init = args.has("--init");
  const stats = args.has("--stats");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const baselineFullPath = join(root, BASELINE_PATH);

  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\0");

  const counts = new Map();
  let totalBlocks = 0;
  let totalLines = 0;
  let totalShedLines = 0;
  let filesWithComments = 0;

  for (const filePath of listed) {
    if (!filePath || !isCheckedSourcePath(filePath) || !existsSync(join(root, filePath))) continue;
    const stat = summarizeFileComments(readFileSync(join(root, filePath), "utf8"), filePath);
    counts.set(filePath, stat);
    if (stat.lines > 0) {
      filesWithComments += 1;
      totalBlocks += stat.blocks;
      totalLines += stat.lines;
      totalShedLines += stat.shedLines;
    }
  }

  if (init) {
    const initial = {};
    for (const [filePath, stat] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (stat.lines > 0) initial[filePath] = stat.lines;
    }
    writeFileSync(baselineFullPath, `${JSON.stringify({ limit: 0, files: initial }, null, 2)}\n`);
    console.log(`comments baseline initialized (${Object.keys(initial).length} files, ${totalLines} comment lines, ${totalShedLines} full lines sheddable).`);
    return;
  }

  if (stats) {
    const byArea = new Map();
    for (const [filePath, stat] of counts) {
      const area = filePath.startsWith("tests/") ? "tests" : filePath.startsWith("scripts/") ? "scripts" : filePath.split("/").slice(0, 2).join("/");
      const row = byArea.get(area) ?? { files: 0, filesWithComments: 0, blocks: 0, lines: 0, shedLines: 0 };
      row.files += 1;
      if (stat.lines > 0) {
        row.filesWithComments += 1;
        row.blocks += stat.blocks;
        row.lines += stat.lines;
        row.shedLines += stat.shedLines;
      }
      byArea.set(area, row);
    }
    console.log(JSON.stringify({
      checkedFiles: counts.size,
      filesWithComments,
      totalBlocks,
      totalCommentLines: totalLines,
      totalSheddableFullLines: totalShedLines,
      byArea: Object.fromEntries([...byArea.entries()].sort((a, b) => b[1].lines - a[1].lines)),
    }, null, 2));
    return;
  }

  const { files: recorded } = JSON.parse(readFileSync(baselineFullPath, "utf8"));
  const { failures, notes, next, atBaseline } = evaluateCommentRatchet(counts, recorded);

  if (update) {
    writeFileSync(baselineFullPath, `${JSON.stringify({ limit: 0, files: next }, null, 2)}\n`);
    console.log(`comments baseline updated (${Object.keys(next).length} entries, ${totalLines} comment lines remaining, ${totalShedLines} full lines sheddable).`);
  } else if (notes.length > 0) {
    for (const note of notes) console.log(`note: ${note}`);
    console.log("Run node scripts/check-comments.mjs --update to lower or remove these baseline entries.");
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log(`comments ok (${counts.size} files checked, ${atBaseline} at baseline, ${totalLines} comment lines remaining)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
