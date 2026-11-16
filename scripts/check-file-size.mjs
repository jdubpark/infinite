#!/usr/bin/env node
// Ratchet on source file length. A new file must stay at or under the limit. A file already over the limit
// may not grow past its entry in scripts/file-size-baseline.json. Raising an entry is a hand edit in the same
// change, so a reviewer sees it. `--update` only lowers or removes entries; it never raises or adds one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const BASELINE = "scripts/file-size-baseline.json";
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".py", ".kt"]);
const SKIPPED_SEGMENTS = new Set(["node_modules", "fixtures", "vendor", "generated", "dist"]);

const update = process.argv.includes("--update");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const { limit, files: recorded } = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));

function isSourcePath(path) {
  if (!EXTENSIONS.has(extname(path)) || path.endsWith(".d.ts")) return false;
  return !path.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment));
}

// Same count as `wc -l`, plus one for a non-empty file whose last line has no newline.
function countLines(bytes) {
  let lines = 0;
  for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) lines += 1;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) lines += 1;
  return lines;
}

const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
}).split("\0");
const counts = new Map();
for (const path of listed) {
  if (!path || !isSourcePath(path) || !existsSync(join(root, path))) continue;
  counts.set(path, countLines(readFileSync(join(root, path))));
}

const failures = [];
const notes = [];
const next = {};
let atBaseline = 0;

for (const [path, lines] of counts) {
  if (!Object.hasOwn(recorded, path) && lines > limit) {
    failures.push(`${path} has ${lines} lines; a new file must stay at or under ${limit}. Split it into focused modules.`);
  }
}

for (const path of Object.keys(recorded).sort()) {
  const was = recorded[path];
  const lines = counts.get(path);
  if (lines === undefined) {
    notes.push(`${path} is no longer counted (deleted, renamed or excluded).`);
    continue;
  }
  if (lines > was) {
    failures.push(`${path} grew from ${was} to ${lines} lines (baseline in ${BASELINE}). Move the new code into its own module, or raise its baseline in the same change and say why in the pull request.`);
  } else if (lines <= limit) {
    notes.push(`${path} is at or under ${limit} lines now (${lines}).`);
  } else if (lines < was) {
    notes.push(`${path} shrank from ${was} to ${lines} lines.`);
  } else {
    atBaseline += 1;
  }
  if (lines > limit) next[path] = Math.min(was, lines);
}

// `next` is filled in sorted-key order, so its keys stay sorted in the written file.
if (update) {
  writeFileSync(join(root, BASELINE), `${JSON.stringify({ limit, files: next }, null, 2)}\n`);
  console.log(`file-size baseline updated (${Object.keys(next).length} entries).`);
} else if (notes.length > 0) {
  for (const note of notes) console.log(`note: ${note}`);
  console.log("Run node scripts/check-file-size.mjs --update to lower or remove these baseline entries.");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`file sizes ok (${counts.size} files checked, ${atBaseline} at baseline)`);
}
