import { createHash } from "node:crypto";
import type { ConnectorSource } from "./mcp-types.js";
import type { Mission, MissionSubtask } from "./mission-types.js";
import { queuedForwardText, type MissionMessage } from "./team-prompts.js";
import { githubReviewSource, type TeamView } from "./team-types.js";
import { TeamError } from "./team-workspace.js";
import { deterministicUuid } from "./intake-types.js";
import type { TeamService } from "./teams.js";
import { settleCoordinatorReport, type DeliveredUnappliedBatch } from "./mission-coordinator.js";

const reopenedMissionMinutes = (mission: Pick<Mission, "maxMinutes">) => mission.maxMinutes;
const READ_RETRY_MS = 60_000;
const live = new Set<Mission["status"]>(["planning", "working", "needs-input"]);

export type MissionReviewTarget = { missionId: string; subtaskId: string };
export type ReviewDirection = { requestId: string; runId: string; subtaskId: string; reviewId: string; pullRequestUrl: string; text: string; revision: number; headCommit: string };
export type MissionReviewDestination = {
  target(runId: string): MissionReviewTarget | undefined;
  applied(missionId: string, requestId: string): boolean;
  direct(missionId: string, direction: ReviewDirection): Promise<"applied" | "waiting">;
};
export type MissionReviewTeams = {
  receipt(runId: string, requestId: string): boolean;
  stillCurrent(runId: string, reviewId: string): Promise<boolean | undefined>;
};
type ReviewFields = Omit<ReviewDirection, "text"> & { at: string };
type ForwardingReview = ReviewFields & { state: "forwarding"; forwardRequestId: string };
export type MissionReviewRecord =
  | ReviewFields & { state: "open" }
  | ForwardingReview
  | ReviewFields & { state: "forwarded"; forwardRequestId: string }
  | ReviewFields & { state: "superseded" | "refused"; reason: string };
export type ReviewForwardOp = { kind: "review-forward"; subtaskId: string; teamId: string; requestId: string; text: string; source?: ConnectorSource };
type ForwardRequest = { kind: "none" } | { kind: "refused"; reason: string } | { kind: "late" } | { kind: "queued" } | { kind: "waiting" };
type ForwardRead = { state: "reading" } | { state: "read"; current: boolean } | { state: "failed"; at: number };
type MissionReviewStored = {
  mission: Mission;
  receipts: Record<string, string>;
  inbox: MissionMessage[];
  notes: MissionMessage[];
  deliveredUnapplied?: DeliveredUnappliedBatch[];
  notified: string[];
  ops: { push(op: ReviewForwardOp): number };
  refusals: number;
  ownerInputs?: number;
  reviews?: MissionReviewRecord[];
};
type MissionReviewHost<S extends MissionReviewStored> = {
  readonly records: ReadonlyMap<string, S>;
  readonly teams: Pick<TeamService, "get" | "steer">;
  enqueue<T>(id: string, task: () => T | Promise<T>): Promise<T>;
  save(stored: S): void;
  event(stored: S, text: string): void;
  follow(subtask: MissionSubtask, team: TeamView): void;
  held(projectId: string): boolean;
  reportHeld(stored: S, subtask: MissionSubtask, reviewId: string): void;
  steeringFull(mission: Mission, text: string): boolean;
};

const notFound = (error: unknown) => error instanceof TeamError && error.code === "team-not-found";
const directionReceipt = (direction: ReviewDirection) => createHash("sha256").update(JSON.stringify({ action: "review-direction", ...direction })).digest("hex");
const fieldsOf = ({ requestId, runId, subtaskId, reviewId, pullRequestUrl, revision, headCommit, at }: MissionReviewRecord): ReviewFields =>
  ({ requestId, runId, subtaskId, reviewId, pullRequestUrl, revision, headCommit, at });

export class MissionReview<S extends MissionReviewStored> implements MissionReviewDestination {
  private teams: MissionReviewTeams = { receipt: () => false, stillCurrent: async () => undefined };
  private readonly reads = new Map<string, ForwardRead>();
  constructor(private readonly host: MissionReviewHost<S>) {}

  connect(teams: MissionReviewTeams) { this.teams = teams; }

  target(runId: string): MissionReviewTarget | undefined {
    for (const { mission } of this.host.records.values()) {
      const subtask = mission.subtasks.find(item => item.teamId === runId);
      if (subtask) return { missionId: mission.id, subtaskId: subtask.id };
    }
    return undefined;
  }

  applied(missionId: string, requestId: string) {
    return Boolean(this.host.records.get(missionId)?.receipts[requestId]);
  }

