import { isDeepStrictEqual } from "node:util";
import type { Criterion } from "../packages/host/src/objective-types.js";
import {
  type admit, type AdmissionFacts, type Candidate, type Decision, type GateOutcome, type HaltReason, isOpen, type LeaveReason,
  type RunView, type SearchClass, type SearchEvent, searchPolicy, type SearchPolicy, type SearchState, searchStateSchema, type step,
} from "../packages/host/src/search-engine.js";
import { bump, type Counts, type Rand, rand } from "./outcome-sim-script.js";

/*
 * A seeded simulator of the search engine's event orders (INF-336). Each seed runs four team runs in one project, so
 * the brake's history and the project's pause carry from run to run. A run has one to three tasks; the dispatcher
 * prepares them at random moments, and each may be admitted to a search. Members act on drawn plans: a result (with a
 * scope violation, an unchanged tree, and a gate outcome) or a leave. The model host keeps one workspace operation slot
 * with a queue, as the design's Part 7 describes: a `live` base run starts only when nothing else waits and yields when
 * something arrives; captures and gate runs wait their turn. A launch is prepared and acknowledged on later steps, so
 * its receipt can cross the hold or the wait or arrive after the end; some receipts arrive twice. Faults: production
 * work arriving, a halt (steer, pause, cancel, block, routing revoked, revision), a restart during an operation (the run
 * blocks), a restart at rest (`resume`, which loses launches not yet prepared), a gate run that the host cannot stop
 * and that reports after its search ended, launches the spend fuse refuses, events of members and launches the search
 * does not know, the owner pausing and resuming the project, the host-load hold, under which queued operations wait,
 * and a host clock that jumps forward and back: every view carries the host's time, and S7 reads that time.
 *
 * Invariants, checked after every step from the engine's output and the simulator's own records. The simulator's
 * values are the truth: a mutant engine may see a tampered view, the checks never do.
 * S0 Every state parses with searchStateSchema, and the champion stays first.
 * S1 One winner: at most one `integrate` per search, only in the step that resolves it, naming the winner. Against the
 *    gate results the simulator delivered: a search resolves exactly at the first pass, for that member, and a pass
 *    delivered before the hold always resolves it.
 * S2 Challengers: a `start-challengers` keeps the run's spareAttempts at 3 or more with them counted, fits the free slot
 *    pairs and `attempts`, names known families distinct from each other and the champion's, none limited, never while
 *    another search is wide or launching; under after-fail only once the champion failed or left, under together also
 *    at arming; launches are numbered 1, 2, … and never start while one waits for its receipt.
 * S3 An ended search changes only by the first receipt of its pending launch, which clears it and, when it names a
 *    member, marks it widened; it decides only stops, its count, a pause and a cancel; states move only forward along
 *    the design's transitions.
 * S4 Against the captures and gate results the simulator delivered: gate runs follow the order in which it delivered
 *    captures in scope and changed before the wait, one outstanding at a time, at the captured commit; when a search
 *    resolves, every such capture delivered before the winner's had a failing gate result delivered; no search ends by
 *    the wait while such a capture waits for its gate.
 * S5 Nothing is gated after a pass, also not in the step that resolves the search.
 * S6 A `live` search that ends releases the task exactly once when exhausted or abandoned and never when resolved; no
 *    acknowledged challenger works after the end, and no champion works after another result won.
 * S7 Time, from the host time of each step and the design's formulas: each cutoff (hold, wait, window) is set at most
 *    its duration after the host time of the event that sets it, and never moves; an open search is before its hold
 *    (and a `measure` one before its window), and ends by the hold, the wait or the window not before that time; the
 *    hold ends a search as `exhausted`; the hold and the window fit before the deadline; no challenger works past the
 *    wait, and a search open past the wait has a capture made before it still waiting for its gate; every run ends with
 *    every search ended.
 * S8 Classes follow Part 8 from what the simulator delivered: the pass that resolved the search, and the champion's
 *    fate delivered after the arming in earlier steps (a failed gate run, a capture out of scope or unchanged, a stall
 *    or an exit without a report); `challenger-first` only under together; no class on a search that never armed. The
 *    arming is read from the delivered failed base run and the simulator's own hold.
 * S9 A search arms only in the step of a failed base run of a `live` search, always does when it stays open, and stays armed.
 * S10 The brake and the pause: admission refuses with condition 6 exactly while the project is paused, the run has had
 *    two searches, or a search is wide or has a launch out (ended or not); a search counts toward the brake exactly
 *    once, with the oracle's class, in the first step in which the simulator has delivered a first receipt that named a
 *    member and the search has ended (so a receipt after the end counts it); a `pause` comes with every count that
 *    leaves the brake engaged, and the pause holds until the owner resumes.
 * S11 A `measure` search starts no challenger, captures nothing, holds and releases nothing; its base run comes at the
 *    boundary; it is `measured` only after a failed base run with the champion's gate result.
 * S12 A restart at rest re-derives an open search's queued base run, its waiting captures (a set: none has completed,
 *    so none has an order), its outstanding gate run, and the launch that waits for its receipt, and starts no new
 *    launch. The host resumes every open search and every ended one with a launch out.
 * S13 Receipts: every member of a launch's first receipt is a contestant or stopped in that step, and after the end
 *    exactly those are stopped; a repeated receipt, or an event of a member or launch the search does not know, does
 *    what the time passing alone does, and so does any event delivered again at once (the host contract redelivers
 *    events whose step it had not saved); no stop ever names the winner; the step that ends a search with a launch out
 *    cancels that launch once, and so does a restart that finds it ended so; every launch has its receipt by the end
 *    of the run (the model host answers a cancelled launch with the members it prepared, or none).
 * S14 A stop never names a member whose result arrived in an earlier step, and a stopped member is never captured or gated.
 *
 * Each invariant has at least one mutant engine in tests/search-engine-sim.test.ts (an in-process wrapper of `admit` or
 * `step`) that the default corpus must catch through that invariant, and the test names the seed that did.
 *
 * What it does not check: the host's I/O (Git, the operation records, the outcome ledger), the host contract's saves (the
 * model host acts on each step's decisions at once; S13 checks the engine's side, that an event delivered again changes
 * nothing), plan order of integration, and the record events of Part 6. Rule semantics with exact values stay with
 * tests/search-engine.test.ts.
 */

const RUNS_PER_SEED = 4;
const MAX_STEPS = 800;
const MINUTE = 60_000;
const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const BASE = "b".repeat(40);
/** Condition 11's floor, from the design's text. */
const RESERVE = 3;
const FAMILIES: Readonly<Record<string, string | undefined>> = {
  "p-claude": "anthropic", "p-claude-2": "anthropic", "p-gpt": "openai", "p-gpt-2": "openai", "p-gemini": "google",
  "p-mistral": "mistral", "p-mystery": undefined,
};
const PROFILE_IDS = Object.keys(FAMILIES);
const HALTS: readonly HaltReason[] = ["steer", "pause", "cancel", "block", "routing-revoked", "revision"];
const CHAMPION_LEAVES: readonly (readonly [number, LeaveReason])[] = [[10, "stall"], [5, "no-report"], [4, "limit"], [4, "question"],
  [3, "blocked"], [4, "escalate"], [5, "permission"], [2, "prep-failed"]];
