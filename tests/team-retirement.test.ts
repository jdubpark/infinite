import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBoundary, inventoryRuntimeProcesses, stopRuntimeTree, type RuntimeProcess } from "../packages/host/src/team-retirement.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (predicate()) return; await sleep(25); }
  assert.fail("Timed out waiting for process fixture");
}
function fixtureProcess(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }

test("retirement signals the stopped launcher and detached agent descendants through the configured boundary", async t => {
  if (process.platform !== "linux" || typeof process.getuid !== "function") { t.skip("Requires Linux process credentials and ps inventory"); return; }
  const root = mkdtempSync(join(tmpdir(), "team-retirement-")), receipts = join(root, "receipts"); mkdirSync(receipts);
  const prefix = { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/team-agent.mjs", import.meta.url)), "--command-prefix", receipts] };
  const boundary = agentBoundary(prefix, root);
  await boundary.uid();
  let launcher: ReturnType<typeof spawn> | undefined, unrelated: ReturnType<typeof spawn> | undefined;
  const spawnedPids = new Set<number>();
  try {
    const grandchildPath = join(root, "grandchild.cjs"), childPath = join(root, "child.cjs"), launcherPath = join(root, "launcher.cjs");
    const childPidFile = join(root, "child.pid"), grandPidFile = join(root, "grand.pid");
    writeFileSync(grandchildPath, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
    writeFileSync(childPath, "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const g=spawn(process.execPath,[process.argv[2]],{detached:true,stdio:'ignore'}); fs.writeFileSync(process.argv[3],String(g.pid)); setInterval(()=>{},1000);");
    writeFileSync(launcherPath, "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[4]],{stdio:'ignore'}); fs.writeFileSync(process.argv[5],String(c.pid)); setInterval(()=>{},1000);");
    launcher = spawn(process.execPath, [launcherPath, childPath, grandchildPath, grandPidFile, childPidFile], { stdio: "ignore" });
    unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await waitUntil(() => existsSync(childPidFile) && existsSync(grandPidFile));
    const childPid = Number(readFileSync(childPidFile, "utf8")), grandPid = Number(readFileSync(grandPidFile, "utf8"));
    spawnedPids.add(childPid); spawnedPids.add(grandPid);
    process.kill(launcher.pid!, "SIGSTOP");
    const base = await inventoryRuntimeProcesses();
    const known = base.filter(row => row.pid === launcher!.pid || row.pid === childPid || row.pid === grandPid);
    assert.equal(known.length, 3);
    const fakeAgentUid = process.getuid() + 100000;
    const agentPids = new Set([childPid, grandPid]);
    const hostSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await stopRuntimeTree(known, launcher.pid!, {
      timeoutMs: 8000, graceMs: 250,
      inventory: async () => (await inventoryRuntimeProcesses()).map(row => agentPids.has(row.pid) || row.pid === unrelated!.pid
        ? { ...row, ruid: fakeAgentUid, euid: fakeAgentUid } : row),
      agent: { uid: fakeAgentUid, signal: boundary.signal },
      signal: (pid, signal) => { hostSignals.push({ pid, signal }); process.kill(pid, signal); },
    });
    assert.equal(result.unsignalable.length, 0);
    const after = await inventoryRuntimeProcesses();
    for (const pid of [launcher.pid!, childPid, grandPid]) assert.ok(!after.some(row => row.pid === pid && !row.state.startsWith("Z")), `process ${pid} should exit`);
    assert.ok(after.some(row => row.pid === unrelated.pid && !row.state.startsWith("Z")), "unrelated agent process must survive");
    assert.ok(hostSignals.every(item => !agentPids.has(item.pid) && item.signal !== "SIGCONT"), JSON.stringify(hostSignals));
    const calls = readFileSync(join(receipts, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(calls.some(call => call.command === process.execPath && call.args[0] === "-e"), "agent signal must use configured team command prefix");
  } finally {
    for (const pid of spawnedPids) if (fixtureProcess(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    for (const child of [launcher, unrelated]) if (child?.pid && fixtureProcess(child.pid)) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown owners remain unsignaled and pid reuse is rejected", async () => {
  const born = "Mon Jan 01 00:00:00 2024", rows: RuntimeProcess[] = [
    { pid: process.pid, parent: 1, group: process.pid, ruid: process.getuid?.() ?? 0, euid: process.getuid?.() ?? 0, born, state: "S" },
    { pid: 400001, parent: process.pid, group: process.pid, ruid: process.getuid?.() ?? 0, euid: process.getuid?.() ?? 0, born, state: "S" },
    { pid: 400002, parent: 400001, group: process.pid, ruid: 0, euid: 0, born, state: "S" },
  ];
  const signaled: number[] = [];
  await assert.rejects(stopRuntimeTree(rows.slice(1), 400001, {
    timeoutMs: 100, graceMs: 25, inventory: async () => rows,
    signal: pid => { signaled.push(pid); },
  }), (error: unknown) => (error as { code?: string; message?: string }).code === "retirement-processes-alive" && (error as Error).message.includes("400002"));
  assert.deepEqual([...new Set(signaled)], [400001]);
  let retryRows = rows.filter(row => row.pid !== 400002);
  const replaySignals: number[] = [];
  const replay = await stopRuntimeTree(rows.slice(1), 400001, {
    inventory: async () => retryRows,
    signal: pid => { replaySignals.push(pid); retryRows = retryRows.filter(row => row.pid !== pid); },
  });
  assert.deepEqual(replaySignals, [400001]);
  assert.ok(replay.processes.some(row => row.pid === 400002), "retirement retains the identity of the naturally exited unknown process");
  const changed = rows.map(row => row.pid === 400001 ? { ...row, born: "Tue Jan 02 00:00:00 2024" } : row);
  const mismatchSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  await assert.rejects(stopRuntimeTree(rows.slice(1), 400001, {
    inventory: async () => changed,
    signal: (pid, signal) => { mismatchSignals.push({ pid, signal }); },
  }), (error: unknown) => (error as { code?: string }).code === "runtime-identity-changed");
  assert.deepEqual(mismatchSignals, [], "identity mismatch must not signal any PID");
  const agentRows = rows.map(row => row.pid === 400002 ? { ...row, ruid: 42, euid: 42 } : row);
  await assert.rejects(stopRuntimeTree(agentRows.slice(1), 400001, {
    inventory: async () => agentRows,
    agent: { uid: 42, signal: async () => ({ 400002: "changed" }) },
    signal: () => {},
  }), (error: unknown) => (error as { code?: string }).code === "runtime-identity-changed");
});

test("multi-UID configured-boundary deployment probe", { skip: !process.env.INFINITE_RETIREMENT_PROBE_PREFIX || !process.env.INFINITE_RETIREMENT_PROBE_CWD ? "Set the deployment probe prefix and host-created team workspace to run the multi-UID probe" : false }, async t => {
  if (process.platform !== "linux" || typeof process.getuid !== "function") { t.skip("Requires Linux process credentials"); return; }
  const prefix = JSON.parse(process.env.INFINITE_RETIREMENT_PROBE_PREFIX!) as TeamCommand;
  const cwd = process.env.INFINITE_RETIREMENT_PROBE_CWD!;
  const boundary = agentBoundary(prefix, cwd), uid = await boundary.uid();
  assert.notEqual(uid, process.getuid(), "probe must cross the configured agent UID boundary");
  const root = cwd, probe = `.infinite-retirement-probe-${randomUUID()}`;
  const grandchildPath = join(root, `${probe}-grandchild.cjs`), childPath = join(root, `${probe}-child.cjs`), launcherPath = join(root, `${probe}-launcher.cjs`);
  const childPidFile = join(root, `${probe}-child.pid`), grandPidFile = join(root, `${probe}-grand.pid`), unrelatedPidFile = join(root, `${probe}-unrelated.pid`);
  writeFileSync(grandchildPath, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
  writeFileSync(childPath, "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const g=spawn(process.execPath,[process.argv[2]],{detached:true,stdio:'ignore'}); fs.writeFileSync(process.argv[3],String(g.pid)); setInterval(()=>{},1000);");
  writeFileSync(launcherPath, "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[4]],{stdio:'ignore'}); fs.writeFileSync(process.argv[5],String(c.pid)); setInterval(()=>{},1000);");
  const unrelatedScript = `require('node:fs').writeFileSync(${JSON.stringify(unrelatedPidFile)},String(process.pid)); setInterval(()=>{},1000)`;
  const launch = (script: string) => spawn(prefix.command, [...prefix.args, process.execPath, "-e", script], { cwd, stdio: "ignore", env: process.env });
  const main = spawn(prefix.command, [...prefix.args, process.execPath, launcherPath, childPath, grandchildPath, grandPidFile, childPidFile], { cwd, stdio: "ignore", env: process.env });
  const unrelated = launch(unrelatedScript);
  const cleanupTargets: Array<{ pid: number; born: string; signal: NodeJS.Signals }> = [];
  try {
    await waitUntil(() => existsSync(childPidFile) && existsSync(grandPidFile) && existsSync(unrelatedPidFile));
    const childPid = Number(readFileSync(childPidFile, "utf8")), grandPid = Number(readFileSync(grandPidFile, "utf8"));
    const unrelatedAgentPid = Number(readFileSync(unrelatedPidFile, "utf8"));
    const rows = await inventoryRuntimeProcesses(), selected = new Set([main.pid!, childPid, grandPid]);
    const known = rows.filter(row => selected.has(row.pid)); assert.equal(known.length, 3);
    cleanupTargets.push(...known.filter(row => row.ruid === uid && row.euid === uid).map(row => ({ pid: row.pid, born: row.born, signal: "SIGKILL" as const })));
    const result = await stopRuntimeTree(known, main.pid!, { timeoutMs: 10000, graceMs: 250, agent: { uid, signal: boundary.signal } });
    assert.equal(result.unsignalable.length, 0);
    const after = await inventoryRuntimeProcesses();
    for (const pid of selected) assert.ok(!after.some(row => row.pid === pid && !row.state.startsWith("Z")), `retired tree process ${pid} should exit`);
    assert.ok(after.some(row => row.pid === unrelatedAgentPid && !row.state.startsWith("Z")), "unrelated agent-owned process must remain alive");
  } finally {
    if (cleanupTargets.length) await boundary.signal(cleanupTargets).catch(() => {});
    if (existsSync(unrelatedPidFile)) {
      const rows = await inventoryRuntimeProcesses().catch(() => []);
      const target = rows.find(row => row.pid === Number(readFileSync(unrelatedPidFile, "utf8")));
      if (target) await boundary.signal([{ pid: target.pid, born: target.born, signal: "SIGKILL" }]).catch(() => {});
    }
    for (const child of [main, unrelated]) if (child.pid && fixtureProcess(child.pid)) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ } }
    for (const file of [grandchildPath, childPath, launcherPath, childPidFile, grandPidFile, unrelatedPidFile]) { try { unlinkSync(file); } catch { /* already removed */ } }
  }
});
