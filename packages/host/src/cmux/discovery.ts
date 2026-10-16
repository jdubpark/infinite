import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { object, string, execute } from "./client.js";

export type CmuxProvider = "claude" | "codex";
export interface HookSession {
  provider: CmuxProvider;
  nativeId: string;
  surfaceId?: string;
  workspaceId?: string;
  cwd?: string;
  lifecycle: string;
  transcript?: string;
  message?: string;
  pid?: number;
  updatedAt: number;
}

export function readHooks(directory: string): HookSession[] {
  const hooks: HookSession[] = [];
  for (const provider of ["claude", "codex"] as const) {
    try {
      const path = join(directory, `${provider}-hook-sessions.json`);
      if (statSync(path).size > 8 * 1024 * 1024) continue;
      const data = object(JSON.parse(readFileSync(path, "utf8")));
      for (const [key, value] of Object.entries(object(data.sessions))) {
        const raw = object(value);
        const nativeId = string(raw.sessionId) ?? key;
        if (!nativeId || nativeId.length > 200) continue;
        const pid = Number(raw.pid);
        const timestamp = typeof raw.updatedAt === "string" && !Number.isFinite(Number(raw.updatedAt))
          ? Date.parse(raw.updatedAt) : Number(raw.updatedAt) * 1000;
        hooks.push({
          provider, nativeId,
          surfaceId: string(raw.surfaceId), workspaceId: string(raw.workspaceId),
          cwd: string(raw.cwd), lifecycle: string(raw.agentLifecycle) ?? "unknown",
          transcript: string(raw.transcriptPath), message: string(raw.lastBody),
          pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
          updatedAt: Number.isFinite(timestamp) ? timestamp : 0,
        });
      }
    } catch { /* Missing or incomplete hook files provide no authority. */ }
  }
  return hooks;
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export const LAUNCH_ENV = "INFINITE_CMUX_LAUNCH";

/**
 * A hook PID alone is not authority to type. Require its foreground process group,
 * terminal and provider command. Suspended agents and background helpers fail closed.
 * Local typing and other cmux controllers remain outside this host's lease boundary.
 */
export async function foregroundAgent(record: {
  pid?: number; hookAt?: number; launchId?: string; surfaceId?: string; tty?: string; provider: CmuxProvider;
}, command?: string): Promise<boolean> {
  try {
    let pid = record.pid;
    const tty = record.tty?.replace(/^\/dev\//, "");
    if (!pid && record.launchId && !tty) {
      const out = await execute("ps", ["-ww", "-E", "-ax", "-o", "pid=", "-o", "command="], 3000);
      const tag = `${LAUNCH_ENV}=${record.launchId}`;
      for (const line of out.split("\n")) {
        if (!line.split(/\s+/).includes(tag)) continue;
        // Environment membership ties the process to the cmux surface as well as
        // the launch. Never confuse another terminal inheriting the launch tag.
        if (record.surfaceId && !line.split(/\s+/).includes(`CMUX_SURFACE_ID=${record.surfaceId}`)) continue;
        const candidate = Number(line.trim().split(/\s+/, 1)[0]);
        if (Number.isSafeInteger(candidate) && candidate > 0) { pid = candidate; break; }
      }
    }
    if (!pid && !tty) return false;
    if (tty && !/^(?:tty[\w.]+|pts\/\d+)$/.test(tty)) return false;
    if (pid && record.hookAt) {
      const started = Date.parse((await execute("ps", ["-p", String(pid), "-o", "lstart="], 3000)).trim());
      if (!Number.isFinite(started) || started > record.hookAt + 1000) return false;
    }
    const output = await execute("ps", [...(pid ? ["-p", String(pid)] : ["-t", tty!]), "-o", "pid=,pgid=,tpgid=,tty=,stat=,comm="], 3000);
    const expected = new Set([record.provider, ...(command ? [basename(command)] : [])]);
    return output.split("\n").some((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match || (pid && Number(match[1]) !== pid) || Number(match[2]) !== Number(match[3]) || Number(match[3]) <= 0 || /[TZ]/.test(match[5]) || ["?", "??", "-"].includes(match[4]) || (tty && match[4] !== tty)) return false;
      const executable = basename(match[6]).replace(/^-/, "");
      // An explicitly configured shell is never evidence that an agent is alive.
      return !["sh", "zsh", "bash", "fish", "dash", "ksh", "login"].includes(executable) && expected.has(executable);
    });
  } catch { return false; }
}
