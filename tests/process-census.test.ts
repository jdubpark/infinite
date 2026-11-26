import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WITNESS_LIMIT, directoryCensus, excuseEarlier, extendWitness, newWitness, operationCensus, processStart, readProcessTable, recordCommand, statusRunsAs, witnessFindings,
  type CensusFinding, type EarlierProcesses, type ProcessRow, type ProcessTable, type ProcessWitness } from "../packages/host/src/process-census.js";

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

test("a process is the account's when the account is an id it runs with, not when the account only started it (INF-402)", () => {
  const status = (ids: string) => `Name:\tsudo\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t4242\nUid:\t${ids}\nGid:\t999\t0\t0\t0\nGroups:\t999\n`;
  assert.equal(statusRunsAs(status("999\t0\t0\t0"), 999), false);
  assert.equal(statusRunsAs(status("999\t0\t0\t0"), 0), true);
  assert.equal(statusRunsAs(status("0\t999\t0\t0"), 999), true, "effective");
  assert.equal(statusRunsAs(status("0\t0\t999\t0"), 999), true, "saved");
  assert.equal(statusRunsAs(status("0\t0\t0\t999"), 999), true, "filesystem");
  assert.equal(statusRunsAs(status("1000\t1000\t1000\t1000"), 999), false, "another account");
  assert.equal(statusRunsAs("Pid:\t999\nUid:\t1000\t0\t0\t0\nGid:\t999\t999\t999\t999\n", 999), false);
  for (const text of ["", "Name:\tx\n", status("999\t0\t0"), status("999\t0\t0\t0\t0"), status("999\tx\t0\t0"), status("")]) assert.equal(statusRunsAs(text, 999), true, JSON.stringify(text));
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
  const t = table([row(31, 1, 30, 30, "x"), row(32, 31, 32, 32, "y")]);
  assert.deepEqual(witnessFindings(w, t), [{ pid: 31, reason: "recorded-session" }]);
  assert.equal(extendWitness(w, t), true);
  assert.deepEqual(witnessFindings(w, t), [{ pid: 31, reason: "recorded-session" }, { pid: 32, reason: "recorded-session" }]);
});

test("only a process that refused inspection and still has the start token recorded before the operation is excused (INF-403)", async () => {
  const positive = { finding: { pid: 10, reason: "unreadable" } as CensusFinding, earlier: [{ pid: 10, start: "a" }] as EarlierProcesses, current: "a" as string | undefined | Error };
  const excused = async (fixture: typeof positive) => excuseEarlier([fixture.finding], fixture.earlier, async () => {
    if (fixture.current instanceof Error) throw fixture.current;
    return fixture.current;
  });
  assert.deepEqual(await excused(positive), [], "the recorded process is excused");
  const negatives: [string, typeof positive][] = [
    ["another start token: the pid was reused", { ...positive, current: "b" }],
    ["the process has gone and its start cannot be read", { ...positive, current: undefined }],
    ["the start read failed", { ...positive, current: new Error("EIO") }],
    ["another pid", { ...positive, earlier: [{ pid: 11, start: "a" }] }],
    ["nothing recorded", { ...positive, earlier: [] }],
    ["a finding that is not unreadable", { ...positive, finding: { pid: 10, reason: "working-directory" } }],
  ];
  for (const [name, fixture] of negatives) assert.deepEqual(await excused(fixture), [fixture.finding], name);
  assert.deepEqual(await excuseEarlier([positive.finding], undefined, async () => "a"), [positive.finding], "no anchor excuses nothing");
  const mixed: CensusFinding[] = [{ pid: 10, reason: "unreadable" }, { pid: 11, reason: "recorded-group" }, { pid: 12, reason: "open-file" }, { pid: 13, reason: "unreadable" }];
  let asked = 0;
  assert.deepEqual(await excuseEarlier(mixed, "all", async () => { asked += 1; return undefined; }), [mixed[1], mixed[2]], "all excuses every unreadable finding and nothing else");
  assert.equal(asked, 0);
});

test("a witness that reached its limit drops nothing and cannot say that no process is left", async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  try {
    const w = newWitness();
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
    const elsewhere = await directoryCensus(join(tmpdir(), `census-elsewhere-${process.pid}`));
    assert.equal(elsewhere.ok, true, elsewhere.ok ? "" : elsewhere.problem);
    assert.deepEqual(elsewhere.ok ? elsewhere.findings.filter(finding => finding.pid === child.pid) : undefined, []);
  } finally {
    try { process.kill(child.pid!, "SIGKILL"); } catch { }
    rmSync(directory, { recursive: true, force: true });
  }
});

const canLeaveExitedChild = (process.platform === "linux" || process.platform === "darwin") && spawnSync("python3", ["-c", ""]).status === 0;
test("an exited process that waits for its parent holds nothing and is not reported (INF-402)", { skip: !canLeaveExitedChild }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  const script = ["import os, time", "pid = os.fork()", "if pid == 0: os._exit(0)", "print(pid, flush=True)", "time.sleep(60)", ""].join("\n");
  const parent = spawn("python3", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const [line] = await once(parent.stdout!, "data") as [Buffer];
    const exited = Number.parseInt(line.toString("utf8"), 10);
    assert.ok(Number.isSafeInteger(exited) && exited > 0, `the parent should print its child's pid, got ${JSON.stringify(line.toString("utf8"))}`);
    const state = (): string | undefined => {
      if (process.platform !== "linux") return spawnSync("/bin/ps", ["-p", String(exited), "-o", "stat="], { encoding: "utf8" }).stdout.trim().charAt(0) || undefined;
      try { const stat = readFileSync(`/proc/${exited}/stat`, "utf8"); return stat[stat.lastIndexOf(")") + 2]; } catch { return undefined; }
    };
    const until = Date.now() + 5000;
    while (state() !== "Z" && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(state(), "Z", "the child should have exited and wait for its parent");
    const census = await directoryCensus(directory);
    assert.equal(census.ok, true, census.ok ? "" : census.problem);
    assert.deepEqual(census.ok ? census.findings.filter(finding => finding.pid === exited) : undefined, []);
  } finally {
    try { process.kill(parent.pid!, "SIGKILL"); } catch { }
    rmSync(directory, { recursive: true, force: true });
  }
});

