import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { MemoryMutationResult, MemoryRecordPayload } from "@infinite/remote";
import { profileIdentityKey, promptVersion } from "../packages/host/src/config-identity.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { priorCells, writePriors } from "../packages/host/src/eval-priors.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { TrialJobs } from "../packages/host/src/eval-trial-jobs.js";
import { TrialPump, type TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import { evalTrialsModule, finishTrial, insertTrial, startTrial, type JobTrialRow } from "../packages/host/src/eval-trial-store.js";
import type { EvalIdentity } from "../packages/host/src/eval-identity.js";
import type { Grader } from "../packages/host/src/eval-grader.js";
import type { ReplayPrior, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceTx } from "../packages/host/src/evidence/types.js";
import { recordHindsight, recordHindsightFromScan, recordHindsightSignals } from "../packages/host/src/hindsight-signal.js";
import type { Manager } from "../packages/host/src/manager.js";
import {
  formatPlannerMemoryBlock,
  MAX_PLANNER_LESSONS,
  MAX_PLANNER_MEMORY_BYTES,
  plannerMemoryForRun,
  retrievePlannerLessons,
  retrievePlannerMemoryBlock,
} from "../packages/host/src/memory/planner-context.js";
import {
  MEMORY_RECOVERY_GENESIS_HASH,
  type MemoryRecoveryAppendReceipt,
  type MemoryRecoveryDelta,
  type MemoryRecoverySignedHead,
  type MemoryRecoveryWitness,
} from "../packages/host/src/memory/recovery.js";
import { MemoryStoreService } from "../packages/host/src/memory/store.js";
import type {
  MemoryCurrentWorkspaceBinding,
  MemoryPrincipalSelector,
  MemoryPrincipalSnapshot,
  MemoryStoreOptions,
} from "../packages/host/src/memory/types.js";
import { applyScan, ownerSignal } from "../packages/host/src/outcome-signals.js";
import { outcomeModule, readOutcome, runOutcomes, runSignals, writeOutcome, writeSummary, type OutcomeRow, type RunSummaryRow } from "../packages/host/src/outcome-store.js";
import { decideAutoStart, evaluateStart, startFrame, type RouterStart } from "../packages/host/src/routing-auto.js";
import { pinRouting } from "../packages/host/src/routing-policy.js";
import { posterior, REPLAY_PRIOR_MASS, type CurrentConfig, type RoutingTarget } from "../packages/host/src/routing-posterior.js";
import { insertDecision, routingModule, taskDecisions } from "../packages/host/src/routing-store.js";
import type { RoutingEvidenceRow, TeamRunRouting } from "../packages/host/src/routing-types.js";
import { teamContext, teamPrompt } from "../packages/host/src/team-prompts.js";
import type { TeamLineup, TeamModelProfile, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { UsageRecord } from "../packages/host/src/usage.js";
import { UsageService, type UsageSessionRow } from "../packages/host/src/usage-service.js";
import { mixedLineup } from "./team-fixture.js";

const DAY_MS = 86_400_000;
const NOW = "2026-11-15T12:00:00.000Z";
const ENDED = new Date(Date.parse(NOW) - 20 * DAY_MS).toISOString();
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
const effortOf = (profile: TeamModelProfile) => ("effort" in profile ? profile.effort : profile.variant) ?? null;

function withTempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEvidenceRow(overrides: Partial<RoutingEvidenceRow> = {}): RoutingEvidenceRow {
  return {
    outcomeId: "o-001",
    source: "production",
    projectRef: "p",
    areaRef: "a",
    provider: "codex",
    model: "gpt-5",
    effort: "medium",
    profileEpoch: 1,
    kind: "fix",
    featureVersion: 1,
    disposition: "integrated",
    exclusion: null,
    flags: [],
    integrated: 1,
    accepted: 1,
    firstPass: 1,
    held: 1,
    endedAt: NOW,
    frozenAt: NOW,
    point: "start",
    featureMapRef: "fm",
    ownerScore: null,
    listUsd: null,
    promptVersion: "pv",
    ...overrides,
  };
}

function makeReplayPrior(overrides: Partial<ReplayPrior> = {}): ReplayPrior {
  return {
    projectId: "proj-1",
    profileId: "p-a",
    profile: { provider: "codex", model: "gpt-5", effort: "medium" },
    profileEpoch: 1,
    promptVersion: "pv",
    role: "implementer",
    area: "host",
    kind: "fix",
    tasks: 5,
    trials: 20,
    resolved: 20,
    source: "replay",
    promptOrigin: "assignment",
    generatedAt: NOW,
    jobId: "job-1",
    ...overrides,
  };
}

test("posterior incorporates bounded time-decayed replayPriors at start and lets real production rows dominate", () => {
  const target: RoutingTarget = {
    projectRef: "p",
    areaRef: "a",
    kind: "fix",
    featureVersion: 1,
    featureMapRef: "fm",
    point: "start",
    projectId: "proj-1",
    area: "host",
  };
  const current: CurrentConfig = { epoch: 1, promptVersion: "pv" };

  const withoutReplay = posterior([], target, current, NOW, 0.5);
  assert.deepEqual(withoutReplay.theta, { a: 1, b: 1 });

  const cellSuccess = posterior([], target, current, NOW, 0.5, undefined, [
    makeReplayPrior({ trials: 500, resolved: 500, area: "host", kind: "fix" }),
  ]);
  const cellSuccessMean = cellSuccess.theta.a / (cellSuccess.theta.a + cellSuccess.theta.b);
  assert.ok(cellSuccessMean > 0.78, "cell replay successes shift cold-start theta upward");
  assert.ok(Math.abs((cellSuccess.reward[2]!.earlier.success + cellSuccess.reward[2]!.earlier.failure) - REPLAY_PRIOR_MASS) < 1e-9);

  const projectOnly = posterior([], target, current, NOW, 0.5, undefined, [
    makeReplayPrior({ trials: 50, resolved: 0, area: "other-area", kind: "feature" }),
  ]);
  assert.ok(projectOnly.theta.b > projectOnly.theta.a, "non-matching cell priors fall back to project level");

  const staleAndEscalation = posterior(
    [],
    { ...target, point: "escalation" },
    current,
    NOW,
    0.5,
    undefined,
    [makeReplayPrior({ trials: 100, resolved: 100 })],
  );
  assert.deepEqual(staleAndEscalation.theta, { a: 1, b: 1 });

  const expiredPrior = posterior([], target, current, NOW, 0.5, undefined, [
    makeReplayPrior({ generatedAt: ago(185), trials: 50, resolved: 50 }),
  ]);
  assert.deepEqual(expiredPrior.theta, { a: 1, b: 1 });

  const productionRows = Array.from({ length: 30 }, (_, index) =>
    makeEvidenceRow({ outcomeId: `prod-${index}`, accepted: 0, held: 1, firstPass: 1 }),
  );
  const dominated = posterior(productionRows, target, current, NOW, 0.5, undefined, [
    makeReplayPrior({ trials: 500, resolved: 500 }),
  ]);
  const dominatedMean = dominated.theta.a / (dominated.theta.a + dominated.theta.b);
  assert.ok(dominatedMean < 0.35, "real production failures override bounded replay priors");
});

test("decideAutoStart reads eval_priors when registered and enforces maxExploreShare transactionally", t => {
  const dir = withTempDir(t, "infinite-phase4-routing-");
  const profileA = mixedLineup.implementers.find(p => p.id === "spark-high")!;
  const profileB = mixedLineup.implementers.find(p => p.id === "spark-low")!;
  const lineup: TeamLineup = { ...mixedLineup, implementers: [profileA, profileB] };
  const routing = pinRouting(
    { mode: "auto", allowContributor: true, knobs: { maxExploreShare: 0.25, exploreWindow: 20, minSpareAttempts: 0 } },
    "supervised",
    lineup,
    ENDED,
  )!;
  assert.equal(routing.mode, "auto");

  const makeStore = (withEval: boolean, name: string) => {
    const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(dir, name)), vaultKey: Buffer.alloc(32, 9) });
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.register(routingModule());
    if (withEval) {
      store.register(evalCorpusModule(store, () => NOW));
      store.register(evalTrialsModule(store, () => NOW));
    }
    return store;
  };

  const plainStore = makeStore(false, "plain");
  t.after(() => plainStore.close());
  const runPlain = { id: "run-plain", revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] } as unknown as TeamRun;
  const plainTask = { id: "task-plain", title: "plain", instructions: "go", paths: ["packages/host/src/a.ts"], kind: "fix", dependsOn: [], revision: 1, status: "pending" } as unknown as TeamTask;
  const plainStart: RouterStart = {
    run: runPlain, task: plainTask, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: undefined, limited: new Set(),
  };
  const plainDecision = decideAutoStart(plainStore, plainStart, () => NOW, () => 0);
  assert.equal(plainDecision.by, "router");

  const evalStore = makeStore(true, "eval");
  t.after(() => evalStore.close());
  evalStore.write(tx => {
    const cfgA: TrialConfiguration = { profile: profileA, guidance: "as-of-base", knowledge: "none" };
    const cfgB: TrialConfiguration = { profile: profileB, guidance: "as-of-base", knowledge: "none" };
    const verA = promptVersion("implementer", profileA.provider, profileA, false, false);
    const verB = promptVersion("implementer", profileB.provider, profileB, false, false);
    const areaRef = tx.index("area", "host");
    const tasks = new Map([["t1", { areaRef, kind: "fix", promptOrigin: "assignment" as const }]]);
    const rows: JobTrialRow[] = [
      ...Array.from({ length: 12 }, (_, idx) => ({
        taskId: "t1", configRef: configRef(cfgA), slot: idx, attempt: 0, state: "final" as const, ending: "graded" as const,
        resolved: false, isolation: "isolated" as const, configId: "cfg-a", profileEpoch: 1, promptVersion: verA,
        tokens: null, spentUsd: null, cost: null, startedAt: NOW, endedAt: NOW, reused: false,
      })),
      ...Array.from({ length: 12 }, (_, idx) => ({
        taskId: "t1", configRef: configRef(cfgB), slot: idx, attempt: 0, state: "final" as const, ending: "graded" as const,
        resolved: true, isolation: "isolated" as const, configId: "cfg-b", profileEpoch: 1, promptVersion: verB,
        tokens: null, spentUsd: null, cost: null, startedAt: NOW, endedAt: NOW, reused: false,
      })),
    ];
    const cells = priorCells([cfgA, cfgB], rows, tasks);
    writePriors(tx, { jobId: "job-priors", projectId: "rehearsal", cells, at: NOW });
  });

  const evalFeatureMap = { areas: [{ id: "host", paths: ["packages/host"] }] };
  const runEval = { id: "run-eval", revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] } as unknown as TeamRun;
  const evalTask = { id: "task-eval", title: "eval", instructions: "go", paths: ["packages/host/src/a.ts"], kind: "fix", dependsOn: [], revision: 1, status: "pending" } as unknown as TeamTask;
  const evalDecision = decideAutoStart(
    evalStore,
    { run: runEval, task: evalTask, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: evalFeatureMap, limited: new Set() },
    () => NOW,
    () => 0,
  );
  assert.equal(evalDecision.by, "router");
  const evalStored = evalStore.read(db => taskDecisions(db, "run-eval", "task-eval").rows[0]);
  assert.equal(evalStored?.greedyProfileId, profileB.id, "eval_priors steer greedy choice toward profileB on cold start");

  const raceStore = makeStore(false, "race");
  t.after(() => raceStore.close());
  raceStore.write(tx => {
    const verA = promptVersion("implementer", profileA.provider, profileA, false, false);
    const verB = promptVersion("implementer", profileB.provider, profileB, false, false);
    tx.run(
      "INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) VALUES (?, ?, ?, ?, ?, 'g', 'k', 'off', 's', ?)",
      "cfg-a", profileA.provider, profileA.model, effortOf(profileA), verA, NOW,
    );
    tx.run(
      "INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) VALUES (?, ?, ?, ?, ?, 'g', 'k', 'off', 's', ?)",
      "cfg-b", profileB.provider, profileB.model, effortOf(profileB), verB, NOW,
    );
    const seedOutcome = (id: string, profile: TeamModelProfile, cfgId: string, accepted: 0 | 1): OutcomeRow => ({
      outcomeId: id, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: id, revision: 1, memberId: "m1",
      sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: profile.id, provider: profile.provider,
      model: profile.model, effort: effortOf(profile), profileEpoch: 1, configId: cfgId, experimentRef: null,
      kind: "fix", risk: "normal", featureVersion: 1, disposition: "integrated", exclusion: null, flags: [],
      integrated: 1, accepted, acceptance: accepted, firstPass: 1, held: 1,
      startedAt: ago(3), endedAt: ago(2), frozenAt: ago(2), holdUntil: null, runDeletedAt: null,
      payload: { projectId: "rehearsal", taskId: id, area: "host", featureMap: "default", rounds: { run: 1, attributed: 1, unknown: 0 }, limitEvents: 0, costCoverage: "none" },
    });
    for (let i = 0; i < 6; i += 1) writeOutcome(tx, seedOutcome(`win-a-${i}`, profileA, "cfg-a", 1));
    for (let i = 0; i < 4; i += 1) writeOutcome(tx, seedOutcome(`win-b-${i}`, profileB, "cfg-b", i === 0 ? 1 : 0));

    const projectRef = tx.index("project", "rehearsal");
    const areaRef = tx.index("area", "host");
    const featureMapRef = tx.index("feature-map", "default");
    for (let i = 0; i < 4; i += 1) {
      const taskKey = tx.index("task", `seed-${i}`);
      insertDecision(
        tx,
        {
          key: `seed-key-${i}`, runId: `seed-run-${i}`, revision: 1, taskKey, point: "start", ordinal: 1,
          projectRef, role: "implementer", areaRef, kind: "fix", risk: "normal", featureVersion: 1, featureMapRef,
          mode: "auto", algorithmVersion: routing.algorithmVersion, rewardVersion: routing.rewardVersion, policyDigest: routing.digest,
          seed: `seed-${i}`, basis: "greedy-share", chosenProfileId: profileA.id,
          chosenIdentity: profileIdentityKey({ provider: profileA.provider, model: profileA.model, effort: effortOf(profileA) }),
          greedyProfileId: profileA.id, coordinatorProfileId: null, explore: false, state: "applied", memberId: "m1",
          decidedAt: new Date(Date.parse(NOW) - (10 + i) * 60_000).toISOString(),
        },
        {
          projectId: "rehearsal", taskId: `seed-${i}`, area: "host", featureMap: "default", coordinatorProfileId: null,
          knobs: routing.knobs, costs: { lightUsd: 0.1, strongUsd: 1, rescueUsd: 1, basis: "tier-default" },
          headroom: "not-modelled", chosenWeight: 0.5, current: [], candidates: [], elapsedMs: 1,
        },
      );
    }
  });

  const runRace = { id: "run-race", revision: 1, projectId: "rehearsal", lineup, routing, tasks: [], members: [], events: [] } as unknown as TeamRun;
  let exploreTask: TeamTask | undefined;
  for (let i = 0; i < 80; i += 1) {
    const candidate = { id: `explore-task-${i}`, title: "race", instructions: "go", paths: ["packages/host/src/a.ts"], kind: "fix", dependsOn: [], revision: 1, status: "pending" } as unknown as TeamTask;
    const probe = raceStore.read(db => {
      const taskKey = db.index("task", candidate.id);
      const startInput: RouterStart = {
        run: runRace, task: candidate, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: evalFeatureMap, limited: new Set(), evalPriorsReady: false,
      };
      return evaluateStart(db, startInput, startFrame(startInput), { taskKey, key: `probe-${i}` }, NOW, true);
    });
    if (probe?.row.explore && probe.row.greedyProfileId === profileA.id) {
      exploreTask = candidate;
      break;
    }
  }
  assert.ok(exploreTask, "found deterministic exploratory seed under 4/0 share");

  const originalTryWrite = raceStore.tryWrite.bind(raceStore);
  (raceStore as { tryWrite: EvidenceStore["tryWrite"] }).tryWrite = ((callback: (tx: EvidenceTx) => void) => {
    return originalTryWrite(tx => {
      insertDecision(
        tx,
        {
          key: "concurrent-explore-key", runId: "concurrent-run", revision: 1, taskKey: tx.index("task", "concurrent-task"),
          point: "start", ordinal: 1, projectRef: tx.index("project", "rehearsal"), role: "implementer", areaRef: tx.index("area", "host"),
          kind: "fix", risk: "normal", featureVersion: 1, featureMapRef: tx.index("feature-map", "default"), mode: "auto",
          algorithmVersion: routing.algorithmVersion, rewardVersion: routing.rewardVersion, policyDigest: routing.digest,
          seed: "concurrent-seed", basis: "sampled", chosenProfileId: profileB.id,
          chosenIdentity: profileIdentityKey({ provider: profileB.provider, model: profileB.model, effort: effortOf(profileB) }),
          greedyProfileId: profileA.id, coordinatorProfileId: null, explore: true, state: "pending", memberId: null,
          decidedAt: new Date(Date.parse(NOW) - 1000).toISOString(),
        },
        {
          projectId: "rehearsal", taskId: "concurrent-task", area: "host", featureMap: "default", coordinatorProfileId: null,
          knobs: routing.knobs, costs: { lightUsd: 0.1, strongUsd: 1, rescueUsd: 1, basis: "tier-default" },
          headroom: "not-modelled", chosenWeight: 0.5, current: [], candidates: [], elapsedMs: 1,
        },
      );
      callback(tx);
    });
  }) as EvidenceStore["tryWrite"];

  const raced = decideAutoStart(
    raceStore,
    { run: runRace, task: exploreTask!, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode: false, featureMap: evalFeatureMap, limited: new Set() },
    () => NOW,
    () => 0,
  );
  assert.equal(raced.by, "router");
  assert.equal(raced.profile.id, profileA.id, "concurrent exploratory insert downgrades decision to greedy profile");
  const persisted = raceStore.read(db => taskDecisions(db, "run-race", exploreTask!.id));
  assert.equal(persisted.rows[0]?.explore, false);
  assert.equal(persisted.rows[0]?.basis, "greedy-share");
  assert.equal(persisted.rows[0]?.chosenProfileId, profileA.id);
  assert.equal(persisted.rows[0]?.payload?.guards?.share.exploratory, 1);
  assert.equal(persisted.rows[0]?.payload?.guards?.share.of, 5);
});

