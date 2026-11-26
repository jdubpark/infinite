import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  fstatSync,
  renameSync,
  rmSync,
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
    try {
      writeSync(fd, seal(key, scope, value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  const dir = openSync(dirname(file), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

export const SEGMENT_SIZE = 256;
export const MAX_EVENT_PAGE_BYTES = 512 * 1024;
export interface JournalAppendMeta {
  segment: string;
  bytes: number;
}
export class Journal {
  seq = 0;
  private failure: unknown;
  private failed = false;
  constructor(
    readonly directory: string,
    readonly key: Buffer,
    readonly sessionId: string,
    private readonly options?: { onAppend?: (event: Event, meta: JournalAppendMeta) => void },
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
    return this.appendAll(type, [data])[0];
  }
  appendAll(type: Event["type"], items: Event["data"][]): Event[] {
    if (this.failed) throw new Error("Journal closed after a failed write", { cause: this.failure });
    return this.write(type, items);
  }
  private write(type: Event["type"], items: Event["data"][]): Event[] {
    const at = new Date().toISOString();
    const first = this.seq;
    const events = items.map(
      (data, index): Event => ({ seq: first + index + 1, at, type, data }),
    );
    for (let start = 0; start < events.length; ) {
      const segment = Math.floor((events[start].seq - 1) / SEGMENT_SIZE);
      const end = Math.min(events.length, (segment + 1) * SEGMENT_SIZE - first);
      const lines = events
        .slice(start, end)
        .map((event) => seal(this.key, `${this.sessionId}:${event.seq}`, event) + "\n");
      const bytes = Buffer.from(lines.join(""));
      const name = `${String(segment).padStart(10, "0")}.journal`;
      let segmentBytes = 0;
      try {
        const fd = openSync(join(this.directory, name), "a", 0o600);
        try {
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
          fsyncSync(fd);
          segmentBytes = fstatSync(fd).size;
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        this.failed = true;
        this.failure = error;
        throw error;
      }
      let size = segmentBytes - bytes.length;
      for (let at = start; at < end; at++) {
        size += Buffer.byteLength(lines[at - start]);
        this.seq = events[at].seq;
        this.options?.onAppend?.(events[at], { segment: name, bytes: size });
      }
      this.seq = events[end - 1].seq;
      start = end;
    }
    return events;
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
    lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const seq = segment * SEGMENT_SIZE + i + 1;
      if (seq <= after) continue;
      if (events.length >= limit || totalBytes >= MAX_EVENT_PAGE_BYTES)
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
