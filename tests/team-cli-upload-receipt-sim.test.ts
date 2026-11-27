import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { HttpError } from "../packages/host/src/client-api.js";
import { hashToken } from "../packages/host/src/config.js";
import { ProjectSync, ProjectSyncError } from "../packages/host/src/project-sync.js";
import {
  beginSourceUploadAttempt,
  CONCURRENT_UPLOAD_ERROR,
  deactivateLockForTest,
  sourceUploadLockPath,
  UNCERTAIN_UPLOAD_ERROR,
  type SourceUploadAttempt,
  type SourceUploadReceiptRecord,
} from "../packages/host/src/source-upload-receipt.js";
import type { Config } from "../packages/host/src/types.js";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";

const DEFAULT_SEEDS = 20;
const ONLY = process.env.UPLOAD_RECEIPT_SIM_SEED;
const COUNT = Number(process.env.UPLOAD_RECEIPT_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.UPLOAD_RECEIPT_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "UPLOAD_RECEIPT_SIM_SEED, UPLOAD_RECEIPT_SIM_SEEDS, and UPLOAD_RECEIPT_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

type InvariantId =
  | "I1_LIVE_ATTEMPT_FENCED_FROM_COMPETING_ATTEMPT"
  | "I2_PRE_COMMIT_RETRY_REUSES_PUBLISHER_AND_RESUMES_LEASE"
  | "I3_COMMITTING_RECEIPT_NEVER_CLEARED_OR_RETRIED_ON_LOST_RESPONSE"
  | "I4_LEGACY_RECEIPT_REFUSED_DURING_ADMITTED_OR_RECEIVED_HOST_STATE"
  | "I5_RECEIPT_ALWAYS_VALID_WITH_STATE_AND_OWNER_GUARD";

class InvariantFailure extends Error {
  constructor(readonly invariant: InvariantId, message: string) {
    super(`${invariant}: ${message}`);
  }
}

type Rand = {
  next(): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
};

function createRand(seed: number): Rand {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: items => items[Math.floor(next() * items.length)]!, chance: p => next() < p };
}

function readReceipt(receiptsPath: string, uploadKey: string): SourceUploadReceiptRecord | undefined {
  if (!existsSync(receiptsPath)) return undefined;
  return (JSON.parse(readFileSync(receiptsPath, "utf8")) as Record<string, SourceUploadReceiptRecord>)[uploadKey];
}

