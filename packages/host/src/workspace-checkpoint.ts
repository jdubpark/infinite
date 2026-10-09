import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, open, opendir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, posix, resolve } from "node:path";
import { createWorkspaceWatch, type WorkspaceWatch } from "./workspace-watch.js";

const CHUNK_BYTES = 256 * 1024;
const MAX_ENTRIES = 500000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const execute = promisify(execFile);
const verifiedBlobs = new Map<string, string>();
function rememberBlob(path: string, signature: string) {
  if (verifiedBlobs.size >= 100000) verifiedBlobs.clear();
  verifiedBlobs.set(path, signature);
}

type EntryKind = "file" | "directory" | "symlink";
export interface WorkspaceEntry {
  root: number;
  path: string;
  kind: EntryKind;
  mode: number;
  size?: number;
  chunks?: string[];
  target?: string;
  /** Opaque local stat signature for incremental source reads, not content proof. */
  sourceStamp?: string;
}
export interface WorkspaceManifest {
  version: 1;
  id: string;
  capturedAt: string;
  captureStartedAt: string;
  cwd: { root: number; path: string };
  roots: string[];
  entries: WorkspaceEntry[];
}
export class WorkspaceCaptureChangedError extends Error {
  readonly code = "workspace-changed";
  readonly retryable = true;
  constructor() { super("Workspace changed during capture; retry preparation"); this.name = "WorkspaceCaptureChangedError"; }
}
function changed(): never { throw new WorkspaceCaptureChangedError(); }
function sha(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function inside(root: string, path: string) { return path === root || path.startsWith(root === "/" ? "/" : `${root}/`); }
function key(root: number, path: string) { return `${root}:${path}`; }
function relativePath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && !value.includes("\\") &&
    (value === "" || (!posix.isAbsolute(value) && posix.normalize(value) === value && value !== "." && value !== ".." && !value.startsWith("../")));
}
function absolutePath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && !value.includes("\\") && posix.isAbsolute(value) && posix.normalize(value) === value && (value === "/" || !value.endsWith("/"));
}
function sourcePath(roots: string[], entry: Pick<WorkspaceEntry, "root" | "path">) { return posix.join(roots[entry.root], entry.path); }
function manifestId(value: Omit<WorkspaceManifest, "id">) { return sha(JSON.stringify(value)); }
function stamp(info: BigIntStats) {
  return sha([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.nlink].join(":"));
}
function abort(signal?: AbortSignal) { signal?.throwIfAborted(); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function invalid(): never { throw new Error("Invalid workspace manifest"); }

/* Resolve link chains using only the complete manifest, including intermediate
 * links before '..'. Unknown paths outside the selected roots are never followed.
 */
function checkLinks(roots: string[], entries: WorkspaceEntry[]) {
  const byPath = new Map<string, WorkspaceEntry>();
  const destinations = new Map<string, string>();
  for (const entry of entries) {
    const path = sourcePath(roots, entry), previous = byPath.get(path);
    if (previous && JSON.stringify({ ...previous, root: 0, path: "" }) !== JSON.stringify({ ...entry, root: 0, path: "" })) invalid();
    byPath.set(path, entry);
  }
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    const start = entry.target!.startsWith("/") ? entry.target! : `${posix.dirname(sourcePath(roots, entry))}/${entry.target}`;
    let todo = start.split("/"), parts: string[] = [], links = 0;
    while (todo.length) {
      const part = todo.shift()!;
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) throw new Error("Workspace symlink traverses above the filesystem root");
        parts.pop(); continue;
      }
      parts.push(part);
      const path = `/${parts.join("/")}`;
      if (!roots.some(root => inside(root, path) || inside(path, root))) throw new Error("Workspace symlink escapes selected roots");
      const target = byPath.get(path);
      if (target?.kind === "symlink") {
        if (++links > 40) throw new Error("Workspace symlink cycle is unsupported");
        parts.pop();
        if (target.target!.startsWith("/")) parts = [];
        todo = [...target.target!.split("/"), ...todo];
      }
    }
    if (!roots.some(root => inside(root, `/${parts.join("/")}`))) throw new Error("Workspace symlink escapes selected roots");
    destinations.set(sourcePath(roots, entry), `/${parts.join("/")}`);
  }
  return destinations;
}

