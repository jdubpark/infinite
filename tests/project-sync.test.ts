import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { ProjectSync, ProjectSyncError } from "../packages/host/src/project-sync.js";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";
import { hashToken } from "../packages/host/src/config.js";
import type { Config } from "../packages/host/src/types.js";

function fixture(sync?: Config["sync"]) {
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const cloud = join(root, "cloud"); mkdirSync(cloud);
  const key = randomBytes(32);
  const keyFile = join(root, "key"); writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0, origin: "http://127.0.0.1:1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
    environment: "local", enableDemo: true, maxSessions: 24, agents: {}, ...(sync ? { sync } : {}),
    projects: [{ id: "example", name: "Example", path: cloud }],
    tokens: [{ id: "o", label: "o", role: "owner", hash: hashToken("x".repeat(40)) }],
  };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  return { root, laptop, cloud, config, key, sync: new ProjectSync(config, key) };
}

const busy = async () => true, idle = async () => false;

/** Make every rename into `destination` that `matches` fail, as a crash between steps would leave it. */
function failRenames(destination: string, matches: (from: string) => boolean) {
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const original = fsp.rename;
  fsp.rename = (async (from: string, to: string) => {
    if (to === destination && matches(String(from))) throw Object.assign(new Error("injected failure"), { code: "EIO" });
    return original(from, to);
  }) as typeof fsp.rename;
  syncBuiltinESMExports();
  return () => { fsp.rename = original; syncBuiltinESMExports(); };
}
const stages = (f: { cloud: string }) => readdirSync(dirname(f.cloud)).filter(n => n.includes("infinite-stage"));

