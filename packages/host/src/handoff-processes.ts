import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export interface HandoffProcess { pid: number; parent: number; group: number; born: string; state: string }
/** No command lines or environment are collected. Failure is never interpreted as an empty tree. */
async function inventory(): Promise<HandoffProcess[]> {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Handoff process inventory is unsupported on this platform");
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  const rows = stdout.trim().split("\n").map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/);
    if (!match || !Number.isFinite(Date.parse(match[4]))) throw new Error("Process identity could not be inspected");
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), born: match[4], state: match[5] };
  });
  if (!rows.some(row => row.pid === process.pid)) throw new Error("Process inventory was incomplete");
  return rows;
}
function descendants(rows: HandoffProcess[], root: number, group?: number) {
  const selected = new Set([root]);
  for (const row of rows) if (row.group === group) selected.add(row.pid);
  for (;;) {
    const before = selected.size;
    for (const row of rows) if (selected.has(row.parent)) selected.add(row.pid);
    if (selected.size === before) break;
  }
  return rows.filter(row => selected.has(row.pid));
}
/** Covers the PTY group and observed descendants; agent attestation covers prior detached jobs. */
export async function stopHandoffProcesses(root: number, saveIntent: (processes: HandoffProcess[]) => void) {
  const first = await inventory(), leader = first.find(row => row.pid === root);
  if (!leader || leader.group !== root || root === process.pid || root <= 1) throw new Error("The source PTY process group could not be verified");
  let known = descendants(first, root, root);
  if (known.some(row => row.pid === process.pid)) throw new Error("Unsafe handoff process group");
  saveIntent(known);
  const signal = (pid: number, kind: NodeJS.Signals) => {
    try { process.kill(pid, kind); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("A source process could not be stopped"); }
  };
  // The group identity is verified while the leader is still present.
  signal(-root, "SIGTERM");
  for (const row of known) if (row.group !== root) signal(row.pid, "SIGTERM");
  const until = Date.now() + 5000;
  let killed = false;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const rows = await inventory();
    const reused = known.some(prior => rows.some(row => row.pid === prior.pid && row.born !== prior.born));
    if (reused) throw new Error("A source process identity changed during handoff");
    const liveKnown = rows.filter(row => known.some(prior => prior.pid === row.pid && prior.born === row.born));
    const current = descendants(rows, root, root).filter(row => !row.state.startsWith("Z"));
    for (const parent of liveKnown) for (const row of descendants(rows, parent.pid))
      if (!current.some(item => item.pid === row.pid)) current.push(row);
    const live = current.filter(row => !row.state.startsWith("Z"));
    if (!live.length) return;
    if (live.some(row => row.pid === process.pid)) throw new Error("Unsafe source process ancestry");
    const additions = live.filter(row => !known.some(prior => prior.pid === row.pid));
    if (additions.length) { known = [...known, ...additions]; saveIntent(known); }
    if (!killed && Date.now() >= until - 4000) {
      // Signal only still-matching identities, never an unverified reused group leader.
      for (const row of live) signal(row.pid, "SIGKILL");
      killed = true;
    } else if (killed) for (const row of additions) signal(row.pid, "SIGKILL");
  }
  throw new Error("Source processes have not confirmed exit; handoff remains blocked");
}
