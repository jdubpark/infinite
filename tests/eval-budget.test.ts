import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { evalBudgetSource, evaluateFuse, evaluateProviderBudget, summarizeProjectBudgets, usdExceeded, type EvalBudgetSource } from "../packages/host/src/eval-budget.js";
import { EvalHost } from "../packages/host/src/eval-host.js";
import type { GraderProbe } from "../packages/host/src/eval-grader.js";
import type { EvalProbe } from "../packages/host/src/eval-identity.js";
import { EvalJobs } from "../packages/host/src/eval-jobs.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { TrialJobs, type TrialGates } from "../packages/host/src/eval-trial-jobs.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import { evalTrialsModule, finishTrial, insertTrial, startTrial } from "../packages/host/src/eval-trial-store.js";
import type { BaselineJobRequest, ComparisonJobRequest, EvalRefusal, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import { HaltService } from "../packages/host/src/halt/service.js";
import { JudgeCalibrations } from "../packages/host/src/judge-calibration-jobs.js";
import { judgeCalibrationsModule } from "../packages/host/src/judge-store.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config, Provider } from "../packages/host/src/types.js";
import type { ProviderSpendSnapshot, UsagePeriod, UsageRecord } from "../packages/host/src/usage.js";
import { UsageService, type UsageSessionRow } from "../packages/host/src/usage-service.js";

const DAY_MS = 86_400_000;
const START = Date.parse("2026-11-16T10:00:00.000Z");
const PROJECT_A = "project-budget-a";
const PROJECT_B = "project-budget-b";
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

const cfg = (profile: TeamModelProfile): TrialConfiguration => ({ profile, guidance: "as-of-base", knowledge: "none" });
const baselineReq = (profiles: TeamModelProfile[], extra: Partial<BaselineJobRequest> = {}): BaselineJobRequest => ({
  kind: "baseline",
  configurations: profiles.map(cfg),
  trialsPerTask: 1,
  limits: { maxTrials: 20, maxWallMinutes: 10_000 },
  ...extra,
});
const compareReq = (profiles: TeamModelProfile[], extra: Partial<ComparisonJobRequest> = {}): ComparisonJobRequest => ({
  kind: "compare",
  configurations: profiles.map(cfg),
  trialsPerTask: 1,
  limits: { maxTrials: 20, maxWallMinutes: 600 },
  ...extra,
});

function measuredSnapshot(provider: Provider, period: UsagePeriod, usd: number, now = new Date(START)): ProviderSpendSnapshot {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const end = new Date(Date.parse(start) + DAY_MS).toISOString();
  return {
    measured: true,
    provider,
    period: { kind: period, start, end },
    usd,
    tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    messages: 1,
    unpriced: 0,
    unmeasuredSessions: 0,
    partialSessions: 0,
  };
}

function unmeasuredSnapshot(
  provider: Provider,
  period: UsagePeriod,
  reason: Extract<ProviderSpendSnapshot, { measured: false }>["reason"],
  usd?: number,
): ProviderSpendSnapshot {
  return {
    measured: false,
    provider,
    period: { kind: period, start: "2026-11-16T00:00:00.000Z", end: "2026-11-17T00:00:00.000Z" },
    reason,
    ...(usd === undefined ? {} : { usd }),
  };
}

function defaultGates(overrides: Partial<TrialGates> = {}): TrialGates {
  return {
    identity: { state: "ready", storage: true, fetch: "refused" } as EvalProbe,
    grader: { state: "ready", storage: true, version: 2 } as GraderProbe,
    hostLoadHeld: false,
    halted: () => false,
    limited: new Set<Provider>(),
    freeSlots: async () => 8,
    trialLive: false,
    ...overrides,
  };
}

function seedTask(store: EvidenceStore, projectId: string, taskId: string, at: string): void {
  store.write(tx => {
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

function completeTrial(store: EvidenceStore, projectId: string, jobId: string, taskId: string, configuration: TrialConfiguration, slot: number, at: string): void {
  const trialId = randomUUID();
  store.write(tx => {
    insertTrial(tx, {
      trialId, jobId, taskId, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot, attempt: 0,
      projectId, configuration, keepDays: 365,
    }, at);
    startTrial(tx, trialId, at);
    finishTrial(tx, trialId, { grade: GRADED, configId: "cfg-1", profileEpoch: 1, sessionId: null, patchKeepDays: 90 }, at);
  });
}

function makeRig(options: {
  projects: { id: string; eval: Record<string, unknown> }[];
  usageBudgets?: Record<string, { usd: number; period?: UsagePeriod }>;
  budget?: EvalBudgetSource;
}) {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-budget-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  let clock = START;
  const now = () => new Date(clock).toISOString();
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  store.register(configurationModule());
  const config = {
    stateDir: join(root, "state"),
    runDir: join(root, "runs"),
    keyFile: join(root, "vault.key"),
    maxSessions: 16,
    projects: options.projects.map(item => ({ id: item.id, name: item.id, path: "/srv/unused", source: { mode: "github" }, team: { eval: item.eval } })),
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: {
        prefix: { command: "/usr/bin/sudo", args: ["-n"] },
        root: "/var/lib/infinite-eval",
        agents: {
          opencode: { command: "opencode", args: [] },
          claude: { command: "claude", args: [] },
          codex: { command: "codex", args: [] },
        },
      },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
    ...(options.usageBudgets ? { usage: { prices: {}, accounts: {}, budgets: options.usageBudgets } } : {}),
  } as unknown as Config;
  const trial = new TrialJobs({ store, config, now, ...(options.budget ? { budget: options.budget } : {}) });
  const jobs = new EvalJobs({
    store, config, now,
    baseline: { views: (db, rows) => trial.views(db, rows), digest: (projectId, jobId) => trial.digest(projectId, jobId) },
  });
  return {
    root, store, config, trial, jobs, now,
    setClock: (ms: number) => { clock = ms; },
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeUsageRig(options: {
  usagePrices?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
  usageBudgets?: Record<string, { usd: number; period: UsagePeriod }>;
  projectEval: Record<string, unknown>;
  fuseProjectLimit?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-budget-usage-"));
  const key = randomBytes(32);
  let clock = START;
  const now = () => new Date(clock).toISOString();
  const stateDir = join(root, "state");
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(stateDir), vaultKey: key });
  const config = {
    stateDir,
    runDir: join(root, "runs"),
    keyFile: join(root, "vault.key"),
    maxSessions: 16,
    projects: [{ id: PROJECT_A, name: PROJECT_A, path: "/srv/unused", source: { mode: "github", repository: "example/app", baseBranch: "main" }, team: { eval: options.projectEval } }],
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: {
        prefix: { command: "/usr/bin/sudo", args: ["-n"] },
        root: "/var/lib/infinite-eval",
        agents: {
          opencode: { command: "opencode", args: [] },
          claude: { command: "claude", args: [] },
          codex: { command: "codex", args: [] },
        },
      },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
    usage: {
      prices: options.usagePrices ?? { "deepseek/deepseek-flash": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      accounts: {},
      budgets: options.usageBudgets ?? {},
    },
    ...(options.fuseProjectLimit === undefined ? {} : { autonomy: { fuse: { project: { launchesPerHour: options.fuseProjectLimit }, host: { launchesPerHour: 100 } } } }),
  } as unknown as Config;
  const eventsBySession = new Map<string, { seq: number; at: string; type: string; data: unknown }[]>();
  let failList = false;
  const manager = {
    list: async () => {
      if (failList) throw new Error("manager failed");
      return [];
    },
    events: (id: string, after: number) => {
      const list = (eventsBySession.get(id) ?? []).filter(event => event.seq > after);
      return { events: list, cursor: list.at(-1)?.seq ?? after, more: false };
    },
  } as unknown as Manager;
  const usage = new UsageService(config, key, manager, store);
  const fuse = new FuseService({ config, key, store, sessionExists: () => false, now: () => clock });
  const halt = new HaltService({ config, key });
  const gate = halt.gate(fuse);
  const host = new EvalHost({
    config,
    store,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: "head" }) as never },
    hostLoad: { held: () => undefined },
    halt: () => halt,
    runs: () => [],
    now,
    usage: () => usage,
    fuse: () => gate,
  });
  const trialJobs = new TrialJobs({ store, config, now, budget: evalBudgetSource({ usage: () => usage, fuse: () => gate }) });
  return {
    root, store, config, usage, fuse, halt, gate, host, trialJobs, eventsBySession, now,
    setClock: (ms: number) => { clock = ms; },
    setFailList: (value: boolean) => { failList = value; },
    addOpenCodeUsage: async (sessionId: string, records: UsageRecord[], rowOverrides: Partial<UsageSessionRow> = {}) => {
      const existing = eventsBySession.get(sessionId) ?? [];
      const next = [...existing, ...records.map((record, index) => ({
        seq: existing.length + index + 1,
        at: record.completedAt,
        type: "usage",
        data: record,
      }))];
      eventsBySession.set(sessionId, next);
      await usage.tick([{
        id: sessionId,
        provider: "opencode",
        projectId: PROJECT_A,
        createdAt: records[0]?.completedAt ?? now(),
        status: "running",
        runtime: { nativeUi: "opencode" },
        ...rowOverrides,
      } as unknown as UsageSessionRow]);
    },
    cleanup: () => {
      host.close();
      fuse.stop();
      halt.stop();
      usage.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function openCodeRecord(completedAt: string, partId: string, inputTokens: number, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "opencode",
    providerId: "deepseek",
    modelId: "deepseek-flash",
    messageId: `msg-${partId}`,
    partId,
    modelSource: "reported",
    completedAt,
    tokens: { input: inputTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    reportedCost: 0,
    ...overrides,
  };
}

test("evaluateProviderBudget enforces configured USD ceilings, precision, and fail-closed measurability", () => {
  const now = new Date(START);
  assert.equal(usdExceeded(0.3 - 1e-12, 0.3), true);
  assert.equal(usdExceeded(0.299999, 0.3), false);
  assert.equal(usdExceeded(0, 0), true);
  assert.equal(usdExceeded(0, 1e-7), false);

  const badLimit = evaluateProviderBudget("opencode", [{ source: "project", usd: Number.NaN, period: "day" }], () => measuredSnapshot("opencode", "day", 0), now);
  assert.equal(badLimit.state === "unmeasurable" && badLimit.reason, "invalid-measurement");
  const badUsd = evaluateProviderBudget("opencode", [{ source: "project", usd: 5, period: "day" }], () => measuredSnapshot("opencode", "day", -1), now);
  assert.equal(badUsd.state === "unmeasurable" && badUsd.reason, "invalid-measurement");

  assert.deepEqual(evaluateProviderBudget("opencode", [], undefined, now), { state: "unconfigured", provider: "opencode" });

  const missingReader = evaluateProviderBudget("opencode", [{ source: "project", usd: 5, period: "day" }], undefined, now);
  assert.equal(missingReader.state, "unmeasurable");
  assert.equal(missingReader.state === "unmeasurable" && missingReader.reason, "ledger-unavailable");

  const admitted = evaluateProviderBudget(
    "opencode",
    [{ source: "project", usd: 5, period: "day" }, { source: "host", usd: 20, period: "month" }],
    (provider, period) => measuredSnapshot(provider, period, period === "day" ? 2.5 : 15),
    now,
  );
  assert.equal(admitted.state, "admitted");

  const hostExceeded = evaluateProviderBudget(
    "opencode",
    [{ source: "project", usd: 5, period: "day" }, { source: "host", usd: 20, period: "month" }],
    (provider, period) => measuredSnapshot(provider, period, period === "day" ? 2.5 : 20),
    now,
  );
  assert.equal(hostExceeded.state, "exceeded");
  assert.equal(hostExceeded.state === "exceeded" && hostExceeded.source, "host");

  const exceededBeatsUnmeasurable = evaluateProviderBudget(
    "opencode",
    [{ source: "project", usd: 5, period: "day" }],
    (provider, period) => unmeasuredSnapshot(provider, period, "unpriced-records", 5.25),
    now,
  );
  assert.equal(exceededBeatsUnmeasurable.state, "exceeded");

  const underWithGapFailsClosed = evaluateProviderBudget(
    "opencode",
    [{ source: "project", usd: 5, period: "day" }],
    (provider, period) => unmeasuredSnapshot(provider, period, "unpriced-records", 2.0),
    now,
  );
  assert.equal(underWithGapFailsClosed.state, "unmeasurable");
  assert.equal(underWithGapFailsClosed.state === "unmeasurable" && underWithGapFailsClosed.reason, "unpriced-records");

  const wrongProvider = evaluateProviderBudget(
    "claude",
    [{ source: "project", usd: 5, period: "day" }],
    (_provider, period) => measuredSnapshot("opencode", period, 0),
    now,
  );
  assert.equal(wrongProvider.state, "unmeasurable");
  assert.equal(wrongProvider.state === "unmeasurable" && wrongProvider.reason, "invalid-measurement");

  const throwing = evaluateProviderBudget(
    "opencode",
    [{ source: "project", usd: 5, period: "day" }],
    () => { throw new Error("boom"); },
    now,
  );
  assert.equal(throwing.state, "unmeasurable");
  assert.equal(throwing.state === "unmeasurable" && throwing.reason, "ledger-unavailable");

  assert.deepEqual(evaluateFuse(undefined, PROJECT_A), { state: "clear" });
  assert.deepEqual(evaluateFuse(() => { throw new Error("fuse crash"); }, PROJECT_A), { state: "open", cause: "unavailable" });
});

test("provider USD budget admits under budget, refuses when exhausted, and resumes on period rollover", async () => {
  let spendByDay = 2.0;
  const r = makeRig({
    projects: [{
      id: PROJECT_A,
      eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } },
    }],
    budget: {
      providerSpend: (provider, period, now) => {
        const dayOffset = Math.floor((now.getTime() - START) / DAY_MS);
        return measuredSnapshot(provider, period, dayOffset === 0 ? spendByDay : 0, now);
      },
    },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:run-1:t01", r.now());
    seedTask(r.store, PROJECT_A, "captured:run-1:t02", r.now());

    const created = r.trial.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in created, `expected job creation under budget, got ${JSON.stringify(created)}`);
    assert.equal(created.job.dailyCap, null, "no trialsPerDay needed when providerBudgets is configured");

    const first = await r.trial.next(defaultGates());
    assert.equal(first.kind, "trial");
    if (first.kind === "trial") completeTrial(r.store, PROJECT_A, first.jobId, first.taskId, first.configuration, first.slot, r.now());

    spendByDay = 5.0;
    const held = await r.trial.next(defaultGates());
    assert.deepEqual(held, { kind: "wait", jobId: created.job.jobId, waiting: "provider-budget" });
    assert.equal(r.jobs.view(created.job.jobId)?.waiting, "provider-budget");

    r.setClock(START + DAY_MS);
    const nextDay = await r.trial.next(defaultGates());
    assert.equal(nextDay.kind, "trial", "the next UTC day resets the daily USD budget");
    assert.equal(nextDay.kind === "trial" && nextDay.taskId, "captured:run-1:t02");
  } finally {
    r.cleanup();
  }
});

test("create refuses immediately when provider budget is exhausted, unmeasurable, or unconfigured for the requested provider", () => {
  const spent: Record<string, ProviderSpendSnapshot> = {
    opencode: measuredSnapshot("opencode", "day", 5.0),
    claude: unmeasuredSnapshot("claude", "day", "provider-unmeasured"),
  };
  const r = makeRig({
    projects: [{
      id: PROJECT_A,
      eval: {
        focusedTest: FOCUSED,
        reportFormat: "junit",
        providerBudgets: { opencode: { usd: 5, period: "day" }, claude: { usd: 10, period: "day" } },
      },
    }],
    budget: {
      providerSpend: (provider, period) => spent[provider] ?? unmeasuredSnapshot(provider, period, "provider-unmeasured"),
    },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:run-1:t01", r.now());

    const over = r.trial.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(over.status, 409);
    assert.equal(over.code, "provider-budget-exceeded");

    const unmeasurable = r.trial.create(PROJECT_A, baselineReq([CLAUDE]), randomUUID()) as EvalRefusal;
    assert.equal(unmeasurable.status, 409);
    assert.equal(unmeasurable.code, "provider-budget-unmeasurable");

    const unconfiguredProvider = r.trial.create(PROJECT_A, baselineReq([CODEX]), randomUUID()) as EvalRefusal;
    assert.equal(unconfiguredProvider.status, 409);
    assert.equal(unconfiguredProvider.code, "eval-config-incomplete");

    assert.equal(r.jobs.list().length, 0, "refused creations leave no job row");
  } finally {
    r.cleanup();
  }
});

test("multi-provider independence: exhausting provider A does not block or misattribute to provider B", async () => {
  const usdByProvider: Record<string, number> = { opencode: 1.0, codex: 1.0 };
  const r = makeRig({
    projects: [
      {
        id: PROJECT_A,
        eval: {
          focusedTest: FOCUSED,
          reportFormat: "junit",
          providerBudgets: { opencode: { usd: 5, period: "day" }, codex: { usd: 5, period: "day" } },
        },
      },
      {
        id: PROJECT_B,
        eval: {
          focusedTest: FOCUSED,
          reportFormat: "junit",
          providerBudgets: { opencode: { usd: 5, period: "day" }, codex: { usd: 5, period: "day" } },
        },
      },
    ],
    budget: {
      providerSpend: (provider, period, now) => measuredSnapshot(provider, period, usdByProvider[provider] ?? 0, now),
    },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:run-a:t01", r.now());
    seedTask(r.store, PROJECT_B, "captured:run-b:t01", r.now());

    const jobA = r.trial.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID());
    r.setClock(START + 1_000);
    const jobB = r.trial.create(PROJECT_B, baselineReq([CODEX]), randomUUID());
    assert.ok("job" in jobA && "job" in jobB);

    usdByProvider.opencode = 6.0;
    usdByProvider.codex = 1.0;

    const picked = await r.trial.next(defaultGates());
    assert.equal(picked.kind, "trial", "provider B job still runs while provider A is exhausted");
    assert.equal(picked.kind === "trial" && picked.jobId, jobB.job.jobId);
    assert.equal(picked.kind === "trial" && picked.configuration.profile.provider, "codex");
    assert.equal(r.jobs.view(jobA.job.jobId)?.waiting, "provider-budget");

    if (picked.kind === "trial") completeTrial(r.store, PROJECT_B, picked.jobId, picked.taskId, picked.configuration, picked.slot, r.now());

    const afterB = await r.trial.next(defaultGates());
    assert.deepEqual(afterB, { kind: "wait", jobId: jobA.job.jobId, waiting: "provider-budget" });

    assert.equal((r.trial.create(PROJECT_B, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal).code, "provider-budget-exceeded");
    const newCodex = r.trial.create(PROJECT_B, baselineReq([CODEX]), randomUUID());
    assert.ok("job" in newCodex, "new job for provider B is still admitted while provider A is exhausted");
  } finally {
    r.cleanup();
  }
});

test("multi-provider baseline job runs provider B slots while provider A is exhausted without skipping the task", async () => {
  const usdByProvider: Record<string, number> = { opencode: 1.0, codex: 1.0 };
  const r = makeRig({
    projects: [{
      id: PROJECT_A,
      eval: {
        focusedTest: FOCUSED,
        reportFormat: "junit",
        providerBudgets: { opencode: { usd: 5, period: "day" }, codex: { usd: 5, period: "day" } },
      },
    }],
    budget: {
      providerSpend: (provider, period, now) => measuredSnapshot(provider, period, usdByProvider[provider] ?? 0, now),
    },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:run-1:t01", r.now());
    seedTask(r.store, PROJECT_A, "captured:run-1:t02", r.now());

    const created = r.trial.create(PROJECT_A, baselineReq([OPENCODE, CODEX]), randomUUID());
    assert.ok("job" in created);

    usdByProvider.opencode = 5.5;
    const first = await r.trial.next(defaultGates());
    assert.equal(first.kind, "trial");
    assert.equal(first.kind === "trial" && first.taskId, "captured:run-1:t01");
    assert.equal(first.kind === "trial" && first.configuration.profile.provider, "codex");
    if (first.kind === "trial") completeTrial(r.store, PROJECT_A, first.jobId, first.taskId, first.configuration, first.slot, r.now());

    const second = await r.trial.next(defaultGates());
    assert.deepEqual(second, { kind: "wait", jobId: created.job.jobId, waiting: "provider-budget" },
      "waits for provider A on task 1 rather than skipping task 1");

    usdByProvider.opencode = 0.0;
    const resumed = await r.trial.next(defaultGates());
    assert.equal(resumed.kind, "trial");
    assert.equal(resumed.kind === "trial" && resumed.taskId, "captured:run-1:t01");
    assert.equal(resumed.kind === "trial" && resumed.configuration.profile.provider, "opencode");
  } finally {
    r.cleanup();
  }
});

test("fail-closed behavior when budget is configured without a usage reader", async () => {
  const r = makeRig({
    projects: [{
      id: PROJECT_A,
      eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } },
    }],
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:run-1:t01", r.now());
    const refused = r.trial.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "provider-budget-unmeasurable");

    const summary = summarizeProjectBudgets({ opencode: { usd: 5, period: "day" } }, undefined, undefined, new Date(START));
    assert.deepEqual(summary, [{
      provider: "opencode",
      source: "project",
      period: "day",
      limitUsd: 5,
      spentUsd: null,
      state: "unmeasurable",
      reason: "ledger-unavailable",
    }]);
  } finally {
    r.cleanup();
  }
});

test("backwards compatibility: trialsPerDay works alone and acts as a secondary safety cap alongside providerBudgets", async () => {
  let spend = 0.5;
  const r = makeRig({
    projects: [
      {
        id: PROJECT_A,
        eval: { focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: 2 },
      },
      {
        id: PROJECT_B,
        eval: {
          focusedTest: FOCUSED,
          reportFormat: "junit",
          providerBudgets: { opencode: { usd: 5, period: "day" } },
          trialsPerDay: 1,
        },
      },
    ],
    budget: {
      providerSpend: (provider, period, now) => measuredSnapshot(provider, period, spend, now),
    },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:legacy:t01", r.now());
    seedTask(r.store, PROJECT_A, "captured:legacy:t02", r.now());
    seedTask(r.store, PROJECT_A, "captured:legacy:t03", r.now());
    const legacyJob = r.trial.create(PROJECT_A, baselineReq([CLAUDE]), randomUUID());
    assert.ok("job" in legacyJob, "legacy trialsPerDay-only project still creates jobs");
    for (let i = 0; i < 2; i += 1) {
      const next = await r.trial.next(defaultGates());
      assert.equal(next.kind, "trial");
      if (next.kind === "trial") completeTrial(r.store, PROJECT_A, next.jobId, next.taskId, next.configuration, next.slot, r.now());
    }
    assert.deepEqual(await r.trial.next(defaultGates()), { kind: "wait", jobId: legacyJob.job.jobId, waiting: "daily-cap" });
    assert.ok(!("code" in r.jobs.control(legacyJob.job.jobId, "cancel")));

    seedTask(r.store, PROJECT_B, "captured:both:t01", r.now());
    seedTask(r.store, PROJECT_B, "captured:both:t02", r.now());
    const bothJob = r.trial.create(PROJECT_B, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in bothJob);
    const firstBoth = await r.trial.next(defaultGates());
    assert.equal(firstBoth.kind, "trial");
    if (firstBoth.kind === "trial") completeTrial(r.store, PROJECT_B, firstBoth.jobId, firstBoth.taskId, firstBoth.configuration, firstBoth.slot, r.now());

    assert.deepEqual(await r.trial.next(defaultGates()), { kind: "wait", jobId: bothJob.job.jobId, waiting: "daily-cap" },
      "secondary trialsPerDay cap still holds when under USD budget");

    spend = 5.0;
    assert.deepEqual(await r.trial.next(defaultGates()), { kind: "wait", jobId: bothJob.job.jobId, waiting: "provider-budget" },
      "provider USD budget takes priority when exhausted");
  } finally {
    r.cleanup();
  }
});

test("integration with real UsageService, FuseService, EvalHost, and HTTP routes", async () => {
  const r = makeUsageRig({
    usagePrices: { "deepseek/deepseek-flash": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    usageBudgets: { opencode: { usd: 3, period: "month" } },
    projectEval: {
      focusedTest: FOCUSED,
      reportFormat: "junit",
      providerBudgets: { opencode: { usd: 1, period: "day" }, claude: { usd: 5, period: "day" } },
    },
    fuseProjectLimit: 1,
  });
  const app = express();
  app.use(express.json());
  r.host.routes(app, (_req, _res, next) => next(), (_req, _res, next) => next());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    seedTask(r.store, PROJECT_A, "captured:int:t01", r.now());
    seedTask(r.store, PROJECT_A, "captured:int:t02", r.now());
    seedTask(r.store, PROJECT_A, "captured:int:t03", r.now());

    await r.addOpenCodeUsage("sess-1", [openCodeRecord(r.now(), "p1", 400_000)]);
    const snapBefore = r.usage.providerSpend("opencode", "day", new Date(r.now()));
    assert.equal(snapBefore.measured, true);
    assert.equal(snapBefore.measured && snapBefore.usd, 0.4);

    const claudeSnap = r.usage.providerSpend("claude", "day", new Date(r.now()));
    assert.equal(claudeSnap.measured, false);
    assert.equal(!claudeSnap.measured && claudeSnap.reason, "provider-unmeasured");

    const claudePost = await fetch(`${base}/api/eval/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_A, requestId: randomUUID(), job: baselineReq([CLAUDE]) }),
    });
    assert.equal(claudePost.status, 409, "unmeasured Claude USD budget refuses fail-closed over HTTP");
    assert.equal(((await claudePost.json()) as { code: string }).code, "provider-budget-unmeasurable");

    const okPost = await fetch(`${base}/api/eval/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_A, requestId: randomUUID(), job: baselineReq([OPENCODE]) }),
    });
    assert.equal(okPost.status, 201);
    const createdBody = (await okPost.json()) as { created: boolean; job: { jobId: string } };
    const jobId = createdBody.job.jobId;

    const first = await r.trialJobs.next(defaultGates());
    assert.equal(first.kind, "trial");
    if (first.kind === "trial") completeTrial(r.store, PROJECT_A, first.jobId, first.taskId, first.configuration, first.slot, r.now());

    await r.addOpenCodeUsage("sess-2", [openCodeRecord(r.now(), "p2", 650_000)]);
    assert.deepEqual(await r.trialJobs.next(defaultGates()), { kind: "wait", jobId, waiting: "provider-budget" },
      "real UsageService spend $1.05 >= $1.00 daily budget halts further trials");

    const summaryRes = await fetch(`${base}/api/eval/projects/${PROJECT_A}`);
    assert.equal(summaryRes.status, 200);
    const summaryBody = (await summaryRes.json()) as {
      trials: { dailyCap: number | null; budgets: { provider: string; source: string; period: string; state: string; spentUsd: number | null; limitUsd: number; reason?: string }[] };
    };
    assert.equal(summaryBody.trials.dailyCap, null);
    assert.deepEqual(summaryBody.trials.budgets, [
      { provider: "claude", source: "project", period: "day", limitUsd: 5, spentUsd: null, state: "unmeasurable", reason: "provider-unmeasured" },
      { provider: "opencode", source: "project", period: "day", limitUsd: 1, spentUsd: 1.05, state: "exceeded" },
      { provider: "opencode", source: "host", period: "month", limitUsd: 3, spentUsd: 1.05, state: "admitted" },
    ]);

    r.setClock(START + DAY_MS);
    await r.addOpenCodeUsage("sess-unpriced", [openCodeRecord(r.now(), "p3", 100_000, { modelId: "unlisted-model" })]);
    assert.deepEqual(await r.trialJobs.next(defaultGates()), { kind: "wait", jobId, waiting: "budget-unmeasurable" },
      "an unpriced OpenCode record in the current day fails closed as budget-unmeasurable");

    r.setClock(START + 2 * DAY_MS);
    await r.addOpenCodeUsage("sess-day3", [openCodeRecord(r.now(), "p4", 200_000)]);
    const admit = r.fuse.admit({ launchId: randomUUID(), projectId: PROJECT_A, purpose: "work", role: "implementer", profileId: "opencode-light" });
    assert.equal(admit.ok, true);
    assert.deepEqual(await r.trialJobs.next(defaultGates()), { kind: "wait", jobId, waiting: "spend-fuse" },
      "an open spend fuse holds eval trials before preparing or launching");

    const cancelRes = await fetch(`${base}/api/eval/jobs/${jobId}/cancel`, { method: "POST" });
    assert.equal(cancelRes.status, 200);
    const fusePost = await fetch(`${base}/api/eval/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_A, requestId: randomUUID(), job: baselineReq([OPENCODE]) }),
    });
    assert.equal(fusePost.status, 409);
    assert.equal(((await fusePost.json()) as { code: string }).code, "spend-fuse-open");

    assert.equal(r.fuse.close({ scope: "project", projectId: PROJECT_A }), "closed");
    r.setClock(START + 3 * DAY_MS);
    await r.addOpenCodeUsage("sess-day4", [openCodeRecord(r.now(), "p5", 900_000)]);
    r.setClock(START + 4 * DAY_MS);
    await r.addOpenCodeUsage("sess-day5", [openCodeRecord(r.now(), "p6", 900_000)]);
    const monthOverPost = await fetch(`${base}/api/eval/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_A, requestId: randomUUID(), job: baselineReq([OPENCODE]) }),
    });
    assert.equal(monthOverPost.status, 409);
    assert.equal(((await monthOverPost.json()) as { code: string }).code, "provider-budget-exceeded");
    const monthSummaryRes = await fetch(`${base}/api/eval/projects/${PROJECT_A}`);
    const monthSummary = (await monthSummaryRes.json()) as { trials: { budgets: { provider: string; source: string; period: string; state: string; spentUsd: number | null }[] } };
    const dayRow = monthSummary.trials.budgets.find(item => item.provider === "opencode" && item.source === "project");
    const monthRow = monthSummary.trials.budgets.find(item => item.provider === "opencode" && item.source === "host");
    assert.equal(dayRow?.state, "admitted", "daily spend $0.90 is still under $1.00");
    assert.equal(monthRow?.state, "exceeded", "monthly spend $3.05 exceeds $3.00 host budget");

    assert.equal(r.usage.providerSpend("opencode", "week", new Date(START + 4 * DAY_MS)).measured, false);
    const nextWeek = r.usage.providerSpend("opencode", "week", new Date(START + 7 * DAY_MS));
    assert.equal(nextWeek.measured, true);
    assert.equal(nextWeek.measured && nextWeek.usd, 0, "Monday week rollover clears prior week spend and gaps");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    r.cleanup();
  }
});

