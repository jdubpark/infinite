import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { synchronizeWorkspace } from "../packages/host/src/laptop-service.js";
import type { ExecutorControl } from "../packages/host/src/executor-tunnel.js";

test("laptop sync commits once while idle, follows file changes, and recommits until acknowledged", {
  skip: process.platform !== "darwin",
  timeout: 30000,
}, async t => {
  const base = mkdtempSync(join(tmpdir(), "laptop-service-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, "file.txt"), "one\n");

  const revision = 7;
  const checkpoint = { id: "initial" };
  const commits: string[] = [];
  let acknowledged = true;
  let epoch = 0;
  let begins = 0;
  const control: ExecutorControl = async (method, params) => {
    switch (method) {
      case "sync/status":
        return { location: "laptop", revision, checkpoint, acknowledged };
      case "sync/begin":
        begins += 1;
        epoch += 1;
        return { revision, epoch };
      case "sync/has":
        return { missing: [] };
      case "sync/commit": {
        const manifest = (params as { manifest: { id: string } }).manifest;
        commits.push(manifest.id);
        checkpoint.id = manifest.id;
        return { checkpoint, epoch };
      }
      case "sync/problem":
        return { received: true };
      default:
        throw new Error(`Unexpected control call: ${method}`);
    }
  };

  const waitForCommitCount = async (count: number) => {
    const deadline = Date.now() + 6000;
    while (commits.length < count && Date.now() < deadline) await delay(25);
    assert.equal(commits.length, count, `expected ${count} commits within one loop interval`);
  };

  const abort = new AbortController();
  const running = synchronizeWorkspace({
    origin: "https://example.invalid",
    token: "test-token",
    sessionId: randomUUID(),
    workspaceToken: "test-workspace-token",
    cwd: root,
    roots: [root],
    configFile: join(base, "config.json"),
  }, control, abort.signal);

  try {
    await delay(7000);
    assert.equal(commits.length, 1, "an acknowledged idle checkpoint is not committed again");
    assert.equal(begins, 1, "an acknowledged idle checkpoint is not begun again");

    writeFileSync(join(root, "file.txt"), "two\n");
    await waitForCommitCount(2);
    assert.equal(begins, 2, "a file change starts another checkpoint");

    assert.equal(checkpoint.id, commits[1]);
    acknowledged = false;
    await waitForCommitCount(3);
    assert.equal(begins, 3, "an unacknowledged checkpoint is recommitted at the same revision and ID");
  } finally {
    abort.abort();
    await running;
  }
});
