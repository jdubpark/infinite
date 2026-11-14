import { existsSync } from "node:fs";
import type { EvidenceStore } from "./evidence/store.js";
import type { MirrorFetch } from "./project-source.js";
import type { ScanGap } from "./outcome-rules.js";
import {
  COMMIT_ID,
  COMMIT_PAGE,
  holdUntil,
  landedIds,
  type LandedRun,
  matchLandings,
  matchReverts,
  PATTERN_PAGE,
  parseCommits,
  parseIds,
  revertPattern,
  type RevertMatch,
  type ScanCommit,
  SCAN_BOUND,
} from "./outcome-hold.js";
import { applyCheck, applyScan, landingSignalId, type ScanInputs, scanInputs, type ScanWrite } from "./outcome-signals.js";
import { OUTCOMES_MODULE } from "./outcome-store.js";
import type { TeamCommand } from "./team-types.js";
import { type CommandResult, teamCommand, teamGitArgs } from "./team-workspace.js";

/** Runs one Git command in a directory and returns its result. The default adds the six `-c` settings. */
export type ScanGit = (cwd: string, args: string[]) => Promise<CommandResult>;

export type ScanResult = {
  state: "scanned" | "checked" | "skipped" | "failed";
  commits: number;
  gap: ScanGap | null;
  landings: number;
  reverts: number;
};

/**
 * The most Git commands one scan may run. A scan of 500 commits against 2,500 landed ids needs about 510. Base branch
 * commits are written by anyone with push rights, and a commit that names many landed commits adds commands, so a scan
 * past the limit fails like any other failed read.
 */
export const SCAN_COMMAND_LIMIT = 600;

/**
 * The most fetches a project keeps that no recorded scan read. Past it the oldest is dropped. The first fetch that is
 * left then says since when its previous head stood, so a dropped fetch that moved the head still breaks the chain.
 */
export const UNREAD_LIMIT = 8;

export type ScanOnceInput = {
  store: EvidenceStore; git: ScanGit; mirror: string; fetch: MirrorFetch; holdDays: number;
  /** Defaults to `SCAN_COMMAND_LIMIT`. */
  commandLimit?: number;
  /** Fetches since the last recorded scan that no recorded scan read, oldest first, with none missing between them. */
  earlier?: readonly MirrorFetch[];
};

const SKIPPED: ScanResult = { state: "skipped", commits: 0, gap: null, landings: 0, reverts: 0 };
const FAILED: ScanResult = { state: "failed", commits: 0, gap: null, landings: 0, reverts: 0 };

/** The Git runner the scanner uses: `git` in `cwd` through `teamCommand`, with the optional launcher prefix. */
export function scanGit(prefix?: TeamCommand): ScanGit {
  return (cwd, args) => teamCommand({ command: "git", args: teamGitArgs(cwd, args) }, cwd, undefined, 30_000, prefix);
}

class ScanFailure extends Error {}

/** Every id that enters a Git argument passes here first, so no argument can be an option. */
function commitId(id: string): string {
  if (!COMMIT_ID.test(id)) throw new ScanFailure("a commit id is malformed");
  return id;
}

/** The stdout of a command that must succeed. A non-zero or null exit code, an interruption, or a truncation fails. */
async function output(git: ScanGit, cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.interrupted || result.truncated || result.exitCode !== 0) throw new ScanFailure("a Git command failed");
  return result.stdout;
}

function listed(stdout: string, max: number): string[] {
  const ids = parseIds(stdout, max);
  if (ids === undefined) throw new ScanFailure("a commit id list did not parse");
  return ids;
}

/** Form 1. Exit 0 is an ancestor; any other exit code is a rewrite. Only an interruption fails. */
async function isAncestor(git: ScanGit, cwd: string, older: string, newer: string): Promise<boolean> {
  const result = await git(cwd, ["merge-base", "--is-ancestor", commitId(older), commitId(newer)]);
  if (result.interrupted) throw new ScanFailure("the ancestry check was interrupted");
  return result.exitCode === 0;
}

/**
 * Whether the unread fetches and the new one continue the ledger's record. Each fetch must name, as the head before
 * it, the head of the one before it in the chain (the stored head, for the first), and that head must have stood
 * since a fetch no later than that one (the last fetch the ledger recorded, for the first). A later start means that
 * a fetch between the two moved the head and was never read, in this process or before a restart. The times are the
 * source's fetch stamps, which never go back. A missing value never matches, and a fetch of another repository or
 * branch breaks the chain.
 */
