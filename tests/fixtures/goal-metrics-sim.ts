import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CheckMetricScanner } from "../../packages/host/src/check-metrics.js";
import { recordObservations, reviewedObservationsOf, type ObservationHolder } from "../../packages/host/src/check-observations.js";
import { goalMetricsRead, pruneMetrics, settleMetrics, type CycleMetrics, type GoalMetrics, type GoalMetricsView, type MetricSeries } from "../../packages/host/src/goal-metrics.js";
import type { TeamCheck, TeamCommand, TeamRun } from "../../packages/host/src/team-types.js";
import { bump, type Counts, type Rand, rand } from "../outcome-sim-script.js";

/*
 * A seeded simulator of reported check numbers (INF-399). Each seed runs one goal through a sequence of cycles. Each
 * cycle's run verifies one or more times at moving heads and rounds, with setup rows, duplicate commands, failed and
 * interrupted checks, and stdout split at random bytes beside stderr marker lines. Its review approves, asks for
 * changes, approves an earlier revision or is missing; it ends; sometimes it reopens at a later revision that prints
 * fewer numbers and ends again. The goal settles each ending and saves. The host stops inside a check, between the
 * run's write and the goal's write, or after a goal write; a restart reloads both holders from their last writes. A
 * fold removes older cycles, sometimes in the same write as a settlement. Some seeds are long, to pass 50 entries.
 *
 * The code under test is the real one: CheckMetricScanner, recordObservations, reviewedObservationsOf, settleMetrics,
 * pruneMetrics and goalMetricsRead, called at the points where teams.ts and goals.ts call them. The services are not:
 * tests/goal-metrics-service.test.ts and tests/goal-metrics-host.test.ts cover their wiring. A reference model, written
 * apart from that code, says what each step should leave.
 *
 * Invariants, checked at every goal write and restart (I5 at the end of each cycle and at each restart):
 * I1 An entry exists only for a cycle the goal holds.
 * I2 An entry equals the reference entry of its run's reviewed observations at the latest durable settlement.
 * I3 At most 50 entries, and the same runs as the reference: the newest settled runs the goal holds.
 * I4 `dropped` equals the reference count of entries retention removed.
 * I5 The read equals the reference read, a second read equals the first, and a restart does not change it.
 */

export class Violation extends Error {}
export const RERUN = (seed: number) => `GOAL_METRICS_SIM_SEED=${seed} node --import tsx --test tests/goal-metrics-sim.test.ts`;
/** Replaces one function of the code under test for one run of the simulator; no source file is edited. */
export type Variant = { record?: typeof recordObservations; reviewed?: typeof reviewedObservationsOf; settle?: typeof settleMetrics; prune?: typeof pruneMetrics; read?: typeof goalMetricsRead };

const T0 = Date.parse("2026-11-23T08:00:00.000Z");
const ENTRIES = 50, VALUES = 16, SERIES = 8, LABEL = 200, SLOTS = 8;
const COMMANDS: readonly TeamCommand[] = [
  { command: "npm", args: ["test"] }, { command: "npm", args: ["run", "lint"] }, { command: "npm", args: ["run", "bench"] },
  { command: "make", args: ["size"] }, { command: "node", args: ["scripts/measure.mjs", "--budget", "x".repeat(240)] },
];
// Byte order and locale order differ for the punctuation here.
const NAMES = ["speed", "size.kb", "p95-ms", "heap_mb", "a0", "a.b", "a-b", "a_b", "errors", "cold.start", "z9", "m"] as const;
const ENDED = ["ready-for-review", "merged", "no-change", "blocked", "cancelled"] as const;

type Kind = "value" | "ambiguous" | "invalid";
type Expected = { name: string; state: Kind; value?: number };
type Plan = { names: string[]; lines: string[]; expected: Expected[] };
type SimRun = { id: string; holder: ObservationHolder; disk: string; expected: Expected[][]; lastNames: Map<string, string[]>; fewer: boolean };
type GoalHolder = { goal: { cycles: { teamId: string; cycle: number }[] }; metrics?: GoalMetrics };
/** `settled` is each run's entry at its latest settlement, whatever retention did since; `entries` is what retention keeps. */
type RefState = { settled: Record<string, CycleMetrics>; entries: Record<string, CycleMetrics>; dropped: number };

