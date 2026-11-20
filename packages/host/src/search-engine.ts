import { z } from "zod";
import type { Criterion } from "./objective-types.js";
import { SHARE_EPSILON } from "./routing-guards.js";

/*
 * The search engine of search mode (docs/superpowers/specs/2026-11-18-search-mode-design.md, delivery phase 1). It
 * applies admission, the base run, captures, gate results, leaves, widening, the wait, the hold, the measurement window
 * and the release to `task.search`. Every function is pure: time, run counters, slots, candidates and the brake history
 * are inputs, and the host acts on the returned decisions. Part numbers, conditions (1 to 12) and rules (1 to 9) below
 * are the design's. Each `PROPOSED:` comment marks a rule the design does not state, for the owner to decide before the
 * wiring phase; `CONTRADICTION:` marks a place where two statements of the design disagree.
 */

/*
 * Host contract (the wiring phase). The engine is correct only when the host keeps these duties; the simulator
 * (tests/search-engine-sim-script.ts) models them. PROPOSED as a whole: the design states the outcomes, not this order.
 *
 * Persistence order.
 * - The source of every event is durable before the event is delivered: the operation record of a base run, a capture
 *   or a gate run, the member's report or leave, the launch's receipt (below). After a restart the host delivers again
 *   every event whose step it had not saved; an event the search has already applied changes nothing.
 * - Before it acts on any decision, the host saves the step's state as `task.search` together with the step's decisions,
 *   in one write. It acts on each saved decision once, idempotently by search ID (a launch by its number, a count by the
 *   search ID), and after a restart it first finishes the saved decisions it had not finished.
 * - After a restart while the run has no workspace operation open, the host delivers `resume` to every open search and
 *   to every ended search whose `pending` is set. Resume re-derives an open search's base run, waiting captures, head
 *   gate run and pending launch, and an ended search's `cancel-launch`. A restart during a workspace operation of a
 *   search delivers `halt` with reason `restart` instead (Failure modes).
 *
 * Launches and receipts.
 * - Before it prepares any member of a `start-challengers`, the host saves the launch: search ID, number and profiles.
 *   It saves each prepared member under its launch before that member starts work.
 * - Each launch has exactly one receipt, the final one. It names every member the host prepared for the launch and no
 *   other: none when the spend fuse refused every profile, or when the launch was cancelled before any member was
 *   prepared. The host saves the receipt before it delivers it, never changes it, and delivers it again after a restart
 *   until the saved search no longer has that launch pending. An empty receipt is delivered like any other.
 * - A `start-challengers` repeated under the same number (at a resume) prepares only the profiles of that launch that
 *   have no saved member; the launch's one receipt names all of its members.
 * - On `cancel-launch` the host prepares no further member for that launch. When the launch's receipt is not yet saved,
 *   it saves one naming the members already prepared, possibly none, and delivers it; when it is saved, it delivers
 *   that one. The engine stops every member the receipt names, and the receipt clears `pending`.
 * - Conditions 6 and 9: `wideSearch` and `otherSearchWide` hold while a search of the run is `wide` or has `pending`
 *   set, ended or not. Condition 11: `spareAttempts` counts each profile of a pending launch without a saved member as
 *   a member.
 *
 * Member events.
 * - No `result`, `captured`, `gated` or `left` event of a challenger is delivered before the receipt that names it; the
 *   host holds such an event until that receipt is delivered. The engine ignores events of members it does not know.
 *
 * The brake.
 * - On `widened` the host appends the class to the project's widened history, once per search ID; on `pause` it stores
 *   the project's pause. Only the owner's resume clears the pause and starts the history again. Both reach the engine as
 *   inputs: `AdmissionFacts.project.paused` and `RunView.widened`.
 *
 * Time: `view.now` is the host's effective time (Time, below).
 */

// ---- Policy (Part 1) ---------------------------------------------------------------------------------------------

/** The saved policy. No key has a schema default; `searchPolicy` applies the read defaults (umbrella C11). */
export const teamSearchSchema = z.object({
  mode: z.enum(["off", "measure", "live"]).optional(),
  start: z.enum(["after-fail", "together"]).optional(),
  share: z.number().min(0).max(0.25).optional(),
  attempts: z.number().int().min(2).max(4).optional(),
  gateMinutes: z.number().int().min(1).max(60).optional(),
  waitMinutes: z.number().int().min(5).max(120).optional(),
}).strict();
export type TeamSearch = z.infer<typeof teamSearchSchema>;
export type SearchPolicy = Required<TeamSearch>;

/** The owner's accepted defaults (owner decisions 2 and 3). */
const SEARCH_DEFAULTS: SearchPolicy = { mode: "off", start: "after-fail", share: 0.1, attempts: 3, gateMinutes: 15, waitMinutes: 60 };

