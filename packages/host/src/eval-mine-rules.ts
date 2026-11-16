import { findSecret } from "./evidence/secret-scan.js";
import type { EvalProjectSettings } from "./eval-config.js";
import { capsuleBytes, CAPSULE_MAX_BYTES, evalTestPath } from "./eval-rules.js";
import type { Capsule, EvalFeatures } from "./eval-types.js";
import { FEATURE_VERSION, type FeatureMap, pathArea, taskFeatures } from "./task-features.js";
import type { TeamRun } from "./team-types.js";

/** Pure mining rules. No I/O, no clock. */

export const MINED_FILES_MAX = 29, MINED_LINES_MAX = 1_499, MINED_PATHS_MAX = 32, COMMIT_MESSAGE_MAX = 24_000, MINED_TITLE_MAX = 100;

/** One record of a `-z` numstat. `null` counts for a binary file. */
export type NumstatEntry = { path: string; added: number | null; removed: number | null };

/** `-z` numstat: ADDED TAB REMOVED TAB PATH NUL. Undefined when any record fails to parse. */
export function parseNumstat(stdout: string): NumstatEntry[] | undefined {
  if (stdout === "") return [];
  if (!stdout.endsWith("\0")) return undefined;
  const entries: NumstatEntry[] = [];
  for (const record of stdout.slice(0, -1).split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (match === null) return undefined;
    const [, added, removed, path] = match as unknown as [string, string, string, string];
    if ((added === "-") !== (removed === "-")) return undefined;
    entries.push({ path, added: added === "-" ? null : Number(added), removed: removed === "-" ? null : Number(removed) });
  }
  return entries;
}

export type MineVerdict =
  | { kind: "skip" }
  | { kind: "reject"; reason: "too-large" | "binary-change" | "excluded-area" | "excluded-area-unknown" }
  | { kind: "read-message"; files: string[]; hiddenFiles: string[]; paths: string[]; features: EvalFeatures };

/**
 * The verdict on one commit's change counts, in this order: a refused read; no test file or no other file; too many
 * files or lines; a binary file; an excluded area without a feature map; an excluded area.
 */
export function mineVerdict(
  read: { state: "read"; entries: NumstatEntry[] } | { state: "too-large" },
  settings: EvalProjectSettings,
  map: FeatureMap | undefined,
): MineVerdict {
  if (read.state === "too-large") return { kind: "reject", reason: "too-large" };
  const { entries } = read;
  const tests = entries.filter(entry => evalTestPath(entry.path, settings.testPaths));
  const others = entries.filter(entry => !evalTestPath(entry.path, settings.testPaths));
  if (tests.length === 0 || others.length === 0) return { kind: "skip" };
  const lines = entries.reduce((sum, entry) => sum + (entry.added ?? 0) + (entry.removed ?? 0), 0);
  if (entries.length > MINED_FILES_MAX || lines > MINED_LINES_MAX) return { kind: "reject", reason: "too-large" };
  // A binary change has no line count, so its size is unknown, and an unknown size is never a small one.
  if (entries.some(entry => entry.added === null || entry.removed === null)) return { kind: "reject", reason: "binary-change" };
  const excluded = settings.excludeAreas ?? [];
  if (excluded.length > 0 && map === undefined) return { kind: "reject", reason: "excluded-area-unknown" };
  if (excluded.length > 0 && entries.some(entry => excluded.includes(pathArea(entry.path, map)))) return { kind: "reject", reason: "excluded-area" };
  const files = entries.map(entry => entry.path);
  const features = taskFeatures({ role: "implementer", paths: files }, map);
  return {
    kind: "read-message",
    files,
    hiddenFiles: tests.map(entry => entry.path),
    paths: parentDirectories(files),
    features: { role: "implementer", area: features.area, kind: null, risk: features.risk, featureVersion: FEATURE_VERSION },
  };
}

/** `SECONDS NUL BODY`. Undefined when the output does not parse or the body is over COMMIT_MESSAGE_MAX characters. */
export function parseMessage(stdout: string): { commitTime: string; message: string } | undefined {
  const nul = stdout.indexOf("\0");
  if (nul < 0) return undefined;
  const seconds = stdout.slice(0, nul);
  const message = stdout.slice(nul + 1).trim();
  if (!/^\d{1,10}$/.test(seconds) || Array.from(message).length > COMMIT_MESSAGE_MAX) return undefined;
  return { commitTime: new Date(Number(seconds) * 1000).toISOString(), message };
}

/** A revert by `git revert`, or one that names the commit it reverts. */
export function isRevert(message: string): boolean {
  const subject = message.split("\n")[0] ?? "";
  return subject.startsWith('Revert "') || /^This reverts commit [0-9a-f]{40}(?:[0-9a-f]{24})?\b/m.test(message);
}

function capsuleFor(objective: string, paths: readonly string[]): Capsule {
  const title = Array.from((objective.split("\n")[0] ?? "")).slice(0, MINED_TITLE_MAX).join("");
  return { objective, steering: [], ownerAnswers: [], task: { id: "mined", title, instructions: "", paths: [...paths] } };
}

/**
 * The capsule of a mined commit. `run` is given only for the run's merge commit: its objective and brief are the
 * prompt, and a run with UI changes is refused. Without it the commit message is the prompt.
 */
export function minedCapsule(message: string, paths: readonly string[], run: Pick<TeamRun, "objective" | "brief"> | undefined):
  { capsule: Capsule; promptOrigin: "run-objective" | "commit-message" } | { reject: "ui-changes" } {
  if (run === undefined) return { capsule: capsuleFor(message.trim(), paths), promptOrigin: "commit-message" };
  if (run.brief?.uiChanges === true) return { reject: "ui-changes" };
  const capsule = capsuleFor(run.objective, paths);
  return { capsule: run.brief ? { ...capsule, brief: run.brief } : capsule, promptOrigin: "run-objective" };
}

export function capsuleVerdict(capsule: Capsule): "ok" | "capsule-too-large" | "secret-shaped" {
  if (capsuleBytes(capsule) > CAPSULE_MAX_BYTES) return "capsule-too-large";
  return findSecret(capsule, { token: "", url: "" }) === undefined ? "ok" : "secret-shaped";
}

/** The directory of each file (a root file's own path), sorted and distinct. Past MINED_PATHS_MAX the shortest are kept. */
export function parentDirectories(files: readonly string[]): string[] {
  const directories = [...new Set(files.map(file => {
    const slash = file.lastIndexOf("/");
    return slash < 0 ? file : file.slice(0, slash);
  }))];
  const shortest = directories.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).slice(0, MINED_PATHS_MAX);
  return shortest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