// ---- Reference model ------------------------------------------------------------------------------------------------
// Written apart from goal-metrics.ts and check-observations.ts. Every string compared here is ASCII, so `<` is byte order.

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const refDigest = (command: TeamCommand) => sha(JSON.stringify({ args: command.args, command: command.command }));
const identities = new Map<string, string>();
const refIdentity = (command: string, name: string) => {
  const key = `${command} ${name}`;
  let found = identities.get(key);
  if (!found) identities.set(key, found = sha(JSON.stringify({ command, name })));
  return found;
};
const lt = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The numbers the goal may read: the reviewed-head rule, then the first occurrence of each command in the final round at the head. */
function refReviewed(run: SimRun): { command: string; name: string; value?: number; state: Kind; at: string }[] | undefined {
  const { run: team, checkHead } = run.holder;
  if (team.headCommit === undefined || checkHead !== team.headCommit || team.review?.revision !== team.revision || team.review.verdict !== "approved") return undefined;
  const rows = team.checks.map((row, index) => ({ row, index })).filter(({ row }) => row.revision === team.revision);
  if (!rows.length) return [];
  const round = Math.max(...rows.map(({ row }) => row.round ?? 0));
  const seen = new Set<string>(), out: { command: string; name: string; value?: number; state: Kind; at: string }[] = [];
  for (const { row, index } of rows) {
    if (row.phase !== undefined || (row.round ?? 0) !== round || row.headCommit !== team.headCommit) continue;
    const command = refDigest(row.command);
    if (seen.has(command)) continue;
    seen.add(command);
    if (row.status !== "passed") continue;
    for (const metric of run.expected[index]!) out.push({ command, name: metric.name, state: metric.state, at: row.finishedAt!, ...(metric.value === undefined ? {} : { value: metric.value }) });
  }
  return out;
}

function refEntry(run: SimRun): CycleMetrics | undefined {
  const values = (refReviewed(run) ?? []).filter(item => item.state === "value").sort((a, b) => lt(a.command, b.command) || lt(a.name, b.name));
  if (!values.length) return undefined;
  return { run: run.id, revision: run.holder.run.revision, head: run.holder.run.headCommit!, more: Math.max(0, values.length - VALUES),
    values: values.slice(0, VALUES).map(item => ({ command: item.command, name: item.name, value: item.value!, at: item.at })) };
}

function refPrune(state: RefState, cycles: GoalHolder["goal"]["cycles"], counts: Counts) {
  const position = new Map(cycles.map((cycle, index) => [cycle.teamId, index]));
  for (const run of Object.keys(state.entries)) {
    if (position.has(run)) continue;
    delete state.entries[run]; state.dropped++; bump(counts, "prune:orphan");
  }
  const held = Object.keys(state.entries).sort((a, b) => position.get(a)! - position.get(b)!);
  for (const run of held.slice(0, Math.max(0, held.length - ENTRIES))) { delete state.entries[run]; state.dropped++; bump(counts, "prune:cap"); }
}

function refRead(state: RefState, cycles: GoalHolder["goal"]["cycles"], configured: readonly TeamCommand[]): GoalMetricsView {
  const position = new Map(cycles.map((cycle, index) => [cycle.teamId, index]));
  const labels = new Map<string, string>();
  for (const command of configured) {
    const digest = refDigest(command), characters = Array.from([command.command, ...command.args].join(" "));
    if (!labels.has(digest)) labels.set(digest, characters.length > LABEL ? `${characters.slice(0, LABEL - 1).join("")}…` : characters.join(""));
  }
  const runs = Object.keys(state.entries).filter(run => position.has(run)).sort((a, b) => position.get(a)! - position.get(b)!);
  const series = new Map<string, { id: string; newest: string; series: MetricSeries }>();
  for (const run of runs) {
    const entry = state.entries[run]!, cycle = cycles[position.get(run)!]!.cycle;
    for (const value of entry.values) {
      const id = refIdentity(value.command, value.name);
      let found = series.get(id);
      if (!found) {
        const label = labels.get(value.command);
        found = { id, newest: value.at, series: { command: value.command, ...(label === undefined ? {} : { label }), name: value.name, configured: label !== undefined, points: [] } };
        series.set(id, found);
      }
      if (value.at > found.newest) found.newest = value.at;
      found.series.points.push({ cycle, run, revision: entry.revision, head: entry.head, value: value.value, at: value.at });
    }
  }
  const ranked = [...series.values()].sort((a, b) => lt(b.newest, a.newest) || lt(a.id, b.id));
  return { series: ranked.slice(0, SERIES).map(item => item.series), omittedSeries: Math.max(0, ranked.length - SERIES),
    omittedValues: runs.reduce((sum, run) => sum + state.entries[run]!.more, 0), dropped: state.dropped };
}

