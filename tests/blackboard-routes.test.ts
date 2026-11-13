import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";
import { startHost } from "./helpers.js";

/**
 * A state directory with a key file, a settled run record that holds a reported member, a failed check whose
 * output carries an escape sequence, and one recorded launch. The store is closed before the host starts.
 */
function sealedState() {
  const root = mkdtempSync(join(tmpdir(), "inf-blk-routes-"));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "teams"), { recursive: true });
  const keyFile = join(root, "key");
  const key = randomBytes(32);
  writeFileSync(keyFile, key, { mode: 0o600 });
  const run: TeamRun = hostEntryRun();
  run.status = "cancelled";
  run.checks[0] = { ...run.checks[0]!, status: "failed", exitCode: 1, output: "\u001b[31mred" };
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(stateDir), vaultKey: key });
  const board = new Blackboard(store);
  if (!board.mirror(run)) throw new Error("the fixture run did not mirror");
  board.recordLaunch(run, run.members.find(member => member.memberId === hostEntryIds.implA)!, { launchSeq: 8, promptBytes: 1200, contextBytes: 4000 });
  store.close();
  writeSealed(join(stateDir, "teams", `${run.id}.sealed`), key, `team:${run.id}`, { run, fingerprint: "fixture", receipts: {}, prepared: true });
  return { root, stateDir, keyFile, runId: run.id };
}

test("the entry routes serve heads, bodies, and sizes", { timeout: 90000 }, async () => {
  const state = sealedState();
  const host = await startHost({ config: { stateDir: state.stateDir, keyFile: state.keyFile } });
  try {
    const base = `/teams/${state.runId}/entries`;
    const list = await host.fetchApi(base);
    assert.equal(list.status, 200);
    assert.equal(list.body.entries.length, 8);
    assert.ok(list.body.entries.every((head: Record<string, unknown>) => !("body" in head)), "heads carry no body");
    const checks = await host.fetchApi(`${base}?kind=check`);
    assert.equal(checks.body.entries.length, 1);
    const paged = await host.fetchApi(`${base}?limit=1`);
    assert.equal(paged.body.entries.length, 1);
    assert.equal(paged.body.more, true);

    const check = checks.body.entries[0];
    const body = await host.fetchApi(`${base}/${check.entryId}`);
    assert.equal(body.status, 200);
    assert.deepEqual(Object.keys(body.body).sort(), ["head", "body"].sort());
    assert.equal(body.body.head.entryId, check.entryId);
    assert.equal(body.body.body.output, "\u001b[31mred", "the body is returned as data");
    assert.equal((await host.fetchApi(`${base}/${randomUUID()}`)).status, 404);
    assert.equal((await host.fetchApi(`/teams/${randomUUID()}/entries`)).status, 404);
    assert.equal((await host.fetchApi(`${base}?kind=bogus`)).status, 400);
    assert.equal((await host.fetchApi(`${base}?limit=0`)).status, 400);
    assert.equal((await host.fetchApi(`${base}?extra=1`)).status, 400);
    assert.equal((await host.fetchApi(base, "viewer")).status, 200, "the viewer role may read");
    assert.equal((await host.fetchApi(base, null)).status, 401);

    const usage = await host.fetchApi(`/teams/${state.runId}/context-usage`);
    assert.equal(usage.status, 200);
    assert.equal(usage.body.members.length, 1);
    assert.equal(usage.body.members[0].memberId, hostEntryIds.implA);
    assert.equal(usage.body.members[0].contextBytes, 4000);
  } finally {
    await host.stop();
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("an unavailable store answers 503", { timeout: 90000 }, async () => {
  const state = sealedState();
  const host = await startHost({ config: { stateDir: state.stateDir, keyFile: state.keyFile } });
  try {
    await host.stopApi();
    const location = join(host.config.stateDir, "evidence");
    rmSync(location, { recursive: true, force: true });
    writeFileSync(location, "not a directory");
    await host.start();
    const response = await host.fetchApi(`/teams/${state.runId}/entries`);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "evidence-unavailable");
    assert.equal((await host.fetchApi(`/teams/${state.runId}/context-usage`)).status, 503);
    assert.equal((await host.fetchApi("/usage")).status, 200, "the rest of the host still serves");
  } finally {
    await host.stop();
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("the entry commands print heads and a body", { timeout: 90000 }, async () => {
  const state = sealedState();
  const host = await startHost({ config: { stateDir: state.stateDir, keyFile: state.keyFile } });
  const root = mkdtempSync(join(tmpdir(), "inf-blk-cli-"));
  try {
    const clientFile = join(root, "client.json");
    writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal" }), { mode: 0o600 });
    const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
    const exec = promisify(execFile);
    const team = async (...args: string[]) => (await exec(process.execPath, [...cli, "team", ...args])).stdout;

    const all = await team("entries", state.runId);
    const lines = all.trimEnd().split("\n");
    assert.equal(lines.length, 8);
    assert.ok(lines.some(line => /^\d+ {2}check {2}host\/receipt {2}check failed \(exit 1\)/.test(line)), all);
    const checkOnly = await team("entries", state.runId, "--kind", "check");
    assert.equal(checkOnly.trimEnd().split("\n").length, 1);
    const json = JSON.parse(await team("entries", state.runId, "--json"));
    assert.deepEqual(json, (await host.fetchApi(`/teams/${state.runId}/entries`)).body);

    const checkId = json.entries.find((head: { kind: string }) => head.kind === "check").entryId;
    const body = await team("entry", state.runId, checkId);
    assert.match(body, /"output": "\\u001b\[31mred"/, "the escape sequence stays as escaped text");
    assert.ok(!body.includes("\u001b"), "no raw escape reaches the terminal");
    assert.ok(!all.includes("\u001b") && !checkOnly.includes("\u001b"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    await host.stop();
    rmSync(state.root, { recursive: true, force: true });
  }
});
