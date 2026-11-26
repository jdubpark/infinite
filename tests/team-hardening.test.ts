import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TeamStopRefused, type Manager } from "../packages/host/src/manager.js";
import type { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { GoalService } from "../packages/host/src/goals.js";
import { unresolvedOperation } from "../packages/host/src/goal-standing.js";
import { intentCheckerPrompt } from "../packages/host/src/intent-prompt.js";
import { runRecord } from "../packages/host/src/objective-record.js";
import { ProjectSourceError } from "../packages/host/src/project-source.js";
import { ENRICH_LIMIT, ENRICH_WARN_INTERVAL_MS, MAX_EVENT_KIND_WARNINGS, PROVIDER_LIMIT_HOLD_PREFIX, IdleWatermark, TrackedTaskSet } from "../packages/host/src/team-diagnostics.js";
import { permissionEvidenceHash } from "../packages/host/src/team-permissions.js";
import { providerInputReason, TeamService, type Stored, type TeamServiceOptions } from "../packages/host/src/teams.js";
import { PROFILE_REQUIRED_REFUSAL, reportRefusal, type TeamLineup, type TeamMember, type TeamModelProfile, type TeamRun } from "../packages/host/src/team-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

const mockEvents: EventOutbox = {
  flush: () => ({ stored: true, refused: 0 }),
  advance: () => ({ pending: false, blocked: [] }),
} as unknown as EventOutbox;

const fallbackLineup: TeamLineup = {
  coordinator: { id: "astra-coordinator", label: "Astra coordinator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
  integrator: { id: "astra-integrator", label: "Astra integrator", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" },
  reviewer: { id: "astra-reviewer", label: "Astra reviewer", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
  implementers: [
    { id: "haiku", label: "Haiku implementer", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light", limitFallback: "deepseek-light" },
    { id: "astra-light", label: "Astra light implementer", provider: "codex", model: "gpt-6-astra", effort: "low", tier: "light" },
  ],
  fallbacks: [
    { id: "deepseek-light", label: "DeepSeek Flash", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light" },
  ],
};

function captureWarnings(t: test.TestContext): string[] {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(arg => String(arg)).join(" "));
  });
  return warnings;
}

function openService(f: ReturnType<typeof schedulerFixture>, options: TeamServiceOptions = {}): TeamService {
  const service = new TeamService(
    f.config,
    f.key,
    f.manager as unknown as Manager,
    (_project, start) => start(),
    undefined,
    undefined,
    options,
  );
  return service;
}

type TeamServiceInternal = {
  records: Map<string, Stored>;
  limits: { observe(limit: { provider: "claude" | "codex" | "opencode" | "demo"; detectedAt: string; resetsAt?: string; sessionId: string; runId?: string; confidence: "corroborated" }): void };
  removalTasks: Set<Promise<void>>;
  publicationTasks: Set<Promise<void>>;
  memberWorkSaveTasks: Set<Promise<void>>;
  enqueue<T>(runId: string, task: () => T | Promise<T>): Promise<T>;
  emit(stored: Stored, kind: string, keyParts: readonly (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void;
  emitWith(stored: Stored, kind: string, keyParts: readonly (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number }, build: () => Record<string, unknown>): void;
  enrich(stored: Stored, read: (signal: AbortSignal) => Promise<(() => void) | undefined>): void;
  invalidatePermissionDecisions(stored: Stored, reason: string, fenceAgent?: boolean): Promise<boolean>;
  stopObsoletePermissionCoordinators(stored: Stored): Promise<void>;
  newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, prompt?: string, pinnedProfile?: TeamModelProfile): TeamMember;
  step(stored: Stored): Promise<void>;
  consume(stored: Stored, member: TeamMember): void;
  createRun: (...args: unknown[]) => Promise<unknown>;
};

test("enrich skip warnings rate-limit per instance with counts instead of permanent global suppression", async t => {
  const warnings = captureWarnings(t);
  const f = schedulerFixture();
  t.after(() => f.close());
  f.writeTeam();
  let now = Date.parse("2026-11-26T00:00:00.000Z");
  const teams = openService(f, { events: mockEvents, now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const releases: Array<() => void> = [];

  for (let i = 0; i < ENRICH_LIMIT; i += 1) {
    internal.enrich(stored, () => new Promise(resolve => { releases.push(() => resolve(undefined)); }));
  }
  assert.equal(warnings.length, 0);

  internal.enrich(stored, async () => undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /1 skipped total/);
  assert.deepEqual(teams.diagnostics().enrichSkips, { total: 1, suppressed: 0, emitted: 1, lastWarnAt: now });

  now += 10_000;
  internal.enrich(stored, async () => undefined);
  internal.enrich(stored, async () => undefined);
  internal.enrich(stored, async () => undefined);
  assert.equal(warnings.length, 1, "additional skips inside the cooldown are suppressed");
  assert.deepEqual(teams.diagnostics().enrichSkips, { total: 4, suppressed: 3, emitted: 1, lastWarnAt: now - 10_000 });

  now += ENRICH_WARN_INTERVAL_MS;
  internal.enrich(stored, async () => undefined);
  assert.equal(warnings.length, 2, "skips after the cooldown emit again with accumulated count");
  assert.match(warnings[1]!, /4 skipped since last warning, 5 total/);
  assert.deepEqual(teams.diagnostics().enrichSkips, { total: 5, suppressed: 0, emitted: 2, lastWarnAt: now });

  const second = openService(f, { events: mockEvents, now: () => now });
  t.after(() => second.close());
  const secondInternal = second as unknown as TeamServiceInternal;
  const secondStored = secondInternal.records.get(f.run.id)!;
  const secondReleases: Array<() => void> = [];
  for (let i = 0; i < ENRICH_LIMIT; i += 1) {
    secondInternal.enrich(secondStored, () => new Promise(resolve => { secondReleases.push(() => resolve(undefined)); }));
  }
  secondInternal.enrich(secondStored, async () => undefined);
  assert.equal(warnings.length, 3, "a fresh TeamService instance is not silenced by an earlier instance");
  assert.equal(second.diagnostics().enrichSkips.emitted, 1);

  for (const release of [...releases, ...secondReleases]) release();
});

test("dropped and unbuilt event-kind warnings stay strictly bounded at MAX_EVENT_KIND_WARNINGS", async t => {
  const warnings = captureWarnings(t);
  const f = schedulerFixture();
  t.after(() => f.close());
  f.writeTeam();
  let now = Date.parse("2026-11-26T00:00:00.000Z");
  const teams = openService(f, { events: mockEvents, now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const oversized = { blob: "x".repeat(20_000) };
  const totalKinds = MAX_EVENT_KIND_WARNINGS + 12;

  for (let i = 0; i < totalKinds; i += 1) {
    internal.emit(stored, `dropped.kind-${i}`, [i], {}, oversized);
    internal.emit(stored, `dropped.kind-${i}`, [i + 1000], {}, oversized);
  }
  assert.deepEqual(teams.diagnostics().droppedEventKinds, {
    tracked: MAX_EVENT_KIND_WARNINGS,
    max: MAX_EVENT_KIND_WARNINGS,
    overflow: 24,
    total: totalKinds * 2,
  });
  const droppedWarnings = warnings.filter(line => line.includes("was dropped:") || line.includes("Dropped run event warning cap"));
  assert.equal(droppedWarnings.length, MAX_EVENT_KIND_WARNINGS + 1, "64 distinct warnings plus 1 rate-limited overflow notice");

  for (let i = 0; i < totalKinds; i += 1) {
    internal.emitWith(stored, `unbuilt.kind-${i}`, [i], {}, () => { throw new Error("boom"); });
  }
  assert.deepEqual(teams.diagnostics().unbuiltEventKinds, {
    tracked: MAX_EVENT_KIND_WARNINGS,
    max: MAX_EVENT_KIND_WARNINGS,
    overflow: 12,
    total: totalKinds,
  });
  const unbuiltWarnings = warnings.filter(line => line.includes("could not be built") || line.includes("Unbuilt run event warning cap"));
  assert.equal(unbuiltWarnings.length, MAX_EVENT_KIND_WARNINGS + 1);

  now += ENRICH_WARN_INTERVAL_MS;
  internal.emit(stored, "dropped.kind-after-cooldown", [9999], {}, oversized);
  assert.equal(warnings.filter(line => line.includes("Dropped run event warning cap")).length, 2);
});

test("TeamService.idle() uses generation tracking to drain chains longer than 5 background tasks", async t => {
  const warnings = captureWarnings(t);
  const f = schedulerFixture();
  t.after(() => f.close());
  f.writeTeam();
  const teams = openService(f);
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const completed: number[] = [];

  const spawnChain = (step: number, total: number) => {
    const bucket = step % 3 === 0 ? internal.removalTasks : step % 3 === 1 ? internal.publicationTasks : internal.memberWorkSaveTasks;
    let task: Promise<void>;
    task = (async () => {
      await Promise.resolve();
      completed.push(step);
      await internal.enqueue(f.run.id, () => {
        if (step < total) spawnChain(step + 1, total);
      });
    })().finally(() => { bucket.delete(task); });
    bucket.add(task);
  };

  spawnChain(1, 9);
  await teams.idle();
  assert.deepEqual(completed, [1, 2, 3, 4, 5, 6, 7, 8, 9], "idle waits for all 9 chained tasks past the old 5-pass limit");
  assert.equal(teams.diagnostics().idle.unsettled, 0);
  assert.ok(teams.diagnostics().idle.generation >= 18);
  assert.equal(warnings.length, 0);
});

test("IdleWatermark emits a bounded diagnostic instead of hanging when background tasks continuously respawn", async () => {
  const watermark = new IdleWatermark();
  const tasks = new TrackedTaskSet<Promise<void>>(() => watermark.bump());
  const notices: Array<{ passes: number; generation: number; active: Record<string, number> }> = [];
  let spawned = 0;

  const respawn = () => {
    spawned += 1;
    let task: Promise<void>;
    task = Promise.resolve().then(() => {
      tasks.delete(task);
      if (spawned < 20) respawn();
    });
    tasks.add(task);
  };
  respawn();

  const result = await watermark.drain({
    reviewFeedback: () => Promise.resolve(),
    activeTicks: new Set(),
    removalTasks: tasks,
    publicationTasks: new Set(),
    memberWorkSaveTasks: new Set(),
    queuesSize: () => 0,
    settleQueues: () => Promise.resolve(),
  }, { maxPasses: 4, onUnsettled: detail => notices.push(detail) });

  assert.equal(result.settled, false);
  assert.equal(result.passes, 4);
  assert.equal(watermark.unsettled, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.passes, 4);
});

test("narrowed TeamService catches stay quiet on benign errors and emit redacted bounded warnings on unexpected failures", async t => {
  const warnings = captureWarnings(t);
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T00:00:00.000Z");
  const secretToken = "tok-redacted-sample-9999";
  const secretPath = "/srv/private/secret-file.txt";
  let sourceError: unknown = new ProjectSourceError("Refresh already in progress", "source-refreshing");
  let mergedError: unknown = new Error(`post-merge failed ${secretToken} at ${secretPath}`);
  let fenceError: unknown = Object.assign(new Error("Missing session"), { code: "ENOENT" });
  let stopError: unknown = new TeamStopRefused("Human lease active");

  const managerExt = f.manager as unknown as Record<string, unknown>;
  managerExt.invalidateTeamPermission = async () => { throw fenceError; };
  f.manager.stopTeamSession = async () => { throw stopError; };

  f.config.projects[0]!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
  f.config.projects[0]!.team = {
    checks: [{ command: process.execPath, args: ["-e", "0"] }],
    delivery: { mode: "merge", repository: "example/app", baseBranch: "main", mergeMethod: "squash" },
  };
  f.config.agents = {
    demo: { command: process.execPath, args: [] },
    codex: { command: process.execPath, args: [] },
    claude: { command: process.execPath, args: [] },
    opencode: { command: process.execPath, args: [] },
  };
  f.run.status = "ready-for-review";
  f.run.headCommit = f.run.baseCommit;
  f.run.members[0]!.status = "stopped";
  f.writeTeam();

  let sourceRefreshCalls = 0;
  const teams = openService(f, {
    events: mockEvents,
    now: () => now,
    onMerged: () => { throw mergedError; },
    source: {
      isGithub: () => true,
      mirrorPath: () => f.run.workspace,
      status: () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: f.run.baseCommit }),
      refresh: async () => { sourceRefreshCalls += 1; throw sourceError; },
    },
  });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;

  stored.run.permissionDecisions = [{
    id: randomUUID(), revision: 1, policyHash: "h", targetMemberId: f.run.members[0]!.memberId,
    targetSessionId: f.run.members[0]!.sessionId, targetCwd: f.run.workspace, promptId: 1, promptHash: "p", evidenceHash: "e",
    prompt: { id: 1, kind: "permission", hash: "p", text: "Allow?", options: ["Yes"] } as never,
    option: 0, expiresAt: new Date(now + 60_000).toISOString(), answerRequestId: randomUUID(), status: "answering",
  }];
  await internal.invalidatePermissionDecisions(stored, "test benign fence", false);
  assert.equal(warnings.length, 0, "ENOENT from invalidateTeamPermission stays quiet");

  const obsoleteCoord: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 0, role: "permission-coordinator",
    sessionId: f.run.members[0]!.sessionId, title: "permission-coordinator: old", status: "running",
    cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: "p", cursor: 0, stopRequestId: randomUUID(),
  };
  stored.run.members.push(obsoleteCoord);
  await internal.stopObsoletePermissionCoordinators(stored);
  assert.equal(warnings.length, 0, "TeamStopRefused from this.stopped stays quiet");

  internal.enrich(stored, async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings.length, 0, "ENOENT in enrich stays quiet");

  fenceError = Object.assign(new Error(`io failure ${secretToken} ${secretPath}`), { code: "EIO" });
  stored.run.permissionDecisions[0]!.status = "answering";
  await internal.invalidatePermissionDecisions(stored, "test unexpected fence", false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /permission-fence.*code:EIO/);
  assert.equal(warnings[0]!.includes(secretToken), false);
  assert.equal(warnings[0]!.includes(secretPath), false);

  stopError = new TypeError(`stop crashed ${secretToken} ${secretPath}`);
  obsoleteCoord.status = "running";
  await internal.stopObsoletePermissionCoordinators(stored);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1]!, /stop-permission-coordinator.*error:TypeError/);
  assert.equal(warnings[1]!.includes(secretToken), false);
  assert.equal(warnings[1]!.includes(secretPath), false);

  internal.enrich(stored, async () => { throw Object.assign(new Error(`denied ${secretToken} ${secretPath}`), { code: "EACCES" }); });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings.length, 3);
  assert.match(warnings[2]!, /enrich.*code:EACCES/);
  assert.equal(warnings[2]!.includes(secretToken), false);

  internal.enrich(stored, async () => { throw Object.assign(new Error(`denied again ${secretToken}`), { code: "EACCES" }); });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings.length, 3, "repeated unexpected catch inside cooldown is rate-limited");

  now += ENRICH_WARN_INTERVAL_MS;
  internal.enrich(stored, async () => { throw Object.assign(new Error("denied third"), { code: "EACCES" }); });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings.length, 4);
  assert.match(warnings[3]!, /2 occurrences since last warning, 3 total/);

  stored.run.status = "delivering";
  stored.run.lineup = fallbackLineup;
  stored.run.delivery = { mode: "merge", repository: "example/app", baseBranch: "main", mergeMethod: "squash" };
  stored.checkHead = f.run.baseCommit;
  stored.run.review = { verdict: "approved", summary: "ok", revision: 1 };
  const deliveryMember: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "delivery",
    sessionId: randomUUID(), title: "delivery: test", status: "stopped", cwd: f.run.workspace,
    baseCommit: f.run.baseCommit, prompt: "p", cursor: 0, stopRequestId: randomUUID(),
    report: { kind: "delivery", headCommit: f.run.baseCommit, pullRequestUrl: "https://github.com/example/app/pull/1", mergeCommit: f.run.baseCommit, summary: "Merged" },
  };
  stored.deliveryAttempt = { memberId: deliveryMember.memberId, revision: 1, headCommit: f.run.baseCommit };
  stored.run.members.push(deliveryMember);
  internal.consume(stored, deliveryMember);
  const mergeDeadline = Date.now() + 10_000;
  while (stored.pending && Date.now() < mergeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  await teams.idle();
  const mergedWarn = warnings.find(line => line.includes("on-merged"));
  assert.ok(mergedWarn, `unexpected onMerged error emits a bounded warning (status=${stored.run.status}, reason=${stored.run.reason})`);
  assert.match(mergedWarn!, /error:Error/);
  assert.equal(mergedWarn!.includes(secretToken), false);
  assert.equal(mergedWarn!.includes(secretPath), false);
  assert.equal(stored.run.status, "merged", "fault tolerance is preserved when onMerged throws");

  const parentGoalId = randomUUID();
  stored.run.goal = {
    id: parentGoalId, revision: 1, cycle: 1, successCriteria: "ok", nonGoals: [], allowedPaths: ["."],
    evidence: [], previousWork: [], deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), maxMembers: 10,
  };
  stored.run.status = "ready-for-review";
  const childRequest = { requestId: randomUUID(), projectId: "fixture", provider: "codex" as const, title: "Child", objective: "Continue", parallelism: 1 };
  await teams.createForGoal(childRequest, { ...stored.run.goal, cycle: 2, parentRunId: stored.run.id }, fallbackLineup);
  const child1 = internal.records.get(childRequest.requestId)!;
  const child1Deadline = Date.now() + 10_000;
  while ((child1.pending || sourceRefreshCalls < 1) && Date.now() < child1Deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(sourceRefreshCalls >= 1, "source.refresh ran for the benign check");
  assert.equal(warnings.some(line => line.includes("source-refresh")), false, "benign ProjectSourceError from source.refresh stays quiet");

  sourceError = new RangeError(`refresh exploded ${secretToken} ${secretPath}`);
  const childRequest2 = { requestId: randomUUID(), projectId: "fixture", provider: "codex" as const, title: "Child 2", objective: "Continue 2", parallelism: 1 };
  await teams.createForGoal(childRequest2, { ...stored.run.goal, cycle: 3, parentRunId: stored.run.id }, fallbackLineup);
  const child2 = internal.records.get(childRequest2.requestId)!;
  const child2Deadline = Date.now() + 10_000;
  while ((child2.pending || !warnings.some(line => line.includes("source-refresh"))) && Date.now() < child2Deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const sourceWarn = warnings.find(line => line.includes("source-refresh"));
  assert.ok(sourceWarn, "unexpected source.refresh failure emits a warning");
  assert.match(sourceWarn!, /error:RangeError/);
  assert.equal(sourceWarn!.includes(secretToken), false);
  assert.equal(sourceWarn!.includes(secretPath), false);
});

test("rate-limited member launch defers when no fallback resolves and launches cleanly once the limit clears", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T01:00:00.000Z");
  const noFallbackLineup: TeamLineup = {
    ...fallbackLineup,
    implementers: [{ id: "haiku", label: "Haiku implementer", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" }],
    fallbacks: undefined,
  };
  f.run.lineup = noFallbackLineup;
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.members = [];
  f.run.tasks = [{ id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" }];
  f.writeTeam();

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const resetsAt = new Date(now + 10 * 60_000).toISOString();
  internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt, sessionId: "other", confidence: "corroborated" });

  const member = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a");
  assert.equal(member.provider, "claude");
  assert.equal(member.pendingLimit, true);
  stored.run.members.push(member);
  stored.run.tasks[0]!.memberId = member.memberId;

  await internal.step(stored);
  await internal.step(stored);
  assert.equal(f.launches.length, 0, "no provider session launches while claude is rate-limited with no fallback");
  assert.equal(member.status, "queued");
  assert.equal(member.pendingLimit, true);
  assert.ok(stored.run.reason?.startsWith(PROVIDER_LIMIT_HOLD_PREFIX));
  assert.equal(stored.run.events.filter(event => event.text.includes("launch deferred")).length, 1, "deferral event is recorded once");

  now = Date.parse(resetsAt) + 1000;
  await internal.step(stored);
  assert.equal(f.launches.length, 1, "deferred member launches automatically once the limit window expires");
  assert.equal(f.launches[0]!.provider, "claude");
  assert.equal(member.status, "running");
  assert.equal(member.pendingLimit, undefined);
  assert.equal(stored.run.reason, undefined);
});

test("rate-limited member launch defers when retargetPrompt returns undefined and launches once the limit clears", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T02:00:00.000Z");
  f.run.lineup = fallbackLineup;
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.members = [];
  f.run.tasks = [{ id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" }];
  f.writeTeam();

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const resetsAt = new Date(now + 10 * 60_000).toISOString();
  internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt, sessionId: "other", confidence: "corroborated" });

  const member = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a", "Unrecognized prompt that cannot be retargeted.");
  assert.equal(member.provider, "claude");
  assert.equal(member.pendingLimit, true);
  stored.run.members.push(member);
  stored.run.tasks[0]!.memberId = member.memberId;

  await internal.step(stored);
  assert.equal(f.launches.length, 0, "unretargetable prompt does not launch blindly into active rate limit");
  assert.equal(member.status, "queued");
  assert.equal(member.pendingLimit, true);

  now = Date.parse(resetsAt) + 1000;
  await internal.step(stored);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]!.provider, "claude");
  assert.equal(member.status, "running");
  assert.equal(member.pendingLimit, undefined);
});

