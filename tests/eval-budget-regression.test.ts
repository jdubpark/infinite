import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { evalBudgetSource, evaluateProviderBudget, summarizeProjectBudgets } from "../packages/host/src/eval-budget.js";
import { ComparisonPass } from "../packages/host/src/eval-comparison.js";
import type { Grader, GraderProbe } from "../packages/host/src/eval-grader.js";
import { EvalHost } from "../packages/host/src/eval-host.js";
import type { EvalIdentity, EvalProbe } from "../packages/host/src/eval-identity.js";
import { EvalJobs } from "../packages/host/src/eval-jobs.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { TrialJobs, type TrialGates } from "../packages/host/src/eval-trial-jobs.js";
import { TrialPump, type TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import { evalTrialsModule, finishTrial, insertTrial, startTrial } from "../packages/host/src/eval-trial-store.js";
import type { SourceResult } from "../packages/host/src/eval-trial.js";
import type { BaselineJobRequest, Capsule, ComparisonJobRequest, EvalRefusal, EvalSummary, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import { HaltService } from "../packages/host/src/halt/service.js";
import { JudgeCalibrations } from "../packages/host/src/judge-calibration-jobs.js";
import { calibrationJudgements, judgeCalibrationsModule } from "../packages/host/src/judge-store.js";
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
  judge: OPENCODE,
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
  objective: "Fix test",
  steering: [],
  ownerAnswers: [],
  task: { id: "task-1", title: "Fix test", instructions: "Fix test.", paths: ["a.txt"] },
} as Capsule;

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
  limits: { maxTrials: 20, maxWallMinutes: 10_000 },
  ...extra,
});

