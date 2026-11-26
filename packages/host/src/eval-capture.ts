import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceTx } from "./evidence/types.js";
import { captureSettings, EVAL_RETENTION_DAYS_DEFAULT, type EvalProjectSettings } from "./eval-config.js";
import { LATER_FILES_MAX, promotion, referenceVerdict, REFERENCE_MAX_FILES, startVerdict, type PromotionFacts } from "./eval-rules.js";
import { type Decide, type MarkerOutcome, type MaterialResult, type Promoted, type SweepCursor, capturedTaskId, completeApproval, completeMaterial, evalCorpusModule, failPending, insertMarker, markApproval, reconcileBatch, sweepEvalTasks } from "./eval-store.js";
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
  type TreeCompare,
} from "./eval-types.js";
import { outcomeId } from "./outcome-projector.js";
import { OUTCOMES_MODULE, readOutcome, type OutcomeRow } from "./outcome-store.js";
import type { ProjectSourceService } from "./project-source.js";
import type { FeatureMap } from "./task-features.js";
import { commandScope } from "./team-workspace.js";
import type { Config } from "./types.js";

export const CAPTURE_QUEUE_MAX = 64, CAPTURE_CONCURRENCY = 2, CAPTURE_STALLED_MAX = 4, CAPTURE_DEADLINE_MS = 35_000, RECONCILE_BATCH = 100;

export type TaskCaptureOptions = {
  config: Pick<Config, "projects" | "teams">;
  store: EvidenceStore;
  source?: Pick<ProjectSourceService, "mirrorPath" | "status">;
  git?: CaptureGit;
  now?: () => string;
  deadlineMs?: number;
  onPromoted?: Promoted;
};

type JobKind = "material" | "approval";
type Job = { kind: JobKind; taskId: string; run: () => Promise<void> };
type Deadline = { timer: NodeJS.Timeout; settle: () => void };
type BaseDelta = Extract<MaterialResult, { kind: "store" }>["baseDelta"];

const skipped = new Set<string>();

function skip(code: "capture-busy" | "corpus-full"): void {
  if (skipped.has(code)) return;
  skipped.add(code);
  console.warn(`Eval capture skipped (${code}).`);
}

function emptyResult(): ReconcileResult {
  return { visited: 0, promoted: 0, rejected: 0, demoted: 0, waiting: 0, unreadable: 0 };
}

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

export class TaskCapture implements CaptureSink {
  private readonly config: Pick<Config, "projects" | "teams">;
  private readonly store: EvidenceStore;
  private readonly source: TaskCaptureOptions["source"];
  private readonly git: CaptureGit;
  private readonly now: () => string;
  private readonly deadlineMs: number;
  private readonly onPromoted: Promoted | undefined;
  private readonly queue: Job[] = [];
  private readonly live: Record<JobKind, Map<string, number>> = { material: new Map(), approval: new Map() };
  private readonly waiters: Array<() => void> = [];
  private running = 0;
  private stalled = 0;
  private readonly deadlines = new Set<Deadline>();
  private readonly sweepCursor: SweepCursor = { after: "" };
  private closed = false;
  private restartChecked = false;

