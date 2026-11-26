import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workerCall } from "../packages/host/src/ipc.js";
import { DEFERRAL_RETENTION_MS } from "../packages/host/src/permission-headless-worker.js";
import { unseal } from "../packages/host/src/vault.js";
import { live, rig } from "./headless-rig.js";
import { waitFor } from "./helpers.js";

async function failJournal(r: Awaited<ReturnType<typeof rig>>, id: string) {
  const events = join(r.config.stateDir, "sessions", id, "events");
  const files = readdirSync(events).map(name => join(events, name));
  for (const file of files) chmodSync(file, 0o400);
  await assert.rejects(workerCall(r.config.runDir, id, { op: "stop", requestId: randomUUID() }), /EACCES/);
  for (const file of files) chmodSync(file, 0o600);
  return waitFor(() => r.manager.state(id), s => s.status === "recording-error", 10_000);
}


test("a worker whose journal failed outlives its waiting call's retention and keeps its status", { timeout: 150_000 }, async () => {
  const r = await rig();
  const clock = join(r.root, "clock");
  const saved = [process.env.NODE_OPTIONS, process.env.INFINITE_TEST_CLOCK_FILE];
  try {
    const id = randomUUID();
    process.env.NODE_OPTIONS = `--import=${pathToFileURL(resolve("tests/fixtures/worker-clock.mjs")).href}`;
    process.env.INFINITE_TEST_CLOCK_FILE = clock;
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "mixed" });
    await waitFor(() => live(r, id), s => s.attention.state === "needs-you" && Boolean(s.permissionChannel?.waiting), 40_000);
    await failJournal(r, id);
    const pid = unseal<{ workerPid: number }>(r.key, `${id}:status`, readFileSync(join(r.config.stateDir, "sessions", id, "status.sealed"), "utf8")).workerPid;
    writeFileSync(clock, String(DEFERRAL_RETENTION_MS + 120_000));
    process.kill(pid, "SIGUSR2");
    await waitFor(async () => readFileSync(clock, "utf8"), text => text.startsWith("moved"), 10_000);
    await new Promise(done => setTimeout(done, 65_000));
    assert.equal((await workerCall<{ status: string }>(r.config.runDir, id, { op: "state" })).status, "recording-error");
  } finally {
    [process.env.NODE_OPTIONS, process.env.INFINITE_TEST_CLOCK_FILE] = saved as [string, string];
    if (saved[0] === undefined) delete process.env.NODE_OPTIONS;
    if (saved[1] === undefined) delete process.env.INFINITE_TEST_CLOCK_FILE;
    await r.stop();
  }
});

test("after a recording error an owner's answer neither resumes the session nor appends", { timeout: 90_000 }, async () => {
  const r = await rig();
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "mixed" });
    const waiting = await waitFor(() => live(r, id), s => s.attention.state === "needs-you" && Boolean(s.permissionChannel?.waiting), 40_000);
    const failed = await failJournal(r, id);
    await assert.rejects(workerCall(r.config.runDir, id, { op: "answer", requestId: randomUUID(), promptId: waiting.attention.prompt!.id, option: 0 }));
    const after = await r.manager.state(id);
    assert.deepEqual([after.status, after.seq], ["recording-error", failed.seq]);
    assert.equal(r.log("ran.log"), "make safe-build\n");
  } finally { await r.stop(); }
});