test("deferred member launch resumes onto a fallback as soon as the fallback provider's limit clears", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T03:00:00.000Z");
  f.run.lineup = fallbackLineup;
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.members = [];
  f.run.tasks = [{ id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" }];
  f.writeTeam();

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const claudeReset = new Date(now + 15 * 60_000).toISOString();
  const opencodeReset = new Date(now + 2 * 60_000).toISOString();
  internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: claudeReset, sessionId: "s-claude", confidence: "corroborated" });
  internal.limits.observe({ provider: "opencode", detectedAt: new Date(now).toISOString(), resetsAt: opencodeReset, sessionId: "s-opencode", confidence: "corroborated" });

  const member = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a");
  assert.equal(member.provider, "claude");
  assert.equal(member.pendingLimit, true);
  stored.run.members.push(member);
  stored.run.tasks[0]!.memberId = member.memberId;

  await internal.step(stored);
  assert.equal(f.launches.length, 0, "launch stays deferred while both primary and fallback providers are limited");
  assert.equal(member.status, "queued");

  now = Date.parse(opencodeReset) + 1000;
  await internal.step(stored);
  assert.equal(f.launches.length, 1, "launch resumes onto fallback once fallback clears while primary is still limited");
  assert.equal(f.launches[0]!.provider, "opencode");
  assert.equal(f.launches[0]!.profile?.id, "deepseek-light");
  assert.equal(member.provider, "opencode");
  assert.equal(member.modelProfile?.id, "deepseek-light");
  assert.equal(member.status, "running");
  assert.equal(member.pendingLimit, undefined);
  assert.equal(stored.run.reason, undefined);
  assert.ok(stored.run.events.some(event => event.text.includes("Haiku implementer launched on DeepSeek Flash")));
});