// ---- Simulator ------------------------------------------------------------------------------------------------------

type Profile = { cycles: number; keep: number; approve: number; pass: number };

class Sim {
  private readonly r: Rand;
  private clock = T0;
  private heads = 0;
  private configured: TeamCommand[];
  private readonly runs = new Map<string, SimRun>();
  private goal: GoalHolder = { goal: { cycles: [] } };
  private goalDisk = JSON.stringify(this.goal);
  private ref: RefState = { settled: {}, entries: {}, dropped: 0 };
  private refDisk: RefState = structuredClone(this.ref);
  private pendingFold = false;
  private readonly record: typeof recordObservations;
  private readonly reviewed: typeof reviewedObservationsOf;
  private readonly settle: typeof settleMetrics;
  private readonly prune: typeof pruneMetrics;
  private readonly read: typeof goalMetricsRead;

  constructor(private readonly seed: number, private readonly counts: Counts, variant: Variant) {
    this.r = rand(seed * 2654435761);
    this.record = variant.record ?? recordObservations;
    this.reviewed = variant.reviewed ?? reviewedObservationsOf;
    this.settle = variant.settle ?? settleMetrics;
    this.prune = variant.prune ?? pruneMetrics;
    this.read = variant.read ?? goalMetricsRead;
    this.configured = COMMANDS.slice(0, this.r.int(2, COMMANDS.length));
  }

  run() {
    const long = this.r.chance(0.12);
    const profile: Profile = long ? { cycles: this.r.int(64, 80), keep: Infinity, approve: 0.95, pass: 0.97 }
      : { cycles: this.r.int(4, 14), keep: this.r.pick([3, 5, 8, Infinity]), approve: 0.6, pass: 0.85 };
    bump(this.counts, long ? "seed:long" : Number.isFinite(profile.keep) ? "seed:fold" : "seed:short");
    for (let cycle = 1; cycle <= profile.cycles; cycle++) this.cycle(cycle, profile);
    this.restart();
    this.checkRead("end");
  }

  // -- Goal side

  private cycle(number: number, profile: Profile) {
    if (this.r.chance(0.1)) this.changeConfig();
    const run: SimRun = { id: `run-${String(number).padStart(3, "0")}`, holder: { run: { revision: 1, round: 0, checks: [] } as unknown as TeamRun },
      disk: "", expected: [], lastNames: new Map(), fewer: false };
    this.runs.set(run.id, run);
    this.runWrite(run);
    this.goal.goal.cycles.push({ teamId: run.id, cycle: number });
    if (this.goal.goal.cycles.length > profile.keep) {
      if (this.r.chance(0.35)) this.pendingFold = true;
      else { this.fold(profile.keep); bump(this.counts, "fold:at-launch"); }
    }
    this.goalSave("launch");
    const revisions = this.r.chance(0.3) ? this.r.int(2, 3) : 1;
    for (let revision = 1; revision <= revisions; revision++) {
      if (revision > 1) this.reopen(run);
      const verifications = this.r.int(1, 3);
      for (let index = 0; index < verifications; index++) this.verify(run, index === 0, profile);
      if (this.r.chance(0.08)) { run.holder.run.headCommit = this.head(); bump(this.counts, "head:moved"); this.runWrite(run); }
      this.review(run, profile);
      this.end(run, profile);
    }
    this.checkRead(`cycle ${number}`);
    if (this.r.chance(0.05)) { bump(this.counts, "stop:after-goal-write"); this.restart(); }
  }

  private fold(keep: number) {
    const cycles = this.goal.goal.cycles;
    this.goal.goal.cycles = cycles.slice(Math.max(0, cycles.length - keep));
  }

  private changeConfig() {
    bump(this.counts, "config:changed");
    const missing = COMMANDS.filter(command => !this.configured.includes(command));
    if (missing.length && (this.configured.length <= 1 || this.r.chance(0.5))) this.configured.push(this.r.pick(missing));
    else this.configured.splice(this.r.int(0, this.configured.length - 1), 1);
  }