test("UsageService.providerSpend ignores out-of-window drain-incomplete sessions and fails closed for in-window ones", async t => {
  const dir = withTempDir(t, "infinite-phase4-usage-");
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  t.after(() => store.close());

  const day1 = Date.parse("2026-11-10T10:00:00.000Z");
  const day5 = Date.parse("2026-11-15T10:00:00.000Z");
  let currentNow = day1;
  let throwOnOldDrain = true;

  const oldRecord: UsageRecord = {
    provider: "opencode",
    providerId: "deepseek",
    modelId: "deepseek-flash",
    messageId: "m-old",
    partId: "p-old",
    modelSource: "reported",
    completedAt: new Date(day1).toISOString(),
    tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    reportedCost: 0.25,
  };
  const newRecord: UsageRecord = {
    provider: "opencode",
    providerId: "deepseek",
    modelId: "deepseek-flash",
    messageId: "m-new",
    partId: "p-new",
    modelSource: "reported",
    completedAt: new Date(day5).toISOString(),
    tokens: { input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    reportedCost: 0.75,
  };

  let listed: UsageSessionRow[] = [
    { id: "s-old-undrained", provider: "opencode", projectId: "proj-u", createdAt: new Date(day1).toISOString(), status: "running", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow,
  ];

  const manager = {
    list: async () => listed,
    meta: () => ({}),
    events: (id: string, after: number) => {
      if (id === "s-old-undrained") {
        if (after === 0) {
          return {
            events: [{ seq: 1, at: oldRecord.completedAt, type: "usage", data: oldRecord }],
            cursor: 1,
            more: true,
          };
        }
        if (throwOnOldDrain) throw new Error("transient drain error on day 1");
        return { events: [], cursor: 1, more: false };
      }
      if (id === "s-new-clean") {
        const events = [{ seq: 1, at: newRecord.completedAt, type: "usage", data: newRecord }].filter(event => event.seq > after);
        return { events, cursor: 1, more: false };
      }
      return { events: [], cursor: after, more: false };
    },
  } as unknown as Manager;

  const config = { stateDir: dir, usage: { prices: {}, accounts: {} } } as unknown as Config;
  let usage = new UsageService(config, key, manager, store, { now: () => currentNow });
  await usage.tick(listed);

  currentNow = day5;
  throwOnOldDrain = false;
  listed = [
    { id: "s-new-clean", provider: "opencode", projectId: "proj-u", createdAt: new Date(day5).toISOString(), status: "exited", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow,
  ];
  usage = new UsageService(config, key, manager, store, { now: () => currentNow });
  await usage.tick(listed);

  const day1Spend = usage.providerSpend("opencode", "day", new Date(day1), "proj-u");
  assert.equal(day1Spend.measured, false);
  if (day1Spend.measured === false) {
    assert.equal(day1Spend.reason, "ingestion-incomplete");
  }

  const day5Spend = usage.providerSpend("opencode", "day", new Date(day5), "proj-u");
  assert.equal(day5Spend.measured, true);
  if (day5Spend.measured === true) {
    assert.equal(day5Spend.usd, 0.75);
  }
});

test("TrialPump.sweep waits when cost lookup reports complete: false before TRIAL_COST_WAIT_MS and finalizes after complete or timeout", async t => {
  const dir = withTempDir(t, "infinite-phase4-pump-");
  let clockMs = Date.parse("2026-11-15T12:00:00.000Z");
  const now = () => new Date(clockMs).toISOString();
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(dir, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  t.after(() => store.close());

  const profile: TeamModelProfile = { id: "claude-strong", label: "Claude", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
  const lineup: TeamLineup = { coordinator: profile, integrator: profile, reviewer: profile, implementers: [profile], escalations: [], fallbacks: [] };
  const config = {
    projects: [{ id: "proj-pump", name: "proj-pump", path: "/srv/unused", source: { mode: "github", repository: "example/app" }, team: { eval: { mine: true, focusedTest: { command: "node", args: ["--test"] }, reportFormat: "junit", trialsPerDay: 10 } } }],
    stateDir: join(dir, "state"), runDir: join(dir, "runs"), keyFile: join(dir, "vault.key"), maxSessions: 8,
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-eval", agents: { claude: { command: "claude", args: [] } } },
    },
    teams: { workspaceDir: join(dir, "workspaces"), lineup },
  } as unknown as Config;

  const removed: string[] = [];
  let incompleteCompleteFlag = false;
  const lookups: Record<string, { usd: number; tokens: number; complete: boolean } | undefined> = {
    "sess-incomplete": { usd: 0.4, tokens: 80, complete: false },
    "sess-timeout": { usd: 0.3, tokens: 60, complete: false },
    "sess-none": undefined,
  };

  const teams: TrialTeams = {
    createForReplay: async () => { throw new Error("unused"); },
    replayState: async () => undefined,
    endReplay: async () => undefined,
    forgetReplay: async () => true,
    replayIds: () => [],
    providerLimits: () => [],
  } as unknown as TrialTeams;

  const jobs = new TrialJobs({ store, config, now });
  const pump = new TrialPump({
    config,
    store,
    jobs,
    grader: { clean: async () => true } as unknown as Grader,
    identity: { probe: async () => ({ state: "ready", uid: 1, storage: true, fetch: "refused" }), receive: async () => "failed", prepare: async () => "failed", check: async () => "failed", teamPrefix: () => undefined, setupPrefix: () => undefined, stop: async () => true, clean: async () => true, scrub: async () => true } as unknown as EvalIdentity,
    teams: () => teams,
    sessions: { list: async () => [], remove: async (id: string) => { removed.push(id); } } as never,
    cost: sessionId => {
      if (sessionId === "sess-incomplete") return { usd: 0.4, tokens: 80, complete: incompleteCompleteFlag };
      return lookups[sessionId];
    },
    source: { mirrorPath: () => join(dir, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main" }) as never },
    hostLoad: { held: () => undefined },
    halt: () => ({ check: () => ({ state: "clear" as const }) }),
    graderProbe: async () => ({ state: "ready", storage: true, version: 2, uid: 5002 }),
    now,
  });

  const endedTwoHoursAgo = new Date(clockMs - 2 * 3_600_000).toISOString();
  store.write(tx => {
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
      + "captured_at, checked_at, payload, group_id, area_ref, validated_at) "
      + "VALUES (?, 'captured', 'run-1', ?, ?, 'valid', 'stored', 'proven', 0, ?, ?, ?, 'run:run-1', 'host', ?)",
      "t1", "member-1", tx.index("project", "proj-pump"), endedTwoHoursAgo, endedTwoHoursAgo, tx.seal("eval_tasks", "t1", { projectId: "proj-pump" }), endedTwoHoursAgo,
    );
  });
  const configuration: TrialConfiguration = { profile, guidance: "as-of-base", knowledge: "none" };
  const createdJob = jobs.create("proj-pump", {
    kind: "baseline",
    configurations: [configuration],
    limits: { maxTrials: 10, maxWallMinutes: 600 },
  }, randomUUID());
  assert.ok("job" in createdJob, "the baseline job is created");
  const jobId = createdJob.job.jobId;
  const voidGrade: TrialGrade = { ending: "void-host", expectedPassed: null, expectedTotal: 0, guardPassed: null, resolved: false, overwritten: 0, diff: null, isolation: "none" };
  let trialIncomplete = "";
  let trialTimeout = "";
  let trialNone = "";
  store.write(tx => {
    const insertAndFinish = (slot: number, sessionId: string) => {
      const trialId = randomUUID();
      insertTrial(tx, {
        trialId,
        jobId,
        taskId: "t1",
        configRef: configRef(configuration),
        harness: TRIAL_HARNESS_VERSION,
        slot,
        attempt: 0,
        projectId: "proj-pump",
        configuration,
        keepDays: 365,
      }, endedTwoHoursAgo);
      startTrial(tx, trialId, endedTwoHoursAgo);
      finishTrial(tx, trialId, { grade: voidGrade, configId: null, profileEpoch: null, sessionId, patchKeepDays: 90 }, endedTwoHoursAgo);
      return trialId;
    };
    trialIncomplete = insertAndFinish(0, "sess-incomplete");
    trialTimeout = insertAndFinish(1, "sess-timeout");
    trialNone = insertAndFinish(2, "sess-none");
  });

  await pump.sweep();
  assert.deepEqual(removed, ["sess-none"], "only unmeasured undefined session is removed at 2h");
  const readCost = (trialId: string) => store.read(db => db.get<{ session_id: string | null; cost: string | null; spent_usd: number | null; tokens: number | null }>("SELECT session_id, cost, spent_usd, tokens FROM eval_trials WHERE trial_id = ?", trialId));
  assert.equal(readCost(trialIncomplete)?.session_id, "sess-incomplete");
  assert.equal(readCost(trialTimeout)?.session_id, "sess-timeout");
  assert.equal(readCost(trialNone)?.cost, "none");

  incompleteCompleteFlag = true;
  await pump.sweep();
  assert.ok(removed.includes("sess-incomplete"), "session with complete: true sweeps immediately");
  assert.equal(readCost(trialIncomplete)?.cost, "complete");
  assert.equal(readCost(trialIncomplete)?.spent_usd, 0.4);
  assert.equal(readCost(trialTimeout)?.session_id, "sess-timeout", "still-incomplete session continues waiting");

  clockMs += 23 * 3_600_000;
  await pump.sweep();
  assert.ok(removed.includes("sess-timeout"), "session still partial after TRIAL_COST_WAIT_MS sweeps as partial");
  assert.equal(readCost(trialTimeout)?.cost, "partial");
  assert.equal(readCost(trialTimeout)?.spent_usd, 0.3);
  assert.equal(readCost(trialTimeout)?.tokens, 60);
});

const { privateKey: memPrivateKey, publicKey: memPublicKey } = generateKeyPairSync("ed25519");
const memRecoveryPub = memPublicKey.export({ type: "spki", format: "der" }) as Buffer;
const signMem = (value: unknown) => sign(null, Buffer.from(JSON.stringify(value)), memPrivateKey).toString("base64");

class TestMemoryWitness implements MemoryRecoveryWitness {
  readonly deltas: MemoryRecoveryDelta[] = [];
  readonly receipts: MemoryRecoveryAppendReceipt[] = [];
  async append(expectedSequence: number, expectedHeadHash: string, batch: readonly MemoryRecoveryDelta[]) {
    const delta = batch[0]!;
    const prior = this.receipts.find(r => r.eventIds[0] === delta.eventId);
    if (prior) return prior;
    if (expectedSequence !== this.deltas.length || expectedHeadHash !== (this.deltas.at(-1)?.deltaHash ?? MEMORY_RECOVERY_GENESIS_HASH)) {
      throw new Error("Witness CAS mismatch");
    }
    this.deltas.push(structuredClone(delta));
    const body = {
      acceptedAt: delta.timestamp,
      deltaHashes: [delta.deltaHash],
      eventIds: [delta.eventId],
      expectedHeadHash,
      expectedSequence,
      headHash: delta.deltaHash,
      sequence: this.deltas.length,
    };
    const receipt = { ...body, signature: signMem(body) };
    this.receipts.push(receipt);
    return receipt;
  }
  async readFresh(challenge: string): Promise<MemoryRecoverySignedHead> {
    const body = { challenge, headHash: this.deltas.at(-1)?.deltaHash ?? MEMORY_RECOVERY_GENESIS_HASH, sequence: this.deltas.length };
    return { ...body, signature: signMem(body) };
  }
  async readDeltas(afterSequence: number): Promise<MemoryRecoveryDelta[]> {
    return structuredClone(this.deltas.filter(d => d.sequence > afterSequence));
  }
}

test("hindsight-signal detects revert and linked-fix commits, writes non-scoring advisory memories, and avoids prompt leakage", async t => {
  const dir = withTempDir(t, "infinite-phase4-hindsight-");
  const vaultKey = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(dir, "evidence")), vaultKey });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => NOW }));
  t.after(() => store.close());

  const landedCommitA = "a".repeat(40);
  const landedCommitB = "b".repeat(40);
  const revertCommit = "c".repeat(40);
  const fixCommit = "d".repeat(40);
  const tLanding = "2026-11-10T10:00:00.000Z";
  const tHindsight = "2026-11-12T10:00:00.000Z";

  store.write(tx => {
    const makeRow = (runId: string): OutcomeRow => ({
      outcomeId: `${runId}:m1`, source: "production", projectRef: tx.index("project", "proj-h"), taskRef: tx.index("task", "t1"),
      areaRef: tx.index("area", "host"), runId, revision: 1, memberId: "m1", sessionId: null, attemptIndex: 1,
      inherited: false, role: "implementer", profileId: "p1", provider: "codex", model: "gpt-5", effort: "medium",
      profileEpoch: 1, configId: null, experimentRef: null, kind: "fix", risk: "normal", featureVersion: 1,
      disposition: "integrated", exclusion: null, flags: [], integrated: 1, accepted: 1, acceptance: 1, firstPass: 1, held: 1,
      startedAt: tLanding, endedAt: tLanding, frozenAt: tLanding, holdUntil: null, runDeletedAt: null,
      payload: { projectId: "proj-h", taskId: "t1", area: "host", featureMap: "default", rounds: { run: 1, attributed: 1, unknown: 0 }, limitEvents: 0, costCoverage: "none" },
    });
    const makeSummary = (runId: string): RunSummaryRow => ({
      runId, source: "production", projectRef: tx.index("project", "proj-h"), revision: 1,
      status: "approved", blockCode: null, flags: [], createdAt: tLanding, settledAt: tLanding,
      approvedAt: tLanding, runDeletedAt: null,
      payload: { projectId: "proj-h", attempts: { integrated: 1 }, rounds: { total: 1, attributed: 1, unattributed: 0, unknown: 0 } },
    });
    writeOutcome(tx, makeRow("run-a"));
    writeOutcome(tx, makeRow("run-b"));
    writeSummary(tx, makeSummary("run-a"));
    writeSummary(tx, makeSummary("run-b"));
    applyScan(tx, {
      projectId: "proj-h",
      repository: "example/repo",
      baseBranch: "main",
      at: tLanding,
      head: landedCommitB,
      commits: 2,
      gap: null,
      expectedSeq: 0,
      landings: [
        { runId: "run-a", commit: landedCommitA, method: "merge-commit", position: 1 },
        { runId: "run-b", commit: landedCommitB, method: "merge-commit", position: 2 },
      ],
      reverts: [],
      holdDays: 30,
    });
  });

  const witness = new TestMemoryWitness();
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const ownerActor: MemoryPrincipalSelector = { kind: "device", deviceId: "dev-owner" };
  const principals = new Map<string, MemoryPrincipalSnapshot>([
    ["dev-owner", { principalId: "prin-owner", kind: "device", deviceId: "dev-owner", deviceRole: "owner", state: "active" }],
  ]);
  const bindings = new Map<string, MemoryCurrentWorkspaceBinding>([
    [workspaceId, { workspaceId, bindingEpoch: 1, bindingDigest: "f".repeat(64), repositoryBindings: [{ repositoryIdentity: "example/repo", projectIds: ["proj-h"], rootIdentityDigest: "e".repeat(64) }], state: "active" }],
  ]);
  const memOpts: MemoryStoreOptions = {
    databasePath: join(dir, "memory.sqlite"),
    vaultKey,
    hostId: "test-host",
    resolvePrincipal: s => principals.get(s.kind === "device" ? s.deviceId : s.taskBindingId),
    resolveWorkspaceBinding: id => bindings.get(id),
    recoveryWitness: witness,
    recoveryPublicKey: memRecoveryPub,
    now: () => Date.parse(tHindsight),
  };
  const memStore = new MemoryStoreService(memOpts);
  await memStore.openRecovery();
  t.after(() => memStore.close());
  memStore.provisionWorkspaceMemory({
    intentEventId: "10000000-0000-4000-8000-000000000001",
    actor: ownerActor as MemoryPrincipalSelector & { kind: "device" },
    workspaceId,
    expectedBindingEpoch: 1,
    bindingDigest: "f".repeat(64),
  });
  const colRes = await memStore.mutate({
    actor: ownerActor,
    workspaceId,
    request: { requestId: "10000000-0000-4000-8000-000000000002", expectedRevision: 1, expectedBindingEpoch: 1, op: { type: "collection_create", scope: "private" } },
  });
  const collectionId = (colRes.value as MemoryMutationResult).receipt.resourceId;

  const candidates: string[] = [];
  const revertReport = await recordHindsight(
    store,
    { projectId: "proj-h", commit: revertCommit, at: tHindsight, message: `Revert feature\n\nThis reverts commit ${landedCommitA}.` },
    {
      memory: { store: memStore, actor: ownerActor, workspaceId, collectionId },
      onEvalCandidate: c => { candidates.push(`${c.kind}:${c.targetRunId}`); },
    },
  );
  assert.equal(revertReport.recordedSignals, 1);
  assert.equal(revertReport.recordedMemories, 1);
  assert.deepEqual(candidates, ["revert:run-a"]);
  const outcomeA = store.read(db => readOutcome(db, "run-a:m1"));
  assert.equal(outcomeA?.held, 0, "revert signal recomputes held to 0");
  assert.ok(store.read(db => runOutcomes(db, "run-a")).every(row => row.held === 0));

  const replayRevert = await recordHindsight(
    store,
    { projectId: "proj-h", commit: revertCommit, at: tHindsight, message: `Revert feature\n\nThis reverts commit ${landedCommitA}.` },
    { memory: { store: memStore, actor: ownerActor, workspaceId, collectionId } },
  );
  assert.equal(replayRevert.recordedSignals, 0);
  assert.equal(replayRevert.recordedMemories, 0, "idempotent memory replay does not increment recordedMemories");

  const fuzzyFix = recordHindsightSignals(store, {
    projectId: "proj-h",
    commit: fixCommit,
    at: tHindsight,
    message: "Fix regression in routing posterior",
    touchedPaths: ["packages/host/src/routing-posterior.ts"],
    priorPathsByRun: new Map([["run-b", ["packages/host/src/routing-posterior.ts"]]]),
  });
  assert.equal(fuzzyFix.recordedSignals, 0, "fuzzy keyword + path overlap stays advisory only");
  assert.equal(fuzzyFix.evalCandidates.length, 1);

  const wildcardSkip = recordHindsightSignals(store, {
    projectId: "proj-h",
    commit: "e".repeat(40),
    at: tHindsight,
    message: 'Revert "Routing feature"',
    touchedPaths: ["packages/host/src/routing-posterior.ts"],
    priorPathsByRun: new Map([["run-b", ["."]]]),
  });
  assert.equal(wildcardSkip.recordedSignals, 0);
  assert.equal(wildcardSkip.detections.length, 0, "wildcard '.' path never triggers path-overlap match");

  const expiredWindow = recordHindsightSignals(store, {
    projectId: "proj-h",
    commit: "f".repeat(40),
    at: "2026-12-15T10:00:00.000Z",
    message: `Fixes ${landedCommitB}`,
  });
  assert.equal(expiredWindow.detections.length, 0, "expired holdUntil landings are ignored");

  const fixReport = recordHindsightSignals(store, {
    projectId: "proj-h",
    commit: fixCommit,
    at: tHindsight,
    message: `Fixes ${landedCommitB.slice(0, 12)}`,
    touchedPaths: ["packages/host/src/routing-posterior.ts"],
    priorPathsByRun: new Map([["run-b", ["packages/host/src/routing-posterior.ts"]]]),
  });
  assert.equal(fixReport.recordedSignals, 1);
  const sigB = store.read(db => runSignals(db, "run-b"));
  const linkedSig = sigB.find(s => s.kind === "linked-fix" && s.payload.kind === "linked-fix" && s.payload.commit === fixCommit);
  assert.ok(linkedSig);
  assert.equal(linkedSig?.authority, "claim");
  assert.equal(store.read(db => readOutcome(db, "run-b:m1"))?.held, 0);
  const withdrawn = ownerSignal(store, { action: "withdraw", kind: "linked-fix", signalId: linkedSig!.signalId }, tHindsight);
  assert.equal(withdrawn.signal.state, "withdrawn");
  assert.equal(store.read(db => readOutcome(db, "run-b:m1"))?.held, null);

  const repeatEmpty = recordHindsightSignals(store, { projectId: "proj-h", commit: "1".repeat(40), at: tHindsight, message: "chore: docs" });
  assert.equal(repeatEmpty.recordedSignals, 0);

  const fromScan = recordHindsightFromScan(store, {
    projectId: "proj-h",
    head: revertCommit,
    continuous: true,
    commits: [],
    landings: [],
    reverts: [{ runId: "run-a", signalId: "sig-a", commit: revertCommit, reverts: landedCommitA }],
    recorded: [],
  }, { at: tHindsight });
  assert.equal(fromScan.evalCandidates.length, 1);
  assert.equal(fromScan.recordedSignals, 0);

  const memRecords = memStore.listRecords(ownerActor, workspaceId, { collectionId });
  assert.equal(memRecords.value.items.length, 1);
  assert.equal(memRecords.value.items[0]?.kind, "outcome");
  assert.ok(!/score|reward|posterior|spentUsd/i.test(memRecords.value.items[0]!.content));
});

