import { createHmac } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Config, ExecutionIdentity, Project } from "./types.js";
import type { TeamAssignment, TeamDelivery } from "./team-types.js";

export const GITHUB_GRANT_VERSION = "v2";
export const GITHUB_GRANT_OPS = ["fetch", "push", "pr", "merge"] as const;
export type GithubGrantOp = typeof GITHUB_GRANT_OPS[number];
export type GithubGrantClaims = { sub: string; sid: string; project: string; repo: string; ops: GithubGrantOp[]; refs?: string[]; exp: number };
export const GITHUB_GRANT_MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_REFS = 32;

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export class GithubGrantError extends Error {}
export class GithubGrantKeyError extends GithubGrantError {}

export function validGrantRepository(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY.test(value) && !value.toLowerCase().endsWith(".git");
}

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
  if (keys !== (claims.refs === undefined ? "exp,ops,project,repo,sid,sub" : "exp,ops,project,refs,repo,sid,sub")) throw new GithubGrantError("Grant claims have unknown or missing fields.");
  if (!LABEL.test(claims.sub) || !LABEL.test(claims.sid) || !LABEL.test(claims.project)) throw new GithubGrantError("Grant subject, session, and project must be short labels.");
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

export function mintGithubGrant(key: Buffer, claims: Omit<GithubGrantClaims, "exp"> & { ttlSeconds?: number }, nowMs = Date.now()): string {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new GithubGrantError("The grant key must hold at least 32 bytes.");
  const nowSeconds = Math.floor(nowMs / 1000);
  const { ttlSeconds = GITHUB_GRANT_MAX_TTL_SECONDS, ...rest } = claims;
  const payload: GithubGrantClaims = {
    sub: rest.sub, sid: rest.sid, project: rest.project, repo: rest.repo, ops: [...rest.ops],
    ...(rest.refs !== undefined ? { refs: [...rest.refs] } : {}),
    exp: nowSeconds + ttlSeconds,
  };
  assertClaims(payload, nowSeconds);
  const signed = `${GITHUB_GRANT_VERSION}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${signed}.${createHmac("sha256", key).update(signed, "utf8").digest("base64url")}`;
}

export function parseGithubGrantKey(text: string): Buffer {
  const hex = text.trim();
  if (!/^(?:[0-9a-fA-F]{2}){32,128}$/.test(hex)) throw new GithubGrantKeyError("invalid (it must hold 32 to 128 bytes as hex)");
  return Buffer.from(hex, "hex");
}

export type GithubKeyOwner = { trustedUid?: number };

export function readGithubGrantKey(path: string, { trustedUid = 0 }: GithubKeyOwner = {}): Buffer {
  const trusted = (uid: number) => uid === 0 || uid === trustedUid;
  if (!isAbsolute(path) || resolve(path) !== path) throw new GithubGrantKeyError("unsafe (the path must be absolute and normalized)");
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    let info;
    try { info = lstatSync(directory); } catch { throw new GithubGrantKeyError("unreadable"); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new GithubGrantKeyError(`unsafe (${directory} is not a real directory)`);
    if (!trusted(info.uid) || (info.mode & 0o022) !== 0) throw new GithubGrantKeyError(`unsafe (${directory} is writable by an account other than root)`);
    if (directory === "/") break;
  }
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch (error) { throw new GithubGrantKeyError((error as NodeJS.ErrnoException).code === "ELOOP" ? "unsafe (a symbolic link)" : "unreadable"); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new GithubGrantKeyError("unsafe (not a regular file)");
    if (!trusted(info.uid)) throw new GithubGrantKeyError("unsafe (not owned by root)");
    if ((info.mode & 0o027) !== 0) throw new GithubGrantKeyError("unsafe (writable by its group or open to other users)");
    if (info.size > 1024) throw new GithubGrantKeyError("invalid (it must hold 32 to 128 bytes as hex)");
    let text: string;
    try { text = readFileSync(fd, "utf8"); } catch { throw new GithubGrantKeyError("unreadable"); }
    return parseGithubGrantKey(text);
  } finally { closeSync(fd); }
}

export type GithubBoundary = { proxyUrl: string; keyPath: string };
export type GithubGrantScope = { sub: string; repo: string; ops: GithubGrantOp[]; refs?: string[] };
export type GithubSessionContext =
  | { kind: "owner"; repository?: string }
  | { kind: "unattributed"; repository?: string }
  | { kind: "team"; role: TeamAssignment["role"]; repository?: string; delivery?: { mode: TeamDelivery["mode"]; repository: string; headBranch: string } };

export function githubBoundary(config: Pick<Config, "autonomy">): GithubBoundary | undefined {
  return config.autonomy?.boundary?.github;
}

export function projectGithubRepository(project: Pick<Project, "source" | "team"> | undefined): string | undefined {
  if (project?.source?.mode === "github") return project.source.repository;
  return project?.team?.delivery?.repository;
}