function writeReceipt(receiptsPath: string, uploadKey: string, value: SourceUploadReceiptRecord | undefined): void {
  mkdirSync(join(receiptsPath, ".."), { recursive: true, mode: 0o700 });
  const records = existsSync(receiptsPath) ? JSON.parse(readFileSync(receiptsPath, "utf8")) as Record<string, SourceUploadReceiptRecord> : {};
  if (value === undefined) delete records[uploadKey];
  else records[uploadKey] = value;
  writeFileSync(receiptsPath, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
}

interface SimEnv {
  root: string;
  receiptsPath: string;
  uploadKey: string;
  sync: ProjectSync;
  manifest: Awaited<ReturnType<typeof captureWorkspace>>;
  storeDir: string;
  commitCount: number;
  cleanup(): void;
}

async function createEnv(seed: number, step: number): Promise<SimEnv> {
  const root = realpathSync(mkdtempSync("/tmp/inf-cli-receipt-sim-"));
  const laptop = join(root, "laptop");
  const cloud = join(root, "cloud");
  const storeDir = join(root, "laptop-store");
  mkdirSync(laptop, { recursive: true });
  mkdirSync(cloud, { recursive: true });
  writeFileSync(join(laptop, "README.md"), `seed=${seed} step=${step}\n`);
  const key = randomBytes(32);
  const keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0,
    origin: "http://127.0.0.1:1",
    stateDir: join(root, "state"),
    runDir: join(root, "run"),
    keyFile,
    environment: "local",
    enableDemo: true,
    maxSessions: 24,
    agents: {},
    projects: [{ id: "example", name: "Example", path: cloud }],
    tokens: [{ id: "o", label: "o", role: "owner", hash: hashToken("x".repeat(40)) }],
  };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const sync = new ProjectSync(config, key);
  const manifest = await captureWorkspace({ roots: [laptop], cwd: laptop, storeDir });
  return {
    root,
    receiptsPath: join(root, "cli", "receipts.json"),
    uploadKey: `http://127.0.0.1:1\n${laptop}:source-upload:example:${"a".repeat(40)}`,
    sync,
    manifest,
    storeDir,
    commitCount: 0,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function uploadChunks(env: SimEnv, publisherId: string, generation: string): Promise<void> {
  const writer = { deviceId: "owner", publisherId };
  const hashes = [...new Set(env.manifest.entries.flatMap(entry => entry.chunks ?? []))];
  for (const hash of await env.sync.missing("example", hashes, writer, generation)) {
    const bytes = Buffer.from(await readWorkspaceBlob(env.storeDir, hash), "base64");
    await env.sync.putBlob("example", hash, bytes, writer, generation);
  }
}

function assertValidReceipt(receipt: SourceUploadReceiptRecord | undefined, where: string): void {
  if (!receipt) return;
  if (!["pending", "pending-apply", "confirmed"].includes(receipt.state)) {
    throw new InvariantFailure("I5_RECEIPT_ALWAYS_VALID_WITH_STATE_AND_OWNER_GUARD", `${where}: receipt missing valid state (${JSON.stringify(receipt)})`);
  }
  if (receipt.state === "pending" && receipt.phase !== undefined && !["preparing", "committing"].includes(receipt.phase)) {
    throw new InvariantFailure("I5_RECEIPT_ALWAYS_VALID_WITH_STATE_AND_OWNER_GUARD", `${where}: receipt has invalid phase (${String(receipt.phase)})`);
  }
}

async function startAttempt(
  env: SimEnv,
  mutation?: InvariantId,
  options?: { olderHost?: boolean },
) {
  if (mutation === "I1_LIVE_ATTEMPT_FENCED_FROM_COMPETING_ATTEMPT") {
    rmSync(sourceUploadLockPath(env.receiptsPath, env.uploadKey), { force: true });
  }
  if (mutation === "I2_PRE_COMMIT_RETRY_REUSES_PUBLISHER_AND_RESUMES_LEASE") {
    const prior = readReceipt(env.receiptsPath, env.uploadKey);
    if (prior?.state === "pending" && prior.phase === "preparing" && prior.publisherId) {
      writeReceipt(env.receiptsPath, env.uploadKey, { ...prior, publisherId: randomUUID() });
    }
  }
  if (mutation === "I4_LEGACY_RECEIPT_REFUSED_DURING_ADMITTED_OR_RECEIVED_HOST_STATE") {
    const prior = readReceipt(env.receiptsPath, env.uploadKey);
    const liveStatus = await env.sync.liveStatus("example", async () => false);
    const emptyStatus = !liveStatus.lastSyncedAt && !liveStatus.lastSyncedManifest && !liveStatus.appliedManifest && !liveStatus.pendingGeneration;
    if (prior?.state === "pending" && prior.phase === undefined && emptyStatus) {
      writeReceipt(env.receiptsPath, env.uploadKey, undefined);
    }
  }
  return beginSourceUploadAttempt({
    receiptsPath: env.receiptsPath,
    uploadKey: env.uploadKey,
    requestId: randomUUID(),
    projectId: "example",
    commit: "a".repeat(40),
    confirmEmptyBegin: async publisherId => {
      if (options?.olderHost) return { generation: randomUUID() };
      return env.sync.begin("example", { deviceId: "owner", publisherId }, { expectEmpty: true });
    },
  });
}

async function runScenario(
  seed: number,
  step: number,
  scenario: "concurrent-live" | "pre-commit-retry" | "lost-commit-response" | "legacy-admitted-commit" | "legacy-host-first-upgrade" | "owner-guard",
  counts: Record<string, number>,
  mutation?: InvariantId,
): Promise<void> {
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const where = `seed=${seed} step=${step} (${scenario})`;
  const env = await createEnv(seed, step);
  try {
    if (scenario === "concurrent-live") {
      const first = await startAttempt(env);
      if (first.kind !== "attempt") throw new Error(`${where}: expected attempt`);
      const firstAttempt = first.attempt;
      firstAttempt.recordCaptured(env.manifest.id);
      firstAttempt.markBeginAttempted();
      const { generation } = await env.sync.begin("example", { deviceId: "owner", publisherId: firstAttempt.publisherId });
      await uploadChunks(env, firstAttempt.publisherId, generation);

      let blocked = false;
      try {
        const second = await startAttempt(env, mutation);
        if (second.kind === "attempt") {
          second.attempt.handleFailure(new HttpError(409, "sync-in-progress", "sync-in-progress"));
          second.attempt.release();
        }
      } catch (error) {
        if (error instanceof Error && error.message === CONCURRENT_UPLOAD_ERROR) blocked = true;
        else throw error;
      }
      if (!blocked) {
        throw new InvariantFailure("I1_LIVE_ATTEMPT_FENCED_FROM_COMPETING_ATTEMPT", `${where}: competing live attempt was not blocked`);
      }
      firstAttempt.markCommitting();
      assertValidReceipt(readReceipt(env.receiptsPath, env.uploadKey), where);
      const afterCommitMark = readReceipt(env.receiptsPath, env.uploadKey);
      if (afterCommitMark?.state !== "pending" || afterCommitMark.phase !== "committing" || afterCommitMark.attemptId !== firstAttempt.attemptId) {
        throw new InvariantFailure("I1_LIVE_ATTEMPT_FENCED_FROM_COMPETING_ATTEMPT", `${where}: owner receipt corrupted by competitor`);
      }
      firstAttempt.release();
      bump("concurrentFenced");
      return;
    }

    if (scenario === "pre-commit-retry") {
      const first = await startAttempt(env);
      if (first.kind !== "attempt") throw new Error(`${where}: expected attempt`);
      const firstAttempt = first.attempt;
      firstAttempt.recordCaptured(env.manifest.id);
      firstAttempt.markBeginAttempted();
      const begun = await env.sync.begin("example", { deviceId: "owner", publisherId: firstAttempt.publisherId });
      const firstPublisher = firstAttempt.publisherId;
      if (step % 2 === 0) {
        firstAttempt.handleFailure(new TypeError("lost begin response"));
        firstAttempt.release();
      } else {
        deactivateLockForTest(firstAttempt.attemptId);
      }
      assertValidReceipt(readReceipt(env.receiptsPath, env.uploadKey), `${where}:after-interrupt`);

      const retry = await startAttempt(env, mutation);
      if (retry.kind !== "attempt") throw new InvariantFailure("I2_PRE_COMMIT_RETRY_REUSES_PUBLISHER_AND_RESUMES_LEASE", `${where}: expected retry attempt`);
      const retryAttempt = retry.attempt;
      try {
        if (retryAttempt.publisherId !== firstPublisher) {
          throw new InvariantFailure("I2_PRE_COMMIT_RETRY_REUSES_PUBLISHER_AND_RESUMES_LEASE", `${where}: publisherId rotated from ${firstPublisher} to ${retryAttempt.publisherId}`);
        }
        retryAttempt.markBeginAttempted();
        const resumed = await env.sync.begin("example", { deviceId: "owner", publisherId: retryAttempt.publisherId });
        if (resumed.generation !== begun.generation) {
          throw new InvariantFailure("I2_PRE_COMMIT_RETRY_REUSES_PUBLISHER_AND_RESUMES_LEASE", `${where}: retry did not resume existing generation`);
        }
        await uploadChunks(env, retryAttempt.publisherId, resumed.generation);
        retryAttempt.markCommitting();
        await env.sync.commit("example", resumed.generation, env.manifest, async () => false, { deviceId: "owner", publisherId: retryAttempt.publisherId });
        retryAttempt.markCommitCompleted();
        retryAttempt.markConfirmed();
      } catch (error) {
        if (error instanceof ProjectSyncError && error.code === "sync-in-progress") {
          throw new InvariantFailure("I2_PRE_COMMIT_RETRY_REUSES_PUBLISHER_AND_RESUMES_LEASE", `${where}: retry conflicted with its own lease`);
        }
        throw error;
      } finally {
        retryAttempt.release();
      }
      assertValidReceipt(readReceipt(env.receiptsPath, env.uploadKey), `${where}:after-confirm`);
      bump("preCommitRetries");
      return;
    }

    if (scenario === "lost-commit-response") {
      const first = await startAttempt(env);
      if (first.kind !== "attempt") throw new Error(`${where}: expected attempt`);
      const firstAttempt = first.attempt;
      firstAttempt.recordCaptured(env.manifest.id);
      firstAttempt.markBeginAttempted();
      const { generation } = await env.sync.begin("example", { deviceId: "owner", publisherId: firstAttempt.publisherId });
      await uploadChunks(env, firstAttempt.publisherId, generation);
      firstAttempt.markCommitting();
      let atCheck!: () => void;
      let releaseApply!: (running: boolean) => void;
      const reached = new Promise<void>(resolve => { atCheck = resolve; });
      const inFlight = env.sync.commit("example", generation, env.manifest, () => {
        atCheck();
        return new Promise<boolean>(resolve => { releaseApply = resolve; });
      }, { deviceId: "owner", publisherId: firstAttempt.publisherId });
      await reached;

      if (mutation === "I3_COMMITTING_RECEIPT_NEVER_CLEARED_OR_RETRIED_ON_LOST_RESPONSE") {
        writeReceipt(env.receiptsPath, env.uploadKey, undefined);
      } else {
        firstAttempt.handleFailure(new TypeError("connection reset during commit"));
      }
      firstAttempt.release();

      let refused = false;
      try {
        const second = await startAttempt(env);
        if (second.kind === "attempt") second.attempt.release();
      } catch (error) {
        if (error instanceof Error && error.message === UNCERTAIN_UPLOAD_ERROR) refused = true;
        else throw error;
      } finally {
        releaseApply(false);
        await inFlight;
      }
      if (!refused) {
        throw new InvariantFailure("I3_COMMITTING_RECEIPT_NEVER_CLEARED_OR_RETRIED_ON_LOST_RESPONSE", `${where}: uncertain committing receipt was retried or cleared`);
      }
      assertValidReceipt(readReceipt(env.receiptsPath, env.uploadKey), where);
      bump("lostCommitBlocked");
      return;
    }

    if (scenario === "legacy-admitted-commit") {
      const priorWriter = { deviceId: "owner", publisherId: randomUUID() };
      const { generation } = await env.sync.begin("example", priorWriter);
      await uploadChunks(env, priorWriter.publisherId, generation);

      let enterQueue!: () => void;
      let finishQueue!: () => void;
      const queued = new Promise<void>(resolve => { enterQueue = resolve; });
      const unblockQueue = new Promise<void>(resolve => { finishQueue = resolve; });
      const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
      const originalOpendir = fsp.opendir;
      let intercepted = false;
      fsp.opendir = (async (target: Parameters<typeof originalOpendir>[0], ...rest: unknown[]) => {
        if (!intercepted && String(target) === join(env.root, "cloud")) {
          intercepted = true;
          enterQueue();
          await unblockQueue;
        }
        return (originalOpendir as (...args: unknown[]) => ReturnType<typeof originalOpendir>)(target, ...rest);
      }) as typeof fsp.opendir;
      syncBuiltinESMExports();
      const holder = env.sync.exportTree("example");
      await queued;
      const admittedCommit = env.sync.commit("example", generation, env.manifest, async () => false, priorWriter);

      const statusWhileAdmitted = await env.sync.liveStatus("example", async () => false);
      assert.equal(statusWhileAdmitted.lastSyncedManifest, undefined, `${where}: status is empty before queued commit writes received`);
      assert.equal(statusWhileAdmitted.appliedManifest, undefined);
      assert.equal(statusWhileAdmitted.pendingGeneration, undefined);

      const legacyReceipt: SourceUploadReceiptRecord = {
        requestId: randomUUID(),
        body: { requestId: randomUUID(), projectId: "example", commit: "a".repeat(40) },
        createdAt: new Date().toISOString(),
        state: "pending",
        manifestId: env.manifest.id,
      };
      writeReceipt(env.receiptsPath, env.uploadKey, legacyReceipt);

      let refused = false;
      let secondAttempt: SourceUploadAttempt | undefined;
      try {
        const retry = await startAttempt(env, mutation);
        if (retry.kind === "attempt") secondAttempt = retry.attempt;
      } catch (error) {
        if (error instanceof Error && error.message === UNCERTAIN_UPLOAD_ERROR) refused = true;
        else throw error;
      } finally {
        fsp.opendir = originalOpendir;
        syncBuiltinESMExports();
        finishQueue();
        await holder;
        await admittedCommit;
        secondAttempt?.release();
      }
      if (!refused) {
        throw new InvariantFailure("I4_LEGACY_RECEIPT_REFUSED_DURING_ADMITTED_OR_RECEIVED_HOST_STATE", `${where}: phase-less legacy receipt was reclaimed during an admitted commit with empty liveStatus`);
      }
      const after = readReceipt(env.receiptsPath, env.uploadKey);
      if (after?.state !== "pending" || after.phase !== undefined) {
        throw new InvariantFailure("I4_LEGACY_RECEIPT_REFUSED_DURING_ADMITTED_OR_RECEIVED_HOST_STATE", `${where}: legacy receipt was mutated despite refused reclaim`);
      }
      bump("legacyAdmittedBlocked");
      return;
    }

    if (scenario === "legacy-host-first-upgrade") {
      const legacyReceipt: SourceUploadReceiptRecord = {
        requestId: randomUUID(),
        body: { requestId: randomUUID(), projectId: "example", commit: "a".repeat(40) },
        createdAt: new Date().toISOString(),
        state: "pending",
        manifestId: "b".repeat(64),
      };
      writeReceipt(env.receiptsPath, env.uploadKey, legacyReceipt);

      let olderHostRefused = false;
      try {
        const oldRetry = await startAttempt(env, undefined, { olderHost: true });
        if (oldRetry.kind === "attempt") oldRetry.attempt.release();
      } catch (error) {
        if (error instanceof Error && error.message === UNCERTAIN_UPLOAD_ERROR) olderHostRefused = true;
        else throw error;
      }
      if (!olderHostRefused) {
        throw new InvariantFailure("I4_LEGACY_RECEIPT_REFUSED_DURING_ADMITTED_OR_RECEIVED_HOST_STATE", `${where}: legacy receipt reclaimed without emptyConfirmed`);
      }

      const upgraded = await startAttempt(env);
      if (upgraded.kind !== "attempt") throw new Error(`${where}: expected attempt`);
      try {
        upgraded.attempt.recordCaptured(env.manifest.id);
        upgraded.attempt.markBeginAttempted();
        const { generation } = await env.sync.begin("example", { deviceId: "owner", publisherId: upgraded.attempt.publisherId });
        await uploadChunks(env, upgraded.attempt.publisherId, generation);
        upgraded.attempt.markCommitting();
        await env.sync.commit("example", generation, env.manifest, async () => false, { deviceId: "owner", publisherId: upgraded.attempt.publisherId });
        upgraded.attempt.markCommitCompleted();
        upgraded.attempt.markConfirmed();
      } finally {
        upgraded.attempt.release();
      }
      assertValidReceipt(readReceipt(env.receiptsPath, env.uploadKey), where);
      bump("legacyUpgradeRecovered");
      return;
    }

    const owned = await startAttempt(env);
    if (owned.kind !== "attempt") throw new Error(`${where}: expected attempt`);
    try {
      if (mutation === "I5_RECEIPT_ALWAYS_VALID_WITH_STATE_AND_OWNER_GUARD") {
        writeReceipt(env.receiptsPath, env.uploadKey, undefined);
        const broken = { phase: "committing" } as unknown as SourceUploadReceiptRecord;
        writeReceipt(env.receiptsPath, env.uploadKey, broken);
        assertValidReceipt(readReceipt(env.receiptsPath, env.uploadKey), where);
      } else {
        writeReceipt(env.receiptsPath, env.uploadKey, undefined);
        let rejectedUnowned = false;
        try {
          owned.attempt.markCommitting();
        } catch {
          rejectedUnowned = true;
        }
        if (!rejectedUnowned) {
          throw new InvariantFailure("I5_RECEIPT_ALWAYS_VALID_WITH_STATE_AND_OWNER_GUARD", `${where}: transition succeeded after receipt was deleted`);
        }
        assertValidReceipt(readReceipt(env.receiptsPath, env.uploadKey), where);
      }
    } finally {
      owned.attempt.release();
    }
    bump("ownerGuardChecked");
  } finally {
    env.cleanup();
  }
}

async function runSeed(seed: number, counts: Record<string, number>, mutation?: InvariantId): Promise<void> {
  const r = createRand(seed);
  const scenarios = [
    "concurrent-live",
    "pre-commit-retry",
    "lost-commit-response",
    "legacy-admitted-commit",
    "legacy-host-first-upgrade",
    "owner-guard",
  ] as const;
  for (let step = 0; step < 8; step++) {
    const scenario = step < scenarios.length && seed === SEEDS[0] ? scenarios[step]! : r.pick(scenarios);
    await runScenario(seed, step, scenario, counts, mutation);
  }
}

test("seeded CLI source-upload receipt simulator preserves fencing, publisherId reuse, and fail-closed recovery invariants", async t => {
  const counts: Record<string, number> = {};
  t.diagnostic(`upload-receipt-sim seeds=${SEEDS[0]}..${SEEDS[SEEDS.length - 1]} (${SEEDS.length} seeds)`);
  for (const seed of SEEDS) {
    try {
      await runSeed(seed, counts);
    } catch (error) {
      t.diagnostic(`upload-receipt-sim failed seed=${seed}`);
      throw error;
    }
  }
  if (DEFAULT_CORPUS) {
    for (const key of ["concurrentFenced", "preCommitRetries", "lostCommitBlocked", "legacyAdmittedBlocked", "legacyUpgradeRecovered", "ownerGuardChecked"]) {
      assert.ok((counts[key] ?? 0) > 0, `default corpus must exercise ${key} (counts=${JSON.stringify(counts)})`);
    }
  }
});

test("CLI source-upload receipt simulator catches one mutation per invariant", async () => {
  const mutations: InvariantId[] = [
    "I1_LIVE_ATTEMPT_FENCED_FROM_COMPETING_ATTEMPT",
    "I2_PRE_COMMIT_RETRY_REUSES_PUBLISHER_AND_RESUMES_LEASE",
    "I3_COMMITTING_RECEIPT_NEVER_CLEARED_OR_RETRIED_ON_LOST_RESPONSE",
    "I4_LEGACY_RECEIPT_REFUSED_DURING_ADMITTED_OR_RECEIVED_HOST_STATE",
    "I5_RECEIPT_ALWAYS_VALID_WITH_STATE_AND_OWNER_GUARD",
  ];
  for (const mutation of mutations) {
    let caught: InvariantFailure | undefined;
    for (const seed of [1, 2, 3]) {
      try {
        await runSeed(seed, {}, mutation);
      } catch (error) {
        if (error instanceof InvariantFailure) {
          caught = error;
          break;
        }
        throw error;
      }
    }
    assert.ok(caught, `simulator must catch mutation ${mutation}`);
    assert.equal(caught.invariant, mutation, `mutation ${mutation} should fail its own invariant (got ${caught.invariant}: ${caught.message})`);
  }
});
