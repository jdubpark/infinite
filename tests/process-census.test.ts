import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WITNESS_LIMIT, directoryCensus, extendWitness, newWitness, operationCensus, processStart, readProcessTable, recordCommand, statusActsAs, witnessFindings,
  type ProcessRow, type ProcessTable, type ProcessWitness } from "../packages/host/src/process-census.js";

const censusFile = fileURLToPath(new URL("../packages/host/src/process-census.ts", import.meta.url));

function row(pid: number, ppid: number, pgid: number, sid: number | undefined, start: string): ProcessRow {
  return { pid, ppid, pgid, sid, uid: 0, start, command: "x" };
}
function table(rows: ProcessRow[], boot = "boot-1"): ProcessTable {
  return { boot, rows };
}
function witness(processes: { pid: number; start: string }[], boot = "boot-1"): ProcessWitness {
  return { boot, processes, sessions: [], groups: [] };
}

test("a process is the account's when it runs as it or can again, not when the account only started it (INF-402)", () => {
  const status = (ids: string) => `Name:\tsudo\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t4242\nUid:\t${ids}\nGid:\t999\t0\t0\t0\nGroups:\t999\n`;
  // The sudo process of a command the host started: real user id 999, and root in the three ids it acts with.
  assert.equal(statusActsAs(status("999\t0\t0\t0"), 999), false);
  assert.equal(statusActsAs(status("999\t0\t0\t0"), 0), true);
  // A process that can act as the account again stays the account's, whatever it runs as now.
  assert.equal(statusActsAs(status("0\t999\t0\t0"), 999), true, "effective");
  assert.equal(statusActsAs(status("0\t0\t999\t0"), 999), true, "saved");
  assert.equal(statusActsAs(status("0\t0\t0\t999"), 999), true, "filesystem");
  assert.equal(statusActsAs(status("1000\t1000\t1000\t1000"), 999), false, "another account");
  // The account's gid on the Gid line and a pid that equals the uid name nobody.
  assert.equal(statusActsAs("Pid:\t999\nUid:\t1000\t0\t0\t0\nGid:\t999\t999\t999\t999\n", 999), false);
  // A status that cannot be classified is reported, never skipped.
  for (const text of ["", "Name:\tx\n", status("999\t0\t0"), status("999\t0\t0\t0\t0"), status("999\tx\t0\t0"), status("")]) assert.equal(statusActsAs(text, 999), true, JSON.stringify(text));
});

test("a witness follows a recorded process's descendants into their own sessions and groups", () => {
  const w = witness([{ pid: 10, start: "a" }]);
  const t = table([row(10, 1, 10, 10, "a"), row(11, 10, 11, 11, "b"), row(12, 11, 11, 11, "c"), row(99, 1, 99, 99, "d")]);
  assert.equal(extendWitness(w, t), true);
  assert.deepEqual(w.sessions, [10, 11]);
  assert.deepEqual(w.groups, [10, 11]);
  assert.equal(extendWitness(w, t), false);
});

test("a reused pid with another start token is not the recorded process", () => {
  const w = witness([{ pid: 10, start: "a" }]);
  const t = table([row(10, 1, 10, 10, "other")]);
  assert.equal(extendWitness(w, t), false);
  assert.deepEqual(witnessFindings(w, t), []);
});

test("a table from another boot changes nothing and finds nothing", () => {
  const w = witness([{ pid: 10, start: "a" }]);
  const t = table([row(10, 1, 10, 10, "a")], "boot-2");
  assert.equal(extendWitness(w, t), false);
  assert.deepEqual(witnessFindings(w, t), []);
  assert.deepEqual(w.groups, []);
});

test("a process in a recorded group is found after its recorded parent has gone", () => {
  const w = witness([]);
  w.groups.push(20);
  const t = table([row(21, 1, 20, 20, "b"), row(22, 1, 22, 22, "c")]);
  assert.deepEqual(witnessFindings(w, t), [{ pid: 21, reason: "recorded-group" }]);
});

test("a started command is recorded as the leader of its session and group, and what joins them later is followed", () => {
  const w = witness([]);
  assert.equal(recordCommand(w, 30), true);
  assert.deepEqual([w.processes, w.sessions, w.groups], [[], [30], [30]]);
  assert.equal(recordCommand(w, 30, "s"), true);
  assert.equal(recordCommand(w, 30, "s"), false);
  // The command has gone; a child it left in its session is found, and that child's own new session is followed.
  const t = table([row(31, 1, 30, 30, "x"), row(32, 31, 32, 32, "y")]);
  assert.deepEqual(witnessFindings(w, t), [{ pid: 31, reason: "recorded-session" }]);
  assert.equal(extendWitness(w, t), true);
  assert.deepEqual(witnessFindings(w, t), [{ pid: 31, reason: "recorded-session" }, { pid: 32, reason: "recorded-session" }]);
});

