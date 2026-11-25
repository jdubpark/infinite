import { readFileSync } from "node:fs";
import { join } from "node:path";
import { githubReviewSource, type GithubReviewSource } from "./team-types.js";
import { hostGithubGrantEnvironment } from "./github-grants.js";
import { teamCommand, TeamError } from "./team-workspace.js";
import { unseal, writeSealed } from "./vault.js";
import type { TeamKernel } from "./team-kernel.js";
import type { Stored } from "./teams.js";
import {
  type PullRequestRead, type ReviewIntent, intentStillCurrent, markReviewApplied, parsePullRequestView, pullRequestTarget,
  pullRequestViewArgs, recordedDeliveryBranch, recordReviewOutcome, reviewRequestId, reviewText, reviewVerdict, watchedRun,
} from "./review-feedback.js";

export type ReviewFeedbackHost = Pick<TeamKernel, "records" | "config" | "save" | "event" | "enqueue"> & {
  readonly key: Buffer;
  readonly directory: string;
  steer(id: string, input: { requestId: string; revision: number; text: string }, source: GithubReviewSource): Promise<unknown>;
  held(projectId: string): boolean;
  now(): number;
};

type Marker = { enabled: boolean; enabledAt?: string };
const MARKER_FILE = "review-feedback.sealed", MARKER_SCOPE = "team:review-feedback";
const SETTLED_INTENT_LIMIT = 20;
const READ_TIMEOUT_MS = 60_000;
const READ_SETTLE_MS = 5_000;
const UNWATCHED: Record<string, string> = {
  closed: "was closed", merged: "was merged", fork: "comes from a fork", base: "targets another base branch", branch: "is not on the branch this run delivered to", "not-delivered": "is not this run's delivery",
};

export class TeamReviewFeedback {
  private enabledAt?: string;
  private lastPoll = 0;
  private running?: Promise<void>;
  private next?: { watch: boolean; done: Promise<void> };
  private stopTick?: () => void;
  private closed = false;
  private readonly abort = new AbortController();
  constructor(private readonly host: ReviewFeedbackHost) {}

  private settings() {
    const settings = this.host.config.github?.reviewFeedback;
    return settings?.enabled === true && settings.ownerLogin ? { ownerLogin: settings.ownerLogin, pollMs: (settings.pollMinutes ?? 5) * 60_000 } : undefined;
  }

  start(onTick?: (listener: () => void) => () => void): Promise<void> | undefined {
    const settings = this.settings();
    try {
      const marker = this.readMarker();
      if (settings && !marker?.enabled) this.writeMarker({ enabled: true, enabledAt: new Date(this.host.now()).toISOString() });
      else if (!settings && marker?.enabled) this.writeMarker({ ...marker, enabled: false });
      this.enabledAt = settings ? this.readMarker()?.enabledAt : undefined;
    } catch (error) {
      console.warn("Review feedback stays off: its switch record cannot be read or written.", error instanceof Error ? error.message : "unknown error");
      return;
    }
    if (!settings) return;
    this.stopTick = onTick?.(() => { if (this.host.now() - this.lastPoll >= settings.pollMs) void this.poll(); });
    return this.pass(false);
  }
  close() { this.closed = true; this.stopTick?.(); this.abort.abort(); return this.settled(); }
  settled(): Promise<void> { return this.next?.done ?? this.running ?? Promise.resolve(); }
  poll() {
    this.lastPoll = this.host.now();
    return this.pass(true);
  }