/** Validate and normalize before using any paths or allocating destination files. */
export function validateWorkspaceManifest(value: unknown, expectedRoots?: string[]): WorkspaceManifest {
  if (!record(value) || value.version !== 1 || typeof value.id !== "string" || !HASH.test(value.id) ||
      !Array.isArray(value.roots) || value.roots.length < 1 || value.roots.length > 64 || !value.roots.every(absolutePath) ||
      new Set(value.roots).size !== value.roots.length || !record(value.cwd) || !Number.isInteger(value.cwd.root) ||
      !relativePath(value.cwd.path) || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES ||
      typeof value.capturedAt !== "string" || typeof value.captureStartedAt !== "string" ||
      !Number.isFinite(Date.parse(value.capturedAt)) || !Number.isFinite(Date.parse(value.captureStartedAt)) ||
      Date.parse(value.captureStartedAt) > Date.parse(value.capturedAt)) invalid();
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MANIFEST_BYTES) invalid();
  const roots = value.roots as string[], cwdRoot = value.cwd.root as number;
  if (cwdRoot < 0 || cwdRoot >= roots.length || (expectedRoots && JSON.stringify(roots) !== JSON.stringify(expectedRoots))) invalid();
  const entries: WorkspaceEntry[] = [], byKey = new Map<string, WorkspaceEntry>();
  for (const raw of value.entries) {
    if (!record(raw) || !Number.isInteger(raw.root) || (raw.root as number) < 0 || (raw.root as number) >= roots.length ||
        !relativePath(raw.path) || !Number.isInteger(raw.mode) || (raw.mode as number) < 0 || (raw.mode as number) > 0o777 ||
        (raw.sourceStamp !== undefined && (typeof raw.sourceStamp !== "string" || !HASH.test(raw.sourceStamp)))) invalid();
    const entry: WorkspaceEntry = { root: raw.root as number, path: raw.path, kind: raw.kind as EntryKind, mode: raw.mode as number };
    if (entry.kind === "file") {
      if (!Number.isSafeInteger(raw.size) || (raw.size as number) < 0 || !Array.isArray(raw.chunks) ||
          raw.chunks.length !== Math.ceil((raw.size as number) / CHUNK_BYTES) ||
          !raw.chunks.every(hash => typeof hash === "string" && HASH.test(hash)) || raw.target !== undefined) invalid();
      if (posix.basename(entry.path) === ".git") throw new Error("External Git worktree metadata is unsupported");
      entry.size = raw.size as number; entry.chunks = [...raw.chunks] as string[];
      if (raw.sourceStamp !== undefined) entry.sourceStamp = raw.sourceStamp as string;
    } else if (entry.kind === "symlink") {
      if (typeof raw.target !== "string" || !raw.target || raw.target.includes("\0") || raw.target.includes("\\") ||
          raw.size !== undefined || raw.chunks !== undefined || raw.sourceStamp !== undefined) invalid();
      entry.target = raw.target;
    } else if (entry.kind !== "directory" || raw.size !== undefined || raw.chunks !== undefined || raw.target !== undefined || raw.sourceStamp !== undefined) invalid();
    if (!entry.path && entry.kind !== "directory") invalid();
    const id = key(entry.root, entry.path);
    if (byKey.has(id)) invalid();
    byKey.set(id, entry); entries.push(entry);
  }
  for (let root = 0; root < roots.length; root++) if (byKey.get(key(root, ""))?.kind !== "directory") invalid();
  for (const entry of entries) {
    if (entry.path && byKey.get(key(entry.root, posix.dirname(entry.path) === "." ? "" : posix.dirname(entry.path)))?.kind !== "directory") invalid();
  }
  if (byKey.get(key(cwdRoot, value.cwd.path))?.kind !== "directory") invalid();
  const body: Omit<WorkspaceManifest, "id"> = {
    version: 1, capturedAt: value.capturedAt, captureStartedAt: value.captureStartedAt,
    cwd: { root: cwdRoot, path: value.cwd.path }, roots: [...roots], entries,
  };
  if (manifestId(body) !== value.id) invalid();
  checkLinks(roots, entries);
  return { ...body, id: value.id };
}