/** Push the laptop tree the way the service will: capture, upload missing blobs, commit. */
async function push(f: ReturnType<typeof fixture>, running = false, previous?: Awaited<ReturnType<typeof captureWorkspace>>) {
  const storeDir = join(f.root, "laptop-store");
  const manifest = await captureWorkspace({ roots: [f.laptop], cwd: f.laptop, storeDir, previous });
  const { generation } = f.sync.begin("example");
  const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
  for (const hash of await f.sync.missing("example", hashes))
    await f.sync.putBlob("example", hash, Buffer.from(await readWorkspaceBlob(storeDir, hash), "base64"));
  return { manifest, status: await f.sync.commit("example", generation, manifest, running ? busy : idle) };
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

test("a setgid parent or sync.sharedGroup makes the applied tree group-writable; otherwise laptop modes stay", async () => {
  const mode = (path: string) => statSync(path).mode & 0o7777;
  for (const setup of ["setgid", "configured", "plain"] as const) {
    const f = fixture(setup === "configured" ? { sharedGroup: true } : undefined);
    try {
      // New directories take the parent's group; the setgid bit survives chmod only for a group the user is in.
      chownSync(f.root, process.getuid!(), process.getgid!());
      if (setup === "setgid") {
        // The Ubuntu template's workspaces directory is setgid.
        chmodSync(f.root, 0o2700);
        assert.equal(mode(f.root) & 0o2000, 0o2000, "the fixture parent carries the setgid bit");
      }
      mkdirSync(join(f.laptop, "src"));
      writeFileSync(join(f.laptop, "src/index.ts"), "export {};\n");
      writeFileSync(join(f.laptop, "run.sh"), "#!/bin/sh\n");
      // Set laptop modes explicitly so a restrictive umask (the server stage uses 077) cannot change the fixture.
      chmodSync(join(f.laptop, "src"), 0o755); chmodSync(join(f.laptop, "src/index.ts"), 0o644); chmodSync(join(f.laptop, "run.sh"), 0o755);
      const first = await push(f);
      writeFileSync(join(f.laptop, "src/index.ts"), "export const a = 1;\n");
      // The second apply replaces a tree with shared directories.
      const second = await push(f, false, first.manifest);
      assert.equal(second.status.appliedManifest, second.manifest.id, setup);
      const shared = setup !== "plain";
      assert.deepEqual([mode(f.cloud), mode(join(f.cloud, "src")), mode(join(f.cloud, "src/index.ts")), mode(join(f.cloud, "run.sh"))],
        shared ? [0o2770, 0o2770, 0o660, 0o770] : [mode(f.laptop), 0o755, 0o644, 0o755], setup);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("a non-empty cloud directory with no applied manifest needs force", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.cloud, "existing.txt"), "cloud-only\n");
    writeFileSync(join(f.laptop, "README.md"), "hello\n");
    const { status } = await push(f);
    assert.equal(status.pendingGeneration?.reason, "cloud-changed");
    assert.equal(readFileSync(join(f.cloud, "existing.txt"), "utf8"), "cloud-only\n", "nothing is applied without force");
    await assert.rejects(f.sync.apply("example", { running: idle }), (error: ProjectSyncError) => error.code === "cloud-changed");
    const applied = await f.sync.apply("example", { running: idle, force: true });
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
    await assert.rejects(f.sync.apply("example", { running: busy }), (error: ProjectSyncError) => error.code === "session-running");
    const applied = await f.sync.apply("example", { running: idle });
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
    const forced = await f.sync.apply("example", { running: idle, force: true });
    assert.equal(forced.appliedManifest, second.manifest.id);
    assert.equal(existsSync(join(f.cloud, "agent-wrote.txt")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a forced apply restores laptop content over cloud edits even when the generation is already applied", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "laptop\n");
    const { manifest } = await push(f);
    writeFileSync(join(f.cloud, "a.txt"), "cloud edit\n");
    const forced = await f.sync.apply("example", { force: true, running: idle });
    assert.equal(forced.appliedManifest, manifest.id);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "laptop\n");
    const previous = join(dirname(f.cloud), `.${basename(f.cloud)}.infinite-previous`);
    assert.equal(readFileSync(join(previous, "a.txt"), "utf8"), "cloud edit\n", "the replaced cloud edit is kept once");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an apply links unchanged files from the verified tree, a forced apply rewrites them, and edits to linked files still count", async () => {
  const f = fixture();
  try {
    const previous = join(dirname(f.cloud), `.${basename(f.cloud)}.infinite-previous`);
    writeFileSync(join(f.laptop, "a.txt"), "1\n"); writeFileSync(join(f.laptop, "b.txt"), "same\n");
    const first = await push(f);
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, false, first.manifest);
    assert.equal(second.status.appliedManifest, second.manifest.id);
    assert.equal(statSync(join(f.cloud, "b.txt")).ino, statSync(join(previous, "b.txt")).ino, "the unchanged file is a hard link into the retired tree");
    assert.notEqual(statSync(join(f.cloud, "a.txt")).ino, statSync(join(previous, "a.txt")).ino);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "2\n");
    // An in-place cloud edit of a linked file, same size, is still drift.
    writeFileSync(join(f.cloud, "b.txt"), "edit\n");
    writeFileSync(join(f.laptop, "a.txt"), "3\n");
    const third = await push(f, false, second.manifest);
    assert.equal(third.status.pendingGeneration?.reason, "cloud-changed");
    const forced = await f.sync.apply("example", { running: idle, force: true });
    assert.equal(forced.appliedManifest, third.manifest.id);
    assert.equal(readFileSync(join(f.cloud, "b.txt"), "utf8"), "same\n", "a forced apply restores laptop content");
    assert.notEqual(statSync(join(f.cloud, "b.txt")).ino, statSync(join(previous, "b.txt")).ino, "a forced apply never links cloud files");
    assert.equal(readFileSync(join(previous, "b.txt"), "utf8"), "edit\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failure between the two renames puts the live tree and .infinite/ back", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    mkdirSync(join(f.cloud, ".infinite")); writeFileSync(join(f.cloud, ".infinite/state.json"), "cloud\n");
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    // The live tree has moved aside; publishing the new root fails.
    const restore = failRenames(f.cloud, from => from.includes(".infinite-stage-"));
    try {
      await assert.rejects(push(f, false, first.manifest), (error: ProjectSyncError) => error.code === "apply-failed" && error.category === "other");
    } finally { restore(); }
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "1\n");
    assert.equal(readFileSync(join(f.cloud, ".infinite/state.json"), "utf8"), "cloud\n");
    assert.deepEqual(stages(f), []);
    assert.equal(f.sync.status("example").pendingGeneration?.reason, "apply-failed");
    const applied = await f.sync.apply("example", { running: idle });
    assert.equal(applied.pendingGeneration, undefined);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "2\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an apply stopped between the two renames is recovered when the store starts", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    mkdirSync(join(f.cloud, ".infinite")); writeFileSync(join(f.cloud, ".infinite/state.json"), "cloud\n");
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    // Neither the publication nor the rollback reaches the project path, as if the host stopped after the first rename.
    const restore = failRenames(f.cloud, () => true);
    try { await assert.rejects(push(f, false, first.manifest)); } finally { restore(); }
    assert.equal(existsSync(f.cloud), false, "the project directory is missing");
    assert.equal(stages(f).length, 1, "the stage still holds the carried .infinite/");
    // A restarted API restores the previous copy and the carried directory, then removes the stage.
    new ProjectSync(f.config, f.key);
    const deadline = Date.now() + 5000;
    while ((existsSync(f.cloud) ? stages(f).length : 1) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "1\n");
    assert.equal(readFileSync(join(f.cloud, ".infinite/state.json"), "utf8"), "cloud\n");
    assert.deepEqual(stages(f), []);
    const applied = await f.sync.apply("example", { running: idle });
    assert.equal(applied.pendingGeneration, undefined);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "2\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an apply restores a missing project directory from its previous copy before it starts", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, false, first.manifest);
    const previous = join(dirname(f.cloud), `.${basename(f.cloud)}.infinite-previous`);
    // A stop right after the live tree moved aside, with no stage left to clean up.
    rmSync(previous, { recursive: true, force: true });
    renameSync(f.cloud, previous);
    writeFileSync(join(f.laptop, "a.txt"), "3\n");
    const third = await push(f, false, second.manifest);
    assert.equal(third.status.appliedManifest, third.manifest.id);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "3\n");
    assert.equal(readFileSync(join(previous, "a.txt"), "utf8"), "2\n", "the restored tree was the one replaced");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("sockets and FIFOs are left out of laptop captures and cloud scans, and the host counts them", async () => {
  const f = fixture();
  const servers: Server[] = [];
  const socket = async (path: string) => { const server = createServer(); servers.push(server); await new Promise<void>(resolve => server.listen(path, resolve)); };
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    mkdirSync(join(f.laptop, ".git")); await socket(join(f.laptop, ".git/fsmonitor--daemon.ipc"));
    execFileSync("mkfifo", [join(f.laptop, "pipe")]);
    const skipped: string[] = [];
    const manifest = await captureWorkspace({ roots: [f.laptop], cwd: f.laptop, storeDir: join(f.root, "laptop-store"), onSkipped: path => skipped.push(path) });
    assert.deepEqual(skipped.sort(), [".git/fsmonitor--daemon.ipc", "pipe"]);
    assert.ok(!manifest.entries.some(e => e.path === "pipe" || e.path.endsWith(".ipc")));
    const first = await push(f);
    assert.equal(first.status.appliedManifest, first.manifest.id);
    // A stale dev-server socket in the cloud tree neither blocks the drift scan nor counts as a change.
    await socket(join(f.cloud, "dev.sock"));
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, false, first.manifest);
    assert.equal(second.status.appliedManifest, second.manifest.id);
    assert.equal(second.status.skipped, 1);
    await f.sync.exportTree("example");
    assert.equal(f.sync.status("example").skipped, undefined, "the new tree holds no special file");
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    rmSync(f.root, { recursive: true, force: true });
  }
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
    await assert.rejects(f.sync.readBlob("nope", "0".repeat(64)), (error: ProjectSyncError) => error.code === "unknown-project");
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
    const status = await f.sync.commit("example", f.sync.begin("example").generation, first.manifest, busy);
    assert.equal(status.lastSyncedManifest, first.manifest.id);
    assert.equal(status.pendingGeneration, undefined, "the newest generation is already applied");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a recapture of unchanged content is marked applied without replacing the tree", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    const previous = join(dirname(f.cloud), `.${basename(f.cloud)}.infinite-previous`);
    const before = { tree: statSync(f.cloud).ino, previous: statSync(previous).ino };
    const second = await push(f, true);
    assert.notEqual(second.manifest.id, first.manifest.id, "a new capture carries a new id");
    assert.equal(second.status.appliedManifest, second.manifest.id);
    assert.equal(second.status.pendingGeneration, undefined, "nothing waits on the running session");
    assert.equal(second.status.appliedAt, first.status.appliedAt, "appliedAt stays the time the tree was published");
    assert.deepEqual({ tree: statSync(f.cloud).ino, previous: statSync(previous).ino }, before, "neither the tree nor the retired copy was swapped");
    assert.deepEqual(readdirSync(dirname(f.cloud)).filter(n => n.includes("infinite-stage")), []);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "1\n");
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

test("symlinks the host wrote do not count as cloud changes", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    symlinkSync("./a.txt", join(f.laptop, "dot"));
    symlinkSync(join(f.laptop, "a.txt"), join(f.laptop, "absolute"));
    const first = await push(f);
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, false, first.manifest);
    assert.equal(second.status.pendingGeneration, undefined);
    assert.equal(second.status.appliedManifest, second.manifest.id);
    assert.equal(readFileSync(join(f.cloud, "dot"), "utf8"), "2\n");
    assert.equal(readFileSync(join(f.cloud, "absolute"), "utf8"), "2\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("sync refuses a project path that holds the host's own state, even with force", async () => {
  const f = fixture();
  const previous = join(dirname(f.root), `.${basename(f.root)}.infinite-previous`);
  try {
    const sync = new ProjectSync({ ...f.config, projects: [{ id: "example", name: "Example", path: f.root }] }, f.key);
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    // A running session keeps the generation pending without touching the tree.
    await push({ ...f, sync }, true);
    const refused = (error: ProjectSyncError) => error.code === "invalid-manifest" && error.status === 500;
    await assert.rejects(sync.apply("example", { running: idle, force: true }), refused);
    await assert.rejects(sync.apply("example", { running: idle }), refused);
    await assert.rejects(sync.exportTree("example"), refused);
    assert.ok(existsSync(join(f.config.stateDir, "projects/example/sync/received.sealed")), "the state directory stays in place");
    assert.equal(existsSync(previous), false);
  } finally { rmSync(previous, { recursive: true, force: true }); rmSync(f.root, { recursive: true, force: true }); }
});

