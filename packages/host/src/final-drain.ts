// The final transcript drain: after a provider exits, the worker runs the hook relay once more in the
// provider's account. Node built-ins and type imports only.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { sudoShape } from "./sudo-profile.js";
import type { AgentProfile } from "./types.js";

/** The longest a final drain runs: the worker's window and the relay's process deadline. */
export const FINAL_DRAIN_MS = 10_000;
/** The wrapper's file name, beside the provider wrapper that a sudo profile names. */
export const DRAIN_WRAPPER = "transcript-drain";

/** The command that runs the relay in drain mode in the provider's account. Undefined when it cannot run. */
export function drainLaunch(profile: AgentProfile, relayPath: string): { command: string; args: string[] } | undefined {
  if (!/(^|\/)sudo$/.test(profile.command)) {
    const development = relayPath.endsWith(".ts");
    return { command: process.execPath, args: [...(development ? ["--import", import.meta.resolve("tsx")] : []), relayPath, "drain"] };
  }
  const shape = sudoShape(profile.args);
  if (!shape.ok || !isAbsolute(shape.executable)) return undefined;
  const wrapper = join(dirname(shape.executable), DRAIN_WRAPPER);
  try { if (!statSync(wrapper).isFile()) return undefined; } catch { return undefined; }
  // -n keeps sudo from waiting for a password; the policy then refuses the drain at once if it is not allowed.
  const options = ["-n", ...shape.options.filter(arg => arg !== "-n")];
  return { command: profile.command, args: [...options, "--", wrapper] };
}

/** Runs the command once. Resolves when it exits, fails to start, or `limitMs` passes. Never rejects. */
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
      try { child.kill("SIGTERM"); } catch { /* The process already exited. */ }
      finish();
    }, limitMs);
    child.once("error", finish);
    child.once("exit", finish);
  });
}
