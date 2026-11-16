import type { ChildProcess } from "node:child_process";
import { COMMIT_ID, parseCommits, parseIds, SCAN_BOUND } from "./outcome-hold.js";
import { scanGit } from "./outcome-scan.js";
import { COMMIT_MESSAGE_MAX, type NumstatEntry, parseMessage, parseNumstat } from "./eval-mine-rules.js";
import type { TeamCommand } from "./team-types.js";
import { type CommandResult, spawnTeamBundle } from "./team-workspace.js";

/** The mining reads (see "Git commands"). Every read runs in the mirror through `teams.commandPrefix`. */
export const MINE_READ_MS = 30_000, BUNDLE_MAX_BYTES = 1_073_741_824;
/** Form 4 takes 1 to this many ids. */
const PARENTS_MAX = 50;

/** Throws TypeError unless the id is a full commit id, so no argument can be an option. */
function commitId(id: string): string {
  if (!COMMIT_ID.test(id)) throw new TypeError("A mining read needs full commit ids.");
  return id;
}

/** E1. The change counts of a commit against its first parent. */
export function numstatArgs(parent: string, commit: string): string[] {
  return ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "--ignore-submodules=none", "--diff-algorithm=myers", "-z", commitId(parent), commitId(commit), "--"];
}

/** E2. The committer time and the message of one commit, as `SECONDS NUL BODY`. */
export function messageArgs(commit: string): string[] {
  return ["log", "--no-walk=unsorted", "--no-show-signature", "--no-notes", "--encoding=UTF-8", "--format=%ct%x00%B", commitId(commit)];
}

/** Form 1. */
function ancestorArgs(older: string, newer: string): string[] {
  return ["merge-base", "--is-ancestor", commitId(older), commitId(newer)];
}

/** Form 3 without `exclude`, form 2 with it. Both repeat the outcome-ledger plan's lists. */
function firstParentArgs(head: string, exclude?: string): string[] {
  if (exclude === undefined) return ["rev-list", "--first-parent", `--max-count=${SCAN_BOUND}`, commitId(head)];
  return ["rev-list", "--first-parent", `--max-count=${SCAN_BOUND + 1}`, commitId(head), `^${commitId(exclude)}`];
}

/** Form 4. */
function parentArgs(ids: readonly string[]): string[] {
  return ["log", "--no-walk=unsorted", "--no-show-signature", "--format=%H %T %P", ...ids.map(commitId)];
}

export interface MineGit {
  isAncestor(mirror: string, older: string, newer: string): Promise<"yes" | "no" | "failed">;                    // form 1
  firstParents(mirror: string, head: string, exclude?: string): Promise<{ ids: string[]; more: boolean } | undefined>;  // form 3, or form 2 with exclude
  parents(mirror: string, ids: readonly string[]): Promise<Map<string, string[]> | undefined>;                    // form 4, 1 to 50 ids
  numstat(mirror: string, parent: string, commit: string): Promise<{ state: "read"; entries: NumstatEntry[] } | { state: "too-large" } | { state: "failed" }>;
  message(mirror: string, commit: string): Promise<{ state: "read"; commitTime: string; message: string } | { state: "too-large" } | { state: "failed" }>;
}

/** Every read runs through `scanGit(prefix())`, with a 30 second limit. A read that throws is a failed read. */
export function mineGit(prefix: () => TeamCommand | undefined): MineGit {
  const run = async (mirror: string, args: string[]): Promise<CommandResult | undefined> => {
    try {
      return await scanGit(prefix())(mirror, args);
    } catch {
      return undefined;
    }
  };
  return {
    async isAncestor(mirror, older, newer) {
      let args: string[];
      try { args = ancestorArgs(older, newer); } catch { return "failed"; }
      const result = await run(mirror, args);
      if (result === undefined || result.interrupted || result.truncated) return "failed";
      if (result.exitCode === 0) return "yes";
      return result.exitCode === 1 ? "no" : "failed";
    },
    async firstParents(mirror, head, exclude) {
      let args: string[];
      try { args = firstParentArgs(head, exclude); } catch { return undefined; }
      const result = await run(mirror, args);
      if (result === undefined || result.interrupted || result.truncated || result.exitCode !== 0) return undefined;
      // Form 3 returns at most SCAN_BOUND ids, so a full page may have more behind it. Form 2 asks for one more to show a gap.
      const ids = parseIds(result.stdout, exclude === undefined ? SCAN_BOUND : SCAN_BOUND + 1);
      if (ids === undefined) return undefined;
      return exclude === undefined
        ? { ids, more: ids.length === SCAN_BOUND }
        : { ids: ids.slice(0, SCAN_BOUND), more: ids.length > SCAN_BOUND };
    },
    async parents(mirror, ids) {
      if (ids.length < 1 || ids.length > PARENTS_MAX) return undefined;
      let args: string[];
      try { args = parentArgs(ids); } catch { return undefined; }
      const result = await run(mirror, args);
      if (result === undefined || result.interrupted || result.truncated || result.exitCode !== 0) return undefined;
      const commits = parseCommits(result.stdout, ids);
      return commits === undefined ? undefined : new Map(commits.map(commit => [commit.id, commit.parents]));
    },
    async numstat(mirror, parent, commit) {
      let args: string[];
      try { args = numstatArgs(parent, commit); } catch { return { state: "failed" }; }
      const result = await run(mirror, args);
      if (result === undefined || result.interrupted) return { state: "failed" };
      if (result.truncated) return { state: "too-large" };
      if (result.exitCode !== 0) return { state: "failed" };
      const entries = parseNumstat(result.stdout);
      return entries === undefined ? { state: "failed" } : { state: "read", entries };
    },
    async message(mirror, commit) {
      let args: string[];
      try { args = messageArgs(commit); } catch { return { state: "failed" }; }
      const result = await run(mirror, args);
      if (result === undefined || result.interrupted) return { state: "failed" };
      if (result.truncated) return { state: "too-large" };
      if (result.exitCode !== 0) return { state: "failed" };
      const parsed = parseMessage(result.stdout);
      if (parsed !== undefined) return { state: "read", ...parsed };
      // A body past the limit is too large; any other output that does not parse is failed.
      const nul = result.stdout.indexOf("\0");
      const body = nul < 0 ? "" : result.stdout.slice(nul + 1);
      return nul >= 0 && Array.from(body.trim()).length > COMMIT_MESSAGE_MAX ? { state: "too-large" } : { state: "failed" };
    },
  };
}

/** E3. The base branch of the mirror, streamed as a bundle. The caller streams stdout and destroys it past BUNDLE_MAX_BYTES. */
export function spawnMirrorBundle(mirror: string, branch: string, prefix?: TeamCommand): ChildProcess {
  return spawnTeamBundle(mirror, branch, prefix);
}
