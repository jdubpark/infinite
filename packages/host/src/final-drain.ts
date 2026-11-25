import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { sudoShape } from "./sudo-profile.js";
import type { AgentProfile } from "./types.js";

export const FINAL_DRAIN_MS = 10_000;
export const DRAIN_WRAPPER = "transcript-drain";

export function drainLaunch(profile: AgentProfile, relayPath: string): { command: string; args: string[] } | undefined {
  if (!/(^|\/)sudo$/.test(profile.command)) {
    const development = relayPath.endsWith(".ts");
    return { command: process.execPath, args: [...(development ? ["--import", import.meta.resolve("tsx")] : []), relayPath, "drain"] };
  }
  const shape = sudoShape(profile.args);
  if (!shape.ok || !isAbsolute(shape.executable)) return undefined;
  const wrapper = join(dirname(shape.executable), DRAIN_WRAPPER);
  try { if (!statSync(wrapper).isFile()) return undefined; } catch { return undefined; }
  const options = ["-n", ...shape.options.filter(arg => arg !== "-n")];
  return { command: profile.command, args: [...options, "--", wrapper] };
}

export function runFinalDrain(launch: { command: string; args: string[] }, env: Record<string, string>, limitMs = FINAL_DRAIN_MS): Promise<void> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, { stdio: "ignore", env });
    } catch {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish();
    }, limitMs);
    child.once("error", finish);
    child.once("exit", finish);
  });
}
