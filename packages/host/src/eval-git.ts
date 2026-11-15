import { spawn, type ChildProcess } from "node:child_process";
import type { BaseRead, CaptureGit, NameRead, PatchRead } from "./eval-types.js";
import { COMMIT_ID } from "./outcome-hold.js";
import type { TeamCommand } from "./team-types.js";
import { teamCommand, teamGitArgs, teamGitEnvironment } from "./team-workspace.js";

export const PATCH_MAX_BYTES = 1_048_576, CAPTURE_READ_MS = 30_000;

/** The new form (see "Git commands"). Throws TypeError when an id fails COMMIT_ID. */
export function patchArgs(from: string, to: string): string[] {
  if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to)) throw new TypeError("A capture patch needs two full commit ids.");
  return ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--default-prefix", "--no-renames", "--submodule=short", "--ignore-submodules=none", "--unified=3", "--inter-hunk-context=0", from, to, "--"];
}

function namesArgs(from: string, to: string) {
  return ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", from, to, "--"];
}

/** Stops the child's process group. The answer does not depend on whether the signal lands, so a failure is ignored. */
function stopGroup(child: ChildProcess) {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // The process may already be gone.
  }
}

/** Streams a patch on stdout. Keeps it only while it fits in PATCH_MAX_BYTES; a patch is never cut or partly returned. */
function readPatch(cwd: string, from: string, to: string, prefix: TeamCommand | undefined, timeoutMs: number): Promise<PatchRead> {
  let args: string[];
  try {
    args = teamGitArgs(cwd, patchArgs(from, to));
  } catch {
    return Promise.resolve({ state: "failed" });
  }
  return new Promise(resolveRead => {
    let child: ChildProcess;
    try {
      child = spawn(prefix?.command ?? "git", prefix ? [...prefix.args, "git", ...args] : args, { cwd, env: teamGitEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch {
      resolveRead({ state: "failed" });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0, settled = false, timer: NodeJS.Timeout | undefined;
    const settle = (read: PatchRead) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRead(read);
    };
    const stop = () => {
      child.stdout?.destroy();
      stopGroup(child);
    };
    timer = setTimeout(() => { settle({ state: "failed" }); stop(); }, timeoutMs);
    timer.unref();
    child.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > PATCH_MAX_BYTES) { settle({ state: "too-large" }); stop(); return; }
      chunks.push(chunk);
    });
    child.stdout!.on("error", () => { settle({ state: "failed" }); stop(); });
    child.stderr!.on("data", () => {});
    child.once("error", () => { settle({ state: "failed" }); stop(); });
    child.once("close", exitCode => {
      settle(exitCode === 0 ? { state: "read", bytes: Buffer.concat(chunks) } : { state: "failed" });
    });
  });
}

export function captureGit(prefix: () => TeamCommand | undefined, timeoutMs = CAPTURE_READ_MS): CaptureGit {
  return {
    patch(cwd, from, to) {
      return readPatch(cwd, from, to, prefix(), timeoutMs);
    },
    async names(cwd, from, to, max): Promise<NameRead> {
      if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to)) return { state: "failed" };
      try {
        const result = await teamCommand({ command: "git", args: teamGitArgs(cwd, namesArgs(from, to)) }, cwd, undefined, timeoutMs, prefix());
        if (result.exitCode !== 0 || result.interrupted) return { state: "failed" };
        if (result.truncated) return { state: "too-wide" };
        const names = result.stdout.split("\0").filter(Boolean);
        return names.length > max ? { state: "too-wide" } : { state: "read", names };
      } catch {
        return { state: "failed" };
      }
    },
    async onBaseBranch(mirror, anchor, head): Promise<BaseRead> {
      if (!COMMIT_ID.test(anchor) || !COMMIT_ID.test(head)) return "not-proven";
      try {
        const result = await teamCommand({ command: "git", args: teamGitArgs(mirror, ["merge-base", "--is-ancestor", anchor, head]) }, mirror, undefined, timeoutMs, prefix());
        return result.exitCode === 0 && !result.interrupted ? "proven" : "not-proven";
      } catch {
        return "not-proven";
      }
    },
  };
}
