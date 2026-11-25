import { familyOf } from "./permission-families.js";
import { digest } from "./team-kernel.js";
import { teamDeliveryBranch, UNKNOWN_DELIVERY_BRANCH } from "./team-prompts.js";
import { TeamError } from "./team-workspace.js";
import type { TeamDelivery, TeamMember, TeamRun } from "./team-types.js";

export type DeliveryReviewLineage = {
  headCommit: string;
  families: string[];
  unknown: boolean;
};

export type DeliveryReviewApproval = {
  reviewerMemberId: string;
  revision: number;
  round: number;
  headCommit: string;
};

export const REVIEWER_FAMILY_REQUIRED = "reviewer-family-required" as const;

export function assertReviewedDelivery(run: TeamRun, checkHead: string | undefined, configured: TeamDelivery | undefined): void {
  if (!run.delivery || !configured || digest(configured) !== digest(run.delivery))
    throw new TeamError(409, "delivery-policy-changed", "The repository delivery policy changed or was removed; publication is blocked.");
  if (!run.headCommit || checkHead !== run.headCommit || run.review?.revision !== run.revision || run.review.verdict !== "approved")
    throw new TeamError(409, "delivery-not-reviewed", "Delivery requires passing checks and independent approval for the current integration commit.");
  if (!teamDeliveryBranch(run)) throw new TeamError(409, "delivery-branch-unknown", UNKNOWN_DELIVERY_BRANCH);
}

export function deliveryReviewLineageAtBase(headCommit: string): DeliveryReviewLineage {
  return { headCommit, families: [], unknown: false };
}

export function advanceDeliveryReviewLineage(
  current: DeliveryReviewLineage | undefined,
  input: { headBefore: string; headAfter: string; contributorFamilies: readonly (string | undefined)[] },
): DeliveryReviewLineage {
  const { headBefore, headAfter, contributorFamilies } = input;
  const prior = current?.headCommit === headBefore ? current : { headCommit: headBefore, families: [], unknown: true };

  if (headAfter === headBefore) return { ...prior, families: [...prior.families] };

  const families = new Set(prior.families);
  for (const family of contributorFamilies) if (family) families.add(family);
  return {
    headCommit: headAfter,
    families: [...families].sort(),
    unknown: prior.unknown || contributorFamilies.length === 0 || contributorFamilies.some(family => !family),
  };
}

export function workspaceContributorFamilies(run: Pick<TeamRun, "members">, member: TeamMember): (string | undefined)[] {
  if ((member.role !== "implementer" && member.role !== "integrator") || !member.cwd || member.role === "implementer" && !member.taskId) return [undefined];
  const attempts = run.members.filter(candidate => candidate.role === member.role && candidate.revision === member.revision &&
    candidate.cwd === member.cwd && (member.role !== "implementer" || Boolean(member.taskId) && candidate.taskId === member.taskId) &&
    (candidate.memberId === member.memberId || candidate.status !== "queued" || candidate.startedAt));
  if (!attempts.some(candidate => candidate.memberId === member.memberId)) return [undefined];
  return attempts.map(candidate => candidate.modelProfile ? familyOf(candidate.modelProfile) : undefined);
}

export function potentialRecoveryContributorFamilies(run: Pick<TeamRun, "members">, revision: number): (string | undefined)[] {
  return run.members.filter(member => member.revision === revision && (member.role === "implementer" || member.role === "integrator") &&
    (member.status !== "queued" || Boolean(member.startedAt)))
    .map(member => member.modelProfile ? familyOf(member.modelProfile) : undefined);
}

export function includeDeliveryReviewContributors(
  current: DeliveryReviewLineage | undefined,
  headCommit: string,
  contributorFamilies: readonly (string | undefined)[],
): DeliveryReviewLineage {
  const prior = current?.headCommit === headCommit ? current : { headCommit, families: [], unknown: true };
  const families = new Set(prior.families);
  for (const family of contributorFamilies) if (family) families.add(family);
  return {
    headCommit,
    families: [...families].sort(),
    unknown: prior.unknown || contributorFamilies.some(family => !family),
  };
}

export function rebaseDeliveryReviewLineage(
  current: DeliveryReviewLineage | undefined,
  previousHead: string,
  newBaseCommit: string,
): DeliveryReviewLineage {
  if (!current || current.headCommit !== previousHead)
    return { headCommit: newBaseCommit, families: [], unknown: true };
  return { ...current, headCommit: newBaseCommit, families: [...current.families] };
}

export function inheritDeliveryReviewLineage(
  source: DeliveryReviewLineage | undefined,
  inheritedHead: string,
): DeliveryReviewLineage {
  if (!source || source.headCommit !== inheritedHead)
    return { headCommit: inheritedHead, families: [], unknown: true };
  return { ...source, families: [...source.families] };
}

type AcceptedReviewRun = {
  headCommit?: string;
  revision: number;
  round: number;
  checkHead?: string;
  review?: { verdict: string; revision: number };
};

export function automaticMergeReviewReason(input: {
  run: AcceptedReviewRun;
  lineage?: DeliveryReviewLineage;
  approval?: DeliveryReviewApproval;
  members: readonly TeamMember[];
}): typeof REVIEWER_FAMILY_REQUIRED | undefined {
  const { run, lineage, approval } = input;
  const head = run.headCommit;
  if (!head || run.checkHead !== head || run.review?.verdict !== "approved" || run.review.revision !== run.revision ||
      !approval || approval.headCommit !== head || approval.revision !== run.revision || approval.round !== run.round ||
      !lineage || lineage.headCommit !== head || lineage.unknown || lineage.families.length === 0 || lineage.families.some(family => !family))
    return REVIEWER_FAMILY_REQUIRED;

  const reviewer = input.members.find(member => member.memberId === approval.reviewerMemberId);
  if (!reviewer || reviewer.role !== "reviewer" || reviewer.status !== "stopped" || reviewer.revision !== run.revision ||
      reviewer.baseCommit !== head || reviewer.report?.kind !== "review" || reviewer.report.verdict !== "approved")
    return REVIEWER_FAMILY_REQUIRED;

  const family = reviewer.modelProfile && familyOf(reviewer.modelProfile);
  if (!family || lineage.families.includes(family)) return REVIEWER_FAMILY_REQUIRED;
  return undefined;
}
