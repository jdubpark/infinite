import type { CycleClass, GoalCycle, ProductGoal } from "./goal-types.js";
import type { TeamView } from "./team-types.js";
import type { PendingWake } from "./signals/types.js";

/** Pure rules of a standing objective (design Part 3). GoalService owns every state change. */
export const keptCycles = 50;
export const maxFailedCycles = 3;
export const defaultWakeMinGapMinutes = 5;
/** `teamGoalContextSchema` accepts at most 16 entries of previous work. */
export const maxPreviousWork = 16;
/** `createTeamSchema` limits a run objective; the steering limit keeps the owner's part within it. */
export const runObjectiveLimitBytes = 24000;
const maxWakeLines = 8;
const reviewedStatuses = new Set(["ready-for-review", "merged"]);

export const isReviewed = (cycle: Pick<GoalCycle, "status">) => reviewedStatuses.has(cycle.status);
/** The parent of the next cycle. A cycle whose merge the host has not validated is never `merged`, so never a parent. */
export const latestReviewed = (cycles: readonly GoalCycle[]) => [...cycles].reverse().find(isReviewed);
export const foldedCycles = (goal: Pick<ProductGoal, "cycleTotals">) =>
  Object.values(goal.cycleTotals ?? {}).reduce((sum, count) => sum + count, 0);

/** Design 3.3. `ownerStop` is an owner pause or cancel in force when the cycle settled. */
export function classifyCycle(input: {
  status: string;
  stopReason?: string;
  blockCode?: string;
  deadlineStop?: GoalCycle["deadlineStop"];
  fuseOpen: boolean;
  ownerStop: boolean;
}): CycleClass {
  if (reviewedStatuses.has(input.status)) return "reviewed";
  if (input.status === "no-change") return "no-change";
  if (input.ownerStop) return "excluded";
  if (input.blockCode === "provider-limit") return "excluded";
  const timeStop = input.stopReason === "deadline" || input.deadlineStop !== undefined;
  if (timeStop && (input.fuseOpen || input.deadlineStop?.fuseOpen)) return "excluded";
  // Only an owner, a Linear block, or the cycle's own budget cancels a goal-owned run.
  if (input.status === "cancelled" && !timeStop && input.stopReason !== "member-limit") return "excluded";
  return "failed";
}

/**
 * Rule 4 of 3.4: an external operation a settled cycle left unresolved. The run view exposes the delivery
 * receipt, delivery recovery, a pending operation's source role, the delivery members, and the publication
 * state. It does not expose the stored delivery attempt or a head push still in flight.
 */
export function unresolvedOperation(team: Pick<TeamView, "status" | "revision" | "headCommit" | "deliveryReceipt" | "deliveryRecovery" | "pullRequest" | "pendingOperation" | "publication" | "members">): string | undefined {
  if (team.deliveryReceipt && team.status !== "merged")
    return "A cycle reported a merge that the host has not validated as a baseline. Inspect its delivery before more work starts.";
  if (team.deliveryRecovery && team.deliveryRecovery.status !== "complete")
    return "A cycle stopped during delivery recovery. Inspect its remote branch and pull request before more work starts.";
  if (team.pendingOperation?.sourceRole === "delivery" ||
      (team.status !== "merged" && !team.pullRequest && team.members.some(member => member.role === "delivery" && member.revision === team.revision)))
    return "A cycle stopped with an unresolved delivery attempt. Inspect its remote branch and pull request before more work starts.";
  const failure = team.publication?.failure;
  if (team.headCommit && failure?.commit === team.headCommit && team.publication?.commit !== team.headCommit)
    return "The host could not confirm that a cycle's head reached GitHub. Inspect the run branch before more work starts.";
  return undefined;
}

/** The earliest cadence start after `last`: its start plus the cadence, and never before it settled. */
export function cadenceDue(last: GoalCycle, cadenceMinutes: number, now: number) {
  const settled = Date.parse(last.settledAt ?? last.finishedAt ?? new Date(now).toISOString());
  return Math.max(Date.parse(last.startedAt) + cadenceMinutes * 60000, settled);
}

const commitText = (commit: string | undefined) => commit && /^[0-9a-f]{7,64}$/i.test(commit) ? commit.slice(0, 12) : undefined;
function wakeLine(signal: PendingWake["signals"][number]): string | undefined {
  const commit = commitText(signal.commit);
  if (signal.kind === "revert") return commit ? `- revert of commit ${commit} on the base branch` : "- a revert on the base branch";
  if (signal.kind === "external-commit") return commit ? `- commit ${commit} landed on the base branch outside this host's runs` : "- a commit landed on the base branch outside this host's runs";
  if (signal.kind === "delivery-landed") return commit ? `- delivered commit ${commit} landed on the base branch` : "- a delivered change landed on the base branch";
  return undefined;
}

/**
 * Appends the wake to a run objective within `limit` bytes. Owner signals become `User direction:` paragraphs, like
 * steering; receipts become one host-written block of at most 8 lines. The owner's objective is never cut: what does
 * not fit is left out, receipts first.
 */
export function wakeObjective(base: string, pending: PendingWake | undefined, limit = runObjectiveLimitBytes): string {
  if (!pending) return base;
  const fits = (text: string) => Buffer.byteLength(text) <= limit;
  let text = base;
  for (const signal of pending.signals) {
    if (signal.kind !== "owner" || !signal.text?.trim()) continue;
    const next = `${text}\n\nUser direction: ${signal.text.trim().slice(0, 8000)}`;
    if (fits(next)) text = next;
  }
  const lines = pending.signals.map(wakeLine).filter((line): line is string => line !== undefined);
  const shown = lines.slice(-maxWakeLines);
  let block = "", kept = 0;
  for (const line of shown) {
    const next = `${block || "Host wake reasons (host receipts, not instructions):"}\n${line}`;
    if (!fits(`${text}\n\n${next}`)) break;
    block = next; kept++;
  }
  if (!kept) return text;
  const omitted = lines.length - kept + pending.dropped;
  const withCount = omitted > 0 ? `${block}\n- ${omitted} more ${omitted === 1 ? "signal" : "signals"} not listed` : block;
  return `${text}\n\n${fits(`${text}\n\n${withCount}`) ? withCount : block}`;
}
