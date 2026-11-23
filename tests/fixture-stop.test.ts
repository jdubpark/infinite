// A host fixture must leave no session worker behind: a worker that outlives its test keeps running after the whole run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { endSessionWorkers, processes, startHost, waitFor, WORKER_ENTRY } from "./helpers.js";

const running = (pid: number) => processes().some(row => row.pid === pid);

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
    workers = await waitFor(async () => processes().filter(row => row.parent === api && row.command.includes(WORKER_ENTRY)).map(row => row.pid), list => list.length > 0);
    await host.stop();
    stopped = true;
    await creating;
    assert.equal(workers.length, 1, "one worker was started");
    assert.deepEqual(workers.filter(running), [], "the worker is gone when the stop returns");
  } finally {
    // A worker the stop missed must not outlive this test either, and must not hold the second stop.
    for (const row of processes()) if (workers.includes(row.pid) && row.command.includes(WORKER_ENTRY)) process.kill(row.pid, "SIGKILL");
    if (!stopped) await host.stop().catch(() => undefined);
  }
});

test("a worker that will not end is killed at the limit, and the stop fails", { timeout: 30 * 1000 }, async () => {
  // A process that holds the worker entry on its command line and hears no request: a worker that never listens.
  const deaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", WORKER_ENTRY + "never-listens"], { stdio: "ignore" });
  try {
    await waitFor(async () => running(deaf.pid!), found => found);
    const nowhere = join("/tmp", "inf-test-no-host-" + randomUUID());
    const config = { keyFile: join(nowhere, "key"), stateDir: join(nowhere, "state"), runDir: join(nowhere, "run") } as Parameters<typeof endSessionWorkers>[0];
    const ended = new Promise<void>(resolve => deaf.once("exit", () => resolve()));
    await assert.rejects(endSessionWorkers(config, [deaf.pid!], 600), /still ran 600 ms after the test stopped them and were killed/);
    await ended;
    assert.equal(deaf.signalCode, "SIGKILL", "the stop that failed did not leave the worker running");
  } finally {
    if (deaf.exitCode === null && deaf.signalCode === null) deaf.kill("SIGKILL");
  }
});