  /** The goal step on an ended run, as goals.ts does it: settle from the run's reviewed observations, then save. */
  private end(run: SimRun, profile: Profile) {
    bump(this.counts, `end:${this.r.pick(ENDED)}`);
    this.runWrite(run);
    this.settleRun(run);
    if (this.r.chance(0.15)) {
      bump(this.counts, "stop:between-run-and-goal");
      this.restart();
      this.settleRun(run);
    }
    if (this.pendingFold) { this.fold(profile.keep); this.pendingFold = false; bump(this.counts, "fold:with-settlement"); }
    this.goalSave("settlement");
    if (this.r.chance(0.2)) { bump(this.counts, "settle:repeated"); this.settleRun(run); this.goalSave("repeated settlement"); }
  }

  private settleRun(run: SimRun) {
    const observations = this.reviewed(run.holder);
    bump(this.counts, observations === undefined ? "settle:unreviewed" : observations.some(item => item.state === "value") ? "settle:values" : "settle:no-values");
    this.settle(this.goal, run.id, observations);
    const before = this.ref.entries[run.id], entry = refEntry(run);
    if (entry) {
      this.ref.entries[run.id] = this.ref.settled[run.id] = entry;
      if (entry.more) bump(this.counts, "entry:over-16");
      if (before && entry.values.length < before.values.length && before.revision < entry.revision) bump(this.counts, "revision:fewer-values");
    } else {
      delete this.ref.entries[run.id]; delete this.ref.settled[run.id];
      if (before) bump(this.counts, "settle:removed");
    }
  }

  /** goals.ts `save`: retention, then the sealed write. */
  private goalSave(where: string) {
    this.prune(this.goal);
    refPrune(this.ref, this.goal.goal.cycles, this.counts);
    this.goalDisk = JSON.stringify(this.goal);
    this.refDisk = structuredClone(this.ref);
    this.checkState(`${where} write`);
  }

  /** Both holders come back from their last writes; running checks end interrupted; the goal's load prunes and writes if that changed it. */
  private restart() {
    bump(this.counts, "restart");
    const before = this.read(JSON.parse(this.goalDisk).metrics, JSON.parse(this.goalDisk).goal.cycles, this.configured);
    for (const run of this.runs.values()) {
      run.holder = JSON.parse(run.disk) as ObservationHolder;
      for (const row of run.holder.run.checks) if (row.status === "running") { row.status = "interrupted"; row.finishedAt = this.tick(); bump(this.counts, "observe:interrupted-by-stop"); }
      this.runWrite(run);
    }
    this.goal = JSON.parse(this.goalDisk) as GoalHolder;
    this.ref = structuredClone(this.refDisk);
    const loaded = JSON.stringify(this.goal);
    this.prune(this.goal);
    refPrune(this.ref, this.goal.goal.cycles, this.counts);
    if (JSON.stringify(this.goal) !== loaded) { this.goalDisk = JSON.stringify(this.goal); bump(this.counts, "restart:pruned"); }
    this.refDisk = structuredClone(this.ref);
    this.checkState("restart");
    const after = this.read(this.goal.metrics, this.goal.goal.cycles, this.configured);
    if (!isDeepStrictEqual(after, before)) this.fail("I5", "restart", `the read changed across a restart: ${JSON.stringify(before)} then ${JSON.stringify(after)}`);
  }

  // -- Run side

  private runWrite(run: SimRun) { run.disk = JSON.stringify(run.holder); }
  private tick() { this.clock += this.r.pick([0, 0, 1000]); return new Date(this.clock).toISOString(); }
  private head() { return sha(`${this.seed} head ${++this.heads}`).slice(0, 40); }

  private reopen(run: SimRun) {
    const team = run.holder.run;
    team.revision++;
    if (this.r.chance(0.4)) { team.round = 0; bump(this.counts, "round:reset"); }
    run.fewer = this.ref.entries[run.id] !== undefined;
    this.runWrite(run);
  }

