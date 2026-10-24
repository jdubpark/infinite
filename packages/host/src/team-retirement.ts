import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { TeamError, teamCommand } from "./team-workspace.js";
import type { TeamCommand } from "./team-types.js";

const execute = promisify(execFile);

export interface RuntimeProcess {
  pid: number; parent: number; group: number; ruid: number; euid: number; born: string; state: string;
}
export interface TeamRuntimeInspection {
  sessionId: string; status: "recording-error"; runtimeId: string | null; workerPid: number;
  pid: number | null; seq: number; since?: string; agentUid: number | null;
  processes: RuntimeProcess[]; identity: string;
}
export interface TeamRuntimeRetirement {
  state: "retired"; requestId: string; identity: string; sessionId: string; seq: number;
  stoppedAt: string; processes: RuntimeProcess[]; unsignalable: number[];
}
export interface RetirementOptions {
  timeoutMs?: number; signal?: (pid: number, signal: NodeJS.Signals) => void;
  inventory?: () => Promise<RuntimeProcess[]>;
  checkpoint?: (known: RuntimeProcess[]) => void | Promise<void>;
  agent?: { uid: number; signal(targets: { pid: number; born: string; signal: NodeJS.Signals }[]): Promise<Record<number, "signaled" | "exited" | "changed" | "denied">> };
}

export async function inventoryRuntimeProcesses(): Promise<RuntimeProcess[]> {
  if (!(["linux", "darwin"].includes(process.platform))) throw new Error("Runtime process inventory is unsupported on this platform");
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,pgid=,ruid=,uid=,lstart=,stat="], {
    encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (!stdout.trim()) throw new Error("Runtime process inventory was empty");
  const processes = stdout.trim().split("\n").map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/);
    if (!match || !Number.isFinite(Date.parse(match[6]))) throw new Error("Runtime process inventory was incomplete");
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), ruid: Number(match[4]), euid: Number(match[5]), born: match[6], state: match[7] };
  });
  if (!processes.some(row => row.pid === process.pid)) throw new Error("Runtime process inventory was incomplete");
  return processes;
}

const boundaryScript = String.raw`
const { execFileSync } = require('node:child_process');
const nonce = process.argv[1];
let input = '';
process.stdin.on('data', chunk => input += chunk.toString('utf8'));
process.stdin.on('end', () => {
const request = JSON.parse(input);
const uid = process.getuid();
if (request.op === 'uid') {
  process.stdout.write('INFINITE_RETIREMENT:' + nonce + ':' + JSON.stringify({ uid, results: {} }) + '\n');
} else {
  const results = {};
  for (const target of request.targets) {
    const pid = target.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) throw new Error('unsafe pid');
    if (target.signal !== 'SIGSTOP' && target.signal !== 'SIGKILL') throw new Error('unsafe signal');
    let born;
    try { born = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim(); }
    catch (error) {
      const failure = error;
      if (failure.status === 1 && !String(failure.stdout || '').trim()) { results[pid] = 'exited'; continue; }
      throw error;
    }
    if (!born) { results[pid] = 'exited'; continue; }
    if (born !== target.born) { results[pid] = 'changed'; continue; }
    try { process.kill(pid, target.signal); results[pid] = 'signaled'; }
    catch (error) { results[pid] = error.code === 'ESRCH' ? 'exited' : error.code === 'EPERM' ? 'denied' : (() => { throw error; })(); }
  }
  process.stdout.write('INFINITE_RETIREMENT:' + nonce + ':' + JSON.stringify({ uid, results }) + '\n');
}
});`;

export function agentBoundary(prefix: TeamCommand, cwd: string) {
  let verifiedUid: number | undefined;
  async function invoke(payload: unknown) {
    const nonce = randomUUID();
    let result: Awaited<ReturnType<typeof teamCommand>>;
    try { result = await teamCommand({ command: process.execPath, args: ["-e", boundaryScript, nonce] }, cwd, undefined, 15000, prefix, JSON.stringify(payload)); }
    catch { throw new TeamError(409, "retirement-boundary-unavailable", "The configured team process boundary did not complete safely."); }
    const marker = `INFINITE_RETIREMENT:${nonce}:`;
    if (result.exitCode !== 0 || result.interrupted || result.truncated) throw new TeamError(409, "retirement-boundary-unavailable", "The configured team process boundary did not complete safely.");
    const matches = result.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
    if (matches.length !== 1) throw new TeamError(409, "retirement-boundary-unavailable", "The configured team process boundary returned no valid identity proof.");
    try {
      const value = JSON.parse(matches[0].slice(marker.length));
      if (!Number.isSafeInteger(value.uid) || !value.results || typeof value.results !== "object") throw new Error("invalid boundary result");
      return value as { uid: number; results: Record<number, "signaled" | "exited" | "changed" | "denied"> };
    } catch { throw new TeamError(409, "retirement-boundary-unavailable", "The configured team process boundary returned invalid identity proof."); }
  }
  return {
    async uid() { verifiedUid = (await invoke({ op: "uid" })).uid; return verifiedUid; },
    async signal(targets: { pid: number; born: string; signal: NodeJS.Signals }[]) {
      if (verifiedUid === undefined) throw new TeamError(409, "retirement-boundary-unavailable", "Probe the configured team process identity before signaling.");
      const result = await invoke({ op: "signal", targets });
      if (result.uid !== verifiedUid) throw new TeamError(409, "runtime-identity-changed", "The configured agent process identity changed during retirement.");
      return result.results;
    },
  };
}

