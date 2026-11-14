import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

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