export function searchPolicy(saved: TeamSearch = {}): SearchPolicy {
  const d = SEARCH_DEFAULTS;
  return { mode: saved.mode ?? d.mode, start: saved.start ?? d.start, share: saved.share ?? d.share, attempts: saved.attempts ?? d.attempts,
    gateMinutes: saved.gateMinutes ?? d.gateMinutes, waitMinutes: saved.waitMinutes ?? d.waitMinutes };
}

/** The clone and the setup command of one gate run (Part 3). */
const GATE_SETUP_MINUTES = 20;
/** Condition 6. */
const SEARCHES_PER_RUN = 2;
/** Condition 7: the share reads the project's last 100 applied `start` decisions. */
const SHARE_WINDOW = 100;
/** Condition 11: a challenger starts only while `spareAttempts(run)`, with it counted, stays at this or above. */
const RESERVE = 3;
/** Part 8: the brake reads the last 10 widened searches and pauses below 2 rescues. */
const BRAKE_WINDOW = 10;
const BRAKE_RESCUES = 2;

// ---- State (Part 4) ----------------------------------------------------------------------------------------------

const isoTime = z.iso.datetime();
const gateRunSchema = z.object({
  result: z.enum(["pass", "fail-scope", "fail-empty", "fail-check"]),
  ms: z.number().int().min(0),
  failures: z.number().int().min(0).optional(),
  at: isoTime,
}).strict();

const contestantSchema = z.object({
  memberId: z.string().min(1),
  profileId: z.string().min(1),
  // PROPOSED: the moment the contestant's `result` arrived. It holds the champion's result while the base run is open,
  // marks a result that waits for its capture after a restart, and starts nothing on its own.
  resultAt: isoTime.optional(),
  // PROPOSED: the capture's place in capture order (1, 2, …) in place of the design's `captured: true`. Gate runs follow
  // capture order (Part 3), and a restart rebuilds it from the record; two captures can complete in one millisecond.
  captured: z.number().int().min(1).optional(),
  commit: z.string().min(1).optional(),
  tree: z.string().min(1).optional(),
  gate: gateRunSchema.optional(),
  // Why the contestant stopped working without a result: its own leave reason. PROPOSED: the engine's own stops record
  // `wait` (rule 6) and `host` (rules 4 and 8).
  left: z.string().min(1).optional(),
}).strict();

const SEARCH_CLASSES = ["champion-pass", "rescued", "challenger-first", "none"] as const;

/** `task.search` in the sealed run record. Parse persisted state with it at the boundary. */
export const searchStateSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(["measure", "live"]),
  start: z.enum(["after-fail", "together"]),
  state: z.enum(["admitting", "armed", "wide", "resolved", "exhausted", "abandoned", "measured"]),
  criterionId: z.string().min(1),
  /** The command's digest. */
  command: z.string().min(1),
  decisionKey: z.string().min(1),
  baseCommit: z.string().min(1),
  base: gateRunSchema.optional(),
  /** The champion first, then the challengers in start order. */
  contestants: z.array(contestantSchema).min(1).max(4),
  // PROPOSED: the moment the base run failed and a `live` search armed, when `search.started` is emitted. It is the
  // only record that tells an abandoned search that armed (source `search`) from one that did not (source `production`).
  armedAt: isoTime.optional(),
  // PROPOSED: the number of `start-challengers` decisions the search made, and the profiles of the last one while it
  // waits for its receipt. A receipt counts once, and only for that launch. A pending launch outlives the search's end:
  // the end cancels it, and its one receipt, which may name no member, clears it and stops the members it names.
  launches: z.number().int().min(1).optional(),
  pending: z.array(z.string().min(1)).min(1).max(3).optional(),
  // PROPOSED: a receipt named at least one member, so the search counts once toward the brake (Part 8): at its end, or
  // at that receipt when it arrives after the end.
  widened: z.literal(true).optional(),
  // A `live` search: rule 6. PROPOSED: a `measure` search keeps the end of the run's measurement window here (Part 3).
  holdUntil: isoTime.optional(),
  waitUntil: isoTime.optional(),
  winner: z.string().min(1).optional(),
  class: z.enum(SEARCH_CLASSES).optional(),
  // PROPOSED: `base-pass`, `base-timeout`, `base-setup`, `base-yielded`, `champion-<leave>`, `deadline`, `hold`, `wait`,
  // `all-failed`, `no-challenger`, `window`, or a halt reason.
  endReason: z.string().min(1).optional(),
}).strict();

export type SearchState = z.infer<typeof searchStateSchema>;
export type Contestant = SearchState["contestants"][number];
export type GateRun = NonNullable<SearchState["base"]>;
export type SearchClass = (typeof SEARCH_CLASSES)[number];

// ---- Inputs and decisions ----------------------------------------------------------------------------------------

/** A candidate of the task's `start` decision row, without a removal, in Part 2 order (`greedyUtility`, highest first). */
export type Candidate = { profileId: string; family?: string; limited: boolean };

