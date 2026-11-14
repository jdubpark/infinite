#!/usr/bin/env node
// GitHub credential proxy. It holds the GitHub App installation token under its own account and checks a
// host-signed grant on every request. Node standard library only. See deploy/ubuntu/github-proxy.md.
import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const GRANT_OPS = new Set(["fetch", "push", "pr", "merge"]);
const GRANT_MAX_TTL_SECONDS = 24 * 60 * 60;
const GRANT_MAX_LENGTH = 4096;
const GRANT_MAX_REFS = 32;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function validRepository(value) {
  return typeof value === "string" && REPOSITORY.test(value) && !value.toLowerCase().endsWith(".git");
}

/** A full ref name, or with `pattern` a prefix ending in `/*`. Never `refs/*`, never a control or Git-special character. */
export function validRef(value, pattern) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  const wildcard = pattern && value.endsWith("/*");
  const ref = wildcard ? value.slice(0, -2) : value;
  if (!ref.startsWith("refs/") || /[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) return false;
  const parts = ref.split("/");
  if (parts.length < (wildcard ? 2 : 3)) return false;
  return parts.every(part => part.length > 0 && part !== "@" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function parseGrantKey(text) {
  const hex = String(text).trim();
  if (!/^(?:[0-9a-fA-F]{2}){32,128}$/.test(hex)) throw new Error("grant-key-invalid");
  return Buffer.from(hex, "hex");
}

function canonicalBase64url(text) {
  if (!BASE64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : undefined;
}

/**
 * Verifies `v1.<payload>.<mac>` and returns `{ ok: true, claims }` or `{ ok: false, reason }`. The MAC is compared in
 * constant time before the payload is parsed; the payload must be canonical base64url JSON with exactly the known fields.
 */
export function verifyGrant(text, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const refuse = reason => ({ ok: false, reason });
  if (typeof text !== "string" || text.length === 0 || text.length > GRANT_MAX_LENGTH) return refuse("grant-malformed");
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return refuse("grant-malformed");
  const mac = canonicalBase64url(parts[2]);
  if (!mac || mac.length !== 32) return refuse("grant-malformed");
  const expected = createHmac("sha256", key).update(`v1.${parts[1]}`, "utf8").digest();
  if (!timingSafeEqual(mac, expected)) return refuse("grant-signature");
  const payload = canonicalBase64url(parts[1]);
  if (!payload) return refuse("grant-malformed");
  let claims;
  try { claims = JSON.parse(payload.toString("utf8")); } catch { return refuse("grant-malformed"); }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return refuse("grant-malformed");
  const keys = Object.keys(claims).sort().join(",");
  if (keys !== (Object.hasOwn(claims, "refs") ? "exp,ops,refs,repo,sid,sub" : "exp,ops,repo,sid,sub")) return refuse("grant-fields");
  if (typeof claims.sub !== "string" || !LABEL.test(claims.sub) || typeof claims.sid !== "string" || !LABEL.test(claims.sid)) return refuse("grant-fields");
  if (!validRepository(claims.repo)) return refuse("grant-fields");
  if (!Array.isArray(claims.ops) || claims.ops.length === 0 || new Set(claims.ops).size !== claims.ops.length || !claims.ops.every(op => typeof op === "string" && GRANT_OPS.has(op))) return refuse("grant-fields");
  if (Object.hasOwn(claims, "refs")) {
    if (!claims.ops.includes("push") || !Array.isArray(claims.refs) || claims.refs.length === 0 || claims.refs.length > GRANT_MAX_REFS ||
      new Set(claims.refs).size !== claims.refs.length || !claims.refs.every(ref => validRef(ref, true))) return refuse("grant-fields");
  }
  if (!Number.isSafeInteger(claims.exp)) return refuse("grant-fields");
  if (claims.exp <= nowSeconds) return refuse("grant-expired");
  if (claims.exp > nowSeconds + GRANT_MAX_TTL_SECONDS) return refuse("grant-lifetime");
  return { ok: true, claims };
}

/** Exact refs match exactly; a pattern ending in `/*` matches every ref under that prefix. */
export function refAllowed(refs, ref) {
  return Array.isArray(refs) && refs.some(pattern => pattern.endsWith("/*") ? ref.startsWith(pattern.slice(0, -1)) : ref === pattern);
}

async function main() {
  throw new Error("The proxy service is not built yet.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`github-proxy: failed (${error instanceof Error ? error.message : "unknown"})\n`);
    process.exitCode = 1;
  });
}
