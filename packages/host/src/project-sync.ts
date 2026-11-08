import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, lstat, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { unseal, writeSealed } from "./vault.js";
import {
  captureWorkspace, decodeChunkBatch, describeMaterializedTree, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob, putWorkspaceBlobs, readWorkspaceBlob,
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
  /** Sockets, FIFOs and device files the host's latest scan of the cloud tree left out, since this API started. */
  skipped?: number;
}
type Received = { manifest: WorkspaceManifest; receivedAt: string; generation: string };
/** A publisher ID distinguishes multiple laptop daemons that use the same paired device credential. */
export interface SyncWriter { deviceId: string; publisherId?: string }
type UploadLease = { generation: string; writer: SyncWriter; updatedAt: string; committing: boolean };
type ActiveUploadLease = { value: UploadLease; expiresAt: number; lastActivityAt: number; lastPersistedAt: number };
/**
 * Whether a cloud session is running or starting in the project. Commit and apply
 * call it inside the project's queue after `applying()` turns true, so a session
 * start refused by `applying()` cannot slip in between the check and the publish.
 */
export type RunningCheck = () => Promise<boolean>;
/** `baseline` is a scan of the published tree; records without one compare against the manifest. */
type Applied = { manifest: WorkspaceManifest; appliedAt: string; baseline?: WorkspaceManifest };

