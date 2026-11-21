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

/** What the poller uses of TeamService. teams.ts builds it in `reviewFeedbackHost`. */
export type ReviewFeedbackHost = Pick<TeamKernel, "records" | "config" | "save" | "event" | "enqueue"> & {
  readonly key: Buffer;
  readonly directory: string;
  /** The service's own steer: its receipt makes a repeated request id a replay, never a second steer. */
  steer(id: string, input: { requestId: string; revision: number; text: string }, source: GithubReviewSource): Promise<unknown>;
  /** Whether the owner's halt holds this project. */
  held(projectId: string): boolean;
  now(): number;
};

type Marker = { enabled: boolean; enabledAt?: string };
const MARKER_FILE = "review-feedback.sealed", MARKER_SCOPE = "team:review-feedback";
/** Settled intents a run keeps, newest last. Pending intents are always kept. */
const SETTLED_INTENT_LIMIT = 20;
const READ_TIMEOUT_MS = 60_000;
/**
 * How long a read may stay open after the host stopped it (timeout or close). A child the host cannot signal, or one that
 * left a descendant holding its output, would otherwise keep the read, and so close() and idle(), waiting.
 */
const READ_SETTLE_MS = 5_000;
const UNWATCHED: Record<string, string> = {
  closed: "was closed", merged: "was merged", fork: "comes from a fork", base: "targets another base branch", branch: "is not on the branch this run delivered to", "not-delivered": "is not this run's delivery",
};

/**
 * Review feedback (INF-324, design sections 2 and 3). On the source refresher's minute timer it reads the pull request
 * of each delivered run and applies the owner's changes-requested review once, as a steer whose source is the review.
 * An accepted review is saved as an intent before its steer, so a host that stops between any two saves steers once:
 * a drain reads the team's receipt for the intent's request id first, and reads GitHub again only when there is none.
 * Reads go through `gh pr view` under a grant with the `pr` operation and no refs. Off unless configured.
 */
export class TeamReviewFeedback {
  private enabledAt?: string;
  private lastPoll = 0;
  private running?: Promise<void>;
  /** The one pass waiting for the running one. */
  private next?: { watch: boolean; done: Promise<void> };
  private stopTick?: () => void;
  private closed = false;
  /** Ends a read in flight at close; after close, nothing is saved or steered (checked after every wait). */
  private readonly abort = new AbortController();
  constructor(private readonly host: ReviewFeedbackHost) {}

  private settings() {
    const settings = this.host.config.github?.reviewFeedback;
    return settings?.enabled === true && settings.ownerLogin ? { ownerLogin: settings.ownerLogin, pollMs: (settings.pollMinutes ?? 5) * 60_000 } : undefined;
  }

  /**
   * Records when the switch was last turned on (decision 4), then drains the intents a stopped host left. `onTick`
   * registers a listener on the source refresher's timer and returns its remover. Returns the drain while one runs.
   */
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
  /** Stops the timer and the read in flight. Resolves once the current pass has ended. */
  close() { this.closed = true; this.stopTick?.(); this.abort.abort(); return this.settled(); }
  /** Resolves when no pass is running or waiting. */
  settled(): Promise<void> { return this.next?.done ?? this.running ?? Promise.resolve(); }
  /** One pass over every run: drain its pending intents, then read its pull request. */
  poll() {
    this.lastPoll = this.host.now();
    return this.pass(true);
  }

  /**
   * Passes run one at a time. Every request made while one runs, the startup drain included, joins a single next pass,
   * which watches when any of them asked it to, so a slow read never queues a backlog of passes.
   */
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

  /** Each pending intent: a receipt acknowledges it; otherwise, unless the owner's halt holds it, GitHub decides whether its steer runs. */
  private async drain(id: string, ownerLogin: string, enabledAt: string) {
    const pending = this.host.records.get(id)?.reviewIntake?.intents.filter(intent => intent.state === "pending") ?? [];
    for (const intent of pending) {
      if (this.closed) return;
      const done = await this.host.enqueue(() => {
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
        await this.host.enqueue(() => {
          const current = this.current(id, intent);
          if (current) this.settle(current, intent, "superseded", moved ? "GitHub shows the pull request on another base or head branch than the one this run delivered to."
            : "GitHub no longer shows this review as the owner's newest request for changes on the delivered head.");
        });
        continue;
      }
      await this.apply(id, intent);
    }
  }

  /** Reads a watched run's pull request and records what the owner's newest review does; a review that counts is saved as an intent, then applied. */
  private async watch(id: string, ownerLogin: string, enabledAt: string) {
    const snapshot = this.host.records.get(id);
    if (!snapshot || !watchedRun(snapshot.run, snapshot.reviewIntake) || snapshot.reviewIntake?.intents.some(intent => intent.state === "pending")) return;
    const target = pullRequestTarget(snapshot.run)!;
    const read = await this.read(snapshot, target);
    if (!read || this.closed) return;
    const intent = await this.host.enqueue(() => {
      const stored = this.host.records.get(id);
      if (this.closed || !stored || !watchedRun(stored.run, stored.reviewIntake) || stored.reviewIntake?.intents.some(item => item.state === "pending")) return undefined;
      const { run } = stored, verdict = reviewVerdict(stored, read, ownerLogin, enabledAt), at = new Date(this.host.now()).toISOString();
      // A record made before the branch was kept takes the branch this read confirmed (design section 4), whatever the
      // review does, so a steer can then continue on it. Every verdict but "unwatched" has confirmed it.
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

  /** Makes the intent's steer off the team queue, then acknowledges its result on it. A transient failure leaves it pending. */
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
    await this.host.enqueue(() => {
      const stored = this.current(id, intent);
      if (stored) this.settle(stored, intent, outcome, reason);
    });
  }

  /** The run's record while this intent is still pending in it and the poller is open; a closed poller acknowledges nothing. */
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

  /** One `gh pr view` read through the host's command path and a grant that can read and cannot write. Undefined on any failure. */
  private async read(stored: Stored, target: { repository: string; number: number }): Promise<PullRequestRead | undefined> {
    const { config } = this.host, run = stored.run;
    try {
      const result = await teamCommand({ command: "gh", args: pullRequestViewArgs(target) }, stored.root ?? config.teams?.workspaceDir ?? this.host.directory, this.abort.signal,
        READ_TIMEOUT_MS, config.teams?.commandPrefix, undefined, hostGithubGrantEnvironment(config, { sid: `review:${run.id}`, project: run.projectId, repo: target.repository, ops: ["pr"] }), READ_SETTLE_MS);
      if (result.exitCode !== 0 || result.interrupted || result.truncated) throw new Error(`gh exited with ${result.exitCode}${result.truncated ? " (output truncated)" : ""}`);
      return parsePullRequestView(result.stdout);
    } catch (error) {
      if (this.closed) return undefined;
      // The output may hold review text, so only the failure's kind is logged.
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
