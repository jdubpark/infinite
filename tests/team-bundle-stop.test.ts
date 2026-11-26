import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT_DRAIN_MS } from "../packages/host/src/team-workspace.js";
import { waitFor } from "./helpers.js";
import { LEADER_LEAVES, endLeftBehind, gone, leaderGone, stubbornMember, until, within } from "./leader-exit.js";
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

test("a bundle pull whose leader exits while an escaped holder keeps the stream ends a drain later, and a stop inside the drain signals nothing", { timeout: 120000, skip: process.platform === "win32" }, async () => {
  const f = await fixture("success");
  const record = join(f.host.root, "bundle-leader.json");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const finished = await f.settled(created.body.id);
    f.host.config.teams!.commandPrefix = { command: process.execPath, args: [LEADER_LEAVES, record, "bundle"] };
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    const pull = (signal: AbortSignal) => fetch(`${f.host.origin}/api/teams/${finished.id}/bundle`, { headers: { Authorization: `Bearer ${f.host.tokens.owner}` }, signal });

    const held = await pull(new AbortController().signal);
    assert.equal(held.status, 200);
    const heldLeft = await leaderGone(record);
    const body = held.arrayBuffer().then(() => "ended", () => "destroyed");
    assert.equal(await within(body, EXIT_DRAIN_MS + 5000, "the pull ends after its leader exits"), "destroyed", "a stream a leftover still holds is not delivered as a whole bundle");
    await new Promise(done => setTimeout(done, 300));
    assert.equal(gone(heldLeft.witness), false, "the process left in the leader's group was not signalled");
    endLeftBehind(record);
    rmSync(record);

    const controller = new AbortController();
    const stopped = await pull(controller.signal);
    assert.equal(stopped.status, 200);
    const reader = stopped.body!.getReader();
    const stoppedLeft = await leaderGone(record);
    controller.abort();
    await reader.read().catch(() => undefined);
    await new Promise(done => setTimeout(done, 500));
    assert.equal(gone(stoppedLeft.witness), false, "a stop after the leader's exit did not signal its group");
  } finally {
    endLeftBehind(record);
    await f.close();
  }
});

test("a stopped bundle pull ends a group member that ignores SIGTERM", { timeout: 120000, skip: process.platform === "win32" }, async () => {
  const f = await fixture("success");
  const record = join(f.host.root, "bundle-leader.json");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const finished = await f.settled(created.body.id);
    f.host.config.teams!.commandPrefix = { command: process.execPath, args: [LEADER_LEAVES, record, "bundle-running"] };
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();

    const controller = new AbortController();
    const response = await fetch(`${f.host.origin}/api/teams/${finished.id}/bundle`, { headers: { Authorization: `Bearer ${f.host.tokens.owner}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const { member } = await stubbornMember(record);
    controller.abort();
    await reader.read().catch(() => undefined);
    await until("the group member that ignores SIGTERM ends", () => gone(member), 3000);
  } finally {
    endLeftBehind(record);
    await f.close();
  }
});