test("intent-checker provider limit deferral preserves model-family independence across fallbacks", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  const now = Date.parse("2026-11-26T04:00:00.000Z");
  const claudeCoord: TeamModelProfile = { id: "claude-coord", label: "Claude Coord", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
  const deepseekEval: TeamModelProfile = { id: "deepseek-eval", label: "DeepSeek Eval", provider: "opencode", model: "deepseek/deepseek-reasoner", variant: "high", tier: "strong" };
  const gptEval: TeamModelProfile = { id: "gpt-eval", label: "GPT Eval", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong", limitFallback: "claude-coord" };
  const nonEvalLight: TeamModelProfile = { id: "muse-light", label: "Muse Light", provider: "opencode", model: "muse/muse-spark", tier: "light" };
  const lineup: TeamLineup = {
    coordinator: claudeCoord,
    integrator: claudeCoord,
    reviewer: gptEval,
    implementers: [nonEvalLight],
    evaluators: [gptEval, deepseekEval],
  };
  const planByCoord: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "project-manager",
    provider: "claude", modelProfile: claudeCoord, sessionId: randomUUID(), title: "project-manager: plan",
    status: "reported", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: "p", cursor: 0, stopRequestId: randomUUID(),
    report: { kind: "plan", summary: "Plan", tasks: [] },
  };
  const planByDeepseek: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "project-manager",
    provider: "opencode", modelProfile: deepseekEval, sessionId: randomUUID(), title: "project-manager: alt",
    status: "reported", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: "p", cursor: 0, stopRequestId: randomUUID(),
    report: { kind: "plan", summary: "Alt plan", tasks: [] },
  };
  const checker: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "intent-checker",
    provider: "codex", modelProfile: structuredClone(gptEval), sessionId: randomUUID(), title: "intent-checker: check",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: intentCheckerPrompt("codex", gptEval), cursor: 0, stopRequestId: randomUUID(),
  };
  f.run.lineup = lineup;
  f.run.status = "planning";
  f.run.headCommit = f.run.baseCommit;
  f.run.intentCheck = "on";
  f.run.members = [planByCoord, planByDeepseek, checker];
  const record = runRecord(f.run, new Date(now).toISOString(), "run-1");
  assert.notEqual(record, "source-invalid");
  f.writeTeam({
    objectiveRecord: record,
    intentCheck: { revision: 1, planMemberId: planByCoord.memberId, status: "checking", failures: 0, checkerMemberId: checker.memberId },
  });

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  internal.limits.observe({ provider: "codex", detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 10 * 60_000).toISOString(), sessionId: "s-codex", confidence: "corroborated" });

  await internal.step(stored);
  assert.equal(f.launches.length, 0, "checker does not fall back to the coordinator's model family");
  assert.equal(stored.run.members[2]!.provider, "codex");
  assert.equal(stored.run.members[2]!.pendingLimit, true);

  stored.run.lineup!.reviewer.limitFallback = "muse-light";
  stored.run.lineup!.evaluators![0]!.limitFallback = "muse-light";
  await internal.step(stored);
  assert.equal(f.launches.length, 0, "checker does not fall back to a non-evaluator profile");

  stored.intentCheck!.planMemberId = planByDeepseek.memberId;
  stored.run.lineup!.reviewer.limitFallback = "deepseek-eval";
  stored.run.lineup!.evaluators![0]!.limitFallback = "deepseek-eval";
  await internal.step(stored);
  assert.equal(f.launches.length, 0, "checker does not fall back to the plan author's model family");

  stored.intentCheck!.planMemberId = planByCoord.memberId;
  await internal.step(stored);
  assert.equal(f.launches.length, 1, "checker switches to an independent eligible evaluator profile");
  assert.equal(f.launches[0]!.provider, "opencode");
  assert.equal(f.launches[0]!.profile?.id, "deepseek-eval");
  assert.equal(stored.run.members[2]!.modelProfile?.id, "deepseek-eval");
});

