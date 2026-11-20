import test from "node:test";
import assert from "node:assert/strict";
import { admit, isOpen, type RunView, type SearchEvent, type SearchState, step } from "../packages/host/src/search-engine.js";
import type { Counts } from "./outcome-sim-script.js";
import { type Engine, simulate, Violation } from "./search-engine-sim-script.js";

/*
 * Runs the search engine's seeded simulator (tests/search-engine-sim-script.ts, which states the invariants) over the
 * default corpus, and checks that each mutant engine below is caught through the invariant it names.
 */

// SEARCH_SIM_SEED=N runs that seed alone; SEARCH_SIM_SEEDS=N runs N seeds from SEARCH_SIM_BASE (default 1). Floors
// describe the default corpus only.
const DEFAULT_SEEDS = 600;
const ONLY = process.env.SEARCH_SIM_SEED;
const COUNT = Number(process.env.SEARCH_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.SEARCH_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "SEARCH_SIM_SEED, SEARCH_SIM_SEEDS and SEARCH_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const sortedCounts = (counts: Counts) => Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1));

/**
 * Floors for the default corpus at about half of what it produced, so a generator that stops producing a case fails.
 * `challenger-first` ran 4 times: it needs `together`, a widening at arming, and a challenger gated before the champion.
 * `pause:again` ran once: it needs a count that engages the brake while the project is already paused.
 */
const FLOORS: Readonly<Record<string, number>> = {
  "admission:admitted": 1360, "admission:refused-6": 349, "admission:refused-7": 334, "owner:pause": 47, "owner:resume": 51, "decision:pause": 15,
  "pause:again": 1, "class:champion-pass": 98, "class:rescued": 10, "class:challenger-first": 2, "class:none": 443, "end:resolved": 110,
  "end:exhausted": 315, "end:measured": 101, "end:widened": 138, "widen:arming": 91, "widen:champion-done": 117, "reason:all-failed": 35,
  "reason:wait": 89, "reason:hold": 55, "reason:no-challenger": 135, "reason:deadline": 28, "reason:window": 45, "reason:base-pass": 70,
  "reason:base-yielded": 61, "reason:champion-stall": 87, "reason:champion-question": 57, "event:boundary": 217, "event:resume": 140,
  "fault:restart-during-operation": 63, "fault:unstoppable-gate": 13, "fault:late-gate-result": 4, "fault:launch-lost": 31, "fuse:refused": 32,
  "receipt:first": 151, "receipt:repeat": 36, "receipt:after-end": 57, "receipt:crossing-timer": 22, "fault:unknown-started": 45,
  "fault:unknown-result": 48, "clock:back": 319, "clock:forward": 241, "cutoff:holdUntil": 761, "cutoff:waitUntil": 289, "cancel:at-end": 57,
  "cancel:at-restart": 5, "cancel:lost-in-restart": 3, "cancel:prepared": 16, "cancel:unprepared": 43, "count:late": 11,
};

test("the search engine keeps its invariants under seeded event orders", t => {
  const counts: Counts = {};
  const started = performance.now();
  for (const seed of SEEDS) simulate(seed, { admit, step }, counts);
  t.diagnostic(`search sim: ${SEEDS.length} seeds from ${SEEDS[0]}, ${((performance.now() - started) / SEEDS.length).toFixed(1)} ms per seed, ${JSON.stringify(Object.fromEntries(sortedCounts(counts)))}`);
  if (!DEFAULT_CORPUS) return;
  for (const [name, floor] of Object.entries(FLOORS)) {
    assert.ok((counts[name] ?? 0) >= floor, `${name} ran ${counts[name] ?? 0} times, under its floor of ${floor}: the generator stopped producing it`);
  }
});

// ---- Mutations ---------------------------------------------------------------------------------------------------

/** An engine whose step output, or whose inputs, one plausible bug changed. Applied in-process; no file is edited. */
type Mutation = { name: string; invariant: string; engine: Engine };

const wrapStep = (wrap: (s: SearchState, e: SearchEvent, v: RunView) => ReturnType<typeof step>): Engine => ({ admit, step: wrap });
const withoutKey = (s: SearchState, key: "holdUntil" | "waitUntil" | "pending") => {
  const copy = { ...s };
  delete copy[key];
  return copy;
};
const recorded = (s: SearchState, ids: readonly string[]) => ids.every(id => s.contestants.some(c => c.memberId === id));

const MUTATIONS: readonly Mutation[] = [
  { name: "a recorded gate result loses its time", invariant: "S0", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    for (const c of out.search.contestants) if (c.gate) delete (c.gate as Partial<typeof c.gate>).at;
    return out;
  }) },
  { name: "a challenger's win also integrates the champion", invariant: "S1", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    const win = out.decisions.find(d => d.kind === "integrate");
    if (win?.kind === "integrate" && win.memberId !== s.contestants[0]!.memberId) out.decisions.push({ kind: "integrate", memberId: s.contestants[0]!.memberId });
    return out;
  }) },
  { name: "the reserve is off by one", invariant: "S2", engine: wrapStep((s, e, v) => step(s, e, { ...v, spareAttempts: v.spareAttempts + 1 })) },
  { name: "families are ignored", invariant: "S2", engine: wrapStep((s, e, v) => step(s, e, {
    ...v, candidates: v.candidates.map(c => ({ ...c, family: `${c.family ?? "unknown"}-${c.profileId}` })) })) },
  { name: "attempts is off by one where challengers are counted", invariant: "S2", engine: wrapStep((s, e, v) => {
    const out = step(s, e, { ...v, policy: { ...v.policy, attempts: v.policy.attempts + 1 } });
    const real = step(s, e, v);
    if (real.search.holdUntil !== undefined) out.search.holdUntil = real.search.holdUntil;
    return out;
  }) },
  { name: "after-fail starts challengers at arming", invariant: "S2", engine: wrapStep((s, e, v) => step(s.start === "after-fail" ? { ...s, start: "together" } : s, e, v)) },
  { name: "a champion's failure launches again while a launch waits for its receipt", invariant: "S2", engine: wrapStep((s, e, v) => {
    if (s.pending === undefined || e.kind === "started" || e.kind === "resume") return step(s, e, v);
    const out = step(withoutKey(s, "pending"), e, v);
    out.search.pending ??= s.pending;
    // Only the widening is wrong: an end in this step still cancels the launch that is out.
    if (!isOpen(out.search) && !out.decisions.some(d => d.kind === "cancel-launch")) out.decisions.push({ kind: "cancel-launch", launch: out.search.launches! });
    return out;
  }) },
  { name: "an ended search records a late gate result", invariant: "S3", engine: wrapStep((s, e, v) => {
    if (isOpen(s) || e.kind !== "gated") return step(s, e, v);
    const search = structuredClone(s);
    const late = search.contestants.find(c => c.memberId === e.memberId && c.gate === undefined);
    if (late) late.gate = { result: e.outcome === "pass" ? "pass" : "fail-check", ms: e.ms, at: v.now };
    return { search, decisions: [] };
  }) },
  { name: "the newest capture is gated first", invariant: "S4", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (e.kind === "resume") return out;
    const newest = out.search.contestants.filter(c => c.captured !== undefined && c.gate === undefined).sort((a, b) => b.captured! - a.captured!)[0];
    out.decisions = out.decisions.map(d => (d.kind === "gate" && newest ? { ...d, memberId: newest.memberId, commit: newest.commit! } : d));
    return out;
  }) },
  { name: "a pass also queues the next capture's gate run", invariant: "S5", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    const waiting = out.search.contestants.find(c => c.captured !== undefined && c.gate === undefined);
    if (out.search.state === "resolved" && s.state !== "resolved" && waiting) out.decisions.push({ kind: "gate", memberId: waiting.memberId, commit: waiting.commit! });
    return out;
  }) },
  { name: "the end of a search stops no challenger", invariant: "S6", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    out.decisions = out.decisions.filter(d => !(d.kind === "stop" && d.reason === "host" && recorded(out.search, d.memberIds)));
    return out;
  }) },
  { name: "an exhausted search does not release the task", invariant: "S6", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    out.decisions = out.decisions.filter(d => !(d.kind === "release" && d.state === "exhausted"));
    return out;
  }) },
  { name: "the hold is ignored", invariant: "S7", engine: wrapStep((s, e, v) => {
    const out = step(withoutKey(s, "holdUntil"), e, v);
    if (out.search.holdUntil === undefined && s.holdUntil !== undefined) out.search.holdUntil = s.holdUntil;
    return out;
  }) },
  { name: "the champion's result skips the deadline check", invariant: "S7", engine: wrapStep((s, e, v) => {
    if (e.kind !== "result") return step(s, e, v);
    const { deadline: _deadline, ...rest } = v;
    return step(s, e, rest);
  }) },
  { name: "the wait is ignored", invariant: "S7", engine: wrapStep((s, e, v) => {
    const out = step(withoutKey(s, "waitUntil"), e, v);
    if (out.search.waitUntil === undefined && s.waitUntil !== undefined) out.search.waitUntil = s.waitUntil;
    return out;
  }) },
  { name: "a result that waits for its capture holds the search open past the wait", invariant: "S7", engine: wrapStep((s, e, v) => {
    if (s.waitUntil === undefined || !s.contestants.some(c => c.resultAt !== undefined && c.captured === undefined && c.left === undefined)) return step(s, e, v);
    const out = step(withoutKey(s, "waitUntil"), e, v);
    out.search.waitUntil ??= s.waitUntil;
    return out;
  }) },
  { name: "the measurement window counts the shorter check limit", invariant: "S7", engine: wrapStep((s, e, v) =>
    step(s, e, e.kind === "boundary" ? { ...v, policy: { ...v.policy, gateMinutes: Math.min(v.policy.gateMinutes, v.checkMinutes) } } : v)) },
  { name: "cutoffs count from the latest time the record holds", invariant: "S7", engine: wrapStep((s, e, v) => {
    const held = [s.armedAt, s.base?.at, ...s.contestants.flatMap(c => [c.resultAt, c.gate?.at])].filter((x): x is string => x !== undefined);
    const latest = Math.max(...held.map(x => Date.parse(x)));
    return step(s, e, latest > Date.parse(v.now) ? { ...v, now: new Date(latest).toISOString() } : v);
  }) },
  { name: "the allowance counts the shorter check limit", invariant: "S7", engine: wrapStep((s, e, v) =>
    step(s, e, e.kind === "boundary" ? v : { ...v, policy: { ...v.policy, gateMinutes: Math.min(v.policy.gateMinutes, v.checkMinutes) } })) },
  { name: "a hold that ends before the arming abandons the search", invariant: "S7", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (isOpen(s) && out.search.endReason === "hold" && out.search.armedAt === undefined) {
      out.search.state = "abandoned";
      out.decisions = out.decisions.map(d => (d.kind === "release" ? { ...d, state: "abandoned" } : d));
    }
    return out;
  }) },
  { name: "challenger-first is labelled rescued", invariant: "S8", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (out.search.class === "challenger-first") out.search.class = "rescued";
    return out;
  }) },
  { name: "a base run that timed out arms the search", invariant: "S9", engine: wrapStep((s, e, v) =>
    step(s, e.kind === "base" && e.outcome === "timeout" && s.mode === "live" ? { ...e, outcome: "fail" } : e, v)) },
  { name: "admission ignores the project's pause", invariant: "S10", engine: { step, admit: f => admit({ ...f, project: { ...f.project, paused: false } }) } },
  { name: "the pause is dropped", invariant: "S10", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    out.decisions = out.decisions.filter(d => d.kind !== "pause");
    return out;
  }) },
  { name: "measure treats a passing base run as failed", invariant: "S11", engine: wrapStep((s, e, v) =>
    step(s, e.kind === "base" && e.outcome === "pass" && s.mode === "measure" ? { ...e, outcome: "fail" } : e, v)) },
  { name: "a restart forgets the outstanding gate run", invariant: "S12", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (e.kind === "resume") out.decisions = out.decisions.filter(d => d.kind !== "gate");
    return out;
  }) },
  { name: "a restart forgets the launch that waits for its receipt", invariant: "S12", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (e.kind === "resume") out.decisions = out.decisions.filter(d => d.kind !== "start-challengers");
    return out;
  }) },
  { name: "a late receipt's members are not stopped", invariant: "S13", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (e.kind === "started") out.decisions = out.decisions.filter(d => !(d.kind === "stop" && !recorded(out.search, d.memberIds)));
    return out;
  }) },
  { name: "a receipt the search already had stops the members it names", invariant: "S13", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (e.kind === "started" && s.pending === undefined && e.challengers.length > 0) out.decisions.push({ kind: "stop", memberIds: e.challengers.map(c => c.memberId), reason: "host" });
    return out;
  }) },
  { name: "a receipt counts for the pending launch whatever its number", invariant: "S13", engine: wrapStep((s, e, v) =>
    step(s, e.kind === "started" && s.launches !== undefined ? { ...e, launch: s.launches } : e, v)) },
  { name: "the end of a search does not cancel its launch", invariant: "S13", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (isOpen(s)) out.decisions = out.decisions.filter(d => d.kind !== "cancel-launch");
    return out;
  }) },
  { name: "a restart that finds the search ended does not cancel its launch", invariant: "S13", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (!isOpen(s)) out.decisions = out.decisions.filter(d => d.kind !== "cancel-launch");
    return out;
  }) },
  { name: "a receipt after the end is not counted toward the brake", invariant: "S10", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    if (!isOpen(s) && e.kind === "started") out.decisions = out.decisions.filter(d => d.kind !== "widened" && d.kind !== "pause");
    return out;
  }) },
  { name: "the wait also stops challengers whose result arrived", invariant: "S14", engine: wrapStep((s, e, v) => {
    const out = step(s, e, v);
    const reported = out.search.contestants.slice(1).filter(c => c.resultAt !== undefined && c.gate === undefined).map(c => c.memberId);
    out.decisions = out.decisions.map(d => (d.kind === "stop" && d.reason === "wait" ? { ...d, memberIds: [...d.memberIds, ...reported] } : d));
    return out;
  }) },
];

for (const mutation of MUTATIONS) {
  test(`the simulator catches a mutant engine: ${mutation.name} (${mutation.invariant})`, t => {
    for (const seed of SEEDS) {
      try {
        simulate(seed, mutation.engine, {});
      } catch (error) {
        if (!(error instanceof Violation)) throw error;
        assert.match(error.message, new RegExp(`: ${mutation.invariant}: `), `caught by another invariant first: ${error.message}`);
        t.diagnostic(`caught at ${error.message.split(": ")[0]}`);
        return;
      }
    }
    assert.fail(`none of ${SEEDS.length} seeds caught it`);
  });
}
