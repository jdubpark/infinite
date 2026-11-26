import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_ENVIRONMENT_STATE_FILE,
  CodexEnvironmentError,
  connectCodexEnvironments,
  openCodexEnvironmentStore,
  type CodexDispatchCheck,
  type CodexDispatchDecision,
  type CodexEnvironmentClient,
  type CodexEnvironmentSelection,
  type CodexEnvironmentStore,
  type CodexExecutor,
  type CodexPlacement,
  type CodexThreadPlacementView,
  type PersistedCodexEnvironmentState,
} from "../packages/host/src/codex-environment.js";
import { makeExecutor, startFakeExecServer, startFakeProvider, type FakeExecServer, type FakeProvider } from "./fixtures/codex-environment-harness.js";

type Mutant =
  | "skip-durable-commit"
  | "flush-stale-queued-frame"
  | "keep-verified-on-write-fail"
  | "trust-persisted-after-restart"
  | "forget-used-ids-on-restart"
  | "fallback-empty-on-corrupt-read";

const DEFAULT_SEEDS = 8;
const STEPS_PER_SEED = 24;
const ONLY = process.env.CODEX_ENV_SIM_SEED;
const COUNT = Number(process.env.CODEX_ENV_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.CODEX_ENV_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "CODEX_ENV_SIM_SEED, CODEX_ENV_SIM_SEEDS, and CODEX_ENV_SIM_BASE must be integers");

class SimViolation extends Error {
  constructor(readonly invariant: string, readonly seed: number, readonly step: number, detail: string) {
    super(`seed ${seed}, step ${step}: ${invariant}: ${detail}; rerun with CODEX_ENV_SIM_SEED=${seed}`);
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFaultyStore(base: CodexEnvironmentStore, state: { failVerifiedWrite: boolean; mutant?: Mutant }): CodexEnvironmentStore {
  return {
    scope: base.scope,
    read() {
      const result = base.read();
      if (state.mutant === "fallback-empty-on-corrupt-read" && result.state === "unreadable") {
        return { state: "missing" };
      }
      if (state.mutant === "forget-used-ids-on-restart" && result.state === "readable") {
        const stripped: PersistedCodexEnvironmentState = { version: 1, scope: result.record.scope, threads: {} };
        for (const [id, entry] of Object.entries(result.record.threads)) {
          if (entry.status === "verified") {
            stripped.threads[id] = { ...entry, usedEnvironmentIds: [entry.placement.environmentId] };
          } else {
            stripped.threads[id] = entry;
          }
        }
        return { state: "readable", record: stripped };
      }
      return result;
    },
    write(record) {
      if (state.mutant === "skip-durable-commit") {
        const hasVerified = Object.values(record.threads).some(entry => entry.status === "verified");
        if (hasVerified) return;
      }
      if (state.failVerifiedWrite) {
        const hasVerified = Object.values(record.threads).some(entry => entry.status === "verified");
        if (hasVerified) throw new Error("Injected disk write failure");
      }
      base.write(record);
    },
  };
}

function wrapClientForMutant(client: CodexEnvironmentClient, mutant: Mutant | undefined): CodexEnvironmentClient {
  if (mutant !== "trust-persisted-after-restart" && mutant !== "keep-verified-on-write-fail") return client;
  let lastVerified: CodexPlacement | undefined;
  return {
    ...client,
    placement(threadId: string): CodexThreadPlacementView {
      const view = client.placement(threadId);
      if (view.status === "verified") lastVerified = view.placement;
      if (mutant === "trust-persisted-after-restart" && view.status === "pending-verification") {
        return {
          status: "verified",
          placement: { threadId, ...view.expected, generation: view.generation, verifiedAt: new Date().toISOString() },
        };
      }
      if (mutant === "keep-verified-on-write-fail" && view.status === "uncertain" && lastVerified) {
        return { status: "verified", placement: lastVerified };
      }
      return view;
    },
    checkDispatch(request: CodexDispatchCheck): CodexDispatchDecision {
      const decision = client.checkDispatch(request);
      if (decision.allowed) {
        lastVerified = decision.placement;
        return decision;
      }
      const view = client.placement(request.threadId);
      if (mutant === "trust-persisted-after-restart" && view.status === "pending-verification") {
        return {
          allowed: true,
          placement: { threadId: request.threadId, ...view.expected, generation: view.generation, verifiedAt: new Date().toISOString() },
        };
      }
      if (mutant === "keep-verified-on-write-fail" && view.status === "uncertain" && lastVerified) {
        return { allowed: true, placement: lastVerified };
      }
      return decision;
    },
  };
}

interface SimModel {
  committedGen: number;
  activeEnvId?: string;
  retiredEnvIds: Set<string>;
  liveVerified: boolean;
  mustReverifyAfterRestart: boolean;
  expectedUncertain: boolean;
  corrupted: boolean;
}

async function runSimulation(seed: number, mutant?: Mutant): Promise<void> {
  const rand = mulberry32(seed);
  const root = realpathSync(mkdtempSync(join(tmpdir(), `infinite-codex-sim-${seed}-`)));
  const key = randomBytes(32);
  const scope = `sim-${seed}:codex-environments`;
  const stateFile = join(root, CODEX_ENVIRONMENT_STATE_FILE);
  const threadId = `thread-sim-${seed}`;
  const execs: FakeExecServer[] = [];
  let provider: FakeProvider | undefined;
  let client: CodexEnvironmentClient | undefined;
  let envCounter = 0;

  const storeControl: { failVerifiedWrite: boolean; mutant?: Mutant } = { failVerifiedWrite: false, mutant };
  const rawStore = openCodexEnvironmentStore({ file: stateFile, key, scope });
  const wrappedStore = makeFaultyStore(rawStore, storeControl);

  const executors = new Map<string, { executor: CodexExecutor; exec: FakeExecServer }>();
  const freshExecutor = async (): Promise<{ executor: CodexExecutor; exec: FakeExecServer }> => {
    const id = `env-sim-${++envCounter}`;
    const dir = join(root, id);
    mkdirSync(dir);
    const exec = await startFakeExecServer(dir);
    execs.push(exec);
    const entry = { executor: makeExecutor(id, exec), exec };
    executors.set(id, entry);
    return entry;
  };

  const model: SimModel = {
    committedGen: 0,
    retiredEnvIds: new Set<string>(),
    liveVerified: false,
    mustReverifyAfterRestart: false,
    expectedUncertain: false,
    corrupted: false,
  };

  const startSession = async (initialThreads?: Map<string, CodexEnvironmentSelection[]>) => {
    client?.close();
    await provider?.close();
    provider = await startFakeProvider(initialThreads);
    const rawClient = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, store: wrappedStore });
    client = wrapClientForMutant(rawClient, mutant);
  };