test("standing goal keeps head publication unresolved across host restart until a durable receipt is written", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: gitEnv }).trim();
  const bareRemote = join(f.config.stateDir, "origin.git");
  mkdirSync(bareRemote, { recursive: true });
  git(bareRemote, "init", "--bare", "--initial-branch=main");
  writeFileSync(join(f.run.workspace, "change.txt"), "durable head\n");
  git(f.run.workspace, "add", "change.txt");
  git(f.run.workspace, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Add change");
  const headCommit = git(f.run.workspace, "rev-parse", "HEAD");
  assert.notEqual(headCommit, f.run.baseCommit);

  const claudeEval: TeamModelProfile = { id: "claude-eval", label: "Claude Eval", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
  const standingLineup: TeamLineup = { ...fallbackLineup, evaluators: [claudeEval] };
  f.config.projects[0]!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
  f.config.projects[0]!.autonomy = "autonomous";
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] };
  f.config.agents = { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] }, opencode: { command: process.execPath, args: [] } };
  f.config.source = { remoteOverrides: { fixture: bareRemote } };
  f.config.teams = { ...f.config.teams!, stallMinutes: 60, lineup: standingLineup, publishHeads: true } as typeof f.config.teams;

  const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const goalId = randomUUID();
  const deadlineAt = new Date(Date.now() + 60 * 60_000).toISOString();
  f.run.status = "ready-for-review";
  f.run.headCommit = headCommit;
  f.run.members[0]!.status = "stopped";
  f.run.publication = undefined;
  f.run.goal = { id: goalId, revision: 1, cycle: 1, successCriteria: "Checks pass", nonGoals: [], allowedPaths: ["."], evidence: [], previousWork: [], deadlineAt, maxMembers: 10 };
  f.writeTeam();

  f.writeRecord("goal", goalId, {
    fingerprint: "standing-restart",
    receipts: {},
    goal: {
      id: goalId, projectId: "fixture", title: "Standing restart goal", objective: "Keep shipping",
      successCriteria: "Checks pass", nonGoals: [], allowedPaths: ["."], evidence: [],
      parallelism: 1, maxMinutes: 60, maxTotalMinutes: 60, maxMembers: 10, maxRuns: 5,
      deadlineAt, ceilingAt: deadlineAt,
      revision: 1, status: "running", createdAt: startedAt, updatedAt: startedAt,
      lineup: standingLineup, autonomy: "autonomous", standing: { cadenceMinutes: 30, pauseAfterFailures: 3 },
      activeTeamId: f.run.id,
      cycles: [{ cycle: 1, teamId: f.run.id, status: "ready-for-review", startedAt, headCommit }],
      memberCount: 1, steering: [], events: [], outcomes: [],
    },
  });

  const teams = openService(f);
  t.after(() => teams.close());
  const goals = new GoalService(f.config, f.key, teams);
  t.after(() => goals.close());
  const goalInternal = goals as unknown as { records: Map<string, unknown>; step(stored: unknown): Promise<void> };
  const goalStored = goalInternal.records.get(goalId)!;

  const afterRestart = teams.get(f.run.id);
  assert.equal(afterRestart.publishing, true, "reopened TeamService marks unreceipted head as publishing without in-memory state");
  assert.match(unresolvedOperation(afterRestart, false) ?? "", /head publication/i);

  await goalInternal.step(goalStored);
  await goalInternal.step(goalStored);
  assert.equal(goals.get(goalId).activeTeamId, f.run.id, "goal scheduler holds activeTeamId across restart before receipt exists");
  assert.equal(goals.get(goalId).cycles[0]!.class, undefined);
  assert.equal(goals.get(goalId).cycles.length, 1);

  const teamInternal = teams as unknown as TeamServiceInternal;
  const teamStored = teamInternal.records.get(f.run.id)!;
  await teamInternal.step(teamStored);
  await teams.idle();
  assert.equal(teams.get(f.run.id).publication?.commit, headCommit);
  assert.equal(teams.get(f.run.id).publishing, undefined);

  await goalInternal.step(goalStored);
  assert.equal(goals.get(goalId).cycles[0]!.class, "reviewed", "goal settles once durable publication receipt is written");

  f.config.source = { remoteOverrides: { fixture: join(f.config.stateDir, "missing-remote.git") } };
  teamStored.run.publication = undefined;
  assert.equal(teams.get(f.run.id).publishing, true);
  await teamInternal.step(teamStored);
  await teams.idle();
  const failedView = teams.get(f.run.id);
  assert.equal(failedView.publishing, undefined);
  assert.equal(failedView.publication?.failure?.commit, headCommit);
  assert.match(unresolvedOperation(failedView, false) ?? "", /could not confirm/i);
});

