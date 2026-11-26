import { readFileSync } from "node:fs";
import { join } from "node:path";
import { githubReviewSource, type GithubReviewSource } from "./team-types.js";
import { hostGithubGrantEnvironment } from "./github-grants.js";
import { teamCommand, TeamError } from "./team-workspace.js";
import { unseal, writeSealed } from "./vault.js";
import type { TeamKernel } from "./team-kernel.js";
import type { Stored } from "./teams.js";
import type { MissionReviewDestination, MissionReviewTeams } from "./mission-review.js";
import {
  type PullRequestRead, type ReviewIntent, intentStillCurrent, markReviewApplied, parsePullRequestBranchView, parsePullRequestView, pullRequestBranchViewArgs,
  pullRequestTarget, pullRequestViewArgs, recordedDeliveryBranch, recordReviewOutcome, resolvePullRequestBranch, reviewRequestId, reviewText, reviewVerdict, watchedRun,
} from "./review-feedback.js";

export type ReviewFeedbackHost = Pick<TeamKernel, "records" | "config" | "save" | "event" | "enqueue"> & {
  readonly key: Buffer;
  readonly directory: string;
  steer(id: string, input: { requestId: string; revision: number; text: string }, source: GithubReviewSource): Promise<unknown>;
  held(projectId: string): boolean;
  now(): number;
  block?(stored: Stored, error: unknown): void;
  step?(stored: Stored): Promise<void>;
  rebuildDeliveryPrompts?(stored: Stored): () => void;
};

type LegacyBranchReadResult =
  | { kind: "aborted" }
  | { kind: "error"; error: TeamError }
  | { kind: "parsed"; parsed: ReturnType<typeof parsePullRequestBranchView> };