const canHideFromItsAccount = process.platform === "linux" && process.getuid?.() !== 0 && spawnSync("python3", ["-c", "import ctypes; ctypes.CDLL(None).prctl"]).status === 0;
test("a process that cannot be inspected is reported, and is not when it can be a moment later (INF-402)", { skip: !canHideFromItsAccount }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  const script = [
    "import ctypes, sys, time",
    "libc = ctypes.CDLL(None)",
    "for line in sys.stdin:",
    "    word = line.split()",
    "    if word[0] == 'hide':",
    "        assert libc.prctl(4, 0, 0, 0, 0) == 0",
    "        print('hidden', flush=True)",
    "    else:",
    "        time.sleep(int(word[1]) / 1000)",
    "        assert libc.prctl(4, 1, 0, 0, 0) == 0",
    "        print('shown %d' % int(time.time() * 1000), flush=True)",
    "",
  ].join("\n");
  const child = spawn("python3", ["-c", script], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  const answer = async (command: string) => { child.stdin!.write(`${command}\n`); return String((await lines.next()).value); };
  const reported = async () => {
    const census = await directoryCensus(directory);
    assert.equal(census.ok, true, census.ok ? "" : census.problem);
    return census.ok ? census.findings.filter(finding => finding.pid === child.pid) : [];
  };
  try {
    assert.equal(await answer("hide"), "hidden");
    assert.equal(statSync(`/proc/${child.pid}`).uid, process.getuid!());
    assert.deepEqual(await reported(), [{ pid: child.pid, reason: "unreadable" }], "a process that stays hidden is reported");
    let decided = false;
    for (let attempt = 0; attempt < 5 && !decided; attempt += 1) {
      if (attempt > 0) assert.equal(await answer("hide"), "hidden");
      const begun = Date.now();
      const shown = answer("show-after 60");
      const findings = await reported();
      const shownAt = Number((await shown).split(" ")[1]);
      if (shownAt >= begun + 100) continue;
      assert.deepEqual(findings, [], "a process that could be inspected at the second look is not reported");
      decided = true;
    }
    if (!decided) t.skip("the process never showed itself within 100 ms, so the second look was not exercised");
  } finally {
    try { process.kill(child.pid!, "SIGKILL"); } catch { }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a process that hides is still reported when its first thread has exited (INF-402)", { skip: !canExitFirstThread || !canHideFromItsAccount }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  const script = ["import ctypes, threading, time", "libc = ctypes.CDLL(None)", "assert libc.prctl(4, 0, 0, 0, 0) == 0",
    "threading.Thread(target=time.sleep, args=(60,)).start()", `libc.syscall(${threadExit}, 0)`, ""].join("\n");
  const child = spawn("python3", ["-c", script], { cwd: directory, detached: true, stdio: "ignore" });
  try {
    const until = Date.now() + 5000;
    const firstThreadExited = () => { try { const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8"); return stat[stat.lastIndexOf(")") + 2] === "Z"; } catch { return false; } };
    while (!firstThreadExited() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(firstThreadExited(), true, "the first thread should have exited");
    const census = await directoryCensus(directory);
    assert.equal(census.ok, true, census.ok ? "" : census.problem);
    assert.deepEqual(census.ok ? census.findings.filter(finding => finding.pid === child.pid) : [], [{ pid: child.pid, reason: "unreadable" }]);
  } finally {
    try { process.kill(child.pid!, "SIGKILL"); } catch { }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a hidden process recorded with its start token is excused, and one started later or with another token is not (INF-403)", { skip: !canHideFromItsAccount }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "census-"));
  const script = ["import ctypes, sys, time", "assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0", "print('hidden', flush=True)", "time.sleep(60)", ""].join("\n");
  const children = [0, 1].map(() => spawn("python3", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] }));
  try {
    for (const child of children) assert.equal(String((await createInterface({ input: child.stdout! })[Symbol.asyncIterator]().next()).value), "hidden");
    const [before, after] = children.map(child => child.pid!);
    const start = await processStart(before!);
    assert.equal(typeof start, "string");
    const reported = async (earlier: EarlierProcesses | undefined) => {
      const census = await operationCensus(newWitness(), directory, undefined, earlier);
      assert.equal(census.ok, true, census.ok ? "" : census.problem);
      return census.ok ? census.findings.filter(finding => finding.pid === before || finding.pid === after).sort((a, b) => a.pid - b.pid) : [];
    };
    assert.deepEqual(await reported(undefined), [{ pid: before, reason: "unreadable" }, { pid: after, reason: "unreadable" }]);
    assert.deepEqual(await reported([{ pid: before!, start: start! }]), [{ pid: after, reason: "unreadable" }]);
    assert.deepEqual(await reported([{ pid: before!, start: `${start}0` }]), [{ pid: before, reason: "unreadable" }, { pid: after, reason: "unreadable" }]);
    assert.deepEqual(await reported("all"), []);
  } finally {
    for (const child of children) try { process.kill(child.pid!, "SIGKILL"); } catch { }
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
