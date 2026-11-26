import type { TeamCheck, TeamMember, TeamRun } from "./team-types.js";
import type { Provider } from "./types.js";
import type { UsageTotals } from "./usage.js";

export type RepairLoopCause = "review" | "check" | "delivery";
export type RepairLoopOutcome = "resolved" | "blocked" | "cancelled" | "superseded" | "unresolved" | "in-progress";

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
  tokens?: number;
  usd?: number;
}

export interface RepairLoopTotals {
  runsExamined: number;
  loopsTotal: number;
  resolved: number;
  unresolved: number;
  inProgress: number;
  byCause: Record<RepairLoopCause, number>;
  coldReplacements: number;
  failedResumes: number;
  measuredLoops: number;
  unmeasuredLoops: number;
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
}

interface CheckBatch {
  kind: "check";
  order: number;
  sortMs: number;
  round?: number;
  headCommit?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed" | "interrupted";
}

interface MemberItem {
  kind: "member";
  order: number;
  sortMs: number;
  member: TeamMember;
}

type TimelineItem = CheckBatch | MemberItem;

interface OpenLoop {
  cause: RepairLoopCause;
  startedAt: string;
  failedCommit?: string;
  rounds: number;
  awaitingNewRound: boolean;
  lastRoleInRound?: "integrator" | "reviewer";
  members: TeamMember[];
  checkBatches: CheckBatch[];
  coldReplacements: number;
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

function hasFailedResume(member: TeamMember): boolean {
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

function batchChecks(checks: readonly TeamCheck[]): CheckBatch[] {
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
      if (check.status === "failed" || check.status === "interrupted" || check.status === "running") current.status = check.status;
    } else {
      batches.push({
        kind: "check",
        order: index,
        sortMs: ms,
        round: check.round,
        headCommit: check.headCommit,
        startedAt: check.startedAt,
        finishedAt: check.finishedAt,
        status: check.status,
      });
    }
  }
  return batches;
}

function memberSortMs(member: TeamMember): number {
  return parseTime(member.startedAt)
    ?? parseTime(member.turns?.[0]?.startedAt)
    ?? parseTime(member.stalledAt)
    ?? parseTime(member.reportedAt)
    ?? Number.POSITIVE_INFINITY;
}

function itemRank(item: TimelineItem): number {
  if (item.kind === "check") return item.status === "failed" ? 0 : 2;
  if (item.member.role === "integrator") return 1;
  if (item.member.role === "reviewer") return 3;
  return 4;
}

function buildTimeline(run: TeamRun, revision: number): TimelineItem[] {
  const checks = batchChecks(run.checks.filter(check => check.revision === revision));
  const members: MemberItem[] = run.members
    .filter(member => member.revision === revision && LOOP_ROLES.has(member.role))
    .map((member, index) => ({ kind: "member", order: index, sortMs: memberSortMs(member), member }));
  return [...checks, ...members].sort((a, b) => {
    if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
    const rankDiff = itemRank(a) - itemRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.order - b.order;
  });
}

function hasPassingCheckForCommit(loop: OpenLoop, commit: string): boolean {
  return loop.checkBatches.some(batch => batch.status === "passed" && (!batch.headCommit || batch.headCommit === commit));
}

function endOutcome(run: TeamRun, revision: number): RepairLoopOutcome {
  if (run.revision > revision) return "superseded";
  if (run.status === "blocked") return "blocked";
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "no-change" || run.status === "merged" || run.status === "ready-for-review") return "unresolved";
  return "in-progress";
}

function finalizeLoop(
  run: TeamRun,
  revision: number,
  loop: OpenLoop,
  outcome: RepairLoopOutcome,
  memberUsage: (member: TeamMember, fallbackProvider: Provider) => UsageTotals | undefined,
  finishedAt?: string,
): { sample: RepairLoopSample; unmeasuredMembers: number } {
  let failedResumes = 0;
  let unmeasuredMembers = 0;
  let allMeasured = loop.members.length > 0;
  let tokens = 0;
  let microUsd = 0;
  for (const member of loop.members) {
    if (hasFailedResume(member)) failedResumes += 1;
    const usage = memberUsage(member, run.provider);
    if (!usage) {
      unmeasuredMembers += 1;
      allMeasured = false;
    } else {
      tokens += usageTokensSum(usage);
      microUsd += Math.round(usage.cost * 1_000_000);
    }
  }
  const startMs = parseTime(loop.startedAt);
  const finishMs = finishedAt ? parseTime(finishedAt) : undefined;
  const durationMs = startMs !== undefined && finishMs !== undefined ? Math.max(0, finishMs - startMs) : undefined;
  const lastPassed = [...loop.checkBatches].reverse().find(batch => batch.status === "passed");
  const sample: RepairLoopSample = {
    runId: run.id,
    projectId: run.projectId,
    revision,
    cause: loop.cause,
    outcome,
    rounds: loop.rounds,
    attempts: loop.members.length + loop.checkBatches.length,
    coldReplacements: loop.coldReplacements,
    failedResumes,
    startedAt: loop.startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(loop.failedCommit ? { failedCommit: loop.failedCommit } : {}),
    ...(outcome === "resolved" && lastPassed?.headCommit ? { passingCommit: lastPassed.headCommit } : {}),
    measured: allMeasured,
    ...(allMeasured ? { tokens, usd: microUsd / 1_000_000 } : {}),
  };
  return { sample, unmeasuredMembers };
}

