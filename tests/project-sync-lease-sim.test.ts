import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashToken } from "../packages/host/src/config.js";
import { ProjectSync, ProjectSyncError, type SyncWriter } from "../packages/host/src/project-sync.js";
import type { Config } from "../packages/host/src/types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";

const DEFAULT_SEEDS = 25;
const ONLY = process.env.SYNC_LEASE_SIM_SEED;
const COUNT = Number(process.env.SYNC_LEASE_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.SYNC_LEASE_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "SYNC_LEASE_SIM_SEED, SYNC_LEASE_SIM_SEEDS, and SYNC_LEASE_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const T0 = Date.parse("2026-11-26T00:00:00.000Z");
const UPLOAD_LEASE_MS = 5 * 60 * 1000;
const UPLOAD_LEASE_PERSIST_MS = 30 * 1000;
const UPLOAD_LEASE_RECOVERY_GRACE_MS = 30 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROBE_WRITER: SyncWriter = { deviceId: "probe-device", publisherId: "00000000-0000-4000-8000-ffffffffffff" };
const PROBE_GENERATION = "00000000-0000-4000-8000-eeeeeeeeeeee";

type InvariantId =
  | "I1_INVALID_HEADERS_REJECTED_WITHOUT_MUTATION"
  | "I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS"
  | "I3_LIVE_IDENTIFIED_LEASE_SURVIVES_RESTART"
  | "I4_LEGACY_INVALID_IDLE_LEASE_DISCARDED_ON_RESTART"
  | "I5_IDLE_EXPIRY_AND_COMMITTING_RECOVERY_MATCH_MODEL";

class InvariantFailure extends Error {
  constructor(readonly invariant: InvariantId, message: string) {
    super(`${invariant}: ${message}`);
  }
}

type Rand = {
  next(): number;
  int(min: number, max: number): number;
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
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => items[Math.floor(next() * items.length)]!,
    chance: p => next() < p,
  };
}

