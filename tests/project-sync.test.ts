import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { ProjectSync, ProjectSyncError } from "../packages/host/src/project-sync.js";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";
import { hashToken } from "../packages/host/src/config.js";
import type { Config } from "../packages/host/src/types.js";

function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const cloud = join(root, "cloud"); mkdirSync(cloud);
  const key = randomBytes(32);
  const keyFile = join(root, "key"); writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0, origin: "http://127.0.0.1:1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
    environment: "local", enableDemo: true, maxSessions: 24, agents: {},
    projects: [{ id: "example", name: "Example", path: cloud }],
    tokens: [{ id: "o", label: "o", role: "owner", hash: hashToken("x".repeat(40)) }],
  };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  return { root, laptop, cloud, config, key, sync: new ProjectSync(config, key) };
}

/** Push the laptop tree the way the service will: capture, upload missing blobs, commit. */
async function push(f: ReturnType<typeof fixture>, running = false, previous?: Awaited<ReturnType<typeof captureWorkspace>>) {
  const storeDir = join(f.root, "laptop-store");
  const manifest = await captureWorkspace({ roots: [f.laptop], cwd: f.laptop, storeDir, previous });
  const { generation } = f.sync.begin("example");
  const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
  for (const hash of await f.sync.missing("example", hashes))
    await f.sync.putBlob("example", hash, Buffer.from(await readWorkspaceBlob(storeDir, hash), "base64"));
  return { manifest, status: await f.sync.commit("example", generation, manifest, running) };
}

test("first push applies onto an empty cloud directory and records both manifests", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "README.md"), "hello\n");
    mkdirSync(join(f.laptop, "src")); writeFileSync(join(f.laptop, "src/index.ts"), "export const a = 1;\n", { mode: 0o644 });
    const { manifest, status } = await push(f);
    assert.equal(status.lastSyncedManifest, manifest.id);
    assert.equal(status.appliedManifest, manifest.id);
    assert.equal(status.pendingGeneration, undefined);
    assert.equal(readFileSync(join(f.cloud, "src/index.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(readFileSync(join(f.cloud, "README.md"), "utf8"), "hello\n");
    assert.deepEqual(readdirSync(dirname(f.cloud)).filter(n => n.includes("infinite-stage")), [], "stage directories are removed after publication");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a non-empty cloud directory with no applied manifest needs force", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.cloud, "existing.txt"), "cloud-only\n");
    writeFileSync(join(f.laptop, "README.md"), "hello\n");
    const { status } = await push(f);
    assert.equal(status.pendingGeneration?.reason, "cloud-changed");
    assert.equal(readFileSync(join(f.cloud, "existing.txt"), "utf8"), "cloud-only\n", "nothing is applied without force");
    await assert.rejects(f.sync.apply("example", { running: false }), (error: ProjectSyncError) => error.code === "cloud-changed");
    const applied = await f.sync.apply("example", { running: false, force: true });
    assert.equal(applied.pendingGeneration, undefined);
    assert.equal(existsSync(join(f.cloud, "existing.txt")), false);
    const previous = join(dirname(f.cloud), `.${basename(f.cloud)}.infinite-previous`);
    assert.equal(readFileSync(join(previous, "existing.txt"), "utf8"), "cloud-only\n", "the replaced tree is kept once");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a running cloud session keeps the generation pending; apply later succeeds", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, true, first.manifest);
    assert.equal(second.status.pendingGeneration?.reason, "session-running");
    assert.equal(second.status.pendingGeneration?.id, second.manifest.id);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "1\n", "files are untouched while a session runs");
    await assert.rejects(f.sync.apply("example", { running: true }), (error: ProjectSyncError) => error.code === "session-running");
    const applied = await f.sync.apply("example", { running: false });
    assert.equal(applied.appliedManifest, second.manifest.id);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "2\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("host-side edits after apply make the next apply refuse without force", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    writeFileSync(join(f.cloud, "agent-wrote.txt"), "cloud edit\n");
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, false, first.manifest);
    assert.equal(second.status.pendingGeneration?.reason, "cloud-changed");
    assert.equal(readFileSync(join(f.cloud, "agent-wrote.txt"), "utf8"), "cloud edit\n");
    const exported = await f.sync.exportTree("example");
    assert.ok(exported.entries.some(e => e.path === "agent-wrote.txt"), "export captures the live cloud tree");
    const forced = await f.sync.apply("example", { running: false, force: true });
    assert.equal(forced.appliedManifest, second.manifest.id);
    assert.equal(existsSync(join(f.cloud, "agent-wrote.txt")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("stale generations and missing content are refused", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const storeDir = join(f.root, "laptop-store");
    const manifest = await captureWorkspace({ roots: [f.laptop], cwd: f.laptop, storeDir });
    const stale = f.sync.begin("example");
    f.sync.begin("example");
    await assert.rejects(f.sync.commit("example", stale.generation, manifest, false), (error: ProjectSyncError) => error.code === "stale-generation");
    const current = f.sync.begin("example");
    await assert.rejects(f.sync.commit("example", current.generation, manifest, false), (error: ProjectSyncError) => error.code === "missing-content");
    assert.throws(() => f.sync.status("nope"), (error: ProjectSyncError) => error.code === "unknown-project");
    await assert.rejects(f.sync.missing("nope", []), (error: ProjectSyncError) => error.code === "unknown-project");
    assert.equal(existsSync(join(f.config.stateDir, "projects", "nope")), false, "unknown projects leave no state behind");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("recommitting the applied generation clears a stale pending marker", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    assert.equal((await push(f, true, first.manifest)).status.pendingGeneration?.reason, "session-running");
    const status = await f.sync.commit("example", f.sync.begin("example").generation, first.manifest, true);
    assert.equal(status.lastSyncedManifest, first.manifest.id);
    assert.equal(status.pendingGeneration, undefined, "the newest generation is already applied");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("read-only directories do not block later applies, and .infinite/ is carried across", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.laptop, "vendor")); writeFileSync(join(f.laptop, "vendor/lib.txt"), "v\n"); chmodSync(join(f.laptop, "vendor"), 0o555);
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    let last = await push(f);
    mkdirSync(join(f.cloud, ".infinite")); writeFileSync(join(f.cloud, ".infinite/state.json"), "{}\n");
    // The third apply replaces a previous tree that holds the read-only directory.
    for (const content of ["2\n", "3\n"]) {
      writeFileSync(join(f.laptop, "a.txt"), content);
      last = await push(f, false, last.manifest);
      assert.equal(last.status.appliedManifest, last.manifest.id);
    }
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "3\n");
    assert.equal(readFileSync(join(f.cloud, ".infinite/state.json"), "utf8"), "{}\n", "Infinite's own directory survives every apply");
    assert.deepEqual(readdirSync(dirname(f.cloud)).filter(n => n.includes("infinite-stage")), []);
  } finally {
    for (const entry of readdirSync(f.root, { withFileTypes: true, recursive: true })) if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
    rmSync(f.root, { recursive: true, force: true });
  }
});
