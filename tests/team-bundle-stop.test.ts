import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";

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
    assert.ok(["EPIPE", "ECONNRESET"].includes(cause), `the closed pipe ended the writer after the pull stopped; the writer recorded '${cause}'`);
  } finally {
    await f.close();
  }
});
