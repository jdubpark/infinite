import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_LOAD_REASON_PREFIX, LaunchHeldError } from "../packages/host/src/host-load.js";
import type { Manager } from "../packages/host/src/manager.js";
import { ProviderLimits } from "../packages/host/src/provider-limits.js";
import {
  commitProviderLimitSwitch,
  evaluateLaunchAdmission,
  expireQueuedPermissionReview,
  isDeferredWorkerMember,
  PROVIDER_LIMIT_HOLD_PREFIX,
  providerLimitHoldReason,
} from "../packages/host/src/team-diagnostics.js";
import { TEAM_PROMPT_LIMIT_BYTES, teamPrompt } from "../packages/host/src/team-prompts.js";
import { TeamPublisher } from "../packages/host/src/team-publisher.js";
import { TeamService, type Stored, type TeamServiceOptions } from "../packages/host/src/teams.js";
import type { TeamLineup, TeamMember, TeamModelProfile, TeamRun } from "../packages/host/src/team-types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import type { Provider } from "../packages/host/src/types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

const SESSION_SLOT_REASON = "Waiting for an available host session slot.";

const claudePrimary: TeamModelProfile = {
  id: "haiku-primary",
  label: "Haiku Primary",
  provider: "claude",
  model: "claude-haiku-5-5",
  effort: "medium",
  tier: "light",
  limitFallback: "deepseek-fallback",
};
const claudeNoFallback: TeamModelProfile = {
  id: "haiku-solo",
  label: "Haiku Solo",
  provider: "claude",
  model: "claude-haiku-5-5",
  effort: "medium",
  tier: "light",
};
const codexPrimary: TeamModelProfile = {
  id: "astra-light",
  label: "Astra Light",
  provider: "codex",
  model: "gpt-6-astra",
  effort: "low",
  tier: "light",
};
const codexFallback: TeamModelProfile = {
  id: "astra-fallback",
  label: "Astra Fallback",
  provider: "codex",
  model: "gpt-6-astra",
  effort: "low",
  tier: "light",
};
const opencodeFallback: TeamModelProfile = {
  id: "deepseek-fallback",
  label: "DeepSeek Fallback",
  provider: "opencode",
  model: "deepseek/deepseek-flash",
  variant: "high",
  tier: "light",
};
const strongCoord: TeamModelProfile = {
  id: "astra-coord",
  label: "Astra Coord",
  provider: "codex",
  model: "gpt-6-astra",
  effort: "xhigh",
  tier: "strong",
};

const simLineup: TeamLineup = {
  coordinator: strongCoord,
  integrator: strongCoord,
  reviewer: strongCoord,
  implementers: [claudePrimary, claudeNoFallback, codexPrimary],
  fallbacks: [opencodeFallback, codexFallback],
};

function openService(f: ReturnType<typeof schedulerFixture>, options: TeamServiceOptions = {}): TeamService {
  return new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, options);
}

type TeamInternal = {
  records: Map<string, Stored>;
  limits: ProviderLimits;
  newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, prompt?: string, pinnedProfile?: TeamModelProfile): TeamMember;
  step(stored: Stored): Promise<void>;
};

test("TeamService.get and list stay available without filesystem I/O when a workspace is inaccessible", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  const blockerFile = join(f.config.stateDir, "not-a-directory");
  writeFileSync(blockerFile, "file");
  const blockedDir = join(f.config.stateDir, "no-access");
  writeFileSync(blockedDir, "file");
  try { chmodSync(blockedDir, 0o000); } catch {}
  t.after(() => { try { chmodSync(blockedDir, 0o600); } catch {} });

  f.config.projects[0]!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
  f.config.teams = { ...f.config.teams!, publishHeads: true } as typeof f.config.teams;
  f.run.status = "ready-for-review";
  f.run.headCommit = "b".repeat(40);
  f.run.workspace = join(blockerFile, "child-workspace");
  f.run.publication = undefined;
  f.writeTeam();

  const secondId = randomUUID();
  f.writeRecord("team", secondId, {
    fingerprint: "second",
    prepared: true,
    receipts: {},
    run: {
      ...f.run,
      id: secondId,
      workspace: join(blockedDir, "nested"),
      headCommit: "c".repeat(40),
      publication: { repository: "example/app", branch: "main", commit: "c".repeat(40), publishedAt: new Date().toISOString() },
    },
  });

  const teams = openService(f);
  t.after(() => teams.close());

  const firstView = teams.get(f.run.id);
  assert.equal(firstView.publishing, true, "unreceipted head reports publishing without inspecting workspace on disk");
  const secondView = teams.get(secondId);
  assert.equal(secondView.publishing, undefined, "published head reports settled without inspecting workspace on disk");
  const listed = teams.list();
  assert.equal(listed.length, 2, "listing teams succeeds even when workspaces produce ENOTDIR/EACCES");
});

