import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { startCloudExecutor } from "./cloud-executor.js";
import {
  captureWorkspace, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob,
  readWorkspaceBlob, validateWorkspaceManifest, type WorkspaceManifest,
} from "./workspace-checkpoint.js";
import type { ExecutionState, LaptopWorkspace } from "./types.js";

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
type Checkpoint = { revision: number; epoch: number; manifest: WorkspaceManifest; tree?: { directory: string; cwd: string; roots: string[] } };
type Placement = { epoch: number; phase: "laptop" | "selecting" | "cloud" | "failed"; checkpoint?: ExecutionState["checkpoint"] };
type Execution = { environmentId: string; url: string; token: string; cwd: string; roots: string[] };

async function durableJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(directory, name));
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
}

async function storedJson(directory: string, name: string): Promise<any | undefined> {
  try {
    const path = join(directory, name), info = await lstat(path);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES + 4096 || (info.mode & 0o077))
      throw new Error("Hybrid workspace state is not a private, bounded file.");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Coordinate checkpoint publication and placement; this does not fence arbitrary laptop processes. */
export async function createHybridWorkspace(options: {
  workspace: LaptopWorkspace;
  directory: string;
  record: (data: Record<string, unknown>) => void;
  publish: (state: ExecutionState) => void;
  select: (execution: Execution) => Promise<void>;
  command?: string;
  commandArgs?: string[];
  workspaceDirectory?: string;
  sharedWorkspace?: boolean;
}) {
  const directory = resolve(options.directory), storeDir = join(directory, "blobs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) ||
      (process.getuid && directoryInfo.uid !== process.getuid()))
    throw new Error("Hybrid workspace state requires a private owner-controlled directory.");
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  if (options.sharedWorkspace && !options.workspaceDirectory) throw new Error("A shared execution identity requires a separate workspace directory.");
  const dataDirectory = resolve(options.workspaceDirectory ?? directory);
  if (options.workspaceDirectory) {
    const relativeData = relative(directory, dataDirectory);
    if (!relativeData || (relativeData !== ".." && !relativeData.startsWith(`..${sep}`) && !isAbsolute(relativeData)))
      throw new Error("Shared workspace data must stay outside private control state.");
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const dataInfo = await lstat(dataDirectory);
    if (!dataInfo.isDirectory() || (process.getuid && dataInfo.uid !== process.getuid()) || await realpath(dataDirectory) !== dataDirectory)
      throw new Error("The execution data directory must be owned by the host and cannot be a symlink.");
    await chmod(dataDirectory, options.sharedWorkspace ? 0o2700 : 0o700);
  }
  const savedPlacement = await storedJson(directory, "placement.json") as Placement | undefined;
  if (savedPlacement && (!validCounter(savedPlacement.epoch) || !["laptop", "selecting", "cloud", "failed"].includes(savedPlacement.phase)))
    throw new Error("Hybrid workspace placement state is invalid.");
  const savedCheckpoint = await storedJson(directory, "checkpoint.json") as Checkpoint | undefined;
  let latest: Checkpoint | undefined;
  if (savedCheckpoint) {
    if (!validCounter(savedCheckpoint.revision) || !validCounter(savedCheckpoint.epoch))
      throw new Error("Hybrid workspace checkpoint state is invalid.");
    // A restarted coordinator has not re-admitted a prepared tree or its writer
    // boundary. Reuse verified content only; never trust an old mutable path.
    latest = { revision: savedCheckpoint.revision, epoch: savedCheckpoint.epoch,
      manifest: validateWorkspaceManifest(savedCheckpoint.manifest, options.workspace.roots) };
  }
  let epoch = Math.max(savedPlacement?.epoch ?? 0, latest?.epoch ?? 0) + 1;
  let revision = 0, busy = false, uncertain = false, online = false, connected = false;
  let supported: boolean | undefined, acknowledged = false, closed = false, transitioning = false;
  let sticky = !!savedPlacement && savedPlacement.phase !== "laptop";
  let location: "laptop" | "cloud" = sticky ? "cloud" : "laptop";
  let failure = sticky ? "A previous cloud handoff requires recovery before execution can continue." : undefined;
  let preparationProblem: string | undefined;
  let cloud: Awaited<ReturnType<typeof startCloudExecutor>> | undefined;
  let cloudWorkspace: { cwd: string; roots: string[] } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let reconnectDeadline = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  let state: ExecutionState;

  const checkpoint = (): ExecutionState["checkpoint"] => latest && ({ id: latest.manifest.id, capturedAt: latest.manifest.capturedAt });
  const record = (data: Record<string, unknown>) => { if (!closed) options.record(data); };
  const blocker = (): string | undefined => {
    if (failure) return failure;
    if (uncertain) return "A laptop operation has an uncertain outcome; reconcile it before cloud continuation.";
    if (busy) return "A laptop operation is still active; cloud continuation is paused.";
    if (supported !== true) return supported === false
      ? "This Codex backend does not support automatic executor handoff."
      : "Provider executor handoff qualification is pending.";
    if (!latest || !acknowledged) return preparationProblem ?? "No verified workspace checkpoint has been acknowledged in this connection.";
    if (latest.revision !== revision) return "Completed laptop operations are not yet covered by the cloud checkpoint.";
    return undefined;
  };
  const publish = () => {
    if (closed) return;
    const reason = blocker();
    const next: ExecutionState = location === "cloud"
      ? { location, state: failure ? "paused" : "online", cloudReady: !failure, checkpoint: checkpoint(),
        ...(failure ? { reason: failure } : {}), ...(online ? { reconciliation: "available" as const } : {}) }
      : { location, state: transitioning ? "preparing" : online ? "online" : connected ? "paused" : "connecting",
        cloudReady: !reason && !transitioning, checkpoint: checkpoint(), ...(reason ? { reason } : {}) };
    if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; options.publish(next); }
  };
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => {
      if (closed) throw new Error("Hybrid workspace is closed.");
      const value = await action();
      if (closed) throw new Error("Hybrid workspace is closed.");
      return value;
    });
    tail = result.catch(() => {});
    return result;
  };
  const placement = async (phase: Placement["phase"]) => {
    await durableJson(directory, "placement.json", { epoch, phase, checkpoint: checkpoint() } satisfies Placement);
  };

  async function handoff(): Promise<void> {
    if (closed || online || !connected || sticky || transitioning || blocker()) { publish(); return; }
    if (Date.now() < reconnectDeadline) return;
    transitioning = true; sticky = true; epoch += 1; publish();
    const selected = latest!;
    const unchanged = () => {
      if (revision !== selected.revision || busy || uncertain || supported !== true) {
        stage = "verifying the unchanged laptop execution boundary";
        throw new Error("The laptop execution boundary changed during cloud preparation.");
      }
    };
    let stage = "recording the handoff intent";
    try {
      await placement("selecting");
      if (closed) return;
      unchanged();
      record({ action: "cloud-handoff-intent", epoch, checkpoint: selected.manifest.id });
      stage = "opening the prepared workspace";
      if (!selected.tree) throw new Error("The checkpoint has no prepared execution tree");
      const prepared = { cwd: selected.tree.cwd, roots: selected.tree.roots };
      cloudWorkspace = prepared;
      if (closed) return;
      unchanged();
      if (options.sharedWorkspace) {
        // Inactive generations and their parent stay private during preparation.
        // Expose just the selected tree after all host writes have finished.
        await chmod(selected.tree.directory, 0o2770);
        await chmod(dataDirectory, 0o2750);
      }
      stage = "starting the cloud executor";
      const executor = await startCloudExecutor({ cwd: prepared.cwd, command: options.command, commandArgs: options.commandArgs });
      if (closed) { await executor.close(); return; }
      cloud = executor;
      void executor.exited.then(() => {
        if (closed || cloud !== executor) return;
        failure = "The cloud executor stopped. Execution is paused; no operation was replayed.";
        record({ action: "cloud-executor-stopped", epoch });
        void placement("failed").catch(() => {});
        publish();
      });
      unchanged();
      stage = "selecting the cloud environment";
      await options.select({ ...executor.environment, roots: prepared.roots });
      if (closed) return;
      location = "cloud";
      stage = "recording the selected cloud environment";
      await placement("cloud");
      if (closed) return;
      record({ action: "cloud-handoff-selected", epoch, checkpoint: selected.manifest.id });
    } catch {
      if (closed) return;
      location = "cloud";
      failure = `Cloud handoff failed while ${stage}; recovery is required and no operation was replayed.`;
      await placement("failed").catch(() => {});
      record({ action: "cloud-handoff-paused", epoch, reason: failure });
    } finally { transitioning = false; publish(); }
  }
  const schedule = () => { void enqueue(handoff).catch(() => {}); };

  await placement(sticky ? savedPlacement!.phase : "laptop");
  publish();
  return {
    control(method: string, params: any): Promise<any> {
      return enqueue(async () => {
        if (method === "sync/status") { publish(); return { ...state, revision, epoch }; }
        if (method === "sync/problem") {
          if (typeof params?.reason !== "string" || !params.reason.trim())
            throw new Error("A workspace preparation problem requires a reason.");
          if (!sticky && location === "laptop") {
            preparationProblem = params.reason.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 300);
            publish();
          }
          return { received: true };
        }
        if (method === "sync/has") {
          if (!Array.isArray(params?.hashes) || params.hashes.length > 512)
            throw new Error("A blob presence request must contain at most 512 hashes.");
          return { missing: await hasWorkspaceBlobs(storeDir, params.hashes) };
        }
        if (method === "sync/blob") {
          if (params?.base64 === undefined) return { base64: await readWorkspaceBlob(storeDir, params?.hash) };
          await putWorkspaceBlob(storeDir, params?.hash, params.base64);
          return { stored: true };
        }
        if (method === "sync/begin") {
          if (sticky || location !== "laptop" || transitioning || busy || uncertain || !online)
            throw new Error("A laptop checkpoint cannot begin in the current execution state.");
          const startedRevision = revision;
          epoch += 1;
          await placement("laptop");
          if (closed || !online || busy || uncertain || revision !== startedRevision)
            throw new Error("Laptop activity changed before checkpoint capture began.");
          return { revision, epoch };
        }
        if (method === "sync/commit") {
          const current = () => !closed && !sticky && location === "laptop" && !transitioning && online && !busy && !uncertain &&
            params?.revision === revision && params?.epoch === epoch;
          if (!current()) throw new Error("The laptop checkpoint belongs to a stale execution boundary.");
          if (Buffer.byteLength(JSON.stringify(params?.manifest) ?? "") > MAX_MANIFEST_BYTES)
            throw new Error("The workspace manifest exceeds the checkpoint size limit.");
          const manifest = validateWorkspaceManifest(params?.manifest, options.workspace.roots);
          if (resolve(manifest.roots[manifest.cwd.root], manifest.cwd.path) !== resolve(options.workspace.cwd))
            throw new Error("The checkpoint does not preserve the selected working directory.");
          const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
          if ((await hasWorkspaceBlobs(storeDir, hashes)).length)
            throw new Error("The checkpoint references missing or corrupt file content.");
          if (!current()) throw new Error("Laptop activity changed while checkpoint content was verified.");
          const previous = latest;
          const destination = join(dataDirectory, `prepared-${epoch}-${randomUUID()}`);
          let published = false;
          try {
            const tree = await materializeWorkspace({ manifest, storeDir, destination, sharedGroup: options.sharedWorkspace,
              ...(previous?.tree ? { previous: { manifest: previous.manifest, roots: previous.tree.roots } } : {}) });
            if (!current()) throw new Error("Laptop activity changed while the execution tree was prepared.");
            const candidate: Checkpoint = { revision, epoch, manifest, tree: { ...tree, directory: destination } };
            await durableJson(directory, "checkpoint.json", candidate);
            // New activity after this durable boundary simply makes the stored
            // revision ineligible. Keep its complete tree and receipt together.
            latest = candidate; acknowledged = true; preparationProblem = undefined; published = true;
          } finally {
            if (!published) await rm(destination, { recursive: true, force: true }).catch(() => {});
          }
          // Only inactive preparation trees share unchanged inodes. CAS and the
          // baseline manifest remain available after cloud files become writable.
          if (previous?.tree) await rm(previous.tree.directory, { recursive: true, force: true }).catch(() => {});
          record({ action: "workspace-checkpoint-published", epoch, revision, checkpoint: manifest.id, capturedAt: manifest.capturedAt });
          publish();
          return { checkpoint: checkpoint(), epoch };
        }
        if (method === "sync/export") {
          if (location !== "cloud" || !cloudWorkspace || transitioning || failure)
            throw new Error("A cloud workspace is not available for reconciliation.");
          const manifest = await captureWorkspace({ ...cloudWorkspace, storeDir, signal: abort.signal });
          if (closed) throw new Error("Hybrid workspace is closed.");
          await durableJson(directory, "export.json", { epoch, manifest });
          record({ action: "cloud-checkpoint-exported", epoch, checkpoint: manifest.id, capturedAt: manifest.capturedAt });
          return { manifest, epoch };
        }
        throw new Error("Unsupported workspace synchronization operation.");
      });
    },
    connection(value: boolean): void {
      if (closed) return;
      const changed = online !== value;
      online = value; connected ||= value;
      clearTimeout(reconnectTimer);
      if (!value && changed) {
        reconnectDeadline = Date.now() + 5000;
        reconnectTimer = setTimeout(schedule, 5000);
        reconnectTimer.unref();
      }
      if (changed) record({ action: value ? "laptop-executor-connected" : "laptop-executor-disconnected", epoch });
      publish(); if (!value) schedule();
    },
    activity(stats: { revision: number; busy: boolean; uncertain: boolean }): void {
      if (closed || (sticky && !transitioning)) return;
      if (!validCounter(stats.revision) || stats.revision < revision) {
        uncertain = true;
      } else { revision = stats.revision; busy = stats.busy; uncertain ||= stats.uncertain; }
      publish(); if (!online) schedule();
    },
    providerReady(value: boolean): void {
      if (closed) return;
      supported = value; publish(); if (!online) schedule();
    },
    close(): void {
      if (closed) return;
      closed = true; epoch += 1; abort.abort(); clearTimeout(reconnectTimer);
      void cloud?.close().catch(() => {});
    },
  };
}