test("queued permission coordinator expires cleanly during a provider limit hold without launching a wasted session", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T05:00:00.000Z");
  const claudeCoord: TeamModelProfile = { id: "claude-coord", label: "Claude Coord", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
  const target = f.run.members[0]!;
  target.role = "implementer";
  target.status = "running";
  target.startedAt = new Date(now).toISOString();
  const prompt = { id: 7, kind: "permission" as const, hash: "prompt-hash-7", text: "Run npm test?", options: ["Yes, once", "No"] };
  f.state.attention = { ...f.state.attention, state: "needs-you", prompt: prompt as never };

  const decisionId = randomUUID();
  const coordMemberId = randomUUID();
  const coordSessionId = randomUUID();
  const expiresAt = new Date(now + 5 * 60_000).toISOString();
  const coord: TeamMember = {
    runId: f.run.id, memberId: coordMemberId, revision: 1, role: "permission-coordinator",
    provider: "claude", modelProfile: claudeCoord, sessionId: coordSessionId, title: "permission-coordinator: review",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: "Review permission", cursor: 0,
    stopRequestId: randomUUID(), nativeSessionId: randomUUID(),
    continuation: { mode: "start", nativeSessionId: randomUUID() },
    turns: [{ sessionId: coordSessionId, decisionId, startedAt: new Date(now).toISOString(), mode: "start" }],
  };
  f.config.teams!.stallMinutes = 60;
  f.run.lineup = { coordinator: claudeCoord, integrator: claudeCoord, reviewer: fallbackLineup.reviewer, implementers: [fallbackLineup.implementers[1]!] };
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.permissions = { scope: "Routine tests", maxDecisions: 5 };
  f.run.tasks = [{ id: "t1", title: "Task 1", instructions: "Do T1", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running", memberId: target.memberId }];
  f.run.members = [target, coord];
  f.run.permissionDecisions = [{
    id: decisionId, revision: 1, policyHash: "p", authorityHash: "auth-hash", targetMemberId: target.memberId, targetSessionId: target.sessionId,
    targetCwd: f.run.workspace, promptId: prompt.id, promptHash: prompt.hash, evidenceHash: permissionEvidenceHash(prompt as never),
    prompt: prompt as never, option: 0, expiresAt, answerRequestId: randomUUID(), purpose: "answer",
    coordinatorMemberId: coordMemberId, coordinatorSessionId: coordSessionId, status: "reviewing",
  }];
  f.writeTeam();

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const claudeReset = new Date(now + 15 * 60_000).toISOString();
  internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: claudeReset, sessionId: "s-claude", confidence: "corroborated" });

  await internal.step(stored);
  assert.equal(f.launches.length, 0);
  assert.equal(stored.run.members[1]!.status, "queued");
  assert.equal(stored.run.members[1]!.pendingLimit, true);
  assert.equal(stored.run.permissionDecisions![0]!.status, "reviewing");

  now = Date.parse(expiresAt) + 1000;
  await internal.step(stored);
  assert.equal(f.launches.length, 0, "expired queued permission review does not launch");
  assert.equal(stored.run.permissionDecisions![0]!.status, "escalated");
  assert.match(stored.run.permissionDecisions![0]!.reason ?? "", /five-minute/i);
  assert.equal(stored.run.members[1]!.status, "stopped");
  assert.equal(stored.run.members[1]!.pendingLimit, undefined);
  assert.equal(stored.run.reason, providerInputReason);

  now = Date.parse(claudeReset) + 1000;
  await internal.step(stored);
  assert.equal(f.launches.length, 0, "clearing the provider limit does not launch an already expired permission review");
});

