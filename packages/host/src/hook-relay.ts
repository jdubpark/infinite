// Provider command hook → POST to the worker's loopback hook listener. Never prints, always
// exits 0, so nothing it does can become a hook decision for the provider.
//
// The relay runs inside the agent's account, so it is the only Infinite process that can read
// the provider's transcript. When the worker's reply asks for the transcript, the relay streams
// the file from the worker's byte cursor in bounded chunks until the worker has caught up.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MAX_SECONDARY_FILES, MAX_SECONDARY_PASSES, SECONDARY_ID, SECONDARY_NAME, type SecondaryListing } from "./transcript-secondary.js";

const CHUNK = 192 * 1024;
/** The most stream passes (one chunk or one end mark each) the primary transcript may spend in one relay run. */
const MAX_CHUNKS = 64;
const STREAM_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface RelayOptions {
  url: string;
  token: string;
  /** Resolves the transcript when the payload names none (Codex rollouts). */
  home?: string;
  fetch?: typeof fetch;
}

const post = async (options: RelayOptions, route: string, body: string): Promise<Record<string, unknown> | null> => {
  const response = await (options.fetch ?? fetch)(`${options.url}/${route}`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(1500),
  });
  if (response.status !== 200) return null;
  const parsed: unknown = await response.json().catch(() => null);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
};

/** Codex names the rollout only by thread id; the file lives under the sessions date tree. */
export function findCodexRollout(home: string, threadId: string): string | undefined {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(threadId)) return undefined;
  const root = join(process.env.CODEX_HOME || join(home, ".codex"), "sessions");
  const suffix = `-${threadId}.jsonl`;
  const dirs = (path: string) => { try { return readdirSync(path, { withFileTypes: true }); } catch { return []; } };
  const years = dirs(root).filter(e => e.isDirectory() && /^\d{4}$/.test(e.name)).map(e => e.name).sort().reverse();
  for (const year of years) for (const month of dirs(join(root, year)).filter(e => e.isDirectory()).map(e => e.name).sort().reverse())
    for (const day of dirs(join(root, year, month)).filter(e => e.isDirectory()).map(e => e.name).sort().reverse())
      for (const entry of dirs(join(root, year, month, day)))
        if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) return join(root, year, month, day, entry.name);
  return undefined;
}

/** The folder that holds a primary transcript's subagent transcripts: the path without `.jsonl`, then `subagents`. */
export function secondaryFolder(primary: string): string {
  return join(primary.replace(/\.jsonl$/, ""), "subagents");
}

/** The subagent folder of `primary`, when its real path is the derived path: no link in the folder or its parents. */
function realSecondaryFolder(primary: string): string | undefined {
  try {
    const folder = join(realpathSync(dirname(primary)), basename(primary).replace(/\.jsonl$/, ""), "subagents");
    return realpathSync(folder) === folder ? folder : undefined;
  } catch {
    return undefined;
  }
}

/** A listing and the identity of each listed file, which the open must match. The identities are sent as `id`. */
interface Scan {
  folder: string;
  listing: SecondaryListing;
  ids: Map<string, string>;
}

function scanSecondaries(primary: string): Scan | undefined {
  const folder = realSecondaryFolder(primary);
  if (!folder) return undefined;
  try {
    const names = readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isFile() && SECONDARY_NAME.test(entry.name))
      .map(entry => entry.name)
      .sort();
    const files: SecondaryListing["files"] = [];
    const ids = new Map<string, string>();
    for (const name of names.slice(0, MAX_SECONDARY_FILES)) {
      try {
        // Bigint stats keep large inode numbers exact.
        const info = lstatSync(join(folder, name), { bigint: true });
        const id = `${info.dev}:${info.ino}`;
        if (!info.isFile() || !SECONDARY_ID.test(id)) continue;
        files.push({ name, size: Number(info.size), id });
        ids.set(name, id);
      } catch { /* A file that cannot be stat'd stays in the total and is not listed. */ }
    }
    return { folder, listing: { files, total: names.length }, ids };
  } catch {
    return undefined;
  }
}

/** The secondary transcripts beside `primary`. Never throws. */
export function listSecondaries(primary: string): SecondaryListing {
  return scanSecondaries(primary)?.listing ?? { files: [], total: 0 };
}

/** Where a stream reads. A secondary carries its name and the `id` its listing gave. */
interface Source {
  file: string;
  secondary?: string;
  id?: string;
}

/**
 * Streams one transcript from `after` until the worker stops asking or the pass budget is spent. The primary
 * (no `secondary`) and each secondary run this loop. `endFields` adds fields to the end mark, after the size check.
 * Returns the reply to the end mark, when one was sent.
 */
