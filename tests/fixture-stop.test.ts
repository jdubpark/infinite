// A host fixture must leave no session worker behind: a worker that outlives its test keeps running after the whole run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { processes, startHost, waitFor } from "./helpers.js";

const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a spawned host's stop ends a session whose worker is not listening yet", { timeout: 90 * 1000 }, async () => {
  const host = await startHost();
  let workers: number[] = [];
  let stopped = false;
  try {
    const api = processes().find(row => row.command.includes(join(host.root, "config.json")))?.pid;
    assert.equal(typeof api, "number", "the API process is found by its configuration file");
    // Not awaited: the stop must meet the worker while the API is still starting it.
    const creating = host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Starting", prompt: "Initial request" })
      .catch(() => undefined);
    workers = await waitFor(async () => processes().filter(row => row.parent === api && row.command.includes("/packages/host/src/worker.")).map(row => row.pid), list => list.length > 0);
    await host.stop();
    stopped = true;
    await creating;
    assert.equal(workers.length, 1, "one worker was started");
    assert.deepEqual(workers.filter(running), [], "the worker is gone when the stop returns");
  } finally {
    if (!stopped) await host.stop();
    // A worker the stop missed must not outlive this test either.
    for (const pid of workers) if (running(pid)) process.kill(pid, "SIGKILL");
  }
});
