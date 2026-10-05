import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  renameSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { Event } from "./types.js";

export function seal(key: Buffer, scope: string, value: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`infinite:v1:${scope}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    n: nonce.toString("base64"),
    c: ciphertext.toString("base64"),
    t: cipher.getAuthTag().toString("base64"),
  });
}

export function unseal<T>(key: Buffer, scope: string, raw: string): T {
  const envelope = JSON.parse(raw);
  if (envelope.v !== 1) throw new Error("Unsupported vault version");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.n, "base64"),
  );
  decipher.setAAD(Buffer.from(`infinite:v1:${scope}`));
  decipher.setAuthTag(Buffer.from(envelope.t, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.c, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}

export function writeSealed(
  file: string,
  key: Buffer,
  scope: string,
  value: unknown,
) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, seal(key, scope, value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const dir = openSync(dirname(file), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

// One worker writes each journal. Records are authenticated against both session
// and sequence. Segments bound reconnect reads without truncating old history.
const SEGMENT_SIZE = 256;
export class Journal {
  seq = 0;
  constructor(
    readonly directory: string,
    readonly key: Buffer,
    readonly sessionId: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const segments = readdirSync(directory)
      .filter((n) => /^\d{10}\.journal$/.test(n))
      .sort();
    if (segments.length) {
      const last = segments.at(-1)!;
      const raw = readFileSync(join(directory, last), "utf8");
      if (!raw.endsWith("\n"))
        throw new Error("Incomplete journal; recovery required");
      const lines = raw.trimEnd().split("\n");
      const seq = Number(last.slice(0, 10)) * SEGMENT_SIZE + lines.length;
      const event = unseal<Event>(key, `${sessionId}:${seq}`, lines.at(-1)!);
      if (event.seq !== seq) throw new Error("Journal sequence mismatch");
      this.seq = seq;
    }
  }
  append(type: Event["type"], data: Event["data"]): Event {
    const seq = this.seq + 1;
    const event: Event = { seq, at: new Date().toISOString(), type, data };
    const file = join(
      this.directory,
      `${String(Math.floor((seq - 1) / SEGMENT_SIZE)).padStart(10, "0")}.journal`,
    );
    const bytes = Buffer.from(
      seal(this.key, `${this.sessionId}:${seq}`, event) + "\n",
    );
    const fd = openSync(file, "a", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.seq = seq;
    return event;
  }
}

export function readEvents(
  directory: string,
  key: Buffer,
  sessionId: string,
  after = 0,
  limit = 200,
  types?: Set<string>,
): { events: Event[]; cursor: number; more: boolean } {
  const events: Event[] = [];
  let segment = Math.floor(after / SEGMENT_SIZE);
  let totalBytes = 0;
  let scanned = after;
  for (;;) {
    const file = join(
      directory,
      `${String(segment).padStart(10, "0")}.journal`,
    );
    if (!existsSync(file)) break;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.pop(); // An in-progress final write is replayed on the next read.
    for (let i = 0; i < lines.length; i++) {
      const seq = segment * SEGMENT_SIZE + i + 1;
      if (seq <= after) continue;
      if (events.length >= limit || totalBytes >= 512 * 1024)
        return { events, cursor: scanned, more: true };
      const event = unseal<Event>(key, `${sessionId}:${seq}`, lines[i]);
      if (event.seq !== seq) throw new Error("Journal sequence mismatch");
      scanned = seq;
      totalBytes += lines[i].length;
      if (types && !types.has(event.type)) continue;
      events.push(event);
    }
    if (lines.length < SEGMENT_SIZE) break;
    segment++;
  }
  return { events, cursor: scanned, more: false };
}
