import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";
import { startHost, waitFor } from "./helpers.js";

async function pushTree(host: Awaited<ReturnType<typeof startHost>>, laptop: string, storeDir: string) {
  const manifest = await captureWorkspace({ roots: [laptop], cwd: laptop, storeDir });
  const begin = await host.fetchApi("/projects/rehearsal/sync/begin", "owner", {});
  assert.equal(begin.status, 200);
  const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
  const has = await host.fetchApi("/projects/rehearsal/sync/has", "owner", { hashes });
  for (const hash of has.body.missing as string[]) {
    const response = await fetch(`${host.origin}/api/projects/rehearsal/sync/blob/${hash}`, {
      method: "PUT", headers: { Authorization: `Bearer ${host.tokens.owner}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from(await readWorkspaceBlob(storeDir, hash), "base64"),
    });
    assert.equal(response.status, 200);
  }
  return { manifest, commit: await host.fetchApi("/projects/rehearsal/sync/commit", "owner", { generation: begin.body.generation, manifest }) };
}

test("sync routes receive a laptop tree, hold it while a session runs, and apply on request", { timeout: 60000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-api-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const storeDir = join(root, "store");
  try {
    assert.equal((await host.fetchApi("/projects/rehearsal", "viewer")).status, 200);
    assert.equal((await host.fetchApi("/projects/rehearsal/sync/begin", "controller", {})).status, 403);
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
