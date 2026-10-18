import { constants, type Stats } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, opendir, readFile, realpath, rename, rm, statfs, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { cpus, freemem, loadavg, platform, totalmem, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./types.js";

export const DESKTOP_LIMITS = { chunkBytes: 48 * 1024, maxFileBytes: 256 * 1024 * 1024, uploads: 8, uploadTtlMs: 30 * 60 * 1000 };
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);
const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
export class DesktopError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const conflict = () => new DesktopError("file-conflict", "The file changed. Download its current version before applying this change.");
const signature = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
interface Upload {
  id: string; device: string; project: string; path: string; size: number; sha256: string; expectedHash: string | null;
  file: string; offset: number; expiresAt: number; result?: { path: string; sha256: string; totalBytes: number };
}

/** File operations stay inside explicitly configured roots. Local agents remain trusted filesystem peers. */
export class DesktopFiles {
  private uploads = new Map<string, Upload>();
  private queues = new Map<string, Promise<unknown>>();
  private hashes = new Map<string, { stamp: string; sha256: string }>();
  private ready: Promise<void>;
  private staging: string;
  private timer: ReturnType<typeof setInterval>;
  constructor(private config: Config) {
    this.staging = join(config.stateDir, "desktop-uploads");
    // Upload handles are connection-independent but intentionally do not survive an API restart.
    this.ready = mkdir(this.staging, { recursive: true, mode: 0o700 }).then(async () => {
      for await (const entry of await opendir(this.staging))
        if (/^[a-f0-9-]{36}\.part$/.test(entry.name)) await rm(join(this.staging, entry.name), { force: true });
    });
    this.timer = setInterval(() => { void this.expire().catch(() => {}); }, 60_000); this.timer.unref();
  }
  close() { clearInterval(this.timer); }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action); this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  private async expire() {
    for (const upload of this.uploads.values()) if (upload.expiresAt <= Date.now() && !this.queues.has(upload.id)) {
      this.uploads.delete(upload.id); await rm(upload.file, { force: true });
    }
  }
  private async location(projectId: string, path: string, missing = false) {
    const project = this.config.projects.find(p => p.id === projectId);
    if (!project) throw new DesktopError("unknown-project", "Unknown project", 404);
    if (path.length > 4096 || isAbsolute(path) || /[\x00-\x1f\x7f\\]/.test(path) || path.split("/").some(p => p === ".." || p === ".infinite" || p.startsWith(".infinite-desktop-")))
      throw new DesktopError("invalid-path", "Choose a relative path inside this project", 400);
    const root = await realpath(project.path), file = resolve(root, path || ".");
    if (!inside(root, file)) throw new DesktopError("invalid-path", "Path is outside this project", 403);
    // Protect host control state even if a project was accidentally configured as its ancestor.
    for (const privatePath of [this.config.stateDir, this.config.runDir, this.config.keyFile]) {
      const protectedPath = await realpath(privatePath).catch(() => resolve(privatePath));
      if (inside(protectedPath, file)) throw new DesktopError("private-path", "Host control files are unavailable", 403);
    }
    let current = root;
    const parts = relative(root, file).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const info = await lstat(current).catch(error => {
        if (missing && index === parts.length - 1 && error.code === "ENOENT") return null;
        throw error;
      });
      if (info?.isSymbolicLink()) throw new DesktopError("symlink-denied", "Symbolic links cannot be followed for file transfer", 403);
      if (index < parts.length - 1 && !info?.isDirectory()) throw new DesktopError("invalid-path", "The parent path is not a directory", 400);
    }
    return { root, file, path: relative(root, file).split(sep).join("/") };
  }
  private async read(project: string, path: string, action: (handle: FileHandle, info: Stats, sha256: string) => Promise<unknown>) {
    const location = await this.location(project, path);
    const handle = await open(location.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new DesktopError("not-file", "Choose a regular file", 400);
      if (info.size > DESKTOP_LIMITS.maxFileBytes) throw new DesktopError("file-too-large", "File transfer is limited to 256 MiB", 413);
      const stamp = signature(info), cached = this.hashes.get(location.file);
      let sha256 = cached?.stamp === stamp ? cached.sha256 : undefined;
      if (!sha256) {
        const digest = createHash("sha256"), buffer = Buffer.alloc(256 * 1024);
        let offset = 0;
        while (offset < info.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
          if (!bytesRead) throw conflict();
          digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        sha256 = digest.digest("hex");
      }
      const value = await action(handle, info, sha256);
      if (signature(await handle.stat()) !== stamp || signature(await lstat(location.file)) !== stamp) throw conflict();
      await this.location(project, path);
      if (this.hashes.size >= 128) this.hashes.delete(this.hashes.keys().next().value!);
      this.hashes.set(location.file, { stamp, sha256 });
      return value;
    } finally { await handle.close(); }
  }
  async download(project: string, path: string, offset: number, length: number, expected?: string) {
    if (offset > 0 && !expected) throw new DesktopError("file-version-required", "Pin the file hash before reading later chunks", 400);
    return this.read(project, path, async (handle, info, sha256) => {
      if (expected && expected !== sha256) throw conflict();
      if (offset > info.size) throw new DesktopError("invalid-offset", "Offset exceeds the file size", 400);
      const data = Buffer.alloc(Math.min(length, info.size - offset));
      const { bytesRead } = await handle.read(data, 0, data.length, offset);
      if (bytesRead !== data.length) throw conflict();
      return { path, sha256, totalBytes: info.size, modifiedAt: info.mtime.toISOString(), offset, base64: data.toString("base64"), nextOffset: offset + bytesRead, eof: offset + bytesRead === info.size };
    });
  }
  async list(project: string, path: string, limit: number, cursor?: string) {
    const location = await this.location(project, path);
    const entries = [];
    for await (const entry of await opendir(location.file)) {
      if (entry.name === ".infinite" || entry.name.startsWith(".infinite-desktop-")) continue;
      if (entries.length >= 10000) throw new DesktopError("directory-too-large", "This directory exceeds the 10,000-entry browsing limit", 413);
      const child = join(location.file, entry.name), info = await lstat(child);
      const childPath = relative(location.root, child).split(sep).join("/");
      try { await this.location(project, childPath); } catch (error) { if (error instanceof DesktopError && error.code === "private-path") continue; if (!info.isSymbolicLink()) throw error; }
      entries.push({ name: entry.name, path: childPath, kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, modifiedAt: info.mtime.toISOString(), transferable: info.isFile() && info.size <= DESKTOP_LIMITS.maxFileBytes });
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const version = hash(JSON.stringify(entries));
    let offset = 0;
    if (cursor) {
      let value;
      try { value = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new DesktopError("invalid-cursor", "Invalid directory cursor", 400); }
      if (value?.version !== version) throw new DesktopError("directory-changed", "This directory changed. Refresh its listing.");
      if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > entries.length) throw new DesktopError("invalid-cursor", "Invalid directory cursor", 400);
      offset = value.offset;
    }
    await this.location(project, path);
    const next = offset + limit;
    return { path: location.path, entries: entries.slice(offset, next), total: entries.length, capturedAt: new Date().toISOString(), nextCursor: next < entries.length ? Buffer.from(JSON.stringify({ version, offset: next })).toString("base64url") : null };
  }
  async begin(project: string, device: string, body: Pick<Upload, "path" | "size" | "sha256" | "expectedHash">) {
    await this.ready; await this.expire();
    await this.location(project, body.path, true);
    if (!body.path || !basename(body.path)) throw new DesktopError("invalid-path", "Choose a file path", 400);
    if ([...this.uploads.values()].filter(upload => !upload.result).length >= DESKTOP_LIMITS.uploads) throw new DesktopError("uploads-busy", "Finish or cancel an existing upload first", 429);
    // Keep recent commit receipts without letting a long-running client grow the map indefinitely.
    while (this.uploads.size >= 128) {
      const oldest = [...this.uploads.values()].find(upload => upload.result);
      if (!oldest) break;
      this.uploads.delete(oldest.id);
    }
    const id = randomUUID(), file = join(this.staging, `${id}.part`);
    const upload: Upload = { ...body, id, device, project, file, offset: 0, expiresAt: Date.now() + DESKTOP_LIMITS.uploadTtlMs };
    this.uploads.set(id, upload);
    try { const handle = await open(file, "wx", 0o600); await handle.close(); } catch (error) { this.uploads.delete(id); throw error; }
    return { uploadId: id, offset: 0, chunkBytes: DESKTOP_LIMITS.chunkBytes, expiresAt: new Date(upload.expiresAt).toISOString() };
  }
  private upload(project: string, device: string, id: string) {
    const upload = this.uploads.get(id);
    if (!upload || upload.project !== project || upload.device !== device || upload.expiresAt <= Date.now()) throw new DesktopError("upload-not-found", "This upload is unavailable or expired; begin a new upload", 404);
    return upload;
  }
  chunk(project: string, device: string, id: string, offset: number, base64: string) {
    return this.serial(id, async () => {
      const upload = this.upload(project, device, id), bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > DESKTOP_LIMITS.chunkBytes || bytes.toString("base64") !== base64) throw new DesktopError("invalid-chunk", "Send a canonical base64 chunk of at most 48 KiB", 400);
      if (upload.result || offset + bytes.length > upload.size) throw new DesktopError("invalid-offset", "Chunk exceeds the declared upload size", 409);
      const handle = await open(upload.file, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        if (offset < upload.offset && offset + bytes.length <= upload.offset) {
          const previous = Buffer.alloc(bytes.length); await handle.read(previous, 0, previous.length, offset);
          if (previous.equals(bytes)) return { uploadId: id, offset: upload.offset };
        }
        if (offset !== upload.offset) throw new DesktopError("invalid-offset", "Resume from the last confirmed upload offset", 409);
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new DesktopError("upload-write-failed", "The upload could not be stored", 409);
          written += result.bytesWritten;
        }
        await handle.sync(); upload.offset += bytes.length;
      } finally { await handle.close(); }
      return { uploadId: id, offset: upload.offset };
    });
  }
  private async currentHash(project: string, path: string): Promise<string | null> {
    try { return await this.read(project, path, async (_handle, _info, sha256) => sha256) as string; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  commit(project: string, device: string, id: string) {
    return this.serial(id, () => this.serial(`project:${project}`, async () => {
      const upload = this.upload(project, device, id);
      if (upload.result) return upload.result;
      if (upload.offset !== upload.size) throw new DesktopError("upload-incomplete", "Upload all file chunks before committing", 409);
      const digest = createHash("sha256"), staged = await open(upload.file, "r");
      try { for await (const bytes of staged.createReadStream({ autoClose: false })) digest.update(bytes); } finally { await staged.close(); }
      if (digest.digest("hex") !== upload.sha256) throw new DesktopError("hash-mismatch", "Uploaded content does not match its declared hash", 409);
      if (await this.currentHash(project, upload.path) !== upload.expectedHash) throw conflict();
      const location = await this.location(project, upload.path, true);
      const parent = await lstat(dirname(location.file));
      const temporary = join(dirname(location.file), `.infinite-desktop-${randomUUID()}`);
      try {
        await copyFile(upload.file, temporary, constants.COPYFILE_EXCL);
        const sharedGroup = this.config.sync?.sharedGroup || Boolean(parent.mode & 0o2000);
        const previousMode = upload.expectedHash ? (await lstat(location.file)).mode & 0o777 : 0o600;
        const mode = sharedGroup ? (previousMode & 0o700) | 0o060 | ((previousMode & 0o100) ? 0o010 : 0) : previousMode;
        const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          // copyFile can copy the staging inode's group. The published inode is
          // host-owned, so shared projects need the destination group and access.
          if (sharedGroup) await handle.chown(-1, parent.gid);
          await handle.chmod(mode); await handle.sync();
        } finally { await handle.close(); }
        await this.location(project, upload.path, true);
        const currentParent = await lstat(dirname(location.file));
        if (parent.dev !== currentParent.dev || parent.ino !== currentParent.ino || await this.currentHash(project, upload.path) !== upload.expectedHash) throw conflict();
        if (upload.expectedHash === null) {
          try { await link(temporary, location.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict(); throw error; }
          await unlink(temporary);
        } else await rename(temporary, location.file);
        const directory = await open(dirname(location.file), constants.O_RDONLY | constants.O_DIRECTORY); try { await directory.sync(); } finally { await directory.close(); }
        upload.result = { path: upload.path, sha256: upload.sha256, totalBytes: upload.size };
        await rm(upload.file, { force: true });
        return upload.result;
      } finally { await rm(temporary, { force: true }); }
    }));
  }
  abort(project: string, device: string, id: string) {
    return this.serial(id, async () => { const upload = this.upload(project, device, id); this.uploads.delete(id); await rm(upload.file, { force: true }); return { aborted: true }; });
  }
  remove(project: string, path: string, expectedHash: string) {
    return this.serial(`project:${project}`, async () => {
      if (await this.currentHash(project, path) !== expectedHash) throw conflict();
      const location = await this.location(project, path);
      await unlink(location.file); this.hashes.delete(location.file);
      return { deleted: true, path };
    });
  }
  directory(project: string, path: string) {
    return this.serial(`project:${project}`, async () => {
      // Validate the full spelling before creating any ancestors.
      if (isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f\\]/.test(path) || path.split("/").some(p => p === ".." || p === ".infinite" || p.startsWith(".infinite-desktop-")))
        throw new DesktopError("invalid-path", "Choose a relative directory path inside this project", 400);
      const parts = path.split("/").filter(p => p && p !== ".");
      if (!parts.length) throw new DesktopError("invalid-path", "Choose a directory path", 400);
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        const location = await this.location(project, prefix, true);
        const parent = await lstat(dirname(location.file)), sharedGroup = this.config.sync?.sharedGroup || Boolean(parent.mode & 0o2000);
        try { await mkdir(location.file, { mode: sharedGroup ? 0o2770 : 0o700 }); if (sharedGroup) await chmod(location.file, 0o2770); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await this.location(project, prefix);
        if (!(await lstat(location.file)).isDirectory()) throw new DesktopError("not-directory", "A file already occupies this directory path", 409);
      }
      return { path: prefix, created: true };
    });
  }
}