  const assertInvariants = async (step: number) => {
    const c = client!;
    const p = provider!;
    const disk = rawStore.read();
    const view = c.placement(threadId);

    if (model.corrupted) {
      if (c.storeStatus !== "corrupted" || c.supportsSelection !== false || view.status !== "corrupted") {
        throw new SimViolation("corrupted-store-fails-closed", seed, step, `storeStatus=${c.storeStatus} supportsSelection=${c.supportsSelection} view=${view.status}`);
      }
      if (c.checkDispatch({ threadId, environmentId: model.activeEnvId }).allowed) {
        throw new SimViolation("corrupted-store-fails-closed", seed, step, "checkDispatch allowed on corrupted store");
      }
      return;
    }

    if (model.mustReverifyAfterRestart) {
      if (c.checkDispatch({ threadId, environmentId: model.activeEnvId }).allowed) {
        throw new SimViolation("restart-requires-reverification", seed, step, "dispatch allowed immediately after restart before verify");
      }
      if (model.activeEnvId && p.environments.has(model.activeEnvId)) {
        const wire = await p.invokeTool(model.activeEnvId, "process/start");
        if (!wire.error) {
          throw new SimViolation("restart-requires-reverification", seed, step, "wire tool call allowed before verify after restart");
        }
      }
    }

    if (model.expectedUncertain) {
      if (view.status === "verified") {
        throw new SimViolation("fail-closed-on-write-or-transition-failure", seed, step, "placement remained verified after failure");
      }
      if (c.checkDispatch({ threadId }).allowed) {
        throw new SimViolation("fail-closed-on-write-or-transition-failure", seed, step, "checkDispatch allowed while uncertain");
      }
    }

    if (view.status === "verified") {
      if (disk.state !== "readable") {
        throw new SimViolation("no-verified-without-durable-commit", seed, step, `disk state is ${disk.state} while live view is verified`);
      }
      const saved = disk.record.threads[threadId];
      if (!saved || saved.status !== "verified" || saved.generation !== view.placement.generation ||
          saved.placement.environmentId !== view.placement.environmentId) {
        throw new SimViolation("no-verified-without-durable-commit", seed, step, "disk entry mismatches live verified placement");
      }
      if (view.placement.generation > 1 && c.checkDispatch({ threadId, environmentId: view.placement.environmentId, generation: view.placement.generation - 1 }).allowed) {
        throw new SimViolation("no-stale-generation-dispatch", seed, step, "stale generation was allowed by checkDispatch");
      }
      for (const retiredId of model.retiredEnvIds) {
        if (c.checkDispatch({ threadId, environmentId: retiredId }).allowed) {
          throw new SimViolation("no-stale-generation-dispatch", seed, step, `retired env ${retiredId} was allowed`);
        }
        if (p.environments.has(retiredId)) {
          const wire = await p.invokeTool(retiredId, "process/start");
          if (!wire.error) {
            throw new SimViolation("no-stale-generation-dispatch", seed, step, `wire tool call reached retired env ${retiredId}`);
          }
        }
      }
    }
  };

