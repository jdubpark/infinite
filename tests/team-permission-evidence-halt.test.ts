import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers.js";
import { fixture, limitLineup } from "./team-fixture.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";

const lineup: TeamLineup = { ...limitLineup, coordinator: { ...limitLineup.coordinator, provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" } };

const holdEvidenceRead = `
const { spawnSync } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const control = process.argv[1];
const [command, ...args] = process.argv.slice(2);
if (command === "git") {
  appendFileSync(join(control, "git.log"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), args }) + "\\n");
  const receipts = existsSync(join(control, "receipts")) ? readFileSync(join(control, "receipts"), "utf8") : "";
  const feedback = receipts ? readdirSync(receipts).find(name => name.endsWith(".permission-feedback.json")) : undefined;
  const changedPathsRead = args.includes("diff") && args.includes("--name-only") && !args.includes("--cached");
  const gated = !existsSync(join(control, "wait-armed")) || existsSync(join(control, "armed"));
  if (feedback && gated && changedPathsRead && !existsSync(join(control, "started")) &&
      process.cwd() === JSON.parse(readFileSync(join(receipts, feedback), "utf8")).targetCwd) {
    writeFileSync(join(control, "started"), String(process.pid));
    const until = Date.now() + 20000;
    while (!existsSync(join(control, "release")) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
const child = spawnSync(command, args, { stdio: "inherit" });
process.exit(child.status ?? 1);
`;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a pause ends the Git read that collects requested permission evidence, starts no later read, and records the halt (INF-521)", { timeout: 180000 }, async () => {
  const control = mkdtempSync(join(tmpdir(), "team-evidence-halt-"));
  const f = await fixture("permissions-codex-diagnostic-evidence", lineup,
    { teams: { commandPrefix: { command: process.execPath, args: ["-e", holdEvidenceRead, control] } } } as Partial<Config>);
  try {
    writeFileSync(join(control, "receipts"), f.receipts);
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id;
    await waitFor(async () => existsSync(join(control, "started")), Boolean, 90000);
    const pid = Number(readFileSync(join(control, "started"), "utf8"));
    assert.ok(alive(pid), "the first changed-paths read of the evidence collection is running");
    const collecting = await f.get(id);
    assert.equal(collecting.permissionDecisions?.[0]?.status, "reviewing");
    const paused = await f.host.fetchApi(`/teams/${id}/pause`, "owner", { requestId: randomUUID(), revision: collecting.revision });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const until = Date.now() + 5000;
    while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(pid), false, "the pause ends the running evidence read");
    writeFileSync(join(control, "release"), "");
    const settled = await waitFor(() => f.get(id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.equal(settled.status, "paused");
    assert.equal(settled.permissionDecisions![0].reason, "The run is paused, stopped, blocked, or its permission policy was revoked.");
    const reads = readFileSync(join(control, "git.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { pid: number; cwd: string; args: string[] });
    const held = reads.findIndex(read => read.pid === pid);
    assert.ok(held >= 0);
    assert.deepEqual(reads.slice(held + 1).filter(read => read.cwd === reads[held].cwd && (read.args.includes("--cached") || read.args.includes("ls-files"))), [],
      "no later read of the evidence collection starts after the pause");
  } finally {
    writeFileSync(join(control, "release"), "");
    await f.close();
    rmSync(control, { recursive: true, force: true });
  }
});

test("a pause ends the Git read that rechecks the target before an approved answer, and nothing is sent (INF-521)", { timeout: 180000 }, async () => {
  const control = mkdtempSync(join(tmpdir(), "team-answer-halt-"));
  const f = await fixture("permissions-codex", limitLineup,
    { teams: { commandPrefix: { command: process.execPath, args: ["-e", holdEvidenceRead, control] } } } as Partial<Config>);
  try {
    writeFileSync(join(control, "receipts"), f.receipts);
    writeFileSync(join(control, "wait-armed"), "");
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id;
    const reviewing = await waitFor(() => f.get(id), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") &&
      existsSync(join(f.receipts, `${run.id}.judge-ready`)) && existsSync(join(f.receipts, `${run.id}.permission-feedback.json`)), 90000);
    writeFileSync(join(control, "armed"), "");
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    await waitFor(async () => existsSync(join(control, "started")), Boolean, 60000);
    const pid = Number(readFileSync(join(control, "started"), "utf8"));
    assert.ok(alive(pid), "the answer's changed-paths read is running");
    const holding = await f.get(id);
    const paused = await f.host.fetchApi(`/teams/${id}/pause`, "owner", { requestId: randomUUID(), revision: holding.revision });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const until = Date.now() + 5000;
    while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(pid), false, "the pause ends the running answer read");
    writeFileSync(join(control, "release"), "");
    const settled = await waitFor(() => f.get(id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.equal(settled.status, "paused");
    assert.equal(settled.permissionDecisions![0].reason, "The team is paused, stopped, blocked, or its permission policy was revoked.");
    assert.equal(settled.permissionDecisions![0].receipt, undefined, "nothing was sent to the target prompt");
  } finally {
    writeFileSync(join(control, "release"), "");
    await f.close();
    rmSync(control, { recursive: true, force: true });
  }
});
