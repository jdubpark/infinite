import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { evalBudgetSource, evaluateProviderBudget, type EvalBudgetSource } from "../packages/host/src/eval-budget.js";
import type { Grader, GraderProbe } from "../packages/host/src/eval-grader.js";
import type { EvalIdentity, EvalProbe } from "../packages/host/src/eval-identity.js";
import { EvalJobs } from "../packages/host/src/eval-jobs.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { TrialJobs, type TrialGates } from "../packages/host/src/eval-trial-jobs.js";
import { TrialPump, type TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import { evalTrialsModule, finishTrial } from "../packages/host/src/eval-trial-store.js";
import type { SourceResult } from "../packages/host/src/eval-trial.js";
import type { BaselineJobRequest, Capsule, ComparisonJobRequest, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import { HaltService } from "../packages/host/src/halt/service.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config, Provider } from "../packages/host/src/types.js";
import { periodStart, type UsageRecord } from "../packages/host/src/usage.js";
import { UsageService, type UsageSessionRow } from "../packages/host/src/usage-service.js";

type Mutant =
  | "skip-prelaunch-recheck"
  | "ignore-ingestion-gap"
  | "drop-project-scope"
  | "consume-attempt-on-budget-release"
  | "gate-before-completion"
  | "stale-rollover-spend";

const DEFAULT_SEEDS = 12;
const ONLY = process.env.EVAL_BUDGET_SIM_SEED;
const COUNT = Number(process.env.EVAL_BUDGET_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.EVAL_BUDGET_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "EVAL_BUDGET_SIM_SEED, EVAL_BUDGET_SIM_SEEDS, and EVAL_BUDGET_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const DAY_MS = 86_400_000;
const START = Date.parse("2026-11-16T08:00:00.000Z");
const PROJECT_A = "sim-project-a";
const PROJECT_B = "sim-project-b";
const BUDGET_A = 5;
const BUDGET_B = 5;
const FOCUSED = {
  command: "node",
  args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"],
};
const OPENCODE: TeamModelProfile = { id: "opencode-light", label: "OpenCode light", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light" };
const CLAUDE: TeamModelProfile = { id: "claude-strong", label: "Claude strong", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
const CODEX: TeamModelProfile = { id: "codex-strong", label: "Codex strong", provider: "codex", model: "gpt-5-codex", effort: "high", tier: "strong" };
const LINEUP = {
  coordinator: CLAUDE,
  integrator: CLAUDE,
  reviewer: CLAUDE,
  implementers: [OPENCODE, CLAUDE, CODEX],
  escalations: [],
  fallbacks: [],
};
const GRADED: TrialGrade = {
  ending: "graded",
  expectedPassed: 1,
  expectedTotal: 1,
  guardPassed: true,
  resolved: true,
  overwritten: 0,
  diff: null,
  isolation: "isolated",
};
const READY_PROBE: EvalProbe = { state: "ready", uid: 5001, storage: true, fetch: "refused" };
const CAPSULE = {
  objective: "Fix bug",
  steering: [],
  ownerAnswers: [],
  task: { id: "task-sim", title: "Fix bug", instructions: "Fix bug.", paths: ["a.txt"] },
} as Capsule;

const cfg = (profile: TeamModelProfile): TrialConfiguration => ({ profile, guidance: "as-of-base", knowledge: "none" });

class SimViolation extends Error {
  constructor(readonly invariant: string, readonly seed: number, readonly step: number, detail: string) {
    super(`seed ${seed}, step ${step}: ${invariant}: ${detail}; rerun with EVAL_BUDGET_SIM_SEED=${seed}`);
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

function openCodeRecord(completedAt: string, partId: string, usd: number, unpriced = false): UsageRecord {
  return {
    provider: "opencode",
    providerId: "deepseek",
    modelId: unpriced ? "unknown-model" : "deepseek-flash",
    messageId: `msg-${partId}`,
    partId,
    modelSource: unpriced ? "unknown" : "reported",
    completedAt,
    tokens: { input: Math.round(usd * 1_000_000), output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    reportedCost: 0,
  };
}

function defaultGates(): TrialGates {
  return {
    identity: READY_PROBE,
    grader: { state: "ready", storage: true, version: 2 } as GraderProbe,
    hostLoadHeld: false,
    halted: () => false,
    limited: new Set<Provider>(),
    freeSlots: async () => 8,
    trialLive: false,
  };
}

type LaunchEvent = {
  trialId: string;
  jobId: string;
  projectId: string;
  provider: Provider;
  at: string;
  projectSpendUsd: number;
  projectUnmeasurable: boolean;
  fuseOpen: boolean;
};

type ModelTrial = {
  projectId: string;
  usd: number;
  unpriced: boolean;
  at: string;
  sessionId: string;
};

class BudgetSimHarness {
  readonly root: string;
  readonly key: Buffer;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly config: Config;
  readonly mutant?: Mutant;
  clock = START;
  store!: EvidenceStore;
  usage!: UsageService;
  fuse!: FuseService;
  halt!: HaltService;
  trialJobs!: TrialJobs;
  evalJobs!: EvalJobs;
  pump!: TrialPump;

  readonly eventsBySession = new Map<string, { seq: number; at: string; type: string; data: unknown }[]>();
  readonly rowsBySession = new Map<string, UsageSessionRow>();
  readonly failingSessions = new Set<string>();
  readonly modelRecords: ModelTrial[] = [];
  readonly launches: LaunchEvent[] = [];
  pageSize = 200;
  fuseOpen = false;
  pendingPrepareHook?: (projectId: string) => Promise<void> | void;
  private eventSeq = 0;
  private sessionSeq = 0;
  private liveReplay: { trialId: string; jobId: string; projectId: string; provider: Provider } | undefined;

  constructor(mutant?: Mutant) {
    this.mutant = mutant;
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-eval-budget-sim-")));
    this.stateDir = join(this.root, "state");
    this.databasePath = evidenceDatabasePath(this.stateDir);
    this.key = randomBytes(32);
    this.config = {
      stateDir: this.stateDir,
      runDir: join(this.root, "runs"),
      keyFile: join(this.root, "vault.key"),
      maxSessions: 16,
      projects: [
        {
          id: PROJECT_A,
          name: PROJECT_A,
          path: "/srv/unused-a",
          source: { mode: "github", repository: "example/a", baseBranch: "main" },
          team: { eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: BUDGET_A, period: "day" } }, trialsPerDay: 50 } },
        },
        {
          id: PROJECT_B,
          name: PROJECT_B,
          path: "/srv/unused-b",
          source: { mode: "github", repository: "example/b", baseBranch: "main" },
          team: { eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: BUDGET_B, period: "day" } } } },
        },
      ],
      eval: {
        grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
        member: {
          prefix: { command: "/usr/bin/sudo", args: ["-n"] },
          root: join(this.root, "eval"),
          agents: {
            opencode: { command: "opencode", args: [] },
            claude: { command: "claude", args: [] },
            codex: { command: "codex", args: [] },
          },
        },
      },
      teams: { workspaceDir: join(this.root, "workspaces"), lineup: LINEUP },
      usage: {
        prices: { "deepseek/deepseek-flash": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
        accounts: {},
        budgets: {},
      },
    } as unknown as Config;
    this.openFromDisk();
  }

  now = () => new Date(this.clock).toISOString();

  openFromDisk(): void {
    this.liveReplay = undefined;
    this.store = new EvidenceStore({ databasePath: this.databasePath, vaultKey: this.key });
    this.store.register(evalCorpusModule(this.store, this.now));
    this.store.register(evalTrialsModule(this.store, this.now));
    this.store.register(configurationModule());

    const manager = {
      list: async () => [...this.rowsBySession.values()],
      events: (id: string, after: number) => {
        if (this.failingSessions.has(id)) throw new Error(`simulated journal error: ${id}`);
        const remaining = (this.eventsBySession.get(id) ?? []).filter(event => event.seq > after);
        const slice = remaining.slice(0, this.pageSize);
        return { events: slice, cursor: slice.at(-1)?.seq ?? after, more: remaining.length > slice.length };
      },
    } as unknown as Manager;

    this.usage = new UsageService(this.config, this.key, manager, this.store, { now: () => this.clock });
    this.fuse = new FuseService({ config: this.config, key: this.key, store: this.store, sessionExists: () => false, now: () => this.clock });
    this.halt = new HaltService({ config: this.config, key: this.key });

    const rawBudget = evalBudgetSource({
      usage: () => this.usage,
      fuse: () => ({
        check: ({ projectId }) => this.fuseOpen
          ? { state: "open" as const, scope: "project" as const, projectId, cause: "launch-rate" as const, ownerClose: false }
          : this.halt.gate(this.fuse).check({ projectId }),
      }),
    })!;
    const budget = this.wrapBudget(rawBudget);

    this.trialJobs = new TrialJobs({ store: this.store, config: this.config, now: this.now, budget });
    this.evalJobs = new EvalJobs({
      store: this.store,
      config: this.config,
      now: this.now,
      baseline: { views: (db, rows) => this.trialJobs.views(db, rows), digest: (projectId, jobId) => this.trialJobs.digest(projectId, jobId) },
    });

    const identity = {
      probe: async () => READY_PROBE,
      receive: async () => "failed",
      prepare: async () => "failed",
      check: async () => "failed",
      teamPrefix: () => undefined,
      setupPrefix: () => undefined,
      stop: async () => true,
      clean: async () => true,
      scrub: async () => true,
    } as unknown as EvalIdentity;

    const teams: TrialTeams = {
      createForReplay: async input => {
        const provider = input.profile.provider;
        const snap = this.usage.providerSpend(provider, "day", new Date(this.clock), input.projectId);
        this.launches.push({
          trialId: input.trialId,
          jobId: input.jobId,
          projectId: input.projectId,
          provider,
          at: this.now(),
          projectSpendUsd: snap.usd ?? 0,
          projectUnmeasurable: !snap.measured,
          fuseOpen: this.fuseOpen,
        });
        this.liveReplay = { trialId: input.trialId, jobId: input.jobId, projectId: input.projectId, provider };
      },
      replayState: async () => undefined,
      endReplay: async () => undefined,
      forgetReplay: async () => true,
      replayIds: () => [],
      providerLimits: () => [],
    } as unknown as TrialTeams;

    this.pump = new TrialPump({
      config: this.config,
      store: this.store,
      jobs: this.trialJobs,
      grader: { clean: async () => true } as unknown as Grader,
      identity,
      teams: () => teams,
      sessions: { list: async () => [], remove: async () => undefined } as never,
      source: { mirrorPath: () => join(this.root, "mirror.git"), status: () => ({ mode: "github", repository: "example/a", baseBranch: "main", mirrorHead: "head" }) as never },
      hostLoad: { held: () => undefined },
      halt: () => this.halt,
      graderProbe: async () => ({ state: "ready", storage: true, version: 2, uid: 5002 }),
      inventory: async () => [],
      now: this.now,
      prepareSource: async (_store, _taskId, ctx): Promise<SourceResult> => {
        if (this.pendingPrepareHook !== undefined) {
          const hook = this.pendingPrepareHook;
          this.pendingPrepareHook = undefined;
          await hook(ctx.projectId);
        }
        return { kind: "ready", baseCommit: "base", workspace: join(ctx.root, "trials", ctx.trialId, "work"), hiddenFiles: [], isolation: "isolated", capsule: CAPSULE, features: {} as never };
      },
    });
    this.applyMutant();
  }

  private wrapBudget(base: EvalBudgetSource): EvalBudgetSource {
    if (this.mutant === "drop-project-scope") {
      return {
        ...base,
        providerSpend: (provider, period, now, _projectId) => base.providerSpend!(provider, period, now, undefined),
      };
    }
    if (this.mutant === "stale-rollover-spend") {
      return {
        ...base,
        providerSpend: (provider, period, _now, projectId) => base.providerSpend!(provider, period, new Date(START), projectId),
      };
    }
    return base;
  }

  private applyMutant(): void {
    if (!this.mutant) return;
    if (this.mutant === "skip-prelaunch-recheck") {
      this.trialJobs.launchWait = () => undefined;
    } else if (this.mutant === "ignore-ingestion-gap") {
      const original = this.usage.providerSpend.bind(this.usage);
      this.usage.providerSpend = (provider, period, now = new Date(), projectId) => {
        const snap = original(provider, period, now, projectId);
        if (!snap.measured && (snap.reason === "read-failed" || snap.reason === "ingestion-incomplete" || snap.reason === "partial-sessions")) {
          return {
            measured: true,
            provider,
            ...(projectId === undefined ? {} : { projectId }),
            period: snap.period,
            usd: snap.usd ?? 0,
            tokens: snap.tokens ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            messages: snap.messages ?? 0,
            unpriced: 0,
            unmeasuredSessions: 0,
            partialSessions: 0,
          };
        }
        return snap;
      };
    } else if (this.mutant === "consume-attempt-on-budget-release") {
      const originalRelease = this.trialJobs.release.bind(this.trialJobs);
      this.trialJobs.release = (trial, waiting) => {
        if (waiting === "provider-budget" || waiting === "spend-fuse" || waiting === "budget-unmeasurable") {
          return "exhausted";
        }
        return originalRelease(trial, waiting);
      };
    } else if (this.mutant === "gate-before-completion") {
      const internal = this.trialJobs as unknown as {
        step: (tx: unknown, row: { job_id: string; project_ref: string; waiting: string | null }, refs: Map<string, string>, gates: TrialGates, free: number | undefined) => unknown;
        waitOn: (tx: unknown, row: unknown, waiting: string) => unknown;
        providerBlock: (projectId: string, provider: Provider, settings: unknown, limited: ReadonlySet<Provider> | undefined, now: Date) => string | undefined;
      };
      const originalStep = internal.step.bind(this.trialJobs);
      internal.step = (tx, row, refs, gates, free) => {
        const projectId = refs.get(row.project_ref);
        if (projectId !== undefined) {
          const project = this.config.projects.find(item => item.id === projectId);
          const verdict = evaluateProviderBudget(
            "opencode",
            projectId,
            project?.team?.eval?.providerBudgets?.opencode ? [{ source: "project", usd: project.team.eval.providerBudgets.opencode.usd, period: "day" }] : [],
            (provider, period, now, pid) => this.usage.providerSpend(provider, period, now, pid),
            new Date(this.clock),
          );
          if (verdict.state === "exceeded") return internal.waitOn(tx, row, "provider-budget");
        }
        return originalStep(tx, row, refs, gates, free);
      };
    }
  }

  reconciled = false;

  async tickUsage(): Promise<void> {
    await this.usage.tick();
    this.reconciled = true;
  }

  restart(): void {
    this.reconciled = false;
    this.fuse.stop();
    this.halt.stop();
    this.usage.close();
    this.store.close();
    this.openFromDisk();
  }

  close(): void {
    try { this.fuse.stop(); } catch {}
    try { this.halt.stop(); } catch {}
    try { this.usage.close(); } catch {}
    try { this.store.close(); } catch {}
    rmSync(this.root, { recursive: true, force: true });
  }

  seedTask(projectId: string, taskId: string): void {
    const at = this.now();
    this.store.write(tx => {
      const ref = tx.index("project", projectId);
      tx.run(
        "INSERT OR IGNORE INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES (?, 'run', ?, ?, ?, 0, NULL)",
        `group-${taskId}`, ref, `group-${taskId}`, at,
      );
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
        + "captured_at, checked_at, payload, group_id, area_ref, validated_at) "
        + "VALUES (?, 'captured', 'run-1', 'member-1', ?, 'valid', 'stored', 'proven', 0, ?, ?, ?, ?, 'host', ?)",
        taskId, ref, at, at, tx.seal("eval_tasks", taskId, { projectId }), `group-${taskId}`, at,
      );
    });
  }

  recordSpend(projectId: string, usd: number, options: { sessionId?: string; count?: number; unpriced?: boolean } = {}): string {
    const sessionId = options.sessionId ?? `sim-oc-${++this.sessionSeq}`;
    const count = options.count ?? 1;
    const perEvent = usd / count;
    const existing = this.eventsBySession.get(sessionId) ?? [];
    const added = Array.from({ length: count }, () => {
      const partId = `p-${++this.eventSeq}`;
      const record = openCodeRecord(this.now(), partId, perEvent, options.unpriced === true);
      this.modelRecords.push({ projectId, usd: options.unpriced ? 0 : perEvent, unpriced: options.unpriced === true, at: this.now(), sessionId });
      return { seq: existing.length + 1, at: this.now(), type: "usage", data: record };
    });
    const combined = [...existing];
    for (const item of added) combined.push({ ...item, seq: combined.length + 1 });
    this.eventsBySession.set(sessionId, combined);
    this.rowsBySession.set(sessionId, {
      id: sessionId,
      provider: "opencode",
      projectId,
      createdAt: this.rowsBySession.get(sessionId)?.createdAt ?? this.now(),
      status: "running",
      runtime: { nativeUi: "opencode" },
    } as unknown as UsageSessionRow);
    return sessionId;
  }

  async settleLiveTrial(costUsd: number): Promise<void> {
    if (this.liveReplay === undefined) return;
    const live = this.liveReplay;
    this.liveReplay = undefined;
    this.store.write(tx => {
      finishTrial(tx, live.trialId, {
        grade: GRADED,
        configId: "cfg-1",
        profileEpoch: 1,
        sessionId: null,
        patchKeepDays: 90,
      }, this.now());
    });
    if (live.provider === "opencode" && costUsd > 0) {
      this.recordSpend(live.projectId, costUsd);
      await this.tickUsage();
    }
    (this.pump as unknown as { live: unknown }).live = undefined;
  }

  trueDaySpend(projectId: string): { usd: number; hasUnpriced: boolean } {
    const startMs = periodStart("day", new Date(this.clock)).getTime();
    let usd = 0;
    let hasUnpriced = false;
    for (const item of this.modelRecords) {
      if (item.projectId !== projectId) continue;
      const at = Date.parse(item.at);
      if (at >= startMs && at <= this.clock) {
        usd += item.usd;
        if (item.unpriced) hasUnpriced = true;
      }
    }
    return { usd: Math.round(usd * 1_000_000) / 1_000_000, hasUnpriced };
  }

  hasUnreadOrFailedSession(projectId: string): boolean {
    const stored = new Map(this.store.read(db => db.all<{ session_id: string; journal_cursor: number }>("SELECT session_id, journal_cursor FROM usage_sessions"))
      .map(row => [row.session_id, row.journal_cursor]));
    for (const [id, row] of this.rowsBySession) {
      if (row.provider !== "opencode" || row.projectId !== projectId) continue;
      if (this.failingSessions.has(id)) return true;
      const total = this.eventsBySession.get(id)?.length ?? 0;
      const cursor = stored.get(id) ?? 0;
      if (cursor < total) return true;
    }
    return false;
  }
}

function checkInvariants(
  h: BudgetSimHarness,
  seed: number,
  step: number,
  expectedJobs: Map<string, { projectId: string; requiredSlots: number; providers: Provider[] }>,
  checkedLaunches: { count: number },
): void {
  while (checkedLaunches.count < h.launches.length) {
    const launch = h.launches[checkedLaunches.count]!;
    checkedLaunches.count += 1;
    if (launch.fuseOpen) {
      throw new SimViolation("I1", seed, step, `launched ${launch.trialId} while spend fuse was open`);
    }
    if (launch.provider === "opencode") {
      const limit = launch.projectId === PROJECT_A ? BUDGET_A : BUDGET_B;
      if (launch.projectUnmeasurable) {
        throw new SimViolation("I1", seed, step, `launched ${launch.trialId} while project ${launch.projectId} spend was unmeasurable`);
      }
      if (launch.projectSpendUsd >= limit) {
        throw new SimViolation("I1", seed, step, `launched ${launch.trialId} at $${launch.projectSpendUsd} >= $${limit}`);
      }
    }
  }

  for (const projectId of [PROJECT_A, PROJECT_B]) {
    if (h.hasUnreadOrFailedSession(projectId)) {
      const snap = h.usage.providerSpend("opencode", "day", new Date(h.clock), projectId);
      if (snap.measured) {
        throw new SimViolation("I2", seed, step, `providerSpend(${projectId}) returned measured=true despite unread/failed journal`);
      }
    }
  }

  const stateB = h.trueDaySpend(PROJECT_B);
  const priorSpendB = h.modelRecords.filter(item => item.projectId === PROJECT_B).reduce((sum, item) => sum + item.usd, 0);
  if (h.reconciled && stateB.usd < BUDGET_B && !stateB.hasUnpriced && !h.hasUnreadOrFailedSession(PROJECT_B) && !h.fuseOpen) {
    const waitB = h.trialJobs.launchWait(PROJECT_B, "opencode");
    if (waitB !== undefined) {
      const invariant = priorSpendB < BUDGET_B ? "I3" : "I6";
      throw new SimViolation(invariant, seed, step, `SUT blocked project B (${waitB}) despite independent oracle showing clean project B day spend $${stateB.usd}`);
    }
  }

  for (const [jobId, info] of expectedJobs) {
    const trials = h.store.read(db => db.all<{ state: string; ending: string | null; attempt: number; slot: number }>(
      "SELECT state, ending, attempt, slot FROM eval_trials WHERE job_id = ?", jobId,
    ));
    const voidHosts = trials.filter(row => row.ending === "void-host");
    if (voidHosts.length > 0) {
      throw new SimViolation("I4", seed, step, `job ${jobId} recorded ${voidHosts.length} void-host attempt(s) from budget release`);
    }
    const maxAttempt = trials.reduce((max, row) => Math.max(max, row.attempt), 0);
    if (maxAttempt > 0) {
      throw new SimViolation("I4", seed, step, `job ${jobId} consumed attempt ${maxAttempt}`);
    }
    const view = h.evalJobs.view(jobId);
    if (view && "tasks" in view && view.tasks.skipped > 0) {
      throw new SimViolation("I4", seed, step, `job ${jobId} skipped ${view.tasks.skipped} task(s)`);
    }
    const finalCount = trials.filter(row => row.state === "final").length;
    if (finalCount > info.requiredSlots) {
      throw new SimViolation("I6", seed, step, `job ${jobId} ran ${finalCount} > ${info.requiredSlots} slots`);
    }
  }
}

async function runSeed(seed: number, counts: Record<string, number>, mutant?: Mutant): Promise<void> {
  const random = mulberry32(seed);
  const h = new BudgetSimHarness(mutant);
  const expectedJobs = new Map<string, { projectId: string; requiredSlots: number; providers: Provider[] }>();
  const checkedLaunches = { count: 0 };
  let step = 0;

  try {
    const tasksA = 2 + Math.floor(random() * 2);
    const tasksB = 1 + Math.floor(random() * 2);
    for (let i = 0; i < tasksA; i += 1) h.seedTask(PROJECT_A, `captured:sim-${seed}:a${i}`);
    for (let i = 0; i < tasksB; i += 1) h.seedTask(PROJECT_B, `captured:sim-${seed}:b${i}`);

    const useReadFail = seed % 2 === 0;
    if (useReadFail) {
      const failId = h.recordSpend(PROJECT_A, 6.0);
      h.failingSessions.add(failId);
      await h.tickUsage();
      counts.readFail = (counts.readFail ?? 0) + 1;
      checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);

      const refused = h.trialJobs.create(PROJECT_A, {
        kind: "baseline",
        configurations: [cfg(OPENCODE)],
        trialsPerTask: 1,
        limits: { maxTrials: 20, maxWallMinutes: 10_000 },
      }, randomUUID());
      if ("job" in refused) {
        throw new SimViolation("I2", seed, ++step, "created project A job despite failed journal read");
      }

      h.failingSessions.delete(failId);
      await h.tickUsage();
      checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);
    } else {
      h.pageSize = 1;
      h.recordSpend(PROJECT_A, 6.0, { count: 22 });
      await h.tickUsage();
      counts.pageCap = (counts.pageCap ?? 0) + 1;
      checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);

      const refused = h.trialJobs.create(PROJECT_A, {
        kind: "baseline",
        configurations: [cfg(OPENCODE)],
        trialsPerTask: 1,
        limits: { maxTrials: 20, maxWallMinutes: 10_000 },
      }, randomUUID());
      if ("job" in refused) {
        throw new SimViolation("I2", seed, ++step, "created project A job despite page-cap undrained journal");
      }

      h.pageSize = 200;
      await h.tickUsage();
      checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);
    }

    h.recordSpend(PROJECT_A, 1.0, { unpriced: true });
    await h.tickUsage();
    checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);

    const createdB = h.trialJobs.create(PROJECT_B, {
      kind: "baseline",
      configurations: [cfg(OPENCODE)],
      trialsPerTask: 1,
      limits: { maxTrials: 20, maxWallMinutes: 10_000 },
    } as BaselineJobRequest, randomUUID());
    if (!("job" in createdB)) {
      throw new SimViolation("I3", seed, ++step, `project B job refused (${createdB.code}) due to project A spend/unpriced record`);
    }
    const jobB = createdB.job.jobId;
    expectedJobs.set(jobB, { projectId: PROJECT_B, requiredSlots: tasksB, providers: ["opencode"] });
    checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);

    const prelaunchFault = seed % 3 === 0 ? "fuse" : "budget";
    h.pendingPrepareHook = async projectId => {
      counts[`prelaunch:${prelaunchFault}`] = (counts[`prelaunch:${prelaunchFault}`] ?? 0) + 1;
      if (prelaunchFault === "fuse") {
        h.fuseOpen = true;
      } else {
        h.recordSpend(projectId, BUDGET_B);
        await h.tickUsage();
      }
    };
    await h.pump.step();
    checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);

    if (random() < 0.7) {
      h.restart();
      counts.restarts = (counts.restarts ?? 0) + 1;
      checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);
    }

    h.fuseOpen = false;
    h.clock += DAY_MS;
    counts.rollovers = (counts.rollovers ?? 0) + 1;
    await h.tickUsage();
    checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);

    const compareMode = seed % 2 === 1;
    const reqA: BaselineJobRequest | ComparisonJobRequest = compareMode
      ? { kind: "compare", configurations: [cfg(OPENCODE), cfg(CODEX)], trialsPerTask: 1, limits: { maxTrials: 20, maxWallMinutes: 10_000 } }
      : { kind: "baseline", configurations: [cfg(OPENCODE)], trialsPerTask: 1, limits: { maxTrials: 20, maxWallMinutes: 10_000 } };
    const createdA = h.trialJobs.create(PROJECT_A, reqA, randomUUID());
    if (!("job" in createdA)) {
      throw new SimViolation("I6", seed, ++step, `project A job refused after rollover: ${createdA.code}`);
    }
    const jobA = createdA.job.jobId;
    expectedJobs.set(jobA, { projectId: PROJECT_A, requiredSlots: tasksA * reqA.configurations.length, providers: reqA.configurations.map(item => item.profile.provider) });

    let exhaustedFinalCheck = false;
    for (let guard = 0; guard < 40; guard += 1) {
      const open = [...expectedJobs.keys()].filter(id => h.evalJobs.view(id)?.status !== "completed");
      if (open.length === 0) break;

      await h.pump.step();
      checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);

      const live = (h.pump as unknown as { live?: { jobId: string; projectId: string; configuration: TrialConfiguration } }).live;
      if (live !== undefined) {
        const info = expectedJobs.get(live.jobId)!;
        const doneSoFar = h.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_trials WHERE job_id = ? AND state = 'final'", live.jobId)?.n ?? 0);
        const isLastSlot = doneSoFar + 1 === info.requiredSlots;
        const cost = isLastSlot ? BUDGET_A + 1 : 2.0;
        await h.settleLiveTrial(cost);
        if (isLastSlot && live.configuration.profile.provider !== "opencode") {
          h.recordSpend(live.projectId, BUDGET_A + 1);
          await h.tickUsage();
        }
        checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);

        if (isLastSlot) {
          h.restart();
          counts.restarts = (counts.restarts ?? 0) + 1;
          const finishPass = await h.trialJobs.next(defaultGates());
          const viewAfter = h.evalJobs.view(live.jobId);
          if (viewAfter?.status !== "completed" || viewAfter.reason !== "done" || viewAfter.waiting !== null) {
            throw new SimViolation(
              "I5",
              seed,
              ++step,
              `final-slot job ${live.jobId} stayed status=${viewAfter?.status} reason=${viewAfter?.reason} waiting=${viewAfter?.waiting} (pass=${finishPass.kind})`,
            );
          }
          exhaustedFinalCheck = true;
          counts.finalSlotDone = (counts.finalSlotDone ?? 0) + 1;
          await h.tickUsage();
        }
      } else {
        const pumpState = h.pump as unknown as { cooldown: number };
        if (pumpState.cooldown > 0) {
          await h.pump.step();
        } else {
          h.clock += DAY_MS;
          counts.rollovers = (counts.rollovers ?? 0) + 1;
          await h.tickUsage();
        }
      }
      checkInvariants(h, seed, ++step, expectedJobs, checkedLaunches);
    }

    for (const [jobId, info] of expectedJobs) {
      const view = h.evalJobs.view(jobId);
      if (view?.status !== "completed" || view.reason !== "done") {
        throw new SimViolation("I6", seed, ++step, `job ${jobId} failed to converge after rollover: status=${view?.status} waiting=${view?.waiting}`);
      }
      const finals = h.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_trials WHERE job_id = ? AND state = 'final'", jobId)?.n ?? 0);
      if (finals !== info.requiredSlots) {
        throw new SimViolation("I6", seed, ++step, `job ${jobId} ended with ${finals} final trials, expected ${info.requiredSlots}`);
      }
    }
    assert.ok(exhaustedFinalCheck, `seed ${seed} must exercise final-slot completion under exhausted budget`);
  } finally {
    h.close();
  }
}