function descendants(rows: RuntimeProcess[], roots: Set<number>): RuntimeProcess[] {
  const selected = new Set(roots);
  for (;;) { const before = selected.size; for (const row of rows) if (selected.has(row.parent)) selected.add(row.pid); if (selected.size === before) break; }
  return rows.filter(row => selected.has(row.pid));
}
const live = (row: RuntimeProcess) => !row.state.startsWith("Z");
const identityChanged = () => new TeamError(409, "runtime-identity-changed", "A process identity changed during runtime retirement.");
const aliveError = (rows: RuntimeProcess[], known: RuntimeProcess[]) => Object.assign(new TeamError(409, "retirement-processes-alive", `Runtime processes remain alive: ${rows.map(row => `${row.pid} (${row.born})`).join(", ")}`), { knownProcesses: known });

export async function stopRuntimeTree(known: RuntimeProcess[], workerPid: number, options: RetirementOptions = {}): Promise<{ processes: RuntimeProcess[]; unsignalable: number[] }> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const inventory = options.inventory ?? inventoryRuntimeProcesses;
  const send = options.signal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const hostUid = typeof process.getuid === "function" ? process.getuid() : -1;
  const byPid = new Map<number, RuntimeProcess>();
  for (const row of known) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 1 || row.pid === process.pid) throw identityChanged();
    const prior = byPid.get(row.pid); if (prior && prior.born !== row.born) throw identityChanged(); byPid.set(row.pid, row);
  }
  if (!byPid.has(workerPid)) throw identityChanged();
  const unsignalable = new Set<number>(), signaled = new Set<string>();
  const signalHost = async (row: RuntimeProcess, signal: NodeJS.Signals) => {
    const key = `${row.pid}:${signal}`; if (signaled.has(key)) return;
    const now = (await inventory()).find(value => value.pid === row.pid);
    if (!now || !live(now)) return;
    if (now.born !== row.born) throw identityChanged();
    try { send(row.pid, signal); signaled.add(key); }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === "ESRCH") return; if (code === "EPERM") { unsignalable.add(row.pid); return; } throw error; }
  };
  const signalAgent = async (targets: RuntimeProcess[], signal: NodeJS.Signals) => {
    if (!targets.length) return;
    if (!options.agent) { targets.forEach(row => unsignalable.add(row.pid)); return; }
    const pending = targets.filter(row => !signaled.has(`${row.pid}:${signal}`));
    if (!pending.length) return;
    const results = await options.agent.signal(pending.map(row => ({ pid: row.pid, born: row.born, signal })));
    for (const row of pending) {
      const result = results[row.pid];
      if (result === "changed") throw identityChanged();
      if (result === "denied" || result === undefined) unsignalable.add(row.pid);
      else if (result === "signaled") signaled.add(`${row.pid}:${signal}`);
    }
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await inventory();
    if (!rows.some(row => row.pid === process.pid)) throw new Error("Runtime process inventory was incomplete");
    const current = new Map(rows.map(row => [row.pid, row]));
    for (const [pid, prior] of byPid) {
      const row = current.get(pid);
      if (row && row.born !== prior.born) throw identityChanged();
      if (row) byPid.set(pid, row);
    }
    const roots = new Set([...byPid.values()].filter(prior => { const row = current.get(prior.pid); return row?.born === prior.born && live(row); }).map(row => row.pid));
    const tree = descendants(rows, roots).filter(row => row.pid !== process.pid);
    if (tree.some(row => row.pid <= 1)) throw identityChanged();
    let discovered = false;
    for (const row of tree) { const prior = byPid.get(row.pid); if (prior && prior.born !== row.born) throw identityChanged(); if (!prior) { byPid.set(row.pid, row); discovered = true; } }
    // Persist new identities before any signal can orphan them or lose its acknowledgement.
    if (discovered) await options.checkpoint?.([...byPid.values()]);
    const alive = [...byPid.values()].filter(row => { const now = current.get(row.pid); return now?.born === row.born && live(now); });
    const agentRows = alive.filter(row => options.agent && row.ruid === options.agent.uid && row.euid === options.agent.uid && row.pid !== workerPid);
    const hostRows = alive.filter(row => row.pid === workerPid || (row.ruid === hostUid && row.pid !== workerPid));
    for (const row of alive) if (!agentRows.includes(row) && !hostRows.includes(row)) unsignalable.add(row.pid);
    if (alive.length === 0) return { processes: [...byPid.values()], unsignalable: [...unsignalable].sort((a, b) => a - b) };
    // Freeze parents before children, then inspect again. No termination handler
    // can fork an unobserved survivor after the whole known tree is stopped.
    const stopped = (row: RuntimeProcess) => /^[Tt]/.test(row.state);
    const signal: NodeJS.Signals = alive.every(stopped) ? "SIGKILL" : "SIGSTOP";
    const depth = (row: RuntimeProcess) => {
      const seen = new Set<number>();
      while (current.has(row.parent) && !seen.has(row.parent)) { seen.add(row.parent); row = current.get(row.parent)!; }
      return seen.size;
    };
    for (const row of [...alive].sort((a, b) => depth(a) - depth(b))) {
      if (signal === "SIGSTOP" && stopped(row)) continue;
      if (agentRows.includes(row)) await signalAgent([row], signal);
      else if (hostRows.includes(row)) await signalHost(row, signal);
    }
    if (Date.now() >= deadline) throw aliveError(alive, [...byPid.values()]);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export function runtimeIdentity(sessionId: string, assignment: unknown, runtimeId: string | null, worker: RuntimeProcess, pid: number | null, pty?: RuntimeProcess): string {
  return createHash("sha256").update(JSON.stringify({ sessionId, assignment, runtimeId, workerPid: worker.pid, worker: worker.born, pid, pidBorn: pty?.born ?? null })).digest("hex");
}
