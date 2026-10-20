import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { captureWorkspace, encodeChunkBatch } from "../packages/host/src/workspace-checkpoint.js";
import { uploadMissingChunks, type ChunkTransport } from "../packages/host/src/chunk-upload.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { inProcessHost, startHost, waitFor, type Host } from "./helpers.js";
import { fixture as teamFixture } from "./team-fixture.js";

type Api = Pick<Host, "origin" | "tokens" | "fetchApi">;

test("owner CLI resolves distinct home-relative projects without falling back to the paired project", async () => {
  const host = await inProcessHost();
  try {
    const home = join(host.root, "home");
    host.config.sync = { homeDir: home, sharedGroup: true };
    const resolved = await host.fetchApi("/projects/resolve", "owner", { path: "Projects/sample" });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.path, join(home, "Projects", "sample"));
    assert.equal(statSync(join(home, "Projects")).mode & 0o030, 0o010, "agents can traverse intermediate folders but cannot rename project roots");
    const again = await host.fetchApi("/projects/resolve", "owner", { path: "Projects/sample" });
    assert.equal(again.body.id, resolved.body.id);
    const other = await host.fetchApi("/projects/resolve", "owner", { path: "Work/sample" });
    assert.equal(other.status, 200);
    assert.notEqual(other.body.id, resolved.body.id);
    assert.notEqual(resolved.body.id, "rehearsal");
    assert.equal((await host.fetchApi("/projects/resolve", "viewer", { path: "Projects/denied" })).status, 403);
    assert.equal((await host.fetchApi("/projects/resolve", "controller", { path: "Projects/denied" })).status, 403);
    for (const path of ["", "../escape", "Projects/../escape", "/absolute", ".ssh", "Projects//sample", "Projects/sample/"])
      assert.equal((await host.fetchApi("/projects/resolve", "owner", { path })).status, 400, path);
    symlinkSync(host.root, join(home, "alias"));
    assert.equal((await host.fetchApi("/projects/resolve", "owner", { path: "alias/escape" })).status, 400);
    mkdirSync(join(home, "Shared"), { mode: 0o700 }); chmodSync(join(home, "Shared"), 0o2770);
    assert.equal((await host.fetchApi("/projects/resolve", "owner", { path: "Shared/new/sample" })).status, 400, "an agent-writable ancestor could swap new folders before their modes are set");
    assert.equal(existsSync(join(home, "Shared", "new")), false);
    mkdirSync(join(home, "Shared", "old", "sample"), { recursive: true });
    assert.equal((await host.fetchApi("/projects/resolve", "owner", { path: "Shared/old/sample" })).status, 400, "an existing folder does not skip the ancestor check");
    assert.equal((await host.fetchApi("/projects/resolve", "owner", { path: "Projects/sample/nested" })).status, 409, "overlapping sync roots cannot bypass each other's running-session fence");
    const login = await host.fetchApi("/login", null, { token: host.tokens.owner }, { Origin: host.config.origin });
    assert.equal(login.status, 200);
    assert.equal((await host.fetchApi("/projects/resolve", null, { path: "Projects/browser" }, { Cookie: login.headers.get("set-cookie")!.split(";")[0], Origin: host.config.origin })).status, 403);
  } finally { await host.stop(); }
});

