import { spawn, type ChildProcess } from "node:child_process";
import { COMMIT_ID } from "./outcome-hold.js";
import { isScopedPath } from "./goal-types.js";
import type { TeamCommand } from "./team-types.js";
import { teamGitArgs, teamGitEnvironment } from "./team-workspace.js";

export type StreamRead = { state: "read"; bytes: Buffer } | { state: "too-large" } | { state: "failed" };
export const BLOB_MAX_BYTES = 1_048_576, BLOB_READ_MS = 30_000, BLOB_RELEASE_MS = 1_000, BLOB_PATH_CHARS = 300;

/**
 * Stops the child's process group. False when the signal was refused (EPERM): a launcher that runs the command as
 * another account, or, on macOS, a child that has already ended. The caller cannot tell the two apart at that moment.
 */
export function stopGroup(child: ChildProcess): boolean {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
  return true;
}

export type GitStreamInput = {
  cwd: string; args: readonly string[]; prefix: TeamCommand | undefined; maxBytes: number; timeoutMs: number; signal: AbortSignal;
  stop: (child: ChildProcess) => boolean; releaseMs: number; env?: Record<string, string>;
  /** Called once, when the answer is decided, before the child closes. */
  decided?: (read: StreamRead) => void;
};

/**
 * Streams a Git read on stdout. Keeps the output only while it fits in `maxBytes`; output is never cut or partly returned.
 * The answer is decided at the first of: the byte limit, the time limit, an abort, a stream error. The promise settles
 * only when the child closes, so a child that cannot be signalled still counts until it ends. After a refused stop the
 * child stops holding the process open `releaseMs` later; it is not released at once, because a child that has already
 * ended also refuses the signal and closes a moment later.
 */
export function readGitStream(input: GitStreamInput): Promise<StreamRead> {
  const { cwd, args, prefix, maxBytes, timeoutMs, signal, stop, releaseMs, env, decided: report } = input;
  if (signal.aborted) return Promise.resolve({ state: "failed" });
  return new Promise(resolveRead => {
    let child: ChildProcess;
    try {
      child = spawn(prefix?.command ?? "git", prefix ? [...prefix.args, "git", ...args] : args, { cwd, env: teamGitEnvironment(env), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch {
      resolveRead({ state: "failed" });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0, decided: StreamRead | undefined, resolved = false, timer: NodeJS.Timeout | undefined, release: NodeJS.Timeout | undefined;
    const finish = (read: StreamRead) => {
      if (resolved) return;
      resolved = true;
      resolveRead(read);
    };
    const clear = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const decide = (read: StreamRead) => {
      if (decided) return;
      decided = read;
      clear();
      child.stdout?.destroy();
      child.stderr?.destroy();
      report?.(read);
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
      if (total > maxBytes) { decide({ state: "too-large" }); return; }
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

/** Form B1 after the six settings: `cat-file blob COMMIT:PATH`. Throws TypeError for a refused id or path; no child starts. */
export function blobArgs(commit: string, path: string): string[] {
  if (!COMMIT_ID.test(commit)) throw new TypeError("A blob read needs a full commit id.");
  if (!isScopedPath(path) || path === "." || path.length > BLOB_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(path)) throw new TypeError("A blob read needs one repository path.");
  return ["cat-file", "blob", `${commit}:${path}`];
}

export type BlobReader = {
  /** Resolves when the answer is decided. A child that the stop could not end counts as stalled until it closes. Never throws. */
  read(cwd: string, commit: string, path: string, signal: AbortSignal): Promise<StreamRead>;
  stalled(): number;
};

/** Reads through `prefix()` with teamGitArgs(cwd, blobArgs(…)) and env { GIT_NO_LAZY_FETCH: "1" }. */
export function blobReader(
  prefix: () => TeamCommand | undefined,
  options: { timeoutMs?: number; stop?: (child: ChildProcess) => boolean; releaseMs?: number } = {},
): BlobReader {
  const { timeoutMs = BLOB_READ_MS, stop = stopGroup, releaseMs = BLOB_RELEASE_MS } = options;
  let stalled = 0;
  return {
    read(cwd, commit, path, signal) {
      let args: string[];
      try {
        args = teamGitArgs(cwd, blobArgs(commit, path));
      } catch {
        return Promise.resolve({ state: "failed" });
      }
      return new Promise(resolveRead => {
        let answered = false;
        const answer = (read: StreamRead) => {
          if (answered) return;
          answered = true;
          resolveRead(read);
        };
        // A child the stop refuses is counted until it closes; `decide` calls the stop before any close.
        const countedStop = (child: ChildProcess) => {
          const ended = stop(child);
          if (!ended) {
            stalled++;
            child.once("close", () => { stalled--; });
          }
          return ended;
        };
        let command: TeamCommand | undefined;
        try {
          command = prefix();
        } catch {
          answer({ state: "failed" });
          return;
        }
        readGitStream({ cwd, args, prefix: command, maxBytes: BLOB_MAX_BYTES, timeoutMs, signal, stop: countedStop, releaseMs, env: { GIT_NO_LAZY_FETCH: "1" }, decided: answer })
          .then(answer, () => answer({ state: "failed" }));
      });
    },
    stalled: () => stalled,
  };
}
