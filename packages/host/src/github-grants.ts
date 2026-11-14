import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config, Project } from "./types.js";
import type { TeamAssignment, TeamDelivery } from "./team-types.js";

/**
 * GitHub grants: host-signed capabilities that the GitHub credential proxy checks on every request.
 * Format `v1.<payload>.<mac>`: `payload` is base64url JSON `{ sub, sid, repo, ops, refs?, exp }` and `mac` is
 * base64url HMAC-SHA256 over `v1.<payload>` with a key shared only by the host account and the proxy account.
 * The proxy (`scripts/github-proxy.mjs`) verifies with the same rules; `tests/github-grants.test.ts` proves they agree.
 */
export const GITHUB_GRANT_OPS = ["fetch", "push", "pr", "merge"] as const;
export type GithubGrantOp = typeof GITHUB_GRANT_OPS[number];
export type GithubGrantClaims = { sub: string; sid: string; repo: string; ops: GithubGrantOp[]; refs?: string[]; exp: number };
/** A grant never lives longer than this; the proxy refuses a later `exp`. */
export const GITHUB_GRANT_MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_REFS = 32;

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export class GithubGrantError extends Error {}

export function validGrantRepository(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY.test(value) && !value.toLowerCase().endsWith(".git");
}

/** A full ref name, or with `pattern` a prefix ending in `/*`. Never `refs/*`, never a control or Git-special character. */
export function validGrantRef(value: unknown, pattern: boolean): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  const wildcard = pattern && value.endsWith("/*");
  const ref = wildcard ? value.slice(0, -2) : value;
  if (!ref.startsWith("refs/") || /[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) return false;
  const parts = ref.split("/");
  if (parts.length < (wildcard ? 2 : 3)) return false;
  return parts.every(part => part.length > 0 && part !== "@" && !part.startsWith(".") && !part.endsWith(".lock"));
}

function assertClaims(claims: GithubGrantClaims, nowSeconds: number) {
  const keys = Object.keys(claims).sort().join(",");
  if (keys !== (claims.refs === undefined ? "exp,ops,repo,sid,sub" : "exp,ops,refs,repo,sid,sub")) throw new GithubGrantError("Grant claims have unknown or missing fields.");
  if (!LABEL.test(claims.sub) || !LABEL.test(claims.sid)) throw new GithubGrantError("Grant subject and session must be short labels.");
  if (!validGrantRepository(claims.repo)) throw new GithubGrantError("Grant repository must be OWNER/NAME.");
  if (!Array.isArray(claims.ops) || claims.ops.length === 0 || new Set(claims.ops).size !== claims.ops.length || claims.ops.some(op => !GITHUB_GRANT_OPS.includes(op)))
    throw new GithubGrantError("Grant operations must be a non-empty list of fetch, push, pr, and merge.");
  if (claims.refs !== undefined) {
    if (!claims.ops.includes("push")) throw new GithubGrantError("Grant refs need the push operation.");
    if (!Array.isArray(claims.refs) || claims.refs.length === 0 || claims.refs.length > MAX_REFS || new Set(claims.refs).size !== claims.refs.length || !claims.refs.every(ref => validGrantRef(ref, true)))
      throw new GithubGrantError("Grant refs must be full ref names or prefixes ending in /*.");
  }
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds || claims.exp > nowSeconds + GITHUB_GRANT_MAX_TTL_SECONDS)
    throw new GithubGrantError("Grant expiry must be in the future and at most 24 hours ahead.");
}

/** Signs a grant. `ttlSeconds` defaults to the 24-hour maximum. */
export function mintGithubGrant(key: Buffer, claims: Omit<GithubGrantClaims, "exp"> & { ttlSeconds?: number }, nowMs = Date.now()): string {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new GithubGrantError("The grant key must hold at least 32 bytes.");
  const nowSeconds = Math.floor(nowMs / 1000);
  const { ttlSeconds = GITHUB_GRANT_MAX_TTL_SECONDS, ...rest } = claims;
  const payload: GithubGrantClaims = {
    sub: rest.sub, sid: rest.sid, repo: rest.repo, ops: [...rest.ops],
    ...(rest.refs !== undefined ? { refs: [...rest.refs] } : {}),
    exp: nowSeconds + ttlSeconds,
  };
  assertClaims(payload, nowSeconds);
  const signed = `v1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${signed}.${createHmac("sha256", key).update(signed, "utf8").digest("base64url")}`;
}

/** The key file holds 32 to 128 random bytes as hex (`openssl rand -hex 32`). */
export function parseGithubGrantKey(text: string): Buffer {
  const hex = text.trim();
  if (!/^(?:[0-9a-fA-F]{2}){32,128}$/.test(hex)) throw new GithubGrantError("The grant key file must hold 32 to 128 bytes as hex.");
  return Buffer.from(hex, "hex");
}

export function readGithubGrantKey(path: string): Buffer {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { throw new GithubGrantError("The grant key file is unreadable."); }
  return parseGithubGrantKey(text);
}

// ---------------------------------------------------------------------------------------------------------------
// Which grant a session or a host Git operation receives. All of this is inert unless `autonomy.boundary.github` is set.

export type GithubBoundary = { proxyUrl: string; keyPath: string };
export type GithubGrantScope = { sub: string; repo: string; ops: GithubGrantOp[]; refs?: string[] };
/** What the host knows about a session when it decides its grant. */
export type GithubSessionContext =
  | { kind: "owner"; repository?: string }
  | { kind: "team"; role: TeamAssignment["role"]; repository?: string; delivery?: { mode: TeamDelivery["mode"]; repository: string; headBranch: string } };

