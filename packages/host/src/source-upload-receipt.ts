import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HttpError } from "./client-api.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UNCERTAIN_UPLOAD_ERROR = "A prior source upload has an uncertain result. Inspect the cloud project before attempting another capture.";
export const CONCURRENT_UPLOAD_ERROR = "Another repo init source upload is already in progress for this checkout.";

export type SourceUploadPhase = "preparing" | "committing";

export interface SourceUploadReceiptRecord {
  requestId: string;
  body: { requestId: string; projectId: string; commit: string };
  createdAt: string;
  state: "pending" | "pending-apply" | "confirmed";
  phase?: SourceUploadPhase;
  attemptId?: string;
  publisherId?: string;
  manifestId?: string;
  pendingReason?: string;
}

export interface SourceUploadLockRecord {
  attemptId: string;
  pid: number;
  startedAt: string;
}

export interface SourceUploadAttempt {
  readonly attemptId: string;
  readonly publisherId: string;
  recordCaptured(manifestId: string): void;
  markBeginAttempted(): void;
  markBeginRejected(error: unknown): void;
  markCommitting(): void;
  markCommitCompleted(): void;
  markPendingApply(reason: string): void;
  markConfirmed(): void;
  handleFailure(error: unknown): void;
  release(): void;
}

export type SourceUploadStartResult =
  | { kind: "confirmed" }
  | { kind: "attempt"; attempt: SourceUploadAttempt };

const activeLocks = new Set<string>();

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultLockAlive(lock: SourceUploadLockRecord): boolean {
  return lock.pid === process.pid ? activeLocks.has(lock.attemptId) : processAlive(lock.pid);
}

