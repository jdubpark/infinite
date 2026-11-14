import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceTx } from "./evidence/types.js";
import { captureSettings, EVAL_RETENTION_DAYS_DEFAULT, type EvalProjectSettings } from "./eval-config.js";
import { LATER_FILES_MAX, promotion, referenceVerdict, REFERENCE_MAX_FILES, startVerdict, type PromotionFacts } from "./eval-rules.js";
import { type Decide, type MarkerOutcome, type MaterialResult, capturedTaskId, completeApproval, completeMaterial, evalCorpusModule, failPending, insertMarker, markApproval, reconcileBatch, sweepEvalTasks } from "./eval-store.js";
import { captureGit } from "./eval-git.js";
import {
  EVAL_MODULE,
  type ApprovalStart,
  type BaseRead,
  type CaptureGit,
  type CaptureSink,
  type CaptureStart,
  type NameRead,
  type PatchRead,
  type ReconcileResult,
} from "./eval-types.js";
import { outcomeId } from "./outcome-projector.js";
import { OUTCOMES_MODULE, readOutcome, type OutcomeRow } from "./outcome-store.js";
import type { ProjectSourceService } from "./project-source.js";
import type { FeatureMap } from "./task-features.js";
import type { Config } from "./types.js";

export const CAPTURE_QUEUE_MAX = 64, CAPTURE_CONCURRENCY = 2, CAPTURE_STALLED_MAX = 4, CAPTURE_DEADLINE_MS = 35_000, RECONCILE_BATCH = 100;

export type TaskCaptureOptions = {
  config: Pick<Config, "projects" | "teams">;
  store: EvidenceStore;
  source?: Pick<ProjectSourceService, "mirrorPath" | "status">;
  /** Default: `captureGit` with the configured Git prefix. */
  git?: CaptureGit;
  now?: () => string;
  /** Default CAPTURE_DEADLINE_MS. */
  deadlineMs?: number;
};

type Job = { taskId: string; run: () => Promise<void> };
type BaseDelta = Extract<MaterialResult, { kind: "store" }>["baseDelta"];

/** The skip lines already written in this process: one per code. */
const skipped = new Set<string>();

function skip(code: "capture-busy" | "corpus-full"): void {
  if (skipped.has(code)) return;
  skipped.add(code);
  console.warn(`Eval capture skipped (${code}).`);
}

function emptyResult(): ReconcileResult {
  return { visited: 0, promoted: 0, rejected: 0, demoted: 0, waiting: 0, unreadable: 0 };
}

/** The promotion rule's facts for one row, with the ledger row read in the same write. */
function decideWith(tx: EvidenceTx): Decide {
  return task => {
    let row: OutcomeRow | undefined;
    try {
      row = readOutcome(tx, outcomeId(task.runId, task.memberId));
    } catch {
      return { kind: "wait", unreadable: true };
    }
    const facts: PromotionFacts = {
      state: task.state === "candidate" ? "candidate" : "captured",
      material: task.material,
      approval: task.approval,
      base: task.base,
      runDeletedAt: task.runDeletedAt,
      payload: task.payload,
    };
    return promotion(facts, row);
  };
}

/**
 * Observes integrated tasks and approvals and keeps their material in the evidence store. It never changes a run:
 * `enabled`, `integrated`, and `approved` are synchronous and never throw; their Git reads run in the background.
 */
export class TaskCapture implements CaptureSink {
  private readonly config: Pick<Config, "projects" | "teams">;
  private readonly store: EvidenceStore;
  private readonly source: TaskCaptureOptions["source"];
  private readonly git: CaptureGit;
  private readonly now: () => string;
  private readonly deadlineMs: number;
  private readonly queue: Job[] = [];
  /** Task ids with a job queued or running. A restart rule must not fail these. */
  private readonly live = new Map<string, number>();
  private readonly waiters: Array<() => void> = [];
  private running = 0;
  /** Git calls that passed their deadline and have not settled yet. */
  private stalled = 0;
  private closed = false;
  private restartChecked = false;

  constructor(options: TaskCaptureOptions) {
    this.config = options.config;
    this.store = options.store;
    this.source = options.source;
    this.git = options.git ?? captureGit(() => options.config.teams?.commandPrefix);
    this.now = options.now ?? (() => new Date().toISOString());
    this.deadlineMs = options.deadlineMs ?? CAPTURE_DEADLINE_MS;
    this.store.register(evalCorpusModule(this.store, this.now));
  }