function deterministicUuid(counter: number): string {
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

type ModelLease = {
  generation: string;
  writer: SyncWriter;
  committing: boolean;
  expiresAt: number;
  lastPersistedAt: number;
};

type DiskRecord = {
  generation: string;
  writer: { deviceId?: string; publisherId?: string };
  updatedAt: string;
  committing: boolean;
};

interface Harness {
  sync: ProjectSync;
  restart(options?: { failRecovery?: boolean; injectedLegacyIdle?: boolean }): Promise<void>;
  begin(writer: SyncWriter): Promise<{ generation: string }>;
  missing(hashes: string[], writer: SyncWriter, generation: string): Promise<string[]>;
  putBlob(hash: string, bytes: Buffer, writer: SyncWriter, generation: string): Promise<void>;
  leasePath(): string;
  writeRawLease(value: DiskRecord): void;
  readRawLease(): DiskRecord | undefined;
}

function createHarness(
  root: string,
  config: Config,
  key: Buffer,
  cloud: string,
  mutation?: InvariantId,
): Harness {
  let sync = new ProjectSync(config, key);
  let forcedConflict: { untilMs: number } | undefined;
  const leasePath = () => join(config.stateDir, "projects", "example", "sync", "upload-lease.sealed");
  const drainRecovery = async (instance: ProjectSync) => {
    await instance.missing("example", [], PROBE_WRITER, PROBE_GENERATION).catch(() => {});
  };
  const writeRawLease = (value: DiskRecord) => {
    writeSealed(leasePath(), key, "project-sync:example:upload-lease", value);
  };
  const readRawLease = (): DiskRecord | undefined => {
    const file = leasePath();
    return existsSync(file) ? unseal<DiskRecord>(key, "project-sync:example:upload-lease", readFileSync(file, "utf8")) : undefined;
  };
  const harness: Harness = {
    get sync() { return sync; },
    leasePath,
    writeRawLease,
    readRawLease,
    async restart(options = {}) {
      forcedConflict = undefined;
      const before = readRawLease();
      const isInvalidLegacyIdle = Boolean(options.injectedLegacyIdle);
      if (mutation === "I3_LIVE_IDENTIFIED_LEASE_SURVIVES_RESTART" && before && !before.committing && !isInvalidLegacyIdle) {
        rmSync(leasePath(), { force: true });
      }
      const failRecovery = Boolean(options.failRecovery) || (mutation === "I5_IDLE_EXPIRY_AND_COMMITTING_RECOVERY_MATCH_MODEL" && Boolean(before?.committing));
      const backup = join(root, "cloud-backup");
      if (failRecovery) {
        renameSync(cloud, backup);
        symlinkSync(cloud, cloud);
      }
      try {
        sync = new ProjectSync(config, key);
        await drainRecovery(sync);
      } finally {
        if (failRecovery) {
          rmSync(cloud, { force: true });
          renameSync(backup, cloud);
        }
      }
      if (mutation === "I4_LEGACY_INVALID_IDLE_LEASE_DISCARDED_ON_RESTART" && isInvalidLegacyIdle && before) {
        writeRawLease(before);
        forcedConflict = { untilMs: Date.now() + UPLOAD_LEASE_MS + UPLOAD_LEASE_RECOVERY_GRACE_MS };
      }
    },
    async begin(writer: SyncWriter) {
      if (mutation === "I1_INVALID_HEADERS_REJECTED_WITHOUT_MUTATION" && !UUID_RE.test(String(writer?.publisherId ?? ""))) {
        return { generation: deterministicUuid(999999) };
      }
      if (forcedConflict && Date.now() < forcedConflict.untilMs) {
        throw new ProjectSyncError("Another workspace publisher is uploading this project.", "sync-in-progress", 409, undefined, 60);
      }
      if (mutation === "I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS") {
        try {
          return await sync.begin("example", writer);
        } catch (error) {
          if (error instanceof ProjectSyncError && error.code === "sync-in-progress") {
            rmSync(leasePath(), { force: true });
            sync = new ProjectSync(config, key);
            await drainRecovery(sync);
            return sync.begin("example", writer);
          }
          throw error;
        }
      }
      return sync.begin("example", writer);
    },
    missing(hashes, writer, generation) {
      return sync.missing("example", hashes, writer, generation);
    },
    putBlob(hash, bytes, writer, generation) {
      return sync.putBlob("example", hash, bytes, writer, generation);
    },
  };
  return harness;
}

function sameWriter(a: SyncWriter, b: SyncWriter): boolean {
  return a.deviceId === b.deviceId && a.publisherId === b.publisherId;
}

async function expectError(
  promise: Promise<unknown>,
  invariant: InvariantId,
  expected: { status: number; code: ProjectSyncError["code"] },
  where: string,
): Promise<ProjectSyncError> {
  try {
    const value = await promise;
    throw new InvariantFailure(invariant, `${where}: expected ${expected.status} ${expected.code}, got ${JSON.stringify(value)}`);
  } catch (error) {
    if (error instanceof InvariantFailure) throw error;
    if (!(error instanceof ProjectSyncError) || error.status !== expected.status || error.code !== expected.code) {
      const actual = error instanceof ProjectSyncError ? `${error.status} ${error.code}` : String(error);
      throw new InvariantFailure(invariant, `${where}: expected ${expected.status} ${expected.code}, got ${actual}`);
    }
    return error;
  }
}

async function runSeed(seed: number, counts: Record<string, number>, mutation?: InvariantId): Promise<void> {
  const r = createRand(seed);
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const root = realpathSync(mkdtempSync("/tmp/inf-lease-sim-"));
  const projectsParent = join(root, "projects");
  const cloud = join(projectsParent, "cloud");
  mkdirSync(cloud, { recursive: true });
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

  const realNow = Date.now;
  let nowMs = T0 + seed * 1000;
  Date.now = () => nowMs;
  let uuidSeq = seed * 1000;
  const writers: SyncWriter[] = [
    { deviceId: "owner-a", publisherId: deterministicUuid(++uuidSeq) },
    { deviceId: "owner-a", publisherId: deterministicUuid(++uuidSeq) },
    { deviceId: "owner-b", publisherId: deterministicUuid(++uuidSeq) },
  ];
  let model: ModelLease | undefined;

  const modelLive = () => {
    if (model && !model.committing && model.expiresAt <= nowMs) model = undefined;
    return model;
  };
  const touchModel = (active: ModelLease) => {
    active.expiresAt = nowMs + UPLOAD_LEASE_MS;
    if (!active.committing && nowMs - active.lastPersistedAt >= UPLOAD_LEASE_PERSIST_MS) {
      active.lastPersistedAt = nowMs;
    }
  };

  try {
    const h = createHarness(root, config, key, cloud, mutation);
    await h.sync.missing("example", [], PROBE_WRITER, PROBE_GENERATION).catch(() => {});

    const checkInvariants = async (step: number, label: string) => {
      const where = `seed=${seed} step=${step} (${label})`;
      const live = modelLive();
      const rawBefore = h.readRawLease();

      const badWriter = { deviceId: "owner-a" } as unknown as SyncWriter;
      await expectError(h.begin(badWriter), "I1_INVALID_HEADERS_REJECTED_WITHOUT_MUTATION", { status: 400, code: "invalid-sync-headers" }, `${where}: begin missing publisher`);
      await expectError(h.missing([], writers[0]!, "not-a-uuid"), "I1_INVALID_HEADERS_REJECTED_WITHOUT_MUTATION", { status: 400, code: "invalid-sync-headers" }, `${where}: missing invalid generation`);
      const rawAfterBad = h.readRawLease();
      if (JSON.stringify(rawAfterBad) !== JSON.stringify(rawBefore)) {
        throw new InvariantFailure("I1_INVALID_HEADERS_REJECTED_WITHOUT_MUTATION", `${where}: invalid header call mutated persisted lease`);
      }

      if (live) {
        const competitor = writers.find(w => !sameWriter(w, live.writer))!;
        const conflict = await expectError(h.begin(competitor), "I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS", { status: 409, code: "sync-in-progress" }, `${where}: competitor begin`);
        if ((conflict.retryAfterSeconds ?? 0) < 1) {
          throw new InvariantFailure("I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS", `${where}: retryAfterSeconds missing`);
        }
        await expectError(h.missing([], competitor, live.generation), "I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS", { status: 409, code: "stale-generation" }, `${where}: competitor missing`);
        if (live.committing) {
          await expectError(h.begin(live.writer), "I5_IDLE_EXPIRY_AND_COMMITTING_RECOVERY_MATCH_MODEL", { status: 409, code: "sync-in-progress" }, `${where}: committing blocks owner begin`);
        }
      }
    };

    for (let step = 0; step < 36; step++) {
      const roll = r.next();
      if (roll < 0.22) {
        const writer = r.pick(writers);
        const live = modelLive();
        if (!live) {
          const started = await h.begin(writer);
          if (!UUID_RE.test(started.generation)) {
            throw new InvariantFailure("I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS", `seed=${seed} step=${step}: non-UUID generation`);
          }
          model = { generation: started.generation, writer, committing: false, expiresAt: nowMs + UPLOAD_LEASE_MS, lastPersistedAt: nowMs };
          bump("begins");
        } else if (!live.committing && sameWriter(live.writer, writer)) {
          const resumed = await h.begin(writer);
          if (resumed.generation !== live.generation) {
            throw new InvariantFailure("I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS", `seed=${seed} step=${step}: owner did not resume same generation`);
          }
          touchModel(live);
          bump("resumes");
        } else {
          await expectError(h.begin(writer), "I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS", { status: 409, code: "sync-in-progress" }, `seed=${seed} step=${step}: conflict begin`);
          bump("competitorConflicts");
        }
        await checkInvariants(step, "begin");
      } else if (roll < 0.42) {
        const live = modelLive();
        const writer = live && r.chance(0.75) ? live.writer : r.pick(writers);
        const generation = live && sameWriter(live.writer, writer) && r.chance(0.85) ? live.generation : deterministicUuid(++uuidSeq);
        const payload = Buffer.from(`seed-${seed}-step-${step}\n`);
        const hash = createHash("sha256").update(payload).digest("hex");
        const usePut = r.chance(0.5);
        if (live && !live.committing && sameWriter(live.writer, writer) && generation === live.generation) {
          if (usePut) await h.putBlob(hash, payload, writer, generation);
          else await h.missing([hash], writer, generation);
          touchModel(live);
          bump("renewals");
        } else {
          const call = usePut ? h.putBlob(hash, payload, writer, generation) : h.missing([hash], writer, generation);
          await expectError(call, "I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS", { status: 409, code: "stale-generation" }, `seed=${seed} step=${step}: non-owner content`);
          bump("staleContent");
        }
        await checkInvariants(step, usePut ? "putBlob" : "missing");
      } else if (roll < 0.54) {
        const badCases: [SyncWriter, string][] = [
          [{ deviceId: "owner-a" } as unknown as SyncWriter, deterministicUuid(++uuidSeq)],
          [{ deviceId: "owner-a", publisherId: "internal" }, deterministicUuid(++uuidSeq)],
          [{ deviceId: "", publisherId: deterministicUuid(++uuidSeq) }, deterministicUuid(++uuidSeq)],
          [writers[0]!, ""],
          [writers[0]!, "not-a-uuid"],
        ];
        const [badWriter, badGen] = r.pick(badCases);
        await expectError(h.missing([], badWriter, badGen), "I1_INVALID_HEADERS_REJECTED_WITHOUT_MUTATION", { status: 400, code: "invalid-sync-headers" }, `seed=${seed} step=${step}: invalid headers`);
        bump("invalidHeaders");
        await checkInvariants(step, "invalid-headers");
      } else if (roll < 0.68) {
        const advance = r.chance(0.55) ? r.int(5_000, 90_000) : r.int(UPLOAD_LEASE_MS + 1_000, UPLOAD_LEASE_MS + UPLOAD_LEASE_RECOVERY_GRACE_MS + 30_000);
        const hadLiveIdle = Boolean(model && !model.committing && model.expiresAt > nowMs);
        nowMs += advance;
        if (hadLiveIdle && !modelLive()) {
          const nextWriter = r.pick(writers);
          const fresh = await h.begin(nextWriter);
          model = { generation: fresh.generation, writer: nextWriter, committing: false, expiresAt: nowMs + UPLOAD_LEASE_MS, lastPersistedAt: nowMs };
          bump("idleExpiries");
        }
        await checkInvariants(step, "advance-clock");
      } else if (roll < 0.82) {
        const liveBefore = modelLive();
        await h.restart();
        if (liveBefore?.committing) {
          model = undefined;
          if (h.readRawLease() !== undefined) {
            throw new InvariantFailure("I5_IDLE_EXPIRY_AND_COMMITTING_RECOVERY_MATCH_MODEL", `seed=${seed} step=${step}: committing lease was not cleared after filesystem recovery`);
          }
          bump("committingRecovered");
        } else if (liveBefore) {
          const recoveredExpiry = liveBefore.lastPersistedAt + UPLOAD_LEASE_MS + UPLOAD_LEASE_RECOVERY_GRACE_MS;
          if (nowMs > recoveredExpiry) {
            model = undefined;
            if (h.readRawLease() !== undefined) {
              throw new InvariantFailure("I5_IDLE_EXPIRY_AND_COMMITTING_RECOVERY_MATCH_MODEL", `seed=${seed} step=${step}: expired lease remained on disk after restart`);
            }
            bump("idleExpiries");
          } else {
            model = { ...liveBefore, expiresAt: recoveredExpiry };
            const resumed = await h.begin(liveBefore.writer);
            if (resumed.generation !== liveBefore.generation) {
              throw new InvariantFailure("I3_LIVE_IDENTIFIED_LEASE_SURVIVES_RESTART", `seed=${seed} step=${step}: live identified lease was dropped on restart (got ${resumed.generation}, expected ${liveBefore.generation})`);
            }
            touchModel(model);
            bump("liveRestarts");
          }
        }
        await checkInvariants(step, "restart");
      } else if (roll < 0.92) {
        const invalidVariant = r.pick(["headerless", "non-uuid-publisher", "non-uuid-generation"] as const);
        const injected: DiskRecord = invalidVariant === "headerless"
          ? { generation: deterministicUuid(++uuidSeq), writer: { deviceId: "owner-a" }, updatedAt: new Date(nowMs).toISOString(), committing: false }
          : invalidVariant === "non-uuid-publisher"
            ? { generation: deterministicUuid(++uuidSeq), writer: { deviceId: "owner-a", publisherId: "internal" }, updatedAt: new Date(nowMs).toISOString(), committing: false }
            : { generation: "not-a-uuid", writer: writers[0]!, updatedAt: new Date(nowMs).toISOString(), committing: false };
        h.writeRawLease(injected);
        await h.restart({ injectedLegacyIdle: true });
        if (h.readRawLease() !== undefined) {
          throw new InvariantFailure("I4_LEGACY_INVALID_IDLE_LEASE_DISCARDED_ON_RESTART", `seed=${seed} step=${step}: invalid legacy idle lease (${invalidVariant}) remained on disk after restart`);
        }
        const writer = r.pick(writers);
        let started: { generation: string };
        try {
          started = await h.begin(writer);
        } catch (error) {
          throw new InvariantFailure("I4_LEGACY_INVALID_IDLE_LEASE_DISCARDED_ON_RESTART", `seed=${seed} step=${step}: valid publisher blocked after legacy idle lease (${invalidVariant}) restart: ${String(error)}`);
        }
        model = { generation: started.generation, writer, committing: false, expiresAt: nowMs + UPLOAD_LEASE_MS, lastPersistedAt: nowMs };
        bump("legacyIdleInjects");
        await checkInvariants(step, `legacy-idle:${invalidVariant}`);
      } else {
        const failRecovery = r.chance(0.5);
        const owner = r.pick(writers);
        const gen = deterministicUuid(++uuidSeq);
        h.writeRawLease({ generation: gen, writer: owner, updatedAt: new Date(nowMs).toISOString(), committing: true });
        await h.restart({ failRecovery });
        if (failRecovery) {
          model = { generation: gen, writer: owner, committing: true, expiresAt: Number.POSITIVE_INFINITY, lastPersistedAt: nowMs };
          nowMs += UPLOAD_LEASE_MS + UPLOAD_LEASE_RECOVERY_GRACE_MS + 60_000;
          await expectError(h.begin(owner), "I5_IDLE_EXPIRY_AND_COMMITTING_RECOVERY_MATCH_MODEL", { status: 409, code: "sync-in-progress" }, `seed=${seed} step=${step}: unrecovered committing lease must remain fenced`);
          bump("committingUnrecovered");
        } else {
          if (h.readRawLease() !== undefined) {
            throw new InvariantFailure("I5_IDLE_EXPIRY_AND_COMMITTING_RECOVERY_MATCH_MODEL", `seed=${seed} step=${step}: committing lease survived successful filesystem recovery`);
          }
          model = undefined;
          const nextWriter = r.pick(writers);
          const fresh = await h.begin(nextWriter);
          model = { generation: fresh.generation, writer: nextWriter, committing: false, expiresAt: nowMs + UPLOAD_LEASE_MS, lastPersistedAt: nowMs };
          bump("committingRecovered");
        }
        await checkInvariants(step, failRecovery ? "committing-unrecovered" : "committing-recovered");
      }
    }
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
}

test("seeded ProjectSync durable lease recovery simulator preserves all invariants across restarts and legacy lease injection", async t => {
  const counts: Record<string, number> = {};
  t.diagnostic(`sync-lease-sim seeds=${SEEDS[0]}..${SEEDS[SEEDS.length - 1]} (${SEEDS.length} seeds)`);
  for (const seed of SEEDS) {
    try {
      await runSeed(seed, counts);
    } catch (error) {
      t.diagnostic(`sync-lease-sim failed seed=${seed}`);
      throw error;
    }
  }
  if (DEFAULT_CORPUS) {
    for (const key of ["begins", "resumes", "renewals", "competitorConflicts", "invalidHeaders", "idleExpiries", "liveRestarts", "legacyIdleInjects", "committingRecovered", "committingUnrecovered"]) {
      assert.ok((counts[key] ?? 0) > 0, `default corpus must exercise ${key} (counts=${JSON.stringify(counts)})`);
    }
  }
});

test("lease recovery simulator catches one mutation per invariant including restoring a legacy idle lease and dropping a live identified lease", async () => {
  const mutations: InvariantId[] = [
    "I1_INVALID_HEADERS_REJECTED_WITHOUT_MUTATION",
    "I2_LIVE_IDENTIFIED_LEASE_RESUMES_AND_BLOCKS_COMPETITORS",
    "I3_LIVE_IDENTIFIED_LEASE_SURVIVES_RESTART",
    "I4_LEGACY_INVALID_IDLE_LEASE_DISCARDED_ON_RESTART",
    "I5_IDLE_EXPIRY_AND_COMMITTING_RECOVERY_MATCH_MODEL",
  ];
  for (const mutation of mutations) {
    let caught: InvariantFailure | undefined;
    for (const seed of [1, 2, 3, 4, 5]) {
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
