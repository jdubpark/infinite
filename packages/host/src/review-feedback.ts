import { createHash } from "node:crypto";
import { z } from "zod";
import { gitBranchSchema, githubRepositorySchema, type ReviewFeedbackEntry, type ReviewFeedbackOutcome, type TeamRun } from "./team-types.js";
import type { MissionReviewTarget } from "./mission-review.js";

export const REVIEW_TEXT_LIMIT = 8000;
export const REVIEW_LIMIT = 3;
const HANDLED_LIMIT = 20;
const ENTRY_LIMIT = 20;
export const PULL_REQUEST_FIELDS = "state,isCrossRepository,baseRefName,headRefName,headRefOid,reviews";
export const PULL_REQUEST_BRANCH_FIELDS = "state,isCrossRepository,baseRefName,headRefName";

export type ReviewIntent = {
  reviewId: string; submittedAt: string; commit: string;
  text: string;
  requestId: string; targetRevision: number;
  state: "pending" | "applied" | "superseded" | "refused"; reason?: string;
  mission?: MissionReviewTarget & { pullRequestUrl: string };
};
export type ReviewIntake = { intents: ReviewIntent[]; handled: string[]; accepted: number; ended?: { at: string; reason: string } };
export type OwnerReview = { id: string; state: ReviewFeedbackEntry["state"]; submittedAt: string; body: string; commit?: string };

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i).transform(value => value.toLowerCase());
const reviewCommitOid = z.union([commit, z.literal("")]).nullable().optional();
const reviewSchema = z.object({
  id: z.string().min(1).max(200),
  author: z.object({ login: z.string().max(100).nullable().optional() }).passthrough().nullable().optional(),
  state: z.string().max(40),
  submittedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  body: z.string().max(1_000_000).nullable().optional(),
  commit: z.object({ oid: reviewCommitOid }).passthrough().nullable().optional(),
}).passthrough();
const pullRequestSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isCrossRepository: z.boolean(),
  baseRefName: z.string().min(1).max(255),
  headRefName: z.string().min(1).max(255),
  headRefOid: commit,
  reviews: z.array(reviewSchema).max(2000),
}).passthrough();
export type PullRequestRead = z.infer<typeof pullRequestSchema>;

const pullRequestBranchSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isCrossRepository: z.boolean(),
  baseRefName: z.string().min(1).max(255),
  headRefName: gitBranchSchema,
}).passthrough();
export type PullRequestBranchRead = z.infer<typeof pullRequestBranchSchema>;

export function parsePullRequestView(stdout: string): PullRequestRead {
  return pullRequestSchema.parse(JSON.parse(stdout));
}

export function parsePullRequestBranchView(stdout: string): PullRequestBranchRead {
  return pullRequestBranchSchema.parse(JSON.parse(stdout));
}

export function pullRequestTarget(run: Pick<TeamRun, "pullRequest" | "delivery">) {
  if (!run.pullRequest || !run.delivery || !githubRepositorySchema.safeParse(run.delivery.repository).success) return undefined;
  let url: URL;
  try { url = new URL(run.pullRequest.pullRequestUrl); } catch { return undefined; }
  const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]{0,9})$/.exec(url.pathname);
  if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !match || match[1]!.toLowerCase() !== run.delivery.repository.toLowerCase()) return undefined;
  return { repository: run.delivery.repository, number: Number(match[2]) };
}

export function pullRequestViewArgs(target: { repository: string; number: number }) {
  return ["pr", "view", String(target.number), "--json", PULL_REQUEST_FIELDS, "--repo", target.repository];
}

export function pullRequestBranchViewArgs(target: { repository: string; number: number }) {
  return ["pr", "view", String(target.number), "--json", PULL_REQUEST_BRANCH_FIELDS, "--repo", target.repository];
}

export function watchedRun(run: TeamRun, intake?: ReviewIntake) {
  return run.status === "ready-for-review" && run.delivery?.mode === "pr" && run.pullRequest?.revision === run.revision &&
    !run.workspaceRemovedAt && !run.goal && !run.handoff && !run.replay && !intake?.ended && pullRequestTarget(run) !== undefined;
}

