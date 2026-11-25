import { z } from "zod";
import type { Criterion } from "./objective-types.js";
import { SHARE_EPSILON } from "./routing-guards.js";

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

const SEARCH_DEFAULTS: SearchPolicy = { mode: "off", start: "after-fail", share: 0.1, attempts: 3, gateMinutes: 15, waitMinutes: 60 };

export function searchPolicy(saved: TeamSearch = {}): SearchPolicy {
  const d = SEARCH_DEFAULTS;
  return { mode: saved.mode ?? d.mode, start: saved.start ?? d.start, share: saved.share ?? d.share, attempts: saved.attempts ?? d.attempts,
    gateMinutes: saved.gateMinutes ?? d.gateMinutes, waitMinutes: saved.waitMinutes ?? d.waitMinutes };
}

const GATE_SETUP_MINUTES = 20;
const SEARCHES_PER_RUN = 2;
const SHARE_WINDOW = 100;
const RESERVE = 3;
const BRAKE_WINDOW = 10;
const BRAKE_RESCUES = 2;

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
  resultAt: isoTime.optional(),
  captured: z.number().int().min(1).optional(),
  commit: z.string().min(1).optional(),
  tree: z.string().min(1).optional(),
  gate: gateRunSchema.optional(),
  left: z.string().min(1).optional(),
}).strict();

const SEARCH_CLASSES = ["champion-pass", "rescued", "challenger-first", "none"] as const;

export const searchStateSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(["measure", "live"]),
  start: z.enum(["after-fail", "together"]),
  state: z.enum(["admitting", "armed", "wide", "resolved", "exhausted", "abandoned", "measured"]),
  criterionId: z.string().min(1),
  command: z.string().min(1),
  decisionKey: z.string().min(1),
  baseCommit: z.string().min(1),
  base: gateRunSchema.optional(),
  contestants: z.array(contestantSchema).min(1).max(4),
  armedAt: isoTime.optional(),
  launches: z.number().int().min(1).optional(),
  pending: z.array(z.string().min(1)).min(1).max(3).optional(),
  widened: z.literal(true).optional(),
  holdUntil: isoTime.optional(),
  waitUntil: isoTime.optional(),
  winner: z.string().min(1).optional(),
  class: z.enum(SEARCH_CLASSES).optional(),
  endReason: z.string().min(1).optional(),
}).strict();

export type SearchState = z.infer<typeof searchStateSchema>;
export type Contestant = SearchState["contestants"][number];
export type GateRun = NonNullable<SearchState["base"]>;
export type SearchClass = (typeof SEARCH_CLASSES)[number];

export type Candidate = { profileId: string; family?: string; limited: boolean };

export type RunView = {
  now: string;
  policy: SearchPolicy;
  checkMinutes: number;
  deadline?: string;
  otherSearchWide: boolean;
  championFamily?: string;
  candidates: readonly Candidate[];
  spareWorkerSlots: number;
  freeSessionSlots: number;
  spareAttempts: number;
  widened: readonly SearchClass[];
};

export type GateOutcome = "pass" | "fail" | "timeout" | "setup-failed";
export type LeaveReason = "stall" | "no-report" | "limit" | "prep-failed" | "permission" | "question" | "blocked" | "escalate"
  | "scope" | "conflict";
export type HaltReason = "steer" | "pause" | "cancel" | "block" | "routing-revoked" | "revision" | "restart";

export type SearchEvent =
  | { kind: "base"; outcome: GateOutcome | "yielded"; ms: number; failures?: number }
  | { kind: "result"; memberId: string }
  | { kind: "captured"; memberId: string; commit: string; tree: string; scope: "ok" | "violation"; empty: boolean }
  | { kind: "gated"; memberId: string; outcome: GateOutcome; ms: number; failures?: number }
  | { kind: "left"; memberId: string; reason: LeaveReason }
  | { kind: "started"; launch: number; challengers: { memberId: string; profileId: string }[] }
  | { kind: "integrated"; memberId: string; commit: string; tree: string; empty: boolean }
  | { kind: "boundary"; searches: number }
  | { kind: "halt"; reason: HaltReason }
  | { kind: "tick" }
  | { kind: "resume" };

