import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";

// In production the bundle writer runs as another account behind the launcher, so the host's group kill cannot reach
// it, and only the closed pipe ends it. The stand-in launcher starts its writer in a session of its own for the same
// effect.
test("a stopped bundle pull ends a writer the host cannot signal", { timeout: 120000, skip: process.platform === "win32" }, async () => {
  const f = await fixture("success");
  const pidFile = join(f.host.root, "writer.pid");
  let writer = 0;
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const finished = await f.settled(created.body.id);
    f.host.config.teams!.commandPrefix = { command: process.execPath, args: [resolve("tests/fixtures/unsignalled-writer.mjs"), pidFile] };
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();

    const controller = new AbortController();
    const response = await fetch(`${f.host.origin}/api/teams/${finished.id}/bundle`, { headers: { Authorization: `Bearer ${f.host.tokens.owner}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.ok((await reader.read()).value?.length, "bundle bytes arrive");
    writer = Number(readFileSync(pidFile, "utf8"));
    assert.ok(writer > 1, "the stand-in launcher recorded its writer");
    process.kill(writer, 0);
    controller.abort();
    await reader.read().catch(() => undefined);

    const gone = await waitFor(async () => {
      try { process.kill(writer, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }, ended => ended, 10000).catch(() => false);
    assert.equal(gone, true, "the writer ended after the pull stopped");
  } finally {
    // A failure before the pid was read must not leave the writer blocked on its pipe.
    if (!writer) try { writer = Number(readFileSync(pidFile, "utf8")); } catch { /* The writer never started. */ }
    if (writer) try { process.kill(writer, "SIGKILL"); } catch { /* Already gone. */ }
    await f.close();
  }
});
