import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FINAL_DRAIN_MS } from "./final-drain.js";
import { MAX_SECONDARY_FILES, MAX_SECONDARY_PASSES, SECONDARY_ID, SECONDARY_NAME, type SecondaryListing } from "./transcript-secondary.js";

const CHUNK = 192 * 1024;
const MAX_CHUNKS = 64;
const STREAM_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface RelayOptions {
  url: string;
  token: string;
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

export function secondaryFolder(primary: string): string {
  return join(primary.replace(/\.jsonl$/, ""), "subagents");
}

function realSecondaryFolder(primary: string): string | undefined {
  try {
    const folder = join(realpathSync(dirname(primary)), basename(primary).replace(/\.jsonl$/, ""), "subagents");
    return realpathSync(folder) === folder ? folder : undefined;
  } catch {
    return undefined;
  }
}

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
        const info = lstatSync(join(folder, name), { bigint: true });
        const id = `${info.dev}:${info.ino}`;
        if (!info.isFile() || !SECONDARY_ID.test(id)) continue;
        files.push({ name, size: Number(info.size), id });
        ids.set(name, id);
      } catch {}
    }
    return { folder, listing: { files, total: names.length }, ids };
  } catch {
    return undefined;
  }
}

export function listSecondaries(primary: string): SecondaryListing {
  return scanSecondaries(primary)?.listing ?? { files: [], total: 0 };
}

interface Source {
  file: string;
  secondary?: string;
  id?: string;
}

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
    if (source.id !== undefined && `${opened.dev}:${opened.ino}` !== source.id) return undefined;
    const buffer = Buffer.alloc(CHUNK);
    const echo = drain === undefined ? {} : { drain };
    const target = source.secondary === undefined ? { path } : { path, secondary: source.secondary };
    let offset = after;
    while (budget.left > 0) {
      budget.left--;
      const size = fstatSync(fd).size;
      if (offset >= size) {
        if (offset !== size) return undefined;
        return await post(options, "transcript", JSON.stringify({ ...target, offset, end: true, ...echo, ...endFields?.() }));
      }
      const length = readSync(fd, buffer, 0, Math.min(CHUNK, size - offset), offset);
      if (!length) return undefined;
      let end = length, lead = length - 1, trailing = 0;
      while (lead >= 0 && trailing < 3 && (buffer[lead] & 0xc0) === 0x80) { lead--; trailing++; }
      if (lead >= 0 && buffer[lead] & 0x80) {
        const needed = (buffer[lead] & 0xf0) === 0xf0 ? 4 : (buffer[lead] & 0xe0) === 0xe0 ? 3 : 2;
        if (trailing + 1 < needed) end = lead;
      }
      if (end <= 0) end = length;
      const text = buffer.toString("utf8", 0, end);
      const reply = await post(options, "transcript", JSON.stringify({ ...target, offset, text, ...echo }));
      const next = typeof reply?.after === "number" ? reply.after : undefined;
      if (next === undefined || next === offset) return undefined;
      offset = next;
    }
    return undefined;
  } finally { closeSync(fd); }
}

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
    if (typeof name !== "string" || !scan.ids.has(name) || streamed.has(name) || typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) continue;
    streamed.add(name);
    const source: Source = { file: join(scan.folder, name), secondary: name, id: scan.ids.get(name) };
    try { await stream(options, path, source, after, drain, budget); } catch {}
  }
}

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
    } catch {}
  }
  const reply = await post(options, route, payload);
  await serve(options, reply?.transcript, route === "claude");
}

async function serve(options: RelayOptions, wanted: unknown, secondariesAllowed: boolean) {
  if (wanted && typeof wanted === "object" && typeof (wanted as { path?: unknown }).path === "string" &&
      Number.isSafeInteger((wanted as { after?: unknown }).after) && (wanted as { after: number }).after >= 0) {
    const path = (wanted as { path: string }).path;
    const drain = (wanted as { drain?: unknown }).drain;
    const echo = Number.isSafeInteger(drain) ? drain as number : undefined;
    const asks = secondariesAllowed && (wanted as { secondaries?: unknown }).secondaries === true;
    const listed: { scan?: Scan } = {};
    const endFields = asks ? () => {
      listed.scan = scanSecondaries(path);
      return { secondaries: listed.scan?.listing ?? { files: [], total: 0 } };
    } : undefined;
    const end = await stream(options, path, { file: path }, (wanted as { after: number }).after, echo, { left: MAX_CHUNKS }, endFields);
    if (listed.scan) await streamWanted(options, path, listed.scan, end?.secondaries, echo, { left: MAX_SECONDARY_PASSES });
  }
}

export async function drain(options: RelayOptions): Promise<void> {
  const reply = await post(options, "drain", "{}");
  await serve(options, reply?.transcript, true);
}

const entry = process.argv[1] ?? "";
if (/hook-relay\.(?:ts|js)$/.test(entry)) {
  const route = process.argv[2] ?? "codex";
  const url = process.env.INFINITE_HOOK_URL;
  const token = process.env.INFINITE_HOOK_TOKEN;
  const deadline = setTimeout(() => process.exit(0), route === "drain" ? FINAL_DRAIN_MS : 4000);
  const main = async () => {
    if (!url || !token) return;
    if (route === "drain") return drain({ url, token });
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
