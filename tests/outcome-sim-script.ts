import { createHash } from "node:crypto";
import { configId } from "../packages/host/src/config-identity.js";
import type { OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { runEventKey } from "../packages/host/src/run-events.js";

/*
 * The event scripts of the outcome projector simulator (tests/outcome-projector-sim.test.ts): team runs as TeamService
 * emits them. Each order below is one the emitter guarantees, so a script keeps it (lines in teams.ts unless named):
 * - run.created and then run.prepared open a run (1604, 1664).
 * - A run's events reach the store in emission order: one outbox array per run, flushed whole (936-961, 1004-1019).
 * - task.planned of a revision precedes every member.started of that revision (5322 in the plan's completion; launch 5158).
 * - discovery.accepted precedes the starts of its scouts (5240, then launch 5158).
 * - A member's start precedes its report, its integration, its completion and its escalation (5158, 4852, 5569, 5254, 5264).
 * - member.stopped(stall | no-report) follows a drained journal, so no report of that member follows it (4880-4888, 3399-3420).
 * - A replacement starts after its predecessor's stall, limit or escalation (4908, 4936, 5269 link it before its launch).
 * - review.recorded precedes the repair.started it causes (5519, 5528, 5599); repair.integrated answers its own round (5575).
 * - No repair.started follows a cancel or pause, which a revision must leave first (5595).
 * - A block saves its status first, so run.blocked precedes the halt's stops (2832, 928, 3304); a recovery stops the
 *   drained revision first and then emits run.revision-advanced (3267-3305, 2942).
 * - One key per fact (run-events.ts:9); the store keeps the first event of a repeated key (store.ts:287-318).
 * Reorders the emitter allows, which the scripts produce:
 * - The members of a revision run at once, so their events interleave (3333 loops over them on each pass).
 * - member.configured, review.tree and repair.paths are reads that end later, also after a settle (5172, 5535, 5584, 5618-5640).
 * - In a drain, a report read from a later journal page follows the halt's stop (3298-3305; outcome-rules.ts:61-65).
 * - An owner cancel settles first, and the halt loop stops the members afterwards (2204, 2231-2232, then 3304).
 * - An operation that finished before a cancel or pause completes while held, after the settle: stopRun aborts the
 *   command but keeps `pending`, and the queued completion runs `complete` (2279-2292, 2695-2704, 5569, 5575).
 * - A halt stops a queued member that never launched, with no start event (3283, 3291, then 3304).
 * - Runs interleave at flush granularity: each save flushes one run's outbox (855-866).
 */

// Off: production can emit an empty repair answer after a cancel settle, and it leaves the summary's rounds stale (INF-309).
export const EMPTY_REPAIR_AFTER_SETTLE = false;

export type Counts = Record<string, number>;
export type Rand = { next(): number; chance(p: number): boolean; int(lo: number, hi: number): number; pick<T>(items: readonly T[]): T };
type Member = {
  id: string; role: string; revision: number; taskId?: string; model: string; attempt: number;
  replaces?: { memberId: string; cause: string }; started: boolean; stopped: boolean; steps: string[];
};
type Task = { escalated: boolean; integrated: boolean; member?: Member };
type Data = Record<string, unknown>;

const MAX_REVISION = 3;
/** Codes a member's own report or an operation failure recovers from (teams.ts:269, 274). */
const RECOVERY_CODES = new Set(["agent-blocked", "agent-question", "missing-agent-report", "wrong-agent-report", "task-scope-violation", "integration-conflict"]);
const DIGESTS = ["a".repeat(64), "e".repeat(64)];
const MODELS = ["m-1", "m-2", "m-3"];
const PATHS = ["a.txt", "b.txt", "c.txt", "z.txt"];

/** How one attempt ends, by weight. A third attempt always succeeds, so a replacement chain ends. */
const IMPLEMENTER_ENDINGS: readonly (readonly [number, string[]])[] = [
  [55, ["report:result", "integrate"]],
  [8, ["stop:stall"]],
  [5, ["stop:limit"]],
  [7, ["report:escalate", "escalate"]],
  [4, ["report:question", "block:agent-question"]],
  [3, ["report:blocked", "block:agent-blocked"]],
  [4, ["stop:no-report", "block:missing-agent-report"]],
  [4, ["report:review", "block:wrong-agent-report"]],
  [5, ["report:result", "block:task-scope-violation"]],
  [5, ["report:result", "block:integration-conflict"]],
];
const SCOUT_ENDINGS: readonly (readonly [number, string[]])[] = [
  [80, ["report:findings", "complete"]],
  [10, ["stop:stall"]],
  [10, ["report:result", "block:wrong-agent-report"]],
];

export const bump = (counts: Counts, name: string, by = 1) => { counts[name] = (counts[name] ?? 0) + by; };

/** mulberry32: small, seeded, and the same on every platform. No Math.random and no clock anywhere in the simulator. */
export function rand(seed: number): Rand {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, chance: p => next() < p, int, pick: items => items[int(0, items.length - 1)]! };
}