test("a witness that reached its limit drops nothing and cannot say that no process is left", async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  try {
    const w = newWitness();
    // Ids above any process id, so nothing on this host matches them.
    for (let id = 1; id <= WITNESS_LIMIT + 1; id++) recordCommand(w, 1_000_000_000 + id);
    assert.equal(w.overflow, true);
    assert.equal(w.sessions.length, WITNESS_LIMIT);
    assert.equal(w.sessions[0], 1_000_000_001, "the first entries are kept");
    assert.deepEqual(await operationCensus(w, directory), { ok: false, problem: "the operation started more processes than the host records" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const threadExit = { x64: 60, arm64: 93 }[process.arch as "x64" | "arm64"];
const canExitFirstThread = process.platform === "linux" && threadExit !== undefined && spawnSync("python3", ["-c", ""]).status === 0;
test("a process whose first thread has exited is still found through its other threads", { skip: !canExitFirstThread }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  // The first thread leaves with the thread-exit system call; the process lives on in its second thread.
  const script = `import ctypes, threading, time\nthreading.Thread(target=time.sleep, args=(60,)).start()\nctypes.CDLL(None).syscall(${threadExit}, 0)\n`;
  const child = spawn("python3", ["-c", script], { cwd: directory, detached: true, stdio: "ignore" });
  try {
    const until = Date.now() + 5000;
    const firstThreadExited = () => { try { const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8"); return stat[stat.lastIndexOf(")") + 2] === "Z"; } catch { return false; } };
    while (!firstThreadExited() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(firstThreadExited(), true, "the first thread should have exited");
    const census = await directoryCensus(directory);
    assert.equal(census.ok, true, census.ok ? "" : census.problem);
    assert.deepEqual(census.ok ? census.findings.filter(finding => finding.pid === child.pid) : [], [{ pid: child.pid, reason: "working-directory" }]);
  } finally {
    try { process.kill(child.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the census never reports the calling process", () => {
  const w = witness([]);
  w.groups.push(process.pid);
  assert.deepEqual(witnessFindings(w, table([row(process.pid, 1, process.pid, process.pid, "self")])), []);
});

test("a detached child in a temporary directory is found, then not found after it exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { cwd: directory, detached: true, stdio: "ignore" });
  try {
    const start = await waitForStart(child.pid!);
    const w = newWitness();
    w.processes.push({ pid: child.pid!, start });
    extendWitness(w, await readProcessTable());

    const live = await operationCensus(w, directory);
    assert.equal(live.ok, true, live.ok ? "" : live.problem);
    const mine = live.ok ? live.findings.filter(finding => finding.pid === child.pid) : [];
    assert.equal(mine.length, 1);
    assert.ok(["recorded-process", "working-directory"].includes(mine[0]!.reason), mine[0]!.reason);

    child.kill("SIGKILL");
    await once(child, "exit");
    // Other processes of the test account may refuse inspection (a login session does); they are not findings about the directory.
    const after = await operationCensus(w, directory);
    assert.equal(after.ok, true, after.ok ? "" : after.problem);
    assert.deepEqual(after.ok ? after.findings.filter(finding => finding.reason !== "unreadable") : undefined, []);
    assert.equal(await processStart(child.pid!), undefined);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a non-sudo prefix is unsupported and a sudo prefix without its wrapper cannot finish", async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  try {
    assert.deepEqual(await operationCensus(newWitness(), directory, { command: "/bin/echo", args: [] }),
      { ok: false, problem: "prefix-unsupported" });
    const missing = await operationCensus(newWitness(), directory,
      { command: "/usr/bin/sudo", args: ["-n", "--", "/nonexistent-census-test/provider"] });
    assert.deepEqual(missing, { ok: false, problem: "census wrapper missing" });
    assert.equal((await directoryCensus("relative/path")).ok, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the command-line entry prints the census as JSON and rejects an argument", () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  try {
    const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), censusFile], { input: `${directory}\n`, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.findings));

    const argument = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), censusFile, "extra"], { input: `${directory}\n`, encoding: "utf8" });
    assert.equal(argument.status, 64);
    assert.match(argument.stderr, /takes no arguments/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitForStart(pid: number): Promise<string> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const start = await processStart(pid);
    if (start !== undefined) return start;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("the child did not start");
}
