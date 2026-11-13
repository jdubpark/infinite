import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export const EVIDENCE_KEY_VERSION = 1;

export type EvidenceKeyPurpose = "row-encryption" | "blind-index" | "event-key";

export type EvidenceIndexClass = "project" | "task" | "area" | "model" | "usage-record";

const INDEX_CLASSES: ReadonlySet<string> = new Set<EvidenceIndexClass>(["project", "task", "area", "model", "usage-record"]);
const TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** One 32-byte key per purpose, derived from the host vault key with its own salt and label. */
export function deriveEvidenceKey(vaultKey: Buffer, purpose: EvidenceKeyPurpose): Buffer {
  const salt = Buffer.from("infinite-evidence-kdf-v1", "utf8");
  const info = Buffer.from(`infinite-evidence:${purpose}:v${EVIDENCE_KEY_VERSION}`, "utf8");
  return Buffer.from(hkdfSync("sha256", vaultKey, salt, info, 32));
}

/** JSON with sorted object keys. Values that JSON cannot represent exactly are refused. */
export function canonicalJson(value: unknown): string {
  return canonical(value, new Set());
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Canonical JSON accepts only JSON values");
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot hold a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) items.push(canonical(value[index], ancestors));
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const members = keys.map(key => `${JSON.stringify(key)}:${canonical(record[key], ancestors)}`);
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function rowAad(table: string, rowId: string): Buffer {
  if (!TABLE_NAME.test(table)) throw new TypeError("Invalid evidence table name");
  if (typeof rowId !== "string" || rowId.length === 0) throw new TypeError("Invalid evidence row ID");
  return Buffer.from(`infinite:evidence:v${EVIDENCE_KEY_VERSION}:${table}:${rowId}`, "utf8");
}

/** AES-256-GCM over canonical JSON, bound to its table and row ID. */
export function sealRow(key: Buffer, table: string, rowId: string, value: unknown): string {
  const aad = rowAad(table, rowId);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(canonicalJson(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    v: EVIDENCE_KEY_VERSION,
    n: nonce.toString("base64"),
    c: encrypted.toString("base64"),
    t: cipher.getAuthTag().toString("base64"),
  });
}

export function openRow<T>(key: Buffer, table: string, rowId: string, sealed: string): T {
  const aad = rowAad(table, rowId);
  const envelope: unknown = JSON.parse(sealed);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Invalid encrypted evidence envelope");
  }
  const data = envelope as Record<string, unknown>;
  if (data.v !== EVIDENCE_KEY_VERSION || typeof data.n !== "string" || typeof data.c !== "string" || typeof data.t !== "string") {
    throw new Error("Unsupported encrypted evidence envelope");
  }
  const nonce = Buffer.from(data.n, "base64");
  const tag = Buffer.from(data.t, "base64");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error("Invalid encrypted evidence envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(Buffer.from(data.c, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as T;
}

/** A keyed hash that lets SQL match a value without storing it. Classes never collide. */
export function blindIndex(key: Buffer, cls: EvidenceIndexClass, value: string): string {
  if (!INDEX_CLASSES.has(cls)) throw new TypeError("Invalid evidence index class");
  if (typeof value !== "string") throw new TypeError("An evidence index value must be a string");
  return createHmac("sha256", key).update(`${cls}\u0000${value}`, "utf8").digest("hex");
}