const CHALLENGER_LEAVES: readonly (readonly [number, LeaveReason])[] = [[8, "stall"], [4, "no-report"], [5, "limit"], [6, "permission"],
  [3, "question"], [3, "blocked"], [3, "escalate"], [2, "prep-failed"]];
/** Allowed moves of `state` in one step (Part 4). */
const NEXT: Readonly<Record<string, readonly string[]>> = {
  admitting: ["admitting", "armed", "abandoned", "measured", "exhausted"],
  armed: ["armed", "wide", "resolved", "exhausted", "abandoned"],
  wide: ["wide", "resolved", "exhausted", "abandoned"],
};

/** Part 7 and Part 3 from the design's text: a gate run is 20 minutes of clone and setup plus `gateMinutes`. */
const allowance = (p: SearchPolicy, baseOpen: boolean) => (p.attempts + (baseOpen ? 1 : 0)) * (20 + p.gateMinutes) + p.waitMinutes;
const windowMinutes = (p: SearchPolicy, searches: number) => 2 * (20 + p.gateMinutes) * searches;

export type Engine = { admit: typeof admit; step: typeof step };
type ResultPlan = { kind: "result"; scope: "ok" | "violation"; empty: boolean; gate: GateOutcome };
type Plan = ResultPlan | { kind: "leave"; reason: LeaveReason };
type Member = { id: string; taskId: string; profileId: string; challenger: boolean; working: boolean; acked: boolean; plan: Plan };
type Op = { kind: "base" | "capture" | "gate" | "work"; taskId?: string; memberId?: string; outcome?: GateOutcome; stale?: boolean };
/** A `start-challengers` decision as the host keeps it: the intent (memory only), the prepared members, receipts due. */
type Launch = { n: number; profileIds: string[]; intent: boolean; members?: Member[]; acked: boolean; due: number; delay: number; slow: boolean };
/** What the simulator delivered to and received from one search: the facts the checks compare against. */
type Ledger = {
  base?: GateOutcome | "yielded"; outstanding?: string; integrates: number; releases: number;
  gated: { memberId: string; outcome: GateOutcome }[]; stopped: Set<string>; resulted: Set<string>;
  /** Delivered captures in scope and changed, in delivery order: true when delivered before the wait, so gateable. */
  okCaptures: Map<string, boolean>;
  /** A failed base run was delivered and armed the search; the champion's fate (a failed gate run, a capture out of
   * scope or unchanged, a stall or an exit without a report) was delivered after the arming. */
  armed: boolean; championDone: boolean;
  hold?: number; wait?: number; window?: number;
  /** A first receipt that named a member was delivered, and the search's count toward the brake was checked. */
  widened: boolean; counted: boolean;
  /** The class the design gives the search at its end, from the simulator's oracle. */
  oracleClass?: SearchClass;
};
type Task = { id: string; prepared: boolean; done: boolean; champion?: Member; search?: SearchState; ledger: Ledger; launches: Launch[] };
/** How the simulator produced an event: a gate run that reported after its search ended, a launch receipt, a ghost. */
type Meta = { stale?: boolean; receipt?: "first" | "again"; ghost?: boolean };
type Project = { history: SearchClass[]; paused: boolean };

export class Violation extends Error {}

function weighted<T>(r: Rand, table: readonly (readonly [number, T])[]): T {
  let roll = r.next() * table.reduce((sum, [weight]) => sum + weight, 0);
  for (const [weight, item] of table) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return table[0]![1];
}

function drawPlan(r: Rand, challenger: boolean): Plan {
  if (r.chance(0.62)) {
    const scope = r.chance(0.08) ? "violation" : "ok";
    const gate: GateOutcome = r.chance(challenger ? 0.45 : 0.35) ? "pass" : r.pick(["fail", "fail", "fail", "timeout", "setup-failed"]);
    return { kind: "result", scope, empty: scope === "ok" && r.chance(0.08), gate };
  }
  return { kind: "leave", reason: weighted(r, challenger ? CHALLENGER_LEAVES : CHAMPION_LEAVES) };
}

/** Part 8, restated from the design's text: 10 or more widened searches, fewer than 2 rescued among the last 10. */
function engaged(history: readonly SearchClass[]): boolean {
  if (history.length < 10) return false;
  let rescued = 0;
  for (let index = history.length - 10; index < history.length; index += 1) if (history[index] === "rescued") rescued += 1;
  return rescued < 2;
}

/** The champion failed its gate or left on its own (rule 2), the condition for widening and for a rescue. */
const championDone = (s: SearchState) => {
  const first = s.contestants[0]!;
  return (first.gate !== undefined && first.gate.result !== "pass") || first.left === "stall" || first.left === "no-report";
};
const at = (ms: number) => new Date(ms).toISOString();
const commitOf = (memberId: string) => `${memberId}:commit`;
const newLedger = (): Ledger => ({ integrates: 0, releases: 0, gated: [], okCaptures: new Map(), stopped: new Set(), resulted: new Set(),
  armed: false, championDone: false, widened: false, counted: false });

class RunSim {
  private readonly policy: SearchPolicy;
  private readonly checkMinutes: number;
  private readonly deadline: string | undefined;
  private readonly limit: number;
  private readonly candidates: Candidate[];
  private readonly tasks: Task[];
  private readonly members: Member[] = [];
  private queue: Op[] = [];
  private current: Op | undefined;
  private clock = T0;
  private steps = 0;
  private serial = 0;
  private halted = false;
  /** The host-load hold: queued operations wait, so a restart can find work queued and none open. */
  private loadHold = false;
  /** The host clock's error: views carry `clock + skew`, and the clock jumps forward and back now and then. */
  private skew = 0;