/** What the host reads from the run and the project at the moment of an event. */
export type RunView = {
  /** The host's effective time (Time, below). Every cutoff the step sets counts from it. */
  now: string;
  /** The run's pinned policy, read through `searchPolicy`. */
  policy: SearchPolicy;
  /** `teams.checkMinutes`: the limit of one check command, which a `measure` window must leave before the deadline. */
  checkMinutes: number;
  /** The run's deadline, with any approved extension applied. */
  deadline?: string;
  /** Condition 9: another search of the run is `wide`, or has a launch that waits for its receipt. */
  otherSearchWide: boolean;
  /** Condition 9: the champion's family (C19), undefined when unknown. */
  championFamily?: string;
  candidates: readonly Candidate[];
  /** Condition 10: free worker slots that no ready task needs, and free host session slots. */
  spareWorkerSlots: number;
  freeSessionSlots: number;
  /** Condition 11: `spareAttempts(run)`, counting every launch of the run that waits for its receipt as members. */
  spareAttempts: number;
  /** The classes of the project's widened searches that ended since the owner last resumed searches, oldest first. */
  widened: readonly SearchClass[];
};

/** How a gate run ended. A stopped gate run has no result and reaches the engine only as a base run's `yielded`. */
export type GateOutcome = "pass" | "fail" | "timeout" | "setup-failed";
/** Why a contestant stopped working without a result. `scope` and `conflict` end a `measure` champion's integration. */
export type LeaveReason = "stall" | "no-report" | "limit" | "prep-failed" | "permission" | "question" | "blocked" | "escalate"
  | "scope" | "conflict";
/** Run-level events that abandon an open search (rule 9; Part 4, `measure`). `restart`: during a search operation. */
export type HaltReason = "steer" | "pause" | "cancel" | "block" | "routing-revoked" | "revision" | "restart";

export type SearchEvent =
  /** The base run ended; `yielded`: the host stopped it for the run's own work (Part 3). */
  | { kind: "base"; outcome: GateOutcome | "yielded"; ms: number; failures?: number }
  /** A contestant reported `result` and stopped (`live`). */
  | { kind: "result"; memberId: string }
  /** A `capture` decision completed (`live`). The host decides scope and emptiness (Part 3). */
  | { kind: "captured"; memberId: string; commit: string; tree: string; scope: "ok" | "violation"; empty: boolean }
  /** A `gate` decision's run ended. */
  | { kind: "gated"; memberId: string; outcome: GateOutcome; ms: number; failures?: number }
  | { kind: "left"; memberId: string; reason: LeaveReason }
  /** The receipt of launch `launch`: the members the host prepared for it, the challengers the spend fuse admitted. */
  | { kind: "started"; launch: number; challengers: { memberId: string; profileId: string }[] }
  /** A `measure` champion's result was captured and integrated as today. */
  | { kind: "integrated"; memberId: string; commit: string; tree: string; empty: boolean }
  /** The `measure` boundary (Part 3); `searches` counts the run's `measure` searches waiting at it. */
  | { kind: "boundary"; searches: number }
  | { kind: "halt"; reason: HaltReason }
  /** Time passed. */
  | { kind: "tick" }
  /** The host restarted while the run had no workspace operation open; re-derive the pending work. */
  | { kind: "resume" };

export type Decision =
  /** Run the gate at the base commit, as a workspace operation. */
  | { kind: "base-run"; commit: string }
  /** Capture this contestant's result without integrating it. */
  | { kind: "capture"; memberId: string }
  /** Run the gate at this contestant's captured commit. At most one is outstanding per search, in capture order. */
  | { kind: "gate"; memberId: string; commit: string }
  /**
   * Prepare challengers on these profiles from the champion's base commit, each through the spend fuse, and answer with
   * one `started` receipt for `launch`. The host keeps each launch by search ID and number with the members it prepared.
   */
  | { kind: "start-challengers"; launch: number; profileIds: string[]; baseCommit: string }
  | { kind: "stop"; memberIds: string[]; reason: string }
  /** Stop the search's open gate run, and drop its queued captures and gate runs. PROPOSED: every end emits it. */
  | { kind: "stop-operations" }
  /** The winner enters today's integration path in plan order, and `task.memberId` becomes it (rule 4). */
  | { kind: "integrate"; memberId: string }
  /** The champion is handled as if no search had run, once the search's open gate run has closed (rule 8). */
  | { kind: "release"; memberId: string; state: "exhausted" | "abandoned"; reason: string }
  /**
   * PROPOSED: the search ended, or a restart found it ended, while launch `launch` waits for its receipt. The host
   * prepares no further member for it and delivers its one receipt, naming the members it already prepared (or none).
   */
  | { kind: "cancel-launch"; launch: number }
  /** A widened search counts toward the brake: the host appends `class` to the project's widened history (Part 8). */
  | { kind: "widened"; class: SearchClass }
  /** The brake is engaged: the host pauses searches for the project until the owner resumes them (Part 8). */
  | { kind: "pause" };

export type Step = { search: SearchState; decisions: Decision[] };

// ---- Time --------------------------------------------------------------------------------------------------------