function continues(chain: readonly MirrorFetch[], state: { head: string; checkedAt: string }, fetch: MirrorFetch): boolean {
  let head = state.head;
  let stamp = Date.parse(state.checkedAt);
  for (const entry of chain) {
    if (entry.repository !== fetch.repository || entry.baseBranch !== fetch.baseBranch) return false;
    if (entry.previousHead === undefined || entry.previousHead !== head || entry.previousSince === undefined) return false;
    const since = Date.parse(entry.previousSince);
    if (Number.isNaN(since) || Number.isNaN(stamp) || since > stamp) return false;
    head = entry.head;
    stamp = Date.parse(entry.fetchedAt);
  }
  return chain.length > 0;
}

/** The unread heads that differ from both the stored head and the new one, distinct, in fetch order. */
function unreadHeads(earlier: readonly MirrorFetch[], stored: string, newer: string): string[] {
  return [...new Set(earlier.map(entry => entry.head))].filter(id => id !== stored && id !== newer);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size));
  return pages;
}

/** Form 5 for some patterns and some commits. Every id it returns must be one of the commits given. */
function revertArgs(patterns: readonly string[], commits: readonly string[]): string[] {
  return [
    "log", "--no-walk=unsorted", "--no-show-signature", "--format=%H", "--fixed-strings",
    ...patterns.map(id => `--grep=${revertPattern(commitId(id))}`),
    ...commits.map(commitId),
  ];
}

async function findReverts(
  git: ScanGit,
  mirror: string,
  commits: readonly ScanCommit[],
  landed: readonly LandedRun[],
  at: string,
  older: boolean,
): Promise<RevertMatch[]> {
  const patterns = [...new Set(landed.flatMap(run => run.ids))];
  const hits = new Map<string, Set<string>>();
  for (const page of chunks(commits.map(commit => commit.id), COMMIT_PAGE)) {
    for (const batch of chunks(patterns, PATTERN_PAGE)) {
      const batchHits = listed(await output(git, mirror, revertArgs(batch, page)), page.length);
      if (batchHits.some(commit => !page.includes(commit))) throw new ScanFailure("a revert id was not requested");
      const found = page.filter(commit => batchHits.includes(commit));
      if (found.length === 0) continue;
      // The batch matched in this page. Ask once per pattern which of the page's hits it names.
      for (const id of batch) {
        const named = listed(await output(git, mirror, revertArgs([id], found)), found.length);
        for (const commit of named) {
          if (!found.includes(commit)) throw new ScanFailure("a revert id was not requested");
          const set = hits.get(id) ?? new Set<string>();
          set.add(commit);
          hits.set(id, set);
        }
      }
    }
  }
  return matchReverts(commits, landed, hits, at, older);
}

/**
 * One base branch scan of a project. Every store write happens in the last transaction, so a scan that fails for any
 * reason writes nothing. A scan is `skipped` unless the module is ready, the mirror exists, and the head is a commit id.
 */