test("seeded durable-state eval budget simulator preserves all invariants across restarts, rollovers, and faults", async t => {
  const counts: Record<string, number> = {};
  for (const seed of SEEDS) {
    await runSeed(seed, counts);
  }
  t.diagnostic(`eval budget sim: ${SEEDS.length} seeds from ${SEEDS[0]}, counts=${JSON.stringify(counts)}`);
  if (!DEFAULT_CORPUS) return;
  assert.ok((counts.readFail ?? 0) >= 4);
  assert.ok((counts.pageCap ?? 0) >= 4);
  assert.ok((counts["prelaunch:budget"] ?? 0) >= 4);
  assert.ok((counts["prelaunch:fuse"] ?? 0) >= 4);
  assert.ok((counts.restarts ?? 0) >= 12);
  assert.ok((counts.finalSlotDone ?? 0) >= 12);
});

const MUTANTS: readonly { name: string; mutant: Mutant; invariant: string }[] = [
  { name: "TrialPump skips pre-launch budget/fuse recheck before createForReplay", mutant: "skip-prelaunch-recheck", invariant: "I1" },
  { name: "UsageService ignores unread/failed journal ingestion gaps", mutant: "ignore-ingestion-gap", invariant: "I2" },
  { name: "project constraints evaluate host-wide spend without projectId", mutant: "drop-project-scope", invariant: "I3" },
  { name: "pre-launch budget release consumes attempts instead of WAITS_ONLY", mutant: "consume-attempt-on-budget-release", invariant: "I4" },
  { name: "step applies spend gates before finishing zero-remaining-slot jobs", mutant: "gate-before-completion", invariant: "I5" },
  { name: "budget evaluation ignores UTC period rollover", mutant: "stale-rollover-spend", invariant: "I6" },
];

for (const item of MUTANTS) {
  test(`eval budget simulator catches mutant: ${item.name} (${item.invariant})`, { skip: ONLY !== undefined }, async t => {
    let caught: SimViolation | undefined;
    for (const seed of SEEDS) {
      try {
        await runSeed(seed, {}, item.mutant);
      } catch (error) {
        if (error instanceof SimViolation) {
          caught = error;
          break;
        }
        throw error;
      }
    }
    assert.ok(caught, `none of ${SEEDS.length} seeds caught mutant ${item.mutant}`);
    assert.equal(caught.invariant, item.invariant, `expected ${item.invariant}, got ${caught.message}`);
    t.diagnostic(`caught at ${caught.message}`);
  });
}
