import type { ChildProcess } from "node:child_process";
import type { BaseRead, CaptureGit, NameRead, PatchRead, TreeCompare } from "./eval-types.js";
import { COMMIT_ID } from "./outcome-hold.js";
import type { TeamCommand } from "./team-types.js";
import { teamCommand, teamGitArgs } from "./team-workspace.js";
import { readGitStream, stopGroup } from "./git-stream.js";

export const PATCH_MAX_BYTES = 1_048_576, CAPTURE_READ_MS = 30_000;
export const CAPTURE_RELEASE_MS = 1_000;
const TREE_OID_MAX_BYTES = 128;

export function patchArgs(from: string, to: string): string[] {
  if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to)) throw new TypeError("A capture patch needs two full commit ids.");
  return ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--default-prefix", "--no-renames", "--submodule=short", "--ignore-submodules=none", "--unified=3", "--inter-hunk-context=0", from, to, "--"];
}

function namesArgs(from: string, to: string) {
  return ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", from, to, "--"];
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
  return readGitStream({ cwd, args, prefix, maxBytes: PATCH_MAX_BYTES, timeoutMs, signal, stop, releaseMs, env: { LC_ALL: "C" }, missingRef: { refs: [from, to] } });
}

async function readTreeOid(
  cwd: string,
  commit: string,
  prefix: TeamCommand | undefined,
  timeoutMs: number,
  signal: AbortSignal,
  stop: (child: ChildProcess) => boolean,
  releaseMs: number,
): Promise<{ state: "read"; oid: string } | { state: "missing" } | { state: "failed" }> {
  if (!COMMIT_ID.test(commit) || signal.aborted) return { state: "failed" };
  let args: string[];
  try {
    args = teamGitArgs(cwd, ["rev-parse", "--verify", `${commit}^{tree}`]);
  } catch {
    return { state: "failed" };
  }
  const read = await readGitStream({
    cwd,
    args,
    prefix,
    maxBytes: TREE_OID_MAX_BYTES,
    timeoutMs,
    signal,
    stop,
    releaseMs,
    env: { LC_ALL: "C" },
    missingRef: { refs: [commit], allowSingleRevision: true },
  });
  if (read.state === "missing") return { state: "missing" };
  if (read.state !== "read") return { state: "failed" };
  const oid = read.bytes.toString("utf8").trim();
  return COMMIT_ID.test(oid) ? { state: "read", oid } : { state: "failed" };
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
      const commandPrefix = prefix();
      const first = await readTreeOid(cwd, from, commandPrefix, timeoutMs, signal, stop, releaseMs);
      if (first.state !== "read") return first.state;
      const second = await readTreeOid(cwd, to, commandPrefix, timeoutMs, signal, stop, releaseMs);
      if (second.state !== "read") return second.state;
      return first.oid === second.oid ? "same" : "different";
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
