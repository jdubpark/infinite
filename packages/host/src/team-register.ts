import type { MemberPostRecord } from "./evidence/blackboard.js";
import { blobReader } from "./git-stream.js";
import type { BlobReader, StreamRead } from "./git-stream.js";
import { heldRecordState, writeHeldRecord } from "./objective-holder.js";
import type { GoalRecordPort } from "./objective-intent.js";
import { applyProposals } from "./objective-proposals.js";
import type { Proposal, ProposalDrop, ProposalsApplied } from "./objective-proposals.js";
import { applyReceipts } from "./objective-register.js";
import { passReads, passSubjects, receiptsFor } from "./objective-receipts.js";
import type { BlobResult, ObjectiveReceipt, PassInput, PassKind, Subject } from "./objective-receipts.js";
import { TeamError } from "./team-workspace.js";
import type { TeamCheck, TeamCommand, TeamMember, TeamRun, TeamStatus } from "./team-types.js";

export { objectivePromptOf, registerPin } from "./objective-digest.js";

export const REGISTER_PASS = { passMs: 120_000, stalledReads: 4 } as const;

export type RegisterPass = {
  revision: number; kind: PassKind; commit?: string; state: "pending" | "done"; markedAt: string; finishedAt?: string;
  receipts?: ObjectiveReceipt[];
  wrote?: number;
  skipped?: "record-unavailable" | "log-full" | "write-failed";
};
export type RegisterDrop = ProposalDrop | "record-unavailable" | "write-failed";
export type RegisterState = { pass?: RegisterPass; drops?: Partial<Record<RegisterDrop, number>> };
export type RegisterHolder = { run: TeamRun; objectiveRecord?: unknown; checkHead?: string; register?: RegisterState };
export type RegisterHost = {
  holder(runId: string): RegisterHolder | undefined;
  configured(run: TeamRun): readonly TeamCommand[];
  workspace(holder: RegisterHolder): string | undefined;
  enqueue(runId: string, work: () => void): Promise<void>;
  save(holder: RegisterHolder): void;
  event(holder: RegisterHolder, text: string): void;
  prefix(): TeamCommand | undefined;
  now(): string;
};

export const REGISTER_EVENTS = {
  recorded: (revision: number, counts: { pass: number; fail: number; unknown: number; changed: number }) =>
    `Host tests for revision ${revision}: ${counts.pass} passed, ${counts.fail} failed, ${counts.unknown} unknown; ${counts.changed} assumption statuses changed.`,
  refuted: (ids: readonly string[]) => `Host tests refuted outcome assumptions ${ids.join(", ")}.`,
  skipped: {
    "record-unavailable": "Host tests could not read the objective record, so no assumption status changed.",
    "log-full": "The objective record's log is full, so host test receipts changed no assumption status.",
    "write-failed": "The objective record could not be saved, so host test receipts changed no assumption status.",
  },
  proposalsDropped: "Member assumption proposals were dropped at a limit or could not be recorded.",
} as const;

const DUE: ReadonlySet<TeamStatus> = new Set<TeamStatus>(["ready-for-review", "merged", "blocked"]);

type Target = ReturnType<typeof passReads>[number];
type Job = { holder: RegisterHolder; pass: RegisterPass };
type Plan = { head: string; subjects: Subject[]; reads: Target[]; checks: TeamCheck[]; configured: TeamCommand[]; startedMs: number; cwd?: string };
type Running = { job: Job; controller: AbortController; done: Promise<void> };

export function reviewedHead(holder: RegisterHolder): boolean {
  const run = holder.run;
  return run.headCommit !== undefined && holder.checkHead === run.headCommit &&
    run.review?.revision === run.revision && run.review.verdict === "approved";
}

function proposalsOf(member: TeamMember, posts: readonly MemberPostRecord[]): Proposal[] {
  const proposals: Proposal[] = [];
  for (const post of posts) {
    const { envelope } = post;
    const entry = envelope.entry;
    if (entry.kind !== "finding" || entry.body.assumption === undefined) continue;
    proposals.push({
      entryId: envelope.requestId, memberId: member.memberId, revision: envelope.revision, authorRole: member.role,
      summary: entry.summary, assumption: entry.body.assumption,
    });
  }
  return proposals;
}

function countsOf(receipts: readonly ObjectiveReceipt[], changed: number): { pass: number; fail: number; unknown: number; changed: number } {
  const count = (outcome: ObjectiveReceipt["outcome"]) => receipts.filter(receipt => receipt.outcome === outcome).length;
  return { pass: count("pass"), fail: count("fail"), unknown: count("unknown"), changed };
}

const isLogFull = (error: unknown): boolean => error instanceof TeamError && error.code === "objective-log-full";

const sameMark = (live: RegisterPass | undefined, pass: RegisterPass): live is RegisterPass =>
  live !== undefined && (live === pass || (live.revision === pass.revision && live.kind === pass.kind && live.markedAt === pass.markedAt));

