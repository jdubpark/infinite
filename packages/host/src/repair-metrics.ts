import { reviewEvidenceProblems } from "./team-acceptance.js";
import type { TeamBrief, TeamCheck, TeamContinuation, TeamMember, TeamRun } from "./team-types.js";
import type { Provider } from "./types.js";
import type { UsageTotals } from "./usage.js";

export type RepairLoopCause = "review" | "check" | "delivery";
export type RepairLoopOutcome = "resolved" | "blocked" | "cancelled" | "superseded" | "unresolved" | "in-progress";
export type RepairEventCoverage = "complete" | "incomplete";

export interface RepairRunEvent {
  seq?: number;
  kind: string;
  revision: number;
  at: string;
  memberId?: string;
  data: Record<string, unknown>;
}

export interface RepairRunFilter {
  projectId?: string;
  cutoffMs?: number;
}

export type RepairMetricsMember = Pick<
  TeamMember,
  "runId" | "memberId" | "revision" | "role" | "provider" | "status" | "baseCommit"
  | "startedAt" | "reportedAt" | "stalledAt" | "stoppedReason" | "continuation" | "turns" | "report"
>;

export type RepairMetricsCheck = Pick<
  TeamCheck,
  "revision" | "round" | "headCommit" | "startedAt" | "finishedAt" | "status" | "phase"
>;

export type RepairMetricsRun = Pick<
  TeamRun,
  "id" | "projectId" | "provider" | "replay" | "revision" | "status" | "createdAt" | "updatedAt" | "brief"
> & {
  round?: number;
  continuations?: readonly Pick<TeamContinuation, "revision" | "brief">[];
  members: readonly RepairMetricsMember[];
  checks: readonly RepairMetricsCheck[];
};

export interface RepairLoopSample {
  runId: string;
  projectId: string;
  revision: number;
  cause: RepairLoopCause;
  outcome: RepairLoopOutcome;
  rounds: number;
  attempts: number;
  coldReplacements: number;
  failedResumes: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  failedCommit?: string;
  passingCommit?: string;
  measured: boolean;
  unfinished?: true;
  tokens?: number;
  usd?: number;
}

export interface RepairLoopTotals {
  runsExamined: number;
  eventCoverage: RepairEventCoverage;
  incompleteRuns: number;
  loopsTotal: number;
  resolved: number;
  unresolved: number;
  inProgress: number;
  byCause: Record<RepairLoopCause, number>;
  coldReplacements: number;
  failedResumes: number;
  measuredLoops: number;
  unmeasuredLoops: number;
  unfinishedLoops: number;
  unmeasuredMembers: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  medianTokens: number | null;
  medianUsd: number | null;
}

export interface RepairLoopReport {
  windowDays: number;
  projectId?: string;
  totals: RepairLoopTotals;
  loops: RepairLoopSample[];
}

export interface RepairLoopOptions {
  projectId?: string;
  days?: number;
  now?: number;
  runEvents?: (runId: string) => readonly RepairRunEvent[];
}

interface CheckBatch {
  kind: "check";
  order: number;
  sortMs: number;
  slot: number;
  round?: number;
  headCommit?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed" | "interrupted";
  hasVerificationCheck: boolean;
}

interface MemberItem {
  kind: "member";
  order: number;
  sortMs: number;
  slot: number;
  member: RepairMetricsMember;
}

type TimelineItem = CheckBatch | MemberItem;

interface ParsedReviewEvent {
  memberId: string;
  verdict: "approved" | "changes-requested";
  headCommit?: string;
  at: string;
  seq?: number;
}

interface ParsedRepairEvent {
  round: number;
  cause: RepairLoopCause;
  headCommit?: string;
  at: string;
  seq?: number;
}

interface OpenLoop {
  cause: RepairLoopCause;
  startedAt: string;
  failedCommit?: string;
  rounds: number;
  awaitingNewRound: boolean;
  lastRoleInRound?: "integrator" | "reviewer";
  latestCheck: CheckBatch | null;
  members: RepairMetricsMember[];
  checkBatches: CheckBatch[];
  coldReplacements: number;
  sawUnrecordedApproval?: true;
}

