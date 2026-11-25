import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TeamCommand } from "../packages/host/src/team-types.js";
import { STOP_GRACE_MS, STOP_SETTLE_MS } from "../packages/host/src/team-workspace.js";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";

const SUDO_ACCOUNT = "nobody";
const STOP_UNCONFIRMED = "A configured team command did not close after the host tried to stop it.";
const CHECK = [
  "const { appendFileSync, existsSync } = require('node:fs');",
  "const [log, release] = process.argv.slice(2);",
  "const note = word => appendFileSync(log, `${Date.now()} ${word} ${process.pid}\\n`);",
  "process.on('SIGTERM', () => note('term'));",
  "note('start');",
  "setInterval(() => { if (existsSync(release)) { note('end'); process.exit(0); } }, 50);",
  "setTimeout(() => process.exit(3), 120000);",
].join("\n");
const RELAY = [
  "const { spawn } = require('node:child_process');",
  "const { appendFileSync } = require('node:fs');",
  "const [log, command, ...args] = process.argv.slice(1);",
  "appendFileSync(log, `${Date.now()} ${process.cwd()} ${command} ${args.slice(0, 3).join(' ')}\\n`);",
  "const child = spawn(command, args, { stdio: 'inherit', detached: true });",
  "process.on('SIGTERM', () => child.kill('SIGTERM'));",
  "child.on('error', () => process.exit(127));",
  "child.on('exit', code => process.exit(code ?? 1));",
].join("\n");
const SUDO_RELAY = [
  "log=$1; check=$2; shift 2",
  "echo \"$(date +%s%3N) $PWD $*\" >> \"$log\"",
  `if [ "$2" = "$check" ]; then exec sudo -n -u ${SUDO_ACCOUNT} -- "$@"; fi`,
  "exec \"$@\"",
].join("\n");
const sudoUnavailable = (() => {
  if (process.platform !== "linux") return "the sudo case runs on Linux";
  try {
    execFileSync("sudo", ["-n", "-u", SUDO_ACCOUNT, "--", process.execPath, "-e", ""], { stdio: "ignore", timeout: 10_000 });
    return false;
  } catch {
    return `sudo -n -u ${SUDO_ACCOUNT} cannot run this Node on this machine`;
  }
})();

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function entries(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => {
    const [at, ...rest] = line.split(" ");
    return { at: Number(at), text: rest.join(" ") };
  }) : [];
}

async function stoppedCheckFencesTheWorkspace(prefixFor: (log: string, check: string) => TeamCommand, endCheck: (pid: number) => void) {
  const shared = mkdtempSync(join(tmpdir(), "team-check-stop-"));
  chmodSync(shared, 0o777);
  const checkFile = join(shared, "check.cjs"), checkLog = join(shared, "check.log"), release = join(shared, "release"), commands = join(shared, "commands.log");
  writeFileSync(checkFile, CHECK, { mode: 0o644 });
  const f = await fixture("lifecycle", undefined, { teams: { checkMinutes: 0.05, commandPrefix: prefixFor(commands, checkFile) } });
  let checkPid: number | undefined;
  try {
    f.host.config.projects[0]!.team!.checks = [{ command: process.execPath, args: [checkFile, checkLog, release] }];
    await f.host.stopApi();
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id;
    await waitFor(async () => entries(checkLog).find(entry => entry.text.startsWith("start")), Boolean, 60_000);
    const started = entries(checkLog).find(entry => entry.text.startsWith("start"))!;
    checkPid = Number(started.text.split(" ")[1]);
    const blocked = await waitFor(() => f.get(id), run => run.status === "blocked", 3_000 + STOP_SETTLE_MS + 20_000);
    assert.equal(blocked.reason, STOP_UNCONFIRMED, JSON.stringify(blocked.reason));
    assert.equal(blocked.pendingOperation?.kind, "check");
    assert.equal(blocked.pendingOperation?.failureCode, "command-stop-unconfirmed");
    assert.equal(blocked.checks.at(-1)?.status, "interrupted");
    assert.ok(entries(checkLog).some(entry => entry.text.startsWith("term")), "the relayed SIGTERM reached the check");
    assert.equal(alive(checkPid), true, "the check that ignored SIGTERM still runs");
    const resumed = await f.host.fetchApi(`/teams/${id}/resume`, "owner", { requestId: randomUUID(), revision: blocked.revision });
    assert.equal(resumed.body?.code, "team-reconciliation-required", JSON.stringify(resumed.body));
    const steered = await f.host.fetchApi(`/teams/${id}/steer`, "owner", { requestId: randomUUID(), revision: blocked.revision, text: "Try again." });
    assert.equal(steered.body?.code, "team-reconciliation-required", JSON.stringify(steered.body));
    const cancelled = await f.host.fetchApi(`/teams/${id}/cancel`, "owner", { requestId: randomUUID(), revision: blocked.revision });
    assert.equal(cancelled.body?.status, "cancelled", JSON.stringify(cancelled.body));
    const removed = await f.host.fetchApi(`/teams/${id}`, "owner", undefined, {}, "DELETE");
    assert.equal(removed.body?.code, "team-operation-running", JSON.stringify(removed.body));
    await delay(STOP_GRACE_MS);
    writeFileSync(release, "done");
    await waitFor(async () => entries(checkLog).find(entry => entry.text.startsWith("end")), Boolean, 10_000);
    const ended = entries(checkLog).find(entry => entry.text.startsWith("end"))!;
    const overlapping = entries(commands).filter(entry => entry.at >= started.at && entry.at <= ended.at);
    assert.deepEqual(overlapping, [], "the host started no command while the check it gave up on still ran");
    assert.equal((await f.get(id)).status, "cancelled");
  } finally {
    if (checkPid !== undefined && alive(checkPid)) endCheck(checkPid);
    await f.close();
    rmSync(shared, { recursive: true, force: true });
  }
}

test("a check that ignores the relayed SIGTERM blocks its run at the stop bound, and no command starts in the workspace until it ends", {
  timeout: 150_000, skip: process.platform === "win32" && "process groups are POSIX",
}, async () => {
  await stoppedCheckFencesTheWorkspace(
    (log) => ({ command: process.execPath, args: ["-e", RELAY, log] }),
    pid => process.kill(pid, "SIGKILL"));
});

test("under sudo, a check that ignores SIGTERM blocks its run at the stop bound, and no command starts in the workspace until it ends", {
  timeout: 150_000, skip: sudoUnavailable,
}, async () => {
  await stoppedCheckFencesTheWorkspace(
    (log, check) => ({ command: "/bin/sh", args: ["-c", SUDO_RELAY, "prefix", log, check] }),
    pid => { try { execFileSync("sudo", ["-n", "-u", SUDO_ACCOUNT, "--", "kill", "-KILL", String(pid)], { stdio: "ignore", timeout: 10_000 }); } catch { } });
});
