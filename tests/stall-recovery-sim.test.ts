import test from "node:test";
import assert from "node:assert/strict";
import {
  applySignal,
  initialAttention,
  type Attention,
  type Signal,
} from "@infinite/attention";
import { evaluateStallRecovery, syncObservedMemberState } from "../packages/host/src/stall-recovery.js";
import { describeTeamWaitReasons } from "../packages/host/src/team-wait-reasons.js";
import { WorkerScreenActivity } from "../packages/host/src/worker-screen-activity.js";
import type { TeamMember, TeamReport, TeamRun } from "../packages/host/src/team-types.js";

const DEFAULT_SEEDS = 30;
const ONLY = process.env.STALL_SIM_SEED;
const COUNT = Number(process.env.STALL_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.STALL_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "STALL_SIM_SEED, STALL_SIM_SEEDS, and STALL_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const T0 = Date.parse("2026-11-26T00:00:00.000Z");
const STALL_WINDOW_MS = 5 * 60_000;
const IDLE_AFTER_MS = 60_000;
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Rand = {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
};

function rand(seed: number): Rand {
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
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
  };
}

type InvariantId =
  | "I1_NO_DUPLICATE_REPLACEMENT_ACROSS_RESTART"
  | "I2_NO_STALL_WHILE_WAITING_ON_PROMPT_OR_LIMIT"
  | "I3_LATE_REPORT_WINS_OVER_STALL"
  | "I4_SECOND_STALL_BLOCKS_INSTEAD_OF_LOOPING"
  | "I5_BUDGET_RESPECTED"
  | "I6_SPINNER_ONLY_NEVER_RESETS_QUIET_CLOCK";

class InvariantFailure extends Error {
  constructor(readonly invariant: InvariantId, message: string) {
    super(`${invariant}: ${message}`);
  }
}

interface MemberRuntime {
  runtimeStatus: "running" | "exited";
  attention: Attention;
  tracker: WorkerScreenActivity;
  screenLines: string[];
  pendingReports: TeamReport[];
  controlBusy: boolean;
  limitArrivedAfterStallStop: boolean;
  seq: number;
}