interface ExtractedLoop {
  revision: number;
  loop: OpenLoop;
  outcome: RepairLoopOutcome;
  finishedAt?: string;
  passingCommit?: string;
}

const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_SAMPLE_LOOPS = 50;
const LOOP_ROLES = new Set<TeamMember["role"]>(["integrator", "reviewer", "delivery"]);

function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function roundTo(value: number, factor: number): number {
  return Math.round(value * factor) / factor;
}

function usageTokensSum(usage: UsageTotals): number {
  const { input, output, reasoning, cacheRead, cacheWrite } = usage.tokens;
  return input + output + reasoning + cacheRead + cacheWrite;
}

function hasFailedResume(member: RepairMetricsMember): boolean {
  if (member.stoppedReason && /resume/i.test(member.stoppedReason)) return true;
  const turns = member.turns;
  if (!turns?.length) return false;
  let sawResume = false;
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]!;
    if (turn.mode === "resume") sawResume = true;
    else if (turn.mode === "start" && (index > 0 || sawResume)) return true;
  }
  return sawResume && member.continuation?.mode === "start";
}

function memberAttempts(member: RepairMetricsMember): number {
  const turns = member.turns;
  if (!turns?.length) return 1;
  const launches = new Set(turns.map(turn => `${turn.sessionId}\u0000${turn.mode}\u0000${turn.startedAt}`));
  return Math.max(1, launches.size);
}

export function runMayOverlapWindow(
  run: Pick<RepairMetricsRun, "replay" | "projectId" | "createdAt" | "updatedAt" | "members" | "checks">,
  filter?: RepairRunFilter,
): boolean {
  if (run.replay) return false;
  if (filter?.projectId !== undefined && run.projectId !== filter.projectId) return false;
  if (filter?.cutoffMs === undefined) return true;
  const runActivityMs = parseTime(run.updatedAt) ?? parseTime(run.createdAt);
  if (runActivityMs !== undefined && runActivityMs >= filter.cutoffMs) return true;
  for (const member of run.members) {
    if (!LOOP_ROLES.has(member.role)) continue;
    const ms = parseTime(member.reportedAt)
      ?? parseTime(member.startedAt)
      ?? parseTime(member.turns?.[0]?.startedAt)
      ?? parseTime(member.stalledAt);
    if (ms !== undefined && ms >= filter.cutoffMs) return true;
  }
  for (const check of run.checks) {
    const ms = parseTime(check.finishedAt) ?? parseTime(check.startedAt);
    if (ms !== undefined && ms >= filter.cutoffMs) return true;
  }
  return false;
}

export function snapshotRepairRun(run: TeamRun): RepairMetricsRun {
  return {
    id: run.id,
    projectId: run.projectId,
    provider: run.provider,
    revision: run.revision,
    round: run.round,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.brief ? { brief: structuredClone(run.brief) } : {}),
    ...(run.continuations
      ? {
          continuations: run.continuations.map(item => ({
            revision: item.revision,
            ...(item.brief ? { brief: structuredClone(item.brief) } : {}),
          })),
        }
      : {}),
    members: run.members
      .filter(member => LOOP_ROLES.has(member.role))
      .map(member => ({
        runId: member.runId,
        memberId: member.memberId,
        revision: member.revision,
        role: member.role,
        ...(member.provider === undefined ? {} : { provider: member.provider }),
        status: member.status,
        baseCommit: member.baseCommit,
        ...(member.startedAt === undefined ? {} : { startedAt: member.startedAt }),
        ...(member.reportedAt === undefined ? {} : { reportedAt: member.reportedAt }),
        ...(member.stalledAt === undefined ? {} : { stalledAt: member.stalledAt }),
        ...(member.stoppedReason === undefined ? {} : { stoppedReason: member.stoppedReason }),
        ...(member.continuation === undefined ? {} : { continuation: { ...member.continuation } }),
        ...(member.turns === undefined ? {} : { turns: member.turns.map(turn => ({ ...turn })) }),
        ...(member.report === undefined ? {} : { report: structuredClone(member.report) }),
      })),
    checks: run.checks.map(check => ({
      revision: check.revision,
      ...(check.round === undefined ? {} : { round: check.round }),
      ...(check.headCommit === undefined ? {} : { headCommit: check.headCommit }),
      startedAt: check.startedAt,
      ...(check.finishedAt === undefined ? {} : { finishedAt: check.finishedAt }),
      status: check.status,
      ...(check.phase === undefined ? {} : { phase: check.phase }),
    })),
  };
}