export async function scanOnce(input: ScanOnceInput): Promise<ScanResult> {
  const { store, mirror, fetch, holdDays } = input;
  const limit = input.commandLimit ?? SCAN_COMMAND_LIMIT;
  let commands = 0;
  const git: ScanGit = (cwd, args) => {
    commands += 1;
    if (commands > limit) throw new ScanFailure("the scan passed its command limit");
    return input.git(cwd, args);
  };
  try {
    if (store.status().modules[OUTCOMES_MODULE] !== "ready" || !existsSync(mirror) || !COMMIT_ID.test(fetch.head)) return SKIPPED;
    const inputs: ScanInputs = store.read(db => scanInputs(db, fetch.projectId, fetch.fetchedAt));
    const state = inputs.state;
    const earlier = input.earlier ?? [];
    const sameSource = state !== undefined && state.repository === fetch.repository && state.baseBranch === fetch.baseBranch;
    // The unread fetches and this one must continue the stored head, or the history between them is unproven.
    const continuous = state !== undefined && sameSource && continues([...earlier, fetch], state, fetch);
    if (state !== undefined && sameSource && continuous && fetch.head === state.head && earlier.every(entry => entry.head === state.head)) {
      const checked = store.write(tx => applyCheck(tx, { projectId: fetch.projectId, head: fetch.head, at: fetch.fetchedAt, expectedSeq: state.seq }));
      return { ...SKIPPED, state: checked.applied ? "checked" : "skipped" };
    }

    // Newest first from Git. The scan keeps the gap and the `from` that its range proves.
    const newest = async (): Promise<string[]> =>
      listed(await output(git, mirror, ["rev-list", "--first-parent", `--max-count=${SCAN_BOUND}`, commitId(fetch.head)]), SCAN_BOUND);
    let listedIds: string[];
    let gap: ScanGap | null = null;
    let from: string | undefined;
    if (state === undefined) {
      gap = "first";
      listedIds = await newest();
    } else if (!sameSource) {
      gap = "source";
      listedIds = await newest();
    } else if (continuous && fetch.head !== state.head && await isAncestor(git, mirror, state.head, fetch.head)) {
      const range = listed(
        await output(git, mirror, ["rev-list", "--first-parent", `--max-count=${SCAN_BOUND + 1}`, commitId(fetch.head), `^${commitId(state.head)}`]),
        SCAN_BOUND + 1,
      );
      if (range.length > SCAN_BOUND) {
        gap = "bound";
        listedIds = range.slice(0, SCAN_BOUND);
      } else if (unreadHeads(earlier, state.head, fetch.head).every(id => range.includes(id))) {
        from = state.head;
        listedIds = range;
      } else {
        // A head that a fetch saw is not a first-parent commit of the range any more, so the commits that stood
        // under it were never read. An ancestor that came back through a merge's second parent is such a head.
        gap = "rewrite";
        listedIds = await newest();
      }
    } else {
      gap = "rewrite";
      listedIds = await newest();
    }
    // Rule 3 reads older history only when the range does not start at the stored head.
    const older = gap === "first" || gap === "rewrite" || gap === "source";

    // Oldest first, reversed once.
    const chronological = [...listedIds].reverse();
    const commits: ScanCommit[] = [];
    for (const page of chunks(chronological, COMMIT_PAGE)) {
      const parsed = parseCommits(
        await output(git, mirror, ["log", "--no-walk=unsorted", "--no-show-signature", "--format=%H %T %P", ...page.map(commitId)]),
        page,
      );
      if (parsed === undefined) throw new ScanFailure("a commit listing did not parse");
      commits.push(...parsed);
    }

    const landings = matchLandings(commits, inputs.candidates, older);
    const landed: LandedRun[] = [
      ...inputs.open,
      ...landings.map(landing => ({
        runId: landing.runId,
        signalId: landingSignalId(landing.runId),
        commit: landing.commit,
        ids: landedIds(landing.method, landing.commit, landing.reviewedHead),
        holdUntil: holdUntil(fetch.fetchedAt, holdDays),
        position: landing.position,
      })),
    ];
    const reverts = landed.length === 0 ? [] : await findReverts(git, mirror, commits, landed, fetch.fetchedAt, older);

    const write: ScanWrite = {
      projectId: fetch.projectId,
      repository: fetch.repository,
      baseBranch: fetch.baseBranch,
      at: fetch.fetchedAt,
      head: fetch.head,
      ...(from === undefined ? {} : { from }),
      ...(commits.length === 0 ? {} : { oldest: commits[0].id }),
      commits: commits.length,
      gap,
      expectedSeq: state?.seq ?? 0,
      landings,
      reverts,
      holdDays,
    };
    const applied = store.write(tx => applyScan(tx, write)).applied;
    return { state: applied ? "scanned" : "skipped", commits: commits.length, gap, landings: landings.length, reverts: reverts.length };
  } catch {
    return { ...FAILED };
  }
}

export type BaseScannerOptions = {
  store: EvidenceStore;
  mirrorPath: (projectId: string) => string;
  prefix?: TeamCommand;
  holdDays: () => number;
  git?: ScanGit;
  log?: (line: string) => void;
};

/**
 * Runs one base scan per project at a time. A notice that arrives during a scan replaces the pending notice of that
 * project and runs after the current scan. Logs at most one line per class in the life of the scanner, and names no
 * commit, project, repository, or branch.
 */
