import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Task features: the area, kind, and risk of a team task. Pure rules only.
 * No file access, clock, or randomness. Nothing calls this module yet.
 */

/** Version of these rules. Bump it when a rule changes, so each stored row says which rules produced it. */
export const FEATURE_VERSION = 1;

export const TASK_KINDS = ["feature", "fix", "refactor", "test", "docs", "investigation"] as const;
export type TaskKind = typeof TASK_KINDS[number];

export type TaskRisk = "normal" | "elevated";

/**
 * Risk tokens used when a project's feature map does not set its own list.
 * Singular forms only: a path also spells an entry when it holds the entry followed by `s`.
 */
export const DEFAULT_ELEVATED_TOKENS: readonly string[] = [
  "auth",
  "authn",
  "authz",
  "authorization",
  "authentication",
  "authorize",
  "authenticate",
  "oauth",
  "permission",
  "security",
  "secret",
  "vault",
  "credential",
  "password",
  "migration",
  "migrate",
  "billing",
  "payment",
  "deploy",
  "deployment",
  "sudoers",
  "workflow",
  "terraform",
  "k8s",
  "kubernetes",
  "dockerfile",
  "env",
  "ci",
];

/** A project's private feature map. Prefixes are repository-relative paths. */
export interface FeatureMap {
  areas: { id: string; paths: string[] }[];
  /** Path prefixes that always raise risk, for any owned path, including test and doc paths. */
  elevated?: string[];
  /** Replaces the default token list when set. */
  elevatedTokens?: string[];
}

export interface TaskFeatures {
  role: "implementer" | "scout";
  area: string;
  kind: TaskKind | null;
  risk: TaskRisk;
  featureVersion: number;
  /** "default" for no map, or the map's digest. */
  featureMap: string;
}

const areaIdPattern = /^[a-z][a-z0-9-]{0,39}$/;
const reservedAreaIds = new Set(["mixed", "none", "root"]);
const tokenPattern = /^[a-z0-9]{2,40}$/;
const controlCharacter = /[\u0000-\u001f\u007f]/;
/** Top-level directories whose second segment names the area, such as `apps/mobile/`. */
const groupingRoots = new Set(["apps", "packages", "services", "libs", "crates", "cmd", "modules"]);
/** A chunk is a run of ASCII letters and digits. Everything else in a path separates chunks. */
const chunkSeparator = /[^A-Za-z0-9]+/;
/**
 * The atoms of a chunk: an upper-case run that no lower-case letter follows (`HTTP` in `HTTPServer`),
 * a lower-case word with at most one leading capital, or a digit run. So `K8S2Client` gives
 * `K`, `8`, `S`, `2`, `Client`, and a lower-case compound such as `authservice` is one atom.
 */
const atomPattern = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
/** The longest list entry. A run of atoms longer than an entry plus `s` cannot match. */
const MAX_TOKEN_LENGTH = 40;

/**
 * A repository-relative path prefix. The single prefix `.` matches every path.
 * Any other prefix has no empty, `.`, or `..` segment, so `./infra`, `infra//x`, and a trailing slash are refused.
 */
