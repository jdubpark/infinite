import test from "node:test";
import assert from "node:assert/strict";
import type { TeamRun } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import type { Counts } from "./outcome-sim-script.js";
import { simulate, type Variant, Violation } from "./fixtures/team-run-sim.js";
import { registerGoalPlanSimulator } from "./fixtures/goal-plan-sim.js";
import "./fixtures/delivery-review-sim.js";

const DEFAULT_SEEDS = 50;
const ONLY = process.env.TEAM_SIM_SEED;
const COUNT = Number(process.env.TEAM_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.TEAM_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "TEAM_SIM_SEED, TEAM_SIM_SEEDS and TEAM_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;
const CONCURRENCY = 8;

const sortedCounts = (counts: Counts) => Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1));

async function sweep(seeds: readonly number[], counts: Counts, variant: Variant = {}): Promise<Violation | undefined> {
  for (let at = 0; at < seeds.length; at += CONCURRENCY) {
    const results = await Promise.allSettled(seeds.slice(at, at + CONCURRENCY).map(seed => simulate(seed, counts, variant)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      if (!(failure.reason instanceof Violation)) throw failure.reason;
      return failure.reason;
    }
  }
  return undefined;
}

const FLOORS: Readonly<Record<string, number>> = {
  "cut:pause:1": 7, "cut:resume:1": 6, "cut:resume:2": 1, "cut:cancel:1": 1,
  "cut:steer:1": 10, "cut:steer:2": 8, "cut:revoke:1": 7, "cut:revoke:2": 3, "cut:answer:1": 2, "cut:answer:2": 1,
  "cut:continue:1": 1, "cut:pass": 4,
  "ack:pause": 31, "ack:resume": 28, "ack:cancel": 8, "ack:steer": 34, "ack:revoke": 16, "ack:answer": 3, "ack:continue": 2,
  "retry:pause": 8, "retry:resume": 9, "retry:cancel": 4, "retry:steer": 10, "retry:revoke": 5, "retry:answer": 1, "retry:continue": 1,
  "refused:request-conflict": 20, "refused:stale-team-revision": 18, "refused:team-cancelled": 29, "refused:members-stopping": 8,
  "pass:ended-halt": 49, "restart": 26, "intermediate:revoke:1": 4,
};

test("team run requests keep their invariants across host stops", async t => {
  const counts: Counts = {};
  const started = performance.now();
  const violation = await sweep(SEEDS, counts);
  if (violation) throw violation;
  t.diagnostic(`team sim: ${SEEDS.length} seeds from ${SEEDS[0]} in ${((performance.now() - started) / 1000).toFixed(1)} s, ${JSON.stringify(Object.fromEntries(sortedCounts(counts)))}`);
  if (!DEFAULT_CORPUS) return t.diagnostic("coverage floors are off: they describe the default corpus, and a TEAM_SIM_* setting changed it");
  for (const [name, floor] of Object.entries(FLOORS)) {
    assert.ok((counts[name] ?? 0) >= floor, `${name} ran ${counts[name] ?? 0} times, under its floor of ${floor}: the generator stopped producing it`);
  }
});

type Stored = { run: TeamRun; receipts: Record<string, string>; checkHead?: string; halt?: string };
type Body = { requestId: string; revision: number };
type Private = {
  admit(stored: Stored, operation: string, body: Body): string | undefined;
  replay(stored: Stored, operation: string, body: Body): boolean;
  save(stored: Stored): void;
  resumeRun(stored: Stored, inPlace?: boolean, record?: () => void): Promise<void>;
  invalidatePermissionDecisions(stored: Stored, reason: string, fenceAgent?: boolean): Promise<boolean>;
  stopRun(stored: Stored, action: "pause" | "cancel", ownerHalt?: unknown, source?: unknown, line?: string, reason?: string): Promise<void>;
  event(stored: Stored, text: string): void;
};
const internals = (service: TeamService) => service as unknown as Private;

type Mutation = { name: string; invariant: string; kind: "source" | "harness"; variant: Variant };

const patchAdmit = (wrap: (host: Private, admit: Private["admit"]) => Private["admit"]): Variant => ({ patch: service => {
  const host = internals(service);
  host.admit = wrap(host, host.admit.bind(host));
} });
const patchReplay = (wrap: (host: Private, replay: Private["replay"]) => Private["replay"]): Variant => ({ patch: service => {
  const host = internals(service);
  host.replay = wrap(host, host.replay.bind(host));
} });

const patchLateStopEffects: Variant = { patch: service => {
  const host = internals(service), stopRun = host.stopRun.bind(host);
  const invalidate = host.invalidatePermissionDecisions.bind(host), emit = host.event.bind(host);
  let stopping: { action: "pause" | "cancel"; reason: string | undefined; events: string[] } | undefined;
  host.event = (stored, text) => {
    if (stopping && text.startsWith(stopping.action === "pause" ? "Team paused" : "Team cancelled")) stopping.events.push(text);
    else emit(stored, text);
  };
  host.invalidatePermissionDecisions = async (stored, reason, fenceAgent) => {
    if (!stopping || reason !== `The team was ${stopping.action} before the permission request could be answered.`)
      return invalidate(stored, reason, fenceAgent);
    const reasonAtFence = stored.run.reason;
    stored.run.reason = stopping.reason;
    try { return await invalidate(stored, reason, fenceAgent); }
    finally { stored.run.reason = reasonAtFence; }
  };
  host.stopRun = async (stored, action, ownerHalt, source, line, reason) => {
    const pending = { action, reason: stored.run.reason, events: [] as string[] };
    stopping = pending;
    try { await stopRun(stored, action, ownerHalt, source, line, reason); }
    finally {
      stopping = undefined;
      for (const text of pending.events) emit(stored, text);
      host.save(stored);
    }
  };
} };

const MUTATIONS: readonly Mutation[] = [
  { name: "the receipt is recorded at admission, before the permission fence's save (INF-331)", invariant: "I3", kind: "source",
    variant: patchAdmit((_host, admit) => (stored, operation, body) => {
      const receipt = admit(stored, operation, body);
      if (receipt) stored.receipts[body.requestId] = receipt;
      return receipt;
    }) },
  { name: "a replay writes the record again", invariant: "I2", kind: "source",
    variant: patchReplay((host, replay) => (stored, operation, body) => {
      const hit = replay(stored, operation, body);
      if (hit) host.save(stored);
      return hit;
    }) },
  { name: "a resume records its receipt and advances its revision before the permission fence (INF-334)", invariant: "I3", kind: "source",
    variant: { patch: service => {
      internals(service).resumeRun = async function (this: Private, stored, inPlace = false, record) {
        record?.();
        const run = stored.run;
        if (inPlace) { run.status = "needs-input"; run.reason = undefined; return; }
        run.revision++; run.tasks = []; run.review = undefined; run.round = 0; stored.checkHead = undefined;
        run.brief = undefined; run.noChange = undefined;
        await this.invalidatePermissionDecisions(stored, "The team resumed under a new revision.");
        run.status = "planning"; run.reason = undefined; run.blockCode = undefined;
      };
    } } },
  { name: "a resume clears the steering before the permission fence's save", invariant: "I1", kind: "source",
    variant: { patch: service => {
      const host = internals(service), resumeRun = host.resumeRun.bind(host);
      host.resumeRun = (stored, inPlace, record) => { stored.run.steering = []; return resumeRun(stored, inPlace, record); };
    } } },
  { name: "a steer sets its halt before the permission fence's save", invariant: "I3", kind: "source",
    variant: patchAdmit((_host, admit) => (stored, operation, body) => {
      const receipt = admit(stored, operation, body);
      if (receipt && operation === "steer") stored.halt = "steer";
      return receipt;
    }) },
  { name: "pause and cancel record their reason and event after the permission fence's save (INF-359)", invariant: "I3", kind: "source", variant: patchLateStopEffects },
  { name: "a stop tears the record write", invariant: "I3", kind: "harness", variant: { stop: "torn" } },
  { name: "a stop loses the last record write", invariant: "I4", kind: "harness", variant: { stop: "lost" } },
  { name: "a save moves member cursors back to the journal's start", invariant: "I4", kind: "source",
    variant: { patch: service => {
      const host = internals(service), save = host.save.bind(host);
      host.save = stored => { for (const member of stored.run.members) member.cursor = 0; save(stored); };
    } } },
  { name: "admission forgets that a cancelled run is settled", invariant: "I5", kind: "source",
    variant: patchAdmit((_host, admit) => (stored, operation, body) =>
      admit(stored.run.status === "cancelled" ? { ...stored, run: { ...stored.run, status: "paused" } } : stored, operation, body)) },
  { name: "admission saves the record before its checks", invariant: "I6", kind: "source",
    variant: patchAdmit((host, admit) => (stored, operation, body) => {
      host.save(stored);
      return admit(stored, operation, body);
    }) },
  { name: "a refused admission saves the record", invariant: "I6", kind: "source",
    variant: patchAdmit((host, admit) => (stored, operation, body) => {
      try { return admit(stored, operation, body); } catch (error) { host.save(stored); throw error; }
    }) },
  { name: "a reused request id replays whatever its action", invariant: "I7", kind: "source",
    variant: patchReplay(() => (stored, _operation, body) => Boolean(stored.receipts[body.requestId])) },
  { name: "admission ignores the revision a request names", invariant: "I7", kind: "source",
    variant: patchAdmit((_host, admit) => (stored, operation, body) => admit(stored, operation, { ...body, revision: stored.run.revision })) },
];

for (const mutation of MUTATIONS) {
  test(`the simulator catches a ${mutation.kind} mutant: ${mutation.name} (${mutation.invariant})`, { skip: ONLY !== undefined && "TEAM_SIM_SEED reruns one corpus seed" }, async t => {
    const violation = await sweep(SEEDS, {}, mutation.variant);
    assert.ok(violation, `none of ${SEEDS.length} seeds caught it`);
    assert.match(violation.message, new RegExp(`: ${mutation.invariant}: `), `caught by another invariant first: ${violation.message}`);
    t.diagnostic(`caught at ${violation.message.split("; rerun")[0]}`);
  });
}

for (const [seed, kind] of [[5, "pause"], [29, "cancel"]] as const) {
  test(`seed ${seed} ${kind} survives a stop after write 1`, async () => {
    const violation = await sweep([seed], {});
    assert.equal(violation, undefined, violation?.message);
  });
}

registerGoalPlanSimulator(test);