function defaultGates(overrides: Partial<TrialGates> = {}): TrialGates {
  return {
    identity: READY_PROBE,
    grader: { state: "ready", storage: true, version: 2 } as GraderProbe,
    hostLoadHeld: false,
    halted: () => false,
    limited: new Set<Provider>(),
    freeSlots: async () => 8,
    trialLive: false,
    ...overrides,
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

function completeTrial(store: EvidenceStore, projectId: string, jobId: string, taskId: string, configuration: TrialConfiguration, slot: number, at: string, resolved = true): void {
  const trialId = randomUUID();
  store.write(tx => {
    insertTrial(tx, {
      trialId, jobId, taskId, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot, attempt: 0,
      projectId, configuration, keepDays: 365,
    }, at);
    startTrial(tx, trialId, at);
    finishTrial(tx, trialId, {
      grade: { ...GRADED, expectedPassed: resolved ? 1 : 0, resolved },
      configId: "cfg-1",
      profileEpoch: 1,
      sessionId: null,
      patchKeepDays: 90,
      patch: Buffer.from(`diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${resolved ? "ok" : "no"}\n`),
    }, at);
  });
}

function multiProjectRig(options: {
  projectAEval: Record<string, unknown>;
  projectBEval: Record<string, unknown>;
  usageBudgets?: Record<string, { usd: number; period: UsagePeriod }>;
  pageSize?: number;
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-eval-budget-reg-")));
  const key = randomBytes(32);
  let clock = START;
  const now = () => new Date(clock).toISOString();
  const stateDir = join(root, "state");
  const databasePath = evidenceDatabasePath(stateDir);
  const config = {
    stateDir,
    runDir: join(root, "runs"),
    keyFile: join(root, "vault.key"),
    maxSessions: 16,
    projects: [
      { id: PROJECT_A, name: PROJECT_A, path: "/srv/unused-a", source: { mode: "github", repository: "example/a", baseBranch: "main" }, team: { eval: options.projectAEval } },
      { id: PROJECT_B, name: PROJECT_B, path: "/srv/unused-b", source: { mode: "github", repository: "example/b", baseBranch: "main" }, team: { eval: options.projectBEval } },
    ],
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: {
        prefix: { command: "/usr/bin/sudo", args: ["-n"] },
        root: join(root, "eval"),
        agents: {
          opencode: { command: "opencode", args: [] },
          claude: { command: "claude", args: [] },
          codex: { command: "codex", args: [] },
        },
      },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
    usage: {
      prices: { "deepseek/deepseek-flash": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      accounts: {},
      budgets: options.usageBudgets ?? {},
    },
  } as unknown as Config;

  const eventsBySession = new Map<string, { seq: number; at: string; type: string; data: unknown }[]>();
  const rowsBySession = new Map<string, UsageSessionRow>();
  const failingSessions = new Set<string>();
  const pageSize = options.pageSize ?? 200;

  const manager = {
    list: async () => [...rowsBySession.values()],
    events: (id: string, after: number) => {
      if (failingSessions.has(id)) throw new Error(`journal error for ${id}`);
      const remaining = (eventsBySession.get(id) ?? []).filter(event => event.seq > after);
      const slice = remaining.slice(0, pageSize);
      return { events: slice, cursor: slice.at(-1)?.seq ?? after, more: remaining.length > slice.length };
    },
  } as unknown as Manager;

  let store = new EvidenceStore({ databasePath, vaultKey: key });
  store.register(configurationModule());
  let usage = new UsageService(config, key, manager, store);
  let fuse = new FuseService({ config, key, store, sessionExists: () => false, now: () => clock });
  let halt = new HaltService({ config, key });
  let gate = halt.gate(fuse);
  let host = new EvalHost({
    config,
    store,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/a", baseBranch: "main", mirrorHead: "head" }) as never },
    hostLoad: { held: () => undefined },
    halt: () => halt,
    runs: () => [],
    now,
    usage: () => usage,
    fuse: () => gate,
  });
  let trialJobs = new TrialJobs({ store, config, now, budget: evalBudgetSource({ usage: () => usage, fuse: () => gate }) });
  let evalJobs = new EvalJobs({
    store, config, now,
    baseline: { views: (db, rows) => trialJobs.views(db, rows), digest: (projectId, jobId) => trialJobs.digest(projectId, jobId) },
  });

  const addSessionEvents = (projectId: string, sessionId: string, records: UsageRecord[], rowOverrides: Partial<UsageSessionRow> = {}) => {
    const existing = eventsBySession.get(sessionId) ?? [];
    const next = [...existing, ...records.map((record, index) => ({
      seq: existing.length + index + 1,
      at: record.completedAt,
      type: "usage",
      data: record,
    }))];
    eventsBySession.set(sessionId, next);
    rowsBySession.set(sessionId, {
      id: sessionId,
      provider: "opencode",
      projectId,
      createdAt: records[0]?.completedAt ?? now(),
      status: "running",
      runtime: { nativeUi: "opencode" },
      ...rowOverrides,
    } as unknown as UsageSessionRow);
  };

  const reopen = () => {
    host.close();
    fuse.stop();
    halt.stop();
    usage.close();
    store.close();
    store = new EvidenceStore({ databasePath, vaultKey: key });
    store.register(configurationModule());
    usage = new UsageService(config, key, manager, store);
    fuse = new FuseService({ config, key, store, sessionExists: () => false, now: () => clock });
    halt = new HaltService({ config, key });
    gate = halt.gate(fuse);
    host = new EvalHost({
      config,
      store,
      source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/a", baseBranch: "main", mirrorHead: "head" }) as never },
      hostLoad: { held: () => undefined },
      halt: () => halt,
      runs: () => [],
      now,
      usage: () => usage,
      fuse: () => gate,
    });
    trialJobs = new TrialJobs({ store, config, now, budget: evalBudgetSource({ usage: () => usage, fuse: () => gate }) });
    evalJobs = new EvalJobs({
      store, config, now,
      baseline: { views: (db, rows) => trialJobs.views(db, rows), digest: (projectId, jobId) => trialJobs.digest(projectId, jobId) },
    });
  };

  return {
    root,
    config,
    now,
    get store() { return store; },
    get usage() { return usage; },
    get fuse() { return fuse; },
    get halt() { return halt; },
    get gate() { return gate; },
    get host() { return host; },
    get trialJobs() { return trialJobs; },
    get evalJobs() { return evalJobs; },
    failingSessions,
    addSessionEvents,
    setClock: (ms: number) => { clock = ms; },
    reopen,
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

test("UsageService fails closed on per-session journal read errors and recovers after catch-up, including across restart", async () => {
  const r = multiProjectRig({
    projectAEval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } },
    projectBEval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:read-fail:a01", r.now());
    seedTask(r.store, PROJECT_B, "captured:read-fail:b01", r.now());

    r.addSessionEvents(PROJECT_A, "oc-read-fail", [openCodeRecord(r.now(), "p1", 6_000_000)]);
    r.failingSessions.add("oc-read-fail");
    await r.usage.tick();

    const snapA = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_A);
    assert.equal(snapA.measured, false);
    assert.equal(!snapA.measured && snapA.reason, "read-failed");

    const snapHost = r.usage.providerSpend("opencode", "day", new Date(r.now()));
    assert.equal(snapHost.measured, false);
    assert.equal(!snapHost.measured && snapHost.reason, "read-failed");

    const snapB = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_B);
    assert.equal(snapB.measured, true, "a journal read error in project A must not mark project B unmeasurable");
    assert.equal(snapB.measured && snapB.usd, 0);

    const refusedA = r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(refusedA.status, 409);
    assert.equal(refusedA.code, "provider-budget-unmeasurable");

    const admittedB = r.host.create(PROJECT_B, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in admittedB, "project B remains admitted when project A journal cannot be read");

    r.reopen();
    const afterReopen = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_A);
    assert.equal(afterReopen.measured, false, "fresh UsageService after restart must fail closed before reconciliation");
    assert.equal(!afterReopen.measured && afterReopen.reason, "reconciliation-pending");

    await r.usage.tick();
    const stillFailing = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_A);
    assert.equal(stillFailing.measured, false);
    assert.equal(!stillFailing.measured && stillFailing.reason, "read-failed");

    r.failingSessions.delete("oc-read-fail");
    await r.usage.tick();
    const recoveredA = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_A);
    assert.equal(recoveredA.measured, true);
    assert.equal(recoveredA.measured && recoveredA.usd, 6);

    const exceededA = r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(exceededA.status, 409);
    assert.equal(exceededA.code, "provider-budget-exceeded");
  } finally {
    r.cleanup();
  }
});