function isValidPathPrefix(prefix: string) {
  if (prefix.length < 1 || prefix.length > 300) return false;
  if (prefix === ".") return true;
  return !controlCharacter.test(prefix)
    && !prefix.includes("\\")
    && prefix.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

const pathPrefixSchema = z.string().refine(isValidPathPrefix, {
  message: "A path prefix must be repository-relative, with no empty, '.', or '..' segment, no backslash, and no control character.",
});

const featureAreaSchema = z.object({
  id: z.string().regex(areaIdPattern).refine(id => !reservedAreaIds.has(id), { message: "This area id is reserved." }),
  paths: z.array(pathPrefixSchema).min(1).max(32),
}).strict();

/** Strict schema for a project's feature map. */
export const featureMapSchema: z.ZodType<FeatureMap> = z.object({
  areas: z.array(featureAreaSchema).max(64),
  elevated: z.array(pathPrefixSchema).max(64).optional(),
  elevatedTokens: z.array(z.string().regex(tokenPattern)).max(64).optional(),
}).strict().superRefine((map, context) => {
  const ids = map.areas.map(area => area.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Area ids must be unique.", path: ["areas"] });
  }
});

/** Whether a path is a documentation path. Matches the rule in `diffStat`. */
export function isDocPath(path: string) {
  return path.startsWith("docs/") || path.endsWith(".md");
}

/** Whether a path is a test path. Matches the rule in `diffStat`. */
export function isTestPath(path: string) {
  return /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(path);
}

/** The paths that vote on the task's area and risk. When none is left, every path votes. */
export function votingPaths(paths: readonly string[]): string[] {
  const voting = paths.filter(path => !isTestPath(path) && !isDocPath(path));
  return voting.length ? voting : [...paths];
}

/**
 * Whether a prefix covers a path, by whole segments. Same rule as `teamPathAllowed`: `.` covers everything,
 * so `src` covers `src/a.ts` but not `src2/a.ts`.
 */
function prefixMatches(path: string, prefix: string) {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * A path a plan may own: relative, with no empty, `.`, or `..` segment, no backslash, and no control character.
 * Callers pass owned paths that the plan schema has already validated. This check is a guard, not an input route.
 */
function isOwnedPath(path: string) {
  return path.length > 0
    && !controlCharacter.test(path)
    && !path.includes("\\")
    && path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The fallback area: a directory name with a trailing slash, so it never equals a mapped id or a reserved name.
 * A root file is `root`.
 */
function fallbackArea(path: string) {
  const segments = path.split("/");
  if (segments.length === 1) return "root";
  if (groupingRoots.has(segments[0]) && segments.length >= 3) return `${segments[0]}/${segments[1]}/`;
  return `${segments[0]}/`;
}

/**
 * The area of one path. The longest matching prefix wins, and the earlier area wins a tie.
 * The `.` prefix is the weakest match, so any named prefix beats it.
 * A malformed path returns `root` and never throws.
 */
export function pathArea(path: string, map?: FeatureMap): string {
  if (!isOwnedPath(path)) return "root";
  let best: { id: string; length: number } | undefined;
  for (const area of map?.areas ?? []) {
    for (const prefix of area.paths) {
      if (!prefixMatches(path, prefix)) continue;
      const length = prefix === "." ? 0 : prefix.length;
      if (!best || length > best.length) best = { id: area.id, length };
    }
  }
  return best?.id ?? fallbackArea(path);
}

/** The area of a task: the one area of its voting paths, or `mixed`. A task with no paths is `mixed`. */
export function taskArea(paths: readonly string[], map?: FeatureMap): string {
  if (paths.length === 0) return "mixed";
  const areas = new Set(votingPaths(paths).map(path => pathArea(path, map)));
  return areas.size === 1 ? [...areas][0] : "mixed";
}

/**
 * Whether a path spells a list entry. It does when some run of adjacent atoms of one chunk, joined in
 * lower case, equals an entry, or an entry followed by `s`. So `OAuthClient` spells `oauth`,
 * `DockerFileBuilder` spells `dockerfile`, and `permissions` spells `permission`. Nothing marks a
 * boundary inside `author` or `authservice`, and a separator ends a chunk, so `per-mission` spells nothing.
 */
function pathSpells(path: string, list: ReadonlySet<string>): boolean {
  for (const chunk of path.split(chunkSeparator)) {
    const atoms = (chunk.match(atomPattern) ?? []).map(atom => atom.toLowerCase());
    for (let start = 0; start < atoms.length; start++) {
      let run = "";
      for (let end = start; end < atoms.length; end++) {
        run += atoms[end];
        if (run.length > MAX_TOKEN_LENGTH + 1) break;
        if (list.has(run) || (run.endsWith("s") && list.has(run.slice(0, -1)))) return true;
      }
    }
  }
  return false;
}

/**
 * The risk of a task. A label can only raise risk to `elevated`.
 * Risk is elevated when the label is set, when any owned path matches an `elevated` prefix,
 * or when a voting path spells an entry of the token list.
 */
export function taskRisk(paths: readonly string[], map?: FeatureMap, label?: "elevated"): TaskRisk {
  if (label === "elevated") return "elevated";
  const prefixes = map?.elevated ?? [];
  if (paths.some(path => prefixes.some(prefix => prefixMatches(path, prefix)))) return "elevated";
  const list = new Set(map?.elevatedTokens ?? DEFAULT_ELEVATED_TOKENS);
  const tokenHit = votingPaths(paths).some(path => pathSpells(path, list));
  return tokenHit ? "elevated" : "normal";
}

/** Canonical JSON: object keys sorted at every level, array order kept, undefined keys dropped. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** "default" for no map. Otherwise the SHA-256 hex of the map's canonical JSON. */
export function featureMapDigest(map?: FeatureMap): string {
  if (!map) return "default";
  return createHash("sha256").update(canonicalJson(map)).digest("hex");
}

/** The features of a task. A scout has no area, and its kind is always `investigation`. */
export function taskFeatures(
  input: { role: "implementer" | "scout"; paths: readonly string[]; kind?: TaskKind; risk?: "elevated" },
  map?: FeatureMap,
): TaskFeatures {
  const risk = taskRisk(input.paths, map, input.risk);
  const featureMap = featureMapDigest(map);
  if (input.role === "scout") {
    return { role: "scout", area: "none", kind: "investigation", risk, featureVersion: FEATURE_VERSION, featureMap };
  }
  return {
    role: "implementer",
    area: taskArea(input.paths, map),
    kind: input.kind ?? null,
    risk,
    featureVersion: FEATURE_VERSION,
    featureMap,
  };
}
