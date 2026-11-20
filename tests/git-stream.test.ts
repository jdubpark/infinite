import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobArgs, blobReader } from "../packages/host/src/git-stream.js";
import { teamGitArgs } from "../packages/host/src/team-workspace.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";

const ID40 = "a".repeat(40);
const SMALL = "0123456789";

function run(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

/** A repository with a 10-byte blob and a blob one byte over the 1 MiB limit. Built with git only; no launcher. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "git-stream-"));
  run(dir, "init", "-q", "--template=");
  run(dir, "config", "user.name", "Placeholder Author");
  run(dir, "config", "user.email", "placeholder@example.invalid");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "a.json"), SMALL);
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(1_048_577, 0x61));
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "fixture");
  return { dir, head: run(dir, "rev-parse", "HEAD") };
}

/**
 * A fake launcher prefix: a node script that records its argv and GIT_NO_LAZY_FETCH, waits for the release file,
 * then runs the git it was given. The release file is written by the caller.
 */
function fakePrefix(dir: string): { prefix: TeamCommand; record: string; release: string } {
  const record = join(dir, "record.json"), release = join(dir, "release"), script = join(dir, "prefix.mjs");
  writeFileSync(script, `
import { writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, lazy: process.env.GIT_NO_LAZY_FETCH ?? null }));
while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 20));
const result = spawnSync("git", argv.slice(1), { stdio: ["ignore", "inherit", "inherit"], env: process.env });
process.exitCode = result.status ?? 1;
`);
  return { prefix: { command: process.execPath, args: [script] }, record, release };
}

test("a blob read is one bounded form", async () => {
  // The form: one argument COMMIT:PATH after cat-file blob.
  assert.deepEqual(blobArgs(ID40, "docs/a.json"), ["cat-file", "blob", `${ID40}:docs/a.json`]);
  assert.deepEqual(blobArgs("b".repeat(64), "docs/a.json"), ["cat-file", "blob", `${"b".repeat(64)}:docs/a.json`]);

  // Refusals: each throws TypeError.
  const refusedIds = ["A".repeat(40), "a".repeat(39)];
  for (const id of refusedIds) assert.throws(() => blobArgs(id, "docs/a.json"), TypeError, `id ${id.length}`);
  const refusedPaths = ["../a", "a:b", ".", ".git/x", "x".repeat(301), "docs/a\u0001b"];
  for (const path of refusedPaths) assert.throws(() => blobArgs(ID40, path), TypeError, JSON.stringify(path));

  // A reader given a refused argument resolves failed and starts no child.
  const { dir, head } = makeRepo();
  try {
    const fake = fakePrefix(dir);
    writeFileSync(fake.release, "");
    const reader = blobReader(() => fake.prefix);
    assert.deepEqual(await reader.read(dir, head, "../a", new AbortController().signal), { state: "failed" });
    assert.deepEqual(await reader.read(dir, "A".repeat(40), "docs/a.json", new AbortController().signal), { state: "failed" });
    assert.equal(existsSync(fake.record), false, "a refused read must not start the prefix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a blob read streams within its limits", async () => {
  const { dir, head } = makeRepo();
  const signal = new AbortController().signal;
  try {
    // Results, with no prefix.
    const direct = blobReader(() => undefined);
    const small = await direct.read(dir, head, "docs/a.json", signal);
    assert.equal(small.state, "read");
    assert.deepEqual(small.state === "read" ? small.bytes : undefined, Buffer.from(SMALL));
    // Compare the state alone: a failing deepEqual on a megabyte of bytes makes node's assert diff exhaust memory.
    assert.equal((await direct.read(dir, head, "big.bin", signal)).state, "too-large");
    assert.deepEqual(await direct.read(dir, head, "docs/missing.json", signal), { state: "failed" });

    // The fake prefix records the six settings, then B1, and GIT_NO_LAZY_FETCH=1.
    const fake = fakePrefix(dir);
    writeFileSync(fake.release, "");
    const recorded = blobReader(() => fake.prefix);
    assert.equal((await recorded.read(dir, head, "docs/a.json", signal)).state, "read");
    const seen = JSON.parse(readFileSync(fake.record, "utf8")) as { argv: string[]; lazy: string | null };
    assert.deepEqual(seen.argv, ["git", ...teamGitArgs(dir, blobArgs(head, "docs/a.json"))]);
    assert.equal(seen.lazy, "1");
    rmSync(fake.release, { force: true });

    // A stalled read: the prefix waits for the release file, the timeout is 200 ms, and the stop refuses.
    const stalledFake = join(dir, "stalled");
    mkdirSync(stalledFake);
    const hold = fakePrefix(stalledFake);
    const stalled = blobReader(() => hold.prefix, { timeoutMs: 200, stop: () => false });
    const started = Date.now();
    try {
      assert.deepEqual(await stalled.read(dir, head, "docs/a.json", signal), { state: "failed" });
      assert.ok(Date.now() - started >= 150 && Date.now() - started < 5000, `answered after ${Date.now() - started} ms`);
      assert.equal(stalled.stalled(), 1);
      writeFileSync(hold.release, "");
      const deadline = Date.now() + 10_000;
      while (stalled.stalled() !== 0 && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
      assert.equal(stalled.stalled(), 0);
    } finally {
      writeFileSync(hold.release, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
