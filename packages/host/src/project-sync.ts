import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, lstat, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { unseal, writeSealed } from "./vault.js";
import {
  captureWorkspace, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob, readWorkspaceBlob,
  validateWorkspaceManifest, WorkspaceCaptureChangedError, type WorkspaceEntry, type WorkspaceManifest,
} from "./workspace-checkpoint.js";
import type { Config } from "./types.js";

export type SyncFailureCategory = "permission" | "cross-device" | "no-space" | "special-file" | "missing-path" | "other";
export interface PendingGeneration {
  id: string; capturedAt: string; receivedAt: string;
  /** `awaiting-apply` is never stored: a read reports it for a `session-running` marker once no session holds the project. */
  reason: "session-running" | "cloud-changed" | "apply-failed" | "awaiting-apply";
  /** Set for `apply-failed`: a fixed category and message that never name a path. */
  category?: SyncFailureCategory; message?: string;
}
export interface ProjectSyncStatus {
  projectId: string;
  lastSyncedAt?: string;
  lastSyncedManifest?: string;
  appliedAt?: string;
  appliedManifest?: string;
  pendingGeneration?: PendingGeneration;
}
type Received = { manifest: WorkspaceManifest; receivedAt: string; generation: string };
/**
 * Whether a cloud session is running or starting in the project. Commit and apply
 * call it inside the project's queue after `applying()` turns true, so a session
 * start refused by `applying()` cannot slip in between the check and the publish.
 */
export type RunningCheck = () => Promise<boolean>;
/** `baseline` is a scan of the published tree; records without one compare against the manifest. */
type Applied = { manifest: WorkspaceManifest; appliedAt: string; baseline?: WorkspaceManifest };

export class ProjectSyncError extends Error {
  constructor(message: string, readonly code: "cloud-changed" | "session-running" | "apply-failed" | "sync-failed" | "sync-applying" | "stale-generation" | "missing-content" | "invalid-manifest" | "unknown-project",
    readonly status = 409, readonly category?: SyncFailureCategory) {
    super(message);
  }
}

const FAILURES: Record<SyncFailureCategory, string> = {
  permission: "The host account cannot read, write, or remove part of the cloud project. Check its owner, group, and default ACL.",
  "cross-device": "The cloud project directory is a mount point or spans filesystems, so the host cannot replace it.",
  "no-space": "The host ran out of disk space or quota.",
  "special-file": "The cloud project holds a socket, FIFO, or device file the host cannot read.",
  "missing-path": "The cloud project directory is missing.",
  other: "The host could not complete the workspace sync operation.",
};
/**
 * A filesystem error as a category and a fixed message, never the raw error text, which names host paths.
 * `ENOENT` means a missing project only when the project directory itself is gone.
 */
export function syncFailure(error: unknown, projectPath?: string): { category: SyncFailureCategory; message: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  const missing = projectPath !== undefined && ["ENOENT", "ENOTDIR"].includes(code) && !existsSync(projectPath);
  const category: SyncFailureCategory = ["EACCES", "EPERM", "EROFS"].includes(code) ? "permission"
    : ["EXDEV", "EBUSY"].includes(code) ? "cross-device"
    : ["ENOSPC", "EDQUOT"].includes(code) ? "no-space"
    : ["ENXIO", "ENODEV"].includes(code) ? "special-file"
    : missing ? "missing-path" : "other";
  return { category, message: error instanceof WorkspaceCaptureChangedError ? "The cloud project changed while the host scanned it." : FAILURES[category] };
}

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
/** Paths Infinite itself owns inside a project; never part of drift detection. */
const OWNED_PREFIX = ".infinite";
const ownedPath = (path: string) => path === OWNED_PREFIX || path.startsWith(`${OWNED_PREFIX}/`);
const entrySignature = (entry: WorkspaceEntry) => JSON.stringify([entry.path, entry.kind, entry.mode, entry.size ?? null, entry.chunks ?? null, entry.target ?? null]);
/** Two captures of one tree differ in id and capture times; their entries, ignoring local stat stamps, do not. */
const sameEntries = (a: WorkspaceManifest, b: WorkspaceManifest) =>
  a.entries.length === b.entries.length && a.entries.every((entry, index) => entrySignature(entry) === entrySignature(b.entries[index]));
