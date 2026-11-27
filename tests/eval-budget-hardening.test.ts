import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { evalBudgetSource } from "../packages/host/src/eval-budget.js";
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
import type { BaselineJobRequest, Capsule, ComparisonJobRequest, EvalRefusal, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import { HaltService } from "../packages/host/src/halt/service.js";
import { JudgeCalibrations } from "../packages/host/src/judge-calibration-jobs.js";
import { judgeCalibrationsModule } from "../packages/host/src/judge-store.js";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamService } from "../packages/host/src/teams.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config, Provider } from "../packages/host/src/types.js";
import type { ProviderSpendSnapshot, UsagePeriod, UsageRecord } from "../packages/host/src/usage.js";
import { USAGE_RECONCILE_STALE_MS, UsageService, type UsageSessionRow } from "../packages/host/src/usage-service.js";

const DAY_MS = 86_400_000;
const START = Date.parse("2026-11-16T10:00:00.000Z");
const PROJECT_A = "project-harden-a";
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
  judge: CLAUDE,
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
  task: { id: "task-harden", title: "Fix bug", instructions: "Fix bug.", paths: ["a.txt"] },
} as Capsule;

const cfg = (profile: TeamModelProfile): TrialConfiguration => ({ profile, guidance: "as-of-base", knowledge: "none" });
const baselineReq = (profiles: TeamModelProfile[]): BaselineJobRequest => ({
  kind: "baseline",
  configurations: profiles.map(cfg),
  trialsPerTask: 1,
  limits: { maxTrials: 20, maxWallMinutes: 10_000 },
});
const compareReq = (profiles: TeamModelProfile[]): ComparisonJobRequest => ({
  kind: "compare",
  configurations: profiles.map(cfg),
  trialsPerTask: 1,
  limits: { maxTrials: 20, maxWallMinutes: 10_000 },
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

function openCodeRecord(completedAt: string, partId: string, usd: number): UsageRecord {
  return {
    provider: "opencode",
    providerId: "deepseek",
    modelId: "deepseek-flash",
    messageId: `msg-${partId}`,
    partId,
    modelSource: "reported",
    completedAt,
    tokens: { input: Math.round(usd * 1_000_000), output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    reportedCost: 0,
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

function measuredSnap(provider: Provider, period: UsagePeriod, usd: number, at: Date, projectId?: string): ProviderSpendSnapshot {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
  const end = new Date(Date.parse(start) + DAY_MS).toISOString();
  return {
    measured: true,
    provider,
    ...(projectId === undefined ? {} : { projectId }),
    period: { kind: period, start, end },
    usd,
    tokens: { input: 1000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    messages: 1,
    unpriced: 0,
    unmeasuredSessions: 0,
    partialSessions: 0,
  };
}

test("Teams.launch rechecks USD budgets and withdrawn settings for delayed replay runs before creating a session", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-eval-delayed-launch-")));
  const key = randomBytes(32);
  const clock = START;
  const now = () => new Date(clock).toISOString();
  const stateDir = join(root, "state");
  const evalRoot = join(root, "eval");
  mkdirSync(join(evalRoot, "trials"), { recursive: true });
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(stateDir), vaultKey: key });
  store.register(configurationModule());

  const config = {
    stateDir,
    runDir: join(root, "runs"),
    keyFile: join(root, "vault.key"),
    maxSessions: 16,
    projects: [{
      id: PROJECT_A,
      name: PROJECT_A,
      path: join(root, "unused"),
      source: { mode: "github", repository: "example/app", baseBranch: "main" },
      team: { eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } } },
    }],
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: evalRoot, agents: { opencode: { command: "opencode", args: [] } } },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
    usage: { prices: { "deepseek/deepseek-flash": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, accounts: {}, budgets: {} },
  } as unknown as Config;

  const eventsBySession = new Map<string, { seq: number; at: string; type: string; data: unknown }[]>();
  const rowsBySession = new Map<string, UsageSessionRow>();
  let hostLoadHeld = true;
  let createdSessions = 0;

  const manager = {
    hostLoad: { held: () => (hostLoadHeld ? "Host load is high." : undefined) },
    list: async () => [...rowsBySession.values()],
    events: (id: string, after: number) => {
      const remaining = (eventsBySession.get(id) ?? []).filter(event => event.seq > after);
      return { events: remaining, cursor: remaining.at(-1)?.seq ?? after, more: false };
    },
    createTeamSession: async () => {
      createdSessions += 1;
      return { id: `sess-${createdSessions}`, status: "running" };
    },
    stop: async () => undefined,
    remove: async () => undefined,
    state: async () => undefined,
    meta: () => { const err = new Error("missing") as NodeJS.ErrnoException; err.code = "ENOENT"; throw err; },
  } as unknown as Manager;

  const usage = new UsageService(config, key, manager, store, { now: () => clock });
  await usage.tick();
  const fuse = new FuseService({ config, key, store, sessionExists: () => false, now: () => clock });
  const halt = new HaltService({ config, key });
  const gate = halt.gate(fuse);
  let teams!: TeamService;
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
  const evalHost = new EvalHost({
    config,
    store,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: "head" }) as never },
    hostLoad: manager.hostLoad,
    halt: () => halt,
    runs: () => [],
    teams: () => teams,
    sessions: manager,
    identity,
    now,
    usage: () => usage,
    fuse: () => gate,
  });
  teams = new TeamService(config, key, manager, (_projectId, start) => start(), undefined, undefined, {
    replayLaunchGate: input => evalHost.replayLaunchWait(input),
  });
  teams.useFuse(gate);
  teams.useUsage(usage);

  try {
    seedTask(store, PROJECT_A, "captured:delay:t01", now());
    const created = evalHost.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    const trialId = randomUUID();
    const workspace = join(evalRoot, "trials", trialId, "work");
    mkdirSync(workspace, { recursive: true });
    execFileSync("git", ["init", "--quiet", workspace]);
    execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", workspace, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", workspace, "commit", "--allow-empty", "-m", "base", "--quiet"]);
    const baseCommit = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    store.write(tx => {
      insertTrial(tx, {
        trialId, jobId, taskId: "captured:delay:t01", configRef: configRef(cfg(OPENCODE)), harness: TRIAL_HARNESS_VERSION, slot: 0, attempt: 0,
        projectId: PROJECT_A, configuration: cfg(OPENCODE), keepDays: 365,
      }, now());
      startTrial(tx, trialId, now());
    });

    await teams.createForReplay({
      trialId, jobId, purpose: "replay", projectId: PROJECT_A,
      profile: OPENCODE, capsule: CAPSULE, features: { role: "implementer", area: "host", kind: null, risk: "normal", featureVersion: 1 },
      baseCommit, workspace,
    });

    const teamsInternal = teams as unknown as {
      records: Map<string, { run: { id: string; members: unknown[] } }>;
      step(stored: unknown): Promise<void>;
      launch(stored: unknown, member: unknown): Promise<void>;
    };
    const stored = teamsInternal.records.get(trialId)!;
    const member = {
      memberId: "m-1", role: "implementer", title: "Eval", provider: "opencode", modelProfile: OPENCODE,
      sessionId: randomUUID(), cwd: workspace, baseCommit, prompt: "Fix bug", status: "queued", revision: 1,
    };
    stored.run.members.push(member);

    await teamsInternal.launch(stored, member);
    assert.equal(createdSessions, 0, "delayed by host load");
    assert.equal((await teams.replayState(trialId))?.phase, "running");

    eventsBySession.set("oc-concurrent", [{ seq: 1, at: now(), type: "usage", data: openCodeRecord(now(), "p1", 6) }]);
    rowsBySession.set("oc-concurrent", {
      id: "oc-concurrent", provider: "opencode", projectId: PROJECT_A, createdAt: now(), status: "running", runtime: { nativeUi: "opencode" },
    } as unknown as UsageSessionRow);
    await usage.tick();

    hostLoadHeld = false;
    await teamsInternal.launch(stored, member);
    assert.equal(createdSessions, 0, "Teams.launch must refuse before createTeamSession when budget exhausted while queued");
    const stateAfter = await teams.replayState(trialId);
    assert.equal(stateAfter?.phase, "ended");
    assert.equal(stateAfter?.launchWait, "provider-budget");
    assert.equal(stateAfter?.memberStartedAt, undefined);

    const trialId2 = randomUUID();
    const workspace2 = join(evalRoot, "trials", trialId2, "work");
    mkdirSync(workspace2, { recursive: true });
    await teams.createForReplay({
      trialId: trialId2, jobId, purpose: "replay", projectId: PROJECT_A,
      profile: OPENCODE, capsule: CAPSULE, features: { role: "implementer", area: "host", kind: null, risk: "normal", featureVersion: 1 },
      baseCommit, workspace: workspace2,
    });
    delete (config.projects[0] as unknown as { team: { eval: Record<string, unknown> } }).team.eval.providerBudgets;
    const stored2 = teamsInternal.records.get(trialId2)!;
    const member2 = { ...member, memberId: "m-2", sessionId: randomUUID(), cwd: workspace2 };
    stored2.run.members.push(member2);
    await teamsInternal.launch(stored2, member2);
    assert.equal(createdSessions, 0, "Teams.launch refuses withdrawn eval settings before creating a session");
    assert.equal((await teams.replayState(trialId2))?.launchWait, "configuration-changed");
  } finally {
    await teams.close();
    evalHost.close();
    fuse.stop();
    halt.stop();
    usage.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("UsageService enforces reconciliation freshness (pending, stale, and markReconciliationFailed), recording-error, starvation freedom, deleted-session bounds, and midnight gap overlap", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-usage-harden-")));
  const key = randomBytes(32);
  let clock = START;
  const now = () => new Date(clock).toISOString();
  const stateDir = join(root, "state");
  const databasePath = evidenceDatabasePath(stateDir);
  const config = {
    stateDir,
    usage: { prices: { "deepseek/deepseek-flash": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, accounts: {}, budgets: {} },
  } as unknown as Config;

  const eventsBySession = new Map<string, { seq: number; at: string; type: string; data: unknown }[]>();
  const rowsBySession = new Map<string, UsageSessionRow>();
  const failingSessions = new Set<string>();
  const existingMeta = new Set<string>();
  let pageSize = 200;

  const manager = {
    list: async () => [...rowsBySession.values()],
    events: (id: string, after: number) => {
      if (failingSessions.has(id)) throw new Error("journal failed");
      const remaining = (eventsBySession.get(id) ?? []).filter(event => event.seq > after);
      const slice = remaining.slice(0, pageSize);
      return { events: slice, cursor: slice.at(-1)?.seq ?? after, more: remaining.length > slice.length };
    },
    meta: (id: string) => {
      if (existingMeta.has(id)) return { id };
      const err = new Error("missing") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  } as unknown as Manager;

  let store = new EvidenceStore({ databasePath, vaultKey: key });
  let usage = new UsageService(config, key, manager, store, { now: () => clock });
  try {
    const pending = usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A);
    assert.equal(pending.measured, false);
    assert.equal(!pending.measured && pending.reason, "reconciliation-pending");

    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A).measured, true);

    clock += USAGE_RECONCILE_STALE_MS + 1;
    const stale = usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A);
    assert.equal(stale.measured, false);
    assert.equal(!stale.measured && stale.reason, "reconciliation-stale");

    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A).measured, true);

    usage.markReconciliationFailed();
    const listFailed = usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A);
    assert.equal(listFailed.measured, false);
    assert.equal(!listFailed.measured && listFailed.reason, "ledger-unavailable");

    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A).measured, true);

    for (let i = 0; i < 25; i += 1) {
      const id = `idle-ahead-${String(i).padStart(2, "0")}`;
      existingMeta.add(id);
      rowsBySession.set(id, { id, provider: "claude", projectId: PROJECT_A, createdAt: now(), status: "running" } as unknown as UsageSessionRow);
    }
    existingMeta.add("oc-late");
    eventsBySession.set("oc-late", [{ seq: 1, at: now(), type: "usage", data: openCodeRecord(now(), "late-1", 6) }]);
    rowsBySession.set("oc-late", { id: "oc-late", provider: "opencode", projectId: PROJECT_A, createdAt: now(), status: "running", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow);
    await usage.tick();
    const lateSnap = usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A);
    assert.equal(lateSnap.measured, true, "25 running sessions ahead must not starve a later OpenCode session");
    assert.equal(lateSnap.measured && lateSnap.usd, 6);

    clock = Date.parse("2026-11-17T10:00:00.000Z");
    existingMeta.add("oc-rec-err");
    eventsBySession.set("oc-rec-err", [{ seq: 1, at: now(), type: "usage", data: openCodeRecord(now(), "rec-1", 1) }]);
    rowsBySession.set("oc-rec-err", { id: "oc-rec-err", provider: "opencode", projectId: PROJECT_A, createdAt: now(), status: "recording-error", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow);
    await usage.tick();
    const recErr = usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A);
    assert.equal(recErr.measured, false);
    assert.equal(!recErr.measured && recErr.reason, "recording-error");

    rowsBySession.set("oc-rec-err", { id: "oc-rec-err", provider: "opencode", projectId: PROJECT_A, createdAt: now(), status: "exited", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow);
    await usage.tick();
    const recErrAfterExit = usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A);
    assert.equal(recErrAfterExit.measured, false, "recording-error must never clear to complete on a readable exit");
    assert.equal(!recErrAfterExit.measured && recErrAfterExit.reason, "recording-error");

    clock = Date.parse("2026-11-18T10:00:00.000Z");
    existingMeta.add("oc-deleted-undrained");
    failingSessions.add("oc-deleted-undrained");
    rowsBySession.set("oc-deleted-undrained", { id: "oc-deleted-undrained", provider: "opencode", projectId: PROJECT_A, createdAt: now(), status: "running", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow);
    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A).measured, false);

    clock = Date.parse("2026-11-18T12:00:00.000Z");
    rowsBySession.delete("oc-deleted-undrained");
    existingMeta.delete("oc-deleted-undrained");
    failingSessions.delete("oc-deleted-undrained");
    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A).measured, false, "deletion day stays unmeasurable");

    clock = Date.parse("2026-11-19T01:00:00.000Z");
    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "week", new Date(clock), PROJECT_A).measured, false, "same week still overlaps deleted undrained session");
    const nextDayFresh = usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A);
    assert.equal(nextDayFresh.measured, true, "fresh UTC day after deleted undrained session is NOT blocked forever");
    assert.equal(nextDayFresh.measured && nextDayFresh.usd, 0);

    clock = Date.parse("2026-11-20T23:59:30.000Z");
    existingMeta.add("oc-midnight");
    rowsBySession.set("oc-midnight", { id: "oc-midnight", provider: "opencode", projectId: PROJECT_A, createdAt: now(), status: "running", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow);
    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A).measured, true);

    clock = Date.parse("2026-11-21T00:00:10.000Z");
    eventsBySession.set("oc-midnight", [{ seq: 1, at: now(), type: "usage", data: { invalid: true } }]);
    rowsBySession.set("oc-midnight", { id: "oc-midnight", provider: "opencode", projectId: PROJECT_A, createdAt: "2026-11-20T23:59:30.000Z", status: "exited", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow);
    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date("2026-11-20T23:59:59.000Z"), PROJECT_A).measured, false, "midnight-spanning gap affects day 1");
    assert.equal(usage.providerSpend("opencode", "day", new Date("2026-11-21T00:00:10.000Z"), PROJECT_A).measured, false, "midnight-spanning gap also affects day 2 even within 60s of prior active timestamp");
    assert.equal(usage.providerSpend("opencode", "day", new Date("2026-11-22T00:00:00.000Z"), PROJECT_A).measured, true, "day 3 after exit is clean");

    usage.close();
    store.close();
    store = new EvidenceStore({ databasePath, vaultKey: key });
    usage = new UsageService(config, key, manager, store, { now: () => clock });
    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date("2026-11-17T12:00:00.000Z"), PROJECT_A).measured, false, "recording-error persists across reopen");
    pageSize = 1;
    for (const id of ["oc-rr-1", "oc-rr-2"]) {
      existingMeta.add(id);
      eventsBySession.set(id, Array.from({ length: 24 }, (_, idx) => ({ seq: idx + 1, at: "2026-11-23T01:00:00.000Z", type: "usage", data: openCodeRecord("2026-11-23T01:00:00.000Z", `${id}-${idx}`, 0.1) })));
      rowsBySession.set(id, { id, provider: "opencode", projectId: PROJECT_A, createdAt: "2026-11-23T01:00:00.000Z", status: "running", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow);
    }
    clock = Date.parse("2026-11-23T01:00:00.000Z");
    await usage.tick();
    assert.equal(usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A).measured, false);
    await usage.tick();
    await usage.tick();
    const rrDone = usage.providerSpend("opencode", "day", new Date(clock), PROJECT_A);
    assert.equal(rrDone.measured, true, "round-robin backlog drains multiple multi-page sessions cleanly");
    assert.equal(rrDone.measured && rrDone.usd, 4.8);
  } finally {
    usage.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TrialPump refuses withdrawn eval settings during prepareSource and rechecks paired providers for compare jobs while keeping baselines independent", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-eval-paired-withdrawn-")));
  const key = randomBytes(32);
  const clock = START;
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
      team: { eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" }, codex: { usd: 5, period: "day" } } } },
    }],
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: join(root, "eval"), agents: { opencode: { command: "opencode", args: [] }, codex: { command: "codex", args: [] } } },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
  } as unknown as Config;

  const usdByProvider: Record<string, number> = { opencode: 0, codex: 0 };
  let onPrepare: () => void = () => {};
  const launches: { jobId: string; provider: Provider }[] = [];

  const budget = {
    providerSpend: (provider: Provider, period: UsagePeriod, at: Date, projectId?: string) => measuredSnap(provider, period, usdByProvider[provider] ?? 0, at, projectId),
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
    clean: async () => true,
    scrub: async () => true,
  } as unknown as EvalIdentity;
  const teams: TrialTeams = {
    createForReplay: async input => { launches.push({ jobId: input.jobId, provider: input.profile.provider }); },
    replayState: async () => ({ phase: "running" as const, sessionExited: false }),
    endReplay: async () => undefined,
    forgetReplay: async () => true,
    replayIds: () => [],
    providerLimits: () => [],
  } as unknown as TrialTeams;
  const pump = new TrialPump({
    config, store, jobs,
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
    seedTask(store, PROJECT_A, "captured:pair:t01", now());
    seedTask(store, PROJECT_A, "captured:pair:t02", now());

    const cmp = jobs.create(PROJECT_A, compareReq([OPENCODE, CODEX]), randomUUID());
    assert.ok("job" in cmp);
    onPrepare = () => { usdByProvider.codex = 5.0; };
    await pump.step();
    assert.equal(launches.length, 0, "compare job must not launch opencode alone when paired codex crosses budget during prepareSource");
    assert.equal(evalJobs.view(cmp.job.jobId)?.waiting, "provider-budget");
    assert.ok(!("code" in evalJobs.control(cmp.job.jobId, "cancel")));

    usdByProvider.codex = 0;
    const base = jobs.create(PROJECT_A, baselineReq([OPENCODE, CODEX]), randomUUID());
    assert.ok("job" in base);
    onPrepare = () => { usdByProvider.codex = 5.0; };
    await pump.step();
    await pump.step();
    assert.equal(launches.length, 1, "baseline job retains per-provider independence when codex crosses budget during opencode prepareSource");
    assert.equal(launches[0]?.provider, "opencode");
    (pump as unknown as { live: unknown }).live = undefined;
    assert.ok(!("code" in evalJobs.control(base.job.jobId, "cancel")));

    usdByProvider.codex = 0;
    const withdrawn = jobs.create(PROJECT_A, baselineReq([OPENCODE]), randomUUID());
    assert.ok("job" in withdrawn);
    onPrepare = () => {
      delete (config.projects[0] as unknown as { team: { eval: Record<string, unknown> } }).team.eval.providerBudgets;
    };
    await pump.step();
    assert.equal(launches.length, 1, "must not launch after project eval budgets are withdrawn during prepareSource");
    assert.equal(evalJobs.view(withdrawn.job.jobId)?.status, "blocked");
    assert.equal(evalJobs.view(withdrawn.job.jobId)?.reason, "configuration-changed");
    assert.equal(store.read(db => db.all("SELECT * FROM eval_trials WHERE job_id = ?", withdrawn.job.jobId)).length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("judge calibration requires budget coverage for the judge provider and preserves legacy trialsPerDay opt-in", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-judge-coverage-")));
  const key = randomBytes(32);
  const now = () => new Date(START).toISOString();
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: key });
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  store.register(configurationModule());
  store.register(judgeCalibrationsModule(store, now));

  const config = {
    projects: [{
      id: PROJECT_A,
      name: PROJECT_A,
      path: "/srv/unused",
      source: { mode: "github", repository: "example/app", baseBranch: "main" },
      team: { eval: { focusedTest: FOCUSED, reportFormat: "junit", providerBudgets: { opencode: { usd: 5, period: "day" } } } },
    }],
    teams: { lineup: { judge: CLAUDE } },
    eval: { member: { agents: { claude: { command: "claude", args: [] } } } },
  } as unknown as Config;

  const budget = evalBudgetSource({
    usage: () => ({ providerSpend: (provider, period, at, pid) => measuredSnap(provider, period, 0, at ?? new Date(START), pid) }),
  });
  const calibrations = new JudgeCalibrations({ store, config, now, budget });

  try {
    store.write(tx => {
      tx.run("INSERT INTO eval_trial_counts (job_id, planned_tasks, planned_trials) VALUES ('seed', 30, 60)");
    });
    for (let i = 0; i < 30; i += 1) {
      const taskId = `captured:jcov:t${String(i).padStart(2, "0")}`;
      seedTask(store, PROJECT_A, taskId, now());
      for (const resolved of [true, false]) {
        const trialId = `trial-${i}-${resolved ? "ok" : "no"}`;
        store.write(tx => {
          insertTrial(tx, {
            trialId, jobId: "seed", taskId, configRef: configRef(cfg(OPENCODE)), harness: TRIAL_HARNESS_VERSION, slot: resolved ? 0 : 1, attempt: 0,
            projectId: PROJECT_A, configuration: cfg(OPENCODE), keepDays: 365,
          }, now());
          startTrial(tx, trialId, now());
          finishTrial(tx, trialId, { grade: { ...GRADED, expectedPassed: resolved ? 1 : 0, resolved }, configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90, patch: Buffer.from(`p-${trialId}`) }, now());
        });
      }
    }

    const refusedNamed = calibrations.create({ requestId: "jcov-1", judgeProfileId: CLAUDE.id, pairs: 30, projects: [PROJECT_A] });
    assert.equal("code" in refusedNamed && refusedNamed.code, "eval-config-incomplete",
      "OpenCode-only USD budget without trialsPerDay must refuse a Claude judge calibration");

    const refusedPool = calibrations.create({ requestId: "jcov-2", judgeProfileId: CLAUDE.id, pairs: 30 });
    assert.equal("code" in refusedPool && refusedPool.code, "too-few-pairs",
      "uncovered project is excluded from default judge pool");

    assert.equal(calibrations.launchWait(PROJECT_A, CLAUDE), "budget-unmeasurable",
      "launchWait refuses uncovered judge provider fail-closed");

    (config.projects[0] as unknown as { team: { eval: Record<string, unknown> } }).team.eval.trialsPerDay = 10;
    const legacyOk = calibrations.create({ requestId: "jcov-3", judgeProfileId: CLAUDE.id, pairs: 30, projects: [PROJECT_A] });
    assert.ok("calibration" in legacyOk, "legacy trialsPerDay opt-in permits Claude judge");
    assert.equal(calibrations.launchWait(PROJECT_A, CLAUDE), undefined);

    delete (config.projects[0] as unknown as { team: { eval: Record<string, unknown> } }).team.eval.trialsPerDay;
    assert.deepEqual(await calibrations.next(defaultGates()), { kind: "wait", reason: "budget-unmeasurable" },
      "removing trialsPerDay while only OpenCode has a USD budget halts the Claude judge");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