test("rate-limited replay trial and duel judgement end immediately as void-limit with resetsAt", async t => {
  for (const scenario of [
    { purpose: "replay" as const, role: "implementer" as const, provider: "claude" as const, profile: fallbackLineup.implementers[0]! },
    { purpose: "duel" as const, role: "judge" as const, provider: "codex" as const, profile: fallbackLineup.reviewer },
  ]) {
    const f = schedulerFixture();
    t.after(() => f.close());
    const now = Date.parse("2026-11-26T06:00:00.000Z");
    const resetsAt = new Date(now + 20 * 60_000).toISOString();
    const { limitFallback: _drop, ...pinned } = scenario.profile;
    const evalRoot = join(dirname(f.config.stateDir), "eval");
    const trialsDir = join(evalRoot, "trials");
    const replayWork = join(trialsDir, f.run.id, "work");
    mkdirSync(replayWork, { recursive: true, mode: 0o700 });
    chmodSync(evalRoot, 0o700);
    chmodSync(trialsDir, 0o700);
    f.config.eval = { member: { root: evalRoot, prefix: { command: process.execPath, args: [] }, agents: {} } } as typeof f.config.eval;
    const member: TeamMember = {
      runId: f.run.id, memberId: randomUUID(), revision: 1, role: scenario.role,
      provider: scenario.provider, modelProfile: pinned, sessionId: randomUUID(), title: `${scenario.role}: eval`,
      status: "queued", cwd: replayWork, baseCommit: f.run.baseCommit, prompt: "Eval prompt", cursor: 0, stopRequestId: randomUUID(),
    };
    f.run.workspace = replayWork;
    f.run.provider = scenario.provider;
    f.run.status = "implementing";
    f.run.headCommit = f.run.baseCommit;
    f.run.lineup = { coordinator: pinned, integrator: pinned, reviewer: pinned, implementers: [pinned] };
    f.run.members = [member];
    f.run.replay = { jobId: "job-1", trialId: f.run.id, purpose: scenario.purpose, ...(scenario.purpose === "duel" ? { judgeMinutes: 10 } : {}) };
    f.writeTeam({ root: trialsDir });

    const teams = openService(f, { now: () => now });
    t.after(() => teams.close());
    const internal = teams as unknown as TeamServiceInternal;
    const stored = internal.records.get(f.run.id)!;
    internal.limits.observe({ provider: scenario.provider, detectedAt: new Date(now).toISOString(), resetsAt, sessionId: "s-limit", confidence: "corroborated" });

    await internal.step(stored);
    await teams.idle();
    assert.equal(f.launches.length, 0, `${scenario.purpose} does not launch into an active limit`);
    assert.equal(stored.run.replay!.ending, "void-limit");
    assert.equal(stored.run.replay!.resetsAt, resetsAt);
    const replayState = await teams.replayState(f.run.id);
    assert.equal(replayState?.phase, "ended");
    assert.equal(replayState?.ending, "void-limit");
    assert.equal(replayState?.resetsAt, resetsAt);
  }
});