export type Decision =
  | { kind: "base-run"; commit: string }
  | { kind: "capture"; memberId: string }
  | { kind: "gate"; memberId: string; commit: string }
  | { kind: "start-challengers"; launch: number; profileIds: string[]; baseCommit: string }
  | { kind: "stop"; memberIds: string[]; reason: string }
  | { kind: "stop-operations" }
  | { kind: "integrate"; memberId: string }
  | { kind: "release"; memberId: string; state: "exhausted" | "abandoned"; reason: string }
  | { kind: "cancel-launch"; launch: number }
  | { kind: "widened"; class: SearchClass }
  | { kind: "pause" };

export type Step = { search: SearchState; decisions: Decision[] };

const MINUTE = 60_000;
const plus = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * MINUTE).toISOString();
const reached = (now: string, at: string | undefined) => at !== undefined && Date.parse(now) >= Date.parse(at);
const pastDeadline = (deadline: string | undefined, at: string) => deadline !== undefined && Date.parse(at) > Date.parse(deadline);

function allowanceMinutes(policy: SearchPolicy, baseOpen: boolean): number {
  return (policy.attempts + (baseOpen ? 1 : 0)) * (GATE_SETUP_MINUTES + policy.gateMinutes) + policy.waitMinutes;
}

function measureWindowMinutes(policy: SearchPolicy, searches: number): number {
  return 2 * (GATE_SETUP_MINUTES + policy.gateMinutes) * searches;
}

export type AdmissionCondition = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type AdmissionFacts = {
  id: string;
  now: string;
  policy: SearchPolicy;
  routing: { mode: "off" | "shadow" | "auto"; coversStart: boolean; revoked: boolean };
  run: { goalCycle: boolean; recordDigest: boolean; requiredChecks: readonly string[]; searches: number; wideSearch: boolean; deadline?: string };
  task: {
    role: string; risk: "normal" | "elevated"; firstAttempt: boolean; criterionId?: string;
    criterionShared: boolean;
    duel: boolean; exploratoryStart: boolean; baseCommit: string; decisionKey: string;
  };
  champion: { memberId: string; profileId: string };
  criterion?: Criterion;
  pins: { atBase: boolean; owned: boolean };
  project: {
    paused: boolean;
    starts: readonly boolean[];
  };
};

export type Admission =
  | { admitted: true; search: SearchState; decisions: Decision[] }
  | { admitted: false; condition: AdmissionCondition };

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
  return { admitted: true, search, decisions: live ? [{ kind: "base-run", commit: task.baseCommit }] : [] };
}

function shareFits(starts: readonly boolean[], share: number): boolean {
  const tail = starts.slice(-(SHARE_WINDOW - 1));
  return tail.filter(Boolean).length + 1 <= share * (tail.length + 1) + SHARE_EPSILON;
}

export function brakeEngaged(widened: readonly SearchClass[]): boolean {
  return widened.length >= BRAKE_WINDOW && widened.slice(-BRAKE_WINDOW).filter(item => item === "rescued").length < BRAKE_RESCUES;
}

export function outcomeSource(search: SearchState | undefined): "search" | "production" {
  return search?.mode === "live" && search.armedAt !== undefined ? "search" : "production";
}

type Ctx = { s: SearchState; view: RunView; out: Decision[] };
type Receipt = Extract<SearchEvent, { kind: "started" }>;

export const isOpen = (s: SearchState) => s.state === "admitting" || s.state === "armed" || s.state === "wide";
const isWorking = (c: Contestant) => c.left === undefined && c.resultAt === undefined;
const isDone = (c: Contestant) => c.left !== undefined || (c.gate !== undefined && c.gate.result !== "pass");
const awaitsGate = (c: Contestant) => c.captured !== undefined && c.gate === undefined;
const champion = (s: SearchState) => s.contestants[0]!;
const find = (s: SearchState, memberId: string) => s.contestants.find(c => c.memberId === memberId);
const stop = (members: readonly { memberId: string }[], reason: string): Decision => ({ kind: "stop", memberIds: members.map(c => c.memberId), reason });

function nextGate(s: SearchState): Contestant | undefined {
  if (!isOpen(s) || s.base?.result !== "fail-check") return undefined;
  let head: Contestant | undefined;
  for (const c of s.contestants) {
    if (awaitsGate(c) && (head === undefined || c.captured! < head.captured!)) head = c;
  }
  return head;
}

