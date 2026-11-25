import { existsSync } from "node:fs";
import type { EvidenceStore } from "./evidence/store.js";
import type { MirrorFetch } from "./project-source.js";
import type { ScanGap } from "./outcome-rules.js";
import {
  COMMIT_ID,
  COMMIT_PAGE,
  holdUntil,
  landedIds,
  type Landing,
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
import { applyCheck, applyScan, landingSignalId, type RecordedScanSignal, type ScanInputs, scanInputs, type ScanWrite } from "./outcome-signals.js";
import { OUTCOMES_MODULE } from "./outcome-store.js";
import type { TeamCommand } from "./team-types.js";
import { type CommandResult, teamCommand, teamGitArgs } from "./team-workspace.js";

export type ScanGit = (cwd: string, args: string[]) => Promise<CommandResult>;

export type ScanResult = {
  state: "scanned" | "checked" | "skipped" | "failed";
  commits: number;
  gap: ScanGap | null;
  landings: number;
  reverts: number;
};

export const SCAN_COMMAND_LIMIT = 600;

export const UNREAD_LIMIT = 8;

export type AppliedScan = {
  projectId: string;
  head: string;
  continuous: boolean;
  commits: readonly ScanCommit[];
  landings: readonly Landing[];
  reverts: readonly RevertMatch[];
  recorded: readonly RecordedScanSignal[];
};

export type ScanOnceInput = {
  store: EvidenceStore; git: ScanGit; mirror: string; fetch: MirrorFetch; holdDays: number;
  commandLimit?: number;
  earlier?: readonly MirrorFetch[];
  onApplied?: (scan: AppliedScan) => void;
};

const SKIPPED: ScanResult = { state: "skipped", commits: 0, gap: null, landings: 0, reverts: 0 };
const FAILED: ScanResult = { state: "failed", commits: 0, gap: null, landings: 0, reverts: 0 };

export function scanGit(prefix?: TeamCommand): ScanGit {
  return (cwd, args) => teamCommand({ command: "git", args: teamGitArgs(cwd, args) }, cwd, undefined, 30_000, prefix);
}

class ScanFailure extends Error {}

function commitId(id: string): string {
  if (!COMMIT_ID.test(id)) throw new ScanFailure("a commit id is malformed");
  return id;
}

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

async function isAncestor(git: ScanGit, cwd: string, older: string, newer: string): Promise<boolean> {
  const result = await git(cwd, ["merge-base", "--is-ancestor", commitId(older), commitId(newer)]);
  if (result.interrupted) throw new ScanFailure("the ancestry check was interrupted");
  return result.exitCode === 0;
}

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

function unreadHeads(earlier: readonly MirrorFetch[], stored: string, newer: string): string[] {
  return [...new Set(earlier.map(entry => entry.head))].filter(id => id !== stored && id !== newer);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size));
  return pages;
}

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
    const continuous = state !== undefined && sameSource && continues([...earlier, fetch], state, fetch);
    if (state !== undefined && sameSource && continuous && fetch.head === state.head && earlier.every(entry => entry.head === state.head)) {
      const checked = store.write(tx => applyCheck(tx, { projectId: fetch.projectId, head: fetch.head, at: fetch.fetchedAt, expectedSeq: state.seq }));
      return { ...SKIPPED, state: checked.applied ? "checked" : "skipped" };
    }

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
        gap = "rewrite";
        listedIds = await newest();
      }
    } else {
      gap = "rewrite";
      listedIds = await newest();
    }
    const older = gap === "first" || gap === "rewrite" || gap === "source";

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
    const recorded: RecordedScanSignal[] = [];
    const applied = store.write(tx => applyScan(tx, write, recorded)).applied;
    if (applied && input.onApplied) {
      try {
        input.onApplied({
          projectId: fetch.projectId, head: fetch.head, continuous: gap === null && from !== undefined,
          commits, landings, reverts, recorded,
        });
      } catch {
      }
    }
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
  onApplied?: (scan: AppliedScan) => void;
};

export class BaseScanner {
  private readonly git: ScanGit;
  private readonly log: (line: string) => void;
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, MirrorFetch>();
  private readonly gapsLogged = new Set<ScanGap>();
  private readonly unread = new Map<string, MirrorFetch[]>();
  private failureLogged = false;
  private closed = false;

  constructor(private readonly options: BaseScannerOptions) {
    this.git = options.git ?? scanGit(options.prefix);
    this.log = options.log ?? (line => console.error(line));
  }

  notify(fetch: MirrorFetch): void {
    try {
      if (this.closed || !COMMIT_ID.test(fetch.head)) return;
      if (this.running.has(fetch.projectId)) {
        const replaced = this.pending.get(fetch.projectId);
        if (replaced !== undefined) this.remember(replaced);
        this.pending.set(fetch.projectId, fetch);
        return;
      }
      this.start(fetch);
    } catch {
    }
  }

  async settled(projectId: string): Promise<void> {
    for (let running = this.running.get(projectId); running !== undefined; running = this.running.get(projectId)) {
      await running.catch(() => undefined);
    }
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.unread.clear();
  }

  private remember(fetch: MirrorFetch): void {
    const list = this.unread.get(fetch.projectId) ?? [];
    list.push(fetch);
    if (list.length > UNREAD_LIMIT) list.shift();
    this.unread.set(fetch.projectId, list);
  }

  private recorded(fetch: MirrorFetch): void {
    const list = this.unread.get(fetch.projectId);
    const index = list === undefined ? -1 : list.indexOf(fetch);
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
        ...(this.options.onApplied === undefined ? {} : { onApplied: this.options.onApplied }),
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
    }
  }
}
