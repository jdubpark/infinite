import type { ChildProcess } from "node:child_process";
import type { BaseRead, CaptureGit, NameRead, PatchRead } from "./eval-types.js";
import { COMMIT_ID } from "./outcome-hold.js";
import type { TeamCommand } from "./team-types.js";
import { teamCommand, teamGitArgs } from "./team-workspace.js";
import { readGitStream, stopGroup } from "./git-stream.js";

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
 * Streams a patch on stdout. Keeps it only while it fits in PATCH_MAX_BYTES; a patch is never cut or partly returned.
 * The body is `readGitStream`; see git-stream.ts for the settling rules.
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
  return readGitStream({ cwd, args, prefix, maxBytes: PATCH_MAX_BYTES, timeoutMs, signal, stop, releaseMs });
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
        // A list cut where a leftover held the output is unread, not too wide.
        if (result.exitCode !== 0 || result.interrupted || result.leftover) return { state: "failed" };
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
