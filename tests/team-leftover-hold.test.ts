import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_TEAM_RETENTION, type TeamView } from "../packages/host/src/team-types.js";
import { commandLeftoverEvent } from "../packages/host/src/teams.js";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";

const CHECK = [
  "const { appendFileSync, existsSync, readFileSync } = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "const [log, release, mode] = process.argv.slice(2);",
  "const note = word => appendFileSync(log, `${Date.now()} ${word} ${process.pid}\\n`);",
  "if (mode === 'child') {",
  "  note('child');",
  "  setInterval(() => { if (existsSync(release)) { note('end'); process.exit(0); } }, 50);",
  "  setTimeout(() => process.exit(3), 300000);",
  "} else if (mode === 'once' && existsSync(log) && readFileSync(log, 'utf8').includes(' leave ')) {",
  "  note('pass');",
  "} else {",
  "  note('leave');",
  "  spawn(process.execPath, [__filename, log, release, 'child'], { stdio: 'inherit' });",
  "  process.stdout.write('The check passed and left a helper running.\\n');",
  "  process.exit(0);",
  "}",
].join("\n");
const running = (count: number) => `The host still sees ${count} process(es) left behind by an earlier command of this run. It keeps this run's directories until a census finds none.`;
const ENDED = "The host sees no process left behind by an earlier command of this run, and none using this run's directory. Its directories can be removed.";
const POSIX = { timeout: 240_000, skip: process.platform === "win32" && "process groups are POSIX" };

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function noted(log: string, word: string) {
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return lines.map(line => line.split(" ")).filter(([, text]) => text === word).map(([, , pid]) => Number(pid));
}