  enabled(projectId: string): boolean {
    try {
      return !this.closed && this.source !== undefined
        && captureSettings(this.project(projectId)) !== undefined
        && this.ready(EVAL_MODULE);
    } catch {
      return false;
    }
  }

  integrated(start: CaptureStart): void {
    try {
      if (!this.enabled(start.projectId)) return;
      const project = this.project(start.projectId);
      const settings = captureSettings(project);
      if (settings === undefined) return;
      const map = project?.team?.features;
      const busy = this.freeSlots() === 0;
      const reason = busy ? "capture-busy" : startVerdict(start, settings, map);
      const capsule = start.capsule;
      const outcome: MarkerOutcome = reason === undefined && capsule !== null
        ? { state: "captured", capsule }
        : { state: "rejected", reason: reason ?? "start-unknown" };
      let result = "exists" as "inserted" | "exists" | "full";
      if (!this.write(tx => { result = insertMarker(tx, start, outcome, this.now()); })) return;
      if (busy) skip("capture-busy");
      if (result === "full") {
        skip("corpus-full");
        return;
      }
      if (result === "inserted" && outcome.state === "captured") {
        this.enqueue(capturedTaskId(start.runId, start.memberId), () => this.captureJob(start, settings, map));
      }
    } catch {
      // Capture never changes a run.
    }
  }

  approved(start: ApprovalStart): void {
    try {
      if (this.closed) return;
      const reads: { taskId: string; integratedHead: string }[] = [];
      let free = this.freeSlots();
      const ok = this.write(tx => {
        for (const task of markApproval(tx, start)) {
          if (task.integratedHead === start.reviewedHead) {
            completeApproval(tx, task.taskId, start.at, []);
          } else if (free > 0) {
            free -= 1;
            reads.push(task);
          } else {
            completeApproval(tx, task.taskId, start.at, undefined);
          }
        }
      });
      if (!ok) return;
      for (const task of reads) {
        this.enqueue(task.taskId, () => this.approvalJob(task.taskId, start, task.integratedHead));
      }
    } catch {
      // Capture never changes a run.
    }
  }

  /** Runs `failPending` once in this process, then one batch. A zero result when closed or a module is not ready. */
  reconcile(): ReconcileResult {
    try {
      if (this.closed || !this.ready(EVAL_MODULE) || !this.ready(OUTCOMES_MODULE)) return emptyResult();
      let result = emptyResult();
      this.store.write(tx => {
        if (!this.restartChecked) failPending(tx, new Set(this.live.keys()), this.now());
        result = reconcileBatch(tx, decideWith(tx), this.now(), RECONCILE_BATCH);
      });
      this.restartChecked = true;
      return result;
    } catch {
      return emptyResult();
    }
  }

  sweep(): number {
    try {
      if (this.closed || !this.ready(EVAL_MODULE)) return 0;
      const projects = this.config.projects.map(project => ({
        projectId: project.id,
        retentionDays: project.team?.eval?.retentionDays ?? EVAL_RETENTION_DAYS_DEFAULT,
      }));
      let removed = 0;
      this.store.write(tx => {
        removed = sweepEvalTasks(tx, this.now(), projects, EVAL_RETENTION_DAYS_DEFAULT, RECONCILE_BATCH);
      });
      return removed;
    } catch {
      return 0;
    }
  }

  /** Resolves when no job is queued or running. A stalled read is not awaited. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running === 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  /** Drops queued jobs and ignores later completions. A dropped job's row is failed by the next process's `failPending`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) this.untrack(job.taskId);
    this.notifyIdle();
  }

  private project(projectId: string) {
    return this.config.projects.find(project => project.id === projectId);
  }

  private ready(name: string): boolean {
    return this.store.status().modules[name] === "ready";
  }

  /** Writes through the store, and never after close. False when the write did not commit. */
  private write(fn: (tx: EvidenceTx) => void): boolean {
    return !this.closed && this.store.tryWrite(fn);
  }

  /** Slots a new job may take. Zero when the queue is full or too many reads have stalled. */
  private freeSlots(): number {
    if (this.stalled >= CAPTURE_STALLED_MAX) return 0;
    return Math.max(0, CAPTURE_QUEUE_MAX - this.queue.length - this.running);
  }

  private enqueue(taskId: string, run: () => Promise<void>): void {
    this.live.set(taskId, (this.live.get(taskId) ?? 0) + 1);
    this.queue.push({ taskId, run });
    this.pump();
  }