test("memory/planner-context retrieves at most 5 scoped Class A verified lessons <= 2048 bytes and leaves unconfigured prompts unchanged", async t => {
  const dir = withTempDir(t, "infinite-phase4-memory-");
  const vaultKey = randomBytes(32);
  const witness = new TestMemoryWitness();
  const workspaceId = "33333333-3333-4333-8333-333333333333";
  const ownerActor: MemoryPrincipalSelector = { kind: "device", deviceId: "dev-owner" };
  const taskActor: MemoryPrincipalSelector = { kind: "task", taskBindingId: "task-actor" };
  const principals = new Map<string, MemoryPrincipalSnapshot>([
    ["dev-owner", { principalId: "prin-owner", kind: "device", deviceId: "dev-owner", deviceRole: "owner", state: "active" }],
    ["task-actor", { principalId: "prin-task", kind: "task", taskBindingId: "task-actor", workspaceId, bindingEpoch: 1, grantEpoch: 1, allowedActions: ["propose", "read"], allowedRecallModes: ["exact", "lexical"], state: "active" }],
  ]);
  const bindings = new Map<string, MemoryCurrentWorkspaceBinding>([
    [workspaceId, { workspaceId, bindingEpoch: 1, bindingDigest: "e".repeat(64), repositoryBindings: [{ repositoryIdentity: "example/repo", projectIds: ["proj-a"], rootIdentityDigest: "d".repeat(64) }], state: "active" }],
  ]);

  let nowMs = Date.parse(NOW);
  const store = new MemoryStoreService({
    databasePath: join(dir, "mem.sqlite"),
    vaultKey,
    hostId: "test-host",
    resolvePrincipal: s => principals.get(s.kind === "device" ? s.deviceId : s.taskBindingId),
    resolveWorkspaceBinding: id => bindings.get(id),
    recoveryWitness: witness,
    recoveryPublicKey: memRecoveryPub,
    now: () => nowMs,
  });
  await store.openRecovery();
  t.after(() => store.close());

  store.provisionWorkspaceMemory({
    intentEventId: "10000000-0000-4000-8000-000000000010",
    actor: ownerActor as MemoryPrincipalSelector & { kind: "device" },
    workspaceId,
    expectedBindingEpoch: 1,
    bindingDigest: "e".repeat(64),
  });
  let reqSeq = 20;
  const nextReq = () => `10000000-0000-4000-8000-${(reqSeq++).toString(16).padStart(12, "0")}`;
  const colRes = await store.mutate({
    actor: ownerActor,
    workspaceId,
    request: { requestId: nextReq(), expectedRevision: 1, expectedBindingEpoch: 1, op: { type: "collection_create", scope: "private" } },
  });
  const collectionId = (colRes.value as MemoryMutationResult).receipt.resourceId;
  let colRev = 1;

  const createRec = async (opType: "record_create" | "record_propose", actor: MemoryPrincipalSelector, payload: MemoryRecordPayload) => {
    const res = await store.mutate({
      actor,
      workspaceId,
      request: { requestId: nextReq(), expectedRevision: colRev, expectedBindingEpoch: 1, op: { type: opType, collectionId, payload } },
    });
    colRev += 1;
    return (res.value as MemoryMutationResult).receipt.resourceId;
  };

  const baseLesson = { kind: "lesson" as const, sensitivity: "standard" as const, sourceRefs: [], derivedFrom: [], validFrom: null, validUntil: null };
  for (let i = 1; i <= 7; i += 1) {
    nowMs += 1000;
    await createRec("record_create", ownerActor, {
      ...baseLesson,
      content: `Routing lesson ${i}: always keep deterministic tie-breaking under packages/host/src/routing-posterior.ts (${"x".repeat(260)}).`,
      metadata: { projectId: "proj-a", paths: ["packages/host/src/routing-posterior.ts"], ownerScore: 5, spentUsd: 12.34, posterior: 0.99 },
    });
  }
  await createRec("record_create", ownerActor, { ...baseLesson, content: "Other project lesson that must stay excluded.", metadata: { projectId: "proj-other", paths: ["packages/host/src/routing-posterior.ts"] } });
  await createRec("record_create", ownerActor, { ...baseLesson, content: "Disjoint path lesson that must stay excluded.", metadata: { projectId: "proj-a", paths: ["apps/web/src/main.tsx"] } });
  await createRec("record_create", ownerActor, { ...baseLesson, content: "Superseded lesson that must stay excluded.", metadata: { projectId: "proj-a", paths: ["packages/host/src"], superseded: true } });
  await createRec("record_create", ownerActor, { ...baseLesson, content: "Expired lesson that must stay excluded.", validUntil: "2026-11-01T00:00:00.000Z", metadata: { projectId: "proj-a", paths: ["packages/host/src"] } });
  await createRec("record_propose", taskActor, { ...baseLesson, content: "Unverified candidate lesson from model must stay excluded.", metadata: { projectId: "proj-a", paths: ["packages/host/src"] } });
  await createRec("record_create", ownerActor, { ...baseLesson, content: "Restricted lesson must stay excluded.", sensitivity: "restricted", metadata: { projectId: "proj-a", paths: ["packages/host/src"] } });
  await createRec("record_create", ownerActor, { ...baseLesson, content: "Outcome summary is not a Class A lesson.", kind: "outcome", metadata: { projectId: "proj-a", paths: ["packages/host/src"] } });
  await createRec("record_create", ownerActor, { ...baseLesson, content: "Secret token ghp_1234567890abcdefghijklmnopqrstuvwxyz1234 must be filtered.", metadata: { projectId: "proj-a", paths: ["packages/host/src"] } });

  const lessons = retrievePlannerLessons({
    store,
    actor: ownerActor,
    workspaceId,
    projectId: "proj-a",
    allowedPaths: ["packages/host/src"],
    query: "routing tie-breaking",
    now: () => nowMs,
  });
  assert.equal(lessons.length, MAX_PLANNER_LESSONS);
  for (const lesson of lessons) {
    assert.equal(lesson.provenanceClass, "owner-authored");
    assert.ok(!("metadata" in lesson));
    assert.ok(!lesson.content.includes("Other project"));
    assert.ok(!lesson.content.includes("Disjoint"));
    assert.ok(!lesson.content.includes("Superseded"));
    assert.ok(!lesson.content.includes("Expired"));
    assert.ok(!lesson.content.includes("candidate"));
    assert.ok(!lesson.content.includes("Restricted"));
    assert.ok(!lesson.content.includes("Outcome summary"));
    assert.ok(!lesson.content.includes("ghp_"));
  }

  const block = retrievePlannerMemoryBlock({
    store,
    actor: ownerActor,
    workspaceId,
    projectId: "proj-a",
    allowedPaths: ["packages/host/src"],
    query: "routing tie-breaking",
    now: () => nowMs,
  });
  assert.ok(block !== undefined);
  assert.ok(Buffer.byteLength(block, "utf8") <= MAX_PLANNER_MEMORY_BYTES);
  assert.ok(block.includes("Advisory repository memory for project proj-a"));
  assert.ok(block.includes("unauthoritative"));
  assert.ok(!block.includes("spentUsd") && !block.includes("ownerScore") && !block.includes("posterior"));

  const emptyBlock = retrievePlannerMemoryBlock({
    store,
    actor: ownerActor,
    workspaceId,
    projectId: "proj-empty",
    allowedPaths: ["packages/host/src"],
    now: () => nowMs,
  });
  assert.equal(emptyBlock, undefined);
  assert.equal(formatPlannerMemoryBlock("proj-a", []), undefined);
  const packed = formatPlannerMemoryBlock("proj-a", [
    { id: "l1", revision: 1, provenanceClass: "owner-authored", content: "A".repeat(1600) },
    { id: "l2", revision: 1, provenanceClass: "owner-authored", content: "B".repeat(500) },
    { id: "l3", revision: 1, provenanceClass: "owner-authored", content: "short fit" },
  ]);
  assert.ok(packed && packed.includes("short fit") && Buffer.byteLength(packed, "utf8") <= MAX_PLANNER_MEMORY_BYTES);

  const run = {
    id: "run-mem-1",
    projectId: "proj-a",
    provider: "claude",
    title: "Routing fix",
    objective: "Keep routing tie-breaking deterministic",
    parallelism: 1,
    revision: 1,
    status: "planning",
    createdAt: NOW,
    updatedAt: NOW,
    workspace: "/home/dev/projects/infinite",
    branch: "infinite/team-mem",
    baseCommit: "a".repeat(40),
    goal: { allowedPaths: ["packages/host/src"], successCriteria: "Tests pass" },
    tasks: [],
    members: [],
    decisions: [],
    checks: [],
    steering: [],
    events: [],
    round: 1,
  } as unknown as TeamRun;

  const computedBlock = plannerMemoryForRun({ store, actor: ownerActor, workspaceId, now: () => nowMs }, run);
  assert.ok(computedBlock && computedBlock.includes("Advisory repository memory"));

  const pmPromptDefault = teamPrompt(run, "project-manager");
  const pmPromptUndefined = teamPrompt(run, "project-manager", undefined, undefined, run.provider, undefined, undefined, [], true, undefined);
  assert.equal(pmPromptDefault, pmPromptUndefined, "omitted or empty memory preserves prompt byte-for-byte");

  const pmPromptWithMem = teamPrompt(run, "project-manager", undefined, undefined, run.provider, undefined, undefined, [], true, computedBlock);
  assert.ok(pmPromptWithMem.includes("Advisory repository memory for project proj-a"));

  const implPromptDefault = teamPrompt(run, "implementer", { id: "t1", title: "T", instructions: "Do", paths: ["packages/host/src/a.ts"], dependsOn: [], revision: 1, status: "pending" });
  const implPromptWithArg = teamPrompt(run, "implementer", { id: "t1", title: "T", instructions: "Do", paths: ["packages/host/src/a.ts"], dependsOn: [], revision: 1, status: "pending" }, undefined, run.provider, undefined, undefined, [], true, computedBlock);
  assert.equal(implPromptDefault, implPromptWithArg, "non-planner roles never receive advisoryMemory");
  assert.equal(teamContext(run, undefined, undefined, "implementer", [], computedBlock).advisoryMemory, undefined);
  assert.equal(teamContext(run, undefined, undefined, "project-manager", [], computedBlock).advisoryMemory, computedBlock);
});
