// Provider command hook → POST to the worker's loopback hook listener. Never prints, always
// exits 0, so nothing it does can become a hook decision for the provider.
//
// The relay runs inside the agent's account, so it is the only Infinite process that can read
// the provider's transcript. When the worker's reply asks for the transcript, the relay streams
// the file from the worker's byte cursor in bounded chunks until the worker has caught up.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

const CHUNK = 192 * 1024;
const MAX_CHUNKS = 64;

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

/** Streams `path` from `after` until the worker stops asking or the chunk budget is spent. */
async function stream(options: RelayOptions, path: string, after: number) {
  if (!path.endsWith(".jsonl")) return;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return; }
  try {
    if (!fstatSync(fd).isFile()) return;
    const buffer = Buffer.alloc(CHUNK);
    let offset = after;
    for (let chunks = 0; chunks < MAX_CHUNKS; chunks++) {
      const size = fstatSync(fd).size;
      if (offset >= size) return;
      const length = readSync(fd, buffer, 0, Math.min(CHUNK, size - offset), offset);
      if (!length) return;
      // Chunks end on a UTF-8 boundary so the worker can decode each one on its own.
      let end = length, lead = length - 1, trailing = 0;
      while (lead >= 0 && trailing < 3 && (buffer[lead] & 0xc0) === 0x80) { lead--; trailing++; }
      if (lead >= 0 && buffer[lead] & 0x80) {
        const needed = (buffer[lead] & 0xf0) === 0xf0 ? 4 : (buffer[lead] & 0xe0) === 0xe0 ? 3 : 2;
        if (trailing + 1 < needed) end = lead;
      }
      if (end <= 0) end = length;
      const text = buffer.toString("utf8", 0, end);
      const reply = await post(options, "transcript", JSON.stringify({ path, offset, text }));
      const next = typeof reply?.after === "number" ? reply.after : undefined;
      // The worker names where it is; a mismatch resynchronizes, a repeat stops the loop.
      if (next === undefined || next === offset) return;
      offset = next;
    }
  } finally { closeSync(fd); }
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
      Number.isSafeInteger((wanted as { after?: unknown }).after) && (wanted as { after: number }).after >= 0)
    await stream(options, (wanted as { path: string }).path, (wanted as { after: number }).after);
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