export class TeamRegister {
  goals?: GoalRecordPort;
  private readonly queue: Job[] = [];
  private running?: Running;
  private closed = false;
  private readonly reader: BlobReader;

  constructor(private readonly host: RegisterHost, reader?: BlobReader) {
    this.reader = reader ?? blobReader(() => this.host.prefix());
  }

  mark(holder: RegisterHolder): void {
    try {
      const run = holder.run;
      if (run.register !== "on" || !DUE.has(run.status) || !run.checks.some(check => check.revision === run.revision)) return;
      const kind: PassKind = reviewedHead(holder) ? "reviewed" : "check";
      const current = holder.register?.pass;
      if (current && current.revision === run.revision && (current.kind === kind || current.kind === "reviewed")) return;
      const pass: RegisterPass = {
        revision: run.revision, kind, state: "pending", markedAt: this.host.now(),
        ...(run.headCommit === undefined ? {} : { commit: run.headCommit }),
      };
      holder.register = { ...holder.register, pass };
      this.queue.push({ holder, pass });
    } catch {
    }
  }

  markReviewed(holder: RegisterHolder): boolean {
    try {
      const run = holder.run;
      if (run.register !== "on" || !reviewedHead(holder)) return false;
      const current = holder.register?.pass;
      if (current && current.revision === run.revision && current.kind === "reviewed") return true;
      const pass: RegisterPass = {
        revision: run.revision, kind: "reviewed", state: "pending", markedAt: this.host.now(),
        ...(run.headCommit === undefined ? {} : { commit: run.headCommit }),
      };
      holder.register = { ...holder.register, pass };
      this.queue.push({ holder, pass });
      this.host.save(holder);
      return true;
    } catch {
      return false;
    }
  }

  reviewedReceipts(runId: string, head: string): readonly ObjectiveReceipt[] | "pending" | undefined {
    const pass = this.host.holder(runId)?.register?.pass;
    if (pass === undefined || pass.kind !== "reviewed" || pass.commit !== head) return undefined;
    return pass.state === "pending" ? "pending" : (pass.receipts ?? []);
  }

  restore(holders: Iterable<RegisterHolder>): void {
    for (const holder of holders) {
      try {
        this.mark(holder);
        const pass = holder.register?.pass;
        if (pass?.state === "pending" && !this.queue.some(item => item.pass === pass)) this.queue.push({ holder, pass });
      } catch {
      }
    }
  }

  drain(): void {
    try {
      while (this.running === undefined && !this.closed) {
        const job = this.queue.shift();
        if (job === undefined) return;
        const live = job.holder.register?.pass;
        if (!sameMark(live, job.pass) || live.state !== "pending") continue;
        job.pass = live;
        this.start(job);
        return;
      }
    } catch {
    }
  }

  propose(runId: string, member: TeamMember, posts: readonly MemberPostRecord[]): void {
    try {
      const holder = this.host.holder(runId);
      if (!holder || holder.run.register !== "on") return;
      const proposals = proposalsOf(member, posts);
      if (proposals.length === 0) return;
      const state = heldRecordState(holder, this.goals);
      if (state.kind !== "ready") {
        this.addDrops(holder, { "record-unavailable": proposals.length });
        this.host.save(holder);
        return;
      }
      const applied: ProposalsApplied = applyProposals(state.record, proposals, {
        runId, configured: [...this.host.configured(holder.run)], at: this.host.now(),
      });
      let changed = this.addDrops(holder, applied.dropped);
      if (applied.record !== undefined) {
        try {
          writeHeldRecord(holder, this.goals, state.record, applied.record);
          changed = true;
        } catch {
          this.addDrops(holder, { "write-failed": applied.added.length + applied.attached });
          changed = true;
        }
      }
      if (changed) this.host.save(holder);
    } catch {
    }
  }

  receipts(runId: string): readonly ObjectiveReceipt[] | undefined {
    return this.host.holder(runId)?.register?.pass?.receipts;
  }

  pending(runId: string): boolean {
    return this.host.holder(runId)?.register?.pass?.state === "pending";
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.running?.controller.abort();
  }

  async idle(): Promise<void> {
    while (this.running !== undefined) await this.running.done;
  }

  private start(job: Job): void {
    const controller = new AbortController();
    const done = this.pass(job, controller.signal)
      .catch(() => undefined)
      .then(() => {
        if (this.running?.job === job) this.running = undefined;
        this.drain();
      });
    this.running = { job, controller, done };
  }

  private async pass(job: Job, signal: AbortSignal): Promise<void> {
    const box: { plan?: Plan } = {};
    await this.host.enqueue(job.holder.run.id, () => { box.plan = this.plan(job); });
    const plan = box.plan;
    if (plan === undefined || signal.aborted) return;
    const blobs = await this.readBlobs(plan, signal);
    if (signal.aborted) return;
    await this.host.enqueue(job.holder.run.id, () => this.apply(job, plan, blobs, signal));
  }

