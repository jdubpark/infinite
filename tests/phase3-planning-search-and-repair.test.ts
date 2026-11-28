import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { advanceGoalDigest, buildCrossingDigest, formatPreviousWork } from "../packages/host/src/goal-cycle-digest.js";
import { wakeObjective } from "../packages/host/src/goal-standing.js";
import { goalStandingSchema, type GoalCycle, type ProductGoal } from "../packages/host/src/goal-types.js";
import { GOAL_DIGEST_LIMIT_BYTES, goalDigestSchema } from "../packages/host/src/goal-digest.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import type { Criterion } from "../packages/host/src/objective-types.js";
import { SignalService } from "../packages/host/src/signals/service.js";
import { addToPendingWake, signalKinds } from "../packages/host/src/signals/types.js";
import { TeamReadPool, readStepToScout } from "../packages/host/src/team-read-pool.js";
import { TeamSearchRuntime, type SearchHost } from "../packages/host/src/team-search-runtime.js";
import { TeamConsumer, type ConsumerHost } from "../packages/host/src/team-consumer.js";
import { COST_HEADROOM_ALGORITHM_VERSION, REWARD_VERSION, ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { teamProjectSchema, type TeamCommand, type TeamLineup, type TeamModelProfile, type TeamRun, type TeamView } from "../packages/host/src/team-types.js";
import { readsStateSchema, searchStateSchema } from "../packages/host/src/team-state-schemas.js";
import { selectWarmRepairTarget, warmRepairFeedback } from "../packages/host/src/team-warm-repair.js";
import type { Stored } from "../packages/host/src/teams.js";
import type { Config } from "../packages/host/src/types.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const TREE_B = "d".repeat(40);
const NOW = "2026-11-28T10:00:00.000Z";

const LINEUP: TeamLineup = {
  coordinator: { id: "coord", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  implementers: [
    { id: "imp-codex", label: "Codex Light", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" },
    { id: "imp-claude", label: "Claude Light", provider: "claude", model: "claude-sonnet-5", effort: "high", tier: "light" },
    { id: "imp-gemini", label: "Gemini Light", provider: "gemini", model: "gemini-3-flash", effort: "high", tier: "light" },
  ],
  integrator: { id: "integ", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "rev", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  evaluators: [{ id: "eval-codex", label: "Codex Eval", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" }],
};

const TEST_CHECK: TeamCommand = { command: "npm", args: ["test"] };

function baseConfig(projectOverrides: Partial<Config["projects"][number]["team"]> = {}, warmRepair?: boolean): Config {
  return {
    port: 0,
    origin: "http://127.0.0.1:0",
    stateDir: "/home/dev/state",
    runDir: "/home/dev/run",
    keyFile: "/home/dev/key",
    environment: "local",
    tokens: [],
    agents: {
      claude: { command: "echo", args: [] },
      codex: { command: "echo", args: [] },
      gemini: { command: "echo", args: [] },
    },
    teams: {
      workspaceDir: "/home/dev/teams",
      lineup: LINEUP,
      ...(warmRepair !== undefined ? { warmRepair } : {}),
    },
    projects: [
      {
        id: "alpha",
        name: "Alpha",
        path: "/home/dev/projects/alpha",
        team: {
          checks: [TEST_CHECK],
          ...projectOverrides,
        },
      },
    ],
  } as unknown as Config;
}

function baseGoal(cycles: GoalCycle[] = []): ProductGoal {
  return {
    id: randomUUID(),
    projectId: "alpha",
    revision: 1,
    status: "running",
    title: "Multi-cycle improvement",
    objective: "Ship checked changes across cycles",
    successCriteria: "Checks pass and criteria are met",
    nonGoals: [],
    allowedPaths: ["src"],
    evidence: [],
    maxRuns: 4,
    maxMinutes: 60,
    maxMembers: 24,
    parallelism: 2,
    createdAt: NOW,
    updatedAt: NOW,
    deadlineAt: "2026-11-28T12:00:00.000Z",
    lineup: LINEUP,
    cycles,
    memberCount: 0,
    steering: [],
    events: [],
    outcomes: [],
  };
}

function baseRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: randomUUID(),
    projectId: "alpha",
    provider: "claude",
    lineup: LINEUP,
    title: "Run",
    objective: "Implement feature",
    parallelism: 3,
    revision: 1,
    status: "implementing",
    createdAt: NOW,
    updatedAt: NOW,
    workspace: "/home/dev/teams/alpha-run",
    branch: "infinite/team-test",
    baseCommit: COMMIT_A,
    headCommit: COMMIT_A,
    tasks: [],
    members: [],
    decisions: [],
    checks: [],
    steering: [],
    events: [],
    round: 0,
    ...overrides,
  };
}

test("goal-cycle-digest advances CrossingDigest -> GoalDigest and bounds previousWork without leaking scores", () => {
  const goal = baseGoal();
  const team1Id = randomUUID();
  const cycle1: GoalCycle = {
    teamId: team1Id,
    cycle: 1,
    goalRevision: 1,
    status: "ready-for-review",
    startedAt: NOW,
    finishedAt: NOW,
    headCommit: COMMIT_B,
    brief: {
      title: "Feature 1",
      problem: "Missing cache",
      evidence: [{ source: "src/cache.ts", observation: "No cache layer" }],
      dataShape: "Map<string, string>",
      acceptance: ["Cache stores values"],
      expectedOutcome: "Cache speeds up repeated lookups",
      uiChanges: false,
    },
    assessment: {
      verdictId: randomUUID(),
      revision: 1,
      head: COMMIT_B,
      kind: "reviewed",
      result: "not-met",
      counts: { met: 0, notMet: 1, inconclusive: 0, pendingOwner: 0 },
      criteria: [{ id: "c1", state: "not-met" }],
      at: NOW,
      progress: 42,
    },
    memberCount: 3,
    class: "reviewed",
    settledAt: NOW,
  };
  goal.cycles.push(cycle1);
  const team1 = {
    status: "ready-for-review",
    revision: 1,
    headCommit: COMMIT_B,
    checks: [{ command: TEST_CHECK, status: "passed", startedAt: NOW, finishedAt: NOW, exitCode: 0, output: "", revision: 1 }],
    changes: { headCommit: COMMIT_B, recordedAt: NOW, files: [{ path: "src/cache.ts", status: "added", added: 30, removed: 0 }], truncated: false },
    tasks: [],
    decisions: [{ id: "d1", memberId: "m1", revision: 1, question: "Keep TTL?", options: ["Yes", "No"], answer: "Yes, 60s", createdAt: NOW }],
  } as unknown as TeamView;

  const d1 = advanceGoalDigest(goal, cycle1, team1);
  assert.ok(d1);
  assert.equal(goalDigestSchema.safeParse(d1).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(d1), "utf8") <= GOAL_DIGEST_LIMIT_BYTES);
  goal.digest = d1;

  const team2Id = randomUUID();
  const cycle2: GoalCycle = {
    teamId: team2Id,
    cycle: 2,
    goalRevision: 1,
    status: "blocked",
    startedAt: NOW,
    finishedAt: NOW,
    reason: "Tests failed on edge case",
    memberCount: 2,
    class: "failed",
    settledAt: NOW,
  };
  goal.cycles.push(cycle2);
  const team2 = {
    status: "blocked",
    revision: 1,
    blockCode: "check-failed",
    reason: "Tests failed on edge case",
    checks: [{ command: TEST_CHECK, status: "failed", startedAt: NOW, finishedAt: NOW, exitCode: 1, output: "fail", revision: 1 }],
    changes: { headCommit: COMMIT_B, recordedAt: NOW, files: [{ path: "src/edge.ts", status: "modified", added: 5, removed: 2 }], truncated: false },
    tasks: [],
    decisions: [{ id: "d2", memberId: "m2", revision: 1, question: "Handle empty input?", intentQuestions: [2], options: ["Throw", "Return null"], createdAt: NOW }],
    review: { verdict: "changes-requested", summary: "Fix empty input", revision: 1 },
  } as unknown as TeamView;

  const crossing2 = buildCrossingDigest(cycle2, team2);
  assert.equal(crossing2.outcome, "failed");
  assert.ok(crossing2.failures.some(item => item.by === "receipt" && item.class === "check"));
  assert.ok(crossing2.open.some(item => item.includes("intent check's questions 2")));

  const punctuationBlockTeam = { ...team2, blockCode: "---" } as unknown as TeamView;
  assert.ok(advanceGoalDigest(goal, { ...cycle2, brief: undefined }, punctuationBlockTeam));

  const d2 = advanceGoalDigest(goal, cycle2, team2);
  assert.ok(d2);
  assert.equal(goalDigestSchema.safeParse(d2).success, true);
  assert.ok(d2.failures.length > 0, "unresolved blocked cycle keeps failure receipts");
  assert.ok(d2.touched.some(item => item.path === "src/cache.ts"));
  assert.ok(d2.touched.some(item => item.path === "src/edge.ts"));
  goal.digest = d2;

  const previous = formatPreviousWork(goal);
  assert.ok(previous.length >= 2 && previous.length <= 16);
  assert.ok(previous[0]!.startsWith("Feature 1:"));
  const carry = previous.at(-1)!;
  assert.ok(carry.length <= 2000);
  assert.match(carry, /src\/cache\.ts/);
  assert.match(carry, /src\/edge\.ts/);
  assert.match(carry, /Unresolved failures:/);
  assert.ok(!carry.includes("Criteria:"), "evaluator criteria section must never leak into prompt previousWork");
  assert.ok(!carry.includes("not-met"), "evaluator criterion verdicts must never leak into prompt previousWork");
  assert.ok(!carry.includes("c1:"), "evaluator criterion ids must never leak into prompt previousWork");
  assert.ok(!carry.includes("42"), "assessment progress/scores must never leak into prompt previousWork");

  const legacyGoal = baseGoal([cycle1]);
  assert.deepEqual(formatPreviousWork(legacyGoal), ["Feature 1: Cache speeds up repeated lookups"]);
});

test("team-warm-repair opts in for single-implementer round 1 check/review failures and falls back cleanly otherwise", () => {
  const implementerProfile: TeamModelProfile = LINEUP.implementers[0]!;
  const taskId = "task-1";
  const memberId = randomUUID();
  const base = baseRun({
    round: 1,
    tasks: [
      {
        id: taskId,
        title: "Add parser",
        instructions: "Write parser",
        paths: ["src/parser.ts"],
        changedPaths: { paths: ["src/parser.ts", "tests/parser.test.ts"], truncated: false },
        dependsOn: [],
        status: "integrated",
        memberId,
        summary: "Implemented streaming parser",
      },
    ],
    members: [
      {
        runId: "r",
        memberId,
        revision: 1,
        role: "implementer",
        provider: "codex",
        modelProfile: implementerProfile,
        taskId,
        sessionId: randomUUID(),
        title: "implementer: task-1",
        status: "stopped",
        cwd: "/tmp/w",
        baseCommit: COMMIT_A,
        prompt: "p",
        cursor: 0,
        stopRequestId: randomUUID(),
      },
    ],
  });

  assert.equal(selectWarmRepairTarget(base, "check", baseConfig()), undefined, "disabled by default");

  const projectEnabled = baseConfig({ warmRepair: true });
  const target = selectWarmRepairTarget(base, "check", projectEnabled);
  assert.ok(target);
  assert.equal(target.memberId, memberId);
  assert.equal(target.modelProfile.id, implementerProfile.id);
  assert.deepEqual(target.changedPaths, ["src/parser.ts", "tests/parser.test.ts"]);

  const hostEnabled = baseConfig({}, true);
  assert.ok(selectWarmRepairTarget(base, "review", hostEnabled));

  const projectOverridesHostOff = baseConfig({ warmRepair: false }, true);
  assert.equal(selectWarmRepairTarget(base, "check", projectOverridesHostOff), undefined);

  const feedback = warmRepairFeedback(target, "npm test failed at line 12");
  assert.match(feedback, /Warm repair handoff \(round 1\)/);
  assert.match(feedback, /src\/parser\.ts, tests\/parser\.test\.ts/);
  assert.match(feedback, /Implemented streaming parser/);
  assert.match(feedback, /npm test failed at line 12/);

  assert.equal(selectWarmRepairTarget(baseRun({ ...base, round: 2 }), "check", projectEnabled), undefined, "round 2 uses fresh integrator");
  assert.equal(selectWarmRepairTarget(baseRun({ ...base, replay: { jobId: "j", trialId: "t", purpose: "replay" } }), "check", projectEnabled), undefined);
  assert.equal(selectWarmRepairTarget(base, "delivery", projectEnabled), undefined);
  assert.equal(selectWarmRepairTarget(base, "check", projectEnabled, new Set(["codex"])), undefined, "rate-limited provider falls back");

  const multiTask = baseRun({
    ...base,
    tasks: [
      ...base.tasks,
      { id: "task-2", title: "Second", instructions: "Second", paths: ["src/other.ts"], dependsOn: [], status: "integrated", memberId: randomUUID() },
    ],
  });
  assert.equal(selectWarmRepairTarget(multiTask, "check", projectEnabled), undefined, "multi-task ambiguity falls back");
});

test("team-search-runtime validates project config, gates on mode, and drives live & measure search lifecycles", () => {
  assert.equal(teamProjectSchema.safeParse({ checks: [TEST_CHECK], search: { mode: "live", attempts: 3 }, warmRepair: true }).success, true);
  assert.equal(teamProjectSchema.safeParse({ checks: [TEST_CHECK], search: { mode: "measure" } }).success, true);

  const checkHash = commandDigest(TEST_CHECK);
  const criterion: Criterion = {
    id: "c1",
    origin: "owner",
    statement: "All tests pass",
    check: { kind: "command", command: checkHash },
    producer: "host",
    threshold: { kind: "pass" },
    pinned: [{ path: "tests/a.test.ts", blob: "e".repeat(40) }],
    state: "active",
  };

  const events: string[] = [];
  const baseCalls: { commit: string; memberId?: string }[] = [];
  const captures: string[] = [];
  const challengerLaunches: { launch: number; profiles: string[]; baseCommit: string }[] = [];
  const integrations: string[] = [];
  const stops: string[] = [];
  const pauses: string[] = [];

  const createHarness = (mode: "off" | "measure" | "live") => {
    const config = baseConfig({ search: { mode, start: "after-fail", share: 0.25, attempts: 3 } });
    const host: SearchHost = {
      config,
      now: () => NOW,
      limited: () => new Set(),
      requiredChecks: () => [TEST_CHECK],
      freeSessionSlots: () => 4,
      activeWorkerCount: () => 1,
      save: () => {},
      event: (_h, text) => { events.push(text); },
      runCheckCommand: (_h, _s, _cmd, commit, memberId) => { baseCalls.push({ commit, memberId }); },
      captureCandidate: (_h, _s, member) => { captures.push(member.memberId); },
      startChallengers: (_h, _s, _t, launch, profiles, baseCommit) => {
        challengerLaunches.push({ launch, profiles: profiles.map(p => p.id), baseCommit });
      },
      cancelChallengerLaunch: () => {},
      stopMember: (_h, member) => { stops.push(member.memberId); },
      stopOperations: () => {},
      integrateWinner: (_h, _s, member) => { integrations.push(member.memberId); },
      releaseChampion: () => {},
      pauseForBrake: (_h, reason) => { pauses.push(reason); },
    };
    return new TeamSearchRuntime(host);
  };

  const makeRunAndTask = () => {
    const champId = randomUUID();
    const run = baseRun({
      routing: {
        mode: "auto",
        requested: "auto",
        source: "saved",
        knobs: { ...ROUTING_DEFAULTS, points: ["start"] },
        defaults: [],
        algorithmVersion: COST_HEADROOM_ALGORITHM_VERSION,
        rewardVersion: REWARD_VERSION,
        digest: "e".repeat(64),
        periodEndedAt: NOW,
      },
      goal: {
        id: randomUUID(),
        revision: 1,
        cycle: 1,
        successCriteria: "Pass tests",
        nonGoals: [],
        allowedPaths: ["src"],
        evidence: [],
        previousWork: [],
        deadlineAt: "2026-11-28T20:00:00.000Z",
        maxMembers: 20,
        record: { version: 1, criteria: [{ id: "c1", statement: "All tests pass", check: "command:npm test", producer: "host" }] },
      },
      tasks: [{
        id: "t1",
        title: "Fix module",
        instructions: "Fix module",
        paths: ["src/mod.ts"],
        dependsOn: [],
        status: "running",
        memberId: champId,
        criterionRefs: { objectiveVersion: 1, criteria: ["c1"] },
      }],
      members: [{
        runId: "r",
        memberId: champId,
        revision: 1,
        role: "implementer",
        provider: "codex",
        modelProfile: LINEUP.implementers[0],
        taskId: "t1",
        sessionId: randomUUID(),
        title: "implementer: t1",
        status: "running",
        cwd: "/tmp/w1",
        baseCommit: COMMIT_A,
        prompt: "p",
        cursor: 0,
        stopRequestId: randomUUID(),
      }],
    });
    return { run, champId, member: run.members[0]!, task: run.tasks[0]! };
  };

  const offRuntime = createHarness("off");
  const offCase = makeRunAndTask();
  assert.equal(offRuntime.admitTaskSearch({ run: offCase.run }, offCase.member, offCase.task, { criterion, pinnedAtBase: true }), undefined);
  assert.equal(offCase.run.searches, undefined);
  assert.equal(offRuntime.startHistory("alpha").length, 0);

  const liveRuntime = createHarness("live");
  const liveCase = makeRunAndTask();
  const holder = { run: liveCase.run };
  const ownedPinTask = { ...liveCase.task, paths: ["tests/a.test.ts"] };
  assert.deepEqual(liveRuntime.admitTaskSearch(holder, liveCase.member, ownedPinTask, { criterion, pinnedAtBase: true }), { admitted: false, condition: 4 });
  assert.deepEqual(liveRuntime.admitTaskSearch(holder, liveCase.member, liveCase.task, { criterion, pinnedAtBase: true, explore: true }), { admitted: false, condition: 5 });
  assert.equal(liveRuntime.startHistory("alpha").length, 0, "ineligible starts must not dilute share history");

  for (let i = 0; i < 3; i++) {
    assert.deepEqual(liveRuntime.admitTaskSearch(holder, liveCase.member, liveCase.task, { criterion, pinnedAtBase: true }), { admitted: false, condition: 7 });
  }
  const admitted = liveRuntime.admitTaskSearch(holder, liveCase.member, liveCase.task, { criterion, pinnedAtBase: true });
  assert.ok(admitted && admitted.admitted);
  assert.equal(liveCase.run.searches?.length, 1);
  assert.equal(searchStateSchema.safeParse(liveCase.run.searches![0]).success, true);
  assert.equal(baseCalls.length, 1);
  assert.equal(baseCalls[0]!.commit, COMMIT_A);

  const searchId = liveCase.run.searches![0]!.id;
  liveRuntime.onGateCompleted(holder, searchId, { outcome: "fail", ms: 200, failures: 1 });
  assert.equal(liveCase.run.searches![0]!.state, "armed");

  assert.equal(liveRuntime.onMemberResult(holder, liveCase.member), true, "live search intercepts champion result");
  assert.deepEqual(captures, [liveCase.champId]);

  liveRuntime.onMemberCaptured(holder, searchId, { memberId: liveCase.champId, commit: COMMIT_B, tree: TREE_B, scope: "ok", empty: false });
  assert.equal(baseCalls.length, 2);
  assert.equal(baseCalls[1]!.memberId, liveCase.champId);

  liveRuntime.onGateCompleted(holder, searchId, { outcome: "fail", ms: 150, failures: 1, memberId: liveCase.champId });
  assert.equal(challengerLaunches.length, 1);
  assert.ok(challengerLaunches[0]!.profiles.includes("imp-claude"));

  const chalId = randomUUID();
  liveCase.run.members.push({
    ...liveCase.member,
    memberId: chalId,
    provider: "claude",
    modelProfile: LINEUP.implementers[1],
  });
  liveRuntime.dispatchEvent(holder, searchId, {
    kind: "started",
    launch: challengerLaunches[0]!.launch,
    challengers: [{ memberId: chalId, profileId: "imp-claude" }],
  });
  assert.equal(liveCase.run.searches![0]!.state, "wide");

  liveRuntime.onMemberResult(holder, liveCase.run.members.at(-1)!);
  liveRuntime.onMemberCaptured(holder, searchId, { memberId: chalId, commit: COMMIT_C, tree: "f".repeat(40), scope: "ok", empty: false });
  liveRuntime.onGateCompleted(holder, searchId, { outcome: "pass", ms: 100, memberId: chalId });
  assert.equal(liveCase.run.searches![0]!.state, "resolved");
  assert.equal(liveCase.run.searches![0]!.class, "rescued");
  assert.deepEqual(integrations, [chalId]);
  assert.equal(liveRuntime.widenedHistory("alpha").at(-1), "rescued");
  assert.ok(events.some(line => line.includes("Admitted live search")));
  assert.ok(stops.length >= 1, "losing champion stops when challenger rescues");
  assert.equal(pauses.length, 0);

  const measureRuntime = createHarness("measure");
  const measureCase = makeRunAndTask();
  const measureHolder = { run: measureCase.run };
  const measureAdmit = measureRuntime.admitTaskSearch(measureHolder, measureCase.member, measureCase.task, { criterion, pinnedAtBase: true });
  assert.ok(measureAdmit && measureAdmit.admitted);
  assert.equal(measureRuntime.onMemberResult(measureHolder, measureCase.member), false, "measure mode does not block integration");
  assert.equal(measureRuntime.outcomeSourceForTask(measureCase.run, measureCase.task), "production");
  measureRuntime.onTaskIntegrated(measureHolder, measureCase.member, measureCase.task, COMMIT_B, TREE_B, false);
  assert.ok(measureCase.run.searches![0]!.holdUntil !== undefined);
});

test("team-read-pool admits multi-phase requests, dispatches scouts, expands forEach phases, and settles steps", () => {
  const pool = new TeamReadPool();
  const stored = { run: baseRun({ parallelism: 3 }) } as Stored;
  const req1Id = randomUUID();
  const req2Id = randomUUID();
  const pmId = randomUUID();

  const admitted = pool.admit(stored, {
    requestId: req1Id,
    requester: { role: "project-manager", memberId: pmId },
    allowanceLeft: 10,
    request: {
      kind: "read",
      summary: "List files then inspect each",
      phases: [
        {
          id: "list-phase",
          steps: [{ id: "find-modules", title: "Find modules", instructions: "List candidate modules", output: "list", paths: ["src"] }],
        },
        {
          id: "read-phase",
          steps: [{ id: "inspect-module", title: "Inspect module", instructions: "Read module behavior", output: "findings", forEach: { step: "find-modules", maxItems: 4 } }],
        },
      ],
    },
  });
  assert.equal(admitted.ok, true);
  assert.equal(readsStateSchema.safeParse(stored.run.reads).success, true);

  const ready1 = pool.nextReadySteps(stored.run);
  assert.equal(ready1.length, 1);
  assert.equal(ready1[0]!.step.id, "find-modules");
  const scoutTask = readStepToScout(ready1[0]!);
  assert.equal(scoutTask.id, "find-modules");
  assert.match(scoutTask.instructions, /Scoped paths: src/);

  const scout1Id = randomUUID();
  assert.equal(pool.markStarted(stored, req1Id, "find-modules", scout1Id).ok, true);
  assert.equal(pool.findMemberStep(stored.run, scout1Id)?.step.id, "find-modules");
  assert.equal(pool.findScoutTask(stored.run, "find-modules")?.title, "Find modules");

  const settled1 = pool.settleStep(stored, req1Id, "find-modules", "complete", randomUUID(), 2);
  assert.equal(settled1.ok, true);
  assert.equal(pool.findMemberStep(stored.run, scout1Id), undefined);

  const ready2 = pool.nextReadySteps(stored.run);
  assert.deepEqual(ready2.map(item => item.step.id), ["inspect-module.0", "inspect-module.1"]);
  assert.equal(readStepToScout(ready2[0]!).title, "Inspect module [1]");

  const joinAdmit = pool.admit(stored, {
    requestId: req2Id,
    requester: { role: "project-manager", memberId: pmId },
    allowanceLeft: 4,
    request: {
      kind: "read",
      summary: "Reuse cached module list",
      phases: [
        {
          id: "reuse-phase",
          steps: [{ id: "find-modules-again", title: "Find modules", instructions: "List candidate modules", output: "list", paths: ["src"] }],
        },
      ],
    },
  });
  assert.equal(joinAdmit.ok, true);

  for (const step of ready2) {
    const mId = randomUUID();
    assert.equal(pool.markStarted(stored, req1Id, step.step.id, mId).ok, true);
    assert.equal(pool.settleStep(stored, req1Id, step.step.id, "complete", randomUUID()).ok, true);
  }

  const summary = pool.summary(stored.run.reads, 1);
  assert.equal(summary.requests.total, 2);
  assert.equal(summary.requests.ended, 2);
  assert.equal(summary.steps.complete, 4);
  assert.equal(summary.steps.expanded, 1);

  const invalidProfile = pool.admit(stored, {
    requestId: randomUUID(),
    requester: { role: "project-manager", memberId: pmId },
    request: {
      kind: "read",
      summary: "Bad profile",
      phases: [{ id: "p1", steps: [{ id: "s1", title: "Step", instructions: "Inspect", output: "findings", agentProfileId: "no-such-profile" }] }],
    },
  });
  assert.equal(invalidProfile.ok, false);

  const req3Id = randomUUID();
  const failStored = { run: baseRun({ parallelism: 2 }) } as Stored;
  assert.equal(pool.admit(failStored, {
    requestId: req3Id,
    requester: { role: "project-manager", memberId: pmId },
    allowanceLeft: 5,
    request: {
      kind: "read",
      summary: "Read and settle with findings",
      phases: [{
        id: "p1",
        steps: [
          { id: "ok-step", title: "OK step", instructions: "Inspect ok", output: "findings" },
          { id: "bad-step", title: "Bad step", instructions: "Inspect bad", output: "findings" },
        ],
      }],
    },
  }).ok, true);
  const okScoutId = randomUUID();
  const badScoutId = randomUUID();
  assert.equal(pool.markStarted(failStored, req3Id, "ok-step", okScoutId).ok, true);
  assert.equal(pool.markStarted(failStored, req3Id, "bad-step", badScoutId).ok, true);
  assert.equal(pool.settleStep(failStored, req3Id, "ok-step", "complete", randomUUID(), undefined, {
    summary: "Checked router wiring",
    evidence: [{ source: "packages/host/src/teams.ts", observation: "Router wired at launch" }],
  }).ok, true);
  assert.equal(pool.failMemberStep(failStored, badScoutId, "Scout timed out"), true);
  const findingsFeedback = pool.formatFindingsFeedback(failStored);
  assert.ok(findingsFeedback);
  assert.match(findingsFeedback, /Checked router wiring/);
  assert.match(findingsFeedback, /packages\/host\/src\/teams\.ts/);
  assert.match(findingsFeedback, /bad-step \(failed\): Scout timed out/);

  const restartedPool = new TeamReadPool();
  const persistedTask = restartedPool.findScoutTask(stored, "find-modules");
  assert.equal(persistedTask?.title, "Find modules");
  assert.match(persistedTask?.instructions ?? "", /Scoped paths: src/);
  assert.equal(persistedTask?.agentProfileId, "imp-codex");
});

test("TeamConsumer ignores losing search contestant late results and handles read-pool scout failures cleanly", () => {
  const pool = new TeamReadPool();
  const config = baseConfig({ search: { mode: "live", start: "after-fail", share: 0.25, attempts: 3 } });
  const blocks: string[] = [];
  let ops = 0;
  let searchRuntime!: TeamSearchRuntime;
  const host: ConsumerHost = {
    records: new Map(),
    config,
    closed: false,
    save: () => {},
    event: () => {},
    enqueue: (_id, fn) => Promise.resolve(fn()),
    operation: () => { ops++; },
    assertRunPath: () => {},
    assertBudget: () => {},
    block: (_stored, err) => { blocks.push(err instanceof Error ? err.message : String(err)); },
    options: undefined,
    diag: { warnUnexpected: () => {}, warnEnrichSkip: () => {} },
    router: undefined,
    replays: { consume: () => false },
    intentChecks: { consume: () => {}, hold: () => false },
    verdicts: { consume: () => {}, holdNoChange: () => false },
    readPool: pool,
    get searchRuntime() { return searchRuntime; },
    startInProject: (_pid, start) => start(),
    consumePermissionCoordinator: () => {},
    prefixFor: () => undefined,
    applyProjectManagerCapacity: () => {},
    emit: () => {},
    emitWith: () => {},
    routerInput: () => ({ publishHeads: false, entryTools: false, objectiveDigest: { version: 1, digest: "a".repeat(64) } as unknown as ReturnType<ConsumerHost["routerInput"]>["objectiveDigest"], codeMode: false, limited: new Set(), limitHistory: [] }),
    newMember: () => { throw new Error("unused"); },
    linkReplacement: () => {},
    prepareMember: () => {},
    assertDelivery: () => {},
    queueDeliveryRetryAfterEvidence: () => {},
    memberProfile: () => undefined,
    captureApproved: () => {},
    captureIntegrated: () => {},
    retentionState: () => ({ status: "implementing", statusAt: NOW, integratedAt: {}, removalErrors: {} }),
    retentionNow: () => NOW,
    flushOutbox: () => true,
    replaceCheck: async () => {},
    noteLeftover: async () => {},
  };
  searchRuntime = new TeamSearchRuntime({
    config,
    now: () => NOW,
    limited: () => new Set(),
    requiredChecks: () => [TEST_CHECK],
    freeSessionSlots: () => 4,
    activeWorkerCount: () => 1,
    save: () => {},
    event: () => {},
    runCheckCommand: () => {},
    captureCandidate: () => {},
    startChallengers: () => {},
    cancelChallengerLaunch: () => {},
    stopMember: () => {},
    stopOperations: () => {},
    integrateWinner: () => {},
    releaseChampion: () => {},
    pauseForBrake: () => {},
  });
  const consumer = new TeamConsumer(host);

  const champId = randomUUID();
  const loserId = randomUUID();
  const searchRun = baseRun({
    tasks: [{ id: "t1", title: "Task 1", instructions: "Do 1", paths: ["src/a.ts"], dependsOn: [], status: "integrated", memberId: champId, commit: COMMIT_B }],
    searches: [{
      id: "s1",
      mode: "live",
      start: "after-fail",
      state: "resolved",
      criterionId: "c1",
      command: commandDigest(TEST_CHECK),
      decisionKey: "t1",
      baseCommit: COMMIT_A,
      contestants: [{ memberId: champId, profileId: "imp-codex" }, { memberId: loserId, profileId: "imp-claude" }],
      winner: champId,
      class: "champion-pass",
    }],
    members: [
      {
        runId: "r", memberId: loserId, revision: 1, role: "implementer", provider: "claude",
        modelProfile: LINEUP.implementers[1], taskId: "t1", sessionId: randomUUID(), title: "loser",
        status: "reported", cwd: "/tmp/w-loser", baseCommit: COMMIT_A, prompt: "p", cursor: 0,
        stopRequestId: randomUUID(), report: { kind: "result", summary: "late loser result" },
      },
    ],
  });
  const searchStored = { run: searchRun } as Stored;
  consumer.consume(searchStored, searchRun.members[0]!);
  assert.equal(ops, 0, "losing contestant late result must not trigger integration operation");
  assert.equal(searchRun.members[0]!.status, "stopped");
  assert.equal(searchRun.tasks[0]!.memberId, champId);

  searchRun.members[0]!.status = "reported";
  searchRun.members[0]!.report = { kind: "blocked", summary: "late loser block" };
  consumer.consume(searchStored, searchRun.members[0]!);
  searchRun.members[0]!.status = "reported";
  searchRun.members[0]!.report = { kind: "escalate", reason: "late loser escalate" };
  consumer.consume(searchStored, searchRun.members[0]!);
  assert.equal(searchRuntime.onMemberLeft(searchStored, searchRun.members[0]!, "no-report"), true);
  assert.equal(blocks.length, 0, "losing contestant departures on closed search must not block the run");

  const abandonedChampId = randomUUID();
  const abandonedStored = {
    run: baseRun({
      searches: [{
        id: "s-abandoned", mode: "live", start: "after-fail", state: "abandoned",
        criterionId: "c1", command: commandDigest(TEST_CHECK), decisionKey: "t1", baseCommit: COMMIT_A,
        contestants: [{ memberId: abandonedChampId, profileId: "imp-codex" }],
      }],
    }),
  } as Stored;
  assert.equal(searchRuntime.onMemberLeft(abandonedStored, { ...searchRun.members[0]!, memberId: abandonedChampId, status: "stopped" }, "no-report"), false);

  const readStored = { run: baseRun({ parallelism: 2 }) } as Stored;
  const reqId = randomUUID();
  const pmId = randomUUID();
  const scoutMemberId = randomUUID();
  assert.equal(pool.admit(readStored, {
    requestId: reqId,
    requester: { role: "project-manager", memberId: pmId },
    allowanceLeft: 4,
    request: { kind: "read", summary: "Read", phases: [{ id: "p1", steps: [{ id: "step-q", title: "Step Q", instructions: "Inspect", output: "findings" }] }] },
  }).ok, true);
  assert.equal(pool.markStarted(readStored, reqId, "step-q", scoutMemberId).ok, true);
  const scoutMember = {
    runId: readStored.run.id, memberId: scoutMemberId, revision: 1, role: "scout" as const, provider: "codex" as const,
    modelProfile: LINEUP.implementers[0], taskId: "step-q", sessionId: randomUUID(), title: "scout: step-q",
    status: "reported" as const, cwd: "/tmp/w-scout", baseCommit: COMMIT_A, prompt: "p", cursor: 0,
    stopRequestId: randomUUID(), report: { kind: "question" as const, question: "Need guidance", options: ["A", "B"] },
  };
  readStored.run.members.push(scoutMember);
  consumer.consume(readStored, scoutMember);
  assert.equal(blocks.length, 0, "read-pool scout question settles step as failed without blocking the run");
  assert.equal(scoutMember.status, "stopped");
  assert.equal(pool.summary(readStored.run.reads, 1).steps.failed, 1);
});

test("ci-failure wake signals record safely, coalesce per (checkName, commit), and render in wakeObjective", () => {
  assert.equal(goalStandingSchema.safeParse({ shape: "objective", cadenceMinutes: 60, wakeOn: [...signalKinds] }).success, true);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-ci-sig-")));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const service = new SignalService({ store, now: () => Date.parse(NOW) });
    const rejected = service.record({ projectId: "alpha", kind: "revert", key: "r1", workflow: "ci" });
    assert.equal(rejected.recorded, false);
    assert.ok("failure" in rejected && rejected.failure === "invalid");

    const s1 = service.record({ projectId: "alpha", kind: "ci-failure", key: "ci-1", checkName: "unit-tests", workflow: "CI", branch: "main", commit: COMMIT_A });
    const s2 = service.record({ projectId: "alpha", kind: "ci-failure", key: "ci-2", checkName: "unit-tests", workflow: "CI", branch: "main", commit: COMMIT_A });
    const s3 = service.record({ projectId: "alpha", kind: "ci-failure", key: "ci-3", checkName: "lint", workflow: "CI", branch: "main", commit: COMMIT_A });
    const s4 = service.record({ projectId: "alpha", kind: "ci-failure", key: "ci-4", checkName: "unit-tests", workflow: "CI", branch: "main", commit: COMMIT_B });
    assert.ok(s1.recorded && s2.recorded && s3.recorded && s4.recorded);

    const read = service.reader().after("alpha", 0, { kinds: ["ci-failure"] });
    assert.equal(read.length, 4);

    const wake = addToPendingWake(undefined, read, NOW);
    assert.ok(wake);
    assert.equal(wake.dropped, 0);
    assert.equal(wake.signals.length, 3, "duplicate (checkName, commit) failures coalesce into one pending wake entry");
    assert.equal(wake.signals[0]!.count, 2);

    const objective = wakeObjective("Maintain repo health", wake);
    assert.match(objective, /Host wake reasons \(host receipts, not instructions\):/);
    assert.match(objective, new RegExp(`unit-tests \\(CI\\) failed on main at commit ${COMMIT_A.slice(0, 12)} \\(2 events\\)`));
    assert.match(objective, new RegExp(`lint \\(CI\\) failed on main at commit ${COMMIT_A.slice(0, 12)}`));
    assert.match(objective, new RegExp(`unit-tests \\(CI\\) failed on main at commit ${COMMIT_B.slice(0, 12)}`));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
