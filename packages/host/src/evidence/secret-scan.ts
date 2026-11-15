import { refusalPath } from "./member-entry.js";

export type SecretClass = "private-key" | "access-token" | "hook-token" | "hook-url" | "session-credential";

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY/;

/** Provider token shapes. A match says only that the text has the shape, never which text it is. */
const ACCESS_TOKENS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /github_pat_\w{22,}/,
  /AKIA[A-Z0-9]{16}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /eyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // Credentials this host issues to a session, of any session: a GitHub grant (`VERSION.CLAIMS.MAC`, the claims being
  // JSON in base64url) and an egress proxy password (`VERSION.EXPIRES.MAC`). The MAC is an HMAC-SHA256 in base64url:
  // exactly 43 characters, so a build or cache id that ends in a 64-character hash is left alone.
  /v\d+\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
  /v\d+\.\d{9,12}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
];
/** A shorter string is no credential; it would only refuse ordinary text. */
const MIN_CREDENTIAL_LENGTH = 16;
/** The variables under which a provider's environment carries a credential of its session. The hook token has its own class. */
const CREDENTIAL_VARIABLES = ["INFINITE_GITHUB_GRANT", "INFINITE_NATIVE_TOKEN", "OPENCODE_SERVER_PASSWORD"] as const;

/**
 * Every credential in the environment a provider is started with: the variables above, and the password of every
 * address, which is where the egress proxy credential travels. The worker passes them to `findSecret` as `own.credentials`.
 */
export function sessionCredentials(env: Readonly<Record<string, string | undefined>>): string[] {
  const found = new Set<string>();
  for (const name of CREDENTIAL_VARIABLES) {
    const value = env[name];
    if (value) found.add(value);
  }
  for (const value of Object.values(env)) {
    if (!value?.includes("://")) continue;
    let password = "";
    try { password = decodeURIComponent(new URL(value).password); } catch { /* not an address */ }
    if (password) found.add(password);
  }
  return [...found];
}

/** The member's own hook URL port on loopback, as the member would write it. */
function hookUrlPattern(url: string): RegExp | undefined {
  let port: string;
  try {
    port = new URL(url).port;
  } catch {
    return undefined;
  }
  return port ? new RegExp(`(?:127\\.0\\.0\\.1|localhost):${port}(?!\\d)`) : undefined;
}

/**
 * The first string, in key order, that matches a class, with its path in `refusalPath` form.
 * Keys are read too. The matched value is never returned.
 * `own.credentials` holds every credential the host issued to this session, whatever its shape.
 */
export function findSecret(value: unknown, own: { token: string; url: string; credentials?: readonly string[] }): { path: string; cls: SecretClass } | undefined {
  const issued = (own.credentials ?? []).filter(credential => credential.length >= MIN_CREDENTIAL_LENGTH);
  const hookUrl = hookUrlPattern(own.url);
  const classify = (text: string): SecretClass | undefined => {
    if (PRIVATE_KEY.test(text)) return "private-key";
    if (issued.some(credential => text.includes(credential))) return "session-credential";
    if (ACCESS_TOKENS.some(pattern => pattern.test(text))) return "access-token";
    if (own.token.length > 0 && text.includes(own.token)) return "hook-token";
    if (hookUrl?.test(text)) return "hook-url";
    return undefined;
  };
  return walk(value, [], classify);
}

function walk(
  value: unknown,
  path: PropertyKey[],
  classify: (text: string) => SecretClass | undefined,
): { path: string; cls: SecretClass } | undefined {
  if (typeof value === "string") {
    const cls = classify(value);
    return cls ? { path: refusalPath(path), cls } : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = walk(value[index], [...path, index], classify);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const cls = classify(key);
      if (cls) return { path: refusalPath([...path, key]), cls };
      const found = walk(child, [...path, key], classify);
      if (found) return found;
    }
  }
  return undefined;
}