const cpuTotals = () => cpus().reduce((value, cpu) => ({ idle: value.idle + cpu.times.idle, total: value.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
type MetricSession = { id: string; pid?: number; status: string };
/** Host-wide sampling is shared across clients; unsupported values stay null. */
export class DesktopResources {
  private previous?: { at: number; cpu: ReturnType<typeof cpuTotals>; rx: number | null; tx: number | null };
  private pending?: Promise<unknown>;
  private cached?: { at: number; value: unknown };
  constructor(private config: Config, private sessions: () => Promise<MetricSession[]>) {}
  sample(): Promise<unknown> {
    if (this.cached && Date.now() - this.cached.at < 1500) return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending;
    const pending = this.capture().then(value => { this.cached = { at: Date.now(), value }; return value; }); this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    return pending;
  }
  private async capture() {
    const at = Date.now(), cpu = cpuTotals(), unavailable: { field: string; reason: string }[] = [];
    let available = freemem(), availableKind: "available" | "free" = "free", swapTotal: number | null = null, swapUsed: number | null = null, rx: number | null = null, tx: number | null = null;
    try {
      if (platform() === "linux") {
        const memory = await readFile("/proc/meminfo", "utf8"), values = Object.fromEntries([...memory.matchAll(/^(\w+):\s+(\d+) kB/gm)].map(m => [m[1], Number(m[2]) * 1024]));
        available = values.MemAvailable ?? values.MemFree ?? available;
        availableKind = values.MemAvailable === undefined ? "free" : "available";
        swapTotal = values.SwapTotal ?? null; swapUsed = values.SwapTotal !== undefined && values.SwapFree !== undefined ? values.SwapTotal - values.SwapFree : null;
        const network = await readFile("/proc/net/dev", "utf8");
        let received = 0, sent = 0;
        for (const line of network.trim().split("\n").slice(2)) {
          const [name, data] = line.split(":"); if (!data || name.trim() === "lo") continue;
          const values = data.trim().split(/\s+/).map(Number);
          if (!Number.isFinite(values[0]) || !Number.isFinite(values[8])) throw new Error("Invalid network counters");
          received += values[0]; sent += values[8];
        }
        rx = received; tx = sent;
      } else if (platform() === "darwin") {
        const [swap, net] = await Promise.all([
          exec("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { timeout: 2000, maxBuffer: 65536 }),
          exec("/usr/sbin/netstat", ["-ibn"], { timeout: 2000, maxBuffer: 1024 * 1024 }),
        ]);
        const parse = (field: string) => { const match = new RegExp(`${field} = ([0-9.]+)([KMG])`).exec(swap.stdout); return match ? Number(match[1]) * 1024 ** ({ K: 1, M: 2, G: 3 }[match[2]]!) : null; };
        swapTotal = parse("total"); swapUsed = parse("used");
        const lines = net.stdout.trim().split("\n"), header = lines[0].trim().split(/\s+/), seen = new Set<string>();
        if (!header.includes("Ibytes") || !header.includes("Obytes")) throw new Error("Network counters are unavailable");
        let received = 0, sent = 0;
        for (const line of lines.slice(1)) {
          const values = line.trim().split(/\s+/); if (!values[2]?.startsWith("<Link#") || values[0] === "lo0" || seen.has(values[0])) continue;
          seen.add(values[0]); const incoming = Number(values[header.indexOf("Ibytes")]), outgoing = Number(values[header.indexOf("Obytes")]);
          if (!Number.isFinite(incoming) || !Number.isFinite(outgoing)) throw new Error("Invalid network counters");
          received += incoming; sent += outgoing;
        }
        rx = received; tx = sent;
        unavailable.push({ field: "memory.availableBytes", reason: "macOS reports free memory here; reclaimable memory is not included" });
      } else unavailable.push({ field: "swap,network", reason: "Platform sampler is unavailable" });
    } catch { unavailable.push({ field: "swap,network", reason: "Operating system counters are unavailable" }); }
    const previous = this.previous, interval = previous ? at - previous.at : null, total = previous ? cpu.total - previous.cpu.total : 0;
    this.previous = { at, cpu, rx, tx };
    if (!previous) unavailable.push({ field: "cpu.usagePercent,network.rates", reason: "Waiting for a second sample" });
    const disks = await Promise.all(this.config.projects.map(async project => {
      try { const disk = await statfs(project.path); return { projectId: project.id, totalBytes: disk.blocks * disk.bsize, availableBytes: disk.bavail * disk.bsize }; }
      catch { return { projectId: project.id, totalBytes: null, availableBytes: null }; }
    }));
    const sessions = await this.sessions(), pids = [...new Set(sessions.filter(s => s.status === "running" && Number.isInteger(s.pid) && s.pid! > 1).map(s => s.pid!))];
    const processes = new Map<number, { cpuPercent: number; rssBytes: number }>();
    if (pids.length) try {
      const result = await exec("ps", ["-p", pids.join(","), "-o", "pid=,%cpu=,rss="], { timeout: 2000, maxBuffer: 256 * 1024 });
      for (const line of result.stdout.trim().split("\n")) { const [pid, cpu, rss] = line.trim().split(/\s+/).map(Number); if ([pid, cpu, rss].every(Number.isFinite)) processes.set(pid, { cpuPercent: cpu, rssBytes: rss * 1024 }); }
    } catch { unavailable.push({ field: "sessions", reason: "Process counters are unavailable" }); }
    const rate = (value: number | null, before: number | null | undefined) => value !== null && before != null && interval && value >= before ? (value - before) * 1000 / interval : null;
    return {
      capturedAt: new Date(at).toISOString(), sampleIntervalMs: interval, uptimeSeconds: uptime(),
      cpu: { logicalCount: cpus().length, usagePercent: previous && total > 0 ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - previous.cpu.idle) / total))) : null, loadAverage: platform() === "win32" ? null : loadavg() },
      memory: { totalBytes: totalmem(), availableBytes: available, availableKind },
      swap: { totalBytes: swapTotal, usedBytes: swapUsed },
      network: { receivedBytes: rx, sentBytes: tx, receiveBytesPerSecond: rate(rx, previous?.rx), sendBytesPerSecond: rate(tx, previous?.tx), scope: "non-loopback-interfaces" },
      disks, sessions: sessions.map(s => ({ sessionId: s.id, pid: s.pid ?? null, scope: "provider-process", cpuKind: "ps-reported", cpuPercent: processes.get(s.pid!)?.cpuPercent ?? null, rssBytes: processes.get(s.pid!)?.rssBytes ?? null })), unavailable,
    };
  }
}