/*
 * The engine reads time only from `view.now`. It sets each cutoff once, from the `now` of the event that sets it:
 * `holdUntil` at the champion's result or leave (a `measure` window at the boundary), `waitUntil` at the champion's
 * failed gate or leave. A cutoff already set never moves, and capture order is the capture ordinal, which needs no time.
 * PROPOSED: the host supplies effective time, its wall clock. A clock that runs back by R delays the expiry of a cutoff
 * set before the step back by at most R, never more, and a cutoff set after it still lasts its own duration from the
 * `now` that set it; a clock that runs forward ends cutoffs early by the jump.
 */
const MINUTE = 60_000;
const plus = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * MINUTE).toISOString();
const reached = (now: string, at: string | undefined) => at !== undefined && Date.parse(now) >= Date.parse(at);
const pastDeadline = (deadline: string | undefined, at: string) => deadline !== undefined && Date.parse(at) > Date.parse(deadline);

/**
 * A `live` search's allowance (Part 7): one gate run for each contestant, one more for a base run that has not ended,
 * and the wait. A gate run counts as Part 7 states it, 20 minutes for the clone and the setup command plus
 * `gateMinutes`, also where Part 3 gives the command a shorter `teams.checkMinutes`. PROPOSED: "each contestant" is the
 * policy's `attempts`, so admission, the champion's result and widening all reckon with the full search; the design's
 * example counts it so (4 × 35 + 60 = 200 with three attempts).
 */
function allowanceMinutes(policy: SearchPolicy, baseOpen: boolean): number {
  return (policy.attempts + (baseOpen ? 1 : 0)) * (GATE_SETUP_MINUTES + policy.gateMinutes) + policy.waitMinutes;
}

/** The run's measurement window (Part 3): 2 × (20 + `gateMinutes`) for each `measure` search that waits at the boundary. */
function measureWindowMinutes(policy: SearchPolicy, searches: number): number {
  return 2 * (GATE_SETUP_MINUTES + policy.gateMinutes) * searches;
}

// ---- Admission (Part 1, conditions 1 to 7) -----------------------------------------------------------------------

export type AdmissionCondition = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** What the host reads when the dispatcher prepares a task's first member. */
export type AdmissionFacts = {
  id: string;
  now: string;
  policy: SearchPolicy;
  routing: { mode: "off" | "shadow" | "auto"; coversStart: boolean; revoked: boolean };
  /** `wideSearch`: a search of the run is `wide` or has a launch that waits for its receipt. */
  run: { goalCycle: boolean; recordDigest: boolean; requiredChecks: readonly string[]; searches: number; wideSearch: boolean; deadline?: string };
  task: {
    role: string; risk: "normal" | "elevated"; firstAttempt: boolean; criterionId?: string;
    /** Another task of the plan names the same criterion. */
    criterionShared: boolean;
    duel: boolean; exploratoryStart: boolean; baseCommit: string; decisionKey: string;
  };
  /** The champion the dispatcher prepared. */
  champion: { memberId: string; profileId: string };
  /** The task's criterion in the run's record at its pinned version; undefined when it cannot be read. */
  criterion?: Criterion;
  /** Condition 4, which the host reads from Git: every pinned file has its recorded blob at `baseCommit`; a pinned file matches an owned path. */
  pins: { atBase: boolean; owned: boolean };
  project: {
    /** The project's stored pause (Part 8): set by a `pause` decision or the owner, cleared only by the owner's resume. */
    paused: boolean;
    /** The project's applied `start` decisions before this task's, oldest first: true where the task had a `live` search. */
    starts: readonly boolean[];
  };
};

export type Admission =
  | { admitted: true; search: SearchState; decisions: Decision[] }
  | { admitted: false; condition: AdmissionCondition };

/** Conditions 1 to 7 in order; the first that fails is the one the host counts. Condition 8 is the base run. */
export function admit(f: AdmissionFacts): Admission {
  const { policy, task, criterion: c } = f;
  const live = policy.mode === "live";
  const checks: [AdmissionCondition, boolean][] = [
    [1, policy.mode !== "off" && f.routing.mode === "auto" && f.routing.coversStart && !f.routing.revoked],
    [2, task.role === "implementer" && task.risk === "normal" && task.firstAttempt && f.run.goalCycle && f.run.recordDigest],
    [3, c !== undefined && task.criterionId === c.id && !task.criterionShared && c.state === "active" && c.origin === "owner"
      && c.check.kind === "command" && c.producer === "host" && (c.pinned?.length ?? 0) >= 1 && f.run.requiredChecks.includes(c.check.command)],
    [4, f.pins.atBase && !f.pins.owned],
    [5, !task.duel && !task.exploratoryStart],
    [6, !f.run.wideSearch && f.run.searches < SEARCHES_PER_RUN && !f.project.paused],
    [7, !live || (shareFits(f.project.starts, policy.share)
      && !pastDeadline(f.run.deadline, plus(f.now, allowanceMinutes(policy, true))))],
  ];
  const failed = checks.find(([, holds]) => !holds);
  if (failed) return { admitted: false, condition: failed[0] };
  const command = c!.check.kind === "command" ? c!.check.command : "";
  const search: SearchState = {
    id: f.id, mode: live ? "live" : "measure", start: policy.start, state: "admitting", criterionId: c!.id, command,
    decisionKey: task.decisionKey, baseCommit: task.baseCommit, contestants: [{ ...f.champion }],
  };
  // `measure` runs its base run at the boundary (Part 3); `live` runs it while the champion works.
  return { admitted: true, search, decisions: live ? [{ kind: "base-run", commit: task.baseCommit }] : [] };
}

