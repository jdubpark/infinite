import type { Coverage, LandingMethod, ScanPoint } from "./outcome-rules.js";

export const HOLD_DAYS_DEFAULT = 30;
export const HOLD_DAYS_MAX = 365;
export const APPROVAL_DAYS = 90;
export const SCAN_BOUND = 500;
export const COMMIT_PAGE = 50;
export const PATTERN_PAGE = 50;
export const COVERAGE_LAPSE_MS = 6 * 3_600_000;
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const DAY_MS = 86_400_000;

/** One commit of a base scan. A scan lists them oldest first. */
export type ScanCommit = { id: string; tree: string; parents: string[] };

export type LandingCandidate = { runId: string; reviewedHead?: string; reviewedTree?: string; mergeCommit?: string };
export type Landing = { runId: string; commit: string; method: LandingMethod; position: number; reviewedHead?: string };
/** `position` is set when the run landed in this scan. */
export type LandedRun = { runId: string; signalId: string; ids: string[]; holdUntil: string; position?: number };
export type RevertMatch = { runId: string; signalId: string; commit: string; reverts: string };

/**
 * Rules 1 to 3 of spec part 5. Exact matches only. Commits are taken oldest first; a run
 * lands at its first matching commit, and within one commit rule 1 comes before 2 and 2
 * before 3. Several runs may land on one commit.
 */
export function matchLandings(commits: readonly ScanCommit[], candidates: readonly LandingCandidate[]): Landing[] {
  const landed = new Set<string>();
  const landings: Landing[] = [];
  commits.forEach((commit, position) => {
    for (const candidate of candidates) {
      if (landed.has(candidate.runId)) continue;
      if (candidate.mergeCommit !== undefined && commit.id === candidate.mergeCommit) {
        landed.add(candidate.runId);
        landings.push({ runId: candidate.runId, commit: commit.id, method: "merge-commit", position });
      } else if (candidate.reviewedHead !== undefined && commit.parents[1] === candidate.reviewedHead) {
        landed.add(candidate.runId);
        landings.push({
          runId: candidate.runId,
          commit: commit.id,
          method: "merge-parent",
          position,
          reviewedHead: candidate.reviewedHead,
        });
      } else if (candidate.reviewedTree !== undefined && commit.tree === candidate.reviewedTree) {
        landed.add(candidate.runId);
        landings.push({ runId: candidate.runId, commit: commit.id, method: "tree-equal", position });
      }
    }
  });
  return landings;
}

/** The ids whose later reverts count: the landing commit, plus the reviewed head for `merge-parent`. */
export function landedIds(method: LandingMethod, commit: string, reviewedHead?: string): string[] {
  if (method === "merge-parent" && reviewedHead !== undefined && reviewedHead !== commit) {
    return [commit, reviewedHead];
  }
  return [commit];
}

export function revertPattern(id: string): string {
  return `This reverts commit ${id}`;
}

/**
 * Rule 4. `hits` maps a landed id to the commits whose message names it, as form 5 reports them.
 * A revert counts once per landing signal and reverting commit. It needs `holdUntil >= at`, and,
 * for a run that landed in this scan, a position after the landing's.
 */
export function matchReverts(
  commits: readonly ScanCommit[],
  landed: readonly LandedRun[],
  hits: ReadonlyMap<string, ReadonlySet<string>>,
  at: string,
): RevertMatch[] {
  const positions = new Map<string, number>();
  commits.forEach((commit, position) => {
    if (!positions.has(commit.id)) positions.set(commit.id, position);
  });
  const atMs = Date.parse(at);
  const matches: RevertMatch[] = [];
  for (const run of landed) {
    if (Date.parse(run.holdUntil) < atMs) continue;
    const seen = new Set<string>();
    for (const id of run.ids) {
      for (const commit of hits.get(id) ?? []) {
        if (seen.has(commit)) continue;
        const position = positions.get(commit);
        if (position === undefined) continue;
        if (run.position !== undefined && position <= run.position) continue;
        seen.add(commit);
        matches.push({ runId: run.runId, signalId: run.signalId, commit, reverts: id });
      }
    }
  }
  // Every match names a commit of this scan, so its position is known.
  return matches.sort((a, b) => (positions.get(a.commit) ?? 0) - (positions.get(b.commit) ?? 0));
}

/** `landedAt` plus `holdDays` whole days, as an ISO string. */
export function holdUntil(landedAt: string, holdDays: number): string {
  return new Date(Date.parse(landedAt) + holdDays * DAY_MS).toISOString();
}

/**
 * The window's coverage, in the order of spec part 5: a gap inside the window is `gap`; a
 * last scan at or after the close is `covered`; no later scan is `open`; a later scan that
 * records a gap is `gap`; otherwise the later scan must come within `lapseMs` of the last one.
 */
export function windowCoverage(
  points: { last?: ScanPoint; next?: ScanPoint; gapInside: boolean },
  holdUntilAt: string,
  lapseMs: number = COVERAGE_LAPSE_MS,
): Coverage {
  const { last, next, gapInside } = points;
  if (gapInside) return "gap";
  if (last !== undefined && Date.parse(last.checkedAt) >= Date.parse(holdUntilAt)) return "covered";
  if (next === undefined) return "open";
  if (next.gap !== null) return "gap";
  if (last === undefined) return "gap";
  return Date.parse(next.at) - Date.parse(last.checkedAt) <= lapseMs ? "covered" : "gap";
}

/** Splits Git output into lines. Empty output is no lines; otherwise exactly one trailing newline is allowed. */
function lines(stdout: string): string[] {
  if (stdout === "") return [];
  const body = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  return body.split("\n");
}

/** Form 3 and form 5 output: one commit id per line, at most `max` lines. */
export function parseIds(stdout: string, max: number): string[] | undefined {
  const ids = lines(stdout);
  if (ids.length > max) return undefined;
  if (!ids.every((id) => COMMIT_ID.test(id))) return undefined;
  return ids;
}

/** Form 4 output: `H T` then one ` P` per parent, one line per requested id, in the requested order. */
export function parseCommits(stdout: string, ids: readonly string[]): ScanCommit[] | undefined {
  const rows = lines(stdout);
  if (rows.length !== ids.length) return undefined;
  const commits: ScanCommit[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const tokens = rows[index].split(" ");
    // A root commit ends with a trailing space, which splits to one empty token.
    if (tokens[tokens.length - 1] === "" && tokens.length > 2) tokens.pop();
    if (tokens.length < 2) return undefined;
    if (!tokens.every((token) => COMMIT_ID.test(token))) return undefined;
    const [id, tree, ...parents] = tokens;
    if (id !== ids[index]) return undefined;
    commits.push({ id, tree, parents });
  }
  return commits;
}
