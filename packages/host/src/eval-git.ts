import { spawn, type ChildProcess } from "node:child_process";
import type { BaseRead, CaptureGit, NameRead, PatchRead } from "./eval-types.js";
import { COMMIT_ID } from "./outcome-hold.js";
import type { TeamCommand } from "./team-types.js";
import { teamCommand, teamGitArgs, teamGitEnvironment } from "./team-workspace.js";

export const PATCH_MAX_BYTES = 1_048_576, CAPTURE_READ_MS = 30_000;
/** After a refused stop, a patch child holds the process open only this long. A child that has already ended closes before that. */
export const CAPTURE_RELEASE_MS = 1_000;

/** The new form (see "Git commands"). Throws TypeError when an id fails COMMIT_ID. */
export function patchArgs(from: string, to: string): string[] {
  if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to)) throw new TypeError("A capture patch needs two full commit ids.");
  return ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--default-prefix", "--no-renames", "--submodule=short", "--ignore-submodules=none", "--unified=3", "--inter-hunk-context=0", from, to, "--"];
}

function namesArgs(from: string, to: string) {
  return ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", from, to, "--"];
}

/**
 * Stops the child's process group. False when the signal was refused (EPERM): a launcher that runs the command as
 * another account, or, on macOS, a child that has already ended. The caller cannot tell the two apart at that moment.
 */
function stopGroup(child: ChildProcess): boolean {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
  return true;
}

/**
 * Streams a patch on stdout. Keeps it only while it fits in PATCH_MAX_BYTES; a patch is never cut or partly returned.
 * The answer is decided at the first of: the byte limit, the time limit, an abort, a stream error. The promise settles
 * only when the child closes, so a child that cannot be signalled still counts until it ends. After a refused stop the
 * child stops holding the process open `releaseMs` later; it is not released at once, because a child that has already
 * ended also refuses the signal and closes a moment later.
 */
function readPatch(
  cwd: string,
  from: string,
  to: string,
  prefix: TeamCommand | undefined,
  timeoutMs: number,
  signal: AbortSignal,
  stop: (child: ChildProcess) => boolean,
  releaseMs: number,
): Promise<PatchRead> {
  let args: string[];
  try {
    args = teamGitArgs(cwd, patchArgs(from, to));
  } catch {
    return Promise.resolve({ state: "failed" });
  }
  if (signal.aborted) return Promise.resolve({ state: "failed" });
  return new Promise(resolveRead => {
    let child: ChildProcess;
    try {
      child = spawn(prefix?.command ?? "git", prefix ? [...prefix.args, "git", ...args] : args, { cwd, env: teamGitEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch {
      resolveRead({ state: "failed" });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0, decided: PatchRead | undefined, resolved = false, timer: NodeJS.Timeout | undefined, release: NodeJS.Timeout | undefined;
    const finish = (read: PatchRead) => {
      if (resolved) return;
      resolved = true;
      resolveRead(read);
    };
    const clear = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const decide = (read: PatchRead) => {
      if (decided) return;
      decided = read;
      clear();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!stop(child)) {
        release = setTimeout(() => child.unref(), releaseMs);
        release.unref();
      }
    };
    const onAbort = () => decide({ state: "failed" });
    timer = setTimeout(() => decide({ state: "failed" }), timeoutMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (decided) return;
      total += chunk.length;
      if (total > PATCH_MAX_BYTES) { decide({ state: "too-large" }); return; }
      chunks.push(chunk);
    });
    child.stdout!.on("error", () => decide({ state: "failed" }));
    child.stderr!.on("data", () => {});
    child.once("error", () => {
      // The child could not start: the answer is known now.
      decide({ state: "failed" });
      clear();
      if (release) clearTimeout(release);
      finish(decided ?? { state: "failed" });
    });
    child.once("close", exitCode => {
      clear();
      if (release) clearTimeout(release);
      finish(decided ?? (exitCode === 0 ? { state: "read", bytes: Buffer.concat(chunks) } : { state: "failed" }));
    });
  });
}

export function captureGit(
  prefix: () => TeamCommand | undefined,
  timeoutMs = CAPTURE_READ_MS,
  stop: (child: ChildProcess) => boolean = stopGroup,
  releaseMs = CAPTURE_RELEASE_MS,
): CaptureGit {
  const controller = new AbortController();
  const { signal } = controller;
  return {
    patch(cwd, from, to) {
      return readPatch(cwd, from, to, prefix(), timeoutMs, signal, stop, releaseMs);
    },
    close() {
      controller.abort();
    },
    async names(cwd, from, to, max): Promise<NameRead> {
      if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to) || signal.aborted) return { state: "failed" };
      try {
        const result = await teamCommand({ command: "git", args: teamGitArgs(cwd, namesArgs(from, to)) }, cwd, signal, timeoutMs, prefix());
        if (result.exitCode !== 0 || result.interrupted) return { state: "failed" };
        if (result.truncated) return { state: "too-wide" };
        const names = result.stdout.split("\0").filter(Boolean);
        return names.length > max ? { state: "too-wide" } : { state: "read", names };
      } catch {
        return { state: "failed" };
      }
    },
    async onBaseBranch(mirror, anchor, head): Promise<BaseRead> {
      if (!COMMIT_ID.test(anchor) || !COMMIT_ID.test(head) || signal.aborted) return "not-proven";
      try {
        const result = await teamCommand({ command: "git", args: teamGitArgs(mirror, ["merge-base", "--is-ancestor", anchor, head]) }, mirror, signal, timeoutMs, prefix());
        return result.exitCode === 0 && !result.interrupted ? "proven" : "not-proven";
      } catch {
        return "not-proven";
      }
    },
  };
}