  private plan(job: Job): Plan | undefined {
    if (!this.current(job)) return undefined;
    const { holder, pass } = job;
    const run = holder.run;
    const head = pass.commit ?? "";
    const state = heldRecordState(holder, this.goals);
    const subjects = state.kind === "ready" ? passSubjects(state.record, pass.kind) : [];
    return {
      head, subjects, reads: passReads(subjects, head), checks: [...run.checks], configured: [...this.host.configured(run)],
      startedMs: Date.parse(this.host.now()), cwd: this.host.workspace(holder),
    };
  }

  private async readBlobs(plan: Plan, signal: AbortSignal): Promise<Map<string, BlobResult>> {
    const blobs = new Map<string, BlobResult>();
    for (const target of plan.reads) {
      if (signal.aborted) break;
      const key = `${target.commit}:${target.path}`;
      if (Date.parse(this.host.now()) - plan.startedMs >= REGISTER_PASS.passMs) {
        blobs.set(key, { state: "not-run", why: "deadline" });
        continue;
      }
      if (this.reader.stalled() >= REGISTER_PASS.stalledReads) {
        blobs.set(key, { state: "not-run", why: "stalled" });
        continue;
      }
      if (plan.cwd === undefined) {
        blobs.set(key, { state: "failed" });
        continue;
      }
      blobs.set(key, await this.readOne(plan.cwd, target, signal));
    }
    return blobs;
  }

  private async readOne(cwd: string, target: Target, signal: AbortSignal): Promise<StreamRead> {
    try {
      return await this.reader.read(cwd, target.commit, target.path, signal);
    } catch {
      return { state: "failed" };
    }
  }

  private apply(job: Job, plan: Plan, blobs: ReadonlyMap<string, BlobResult>, signal: AbortSignal): void {
    if (signal.aborted || !this.current(job)) return;
    const { holder, pass } = job;
    const at = this.host.now();
    const input: PassInput = { runId: holder.run.id, revision: pass.revision, kind: pass.kind, head: plan.head, at, checks: plan.checks, configured: plan.configured, blobs: new Map(blobs) };
    const state = heldRecordState(holder, this.goals);
    if (state.kind !== "ready") {
      this.settle(job, receiptsFor(plan.subjects, input), { skipped: "record-unavailable" });
      return;
    }
    const receipts = receiptsFor(passSubjects(state.record, pass.kind), input);
    let applied: ReturnType<typeof applyReceipts>;
    try {
      applied = applyReceipts(state.record, receipts, { runId: holder.run.id, revision: pass.revision, kind: pass.kind, at });
    } catch (error) {
      this.settle(job, receipts, { skipped: isLogFull(error) ? "log-full" : "write-failed" });
      return;
    }
    if (applied === undefined) {
      this.settle(job, receipts, {});
      return;
    }
    try {
      writeHeldRecord(holder, this.goals, state.record, applied.record);
    } catch {
      this.settle(job, receipts, { skipped: "write-failed" });
      return;
    }
    this.settle(job, receipts, { wrote: applied.record.version, changed: applied.changed.length, refuted: applied.refutedOutcome });
  }

  private settle(job: Job, receipts: ObjectiveReceipt[], outcome: { skipped?: NonNullable<RegisterPass["skipped"]>; wrote?: number; changed?: number; refuted?: string[] }): void {
    const { holder, pass } = job;
    pass.state = "done";
    pass.finishedAt = this.host.now();
    pass.receipts = receipts;
    if (outcome.wrote !== undefined) pass.wrote = outcome.wrote;
    if (outcome.skipped !== undefined) {
      pass.skipped = outcome.skipped;
      this.host.event(holder, REGISTER_EVENTS.skipped[outcome.skipped]);
    } else {
      this.host.event(holder, REGISTER_EVENTS.recorded(pass.revision, countsOf(receipts, outcome.changed ?? 0)));
      if (outcome.refuted !== undefined && outcome.refuted.length > 0) this.host.event(holder, REGISTER_EVENTS.refuted(outcome.refuted));
    }
    this.host.save(holder);
  }

  private addDrops(holder: RegisterHolder, counts: Partial<Record<RegisterDrop, number>>): boolean {
    const entries = Object.entries(counts).filter((item): item is [RegisterDrop, number] => typeof item[1] === "number" && item[1] > 0);
    if (entries.length === 0) return false;
    const register = holder.register ?? {};
    const first = Object.keys(register.drops ?? {}).length === 0;
    const drops: Partial<Record<RegisterDrop, number>> = { ...register.drops };
    for (const [reason, count] of entries) drops[reason] = (drops[reason] ?? 0) + count;
    holder.register = { ...register, drops };
    if (first) this.host.event(holder, REGISTER_EVENTS.proposalsDropped);
    return true;
  }

  private current(job: Job): boolean {
    const live = job.holder.register?.pass;
    if (this.closed || this.host.holder(job.holder.run.id) !== job.holder || !sameMark(live, job.pass)) return false;
    job.pass = live;
    return true;
  }
}

