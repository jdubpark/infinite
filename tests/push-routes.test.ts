import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { startHost } from "./helpers.js";
import { PushStore } from "../packages/host/src/push.js";
import { readConfig } from "../packages/host/src/config.js";

const TOKEN = "ExponentPushToken[abcdefghijkl]";

test("device push routes validate input, accept any paired role, and delete", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const store = () => new PushStore(host.config.stateDir, readFileSync(host.config.keyFile));
    const ok = await host.fetchApi("/devices/push", "controller", { token: TOKEN, platform: "android" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, push: false });
    assert.deepEqual(store().list().map((d) => [d.deviceId, d.token]), [["controller", TOKEN]]);
    assert.equal((await host.fetchApi("/devices/push", "controller", { token: "nope", platform: "android" })).status, 400);
    assert.equal((await host.fetchApi("/devices/push", "controller", { token: TOKEN, platform: "android", extra: 1 })).status, 400);
    assert.equal((await host.fetchApi("/devices/push", "viewer", { token: "ExponentPushToken[viewerviewer1]", platform: "ios" })).status, 200);
    assert.equal(store().list().length, 2);
    const del = await host.fetchApi("/devices/push", "controller", { token: TOKEN }, {}, "DELETE");
    assert.equal(del.status, 200);
    assert.deepEqual(store().list().map((d) => d.deviceId), ["viewer"]);
  } finally {
    await host.stop();
  }
});

test("/api/me reports capabilities by role", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    assert.deepEqual((await host.fetchApi("/me", "controller")).body.capabilities, { signals: true, answer: true, push: false });
    assert.equal((await host.fetchApi("/me", "viewer")).body.capabilities.answer, false);
  } finally {
    await host.stop();
  }
});

test("readConfig validates the push access token file", () => {
  const root = mkdtempSync("/tmp/inf-cfg-");
  try {
    mkdirSync(join(root, "state"));
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "key"), Buffer.alloc(32, 1), { mode: 0o600 });
    const write = (push: unknown) => {
      const file = join(root, "config.json");
      writeFileSync(file, JSON.stringify({
        port: 1, origin: "http://127.0.0.1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile: join(root, "key"),
        environment: "local", tokens: [{ id: "a", label: "a", role: "owner", hash: "a".repeat(64) }],
        projects: [{ id: "p", name: "P", path: join(root, "other") }], push,
      }));
      return file;
    };
    const secret = (path: string, mode: number) => { writeFileSync(path, "exp-secret\n"); chmodSync(path, mode); return path; };
    assert.throws(() => readConfig(write({ enabled: true, accessTokenFile: "rel/token" })), /Push access token file/);
    assert.throws(() => readConfig(write({ enabled: true, accessTokenFile: secret(join(root, "other", "loose"), 0o644) })), /Push access token file/);
    assert.throws(() => readConfig(write({ enabled: true, accessTokenFile: secret(join(root, "state", "inside"), 0o600) })), /Push access token file/);
    assert.equal(readConfig(write({ enabled: true, accessTokenFile: secret(join(root, "other", "good"), 0o600) })).config.push?.enabled, true);
    assert.equal(readConfig(write({ enabled: false })).config.push?.enabled, false);
    assert.throws(() => readConfig(write({ enabled: false, acessTokenFile: "/x" })));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