export class BaseScanner {
  private readonly git: ScanGit;
  private readonly log: (line: string) => void;
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, MirrorFetch>();
  private readonly gapsLogged = new Set<ScanGap>();
  /** Per project, the fetches that no recorded scan read, oldest first. The fetch of a running scan is the last one a scan may clear. */
  private readonly unread = new Map<string, MirrorFetch[]>();
  private failureLogged = false;
  private closed = false;

  constructor(private readonly options: BaseScannerOptions) {
    this.git = options.git ?? scanGit(options.prefix);
    this.log = options.log ?? (line => console.error(line));
  }

  /** Returns at once and never throws. */
  notify(fetch: MirrorFetch): void {
    try {
      // A head that is not a commit id cannot be scanned. The next fetch then names it as its previous head, which
      // no stored head equals, so that scan is a gap.
      if (this.closed || !COMMIT_ID.test(fetch.head)) return;
      if (this.running.has(fetch.projectId)) {
        const replaced = this.pending.get(fetch.projectId);
        if (replaced !== undefined) this.remember(replaced);
        this.pending.set(fetch.projectId, fetch);
        return;
      }
      this.start(fetch);
    } catch {
      // A notice never throws.
    }
  }

  /** Resolves when the project has no running and no pending scan. */
  async settled(projectId: string): Promise<void> {
    for (let running = this.running.get(projectId); running !== undefined; running = this.running.get(projectId)) {
      await running.catch(() => undefined);
    }
  }

  /** Drops every pending notice and every unread fetch, and ignores the result of a running scan. */
  close(): void {
    this.closed = true;
    this.pending.clear();
    this.unread.clear();
  }

  /** Keeps a fetch that no recorded scan read. Past `UNREAD_LIMIT` the oldest goes. */
  private remember(fetch: MirrorFetch): void {
    const list = this.unread.get(fetch.projectId) ?? [];
    list.push(fetch);
    if (list.length > UNREAD_LIMIT) list.shift();
    this.unread.set(fetch.projectId, list);
  }

  /** A recorded scan read its own fetch and every fetch before it. The fetches after it stay unread. */
  private recorded(fetch: MirrorFetch): void {
    const list = this.unread.get(fetch.projectId);
    const index = list === undefined ? -1 : list.indexOf(fetch);
    // When the fetch itself was dropped past the limit, every fetch that is left came after it and stays unread.
    if (list === undefined || index === -1) return;
    list.splice(0, index + 1);
    if (list.length === 0) this.unread.delete(fetch.projectId);
  }

  private start(first: MirrorFetch): void {
    this.running.set(first.projectId, this.drain(first));
  }

  private async drain(first: MirrorFetch): Promise<void> {
    const projectId = first.projectId;
    try {
      let next: MirrorFetch | undefined = first;
      while (next !== undefined) {
        const fetch: MirrorFetch = next;
        // The scan reads the unread fetches before this one. This fetch joins the list now, so that the list stays in
        // fetch order: a notice that is replaced while the scan runs was fetched after it.
        const earlier = [...(this.unread.get(projectId) ?? [])];
        this.remember(fetch);
        const result = await this.scan(fetch, earlier);
        if (this.closed) return;
        if (result.state === "scanned" || result.state === "checked") this.recorded(fetch);
        this.report(result);
        next = this.pending.get(projectId);
        this.pending.delete(projectId);
      }
    } finally {
      // In the same turn as the last look at `pending`, so no notice can park behind a scan that has ended.
      this.running.delete(projectId);
    }
  }

  private async scan(fetch: MirrorFetch, earlier: MirrorFetch[]): Promise<ScanResult> {
    try {
      return await scanOnce({
        store: this.options.store,
        git: this.git,
        mirror: this.options.mirrorPath(fetch.projectId),
        fetch,
        holdDays: this.options.holdDays(),
        earlier,
      });
    } catch {
      return { ...FAILED };
    }
  }

  private report(result: ScanResult): void {
    try {
      if (result.state === "failed") {
        if (this.failureLogged) return;
        this.failureLogged = true;
        this.log("Base branch scan failed.");
        return;
      }
      if (result.state === "scanned" && result.gap !== null && result.gap !== "first" && !this.gapsLogged.has(result.gap)) {
        this.gapsLogged.add(result.gap);
        this.log(`Base branch scan gap: ${result.gap}.`);
      }
    } catch {
      // A log line never throws.
    }
  }
}