  try {
    await startSession();
    const initial = await freshExecutor();
    client!.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    const initReceipt = await client!.select({ threadId, executor: initial.executor });
    model.committedGen = initReceipt.generation;
    model.activeEnvId = initial.executor.environmentId;
    model.liveVerified = true;
    await assertInvariants(0);

    for (let step = 1; step <= STEPS_PER_SEED; step++) {
      if (model.corrupted) break;
      const roll = rand();
      const op = mutant === "fallback-empty-on-corrupt-read" && step === 3 ? "corrupt"
        : mutant === "forget-used-ids-on-restart" && step === 4 ? "restart-retry-retired"
        : mutant === "keep-verified-on-write-fail" && step === 3 ? "write-fail"
        : mutant === "flush-stale-queued-frame" && step === 2 ? "reselect-queued"
        : mutant === "trust-persisted-after-restart" && step === 2 ? "restart-clean"
        : roll < 0.22 ? "select-fresh"
        : roll < 0.38 ? "reselect-queued"
        : roll < 0.54 ? "restart-clean"
        : roll < 0.68 ? "restart-drift"
        : roll < 0.80 ? "write-fail"
        : roll < 0.90 ? "restart-retry-retired"
        : "reconcile-fresh";

      if (op === "select-fresh") {
        const next = await freshExecutor();
        client!.observe({ method: "thread/started", params: { thread: { id: threadId } } });
        const receipt = (model.expectedUncertain || model.mustReverifyAfterRestart)
          ? await client!.reconcile({ threadId, executor: next.executor })
          : await client!.select({ threadId, executor: next.executor });
        if (receipt.generation <= model.committedGen) {
          throw new SimViolation("no-verified-without-durable-commit", seed, step, `non-monotonic generation ${receipt.generation} <= ${model.committedGen}`);
        }
        if (model.activeEnvId && model.activeEnvId !== next.executor.environmentId) model.retiredEnvIds.add(model.activeEnvId);
        model.activeEnvId = next.executor.environmentId;
        model.committedGen = receipt.generation;
        model.expectedUncertain = false;
        model.mustReverifyAfterRestart = false;
        model.liveVerified = true;
      } else if (op === "reselect-queued") {
        if (model.activeEnvId && model.liveVerified && !model.expectedUncertain && !model.mustReverifyAfterRestart) {
          const active = executors.get(model.activeEnvId)!;
          const beforeCount = active.exec.received.filter(item => item.method === "process/start").length;
          active.exec.holdNextUpgrades = 1;
          const bypassFence = mutant === "flush-stale-queued-frame"
            ? { url: active.exec.url, token: active.exec.token }
            : undefined;
          const channel = await provider!.openPersistentToolChannel(active.executor.environmentId, bypassFence);
          try {
            const queuedCall = channel.send("process/start", { step });
            await active.exec.waitForHeldUpgrade();
            client!.observe({ method: "thread/started", params: { thread: { id: threadId } } });
            const receipt = await client!.select({ threadId, executor: active.executor });
            model.committedGen = receipt.generation;
            active.exec.releaseUpgrades();
            const reply = await queuedCall;
            const afterCount = active.exec.received.filter(item => item.method === "process/start").length;
            if (!reply.error || afterCount !== beforeCount) {
              throw new SimViolation("no-stale-generation-dispatch", seed, step, "stale pre-handshake queued frame was not fenced across same-ID reselection");
            }
          } finally {
            active.exec.releaseUpgrades();
            channel.close();
          }
        }
      } else if (op === "restart-clean") {
        const snapshotThreads = new Map(provider!.threads);
        await startSession(snapshotThreads);
        model.liveVerified = false;
        if (!model.expectedUncertain && model.activeEnvId) {
          model.mustReverifyAfterRestart = true;
          const active = executors.get(model.activeEnvId)!;
          await client!.register(active.executor);
          await assertInvariants(step);
          const verified = await client!.verify(threadId);
          if (verified.environmentId !== model.activeEnvId || verified.generation !== model.committedGen) {
            throw new SimViolation("restart-requires-reverification", seed, step, "verified placement after restart mismatched expected");
          }
          model.mustReverifyAfterRestart = false;
          model.liveVerified = true;
        }
      } else if (op === "restart-drift") {
        await startSession(new Map());
        model.liveVerified = false;
        if (model.activeEnvId && !model.expectedUncertain) {
          const active = executors.get(model.activeEnvId)!;
          await client!.register(active.executor);
          let rejected = false;
          try { await client!.verify(threadId); } catch (error) {
            rejected = error instanceof CodexEnvironmentError && error.code === "conflict";
          }
          if (!rejected) {
            throw new SimViolation("restart-requires-reverification", seed, step, "drifted restart verify did not reject with conflict");
          }
          model.expectedUncertain = true;
          model.mustReverifyAfterRestart = false;
        }
      } else if (op === "write-fail") {
        const next = await freshExecutor();
        client!.observe({ method: "thread/started", params: { thread: { id: threadId } } });
        storeControl.failVerifiedWrite = true;
        let failed = false;
        try {
          if (model.expectedUncertain) await client!.reconcile({ threadId, executor: next.executor });
          else await client!.select({ threadId, executor: next.executor });
        } catch (error) {
          failed = error instanceof CodexEnvironmentError && error.code === "uncertain";
        } finally {
          storeControl.failVerifiedWrite = false;
        }
        if (!failed) {
          throw new SimViolation("fail-closed-on-write-or-transition-failure", seed, step, "write failure did not fail closed with uncertain");
        }
        if (model.activeEnvId && model.activeEnvId !== next.executor.environmentId) model.retiredEnvIds.add(model.activeEnvId);
        model.expectedUncertain = true;
        model.mustReverifyAfterRestart = false;
        model.liveVerified = false;
      } else if (op === "restart-retry-retired") {
        if (model.retiredEnvIds.size === 0) {
          const next = await freshExecutor();
          client!.observe({ method: "thread/started", params: { thread: { id: threadId } } });
          const receipt = model.expectedUncertain
            ? await client!.reconcile({ threadId, executor: next.executor })
            : await client!.select({ threadId, executor: next.executor });
          if (model.activeEnvId && model.activeEnvId !== next.executor.environmentId) model.retiredEnvIds.add(model.activeEnvId);
          model.activeEnvId = next.executor.environmentId;
          model.committedGen = receipt.generation;
          model.expectedUncertain = false;
          model.liveVerified = true;
        }
        const retiredId = [...model.retiredEnvIds][0];
        const retired = executors.get(retiredId)!;
        const snapshotThreads = new Map(provider!.threads);
        await startSession(snapshotThreads);
        client!.observe({ method: "thread/started", params: { thread: { id: threadId } } });
        let reused = false;
        try {
          await client!.reconcile({ threadId, executor: retired.executor });
          reused = true;
        } catch (error) {
          if (!(error instanceof CodexEnvironmentError) || error.code !== "conflict") throw error;
        }
        if (reused) {
          throw new SimViolation("retired-ids-never-reused", seed, step, `retired environment ${retiredId} was reused after restart`);
        }
        model.liveVerified = false;
        model.mustReverifyAfterRestart = !model.expectedUncertain;
      } else if (op === "corrupt") {
        writeFileSync(stateFile, "corrupted-bytes", { mode: 0o600 });
        model.corrupted = true;
        await startSession(new Map());
      } else {
        const next = await freshExecutor();
        client!.observe({ method: "thread/started", params: { thread: { id: threadId } } });
        const receipt = await client!.reconcile({ threadId, executor: next.executor });
        if (model.activeEnvId && model.activeEnvId !== next.executor.environmentId) model.retiredEnvIds.add(model.activeEnvId);
        model.activeEnvId = next.executor.environmentId;
        model.committedGen = receipt.generation;
        model.expectedUncertain = false;
        model.mustReverifyAfterRestart = false;
        model.liveVerified = true;
      }

      await assertInvariants(step);
    }
  } finally {
    client?.close();
    await provider?.close();
    for (const exec of execs) await exec.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test(`codex environment durable-state simulator holds all invariants across seeds [${SEEDS.join(", ")}]`, { timeout: 60000 }, async () => {
  for (const seed of SEEDS) {
    await runSimulation(seed);
  }
});

const MUTATION_CASES: Array<{ mutant: Mutant; invariant: string }> = [
  { mutant: "skip-durable-commit", invariant: "no-verified-without-durable-commit" },
  { mutant: "flush-stale-queued-frame", invariant: "no-stale-generation-dispatch" },
  { mutant: "keep-verified-on-write-fail", invariant: "fail-closed-on-write-or-transition-failure" },
  { mutant: "trust-persisted-after-restart", invariant: "restart-requires-reverification" },
  { mutant: "forget-used-ids-on-restart", invariant: "retired-ids-never-reused" },
  { mutant: "fallback-empty-on-corrupt-read", invariant: "corrupted-store-fails-closed" },
];

for (const { mutant, invariant } of MUTATION_CASES) {
  test(`codex environment simulator catches mutation ${mutant} via invariant ${invariant}`, { timeout: 20000 }, async () => {
    await assert.rejects(
      runSimulation(1, mutant),
      (error: unknown) => error instanceof SimViolation && error.invariant === invariant,
    );
  });
}