test("mirrored project IDs are readable, collision-safe, persistent, and retain legacy IDs", async () => {
  const outside = realpathSync(mkdtempSync("/tmp/inf-mirror-ids-"));
  const home = join(outside, "home"), configured = join(outside, "configured");
  mkdirSync(configured);
  const host = await startHost({ config: { sync: { homeDir: home }, projects: [{ id: "sample", name: "Configured", path: configured }] } });
  const suffix = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 8);
  const resolveId = async (path: string) => (await host.fetchApi("/projects/resolve", "owner", { path })).body.id;
  try {
    assert.equal(await resolveId("Projects/Sample"), `sample-${suffix("Projects/Sample")}`, "a configured ID is never taken");
    assert.equal(await resolveId("Apps/Sample/codebase"), "sample-codebase", "three components keep the parent as a prefix");
    assert.equal(await resolveId("code"), "code");
    assert.equal(await resolveId("Other/Sample"), `sample-${suffix("Other/Sample")}`);
    const capabilities = (await host.fetchApi("/me")).body.capabilities;
    assert.deepEqual([capabilities.workspaceMirror, capabilities.mirrorForget], [1, 1], "older CLIs keep the version 1 mapping contract");

    const legacyPath = "Old/legacy";
    const legacyId = `folder-${createHash("sha256").update(legacyPath).digest("hex").slice(0, 32)}`;
    await host.stopApi();
    writeSealed(join(host.config.stateDir, "mirrored-projects.sealed"), readFileSync(host.config.keyFile), "mirrored-projects", [legacyPath]);
    await host.start();
    assert.equal(await resolveId(legacyPath), legacyId, "legacy mappings keep their original IDs after restart");
    assert.equal(await resolveId("Work/Persisted"), "persisted");
    const stored = unseal<{ version: number; entries: { path: string; id: string }[] }>(readFileSync(host.config.keyFile), "mirrored-projects", readFileSync(join(host.config.stateDir, "mirrored-projects.sealed"), "utf8"));
    assert.equal(stored.version, 2, "the next mutation upgrades storage to version 2");
    assert.deepEqual(stored.entries.map(entry => entry.id), [legacyId, "persisted"]);
    await host.stopApi(); await host.start();
    assert.equal(await resolveId("Work/Persisted"), "persisted", "IDs are restored from storage after restart");
    assert.equal(await resolveId(legacyPath), legacyId);
  } finally { await host.stop(); rmSync(outside, { recursive: true, force: true }); }
});

test("forget tombstones a mapping, reserves its ID for other folders, and allows the same folder to reclaim it", async () => {
  const host = await inProcessHost();
  try {
    host.config.sync = { homeDir: join(host.root, "mirror-home") };
    const first = await host.fetchApi("/projects/resolve", "owner", { path: "Projects/Shared" });
    const forgotten = await host.fetchApi(`/projects/${first.body.id}/mirror`, "owner", undefined, {}, "DELETE");
    assert.equal(forgotten.status, 200);
    assert.equal(forgotten.body.path, first.body.path);
    assert.ok(existsSync(first.body.path));
    assert.equal((await host.fetchApi(`/projects/${first.body.id}`)).status, 404);
    assert.equal((await host.fetchApi("/projects/resolve", "owner", { path: "Work/Shared" })).body.id,
      `shared-${createHash("sha256").update("Work/Shared").digest("hex").slice(0, 8)}`);
    assert.equal((await host.fetchApi("/projects/resolve", "owner", { path: "Projects/Shared" })).body.id, first.body.id);
    assert.equal((await host.fetchApi("/projects/rehearsal/mirror", "owner", undefined, {}, "DELETE")).body.code, "project-not-mirrored");

    const session = randomUUID();
    assert.equal((await host.fetchApi("/sessions", "owner", { requestId: session, provider: "demo", projectId: first.body.id, title: "Hold mirror", prompt: "" })).status, 201);
    await waitFor(() => host.fetchApi(`/sessions/${session}`), result => ["starting", "running"].includes(result.body.status));
    const refused = await host.fetchApi(`/projects/${first.body.id}/mirror`, "owner", undefined, {}, "DELETE");
    assert.deepEqual([refused.status, refused.body.code], [409, "session-running"]);
    assert.equal((await host.fetchApi(`/sessions/${session}/stop`, "owner", { requestId: randomUUID() })).status, 200);
    await waitFor(() => host.fetchApi(`/sessions/${session}`), result => result.body.status === "exited");
  } finally { await host.stop(); }
});

test("mirroring refuses a destination overlapping a project teamwork folder", async () => {
  const host = await inProcessHost();
  try {
    host.config.sync = { homeDir: join(host.root, "mirror-home") };
    host.config.projects.push({ id: "team-project", name: "Team", path: join(host.root, "team-cloud"), teamworkDir: join(host.config.sync.homeDir, "Projects", "Team") });
    const result = await host.fetchApi("/projects/resolve", "owner", { path: "Projects/Team/repo" });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /teamwork folder/);
  } finally { await host.stop(); }
});

