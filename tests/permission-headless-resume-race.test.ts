import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { socketPath } from "../packages/host/src/ipc.js";
import { Journal, writeSealed } from "../packages/host/src/vault.js";
import { demoProfile, inProcessHost } from "./helpers.js";

test("a deferral recorded while resume reads the session state still refuses the resume", async () => {
  const host = await inProcessHost({ configure: config => { config.agents.claude = demoProfile(); } });
  const worker = createServer();
  try {
    const key = readFileSync(host.config.keyFile);
    const id = randomUUID(), dir = join(host.config.stateDir, "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeSealed(join(dir, "meta.sealed"), key, `${id}:meta`, { session: { id, provider: "claude", projectId: "rehearsal", title: "Headless", cwd: host.config.projects[0]!.path, headless: { channel: true } } });
    const journal = new Journal(join(dir, "events"), key, id);
    worker.on("connection", socket => socket.once("data", chunk => {
      assert.equal(JSON.parse(String(chunk)).op, "state");
      journal.append("lifecycle", { permissionChannel: { event: "deferred", callId: "toolu_1" } });
      socket.end(JSON.stringify({ result: { status: "exited", nativeSession: { id: "native-1", source: "hook" } } }) + "\n");
    }));
    await new Promise<void>(done => worker.listen(socketPath(host.config.runDir, id), done));
    await assert.rejects(host.manager.resume(id, randomUUID()), /waited for the owner's answer/);
  } finally {
    worker.close();
    await host.stop();
  }
});
