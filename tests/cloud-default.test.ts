import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../packages/host/src/server.js";
import { hashToken } from "../packages/host/src/config.js";
import { writeSealed } from "../packages/host/src/vault.js";
import type { Config } from "../packages/host/src/types.js";
import { startHost } from "./helpers.js";

test("new sessions record cloud execution and /me reports the cloud default", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const me = await host.fetchApi("/me");
    assert.equal(me.body.execution.default, "cloud");
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Cloud", prompt: "" });
    assert.equal(created.status, 201);
    assert.equal(created.body.executionLocation, "cloud");
    assert.equal(created.body.machineId, me.body.machine.id);
    const row = (await host.fetchApi("/sessions")).body.sessions.find((s: { id: string }) => s.id === id);
    assert.equal(row.executionLocation, "cloud");
    const detail = await host.fetchApi(`/sessions/${id}`);
    assert.equal(detail.body.executionLocation, "cloud");
  } finally { await host.stop(); }
});

test("records written before executionLocation existed report laptop when they carry a hybrid workspace, cloud otherwise", async () => {
  const root = mkdtempSync("/tmp/inf-location-");
  const key = randomBytes(32), token = randomBytes(32).toString("base64url");
  const config: Config = { port: 0, origin: "http://127.0.0.1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile: join(root, "key"), environment: "cloud", enableDemo: false, maxSessions: 2, tokens: [{ id: "owner", label: "owner", role: "owner", hash: hashToken(token) }], projects: [], agents: {} };
  mkdirSync(config.runDir, { recursive: true });
  const record = (id: string, extra: Record<string, unknown>) => {
    const dir = join(config.stateDir, "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeSealed(join(dir, "meta.sealed"), key, `${id}:meta`, { session: { id, provider: "codex", title: "Older session", projectId: "old", createdAt: new Date().toISOString(), status: "exited", context: "", contextVersion: 0, initialPrompt: "", cwd: root, ...extra }, fingerprint: "old" });
  };
  const cloud = randomUUID(), laptop = randomUUID();
  record(cloud, {});
  record(laptop, { workspace: { cwd: root, roots: [root] } });
  const app = createApp(config, key);
  const server = app.server.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  config.port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`;
  const get = async (path: string) => (await fetch(origin + "/api" + path, { headers: { Authorization: `Bearer ${token}` } })).json();
  try {
    const rows = (await get("/sessions")).sessions as { id: string; executionLocation?: string }[];
    assert.equal(rows.find(s => s.id === cloud)?.executionLocation, "cloud");
    assert.equal(rows.find(s => s.id === laptop)?.executionLocation, "laptop");
    assert.equal((await get(`/sessions/${cloud}`)).executionLocation, "cloud");
    assert.equal((await get(`/sessions/${laptop}`)).executionLocation, "laptop");
  } finally {
    app.closeConnections(); await new Promise<void>(r => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
