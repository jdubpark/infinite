import { isScopedPath } from "./goal-types.js";

export const CITATION_LIMITS = { chars: 2_000, lineSpan: 10_000, sourcesPerEntry: 32 } as const;
export type RepositoryCitation = { kind: "repository"; path: string; lines?: { from: number; to: number }; commit?: string };
export type OutsideCitation = { kind: "outside"; host: string };

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY = /^([^@#]+)(?:#L(\d+)(?:-L(\d+))?)?(?:@([0-9a-f]{40}|[0-9a-f]{64}))?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Form only: `path`, `path#Lfrom`, `path#Lfrom-Lto`, each with an optional `@commit`, or an https URL. Undefined for anything else. */
export function parseCitation(text: string): RepositoryCitation | OutsideCitation | undefined {
  if (text.length > CITATION_LIMITS.chars) return undefined;
  if (SCHEME.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" || url.hostname === "") return undefined;
    return { kind: "outside", host: url.hostname };
  }
  const match = REPOSITORY.exec(text);
  if (!match) return undefined;
  const [, path, fromText, toText, commit] = match;
  if (path.length > 300 || path === "." || !isScopedPath(path)) return undefined;
  const citation: RepositoryCitation = { kind: "repository", path };
  if (fromText !== undefined) {
    const from = Number(fromText);
    const to = toText === undefined ? from : Number(toText);
    if (from < 1 || to < from || to - from >= CITATION_LIMITS.lineSpan) return undefined;
    citation.lines = { from, to };
  }
  if (commit !== undefined) {
    if (!COMMIT.test(commit)) return undefined;
    citation.commit = commit;
  }
  return citation;
}

/** Array elements whose first 32 `sources` strings hold at least `perEntry` form-valid citations; outside citations count once per host. */
export function qualifyingEntries(entries: readonly unknown[], perEntry: number): number {
  let qualifying = 0;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const sources = (entry as { sources?: unknown }).sources;
    if (!Array.isArray(sources)) continue;
    const hosts = new Set<string>();
    let valid = 0;
    for (const source of sources.slice(0, CITATION_LIMITS.sourcesPerEntry)) {
      if (typeof source !== "string") continue;
      const citation = parseCitation(source);
      if (citation === undefined) continue;
      if (citation.kind === "outside") {
        if (hosts.has(citation.host)) continue;
        hosts.add(citation.host);
      }
      valid += 1;
    }
    if (valid >= perEntry) qualifying += 1;
  }
  return qualifying;
}

const fold = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Whether `quote` appears in `text`, or in its lines `from` to `to`, after folding every whitespace run to one space and trimming.
 *  Lines are split on "\n" with a trailing "\r" removed; lines past the end are absent. */
export function quotePresent(text: string, quote: string, lines?: { from: number; to: number }): boolean {
  const needle = fold(quote);
  if (needle === "") return false;
  let scope = text;
  if (lines !== undefined) {
    if (lines.from < 1) return false;
    const all = text.split("\n").map(line => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (lines.from > all.length) return false;
    scope = all.slice(lines.from - 1, lines.to).join("\n");
  }
  return fold(scope).includes(needle);
}