/**
 * Condition 7's share: with this task's decision the window holds the newest 99 earlier decisions and this one, and
 * its `live` searches, this one included, stay at or below `share` of it. The router's own window works the same way.
 */
function shareFits(starts: readonly boolean[], share: number): boolean {
  const tail = starts.slice(-(SHARE_WINDOW - 1));
  return tail.filter(Boolean).length + 1 <= share * (tail.length + 1) + SHARE_EPSILON;
}

/** Part 8: at least 10 widened searches, and fewer than 2 `rescued` among the last 10. */
export function brakeEngaged(widened: readonly SearchClass[]): boolean {
  return widened.length >= BRAKE_WINDOW && widened.slice(-BRAKE_WINDOW).filter(item => item === "rescued").length < BRAKE_RESCUES;
}

/** Part 6: every attempt of a task whose `live` search armed has source `search`; any other attempt keeps `production`. */
export function outcomeSource(search: SearchState | undefined): "search" | "production" {
  return search?.mode === "live" && search.armedAt !== undefined ? "search" : "production";
}

// ---- Steps -------------------------------------------------------------------------------------------------------

type Ctx = { s: SearchState; view: RunView; out: Decision[] };
type Receipt = Extract<SearchEvent, { kind: "started" }>;

export const isOpen = (s: SearchState) => s.state === "admitting" || s.state === "armed" || s.state === "wide";
const isWorking = (c: Contestant) => c.left === undefined && c.resultAt === undefined;
/** Failed its gate, or left. */
const isDone = (c: Contestant) => c.left !== undefined || (c.gate !== undefined && c.gate.result !== "pass");
const awaitsGate = (c: Contestant) => c.captured !== undefined && c.gate === undefined;
const champion = (s: SearchState) => s.contestants[0]!;
const find = (s: SearchState, memberId: string) => s.contestants.find(c => c.memberId === memberId);
const stop = (members: readonly { memberId: string }[], reason: string): Decision => ({ kind: "stop", memberIds: members.map(c => c.memberId), reason });

/** The captured result whose gate runs next: the earliest capture without a gate result, once the base run failed. */
function nextGate(s: SearchState): Contestant | undefined {
  if (!isOpen(s) || s.base?.result !== "fail-check") return undefined;
  let head: Contestant | undefined;
  for (const c of s.contestants) {
    if (awaitsGate(c) && (head === undefined || c.captured! < head.captured!)) head = c;
  }
  return head;
}

/**
 * Applies the time rules (the hold, the wait, the measurement window) and then one event. Returns the next state and
 * what the host does. An ended search changes only when the receipt of its pending launch arrives, and decides only
 * that receipt's stops and count, or, at a restart, the cancellation of that launch. Events that do not apply to the
 * current state (a stale gate result, a second report, an unknown member or launch) change nothing.
 */
export function step(search: SearchState, event: SearchEvent, view: RunView): Step {
  const s = structuredClone(search);
  const ctx: Ctx = { s, view, out: [] };
  const wasOpen = isOpen(s);
  const head = nextGate(s)?.memberId;
  // PROPOSED: the time rules apply before the step's event, a halt included: a hold that has passed ends the search as
  // `exhausted` before a steer in the same step could abandon it.
  if (wasOpen) advance(ctx);
  if (event.kind === "started") receive(ctx, event);
  else if (isOpen(s)) HANDLERS[event.kind](ctx, event as never);
  // A search that ends with a launch out cancels it, and a restart that finds it so cancels it again, until the
  // launch's receipt clears it (Host contract, above). A receipt that arrives in the ending step needs no cancel.
  if (!isOpen(s) && s.pending !== undefined && (wasOpen || event.kind === "resume")) ctx.out.push({ kind: "cancel-launch", launch: s.launches! });
  // PROPOSED: one gate decision is outstanding per search; the next is decided when its result arrives, so the engine,
  // not the host's queue, keeps capture order.
  const next = event.kind === "resume" ? undefined : nextGate(s);
  if (next !== undefined && next.memberId !== head) ctx.out.push({ kind: "gate", memberId: next.memberId, commit: next.commit! });
  return { search: s, decisions: ctx.out };
}