  direct(missionId: string, direction: ReviewDirection) {
    return this.host.enqueue(missionId, (): "applied" | "waiting" => {
      const stored = this.host.records.get(missionId);
      if (!stored) throw new TeamError(404, "mission-not-found", "This mission does not exist.");
      const mission = stored.mission, fingerprint = directionReceipt(direction), prior = stored.receipts[direction.requestId];
      if (prior && prior !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different mission action.");
      if (prior) return "applied";
      const subtask = mission.subtasks.find(item => item.id === direction.subtaskId);
      if (!subtask || subtask.teamId !== direction.runId) throw new TeamError(409, "mission-review-subtask", "The reviewed run is no longer a subtask of this mission.");
      if (mission.status === "cancelled") throw new TeamError(409, "mission-cancelled", "This mission has been cancelled.");
      if (mission.status === "paused" || mission.status === "blocked") return this.waiting(stored, direction);
      if (this.host.steeringFull(mission, direction.text)) throw new TeamError(409, "mission-steering-limit", "Start a new mission with consolidated directions.");
      if (mission.status === "ready-for-review") this.reopen(stored);
      this.record(stored, direction, fingerprint);
      return "applied";
    });
  }

  queueForward(stored: S, subtask: MissionSubtask, text: string, sawReview: boolean, source?: ConnectorSource): ForwardRequest {
    const review = subtask.status === "done" ? stored.reviews?.filter(item => item.subtaskId === subtask.id && item.state === "open").at(-1) : undefined;
    if (!review) return this.alreadyQueued(stored, subtask);
    if (!sawReview || stored.inbox.some(message => message.type === "review-direction" && message.reviewId === review.reviewId)) {
      this.host.event(stored, `The coordinator's steer-subtask report for subtask ${subtask.id} was not applied: that attempt had not received the owner's latest direction or review. A new attempt will consider it.`);
      stored.inbox.push({ type: "refused", kind: "steer-subtask", reason: `Your previous attempt had not received the owner's latest direction or review. Read it before you forward the owner's review of subtask ${subtask.id} with steer-subtask.` });
      return { kind: "late" };
    }
    const moved = this.moved(review);
    if (moved) {
      this.replace(stored, review, { ...fieldsOf(review), state: "refused", reason: moved });
      return { kind: "refused", reason: moved };
    }
    const forwardRequestId = deterministicUuid("mission-review-forward", `${stored.mission.id}:${review.requestId}`);
    this.replace(stored, review, { ...fieldsOf(review), state: "forwarding", forwardRequestId });
    this.host.event(stored, `The coordinator forwarded the owner's review ${review.reviewId} to subtask ${subtask.id}.`);
    stored.ops.push({ kind: "review-forward", subtaskId: subtask.id, teamId: review.runId, requestId: forwardRequestId, text, ...(source ? { source } : {}) });
    for (const batch of stored.deliveredUnapplied ?? []) batch.inbox = batch.inbox.filter(message => message.type !== "review-direction" || message.reviewId !== review.reviewId);
    return { kind: "queued" };
  }

  queuedForwards(stored: S) {
    return (stored.reviews ?? []).filter(item => item.state === "forwarding").map(item => ({ subtaskId: item.subtaskId, reviewId: item.reviewId }));
  }

  private alreadyQueued(stored: S, subtask: MissionSubtask): ForwardRequest {
    const queued = subtask.status === "done" ? stored.reviews?.find(item => item.subtaskId === subtask.id && item.state === "forwarding") : undefined;
    if (!queued) return { kind: "none" };
    const reason = queuedForwardText(subtask.id, queued.reviewId);
    this.host.event(stored, `The coordinator's steer-subtask report for subtask ${subtask.id} was not applied: ${reason}`);
    stored.notes.push({ type: "refused", kind: "steer-subtask", reason });
    return { kind: "waiting" };
  }

  async applyForward(stored: S, op: ReviewForwardOp): Promise<boolean> {
    const mission = stored.mission, read = this.taken(op.requestId);
    const review = stored.reviews?.find((item): item is ForwardingReview => item.state === "forwarding" && item.forwardRequestId === op.requestId);
    if (!review) return false;
    if (this.teams.receipt(op.teamId, op.requestId)) return this.used(stored, review);
    if (mission.status === "paused" || mission.status === "blocked" && mission.stopReason === "deadline") return true;
    if (!live.has(mission.status)) return this.end(stored, review, "refused", "The mission stopped before the forward reached the subteam.");
    const subtask = mission.subtasks.find(item => item.id === op.subtaskId);
    if (subtask && this.host.held(subtask.repoProjectId)) {
      this.host.reportHeld(stored, subtask, review.reviewId);
      return true;
    }
    if (!read) return this.read(op, review);
    if (!read.current) return this.end(stored, review, "superseded", "GitHub no longer shows it as the owner's newest request for changes on the delivered head, or review feedback was switched off.");
    const moved = this.moved(review);
    if (moved) return this.end(stored, review, "refused", moved);
    try {
      await this.host.teams.steer(op.teamId, { requestId: op.requestId, revision: review.revision, text: op.text }, op.source ?? "coordinator");
    } catch (error) {
      if (!(error instanceof TeamError)) throw error;
      if (["members-stopping", "team-operation-running", "team-paused"].includes(error.code)) return true;
      return this.end(stored, review, "refused", error.message);
    }
    return this.used(stored, review);
  }

  private taken(requestId: string) {
    const read = this.reads.get(requestId);
    if (read?.state !== "read") return undefined;
    this.reads.delete(requestId);
    return read;
  }

  private read(op: ReviewForwardOp, review: ForwardingReview) {
    const prior = this.reads.get(op.requestId);
    if (prior?.state === "reading" || prior?.state === "failed" && Date.now() - prior.at < READ_RETRY_MS) return true;
    this.reads.set(op.requestId, { state: "reading" });
    void this.teams.stillCurrent(op.teamId, review.reviewId).catch(() => undefined)
      .then(current => this.reads.set(op.requestId, current === undefined ? { state: "failed", at: Date.now() } : { state: "read", current }));
    return true;
  }

  private record(stored: S, direction: ReviewDirection, fingerprint: string) {
    const mission = stored.mission, at = new Date().toISOString(), { text, ...fields } = direction;
    stored.receipts[direction.requestId] = fingerprint;
    mission.revision++;
    mission.steering.push({ text, revision: mission.revision, at, source: githubReviewSource(direction.reviewId) });
    stored.ownerInputs = (stored.ownerInputs ?? 0) + 1;
    stored.inbox.push({ type: "review-direction", subtaskId: direction.subtaskId, teamId: direction.runId, reviewId: direction.reviewId, pullRequestUrl: direction.pullRequestUrl, text });
    const superseded = (item: MissionReviewRecord): MissionReviewRecord => item.subtaskId === direction.subtaskId && item.state === "open"
      ? { ...fieldsOf(item), state: "superseded", reason: "A newer review of the same pull request replaced it." } : item;
    stored.reviews = [...(stored.reviews ?? []).map(superseded), { ...fields, at, state: "open" }];
    this.host.event(stored, `The owner's review was delivered to the coordinator: changes requested on the pull request of subtask ${direction.subtaskId} (review ${direction.reviewId}).`);
    this.host.save(stored);
  }

  private waiting(stored: S, direction: ReviewDirection) {
    const key = `review-waiting:${direction.requestId}`;
    if (!stored.notified.includes(key)) {
      stored.notified.push(key);
      this.host.event(stored, `A review is waiting: the owner requested changes on the pull request of subtask ${direction.subtaskId} (review ${direction.reviewId}). It reaches the coordinator when the mission is live again.`);
      this.host.save(stored);
    }
    return "waiting" as const;
  }

  private reopen(stored: S) {
    const mission = stored.mission, minutes = reopenedMissionMinutes(mission);
    if (mission.result) (mission.earlierResults ??= []).push(mission.result);
    delete mission.result;
    mission.status = "working";
    mission.deadlineAt = new Date(Date.now() + minutes * 60000).toISOString();
    this.host.event(stored, `The owner's review reopened the mission with ${minutes} more minutes of working time. Its earlier result is kept in its history.`);
  }

  private moved(review: MissionReviewRecord) {
    let team: TeamView;
    try { team = this.host.teams.get(review.runId); }
    catch (error) {
      if (notFound(error)) return "The subteam's run no longer exists.";
      throw error;
    }
    if (team.workspaceRemovedAt) return "The subteam's workspace was removed, so its pull request cannot be continued. Dispatch a follow-up subtask instead.";
    const pullRequest = team.pullRequest;
    if (team.status !== "ready-for-review" || team.revision !== review.revision || pullRequest?.revision !== review.revision || pullRequest.headCommit.toLowerCase() !== review.headCommit.toLowerCase())
      return "The subteam's run no longer waits for review at the reviewed revision and head.";
    return undefined;
  }

  private replace(stored: S, from: MissionReviewRecord, to: MissionReviewRecord) {
    stored.reviews = stored.reviews?.map(item => item === from ? to : item);
  }

  private used(stored: S, review: ForwardingReview) {
    this.replace(stored, review, { ...review, state: "forwarded" });
    const subtask = stored.mission.subtasks.find(item => item.id === review.subtaskId);
    try {
      if (subtask) this.host.follow(subtask, this.host.teams.get(review.runId));
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    settleCoordinatorReport(stored, "accepted");
    this.host.event(stored, `Subtask ${review.subtaskId} received the owner's review ${review.reviewId} through the coordinator and continues from its delivered commit.`);
    return false;
  }

  private end(stored: S, review: ForwardingReview, state: "superseded" | "refused", reason: string) {
    this.replace(stored, review, { ...fieldsOf(review), state, reason });
    const text = `The owner's review ${review.reviewId} of subtask ${review.subtaskId} was not forwarded: ${reason}`;
    this.host.event(stored, text);
    stored.inbox.push({ type: "refused", kind: "steer-subtask", reason: text });
    return false;
  }
}