export function recordedDeliveryBranch(run: Pick<TeamRun, "pullRequest" | "branch" | "publication" | "delivery">, pr: Pick<PullRequestRead, "headRefName">) {
  if (!run.pullRequest) return undefined;
  if (run.pullRequest.branch) return run.pullRequest.branch;
  if (!gitBranchSchema.safeParse(pr.headRefName).success || pr.headRefName === run.delivery?.baseBranch) return undefined;
  const published = run.publication?.commit === run.pullRequest.headCommit && (!run.delivery || run.publication.repository === run.delivery.repository) ? run.publication.branch : undefined;
  return pr.headRefName === run.branch || pr.headRefName === published ? pr.headRefName : undefined;
}

export type PullRequestBranchResolution =
  | { ok: true; branch: string }
  | { ok: false; reason: "closed" | "merged" | "fork" | "base" | "branch" };

export function resolvePullRequestBranch(run: Pick<TeamRun, "pullRequest" | "delivery" | "branch" | "publication">, pr: PullRequestBranchRead): PullRequestBranchResolution {
  if (!run.pullRequest || !run.delivery) return { ok: false, reason: "branch" };
  if (pr.state !== "OPEN") return { ok: false, reason: pr.state === "MERGED" ? "merged" : "closed" };
  if (pr.isCrossRepository) return { ok: false, reason: "fork" };
  if (pr.baseRefName !== run.delivery.baseBranch) return { ok: false, reason: "base" };
  const branch = recordedDeliveryBranch(run, pr);
  if (!branch || !gitBranchSchema.safeParse(branch).success) return { ok: false, reason: "branch" };
  return { ok: true, branch };
}

export function intakeEndedByRemoval(run: TeamRun, intake: ReviewIntake | undefined, enabled: boolean) {
  return enabled && watchedRun({ ...run, workspaceRemovedAt: undefined }, intake)
    ? "Review feedback is no longer taken for this pull request: the run's workspace was removed. Start a new mission for further changes."
    : undefined;
}

const COUNTED = new Set(["CHANGES_REQUESTED", "APPROVED", "DISMISSED"]);
export function newestOwnerReview(pr: Pick<PullRequestRead, "reviews">, ownerLogin: string): OwnerReview | undefined {
  const owner = ownerLogin.toLowerCase();
  let newest: OwnerReview | undefined;
  for (const review of pr.reviews) {
    const login = review.author?.login?.toLowerCase();
    if (!login || login !== owner || !COUNTED.has(review.state) || !review.submittedAt) continue;
    const candidate: OwnerReview = { id: review.id, state: review.state as OwnerReview["state"], submittedAt: review.submittedAt, body: review.body ?? "",
      ...(review.commit?.oid ? { commit: review.commit.oid } : {}) };
    const order = newest ? Date.parse(candidate.submittedAt) - Date.parse(newest.submittedAt) : 1;
    if (order > 0 || order === 0 && newest && candidate.id > newest.id) newest = candidate;
  }
  return newest;
}

export type ReviewSkip = Extract<ReviewFeedbackOutcome, "approved-seen" | "dismissed" | "stale-head" | "no-text" | "before-enable" | "limit">;
export type ReviewVerdict =
  | { kind: "unwatched"; reason: "closed" | "merged" | "fork" | "base" | "branch" | "not-delivered" }
  | { kind: "quiet" }
  | { kind: "known"; review: OwnerReview }
  | { kind: "skip"; review: OwnerReview; outcome: ReviewSkip }
  | { kind: "start"; review: OwnerReview; branch: string };