test("implementer fallback updates escalation instructions to match member.hostProfiles and declines ambiguous prompts", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  const now = Date.parse("2026-11-26T07:00:00.000Z");
  const strongEsc: TeamModelProfile = { id: "deepseek-strong", label: "DeepSeek Strong", provider: "opencode", model: "deepseek/deepseek-reasoner", variant: "high", tier: "strong" };
  const lightPrimary: TeamModelProfile = { id: "haiku-esc", label: "Haiku", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light", limitFallback: "deepseek-strong" };
  const lineup: TeamLineup = {
    coordinator: fallbackLineup.coordinator,
    integrator: fallbackLineup.integrator,
    reviewer: fallbackLineup.reviewer,
    implementers: [lightPrimary],
    escalations: [strongEsc],
  };
  f.config.teams!.stallMinutes = 60;
  f.run.lineup = lineup;
  f.run.routing = {
    mode: "auto",
    algorithmVersion: 2,
    knobs: { allowContributor: true, points: ["escalation"] },
  } as TeamRun["routing"];
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.members = [];
  f.run.tasks = [{ id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku-esc", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" }];
  f.writeTeam();

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;

  const member = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a");
  const ambiguous = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a");
  assert.equal(member.hostProfiles, true);
  assert.match(member.prompt, /The host selects the stronger profile\./);
  stored.run.members.push(member);
  stored.run.tasks[0]!.memberId = member.memberId;

  internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 10 * 60_000).toISOString(), sessionId: "s-claude", confidence: "corroborated" });
  await internal.step(stored);

  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]!.provider, "opencode");
  assert.equal(member.modelProfile?.id, "deepseek-strong");
  assert.equal(member.hostProfiles, undefined);
  assert.doesNotMatch(f.launches[0]!.prompt, /The host selects the stronger profile\./);
  assert.doesNotMatch(f.launches[0]!.prompt, /request one explicit escalation/, "switching onto the only escalation profile omits self-escalation guidance");
  assert.equal(
    reportRefusal({ runId: stored.run.id, memberId: member.memberId, revision: 1, role: "implementer" }, { kind: "escalate", reason: "Need stronger" }),
    PROFILE_REQUIRED_REFUSAL,
  );

  const otherEsc: TeamModelProfile = { id: "claude-strong-esc", label: "Claude Strong", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
  stored.run.lineup!.escalations = [strongEsc, otherEsc]; stored.run.routingRevokedAt = new Date(now).toISOString(); member.status = "stopped";
  const twoEscMember = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a");
  twoEscMember.provider = "claude"; twoEscMember.modelProfile = structuredClone(lightPrimary); stored.run.members.push(twoEscMember);
  await internal.step(stored);
  assert.equal(f.launches.length, 2);
  assert.match(f.launches[1]!.prompt, /"claude-strong-esc"/, "other approved escalation profile remains advertised");
  assert.doesNotMatch(f.launches[1]!.prompt, /to this approved pool: \[[^\]]*"deepseek-strong"/, "fallback excludes its own profile from escalation pool");
  twoEscMember.status = "stopped"; stored.run.lineup!.escalations = [strongEsc]; stored.run.routingRevokedAt = undefined;

  const hostLine = `If this task exceeds your reasoning capacity or the approach is failing, you may request one explicit escalation. The host selects the stronger profile. Report {"kind":"escalate","reason":"What failed or requires deeper reasoning; identify partial edits and remaining work"}. The host checks your partial edits, stops you, and continues in the same working copy. If this task already records an escalation, ask a material user question or report blocked; do not switch models yourself.`;
  ambiguous.prompt = `${ambiguous.prompt}\n\n${hostLine}`;
  stored.run.members.push(ambiguous);
  await internal.step(stored);
  assert.equal(f.launches.length, 2, "ambiguous escalation prompt declines the fallback switch and defers instead");
  assert.equal(ambiguous.status, "queued");
  assert.equal(ambiguous.pendingLimit, true);
});