type Store = { root: string; blobs: string; shards: Set<string> };
async function privateDirectory(path: string) {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Workspace storage must be a private owner-controlled directory");
  if (created) {
    let current = resolve(path);
    for (;;) {
      await syncDirectory(current);
      if (current === resolve(created)) break;
      current = dirname(current);
    }
    await syncDirectory(dirname(resolve(created)));
  }
}
async function storeAt(path: string): Promise<Store> {
  await privateDirectory(path);
  const root = await realpath(path), blobs = join(root, "blobs");
  await privateDirectory(blobs);
  return { root, blobs, shards: new Set() };
}
async function blobPath(store: Store, hash: string) {
  if (!HASH.test(hash)) throw new Error("Invalid workspace blob hash");
  return join(store.blobs, hash.slice(0, 2), hash);
}
async function readBlob(store: Store, hash: string): Promise<Buffer> {
  const file = await blobPath(store, hash);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > BigInt(CHUNK_BYTES) || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) || info.nlink !== 1n) throw new Error("Unsafe workspace blob");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const data = buffer.subarray(0, size);
    if (BigInt(data.length) !== info.size || data.length > CHUNK_BYTES || sha(data) !== hash ||
        stamp(await handle.stat({ bigint: true })) !== stamp(info)) throw new Error("Corrupt workspace blob");
    rememberBlob(file, stamp(info));
    return data;
  } finally { await handle.close(); }
}
async function verifyBlob(store: Store, hash: string) {
  const file = await blobPath(store, hash), info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.size > BigInt(CHUNK_BYTES) || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) || info.nlink !== 1n) throw new Error("Unsafe workspace blob");
  if (verifiedBlobs.get(file) === stamp(info)) return;
  await readBlob(store, hash);
}
async function syncDirectory(path: string) { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } }
async function writeBlob(store: Store, hash: string, bytes: Buffer) {
  if (bytes.length > CHUNK_BYTES || !HASH.test(hash) || sha(bytes) !== hash) throw new Error("Invalid workspace blob content");
  const file = await blobPath(store, hash), shard = dirname(file);
  if (!store.shards.has(shard)) { await privateDirectory(shard); store.shards.add(shard); }
  try { await verifyBlob(store, hash); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof Error && error.message === "Corrupt workspace blob")) throw error;
  }
  const temporary = join(shard, `.${hash}-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file); await syncDirectory(shard); await syncDirectory(store.blobs); await syncDirectory(store.root);
    rememberBlob(file, stamp(await lstat(file, { bigint: true })));
  } finally { await rm(temporary, { force: true }); }
}
export async function putWorkspaceBlob(storeDir: string, hash: string, base64: string): Promise<void> {
  if (typeof base64 !== "string" || base64.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw new Error("Workspace blob exceeds the chunk bound");
  const data = Buffer.from(base64, "base64");
  if (data.toString("base64") !== base64 || data.length > CHUNK_BYTES) throw new Error("Invalid workspace blob encoding");
  await writeBlob(await storeAt(storeDir), hash, data);
}
export async function readWorkspaceBlob(storeDir: string, hash: string): Promise<string> { return (await readBlob(await storeAt(storeDir), hash)).toString("base64"); }
export async function hasWorkspaceBlobs(storeDir: string, hashes: string[]): Promise<string[]> {
  if (!Array.isArray(hashes) || hashes.length > MAX_ENTRIES || hashes.some(hash => typeof hash !== "string" || !HASH.test(hash))) throw new Error("Invalid workspace blob request");
  const store = await storeAt(storeDir), missing: string[] = [];
  for (const hash of new Set(hashes)) {
    try { await verifyBlob(store, hash); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof Error && error.message === "Corrupt workspace blob")) missing.push(hash);
      else throw error;
    }
  }
  return missing;
}

async function futurePath(path: string): Promise<string> {
  let cursor = resolve(path); const suffix: string[] = [];
  for (;;) {
    try { return join(await realpath(cursor), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(cursor) === cursor) throw error;
      suffix.push(posix.basename(cursor)); cursor = dirname(cursor);
    }
  }
}
async function openDirectory(path: string) { return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }

/** Full selected scope, per-file stable reads and a verified metadata pass.
 * This records an observation span, not an atomic filesystem snapshot. Shared
 * writable mappings may escape change notifications and metadata comparisons.
 */
export async function captureWorkspace(options: {
  roots: string[]; cwd: string; storeDir: string; signal?: AbortSignal;
  previous?: WorkspaceManifest; forceFull?: boolean;
}): Promise<WorkspaceManifest> {
  abort(options.signal);
  if (!options.roots.length || options.roots.length > 64) throw new Error("Invalid workspace roots");
  const roots = await Promise.all(options.roots.map(root => realpath(root))), cwd = await realpath(options.cwd);
  if (new Set(roots).size !== roots.length) throw new Error("Duplicate workspace roots");
  const canonicalStore = await futurePath(options.storeDir);
  if (roots.some(root => inside(root, canonicalStore))) throw new Error("Workspace storage must be outside all selected roots");
  const cwdRoot = roots.map((root, index) => ({ root, index })).filter(item => inside(item.root, cwd)).sort((a, b) => b.root.length - a.root.length)[0];
  if (!cwdRoot) throw new Error("Workspace cwd is outside the selected roots");
  const store = await storeAt(options.storeDir), handles: FileHandle[] = [];
  const gitProjections = new Map<string, { common: string; selected: string; pointerStamp: string }>();
  const gitLocation = async (root: string) => {
    const { stdout } = await execute("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
      timeout: 10000, maxBuffer: 65536, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, signal: options.signal,
    });
    const paths = stdout.trim().split("\n");
    if (paths.length !== 2 || paths.some(path => !posix.isAbsolute(path))) throw new Error("Unsupported Git metadata location");
    return Promise.all(paths.map(path => realpath(path)));
  };
  for (const root of roots) {
    try {
      const info = await lstat(join(root, ".git"), { bigint: true });
      if (!info.isFile()) continue;
      const [selected, common] = await gitLocation(root);
      if ([selected, common].some(path => inside(path, canonicalStore))) throw new Error("Workspace storage must be outside Git metadata");
      gitProjections.set(join(root, ".git"), { common, selected, pointerStamp: stamp(info) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let watch: WorkspaceWatch | undefined;
  const entries: WorkspaceEntry[] = [], observed = new Map<string, string>(), written = new Set<string>();
  const virtualDirectories = new Set<string>();
  const previous = options.previous && !options.forceFull ? validateWorkspaceManifest(options.previous, roots) : undefined;
  const prior = new Map(previous?.entries.map(entry => [key(entry.root, entry.path), entry]));
  let manifestBytes = 1024;
  const add = (entry: WorkspaceEntry) => {
    if (entry.kind === "directory") {
      const id = key(entry.root, entry.path);
      if (virtualDirectories.has(id)) return;
      virtualDirectories.add(id);
    }
    manifestBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (entries.length >= MAX_ENTRIES || manifestBytes > MAX_MANIFEST_BYTES) throw new Error("Workspace manifest exceeds its size bound");
    entries.push(entry);
  };
  async function chunks(path: string, info: BigIntStats): Promise<string[]> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile() || stamp(await handle.stat({ bigint: true })) !== stamp(info)) changed();
      const result: string[] = [], buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let total = 0;
      for (;;) {
        abort(options.signal);
        let length = 0;
        while (length < CHUNK_BYTES) {
          const next = await handle.read(buffer, length, CHUNK_BYTES - length, null);
          if (next.bytesRead === 0) break;
          length += next.bytesRead;
        }
        if (!length) break;
        total += length;
        if (!Number.isSafeInteger(total) || result.length * 67 > MAX_MANIFEST_BYTES) throw new Error("Workspace file exceeds the manifest size bound");
        const bytes = buffer.subarray(0, length), hash = sha(bytes);
        if (!written.has(hash)) { await writeBlob(store, hash, bytes); written.add(hash); }
        result.push(hash);
        if (length < CHUNK_BYTES) break;
      }
      if (BigInt(total) !== info.size || stamp(await handle.stat({ bigint: true })) !== stamp(info)) changed();
      return result;
    } finally { await handle.close(); }
  }
  async function projectedFile(file: string, logical: string, info: BigIntStats, kind: "config" | "alternates") {
    const temporary = join(store.root, `.git-capture-${randomUUID()}`);
    try {
      await copyFile(file, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o600);
      if (kind === "config") {
        try { await execute("git", ["config", "--file", temporary, "--no-includes", "--unset-all", "core.worktree"], { timeout: 10000, maxBuffer: 65536, signal: options.signal }); }
        catch (error) { if ((error as { code?: unknown }).code !== 5) throw new Error("Git worktree configuration could not be projected"); }
        await execute("git", ["config", "--file", temporary, "--no-includes", "core.bare", "false"], { timeout: 10000, maxBuffer: 65536, signal: options.signal });
      } else {
        const lines = (await readFile(temporary, "utf8")).split("\n").filter(Boolean), mapped: string[] = [];
        for (const line of lines) {
          if (line.startsWith('"')) throw new Error("Quoted Git alternate object paths are unsupported");
          const target = await realpath(resolve(dirname(dirname(file)), line));
          if (!roots.some(root => inside(root, target))) throw new Error("Git alternate objects are outside the selected roots");
          mapped.push(posix.relative(posix.dirname(posix.dirname(logical)), target));
        }
        await writeFile(temporary, `${mapped.join("\n")}\n`);
      }
      const transformed = await lstat(temporary, { bigint: true }), hashes = await chunks(temporary, transformed);
      if (stamp(await lstat(file, { bigint: true })) !== stamp(info)) changed();
      return { hashes, size: Number(transformed.size) };
    } finally { await rm(temporary, { force: true }); }
  }
  async function reusable(entry: WorkspaceEntry | undefined, signature: string): Promise<boolean> {
    if (entry?.kind !== "file" || entry.sourceStamp !== signature) return false;
    for (const hash of new Set(entry.chunks!)) {
      try { await verifyBlob(store, hash); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof Error && error.message === "Corrupt workspace blob")) return false;
        throw error;
      }
    }
    return true;
  }
  async function walk(root: number, handle: FileHandle, path: string, verify: boolean, seen?: Set<string>, physical?: string,
    allow?: (path: string) => boolean, projectGit = false): Promise<void> {
    abort(options.signal);
    const info = await handle.stat({ bigint: true });
    const directoryPath = physical ?? sourcePath(roots, { root, path }), id = key(root, directoryPath);
    if (await realpath(directoryPath) !== directoryPath || stamp(await lstat(directoryPath, { bigint: true })) !== stamp(info)) changed();
    if (verify) { if (observed.get(id) !== stamp(info)) changed(); seen!.add(id); }
    else { observed.set(id, stamp(info)); add({ root, path, kind: "directory", mode: Number(info.mode & 0o777n) }); }
    const directory = await opendir(directoryPath);
    for await (const child of directory) {
      abort(options.signal);
      const childPath = path ? `${path}/${child.name}` : child.name;
      if (!relativePath(childPath)) throw new Error("Unsupported workspace filename");
      const file = join(directoryPath, child.name), childInfo = await lstat(file, { bigint: true });
      if (await realpath(directoryPath) !== directoryPath || stamp(await lstat(directoryPath, { bigint: true })) !== stamp(info)) changed();
      if ((projectGit || childPath.split("/").includes(".git")) && child.name.endsWith(".lock")) changed();
      if (allow && !allow(childPath)) continue;
      if (childInfo.isDirectory()) {
        const next = await openDirectory(file);
        try { if (stamp(await next.stat({ bigint: true })) !== stamp(childInfo)) changed(); await walk(root, next, childPath, verify, seen, file, allow, projectGit); }
        finally { await next.close(); }
        continue;
      }
      const childId = key(root, file), signature = stamp(childInfo);
      if (verify) {
        if (observed.get(childId) !== signature) changed();
        seen!.add(childId);
      } else observed.set(childId, signature);
      const projection = gitProjections.get(file);
      if (childInfo.isFile() && child.name === ".git" && projection) {
        if (signature !== projection.pointerStamp) changed();
        const commonAllow = (virtual: string) => {
          const relative = virtual.slice(childPath.length + 1), top = relative.split("/")[0];
          if (top === "logs") return relative === "logs" || relative === "logs/refs" || relative.startsWith("logs/refs/");
          if (top === "refs" && /^refs\/(bisect|rewritten|worktree)(\/|$)/.test(relative)) return false;
          return ["objects", "refs", "info", "config", "packed-refs", "shallow", "description"].includes(top);
        };
        const selectedAllow = (virtual: string) => {
          const top = virtual.slice(childPath.length + 1).split("/")[0];
          return ["HEAD", "index", "ORIG_HEAD", "FETCH_HEAD", "AUTO_MERGE", "SQUASH_MSG", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-apply", "rebase-merge", "sequencer", "logs", "refs", "config.worktree"].includes(top) || /^(MERGE_|BISECT_)/.test(top);
        };
        for (const [source, filter] of [[projection.common, commonAllow], [projection.selected, selectedAllow]] as const) {
          const metadata = await openDirectory(source);
          try { await walk(root, metadata, childPath, verify, seen, source, filter, true); }
          finally { await metadata.close(); }
        }
        const pointer = join(projection.selected, "commondir");
        try {
          const pointerStamp = stamp(await lstat(pointer, { bigint: true })), pointerId = key(root, pointer);
          if (verify) { if (observed.get(pointerId) !== pointerStamp) changed(); seen!.add(pointerId); }
          else observed.set(pointerId, pointerStamp);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        continue;
      }
      if (verify) continue;
      if (childInfo.isFile()) {
        if (child.name === ".git") throw new Error("External Git worktree metadata is unsupported");
        if (childInfo.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Workspace file size is unsupported");
        const transform = projectGit && (childPath.endsWith("/config") || childPath.endsWith("/config.worktree")) ? "config" :
          childPath.endsWith("/.git/objects/info/alternates") || childPath === ".git/objects/info/alternates" ? "alternates" : undefined;
        if (childPath.endsWith("/.git/objects/info/http-alternates") || childPath === ".git/objects/info/http-alternates") throw new Error("Remote Git alternate objects are unsupported");
        const sourceStamp = transform ? sha(`git-projection-v1:${transform}:${signature}`) : signature;
        const old = prior.get(key(root, childPath));
        let hashes: string[], size = Number(childInfo.size);
        if (await reusable(old, sourceStamp)) { hashes = [...old!.chunks!]; size = old!.size!; }
        else if (transform) ({ hashes, size } = await projectedFile(file, sourcePath(roots, { root, path: childPath }), childInfo, transform));
        else hashes = await chunks(file, childInfo);
        add({ root, path: childPath, kind: "file", mode: Number(childInfo.mode & 0o777n), size, chunks: hashes, sourceStamp });
      } else if (childInfo.isSymbolicLink()) {
        add({ root, path: childPath, kind: "symlink", mode: Number(childInfo.mode & 0o777n), target: await readlink(file) });
      } else throw new Error("Workspace contains an unsupported special file");
    }
  }
  let captureStartedAt = new Date().toISOString();
  try {
    for (const root of roots) handles.push(await openDirectory(root));
    if (process.platform === "darwin") {
      const watched = [...new Set([...roots, ...[...gitProjections.values()].flatMap(item => [item.common, item.selected])])];
      try { watch = await createWorkspaceWatch(watched, join(store.root, "watch-cache")); }
      catch { abort(options.signal); /* Optional detector; metadata verification still applies. */ }
    }
    const before = watch ? await watch.flush() : undefined;
    if (before && !before.valid) changed();
    captureStartedAt = new Date().toISOString();
    for (let root = 0; root < roots.length; root++) await walk(root, handles[root], "", false);
    const seen = new Set<string>();
    for (let root = 0; root < roots.length; root++) {
      if (stamp(await lstat(roots[root], { bigint: true })) !== stamp(await handles[root].stat({ bigint: true }))) changed();
      await walk(root, handles[root], "", true, seen);
    }
    if (seen.size !== observed.size) changed();
    for (const [file, projection] of gitProjections) {
      const [selected, common] = await gitLocation(dirname(file));
      if (selected !== projection.selected || common !== projection.common) changed();
    }
    const after = watch ? await watch.flush() : undefined;
    if (after && (!after.valid || after.revision !== before!.revision)) changed();
    abort(options.signal);
    entries.sort((a, b) => a.root - b.root || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const body: Omit<WorkspaceManifest, "id"> = {
      version: 1, capturedAt: new Date().toISOString(), captureStartedAt,
      cwd: { root: cwdRoot.index, path: posix.relative(cwdRoot.root, cwd) }, roots, entries,
    };
    return validateWorkspaceManifest({ ...body, id: manifestId(body) });
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "ESTALE"].includes((error as NodeJS.ErrnoException).code ?? "")) changed();
    throw error;
  } finally {
    await watch?.close();
    await Promise.all(handles.map(handle => handle.close()));
  }
}

/** Publish a complete generation into a previously absent destination.
 * `sharedGroup` prepares shared interior permissions behind a private 02700
 * generation root. Only the coordinator may expose the chosen root at promotion.
 * `previous` MUST be a verified, inactive ready tree with no writers. Never pass
 * an active executor's tree: unchanged files may share an inode until the caller
 * removes the old ready generation. The caller owns that provenance and fence.
 */
export async function materializeWorkspace(options: {
  manifest: WorkspaceManifest; storeDir: string; destination: string; sharedGroup?: boolean;
  previous?: { manifest: WorkspaceManifest; roots: string[] };
}): Promise<{ cwd: string; roots: string[] }> {
  const manifest = validateWorkspaceManifest(options.manifest), store = await storeAt(options.storeDir);
  const previous = options.previous ? validateWorkspaceManifest(options.previous.manifest, manifest.roots) : undefined;
  const previousEntries = new Map(previous?.entries.map(entry => [key(entry.root, entry.path), entry]));
  const previousRoots = options.previous?.roots;
  if (previousRoots) {
    if (previousRoots.length !== manifest.roots.length || previousRoots.some(root => !absolutePath(root))) throw new Error("Invalid previous workspace roots");
    for (const root of previousRoots) {
      if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error("Previous workspace roots must be canonical directories");
    }
    // Retain the same source-to-destination layout, including overlapping roots.
    const offsets = previousRoots.map((root, index) => manifest.roots[index] === "/" ? root :
      root.endsWith(manifest.roots[index]) ? root.slice(0, -manifest.roots[index].length) : undefined);
    if (offsets.some(offset => offset === undefined || offset !== offsets[0])) throw new Error("Previous workspace root mapping is inconsistent");
  }
  const fileMode = (entry: WorkspaceEntry) => options.sharedGroup ? (entry.mode & 0o700) | 0o060 | ((entry.mode & 0o111) ? 0o010 : 0) : entry.mode;
  async function reuseFile(entry: WorkspaceEntry, destinationFile: string): Promise<boolean> {
    const old = previousEntries.get(key(entry.root, entry.path));
    if (!previousRoots || old?.kind !== "file" || old.size !== entry.size || old.mode !== entry.mode ||
        JSON.stringify(old.chunks) !== JSON.stringify(entry.chunks)) return false;
    const root = previousRoots[entry.root], source = join(root, entry.path);
    // Every parent must remain a directory in the inactive tree; never follow a
    // substituted symlink into another tree when creating a hardlink.
    let parent = root;
    for (const component of entry.path.split("/").slice(0, -1)) {
      parent = join(parent, component);
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    if (await realpath(parent) !== parent) return false;
    let linked = false;
    try {
      const before = await lstat(source, { bigint: true });
      if (!before.isFile() || before.size !== BigInt(entry.size!) || Number(before.mode & 0o7777n) !== fileMode(entry)) return false;
      if (options.sharedGroup && before.gid !== (await lstat(dirname(destinationFile), { bigint: true })).gid) return false;
      await link(source, destinationFile); linked = true;
      const after = await lstat(destinationFile, { bigint: true });
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
          after.mode !== before.mode || after.mtimeNs !== before.mtimeNs) throw new Error("Previous workspace changed during file reuse");
      // Do not chmod, truncate, write, or otherwise mutate the shared file.
      return true;
    } catch (error) {
      if (linked) { await rm(destinationFile, { force: true }); throw error; }
      if (["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }
  const destination = await futurePath(options.destination), parent = dirname(destination);
  if (inside(destination, store.root) || inside(store.root, destination)) throw new Error("Workspace destination must be separate from content storage");
  try { await lstat(destination); throw new Error("Workspace destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(parent, ".workspace-"));
  if (options.sharedGroup) await chmod(stage, 0o2700);
  let published = false;
  /* A shared hierarchy preserves relative links across separately selected roots. */
  const mapped = (base: string, path: string) => join(base, "workspace", path.slice(1));
  const unique = new Map<string, WorkspaceEntry>();
  for (const entry of manifest.entries) unique.set(sourcePath(manifest.roots, entry), entry);
  const paths = [...unique].sort(([a], [b]) => a.length - b.length || a.localeCompare(b));
  const linkTargets = checkLinks(manifest.roots, manifest.entries);
  const directoryModes = new Map<string, number>([[stage, options.sharedGroup ? 0o2700 : 0o700]]);
  try {
    for (const [path, entry] of paths) {
      if (entry.kind !== "directory") continue;
      await mkdir(mapped(stage, path), { recursive: true, mode: 0o700 });
      let directory = mapped(stage, path);
      directoryModes.set(directory, options.sharedGroup ? 0o2770 : entry.mode);
      while (directory !== stage) {
        directory = dirname(directory);
        if (!directoryModes.has(directory)) directoryModes.set(directory, options.sharedGroup ? 0o2770 : 0o700);
      }
    }
    for (const [path, entry] of paths) {
      const file = mapped(stage, path);
      if (entry.kind === "directory") continue;
      if (entry.kind === "symlink") {
        const target = mapped(destination, linkTargets.get(path)!);
        const rewritten = posix.relative(posix.dirname(mapped(destination, path)), target) || ".";
        await symlink(rewritten, file); continue;
      }
      if (await reuseFile(entry, file)) continue;
      const handle = await open(file, "wx", 0o600);
      try {
        let total = 0;
        for (let i = 0; i < entry.chunks!.length; i++) {
          const bytes = await readBlob(store, entry.chunks![i]);
          const expected = Math.min(CHUNK_BYTES, entry.size! - total);
          if (bytes.length !== expected) throw new Error("Workspace file chunks do not match its declared size");
          await handle.writeFile(bytes); total += bytes.length;
        }
        if (total !== entry.size) throw new Error("Workspace file is incomplete");
        await handle.chmod(fileMode(entry)); await handle.sync();
      } finally { await handle.close(); }
    }
    for (const [path, mode] of [...directoryModes].sort(([a], [b]) => b.length - a.length)) {
      const handle = await openDirectory(path);
      try { if (path !== stage) await handle.chmod(mode); await handle.sync(); }
      finally { await handle.close(); }
    }
    await rename(stage, destination); published = true;
    await syncDirectory(parent);
    const roots = manifest.roots.map(root => mapped(destination, root));
    return { roots, cwd: join(roots[manifest.cwd.root], manifest.cwd.path) };
  } finally { if (!published) await rm(stage, { recursive: true, force: true }); }
}