type Marker = { enabled: boolean; enabledAt?: string };
const MARKER_FILE = "review-feedback.sealed", MARKER_SCOPE = "team:review-feedback";
const SETTLED_INTENT_LIMIT = 20;
const READ_TIMEOUT_MS = 60_000;
const READ_SETTLE_MS = 5_000;
const LEGACY_BRANCH_PREFIX = "This run's pull request was recorded before the host kept its branch";
const TERMINAL_OR_PAUSED = new Set(["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"]);
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
  private missions?: MissionReviewDestination;
  private readonly abort = new AbortController();
  private readonly branchLookups = new Map<string, Promise<void>>();
  constructor(private readonly host: ReviewFeedbackHost) {}

  useMissions(destination: MissionReviewDestination): MissionReviewTeams {
    this.missions = destination;
    return { receipt: (runId, requestId) => Boolean(this.host.records.get(runId)?.receipts[requestId]), stillCurrent: (runId, reviewId) => this.stillCurrent(runId, reviewId) };
  }

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
  async settled(): Promise<void> {
    await Promise.allSettled([this.next?.done ?? this.running ?? Promise.resolve(), ...this.branchLookups.values()]);
  }
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
        if (!(intent.mission ? this.missions?.applied(intent.mission.missionId, intent.requestId) : stored.receipts[intent.requestId])) return false;
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
    if (!snapshot || !watchedRun(snapshot.run, snapshot.reviewIntake) || (snapshot.run.missionId && !this.missions) || snapshot.reviewIntake?.intents.some(intent => intent.state === "pending")) return;
    const target = pullRequestTarget(snapshot.run)!;
    const read = await this.read(snapshot, target);
    if (!read || this.closed) return;
    const intent = await this.host.enqueue(id, () => {
      const stored = this.host.records.get(id);
      if (this.closed || !stored || !watchedRun(stored.run, stored.reviewIntake) || stored.reviewIntake?.intents.some(item => item.state === "pending")) return undefined;
      const { run } = stored, verdict = reviewVerdict(stored, read, ownerLogin, enabledAt), at = new Date(this.host.now()).toISOString();
      const legacy = verdict.kind !== "unwatched" && !run.pullRequest!.branch;
      if (legacy) {
        run.pullRequest!.branch = recordedDeliveryBranch(run, read);
        this.host.rebuildDeliveryPrompts?.(stored);
      }
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
      const mission = run.missionId ? this.missions?.target(run.id) : undefined;
      if (run.missionId && !mission) return undefined;
      const intake = stored.reviewIntake ??= { intents: [], handled: [], accepted: 0 };
      const accepted: ReviewIntent = { reviewId: verdict.review.id, submittedAt: verdict.review.submittedAt, commit: verdict.review.commit!,
        text: reviewText(verdict.review.body, run.pullRequest!.pullRequestUrl), requestId: reviewRequestId(run.id, verdict.review.id), targetRevision: run.revision, state: "pending",
        ...(mission ? { mission: { ...mission, pullRequestUrl: run.pullRequest!.pullRequestUrl } } : {}) };
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
      if (!intent.mission) await this.host.steer(id, { requestId: intent.requestId, revision: intent.targetRevision, text: intent.text }, githubReviewSource(intent.reviewId));
      else if (await this.missions?.direct(intent.mission.missionId, { requestId: intent.requestId, runId: id, subtaskId: intent.mission.subtaskId, reviewId: intent.reviewId,
        pullRequestUrl: intent.mission.pullRequestUrl, text: intent.text, revision: intent.targetRevision, headCommit: intent.commit }) !== "applied") return;
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

  private async stillCurrent(id: string, reviewId: string) {
    const settings = this.settings(), stored = this.host.records.get(id), enabledAt = this.enabledAt;
    const intent = stored?.reviewIntake?.intents.find(item => item.reviewId === reviewId && item.state === "applied"), target = stored && pullRequestTarget(stored.run);
    if (this.closed) return undefined;
    if (!settings || !enabledAt || !stored || !intent || !target) return false;
    const read = await this.read(stored, target);
    return read ? intentStillCurrent(intent, stored.run, read, settings.ownerLogin, enabledAt) : undefined;
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
      if (!saved.mission) this.host.event(stored, `The owner requested changes on the pull request (review ${saved.reviewId}). The run continues from its delivered commit at revision ${saved.targetRevision + 1}.`);
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

  ensureLegacyPullRequestBranch(stored: Stored): boolean {
    const run = stored.run;
    if (!run.pullRequest || run.pullRequest.branch) return true;
    if (this.closed || this.abort.signal.aborted) return false;
    const target = pullRequestTarget(run);
    if (!target) throw new TeamError(409, "delivery-branch-unknown", `${LEGACY_BRANCH_PREFIX}, and its pull request URL does not match the pinned delivery repository. Start a new run for further changes.`);
    if (this.branchLookups.has(run.id)) return false;
    const snapshot = { runId: run.id, projectId: run.projectId, root: stored.root, revision: run.revision, pullRequestUrl: run.pullRequest.pullRequestUrl };
    const task = this.completeLegacyBranchLookup(stored, snapshot, target).finally(() => {
      if (this.branchLookups.get(run.id) === task) this.branchLookups.delete(run.id);
    });
    this.branchLookups.set(run.id, task);
    return false;
  }

  async resolveLegacyPullRequestBranch(stored: Stored): Promise<string | undefined> {
    const run = stored.run;
    if (!run.pullRequest) return undefined;
    if (run.pullRequest.branch) return run.pullRequest.branch;
    if (this.closed || this.abort.signal.aborted) throw new TeamError(503, "host-closing", "The host is shutting down; retry steering after it restarts.");
    const target = pullRequestTarget(run);
    if (!target) throw new TeamError(409, "delivery-branch-unknown", `${LEGACY_BRANCH_PREFIX}, and its pull request URL does not match the pinned delivery repository. Start a new run for further changes.`);
    const outcome = await this.readLegacyBranch({ runId: run.id, projectId: run.projectId, root: stored.root }, target);
    if (outcome.kind === "aborted") throw new TeamError(503, "host-closing", "The host is shutting down; retry steering after it restarts.");
    if (outcome.kind === "error") throw outcome.error;
    if (this.closed || this.host.records.get(run.id) !== stored || !stored.run.pullRequest) {
      throw new TeamError(409, "delivery-branch-unknown", `${LEGACY_BRANCH_PREFIX}, and the run changed while reading GitHub.`);
    }
    if (stored.run.pullRequest.branch) return stored.run.pullRequest.branch;
    const resolution = resolvePullRequestBranch(stored.run, outcome.parsed);
    if (!resolution.ok) {
      throw new TeamError(409, "delivery-branch-unknown", `${LEGACY_BRANCH_PREFIX}, and ${target.repository}#${target.number} ${UNWATCHED[resolution.reason]}, so the host will not continue it. Start a new run for further changes.`);
    }
    this.persistResolvedBranch(stored, resolution.branch);
    return resolution.branch;
  }

  private async completeLegacyBranchLookup(
    stored: Stored,
    snapshot: { runId: string; projectId: string; root?: string; revision: number; pullRequestUrl: string },
    target: { repository: string; number: number },
  ): Promise<void> {
    const outcome = await this.readLegacyBranch(snapshot, target);
    if (outcome.kind === "aborted" || this.closed || this.abort.signal.aborted) return;
    await this.host.enqueue(snapshot.runId, async () => {
      const current = this.host.records.get(snapshot.runId);
      if (this.closed || this.abort.signal.aborted || !current || current !== stored) return;
      const run = current.run;
      if (!run.pullRequest || run.pullRequest.pullRequestUrl !== snapshot.pullRequestUrl || run.pullRequest.branch) return;
      if (run.revision !== snapshot.revision || current.halt || TERMINAL_OR_PAUSED.has(run.status)) return;
      if (outcome.kind === "error") {
        this.host.block?.(current, outcome.error);
        return;
      }
      const resolution = resolvePullRequestBranch(run, outcome.parsed);
      if (!resolution.ok) {
        this.host.block?.(current, new TeamError(409, "delivery-branch-unknown", `${LEGACY_BRANCH_PREFIX}, and ${target.repository}#${target.number} ${UNWATCHED[resolution.reason]}, so the host will not continue it. Start a new run for further changes.`));
        return;
      }
      this.persistResolvedBranch(current, resolution.branch);
      if (!this.closed && !this.abort.signal.aborted) await this.host.step?.(current);
    }).catch(() => {});
  }

  private persistResolvedBranch(stored: Stored, branch: string): void {
    stored.run.pullRequest!.branch = branch;
    const rollbackPrompts = this.host.rebuildDeliveryPrompts?.(stored);
    try { this.host.save(stored); }
    catch (error) {
      delete stored.run.pullRequest!.branch;
      rollbackPrompts?.();
      throw error;
    }
  }

  private async readLegacyBranch(
    snapshot: { runId: string; projectId: string; root?: string },
    target: { repository: string; number: number },
  ): Promise<LegacyBranchReadResult> {
    if (this.closed || this.abort.signal.aborted) return { kind: "aborted" };
    let result: Awaited<ReturnType<typeof teamCommand>>;
    try {
      const { config } = this.host;
      result = await teamCommand(
        { command: "gh", args: pullRequestBranchViewArgs(target) },
        snapshot.root ?? config.teams?.workspaceDir ?? this.host.directory,
        this.abort.signal,
        READ_TIMEOUT_MS,
        config.teams?.commandPrefix,
        undefined,
        hostGithubGrantEnvironment(config, { sid: `review:${snapshot.runId}`, project: snapshot.projectId, repo: target.repository, ops: ["pr"] }),
        READ_SETTLE_MS,
      );
    } catch {
      if (this.closed || this.abort.signal.aborted) return { kind: "aborted" };
      return { kind: "error", error: new TeamError(409, "delivery-branch-unknown", `${LEGACY_BRANCH_PREFIX}, and reading ${target.repository}#${target.number} on GitHub failed because gh could not be started. Check GitHub CLI access and retry, or start a new run.`) };
    }
    if (this.closed || this.abort.signal.aborted) return { kind: "aborted" };
    if (result.exitCode !== 0 || result.interrupted || result.truncated) {
      const detail = result.interrupted ? "command interrupted" : result.truncated ? "output truncated" : `gh exited with ${result.exitCode ?? "unknown"}`;
      return { kind: "error", error: new TeamError(409, "delivery-branch-unknown", `${LEGACY_BRANCH_PREFIX}, and reading ${target.repository}#${target.number} on GitHub failed (${detail}). Check GitHub CLI access and retry, or start a new run.`) };
    }
    try {
      return { kind: "parsed", parsed: parsePullRequestBranchView(result.stdout) };
    } catch {
      return { kind: "error", error: new TeamError(409, "delivery-branch-unknown", `${LEGACY_BRANCH_PREFIX}, and GitHub returned an unreadable pull request or invalid head branch for ${target.repository}#${target.number}. Retry, or start a new run.`) };
    }
  }

  private runPullRequestView(stored: Stored, target: { repository: string; number: number }, args: string[]) {
    const { config } = this.host, run = stored.run;
    return teamCommand({ command: "gh", args }, stored.root ?? config.teams?.workspaceDir ?? this.host.directory, this.abort.signal,
      READ_TIMEOUT_MS, config.teams?.commandPrefix, undefined, hostGithubGrantEnvironment(config, { sid: `review:${run.id}`, project: run.projectId, repo: target.repository, ops: ["pr"] }), READ_SETTLE_MS);
  }

  private async read(stored: Stored, target: { repository: string; number: number }): Promise<PullRequestRead | undefined> {
    try {
      const result = await this.runPullRequestView(stored, target, pullRequestViewArgs(target));
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
