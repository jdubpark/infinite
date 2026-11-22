import test from "node:test";
import assert from "node:assert/strict";
import type { MainCheckNotice, MainCheckService } from "../packages/host/src/main-check.js";
import type { MainCheckPorts } from "../packages/host/src/main-check-ports.js";
import { checksDigest, outcomeOf, type CheckSummary, type MainCheckRecord, type Retiring } from "../packages/host/src/main-check-state.js";
import type { CensusResult } from "../packages/host/src/process-census.js";
import type { Config } from "../packages/host/src/types.js";
import type { Counts } from "./outcome-sim-script.js";
import { simulate, type Variant, Violation } from "./fixtures/main-check-sim.js";

/*
 * Runs the main-check simulator (tests/fixtures/main-check-sim.ts, which states the invariants I1-I9) over the default
 * corpus, and checks that each mutant below is caught through the invariant it names while the same corpus passes
 * without it.
 */

// MAIN_CHECK_SIM_SEED=N runs that seed alone and skips the mutants; MAIN_CHECK_SIM_SEEDS=N runs N seeds from
// MAIN_CHECK_SIM_BASE (default 1). Floors describe the default corpus only.
const DEFAULT_SEEDS = 200;
const ONLY = process.env.MAIN_CHECK_SIM_SEED;
const COUNT = Number(process.env.MAIN_CHECK_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.MAIN_CHECK_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "MAIN_CHECK_SIM_SEED, MAIN_CHECK_SIM_SEEDS and MAIN_CHECK_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const sortedCounts = (counts: Counts) => Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1));

/** Runs `seeds` one after another (each is CPU-bound on a virtual clock) and returns the first violation. */
async function sweep(seeds: readonly number[], counts: Counts, variant: Variant = {}): Promise<Violation | undefined> {
  for (const seed of seeds) {
    try { await simulate(seed, counts, variant); }
    catch (error) {
      if (error instanceof Violation) return error;
      throw error;
    }
  }
  return undefined;
}

/**
 * Floors for the default corpus at about half of what it produced, so a generator that stops producing a case fails.
 * They follow the cases the specification lists: a host stop after each kind of record write; heads that move,
 * revert, repeat, arrive late or twice; two projects; a halt during a check; checks changing at a measured head; a
 * census that fails, finds processes or is clean; a removal that fails; acceptances at once, late, out of order,
 * stale or never; a failure told, then the checks changed, and nothing offered until the next result (I10). The
 * thinnest ran 3 to 8 times: a stop after a `told` write, the R8 ending of a record that read again, an out-of-order
 * acceptance, and a stop on a write of close().
 */
const FLOORS: Readonly<Record<string, number>> = {
  "stop:after-create": 8, "stop:after-admission": 18, "stop:after-witness": 50, "stop:after-finish": 22, "stop:after-retire": 20,
  "stop:after-observe": 70, "stop:after-told": 2, "stop:after-waiting": 37, "stop:after-settle": 3,
  "restart:clean": 140, "restart:stopped-in-close": 4, "reboot": 120, "drain:reboot": 28, "record:unreadable": 41, "restore:some": 40,
  "r8:start:recording": 59, "r8:start:recorded": 58, "r8:reread:recording": 2, "r8:reread:recorded": 1,
  "admission:alpha": 415, "admission:beta": 309, "start:sudo": 32, "setting:off": 69,
  "fetch:next:observed": 730, "fetch:revert:observed": 319, "fetch:repeat:observed": 265, "fetch:duplicate:observed": 186,
  "fetch:late:observed": 24, "fetch:late:ignored": 178, "fetch:foreign:ignored": 70,
  "halt:during-check": 44, "halt:check-interrupted": 19, "waiting:halt": 132,
  "checks:changed-at-measured-head": 28, "command:from-earlier-checks": 3,
  "census:run:clean": 1097, "census:run:finds": 700, "census:run:fail": 45, "census:root:fail": 121,
  "removal:fail": 17, "waiting:cleanup": 5, "waiting:processes": 296, "retire:removed:earlier": 219,
  "waiting:another-check": 248, "waiting:attempts": 99, "waiting:execution-identity": 13, "waiting:census-unavailable": 29,
  "waiting:host-load": 22, "waiting:storage": 17,
  "outcome:passed": 174, "outcome:failed": 88, "outcome:error:copy-changed": 77, "outcome:error:workspace": 90,
  "outcome:error:command-unavailable": 32, "outcome:error:stop-unconfirmed": 41, "outcome:interrupted:time-limit": 39,
  "outcome:interrupted:host-stop": 40, "outcome:interrupted:halt": 19,
  "health:failed": 86, "health:passed": 42, "health:fixed-before-told": 7, "told:changed": 88,
  "notice:offered:failed": 90, "notice:offered:passed": 22, "notice:withheld:told-failed-health-absent": 66,
  "notice:accepted:at-once": 77, "notice:accepted:late": 17, "notice:accepted:out-of-order": 2, "notice:accepted:stale": 6,
  "notice:refused": 5, "notice:never": 13,
};

test("the main check keeps its invariants across host stops, halts, faults and late acceptances", async t => {
  const counts: Counts = {};
  const started = performance.now();
  const violation = await sweep(SEEDS, counts);
  if (violation) throw violation;
  t.diagnostic(`main-check sim: ${SEEDS.length} seeds from ${SEEDS[0]} in ${((performance.now() - started) / 1000).toFixed(1)} s, ${JSON.stringify(Object.fromEntries(sortedCounts(counts)))}`);
  if (!DEFAULT_CORPUS) return t.diagnostic("coverage floors are off: they describe the default corpus, and a MAIN_CHECK_SIM_* setting changed it");
  for (const [name, floor] of Object.entries(FLOORS)) {
    assert.ok((counts[name] ?? 0) >= floor, `${name} ran ${counts[name] ?? 0} times, under its floor of ${floor}: the generator stopped producing it`);
  }
});

// ---- Mutations ---------------------------------------------------------------------------------------------------

type Slot = { record?: MainCheckRecord; unreadable?: true };
/** The private service members the mutants replace or read on one instance. No file is edited. */
type Private = {
  config: Config;
  ports: MainCheckPorts;
  slots: Map<string, Slot>;
  retirement: Map<string, string>;
  listed: boolean;
  active?: unknown;
  unwritten: Set<unknown>;
  hostBusy(projectId: string): string | undefined;
  pollHalt(active: unknown): void;
  pick(record: MainCheckRecord, digest: string): { head: string } | { waiting: "attempts" } | undefined;
  commit(projectId: string, next: MainCheckRecord): boolean;
  settled(projectId: string, record: MainCheckRecord): MainCheckRecord;
  removable(projectId: string, entry: Retiring, result: CensusResult): boolean;
  halted(projectId: string): boolean;
  offer(projectId: string, slot: Slot, now: number): MainCheckNotice | undefined;
  notices(): MainCheckNotice[];
};
const internals = (service: MainCheckService) => service as unknown as Private;
const patch = (change: (host: Private) => void): Variant => ({ patch: service => change(internals(service)) });

type Mutation = { name: string; invariant: string; variant: Variant };

const MUTATIONS: readonly Mutation[] = [
  { name: "the host-wide gate looks only at the project's own run directories", invariant: "I1",
    variant: patch(host => {
      host.hostBusy = projectId => host.slots.get(projectId)?.record?.retiring?.length ? host.retirement.get(projectId) ?? "processes" : undefined;
    }) },
  { name: "the host-wide gate skips an unreadable record", invariant: "I1",
    variant: patch(host => {
      host.hostBusy = projectId => {
        if (host.slots.get(projectId)?.record?.retiring?.length) return host.retirement.get(projectId) ?? "processes";
        if (!host.listed || host.active || host.unwritten.size > 0) return "another-check";
        for (const slot of host.slots.values()) if (slot.record?.running || slot.record?.retiring?.length) return "another-check";
        return undefined;
      };
    }) },
  { name: "the candidate rule forgets the head's results", invariant: "I2",
    variant: patch(host => {
      const pick = host.pick.bind(host);
      host.pick = (record, digest) => pick({ ...record, results: undefined }, digest);
    }) },
  { name: "an admission does not charge the head", invariant: "I3",
    variant: patch(host => {
      const commit = host.commit.bind(host);
      host.commit = (projectId, next) => {
        const prev = host.slots.get(projectId)?.record;
        if (prev?.running || !next.running) return commit(projectId, next);
        const { attempts: _attempts, ...rest } = next;
        return commit(projectId, prev?.attempts ? { ...rest, attempts: prev.attempts } : rest);
      };
    }) },
  { name: "removal trusts any clean census, also for an earlier process's recording entry of the same boot", invariant: "I4",
    variant: patch(host => {
      host.removable = (_projectId, _entry, result) => result.ok && result.findings.length === 0;
    }) },
  { name: "removal ignores what the census found", invariant: "I4",
    variant: patch(host => {
      const removable = host.removable.bind(host);
      host.removable = (projectId, entry, result) => result.ok && removable(projectId, entry, { ok: true, findings: [] });
    }) },
  { name: "an offered notice counts as told", invariant: "I5",
    variant: patch(host => {
      const notices = host.notices.bind(host);
      host.notices = () => {
        const offered = notices();
        for (const notice of offered) {
          const record = host.slots.get(notice.projectId)?.record;
          if (record) host.commit(notice.projectId, { ...record, told: { notice: notice.notice, outcome: notice.outcome } });
        }
        return offered;
      };
    }) },
  { name: "a notice is due whenever health's generation moved past what the owner was told", invariant: "I6",
    variant: patch(host => {
      const offer = host.offer.bind(host);
      host.offer = (projectId, slot, now) => {
        const record = slot.record;
        if (!record || (record.notice ?? 0) <= (record.told?.notice ?? 0)) return offer(projectId, slot, now);
        const told = { notice: record.told?.notice ?? 0, outcome: outcomeOf(record.health) === "passed" ? "failed" as const : "passed" as const };
        return offer(projectId, { record: { ...record, told } }, now);
      };
    }) },
  { name: "health takes the last result in record order instead of the most recently observed head", invariant: "I7",
    variant: patch(host => {
      host.settled = (projectId, record) => {
        const team = host.config.projects.find(project => project.id === projectId)?.team;
        if (!team) return record;
        const digest = checksDigest(team);
        const best = record.results?.filter(result => result.checks === digest).at(-1);
        const { health: _health, ...rest } = record;
        const next: MainCheckRecord = best ? { ...rest, health: best } : rest;
        return outcomeOf(best) === outcomeOf(record.health) ? next : { ...next, notice: (record.notice ?? 0) + 1 };
      };
    }) },
  { name: "an absent health counts as passed at the offer (the notice rule before the amendment)", invariant: "I10",
    variant: patch(host => {
      const offer = host.offer.bind(host);
      host.offer = (projectId, slot, now) => {
        const record = slot.record;
        if (!record || record.health || record.told?.outcome !== "failed") return offer(projectId, slot, now);
        const at = new Date(now).toISOString();
        const passed: CheckSummary = { head: record.observed?.head ?? "0".repeat(40), checks: "0".repeat(64), observedAt: at, outcome: "passed", finishedAt: at, expected: 0 };
        return offer(projectId, { record: { ...record, health: passed } }, now);
      };
    }) },
  { name: "the halt is never read", invariant: "I8",
    variant: patch(host => {
      host.halted = () => false;
    }) },
  { name: "a running check does not poll the halt; only the read before each command sees it", invariant: "I8",
    variant: patch(host => {
      host.pollHalt = () => undefined;
    }) },
  { name: "the copy is not checked after each command (one instance's assertClean port)", invariant: "I9",
    variant: patch(host => {
      host.ports.assertClean = async () => undefined;
    }) },
];

for (const mutation of MUTATIONS) {
  test(`the simulator catches a mutant: ${mutation.name} (${mutation.invariant})`, { skip: ONLY !== undefined && "MAIN_CHECK_SIM_SEED reruns one corpus seed" }, async t => {
    const violation = await sweep(SEEDS, {}, mutation.variant);
    assert.ok(violation, `none of ${SEEDS.length} seeds caught it`);
    assert.match(violation.message, new RegExp(`: ${mutation.invariant}: `), `caught by another invariant first: ${violation.message}`);
    t.diagnostic(`caught at ${violation.message.split("; rerun")[0]}`);
  });
}