const inside = (root: string, path: string) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** One-way laptop-to-cloud synchronization state for configured projects. */
export class ProjectSync {
  private readonly generations = new Map<string, string>();
  private readonly serial = new Map<string, Promise<unknown>>();
  private readonly changing = new Set<string>();
  constructor(private readonly config: Config, private readonly key: Buffer) {}

  private project(projectId: string) {
    const project = this.config.projects.find(p => p.id === projectId);
    if (!project) throw new ProjectSyncError("Unknown project", "unknown-project", 404);
    return project;
  }
  private dir(projectId: string) {
    this.project(projectId);
    const dir = join(this.config.stateDir, "projects", projectId, "sync");
    mkdirSync(join(dir, "blobs"), { recursive: true, mode: 0o700 });
    return dir;
  }
  private read<T>(projectId: string, name: "received" | "applied"): T | undefined {
    const file = join(this.dir(projectId), `${name}.sealed`);
    return existsSync(file) ? unseal<T>(this.key, `project-sync:${projectId}:${name}`, readFileSync(file, "utf8")) : undefined;
  }
  private write(projectId: string, name: "received" | "applied", value: unknown) {
    writeSealed(join(this.dir(projectId), `${name}.sealed`), this.key, `project-sync:${projectId}:${name}`, value);
  }
  /** Serialize commit and apply per project; blob writes are content-addressed and need no lock. */
  private queue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(projectId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.serial.set(projectId, next.catch(() => {}));
    return next;
  }
  /** A queued task that may replace the project tree. `applying()` is true for all of it. */
  private changeQueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    return this.queue(projectId, async () => {
      this.changing.add(projectId);
      try { return await task(); } finally { this.changing.delete(projectId); }
    });
  }

  status(projectId: string): ProjectSyncStatus {
    this.project(projectId);
    const received = this.read<Received>(projectId, "received");
    const applied = this.read<Applied>(projectId, "applied");
    const status: ProjectSyncStatus = { projectId };
    if (received) { status.lastSyncedAt = received.receivedAt; status.lastSyncedManifest = received.manifest.id; }
    if (applied) { status.appliedAt = applied.appliedAt; status.appliedManifest = applied.manifest.id; }
    const pending = this.readPending(projectId);
    if (pending) status.pendingGeneration = pending;
    return status;
  }
  /** Status as of now: a generation that waited for a session reads `awaiting-apply` once no session holds the project. */
  async liveStatus(projectId: string, running: RunningCheck): Promise<ProjectSyncStatus> {
    const status = this.status(projectId);
    if (status.pendingGeneration?.reason === "session-running" && !(await running()))
      status.pendingGeneration = { ...status.pendingGeneration, reason: "awaiting-apply" };
    return status;
  }
  private readPending(projectId: string) {
    const file = join(this.dir(projectId), "pending.json");
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as PendingGeneration;
  }
  private writePending(projectId: string, value: PendingGeneration | undefined) {
    const file = join(this.dir(projectId), "pending.json");
    if (!value) { rmSync(file, { force: true }); return; }
    writeJson(file, value);
  }

  begin(projectId: string) {
    this.project(projectId);
    const generation = randomUUID();
    this.generations.set(projectId, generation);
    return { generation };
  }
  async missing(projectId: string, hashes: string[]) {
    if (!Array.isArray(hashes) || hashes.length > 512 || hashes.some(h => !/^[a-f0-9]{64}$/.test(h))) throw new ProjectSyncError("Invalid blob presence request", "invalid-manifest", 400);
    return hasWorkspaceBlobs(join(this.dir(projectId), "blobs"), hashes);
  }
  async putBlob(projectId: string, hash: string, bytes: Buffer) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectSyncError("Invalid blob hash", "invalid-manifest", 400);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new ProjectSyncError("The uploaded content does not match its hash", "invalid-manifest", 400);
    await putWorkspaceBlob(join(this.dir(projectId), "blobs"), hash, bytes.toString("base64"));
  }
  async readBlob(projectId: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectSyncError("Invalid blob hash", "invalid-manifest", 400);
    try { return await readWorkspaceBlob(join(this.dir(projectId), "blobs"), hash); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProjectSyncError("This content is not stored for the project", "missing-content", 404);
      throw error;
    }
  }

  commit(projectId: string, generation: string, value: unknown, running: RunningCheck) {
    return this.changeQueue(projectId, async () => {
      this.project(projectId);
      if (this.generations.get(projectId) !== generation) throw new ProjectSyncError("This sync generation is stale; begin again", "stale-generation");
      if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_MANIFEST_BYTES) throw new ProjectSyncError("Manifest exceeds the size limit", "invalid-manifest", 413);
      let manifest: WorkspaceManifest;
      try { manifest = validateWorkspaceManifest(value); } catch { throw new ProjectSyncError("Invalid workspace manifest", "invalid-manifest", 400); }
      if (manifest.roots.length !== 1) throw new ProjectSyncError("Project sync accepts exactly one root", "invalid-manifest", 400);
      const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
      if ((await hasWorkspaceBlobs(join(this.dir(projectId), "blobs"), hashes)).length) throw new ProjectSyncError("The manifest references content that was not uploaded", "missing-content");
      this.write(projectId, "received", { manifest, receivedAt: new Date().toISOString(), generation } satisfies Received);
      // A pending marker always describes the newest received generation.
      this.writePending(projectId, undefined);
      return this.applyReceived(projectId, { running });
    });
  }

  apply(projectId: string, options: { force?: boolean; running: RunningCheck }) {
    return this.changeQueue(projectId, () => this.applyReceived(projectId, options, true));
  }
  /** A commit or apply holds this project and may replace its tree; new sessions must not start in it. */
  applying(projectId: string) {
    return this.changing.has(projectId);
  }

  private async applyReceived(projectId: string, options: { force?: boolean; running: RunningCheck }, explicit = false): Promise<ProjectSyncStatus> {
    const project = this.project(projectId);
    const received = this.read<Received>(projectId, "received");
    if (!received) return this.status(projectId);
    const applied = this.read<Applied>(projectId, "applied");
    // A recapture of the applied content is already in place: record it as applied without replacing the tree.
    // A forced apply still republishes it, which resets cloud edits to the laptop content.
    if (!options.force && applied && (applied.manifest.id === received.manifest.id || sameEntries(applied.manifest, received.manifest))) {
      if (applied.manifest.id !== received.manifest.id) this.write(projectId, "applied", { ...applied, manifest: received.manifest } satisfies Applied);
      this.writePending(projectId, undefined);
      return this.status(projectId);
    }
    const pending = (reason: "session-running" | "cloud-changed") => {
      this.writePending(projectId, { id: received.manifest.id, capturedAt: received.manifest.capturedAt, receivedAt: received.receivedAt, reason });
      if (explicit) throw new ProjectSyncError(reason === "session-running" ? "A session is running in this project; stop it or wait before applying" : "The cloud workspace changed since the last applied generation; pull it or apply with force", reason);
      return this.status(projectId);
    };
    if (await options.running()) return pending("session-running");
    try {
      if (!options.force && await this.drifted(projectId, project.path, applied)) return pending("cloud-changed");
      return await this.publish(projectId, project.path, received);
    } catch (error) {
      if (error instanceof ProjectSyncError) throw error;
      // The generation stays received and pending with a reason; a later laptop change or an explicit apply retries it.
      const failure = syncFailure(error, project.path);
      this.writePending(projectId, { id: received.manifest.id, capturedAt: received.manifest.capturedAt, receivedAt: received.receivedAt, reason: "apply-failed", ...failure });
      throw new ProjectSyncError(failure.message, "apply-failed", 409, failure.category);
    }
  }

  /** Replace the project tree with the received generation and record it as applied. */
  private async publish(projectId: string, path: string, received: Received): Promise<ProjectSyncStatus> {
    const target = await this.projectRoot(path);
    const parent = dirname(target), name = basename(target);
    const stage = join(parent, `.${name}.infinite-stage-${randomUUID()}`);
    const previous = join(parent, `.${name}.infinite-previous`);
    const owned = join(target, OWNED_PREFIX);
    let carried: string | undefined, retired = false;
    try {
      const sharedGroup = await this.sharedGroup(parent);
      const source = (await materializeWorkspace({ manifest: received.manifest, storeDir: join(this.dir(projectId), "blobs"), destination: stage, sharedGroup })).roots[0];
      // The cloud copy of Infinite's own directory wins; a laptop copy never replaces it.
      await removeTree(join(source, OWNED_PREFIX));
      await removeTree(previous);
      if (existsSync(owned)) { await rename(owned, join(source, OWNED_PREFIX)); carried = join(source, OWNED_PREFIX); }
      await rename(target, previous); retired = true;
      await rename(source, target);
    } catch (error) {
      // Put the live tree and Infinite's own directory back before the stage is discarded.
      if (retired) await rename(previous, target).catch(() => {});
      if (carried) await rename(carried, owned).catch(() => {});
      throw error;
    } finally { await removeTree(stage).catch(() => {}); }
    // Drift compares against what materialize actually wrote: resolved symlink targets and this host's symlink modes.
    // Without a baseline, drift falls back to the manifest.
    const baseline = await this.scan(projectId, target).catch(() => undefined);
    this.write(projectId, "applied", { manifest: received.manifest, appliedAt: new Date().toISOString(), baseline } satisfies Applied);
    this.writePending(projectId, undefined);
    return this.status(projectId);
  }

  /**
   * A separate agent account edits the tree through a shared group: the configured flag, or a setgid
   * parent such as the Ubuntu template's workspaces directory. Shared trees get group-writable files
   * and 2770 directories instead of the laptop's modes.
   */
  private async sharedGroup(parent: string) {
    return this.config.sync?.sharedGroup === true || Boolean((await stat(parent)).mode & 0o2000);
  }
  /** The live cloud tree differs from the last applied generation, ignoring Infinite's own directory. */
  private async drifted(projectId: string, path: string, applied?: Applied): Promise<boolean> {
    const live = (await this.scan(projectId, path, applied?.baseline)).entries.filter(e => !ownedPath(e.path) && e.path !== "");
    const reference = applied?.baseline ?? applied?.manifest;
    if (!reference) return live.length > 0;
    const expected = new Set(reference.entries.filter(e => !ownedPath(e.path) && e.path !== "").map(entrySignature));
    if (live.length !== expected.size) return true;
    return live.some(e => !expected.has(entrySignature(e)));
  }
  /** Canonical project directory. Refuses the filesystem root, the home directory, and any path holding the host's own state. */
  private async projectRoot(path: string) {
    const root = await realpath(path);
    const own = await Promise.all([this.config.stateDir, this.config.runDir, dirname(this.config.keyFile)].map(canonical));
    if (root === "/" || root === await canonical(homedir()) || own.some(dir => inside(root, dir)))
      throw new ProjectSyncError("The project path is the root or home directory or holds the host's own state; sync refuses it", "invalid-manifest", 500);
    if (!(await lstat(root)).isDirectory()) throw new ProjectSyncError("Configured project path is not a directory", "invalid-manifest", 500);
    return root;
  }
  /** Capture the live tree into the shared content store, reusing unchanged files from `previous` when it describes this root. */
  private async scan(projectId: string, path: string, previous?: WorkspaceManifest) {
    const root = await this.projectRoot(path);
    return captureWorkspace({ roots: [root], cwd: root, storeDir: join(this.dir(projectId), "blobs"), previous: previous?.roots[0] === root ? previous : undefined });
  }
  async exportTree(projectId: string): Promise<WorkspaceManifest> {
    const project = this.project(projectId);
    return this.queue(projectId, () => this.scan(projectId, project.path, this.read<Applied>(projectId, "applied")?.baseline));
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

/** Remove a tree this host wrote, including directories a manifest made read-only. */
async function removeTree(path: string) {
  try { await rm(path, { recursive: true, force: true }); return; } catch (error) {
    if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || !(await lstat(path)).isDirectory()) throw error;
  }
  await ownerWritable(path);
  await rm(path, { recursive: true, force: true });
}
async function ownerWritable(directory: string) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await ownerWritable(join(directory, entry.name));
}
/** Real path of `path`, resolving the nearest existing ancestor when the path itself does not exist yet. */
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    const absolute = resolve(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(absolute) === absolute) throw error;
    return join(await canonical(dirname(absolute)), basename(absolute));
  }
}