test("concurrent provider-limit holds produce a deterministic reason with zero rewrites across idle ticks", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T01:00:00.000Z");
  const claudeLight: TeamModelProfile = { id: "haiku", label: "Haiku", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
  const opencodeLight: TeamModelProfile = { id: "deepseek-light", label: "DeepSeek Flash", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light" };
  f.run.parallelism = 2;
  f.run.lineup = { ...fallbackLineup, implementers: [claudeLight, opencodeLight], fallbacks: undefined };
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.members = [];
  f.run.tasks = [
    { id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" },
    { id: "b", title: "Task B", instructions: "Implement B", agentProfileId: "deepseek-light", paths: ["b.txt"], dependsOn: [], revision: 1, status: "running" },
  ];
  f.writeTeam();

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const claudeReset = "2026-11-26T01:10:00.000Z";
  const opencodeReset = "2026-11-26T01:20:00.000Z";
  internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: claudeReset, sessionId: "s-claude", confidence: "corroborated" });
  internal.limits.observe({ provider: "opencode", detectedAt: new Date(now).toISOString(), resetsAt: opencodeReset, sessionId: "s-opencode", confidence: "corroborated" });

  const memberA = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "a");
  const memberB = internal.newMember(stored.run, "implementer", stored.run.workspace, stored.run.baseCommit, "b");
  stored.run.members.push(memberA, memberB);
  stored.run.tasks[0]!.memberId = memberA.memberId;
  stored.run.tasks[1]!.memberId = memberB.memberId;

  await internal.step(stored);
  const expectedReason = `${PROVIDER_LIMIT_HOLD_PREFIX}Claude Code is limited until 01:10 UTC; OpenCode is limited until 01:20 UTC.`;
  assert.equal(stored.run.reason, expectedReason);

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
  assert.equal(stored.run.lastActivityAt, beforeActivity, "idle ticks with concurrent holds do not bump lastActivityAt");
  assert.equal(stored.run.updatedAt, beforeUpdated, "idle ticks with concurrent holds do not bump updatedAt");
  assert.equal(statSync(sealedPath).mtimeMs, beforeMtime, "idle ticks with concurrent holds do not rewrite the sealed run");
  assert.equal(readFileSync(sealedPath, "utf8"), beforeRaw);
  assert.equal(f.launches.length, 0);

  now = Date.parse(claudeReset) + 1000;
  await internal.step(stored);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]!.provider, "claude");
  assert.equal(stored.run.reason, `${PROVIDER_LIMIT_HOLD_PREFIX}OpenCode is limited until 01:20 UTC.`);
});

test("provider-deferred unlaunched workers free their parallelism slot for runnable tasks and respect parallelism on recovery", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T08:00:00.000Z");
  const claudeLight: TeamModelProfile = { id: "haiku", label: "Haiku", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
  const codexLight: TeamModelProfile = { id: "astra-light", label: "Astra Light", provider: "codex", model: "gpt-6-astra", effort: "low", tier: "light" };
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] };
  f.config.teams!.stallMinutes = 60;
  f.run.parallelism = 1;
  f.run.parallelismCeiling = 1;
  f.run.lineup = { ...fallbackLineup, implementers: [claudeLight, codexLight], fallbacks: undefined };
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.members = [];
  f.run.tasks = [
    { id: "a", title: "Task A", instructions: "Implement A", agentProfileId: "haiku", paths: ["a.txt"], dependsOn: [], revision: 1, status: "pending" },
    { id: "b", title: "Task B", instructions: "Implement B", agentProfileId: "astra-light", paths: ["b.txt"], dependsOn: [], revision: 1, status: "pending" },
  ];
  f.writeTeam();

  const teams = openService(f, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as TeamServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const claudeReset = new Date(now + 10 * 60_000).toISOString();
  internal.limits.observe({ provider: "claude", detectedAt: new Date(now).toISOString(), resetsAt: claudeReset, sessionId: "s-claude", confidence: "corroborated" });

  const waitPending = async () => {
    const deadline = Date.now() + 10_000;
    while (stored.pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    await teams.idle();
  };

  await internal.step(stored);
  await waitPending();
  const memberA = stored.run.members.find(member => member.taskId === "a")!;
  assert.ok(memberA);
  assert.equal(memberA.pendingLimit, true);
  assert.equal(teams.get(f.run.id).workers.running, 0, "deferred unlaunched worker does not occupy a worker slot");

  await internal.step(stored);
  await waitPending();
  const memberB = stored.run.members.find(member => member.taskId === "b")!;
  assert.ok(memberB, "independent task on an available provider prepares while the limited task is deferred");

  await internal.step(stored);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]!.provider, "codex");
  assert.equal(memberB.status, "running");
  assert.equal(memberA.status, "queued");
  assert.equal(teams.get(f.run.id).workers.running, 1);

  now = Date.parse(claudeReset) + 1000;
  await internal.step(stored);
  await internal.step(stored);
  assert.equal(stored.run.parallelism, 1);
  assert.equal(f.launches.length, 1, "resuming a deferred worker waits when parallelism slots are full");
  assert.equal(memberA.status, "queued");
  assert.equal(memberA.pendingLimit, undefined, "provider-limit badge clears as soon as the provider limit expires even while waiting on a worker slot");
  assert.equal(memberA.pendingCapacity, true, "capacity wait is tracked separately from provider limits");
  assert.equal(teams.get(f.run.id).workers.running, 1);
  assert.equal(stored.run.reason, undefined);

  memberB.status = "stopped";
  stored.run.tasks[1]!.status = "integrated";
  await internal.step(stored);
  assert.equal(f.launches.length, 2, "deferred worker launches once the running worker frees its slot");
  assert.equal(f.launches[1]!.provider, "claude");
  assert.equal(memberA.status, "running");
  assert.equal(memberA.pendingLimit, undefined);
  assert.equal(memberA.pendingCapacity, undefined);
});
