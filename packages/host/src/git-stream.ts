import { spawn, type ChildProcess } from "node:child_process";
import { COMMIT_ID } from "./outcome-hold.js";
import { isScopedPath } from "./goal-types.js";
import type { TeamCommand } from "./team-types.js";
import { teamGitArgs, teamGitEnvironment } from "./team-workspace.js";
import { leaderExited, signalGroup, watchLeader } from "./process-group.js";

export type StreamRead = { state: "read"; bytes: Buffer } | { state: "too-large" } | { state: "failed" };
export const BLOB_MAX_BYTES = 1_048_576, BLOB_READ_MS = 30_000, BLOB_RELEASE_MS = 1_000, BLOB_PATH_CHARS = 300;

export function stopGroup(child: ChildProcess): boolean {
  return signalGroup(child, "SIGKILL") !== "refused";
}

export type GitStreamInput = {
  cwd: string; args: readonly string[]; prefix: TeamCommand | undefined; maxBytes: number; timeoutMs: number; signal: AbortSignal;
  stop: (child: ChildProcess) => boolean; releaseMs: number; env?: Record<string, string>;
  decided?: (read: StreamRead) => void;
};

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
    const leader = watchLeader(child);
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
      if (!leaderExited(child) && !stop(child)) {
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
      decide({ state: "failed" });
      clear();
      if (release) clearTimeout(release);
      finish(decided ?? { state: "failed" });
    });
    child.once("close", exitCode => {
      clear();
      if (release) clearTimeout(release);
      finish(decided ?? (exitCode === 0 && !leader.leftover ? { state: "read", bytes: Buffer.concat(chunks) } : { state: "failed" }));
    });
  });
}

const REVISION_SYNTAX = /[\^~{}@]|-g[0-9A-Fa-f]+$/;

export function blobArgs(commit: string, path: string): string[] {
  if (!COMMIT_ID.test(commit)) throw new TypeError("A blob read needs a full commit id.");
  if (!isScopedPath(path) || path === "." || path.length > BLOB_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(path) || REVISION_SYNTAX.test(path)) throw new TypeError("A blob read needs one repository path.");
  return ["cat-file", "blob", `${commit}:${path}`];
}

export type BlobReader = {
  read(cwd: string, commit: string, path: string, signal: AbortSignal): Promise<StreamRead>;
  stalled(): number;
};

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