/** The hold, the wait and the measurement window at `now`; when one step passes both, the earlier applies first. */
function advance(ctx: Ctx): void {
  const { s, view } = ctx;
  if (s.mode === "measure") {
    if (reached(view.now, s.holdUntil)) end(ctx, "abandoned", "window");
    return;
  }
  if (reached(view.now, s.waitUntil) && !(s.holdUntil !== undefined && Date.parse(s.holdUntil) < Date.parse(s.waitUntil!))) {
    const working = s.contestants.slice(1).filter(isWorking);
    for (const c of working) c.left = "wait";
    if (working.length > 0) ctx.out.push(stop(working, "wait"));
    settle(ctx);
  }
  // Acceptance 11: at `holdUntil` the search is `exhausted`, also when the base run has not ended.
  if (isOpen(s) && reached(view.now, s.holdUntil)) end(ctx, "exhausted", "hold");
}

/**
 * Rule 7: every contestant failed its gate or left, or `waitUntil` has passed and no captured result waits for its gate
 * (a result that still waits for its capture does not count). The reason is `wait` when the wait decided it.
 */
function settle(ctx: Ctx): void {
  const { s, view } = ctx;
  if (!isOpen(s) || s.state === "admitting") return;
  const allDone = s.state === "wide" && s.contestants.every(isDone);
  const waitOver = reached(view.now, s.waitUntil) && !s.contestants.some(awaitsGate);
  if (allDone || waitOver) end(ctx, "exhausted", !allDone || s.contestants.some(c => c.left === "wait") ? "wait" : "all-failed");
}

/** Conditions 9 to 12 and rule 3. `arming`: `start: "together"` at the failed base run, where nothing ends (rule 1). */
function widen(ctx: Ctx, arming: boolean): void {
  const { s, view } = ctx;
  // PROPOSED: one launch at a time. A champion that fails or leaves while the launch of arming waits for its receipt
  // starts no second one; the receipt decides, and an empty one ends the search under rule 3.
  if (s.pending !== undefined) return;
  const rest = s.holdUntil ?? plus(view.now, allowanceMinutes(view.policy, false));
  if (pastDeadline(view.deadline, rest)) {
    // CONTRADICTION: condition 12 failing at widening makes "none can start", which rule 3 ends as `exhausted`; Part 7
    // and rule 9 say a `live` allowance that no longer fits is `abandoned`. This follows Part 7 and rule 9.
    // PROPOSED: "the rest of the allowance" ends at `holdUntil` once it is set, else one allowance from now.
    if (!arming) end(ctx, "abandoned", "deadline");
    return;
  }
  const profileIds = pickChallengers(s, view);
  if (profileIds.length > 0) {
    s.launches = (s.launches ?? 0) + 1;
    s.pending = profileIds;
    ctx.out.push({ kind: "start-challengers", launch: s.launches, profileIds, baseCommit: s.baseCommit });
  } else if (!arming) end(ctx, "exhausted", "no-challenger");
}

/** Part 2 order under conditions 9 to 11: one challenger per free slot pair, up to `attempts − 1`, inside the reserve. */
function pickChallengers(s: SearchState, view: RunView): string[] {
  if (view.otherSearchWide || view.championFamily === undefined) return [];
  const room = Math.min(view.policy.attempts - s.contestants.length, view.spareWorkerSlots, view.freeSessionSlots, view.spareAttempts - RESERVE);
  const families = new Set([view.championFamily]);
  const picked: string[] = [];
  for (const candidate of view.candidates) {
    if (picked.length >= room) break;
    if (candidate.family === undefined || candidate.limited || families.has(candidate.family)) continue;
    families.add(candidate.family);
    picked.push(candidate.profileId);
  }
  return picked;
}

/**
 * The receipt of the pending launch, after the time rules (rules 4, 6 and 8). A receipt of another launch, or a second
 * one, changes nothing, so a repeated receipt never stops a member twice or a winner at all. Members of the launch's
 * profiles join an open search; every other member it names is stopped at once: all of them once the search has ended,
 * and, PROPOSED, one on a profile the launch did not name. Members that join after `waitUntil` are stopped by the wait.
 * The first receipt that names a member makes the search widened; one that arrives after the end counts it at once.
 */
function receive(ctx: Ctx, e: Receipt): void {
  const { s, view, out } = ctx;
  if (s.pending === undefined || e.launch !== s.launches) return;
  const profiles = [...s.pending];
  delete s.pending;
  const fresh = e.challengers.filter((c, index) => find(s, c.memberId) === undefined && e.challengers.findIndex(o => o.memberId === c.memberId) === index);
  const joining = !isOpen(s) ? [] : fresh.filter(c => {
    const index = profiles.indexOf(c.profileId);
    if (index >= 0) profiles.splice(index, 1);
    return index >= 0;
  });
  const away = fresh.filter(c => !joining.includes(c));
  if (away.length > 0) out.push(stop(away, "host"));
  const first = fresh.length > 0 && s.widened === undefined;
  if (first) s.widened = true;
  if (!isOpen(s)) {
    if (first) count(ctx);
    return;
  }
  const cutoff = reached(view.now, s.waitUntil);
  for (const { memberId, profileId } of joining) s.contestants.push({ memberId, profileId, ...(cutoff ? { left: "wait" } : {}) });
  if (cutoff && joining.length > 0) out.push(stop(joining, "wait"));
  if (joining.length > 0) s.state = "wide";
  else if (isDone(champion(s))) return end(ctx, "exhausted", "no-challenger");
  settle(ctx);
}

