import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherGrader, stopGrader } from "../packages/host/src/eval-grader.js";
import type { EvalGraderConfig } from "../packages/host/src/eval-config.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/grader-command.mjs", import.meta.url));
const JOB = "11111111-2222-4333-8444-555555555555";
const UID = process.getuid?.() ?? 0;
const OTHER_UID = UID + 1;
const sandboxes: string[] = [];

type Sandbox = { root: string; record: string };

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "grader-client-"));
  sandboxes.push(dir);
  const root = join(dir, "root");
  mkdirSync(root);
  chmodSync(root, 0o700);
  return { root, record: join(dir, "record.log") };
}

test.after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** The fixture as the launcher prefix. Extra flags go before the operation, as the fixture expects. */
function config(sb: Sandbox, extra: string[] = [], canaries: string[] = []): EvalGraderConfig {
  return {
    prefix: { command: process.execPath, args: [FIXTURE, "--root", sb.root, "--uid", String(UID), "--record", sb.record, ...extra] },
    root: sb.root,
    canaries,
  };
}

function grader(sb: Sandbox, options: { hostUid?: number; graceMs?: number } = { hostUid: OTHER_UID }, extra: string[] = [], canaries: string[] = []) {
  return launcherGrader(() => config(sb, extra, canaries), options);
}

function recordedCalls(sb: Sandbox): number {
  return existsSync(sb.record) ? readFileSync(sb.record, "utf8").split("\n").filter(Boolean).length : 0;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("the probe names every unsafe state", async () => {
  const sb = sandbox();
  assert.equal((await launcherGrader(() => undefined).probe([])).state, "not-configured");

  const exitOne = launcherGrader(() => ({ prefix: { command: process.execPath, args: ["-e", "process.exit(1)"] }, root: sb.root, canaries: [] }));
  assert.equal((await exitOne.probe([])).state, "unavailable");

  const exitSixtyFour = launcherGrader(() => ({ prefix: { command: process.execPath, args: ["-e", "process.exit(64)"] }, root: sb.root, canaries: [] }));
  assert.equal((await exitSixtyFour.probe([])).state, "misconfigured");

  // The default host uid is this process's, and the fixture runs as this process.
  assert.equal((await launcherGrader(() => config(sb)).probe([])).state, "misconfigured");

  chmodSync(sb.root, 0o755);
  assert.equal((await grader(sb).probe([])).state, "misconfigured");
  chmodSync(sb.root, 0o700);

  assert.equal((await grader(sb, { hostUid: OTHER_UID }, ["--ancestors-writable"]).probe([])).state, "misconfigured");
  assert.equal((await grader(sb, { hostUid: OTHER_UID }, ["--tools", "missing"]).probe([])).state, "misconfigured");

  const readableCanary = join(sb.root, "..", "canary-readable");
  writeFileSync(readableCanary, "secret");
  chmodSync(readableCanary, 0o644);
  assert.equal((await grader(sb, { hostUid: OTHER_UID }, [], [readableCanary]).probe([])).state, "exposed");

  if (UID !== 0) {
    const sealedCanary = join(sb.root, "..", "canary-sealed");
    writeFileSync(sealedCanary, "secret");
    chmodSync(sealedCanary, 0o000);
    assert.equal((await grader(sb, { hostUid: OTHER_UID }, [], [sealedCanary]).probe([])).state, "ready");
  }

  assert.equal((await grader(sb, { hostUid: OTHER_UID }, ["--metadata", "open"]).probe([])).state, "network-open");

  const ready = await grader(sb, { hostUid: OTHER_UID }).probe([]);
  assert.equal(ready.state, "ready");
  assert.equal(ready.uid, UID);
});

test("the host reads only reports, and only as the grader", async () => {
  const sb = sandbox();
  const g = grader(sb);
  const reports = join(sb.root, "jobs", JOB, "work", "reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "round-1.xml"), "<testsuite/>");

  const read = await g.read(JOB, "reports/round-1.xml", 1024);
  assert.deepEqual({ state: read.state, text: read.state === "read" ? read.bytes.toString() : null }, { state: "read", text: "<testsuite/>" });

  const outside = join(sb.root, "..", "outside.xml");
  writeFileSync(outside, "<testsuite/>");
  symlinkSync(outside, join(reports, "round-2.xml"));
  assert.deepEqual(await g.read(JOB, "reports/round-2.xml", 1024), { state: "missing" });

  writeFileSync(join(reports, "round-3.xml"), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.deepEqual(await g.read(JOB, "reports/round-3.xml", 8 * 1024 * 1024), { state: "too-large" });

  const before = recordedCalls(sb);
  assert.deepEqual(await g.read(JOB, "reports/../in/base.bundle", 1024), { state: "failed" });
  assert.deepEqual(await g.read(JOB, "../x", 1024), { state: "failed" });
  assert.equal(recordedCalls(sb), before, "a refused path spawns nothing");
});

test("a surviving grader process blocks the job", async () => {
  const sb = sandbox();
  const g = grader(sb);
  const row = (uid: number) => ({ pid: 9, parent: 1, group: 9, ruid: uid, euid: uid, born: "x", state: "S" });

  const started = Date.now();
  assert.equal(await stopGrader(g, UID, async () => [row(UID)]), "alive");
  assert.ok(Date.now() - started >= 1900, "three stops, one second apart");
  assert.equal(recordedCalls(sb), 3, "one stop per round");

  let calls = 0;
  const emptiesAfterSecond = async () => (++calls <= 2 ? [row(UID)] : []);
  assert.equal(await stopGrader(g, UID, emptiesAfterSecond), "stopped");

  assert.equal(await stopGrader(g, UID, async () => [row(OTHER_UID)]), "stopped", "another user's process does not count");
});

test("a call that never closes counts as failed", async () => {
  const sb = sandbox();
  const g = launcherGrader(() => config(sb, ["--hang", "2"]), { hostUid: OTHER_UID, graceMs: 200 });

  const first = await g.run(JOB, ".", 1, ["true"]);
  assert.equal(first.failed, true);

  const callsBefore = recordedCalls(sb);
  const second = await g.run(JOB, ".", 1, ["true"]);
  assert.equal(second.failed, true);
  assert.equal(recordedCalls(sb), callsBefore, "no call starts while the first one stays open");
});

test("digest reads the bundle's hash", async () => {
  const sb = sandbox();
  const bundleDir = join(sb.root, "jobs", JOB, "in");
  mkdirSync(bundleDir, { recursive: true });
  const bundle = join(bundleDir, "base.bundle");
  const bytes = Buffer.from("bundle bytes");
  writeFileSync(bundle, bytes);

  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(await grader(sb).digest(JOB), { state: "read", sha256: expected });

  rmSync(bundle);
  assert.deepEqual(await grader(sb).digest(JOB), { state: "missing" });

  writeFileSync(bundle, bytes);
  assert.deepEqual(await grader(sb, { hostUid: OTHER_UID }, ["--digest-text", "not-hex"]).digest(JOB), { state: "failed" });
});
