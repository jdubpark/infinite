import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/check-file-size.mjs", import.meta.url));

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "file-size-"));
  const init = spawnSync("git", ["init", "-q", "--template="], { cwd: repo, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  return repo;
}

function writeLines(repo: string, path: string, lines: number) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${Array.from({ length: lines }, () => "x").join("\n")}\n`);
}

function writeBaseline(repo: string, files: Record<string, number>) {
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "scripts/file-size-baseline.json"), `${JSON.stringify({ limit: 1000, files }, null, 2)}\n`);
}

function checkSize(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
}

test("a new file may be at most 1000 lines", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo, {});
    writeLines(repo, "src/at-limit.ts", 1000);
    const passing = checkSize(repo);
    assert.equal(passing.status, 0, passing.stdout + passing.stderr);

    writeLines(repo, "src/over-limit.ts", 1001);
    const failing = checkSize(repo);
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /^src\/over-limit\.ts has 1001 lines; a new file must stay at or under 1000\./m);
    assert.doesNotMatch(failing.stderr, /at-limit/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a baselined file may not grow, and --update only lowers its entry", () => {
  const repo = makeRepo();
  try {
    writeBaseline(repo, { "src/legacy.ts": 1200 });
    writeLines(repo, "src/legacy.ts", 1300);
    const grown = checkSize(repo);
    assert.equal(grown.status, 1);
    assert.match(grown.stderr, /src\/legacy\.ts grew from 1200 to 1300 lines/);

    const grownUpdate = checkSize(repo, "--update");
    assert.equal(grownUpdate.status, 1, "--update must not hide growth");
    const kept = JSON.parse(readFileSync(join(repo, "scripts/file-size-baseline.json"), "utf8"));
    assert.deepEqual(kept.files, { "src/legacy.ts": 1200 }, "--update must never raise an entry");

    writeLines(repo, "src/legacy.ts", 1100);
    const shrunk = checkSize(repo);
    assert.equal(shrunk.status, 0, shrunk.stdout + shrunk.stderr);
    assert.match(shrunk.stdout, /shrank from 1200 to 1100 lines/);
    assert.match(shrunk.stdout, /--update/);

    const updated = checkSize(repo, "--update");
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    const lowered = JSON.parse(readFileSync(join(repo, "scripts/file-size-baseline.json"), "utf8"));
    assert.deepEqual(lowered.files, { "src/legacy.ts": 1100 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