  private pass(watch: boolean): Promise<void> {
    if (this.next) { this.next.watch ||= watch; return this.next.done; }
    if (!this.running) return this.begin(watch);
    const next = { watch, done: Promise.resolve() };
    next.done = this.running.then(() => { this.next = undefined; return this.begin(next.watch); });
    this.next = next;
    return next.done;
  }
  private begin(watch: boolean) {
    this.running = this.run(watch).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run(watch: boolean) {
    const settings = this.settings();
    if (!settings || !this.enabledAt || this.closed) return;
    for (const id of [...this.host.records.keys()]) {
      if (this.closed) return;
      try {
        await this.drain(id, settings.ownerLogin, this.enabledAt);
        if (watch) await this.watch(id, settings.ownerLogin, this.enabledAt);
      } catch (error) {
        console.warn("Review feedback could not process a run; it is retried at the next interval.", error instanceof Error ? error.message : "unknown error");
      }
    }
  }

  private async drain(id: string, ownerLogin: string, enabledAt: string) {
    const pending = this.host.records.get(id)?.reviewIntake?.intents.filter(intent => intent.state === "pending") ?? [];
    for (const intent of pending) {
      if (this.closed) return;
      const done = await this.host.enqueue(id, () => {
        const stored = this.current(id, intent);
        if (!stored) return true;
        if (!stored.receipts[intent.requestId]) return false;
        this.settle(stored, intent, "applied");
        return true;
      });
      if (done) continue;
      const stored = this.host.records.get(id);
      if (!stored || this.host.held(stored.run.projectId)) continue;
      const target = pullRequestTarget(stored.run);
      const read = target ? await this.read(stored, target) : undefined;
      if (this.closed) return;
      if (target && !read) continue;
      if (!read || !intentStillCurrent(intent, stored.run, read, ownerLogin, enabledAt)) {
        const moved = read && (read.baseRefName !== stored.run.delivery?.baseBranch || read.headRefName !== stored.run.pullRequest?.branch);
        await this.host.enqueue(id, () => {
          const current = this.current(id, intent);
          if (current) this.settle(current, intent, "superseded", moved ? "GitHub shows the pull request on another base or head branch than the one this run delivered to."
            : "GitHub no longer shows this review as the owner's newest request for changes on the delivered head.");
        });
        continue;
      }
      await this.apply(id, intent);
    }
  }

  private async watch(id: string, ownerLogin: string, enabledAt: string) {
    const snapshot = this.host.records.get(id);
    if (!snapshot || !watchedRun(snapshot.run, snapshot.reviewIntake) || snapshot.reviewIntake?.intents.some(intent => intent.state === "pending")) return;
    const target = pullRequestTarget(snapshot.run)!;
    const read = await this.read(snapshot, target);
    if (!read || this.closed) return;
    const intent = await this.host.enqueue(id, () => {
      const stored = this.host.records.get(id);
      if (this.closed || !stored || !watchedRun(stored.run, stored.reviewIntake) || stored.reviewIntake?.intents.some(item => item.state === "pending")) return undefined;
      const { run } = stored, verdict = reviewVerdict(stored, read, ownerLogin, enabledAt), at = new Date(this.host.now()).toISOString();
      const legacy = verdict.kind !== "unwatched" && !run.pullRequest!.branch;
      if (legacy) run.pullRequest!.branch = recordedDeliveryBranch(run, read);
      if (verdict.kind === "quiet" || verdict.kind === "known") {
        if (legacy) this.host.save(stored);
        return undefined;
      }
      if (verdict.kind === "unwatched") {
        (stored.reviewIntake ??= { intents: [], handled: [], accepted: 0 }).ended = { at, reason: verdict.reason };
        this.host.event(stored, `Review feedback stopped for this run: its pull request ${UNWATCHED[verdict.reason]}.`);
        this.host.save(stored);
        return undefined;
      }
      if (verdict.kind === "skip") {
        const changed = recordReviewOutcome(run, verdict.review, verdict.outcome, at);
        if (changed && verdict.outcome === "no-text") this.host.event(stored, `The owner's review ${verdict.review.id} requests changes with an empty summary. Write the requested changes in the review summary; inline comments are not read.`);
        if (changed && verdict.outcome === "limit") this.host.event(stored, `The owner's review ${verdict.review.id} was not taken: this run already accepted its limit of reviews. Start a new mission with consolidated direction.`);
        if (changed || legacy) this.host.save(stored);
        return undefined;
      }
      const intake = stored.reviewIntake ??= { intents: [], handled: [], accepted: 0 };
      const accepted: ReviewIntent = { reviewId: verdict.review.id, submittedAt: verdict.review.submittedAt, commit: verdict.review.commit!,
        text: reviewText(verdict.review.body, run.pullRequest!.pullRequestUrl), requestId: reviewRequestId(run.id, verdict.review.id), targetRevision: run.revision, state: "pending" };
      intake.intents.push(accepted);
      recordReviewOutcome(run, verdict.review, "accepted", at);
      this.host.save(stored);
      return accepted;
    });
    if (intent && !this.host.held(snapshot.run.projectId)) await this.apply(id, intent);
  }

  private async apply(id: string, intent: ReviewIntent) {
    if (this.closed) return;
    let outcome: "applied" | "refused" | undefined, reason: string | undefined;
    try {
      await this.host.steer(id, { requestId: intent.requestId, revision: intent.targetRevision, text: intent.text }, githubReviewSource(intent.reviewId));
      outcome = "applied";
    } catch (error) {
      if (error instanceof TeamError && error.code !== "team-operation-running") { outcome = "refused"; reason = error.message; }
      else console.warn("A review's steer did not run; it is retried at the next interval.", error instanceof Error ? error.message : "unknown error");
    }
    if (!outcome) return;
    await this.host.enqueue(id, () => {
      const stored = this.current(id, intent);
      if (stored) this.settle(stored, intent, outcome, reason);
    });
  }

  private current(id: string, intent: ReviewIntent) {
    if (this.closed) return undefined;
    const stored = this.host.records.get(id);
    const saved = stored?.reviewIntake?.intents.find(item => item.requestId === intent.requestId);
    if (saved && saved !== intent) Object.assign(intent, saved);
    return saved?.state === "pending" ? stored : undefined;
  }

  private settle(stored: Stored, intent: ReviewIntent, outcome: "applied" | "refused" | "superseded", reason?: string) {
    const intake = stored.reviewIntake!, saved = intake.intents.find(item => item.requestId === intent.requestId)!;
    const at = new Date(this.host.now()).toISOString(), review = { id: saved.reviewId, state: "CHANGES_REQUESTED" as const, submittedAt: saved.submittedAt };
    if (outcome === "applied") {
      markReviewApplied(intake, saved);
      this.host.event(stored, `The owner requested changes on the pull request (review ${saved.reviewId}). The run continues from its delivered commit at revision ${saved.targetRevision + 1}.`);
    } else {
      Object.assign(saved, { state: outcome, ...(reason ? { reason } : {}) });
      this.host.event(stored, `The owner's review ${saved.reviewId} was not applied: ${reason ?? "the run refused it."}`);
    }
    Object.assign(intent, saved);
    recordReviewOutcome(stored.run, review, outcome, at);
    const settled = intake.intents.filter(item => item.state !== "pending");
    if (settled.length > SETTLED_INTENT_LIMIT) intake.intents = intake.intents.filter(item => item.state === "pending" || settled.indexOf(item) >= settled.length - SETTLED_INTENT_LIMIT);
    this.host.save(stored);
  }

  private async read(stored: Stored, target: { repository: string; number: number }): Promise<PullRequestRead | undefined> {
    const { config } = this.host, run = stored.run;
    try {
      const result = await teamCommand({ command: "gh", args: pullRequestViewArgs(target) }, stored.root ?? config.teams?.workspaceDir ?? this.host.directory, this.abort.signal,
        READ_TIMEOUT_MS, config.teams?.commandPrefix, undefined, hostGithubGrantEnvironment(config, { sid: `review:${run.id}`, project: run.projectId, repo: target.repository, ops: ["pr"] }), READ_SETTLE_MS);
      if (result.exitCode !== 0 || result.interrupted || result.truncated) throw new Error(`gh exited with ${result.exitCode}${result.truncated ? " (output truncated)" : ""}`);
      return parsePullRequestView(result.stdout);
    } catch (error) {
      if (this.closed) return undefined;
      console.warn(`Review feedback could not read pull request ${target.repository}#${target.number}; it is read again at the next interval.`, error instanceof Error && !(error instanceof SyntaxError) && !("issues" in error) ? error.message : "unreadable output");
      return undefined;
    }
  }

  private readMarker(): Marker | undefined {
    try { return unseal<Marker>(this.host.key, MARKER_SCOPE, readFileSync(join(this.host.directory, MARKER_FILE), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }
  private writeMarker(marker: Marker) { writeSealed(join(this.host.directory, MARKER_FILE), this.host.key, MARKER_SCOPE, marker); }
}