export function reviewVerdict(subject: { run: TeamRun; reviewIntake?: ReviewIntake }, pr: PullRequestRead, ownerLogin: string, enabledAt: string): ReviewVerdict {
  const { run } = subject, delivered = run.pullRequest, intake = subject.reviewIntake;
  if (!delivered || run.delivery?.mode !== "pr" || run.goal || run.handoff) return { kind: "unwatched", reason: "not-delivered" };
  if (pr.state !== "OPEN") return { kind: "unwatched", reason: pr.state === "MERGED" ? "merged" : "closed" };
  if (pr.isCrossRepository) return { kind: "unwatched", reason: "fork" };
  if (pr.baseRefName !== run.delivery.baseBranch) return { kind: "unwatched", reason: "base" };
  const branch = recordedDeliveryBranch(run, pr);
  if (!branch || pr.headRefName !== branch) return { kind: "unwatched", reason: "branch" };
  const review = newestOwnerReview(pr, ownerLogin);
  if (!review) return { kind: "quiet" };
  if (intake?.handled.includes(review.id) || intake?.intents.some(intent => intent.reviewId === review.id)) return { kind: "known", review };
  const skip = (outcome: ReviewSkip): ReviewVerdict => ({ kind: "skip", review, outcome });
  if (review.state === "APPROVED") return skip("approved-seen");
  if (review.state === "DISMISSED") return skip("dismissed");
  if (!(Date.parse(review.submittedAt) > Date.parse(enabledAt))) return skip("before-enable");
  if (review.commit !== pr.headRefOid || pr.headRefOid !== delivered.headCommit.toLowerCase() || delivered.revision !== run.revision) return skip("stale-head");
  if (!review.body.trim()) return skip("no-text");
  if ((intake?.accepted ?? 0) >= REVIEW_LIMIT) return skip("limit");
  return { kind: "start", review, branch };
}

export function intentStillCurrent(intent: Pick<ReviewIntent, "reviewId" | "commit" | "submittedAt">, run: Pick<TeamRun, "delivery" | "pullRequest">, pr: PullRequestRead, ownerLogin: string, enabledAt: string) {
  const review = newestOwnerReview(pr, ownerLogin);
  return pr.state === "OPEN" && !pr.isCrossRepository && pr.baseRefName === run.delivery?.baseBranch && pr.headRefName === run.pullRequest?.branch &&
    review?.id === intent.reviewId && review.state === "CHANGES_REQUESTED" && pr.headRefOid === intent.commit && Date.parse(intent.submittedAt) > Date.parse(enabledAt);
}

export function reviewText(body: string, pullRequestUrl: string) {
  const text = body.trim();
  if (text.length <= REVIEW_TEXT_LIMIT) return text;
  const note = `\n\n[The review summary is longer than ${REVIEW_TEXT_LIMIT} characters and was cut here. Read the rest on the pull request: ${pullRequestUrl}]`;
  return text.slice(0, REVIEW_TEXT_LIMIT - note.length).replace(/[\uD800-\uDBFF]$/, "").trimEnd() + note;
}

export function reviewRequestId(runId: string, reviewId: string) {
  const hex = createHash("sha256").update(`review-feedback:${runId}:${reviewId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | parseInt(hex[16]!, 16) & 3).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function recordReviewOutcome(run: TeamRun, review: Pick<OwnerReview, "id" | "state" | "submittedAt">, outcome: ReviewFeedbackOutcome, at: string) {
  const entries = run.reviewFeedback ??= [];
  const entry = entries.find(item => item.reviewId === review.id);
  if (entry?.outcome === outcome && entry.state === review.state) return false;
  if (entry) Object.assign(entry, { state: review.state, outcome });
  else entries.push({ reviewId: review.id, state: review.state, submittedAt: review.submittedAt, receivedAt: at, outcome });
  if (entries.length > ENTRY_LIMIT) entries.splice(0, entries.length - ENTRY_LIMIT);
  return true;
}

export function markReviewApplied(intake: ReviewIntake, intent: ReviewIntent) {
  intent.state = "applied";
  if (!intake.handled.includes(intent.reviewId)) intake.handled = [...intake.handled, intent.reviewId].slice(-HANDLED_LIMIT);
  intake.accepted++;
}
