import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";

// In production the bundle writer runs as another account behind the launcher, so the host's group kill cannot reach
// it, and only the closed pipe ends it. The stand-in launcher starts its writer in a session of its own, which puts
// the writer outside that group kill. The writer records the error that ended it, so the test never signals a pid or
// asks the kernel about one: by then another process could hold the number.
test("a stopped bundle pull ends a writer outside the host's group kill", { timeout: 120000, skip: process.platform === "win32" }, async () => {
  const f = await fixture("success");
  const endFile = join(f.host.root, "writer.ended");
  const ended = (): string => { try { return readFileSync(endFile, "utf8"); } catch { return ""; } };
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const finished = await f.settled(created.body.id);
    f.host.config.teams!.commandPrefix = { command: process.execPath, args: [resolve("tests/fixtures/unsignalled-writer.mjs"), endFile] };
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();

    const controller = new AbortController();
    const response = await fetch(`${f.host.origin}/api/teams/${finished.id}/bundle`, { headers: { Authorization: `Bearer ${f.host.tokens.owner}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.ok((await reader.read()).value?.length, "bundle bytes arrive");
    assert.equal(ended(), "", "the writer is still writing");
    controller.abort();
    await reader.read().catch(() => undefined);

    const cause = await waitFor(async () => ended(), text => text !== "", 10000).catch(() => "");
    // The writer's stdout is one end of a socket pair. When the host closes the other end with bytes still unread,
    // macOS answers the writer's next write with EPIPE, and Linux with EPIPE or ECONNRESET, by where the write was.
    assert.ok(["EPIPE", "ECONNRESET"].includes(cause), `the closed pipe ended the writer after the pull stopped; the writer recorded '${cause}'`);
  } finally {
    // Closing the fixture ends the host, which holds the only other end of the pipe, so a writer that is still
    // blocked ends here too.
    await f.close();
  }
});