test("forget refuses a mirrored project with an unfinished team run", { timeout: 60000 }, async () => {
  const home = realpathSync(mkdtempSync("/tmp/inf-mirror-team-"));
  const repository = join(home, "Projects", "team");
  mkdirSync(repository, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  git("init", "--initial-branch=main");
  writeFileSync(join(repository, "README.md"), "Mirrored team fixture\n");
  git("add", "README.md");
  git("-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial mirrored fixture");
  const run = await teamFixture("lifecycle", undefined, { sync: { homeDir: home } });
  try {
    const host = run.host;
    const mapped = await host.fetchApi("/projects/resolve", "owner", { path: "Projects/team" });
    assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
    const current = (await host.fetchApi(`/projects/${mapped.body.id}/team`, "owner")).body;
    const enrolled = await host.fetchApi(`/projects/${mapped.body.id}/team`, "owner", { requestId: randomUUID(), revision: current.revision, team: { checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }] } }, {}, "PUT");
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
    const started = await host.fetchApi("/teams", "owner", { ...run.create(), projectId: mapped.body.id });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const refused = await host.fetchApi(`/projects/${mapped.body.id}/mirror`, "owner", undefined, {}, "DELETE");
    assert.deepEqual([refused.status, refused.body.code], [409, "project-team-active"]);
    assert.equal((await host.fetchApi("/me")).body.projects.some((project: { id: string }) => project.id === mapped.body.id), true, "a refused forget keeps the mapping");
  } finally { await run.close(); rmSync(home, { recursive: true, force: true }); }
});

const putChunk = (host: Api, hash: string, body: Buffer) => fetch(`${host.origin}/api/projects/rehearsal/sync/blob/${hash}`, {
  method: "PUT", headers: { Authorization: `Bearer ${host.tokens.owner}`, "Content-Type": "application/octet-stream" }, body,
});

const putBatch = (host: Api, body: Buffer) => fetch(`${host.origin}/api/projects/rehearsal/sync/blobs`, {
  method: "PUT", headers: { Authorization: `Bearer ${host.tokens.owner}`, "Content-Type": "application/octet-stream" }, body,
});
const ok = async (response: Response) => { assert.equal(response.status, 200, await response.text()); };
/** The CLI's transport over the real routes; `batches` counts batch requests, and `legacy` answers them as a host without the route would. */
function transport(host: Api, counts = { batches: 0, singles: 0 }, legacy = false): ChunkTransport {
  return {
    has: async hashes => (await host.fetchApi("/projects/rehearsal/sync/has", "owner", { hashes })).body.missing,
    putBatch: async body => {
      counts.batches += 1;
      if (legacy) return "unsupported";
      await ok(await putBatch(host, body));
    },
    put: async (hash, bytes) => { counts.singles += 1; await ok(await putChunk(host, hash, bytes)); },
  };
}

/** Capture the laptop tree, begin a generation, and upload the chunks the host lacks. */
async function upload(host: Api, laptop: string, storeDir: string, chunks: ChunkTransport = transport(host)) {
  const manifest = await captureWorkspace({ roots: [laptop], cwd: laptop, storeDir });
  const begin = await host.fetchApi("/projects/rehearsal/sync/begin", "owner", {});
  assert.equal(begin.status, 200);
  await uploadMissingChunks({ storeDir, hashes: manifest.entries.flatMap(e => e.chunks ?? []), transport: chunks });
  return { manifest, generation: begin.body.generation as string };
}

async function pushTree(host: Api, laptop: string, storeDir: string) {
  const { manifest, generation } = await upload(host, laptop, storeDir);
  return { manifest, commit: await host.fetchApi("/projects/rehearsal/sync/commit", "owner", { generation, manifest }) };
}