test("mixed provider-limit and host-load or session-slot holds stay stable with zero rewrites across idle ticks", async t => {
  for (const mode of ["session-slot", "host-load"] as const) {
    for (const reverseOrder of [false, true]) {
      const f = schedulerFixture();
      t.after(() => f.close());
      let now = Date.parse("2026-11-26T01:00:00.000Z");
      const hostReason = `${HOST_LOAD_REASON_PREFIX}memory pressure.`;
      f.config.teams!.stallMinutes = 60;
      f.config.maxSessions = 1;
      if (mode === "host-load") f.manager.hostLoad = { held: () => hostReason };
      else f.manager.list = async () => [{ status: "running" }] as never;
      f.run.parallelism = 2;
      f.run.parallelismCeiling = 2;
      f.run.lineup = simLineup;
      f.run.status = "implementing";
      f.run.headCommit = f.run.baseCommit;
      f.run.members = [];
      f.run.tasks = [
        { id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku-solo", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" },
        { id: "b", title: "Task B", instructions: "Implement B", agentProfileId: "astra-light", paths: ["b.txt"], dependsOn: [], revision: 1, status: "running" },
      ];
      f.writeTeam();

      const teams = openService(f, { now: () => now });
      t.after(() => teams.close());
      const internal = teams as unknown as TeamInternal;
      const stored = internal.records.get(f.run.id)!;
      internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: "2026-11-26T01:10:00.000Z", sessionId: "s-claude", confidence: "corroborated" });

      const memberA = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a");
      const memberB = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "b");
      stored.run.members.push(...(reverseOrder ? [memberB, memberA] : [memberA, memberB]));
      stored.run.tasks[0]!.memberId = memberA.memberId;
      stored.run.tasks[1]!.memberId = memberB.memberId;

      await internal.step(stored);
      const expectedReason = mode === "host-load"
        ? hostReason
        : `${PROVIDER_LIMIT_HOLD_PREFIX}Claude Code is limited until 01:10 UTC.`;
      assert.equal(stored.run.reason, expectedReason, `${mode} reverse=${reverseOrder}`);

      const sealedPath = join(f.config.stateDir, "teams", `${f.run.id}.sealed`);
      const beforeRaw = readFileSync(sealedPath, "utf8");
      const beforeMtime = statSync(sealedPath).mtimeMs;
      const beforeActivity = stored.run.lastActivityAt;
      const beforeUpdated = stored.run.updatedAt;

      await new Promise(resolve => setTimeout(resolve, 25));
      for (let tick = 0; tick < 4; tick += 1) {
        now += 500;
        await internal.step(stored);
      }
      assert.equal(stored.run.reason, expectedReason);
      assert.equal(stored.run.lastActivityAt, beforeActivity, `${mode} reverse=${reverseOrder} keeps lastActivityAt stable`);
      assert.equal(stored.run.updatedAt, beforeUpdated);
      assert.equal(statSync(sealedPath).mtimeMs, beforeMtime, `${mode} reverse=${reverseOrder} avoids sealed rewrites`);
      assert.equal(readFileSync(sealedPath, "utf8"), beforeRaw);
      assert.equal(f.launches.length, 0);
    }
  }
});