  constructor(options: TaskCaptureOptions) {
    this.config = options.config;
    this.store = options.store;
    this.source = options.source;
    this.git = options.git ?? captureGit(() => options.config.teams?.commandPrefix);
    this.now = options.now ?? (() => new Date().toISOString());
    this.deadlineMs = options.deadlineMs ?? CAPTURE_DEADLINE_MS;
    this.onPromoted = options.onPromoted;
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
        this.enqueue("material", capturedTaskId(start.runId, start.memberId), () => this.captureJob(start, settings, map));
      }
    } catch {
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
        this.enqueue("approval", task.taskId, () => this.approvalJob(task.taskId, start, task.integratedHead));
      }
    } catch {
    }
  }

  reconcile(): ReconcileResult {
    try {
      if (this.closed || !this.ready(EVAL_MODULE) || !this.ready(OUTCOMES_MODULE)) return emptyResult();
      let result = emptyResult();
      this.store.write(tx => {
        if (!this.restartChecked) {
          failPending(tx, new Set(this.live.material.keys()), new Set(this.live.approval.keys()), this.now());
        }
        result = reconcileBatch(tx, decideWith(tx), this.now(), RECONCILE_BATCH, this.onPromoted);
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
        removed = sweepEvalTasks(tx, this.now(), projects, EVAL_RETENTION_DAYS_DEFAULT, RECONCILE_BATCH, this.sweepCursor);
      });
      return removed;
    } catch {
      return 0;
    }
  }

  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running === 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) this.untrack(job);
    const waits = [...this.deadlines];
    this.deadlines.clear();
    for (const wait of waits) {
      clearTimeout(wait.timer);
      wait.settle();
    }
    try {
      this.git.close?.();
    } catch {
    }
    this.notifyIdle();
  }

  private project(projectId: string) {
    return this.config.projects.find(project => project.id === projectId);
  }

  private ready(name: string): boolean {
    return this.store.status().modules[name] === "ready";
  }

  private write(fn: (tx: EvidenceTx) => void): boolean {
    return !this.closed && this.store.tryWrite(fn);
  }

  private freeSlots(): number {
    if (this.stalled >= CAPTURE_STALLED_MAX) return 0;
    return Math.max(0, CAPTURE_QUEUE_MAX - this.queue.length - this.running);
  }

  private enqueue(kind: JobKind, taskId: string, run: () => Promise<void>): void {
    this.live[kind].set(taskId, (this.live[kind].get(taskId) ?? 0) + 1);
    this.queue.push({ kind, taskId, run });
    this.pump();
  }

  private pump(): void {
    while (!this.closed && this.running < CAPTURE_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running += 1;
      new Promise<void>(resolve => resolve(commandScope.exit(() => job.run())))
        .catch(() => undefined)
        .finally(() => {
          this.running -= 1;
          this.untrack(job);
          this.pump();
          this.notifyIdle();
        });
    }
  }

  private untrack(job: Job): void {
    const live = this.live[job.kind];
    const count = (live.get(job.taskId) ?? 1) - 1;
    if (count > 0) live.set(job.taskId, count);
    else live.delete(job.taskId);
  }

  private notifyIdle(): void {
    if (this.queue.length > 0 || this.running > 0) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private bounded<T>(call: () => Promise<T>, failed: T): Promise<T> {
    if (this.closed || this.stalled >= CAPTURE_STALLED_MAX) return Promise.resolve(failed);
    return new Promise<T>(resolve => {
      let open = true, stalledNow = false;
      const end = (value: T) => {
        if (!open) return;
        open = false;
        clearTimeout(timer);
        this.deadlines.delete(deadline);
        resolve(value);
      };
      const timer = setTimeout(() => {
        if (!open) return;
        stalledNow = true;
        this.stalled += 1;
        end(failed);
      }, this.deadlineMs);
      timer.unref();
      const deadline: Deadline = { timer, settle: () => end(failed) };
      this.deadlines.add(deadline);
      let pending: Promise<T>;
      try {
        pending = call();
      } catch {
        pending = Promise.reject(new Error("The Git call could not start."));
      }
      const settled = (value: T) => {
        if (stalledNow) this.stalled -= 1;
        else end(value);
      };
      pending.then(settled, () => settled(failed));
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
      if (read.state === "failed") return { kind: "reject", reason: "capture-failed" };
      if (read.state === "missing") baseDelta = { state: "missing" };
      else if (read.state === "empty" || read.bytes.length === 0) {
        const trees = await this.bounded<TreeCompare>(
          () => this.git.sameTree(workspace, start.anchorCommit, start.memberBaseCommit),
          "failed",
        );
        if (trees === "same") baseDelta = { state: "stored", bytes: Buffer.alloc(0) };
        else if (trees === "missing") baseDelta = { state: "missing" };
        else return { kind: "reject", reason: "capture-failed" };
      } else {
        baseDelta = { state: "stored", bytes: read.bytes };
      }
    }

    const reference = await this.bounded<PatchRead>(
      () => this.git.patch(workspace, start.memberBaseCommit, start.commit),
      { state: "failed" },
    );
    if (reference.state === "too-large") return { kind: "reject", reason: "patch-too-large" };
    if (reference.state === "failed" || reference.state === "empty") return { kind: "reject", reason: "capture-failed" };
    if (reference.state === "read" && reference.bytes.length === 0) return { kind: "reject", reason: "capture-failed" };

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