export function step(search: SearchState, event: SearchEvent, view: RunView): Step {
  const s = structuredClone(search);
  const ctx: Ctx = { s, view, out: [] };
  const wasOpen = isOpen(s);
  const head = nextGate(s)?.memberId;
  if (wasOpen) advance(ctx);
  if (event.kind === "started") receive(ctx, event);
  else if (isOpen(s)) HANDLERS[event.kind](ctx, event as never);
  if (!isOpen(s) && s.pending !== undefined && (wasOpen || event.kind === "resume")) ctx.out.push({ kind: "cancel-launch", launch: s.launches! });
  const next = event.kind === "resume" ? undefined : nextGate(s);
  if (next !== undefined && next.memberId !== head) ctx.out.push({ kind: "gate", memberId: next.memberId, commit: next.commit! });
  return { search: s, decisions: ctx.out };
}

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
  if (isOpen(s) && reached(view.now, s.holdUntil)) end(ctx, "exhausted", "hold");
}

function settle(ctx: Ctx): void {
  const { s, view } = ctx;
  if (!isOpen(s) || s.state === "admitting") return;
  const allDone = s.state === "wide" && s.contestants.every(isDone);
  const waitOver = reached(view.now, s.waitUntil) && !s.contestants.some(awaitsGate);
  if (allDone || waitOver) end(ctx, "exhausted", !allDone || s.contestants.some(c => c.left === "wait") ? "wait" : "all-failed");
}

function widen(ctx: Ctx, arming: boolean): void {
  const { s, view } = ctx;
  if (s.pending !== undefined) return;
  const rest = s.holdUntil ?? plus(view.now, allowanceMinutes(view.policy, false));
  if (pastDeadline(view.deadline, rest)) {
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

function classify(s: SearchState): SearchClass {
  const first = champion(s);
  if (s.winner === undefined) return "none";
  if (s.winner === first.memberId) return "champion-pass";
  return isDone(first) ? "rescued" : "challenger-first";
}

function end(ctx: Ctx, state: "resolved" | "exhausted" | "abandoned" | "measured", reason?: string): void {
  const { s, out } = ctx;
  if (s.mode === "live" && s.armedAt !== undefined) s.class = classify(s);
  s.state = state;
  if (reason !== undefined) s.endReason = reason;
  out.push({ kind: "stop-operations" });
  if (s.mode === "measure") return;
  const running = s.contestants.filter((c, index) => isWorking(c) && (state === "resolved" ? c.memberId !== s.winner : index > 0));
  for (const c of running) c.left = "host";
  if (running.length > 0) out.push(stop(running, "host"));
  if (state === "resolved") out.push({ kind: "integrate", memberId: s.winner! });
  else out.push({ kind: "release", memberId: champion(s).memberId, state: state === "exhausted" ? "exhausted" : "abandoned", reason: reason ?? state });
  if (s.widened) count(ctx);
}

function count(ctx: Ctx): void {
  const { s, view, out } = ctx;
  const counted = s.class ?? "none";
  out.push({ kind: "widened", class: counted });
  if (brakeEngaged([...view.widened, counted])) out.push({ kind: "pause" });
}

const CHAMPION_LEAVES: ReadonlySet<LeaveReason> = new Set(["stall", "no-report"]);
const BASE_REASONS = { pass: "base-pass", timeout: "base-timeout", "setup-failed": "base-setup" } as const;

type Handled = Exclude<SearchEvent["kind"], "started">;
type Handlers = { [K in Handled]: (ctx: Ctx, event: Extract<SearchEvent, { kind: K }>) => void };

const HANDLERS: Handlers = {
  base(ctx, e) {
    const { s, view, out } = ctx;
    if (s.base !== undefined || (s.mode === "live" ? s.state !== "admitting" : s.holdUntil === undefined)) return;
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
    if (pastDeadline(view.deadline, s.holdUntil)) return end(ctx, "abandoned", "deadline");
    if (s.state === "armed") widen(ctx, false);
    else settle(ctx);
  },

  integrated(ctx, e) {
    const { s, view } = ctx;
    const c = champion(s);
    if (s.mode !== "measure" || c.memberId !== e.memberId || !isWorking(c)) return;
    Object.assign(c, { resultAt: view.now, captured: 1, commit: e.commit, tree: e.tree });
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
      const waiting = reached(view.now, s.waitUntil) ? []
        : s.contestants.filter(c => c.resultAt !== undefined && c.captured === undefined && c.left === undefined);
      for (const c of waiting) out.push({ kind: "capture", memberId: c.memberId });
      if (s.pending !== undefined) out.push({ kind: "start-challengers", launch: s.launches!, profileIds: [...s.pending], baseCommit: s.baseCommit });
    }
    const head = nextGate(s);
    if (head !== undefined) out.push({ kind: "gate", memberId: head.memberId, commit: head.commit! });
  },
};