async function stream(
  options: RelayOptions,
  path: string,
  source: Source,
  after: number,
  drain: number | undefined,
  budget: { left: number },
  endFields?: () => Record<string, unknown>,
): Promise<Record<string, unknown> | null | undefined> {
  const file = source.file;
  if (!file.endsWith(".jsonl")) return undefined;
  let fd: number;
  try { fd = openSync(file, STREAM_FLAGS); } catch { return undefined; }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return undefined;
    // A file replaced after the listing has another identity, and is never read.
    if (source.id !== undefined && `${opened.dev}:${opened.ino}` !== source.id) return undefined;
    const buffer = Buffer.alloc(CHUNK);
    const echo = drain === undefined ? {} : { drain };
    const target = source.secondary === undefined ? { path } : { path, secondary: source.secondary };
    let offset = after;
    while (budget.left > 0) {
      budget.left--;
      // A fresh size on every pass. The end mark is sent only when the acknowledged cursor is at that size.
      const size = fstatSync(fd).size;
      if (offset >= size) {
        if (offset !== size) return undefined;
        return await post(options, "transcript", JSON.stringify({ ...target, offset, end: true, ...echo, ...endFields?.() }));
      }
      const length = readSync(fd, buffer, 0, Math.min(CHUNK, size - offset), offset);
      if (!length) return undefined;
      // Chunks end on a UTF-8 boundary so the worker can decode each one on its own.
      let end = length, lead = length - 1, trailing = 0;
      while (lead >= 0 && trailing < 3 && (buffer[lead] & 0xc0) === 0x80) { lead--; trailing++; }
      if (lead >= 0 && buffer[lead] & 0x80) {
        const needed = (buffer[lead] & 0xf0) === 0xf0 ? 4 : (buffer[lead] & 0xe0) === 0xe0 ? 3 : 2;
        if (trailing + 1 < needed) end = lead;
      }
      if (end <= 0) end = length;
      const text = buffer.toString("utf8", 0, end);
      // A chunk never carries the end flag. The end mark follows only after the cursor reaches a fresh size.
      const reply = await post(options, "transcript", JSON.stringify({ ...target, offset, text, ...echo }));
      const next = typeof reply?.after === "number" ? reply.after : undefined;
      // The worker names where it is; a mismatch resynchronizes, a repeat stops the loop.
      if (next === undefined || next === offset) return undefined;
      offset = next;
    }
    return undefined;
  } finally { closeSync(fd); }
}

/**
 * Streams the secondaries the worker asked for, in the reply's order. Only names in the listing just sent are
 * opened. A failed file ends that file alone, and the shared budget bounds the whole run.
 */
async function streamWanted(
  options: RelayOptions,
  path: string,
  scan: Scan,
  reply: unknown,
  drain: number | undefined,
  budget: { left: number },
) {
  if (!Array.isArray(reply)) return;
  const streamed = new Set<string>();
  for (const item of reply.slice(0, MAX_SECONDARY_FILES)) {
    if (budget.left <= 0) return;
    const { name, after } = (item ?? {}) as { name?: unknown; after?: unknown };
    // Only a name the listing gave is opened, and a name that repeats is streamed once.
    if (typeof name !== "string" || !scan.ids.has(name) || streamed.has(name) || typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) continue;
    streamed.add(name);
    const source: Source = { file: join(scan.folder, name), secondary: name, id: scan.ids.get(name) };
    try { await stream(options, path, source, after, drain, budget); } catch { /* The next wanted file still runs. */ }
  }
}

/** One hook event: forward the payload, then serve any transcript bytes the worker asks for. */
export async function relay(route: string, body: string, options: RelayOptions) {
  let payload = body;
  if (options.home && (route === "codex" || route === "codex-notify")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const id = route === "codex" ? parsed.session_id : parsed["thread-id"];
      if (typeof parsed.transcript_path !== "string" && typeof id === "string") {
        const found = findCodexRollout(options.home, id);
        if (found) payload = JSON.stringify({ ...parsed, transcript_path: found });
      }
    } catch { /* forwarded as received */ }
  }
  const reply = await post(options, route, payload);
  const wanted = reply?.transcript;
  if (wanted && typeof wanted === "object" && typeof (wanted as { path?: unknown }).path === "string" &&
      Number.isSafeInteger((wanted as { after?: unknown }).after) && (wanted as { after: number }).after >= 0) {
    const path = (wanted as { path: string }).path;
    const drain = (wanted as { drain?: unknown }).drain;
    const echo = Number.isSafeInteger(drain) ? drain as number : undefined;
    // Only a claude transcript has subagent files. The listing rides on the primary end mark, when one is sent.
    const asks = route === "claude" && (wanted as { secondaries?: unknown }).secondaries === true;
    const listed: { scan?: Scan } = {};
    const endFields = asks ? () => {
      listed.scan = scanSecondaries(path);
      return { secondaries: listed.scan?.listing ?? { files: [], total: 0 } };
    } : undefined;
    const end = await stream(options, path, { file: path }, (wanted as { after: number }).after, echo, { left: MAX_CHUNKS }, endFields);
    if (listed.scan) await streamWanted(options, path, listed.scan, end?.secondaries, echo, { left: MAX_SECONDARY_PASSES });
  }
}

const entry = process.argv[1] ?? "";
if (/hook-relay\.(?:ts|js)$/.test(entry)) {
  const route = process.argv[2] ?? "codex";
  const url = process.env.INFINITE_HOOK_URL;
  const token = process.env.INFINITE_HOOK_TOKEN;
  const deadline = setTimeout(() => process.exit(0), 4000);
  const main = async () => {
    if (!url || !token) return;
    let body = process.argv[3];
    if (!body) {
      body = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        body += chunk;
        if (body.length > 256 * 1024) return;
      }
    }
    await relay(route, body, { url, token, home: process.env.HOME });
  };
  main()
    .catch(() => {})
    .finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
}