  constructor(private readonly r: Rand, private readonly engine: Engine, private readonly counts: Counts,
    private readonly project: Project, private readonly label: string) {
    const live = r.chance(0.75);
    this.policy = searchPolicy({ mode: live ? "live" : "measure", start: r.chance(0.35) ? "together" : "after-fail", share: r.pick([0.1, 0.25]),
      attempts: r.pick([2, 3, 4, 4]), gateMinutes: r.pick([5, 15, 30, 60]), waitMinutes: r.pick([5, 30, 60, 120]) });
    this.checkMinutes = r.pick([10, 30, 60]);
    const count = r.int(1, 3);
    this.tasks = Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}`, prepared: false, done: false, ledger: newLedger(), launches: [] }));
    // spareAttempts starts at 2 to 9 once every champion is prepared, so the reserve often binds.
    this.limit = 2 * count + 3 + r.int(2, 9);
    this.deadline = r.chance(0.4) ? at(T0 + r.int(150, 700) * MINUTE) : undefined;
    this.candidates = [...PROFILE_IDS].sort(() => r.next() - 0.5)
      .map(profileId => ({ profileId, ...(FAMILIES[profileId] === undefined ? {} : { family: FAMILIES[profileId] }), limited: r.chance(0.12) }));
    bump(counts, `policy:${this.policy.mode}:${this.policy.start}`);
  }

  run(): void {
    while (!this.finished()) {
      this.steps += 1;
      if (this.steps > MAX_STEPS) this.fail("S7", `the run did not end in ${MAX_STEPS} steps`);
      weighted(this.r, this.actions())();
      this.settleOps();
    }
    for (const task of this.tasks) if (task.search && isOpen(task.search)) this.fail("S7", `${task.id}'s search is still ${task.search.state} at the end of the run`);
    for (const task of this.tasks) for (const l of task.launches) if (!l.acked) this.fail("S13", `launch ${l.n} never got its receipt`, task);
  }

  private where(task?: Task): string {
    return `${this.label} step ${this.steps}${task ? ` task ${task.id}` : ""} at ${at(this.clock)}, host time ${at(this.now())}`;
  }

  private fail(invariant: string, message: string, task?: Task): never {
    throw new Violation(`${this.where(task)}: ${invariant}: ${message}`);
  }

  private finished(): boolean {
    if (this.tasks.some(task => task.launches.some(l => l.intent || l.due > 0))) return false;
    return this.halted || (this.tasks.every(task => task.prepared && (!task.search || !isOpen(task.search))) && this.current === undefined);
  }

  /** The host's time, which every view and every check of S7 reads. */
  private now(): number {
    return this.clock + this.skew;
  }

  /** The host clock jumps: forward, or back across moments the record already holds. */
  private jump(): void {
    const minutes = this.r.pick([-150, -60, -20, -5, 5, 20, 60]);
    this.skew += minutes * MINUTE;
    bump(this.counts, minutes < 0 ? "clock:back" : "clock:forward");
  }

  private openTasks(): Task[] {
    return this.tasks.filter(task => task.search !== undefined && isOpen(task.search));
  }

  /** A search the host sees as wide for conditions 6 and 9: `wide`, or with a launch that waits for its receipt, ended or not. */
  private wide(task: Task): boolean {
    return (task.search !== undefined && isOpen(task.search) && task.search.state === "wide") || task.launches.some(l => !l.acked);
  }

  private actions(): (readonly [number, () => void])[] {
    const list: (readonly [number, () => void])[] = [];
    const later = (minutes: number, action: () => void) => () => { this.clock += minutes * MINUTE; action(); };
    for (const task of this.tasks) {
      for (const l of task.launches) {
        if (l.intent) list.push([l.slow ? 0.3 : 8, later(this.r.int(0, 2), () => this.prepareLaunch(task, l))]);
        else if (l.members !== undefined && l.due > 0) list.push([8, later(l.delay, () => this.receipt(task, l))]);
      }
    }
    if (this.halted) return list;
    const next = this.tasks.find(task => !task.prepared);
    if (next) list.push([3, later(this.r.int(0, 20), () => this.prepare(next))]);
    for (const m of this.members) if (m.working && (!m.challenger || m.acked)) list.push([3, later(this.r.int(0, 12), () => this.act(m))]);
    if (this.current) list.push([4, later(this.r.int(0, 12), () => this.complete())]);
    if (this.boundaryReady()) list.push([4, later(this.r.int(0, 5), () => this.boundary())]);
    // A restart is likelier while a slow launch waits for its preparation, so that the restart loses it, and while an
    // ended search's launch waits for its receipt, so that the restart finds the search ended.
    const endedLaunch = this.tasks.some(task => task.search && !isOpen(task.search) && task.launches.some(l => !l.acked));
    const slowLaunch = this.tasks.some(task => task.launches.some(l => l.intent && l.slow));
    if (this.openTasks().length > 0) {
      list.push([1, later(this.r.int(15, 90), () => this.tick())]);
      list.push([0.3, later(this.r.int(0, 5), () => this.queue.push({ kind: "work" }))]);
      list.push([0.06, later(this.r.int(0, 5), () => this.halt())]);
      list.push([endedLaunch || slowLaunch ? 1 : 0.12, later(this.r.int(0, 5), () => this.restart())]);
      list.push([0.4, later(this.r.int(0, 5), () => { this.loadHold = !this.loadHold; bump(this.counts, `load-hold:${this.loadHold ? "on" : "off"}`); })]);
      list.push([0.5, () => this.jump()]);
      list.push([0.2, later(this.r.int(0, 5), () => this.ghost())]);
    } else if (endedLaunch) {
      list.push([1, later(this.r.int(0, 5), () => this.restart())]);
    }
    if (list.length === 0) list.push([1, later(5, () => undefined)]);
    return list;
  }

  private newMember(task: Task, profileId: string, challenger: boolean): Member {
    const member: Member = { id: challenger ? `${task.id}-c${++this.serial}` : `${task.id}-m`, taskId: task.id, profileId, challenger, working: true,
      acked: !challenger, plan: drawPlan(this.r, challenger) };
    this.members.push(member);
    return member;
  }

  private task(id: string): Task {
    return this.tasks.find(task => task.id === id)!;
  }

  /** The run's spareAttempts: limit − members − launches not yet prepared − tasks not yet integrated − 3. */
  private spare(): number {
    const launching = this.tasks.flatMap(task => task.launches).filter(l => l.intent).reduce((sum, l) => sum + l.profileIds.length, 0);
    return this.limit - this.members.length - launching - this.tasks.filter(task => !task.done).length - 3;
  }

  private view(task: Task): RunView {
    const family = FAMILIES[task.champion!.profileId];
    return {
      now: at(this.now()), policy: this.policy, checkMinutes: this.checkMinutes, ...(this.deadline === undefined ? {} : { deadline: this.deadline }),
      otherSearchWide: this.tasks.some(other => other !== task && this.wide(other)),
      ...(family === undefined ? {} : { championFamily: family }),
      candidates: this.candidates.filter(c => c.profileId !== task.champion!.profileId),
      spareWorkerSlots: this.r.pick([0, 1, 2, 2, 3, 4]), freeSessionSlots: this.r.pick([0, 1, 2, 3, 3, 4]),
      spareAttempts: this.spare(), widened: [...this.project.history],
    };
  }

  // ---- Actions -----------------------------------------------------------------------------------------------------

  private prepare(task: Task): void {
    task.prepared = true;
    const champion = this.newMember(task, this.r.pick(PROFILE_IDS), false);
    task.champion = champion;
    // The owner resumes a paused project now and then, and the brake's count starts again; rarely the owner pauses it.
    if (this.project.paused && this.r.chance(0.3)) {
      Object.assign(this.project, { paused: false, history: [] });
      bump(this.counts, "owner:resume");
    } else if (!this.project.paused && this.r.chance(0.02)) {
      this.project.paused = true;
      bump(this.counts, "owner:pause");
    }
    const flips = [this.r.chance(0.03), this.r.chance(0.03), this.r.chance(0.03), this.r.chance(0.03), this.r.chance(0.03)];
    const criterion: Criterion = { id: `c-${task.id}`, origin: flips[2] ? "derived" : "owner", statement: "The check passes",
      check: { kind: "command", command: "digest-check" }, producer: "host", threshold: { kind: "pass" },
      pinned: [{ path: "tests/check.test.ts", blob: "a".repeat(40) }], state: "active" };
    const searches = this.tasks.filter(other => other.search !== undefined).length;
    const wide = this.tasks.some(other => this.wide(other));
    const facts: AdmissionFacts = {
      id: `${this.label}:${task.id}`, now: at(this.now()), policy: this.policy,
      routing: { mode: flips[0] ? "shadow" : "auto", coversStart: true, revoked: false },
      run: { goalCycle: true, recordDigest: true, requiredChecks: ["digest-check"], searches, wideSearch: wide,
        ...(this.deadline === undefined ? {} : { deadline: this.deadline }) },
      task: { role: "implementer", risk: flips[1] ? "elevated" : "normal", firstAttempt: true, criterionId: criterion.id, criterionShared: false,
        duel: false, exploratoryStart: flips[4]!, baseCommit: BASE, decisionKey: `decision-${task.id}` },
      champion: { memberId: champion.id, profileId: champion.profileId }, criterion,
      pins: { atBase: !flips[3], owned: false },
      project: { paused: this.project.paused, starts: Array.from({ length: this.r.int(15, 130) }, () => this.r.chance(0.07)) },
    };
    const admission = this.engine.admit(facts);
    // S10: conditions 1 to 5 hold unless a flip broke one; then condition 6 is the pause, two searches, or a wide search.
    if (!flips.some(Boolean)) {
      const six = this.project.paused || searches >= 2 || wide;
      const refusedAtSix = !admission.admitted && admission.condition === 6;
      if (six !== refusedAtSix) this.fail("S10", `admission ${JSON.stringify(admission.admitted ? "admitted" : admission.condition)} with the project ${this.project.paused ? "paused" : "not paused"}, ${searches} searches, wide ${wide}`, task);
    }
    if (!admission.admitted) {
      bump(this.counts, `admission:refused-${admission.condition}`);
      return;
    }
    bump(this.counts, "admission:admitted");
    this.parse(admission.search, task);
    task.search = admission.search;
    this.apply(task, admission.decisions);
  }

  private act(m: Member): void {
    const task = this.task(m.taskId);
    const s = task.search;
    if (!s || !isOpen(s)) {
      // No search holds this member: it goes on as today, outside the simulator.
      m.working = false;
      if (!m.challenger) task.done = true;
      return;
    }
    const plan = m.plan;
    if (plan.kind === "leave" && plan.reason === "permission" && !m.challenger) {
      this.deliver(task, { kind: "left", memberId: m.id, reason: "permission" });
      m.plan = drawPlan(this.r, false);
      return;
    }
    m.working = false;
    if (plan.kind === "leave") {
      this.deliver(task, { kind: "left", memberId: m.id, reason: plan.reason });
      if (s.mode === "measure") task.done = true;
      return;
    }
    if (s.mode === "live") return this.deliver(task, { kind: "result", memberId: m.id });
    // `measure`: today's single operation captures and integrates the result, or refuses it.
    task.done = true;
    if (plan.scope === "violation" || this.r.chance(0.04)) {
      this.deliver(task, { kind: "left", memberId: m.id, reason: plan.scope === "violation" ? "scope" : "conflict" });
    } else {
      this.deliver(task, { kind: "integrated", memberId: m.id, commit: commitOf(m.id), tree: `${m.id}:tree`, empty: plan.empty });
    }
  }

  private complete(): void {
    const op = this.current!;
    this.current = undefined;
    if (op.kind === "work") return;
    const task = this.task(op.taskId!);
    if (op.kind === "base") return this.deliver(task, { kind: "base", outcome: op.outcome!, ms: this.r.int(1, 900) * 1000 });
    const m = this.members.find(member => member.id === op.memberId)!;
    const plan = m.plan as ResultPlan;
    if (op.kind === "capture") {
      return this.deliver(task, { kind: "captured", memberId: m.id, commit: commitOf(m.id), tree: `${m.id}:tree`, scope: plan.scope, empty: plan.empty });
    }
    if (op.stale) bump(this.counts, "fault:late-gate-result");
    this.deliver(task, { kind: "gated", memberId: m.id, outcome: plan.gate, ms: this.r.int(1, 900) * 1000 }, { stale: op.stale === true });
  }

  private boundaryReady(): boolean {
    return this.policy.mode === "measure" && this.tasks.every(task => task.prepared && task.done) && !this.members.some(m => m.working)
      && this.current === undefined && this.queue.length === 0 && this.waitingAtBoundary().length > 0;
  }

  private waitingAtBoundary(): Task[] {
    return this.openTasks().filter(task => task.search!.holdUntil === undefined && task.search!.contestants[0]!.captured !== undefined);
  }

  private boundary(): void {
    const waiting = this.waitingAtBoundary();
    bump(this.counts, "measure:boundary");
    for (const task of waiting) this.deliver(task, { kind: "boundary", searches: waiting.length });
  }

  private tick(): void {
    for (const task of this.openTasks()) this.deliver(task, { kind: "tick" });
  }

  private halt(): void {
    const reason = this.r.pick(HALTS);
    bump(this.counts, `fault:halt-${reason}`);
    for (const task of this.openTasks()) this.deliver(task, { kind: "halt", reason });
    this.halted = true;
  }

  private restart(): void {
    const op = this.current;
    if (op !== undefined) {
      bump(this.counts, "fault:restart-during-operation");
      for (const task of this.openTasks()) this.deliver(task, { kind: "halt", reason: op.taskId === task.id ? "restart" : "block" });
      this.halted = true;
      return;
    }
    bump(this.counts, "fault:restart-resume");
    // A launch not yet prepared lived in memory; prepared members and their receipts are on record.
    for (const task of this.tasks) for (const l of task.launches) if (l.members === undefined && l.intent) {
      l.intent = false;
      bump(this.counts, "fault:launch-lost");
    }
    // The host resumes every open search, and every ended one whose launch still waits for its receipt.
    for (const task of this.tasks) if (task.search && (isOpen(task.search) || task.launches.some(l => !l.acked))) this.deliver(task, { kind: "resume" });
  }

  /** An event of a member or a launch the search does not know. */
  private ghost(): void {
    const task = this.r.pick(this.openTasks());
    const id = `${task.id}-ghost`;
    const event = this.r.pick<SearchEvent>([{ kind: "result", memberId: id }, { kind: "left", memberId: id, reason: "stall" },
      { kind: "captured", memberId: id, commit: commitOf(id), tree: `${id}:tree`, scope: "ok", empty: false },
      { kind: "gated", memberId: id, outcome: "pass", ms: 1000 }, { kind: "started", launch: 99, challengers: [{ memberId: id, profileId: "p-gpt" }] }]);
    bump(this.counts, `fault:unknown-${event.kind}`);
    this.deliver(task, event, { ghost: true });
  }

  /** The host prepares a launch's challengers, each through the spend fuse, and owes the launch's receipt. */
  private prepareLaunch(task: Task, l: Launch): void {
    l.intent = false;
    const admitted = l.profileIds.filter(() => !this.r.chance(0.12));
    bump(this.counts, "fuse:refused", l.profileIds.length - admitted.length);
    l.members = admitted.map(profileId => this.newMember(task, profileId, true));
    bump(this.counts, "challengers:started", l.members.length);
    l.due = this.r.chance(0.2) ? 2 : 1;
    // Most receipts follow at once; some arrive late enough to cross the hold, the wait, or the end.
    l.delay = this.r.chance(0.2) ? this.r.int(10, 60) : 0;
  }

  private receipt(task: Task, l: Launch): void {
    l.due -= 1;
    const first = !l.acked;
    l.acked = true;
    for (const m of l.members!) m.acked = true;
    bump(this.counts, first ? (isOpen(task.search!) ? "receipt:first" : "receipt:after-end") : "receipt:repeat");
    const challengers = l.members!.map(m => ({ memberId: m.id, profileId: m.profileId }));
    this.deliver(task, { kind: "started", launch: l.n, challengers }, { receipt: first ? "first" : "again" });
  }

  // ---- The model host ----------------------------------------------------------------------------------------------

  /** One operation at a time, none started under the host-load hold: other work first, in any order (captures can
   * overtake a queued gate run); a `live` base run starts only when nothing else waits, and yields to it. */
  private settleOps(): void {
    for (;;) {
      const op = this.current;
      if (op?.kind === "base" && this.task(op.taskId!).search?.mode === "live" && this.queue.some(item => item.kind !== "base")) {
        this.current = undefined;
        bump(this.counts, "fault:base-yield");
        this.deliver(this.task(op.taskId!), { kind: "base", outcome: "yielded", ms: this.r.int(1, 60) * 1000 });
        continue;
      }
      if (this.current === undefined && this.queue.length > 0 && !this.loadHold) {
        const other = this.queue.flatMap((item, index) => (item.kind === "base" ? [] : [index]));
        this.current = this.queue.splice(other.length > 0 ? this.r.pick(other) : 0, 1)[0];
        continue;
      }
      return;
    }
  }

  private drawBase(): GateOutcome {
    return weighted(this.r, [[80, "fail"], [8, "pass"], [6, "timeout"], [6, "setup-failed"]] as const);
  }

  private dropOps(task: Task): void {
    this.queue = this.queue.filter(op => op.taskId !== task.id);
    const op = this.current;
    if (op?.taskId !== task.id || op.stale) return;
    if (op.kind === "gate" && this.r.chance(0.5)) {
      op.stale = true;
      bump(this.counts, "fault:unstoppable-gate");
    } else {
      this.current = undefined;
    }
  }

  private apply(task: Task, decisions: readonly Decision[], event?: SearchEvent): void {
    if (event?.kind === "resume") this.queue = this.queue.filter(op => op.taskId !== task.id);
    for (const d of decisions) {
      bump(this.counts, `decision:${d.kind}`);
      if (d.kind === "base-run") this.queue.push({ kind: "base", taskId: task.id, outcome: this.drawBase() });
      else if (d.kind === "capture") this.queue.push({ kind: "capture", taskId: task.id, memberId: d.memberId });
      else if (d.kind === "gate") {
        this.queue.push({ kind: "gate", taskId: task.id, memberId: d.memberId });
        task.ledger.outstanding = d.memberId;
      } else if (d.kind === "start-challengers") {
        // A repeated decision prepares a launch whose intent a restart lost, or delivers the prepared one's receipt again.
        const known = task.launches.find(l => l.n === d.launch);
        // Some launches wait long for preparation, so the hold, the wait, a halt or a restart can overtake them.
        if (known === undefined) task.launches.push({ n: d.launch, profileIds: [...d.profileIds], intent: true, acked: false, due: 0, delay: 0, slow: this.r.chance(0.2) });
        else if (known.members === undefined) known.intent = true;
        else known.due += 1;
      } else if (d.kind === "stop") {
        for (const id of d.memberIds) for (const m of this.members) if (m.id === id) m.working = false;
      } else if (d.kind === "stop-operations") this.dropOps(task);
      else if (d.kind === "integrate") task.done = true;
      else if (d.kind === "release") {
        task.done = true;
        task.champion!.working = false; // A champion that still works goes on as a single attempt, outside the simulator.
      } else if (d.kind === "cancel-launch") {
        // The host prepares nothing more for the launch and owes its one receipt: an empty one when nothing was prepared.
        const l = task.launches.find(item => item.n === d.launch);
        if (l !== undefined && !l.acked && l.members === undefined) {
          bump(this.counts, l.intent ? "cancel:unprepared" : "cancel:lost-in-restart");
          Object.assign(l, { intent: false, members: [], due: 1, delay: this.r.chance(0.3) ? this.r.int(5, 40) : 0 });
        } else if (l !== undefined && !l.acked) bump(this.counts, "cancel:prepared");
      } else if (d.kind === "pause") this.project.paused = true;
    }
  }

  /** Delivers one event to a task's search: the engine's step, the checks, then the host acts on the decisions. */
  private deliver(task: Task, event: SearchEvent, meta: Meta = {}): void {
    const prev = task.search!;
    const view = this.view(task);
    const { search: next, decisions } = this.engine.step(prev, event, view);
    bump(this.counts, `event:${event.kind}`);
    this.check(task, prev, next, decisions, event, view, meta);
    task.search = next;
    this.apply(task, decisions, event);
    this.checkAfter(task, prev, next);
    // S13, last: the host contract redelivers an event whose step it had not saved. Delivered again at once, the event
    // does what the time passing alone does.
    if (event.kind !== "resume" && event.kind !== "tick" && !isDeepStrictEqual(this.engine.step(next, event, view), this.engine.step(next, { kind: "tick" }, view))) {
      this.fail("S13", `an event delivered again did more than the time passing (event ${JSON.stringify(event)})`, task);
    }
  }

  // ---- Invariants --------------------------------------------------------------------------------------------------

  private parse(s: SearchState, task: Task): void {
    const parsed = searchStateSchema.safeParse(s);
    if (!parsed.success) this.fail("S0", `the state does not parse: ${parsed.error.message}`, task);
    if (s.contestants[0]!.memberId !== task.champion!.id) this.fail("S0", "the champion is not first", task);
  }

  private check(task: Task, prev: SearchState, next: SearchState, decisions: readonly Decision[], event: SearchEvent, view: RunView, meta: Meta): void {
    const fail = (invariant: string, message: string): never => this.fail(invariant, `${message} (event ${JSON.stringify(event)}, decisions ${JSON.stringify(decisions)})`, task);
    const ledger = task.ledger;
    const now = this.now();
    const of = (kind: Decision["kind"]) => decisions.filter(d => d.kind === kind);
    const stops = decisions.flatMap(d => (d.kind === "stop" ? d.memberIds : []));
    this.parse(next, task);

    // S10: a search counts toward the brake once, from the receipts the simulator delivered: in the first step in which
    // a first receipt that named a member has been delivered and the search has ended (at its end, or at a receipt that
    // arrives after it), with the oracle's class; a pause comes with every count that leaves the brake engaged.
    const named = event.kind === "started" && meta.receipt === "first" && event.challengers.length > 0;
    const checkCount = (endedNow: boolean) => {
      if (named) ledger.widened = true;
      const counted = decisions.filter(d => d.kind === "widened");
      const pauses = of("pause").length;
      if (!ledger.widened || isOpen(next) || ledger.counted) {
        if (counted.length + pauses > 0) fail("S10", `${counted.length} counts and ${pauses} pauses from a search that owes none`);
        return;
      }
      ledger.counted = true;
      const searchClass = ledger.oracleClass ?? "none";
      const expectPause = engaged([...this.project.history, searchClass]);
      if (!isDeepStrictEqual(counted, [{ kind: "widened", class: searchClass }])) fail("S10", `counted ${JSON.stringify(counted)}, expected ${searchClass} once`);
      if (pauses !== (expectPause ? 1 : 0)) fail("S10", `pause ${pauses}, expected ${expectPause ? 1 : 0}`);
      this.project.history.push(searchClass);
      bump(this.counts, endedNow ? "end:widened" : "count:late");
      if (expectPause) bump(this.counts, this.project.paused ? "pause:again" : "pause:first");
    };

    // S13
    if (event.kind === "started" && meta.receipt === "first") {
      for (const { memberId } of event.challengers) {
        if (!next.contestants.some(c => c.memberId === memberId) && !stops.includes(memberId)) fail("S13", `${memberId} was acknowledged and is neither a contestant nor stopped`);
      }
      if (isOpen(prev) && !isOpen(next)) bump(this.counts, "receipt:crossing-timer");
    }
    if ((meta.receipt === "again" || meta.ghost) && !isDeepStrictEqual(this.engine.step(prev, { kind: "tick" }, view), { search: next, decisions })) {
      fail("S13", "a repeated receipt or an unknown member's event did more than the time passing");
    }
    const winner = next.winner ?? prev.winner;
    if (winner !== undefined && stops.includes(winner)) fail("S13", `the winner ${winner} was stopped`);
    // An end with a launch out cancels it once, and so does a restart that finds the search ended with it out.
    const out = task.launches.find(l => !l.acked);
    const cancels = decisions.flatMap(d => (d.kind === "cancel-launch" ? [d.launch] : []));
    const owed = out !== undefined && !isOpen(next) && (isOpen(prev) || event.kind === "resume");
    if (!isDeepStrictEqual(cancels, owed ? [out.n] : [])) fail("S13", `cancelled ${JSON.stringify(cancels)} with launch ${out?.n ?? "none"} out`);
    if (owed) bump(this.counts, isOpen(prev) ? "cancel:at-end" : "cancel:at-restart");

    // S14
    for (const id of stops) {
      if (ledger.resulted.has(id)) fail("S14", `${id} is stopped after its result arrived`);
      ledger.stopped.add(id);
    }
    for (const d of decisions) {
      if ((d.kind === "gate" || d.kind === "capture") && ledger.stopped.has(d.memberId)) fail("S14", `${d.memberId} was stopped and is ${d.kind === "gate" ? "gated" : "captured"}`);
    }
    if (event.kind === "result" && !meta.ghost) ledger.resulted.add(event.memberId);

    // S3: an ended search changes only by its launch's first receipt, which clears it and, naming a member, widens it.
    if (!isOpen(prev)) {
      const late = event.kind === "started" && meta.receipt === "first";
      const { pending: _pending, ...settled } = prev;
      if (!isDeepStrictEqual(next, !late ? prev : named ? { ...settled, widened: true } : settled)) fail("S3", `an ended (${prev.state}) search changed`);
      const other = decisions.filter(d => !["stop", "widened", "pause", "cancel-launch"].includes(d.kind));
      if (other.length > 0) fail("S3", `an ended search decided ${other.map(d => d.kind).join(", ")}`);
      const want = named ? [{ kind: "stop", memberIds: event.challengers.map(c => c.memberId), reason: "host" }] : [];
      if (!isDeepStrictEqual(of("stop"), want)) fail("S13", "a receipt after the end stops other members than it names");
      checkCount(false);
      return;
    }
    if (!NEXT[prev.state]!.includes(next.state)) fail("S3", `${prev.state} moved to ${next.state}`);
    const ended = !isOpen(next);
    const live = next.mode === "live";
    const first = next.contestants[0]!;
    const championId = task.champion!.id;

    // Ledger: what the simulator delivered. The arming is read from the delivered failed base run and the simulator's
    // own hold, since a hold that has passed ends the search before a base result in the same step applies.
    if (!meta.ghost) {
      if (live && event.kind === "base" && event.outcome === "fail" && ledger.base === undefined && !(ledger.hold !== undefined && now >= ledger.hold)) ledger.armed = true;
      if (event.kind === "base") ledger.base = event.outcome;
      if (event.kind === "gated" && !meta.stale) {
        ledger.gated.push({ memberId: event.memberId, outcome: event.outcome });
        if (ledger.outstanding === event.memberId) ledger.outstanding = undefined;
      }
      const okCapture = (event.kind === "captured" && event.scope === "ok" && !event.empty) || (event.kind === "integrated" && !event.empty && event.memberId === championId);
      if (okCapture && !ledger.okCaptures.has(event.memberId)) ledger.okCaptures.set(event.memberId, ledger.wait === undefined || now < ledger.wait);
    }
    const gateable = [...ledger.okCaptures].filter(([, before]) => before).map(([id]) => id);
    const waiting = gateable.filter(id => !ledger.gated.some(g => g.memberId === id));

    // S7: each cutoff the step sets is at most its design duration after the host time of the step, and none moves.
    for (const key of ["holdUntil", "waitUntil"] as const) {
      const before = prev[key];
      const after = next[key];
      if (before !== undefined && after !== before) fail("S7", `${key} moved from ${before} to ${after}`);
      if (before !== undefined || after === undefined) continue;
      const minutes = key === "waitUntil" ? this.policy.waitMinutes : live ? allowance(this.policy, ledger.base === undefined)
        : event.kind === "boundary" ? windowMinutes(this.policy, event.searches) : 0;
      if (Date.parse(after) > now + minutes * MINUTE) fail("S7", `${key} ${after} is more than ${minutes} minutes after the host time ${at(now)}`);
      bump(this.counts, `cutoff:${key}`);
    }

    // S7's times, from the events the simulator delivered, the host time, and the design's formulas.
    if (isOpen(next) && !meta.ghost) {
      if (live && event.kind === "result" && event.memberId === championId) ledger.hold ??= now + allowance(this.policy, ledger.base === undefined) * MINUTE;
      const left = live && event.kind === "left" && event.memberId === championId && (event.reason === "stall" || event.reason === "no-report") && ledger.base === "fail";
      if (left) ledger.hold = now + allowance(this.policy, false) * MINUTE;
      const failed = (event.kind === "gated" && !meta.stale && event.memberId === championId && event.outcome !== "pass")
        || (event.kind === "captured" && event.memberId === championId && (event.scope === "violation" || event.empty));
      if (live && (failed || left)) ledger.wait ??= now + this.policy.waitMinutes * MINUTE;
      if (!live && event.kind === "boundary") ledger.window ??= now + windowMinutes(this.policy, event.searches) * MINUTE;
    }

    // S9, first: arming is what the later checks build on.
    const failedBase = event.kind === "base" && event.outcome === "fail";
    if (prev.armedAt === undefined && next.armedAt !== undefined && !(failedBase && live)) fail("S9", "armed without a failed base run of a live search");
    if (prev.armedAt !== undefined && next.armedAt !== prev.armedAt) fail("S9", "armedAt changed");
    if (failedBase && live && prev.state === "admitting" && isOpen(next) && next.armedAt === undefined) fail("S9", "a failed base run left the search unarmed");

    // S1
    const integrates = of("integrate");
    ledger.integrates += integrates.length;
    if (ledger.integrates > 1) fail("S1", "a second integrate");
    if (live) {
      if ((next.state === "resolved") !== (next.winner !== undefined)) fail("S1", `state ${next.state} with winner ${next.winner}`);
      const resolvedNow = next.state === "resolved" && prev.state !== "resolved";
      if (resolvedNow !== (integrates.length === 1) || (resolvedNow && (integrates[0] as { memberId: string }).memberId !== next.winner)) {
        fail("S1", "an integrate outside the step that resolves, or of another member than the winner");
      }
      const delivered = event.kind === "gated" && !meta.stale && !meta.ghost;
      const passes = ledger.gated.filter(g => g.outcome === "pass");
      if (resolvedNow && !(delivered && event.outcome === "pass" && passes.length === 1 && event.memberId === next.winner)) {
        fail("S1", `resolved for ${next.winner}, the gate results delivered are ${JSON.stringify(ledger.gated)}`);
      }
      if (delivered && event.outcome === "pass" && !resolvedNow && !(ledger.hold !== undefined && now >= ledger.hold)) fail("S1", `the pass of ${event.memberId} did not resolve the search`);
    }

    // S2
    for (const d of of("start-challengers")) {
      if (d.kind !== "start-challengers") continue;
      if (!live) fail("S11", "a measure search started a challenger");
      if (task.launches.some(l => l.n === d.launch)) {
        if (event.kind !== "resume") fail("S2", `launch ${d.launch} decided again outside a restart`);
        continue;
      }
      if (d.launch !== 1 + Math.max(0, ...task.launches.map(l => l.n))) fail("S2", `launch ${d.launch} after ${task.launches.length}`);
      if (task.launches.some(l => !l.acked)) fail("S2", "a launch while another waits for its receipt");
      const championFamily = FAMILIES[task.champion!.profileId];
      if (view.otherSearchWide) fail("S2", "challengers while another search is wide or launching");
      if (championFamily === undefined) fail("S2", "challengers for a champion of unknown family");
      const families = d.profileIds.map(p => FAMILIES[p]);
      if (families.some(f => f === undefined) || new Set([championFamily, ...families]).size !== families.length + 1) fail("S2", `families ${families.join(",")} against ${championFamily}`);
      if (d.profileIds.some(p => this.candidates.find(c => c.profileId === p)?.limited)) fail("S2", "a limited profile");
      if (this.spare() - d.profileIds.length < RESERVE) fail("S2", `the reserve: spareAttempts ${this.spare()} with ${d.profileIds.length} challengers`);
      if (d.profileIds.length > Math.min(view.spareWorkerSlots, view.freeSessionSlots)) fail("S2", "more challengers than free slot pairs");
      if (next.contestants.length + d.profileIds.length > this.policy.attempts) fail("S2", `more than ${this.policy.attempts} attempts`);
      if (d.baseCommit !== BASE) fail("S2", "a challenger off the champion's base commit");
      const arming = this.policy.start === "together" && event.kind === "base" && event.outcome === "fail";
      bump(this.counts, arming ? "widen:arming" : "widen:champion-done");
      if (!arming && !championDone(next)) fail("S2", "a challenger while the champion still works");
    }

    // S4, S5: against the captures and gate results the simulator delivered.
    const gates = of("gate");
    if (gates.length > 1) fail("S4", "two gate runs at once");
    for (const g of gates) {
      if (g.kind !== "gate") continue;
      if (g.memberId !== waiting[0]) fail("S4", `gated ${g.memberId}, the first capture delivered before the wait and waiting is ${waiting[0]}`);
      if (g.commit !== commitOf(g.memberId)) fail("S4", "a gate run off the captured commit");
      if (event.kind === "resume") continue;
      if (ended || next.state === "resolved") fail("S5", "a gate run for an ended or resolved search");
      if (ledger.outstanding !== undefined) fail("S4", `a gate run while ${ledger.outstanding}'s is outstanding`);
    }
    if (next.state === "resolved" && prev.state !== "resolved") {
      const place = gateable.indexOf(next.winner!);
      if (place < 0) fail("S4", `the winner ${next.winner} has no capture delivered before the wait`);
      for (const id of gateable.slice(0, place)) {
        const result = ledger.gated.find(g => g.memberId === id);
        if (result === undefined || result.outcome === "pass") fail("S4", `${id} was captured before the winner and not failed`);
      }
    }
    if (ended && next.endReason === "wait" && waiting.length > 0) fail("S4", `ended by the wait while ${waiting[0]}'s capture, delivered before it, waits for its gate`);

    // S6: releases in this step.
    const releases = of("release");
    ledger.releases += releases.length;
    if (live && ended) {
      const want = next.state === "resolved" ? 0 : 1;
      if (releases.length !== want) fail("S6", `${releases.length} releases when the search ended ${next.state}`);
      if (releases.some(d => d.kind === "release" && d.memberId !== first.memberId)) fail("S6", "a release of another member than the champion");
    } else if (releases.length > 0) fail("S6", "a release while the search goes on");

    // S8: the class from what the simulator delivered: the pass that resolved the search (S1 ties the resolution to it)
    // and the champion's fate delivered in earlier steps. Then this step's fate, for later steps.
    if (ended && live && ledger.armed) {
      const winner = next.state === "resolved" && event.kind === "gated" ? event.memberId : undefined;
      const expected: SearchClass = winner === undefined ? "none" : winner === championId ? "champion-pass"
        : ledger.championDone ? "rescued" : "challenger-first";
      ledger.oracleClass = expected;
      if (next.class !== expected) fail("S8", `class ${next.class}, expected ${expected}`);
      if (next.class === "challenger-first" && this.policy.start !== "together") fail("S8", "challenger-first under after-fail");
    } else if (next.class !== undefined) fail("S8", `class ${next.class} on a search that is open, measured, or never armed`);
    if (ledger.armed && !meta.ghost && !meta.stale) {
      const fate = (event.kind === "gated" && event.memberId === championId && event.outcome !== "pass")
        || (event.kind === "captured" && event.memberId === championId && (event.scope === "violation" || event.empty))
        || (event.kind === "left" && event.memberId === championId && (event.reason === "stall" || event.reason === "no-report"));
      if (fate) ledger.championDone = true;
    }

    // S10
    if (ended) {
      bump(this.counts, `end:${next.state}`);
      bump(this.counts, `reason:${next.endReason ?? next.state}`);
      if (next.class !== undefined) bump(this.counts, `class:${next.class}`);
    }
    checkCount(ended);

    // S11
    if (!live) {
      const forbidden = decisions.filter(d => ["capture", "start-challengers", "integrate", "release", "pause", "stop"].includes(d.kind));
      if (forbidden.length > 0) fail("S11", `a measure search decided ${forbidden.map(d => d.kind).join(", ")}`);
      if (of("base-run").length > 0 && event.kind !== "boundary" && event.kind !== "resume") fail("S11", "a measure base run outside the boundary");
      if (next.state === "measured" && prev.state !== "measured" && (ledger.base !== "fail" || first.gate === undefined)) {
        fail("S11", `measured with base ${ledger.base} and gate ${first.gate?.result}`);
      }
    }

    // S12
    if (event.kind === "resume" && isOpen(next)) {
      // Captures that have not completed have no order yet, so they compare as a set; gate runs follow capture order. Once
      // the wait has passed, no capture is owed: none would be gated.
      const queued = this.queue.filter(op => op.taskId === task.id && !(op.kind === "capture" && ledger.wait !== undefined && now >= ledger.wait));
      const want = { base: queued.filter(op => op.kind === "base").length, captures: queued.filter(op => op.kind === "capture").map(op => op.memberId).sort(),
        gates: queued.filter(op => op.kind === "gate").map(op => op.memberId), launches: task.launches.filter(l => !l.acked).map(l => [l.n, l.profileIds]) };
      const got = { base: of("base-run").length, captures: of("capture").map(d => (d as { memberId: string }).memberId).sort(),
        gates: gates.map(d => (d as { memberId: string }).memberId),
        launches: of("start-challengers").map(d => (d.kind === "start-challengers" ? [d.launch, d.profileIds] : [])) };
      if (!isDeepStrictEqual(got, want)) fail("S12", `resume decided ${JSON.stringify(got)}, the host had ${JSON.stringify(want)}`);
    }
  }

  /** Checks on the simulator's members and its own clock once the host has acted on the step's decisions. */
  private checkAfter(task: Task, prev: SearchState, next: SearchState): void {
    const now = this.now();
    const ledger = task.ledger;
    const working = this.members.filter(m => m.taskId === task.id && m.challenger && m.acked && m.working);
    if (next.mode === "live" && !isOpen(next)) {
      if (working.length > 0) this.fail("S6", `${working.map(m => m.id).join(", ")} still work after the search ended ${next.state}`, task);
      if (isOpen(prev) && next.state === "resolved" && next.winner !== task.champion!.id && task.champion!.working) this.fail("S6", "the champion works on after a challenger won", task);
    }
    if (isOpen(prev) && !isOpen(next)) {
      const times: Record<string, number | undefined> = { hold: ledger.hold, wait: ledger.wait, window: ledger.window };
      const reason = next.endReason ?? "";
      if (reason in times && (times[reason] === undefined || now < times[reason]!)) this.fail("S7", `ended by its ${reason} at ${at(now)}, before ${times[reason] === undefined ? "any" : at(times[reason]!)}`, task);
      if (reason === "hold" && next.state !== "exhausted") this.fail("S7", `the hold ended the search as ${next.state}, not exhausted (acceptance 11)`, task);
    }
    if (!isOpen(next)) return;
    const deadline = this.deadline === undefined ? undefined : Date.parse(this.deadline);
    if (next.mode === "measure") {
      if (ledger.window !== undefined && now >= ledger.window) this.fail("S7", `open at ${at(now)}, past its window ${at(ledger.window)}`, task);
      if (deadline !== undefined && ledger.window !== undefined && ledger.window + this.checkMinutes * MINUTE > deadline) this.fail("S7", "a window that does not fit before the deadline", task);
      return;
    }
    if (ledger.hold !== undefined && now >= ledger.hold) this.fail("S7", `open at ${at(now)}, past its hold ${at(ledger.hold)}`, task);
    if (deadline !== undefined && ledger.hold !== undefined && ledger.hold > deadline) this.fail("S7", `hold ${at(ledger.hold)} past the deadline ${this.deadline}`, task);
    if (ledger.wait !== undefined && now >= ledger.wait) {
      if (working.length > 0) this.fail("S7", `${working.map(m => m.id).join(", ")} work past the wait ${at(ledger.wait)}`, task);
      const waiting = [...ledger.okCaptures].some(([id, before]) => before && !ledger.gated.some(g => g.memberId === id));
      if (!waiting) this.fail("S7", `open past the wait ${at(ledger.wait)} with no capture made before it waiting for its gate`, task);
    }
  }
}

/** One seed: four runs in one project whose brake history starts from a random prior, paused when it engages the brake. */
export function simulate(seed: number, engine: Engine, counts: Counts): void {
  const r = rand(seed);
  // A third of the projects start one widened search short of the brake's window, so that counts engage it often.
  const length = r.chance(0.33) ? 9 : r.int(0, 14);
  const history: SearchClass[] = Array.from({ length }, () => weighted(r, [[25, "rescued"], [35, "none"], [30, "champion-pass"], [10, "challenger-first"]] as const));
  const project: Project = { history, paused: engaged(history) };
  for (let run = 1; run <= RUNS_PER_SEED; run += 1) {
    new RunSim(r, engine, counts, project, `seed ${seed} run ${run} (reproduce with SEARCH_SIM_SEED=${seed})`).run();
  }
}