  private verify(run: SimRun, first: boolean, profile: Profile) {
    const team = run.holder.run;
    if (!first && this.r.chance(0.2)) bump(this.counts, "round:same");
    else if (!first || team.checks.some(row => row.revision === team.revision)) team.round++;
    const head = team.headCommit !== undefined && this.r.chance(0.15) ? (bump(this.counts, "head:repeated"), team.headCommit) : this.head();
    team.headCommit = head;
    const commands: { command: TeamCommand; phase?: "setup" }[] = [];
    if (this.r.chance(0.3)) {
      const same = this.r.chance(0.5);
      commands.push({ command: same ? this.r.pick(this.configured) : { command: "npm", args: ["ci"] }, phase: "setup" });
      if (same) bump(this.counts, "observe:setup-same-command");
    }
    for (const command of this.configured) commands.push({ command });
    if (this.r.chance(0.15)) { commands.push({ command: this.r.pick(this.configured) }); bump(this.counts, "observe:duplicate-command"); }
    let passed = true;
    const seen = new Map<string, TeamCheck["status"]>();
    for (const { command, phase } of commands) {
      const plan = this.plan(run, command);
      const row: TeamCheck = { command, ...(phase ? { phase } : {}), status: "running", startedAt: this.tick(), output: "", revision: team.revision, round: team.round, headCommit: head };
      team.checks.push(row); run.expected.push(plan.expected);
      this.runWrite(run);
      if (this.r.chance(0.03)) { bump(this.counts, "stop:in-check"); this.restart(); return; }
      const status: TeamCheck["status"] = this.r.chance(profile.pass) ? "passed" : this.r.chance(0.8) ? "failed" : "interrupted";
      const scanner = new CheckMetricScanner();
      this.feed(scanner, plan.lines);
      Object.assign(row, { status, finishedAt: this.tick(), exitCode: status === "passed" ? 0 : 1 });
      this.record(run.holder, row, scanner.finish());
      this.runWrite(run);
      if (status !== "passed") passed = false;
      if (phase) continue;
      const key = refDigest(command), earlier = seen.get(key);
      if (earlier === undefined) { seen.set(key, status); run.lastNames.set(key, plan.names); }
      else if (earlier !== "passed" && status === "passed") bump(this.counts, "observe:first-failed");
      bump(this.counts, `check:${status}`);
    }
    if (passed) { run.holder.checkHead = head; this.runWrite(run); }
  }

  /** What one check prints: lines per name kept together, so the scanner's slots follow the order of `names`. */
  private plan(run: SimRun, command: TeamCommand): Plan {
    const r = this.r, last = run.lastNames.get(refDigest(command));
    let names: string[];
    if (run.fewer && last?.length) names = last.slice(0, r.int(0, last.length - 1));
    else {
      const roll = r.next(), count = roll < 0.1 ? 0 : roll < 0.7 ? r.int(1, 3) : roll < 0.95 ? r.int(4, 8) : r.int(9, 11);
      // A seeded Fisher-Yates shuffle: unlike a random comparator, it does not depend on the engine's sort.
      const pool: string[] = [...NAMES];
      for (let index = pool.length - 1; index > 0; index--) {
        const other = r.int(0, index);
        [pool[index], pool[other]] = [pool[other]!, pool[index]!];
      }
      names = pool.slice(0, count);
    }
    if (names.length > SLOTS) bump(this.counts, "observe:unslotted");
    const wholeInvalid = r.chance(0.02);
    const lines: string[] = [], expected: Expected[] = [];
    if (wholeInvalid) bump(this.counts, "observe:whole-invalid");
    for (const name of names) {
      if (r.chance(0.3)) lines.push(`ok ${r.int(1, 99)} - ${name}`);
      const roll = r.next(), value = r.chance(0.5) ? r.int(-500, 100_000) : r.int(0, 80_000) / 8;
      const kind: Kind = roll < 0.85 ? "value" : roll < 0.93 ? "ambiguous" : "invalid";
      if (kind === "value") { lines.push(`infinite-metric ${name} ${value}`); if (r.chance(0.1)) lines.push(`infinite-metric ${name} ${value}`); }
      else if (kind === "ambiguous") lines.push(`infinite-metric ${name} ${value}`, `infinite-metric ${name} ${value + 1}`);
      else lines.push(`infinite-metric ${name} x${value}`);
      if (expected.length < SLOTS) {
        if (kind !== "value" || wholeInvalid) bump(this.counts, `observe:${wholeInvalid ? "invalid" : kind}`);
        const state = wholeInvalid ? "invalid" : kind;
        expected.push({ name, state, ...(state === "value" ? { value } : {}) });
      }
    }
    if (wholeInvalid) lines.push("infinite-metric Bad 1");
    return { names, lines, expected };
  }