test("UsageService fails closed when page cap leaves a session undrained mid-session or unvisited, and recovers after draining", async () => {
  const r = multiProjectRig({
    projectAEval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 25, period: "day" } } },
    projectBEval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } },
    pageSize: 1,
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:cap:a01", r.now());
    seedTask(r.store, PROJECT_B, "captured:cap:b01", r.now());

    const records = Array.from({ length: 22 }, (_, i) => openCodeRecord(r.now(), `p-${i}`, 1_000_000));
    r.addSessionEvents(PROJECT_A, "oc-big-journal", records);
    r.addSessionEvents(PROJECT_B, "oc-second-backlog", [
      openCodeRecord(r.now(), "pb-0", 3_000_000),
      openCodeRecord(r.now(), "pb-1", 3_000_000),
    ]);

    await r.usage.tick();

    const snapA = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_A);
    assert.equal(snapA.measured, false, "session hitting MAX_PAGES=20 mid-stream must fail closed");
    assert.equal(!snapA.measured && snapA.reason, "ingestion-incomplete");
    assert.equal(snapA.usd, 20);

    const snapB = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_B);
    assert.equal(snapB.measured, false, "backlogged session after page cap exhausted must fail closed");
    assert.equal(!snapB.measured && snapB.reason, "ingestion-incomplete");
    assert.equal(snapB.usd, 3);

    const refusedA = r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(refusedA.code, "provider-budget-unmeasurable");
    const refusedB = r.host.create(PROJECT_B, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(refusedB.code, "provider-budget-unmeasurable");

    await r.usage.tick();

    const drainedA = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_A);
    assert.equal(drainedA.measured, true);
    assert.equal(drainedA.measured && drainedA.usd, 22);

    const drainedB = r.usage.providerSpend("opencode", "day", new Date(r.now()), PROJECT_B);
    assert.equal(drainedB.measured, true);
    assert.equal(drainedB.measured && drainedB.usd, 6);

    const admittedA = r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in admittedA, "project A is admitted once fully drained under $25");
    const exceededB = r.host.create(PROJECT_B, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(exceededB.code, "provider-budget-exceeded", "project B is refused once $6 spend is drained against $5 limit");
  } finally {
    r.cleanup();
  }
});