function weighted(r: Rand, table: readonly (readonly [number, string[]])[]): string[] {
  let roll = r.next() * table.reduce((sum, [weight]) => sum + weight, 0);
  for (const [weight, steps] of table) {
    roll -= weight;
    if (roll < 0) return [...steps];
  }
  return [...table[0]![1]];
}

/** A `member.configured` whose id matches its six components, as `configuredData` builds it. */
function configured(model: string, promptVersion: string): Data {
  const profile = { provider: "claude", model, effort: null };
  const components = { profile, promptVersion, guidance: DIGESTS[1]!, knowledge: "none" as const, routing: "off", shape: "team" as const };
  return { configId: configId(components), provider: "claude", model, promptVersion, guidance: DIGESTS[1], knowledge: "none", routing: "off", shape: "team" };
}

/**
 * One run's events in emission order. Members run as threads; blocks, recoveries, steering, pauses, continuations and
 * owner cancels end revisions; enrichment reads land later. Event times come from the caller's logical clock.
 */
export class RunScript {
  readonly events: OutboxEvent[] = [];
  private keys = new Set<string>();
  private late: (() => void)[] = [];
  private members: Member[] = [];
  private tasks = new Map<string, Task>();
  private revision = 1;
  private round = 0;
  private recoveries = 0;
  private serial = 0;
  private settled = false;
  private status = "planning";
  private ended = false;
  private base: string;
  private head: string;

  constructor(private readonly r: Rand, private readonly runId: string, private readonly clock: () => string, private readonly counts: Counts) {
    this.base = this.head = this.commit();
  }

  script(): OutboxEvent[] {
    const goal = this.r.chance(0.3) ? { goalId: "goal-1", goalCycle: 1, missionId: "mission-1" } : {};
    this.emit("run.created", [], {}, { projectId: "example", purpose: "work", ...goal });
    this.emit("run.prepared", [], {}, { baseCommit: this.base });
    while (!this.ended) this.revise();
    // A read still running when the record is last saved emits later, or never when it fails.
    for (const read of this.late.splice(0)) if (this.r.chance(0.8)) read();
    // Deleting the record flushes its outbox last; the projector only advances past run.deleted (teams.ts:1384).
    if (this.r.chance(0.2)) this.emit("run.deleted", [], {}, { status: this.status });
    return this.events;
  }

