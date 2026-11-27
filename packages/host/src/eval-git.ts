import type { ChildProcess } from "node:child_process";
import type { BaseRead, CaptureGit, NameRead, PatchRead, TreeCompare } from "./eval-types.js";
import { COMMIT_ID, parseCommits } from "./outcome-hold.js";
import type { TeamCommand } from "./team-types.js";
import { teamCommand, teamGitArgs } from "./team-workspace.js";
import { readGitStream, stopGroup } from "./git-stream.js";

export const PATCH_MAX_BYTES = 1_048_576, CAPTURE_READ_MS = 30_000;
export const CAPTURE_RELEASE_MS = 1_000;
const TREE_READ_MAX_BYTES = 4_096;

export function patchArgs(from: string, to: string): string[] {
  if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to)) throw new TypeError("A capture patch needs two full commit ids.");
  return ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--default-prefix", "--no-renames", "--submodule=short", "--ignore-submodules=none", "--unified=3", "--inter-hunk-context=0", from, to, "--"];
}

function namesArgs(from: string, to: string) {
  return ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", from, to, "--"];
}

export function treeArgs(ids: readonly string[]): string[] {
  if (ids.length === 0 || ids.some(id => !COMMIT_ID.test(id))) throw new TypeError("A tree check needs full commit ids.");
  return ["log", "--no-walk=unsorted", "--no-show-signature", "--format=%H %T %P", ...ids, "--"];
}

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
  return readGitStream({ cwd, args, prefix, maxBytes: PATCH_MAX_BYTES, timeoutMs, signal, stop, releaseMs, env: { LC_ALL: "C" }, missingRefs: [from, to] });
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
    async sameTree(cwd, from, to): Promise<TreeCompare> {
      if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to) || signal.aborted) return "failed";
      const ids = from === to ? [from] : [from, to];
      let args: string[];
      try {
        args = teamGitArgs(cwd, treeArgs(ids));
      } catch {
        return "failed";
      }
      const read = await readGitStream({
        cwd,
        args,
        prefix: prefix(),
        maxBytes: TREE_READ_MAX_BYTES,
        timeoutMs,
        signal,
        stop,
        releaseMs,
        env: { LC_ALL: "C" },
        missingRefs: ids,
      });
      if (read.state === "missing") return "missing";
      if (read.state !== "read") return "failed";
      const commits = parseCommits(read.bytes.toString("utf8"), ids);
      if (commits === undefined) return "failed";
      return commits.length === 1 || commits[0]!.tree === commits[1]!.tree ? "same" : "different";
    },
    close() {
      controller.abort();
    },
    async names(cwd, from, to, max): Promise<NameRead> {
      if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to) || signal.aborted) return { state: "failed" };
      try {
        const result = await teamCommand({ command: "git", args: teamGitArgs(cwd, namesArgs(from, to)) }, cwd, signal, timeoutMs, prefix());
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