function readJson(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Private CLI state is unreadable; preserve it and inspect the file before retrying.");
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readLock(path: string): SourceUploadLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SourceUploadLockRecord>;
    if (typeof parsed.attemptId === "string" && parsed.attemptId && typeof parsed.pid === "number") {
      return { attemptId: parsed.attemptId, pid: parsed.pid, startedAt: String(parsed.startedAt ?? "") };
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export function sourceUploadLockPath(receiptsPath: string, uploadKey: string): string {
  const hash = createHash("sha256").update(uploadKey).digest("hex");
  return join(dirname(receiptsPath), "source-upload-locks", `${hash}.lock`);
}

function acquireLock(lockPath: string, attemptId: string, isLockAlive: (lock: SourceUploadLockRecord) => boolean): void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ attemptId, pid: process.pid, startedAt: new Date().toISOString() }) + "\n";
  for (let round = 0; round < 3; round++) {
    try {
      writeFileSync(lockPath, payload, { flag: "wx", mode: 0o600 });
      activeLocks.add(attemptId);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = readLock(lockPath);
    if (existing && isLockAlive(existing)) throw new Error(CONCURRENT_UPLOAD_ERROR);
    const stale = `${lockPath}.stale.${randomUUID()}`;
    try {
      renameSync(lockPath, stale);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const moved = readLock(stale);
    if (moved && isLockAlive(moved)) {
      try { renameSync(stale, lockPath); } catch {}
      throw new Error(CONCURRENT_UPLOAD_ERROR);
    }
    rmSync(stale, { force: true });
  }
  throw new Error(CONCURRENT_UPLOAD_ERROR);
}

function releaseLock(lockPath: string, attemptId: string): void {
  activeLocks.delete(attemptId);
  const current = readLock(lockPath);
  if (current?.attemptId === attemptId) rmSync(lockPath, { force: true });
}

export function deactivateLockForTest(attemptId: string): void {
  activeLocks.delete(attemptId);
}

export async function beginSourceUploadAttempt(params: {
  receiptsPath: string;
  uploadKey: string;
  requestId: string;
  projectId: string;
  commit: string;
  confirmEmptyBegin: (publisherId: string) => Promise<{ generation: string; emptyConfirmed?: boolean }>;
  isLockAlive?: (lock: SourceUploadLockRecord) => boolean;
}): Promise<SourceUploadStartResult> {
  const { receiptsPath, uploadKey, requestId, projectId, commit, confirmEmptyBegin } = params;
  const isLockAlive = params.isLockAlive ?? defaultLockAlive;
  const lockPath = sourceUploadLockPath(receiptsPath, uploadKey);
  const attemptId = randomUUID();
  acquireLock(lockPath, attemptId, isLockAlive);
  let handedOff = false;
  try {
    const records = readJson(receiptsPath);
    const prior = records[uploadKey] as SourceUploadReceiptRecord | undefined;
    if (prior?.state === "confirmed") return { kind: "confirmed" };
    let publisherId: string;
    let initialGeneration: string | undefined;
    let reusedPublisher = false;
    if (!prior) {
      publisherId = randomUUID();
    } else if (prior.state === "pending" && prior.phase === "preparing") {
      if (prior.publisherId && UUID_RE.test(prior.publisherId)) {
        publisherId = prior.publisherId;
        reusedPublisher = true;
      } else {
        publisherId = randomUUID();
      }
    } else if (prior.state === "pending" && prior.phase === undefined) {
      publisherId = prior.publisherId && UUID_RE.test(prior.publisherId) ? prior.publisherId : randomUUID();
      let reply: { generation: string; emptyConfirmed?: boolean };
      try {
        reply = await confirmEmptyBegin(publisherId);
      } catch {
        throw new Error(UNCERTAIN_UPLOAD_ERROR);
      }
      if (!reply.emptyConfirmed || !UUID_RE.test(reply.generation)) throw new Error(UNCERTAIN_UPLOAD_ERROR);
      initialGeneration = reply.generation;
    } else {
      throw new Error(UNCERTAIN_UPLOAD_ERROR);
    }

    const updated = readJson(receiptsPath);
    updated[uploadKey] = {
      requestId,
      body: { requestId, projectId, commit },
      createdAt: prior?.createdAt ?? new Date().toISOString(),
      state: "pending",
      phase: "preparing",
      attemptId,
      publisherId,
      ...(prior?.manifestId ? { manifestId: prior.manifestId } : {}),
    } satisfies SourceUploadReceiptRecord;
    writeJson(receiptsPath, updated);

    let leaseMayExist = reusedPublisher || initialGeneration !== undefined;
    let commitAttempted = false;
    let commitCompleted = false;
    let released = false;

    const updateOwned = (mutate: (current: SourceUploadReceiptRecord) => SourceUploadReceiptRecord | undefined) => {
      const latest = readJson(receiptsPath);
      const current = latest[uploadKey] as SourceUploadReceiptRecord | undefined;
      if (!current || current.state !== "pending" || current.attemptId !== attemptId) {
        throw new Error("Source upload receipt ownership was lost.");
      }
      const next = mutate(current);
      if (next === undefined) delete latest[uploadKey];
      else latest[uploadKey] = next;
      writeJson(receiptsPath, latest);
    };

    const attempt: SourceUploadAttempt = {
      attemptId,
      publisherId,
      recordCaptured(manifestId: string) {
        updateOwned(current => ({ ...current, state: "pending", phase: "preparing", manifestId }));
      },
      markBeginAttempted() {
        leaseMayExist = true;
      },
      markBeginRejected(error: unknown) {
        if (error instanceof HttpError && [400, 401, 403, 404, 409, 413].includes(error.status)) {
          leaseMayExist = false;
        }
      },
      markCommitting() {
        commitAttempted = true;
        updateOwned(current => {
          if (current.phase !== "preparing") throw new Error("Source upload receipt is not in preparing phase.");
          return { ...current, state: "pending", phase: "committing" };
        });
      },
      markCommitCompleted() {
        commitCompleted = true;
      },
      markPendingApply(reason: string) {
        updateOwned(current => ({ ...current, state: "pending-apply", pendingReason: reason }));
      },
      markConfirmed() {
        updateOwned(current => ({ ...current, state: "confirmed" }));
      },
      handleFailure(error: unknown) {
        if (commitAttempted) {
          if (commitCompleted || !(error instanceof HttpError)) return;
          const keepLeaseRefusal = (error.status === 400 && error.code === "invalid-manifest")
            || error.status === 413
            || (error.status === 409 && error.code === "missing-content");
          if (keepLeaseRefusal) {
            updateOwned(current => ({ ...current, state: "pending", phase: "preparing" }));
            return;
          }
          const clearLeaseRefusal = [400, 401, 403, 404].includes(error.status)
            || (error.status === 409 && ["stale-generation", "source-github"].includes(error.code ?? ""));
          if (clearLeaseRefusal) updateOwned(() => undefined);
          return;
        }
        if (!leaseMayExist) updateOwned(() => undefined);
      },
      release() {
        if (released) return;
        released = true;
        releaseLock(lockPath, attemptId);
      },
    };
    handedOff = true;
    return { kind: "attempt", attempt };
  } finally {
    if (!handedOff) releaseLock(lockPath, attemptId);
  }
}