  private emit(kind: string, parts: (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number },
    data: Data | ((at: string) => Data)): void {
    const key = runEventKey(kind, this.runId, parts);
    if (this.keys.has(key)) throw new Error(`the script repeated the key ${key}`);
    this.keys.add(key);
    const at = this.clock();
    const body = typeof data === "function" ? data(at) : data;
    this.events.push({
      key, runId: this.runId, revision: ids.revision ?? this.revision, at, kind,
      ...(ids.memberId === undefined ? {} : { memberId: ids.memberId }),
      ...(ids.taskId === undefined ? {} : { taskId: ids.taskId }),
      data: { v: 1, ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) },
    });
    if (this.settled) bump(this.counts, `after-settle:${kind}`);
    if (this.late.length > 0 && this.r.chance(0.2)) this.late.splice(this.r.int(0, this.late.length - 1), 1)[0]!();
  }

  /** One revision: an optional discovery, a plan and its members, then checks and reviews. */
  private revise(): void {
    if (this.r.chance(0.3)) {
      this.discover();
      if (!this.work()) return;
    }
    this.plan();
    if (this.work()) this.review();
  }

  private discover(): void {
    const pm = this.member("project-manager");
    this.start(pm);
    this.report(pm, "explore");
    const scouts = this.r.chance(0.5) ? ["s-a", "s-b"] : ["s-a"];
    const features = { role: "scout", area: "none", kind: "investigation", risk: "normal", featureVersion: 1, featureMap: "default" };
    this.emit("discovery.accepted", [this.revision], { memberId: pm.id }, {
      parallelism: 2, scouts: scouts.map(taskId => ({ taskId, profileId: "scout", features })),
    });
    for (const taskId of scouts) this.member("scout", taskId);
  }

  private plan(): void {
    const pm = this.member("project-manager");
    this.start(pm);
    this.report(pm, "plan");
    const ids = ["a", "b", "c"].slice(0, this.r.int(1, 3));
    this.tasks = new Map(ids.map(id => [id, { escalated: false, integrated: false }]));
    this.emit("plan.accepted", [this.revision], { memberId: pm.id }, { taskCount: ids.length, planDigest: DIGESTS[0], parallelism: 2 });
    for (const id of ids) {
      this.emit("task.planned", [this.revision, id], { taskId: id }, {
        profileId: "impl", paths: [`${id}.txt`],
        features: { role: "implementer", area: this.r.pick(["core", "ui"]), kind: null, risk: "normal", featureVersion: 1, featureMap: "default" },
      });
      this.member("implementer", id);
    }
  }

  /** Runs this revision's members as threads. False when a block or an owner halt ended the revision. */
  private work(): boolean {
    for (;;) {
      const runnable = this.members.filter(m => m.revision === this.revision && !m.stopped && m.steps.length > 0);
      if (runnable.length === 0) return true;
      if (this.r.chance(0.025)) {
        this.ownerHalt(this.pendingResult());
        return false;
      }
      const m = this.r.pick(runnable);
      const [verb, arg = ""] = m.steps.shift()!.split(":");
      if (verb === "start") this.start(m);
      else if (verb === "report") this.report(m, arg);
      else if (verb === "integrate") this.integrate(m);
      else if (verb === "complete") this.complete(m);
      else if (verb === "escalate") {
        this.emit("task.escalated", [m.revision, m.taskId!], this.ids(m), { fromProfileId: `profile-${m.model}`, toProfileId: "profile-strong" });
        this.member(m.role, m.taskId, m.attempt + 1, { memberId: m.id, cause: "escalation" });
      } else if (verb === "stop") {
        this.stop(m, arg);
        if (arg === "stall" || arg === "limit") this.member(m.role, m.taskId, m.attempt + 1, { memberId: m.id, cause: arg });
      } else {
        this.block(arg, m);
        return false;
      }
    }
  }

  /** Checks and reviews until the revision is approved, blocked or halted (teams.ts:5490-5539, 5594-5601). */
  private review(): void {
    for (;;) {
      this.emit("check.finished", [this.revision, this.round, this.stamp()], {}, { round: this.round });
      if (this.round < 2 && this.r.chance(0.2)) {
        if (!this.repair("check")) return;
        continue;
      }
      const reviewer = this.member("reviewer");
      this.start(reviewer);
      this.report(reviewer, "review");
      const verdict = this.r.chance(0.5) ? "approved" : "changes-requested";
      const record = () => this.recordReview(reviewer, verdict);
      if (this.r.chance(0.06)) return this.ownerHalt(record);
      record();
      if (verdict === "approved") return this.approve();
      if (this.round >= 2) return this.block("repair-limit");
      if (!this.repair("review")) return;
    }
  }

  private recordReview(reviewer: Member, verdict: string): void {
    const { head, base } = this;
    const revision = reviewer.revision;
    const rubric = verdict !== "approved" ? [] : [...this.tasks.entries()]
      .filter(([, task]) => task.integrated && this.r.chance(0.7))
      .map(([taskId]) => ({ taskId, correctness: this.r.int(1, 5), cleanliness: 3, extensibility: 4, docs: 2 }));
    this.emit("review.recorded", [revision, reviewer.id], { memberId: reviewer.id, revision }, {
      verdict, headCommit: head, baseCommit: base, reviewer: { provider: "claude", profileId: "rev", model: reviewer.model },
      rubric: rubric.length > 0 ? rubric : undefined,
    });
    if (this.r.chance(0.7)) {
      this.late.push(() => this.emit("review.tree", [revision, reviewer.id], { memberId: reviewer.id, revision }, { headCommit: head, tree: this.commit() }));
    }
  }

  /** One correction round. False when an owner halt ended the revision while the integrator's result was in flight. */
  private repair(cause: string): boolean {
    this.round += 1;
    const { revision, round, base } = this;
    this.emit("repair.started", [revision, round], {}, { round, cause, headCommit: this.head });
    const integrator = this.member("integrator");
    this.start(integrator);
    this.report(integrator, "result");
    const answer = () => {
      const empty = this.r.chance(0.3) && (EMPTY_REPAIR_AFTER_SETTLE || !this.settled);
      const commit = empty ? undefined : this.commit();
      if (commit !== undefined) this.head = this.commit();
      this.emit("repair.integrated", [revision, round], { memberId: integrator.id, revision }, { round, commit, headCommit: this.head, baseCommit: base });
      // A failed path read still emits, with pathsOmitted (teams.ts:5580-5587).
      if (commit !== undefined) {
        const paths = this.r.chance(0.15) ? { pathsOmitted: true } : { paths: PATHS.filter(() => this.r.chance(0.4)) };
        this.late.push(() => this.emit("repair.paths", [revision, round], { memberId: integrator.id, revision }, { round, commit, ...paths }));
      }
    };
    if (this.r.chance(0.25)) {
      this.ownerHalt(answer);
      return false;
    }
    answer();
    return true;
  }

  private approve(): void {
    const roll = this.r.next();
    let status = "ready-for-review";
    if (roll < 0.55) {
      const delivery = this.member("delivery");
      this.start(delivery);
      if (roll < 0.08 && this.revision < MAX_REVISION) {
        // Nothing was published and the base moved: a new revision starts on the new base (teams.ts:5397-5411).
        this.report(delivery, "delivery-reconciliation");
        return this.advance("moved-base");
      }
      const merge = this.r.chance(0.5);
      this.report(delivery, merge ? "delivery" : "pull-request");
      this.emit("delivery.recorded", [this.revision, delivery.id], { memberId: delivery.id }, merge
        ? { method: "merge", headCommit: this.head, mergeCommit: this.commit() } : { method: "pull-request", headCommit: this.head });
      if (merge) status = "merged";
    }
    this.settle(status);
    for (const [taskId, task] of this.tasks) {
      if (task.member && this.r.chance(0.35)) {
        this.emit("rating.recorded", [`request-${this.stamp()}`], { taskId, memberId: task.member.id, revision: task.member.revision }, { score: this.r.int(1, 5) });
      }
    }
    const next = this.r.next();
    if (next < 0.35 && this.revision < MAX_REVISION) return this.advance("continue");
    if (next < 0.45) return this.cancel();
    this.ended = true;
  }

  /** A block. A recoverable one drains its revision and advances; any other one blocks the run (teams.ts:2759-2833). */
  private block(code: string, source?: Member): void {
    if (source && RECOVERY_CODES.has(code) && this.recoveries < 2 && this.revision < MAX_REVISION && this.r.chance(0.6)) {
      this.recoveries += 1;
      this.halt("host", "block", this.revision);
      return this.advance("automatic-recovery", { sourceCode: code, sourceMemberId: source.id });
    }
    this.emit("run.blocked", [this.revision, this.stamp()], {}, { code, sourceMemberId: source?.id });
    this.status = "blocked";
    this.halt("host", "block");
    const roll = this.r.next();
    if (roll < 0.3) return this.cancel();
    // Retention removes a blocked run's workspace and settles it as blocked (teams.ts:3225-3226).
    if (roll < 0.45) this.settle("blocked", "workspace-removed");
    this.ended = true;
  }

  /** An owner halt: cancel, pause and resume, or steer. `pending` is a workspace operation that already finished. */
  private ownerHalt(pending?: () => void): void {
    const action = this.revision < MAX_REVISION ? this.r.pick(["cancel", "cancel", "pause", "steer"]) : "cancel";
    if (action === "cancel") return this.cancel(pending);
    // Steering refuses a running operation (teams.ts:1695); a pause holds the completion like a cancel does.
    pending?.();
    if (action === "steer") {
      this.advance("steer");
      return this.halt("owner", "steer");
    }
    this.halt("owner", "pause");
    this.status = "paused";
    if (this.r.chance(0.7)) this.advance("resume");
    else this.ended = true;
  }

  private cancel(pending?: () => void): void {
    this.settle("cancelled");
    const first = this.r.chance(0.5);
    if (pending && first) pending();
    this.halt("owner", "cancel");
    if (pending && !first) pending();
    this.ended = true;
  }

  /** The halt loop stops every active member (teams.ts:3270-3305). A drained revision reads one journal page first. */
  private halt(reason: "owner" | "host", detail: string, drained?: number): void {
    for (const m of this.members) {
      if (m.stopped) continue;
      const next = m.steps[0];
      const report = m.started && m.revision === drained && next?.startsWith("report:") ? next.slice(7) : undefined;
      const when = report === undefined ? "never" : this.r.pick(["before", "after", "after", "never"]);
      if (when === "before") this.report(m, report!);
      this.stop(m, reason, detail);
      if (when === "after") {
        this.report(m, report!);
        bump(this.counts, "reorder:report-after-stop");
      }
    }
  }

  private advance(cause: string, extra: Data = {}): void {
    this.revision += 1;
    this.round = 0;
    this.tasks = new Map();
    this.settled = false;
    if (cause === "moved-base") this.base = this.head = this.commit();
    this.emit("run.revision-advanced", [this.revision], {}, { cause, fromRevision: this.revision - 1, baseChanged: cause === "moved-base", ...extra });
  }

  private settle(status: string, tag = this.stamp()): void {
    const tasks = [...this.tasks.values()];
    this.emit("run.settled", [this.revision, status, tag], {}, {
      status,
      summary: {
        tasks: tasks.length, integrated: tasks.filter(task => task.integrated).length, members: this.members.length, round: this.round,
        checks: 0, recoveries: this.recoveries, decisionsByOwner: 0, decisionsByCoordinator: 0, steering: 0, permissionEscalations: 0, continuations: 0,
      },
    });
    this.settled = true;
    this.status = status;
  }

  /** The one operation that can be in flight: a reported result or findings awaiting its completion. */
  private pendingResult(): (() => void) | undefined {
    const m = this.members.find(item => item.revision === this.revision && !item.stopped && (item.steps[0] === "integrate" || item.steps[0] === "complete"));
    if (!m) return undefined;
    const step = m.steps[0];
    return () => {
      bump(this.counts, "reorder:completion-after-halt");
      if (step === "integrate") this.integrate(m);
      else this.complete(m);
    };
  }

  private member(role: string, taskId?: string, attempt = 1, replaces?: Member["replaces"]): Member {
    const table = role === "implementer" ? IMPLEMENTER_ENDINGS : role === "scout" ? SCOUT_ENDINGS : undefined;
    let steps = table === undefined ? [] : attempt >= 3 ? [...table[0]![1]] : weighted(this.r, table);
    if (steps.includes("escalate")) {
      const task = this.tasks.get(taskId!);
      if (!task || task.escalated) steps = [...table![0]![1]];
      else task.escalated = true;
    }
    const prefix: Record<string, string> = { implementer: "m", scout: "s", reviewer: "r", integrator: "g", delivery: "d", "project-manager": "p" };
    const member: Member = {
      id: `${prefix[role]}${++this.serial}`, role, revision: this.revision, taskId, model: this.r.pick(MODELS), attempt, replaces,
      started: false, stopped: false, steps: table === undefined ? [] : ["start", ...steps],
    };
    this.members.push(member);
    return member;
  }

  private ids(m: Member) {
    return { memberId: m.id, taskId: m.taskId, revision: m.revision };
  }

  private start(m: Member): void {
    m.started = true;
    this.emit("member.started", [m.id], this.ids(m), at => ({
      role: m.role, purpose: "work", sessionId: `session-${m.id}`, startedAt: at, baseCommit: this.base,
      provider: "claude", profileId: `profile-${m.model}`, model: m.model, replaces: m.replaces,
    }));
    if (this.r.chance(0.75)) {
      const data = configured(m.model, this.r.pick(DIGESTS));
      this.late.push(() => this.emit("member.configured", [m.id], this.ids(m), data));
    }
  }

  private report(m: Member, kind: string): void {
    this.emit("member.reported", [m.id], this.ids(m), { role: m.role, reportKind: kind });
  }

  private integrate(m: Member): void {
    const commit = this.r.chance(0.85) ? this.commit() : undefined;
    if (commit !== undefined) this.head = this.commit();
    this.emit("task.integrated", [m.revision, m.taskId!], this.ids(m), {
      commit, headCommit: this.head, baseCommit: this.base, memberBaseCommit: this.base,
      diff: { added: this.r.int(0, 9), removed: this.r.int(0, 9), files: 1, docs: false, tests: this.r.chance(0.5) },
    });
    const task = this.tasks.get(m.taskId!);
    if (task) Object.assign(task, { integrated: true, member: m });
  }

  private complete(m: Member): void {
    this.emit("scout.completed", [m.revision, m.taskId!], this.ids(m), {});
  }

  private stop(m: Member, reason: string, detail?: string): void {
    if (!m.started) bump(this.counts, "reorder:stop-without-start");
    m.stopped = true;
    m.steps = [];
    this.emit("member.stopped", [m.id], this.ids(m), { role: m.role, reason, detail, reported: false });
  }

  private stamp(): string {
    return `s${++this.serial}`;
  }

  private commit(): string {
    return createHash("sha1").update(`${this.runId}:${++this.serial}`).digest("hex");
  }
}