  /** Stdout in chunks cut at random bytes, with stderr marker lines between them that the scanner must ignore. */
  private feed(scanner: CheckMetricScanner, lines: readonly string[]) {
    const bytes = Buffer.from(lines.map(line => `${line}${this.r.chance(0.2) ? "\r\n" : "\n"}`).join(""));
    for (let at = 0; at < bytes.length;) {
      const end = Math.min(bytes.length, at + this.r.int(1, 48));
      scanner.push(bytes.subarray(at, end), "stdout");
      if (this.r.chance(0.1)) scanner.push(Buffer.from(`infinite-metric ${this.r.pick(NAMES)} 1\n`), "stderr");
      at = end;
    }
  }

  private review(run: SimRun, profile: Profile) {
    const team = run.holder.run, roll = this.r.next();
    if (roll < profile.approve) { team.review = { verdict: "approved", summary: "Approved.", revision: team.revision }; bump(this.counts, "review:approved"); }
    else if (roll < profile.approve + (1 - profile.approve) / 3) { team.review = { verdict: "changes-requested", summary: "Changes.", revision: team.revision }; bump(this.counts, "review:changes"); }
    else if (team.revision > 1 && this.r.chance(0.5)) { team.review = { verdict: "approved", summary: "Approved.", revision: team.revision - 1 }; bump(this.counts, "review:older-revision"); }
    else { delete team.review; bump(this.counts, "review:none"); }
    this.runWrite(run);
  }

  // -- Invariants

  private fail(invariant: string, where: string, message: string): never {
    throw new Violation(`seed ${this.seed}: ${invariant}: ${where}: ${message}; rerun with ${RERUN(this.seed)}`);
  }

  private checkState(where: string) {
    const disk = JSON.parse(this.goalDisk) as GoalHolder, ref = this.refDisk;
    const entries = disk.metrics?.entries ?? [], held = new Set(disk.goal.cycles.map(cycle => cycle.teamId));
    for (const entry of entries) if (!held.has(entry.run)) this.fail("I1", where, `an entry for ${entry.run}, a cycle the goal no longer holds`);
    for (const entry of entries) {
      if (!isDeepStrictEqual(entry, ref.settled[entry.run])) this.fail("I2", where, `${JSON.stringify(entry)}; the reference settlement is ${JSON.stringify(ref.settled[entry.run])}`);
    }
    const runs = entries.map(entry => entry.run).sort(), expected = Object.keys(ref.entries).sort();
    if (entries.length > ENTRIES) this.fail("I3", where, `${entries.length} entries`);
    if (!isDeepStrictEqual(runs, expected)) this.fail("I3", where, `entries for ${runs.join(",")}; the reference keeps ${expected.join(",")}`);
    if (disk.metrics && !entries.length && !disk.metrics.dropped) this.fail("I3", where, "an empty metrics field was written");
    if ((disk.metrics?.dropped ?? 0) !== ref.dropped) this.fail("I4", where, `dropped ${disk.metrics?.dropped ?? 0}; the reference removed ${ref.dropped}`);
  }

  private checkRead(where: string) {
    const view = this.read(this.goal.metrics, this.goal.goal.cycles, this.configured);
    const expected = refRead(this.ref, this.goal.goal.cycles, this.configured);
    if (!isDeepStrictEqual(view, expected)) this.fail("I5", where, `read ${JSON.stringify(view)}; the reference reads ${JSON.stringify(expected)}`);
    const again = this.read(this.goal.metrics, this.goal.goal.cycles, this.configured);
    if (!isDeepStrictEqual(again, view)) this.fail("I5", where, "a second read differs from the first");
    if (expected.omittedSeries) bump(this.counts, "read:over-8-series");
    if (expected.series.some(series => !series.configured)) bump(this.counts, "read:unconfigured");
    if (expected.series.some(series => series.label?.endsWith("…"))) bump(this.counts, "read:long-label");
    if (expected.omittedSeries && this.boundaryTie()) bump(this.counts, "read:boundary-tie");
  }

  /** Whether the 8th and 9th series by newest time share it, so the identity digest decides which is shown. */
  private boundaryTie() {
    const newest = new Map<string, string>();
    for (const entry of Object.values(this.ref.entries)) for (const value of entry.values) {
      const id = refIdentity(value.command, value.name), at = newest.get(id);
      if (at === undefined || value.at > at) newest.set(id, value.at);
    }
    const times = [...newest.values()].sort().reverse();
    return times.length > SERIES && times[SERIES - 1] === times[SERIES];
  }
}

export function simulate(seed: number, counts: Counts, variant: Variant = {}): void {
  new Sim(seed, counts, variant).run();
}