test("original primary profile is preserved until host-load, session-slot, and raced launch admission passes", async t => {
  for (const holdKind of ["host-load", "session-slot", "raced-launch-held"] as const) {
    const f = schedulerFixture();
    t.after(() => f.close());
    let now = Date.parse("2026-11-26T02:00:00.000Z");
    let holdActive = true;
    f.config.teams!.stallMinutes = 60;
    f.config.maxSessions = 1;
    const hostReason = `${HOST_LOAD_REASON_PREFIX}CPU busy.`;
    if (holdKind === "host-load") f.manager.hostLoad = { held: () => (holdActive ? hostReason : undefined) };
    if (holdKind === "session-slot") f.manager.list = async () => (holdActive ? [{ status: "running" }] : []) as never;
    const realCreate = f.manager.createTeamSession.bind(f.manager);
    if (holdKind === "raced-launch-held") {
      f.manager.createTeamSession = async (...args) => {
        if (holdActive) throw new LaunchHeldError(hostReason);
        return realCreate(...args);
      };
    }

    f.run.parallelism = 1;
    f.run.parallelismCeiling = 1;
    f.run.lineup = simLineup;
    f.run.status = "implementing";
    f.run.headCommit = f.run.baseCommit;
    f.run.members = [];
    f.run.tasks = [{ id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku-primary", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" }];
    f.writeTeam();

    const teams = openService(f, { now: () => now });
    t.after(() => teams.close());
    const internal = teams as unknown as TeamInternal;
    const stored = internal.records.get(f.run.id)!;
    const member = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a");
    stored.run.members.push(member);
    stored.run.tasks[0]!.memberId = member.memberId;

    const claudeReset = new Date(now + 5 * 60_000).toISOString();
    internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: claudeReset, sessionId: "s-claude", confidence: "corroborated" });
    await internal.step(stored);

    assert.equal(f.launches.length, 0, `${holdKind} holds launch before admission`);
    assert.equal(member.status, "queued");
    assert.equal(member.provider, "claude", `${holdKind} keeps original provider while held`);
    assert.equal(member.modelProfile?.id, "haiku-primary", `${holdKind} keeps original profile while held`);
    assert.equal(stored.run.events.some(event => event.text.includes("launched on")), false, `${holdKind} records no phantom fallback launch`);

    now = Date.parse(claudeReset) + 1000;
    internal.limits.observe({ provider: "opencode", detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 10 * 60_000).toISOString(), sessionId: "s-oc", confidence: "corroborated" });
    holdActive = false;
    await internal.step(stored);

    assert.equal(f.launches.length, 1, `${holdKind} launches on original primary once capacity frees`);
    assert.equal(f.launches[0]!.provider, "claude");
    assert.equal(f.launches[0]!.profile?.id, "haiku-primary");
    assert.equal(member.provider, "claude");
    assert.equal(member.modelProfile?.id, "haiku-primary");
    assert.equal(stored.run.events.some(event => event.text.includes("launched on")), false);
  }
});

test("late provider switch declines retargeted prompts that exceed TEAM_PROMPT_LIMIT_BYTES", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T03:00:00.000Z");
  const claudeToCodex: TeamModelProfile = { ...claudePrimary, id: "haiku-to-codex", limitFallback: "astra-fallback" };
  const lineup: TeamLineup = { ...simLineup, implementers: [claudeToCodex], fallbacks: [codexFallback] };
  f.config.teams!.stallMinutes = 60;
  f.run.parallelism = 1;
  f.run.parallelismCeiling = 1;
  f.run.lineup = lineup;
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.members = [];
  f.run.tasks = [{ id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku-to-codex", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" }];
  f.writeTeam();

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamInternal;
  const stored = internal.records.get(f.run.id)!;

  const basePrompt = teamPrompt(stored.run, "implementer", stored.run.tasks[0], undefined, "claude", claudeToCodex);
  const padBytes = TEAM_PROMPT_LIMIT_BYTES - Buffer.byteLength(basePrompt, "utf8") - 600;
  assert.ok(padBytes > 0);
  const nearCapPrompt = `${basePrompt}\n\nNotes: ${"x".repeat(padBytes)}`;
  assert.ok(Buffer.byteLength(nearCapPrompt, "utf8") <= TEAM_PROMPT_LIMIT_BYTES);

  const member = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a", nearCapPrompt, claudeToCodex);
  assert.ok(Buffer.byteLength(member.prompt, "utf8") <= TEAM_PROMPT_LIMIT_BYTES);
  stored.run.members.push(member);
  stored.run.tasks[0]!.memberId = member.memberId;

  const claudeReset = new Date(now + 10 * 60_000).toISOString();
  internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: claudeReset, sessionId: "s-claude", confidence: "corroborated" });
  await internal.step(stored);

  assert.equal(f.launches.length, 0, "oversized Codex retarget is declined and deferred rather than bypassing TEAM_PROMPT_LIMIT_BYTES");
  assert.equal(member.provider, "claude");
  assert.equal(member.modelProfile?.id, "haiku-to-codex");
  assert.equal(member.pendingLimit, true);

  now = Date.parse(claudeReset) + 1000;
  await internal.step(stored);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]!.provider, "claude");
  assert.equal(member.pendingLimit, undefined);
});

