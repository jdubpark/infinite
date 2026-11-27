import { COMMIT_ID, parseCommits, parseIds, SCAN_BOUND } from "./outcome-hold.js";
import { scanGit } from "./outcome-scan.js";
import { COMMIT_MESSAGE_MAX, type NumstatEntry, parseMessage, parseNumstat } from "./eval-mine-rules.js";
import type { TeamCommand } from "./team-types.js";
import type { CommandResult } from "./team-workspace.js";

const PARENTS_MAX = 50;

function commitId(id: string): string {
  if (!COMMIT_ID.test(id)) throw new TypeError("A mining read needs full commit ids.");
  return id;
}

export function numstatArgs(parent: string, commit: string): string[] {
  return ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "--ignore-submodules=none", "--diff-algorithm=myers", "-z", commitId(parent), commitId(commit), "--"];
}

export function messageArgs(commit: string): string[] {
  return ["log", "--no-walk=unsorted", "--no-show-signature", "--no-notes", "--encoding=UTF-8", "--format=%ct%x00%B", commitId(commit), "--"];
}

function ancestorArgs(older: string, newer: string): string[] {
  return ["merge-base", "--is-ancestor", commitId(older), commitId(newer)];
}

function firstParentArgs(head: string, exclude?: string): string[] {
  if (exclude === undefined) return ["rev-list", "--first-parent", `--max-count=${SCAN_BOUND}`, commitId(head)];
  return ["rev-list", "--first-parent", `--max-count=${SCAN_BOUND + 1}`, commitId(head), `^${commitId(exclude)}`];
}

function parentArgs(ids: readonly string[]): string[] {
  return ["log", "--no-walk=unsorted", "--no-show-signature", "--format=%H %T %P", ...ids.map(commitId)];
}

export interface MineGit {
  isAncestor(mirror: string, older: string, newer: string): Promise<"yes" | "no" | "failed">;
  firstParents(mirror: string, head: string, exclude?: string): Promise<{ ids: string[]; more: boolean } | undefined>;
  parents(mirror: string, ids: readonly string[]): Promise<Map<string, string[]> | undefined>;
  present(mirror: string, id: string): Promise<"yes" | "no" | "failed">;
  numstat(mirror: string, parent: string, commit: string): Promise<{ state: "read"; entries: NumstatEntry[] } | { state: "too-large" } | { state: "failed" }>;
  message(mirror: string, commit: string): Promise<{ state: "read"; commitTime: string; message: string } | { state: "too-large" } | { state: "failed" }>;
}

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
    async present(mirror, id) {
      let args: string[];
      try { args = parentArgs([id]); } catch { return "failed"; }
      const result = await run(mirror, args);
      if (result === undefined || result.interrupted || result.truncated) return "failed";
      if (result.exitCode === 128) return "no";
      if (result.exitCode !== 0) return "failed";
      return parseCommits(result.stdout, [id]) === undefined ? "failed" : "yes";
    },
    async numstat(mirror, parent, commit) {
      let args: string[];
      try { args = numstatArgs(parent, commit); } catch { return { state: "failed" }; }
      const result = await run(mirror, args);
      if (result === undefined || result.interrupted || result.leftover) return { state: "failed" };
      if (result.truncated) return { state: "too-large" };
      if (result.exitCode !== 0) return { state: "failed" };
      const entries = parseNumstat(result.stdout);
      return entries === undefined ? { state: "failed" } : { state: "read", entries };
    },
    async message(mirror, commit) {
      let args: string[];
      try { args = messageArgs(commit); } catch { return { state: "failed" }; }
      const result = await run(mirror, args);
      if (result === undefined || result.interrupted || result.leftover) return { state: "failed" };
      if (result.truncated) return { state: "too-large" };
      if (result.exitCode !== 0) return { state: "failed" };
      const parsed = parseMessage(result.stdout);
      if (parsed !== undefined) return { state: "read", ...parsed };
      const nul = result.stdout.indexOf("\0");
      const body = nul < 0 ? "" : result.stdout.slice(nul + 1);
      return nul >= 0 && Array.from(body.trim()).length > COMMIT_MESSAGE_MAX ? { state: "too-large" } : { state: "failed" };
    },
  };
}