function extractRevisionLoops(
  run: TeamRun,
  revision: number,
  memberUsage: (member: TeamMember, fallbackProvider: Provider) => UsageTotals | undefined,
): { sample: RepairLoopSample; unmeasuredMembers: number }[] {
  const timeline = buildTimeline(run, revision);
  const extracted: { sample: RepairLoopSample; unmeasuredMembers: number }[] = [];
  let active: OpenLoop | null = null;

  for (let index = 0; index < timeline.length; index++) {
    const item = timeline[index]!;
    if (item.kind === "check") {
      if (active) {
        active.checkBatches.push(item);
        active.lastRoleInRound = undefined;
        if (item.status === "failed") active.awaitingNewRound = true;
      } else if (item.status === "failed") {
        const leadsToIntegrator = timeline.slice(index + 1).some(later => later.kind === "member" && later.member.role === "integrator");
        if (leadsToIntegrator) {
          active = {
            cause: "check",
            startedAt: item.finishedAt ?? item.startedAt,
            failedCommit: item.headCommit,
            rounds: 1,
            awaitingNewRound: false,
            members: [],
            checkBatches: [item],
            coldReplacements: 0,
          };
        }
      }
      continue;
    }

    const { member } = item;
    if (member.role === "integrator") {
      if (!active) continue;
      active.members.push(member);
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
      if (!active) {
        if (member.report?.kind === "review" && member.report.verdict === "changes-requested") {
          active = {
            cause: "review",
            startedAt: member.reportedAt ?? member.startedAt ?? run.updatedAt,
            failedCommit: member.baseCommit,
            rounds: 1,
            awaitingNewRound: false,
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
      if (member.report?.kind === "review" && member.report.verdict === "approved" && hasPassingCheckForCommit(active, member.baseCommit)) {
        const finishedAt = member.reportedAt ?? member.startedAt ?? run.updatedAt;
        const finalized = finalizeLoop(run, revision, active, "resolved", memberUsage, finishedAt);
        if (!finalized.sample.passingCommit) finalized.sample.passingCommit = member.baseCommit;
        extracted.push(finalized);
        active = null;
      } else if (member.report?.kind === "review" && member.report.verdict === "changes-requested") {
        active.awaitingNewRound = true;
      }
      continue;
    }

    if (member.role === "delivery" && member.report?.kind === "delivery-repair") {
      if (!active) {
        active = {
          cause: "delivery",
          startedAt: member.reportedAt ?? member.startedAt ?? run.updatedAt,
          failedCommit: member.report.headCommit ?? member.baseCommit,
          rounds: 1,
          awaitingNewRound: false,
          members: [],
          checkBatches: [],
          coldReplacements: 0,
        };
      } else {
        active.awaitingNewRound = true;
      }
    }
  }

  if (active) extracted.push(finalizeLoop(run, revision, active, endOutcome(run, revision), memberUsage));
  return extracted;
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
  runs: readonly TeamRun[],
  memberUsage: (member: TeamMember, fallbackProvider: Provider) => UsageTotals | undefined,
  options?: RepairLoopOptions,
): RepairLoopReport {
  const windowDays = options?.days ?? DEFAULT_DAYS;
  const now = options?.now ?? Date.now();
  const cutoffMs = now - windowDays * DAY_MS;
  const projectId = options?.projectId;

  let runsExamined = 0;
  let unmeasuredMembers = 0;
  const allSamples: RepairLoopSample[] = [];

  for (const run of runs) {
    if (run.replay) continue;
    if (projectId !== undefined && run.projectId !== projectId) continue;
    const revisions = [...new Set([...run.members.map(m => m.revision), ...run.checks.map(c => c.revision)])].sort((a, b) => a - b);
    const runLoops = revisions.flatMap(revision => extractRevisionLoops(run, revision, memberUsage));
    const inWindowLoops = runLoops.filter(item => {
      const startMs = parseTime(item.sample.startedAt);
      return startMs !== undefined && startMs >= cutoffMs;
    });
    const runActivityMs = parseTime(run.updatedAt) ?? parseTime(run.createdAt);
    const runInWindow = (runActivityMs !== undefined && runActivityMs >= cutoffMs) || inWindowLoops.length > 0;
    if (runInWindow) runsExamined += 1;
    for (const item of inWindowLoops) {
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
      loopsTotal: allSamples.length,
      resolved,
      unresolved,
      inProgress,
      byCause,
      coldReplacements,
      failedResumes,
      measuredLoops,
      unmeasuredLoops,
      unmeasuredMembers,
      medianMinutes: medianMin === null ? null : roundTo(medianMin, 100),
      p90Minutes: p90Min === null ? null : roundTo(p90Min, 100),
      medianTokens: medTok === null ? null : Math.round(medTok),
      medianUsd: medUsd === null ? null : roundTo(medUsd, 1_000_000),
    },
    loops: allSamples.slice(0, MAX_SAMPLE_LOOPS),
  };
}
