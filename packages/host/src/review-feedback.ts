import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReviewFeedbackEntry, ReviewFeedbackOutcome, TeamRun } from "./team-types.js";

/**
 * Review feedback (INF-324): which pull request the host watches, how one `gh pr view` read is parsed, and which of the
 * owner's reviews starts work. Pure; team-review-feedback.ts reads GitHub and applies the result. A review is owner
 * direction and never approval, and only the configured owner login counts.
 */

/** A review's text is bounded to this many characters, the most a steer takes. */
export const REVIEW_TEXT_LIMIT = 8000;
/** Reviews one run accepts before further direction needs a new mission. */
export const REVIEW_LIMIT = 3;
const HANDLED_LIMIT = 20;
const ENTRY_LIMIT = 20;
/** The fields of one read: `gh pr view NUMBER --json FIELDS --repo REPOSITORY`, a read the GitHub proxy allows under `pr`. */
export const PULL_REQUEST_FIELDS = "state,isCrossRepository,baseRefName,headRefName,headRefOid,reviews";

/** Saved in the run's host-private record before its call is made; see the design's section 3. */
export type ReviewIntent = {
  reviewId: string; submittedAt: string; commit: string;
  /** The bounded summary as read at acceptance. A later edit of the review never replaces it. */
  text: string;
  requestId: string; targetRevision: number;
  state: "pending" | "applied" | "superseded" | "refused"; reason?: string;
};
/** A run's host-private review intake: intents, the ids of applied reviews (newest 20), their count, and why intake ended. */
export type ReviewIntake = { intents: ReviewIntent[]; handled: string[]; accepted: number; ended?: { at: string; reason: string } };
export type OwnerReview = { id: string; state: ReviewFeedbackEntry["state"]; submittedAt: string; body: string; commit?: string };

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i).transform(value => value.toLowerCase());
/**
 * GitHub's documented field names for a pull request review as `gh` prints them. Not yet checked against a real review
 * on the installed `gh` (design, "Not verified"); everything the host reads of a review passes through this schema.
 */
const reviewSchema = z.object({
  id: z.string().min(1).max(200),
  author: z.object({ login: z.string().max(100) }).passthrough().nullable().optional(),
  state: z.string().max(40),
  submittedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  body: z.string().max(1_000_000).nullable().optional(),
  commit: z.object({ oid: commit }).passthrough().nullable().optional(),
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

/** The one place the output of `gh pr view --json` is interpreted. Throws on anything else. */
export function parsePullRequestView(stdout: string): PullRequestRead {
  return pullRequestSchema.parse(JSON.parse(stdout));
}

/** The repository and number of the run's recorded pull request, when its URL is one in the delivery repository. */
export function pullRequestTarget(run: Pick<TeamRun, "pullRequest" | "delivery">) {
  if (!run.pullRequest || !run.delivery) return undefined;
  let url: URL;
  try { url = new URL(run.pullRequest.pullRequestUrl); } catch { return undefined; }
  const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]{0,9})$/.exec(url.pathname);
  if (url.origin !== "https://github.com" || !match || match[1]!.toLowerCase() !== run.delivery.repository.toLowerCase()) return undefined;
  return { repository: run.delivery.repository, number: Number(match[2]) };
}

/** The `gh` arguments of one read. The proxy's `pr view` allows them under the `pr` operation with no refs. */
export function pullRequestViewArgs(target: { repository: string; number: number }) {
  return ["pr", "view", String(target.number), "--json", PULL_REQUEST_FIELDS, "--repo", target.repository];
}

/**
 * A run whose pull request the host reads: delivered as a `pr` at its current revision, ready for review, its workspace
 * still present, and not owned by a goal, a handoff, or a replay. Mission runs wait for the mission's destination
 * (build step 4), so the first build leaves them out.
 */
export function watchedRun(run: TeamRun, intake?: ReviewIntake) {
  return run.status === "ready-for-review" && run.delivery?.mode === "pr" && run.pullRequest?.revision === run.revision &&
    !run.workspaceRemovedAt && !run.goal && !run.handoff && !run.missionId && !run.replay && !intake?.ended && pullRequestTarget(run) !== undefined;
}

/**
 * The branch the run delivered to. A record made before the branch was kept takes the read's head branch, and only when
 * that is the run's branch or the branch its delivered head was published to.
 */
export function recordedDeliveryBranch(run: Pick<TeamRun, "pullRequest" | "branch" | "publication">, pr: Pick<PullRequestRead, "headRefName">) {
  if (!run.pullRequest) return undefined;
  if (run.pullRequest.branch) return run.pullRequest.branch;
  const published = run.publication?.commit === run.pullRequest.headCommit ? run.publication.branch : undefined;
  return pr.headRefName === run.branch || pr.headRefName === published ? pr.headRefName : undefined;
}

/**
 * The event of a workspace removal that ends review intake for a watched pull request (decision 3), or undefined when
 * the removal ends nothing. `run` is read as it was just before its removal started.
 */