  private pump(): void {
    while (!this.closed && this.running < CAPTURE_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running += 1;
      new Promise<void>(resolve => resolve(job.run()))
        .catch(() => undefined)
        .finally(() => {
          this.running -= 1;
          this.untrack(job.taskId);
          this.pump();
          this.notifyIdle();
        });
    }
  }

  private untrack(taskId: string): void {
    const count = (this.live.get(taskId) ?? 1) - 1;
    if (count > 0) this.live.set(taskId, count);
    else this.live.delete(taskId);
  }

  private notifyIdle(): void {
    if (this.queue.length > 0 || this.running > 0) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  /**
   * Races one Git call against the deadline. When the deadline wins, the call counts as failed and as stalled until
   * its promise settles; the job goes on.
   */
  private bounded<T>(call: () => Promise<T>, failed: T): Promise<T> {
    return new Promise<T>(resolve => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.stalled += 1;
        resolve(failed);
      }, this.deadlineMs);
      const finish = (value: T) => {
        clearTimeout(timer);
        if (timedOut) {
          this.stalled -= 1;
          return;
        }
        resolve(value);
      };
      let pending: Promise<T>;
      try {
        pending = call();
      } catch {
        pending = Promise.reject(new Error("The Git call could not start."));
      }
      pending.then(finish, () => finish(failed));
    });
  }

  private async captureJob(start: CaptureStart, settings: EvalProjectSettings, map: FeatureMap | undefined): Promise<void> {
    let result: MaterialResult;
    try {
      result = await this.referenceResult(start, settings, map);
    } catch {
      result = { kind: "reject", reason: "capture-failed" };
    }
    const taskId = capturedTaskId(start.runId, start.memberId);
    this.write(tx => { completeMaterial(tx, taskId, result, this.now()); });
  }

  /** The reads of one capture, in order. Each stops the job at its first refusal. */
  private async referenceResult(start: CaptureStart, settings: EvalProjectSettings, map: FeatureMap | undefined): Promise<MaterialResult> {
    const workspace = start.workspace;
    const names = await this.bounded<NameRead>(
      () => this.git.names(workspace, start.memberBaseCommit, start.commit, REFERENCE_MAX_FILES),
      { state: "failed" },
    );
    const verdict = referenceVerdict(names, settings, map);
    if ("reason" in verdict) return { kind: "reject", reason: verdict.reason };

    let baseDelta: BaseDelta = { state: "none" };
    if (start.anchorCommit !== start.memberBaseCommit) {
      const read = await this.bounded<PatchRead>(
        () => this.git.patch(workspace, start.anchorCommit, start.memberBaseCommit),
        { state: "failed" },
      );
      if (read.state === "too-large") return { kind: "reject", reason: "patch-too-large" };
      baseDelta = read.state === "read" ? { state: "stored", bytes: read.bytes } : { state: "missing" };
    }

    const reference = await this.bounded<PatchRead>(
      () => this.git.patch(workspace, start.memberBaseCommit, start.commit),
      { state: "failed" },
    );
    if (reference.state === "too-large") return { kind: "reject", reason: "patch-too-large" };

    const base = await this.baseCheck(start);
    return {
      kind: "store",
      files: verdict.files,
      hiddenFiles: verdict.hiddenFiles,
      baseDelta,
      reference: reference.state === "read" ? { state: "stored", bytes: reference.bytes } : { state: "missing" },
      base,
    };
  }

  /** Form 1 in the source mirror against the mirror's head. No head, a throw, or a timeout is `not-proven`. */
  private async baseCheck(start: CaptureStart): Promise<BaseRead> {
    try {
      const source = this.source;
      if (source === undefined) return "not-proven";
      const head = source.status(start.projectId).mirrorHead;
      if (head === undefined) return "not-proven";
      const mirror = source.mirrorPath(start.projectId);
      return await this.bounded<BaseRead>(() => this.git.onBaseBranch(mirror, start.anchorCommit, head), "not-proven");
    } catch {
      return "not-proven";
    }
  }

  private async approvalJob(taskId: string, start: ApprovalStart, integratedHead: string): Promise<void> {
    let later: string[] | undefined;
    try {
      const read = await this.bounded<NameRead>(
        () => this.git.names(start.workspace, integratedHead, start.reviewedHead, LATER_FILES_MAX),
        { state: "failed" },
      );
      later = read.state === "read" ? read.names : undefined;
    } catch {
      later = undefined;
    }
    this.write(tx => { completeApproval(tx, taskId, start.at, later); });
  }
}