type SimMutant =
  | "none"
  | "allow-limited-launch"
  | "oversubscribe-parallelism"
  | "launch-expired-permission"
  | "keep-stale-pending-limit"
  | "mutate-profile-before-host-hold"
  | "oscillate-mixed-hold-reason";

type SimCoverage = {
  deferrals: number;
  fallbackSwitches: number;
  fallbackDeferredOnHostHold: number;
  capacityWaits: number;
  permissionExpiries: number;
  restarts: number;
  mixedHoldStableTicks: number;
  oversizedFallbackDeclines: number;
};

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function runDeferralSimulation(seed: number, mutant: SimMutant = "none"): SimCoverage {
  const f = schedulerFixture();
  try {
    const rand = mulberry32(seed);
    let now = Date.parse("2026-11-26T00:00:00.000Z");
    const claudeToCodex: TeamModelProfile = { ...claudePrimary, id: "haiku-to-codex", limitFallback: "astra-fallback" };
    const lineup: TeamLineup = {
      coordinator: strongCoord,
      integrator: strongCoord,
      reviewer: strongCoord,
      implementers: [claudePrimary, claudeNoFallback, codexPrimary, claudeToCodex],
      fallbacks: [opencodeFallback, codexFallback],
    };
    const limitsFile = join(f.config.stateDir, "provider-limits.sealed");
    let limits = new ProviderLimits(limitsFile, f.key);
    const runFile = join(f.config.stateDir, "sim-run.sealed");
    const baseHead = "a".repeat(40);
    const nextHead = "b".repeat(40);
    let stored: Stored = {
      fingerprint: `sim-${seed}`,
      prepared: true,
      receipts: {},
      run: {
        id: f.run.id,
        projectId: "fixture",
        provider: "codex",
        title: "Sim run",
        objective: "Simulate orchestration deferrals",
        parallelism: 1 + Math.floor(rand() * 2),
        parallelismCeiling: 2,
        revision: 1,
        status: "implementing",
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        lastActivityAt: new Date(now).toISOString(),
        workspace: join(f.config.stateDir, "inaccessible-file", "nested"),
        branch: "main",
        baseCommit: baseHead,
        headCommit: nextHead,
        lineup,
        tasks: [],
        members: [],
        decisions: [],
        permissionDecisions: [],
        checks: [],
        steering: [],
        events: [],
        round: 0,
      },
    };
    writeFileSync(join(f.config.stateDir, "inaccessible-file"), "not-a-dir");
    f.config.projects[0]!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
    f.config.teams = { ...f.config.teams!, publishHeads: true } as typeof f.config.teams;
    const makePublisher = () => new TeamPublisher({
      records: new Map([[stored.run.id, stored]]),
      config: f.config,
      save: () => {},
      event: () => {},
      enqueue: async (_id, fn) => fn(),
      options: { now: () => now },
      retentionNow: () => new Date(now).toISOString(),
    });
    let publisher = makePublisher();

    const coverage: SimCoverage = {
      deferrals: 0,
      fallbackSwitches: 0,
      fallbackDeferredOnHostHold: 0,
      capacityWaits: 0,
      permissionExpiries: 0,
      restarts: 0,
      mixedHoldStableTicks: 0,
      oversizedFallbackDeclines: 0,
    };

    const originalProfiles = new Map<string, string>();
    let hostLoadReason: string | undefined;
    let sessionSlotFull = false;
    let seq = 0;

    const holdsSlot = (member: TeamMember) => member.revision === stored.run.revision
      && (member.role === "scout" || member.role === "implementer")
      && (!isDeferredWorkerMember(member) && ["queued", "running", "unavailable"].includes(member.status) || member.status === "reported" && !member.exitConfirmedAt);

    const queueWorker = (profile: TeamModelProfile, oversized = false) => {
      seq += 1;
      const taskId = `t-${seq}`;
      const task = { id: taskId, title: `Task ${seq}`, instructions: `Do ${seq}`, agentProfileId: profile.id, paths: [`f${seq}.ts`], dependsOn: [], revision: 1, status: "running" as const };
      stored.run.tasks.push(task);
      let prompt = teamPrompt(stored.run, "implementer", task, undefined, profile.provider, profile);
      if (oversized) {
        const pad = TEAM_PROMPT_LIMIT_BYTES - Buffer.byteLength(prompt, "utf8") - 120;
        prompt = `${prompt}\n\nNotes: ${"y".repeat(Math.max(0, pad))}`;
      }
      const member: TeamMember = {
        runId: stored.run.id,
        memberId: randomUUID(),
        revision: 1,
        role: "implementer",
        provider: profile.provider,
        modelProfile: structuredClone(profile),
        taskId,
        sessionId: randomUUID(),
        title: `implementer: ${taskId}`,
        status: "queued",
        cwd: stored.run.workspace,
        baseCommit: baseHead,
        prompt,
        cursor: 0,
        stopRequestId: randomUUID(),
      };
      originalProfiles.set(member.memberId, profile.id);
      stored.run.members.push(member);
      return member;
    };

    const queuePermissionReview = () => {
      seq += 1;
      const decisionId = randomUUID();
      const memberId = randomUUID();
      const sessionId = randomUUID();
      stored.run.permissionDecisions!.push({
        id: decisionId,
        revision: 1,
        policyHash: "p",
        authorityHash: "a",
        targetMemberId: "target",
        targetSessionId: "target-session",
        targetCwd: stored.run.workspace,
        promptId: seq,
        promptHash: `ph-${seq}`,
        evidenceHash: `eh-${seq}`,
        prompt: { id: seq, kind: "permission", hash: `ph-${seq}`, text: "Run?", options: [] } as never,
        option: 0,
        expiresAt: new Date(now + 5 * 60_000).toISOString(),
        answerRequestId: randomUUID(),
        purpose: "answer",
        coordinatorMemberId: memberId,
        coordinatorSessionId: sessionId,
        status: "reviewing",
      });
      stored.run.members.push({
        runId: stored.run.id,
        memberId,
        revision: 1,
        role: "permission-coordinator",
        provider: "claude",
        modelProfile: structuredClone(claudeNoFallback),
        sessionId,
        title: `permission-coordinator: ${seq}`,
        status: "queued",
        cwd: stored.run.workspace,
        baseCommit: baseHead,
        prompt: "Review permission",
        cursor: 0,
        stopRequestId: randomUUID(),
        continuation: { mode: "start", nativeSessionId: randomUUID() },
      });
    };

    const stepAll = (): { changes: number } => {
      let changes = 0;
      const launchedThisStep = new Set<string>();
      const activeLimits = limits.active(new Date(now));
      const limitedSet = limits.limited(new Date(now));
      for (const member of stored.run.members.filter(item => item.status === "queued")) {
        if (member.role === "permission-coordinator") {
          const decision = stored.run.permissionDecisions!.find(item => item.coordinatorMemberId === member.memberId);
          if (decision && now >= Date.parse(decision.expiresAt) && mutant !== "launch-expired-permission") {
            expireQueuedPermissionReview(stored.run, member, decision, activeLimits);
            coverage.permissionExpiries += 1;
            changes += 1;
            continue;
          }
        }
        const activeOtherWorkers = stored.run.members.filter(other => other !== member && holdsSlot(other) && (isDeferredWorkerMember(member) || other.status !== "queued")).length;
        const workerCapacityFull = (member.role === "scout" || member.role === "implementer")
          && activeOtherWorkers >= stored.run.parallelism
          && mutant !== "oversubscribe-parallelism";

        if (mutant === "allow-limited-launch" && member.role === "implementer" && !workerCapacityFull && limitedSet.has(member.provider ?? stored.run.provider)) {
          member.status = "running";
          member.startedAt = new Date(now).toISOString();
          launchedThisStep.add(member.memberId);
          changes += 1;
          continue;
        }
        if (mutant === "mutate-profile-before-host-hold" && (hostLoadReason || sessionSlotFull)) {
          const check = evaluateLaunchAdmission(stored.run, member, activeLimits, limitedSet, SESSION_SLOT_REASON, text => stored.run.events.push({ at: new Date(now).toISOString(), text }), { workerCapacityFull });
          if (check.proceed && check.pendingSwitch) {
            commitProviderLimitSwitch(stored.run, member, check.pendingSwitch, text => stored.run.events.push({ at: new Date(now).toISOString(), text }));
            changes += 1;
            continue;
          }
        }
        const preEvents = stored.run.events.length;
        const result = evaluateLaunchAdmission(
          stored.run,
          member,
          activeLimits,
          limitedSet,
          SESSION_SLOT_REASON,
          text => stored.run.events.push({ at: new Date(now).toISOString(), text }),
          { workerCapacityFull, hostLoadReason, sessionSlotFull },
        );
        if (mutant === "keep-stale-pending-limit" && !result.proceed && workerCapacityFull) {
          member.pendingLimit = true;
        }
        if (mutant === "oscillate-mixed-hold-reason" && !result.proceed) {
          const brokenReason = member.pendingLimit ? providerLimitHoldReason(stored.run, activeLimits) : sessionSlotFull ? SESSION_SLOT_REASON : hostLoadReason;
          if (brokenReason && stored.run.reason !== brokenReason) {
            stored.run.reason = brokenReason;
            changes += 1;
          }
        }
        if (result.changed) changes += 1;
        if (!result.proceed) {
          if (member.pendingLimit) {
            coverage.deferrals += 1;
            if (member.modelProfile?.id === "haiku-to-codex" && !limitedSet.has("codex")) coverage.oversizedFallbackDeclines += 1;
          } else if (member.pendingCapacity) {
            coverage.capacityWaits += 1;
          } else if ((hostLoadReason || sessionSlotFull) && limitedSet.has(member.provider ?? stored.run.provider)) {
            coverage.fallbackDeferredOnHostHold += 1;
          }
          continue;
        }
        if (result.pendingSwitch) {
          commitProviderLimitSwitch(stored.run, member, result.pendingSwitch, text => stored.run.events.push({ at: new Date(now).toISOString(), text }));
          if (stored.run.events.length > preEvents) coverage.fallbackSwitches += 1;
        }
        member.status = "running";
        member.startedAt = new Date(now).toISOString();
        launchedThisStep.add(member.memberId);
        changes += 1;
      }

      const liveLimited = limits.limited(new Date(now));
      const runningWorkers = stored.run.members.filter(item => item.role === "implementer" && item.status === "running");
      assert.ok(runningWorkers.length <= stored.run.parallelism, `invariant parallelismNeverExceeded violated (${runningWorkers.length} > ${stored.run.parallelism})`);
      for (const member of stored.run.members) {
        if (launchedThisStep.has(member.memberId)) {
          assert.equal(liveLimited.has(member.provider ?? stored.run.provider), false, "invariant limitedMemberNeverLaunched violated");
          if (member.role === "permission-coordinator") {
            const decision = stored.run.permissionDecisions!.find(item => item.coordinatorMemberId === member.memberId);
            assert.ok(!decision || now < Date.parse(decision.expiresAt), "invariant expiredPermissionNeverLaunched violated");
          }
        }
        if (member.status === "queued") {
          if (member.pendingCapacity) {
            assert.notEqual(member.pendingLimit, true, "invariant pendingLimitAccurate violated");
          }
          const orig = originalProfiles.get(member.memberId);
          if (orig) {
            assert.equal(member.modelProfile?.id, orig, "invariant originalProfilePreservedUntilAdmitted violated");
          }
        }
      }
      assert.equal(publisher.isPublicationPending(stored), true, "invariant durablePublicationPendingAcrossRestart violated");
      return { changes };
    };

    const providers: Provider[] = ["claude", "codex", "opencode"];
    for (let step = 0; step < 50; step += 1) {
      now += 60_000;
      if (step === 2) {
        limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 10 * 60_000).toISOString(), sessionId: `lim-${step}`, confidence: "corroborated" });
        const limitedWorker = queueWorker(claudeNoFallback);
        limitedWorker.pendingLimit = true;
        queueWorker(codexPrimary);
        sessionSlotFull = true;
        stepAll();
        const idle = stepAll();
        assert.equal(idle.changes, 0, "invariant mixedHoldReasonStable violated");
        coverage.mixedHoldStableTicks += 1;
        sessionSlotFull = false;
      } else if (step === 6) {
        for (const active of stored.run.members.filter(item => item.role === "implementer" && item.status === "running")) active.status = "stopped";
        limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 10 * 60_000).toISOString(), sessionId: `lim-${step}`, confidence: "corroborated" });
        limits.clear("opencode", new Date(now).toISOString());
        queueWorker(claudePrimary);
        hostLoadReason = `${HOST_LOAD_REASON_PREFIX}high load.`;
        stepAll();
        hostLoadReason = undefined;
      } else if (step === 10) {
        hostLoadReason = undefined; sessionSlotFull = false;
        limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 8 * 60_000).toISOString(), sessionId: `lim-${step}`, confidence: "corroborated" });
        limits.clear("codex", new Date(now).toISOString());
        const oversizedWorker = queueWorker(claudeToCodex, true);
        oversizedWorker.pendingLimit = true;
        stepAll();
      } else if (step === 14) {
        hostLoadReason = undefined; sessionSlotFull = false;
        queuePermissionReview();
        limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 15 * 60_000).toISOString(), sessionId: `lim-${step}`, confidence: "corroborated" });
        stepAll();
        now += 6 * 60_000;
        stepAll();
      } else if (step === 18) {
        hostLoadReason = undefined; sessionSlotFull = false;
        const running = stored.run.members.filter(item => item.role === "implementer" && item.status === "running");
        while (running.length < stored.run.parallelism) {
          const active = queueWorker(codexPrimary);
          active.status = "running";
          running.push(active);
        }
        const waited = queueWorker(claudeNoFallback);
        waited.pendingLimit = true;
        limits.clear("claude", new Date(now).toISOString());
        stepAll();
      } else {
        now += 60_000 * (1 + Math.floor(rand() * 3));
        const action = rand();
        if (action < 0.25) {
          const provider = providers[Math.floor(rand() * providers.length)]!;
          if (rand() < 0.6) limits.observe({ provider, detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + (3 + Math.floor(rand() * 10)) * 60_000).toISOString(), sessionId: `sim-${step}`, confidence: "corroborated" });
          else limits.clear(provider, new Date(now).toISOString());
        } else if (action < 0.45 && stored.run.members.filter(holdsSlot).length < stored.run.parallelism && stored.run.members.filter(m => m.status === "queued").length < 4) {
          const pool = [claudePrimary, claudeNoFallback, codexPrimary];
          queueWorker(pool[Math.floor(rand() * pool.length)]!);
        } else if (action < 0.6) {
          const running = stored.run.members.filter(item => item.role === "implementer" && item.status === "running");
          if (running.length) running[0]!.status = "stopped";
        } else if (action < 0.72) {
          hostLoadReason = rand() < 0.5 ? `${HOST_LOAD_REASON_PREFIX}load spike.` : undefined;
          sessionSlotFull = rand() < 0.4;
        } else if (action < 0.84) {
          writeSealed(runFile, f.key, `sim:${stored.run.id}`, stored);
          stored = unseal<Stored>(f.key, `sim:${stored.run.id}`, readFileSync(runFile, "utf8"));
          limits = new ProviderLimits(limitsFile, f.key);
          publisher = makePublisher();
          coverage.restarts += 1;
        } else if (action < 0.92 && !stored.run.members.some(m => m.role === "permission-coordinator" && m.status === "queued")) {
          queuePermissionReview();
        }
        stepAll();
      }
    }
    return coverage;
  } finally {
    f.close();
  }
}