test("real UsageService fails closed on unmeasured sessions, partial sessions, and unavailable ledger", async () => {
  const r = makeUsageRig({
    projectEval: {
      focusedTest: FOCUSED,
      reportFormat: "junit",
      providerBudgets: { opencode: { usd: 5, period: "day" } },
    },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:gap:t01", r.now());
    await r.usage.tick([{
      id: "sess-unmeasured",
      provider: "opencode",
      projectId: PROJECT_A,
      createdAt: r.now(),
      status: "exited",
    } as unknown as UsageSessionRow]);
    const unmeasuredSnap = r.usage.providerSpend("opencode", "day", new Date(r.now()));
    assert.equal(unmeasuredSnap.measured, false);
    assert.equal(!unmeasuredSnap.measured && unmeasuredSnap.reason, "unmeasured-sessions");
    assert.equal((r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal).code, "provider-budget-unmeasurable");

    r.setClock(START + DAY_MS);
    r.eventsBySession.set("sess-partial", [{ seq: 1, at: r.now(), type: "usage", data: { invalid: true } }]);
    await r.usage.tick([{
      id: "sess-partial",
      provider: "opencode",
      projectId: PROJECT_A,
      createdAt: r.now(),
      status: "exited",
      runtime: { nativeUi: "opencode" },
    } as unknown as UsageSessionRow]);
    const partialSnap = r.usage.providerSpend("opencode", "day", new Date(r.now()));
    assert.equal(partialSnap.measured, false);
    assert.equal(!partialSnap.measured && partialSnap.reason, "partial-sessions");
    assert.equal((r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal).code, "provider-budget-unmeasurable");

    r.setClock(START + 2 * DAY_MS);
    const created = r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in created, "clean day admits job creation");
    assert.ok(!("code" in r.host.control(created.job.jobId, "cancel")));

    r.setFailList(true);
    await r.usage.tick();
    const tickFailedRefusal = r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(tickFailedRefusal.status, 409);
    assert.equal(tickFailedRefusal.code, "provider-budget-unmeasurable");
    r.setFailList(false);

    r.store.close();
    const unavailableSnap = r.usage.providerSpend("opencode", "day", new Date(r.now()));
    assert.equal(unavailableSnap.measured, false);
    assert.equal(!unavailableSnap.measured && unavailableSnap.reason, "ledger-unavailable");
  } finally {
    r.cleanup();
  }
});

