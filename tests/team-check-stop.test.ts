import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CENSUS_WRAPPER } from "../packages/host/src/process-census.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";
import { COMMAND_STOP_UNCONFIRMED_REASON, STOP_SETTLE_MS } from "../packages/host/src/team-workspace.js";
import { waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";

const SUDO_ACCOUNT = "nobody";
const SHARED_BASE = "/tmp";
const SELF = userInfo().username;
const CENSUS_FILE = fileURLToPath(new URL("../packages/host/src/process-census.ts", import.meta.url));
const CHECK = [
  "const { appendFileSync, existsSync } = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "const [log, release, mode] = process.argv.slice(2);",
  "const note = word => appendFileSync(log, `${Date.now()} ${word} ${process.pid}\\n`);",
  "if (existsSync(release)) { note('pass'); process.exit(0); }",
  "const untilRelease = () => setInterval(() => { if (existsSync(release)) { note('end'); process.exit(0); } }, 50);",
  "setTimeout(() => process.exit(3), 120000);",
  "if (mode === 'child') { note('child'); untilRelease(); }",
  "else if (mode === 'ignores-term') { note('start'); process.on('SIGTERM', () => note('term')); untilRelease(); }",
  "else {",
  "  note('start');",
  "  const holds = mode === 'holds-output';",
  "  spawn(process.execPath, [__filename, log, release, 'child'], { stdio: holds ? 'inherit' : 'ignore', detached: holds });",
  "  setInterval(() => {}, 1000);",
  "}",
].join("\n");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function sharedDirectory() {
  const shared = mkdtempSync(join(SHARED_BASE, "team-check-stop-"));
  chmodSync(shared, 0o777);
  return shared;
}
const sudoUnavailable = (() => {
  if (process.platform !== "linux") return "the sudo cases run on Linux";
  const probe = sharedDirectory();
  try {
    execFileSync("sudo", ["-n", "-u", SELF, "--", "sudo", "-n", "-u", SUDO_ACCOUNT, "--", process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], '')", join(probe, "probe")], { stdio: "ignore", timeout: 10_000 });
    return false;
  } catch {
    return `sudo -n -u ${SELF} cannot run sudo -n -u ${SUDO_ACCOUNT} with this Node and write under ${SHARED_BASE} on this machine`;
  } finally {
    rmSync(probe, { recursive: true, force: true });
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

interface Harness { shared: string; checkFile: string; checkLog: string; release: string; commands: string; prefix?: TeamCommand; end(pid: number): void }

function harness(sudo: boolean): Harness {
  const shared = sharedDirectory();
  const checkFile = join(shared, "check.cjs"), checkLog = join(shared, "check.log"), release = join(shared, "release"), commands = join(shared, "commands.log");
  writeFileSync(checkFile, CHECK, { mode: 0o644 });
  if (!sudo) return { shared, checkFile, checkLog, release, commands, end: pid => process.kill(pid, "SIGKILL") };
  const launcher = join(shared, "team-run");
  writeFileSync(launcher, [
    "#!/bin/sh",
    `export PATH=${quote(process.env.PATH ?? "/usr/bin:/bin")} HOME=${quote(homedir())} GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0`,
    `echo "$(date +%s%3N) $PWD $*" >> ${quote(commands)}`,
    `if [ "$1" = ${quote(process.execPath)} ] && [ "$2" = ${quote(checkFile)} ]; then exec sudo -n -u ${SUDO_ACCOUNT} -- "$@"; fi`,
    "exec \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(shared, CENSUS_WRAPPER), `#!/bin/sh\nexec ${[process.execPath, "--import", import.meta.resolve("tsx"), CENSUS_FILE].map(quote).join(" ")}\n`, { mode: 0o755 });
  return { shared, checkFile, checkLog, release, commands, prefix: { command: "sudo", args: ["-n", "-u", SELF, "--", launcher] },
    end: pid => { try { execFileSync("sudo", ["-n", "-u", SUDO_ACCOUNT, "--", "kill", "-KILL", String(pid)], { stdio: "ignore", timeout: 10_000 }); } catch { } } };
}

async function teamWithCheck(h: Harness, mode: string) {
  const f = await fixture("lifecycle", undefined, { teams: { checkMinutes: 0.05, ...(h.prefix ? { commandPrefix: h.prefix } : {}) } });
  f.host.config.projects[0]!.team!.checks = [{ command: process.execPath, args: [h.checkFile, h.checkLog, h.release, mode] }];
  await f.host.stopApi();
  writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
  await f.host.start();
  const created = await f.host.fetchApi("/teams", "owner", f.create());
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  return { f, id: created.body.id as string };
}

async function entry(file: string, word: string, pid?: number, timeoutMs = 60_000) {
  const find = () => entries(file).find(item => item.text.startsWith(`${word} `) && (pid === undefined || item.text === `${word} ${pid}`));
  await waitFor(async () => find(), Boolean, timeoutMs);
  const found = find()!;
  return { at: found.at, pid: Number(found.text.split(" ")[1]) };
}

function pidsIn(file: string) {
  return entries(file).map(item => Number(item.text.split(" ")[1])).filter(pid => Number.isSafeInteger(pid) && pid > 1);
}

async function resumedOnceEnded(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  let last: { status: number; body?: { code?: string } } | undefined;
  await waitFor(async () => {
    const run = await f.get(id);
    last = await f.host.fetchApi(`/teams/${id}/resume`, "owner", { requestId: randomUUID(), revision: run.revision });
    return last.status;
  }, status => status === 200, 30_000).catch(() => {});
  assert.equal(last?.status, 200, `Resume is accepted once the command ended: ${JSON.stringify(last?.body)}`);
}

async function stoppedCheckIsFenced(sudo: boolean, mode: "holds-output" | "leaves-child") {
  const h = harness(sudo);
  const { f, id } = await teamWithCheck(h, mode);
  try {
    const first = await entry(h.checkLog, "start");
    const child = await entry(h.checkLog, "child", undefined, 10_000);
    const blocked = await waitFor(() => f.get(id), run => run.status === "blocked", 3_000 + STOP_SETTLE_MS + 20_000);
    assert.equal(blocked.reason, COMMAND_STOP_UNCONFIRMED_REASON, JSON.stringify(blocked.reason));
    assert.equal(blocked.pendingOperation?.kind, "check");
    assert.equal(blocked.pendingOperation?.failureCode, "command-stop-unconfirmed");
    assert.equal(blocked.checks.at(-1)?.status, "interrupted");
    assert.equal(alive(first.pid), false, "the stop ended the check's first process");
    assert.equal(alive(child.pid), true, "the first process's child still runs");
    for (const action of ["resume", "steer"] as const) {
      const refused = await f.host.fetchApi(`/teams/${id}/${action}`, "owner", { requestId: randomUUID(), revision: blocked.revision, ...(action === "steer" ? { text: "Try again." } : {}) });
      assert.equal(refused.body?.code, "team-command-running", `${action}: ${JSON.stringify(refused.body)}`);
    }
    assert.equal((await f.get(id)).checks.length, blocked.checks.length, "no check started while the child ran");
    writeFileSync(h.release, "done");
    const ended = await entry(h.checkLog, "end", child.pid, 10_000);
    if (sudo) assert.deepEqual(entries(h.commands).filter(item => item.at >= first.at && item.at <= ended.at), [], "the host started no command while the check's child ran");
    await resumedOnceEnded(f, id);
  } finally {
    for (const pid of pidsIn(h.checkLog)) if (alive(pid)) h.end(pid);
    await f.close();
    rmSync(h.shared, { recursive: true, force: true });
  }
}

test("a check stopped at its time limit whose child keeps the output open blocks its run at the stop bound; Resume and steering wait for a census that finds none of its processes", {
  timeout: 150_000, skip: process.platform === "win32" && "process groups are POSIX",
}, async () => {
  await stoppedCheckIsFenced(false, "holds-output");
});

test("under a sudo prefix, a check stopped at its time limit whose first process ends while its child runs on blocks its run; nothing starts in the workspace and Resume waits for a census that finds none of its processes", {
  timeout: 150_000, skip: sudoUnavailable,
}, async () => {
  await stoppedCheckIsFenced(true, "leaves-child");
});

test("under a sudo prefix, after the host ends in the middle of a stop, removal of the cancelled run is refused while the check runs and accepted after it ended", {
  timeout: 150_000, skip: sudoUnavailable,
}, async () => {
  const h = harness(true);
  const { f, id } = await teamWithCheck(h, "ignores-term");
  try {
    const first = await entry(h.checkLog, "start");
    const running = await f.get(id);
    const cancelled = await f.host.fetchApi(`/teams/${id}/cancel`, "owner", { requestId: randomUUID(), revision: running.revision });
    assert.equal(cancelled.body?.status, "cancelled", JSON.stringify(cancelled.body));
    await delay(1_000);
    await f.host.stopApi();
    assert.equal(alive(first.pid), true, "the check outlived the host");
    await f.host.start();
    const refused = await f.host.fetchApi(`/teams/${id}`, "owner", undefined, {}, "DELETE");
    assert.equal(refused.body?.code, "team-operation-running", JSON.stringify(refused.body));
    assert.equal(existsSync(h.checkLog) && entries(h.checkLog).some(item => item.text === `term ${first.pid}`), true, "the relayed SIGTERM reached the check before the host ended");
    writeFileSync(h.release, "done");
    await entry(h.checkLog, "end", first.pid, 10_000);
    let last: { status: number; body?: { code?: string } } | undefined;
    await waitFor(async () => (last = await f.host.fetchApi(`/teams/${id}`, "owner", undefined, {}, "DELETE")).status, status => status === 200, 30_000).catch(() => {});
    assert.equal(last?.status, 200, `removal is accepted once the check ended: ${JSON.stringify(last?.body)}`);
  } finally {
    for (const pid of pidsIn(h.checkLog)) if (alive(pid)) h.end(pid);
    await f.close();
    rmSync(h.shared, { recursive: true, force: true });
  }
});