function batchChecks(checks: readonly RepairMetricsCheck[]): CheckBatch[] {
  const ordered = checks
    .map((check, index) => ({ check, index, ms: parseTime(check.startedAt) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);
  const batches: CheckBatch[] = [];
  for (const { check, index, ms } of ordered) {
    const current = batches.at(-1);
    const sameRound = current && current.round === check.round && current.headCommit === check.headCommit;
    const canAppend = Boolean(current && sameRound && current.status !== "failed" && current.status !== "interrupted");
    if (canAppend && current) {
      current.finishedAt = check.finishedAt ?? current.finishedAt;
      if (check.phase !== "setup") current.hasVerificationCheck = true;
      if (check.status === "failed" || check.status === "interrupted" || check.status === "running") current.status = check.status;
    } else {
      batches.push({
        kind: "check",
        order: index,
        sortMs: ms,
        slot: index,
        round: check.round,
        headCommit: check.headCommit,
        startedAt: check.startedAt,
        finishedAt: check.finishedAt,
        status: check.status,
        hasVerificationCheck: check.phase !== "setup",
      });
    }
  }
  return batches;
}

function memberSortMs(member: RepairMetricsMember): number {
  return parseTime(member.startedAt)
    ?? parseTime(member.turns?.[0]?.startedAt)
    ?? parseTime(member.stalledAt)
    ?? parseTime(member.reportedAt)
    ?? Number.POSITIVE_INFINITY;
}

function checkSlotForTie(batch: CheckBatch, sameTimeMembers: readonly MemberItem[]): number {
  if (sameTimeMembers.length === 0) return batch.order;
  if (batch.round === 0) return -0.5;
  if (batch.status === "failed") {
    const targetIntegrator = sameTimeMembers.find(item =>
      item.member.role === "integrator"
      && (batch.headCommit === undefined || item.member.baseCommit === batch.headCommit)
      && (parseTime(batch.finishedAt) ?? batch.sortMs) <= (parseTime(item.member.startedAt) ?? item.sortMs),
    );
    if (targetIntegrator) return targetIntegrator.slot - 0.5;
  }
  if (batch.headCommit) {
    const targetReviewer = sameTimeMembers.find(item =>
      item.member.role === "reviewer" && item.member.baseCommit === batch.headCommit,
    );
    if (targetReviewer) return targetReviewer.slot - 0.5;
  }
  const integrators = sameTimeMembers.filter(item => item.member.role === "integrator");
  if (batch.round !== undefined && batch.round >= 1 && integrators.length > 0) {
    const target = integrators[Math.min(batch.round - 1, integrators.length - 1)]!;
    return target.slot + 0.5;
  }
  const firstReviewer = sameTimeMembers.find(item => item.member.role === "reviewer");
  if (firstReviewer) return firstReviewer.slot - 0.5;
  const firstIntegrator = integrators[0];
  if (firstIntegrator && batch.status === "failed") return firstIntegrator.slot - 0.5;
  return sameTimeMembers.at(-1)!.slot + 0.5;
}

function buildTimeline(run: RepairMetricsRun, revision: number): TimelineItem[] {
  const checks = batchChecks(run.checks.filter(check => check.revision === revision));
  const members: MemberItem[] = run.members
    .filter(member => member.revision === revision && LOOP_ROLES.has(member.role))
    .map((member, index) => ({ kind: "member", order: index, sortMs: memberSortMs(member), slot: index, member }));
  const membersBySortMs = new Map<number, MemberItem[]>();
  for (const item of members) {
    const group = membersBySortMs.get(item.sortMs);
    if (group) group.push(item);
    else membersBySortMs.set(item.sortMs, [item]);
  }
  for (const batch of checks) {
    batch.slot = checkSlotForTie(batch, membersBySortMs.get(batch.sortMs) ?? []);
  }
  return [...checks, ...members].sort((a, b) => {
    if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
    if (a.slot !== b.slot) return a.slot - b.slot;
    if (a.kind !== b.kind) return a.kind === "check" ? -1 : 1;
    return a.order - b.order;
  });
}

function parseRevisionEvents(
  events: readonly RepairRunEvent[],
  revision: number,
): { reviewByMember: Map<string, ParsedReviewEvent>; repairs: ParsedRepairEvent[] } {
  const reviewByMember = new Map<string, ParsedReviewEvent>();
  const repairsByRound = new Map<number, ParsedRepairEvent>();
  for (const event of events) {
    if (event.revision !== revision) continue;
    if (event.kind === "review.recorded") {
      const verdict = event.data.verdict;
      if (!event.memberId || (verdict !== "approved" && verdict !== "changes-requested")) continue;
      const headCommit = typeof event.data.headCommit === "string" ? event.data.headCommit : undefined;
      reviewByMember.set(event.memberId, {
        memberId: event.memberId,
        verdict,
        ...(headCommit === undefined ? {} : { headCommit }),
        at: event.at,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
      });
    } else if (event.kind === "repair.started") {
      const round = event.data.round;
      const cause = event.data.cause;
      if (typeof round !== "number" || !Number.isInteger(round) || round < 1) continue;
      if (cause !== "check" && cause !== "review" && cause !== "delivery") continue;
      const headCommit = typeof event.data.headCommit === "string" ? event.data.headCommit : undefined;
      repairsByRound.set(round, {
        round,
        cause,
        ...(headCommit === undefined ? {} : { headCommit }),
        at: event.at,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
      });
    }
  }
  const repairs = [...repairsByRound.values()].sort((a, b) =>
    a.round - b.round || (a.seq ?? 0) - (b.seq ?? 0) || (parseTime(a.at) ?? 0) - (parseTime(b.at) ?? 0),
  );
  return { reviewByMember, repairs };
}

function bindRepairsToTimeline(
  timeline: readonly TimelineItem[],
  reviewByMember: ReadonlyMap<string, ParsedReviewEvent>,
  repairs: readonly ParsedRepairEvent[],
  brief: TeamBrief | undefined,
): Map<TimelineItem, ParsedRepairEvent> {
  const bound = new Map<TimelineItem, ParsedRepairEvent>();
  for (const repair of repairs) {
    const repairMs = parseTime(repair.at);
    if (repair.cause === "check") {
      let chosen: { item: CheckBatch; ms: number; index: number } | undefined;
      for (let index = 0; index < timeline.length; index++) {
        const item = timeline[index]!;
        if (item.kind !== "check" || item.status !== "failed" || bound.has(item)) continue;
        if (item.round !== undefined && item.round !== repair.round - 1) continue;
        if (repair.headCommit !== undefined && item.headCommit !== undefined && item.headCommit !== repair.headCommit) continue;
        const itemMs = parseTime(item.finishedAt ?? item.startedAt);
        if (repairMs !== undefined && itemMs !== undefined && itemMs > repairMs) continue;
        const scoreMs = itemMs ?? Number.NEGATIVE_INFINITY;
        if (!chosen || scoreMs > chosen.ms || (scoreMs === chosen.ms && index > chosen.index)) {
          chosen = { item, ms: scoreMs, index };
        }
      }
      if (chosen) bound.set(chosen.item, repair);
      continue;
    }

    if (repair.cause === "review") {
      let chosen: { item: MemberItem; seq?: number; ms: number; index: number } | undefined;
      for (let index = 0; index < timeline.length; index++) {
        const item = timeline[index]!;
        if (item.kind !== "member" || item.member.role !== "reviewer" || bound.has(item)) continue;
        const report = item.member.report;
        if (report?.kind !== "review" || report.verdict !== "changes-requested") continue;
        if (reviewEvidenceProblems(brief, report).length > 0) continue;
        const recorded = reviewByMember.get(item.member.memberId);
        if (!recorded || recorded.verdict !== "changes-requested") continue;
        if (recorded.headCommit !== undefined && recorded.headCommit !== item.member.baseCommit) continue;
        if (repair.headCommit !== undefined && item.member.baseCommit !== repair.headCommit) continue;
        if (repair.seq !== undefined && recorded.seq !== undefined) {
          if (recorded.seq >= repair.seq) continue;
          if (!chosen || (chosen.seq ?? Number.NEGATIVE_INFINITY) < recorded.seq) {
            chosen = { item, seq: recorded.seq, ms: parseTime(recorded.at) ?? Number.NEGATIVE_INFINITY, index };
          }
          continue;
        }
        const itemMs = parseTime(item.member.reportedAt ?? recorded.at ?? item.member.startedAt);
        if (repairMs !== undefined && itemMs !== undefined && itemMs > repairMs) continue;
        const scoreMs = itemMs ?? Number.NEGATIVE_INFINITY;
        if (!chosen || scoreMs > chosen.ms) {
          chosen = { item, ms: scoreMs, index };
        }
      }
      if (chosen) bound.set(chosen.item, repair);
      continue;
    }

    let chosen: { item: MemberItem; ms: number; index: number } | undefined;
    for (let index = 0; index < timeline.length; index++) {
      const item = timeline[index]!;
      if (item.kind !== "member" || item.member.role !== "delivery" || bound.has(item)) continue;
      const report = item.member.report;
      if (report?.kind !== "delivery-repair") continue;
      if (report.headCommit !== item.member.baseCommit) continue;
      if (repair.headCommit !== undefined && report.headCommit !== repair.headCommit) continue;
      const itemMs = parseTime(item.member.reportedAt ?? item.member.startedAt);
      if (repairMs !== undefined && itemMs !== undefined && itemMs > repairMs) continue;
      const scoreMs = itemMs ?? Number.NEGATIVE_INFINITY;
      if (!chosen || scoreMs > chosen.ms || (scoreMs === chosen.ms && index > chosen.index)) {
        chosen = { item, ms: scoreMs, index };
      }
    }
    if (chosen) bound.set(chosen.item, repair);
  }
  return bound;
}

function briefForRevision(run: RepairMetricsRun, revision: number): TeamBrief | undefined {
  if (revision === run.revision) return run.brief;
  return run.continuations?.find(item => item.revision === revision)?.brief;
}

function endOutcome(run: RepairMetricsRun, revision: number): RepairLoopOutcome {
  if (run.revision > revision) return "superseded";
  if (run.status === "blocked") return "blocked";
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "no-change" || run.status === "merged" || run.status === "ready-for-review") return "unresolved";
  return "in-progress";
}

function finalizeLoop(
  run: RepairMetricsRun,
  extracted: ExtractedLoop,
  memberUsage: (member: RepairMetricsMember, fallbackProvider: Provider) => UsageTotals | undefined,
): { sample: RepairLoopSample; unmeasuredMembers: number } {
  const { revision, loop, outcome, finishedAt, passingCommit } = extracted;
  const unfinished = outcome === "in-progress" || loop.members.some(member => member.status !== "stopped");
  let failedResumes = 0;
  let unmeasuredMembers = 0;
  let memberLaunchAttempts = 0;
  let allMeasured = !unfinished && loop.members.length > 0;
  let tokens = 0;
  let microUsd = 0;
  for (const member of loop.members) {
    memberLaunchAttempts += memberAttempts(member);
    if (hasFailedResume(member)) failedResumes += 1;
    if (member.status !== "stopped") {
      allMeasured = false;
      continue;
    }
    const usage = memberUsage(member, run.provider);
    if (!usage || usage.pricing.unknown > 0) {
      unmeasuredMembers += 1;
      allMeasured = false;
    } else if (!unfinished) {
      tokens += usageTokensSum(usage);
      microUsd += Math.round(usage.cost * 1_000_000);
    }
  }
  const startMs = parseTime(loop.startedAt);
  const finishMs = finishedAt ? parseTime(finishedAt) : undefined;
  const durationMs = startMs !== undefined && finishMs !== undefined ? Math.max(0, finishMs - startMs) : undefined;
  const sample: RepairLoopSample = {
    runId: run.id,
    projectId: run.projectId,
    revision,
    cause: loop.cause,
    outcome,
    rounds: loop.rounds,
    attempts: memberLaunchAttempts + loop.checkBatches.length,
    coldReplacements: loop.coldReplacements,
    failedResumes,
    startedAt: loop.startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(loop.failedCommit ? { failedCommit: loop.failedCommit } : {}),
    ...(outcome === "resolved" && passingCommit ? { passingCommit } : {}),
    measured: allMeasured,
    ...(unfinished ? { unfinished: true as const } : {}),
    ...(allMeasured ? { tokens, usd: microUsd / 1_000_000 } : {}),
  };
  return { sample, unmeasuredMembers };
}

function revisionOverlapsWindow(
  run: RepairMetricsRun,
  revision: number,
  events: readonly RepairRunEvent[],
  cutoffMs: number,
  runActivityMs: number | undefined,
): boolean {
  if (revision === run.revision && runActivityMs !== undefined && runActivityMs >= cutoffMs) return true;
  for (const member of run.members) {
    if (member.revision !== revision || !LOOP_ROLES.has(member.role)) continue;
    const ms = parseTime(member.reportedAt)
      ?? parseTime(member.startedAt)
      ?? parseTime(member.turns?.[0]?.startedAt)
      ?? parseTime(member.stalledAt);
    if (ms !== undefined && ms >= cutoffMs) return true;
  }
  for (const check of run.checks) {
    if (check.revision !== revision) continue;
    const ms = parseTime(check.finishedAt) ?? parseTime(check.startedAt);
    if (ms !== undefined && ms >= cutoffMs) return true;
  }
  for (const event of events) {
    if (event.revision !== revision) continue;
    const ms = parseTime(event.at);
    if (ms !== undefined && ms >= cutoffMs) return true;
  }
  return false;
}

function extractRevisionLoops(
  run: RepairMetricsRun,
  revision: number,
  events: readonly RepairRunEvent[],
): { loops: ExtractedLoop[]; incomplete: boolean } {
  const timeline = buildTimeline(run, revision);
  const extracted: ExtractedLoop[] = [];
  const brief = briefForRevision(run, revision);
  const { reviewByMember, repairs } = parseRevisionEvents(events, revision);
  const repairByTrigger = bindRepairsToTimeline(timeline, reviewByMember, repairs, brief);
  const repairRounds = new Set(repairs.map(item => item.round));
  let incomplete = repairByTrigger.size < repairs.length;
  if (revision === run.revision && (run.round ?? 0) >= 1) {
    for (let round = 1; round <= run.round!; round++) {
      if (!repairRounds.has(round)) incomplete = true;
    }
  }
  for (const check of run.checks) {
    if (check.revision === revision && check.round !== undefined && check.round >= 1 && !repairRounds.has(check.round)) {
      incomplete = true;
    }
  }
  let sawRepairTriggerSignal = false;
  let active: OpenLoop | null = null;

  for (let index = 0; index < timeline.length; index++) {
    const item = timeline[index]!;
    const boundRepair = repairByTrigger.get(item);

    if (item.kind === "check") {
      if (item.status === "failed") sawRepairTriggerSignal = true;
      if (active) {
        active.checkBatches.push(item);
        active.latestCheck = item;
        active.lastRoleInRound = undefined;
        if (boundRepair) {
          active.rounds += 1;
          active.awaitingNewRound = false;
        } else if (item.status === "failed") {
          active.awaitingNewRound = true;
        }
      } else if (item.status === "failed" && boundRepair) {
        active = {
          cause: "check",
          startedAt: item.finishedAt ?? item.startedAt,
          failedCommit: item.headCommit ?? boundRepair.headCommit,
          rounds: 1,
          awaitingNewRound: false,
          latestCheck: item,
          members: [],
          checkBatches: [item],
          coldReplacements: 0,
        };
      }
      continue;
    }

    const { member } = item;
    if (member.role === "integrator") {
      if (!active) {
        if (sawRepairTriggerSignal) incomplete = true;
        continue;
      }
      active.members.push(member);
      active.latestCheck = null;
      if (active.awaitingNewRound) {
        active.rounds += 1;
        active.awaitingNewRound = false;
        active.lastRoleInRound = "integrator";
      } else if (active.lastRoleInRound === "integrator") {
        active.coldReplacements += 1;
      } else {
        active.lastRoleInRound = "integrator";
      }
      continue;
    }

    if (member.role === "reviewer") {
      if (member.report?.kind === "review" && member.report.verdict === "changes-requested") {
        sawRepairTriggerSignal = true;
      }
      const recorded = reviewByMember.get(member.memberId);
      if (!active) {
        if (boundRepair) {
          active = {
            cause: "review",
            startedAt: member.reportedAt ?? recorded?.at ?? member.startedAt ?? run.updatedAt,
            failedCommit: member.baseCommit,
            rounds: 1,
            awaitingNewRound: false,
            latestCheck: null,
            members: [],
            checkBatches: [],
            coldReplacements: 0,
          };
        }
        continue;
      }
      active.members.push(member);
      if (active.lastRoleInRound === "reviewer") active.coldReplacements += 1;
      else active.lastRoleInRound = "reviewer";

      if (member.report?.kind === "review" && member.report.verdict === "approved") {
        const nextItem = timeline[index + 1];
        const replacedSameCommit = nextItem?.kind === "member"
          && nextItem.member.role === "reviewer"
          && nextItem.member.baseCommit === member.baseCommit;
        const evidenceProblems = reviewEvidenceProblems(brief, member.report);
        const checkReady = !active.awaitingNewRound
          && active.latestCheck?.status === "passed"
          && active.latestCheck.hasVerificationCheck
          && (!active.latestCheck.headCommit || active.latestCheck.headCommit === member.baseCommit);
        const approvedByHost = recorded?.verdict === "approved"
          && typeof recorded.headCommit === "string"
          && recorded.headCommit === member.baseCommit
          && (!active.latestCheck?.headCommit || recorded.headCommit === active.latestCheck.headCommit);
        if (checkReady && approvedByHost && evidenceProblems.length === 0 && !replacedSameCommit) {
          const finishedAt = member.reportedAt ?? recorded.at ?? member.startedAt ?? run.updatedAt;
          const passingCommit = active.latestCheck!.headCommit ?? member.baseCommit;
          extracted.push({ revision, loop: active, outcome: "resolved", finishedAt, passingCommit });
          active = null;
        } else if (checkReady && !approvedByHost && evidenceProblems.length === 0 && !replacedSameCommit) {
          active.sawUnrecordedApproval = true;
        }
      } else if (boundRepair) {
        active.rounds += 1;
        active.awaitingNewRound = false;
        active.latestCheck = null;
        active.lastRoleInRound = undefined;
      } else if (
        member.report?.kind === "review"
        && member.report.verdict === "changes-requested"
        && recorded?.verdict === "changes-requested"
      ) {
        active.awaitingNewRound = true;
        active.latestCheck = null;
      }
      continue;
    }

    if (member.role === "delivery") {
      if (member.report?.kind === "delivery-repair") sawRepairTriggerSignal = true;
      if (!boundRepair) continue;
      if (!active) {
        active = {
          cause: "delivery",
          startedAt: member.reportedAt ?? member.startedAt ?? run.updatedAt,
          failedCommit: member.report?.kind === "delivery-repair" ? member.report.headCommit : member.baseCommit,
          rounds: 1,
          awaitingNewRound: false,
          latestCheck: null,
          members: [],
          checkBatches: [],
          coldReplacements: 0,
        };
      } else {
        active.rounds += 1;
        active.awaitingNewRound = false;
        active.latestCheck = null;
        active.lastRoleInRound = undefined;
      }
    }
  }

  if (active) {
    if (active.sawUnrecordedApproval && revision === run.revision && (run.status === "ready-for-review" || run.status === "merged")) {
      incomplete = true;
    }
    extracted.push({ revision, loop: active, outcome: endOutcome(run, revision) });
  }
  return { loops: extracted, incomplete };
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function p90(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!;
}

export function computeRepairLoopMetrics(
  runs: readonly RepairMetricsRun[],
  memberUsage: (member: RepairMetricsMember, fallbackProvider: Provider) => UsageTotals | undefined,
  options?: RepairLoopOptions,
): RepairLoopReport {
  const windowDays = options?.days ?? DEFAULT_DAYS;
  const now = options?.now ?? Date.now();
  const cutoffMs = now - windowDays * DAY_MS;
  const projectId = options?.projectId;
  const filter: RepairRunFilter = { ...(projectId === undefined ? {} : { projectId }), cutoffMs };

  let runsExamined = 0;
  let incompleteRuns = 0;
  let unmeasuredMembers = 0;
  const allSamples: RepairLoopSample[] = [];

  for (const run of runs) {
    if (!runMayOverlapWindow(run, filter)) continue;
    const events = options?.runEvents ? options.runEvents(run.id) : [];
    const runActivityMs = parseTime(run.updatedAt) ?? parseTime(run.createdAt);
    const hasLedgerGap = events.some(event => event.kind === "ledger.gap");
    const revisions = [...new Set([
      run.revision,
      ...run.members.map(m => m.revision),
      ...run.checks.map(c => c.revision),
      ...events.map(e => e.revision),
    ])].sort((a, b) => a - b);
    const extractedLoops: ExtractedLoop[] = [];
    let runIncomplete = hasLedgerGap;
    for (const revision of revisions) {
      const result = extractRevisionLoops(run, revision, events);
      extractedLoops.push(...result.loops);
      if (result.incomplete && revisionOverlapsWindow(run, revision, events, cutoffMs, runActivityMs)) {
        runIncomplete = true;
      }
    }
    const inWindowExtracted = extractedLoops.filter(item => {
      const startMs = parseTime(item.loop.startedAt);
      return startMs !== undefined && startMs >= cutoffMs;
    });
    const runInWindow = (runActivityMs !== undefined && runActivityMs >= cutoffMs) || inWindowExtracted.length > 0;
    if (runInWindow) {
      runsExamined += 1;
      if (runIncomplete) incompleteRuns += 1;
    }
    for (const extracted of inWindowExtracted) {
      const item = finalizeLoop(run, extracted, memberUsage);
      allSamples.push(item.sample);
      unmeasuredMembers += item.unmeasuredMembers;
    }
  }

  allSamples.sort((a, b) => (parseTime(b.startedAt) ?? 0) - (parseTime(a.startedAt) ?? 0) || a.runId.localeCompare(b.runId) || b.revision - a.revision);

  const byCause: Record<RepairLoopCause, number> = { review: 0, check: 0, delivery: 0 };
  let resolved = 0;
  let unresolved = 0;
  let inProgress = 0;
  let coldReplacements = 0;
  let failedResumes = 0;
  let measuredLoops = 0;
  let unmeasuredLoops = 0;
  let unfinishedLoops = 0;
  const resolvedMinutes: number[] = [];
  const measuredTokens: number[] = [];
  const measuredUsd: number[] = [];

  for (const sample of allSamples) {
    byCause[sample.cause] += 1;
    if (sample.outcome === "resolved") {
      resolved += 1;
      if (sample.durationMs !== undefined) resolvedMinutes.push(sample.durationMs / 60_000);
    } else if (sample.outcome === "in-progress") {
      inProgress += 1;
    } else {
      unresolved += 1;
    }
    coldReplacements += sample.coldReplacements;
    failedResumes += sample.failedResumes;
    if (sample.measured && sample.tokens !== undefined && sample.usd !== undefined) {
      measuredLoops += 1;
      measuredTokens.push(sample.tokens);
      measuredUsd.push(sample.usd);
    } else if (sample.unfinished) {
      unfinishedLoops += 1;
    } else {
      unmeasuredLoops += 1;
    }
  }

  const medianMin = median(resolvedMinutes);
  const p90Min = p90(resolvedMinutes);
  const medTok = median(measuredTokens);
  const medUsd = median(measuredUsd);

  return {
    windowDays,
    ...(projectId === undefined ? {} : { projectId }),
    totals: {
      runsExamined,
      eventCoverage: incompleteRuns > 0 ? "incomplete" : "complete",
      incompleteRuns,
      loopsTotal: allSamples.length,
      resolved,
      unresolved,
      inProgress,
      byCause,
      coldReplacements,
      failedResumes,
      measuredLoops,
      unmeasuredLoops,
      unfinishedLoops,
      unmeasuredMembers,
      medianMinutes: medianMin === null ? null : roundTo(medianMin, 100),
      p90Minutes: p90Min === null ? null : roundTo(p90Min, 100),
      medianTokens: medTok === null ? null : Math.round(medTok),
      medianUsd: medUsd === null ? null : roundTo(medUsd, 1_000_000),
    },
    loops: allSamples.slice(0, MAX_SAMPLE_LOOPS),
  };
}