/** A gate result that is not a pass. A failed champion starts the wait and widens (rules 3 and 6). */
function failed(ctx: Ctx, c: Contestant): void {
  const { s, view } = ctx;
  if (c !== champion(s)) return settle(ctx);
  s.waitUntil ??= plus(view.now, view.policy.waitMinutes);
  if (s.state === "armed") widen(ctx, false);
  else settle(ctx);
}

function record(c: Contestant, result: GateRun["result"], at: string, ms = 0, failures?: number): void {
  c.gate = { result, ms, ...(failures === undefined ? {} : { failures }), at };
}

/** Which classes Part 8 gives an armed `live` search when it ends. */
function classify(s: SearchState): SearchClass {
  const first = champion(s);
  if (s.winner === undefined) return "none";
  if (s.winner === first.memberId) return "champion-pass";
  // PROPOSED: a champion whose result arrived and was not yet gated counts as still working: `challenger-first`.
  return isDone(first) ? "rescued" : "challenger-first";
}

/** Ends the search: stops what still works for it, then integrates the winner or releases the task (rules 4 and 8). */
function end(ctx: Ctx, state: "resolved" | "exhausted" | "abandoned" | "measured", reason?: string): void {
  const { s, out } = ctx;
  if (s.mode === "live" && s.armedAt !== undefined) s.class = classify(s);
  s.state = state;
  if (reason !== undefined) s.endReason = reason;
  out.push({ kind: "stop-operations" });
  if (s.mode === "measure") return;
  // Rule 4 stops every other running contestant, the champion included; rule 8 stops the challengers, and a champion
  // that still works goes on as a single attempt.
  const running = s.contestants.filter((c, index) => isWorking(c) && (state === "resolved" ? c.memberId !== s.winner : index > 0));
  for (const c of running) c.left = "host";
  if (running.length > 0) out.push(stop(running, "host"));
  if (state === "resolved") out.push({ kind: "integrate", memberId: s.winner! });
  else out.push({ kind: "release", memberId: champion(s).memberId, state: state === "exhausted" ? "exhausted" : "abandoned", reason: reason ?? state });
  if (s.widened) count(ctx);
}

/**
 * PROPOSED: the brake counts every search that widened, whatever its end, by its class (an abandoned one is `none`),
 * exactly once, and every count that leaves it engaged emits `pause`. The pause is the host's stored state, which only
 * the owner's resume clears (Part 8); a later rescue that disengages the brake does not.
 */
function count(ctx: Ctx): void {
  const { s, view, out } = ctx;
  const counted = s.class ?? "none";
  out.push({ kind: "widened", class: counted });
  if (brakeEngaged([...view.widened, counted])) out.push({ kind: "pause" });
}

/** Rule 2's leaves of the champion; its other leaves abandon the search (rule 9). */
const CHAMPION_LEAVES: ReadonlySet<LeaveReason> = new Set(["stall", "no-report"]);
const BASE_REASONS = { pass: "base-pass", timeout: "base-timeout", "setup-failed": "base-setup" } as const;

type Handled = Exclude<SearchEvent["kind"], "started">;
type Handlers = { [K in Handled]: (ctx: Ctx, event: Extract<SearchEvent, { kind: K }>) => void };