export function githubBoundary(config: Pick<Config, "autonomy">): GithubBoundary | undefined {
  return config.autonomy?.boundary?.github;
}

/** The GitHub repository a project maps to: its GitHub-source enrollment, else its delivery policy's repository. */
export function projectGithubRepository(project: Pick<Project, "source" | "team"> | undefined): string | undefined {
  if (project?.source?.mode === "github") return project.source.repository;
  return project?.team?.delivery?.repository;
}

/**
 * The grant rules. No repository means no grant. Mission coordinators and permission reviewers get none. The delivery
 * role gets fetch, push on the run's head branch only, pull requests, and merge only under a merge delivery policy.
 * Every other team member gets fetch. A session the owner started directly gets fetch, push on any branch, pull
 * requests and merge; branch protection on GitHub still governs the base branch.
 */
export function sessionGithubScope(context: GithubSessionContext): GithubGrantScope | undefined {
  if (context.kind === "owner") {
    if (!context.repository || !validGrantRepository(context.repository)) return undefined;
    return { sub: "owner", repo: context.repository, ops: ["fetch", "push", "pr", "merge"], refs: ["refs/heads/*"] };
  }
  if (context.role === "mission-coordinator" || context.role === "permission-coordinator") return undefined;
  if (context.role === "delivery" && context.delivery) {
    const ref = `refs/heads/${context.delivery.headBranch}`;
    if (!validGrantRepository(context.delivery.repository) || !validGrantRef(ref, false)) return undefined;
    return { sub: "team:delivery", repo: context.delivery.repository, ops: context.delivery.mode === "merge" ? ["fetch", "push", "pr", "merge"] : ["fetch", "push", "pr"], refs: [ref] };
  }
  if (!context.repository || !validGrantRepository(context.repository)) return undefined;
  return { sub: `team:${context.role}`, repo: context.repository, ops: ["fetch"] };
}

/** Mints a session's grant, or returns undefined when the boundary is off, there is no scope, or the key is unreadable. */
export function sessionGithubGrant(config: Pick<Config, "autonomy">, scope: GithubGrantScope | undefined, sessionId: string, nowMs = Date.now()): { proxy: string; grant: string } | undefined {
  const boundary = githubBoundary(config);
  if (!boundary || !scope) return undefined;
  try {
    return { proxy: boundary.proxyUrl, grant: mintGithubGrant(readGithubGrantKey(boundary.keyPath), { ...scope, sid: sessionId }, nowMs) };
  } catch {
    console.warn("A GitHub grant could not be minted; the session starts without GitHub access through the proxy.");
    return undefined;
  }
}

/** Host-run Git operations live minutes, not hours. */
const HOST_GRANT_TTL_SECONDS = 15 * 60;
const HOST_CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; test -n "$INFINITE_GITHUB_GRANT" || exit 0; printf 'username=x-infinite-grant\\npassword=%s\\n' "$INFINITE_GITHUB_GRANT"; }; f`;

/**
 * Environment for one host-run Git operation: the grant, the proxy, and (for Git run without a command prefix) Git
 * configuration that rewrites github.com to the proxy and answers the proxy's credential request with the grant.
 * Through `teams.commandPrefix`, sudo drops the GIT_CONFIG_* entries and the root-owned launcher adds the same settings.
 * Empty when the boundary is off, so the environment stays exactly as it was.
 */
export function hostGithubGrantEnvironment(config: Pick<Config, "autonomy">, operation: { sid: string; repo: string; ops: GithubGrantOp[]; refs?: string[] }, nowMs = Date.now()): Record<string, string> {
  const boundary = githubBoundary(config);
  if (!boundary) return {};
  let grant: string;
  try { grant = mintGithubGrant(readGithubGrantKey(boundary.keyPath), { sub: "host", ...operation, ttlSeconds: HOST_GRANT_TTL_SECONDS }, nowMs); }
  catch { return {}; }
  const origin = new URL(boundary.proxyUrl).origin;
  return {
    INFINITE_GITHUB_GRANT: grant,
    INFINITE_GITHUB_PROXY: origin,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: `url.${origin}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_CONFIG_KEY_1: `credential.${origin}.helper`, GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: `credential.${origin}.helper`, GIT_CONFIG_VALUE_2: HOST_CREDENTIAL_HELPER,
  };
}

/** One `doctor` line: proxy reachable, grant key readable, and whether the agent account can still read the token cache. */
export async function githubProxyDoctorLine(config: Pick<Config, "autonomy">): Promise<string | undefined> {
  const boundary = githubBoundary(config);
  if (!boundary) return undefined;
  let key = "readable";
  try { readGithubGrantKey(boundary.keyPath); } catch { key = "UNREADABLE"; }
  let reachable = "unreachable", cache = "unknown";
  try {
    const response = await fetch(new URL("/health", boundary.proxyUrl), { redirect: "error", signal: AbortSignal.timeout(3000) });
    const body = await response.json() as { ok?: unknown; tokenCache?: unknown };
    if (response.ok && body.ok === true) {
      reachable = "reachable";
      if (body.tokenCache === "agent-readable") cache = "READABLE by the agent account, which bypasses the proxy";
      else if (body.tokenCache === "proxy-only") cache = "not readable by the agent account";
    }
  } catch { /* reported as unreachable */ }
  return `GitHub proxy: ${boundary.proxyUrl} ${reachable} · grant key ${key} · token cache ${cache}`;
}
