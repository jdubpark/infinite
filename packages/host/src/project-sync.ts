import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { unseal, writeSealed } from "./vault.js";
import {
  captureWorkspace, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob, readWorkspaceBlob,
  validateWorkspaceManifest, type WorkspaceEntry, type WorkspaceManifest,
} from "./workspace-checkpoint.js";
import type { Config } from "./types.js";

export interface ProjectSyncStatus {
  projectId: string;
  lastSyncedAt?: string;
  lastSyncedManifest?: string;
  appliedAt?: string;
  appliedManifest?: string;
  pendingGeneration?: { id: string; capturedAt: string; receivedAt: string; reason: "session-running" | "cloud-changed" };
}
type Received = { manifest: WorkspaceManifest; receivedAt: string; generation: string };
type Applied = { manifest: WorkspaceManifest; appliedAt: string };

export class ProjectSyncError extends Error {
  constructor(message: string, readonly code: "cloud-changed" | "session-running" | "stale-generation" | "missing-content" | "invalid-manifest" | "unknown-project", readonly status = 409) {
    super(message);
  }
}

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
/** Paths Infinite itself owns inside a project; never part of drift detection. */
const OWNED_PREFIX = ".infinite";
const ownedPath = (path: string) => path === OWNED_PREFIX || path.startsWith(`${OWNED_PREFIX}/`);
const entrySignature = (entry: WorkspaceEntry) => JSON.stringify([entry.path, entry.kind, entry.mode, entry.size ?? null, entry.chunks ?? null, entry.target ?? null]);

/** One-way laptop-to-cloud synchronization state for configured projects. */
export class ProjectSync {
  private readonly generations = new Map<string, string>();
  private readonly serial = new Map<string, Promise<unknown>>();
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
  private readPending(projectId: string) {
    const file = join(this.dir(projectId), "pending.json");
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as ProjectSyncStatus["pendingGeneration"];
  }
  private writePending(projectId: string, value: ProjectSyncStatus["pendingGeneration"] | undefined) {
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
    await putWorkspaceBlob(join(this.dir(projectId), "blobs"), hash, bytes.toString("base64"));
  }
  readBlob(projectId: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectSyncError("Invalid blob hash", "invalid-manifest", 400);
    return readWorkspaceBlob(join(this.dir(projectId), "blobs"), hash);
  }

  commit(projectId: string, generation: string, value: unknown, running: boolean) {
    return this.queue(projectId, async () => {
      this.project(projectId);
      if (this.generations.get(projectId) !== generation) throw new ProjectSyncError("This sync generation is stale; begin again", "stale-generation");
      if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_MANIFEST_BYTES) throw new ProjectSyncError("Manifest exceeds the size limit", "invalid-manifest", 413);
      let manifest: WorkspaceManifest;
      try { manifest = validateWorkspaceManifest(value); } catch { throw new ProjectSyncError("Invalid workspace manifest", "invalid-manifest", 400); }
      if (manifest.roots.length !== 1) throw new ProjectSyncError("Project sync accepts exactly one root", "invalid-manifest", 400);
      const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
      if ((await hasWorkspaceBlobs(join(this.dir(projectId), "blobs"), hashes)).length) throw new ProjectSyncError("The manifest references content that was not uploaded", "missing-content");
      this.write(projectId, "received", { manifest, receivedAt: new Date().toISOString(), generation } satisfies Received);
      return this.applyReceived(projectId, { running });
    });
  }

  apply(projectId: string, options: { force?: boolean; running: boolean }) {
    return this.queue(projectId, () => this.applyReceived(projectId, options, true));
  }

  private async applyReceived(projectId: string, options: { force?: boolean; running: boolean }, explicit = false): Promise<ProjectSyncStatus> {
    const project = this.project(projectId);
    const received = this.read<Received>(projectId, "received");
    if (!received) return this.status(projectId);
    const applied = this.read<Applied>(projectId, "applied");
    if (applied?.manifest.id === received.manifest.id) { this.writePending(projectId, undefined); return this.status(projectId); }
    const pending = (reason: "session-running" | "cloud-changed") => {
      this.writePending(projectId, { id: received.manifest.id, capturedAt: received.manifest.capturedAt, receivedAt: received.receivedAt, reason });
      if (explicit) throw new ProjectSyncError(reason === "session-running" ? "A session is running in this project; stop it or wait before applying" : "The cloud workspace changed since the last applied generation; pull it or apply with force", reason);
      return this.status(projectId);
    };
    if (options.running) return pending("session-running");
    if (!options.force && await this.drifted(projectId, project.path, applied?.manifest)) return pending("cloud-changed");
    const target = await realpath(project.path);
    const parent = dirname(target), name = basename(target);
    const stage = join(parent, `.${name}.infinite-stage-${randomUUID()}`);
    const previous = join(parent, `.${name}.infinite-previous`);
    const owned = join(target, OWNED_PREFIX);
    let carried: string | undefined, retired = false;
    try {
      const source = (await materializeWorkspace({ manifest: received.manifest, storeDir: join(this.dir(projectId), "blobs"), destination: stage })).roots[0];
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
    this.write(projectId, "applied", { manifest: received.manifest, appliedAt: new Date().toISOString() } satisfies Applied);
    this.writePending(projectId, undefined);
    return this.status(projectId);
  }

  /** The live cloud tree differs from the last applied generation, ignoring Infinite's own directory. */
  private async drifted(projectId: string, path: string, applied?: WorkspaceManifest): Promise<boolean> {
    const live = await this.scan(projectId, path);
    const liveEntries = live.entries.filter(e => !ownedPath(e.path) && e.path !== "");
    if (!applied) return liveEntries.length > 0;
    const expected = new Set(applied.entries.filter(e => !ownedPath(e.path) && e.path !== "").map(entrySignature));
    if (liveEntries.length !== expected.size) return true;
    return liveEntries.some(e => !expected.has(entrySignature(e)));
  }
  private async scan(projectId: string, path: string) {
    const root = await realpath(path);
    if (!(await lstat(root)).isDirectory()) throw new ProjectSyncError("Configured project path is not a directory", "invalid-manifest", 500);
    const storeDir = join(this.dir(projectId), "scan");
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    return captureWorkspace({ roots: [root], cwd: root, storeDir });
  }
  async exportTree(projectId: string): Promise<WorkspaceManifest> {
    const project = this.project(projectId);
    const root = await realpath(project.path);
    return captureWorkspace({ roots: [root], cwd: root, storeDir: join(this.dir(projectId), "blobs") });
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