test("seeded durable-state simulator enforces deferral invariants across seeds and catches all named mutants", () => {
  const seeds = [101, 202, 303, 404, 505, 606, 707, 808];
  const totals: SimCoverage = {
    deferrals: 0,
    fallbackSwitches: 0,
    fallbackDeferredOnHostHold: 0,
    capacityWaits: 0,
    permissionExpiries: 0,
    restarts: 0,
    mixedHoldStableTicks: 0,
    oversizedFallbackDeclines: 0,
  };
  for (const seed of seeds) {
    const run = runDeferralSimulation(seed, "none");
    for (const key of Object.keys(totals) as (keyof SimCoverage)[]) totals[key] += run[key];
  }
  for (const [key, count] of Object.entries(totals)) {
    assert.ok(count > 0, `simulator coverage counter ${key} must be > 0 (got ${count})`);
  }

  const expectedMutants: Array<[SimMutant, RegExp]> = [
    ["allow-limited-launch", /limitedMemberNeverLaunched/],
    ["oversubscribe-parallelism", /parallelismNeverExceeded/],
    ["launch-expired-permission", /expiredPermissionNeverLaunched/],
    ["keep-stale-pending-limit", /pendingLimitAccurate/],
    ["mutate-profile-before-host-hold", /originalProfilePreservedUntilAdmitted/],
    ["oscillate-mixed-hold-reason", /mixedHoldReasonStable/],
  ];
  for (const [mutant, pattern] of expectedMutants) {
    assert.throws(() => runDeferralSimulation(101, mutant), pattern, `simulator must catch mutant ${mutant}`);
  }
});