export class ProjectSyncError extends Error {
  constructor(message: string, readonly code: "cloud-changed" | "session-running" | "apply-failed" | "sync-failed" | "sync-applying" | "sync-in-progress" | "stale-generation" | "missing-content" | "invalid-manifest" | "unknown-project",
    readonly status = 409, readonly category?: SyncFailureCategory, readonly retryAfterSeconds?: number) {
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
/** A stalled upload stops owning the project after five minutes without an owning request. */
const UPLOAD_LEASE_MS = 5 * 60 * 1000;
/** Persist lease heartbeats at most every 30 seconds instead of rewriting lease state for every chunk. */
const UPLOAD_LEASE_PERSIST_MS = 30 * 1000;
/** The persisted heartbeat may lag activity by one interval, so restart recovery adds a bounded grace period. */
const UPLOAD_LEASE_RECOVERY_GRACE_MS = 30 * 1000;
const INTERNAL_WRITER: SyncWriter = { deviceId: "internal", publisherId: "internal" };
/** Paths Infinite itself owns inside a project; never part of drift detection. */
const OWNED_PREFIX = ".infinite";
const ownedPath = (path: string) => path === OWNED_PREFIX || path.startsWith(`${OWNED_PREFIX}/`);
const entrySignature = (entry: WorkspaceEntry) => JSON.stringify([entry.path, entry.kind, entry.mode, entry.size ?? null, entry.chunks ?? null, entry.target ?? null]);
/** Two captures of one tree differ in id and capture times; their entries, ignoring local stat stamps, do not. */
const sameEntries = (a: WorkspaceManifest, b: WorkspaceManifest) =>
  a.entries.length === b.entries.length && a.entries.every((entry, index) => entrySignature(entry) === entrySignature(b.entries[index]));
const inside = (root: string, path: string) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
/**
 * Files of the applied generation may be hard-linked into the next one only when both describe the same laptop root
 * and the drift reference agrees with the applied manifest on every file, so a match against it proves the content.
 */
function reusable(applied: Applied, next: WorkspaceManifest) {
  if (applied.manifest.roots.length !== 1 || JSON.stringify(applied.manifest.roots) !== JSON.stringify(next.roots)) return false;
  if (!applied.baseline) return true;
  const content = new Map(applied.baseline.entries.filter(e => e.kind === "file").map(e => [e.path, JSON.stringify(e.chunks)]));
  return applied.manifest.entries.every(e => e.kind !== "file" || ownedPath(e.path) || content.get(e.path) === JSON.stringify(e.chunks));
}

/** One-way laptop-to-cloud synchronization state for configured projects. */
export class ProjectSync {
  private readonly uploads = new Map<string, ActiveUploadLease | undefined>();
  private readonly serial = new Map<string, Promise<unknown>>();
  private readonly changing = new Set<string>();
  private readonly skipped = new Map<string, number>();
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly recovered = new Set<string>();
  constructor(private readonly config: Config, private readonly key: Buffer) {
    // An API stopped in the middle of an apply leaves its stage, and possibly a missing project directory, behind.
    for (const project of config.projects) {
      const recovery = this.queue(project.id, async () => {
        let filesystemRecovered = false;
        try { await this.recover(project.path); filesystemRecovered = true; } catch { /* The project operation reports the actionable refusal. */ }
        const saved = this.readLease(project.id);
        if (saved?.committing && filesystemRecovered) this.clearLease(project.id);
        else if (saved?.committing) this.uploads.set(project.id, {
          value: saved,
          expiresAt: Number.POSITIVE_INFINITY,
          lastActivityAt: Date.parse(saved.updatedAt),
          lastPersistedAt: Date.parse(saved.updatedAt),
        });
        else if (saved) {
          const updatedAt = Date.parse(saved.updatedAt), now = Date.now();
          if (!Number.isFinite(updatedAt) || now > updatedAt + UPLOAD_LEASE_MS + UPLOAD_LEASE_RECOVERY_GRACE_MS) this.clearLease(project.id);
          else this.uploads.set(project.id, {
            value: saved,
            expiresAt: updatedAt + UPLOAD_LEASE_MS + UPLOAD_LEASE_RECOVERY_GRACE_MS,
            lastActivityAt: updatedAt,
            lastPersistedAt: updatedAt,
          });
        }
        this.recovered.add(project.id);
      });
      this.recoveries.set(project.id, recovery);
      void recovery.catch(() => {});
    }
  }

  private ready(projectId: string) {
    if (this.recovered.has(projectId)) return Promise.resolve();
    const recovery = this.recoveries.get(projectId);
    return recovery ?? Promise.resolve();
  }

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
  private store(projectId: string) {
    return { directory: join(this.dir(projectId), "blobs"), sharedPoolDirectory: join(this.config.stateDir, "workspace-pool") };
  }
  private write(projectId: string, name: "received" | "applied", value: unknown) {
    writeSealed(join(this.dir(projectId), `${name}.sealed`), this.key, `project-sync:${projectId}:${name}`, value);
  }
  private readLease(projectId: string): UploadLease | undefined {
    const file = join(this.dir(projectId), "upload-lease.sealed");
    return existsSync(file) ? unseal<UploadLease>(this.key, `project-sync:${projectId}:upload-lease`, readFileSync(file, "utf8")) : undefined;
  }
  private writeLease(projectId: string, value: UploadLease) {
    writeSealed(join(this.dir(projectId), "upload-lease.sealed"), this.key, `project-sync:${projectId}:upload-lease`, value);
  }
  private clearLease(projectId: string) {
    rmSync(join(this.dir(projectId), "upload-lease.sealed"), { force: true });
    this.uploads.delete(projectId);
  }
  private expireLease(projectId: string, now = Date.now()) {
    const active = this.uploads.get(projectId);
    if (active && !active.value.committing && active.expiresAt <= now) this.clearLease(projectId);
    return this.uploads.get(projectId);
  }
  private sameWriter(a: SyncWriter, b: SyncWriter) {
    return a.deviceId === b.deviceId && a.publisherId === b.publisherId;
  }
  private conflict(active: ActiveUploadLease, now = Date.now()): never {
    const retryAfterSeconds = active.value.committing ? 5 : Math.max(1, Math.ceil((active.expiresAt - now) / 1000));
    throw new ProjectSyncError(active.value.committing
      ? "A workspace sync is being committed for this project. Retry shortly."
      : `Another workspace publisher is uploading this project. Retry in about ${retryAfterSeconds} seconds.`,
    "sync-in-progress", 409, undefined, retryAfterSeconds);
  }
  private touchLease(projectId: string, active: ActiveUploadLease, now = Date.now()) {
    active.lastActivityAt = now;
    active.expiresAt = now + UPLOAD_LEASE_MS;
    if (!active.value.committing && now - active.lastPersistedAt >= UPLOAD_LEASE_PERSIST_MS) {
      active.value.updatedAt = new Date(now).toISOString();
      this.writeLease(projectId, active.value);
      active.lastPersistedAt = now;
    }
  }
  private ownedLease(projectId: string, writer: SyncWriter, generation: string | undefined, options: { touch?: boolean; allowLegacyContent?: boolean; allowCommitting?: boolean } = {}) {
    this.project(projectId);
    if (writer.publisherId && !generation) throw new ProjectSyncError("This sync request is missing its generation; begin again", "stale-generation");
    const active = this.expireLease(projectId);
    // Headerless legacy clients may still transfer immutable content. Their begin and commit operations remain fenced.
    if (!generation && !writer.publisherId && options.allowLegacyContent) {
      if (active && !active.value.committing && !active.value.writer.publisherId && active.value.writer.deviceId === writer.deviceId && options.touch)
        this.touchLease(projectId, active);
      return undefined;
    }
    if (!active || (active.value.committing && !options.allowCommitting) || active.value.generation !== generation || !this.sameWriter(active.value.writer, writer))
      throw new ProjectSyncError("This sync generation is stale or belongs to another publisher; begin again", "stale-generation");
    if (options.touch) this.touchLease(projectId, active);
    return active;
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
    if (this.skipped.get(projectId)) status.skipped = this.skipped.get(projectId);
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

  async begin(projectId: string, writer: SyncWriter = INTERNAL_WRITER) {
    await this.ready(projectId);
    this.project(projectId);
    const now = Date.now(), active = this.expireLease(projectId, now);
    if (active) {
      // Unknown legacy writers cannot prove they are the caller that started the lease, so they never resume by identity.
      if (writer.publisherId !== undefined && this.sameWriter(active.value.writer, writer)) {
        if (active.value.committing) this.conflict(active, now);
        this.touchLease(projectId, active, now);
        return { generation: active.value.generation };
      }
      this.conflict(active, now);
    }
    const value: UploadLease = { generation: randomUUID(), writer, updatedAt: new Date(now).toISOString(), committing: false };
    this.writeLease(projectId, value);
    this.uploads.set(projectId, { value, expiresAt: now + UPLOAD_LEASE_MS, lastActivityAt: now, lastPersistedAt: now });
    return { generation: value.generation };
  }
  async missing(projectId: string, hashes: string[], writer: SyncWriter = INTERNAL_WRITER, generation?: string) {
    this.ownedLease(projectId, writer, generation, { touch: true, allowLegacyContent: true });
    if (!Array.isArray(hashes) || hashes.length > 512 || hashes.some(h => !/^[a-f0-9]{64}$/.test(h))) throw new ProjectSyncError("Invalid blob presence request", "invalid-manifest", 400);
    return hasWorkspaceBlobs(this.store(projectId), hashes);
  }
  async putBlob(projectId: string, hash: string, bytes: Buffer, writer: SyncWriter = INTERNAL_WRITER, generation?: string) {
    this.ownedLease(projectId, writer, generation, { touch: true, allowLegacyContent: true });
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectSyncError("Invalid blob hash", "invalid-manifest", 400);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new ProjectSyncError("The uploaded content does not match its hash", "invalid-manifest", 400);
    await putWorkspaceBlob(this.store(projectId), hash, bytes.toString("base64"));
  }
  /** Store a framed batch; returns the number of chunks it held. */
  async putBlobs(projectId: string, body: Buffer, writer: SyncWriter = INTERNAL_WRITER, generation?: string) {
    this.ownedLease(projectId, writer, generation, { touch: true, allowLegacyContent: true });
    let chunks: { hash: string; bytes: Buffer }[];
    try { chunks = decodeChunkBatch(body); } catch { throw new ProjectSyncError("Invalid chunk batch", "invalid-manifest", 400); }
    if (chunks.some(({ hash, bytes }) => createHash("sha256").update(bytes).digest("hex") !== hash))
      throw new ProjectSyncError("The uploaded content does not match its hash", "invalid-manifest", 400);
    await putWorkspaceBlobs(this.store(projectId), chunks);
    return chunks.length;
  }
  async readBlob(projectId: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectSyncError("Invalid blob hash", "invalid-manifest", 400);
    try { return await readWorkspaceBlob(this.store(projectId), hash); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProjectSyncError("This content is not stored for the project", "missing-content", 404);
      throw error;
    }
  }

  commit(projectId: string, generation: string, value: unknown, running: RunningCheck, writer: SyncWriter = INTERNAL_WRITER) {
    const admit = () => {
      const active = this.ownedLease(projectId, writer, generation);
      if (!active) throw new ProjectSyncError("This sync generation is stale; begin again", "stale-generation");
      // Admission is durable before the commit waits in the project queue, and this flag disables lease expiry.
      const admitted = { ...active.value, updatedAt: new Date().toISOString(), committing: true };
      this.writeLease(projectId, admitted);
      active.value = admitted;
      active.lastPersistedAt = active.lastActivityAt = Date.now();
      active.expiresAt = Number.POSITIVE_INFINITY;
      return this.changeQueue(projectId, async () => {
        try {
          this.ownedLease(projectId, writer, generation, { allowCommitting: true });
          if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_MANIFEST_BYTES) throw new ProjectSyncError("Manifest exceeds the size limit", "invalid-manifest", 413);
          let manifest: WorkspaceManifest;
          try { manifest = validateWorkspaceManifest(value); } catch { throw new ProjectSyncError("Invalid workspace manifest", "invalid-manifest", 400); }
          if (manifest.roots.length !== 1) throw new ProjectSyncError("Project sync accepts exactly one root", "invalid-manifest", 400);
          const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
          if ((await hasWorkspaceBlobs(this.store(projectId), hashes)).length) throw new ProjectSyncError("The manifest references content that was not uploaded", "missing-content");
          this.ownedLease(projectId, writer, generation, { allowCommitting: true });
          this.write(projectId, "received", { manifest, receivedAt: new Date().toISOString(), generation } satisfies Received);
          // A pending marker always describes the newest received generation.
          this.writePending(projectId, undefined);
          const status = await this.applyReceived(projectId, { running });
          this.clearLease(projectId);
          return status;
        } catch (error) {
          const current = this.uploads.get(projectId);
          if (current?.value.generation === generation) {
            if (error instanceof ProjectSyncError && error.code === "apply-failed") this.clearLease(projectId);
            else {
              current.value.committing = false;
              current.value.updatedAt = new Date().toISOString();
              this.writeLease(projectId, current.value);
              current.lastActivityAt = current.lastPersistedAt = Date.now();
              current.expiresAt = current.lastActivityAt + UPLOAD_LEASE_MS;
            }
          }
          throw error;
        }
      });
    };
    if (this.recovered.has(projectId)) {
      try { return admit(); } catch (error) { return Promise.reject(error); }
    }
    return this.ready(projectId).then(admit);
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
      await this.recover(project.path);
      if (!options.force && await this.drifted(projectId, project.path, applied)) return pending("cloud-changed");
      // Without force, the drift check just verified that the live tree matches the applied generation.
      return await this.publish(projectId, project.path, received, options.force ? undefined : applied);
    } catch (error) {
      if (error instanceof ProjectSyncError) throw error;
      // The generation stays received and pending with a reason; a later laptop change or an explicit apply retries it.
      const failure = syncFailure(error, project.path);
      this.writePending(projectId, { id: received.manifest.id, capturedAt: received.manifest.capturedAt, receivedAt: received.receivedAt, reason: "apply-failed", ...failure });
      throw new ProjectSyncError(failure.message, "apply-failed", 409, failure.category);
    }
  }

  /**
   * Replace the project tree with the received generation and record it as applied. `verified` is the applied
   * generation the live tree was just checked against; its unchanged files are hard-linked instead of rewritten.
   */
  private async publish(projectId: string, path: string, received: Received, verified?: Applied): Promise<ProjectSyncStatus> {
    const target = await this.projectRoot(path);
    const parent = dirname(target), name = basename(target);
    // The new root always sits at STAGE/root, so recovery finds a carried .infinite/ without knowing the laptop path.
    const stage = join(parent, `.${name}.infinite-stage-${randomUUID()}`), source = join(stage, "root");
    const previous = join(parent, `.${name}.infinite-previous`);
    const owned = join(target, OWNED_PREFIX), carried = join(source, OWNED_PREFIX);
    const reuse = verified && reusable(verified, received.manifest) ? { manifest: verified.manifest, roots: [target] } : undefined;
    let moved = false, retired = false, restored = true, written: WorkspaceManifest | undefined;
    try {
      const sharedGroup = await this.sharedGroup(parent);
      const tree = await materializeWorkspace({ manifest: received.manifest, storeDir: this.store(projectId), destination: join(stage, "tree"), sharedGroup, previous: reuse, flush: "once" });
      await rename(tree.roots[0], source);
      // The cloud copy of Infinite's own directory wins; a laptop copy never replaces it.
      await removeTree(carried);
      await removeTree(previous);
      if (existsSync(owned)) { await rename(owned, carried); moved = true; }
      // Only this host can write the private stage, so a metadata pass now describes what the swap publishes.
      written = await describeMaterializedTree(received.manifest, source, target, ownedPath).catch(() => undefined);
      await rename(target, previous); retired = true;
      await rename(source, target);
      await syncDirectory(parent);
    } catch (error) {
      // Put the live tree and Infinite's own directory back. If that fails, the stage keeps .infinite/ for recovery.
      if (retired) await rename(previous, target).catch(() => { restored = false; });
      if (moved && restored) await rename(carried, owned).catch(() => { restored = false; });
      await syncDirectory(parent).catch(() => {});
      throw error;
    } finally { if (restored) await removeTree(stage).catch(() => {}); }
    // Drift compares against what materialize actually wrote: resolved symlink targets and this host's modes. When the
    // metadata pass could not describe it, a full scan does. Without a baseline, drift falls back to the manifest.
    const baseline = written ?? await this.scan(projectId, target).catch(() => undefined);
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
    const root = await this.refuseHostPaths(await realpath(path));
    if (!(await lstat(root)).isDirectory()) throw new ProjectSyncError("Configured project path is not a directory", "invalid-manifest", 500);
    return root;
  }
  private async refuseHostPaths(root: string) {
    const own = await Promise.all([this.config.stateDir, this.config.runDir, dirname(this.config.keyFile)].map(canonical));
    if (root === "/" || root === await canonical(homedir()) || own.some(dir => inside(root, dir)))
      throw new ProjectSyncError("The project path is the root or home directory or holds the host's own state; sync refuses it", "invalid-manifest", 500);
    return root;
  }
  /**
   * Finish an apply that stopped between its steps, after a crash or a kill: restore a missing project directory from
   * its previous copy, return a carried .infinite/ to the project, and remove leftover stages. Runs inside the project's
   * queue, at construction and before each apply, so no apply of this project is in progress.
   */
  private async recover(path: string) {
    const target = await this.refuseHostPaths(await canonical(path));
    const parent = dirname(target), name = basename(target);
    const previous = join(parent, `.${name}.infinite-previous`), owned = join(target, OWNED_PREFIX);
    let changed = false;
    if (!(await present(target)) && (await lstat(previous).catch(() => undefined))?.isDirectory()) { await rename(previous, target); changed = true; }
    for (const entry of await readdir(parent)) {
      if (STAGE.exec(entry)?.[1] !== name) continue;
      const stage = join(parent, entry), carried = join(stage, "root", OWNED_PREFIX);
      if (await present(carried) && (await lstat(target).catch(() => undefined))?.isDirectory() && !(await present(owned))) await rename(carried, owned);
      await removeTree(stage); changed = true;
    }
    if (changed) await syncDirectory(parent);
  }
  /** Capture the live tree into the shared content store, reusing unchanged files from `previous` when it describes this root. */
  private async scan(projectId: string, path: string, previous?: WorkspaceManifest) {
    const root = await this.projectRoot(path);
    let skipped = 0;
    const manifest = await captureWorkspace({ roots: [root], cwd: root, storeDir: this.store(projectId), previous: previous?.roots[0] === root ? previous : undefined, onSkipped: () => { skipped += 1; } });
    this.skipped.set(projectId, skipped);
    return manifest;
  }
  async exportTree(projectId: string): Promise<WorkspaceManifest> {
    const project = this.project(projectId);
    return this.queue(projectId, () => this.scan(projectId, project.path, this.read<Applied>(projectId, "applied")?.baseline));
  }
}

const STAGE = /^\.(.+)\.infinite-stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const present = async (path: string) => Boolean(await lstat(path).catch(() => undefined));
async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
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