test("compare jobs wait when either paired provider budget is exhausted, while fully reused compare jobs still complete", async () => {
  const usdByProvider: Record<string, number> = { opencode: 1.0, codex: 1.0 };
  const r = makeRig({
    projects: [{
      id: PROJECT_A,
      eval: {
        focusedTest: FOCUSED,
        reportFormat: "junit",
        providerBudgets: { opencode: { usd: 5, period: "day" }, codex: { usd: 5, period: "day" } },
      },
    }],
    budget: {
      providerSpend: (provider, period, now) => measuredSnapshot(provider, period, usdByProvider[provider] ?? 0, now),
    },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:cmp:t01", r.now());
    seedTask(r.store, PROJECT_A, "captured:cmp:t02", r.now());

    const created = r.trial.create(PROJECT_A, compareReq([OPENCODE, CODEX]), randomUUID());
    assert.ok("job" in created);

    usdByProvider.codex = 5.0;
    assert.deepEqual(await r.trial.next(defaultGates()), { kind: "wait", jobId: created.job.jobId, waiting: "provider-budget" },
      "compare job waits when either paired provider exhausts its budget");

    assert.ok(!("code" in r.jobs.control(created.job.jobId, "cancel")));
    const priorJobId = "prior-reuse-job";
    r.store.write(tx => {
      tx.run(
        "INSERT INTO eval_jobs (job_id, project_ref, kind, status, request_id, created_at, expires_at, updated_at, payload) "
        + "VALUES (?, 'ref', 'baseline', 'completed', ?, ?, ?, ?, '{}')",
        priorJobId, priorJobId, r.now(), r.now(), r.now(),
      );
      tx.run("INSERT INTO eval_trial_counts (job_id, planned_tasks, planned_trials) VALUES (?, 2, 4)", priorJobId);
    });
    for (const taskId of ["captured:cmp:t01", "captured:cmp:t02"]) {
      for (const profile of [OPENCODE, CODEX]) {
        completeTrial(r.store, PROJECT_A, priorJobId, taskId, cfg(profile), 0, r.now());
      }
    }
    const reused = r.trial.create(PROJECT_A, compareReq([OPENCODE, CODEX]), randomUUID());
    assert.ok("job" in reused && reused.job.status === "completed",
      "a fully reused compare job spends no provider tokens and still completes");
  } finally {
    r.cleanup();
  }
});

test("host usage.budgets enables and enforces provider budgets without trialsPerDay, and removing the budget blocks the job", async () => {
  let daySpend = 0.5;
  let monthSpend = 8.0;
  const r = makeRig({
    projects: [{
      id: PROJECT_A,
      eval: { focusedTest: FOCUSED, reportFormat: "junit" },
    }],
    usageBudgets: { opencode: { usd: 10, period: "month" } },
    budget: {
      providerSpend: (provider, period, now) => measuredSnapshot(provider, period, period === "day" ? daySpend : monthSpend, now),
    },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:host:t01", r.now());
    seedTask(r.store, PROJECT_A, "captured:host:t02", r.now());

    const claudeRefused = r.trial.create(PROJECT_A, baselineReq([CLAUDE]), randomUUID()) as EvalRefusal;
    assert.equal(claudeRefused.code, "eval-config-incomplete", "host opencode budget does not cover claude without trialsPerDay");

    const created = r.trial.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in created, "host opencode budget alone enables opencode trials");

    const first = await r.trial.next(defaultGates());
    assert.equal(first.kind, "trial");
    if (first.kind === "trial") completeTrial(r.store, PROJECT_A, first.jobId, first.taskId, first.configuration, first.slot, r.now());

    (r.config.projects[0] as unknown as { team: { eval: Record<string, unknown> } }).team.eval.providerBudgets = { opencode: { usd: 5, period: "day" } };
    daySpend = 1.0;
    monthSpend = 10.0;
    assert.deepEqual(await r.trial.next(defaultGates()), { kind: "wait", jobId: created.job.jobId, waiting: "provider-budget" },
      "tighter host monthly budget blocks even while project daily budget has headroom");

    monthSpend = 4.0;
    delete (r.config.projects[0] as unknown as { team: { eval: Record<string, unknown> } }).team.eval.providerBudgets;
    delete r.config.usage!.budgets.opencode;
    assert.deepEqual(await r.trial.next(defaultGates()), { kind: "none" }, "removing all budgets blocks the open job");
    assert.equal(r.jobs.view(created.job.jobId)?.status, "blocked");
    assert.equal(r.jobs.view(created.job.jobId)?.reason, "configuration-changed");
  } finally {
    r.cleanup();
  }
});

test("judge calibration honors spend fuse and provider USD budgets fail-closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-budget-judge-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  const now = () => new Date(START).toISOString();
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  store.register(configurationModule());
  store.register(judgeCalibrationsModule(store, now));
  const config = {
    projects: [{ id: PROJECT_A, team: { eval: { providerBudgets: { opencode: { usd: 2, period: "day" } } } } }],
    teams: { lineup: { judge: OPENCODE } },
    eval: { member: { agents: { opencode: { command: "opencode", args: [] } } } },
  } as unknown as Config;
  let fuseOpen = false;
  let spend: ProviderSpendSnapshot = measuredSnapshot("opencode", "day", 0.5);
  const calibrations = new JudgeCalibrations({
    store,
    config,
    now,
    budget: {
      providerSpend: () => spend,
      fuseCheck: () => fuseOpen ? { state: "open", scope: "project", projectId: PROJECT_A, cause: "launch-rate", ownerClose: false } : { state: "closed" },
    },
  });
  try {
    store.write(tx => {
      tx.run("INSERT INTO eval_trial_counts (job_id, planned_tasks, planned_trials) VALUES ('seed', 30, 60)");
    });
    for (let i = 0; i < 30; i += 1) {
      const taskId = `captured:judge:t${String(i).padStart(2, "0")}`;
      seedTask(store, PROJECT_A, taskId, now());
      for (const resolved of [true, false]) {
        const trialId = `trial-${i}-${resolved ? "ok" : "no"}`;
        const configuration = cfg(CLAUDE);
        store.write(tx => {
          insertTrial(tx, { trialId, jobId: "seed", taskId, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot: resolved ? 0 : 1, attempt: 0, projectId: PROJECT_A, configuration, keepDays: 365 }, now());
          startTrial(tx, trialId, now());
          finishTrial(tx, trialId, { grade: { ...GRADED, expectedPassed: resolved ? 1 : 0, resolved }, configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90, patch: Buffer.from(`p-${trialId}`) }, now());
        });
      }
    }
    const created = calibrations.create({ requestId: "judge-budget-1", judgeProfileId: OPENCODE.id, pairs: 30 });
    assert.ok("calibration" in created, `expected calibration, got ${JSON.stringify(created)}`);

    assert.equal((await calibrations.next(defaultGates())).kind, "start");

    fuseOpen = true;
    assert.deepEqual(await calibrations.next(defaultGates()), { kind: "wait", reason: "spend-fuse" });
    fuseOpen = false;

    spend = measuredSnapshot("opencode", "day", 2.0);
    assert.deepEqual(await calibrations.next(defaultGates()), { kind: "wait", reason: "provider-budget" });

    spend = unmeasuredSnapshot("opencode", "day", "ledger-unavailable");
    assert.deepEqual(await calibrations.next(defaultGates()), { kind: "wait", reason: "budget-unmeasurable" });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