const HANDLERS: Handlers = {
  base(ctx, e) {
    const { s, view, out } = ctx;
    if (s.base !== undefined || (s.mode === "live" ? s.state !== "admitting" : s.holdUntil === undefined)) return;
    // PROPOSED: a timeout or a failed setup is stored as `fail-check`, and `endReason` tells it from a failing exit; a
    // yielded base run stores nothing, as a stopped gate run has no result (Part 3).
    if (e.outcome === "yielded") return end(ctx, "abandoned", "base-yielded");
    s.base = { result: e.outcome === "pass" ? "pass" : "fail-check", ms: e.ms, ...(e.failures === undefined ? {} : { failures: e.failures }), at: view.now };
    if (e.outcome !== "fail") return end(ctx, "abandoned", BASE_REASONS[e.outcome]);
    if (s.mode === "measure") {
      if (champion(s).gate !== undefined) end(ctx, "measured");
      return;
    }
    s.state = "armed";
    s.armedAt = view.now;
    if (champion(s).resultAt !== undefined) out.push({ kind: "capture", memberId: champion(s).memberId });
    if (s.start === "together") widen(ctx, true);
  },

  result(ctx, e) {
    const { s, view, out } = ctx;
    const c = find(s, e.memberId);
    if (s.mode === "measure" || c === undefined || !isWorking(c)) return;
    c.resultAt = view.now;
    if (c === champion(s)) {
      s.holdUntil ??= plus(view.now, allowanceMinutes(view.policy, s.state === "admitting"));
      if (pastDeadline(view.deadline, s.holdUntil)) return end(ctx, "abandoned", "deadline");
      if (s.state === "admitting") return;
    }
    out.push({ kind: "capture", memberId: c.memberId });
  },

  captured(ctx, e) {
    const { s, view } = ctx;
    const c = find(s, e.memberId);
    if (s.state === "admitting" || c === undefined || c.resultAt === undefined || c.captured !== undefined || c.left !== undefined) return;
    // PROPOSED: a capture that completes at or after `waitUntil` is not gated; rule 6 gates the results captured before it.
    if (reached(view.now, s.waitUntil)) return;
    Object.assign(c, { captured: 1 + Math.max(0, ...s.contestants.map(other => other.captured ?? 0)), commit: e.commit, tree: e.tree });
    if (e.scope === "violation" || e.empty) {
      record(c, e.scope === "violation" ? "fail-scope" : "fail-empty", view.now);
      failed(ctx, c);
    }
  },

  gated(ctx, e) {
    const { s, view } = ctx;
    const head = nextGate(s);
    if (head === undefined || head.memberId !== e.memberId) return;
    record(head, e.outcome === "pass" ? "pass" : "fail-check", view.now, e.ms, e.failures);
    if (s.mode === "measure") return end(ctx, "measured");
    if (e.outcome !== "pass") return failed(ctx, head);
    s.winner = head.memberId;
    end(ctx, "resolved");
  },

  left(ctx, e) {
    const { s, view, out } = ctx;
    const c = find(s, e.memberId);
    if (c === undefined || !isWorking(c)) return;
    const isChampion = c === champion(s);
    // PROPOSED: a champion's permission prompt takes today's path (rule 10 names challengers only).
    if (isChampion && e.reason === "permission") return;
    c.left = e.reason;
    if (!isChampion) {
      out.push(stop([c], e.reason));
      return settle(ctx);
    }
    if (s.mode === "measure" || s.state === "admitting" || !CHAMPION_LEAVES.has(e.reason)) return end(ctx, "abandoned", `champion-${e.reason}`);
    out.push(stop([c], e.reason));
    s.holdUntil ??= plus(view.now, allowanceMinutes(view.policy, false));
    s.waitUntil ??= plus(view.now, view.policy.waitMinutes);
    // PROPOSED: a champion that leaves gets the deadline check of a champion's result (Part 7 names the result only).
    if (pastDeadline(view.deadline, s.holdUntil)) return end(ctx, "abandoned", "deadline");
    if (s.state === "armed") widen(ctx, false);
    else settle(ctx);
  },

  integrated(ctx, e) {
    const { s, view } = ctx;
    const c = champion(s);
    if (s.mode !== "measure" || c.memberId !== e.memberId || !isWorking(c)) return;
    Object.assign(c, { resultAt: view.now, captured: 1, commit: e.commit, tree: e.tree });
    // PROPOSED: an unchanged tree is recorded as `fail-empty` at integration; the base run at the boundary still decides
    // between `measured` and `abandoned`.
    if (e.empty) record(c, "fail-empty", view.now);
  },

  boundary(ctx, e) {
    const { s, view, out } = ctx;
    if (s.mode !== "measure" || s.holdUntil !== undefined || champion(s).captured === undefined) return;
    const window = measureWindowMinutes(view.policy, e.searches);
    if (pastDeadline(view.deadline, plus(view.now, window + view.checkMinutes))) return end(ctx, "abandoned", "deadline");
    s.holdUntil = plus(view.now, window);
    out.push({ kind: "base-run", commit: s.baseCommit });
  },

  halt(ctx, e) {
    end(ctx, "abandoned", e.reason);
  },

  tick() {},

  resume(ctx) {
    const { s, view, out } = ctx;
    if (s.base === undefined && (s.mode === "live" || s.holdUntil !== undefined)) out.push({ kind: "base-run", commit: s.baseCommit });
    if (s.state === "armed" || s.state === "wide") {
      // Captures that have not completed have no order yet; after the wait none would be gated (rule 6).
      const waiting = reached(view.now, s.waitUntil) ? []
        : s.contestants.filter(c => c.resultAt !== undefined && c.captured === undefined && c.left === undefined);
      for (const c of waiting) out.push({ kind: "capture", memberId: c.memberId });
      // PROPOSED (acceptance 16): the launch that waits for its receipt is decided again under its number. The host
      // prepares only the profiles of that launch that have no member yet and answers with one receipt of all of them,
      // so no profile gets a second member.
      if (s.pending !== undefined) out.push({ kind: "start-challengers", launch: s.launches!, profileIds: [...s.pending], baseCommit: s.baseCommit });
    }
    const head = nextGate(s);
    if (head !== undefined) out.push({ kind: "gate", memberId: head.memberId, commit: head.commit! });
  },
};
