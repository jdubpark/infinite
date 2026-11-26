import test from "node:test";
import assert from "node:assert/strict";
import {
  applySignal,
  evaluateScreenActivity,
  initialAttention,
  type Attention,
  type ScreenActivityState,
  type Signal,
} from "@infinite/attention";
import { evaluateStallRecovery } from "../packages/host/src/stall-recovery.js";
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
  screenState: ScreenActivityState;
  screenLines: string[];
  pendingReports: TeamReport[];
  controlBusy: boolean;
  seq: number;
}

interface SimState {
  run: TeamRun;
  nowMs: number;
  seq: number;
  memberCounter: number;
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
    cwd: `/tmp/ws/${memberId}`,
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
  const initialLines = ["⠋ Thinking… (0s)"];
  const initialEval = evaluateScreenActivity(undefined, initialLines, member.provider ?? "codex", true, sim.nowMs);
  sim.runtimes.set(memberId, {
    runtimeStatus: "running",
    attention,
    screenState: initialEval.nextState,
    screenLines: initialLines,
    pendingReports: [],
    controlBusy: false,
    seq: 1,
  });
  return member;
}

function createSim(r: Rand, counts: Record<string, number>, mutation?: InvariantId): SimState {
  const maxMembers = r.int(2, 5);
  const deadlineOffsetMs = r.int(15, 70) * 60_000;
  const runId = "run-sim";
  const sim: SimState = {
    nowMs: T0,
    seq: 0,
    memberCounter: 0,
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
      workspace: "/tmp/ws",
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
      tasks: [
        {
          id: "task-a",
          title: "Task A",
          instructions: "Do task A",
          paths: ["src/a.ts"],
          dependsOn: [],
          revision: 1,
          status: "running",
        },
      ],
      members: [],
      decisions: [],
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
  }

  for (const m of run.members) {
    const rt = runtimes.get(m.memberId);
    if (!rt) continue;
    if (bySource.has(m.memberId) && (rt.attention.state === "needs-you" || m.pendingLimit)) {
      throw new InvariantFailure(
        "I2_NO_STALL_WHILE_WAITING_ON_PROMPT_OR_LIMIT",
        `${where}: member ${m.memberId} replaced for stall while state=${rt.attention.state} pendingLimit=${Boolean(m.pendingLimit)}`,
      );
    }
    if (m.report && (m.stalledAt !== undefined || bySource.has(m.memberId))) {
      throw new InvariantFailure(
        "I3_LATE_REPORT_WINS_OVER_STALL",
        `${where}: reported member ${m.memberId} has stalledAt=${m.stalledAt} or replacement=${bySource.get(m.memberId)?.join(",")}`,
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

  const stalledPerAssignment = new Map<string, TeamMember[]>();
  for (const m of run.members) {
    if (!m.stalledAt && !bySource.has(m.memberId)) continue;
    const key = `${m.revision}:${m.role}:${m.taskId ?? ""}`;
    const list = stalledPerAssignment.get(key) ?? [];
    list.push(m);
    stalledPerAssignment.set(key, list);
  }
  for (const [key, list] of stalledPerAssignment) {
    const nonReportedForKey = run.members.filter(
      (m) => `${m.revision}:${m.role}:${m.taskId ?? ""}` === key && !m.report,
    );
    if (list.length >= 2 && nonReportedForKey.length > 2) {
      throw new InvariantFailure(
        "I4_SECOND_STALL_BLOCKS_INSTEAD_OF_LOOPING",
        `${where}: assignment ${key} spawned ${nonReportedForKey.length} attempts after second stall`,
      );
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
  const prevSubstantiveMs = rt.screenState.lastSubstantiveAtMs ?? prevActivityMs;
  const frame = r.pick(BRAILLE);
  const secs = Math.floor((sim.nowMs - T0) / 1000);
  const lines = [`${frame} Thinking… (${secs}s · ↓ ${100 + secs} tokens)`];
  const res = evaluateScreenActivity(rt.screenState, lines, member.provider ?? "codex", true, sim.nowMs);
  rt.screenState = res.nextState;
  rt.screenLines = lines;
  if (res.spinnerOnly && res.spinnerOnlySince) {
    rt.attention = { ...rt.attention, spinnerOnlySince: res.spinnerOnlySince };
  }
  if (sim.mutation === "I6_SPINNER_ONLY_NEVER_RESETS_QUIET_CLOCK" && res.spinnerOnly) {
    rt.attention = { ...rt.attention, lastActivityAt: iso(sim.nowMs) };
  }
  syncMemberFromAttention(member, rt);
  bump(sim.counts, "event:spinner-only");

  const nextActivityMs = Date.parse(rt.attention.lastActivityAt);
  const nextSubstantiveMs = rt.screenState.lastSubstantiveAtMs ?? prevSubstantiveMs;
  if (res.spinnerOnly && (nextActivityMs > prevActivityMs || nextSubstantiveMs > prevSubstantiveMs || !rt.attention.spinnerOnlySince)) {
    throw new InvariantFailure(
      "I6_SPINNER_ONLY_NEVER_RESETS_QUIET_CLOCK",
      `spinner-only redraw advanced activity clock from ${prevActivityMs} to ${nextActivityMs}`,
    );
  }
}

function runSubstantiveOutput(sim: SimState, r: Rand, member: TeamMember, rt: MemberRuntime): void {
  const lines = [...rt.screenLines, `Step ${rt.seq + 1}: edited file_${r.int(1, 99)}.ts`];
  const res = evaluateScreenActivity(rt.screenState, lines, member.provider ?? "codex", true, sim.nowMs);
  rt.screenState = res.nextState;
  rt.screenLines = lines;
  if (res.substantiveChange) {
    const { spinnerOnlySince: _s, ...rest } = rt.attention;
    rt.attention = {
      ...rest,
      ...(rt.attention.hooks === "none" ? { lastActivityAt: iso(sim.nowMs) } : {}),
    } as Attention;
  }
  syncMemberFromAttention(member, rt);
  bump(sim.counts, "event:substantive-output");
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
      (rt.attention.state === "needs-you" || Boolean(member.pendingLimit)) &&
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
    if (!earlierStop && (rt.attention.state === "needs-you" || member.pendingLimit)) {
      throw new InvariantFailure(
        "I2_NO_STALL_WHILE_WAITING_ON_PROMPT_OR_LIMIT",
        `${where}: member ${member.memberId} entered stall stop while state=${rt.attention.state} pendingLimit=${Boolean(member.pendingLimit)}`,
      );
    }
    member.stalledAt ??= iso(sim.nowMs);
    member.stoppedReason ??= "No activity for 5 minutes";

    if (r.chance(0.18)) {
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

    if (r.chance(0.25)) {
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
      run.members.push(next);
      bump(sim.counts, "action:stall-replaced");

      if (r.chance(0.45)) {
        member.status = "unavailable";
        bump(sim.counts, "fault:crash-after-spawn-before-source-stopped");
        assertInvariants(sim, where);
        return;
      }

      const task = run.tasks.find((t) => t.id === member.taskId && t.memberId === member.memberId);
      if (task) task.memberId = next.memberId;
      assertInvariants(sim, where);
      return;
    }
  }
}

function simulate(seed: number, counts: Record<string, number>, mutation?: InvariantId): void {
  const r = rand(seed);
  const sim = createSim(r, counts, mutation);
  const reproduce = `reproduce with STALL_SIM_SEED=${seed}`;

  for (let step = 1; step <= 60; step += 1) {
    if (sim.run.status === "blocked" || sim.run.tasks.every((t) => t.status === "integrated")) break;
    sim.nowMs += r.int(45, 140) * 1000;
    const active = sim.run.members.filter((m) => (m.status === "running" || m.status === "unavailable") && !m.stalledAt);
    const target = active.at(-1);
    if (target) {
      const rt = sim.runtimes.get(target.memberId)!;
      if (rt.attention.state === "needs-you" && rt.attention.prompt && r.chance(0.45)) {
        sendSignal(sim, target, rt, { kind: "prompt-closed", promptId: rt.attention.prompt.id, reason: "answered-here" });
      } else if (rt.attention.limit && r.chance(0.45)) {
        sendSignal(sim, target, rt, { kind: "notice", type: "quota_auto_resume_fired" });
      } else {
        const draw = r.next();
        if (draw < 0.48) {
          runSpinnerTick(sim, r, target, rt);
        } else if (draw < 0.56) {
          runSubstantiveOutput(sim, r, target, rt);
        } else if (draw < 0.64 && rt.attention.state !== "needs-you") {
          sendSignal(sim, target, rt, {
            kind: "prompt-open",
            prompt: { id: 0, kind: "permission", title: "Run check?", options: [], acceptsText: false, source: "hook" },
          });
        } else if (draw < 0.72 && !rt.attention.limit) {
          sendSignal(sim, target, rt, {
            kind: "provider-limit",
            limit: "usage",
            confidence: "single-source",
            message: "Limit pending",
          });
        } else if (draw < 0.78) {
          rt.controlBusy = !rt.controlBusy;
        } else if (draw < 0.80) {
          rt.pendingReports.push({ kind: "result", summary: "Completed task" });
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
  "guard:duplicate-suppressed": 4,
  "fault:crash-mid-stop": 3,
  "fault:control-busy-refusal": 3,
  "fault:late-report-in-tail": 4,
  "fault:crash-after-spawn-before-source-stopped": 4,
  "invariant:late-report-won": 4,
  "action:stall-replaced": 12,
  "block:member-stalled": 3,
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