test("project budgets isolate spend and unpriced records per project while host ceilings enforce host-wide", async () => {
  const r = multiProjectRig({
    projectAEval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } },
    projectBEval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:iso:a01", r.now());
    seedTask(r.store, PROJECT_B, "captured:iso:b01", r.now());
    seedTask(r.store, PROJECT_B, "captured:iso:b02", r.now());

    r.addSessionEvents(PROJECT_A, "oc-proj-a", [
      openCodeRecord(r.now(), "a1", 6_000_000),
      openCodeRecord(r.now(), "a-unpriced", 500_000, { modelId: "unknown-model", modelSource: "unknown" }),
    ]);
    r.addSessionEvents(PROJECT_A, "oc-proj-a-unmeasured", [], { runtime: {} });
    r.addSessionEvents(PROJECT_B, "oc-proj-b", [openCodeRecord(r.now(), "b1", 2_000_000)]);
    await r.usage.tick();

    const refusedA = r.host.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID()) as EvalRefusal;
    assert.equal(refusedA.status, 409);
    assert.equal(refusedA.code, "provider-budget-exceeded");

    const createdB = r.trialJobs.create(PROJECT_B, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in createdB, "project A $6 spend + unpriced + unmeasured session do not block project B's $5 project budget");
    const firstB = await r.trialJobs.next(defaultGates());
    assert.equal(firstB.kind, "trial");
    assert.equal(firstB.kind === "trial" && firstB.projectId, PROJECT_B);

    const app = express();
    app.use(express.json());
    r.host.routes(app, (_req, _res, next) => next(), (_req, _res, next) => next());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const summaryB = await fetch(`${base}/api/eval/projects/${PROJECT_B}`).then(res => res.json() as Promise<EvalSummary>);
      assert.deepEqual(summaryB.trials.budgets, [{
        provider: "opencode",
        source: "project",
        period: "day",
        limitUsd: 5,
        spentUsd: 2,
        state: "admitted",
      }]);

      r.config.usage!.budgets.opencode = { usd: 8, period: "month" };
      const summaryWithHost = await fetch(`${base}/api/eval/projects/${PROJECT_B}`).then(res => res.json() as Promise<EvalSummary>);
      assert.deepEqual(summaryWithHost.trials.budgets, [
        { provider: "opencode", source: "project", period: "day", limitUsd: 5, spentUsd: 2, state: "admitted" },
        { provider: "opencode", source: "host", period: "month", limitUsd: 8, spentUsd: 8, state: "exceeded" },
      ]);

      const heldByHost = await r.trialJobs.next(defaultGates());
      assert.deepEqual(heldByHost, { kind: "wait", jobId: createdB.job.jobId, waiting: "provider-budget" },
        "host-wide $8 ceiling blocks project B once combined project A ($6) + project B ($2) reaches $8");

      r.config.usage!.budgets.opencode = { usd: 20, period: "month" };
      const heldByHostGap = await r.trialJobs.next(defaultGates());
      assert.deepEqual(heldByHostGap, { kind: "wait", jobId: createdB.job.jobId, waiting: "budget-unmeasurable" },
        "host-wide ceiling still fails closed when another project has an unmeasured session or unpriced record");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    const wrongScope = evaluateProviderBudget(
      "opencode",
      PROJECT_B,
      [{ source: "project", usd: 5, period: "day" }],
      () => ({ measured: true, provider: "opencode", projectId: PROJECT_A, period: { kind: "day", start: "", end: "" }, usd: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 0, unpriced: 0, unmeasuredSessions: 0, partialSessions: 0 }),
      new Date(r.now()),
    );
    assert.equal(wrongScope.state === "unmeasurable" && wrongScope.reason, "invalid-measurement");

    const hostGotProject = summarizeProjectBudgets(
      PROJECT_B,
      undefined,
      { opencode: { usd: 10, period: "month" } },
      { providerSpend: () => ({ measured: true, provider: "opencode", projectId: PROJECT_B, period: { kind: "month", start: "", end: "" }, usd: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 0, unpriced: 0, unmeasuredSessions: 0, partialSessions: 0 }) },
      new Date(r.now()),
    );
    assert.equal(hostGotProject[0]?.state, "unmeasurable");
    assert.equal(hostGotProject[0]?.reason, "invalid-measurement");
  } finally {
    r.cleanup();
  }
});

