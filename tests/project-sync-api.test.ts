import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";
import { createApp } from "../packages/host/src/server.js";
import { hashToken } from "../packages/host/src/config.js";
import type { Config, Role } from "../packages/host/src/types.js";
import { apiClient, demoProfile, startHost, stopSessionWorkers, waitFor, type Host } from "./helpers.js";

type Api = Pick<Host, "origin" | "tokens" | "fetchApi">;

const putChunk = (host: Api, hash: string, body: Buffer) => fetch(`${host.origin}/api/projects/rehearsal/sync/blob/${hash}`, {
  method: "PUT", headers: { Authorization: `Bearer ${host.tokens.owner}`, "Content-Type": "application/octet-stream" }, body,
});

/** Capture the laptop tree, begin a generation, and upload the chunks the host lacks. */
async function upload(host: Api, laptop: string, storeDir: string) {
  const manifest = await captureWorkspace({ roots: [laptop], cwd: laptop, storeDir });
  const begin = await host.fetchApi("/projects/rehearsal/sync/begin", "owner", {});
  assert.equal(begin.status, 200);
  const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
  const has = await host.fetchApi("/projects/rehearsal/sync/has", "owner", { hashes });
  for (const hash of has.body.missing as string[])
    assert.equal((await putChunk(host, hash, Buffer.from(await readWorkspaceBlob(storeDir, hash), "base64"))).status, 200);
  return { manifest, generation: begin.body.generation as string };
}

async function pushTree(host: Api, laptop: string, storeDir: string) {
  const { manifest, generation } = await upload(host, laptop, storeDir);
  return { manifest, commit: await host.fetchApi("/projects/rehearsal/sync/commit", "owner", { generation, manifest }) };
}

/** An API served from this process, so a test can hold the sync queue open through the ProjectSync it returns. */
async function inProcessHost() {
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-guard-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const key = randomBytes(32);
  const keyFile = join(root, "key"); writeFileSync(keyFile, key, { mode: 0o600 });
  const roles: Role[] = ["owner", "controller", "viewer"];
  const tokens = Object.fromEntries(roles.map(role => [role, randomBytes(32).toString("base64url")])) as Record<Role, string>;
  const config: Config = {
    port: 0, origin: "http://127.0.0.1", keyFile, stateDir: join(root, "state"), runDir: join(root, "run"),
    environment: "local", enableDemo: true, maxSessions: 24, agents: { demo: demoProfile() },
    projects: [{ id: "rehearsal", name: "Rehearsal", path: workspace }],
    tokens: roles.map(role => ({ id: role, label: role, role, hash: hashToken(tokens[role]) })),
  };
  const host = createApp(config, key);
  await new Promise<void>(resolve => host.server.listen(0, "127.0.0.1", resolve));
  config.port = (host.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`;
  return {
    ...host, root, config, origin, tokens, fetchApi: apiClient(origin, tokens),
    stop: async () => {
      await stopSessionWorkers(config);
      host.closeConnections();
      await new Promise<void>(resolve => host.server.close(() => resolve()));
      // Workers exit 1.5 s after their child; wait so they never write into a removed directory.
      await new Promise(resolve => setTimeout(resolve, 1700));
      rmSync(root, { recursive: true, force: true });
    },
  };
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
    for (const [method, route] of [["POST", "begin"], ["POST", "has"], ["PUT", `blob/${absent}`], ["GET", `blob/${absent}`], ["POST", "commit"], ["POST", "export"]])
      assert.equal((await fetch(`${host.origin}/api/projects/rehearsal/sync/${route}`, { method, headers: browser, body: method === "GET" ? undefined : "{}" })).status, 403, `${method} ${route}`);
    const missing = await host.fetchApi(`/projects/rehearsal/sync/blob/${absent}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "missing-content");
    const mismatched = await putChunk(host, absent, Buffer.from("other bytes\n"));
    assert.equal(mismatched.status, 400);
    assert.equal((await mismatched.json()).code, "invalid-manifest");
    assert.equal((await putChunk(host, absent, Buffer.alloc(1024 * 1024 + 1))).status, 413);

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

    const stop = await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() });
    assert.equal(stop.status, 200);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "exited");
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