interface SimState {
  run: TeamRun;
  nowMs: number;
  seq: number;
  memberCounter: number;
  decisionCounter: number;
  runtimes: Map<string, MemberRuntime>;
  counts: Record<string, number>;
  mutation?: InvariantId;
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function spawnMember(sim: SimState, taskId: string, hooks: "active" | "none", stalledSourceMemberId?: string): TeamMember {
  sim.memberCounter += 1;
  const memberId = `m-${sim.memberCounter}`;
  const at = iso(sim.nowMs);
  const member: TeamMember = {
    runId: sim.run.id,
    memberId,
    revision: sim.run.revision,
    role: "implementer",
    provider: hooks === "none" ? "codex" : "claude",
    sessionId: `s-${sim.memberCounter}`,
    title: `implementer: ${taskId}`,
    status: "running",
    cwd: `/home/dev/projects/infinite/ws/${memberId}`,
    baseCommit: "a".repeat(40),
    prompt: "Implement task",
    taskId,
    startedAt: at,
    lastActivityAt: at,
    cursor: 0,
    stopRequestId: `stop-${sim.memberCounter}`,
    ...(stalledSourceMemberId ? { stalledSourceMemberId } : {}),
  };
  let attention = initialAttention(at, true);
  if (hooks === "active") {
    sim.seq += 1;
    attention = applySignal(attention, {
      seq: sim.seq,
      at,
      type: "signal",
      data: { kind: "hooks-ready", event: "SessionStart", source: "hook", provider: "claude" },
    });
  }
  const tracker = new WorkerScreenActivity(IDLE_AFTER_MS, sim.nowMs);
  const initialLines = ["⠋ Thinking… (0s)"];
  tracker.noteRawOutput(sim.nowMs);
  const initialOutcome = tracker.evaluate(attention, initialLines, member.provider ?? "codex", false, sim.nowMs);
  attention = initialOutcome.attention;
  sim.runtimes.set(memberId, {
    runtimeStatus: "running",
    attention,
    tracker,
    screenLines: initialLines,
    pendingReports: [],
    controlBusy: false,
    limitArrivedAfterStallStop: false,
    seq: 1,
  });
  return member;
}

function createSim(r: Rand, counts: Record<string, number>, mutation?: InvariantId): SimState {
  const maxMembers = r.int(2, 4);
  const deadlineOffsetMs = r.int(12, 65) * 60_000;
  const multiTask = r.chance(0.5);
  const runId = "run-sim";
  const sim: SimState = {
    nowMs: T0,
    seq: 0,
    memberCounter: 0,
    decisionCounter: 0,
    runtimes: new Map(),
    counts,
    mutation,
    run: {
      id: runId,
      projectId: "proj-sim",
      provider: "codex",
      title: "Sim run",
      objective: "Simulate stall recovery",
      parallelism: 1,
      revision: 1,
      status: "implementing",
      createdAt: iso(T0),
      updatedAt: iso(T0),
      workspace: "/home/dev/projects/infinite/ws",
      branch: "main",
      baseCommit: "a".repeat(40),
      goal: {
        id: "goal-1",
        revision: 1,
        cycle: 1,
        successCriteria: "Pass tests",
        nonGoals: [],
        allowedPaths: ["."],
        evidence: [],
        previousWork: [],
        deadlineAt: iso(T0 + deadlineOffsetMs),
        maxMembers,
      },
      tasks: multiTask
        ? [
            { id: "task-a", title: "Task A", instructions: "Do task A", paths: ["src/a.ts"], dependsOn: [], revision: 1, status: "running" },
            { id: "task-b", title: "Task B", instructions: "Do task B", paths: ["src/b.ts"], dependsOn: ["task-a"], revision: 1, status: "pending" },
          ]
        : [
            { id: "task-a", title: "Task A", instructions: "Do task A", paths: ["src/a.ts"], dependsOn: [], revision: 1, status: "running" },
          ],
      members: [],
      decisions: [],
      permissionDecisions: [],
      permissionRecovery: { requests: [], steps: [], outcomes: [] },
      checks: [],
      steering: [],
      events: [],
      round: 0,
    },
  };
  const first = spawnMember(sim, "task-a", r.chance(0.5) ? "none" : "active");
  sim.run.tasks[0]!.memberId = first.memberId;
  sim.run.members.push(first);
  return sim;
}

function syncMemberFromAttention(member: TeamMember, rt: MemberRuntime): void {
  member.lastActivityAt = rt.attention.lastActivityAt;
  member.spinnerOnlySince = rt.attention.spinnerOnlySince;
  member.pendingLimit = Boolean(rt.attention.limit);
}

function drainReports(sim: SimState, member: TeamMember, rt: MemberRuntime): boolean {
  if (rt.pendingReports.length === 0) return false;
  const report = rt.pendingReports.shift()!;
  member.report = report;
  member.status = "reported";
  member.reportedAt = iso(sim.nowMs);
  member.stalledAt = undefined;
  member.spinnerOnlySince = undefined;
  member.stoppedReason = undefined;
  if (report.kind === "result") {
    const task = sim.run.tasks.find((t) => t.id === member.taskId && t.memberId === member.memberId);
    if (task) task.status = "integrated";
  }
  return true;
}

function hasOpenBlockerForMember(run: TeamRun, memberId: string): boolean {
  const openDecision = run.decisions.some((d) => d.revision === run.revision && !d.answer && d.memberId === memberId);
  const openPermission = (run.permissionDecisions ?? []).some(
    (d) => d.revision === run.revision && d.targetMemberId === memberId && ["pending", "reviewing", "approved", "answering", "escalated", "uncertain"].includes(d.status),
  );
  const liveRecovery = (run.permissionRecovery?.requests ?? []).some(
    (req) => req.revision === run.revision && req.targetMemberId === memberId && ["expanding", "diagnosing", "reviewing-evidence"].includes(req.status),
  );
  return openDecision || openPermission || liveRecovery;
}

function assertInvariants(sim: SimState, where: string): void {
  const { run, runtimes } = sim;
  const bySource = new Map<string, string[]>();
  for (const m of run.members) {
    if (m.stalledSourceMemberId) {
      const list = bySource.get(m.stalledSourceMemberId) ?? [];
      list.push(m.memberId);
      bySource.set(m.stalledSourceMemberId, list);
    }
  }
  for (const [sourceId, replacements] of bySource) {
    if (replacements.length > 1) {
      throw new InvariantFailure(
        "I1_NO_DUPLICATE_REPLACEMENT_ACROSS_RESTART",
        `${where}: source member ${sourceId} produced ${replacements.length} replacements (${replacements.join(", ")})`,
      );
    }
    const replacement = run.members.find((m) => m.memberId === replacements[0])!;
    if (replacement.role === "implementer") {
      const latestForTask = run.members
        .filter((m) => m.revision === replacement.revision && m.role === "implementer" && m.taskId === replacement.taskId)
        .at(-1);
      const task = run.tasks.find((t) => t.id === replacement.taskId);
      if (latestForTask?.memberId === replacement.memberId && task && task.memberId !== replacement.memberId) {
        throw new InvariantFailure(
          "I1_NO_DUPLICATE_REPLACEMENT_ACROSS_RESTART",
          `${where}: replacement ${replacement.memberId} does not own task ${task.id} (task.memberId=${task.memberId})`,
        );
      }
    }
  }

  for (const m of run.members) {
    const rt = runtimes.get(m.memberId);
    if (!rt) continue;
    if (
      bySource.has(m.memberId) &&
      (rt.attention.state === "needs-you" ||
        (m.pendingLimit && !rt.limitArrivedAfterStallStop) ||
        hasOpenBlockerForMember(run, m.memberId))
    ) {
      throw new InvariantFailure(
        "I2_NO_STALL_WHILE_WAITING_ON_PROMPT_OR_LIMIT",
        `${where}: member ${m.memberId} replaced for stall while state=${rt.attention.state} pendingLimit=${Boolean(m.pendingLimit)}`,
      );
    }
    if (rt.limitArrivedAfterStallStop && m.status === "stopped" && !bySource.has(m.memberId) && run.status !== "blocked" && !m.report) {
      throw new InvariantFailure(
        "I2_NO_STALL_WHILE_WAITING_ON_PROMPT_OR_LIMIT",
        `${where}: member ${m.memberId} deadlocked as stopped after single-source limit during stall stop`,
      );
    }
    if (m.report && (m.stalledAt !== undefined || bySource.has(m.memberId))) {
      throw new InvariantFailure(
        "I3_LATE_REPORT_WINS_OVER_STALL",
        `${where}: reported member ${m.memberId} has stalledAt=${m.stalledAt} or replacement=${bySource.get(m.memberId)?.join(",")}`,
      );
    }
    if (sim.mutation !== "I3_LATE_REPORT_WINS_OVER_STALL" && m.status === "stopped" && rt.pendingReports.length > 0) {
      throw new InvariantFailure(
        "I3_LATE_REPORT_WINS_OVER_STALL",
        `${where}: stopped member ${m.memberId} has undrained pendingReports=${rt.pendingReports.length}`,
      );
    }
  }

  const maxMembers = run.goal?.maxMembers ?? 60;
  if (run.members.length > maxMembers) {
    throw new InvariantFailure(
      "I5_BUDGET_RESPECTED",
      `${where}: member count ${run.members.length} exceeded maxMembers ${maxMembers}`,
    );
  }
  const deadlineMs = run.goal ? Date.parse(run.goal.deadlineAt) : Infinity;
  for (const m of run.members) {
    if (m.stalledSourceMemberId && m.startedAt && Date.parse(m.startedAt) >= deadlineMs) {
      throw new InvariantFailure(
        "I5_BUDGET_RESPECTED",
        `${where}: replacement ${m.memberId} spawned at ${m.startedAt} past deadline ${run.goal?.deadlineAt}`,
      );
    }
  }

  const byAssignment = new Map<string, TeamMember[]>();
  for (const m of run.members) {
    const key = `${m.revision}:${m.role}:${m.taskId ?? ""}`;
    const list = byAssignment.get(key) ?? [];
    list.push(m);
    byAssignment.set(key, list);
  }
  for (const [key, attempts] of byAssignment) {
    let segmentStalls = 0;
    let segmentNonReported = 0;
    for (const m of attempts) {
      if (m.report) {
        segmentStalls = 0;
        segmentNonReported = 0;
        continue;
      }
      segmentNonReported += 1;
      if (m.stalledAt || bySource.has(m.memberId)) segmentStalls += 1;
      if (segmentStalls >= 2 && segmentNonReported > 2) {
        throw new InvariantFailure(
          "I4_SECOND_STALL_BLOCKS_INSTEAD_OF_LOOPING",
          `${where}: assignment ${key} spawned ${segmentNonReported} attempts after second stall`,
        );
      }
    }
  }
}

function sendSignal(sim: SimState, member: TeamMember, rt: MemberRuntime, signal: Signal, source: "hook" | "protocol" = "hook"): void {
  sim.seq += 1;
  rt.seq += 1;
  const at = iso(sim.nowMs);
  rt.attention = applySignal(rt.attention, {
    seq: sim.seq,
    at,
    type: "signal",
    data: { ...signal, source, provider: member.provider ?? "codex" },
  });
  syncMemberFromAttention(member, rt);
}

function runSpinnerTick(sim: SimState, r: Rand, member: TeamMember, rt: MemberRuntime): void {
  const prevActivityMs = Date.parse(rt.attention.lastActivityAt);
  const frame = r.pick(BRAILLE);
  const secs = Math.floor((sim.nowMs - T0) / 1000);
  const lines = [`${frame} Thinking… (${secs}s · ↓ ${100 + secs} tokens)`];
  rt.tracker.noteRawOutput(sim.nowMs);
  const outcome = rt.tracker.evaluate(rt.attention, lines, member.provider ?? "codex", false, sim.nowMs);
  rt.attention = outcome.attention;
  rt.screenLines = lines;

  if (sim.mutation === "I6_SPINNER_ONLY_NEVER_RESETS_QUIET_CLOCK" && outcome.spinnerOnly) {
    rt.attention = { ...rt.attention, lastActivityAt: iso(sim.nowMs) };
  }
  syncMemberFromAttention(member, rt);
  bump(sim.counts, "event:spinner-only");

  const nextActivityMs = Date.parse(rt.attention.lastActivityAt);
  if (
    outcome.spinnerOnly &&
    (outcome.freshOutput || nextActivityMs > prevActivityMs || (rt.attention.state === "working" && !rt.attention.spinnerOnlySince))
  ) {
    throw new InvariantFailure(
      "I6_SPINNER_ONLY_NEVER_RESETS_QUIET_CLOCK",
      `spinner-only redraw advanced activity clock from ${prevActivityMs} to ${nextActivityMs}`,
    );
  }
}

function runSubstantiveOutput(sim: SimState, r: Rand, member: TeamMember, rt: MemberRuntime): void {
  const lines = [...rt.screenLines, `Step ${rt.seq + 1}: edited file_${r.int(1, 99)}.ts`];
  rt.tracker.noteRawOutput(sim.nowMs);
  const outcome = rt.tracker.evaluate(rt.attention, lines, member.provider ?? "codex", false, sim.nowMs);
  rt.attention = outcome.attention;
  rt.screenLines = lines;
  syncMemberFromAttention(member, rt);
  bump(sim.counts, "event:substantive-output");
}

function scheduleNextPendingTask(sim: SimState, r: Rand): void {
  const run = sim.run;
  if (run.status === "blocked") return;
  const active = run.members.some((m) => m.revision === run.revision && (m.status === "running" || m.status === "unavailable"));
  if (active) return;
  const ready = run.tasks.find(
    (t) => t.status === "pending" && t.dependsOn.every((depId) => run.tasks.find((item) => item.id === depId)?.status === "integrated"),
  );
  if (!ready) return;
  const limit = run.goal?.maxMembers ?? 60;
  if (run.members.length >= limit) return;
  const next = spawnMember(sim, ready.id, r.chance(0.5) ? "none" : "active");
  ready.status = "running";
  ready.memberId = next.memberId;
  run.members.push(next);
}

function stepHostStall(sim: SimState, r: Rand, where: string): void {
  const run = sim.run;
  if (run.status === "blocked" || run.status === "ready-for-review") return;

  for (const member of [...run.members]) {
    if (member.revision !== run.revision) continue;
    if (member.status !== "running" && member.status !== "unavailable") continue;
    const rt = sim.runtimes.get(member.memberId)!;
    syncMemberFromAttention(member, rt);

    if (drainReports(sim, member, rt)) {
      bump(sim.counts, "event:report-drained");
      continue;
    }

    const quietForMs = sim.nowMs - Date.parse(member.lastActivityAt ?? member.startedAt ?? iso(sim.nowMs));
    let detect = evaluateStallRecovery({
      run,
      member,
      attentionState: rt.attention.state,
      quietForMs,
      stallWindowMs: STALL_WINDOW_MS,
      journalDrained: true,
      hasDeliveryAttempt: false,
      nowMs: sim.nowMs,
      phase: "detect",
    });

    if (sim.mutation === "I1_NO_DUPLICATE_REPLACEMENT_ACROSS_RESTART" && detect.action === "suppress-duplicate") {
      detect = { action: "initiate-stop" };
    }
    if (
      sim.mutation === "I2_NO_STALL_WHILE_WAITING_ON_PROMPT_OR_LIMIT" &&
      detect.action === "none" &&
      (rt.attention.state === "needs-you" || Boolean(member.pendingLimit) || hasOpenBlockerForMember(run, member.memberId)) &&
      quietForMs > STALL_WINDOW_MS
    ) {
      detect = { action: "initiate-stop" };
    }

    if (detect.action === "suppress-duplicate") {
      member.status = "stopped";
      bump(sim.counts, "guard:duplicate-suppressed");
      continue;
    }
    if (detect.action !== "initiate-stop") {
      if (detect.action === "none" && detect.reason === "waiting-on-prompt") bump(sim.counts, "guard:blocked-prompt");
      if (detect.action === "none" && detect.reason === "waiting-on-limit") bump(sim.counts, "guard:blocked-limit");
      continue;
    }

    const earlierStop = Boolean(member.stalledAt);
    if (!earlierStop && (rt.attention.state === "needs-you" || member.pendingLimit || hasOpenBlockerForMember(run, member.memberId))) {
      throw new InvariantFailure(
        "I2_NO_STALL_WHILE_WAITING_ON_PROMPT_OR_LIMIT",
        `${where}: member ${member.memberId} entered stall stop while state=${rt.attention.state} pendingLimit=${Boolean(member.pendingLimit)}`,
      );
    }
    member.stalledAt ??= iso(sim.nowMs);
    member.stoppedReason ??= "No activity for 5 minutes";

    if (r.chance(0.15)) {
      if (r.chance(0.35) && !rt.attention.limit) {
        sendSignal(sim, member, rt, {
          kind: "provider-limit",
          limit: "usage",
          confidence: "single-source",
          message: "Single-source limit during stop",
        });
        rt.limitArrivedAfterStallStop = true;
        bump(sim.counts, "fault:single-source-limit-during-stop");
      }
      bump(sim.counts, "fault:crash-mid-stop");
      return;
    }

    if (rt.controlBusy) {
      if (!earlierStop) {
        member.stalledAt = undefined;
        member.stoppedReason = undefined;
      }
      member.status = "unavailable";
      bump(sim.counts, "fault:control-busy-refusal");
      continue;
    }

    rt.runtimeStatus = "exited";
    member.status = "stopped";

    const alreadyReplaced = run.members.some((item) => item.stalledSourceMemberId === member.memberId);
    if (!alreadyReplaced && r.chance(0.25)) {
      rt.pendingReports.push({ kind: "result", summary: "Late report written during stop" });
      bump(sim.counts, "fault:late-report-in-tail");
    }

    if (sim.mutation !== "I3_LATE_REPORT_WINS_OVER_STALL") {
      if (drainReports(sim, member, rt)) {
        bump(sim.counts, "invariant:late-report-won");
        continue;
      }
    }

    let replace = evaluateStallRecovery({
      run,
      member,
      attentionState: rt.attention.state,
      quietForMs,
      stallWindowMs: STALL_WINDOW_MS,
      journalDrained: true,
      hasDeliveryAttempt: false,
      nowMs: sim.nowMs,
      phase: "replace",
    });

    if (sim.mutation === "I1_NO_DUPLICATE_REPLACEMENT_ACROSS_RESTART" && replace.action === "suppress-duplicate") {
      replace = { action: "replace", editing: true };
    }
    if (sim.mutation === "I4_SECOND_STALL_BLOCKS_INSTEAD_OF_LOOPING" && replace.action === "block" && replace.code === "member-stalled") {
      replace = { action: "replace", editing: true };
    }
    if (
      sim.mutation === "I5_BUDGET_RESPECTED" &&
      replace.action === "block" &&
      (replace.code === "team-attempt-limit" || replace.code === "goal-deadline")
    ) {
      replace = { action: "replace", editing: true };
    }

    if (replace.action === "block") {
      run.status = "blocked";
      run.blockCode = replace.code;
      run.reason = replace.message;
      if (replace.code === "member-stalled") bump(sim.counts, "block:member-stalled");
      else bump(sim.counts, `block:${replace.code}`);
      assertInvariants(sim, where);
      return;
    }

    if (replace.action === "replace") {
      const next = spawnMember(sim, member.taskId ?? "task-a", rt.attention.hooks, member.memberId);
      const task = run.tasks.find((t) => t.id === member.taskId && t.memberId === member.memberId);
      if (task) {
        task.memberId = next.memberId;
        task.status = "running";
      }
      run.members.push(next);
      bump(sim.counts, "action:stall-replaced");

      if (r.chance(0.42)) {
        sim.run = JSON.parse(JSON.stringify(sim.run)) as TeamRun;
        const reloadedMember = sim.run.members.find((m) => m.memberId === member.memberId);
        const reloadedTask = sim.run.tasks.find((t) => t.id === member.taskId);
        if (reloadedTask && reloadedTask.memberId !== next.memberId) {
          throw new InvariantFailure(
            "I1_NO_DUPLICATE_REPLACEMENT_ACROSS_RESTART",
            `${where}: reloaded task ${reloadedTask.id} owned by ${reloadedTask.memberId}, expected ${next.memberId}`,
          );
        }
        if (reloadedMember) reloadedMember.status = "unavailable";
        bump(sim.counts, "fault:crash-after-spawn-before-source-stopped");
        assertInvariants(sim, where);
        return;
      }

      assertInvariants(sim, where);
      return;
    }
  }
}

function simulate(seed: number, counts: Record<string, number>, mutation?: InvariantId): void {
  const r = rand(seed);
  const sim = createSim(r, counts, mutation);
  const reproduce = `reproduce with STALL_SIM_SEED=${seed}`;

  for (let step = 1; step <= 65; step += 1) {
    scheduleNextPendingTask(sim, r);
    if (sim.run.status === "blocked" || sim.run.tasks.every((t) => t.status === "integrated")) break;
    sim.nowMs += r.int(45, 140) * 1000;
    const active = sim.run.members.filter((m) => (m.status === "running" || m.status === "unavailable") && !m.stalledAt);
    const target = active.at(-1);
    if (target) {
      const rt = sim.runtimes.get(target.memberId)!;
      const openDec = sim.run.decisions.find((d) => d.revision === sim.run.revision && !d.answer && d.memberId === target.memberId);
      const openPerm = (sim.run.permissionDecisions ?? []).find(
        (d) => d.revision === sim.run.revision && d.targetMemberId === target.memberId && d.status === "pending",
      );
      if (rt.attention.state === "needs-you" && rt.attention.prompt && r.chance(0.45)) {
        sendSignal(sim, target, rt, { kind: "prompt-closed", promptId: rt.attention.prompt.id, reason: "answered-here" });
      } else if (rt.attention.limit && r.chance(0.45)) {
        rt.limitArrivedAfterStallStop = false;
        sendSignal(sim, target, rt, { kind: "notice", type: "quota_auto_resume_fired" });
      } else if (openDec && r.chance(0.5)) {
        openDec.answer = "Yes";
        openDec.answeredBy = "owner";
      } else if (openPerm && r.chance(0.5)) {
        openPerm.status = "answered";
      } else {
        const draw = r.next();
        if (draw < 0.44) {
          runSpinnerTick(sim, r, target, rt);
        } else if (draw < 0.52) {
          runSubstantiveOutput(sim, r, target, rt);
        } else if (draw < 0.60 && rt.attention.state !== "needs-you") {
          sendSignal(sim, target, rt, {
            kind: "prompt-open",
            prompt: { id: 0, kind: "permission", title: "Run check?", options: [], acceptsText: false, source: "hook" },
          });
        } else if (draw < 0.67 && !rt.attention.limit) {
          sendSignal(sim, target, rt, {
            kind: "provider-limit",
            limit: "usage",
            confidence: "single-source",
            message: "Limit pending",
          });
        } else if (draw < 0.72 && !openDec) {
          sim.decisionCounter += 1;
          sim.run.decisions.push({
            id: `dec-${sim.decisionCounter}`,
            memberId: target.memberId,
            revision: sim.run.revision,
            question: "Proceed?",
            options: ["Yes", "No"],
            createdAt: iso(sim.nowMs),
          });
        } else if (draw < 0.76 && !openPerm) {
          sim.decisionCounter += 1;
          sim.run.permissionDecisions!.push({
            id: `perm-${sim.decisionCounter}`,
            revision: sim.run.revision,
            policyHash: "p",
            targetMemberId: target.memberId,
            targetSessionId: target.sessionId,
            targetCwd: target.cwd,
            promptId: sim.decisionCounter,
            promptHash: "h",
            evidenceHash: "e",
            prompt: { id: sim.decisionCounter, kind: "permission", title: "Run?", options: [], acceptsText: false, source: "screen" },
            option: 0,
            expiresAt: iso(sim.nowMs + 60_000),
            answerRequestId: `req-${sim.decisionCounter}`,
            status: "pending",
          });
        } else if (draw < 0.81) {
          rt.controlBusy = !rt.controlBusy;
        } else if (draw < 0.84) {
          rt.pendingReports.push({ kind: "result", summary: "Completed task" });
        } else if (draw < 0.87 && target.role === "implementer") {
          const task = sim.run.tasks.find((t) => t.id === target.taskId && t.memberId === target.memberId);
          if (task && !task.escalation && sim.run.members.length < (sim.run.goal?.maxMembers ?? 60)) {
            target.report = { kind: "escalate", reason: "Needs stronger profile" };
            target.status = "stopped";
            target.reportedAt = iso(sim.nowMs);
            task.escalation = { toProfileId: "strong", reason: "Needs stronger profile", memberId: target.memberId, at: iso(sim.nowMs) };
            const escalated = spawnMember(sim, task.id, rt.attention.hooks);
            task.memberId = escalated.memberId;
            task.status = "running";
            sim.run.members.push(escalated);
            bump(sim.counts, "event:task-escalated");
          }
        }
      }
    }
    const where = `seed ${seed} step ${step}; ${reproduce}`;
    stepHostStall(sim, r, where);
    assertInvariants(sim, where);
  }
}

const FLOORS: Readonly<Record<string, number>> = {
  "event:spinner-only": 100,
  "event:substantive-output": 20,
  "guard:blocked-prompt": 10,
  "guard:blocked-limit": 10,
  "guard:duplicate-suppressed": 3,
  "fault:crash-mid-stop": 3,
  "fault:control-busy-refusal": 3,
  "fault:late-report-in-tail": 4,
  "fault:crash-after-spawn-before-source-stopped": 3,
  "invariant:late-report-won": 4,
  "action:stall-replaced": 10,
  "block:member-stalled": 3,
  "block:goal-deadline": 2,
  "block:team-attempt-limit": 2,
};

test("stall recovery state machine keeps all invariants under seeded faults", (t) => {
  const counts: Record<string, number> = {};
  for (const seed of SEEDS) simulate(seed, counts);
  t.diagnostic(`stall sim: ${SEEDS.length} seeds from ${SEEDS[0]}, counts=${JSON.stringify(counts)}`);
  if (!DEFAULT_CORPUS) return;
  for (const [key, floor] of Object.entries(FLOORS)) {
    assert.ok((counts[key] ?? 0) >= floor, `${key} occurred ${counts[key] ?? 0} times, under floor ${floor}`);
  }
});

const MUTATIONS: readonly InvariantId[] = [
  "I1_NO_DUPLICATE_REPLACEMENT_ACROSS_RESTART",
  "I2_NO_STALL_WHILE_WAITING_ON_PROMPT_OR_LIMIT",
  "I3_LATE_REPORT_WINS_OVER_STALL",
  "I4_SECOND_STALL_BLOCKS_INSTEAD_OF_LOOPING",
  "I5_BUDGET_RESPECTED",
  "I6_SPINNER_ONLY_NEVER_RESETS_QUIET_CLOCK",
];

for (const mutation of MUTATIONS) {
  test(`mutation test proves simulator catches ${mutation}`, () => {
    const counts: Record<string, number> = {};
    let caught = false;
    for (let seed = 1; seed <= 40; seed += 1) {
      try {
        simulate(seed, counts, mutation);
      } catch (error) {
        if (error instanceof InvariantFailure && error.invariant === mutation) {
          caught = true;
          break;
        }
        throw error;
      }
    }
    assert.equal(caught, true, `Simulator failed to catch injected mutation ${mutation}`);
  });
}

test("evaluateStallRecovery guards reject non-active run statuses, non-running members, open blockers, and uncorroborated limit on already-stalled member", () => {
  const makeRun = (overrides: Partial<TeamRun> = {}): TeamRun => ({
    id: "r1",
    projectId: "p1",
    provider: "codex",
    title: "Run",
    objective: "Obj",
    parallelism: 1,
    revision: 1,
    status: "implementing",
    createdAt: iso(T0),
    updatedAt: iso(T0),
    workspace: "/home/dev/projects/infinite/ws",
    branch: "main",
    baseCommit: "a".repeat(40),
    tasks: [{ id: "task-a", title: "A", instructions: "A", paths: ["a.ts"], dependsOn: [], revision: 1, status: "running", memberId: "m1" }],
    members: [],
    decisions: [],
    permissionDecisions: [],
    permissionRecovery: { requests: [], steps: [], outcomes: [] },
    checks: [],
    steering: [],
    events: [],
    round: 0,
    ...overrides,
  });
  const makeMember = (overrides: Partial<TeamMember> = {}): TeamMember => ({
    runId: "r1",
    memberId: "m1",
    revision: 1,
    role: "implementer",
    provider: "codex",
    sessionId: "s1",
    title: "implementer: task-a",
    status: "running",
    cwd: "/home/dev/projects/infinite/ws/m1",
    baseCommit: "a".repeat(40),
    prompt: "work",
    taskId: "task-a",
    startedAt: iso(T0),
    lastActivityAt: iso(T0),
    cursor: 0,
    stopRequestId: "stop-1",
    ...overrides,
  });

  const baseArgs = (run: TeamRun, member: TeamMember, phase: "detect" | "replace" = "detect") => ({
    run,
    member,
    attentionState: "working" as const,
    quietForMs: STALL_WINDOW_MS + 10_000,
    stallWindowMs: STALL_WINDOW_MS,
    journalDrained: true,
    hasDeliveryAttempt: false,
    nowMs: T0 + STALL_WINDOW_MS + 10_000,
    phase,
  });

  for (const status of ["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"] as const) {
    const m = makeMember();
    const res = evaluateStallRecovery(baseArgs(makeRun({ status, members: [m] }), m));
    assert.equal(res.action, "none");
  }

  for (const status of ["queued", "waiting"] as const) {
    const m = makeMember({ status });
    const res = evaluateStallRecovery(baseArgs(makeRun({ members: [m] }), m));
    assert.equal(res.action, "none");
  }

  const integratedTaskMember = makeMember();
  assert.equal(evaluateStallRecovery(baseArgs(makeRun({
    tasks: [{ id: "task-a", title: "A", instructions: "A", paths: ["a.ts"], dependsOn: [], revision: 1, status: "integrated", memberId: "m1" }],
    members: [integratedTaskMember],
  }), integratedTaskMember)).action, "none");

  const completedDiscoveryMember = makeMember({ role: "scout" });
  assert.equal(evaluateStallRecovery(baseArgs(makeRun({
    discovery: { revision: 1, summary: "Done", completedAt: iso(T0 + 1000), tasks: [{ id: "task-a", title: "S", instructions: "S", status: "complete", memberId: "m1" }] },
    members: [completedDiscoveryMember],
  }), completedDiscoveryMember)).action, "none");

  const withDecision = makeMember();
  assert.equal(evaluateStallRecovery(baseArgs(makeRun({
    members: [withDecision],
    decisions: [{ id: "d1", memberId: "m1", revision: 1, question: "Q?", options: ["Y"], createdAt: iso(T0) }],
  }), withDecision)).action, "none");

  const withLiveRecovery = makeMember();
  assert.equal(evaluateStallRecovery(baseArgs(makeRun({
    members: [withLiveRecovery],
    permissionRecovery: {
      requests: [{
        id: "pr1", revision: 1, targetMemberId: "m1", targetSessionId: "s1", promptId: 1, promptHash: "h", evidenceHash: "e",
        targetCwd: "/home/dev/projects/infinite/ws/m1", policyHash: "p", expiresAt: iso(T0 + 60_000), status: "expanding", rounds: 1,
      }],
      steps: [], outcomes: [],
    },
  }), withLiveRecovery)).action, "none");

  const uncertainStalled = makeMember({ stalledAt: iso(T0 + 1000), status: "stopped" });
  assert.equal(evaluateStallRecovery(baseArgs(makeRun({
    members: [uncertainStalled],
    permissionDecisions: [{
      id: "pd1", revision: 1, policyHash: "p", targetMemberId: "m1", targetSessionId: "s1", targetCwd: "/home/dev/projects/infinite/ws/m1",
      promptId: 1, promptHash: "h", evidenceHash: "e", prompt: { id: 1, kind: "permission", title: "T", options: [], acceptsText: false, source: "screen" },
      option: 0, expiresAt: iso(T0 + 60_000), answerRequestId: "ar1", status: "uncertain",
    }],
  }), uncertainStalled, "replace")).action, "none");

  const stalledWithSingleSourceLimit = makeMember({ stalledAt: iso(T0 + 1000), status: "stopped", pendingLimit: true });
  assert.equal(evaluateStallRecovery(baseArgs(makeRun({ members: [stalledWithSingleSourceLimit] }), stalledWithSingleSourceLimit, "replace")).action, "replace");

  const escalatedOld = makeMember({ memberId: "m-esc-1", sessionId: "s-esc-1", status: "stopped", report: { kind: "escalate", reason: "Needs stronger model" } });
  const escalatedNew = makeMember({ memberId: "m-esc-2", sessionId: "s-esc-2", status: "running" });
  const escalatedRun = makeRun({
    tasks: [{ id: "task-a", title: "A", instructions: "A", paths: ["a.ts"], dependsOn: [], revision: 1, status: "running", memberId: "m-esc-2" }],
    members: [escalatedOld, escalatedNew],
  });
  assert.equal(evaluateStallRecovery(baseArgs(escalatedRun, escalatedNew, "detect")).action, "initiate-stop");
  assert.equal(evaluateStallRecovery(baseArgs(escalatedRun, escalatedNew, "replace")).action, "replace");

  const pm1 = makeMember({
    memberId: "pm-1", sessionId: "s-pm-1", role: "project-manager", taskId: undefined, status: "stopped",
    report: { kind: "explore", summary: "Explore first", tasks: [{ id: "sc-1", title: "S1", instructions: "Read" }] },
  });
  const pm2 = makeMember({ memberId: "pm-2", sessionId: "s-pm-2", role: "project-manager", taskId: undefined, status: "running" });
  const postDiscoveryRun = makeRun({
    status: "planning", tasks: [], members: [pm1, pm2],
    discovery: { revision: 1, summary: "Explore first", completedAt: iso(T0 + 1000), tasks: [{ id: "sc-1", title: "S1", instructions: "Read", status: "complete" }] },
  });
  assert.equal(evaluateStallRecovery(baseArgs(postDiscoveryRun, pm2, "detect")).action, "initiate-stop");
  assert.equal(evaluateStallRecovery(baseArgs(postDiscoveryRun, pm2, "replace")).action, "replace");

  const obsoletePm = makeMember({ memberId: "pm-old", sessionId: "s-pm-old", role: "project-manager", taskId: undefined, status: "running" });
  const currentPm = makeMember({ memberId: "pm-cur", sessionId: "s-pm-cur", role: "project-manager", taskId: undefined, status: "queued" });
  assert.equal(evaluateStallRecovery(baseArgs(makeRun({ status: "planning", tasks: [], members: [obsoletePm, currentPm] }), obsoletePm, "detect")).action, "none");

  const answeredPm = makeMember({ memberId: "pm-ans-2", sessionId: "s-ans-2", role: "project-manager", taskId: undefined, status: "running" });
  const needsInputAnsweredRun = makeRun({
    status: "needs-input", tasks: [],
    decisions: [{ id: "d-ans", memberId: "pm-ans-1", revision: 1, question: "Proceed?", options: ["Yes"], createdAt: iso(T0), answer: "Yes" }],
    members: [
      makeMember({ memberId: "pm-ans-1", sessionId: "s-ans-1", role: "project-manager", taskId: undefined, status: "stopped", report: { kind: "question", question: "Proceed?", options: ["Yes"] } }),
      answeredPm,
    ],
  });
  assert.equal(evaluateStallRecovery(baseArgs(needsInputAnsweredRun, answeredPm, "detect")).action, "initiate-stop");

  const historicalEscMember = makeMember({ memberId: "m-hist", sessionId: "s-hist" });
  const historicalEscRun = makeRun({
    tasks: [{ id: "task-a", title: "A", instructions: "A", paths: ["a.ts"], dependsOn: [], revision: 1, status: "running", memberId: "m-hist" }],
    members: [historicalEscMember],
    permissionDecisions: [{
      id: "pd-hist", revision: 1, policyHash: "p", targetMemberId: "m-hist", targetSessionId: "s-hist", targetCwd: historicalEscMember.cwd,
      promptId: 9, promptHash: "h9", evidenceHash: "e9", prompt: { id: 9, kind: "permission", title: "Old prompt", options: [], acceptsText: false, source: "screen" },
      option: 0, expiresAt: iso(T0 + 60_000), answerRequestId: "ar-hist", status: "escalated",
    }],
  });
  assert.equal(evaluateStallRecovery({ ...baseArgs(historicalEscRun, historicalEscMember, "detect"), activePrompt: null }).action, "initiate-stop");
  assert.equal(evaluateStallRecovery({ ...baseArgs(historicalEscRun, historicalEscMember, "detect"), attentionState: "needs-you", activePrompt: { id: 9, hash: "h9" } }).action, "none");

  const reconnectingMember = makeMember({ memberId: "m-reconn", sessionId: "s-reconn", status: "unavailable" });
  const prompt = { id: 11, kind: "permission" as const, title: "Run command?", options: [], acceptsText: false, source: "screen" as const, hash: "h11" };
  let reconnectRun = makeRun({
    tasks: [{ id: "task-a", title: "A", instructions: "A", paths: ["a.ts"], dependsOn: [], revision: 1, status: "running", memberId: "m-reconn" }],
    members: [reconnectingMember],
    permissionDecisions: [{
      id: "pd-reconn", revision: 1, policyHash: "p", targetMemberId: "m-reconn", targetSessionId: "s-reconn", targetCwd: reconnectingMember.cwd,
      promptId: 11, promptHash: "h11", evidenceHash: "e11", prompt, option: 0, expiresAt: iso(T0 + 60_000), answerRequestId: "ar-reconn", status: "escalated",
    }],
  });
  syncObservedMemberState(reconnectRun, reconnectingMember, { status: "unavailable", attention: { state: "unavailable", lastActivityAt: iso(T0) } }, iso(T0 + 2000));
  assert.equal(reconnectRun.permissionDecisions![0]!.promptClosedAt, undefined);
  reconnectRun = JSON.parse(JSON.stringify(reconnectRun)) as TeamRun;
  const reloadedMember = reconnectRun.members[0]!;
  assert.equal(describeTeamWaitReasons(reconnectRun, [], T0 + 3000).some((r) => r.kind === "provider-prompt" && r.decisionId === "pd-reconn"), true);

  reloadedMember.status = "running";
  syncObservedMemberState(reconnectRun, reloadedMember, { status: "running", attention: { state: "needs-you", lastActivityAt: iso(T0 + 4000), prompt } }, iso(T0 + 4000));
  assert.equal(reconnectRun.permissionDecisions![0]!.promptClosedAt, undefined);
  assert.equal(describeTeamWaitReasons(reconnectRun, [], T0 + 4000).some((r) => r.kind === "provider-prompt" && r.decisionId === "pd-reconn"), true);
  assert.equal(evaluateStallRecovery({ ...baseArgs(reconnectRun, reloadedMember, "detect"), attentionState: "needs-you", activePrompt: { id: 11, hash: "h11" } }).action, "none");

  syncObservedMemberState(reconnectRun, reloadedMember, { status: "running", attention: { state: "working", lastActivityAt: iso(T0 + 5000) } }, iso(T0 + 5000));
  assert.equal(reconnectRun.permissionDecisions![0]!.promptClosedAt, iso(T0 + 5000));
  assert.equal(describeTeamWaitReasons(reconnectRun, [], T0 + 5000).some((r) => r.kind === "provider-prompt"), false);
  assert.equal(evaluateStallRecovery({ ...baseArgs(reconnectRun, reloadedMember, "detect"), activePrompt: null }).action, "initiate-stop");
});