test("TrialPump rechecks spend fuse and USD budget after prepareSource before createForReplay without consuming an attempt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-eval-pump-recheck-")));
  const key = randomBytes(32);
  let clock = START;
  const now = () => new Date(clock).toISOString();
  const stateDir = join(root, "state");
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(stateDir), vaultKey: key });
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  store.register(configurationModule());
  const config = {
    stateDir,
    runDir: join(root, "runs"),
    keyFile: join(root, "vault.key"),
    maxSessions: 16,
    projects: [{
      id: PROJECT_A,
      name: PROJECT_A,
      path: "/srv/unused",
      source: { mode: "github", repository: "example/app", baseBranch: "main" },
      team: { eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } } },
    }],
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: join(root, "eval"), agents: { opencode: { command: "opencode", args: [] } } },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
  } as unknown as Config;

  let spendUsd = 1.0;
  let unmeasurable = false;
  let fuseOpen = false;
  let onPrepare: () => void = () => {};
  const launches: string[] = [];
  const cleans: string[] = [];

  const budget = {
    providerSpend: (provider: Provider, period: UsagePeriod, at: Date, projectId?: string): ProviderSpendSnapshot => {
      const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
      const end = new Date(Date.parse(start) + DAY_MS).toISOString();
      const scoped = projectId === undefined ? {} : { projectId };
      if (unmeasurable) return { measured: false, provider, ...scoped, period: { kind: period, start, end }, reason: "read-failed", usd: spendUsd };
      return {
        measured: true,
        provider,
        ...scoped,
        period: { kind: period, start, end },
        usd: spendUsd,
        tokens: { input: 1000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        messages: 1,
        unpriced: 0,
        unmeasuredSessions: 0,
        partialSessions: 0,
      };
    },
    fuseCheck: (projectId: string) => fuseOpen
      ? { state: "open" as const, scope: "project" as const, projectId, cause: "launch-rate" as const, ownerClose: false }
      : { state: "closed" as const },
  };

  const jobs = new TrialJobs({ store, config, now, budget });
  const evalJobs = new EvalJobs({
    store, config, now,
    baseline: { views: (db, rows) => jobs.views(db, rows), digest: (projectId, jobId) => jobs.digest(projectId, jobId) },
  });
  const identity = {
    probe: async () => READY_PROBE,
    receive: async () => "failed",
    prepare: async () => "failed",
    check: async () => "failed",
    teamPrefix: () => undefined,
    setupPrefix: () => undefined,
    stop: async () => true,
    clean: async () => { cleans.push("clean"); return true; },
    scrub: async () => { cleans.push("scrub"); return true; },
  } as unknown as EvalIdentity;
  const teams: TrialTeams = {
    createForReplay: async input => { launches.push(input.trialId); },
    replayState: async trialId => launches.includes(trialId) ? { phase: "running" as const } : undefined,
    endReplay: async () => undefined,
    forgetReplay: async () => true,
    replayIds: () => [],
    providerLimits: () => [],
  } as unknown as TrialTeams;
  const pump = new TrialPump({
    config,
    store,
    jobs,
    grader: { clean: async () => true } as unknown as Grader,
    identity,
    teams: () => teams,
    sessions: { list: async () => [], remove: async () => undefined } as never,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: "head" }) as never },
    hostLoad: { held: () => undefined },
    halt: () => ({ check: () => ({ state: "clear" as const }) }),
    graderProbe: async () => ({ state: "ready", storage: true, version: 2, uid: 5002 }),
    inventory: async () => [],
    now,
    prepareSource: async (_store, _taskId, ctx): Promise<SourceResult> => {
      onPrepare();
      return { kind: "ready", baseCommit: "base", workspace: join(ctx.root, "trials", ctx.trialId, "work"), hiddenFiles: [], isolation: "isolated", capsule: CAPSULE, features: {} as never };
    },
  });

  try {
    seedTask(store, PROJECT_A, "captured:recheck:t01", now());
    const created = jobs.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in created);
    const jobId = created.job.jobId;

    onPrepare = () => { spendUsd = 5.0; };
    await pump.step();
    assert.equal(launches.length, 0, "createForReplay must not be called when spend crossed budget during prepareSource");
    assert.equal(store.read(db => db.all("SELECT * FROM eval_trials WHERE job_id = ?", jobId)).length, 0, "no trial row or attempt consumed");
    assert.equal(evalJobs.view(jobId)?.waiting, "provider-budget");
    assert.ok(cleans.length >= 2, "prepared workspace cleaned on pre-launch release");

    for (let i = 0; i < 12; i += 1) {
      spendUsd = 1.0;
      onPrepare = () => { spendUsd = 5.0; };
      await pump.step();
      await pump.step();
    }
    assert.equal(launches.length, 0);
    assert.equal(store.read(db => db.all("SELECT * FROM eval_trials WHERE job_id = ?", jobId)).length, 0,
      "repeated budget pre-launch releases never exhaust TRIAL_RELEASES or skip the task");

    spendUsd = 1.0;
    onPrepare = () => { unmeasurable = true; };
    await pump.step();
    await pump.step();
    assert.equal(launches.length, 0);
    assert.equal(evalJobs.view(jobId)?.waiting, "budget-unmeasurable");

    unmeasurable = false;
    onPrepare = () => { fuseOpen = true; };
    await pump.step();
    await pump.step();
    assert.equal(launches.length, 0);
    assert.equal(evalJobs.view(jobId)?.waiting, "spend-fuse");

    fuseOpen = false;
    spendUsd = 1.0;
    onPrepare = () => {};
    await pump.step();
    await pump.step();
    assert.equal(launches.length, 1, "launches cleanly once budget and fuse stay clear through prepareSource");
    const rows = store.read(db => db.all<{ slot: number; attempt: number; state: string }>("SELECT slot, attempt, state FROM eval_trials WHERE job_id = ?", jobId))
      .map(row => ({ slot: row.slot, attempt: row.attempt, state: row.state }));
    assert.deepEqual(rows, [{ slot: 0, attempt: 0, state: "running" }]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TrialPump rechecks judge calibration budget and spend fuse before createForReplay without consuming an attempt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-judge-recheck-")));
  const key = randomBytes(32);
  const clock = START;
  const now = () => new Date(clock).toISOString();
  const stateDir = join(root, "state");
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(stateDir), vaultKey: key });
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  store.register(configurationModule());
  store.register(judgeCalibrationsModule(store, now));
  const config = {
    stateDir,
    runDir: join(root, "runs"),
    keyFile: join(root, "vault.key"),
    maxSessions: 16,
    projects: [{
      id: PROJECT_A,
      name: PROJECT_A,
      path: "/srv/unused",
      source: { mode: "github", repository: "example/app", baseBranch: "main" },
      team: { eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 3, period: "day" } } } },
    }],
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: join(root, "eval"), agents: { opencode: { command: "opencode", args: [] } } },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
  } as unknown as Config;

  let spendUsd = 0.5;
  let fuseOpen = false;
  let onPrepare: () => void = () => {};
  const launches: string[] = [];

  const budget = {
    providerSpend: (provider: Provider, period: UsagePeriod, at: Date, projectId?: string): ProviderSpendSnapshot => {
      const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
      const end = new Date(Date.parse(start) + DAY_MS).toISOString();
      return {
        measured: true,
        provider,
        ...(projectId === undefined ? {} : { projectId }),
        period: { kind: period, start, end },
        usd: spendUsd,
        tokens: { input: 1000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        messages: 1,
        unpriced: 0,
        unmeasuredSessions: 0,
        partialSessions: 0,
      };
    },
    fuseCheck: (projectId: string) => fuseOpen
      ? { state: "open" as const, scope: "project" as const, projectId, cause: "launch-rate" as const, ownerClose: false }
      : { state: "closed" as const },
  };

  const jobs = new TrialJobs({ store, config, now, budget });
  const judgements = new JudgeCalibrations({ store, config, now, budget });
  const identity = {
    probe: async () => READY_PROBE,
    receive: async () => "failed",
    prepare: async () => "failed",
    check: async () => "failed",
    teamPrefix: () => undefined,
    setupPrefix: () => undefined,
    stop: async () => true,
    clean: async () => { rmSync(join(root, "eval", "trials"), { recursive: true, force: true }); return true; },
    scrub: async () => true,
  } as unknown as EvalIdentity;
  const teams: TrialTeams = {
    createForReplay: async input => { launches.push(input.trialId); },
    replayState: async trialId => launches.includes(trialId) ? { phase: "running" as const } : undefined,
    endReplay: async () => undefined,
    forgetReplay: async () => true,
    replayIds: () => [],
    providerLimits: () => [],
  } as unknown as TrialTeams;
  const pump = new TrialPump({
    config,
    store,
    jobs,
    judgements,
    grader: { clean: async () => true } as unknown as Grader,
    identity,
    teams: () => teams,
    sessions: { list: async () => [], remove: async () => undefined } as never,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: "head" }) as never },
    hostLoad: { held: () => undefined },
    halt: () => ({ check: () => ({ state: "clear" as const }) }),
    graderProbe: async () => ({ state: "ready", storage: true, version: 2, uid: 5002 }),
    inventory: async () => [],
    now,
    prepareSource: async (_store, _taskId, ctx): Promise<SourceResult> => {
      onPrepare();
      const workspace = join(ctx.root, "trials", ctx.trialId, "work");
      mkdirSync(workspace, { recursive: true });
      execFileSync("git", ["init", "--quiet", workspace]);
      return { kind: "ready", baseCommit: "base", workspace, hiddenFiles: [], isolation: "isolated", capsule: CAPSULE, features: {} as never };
    },
  });

  try {
    store.write(tx => {
      tx.run("INSERT INTO eval_trial_counts (job_id, planned_tasks, planned_trials) VALUES ('seed', 30, 60)");
    });
    for (let i = 0; i < 30; i += 1) {
      const taskId = `captured:judge-recheck:t${String(i).padStart(2, "0")}`;
      seedTask(store, PROJECT_A, taskId, now());
      completeTrial(store, PROJECT_A, "seed", taskId, cfg(CLAUDE), 0, now(), true);
      completeTrial(store, PROJECT_A, "seed", taskId, cfg(CLAUDE), 1, now(), false);
    }

    const created = judgements.create({ requestId: "judge-recheck-1", judgeProfileId: OPENCODE.id, pairs: 30 });
    assert.ok("calibration" in created);
    const calibrationId = created.calibration.calibrationId;

    for (let i = 0; i < 12; i += 1) {
      spendUsd = 0.5;
      onPrepare = () => { spendUsd = 3.0; };
      await pump.step();
      await pump.step();
    }
    assert.equal(launches.length, 0, "duel member must not launch when judge budget is crossed during preparation");
    assert.equal(store.read(db => calibrationJudgements(db, calibrationId)).length, 0,
      "repeated pre-launch budget releases leave no judgement row and consume zero attempts");
    assert.equal(judgements.views().find(v => v.calibrationId === calibrationId)?.waiting, "provider-budget");

    spendUsd = 0.5;
    onPrepare = () => { fuseOpen = true; };
    await pump.step();
    await pump.step();
    assert.equal(launches.length, 0);
    assert.equal(judgements.views().find(v => v.calibrationId === calibrationId)?.waiting, "spend-fuse");

    fuseOpen = false;
    onPrepare = () => {};
    await pump.step();
    await pump.step();
    assert.equal(launches.length, 1);
    const rows = store.read(db => calibrationJudgements(db, calibrationId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.pairIndex, 0);
    assert.equal(rows[0]?.ordering, 0);
    assert.equal(rows[0]?.attempt, 0);
    assert.equal(rows[0]?.state, "live");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed compare and baseline jobs finish immediately before spend gates when final slot exhausts budget or trips fuse", async () => {
  const r = multiProjectRig({
    projectAEval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } }, trialsPerDay: 50 },
    projectBEval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } },
  });
  try {
    seedTask(r.store, PROJECT_A, "captured:done:a01", r.now());
    seedTask(r.store, PROJECT_A, "captured:done:a02", r.now());
    seedTask(r.store, PROJECT_B, "captured:done:b01", r.now());
    await r.usage.tick();

    const cmp = r.trialJobs.create(PROJECT_A, compareReq([OPENCODE, CODEX], { limits: { maxTrials: 20, maxWallMinutes: 10_000 } }), randomUUID());
    assert.ok("job" in cmp, `expected compare job, got ${JSON.stringify(cmp)}`);
    const cmpId = cmp.job.jobId;

    for (let i = 0; i < 4; i += 1) {
      const next = await r.trialJobs.next(defaultGates());
      assert.equal(next.kind, "trial", `expected compare trial ${i + 1}`);
      if (next.kind === "trial") completeTrial(r.store, PROJECT_A, cmpId, next.taskId, next.configuration, next.slot, r.now(), i % 2 === 0);
    }

    r.addSessionEvents(PROJECT_A, "oc-final-exhaust", [openCodeRecord(r.now(), "p1", 6_000_000)]);
    await r.usage.tick();

    const finishCompare = await r.trialJobs.next(defaultGates({ limited: new Set<Provider>(["opencode", "codex"]) }));
    assert.deepEqual(finishCompare, { kind: "none" }, "completed compare job must not return provider-budget or provider-limit wait");
    const cmpView = r.evalJobs.view(cmpId);
    assert.equal(cmpView?.status, "completed");
    assert.equal(cmpView?.reason, "done");
    assert.equal(cmpView?.waiting, null);

    const pass = new ComparisonPass({ store: r.store, config: r.config, now: r.now });
    pass.step();
    const report = r.host.report(cmpId);
    assert.ok("jobId" in report && report.jobId === cmpId, "comparison report is generated immediately without waiting for rollover");

    const base = r.trialJobs.create(PROJECT_B, baselineReq([OPENCODE], { limits: { maxTrials: 20, maxWallMinutes: 10_000 } }), randomUUID());
    assert.ok("job" in base);
    const baseId = base.job.jobId;
    const baseSlot = await r.trialJobs.next(defaultGates());
    assert.equal(baseSlot.kind, "trial");
    if (baseSlot.kind === "trial") completeTrial(r.store, PROJECT_B, baseId, baseSlot.taskId, baseSlot.configuration, baseSlot.slot, r.now(), true);

    r.addSessionEvents(PROJECT_B, "oc-final-b", [openCodeRecord(r.now(), "pb1", 6_000_000)]);
    await r.usage.tick();
    r.reopen();

    const finishBase = await r.trialJobs.next(defaultGates());
    assert.deepEqual(finishBase, { kind: "none" }, "completed baseline job finishes immediately after reopen even with budget exhausted");
    const baseView = r.evalJobs.view(baseId);
    assert.equal(baseView?.status, "completed");
    assert.equal(baseView?.reason, "done");
    assert.equal(baseView?.waiting, null);
  } finally {
    r.cleanup();
  }
});