test("sync routes receive a laptop tree, hold it while a session runs, and apply on request", { timeout: 60000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-api-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const storeDir = join(root, "store");
  try {
    assert.equal((await host.fetchApi("/projects/rehearsal", "viewer")).status, 200);
    assert.equal((await host.fetchApi("/projects/rehearsal/sync/begin", "controller", {})).status, 403);
    // Authorization runs before the manifest parser: a viewer's malformed body is refused, never parsed.
    const unparsed = await fetch(`${host.origin}/api/projects/rehearsal/sync/commit`, {
      method: "POST", headers: { Authorization: `Bearer ${host.tokens.viewer}`, "Content-Type": "application/json" }, body: "{",
    });
    assert.equal(unparsed.status, 403);
    // A browser owner can read sync status but cannot move workspace content.
    const login = await fetch(`${host.origin}/api/login`, {
      method: "POST", headers: { Origin: host.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: host.tokens.owner }),
    });
    const browser = { Cookie: login.headers.get("set-cookie")!.split(";")[0], Origin: host.origin, "Content-Type": "application/json" };
    assert.equal((await fetch(`${host.origin}/api/projects/rehearsal`, { headers: browser })).status, 200);
    const absent = "0".repeat(64);
    for (const [method, route] of [["POST", "begin"], ["POST", "has"], ["PUT", `blob/${absent}`], ["PUT", "blobs"], ["GET", `blob/${absent}`], ["POST", "commit"], ["POST", "export"]])
      assert.equal((await fetch(`${host.origin}/api/projects/rehearsal/sync/${route}`, { method, headers: browser, body: method === "GET" ? undefined : "{}" })).status, 403, `${method} ${route}`);
    const missing = await host.fetchApi(`/projects/rehearsal/sync/blob/${absent}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "missing-content");
    const mismatched = await putChunk(host, absent, Buffer.from("other bytes\n"));
    assert.equal(mismatched.status, 400);
    assert.equal((await mismatched.json()).code, "invalid-manifest");
    assert.equal((await putChunk(host, absent, Buffer.alloc(1024 * 1024 + 1))).status, 413);
    // A body one byte over the chunk bound is refused as too large even when its hash is right.
    const oversize = Buffer.alloc(256 * 1024 + 1);
    assert.equal((await putChunk(host, createHash("sha256").update(oversize).digest("hex"), oversize)).status, 413);
    // A batch is refused whole when any chunk misnames its content, when a frame is cut short, or when the body is over its bound.
    const good = Buffer.from("batched\n"), goodHash = createHash("sha256").update(good).digest("hex");
    const misnamed = await putBatch(host, encodeChunkBatch([{ hash: goodHash, bytes: good }, { hash: absent, bytes: Buffer.from("other\n") }]));
    assert.deepEqual([misnamed.status, (await misnamed.json()).code], [400, "invalid-manifest"]);
    assert.deepEqual((await host.fetchApi("/projects/rehearsal/sync/has", "owner", { hashes: [goodHash] })).body.missing, [goodHash], "a refused batch stores none of its chunks");
    const framed = encodeChunkBatch([{ hash: goodHash, bytes: good }]);
    assert.equal((await putBatch(host, framed.subarray(0, framed.length - 1))).status, 400);
    assert.equal((await putBatch(host, Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
    // A manifest at the bound still fits the commit body with its generation, so the store judges it.
    const begun = (await host.fetchApi("/projects/rehearsal/sync/begin", "owner", {})).body.generation;
    const atBound = await host.fetchApi("/projects/rehearsal/sync/commit", "owner", { generation: begun, manifest: "x".repeat(32 * 1024 * 1024 - 2) });
    assert.deepEqual([atBound.status, atBound.body.code], [400, "invalid-manifest"]);

    writeFileSync(join(laptop, "notes.md"), "v1\n");
    const first = await pushTree(host, laptop, storeDir);
    assert.equal(first.commit.status, 200);
    assert.equal(first.commit.body.appliedManifest, first.manifest.id, "idle project applies immediately");
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v1\n");

    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Busy", prompt: "" });
    assert.equal(created.status, 201);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    writeFileSync(join(laptop, "notes.md"), "v2\n");
    const second = await pushTree(host, laptop, storeDir);
    assert.equal(second.commit.body.pendingGeneration?.reason, "session-running");
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v1\n");
    const refused = await host.fetchApi("/projects/rehearsal/sync/apply", "owner", {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "session-running");

    assert.equal((await host.fetchApi("/projects/rehearsal")).body.sync.pendingGeneration?.reason, "session-running");

    const stop = await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() });
    assert.equal(stop.status, 200);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "exited");
    // The marker still says session-running, but nothing holds the project now.
    const waiting = (await host.fetchApi("/projects/rehearsal")).body.sync.pendingGeneration;
    assert.deepEqual([waiting?.reason, waiting?.id], ["awaiting-apply", second.manifest.id]);
    const applied = await host.fetchApi("/projects/rehearsal/sync/apply", "owner", {});
    assert.equal(applied.status, 200);
    assert.equal(applied.body.appliedManifest, second.manifest.id);
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v2\n");
    const detail = await host.fetchApi("/projects/rehearsal");
    assert.equal(detail.body.sync.appliedManifest, second.manifest.id);
    assert.equal(detail.body.sync.pendingGeneration, undefined);

    const exported = await host.fetchApi("/projects/rehearsal/sync/export", "owner", {});
    assert.equal(exported.status, 200);
    const hash = exported.body.manifest.entries.find((e: { path: string }) => e.path === "notes.md").chunks[0];
    const blob = await host.fetchApi(`/projects/rehearsal/sync/blob/${hash}`);
    assert.equal(Buffer.from(blob.body.base64, "base64").toString(), "v2\n");
  } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("chunk upload batches a large tree into bounded requests and falls back to single chunks on an older host", { timeout: 60000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-batch-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  try {
    // Random content does not repeat; seven full chunks fill a 2 MiB batch, so twelve need two.
    for (let index = 0; index < 12; index++) writeFileSync(join(laptop, `file-${index}.bin`), randomBytes(256 * 1024));
    for (let index = 0; index < 300; index++) writeFileSync(join(laptop, `small-${index}.txt`), `small ${index}\n`);
    // The first batch request loses its connection, as fetch reports a dropped socket; the uploader sends it again.
    const counts = { batches: 0, singles: 0 }, base = transport(host, counts);
    let dropped = false;
    const flaky: ChunkTransport = { ...base, putBatch: async (body, signal) => {
      if (!dropped) { dropped = true; counts.batches += 1; throw new TypeError("fetch failed"); }
      return base.putBatch(body, signal);
    } };
    const { manifest, generation } = await upload(host, laptop, join(root, "store"), flaky);
    assert.deepEqual(counts, { batches: 3, singles: 0 }, "two batches, one of them sent twice");
    const committed = await host.fetchApi("/projects/rehearsal/sync/commit", "owner", { generation, manifest });
    assert.equal(committed.body.appliedManifest, manifest.id);
    assert.equal(readFileSync(join(host.config.projects[0].path, "small-299.txt"), "utf8"), "small 299\n");

    writeFileSync(join(laptop, "small-0.txt"), "changed\n");
    writeFileSync(join(laptop, "added.txt"), "added\n");
    const legacy = { batches: 0, singles: 0 };
    const second = await upload(host, laptop, join(root, "store"), transport(host, legacy, true));
    assert.equal(legacy.singles, 2, "only the two new chunks are sent, one request each");
    assert.equal((await host.fetchApi("/projects/rehearsal/sync/commit", "owner", second)).body.appliedManifest, second.manifest.id);
    assert.equal(readFileSync(join(host.config.projects[0].path, "added.txt"), "utf8"), "added\n");
  } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("session starts are refused while a sync holds the project, and an admitted start holds the next apply", { timeout: 60000 }, async () => {
  const host = await inProcessHost();
  const laptop = join(host.root, "laptop"); mkdirSync(laptop);
  const storeDir = join(host.root, "store");
  try {
    const earlier = randomUUID();
    assert.equal((await host.fetchApi("/sessions", "owner", { requestId: earlier, provider: "demo", projectId: "rehearsal", title: "Earlier", prompt: "" })).status, 201);
    assert.equal((await host.fetchApi(`/sessions/${earlier}/stop`, "owner", { requestId: randomUUID() })).status, 200);
    await waitFor(() => host.fetchApi(`/sessions/${earlier}`), r => r.body.status === "exited");

    // Hold a commit at its running check, inside the project's queue.
    writeFileSync(join(laptop, "notes.md"), "v1\n");
    const first = await upload(host, laptop, storeDir);
    let atCheck!: () => void, answer!: (running: boolean) => void;
    const reached = new Promise<void>(resolve => { atCheck = resolve; });
    const held = host.projectSync.commit("rehearsal", first.generation, first.manifest, () => {
      atCheck();
      return new Promise<boolean>(resolve => { answer = resolve; });
    });
    await reached;
    const late = randomUUID();
    const refused = await host.fetchApi("/sessions", "owner", { requestId: late, provider: "demo", projectId: "rehearsal", title: "Late", prompt: "" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "sync-applying");
    assert.equal(existsSync(join(host.config.stateDir, "sessions", late)), false, "the refused session never started");
    const resumed = await host.fetchApi(`/sessions/${earlier}/resume`, "owner", { requestId: randomUUID() });
    assert.equal(resumed.status, 409);
    assert.equal(resumed.body.code, "sync-applying");
    answer(false);
    assert.equal((await held).appliedManifest, first.manifest.id);

    // A start admitted before the next sync check counts as running before manager.list() can show it.
    let entered!: () => void, finish!: () => void;
    const creating = new Promise<void>(resolve => { entered = resolve; });
    host.manager.create = (request => new Promise(resolve => {
      entered();
      finish = () => resolve({ id: request.requestId } as never);
    })) as typeof host.manager.create;
    const admitted = host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Admitted", prompt: "" });
    await creating;
    writeFileSync(join(laptop, "notes.md"), "v2\n");
    const second = await pushTree(host, laptop, storeDir);
    assert.equal(second.commit.body.pendingGeneration?.reason, "session-running");
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v1\n");
    finish();
    assert.equal((await admitted).status, 201);
    const applied = await host.fetchApi("/projects/rehearsal/sync/apply", "owner", {});
    assert.equal(applied.status, 200, "the finished start no longer holds the project");
    assert.equal(applied.body.appliedManifest, second.manifest.id);
  } finally { await host.stop(); }
});

test("a running session whose worker does not answer still holds the next generation pending", { timeout: 90000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-stall-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const storeDir = join(root, "store");
  let worker: number | undefined;
  try {
    writeFileSync(join(laptop, "notes.md"), "v1\n");
    assert.equal((await pushTree(host, laptop, storeDir)).commit.status, 200);
    const id = randomUUID();
    assert.equal((await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Busy", prompt: "" })).status, 201);
    const running = await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running" && r.body.pid > 0);
    // Stop the session's worker, the provider's parent, so its state call times out during the commit.
    worker = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(running.body.pid)], { encoding: "utf8" }).trim());
    assert.ok(worker > 1);
    process.kill(worker, "SIGSTOP");
    writeFileSync(join(laptop, "notes.md"), "v2\n");
    const second = await pushTree(host, laptop, storeDir);
    assert.equal(second.commit.status, 200);
    assert.equal(second.commit.body.pendingGeneration?.reason, "session-running");
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v1\n", "the tree under the session was not replaced");
  } finally {
    if (worker) process.kill(worker, "SIGCONT");
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("a failed apply answers a sync-specific refusal and keeps the generation pending", { timeout: 60000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-fail-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const storeDir = join(root, "store");
  try {
    writeFileSync(join(laptop, "notes.md"), "v1\n");
    assert.equal((await pushTree(host, laptop, storeDir)).commit.status, 200);
    // The host cannot create its stage beside the project directory.
    chmodSync(host.root, 0o500);
    writeFileSync(join(laptop, "notes.md"), "v2\n");
    const { manifest, commit } = await pushTree(host, laptop, storeDir);
    assert.equal(commit.status, 409);
    assert.deepEqual({ code: commit.body.code, category: commit.body.category }, { code: "apply-failed", category: "permission" });
    assert.equal(commit.body.error, commit.body.message);
    assert.ok(!commit.body.error.includes(host.root), "the refusal never names a host path");
    const detail = await host.fetchApi("/projects/rehearsal");
    assert.deepEqual([detail.body.sync.pendingGeneration?.reason, detail.body.sync.pendingGeneration?.category, detail.body.sync.pendingGeneration?.id], ["apply-failed", "permission", manifest.id]);
    chmodSync(host.root, 0o700);
    const applied = await host.fetchApi("/projects/rehearsal/sync/apply", "owner", {});
    assert.equal(applied.status, 200);
    assert.equal(applied.body.pendingGeneration, undefined);
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v2\n");
  } finally { chmodSync(host.root, 0o700); await host.stop(); rmSync(root, { recursive: true, force: true }); }
});
