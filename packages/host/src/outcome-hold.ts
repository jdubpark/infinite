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

export type ScanCommit = { id: string; tree: string; parents: string[] };

export type LandingCandidate = { runId: string; reviewedHead?: string; reviewedTree?: string; mergeCommit?: string; base?: string };
export type Landing = { runId: string; commit: string; method: LandingMethod; position: number; reviewedHead?: string };
export type LandedRun = { runId: string; signalId: string; commit: string; ids: string[]; holdUntil: string; position?: number; unsure?: boolean };
export type RevertMatch = { runId: string; signalId: string; commit: string; reverts: string };

export function matchLandings(commits: readonly ScanCommit[], candidates: readonly LandingCandidate[], older = false): Landing[] {
  const landed = new Set<string>();
  const landings: Landing[] = [];
  const positions = new Map<string, number>();
  commits.forEach((commit, position) => {
    if (!positions.has(commit.id)) positions.set(commit.id, position);
  });
  const afterBase = (candidate: LandingCandidate, commit: ScanCommit, position: number): boolean => {
    if (commit.id === candidate.reviewedHead) return true;
    const base = candidate.base === undefined ? undefined : positions.get(candidate.base);
    return base === undefined ? !older : position > base;
  };
  commits.forEach((commit, position) => {
    for (const candidate of candidates) {
      if (landed.has(candidate.runId)) continue;
      if (candidate.base !== undefined && candidate.reviewedHead === candidate.base) continue;
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
      } else if (candidate.reviewedTree !== undefined && commit.tree === candidate.reviewedTree && afterBase(candidate, commit, position)) {
        landed.add(candidate.runId);
        landings.push({ runId: candidate.runId, commit: commit.id, method: "tree-equal", position });
      }
    }
  });
  return landings;
}

export function landedIds(method: LandingMethod, commit: string, reviewedHead?: string): string[] {
  if (method === "merge-parent" && reviewedHead !== undefined && reviewedHead !== commit) {
    return [commit, reviewedHead];
  }
  return [commit];
}

export function revertPattern(id: string): string {
  return `This reverts commit ${id}`;
}

export function matchReverts(
  commits: readonly ScanCommit[],
  landed: readonly LandedRun[],
  hits: ReadonlyMap<string, ReadonlySet<string>>,
  at: string,
  older = false,
): RevertMatch[] {
  const positions = new Map<string, number>();
  commits.forEach((commit, position) => {
    if (!positions.has(commit.id)) positions.set(commit.id, position);
  });
  const atMs = Date.parse(at);
  const matches: RevertMatch[] = [];
  for (const run of landed) {
    if (Date.parse(run.holdUntil) < atMs) continue;
    let landing = run.position;
    if (landing === undefined) {
      landing = positions.get(run.commit);
      if (landing === undefined && (older || run.unsure === true)) continue;
    }
    const seen = new Set<string>();
    for (const id of run.ids) {
      for (const commit of hits.get(id) ?? []) {
        if (seen.has(commit)) continue;
        const position = positions.get(commit);
        if (position === undefined) continue;
        if (landing !== undefined && position <= landing) continue;
        seen.add(commit);
        matches.push({ runId: run.runId, signalId: run.signalId, commit, reverts: id });
      }
    }
  }
  return matches.sort((a, b) => (positions.get(a.commit) ?? 0) - (positions.get(b.commit) ?? 0));
}

export function holdUntil(landedAt: string, holdDays: number): string {
  return new Date(Date.parse(landedAt) + holdDays * DAY_MS).toISOString();
}

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

function lines(stdout: string): string[] | undefined {
  if (stdout === "") return [];
  if (!stdout.endsWith("\n")) return undefined;
  return stdout.slice(0, -1).split("\n");
}

export function parseIds(stdout: string, max: number): string[] | undefined {
  const ids = lines(stdout);
  if (ids === undefined || ids.length > max) return undefined;
  if (!ids.every((id) => COMMIT_ID.test(id) && id.length === ids[0].length)) return undefined;
  return ids;
}

export function parseCommits(stdout: string, ids: readonly string[]): ScanCommit[] | undefined {
  const rows = lines(stdout);
  if (rows === undefined || rows.length !== ids.length) return undefined;
  const commits: ScanCommit[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const tokens = rows[index].split(" ");
    if (tokens.length === 3 && tokens[2] === "") tokens.pop();
    if (tokens.length < 2) return undefined;
    const [id, tree, ...parents] = tokens;
    if (id !== ids[index]) return undefined;
    if (!tokens.every((token) => COMMIT_ID.test(token) && token.length === id.length)) return undefined;
    commits.push({ id, tree, parents });
  }
  return commits;
}
