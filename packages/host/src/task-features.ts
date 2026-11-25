import { createHash } from "node:crypto";
import { z } from "zod";

export const FEATURE_VERSION = 1;

export const TASK_KINDS = ["feature", "fix", "refactor", "test", "docs", "investigation"] as const;
export type TaskKind = typeof TASK_KINDS[number];

export type TaskRisk = "normal" | "elevated";

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

export interface FeatureMap {
  areas: { id: string; paths: string[] }[];
  elevated?: string[];
  elevatedTokens?: string[];
}

export interface TaskFeatures {
  role: "implementer" | "scout";
  area: string;
  kind: TaskKind | null;
  risk: TaskRisk;
  featureVersion: number;
  featureMap: string;
}

const areaIdPattern = /^[a-z][a-z0-9-]{0,39}$/;
const reservedAreaIds = new Set(["mixed", "none", "root"]);
const tokenPattern = /^[a-z0-9]{2,40}$/;
const controlCharacter = /[\u0000-\u001f\u007f]/;
const groupingRoots = new Set(["apps", "packages", "services", "libs", "crates", "cmd", "modules"]);
const chunkSeparator = /[^A-Za-z0-9]+/;
const atomPattern = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
const MAX_TOKEN_LENGTH = 40;

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

export function isDocPath(path: string) {
  return path.startsWith("docs/") || path.endsWith(".md");
}

export function isTestPath(path: string) {
  return /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(path);
}

export function votingPaths(paths: readonly string[]): string[] {
  const voting = paths.filter(path => !isTestPath(path) && !isDocPath(path));
  return voting.length ? voting : [...paths];
}

function prefixMatches(path: string, prefix: string) {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function isOwnedPath(path: string) {
  return path.length > 0
    && !controlCharacter.test(path)
    && !path.includes("\\")
    && path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

function fallbackArea(path: string) {
  const segments = path.split("/");
  if (segments.length === 1) return "root";
  if (groupingRoots.has(segments[0]) && segments.length >= 3) return `${segments[0]}/${segments[1]}/`;
  return `${segments[0]}/`;
}

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

export function taskArea(paths: readonly string[], map?: FeatureMap): string {
  if (paths.length === 0) return "mixed";
  const areas = new Set(votingPaths(paths).map(path => pathArea(path, map)));
  return areas.size === 1 ? [...areas][0] : "mixed";
}

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

export function taskRisk(paths: readonly string[], map?: FeatureMap, label?: "elevated"): TaskRisk {
  if (label === "elevated") return "elevated";
  const prefixes = map?.elevated ?? [];
  if (paths.some(path => prefixes.some(prefix => prefixMatches(path, prefix)))) return "elevated";
  const list = new Set(map?.elevatedTokens ?? DEFAULT_ELEVATED_TOKENS);
  const tokenHit = votingPaths(paths).some(path => pathSpells(path, list));
  return tokenHit ? "elevated" : "normal";
}

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

export function featureMapDigest(map?: FeatureMap): string {
  if (!map) return "default";
  return createHash("sha256").update(canonicalJson(map)).digest("hex");
}

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