export function sessionGithubScope(context: GithubSessionContext): GithubGrantScope | undefined {
  if (context.kind === "owner" || context.kind === "unattributed") {
    if (!context.repository || !validGrantRepository(context.repository)) return undefined;
    return context.kind === "owner"
      ? { sub: "owner", repo: context.repository, ops: ["fetch", "push", "pr", "merge"], refs: ["refs/heads/*"] }
      : { sub: "unattributed", repo: context.repository, ops: ["fetch"] };
  }
  if (context.role === "mission-coordinator" || context.role === "permission-coordinator" || context.role === "intent-checker" || context.role === "evaluator" || context.role === "judge") return undefined;
  if (context.role === "delivery" && context.delivery) {
    const ref = `refs/heads/${context.delivery.headBranch}`;
    if (!validGrantRepository(context.delivery.repository) || !validGrantRef(ref, false)) return undefined;
    return { sub: "team:delivery", repo: context.delivery.repository, ops: context.delivery.mode === "merge" ? ["fetch", "push", "pr", "merge"] : ["fetch", "push", "pr"], refs: [ref] };
  }
  if (!context.repository || !validGrantRepository(context.repository)) return undefined;
  return { sub: `team:${context.role}`, repo: context.repository, ops: ["fetch"] };
}

export type SessionGithubOrigin = { team: GithubGrantScope | undefined } | "owner-started";

export function sessionGithubScopeFor(input: { team: boolean; origin: SessionGithubOrigin | undefined; repository: string | undefined; executionIdentity?: ExecutionIdentity }): GithubGrantScope | undefined {
  if (input.executionIdentity === "eval") return undefined;
  if (input.team) return typeof input.origin === "object" ? input.origin.team : undefined;
  return sessionGithubScope({ kind: input.origin === "owner-started" ? "owner" : "unattributed", repository: input.repository });
}

export function sessionGithubGrant(config: Pick<Config, "autonomy">, scope: GithubGrantScope | undefined,
  session: { sessionId: string; projectId: string; nowMs?: number } & GithubKeyOwner): { proxy: string; grant: string } | undefined {
  const boundary = githubBoundary(config);
  if (!boundary || !scope) return undefined;
  try {
    const key = readGithubGrantKey(boundary.keyPath, session);
    return { proxy: boundary.proxyUrl, grant: mintGithubGrant(key, { ...scope, sid: session.sessionId, project: session.projectId }, session.nowMs) };
  } catch (error) {
    const reason = error instanceof GithubGrantKeyError ? ` (the grant key file is ${error.message})` : "";
    console.warn(`A GitHub grant could not be minted${reason}; the session starts without GitHub access through the proxy.`);
    return undefined;
  }
}

const HOST_GRANT_TTL_SECONDS = 15 * 60;
const HOST_CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; test -n "$INFINITE_GITHUB_GRANT" || exit 0; printf 'username=x-infinite-grant\\npassword=%s\\n' "$INFINITE_GITHUB_GRANT"; }; f`;

export function hostGithubGrantEnvironment(config: Pick<Config, "autonomy">, operation: { sid: string; project: string; repo: string; ops: GithubGrantOp[]; refs?: string[] },
  { nowMs, trustedUid }: { nowMs?: number } & GithubKeyOwner = {}): Record<string, string> {
  const boundary = githubBoundary(config);
  if (!boundary) return {};
  let grant: string;
  try { grant = mintGithubGrant(readGithubGrantKey(boundary.keyPath, { trustedUid }), { sub: "host", ...operation, ttlSeconds: HOST_GRANT_TTL_SECONDS }, nowMs); }
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

export async function githubProxyDoctorLine(config: Pick<Config, "autonomy">, owner: GithubKeyOwner = {}): Promise<string | undefined> {
  const boundary = githubBoundary(config);
  if (!boundary) return undefined;
  let key = "readable";
  try { readGithubGrantKey(boundary.keyPath, owner); } catch (error) { key = error instanceof GithubGrantKeyError ? error.message.replace(/^[a-z]+/, (word) => word.toUpperCase()) : "UNREADABLE"; }
  let reachable = "unreachable", cache = "unknown";
  try {
    const response = await fetch(new URL("/health", boundary.proxyUrl), { redirect: "error", signal: AbortSignal.timeout(3000) });
    const body = await response.json() as { ok?: unknown; tokenCache?: unknown };
    if (response.ok && body.ok === true) {
      reachable = "reachable";
      if (body.tokenCache === "agent-readable") cache = "READABLE by the agent account, which bypasses the proxy";
      else if (body.tokenCache === "proxy-only") cache = "not readable by the agent account";
      else cache = "UNKNOWN: agent access could not be ruled out (check ACLs with getfacl)";
    }
  } catch {}
  return `GitHub proxy: ${boundary.proxyUrl} ${reachable} · grant key ${key} · token cache ${cache}`;
}