test("the cloud .infinite/ wins over a laptop copy", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.laptop, ".infinite")); writeFileSync(join(f.laptop, ".infinite/laptop.json"), "{}\n");
    mkdirSync(join(f.cloud, ".infinite")); writeFileSync(join(f.cloud, ".infinite/state.json"), "cloud\n");
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const { manifest, status } = await push(f);
    assert.equal(status.appliedManifest, manifest.id);
    assert.equal(readFileSync(join(f.cloud, ".infinite/state.json"), "utf8"), "cloud\n");
    assert.equal(existsSync(join(f.cloud, ".infinite/laptop.json")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed apply keeps the newest generation pending with a sanitized category", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, true, first.manifest);
    // The next generation fails while the host scans a cloud file it cannot read.
    writeFileSync(join(f.cloud, "unreadable.txt"), "x\n", { mode: 0o000 });
    writeFileSync(join(f.laptop, "a.txt"), "3\n");
    const refusedScan = (error: ProjectSyncError) => error.code === "apply-failed" && error.category === "permission" && !error.message.includes(f.root);
    await assert.rejects(push(f, false, second.manifest), refusedScan);
    let status = f.sync.status("example");
    assert.equal(status.pendingGeneration?.reason, "apply-failed");
    assert.equal(status.pendingGeneration?.category, "permission");
    assert.equal(status.pendingGeneration?.id, status.lastSyncedManifest, "the marker names the newest generation");
    assert.ok(status.pendingGeneration?.message && !status.pendingGeneration.message.includes(f.root), "the message never names a host path");
    // A forced apply that fails while staging keeps the marker for the newest generation.
    await assert.rejects(f.sync.apply("example", { running: busy }), (error: ProjectSyncError) => error.code === "session-running");
    chmodSync(f.root, 0o500);
    await assert.rejects(f.sync.apply("example", { running: idle, force: true }), (error: ProjectSyncError) => error.code === "apply-failed" && error.category === "permission");
    assert.equal(f.sync.applying("example"), false, "a failed publication does not keep refusing new sessions");
    status = f.sync.status("example");
    assert.deepEqual([status.pendingGeneration?.reason, status.pendingGeneration?.category], ["apply-failed", "permission"]);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "1\n");
    // Once the cause is fixed, an explicit apply clears the marker.
    chmodSync(f.root, 0o700);
    const applied = await f.sync.apply("example", { running: idle, force: true });
    assert.equal(applied.pendingGeneration, undefined);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "3\n");
  } finally { chmodSync(f.root, 0o700); rmSync(f.root, { recursive: true, force: true }); }
});
