import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { startCloudExecutor } from "./cloud-executor.js";
import {
  captureWorkspace, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob,
  readWorkspaceBlob, validateWorkspaceManifest, type WorkspaceManifest, type WorkspaceStoreTarget,
} from "./workspace-checkpoint.js";
import { createWorkspaceTransferPool } from "./workspace-transfer.js";
import type { ExecutionState, LaptopWorkspace } from "./types.js";

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
type Checkpoint = { revision: number; epoch: number; manifest: WorkspaceManifest; tree?: { directory: string; cwd: string; roots: string[] } };
type Placement = { epoch: number; phase: "laptop" | "selecting" | "cloud" | "failed"; checkpoint?: ExecutionState["checkpoint"] };
type Execution = { environmentId: string; url: string; token: string; cwd: string; roots: string[] };
type CloudExecutor = Awaited<ReturnType<typeof startCloudExecutor>>;
type CloudWorkspace = { cwd: string; roots: string[] };
type LaptopBoundary = {
  revision: number;
  busy: boolean;
  uncertain: boolean;
  online: boolean;
  connected: boolean;
  supported: boolean | undefined;
  acknowledged: boolean;
};
type WorkspacePhase =
  | (LaptopBoundary & {
      kind: "laptop";
      preparationProblem?: string;
      reconnectDeadline: number;
      reconnectTimer?: ReturnType<typeof setTimeout>;
    })
  | (LaptopBoundary & {
      kind: "selecting";
      cloud?: CloudExecutor;
      cloudWorkspace?: CloudWorkspace;
    })
  | {
      kind: "cloud";
      revision: number;
      online: boolean;
      acknowledged: boolean;
      cloud: CloudExecutor;
      cloudWorkspace: CloudWorkspace;
    }
  | {
      kind: "failed";
      revision: number;
      online: boolean;
      acknowledged: boolean;
      reason: string;
      cloud?: CloudExecutor;
    }
  | {
      kind: "closed";
      closePromise: Promise<void>;
    };

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
  sharedPoolDirectory?: string;
  egress?: Record<string, string>;
}) {
  const directory = resolve(options.directory), scopeDirectory = join(directory, "blobs");
  const storeDir: WorkspaceStoreTarget = options.sharedPoolDirectory
    ? { directory: scopeDirectory, sharedPoolDirectory: options.sharedPoolDirectory } : scopeDirectory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) ||
      (process.getuid && directoryInfo.uid !== process.getuid()))
    throw new Error("Hybrid workspace state requires a private owner-controlled directory.");
  await mkdir(scopeDirectory, { recursive: true, mode: 0o700 });
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
    latest = { revision: savedCheckpoint.revision, epoch: savedCheckpoint.epoch,
      manifest: validateWorkspaceManifest(savedCheckpoint.manifest, options.workspace.roots) };
  }
  let epoch = Math.max(savedPlacement?.epoch ?? 0, latest?.epoch ?? 0) + 1;
  const stickyAtStart = !!savedPlacement && savedPlacement.phase !== "laptop";
  let phase: WorkspacePhase = stickyAtStart
    ? {
        kind: "failed",
        revision: 0,
        online: false,
        acknowledged: false,
        reason: "A previous cloud handoff requires recovery before execution can continue.",
      }
    : {
        kind: "laptop",
        revision: 0,
        busy: false,
        uncertain: false,
        online: false,
        connected: false,
        supported: undefined,
        acknowledged: false,
        reconnectDeadline: 0,
      };
  let tail: Promise<unknown> = Promise.resolve();
  const blobTransfers = createWorkspaceTransferPool();
  const admittedBlobs = new Set<Promise<unknown>>();
  const abort = new AbortController();
  let state: ExecutionState;

  const checkpoint = (): ExecutionState["checkpoint"] => latest && ({ id: latest.manifest.id, capturedAt: latest.manifest.capturedAt });
  const record = (data: Record<string, unknown>) => { if (phase.kind !== "closed") options.record(data); };
  const laptopBlocker = (current: Extract<WorkspacePhase, { kind: "laptop" | "selecting" }>): string | undefined => {
    if (current.uncertain) return "A laptop operation has an uncertain outcome; reconcile it before cloud continuation.";
    if (current.busy) return "A laptop operation is still active; cloud continuation is paused.";
    if (current.supported !== true) return current.supported === false
      ? "This Codex backend does not support automatic executor handoff."
      : "Provider executor handoff qualification is pending.";
    if (!latest || !current.acknowledged) {
      return (current.kind === "laptop" ? current.preparationProblem : undefined)
        ?? "No verified workspace checkpoint has been acknowledged in this connection.";
    }
    if (latest.revision !== current.revision) return "Completed laptop operations are not yet covered by the cloud checkpoint.";
    return undefined;
  };
  const publish = () => {
    if (phase.kind === "closed") return;
    let next: ExecutionState;
    if (phase.kind === "cloud") {
      next = {
        location: "cloud",
        state: "online",
        cloudReady: true,
        checkpoint: checkpoint(),
        ...(phase.online ? { reconciliation: "available" as const } : {}),
      };
    } else if (phase.kind === "failed") {
      next = {
        location: "cloud",
        state: "paused",
        cloudReady: false,
        checkpoint: checkpoint(),
        reason: phase.reason,
        ...(phase.online ? { reconciliation: "available" as const } : {}),
      };
    } else {
      const reason = laptopBlocker(phase);
      const transitioning = phase.kind === "selecting";
      next = {
        location: "laptop",
        state: transitioning ? "preparing" : phase.online ? "online" : phase.connected ? "paused" : "connecting",
        cloudReady: !reason && !transitioning,
        checkpoint: checkpoint(),
        ...(reason ? { reason } : {}),
      };
    }
    if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; options.publish(next); }
  };
  const currentPhase = (): WorkspacePhase => phase;
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const precedingBlobs = [...admittedBlobs];
    const result = tail.then(async () => {
      if (currentPhase().kind === "closed") throw new Error("Hybrid workspace is closed.");
      await Promise.allSettled(precedingBlobs);
      if (currentPhase().kind === "closed") throw new Error("Hybrid workspace is closed.");
      const value = await action();
      if (currentPhase().kind === "closed") throw new Error("Hybrid workspace is closed.");
      return value;
    });
    tail = result.catch(() => {});
    return result;
  };
  const enqueueBlob = (params: any): Promise<{ base64: string } | { stored: true }> => {
    if (currentPhase().kind === "closed") return Promise.reject(new Error("Hybrid workspace is closed."));
    const previous = tail;
    const operation = previous.then(async () => {
      if (currentPhase().kind === "closed") throw new Error("Hybrid workspace is closed.");
      return blobTransfers.run(async () => {
        if (currentPhase().kind === "closed") throw new Error("Hybrid workspace is closed.");
        const result = params?.base64 === undefined
          ? { base64: await readWorkspaceBlob(storeDir, params?.hash) }
          : (await putWorkspaceBlob(storeDir, params?.hash, params.base64), { stored: true as const });
        if (currentPhase().kind === "closed") throw new Error("Hybrid workspace is closed.");
        return result;
      });
    });
    admittedBlobs.add(operation);
    operation.then(() => admittedBlobs.delete(operation), () => admittedBlobs.delete(operation));
    return operation;
  };
  const placement = async (nextPhase: Placement["phase"]) => {
    await durableJson(directory, "placement.json", { epoch, phase: nextPhase, checkpoint: checkpoint() } satisfies Placement);
  };

  async function handoff(): Promise<void> {
    if (phase.kind !== "laptop" || phase.online || !phase.connected || laptopBlocker(phase)) { publish(); return; }
    const remaining = phase.reconnectDeadline - Date.now();
    if (remaining > 0) {
      clearTimeout(phase.reconnectTimer);
      const timer = setTimeout(schedule, remaining);
      timer.unref();
      phase.reconnectTimer = timer;
      return;
    }
    clearTimeout(phase.reconnectTimer);
    phase = {
      kind: "selecting",
      revision: phase.revision,
      busy: phase.busy,
      uncertain: phase.uncertain,
      online: phase.online,
      connected: phase.connected,
      supported: phase.supported,
      acknowledged: phase.acknowledged,
    };
    epoch += 1;
    publish();
    const selected = latest!;
    const unchanged = () => {
      if (phase.kind !== "selecting" || phase.revision !== selected.revision || phase.busy || phase.uncertain || phase.supported !== true) {
        stage = "verifying the unchanged laptop execution boundary";
        throw new Error("The laptop execution boundary changed during cloud preparation.");
      }
    };
    let stage = "recording the handoff intent";
    try {
      await placement("selecting");
      if (phase.kind !== "selecting") return;
      unchanged();
      record({ action: "cloud-handoff-intent", epoch, checkpoint: selected.manifest.id });
      stage = "opening the prepared workspace";
      if (!selected.tree) throw new Error("The checkpoint has no prepared execution tree");
      const prepared = { cwd: selected.tree.cwd, roots: selected.tree.roots };
      phase.cloudWorkspace = prepared;
      if (phase.kind !== "selecting") return;
      unchanged();
      if (options.sharedWorkspace) {
        await chmod(selected.tree.directory, 0o2770);
        await chmod(dataDirectory, 0o2750);
      }
      stage = "starting the cloud executor";
      const executor = await startCloudExecutor({ cwd: prepared.cwd, command: options.command, commandArgs: options.commandArgs, egress: options.egress });
      if (phase.kind !== "selecting") { await executor.close(); return; }
      phase.cloud = executor;
      void executor.exited.then(() => {
        if ((phase.kind !== "selecting" && phase.kind !== "cloud") || phase.cloud !== executor) return;
        const reason = "The cloud executor stopped. Execution is paused; no operation was replayed.";
        phase = { kind: "failed", revision: phase.revision, online: phase.online, acknowledged: phase.acknowledged, reason, cloud: executor };
        record({ action: "cloud-executor-stopped", epoch });
        void placement("failed").catch(() => {});
        publish();
      });
      unchanged();
      stage = "selecting the cloud environment";
      await options.select({ ...executor.environment, roots: prepared.roots });
      if (phase.kind !== "selecting") return;
      stage = "recording the selected cloud environment";
      await placement("cloud");
      if (phase.kind !== "selecting") return;
      phase = {
        kind: "cloud",
        revision: phase.revision,
        online: phase.online,
        acknowledged: phase.acknowledged,
        cloud: executor,
        cloudWorkspace: prepared,
      };
      record({ action: "cloud-handoff-selected", epoch, checkpoint: selected.manifest.id });
    } catch {
      const latestPhase = currentPhase();
      if (latestPhase.kind === "closed") return;
      const reason = `Cloud handoff failed while ${stage}; recovery is required and no operation was replayed.`;
      const activeCloud = latestPhase.kind === "selecting" || latestPhase.kind === "failed" || latestPhase.kind === "cloud" ? latestPhase.cloud : undefined;
      phase = {
        kind: "failed",
        revision: latestPhase.revision,
        online: latestPhase.online,
        acknowledged: latestPhase.acknowledged,
        reason,
        ...(activeCloud ? { cloud: activeCloud } : {}),
      };
      await placement("failed").catch(() => {});
      record({ action: "cloud-handoff-paused", epoch, reason });
    } finally { publish(); }
  }
  const schedule = () => { void enqueue(handoff).catch(() => {}); };

  await placement(stickyAtStart ? savedPlacement!.phase : "laptop");
  publish();
  return {
    control(method: string, params: any): Promise<any> {
      if (phase.kind === "closed") return Promise.reject(new Error("Hybrid workspace is closed."));
      if (method === "sync/blob") return enqueueBlob(params);
      return enqueue(async () => {
        if (phase.kind === "closed") throw new Error("Hybrid workspace is closed.");
        if (method === "sync/status") { publish(); return { ...state, revision: phase.revision, epoch, acknowledged: phase.acknowledged }; }
        if (method === "sync/problem") {
          if (typeof params?.reason !== "string" || !params.reason.trim())
            throw new Error("A workspace preparation problem requires a reason.");
          if (phase.kind === "laptop") {
            phase.preparationProblem = params.reason.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 300);
            publish();
          }
          return { received: true };
        }
        if (method === "sync/has") {
          if (!Array.isArray(params?.hashes) || params.hashes.length > 512)
            throw new Error("A blob presence request must contain at most 512 hashes.");
          return { missing: await hasWorkspaceBlobs(storeDir, params.hashes) };
        }
        if (method === "sync/begin") {
          if (phase.kind !== "laptop" || phase.busy || phase.uncertain || !phase.online)
            throw new Error("A laptop checkpoint cannot begin in the current execution state.");
          const startedRevision = phase.revision;
          epoch += 1;
          await placement("laptop");
          if (phase.kind !== "laptop" || !phase.online || phase.busy || phase.uncertain || phase.revision !== startedRevision)
            throw new Error("Laptop activity changed before checkpoint capture began.");
          return { revision: phase.revision, epoch };
        }
        if (method === "sync/commit") {
          const current = () => phase.kind === "laptop" && phase.online && !phase.busy && !phase.uncertain &&
            params?.revision === phase.revision && params?.epoch === epoch;
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
            const candidate: Checkpoint = { revision: phase.revision, epoch, manifest, tree: { ...tree, directory: destination } };
            await durableJson(directory, "checkpoint.json", candidate);
            if (phase.kind !== "laptop") throw new Error("Hybrid workspace is no longer in laptop phase.");
            latest = candidate;
            phase.acknowledged = true;
            phase.preparationProblem = undefined;
            published = true;
          } finally {
            if (!published) await rm(destination, { recursive: true, force: true }).catch(() => {});
          }
          if (previous?.tree) await rm(previous.tree.directory, { recursive: true, force: true }).catch(() => {});
          record({ action: "workspace-checkpoint-published", epoch, revision: phase.revision, checkpoint: manifest.id, capturedAt: manifest.capturedAt });
          publish();
          return { checkpoint: checkpoint(), epoch };
        }
        if (method === "sync/export") {
          if (phase.kind !== "cloud")
            throw new Error("A cloud workspace is not available for reconciliation.");
          const manifest = await captureWorkspace({ ...phase.cloudWorkspace, storeDir, signal: abort.signal });
          if (currentPhase().kind === "closed") throw new Error("Hybrid workspace is closed.");
          await durableJson(directory, "export.json", { epoch, manifest });
          record({ action: "cloud-checkpoint-exported", epoch, checkpoint: manifest.id, capturedAt: manifest.capturedAt });
          return { manifest, epoch };
        }
        throw new Error("Unsupported workspace synchronization operation.");
      });
    },
    connection(value: boolean): void {
      if (phase.kind === "closed") return;
      const changed = phase.online !== value;
      phase.online = value;
      if (phase.kind === "laptop" || phase.kind === "selecting") phase.connected ||= value;
      if (phase.kind === "laptop") {
        if (changed) {
          clearTimeout(phase.reconnectTimer);
          phase.reconnectTimer = undefined;
        }
        if (!value && changed) {
          phase.reconnectDeadline = Date.now() + 5000;
          const timer = setTimeout(schedule, 5000);
          timer.unref();
          phase.reconnectTimer = timer;
        }
      }
      if (changed) record({ action: value ? "laptop-executor-connected" : "laptop-executor-disconnected", epoch });
      publish();
      if (!value) schedule();
    },
    activity(stats: { revision: number; busy: boolean; uncertain: boolean }): void {
      if (phase.kind !== "laptop" && phase.kind !== "selecting") return;
      if (!validCounter(stats.revision) || stats.revision < phase.revision) {
        phase.uncertain = true;
      } else {
        phase.revision = stats.revision;
        phase.busy = stats.busy;
        phase.uncertain ||= stats.uncertain;
      }
      publish();
      if (!phase.online) schedule();
    },
    providerReady(value: boolean): void {
      if (phase.kind === "closed") return;
      if (phase.kind === "laptop" || phase.kind === "selecting") phase.supported = value;
      publish();
      if (!phase.online) schedule();
    },
    close(): Promise<void> {
      if (phase.kind === "closed") return phase.closePromise;
      if (phase.kind === "laptop") clearTimeout(phase.reconnectTimer);
      const activeCloud = phase.kind === "cloud" || phase.kind === "selecting" || phase.kind === "failed" ? phase.cloud : undefined;
      epoch += 1;
      abort.abort();
      const closePromise = (async () => {
        await Promise.allSettled([...admittedBlobs]);
        await tail;
        await blobTransfers.drain();
        await activeCloud?.close().catch(() => {});
      })();
      phase = { kind: "closed", closePromise };
      return closePromise;
    },
  };
}