export function intakeEndedByRemoval(run: TeamRun, intake: ReviewIntake | undefined, enabled: boolean) {
  return enabled && watchedRun({ ...run, workspaceRemovedAt: undefined }, intake)
    ? "Review feedback is no longer taken for this pull request: the run's workspace was removed. Start a new mission for further changes."
    : undefined;
}

const COUNTED = new Set(["CHANGES_REQUESTED", "APPROVED", "DISMISSED"]);
/** The owner's newest review in a counted state, by submission time and then by review id. A comment-only review never counts. */
export function newestOwnerReview(pr: Pick<PullRequestRead, "reviews">, ownerLogin: string): OwnerReview | undefined {
  const owner = ownerLogin.toLowerCase();
  let newest: OwnerReview | undefined;
  for (const review of pr.reviews) {
    if (review.author?.login.toLowerCase() !== owner || !COUNTED.has(review.state) || !review.submittedAt) continue;
    const candidate: OwnerReview = { id: review.id, state: review.state as OwnerReview["state"], submittedAt: review.submittedAt, body: review.body ?? "",
      ...(review.commit ? { commit: review.commit.oid } : {}) };
    const order = newest ? Date.parse(candidate.submittedAt) - Date.parse(newest.submittedAt) : 1;
    if (order > 0 || order === 0 && newest && candidate.id > newest.id) newest = candidate;
  }
  return newest;
}

export type ReviewSkip = Extract<ReviewFeedbackOutcome, "approved-seen" | "dismissed" | "stale-head" | "no-text" | "before-enable" | "limit">;
export type ReviewVerdict =
  /** The run leaves the watched set: the pull request closed, merged, came from a fork, or is not the delivered one. */
  | { kind: "unwatched"; reason: "closed" | "merged" | "fork" | "base" | "branch" | "not-delivered" }
  /** No review by the owner in a counted state. */
  | { kind: "quiet" }
  /** The newest review already has an intent or was applied; nothing more is recorded for it. */
  | { kind: "known"; review: OwnerReview }
  | { kind: "skip"; review: OwnerReview; outcome: ReviewSkip }
  | { kind: "start"; review: OwnerReview; branch: string };

/**
 * Section 1 of the design: whether the owner's newest review starts work on this run. `subject` is the run's record with
 * its host-private intake. `enabledAt` is when review feedback was last switched on for this host.
 */
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
  // A review already taken keeps the outcome it was given; checking it again would only record a later state over it.
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

/**
 * Whether a saved intent still holds against a fresh read: its review is still the owner's newest and still requests
 * changes, it came after the switch was last turned on, and the pull request is open with its head unmoved.
 */
export function intentStillCurrent(intent: Pick<ReviewIntent, "reviewId" | "commit" | "submittedAt">, pr: PullRequestRead, ownerLogin: string, enabledAt: string) {
  const review = newestOwnerReview(pr, ownerLogin);
  return pr.state === "OPEN" && !pr.isCrossRepository && review?.id === intent.reviewId && review.state === "CHANGES_REQUESTED" &&
    pr.headRefOid === intent.commit && Date.parse(intent.submittedAt) > Date.parse(enabledAt);
}

/** The review summary as steering text: at most REVIEW_TEXT_LIMIT characters, with a note and the link when it was longer. */
export function reviewText(body: string, pullRequestUrl: string) {
  const text = body.trim();
  if (text.length <= REVIEW_TEXT_LIMIT) return text;
  const note = `\n\n[The review summary is longer than ${REVIEW_TEXT_LIMIT} characters and was cut here. Read the rest on the pull request: ${pullRequestUrl}]`;
  return text.slice(0, REVIEW_TEXT_LIMIT - note.length).replace(/[\uD800-\uDBFF]$/, "").trimEnd() + note;
}

/** The steer's request id: stable for a run and a review, so a replay is the same request. A UUID, as a steer requires. */
export function reviewRequestId(runId: string, reviewId: string) {
  const hex = createHash("sha256").update(`review-feedback:${runId}:${reviewId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | parseInt(hex[16]!, 16) & 3).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Records what a review did on the run's view, once per review and outcome. True when the view changed. */
export function recordReviewOutcome(run: TeamRun, review: Pick<OwnerReview, "id" | "state" | "submittedAt">, outcome: ReviewFeedbackOutcome, at: string) {
  const entries = run.reviewFeedback ??= [];
  const entry = entries.find(item => item.reviewId === review.id);
  if (entry?.outcome === outcome && entry.state === review.state) return false;
  if (entry) Object.assign(entry, { state: review.state, outcome });
  else entries.push({ reviewId: review.id, state: review.state, submittedAt: review.submittedAt, receivedAt: at, outcome });
  if (entries.length > ENTRY_LIMIT) entries.splice(0, entries.length - ENTRY_LIMIT);
  return true;
}

/** An applied review: its id enters the handled list (newest 20) and counts toward the run's limit. */
export function markReviewApplied(intake: ReviewIntake, intent: ReviewIntent) {
  intent.state = "applied";
  if (!intake.handled.includes(intent.reviewId)) intake.handled = [...intake.handled, intent.reviewId].slice(-HANDLED_LIMIT);
  intake.accepted++;
}