async function leavingTeam(mode: "always" | "once", retention: Partial<typeof DEFAULT_TEAM_RETENTION> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "team-leftover-"));
  const script = join(dir, "check.cjs"), log = join(dir, "check.log"), release = join(dir, "release");
  writeFileSync(script, CHECK);
  const f = await fixture("lifecycle", undefined, { teams: { checkMinutes: 0.5, retention: { ...DEFAULT_TEAM_RETENTION, ...retention } } });
  const close = async () => {
    writeFileSync(release, "done");
    for (const pid of noted(log, "child")) if (alive(pid)) process.kill(pid, "SIGKILL");
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    f.host.config.projects[0]!.team!.checks = [{ command: process.execPath, args: [script, log, release, mode] }];
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const settled = await f.settled(created.body.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify({ status: settled.status, reason: settled.reason }));
    const helpers = noted(log, "child");
    assert.ok(helpers.length > 0 && helpers.every(alive), "the check left its helper running");
    return { f, id: settled.id, settled, helpers, log, release, runDirectory: dirname(settled.workspace), close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function cancel(f: Awaited<ReturnType<typeof fixture>>, run: TeamView) {
  const cancelled = await f.host.fetchApi(`/teams/${run.id}/cancel`, "owner", { requestId: randomUUID(), revision: run.revision });
  assert.equal(cancelled.body?.status, "cancelled", JSON.stringify(cancelled.body));
}

const remove = (f: Awaited<ReturnType<typeof fixture>>, id: string) => f.host.fetchApi(`/teams/${id}`, "owner", undefined, {}, "DELETE");

async function removedAfterEnd(t: Awaited<ReturnType<typeof leavingTeam>>) {
  writeFileSync(t.release, "done");
  await waitFor(async () => noted(t.log, "end"), ended => t.helpers.every(pid => ended.includes(pid)), 10_000);
  let last: Awaited<ReturnType<typeof remove>> | undefined;
  await waitFor(async () => (last = await remove(t.f, t.id)).status, status => status === 200, 30_000).catch(() => {});
  assert.equal(last?.status, 200, `removal is accepted once the helper ended: ${JSON.stringify(last?.body)}`);
  assert.equal(existsSync(t.runDirectory), false, "the run directory is removed");
  assert.ok((last?.body as TeamView).events.some(event => event.text === ENDED), JSON.stringify((last?.body as TeamView).events.slice(-4)));
}

test("a cancelled run keeps its directory while a process its passing check left holds the output, says why, refuses removal, and is removed after the process ends", POSIX, async () => {
  const t = await leavingTeam("always", { cancelledMinutes: 0 });
  try {
    await cancel(t.f, t.settled);
    await delay(2000);
    assert.equal(existsSync(t.runDirectory), true, "the run directory stays while the helper runs");
    assert.ok(t.settled.events.some(event => event.text === commandLeftoverEvent), "the run says the check left a process");
    assert.equal(commandLeftoverEvent, "A configured command exited while a process it started still held its output. The host judged the command by its exit code and neither waited for that process nor stopped it. It keeps this run's directories until a process census finds none of that command's processes.");
    assert.equal(t.settled.leftoverProcesses?.state, "unchecked");
    const held = await waitFor(() => t.f.get(t.id), run => run.leftoverProcesses?.state === "running", 30_000);
    assert.ok(held.leftoverProcesses?.checkedAt);
    assert.equal(held.events.filter(event => event.text === running(t.helpers.length)).length, 1, JSON.stringify(held.events.slice(-4)));
    const refused = await remove(t.f, t.id);
    assert.equal(refused.status, 409);
    assert.equal(refused.body?.code, "team-leftover-running", JSON.stringify(refused.body));
    const stated = await t.f.host.fetchApi(`/teams/${t.id}/processes-ended`, "owner", { requestId: randomUUID() });
    assert.equal(stated.body?.code, "team-command-running", "the owner's statement is refused while the census sees the helper");
    assert.equal((await remove(t.f, t.id)).body?.code, "team-leftover-running", "a refused statement leaves the hold");
    assert.equal(existsSync(t.runDirectory), true);
    assert.ok(t.helpers.every(alive));
    await removedAfterEnd(t);
  } finally { await t.close(); }
});

test("after host restarts before and during the hold, a cancelled run still keeps its directory and its record of the process its check left", POSIX, async () => {
  const t = await leavingTeam("always", { cancelledMinutes: 0 });
  try {
    await t.f.host.stopApi();
    await t.f.host.start();
    const restarted = await t.f.get(t.id);
    assert.equal(restarted.leftoverProcesses?.state, "unchecked", "the record of the process survives a restart before any census");
    await cancel(t.f, restarted);
    await waitFor(() => t.f.get(t.id), run => run.leftoverProcesses?.state === "running", 30_000);
    await t.f.host.stopApi();
    assert.ok(t.helpers.every(alive), "the helper outlived the host");
    await t.f.host.start();
    await delay(2000);
    assert.equal(existsSync(t.runDirectory), true, "the run directory stays after the restart while the helper runs");
    assert.equal((await t.f.get(t.id)).leftoverProcesses?.state, "running");
    assert.equal((await remove(t.f, t.id)).body?.code, "team-leftover-running");
    await removedAfterEnd(t);
  } finally { await t.close(); }
});

test("a later steer whose check passes without leaving a process keeps the record of the process the first check left", POSIX, async () => {
  const t = await leavingTeam("once");
  try {
    assert.equal(t.settled.leftoverProcesses?.state, "unchecked");
    const steer = { requestId: randomUUID(), revision: t.settled.revision, text: "Keep the original acceptance criteria and add nothing new." };
    let steered = await t.f.host.fetchApi(`/teams/${t.id}/steer`, "owner", steer);
    for (let attempt = 0; attempt < 40 && steered.status === 409 && steered.body.code === "team-operation-running"; attempt++) {
      await delay(50);
      steered = await t.f.host.fetchApi(`/teams/${t.id}/steer`, "owner", steer);
    }
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    const again = await waitFor(() => t.f.get(t.id), run => run.revision > t.settled.revision && ["ready-for-review", "merged", "blocked"].includes(run.status), 90_000);
    assert.equal(again.status, "ready-for-review", JSON.stringify({ status: again.status, reason: again.reason }));
    assert.equal(again.checks.at(-1)?.status, "passed");
    assert.ok(noted(t.log, "pass").length > 0, "the later check passed without leaving a process");
    assert.equal(noted(t.log, "child").length, t.helpers.length, "only the first check left a process");
    assert.equal(again.leftoverProcesses?.state, "unchecked", "the later operations kept the record");
    assert.ok(t.helpers.every(alive));
    await cancel(t.f, again);
    assert.equal((await remove(t.f, t.id)).body?.code, "team-leftover-running", "removal still waits for the first helper");
    await removedAfterEnd(t);
  } finally { await t.close(); }
});
