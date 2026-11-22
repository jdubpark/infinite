import { isDeepStrictEqual } from "node:util";
import { MainCheckService, type MainCheckNotice } from "../../packages/host/src/main-check.js";
import { checksDigest, mainCheckSetting, outcomeOf, type CheckSummary, type MainCheckRecord, type Retiring } from "../../packages/host/src/main-check-state.js";
import type { CensusResult, ProcessWitness } from "../../packages/host/src/process-census.js";
import type { TeamCommand, TeamProject } from "../../packages/host/src/team-types.js";
import type { Config, Project } from "../../packages/host/src/types.js";
import { bump, type Counts, type Rand, rand } from "../outcome-sim-script.js";
import { clearFaults, Clock, guard, hex, type Life, type Nature, World, type WorldHooks } from "./main-check-world.js";

/*
 * A seeded simulator of the main check (INF-388). Each seed builds a host with two GitHub projects and scripts mirror
 * fetches against a real MainCheckService whose ports are the world in main-check-world.ts: heads that move, revert
 * (A, B, A), oscillate and repeat; fetches that arrive late or twice; halts during a check; host load, storage, the
 * execution identity, a census that fails, finds processes or is clean, and a removal that fails; the checks changing
 * at the same head; the setting turned off and on; notices whose acceptances arrive at once, late, out of order or
 * never; a host stop right after any kind of record write (armed by count or by kind), a clean restart, a boot, an
 * unreadable record and its restore. Then a drain clears every fault, ends what never ends, accepts every notice, and
 * waits for the host to come to rest. Time is virtual, so a seed replays exactly.
 *
 * Invariants, checked at every record write, removal and notice, after every step, and at the end of the drain:
 * I1 No admission while a main check runs or any directory is unretired, on the whole host (an unreadable record
 *    counts, since it may hide one). An unreadable record is never written.
 * I2 A head that has a result with the current checks digest is never admitted again.
 * I3 A head has at most 3 charged admissions per checks digest, and the record's attempts are exactly the charged
 *    admissions the writes made; after the drain the observed head has a result or 3 charged admissions.
 * I4 A directory is removed only after a census of its current witness that finished and found nothing, never for a
 *    recording entry of the same boot left by an earlier host process, and never while a process of its run lives;
 *    after the drain every run directory is removed.
 * I5 `told` changes only on an acceptance, to what was accepted and never back; after the drain it equals health's outcome.
 * I6 A notice is offered only while it is due: a failure nobody was told about, then fixed, offers nothing further.
 * I7 `health` is the result of the most recently observed head that has a result with the current digest, and
 *    `notice` went up exactly when its outcome changed.
 * I8 Under a halt nothing is admitted; a check that runs into a halt ends interrupted once a halt poll passed (unless
 *    an earlier stop or an unconfirmed stop decided its ending), and ends within a poll and the stop bound.
 * I9 A result is recorded only for a check whose copy was at the head and clean after every command.
 * Other labels name rules the simulator also checks: R1, R2, R4, R5, R6, R8, R9 and close.
 */

export class Violation extends Error {}
export const RERUN = (seed: number) => `MAIN_CHECK_SIM_SEED=${seed} node --import tsx --test tests/main-check-sim.test.ts`;
/** `patch` replaces something on one service instance; no source file is edited. */
export type Variant = { patch?: (service: MainCheckService) => void };

const ROOT = "/srv/main-check-sim";
const TEAMS = `${ROOT}/teams`;
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const KEY = Buffer.alloc(32, 7);
const PROJECTS = ["alpha", "beta"] as const;
type ProjectId = typeof PROJECTS[number];
const HEADS = 4;
const MINUTES = 1;
const STOP_BOUND_MS = 10_000;
/** A halt poll runs every 2 seconds; a final result after this much of a halt missed one. */
const HALT_WINDOW_MS = 2_050;
const DRAIN_ROUNDS = 240;
const DRAIN_ROUND_MS = 15_000;
const STEPS_PER_SEED = 70;
const SUDO = { command: "/usr/bin/sudo", args: ["-n", "-u", "agent", "--", "/opt/infinite/launcher"] };
const npm = (...args: string[]): TeamCommand => ({ command: "npm", args });
const make = (...args: string[]): TeamCommand => ({ command: "make", args });
/** The setup and checks each project can be configured with; a change step moves between them. */
const VARIANTS: Record<ProjectId, readonly { setup?: TeamCommand; checks: TeamCommand[] }[]> = {
  alpha: [
    { setup: npm("ci"), checks: [npm("run", "lint"), npm("test")] },
    { setup: npm("ci"), checks: [npm("run", "lint"), npm("test"), npm("run", "build")] },
    { checks: [npm("test")] },
  ],
  beta: [
    { checks: [make("check"), make("test")] },
    { setup: make("deps"), checks: [make("check"), make("test")] },
  ],
};

// ---- Script ------------------------------------------------------------------------------------------------------

type Move = "next" | "revert" | "repeat" | "late" | "duplicate" | "foreign";
type Step =
  | { do: "fetch"; project: ProjectId; move: Move }
  | { do: "advance"; ms: number }
  | { do: "halt"; scope: "host" | ProjectId | "throw"; on: boolean }
  | { do: "gate"; gate: "load" | "storage" | "identity" | "census" | "removal"; mode: string }
  | { do: "checks"; project: ProjectId; variant: number }
  | { do: "setting"; project: ProjectId; on: boolean }
  | { do: "notify" }
  | { do: "stop"; after: number }
  | { do: "stop"; kind: WriteKind }
  | { do: "restart" }
  | { do: "reboot" }
  | { do: "end-stuck" }
  | { do: "restore" };
type Script = { natures: Record<ProjectId, Nature[][]>; sudo: boolean; steps: Step[] };

function weighted<T>(r: Rand, table: readonly (readonly [number, T])[]): T {
  let roll = r.next() * table.reduce((sum, [weight]) => sum + weight, 0);
  for (const [weight, item] of table) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return table[0]![1];
}

function nature(r: Rand): Nature {
  const at = r.int(0, 3);
  return weighted<Nature>(r, [
    [30, { kind: "pass" }], [8, { kind: "slow" }], [16, { kind: "fail", at }], [10, { kind: "flaky" }], [5, { kind: "hang", at }],
    [4, { kind: "stuck", at }], [8, { kind: "dirty", at, heal: r.chance(0.5) }], [3, { kind: "unavailable", at }],
    [4, { kind: "prep-fail" }], [2, { kind: "prep-hang" }], [3, { kind: "wrong-head" }],
  ]);
}

const PROJECT_PICK: readonly (readonly [number, ProjectId])[] = [[60, "alpha"], [40, "beta"]];

/** Every random draw of the script happens here, before the host runs, so a seed names one script. */
function script(seed: number): Script {
  const r = rand(seed);
  const natures = Object.fromEntries(PROJECTS.map(project => [project, Array.from({ length: HEADS }, () => VARIANTS[project].map(() => nature(r)))])) as Record<ProjectId, Nature[][]>;
  const steps: Step[] = [];
  // Most halts, faults and settings that go off come back a few steps later, so heads keep being measured.
  const later: { at: number; step: Step }[] = [];
  const release = (index: number, step: Step) => {
    if (r.chance(0.7)) later.push({ at: index + r.int(1, 6), step });
  };
  for (let index = 0; index < STEPS_PER_SEED; index += 1) {
    for (const due of later.filter(item => item.at === index)) steps.push(due.step);
    const what = weighted(r, [[30, "fetch"], [28, "advance"], [5, "halt"], [6, "gate"], [5, "checks"], [2, "setting"], [14, "notify"], [7, "stop"], [2, "restart"], [1, "reboot"], [2, "end-stuck"], [1, "restore"]] as const);
    const project = weighted(r, PROJECT_PICK);
    if (what === "fetch") steps.push({ do: "fetch", project, move: weighted<Move>(r, [[40, "next"], [18, "revert"], [16, "repeat"], [10, "late"], [10, "duplicate"], [3, "foreign"]]) });
    else if (what === "advance") steps.push({ do: "advance", ms: r.chance(0.6) ? r.int(100, 5_000) : r.int(10_000, 90_000) });
    else if (what === "halt") {
      const scope = weighted(r, [[40, project], [35, "host"], [25, "throw"]] as const);
      const on = r.chance(0.55);
      steps.push({ do: "halt", scope, on });
      if (on) release(index, { do: "halt", scope, on: false });
    } else if (what === "gate") {
      const gate = weighted(r, [[20, "load"], [20, "storage"], [15, "identity"], [30, "census"], [25, "removal"]] as const);
      const modes = { load: ["clear", "held", "throw"], storage: ["ok", "low", "fail"], identity: ["fixed", "broken"], census: ["clean", "fail", "finds", "flaky"], removal: ["ok", "fail", "flaky"] }[gate];
      const mode = r.chance(0.45) ? modes[0]! : r.pick(modes);
      steps.push({ do: "gate", gate, mode });
      if (mode !== modes[0]) release(index, { do: "gate", gate, mode: modes[0]! });
    } else if (what === "checks") steps.push({ do: "checks", project, variant: r.int(0, VARIANTS[project].length - 1) });
    else if (what === "setting") {
      const on = r.chance(0.5);
      steps.push({ do: "setting", project, on });
      if (!on) release(index, { do: "setting", project, on: true });
    } else if (what === "notify") steps.push({ do: "notify" });
    else if (what === "stop") steps.push(r.chance(0.5) ? { do: "stop", after: r.int(1, 8) } : { do: "stop", kind: r.pick(WRITE_KINDS) });
    else steps.push({ do: what });
  }
  return { natures, sudo: r.chance(0.3), steps };
}

function describe(step: Step): string {
  switch (step.do) {
    case "fetch": return `fetch ${step.project} (${step.move})`;
    case "advance": return `advance ${step.ms} ms`;
    case "halt": return `halt ${step.scope} ${step.on ? "on" : "off"}`;
    case "gate": return `${step.gate} ${step.mode}`;
    case "checks": return `checks of ${step.project} to variant ${step.variant}`;
    case "setting": return `setting of ${step.project} ${step.on ? "on" : "off"}`;
    case "stop": return "kind" in step ? `stop after the next ${step.kind} write` : `stop after write ${step.after}`;
    default: return step.do;
  }
}

// ---- Host --------------------------------------------------------------------------------------------------------

const flush = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};
const short = (head: string) => head.slice(0, 8);
const show = (summary?: CheckSummary) => summary ? `${summary.outcome} at ${short(summary.head)}` : "absent";
const pathOf = (entry: { root: string; directory: string }) => `${entry.root}/${entry.directory}`;
const witnesses = (record: MainCheckRecord) => JSON.stringify([record.running?.witness, record.running?.recording, record.retiring]);

const WRITE_KINDS = ["create", "admission", "finish", "retire", "told", "observe", "witness", "waiting", "settle"] as const;
type WriteKind = typeof WRITE_KINDS[number];

/** What one record write did, so a stop can follow each kind and the corpus can show that it did. */
function writeKind(prev: MainCheckRecord | undefined, next: MainCheckRecord): WriteKind {
  if (!prev) return "create";
  if (!prev.running && next.running) return "admission";
  if (prev.running && !next.running) return "finish";
  if ((next.retiring?.length ?? 0) < (prev.retiring?.length ?? 0)) return "retire";
  if (!isDeepStrictEqual(prev.told, next.told)) return "told";
  if (!isDeepStrictEqual(prev.observed, next.observed)) return "observe";
  if (witnesses(prev) !== witnesses(next)) return "witness";
  if (prev.waiting !== next.waiting) return "waiting";
  return "settle";
}

function projectOf(id: ProjectId, variant: number): Project {
  return {
    id, name: id === "alpha" ? "Alpha" : "Beta", path: `${ROOT}/${id}`,
    ...(id === "beta" ? { teamworkDir: `${ROOT}/home/teamwork-beta` } : {}),
    source: { mode: "github", repository: `example/${id}`, baseBranch: "main" },
    team: { ...structuredClone(VARIANTS[id][variant]!), mainCheck: { minutes: MINUTES } } as TeamProject,
  };
}

class Sim {
  readonly clock = new Clock(T0);
  readonly world: World;
  readonly config: Config;
  private readonly runtime: Rand;
  private readonly heads: Record<ProjectId, string[]>;
  private life: Life = { id: 0, stopped: true };
  private service!: MainCheckService;
  private where = "setup";
  private failure?: unknown;
  private writes = 0;
  private stopAt = 0;
  private readonly stopKinds = new Set<WriteKind>();
  private down = false;
  private inStart = false;
  private accepting?: { projectId: string; notice: number; outcome: "passed" | "failed" };
  private pendingObservation?: { projectId: string; head: string; at: string };
  // The model: what the writes so far establish.
  private readonly log = new Map<string, { head: string; at: string }[]>();
  private readonly charged = new Map<string, number>();
  private readonly measured = new Set<string>();
  private readonly admitted = new Map<string, { projectId: string; life: number }>();
  private earlier = new Set<string>();
  private readonly censuses = new Map<string, { life: number; clean: boolean; witness: string }>();
  private readonly haltSince = new Map<string, number>();
  private readonly flights = new Map<string, { notice: number; until: number }>();
  private pending: MainCheckNotice[] = [];
  private readonly acceptedUpTo = new Map<string, number>();
  private readonly corrupt = new Map<string, string>();
  private readonly stamps = new Map<string, number>();
  private readonly main = new Map<string, { index: number; previous: number; last?: { head: string; at: string } }>();
  private readonly variants = new Map<string, number>();

  constructor(private readonly seed: number, private readonly s: Script, private readonly counts: Counts, private readonly variant: Variant) {
    this.runtime = rand(seed ^ 0x5bd1e995);
    const r = rand(seed + 1_000_003);
    this.heads = Object.fromEntries(PROJECTS.map(project => [project, Array.from({ length: HEADS }, () => hex(r, 40))])) as Record<ProjectId, string[]>;
    this.world = new World(this.clock, rand(seed + 2_000_003), counts, this.hooks());
    const agents = { claude: s.sudo ? { command: "/usr/bin/sudo", args: ["-n", "-u", "agent", "--", "claude"] } : { command: "claude", args: [] } };
    this.config = {
      stateDir: `${ROOT}/state`, projects: PROJECTS.map(id => projectOf(id, 0)), agents,
      teams: { workspaceDir: TEAMS, ...(s.sudo ? { commandPrefix: SUDO } : {}), publishHeads: true },
      sync: { homeDir: `${ROOT}/home` },
    } as unknown as Config;
    for (const id of PROJECTS) {
      this.variants.set(id, 0);
      this.main.set(id, { index: 0, previous: 0 });
    }
  }

  private fail(invariant: string, message: string): never {
    throw new Violation(`seed ${this.seed} ${this.where}: ${invariant}: ${message}; rerun: ${RERUN(this.seed)}`);
  }

  /** A check that throws inside a port is kept and raised at the step: the service swallows what its ports throw. */
  private guarded(check: () => void) {
    try { check(); } catch (error) { this.failure ??= error; }
  }

  private raise() {
    if (this.failure !== undefined) throw this.failure;
  }

  private project(id: string): Project {
    return this.config.projects.find(project => project.id === id)!;
  }

  private digestOf(id: string) {
    return checksDigest(this.project(id).team!);
  }

  private planLength(id: string) {
    const team = this.project(id).team!;
    return team.checks.length + (team.setup ? 1 : 0);
  }

  /** The record on disk; for an unreadable one, the record it was before. */
  private durable(id: string): MainCheckRecord | undefined {
    const text = this.corrupt.get(id) ?? this.world.records.get(id);
    return text === undefined ? undefined : JSON.parse(text) as MainCheckRecord;
  }

  private halts(id: string) {
    const halt = this.world.faults.halt;
    return halt.host || halt.throws || halt.projects.has(id);
  }

  private hooks(): WorldHooks {
    return {
      write: (projectId, record) => {
        const kind = writeKind(this.durable(projectId), record);
        this.guarded(() => this.checkWrite(projectId, record));
        this.world.records.set(projectId, JSON.stringify(record));
        this.writes += 1;
        bump(this.counts, `write:${kind}`);
        // A stop armed by kind waits for that kind and outlives stops armed by count.
        if (this.stopKinds.delete(kind)) bump(this.counts, "stop:by-kind");
        else if (this.stopAt > 0 && this.writes >= this.stopAt) this.stopAt = 0;
        else return;
        this.life.stopped = true;
        bump(this.counts, `stop:after-${kind}`);
      },
      census: (directory, witness, result) => this.noteCensus(directory, witness, result),
      remove: directory => this.guarded(() => this.checkRemove(directory)),
      prepare: (mirror, head, root, directoryName, branch, teamwork) => {
        const projectId = /\/mirrors\/([a-z0-9-]+)\.git$/.exec(mirror)?.[1] ?? "";
        this.guarded(() => this.checkNames(projectId, head, root, directoryName, branch, teamwork));
        return projectId;
      },
      command: (run, command, timeoutMs, forceSettleAfterMs) => this.guarded(() => {
        if (timeoutMs !== MINUTES * 60_000 || forceSettleAfterMs !== STOP_BOUND_MS) this.fail("R5", `a check command ran with a time limit of ${timeoutMs} ms and a stop bound of ${forceSettleAfterMs} ms`);
        if (!this.project(run.projectId).team!.checks.concat(this.project(run.projectId).team!.setup ?? []).some(item => isDeepStrictEqual(item, command))) bump(this.counts, "command:from-earlier-checks");
      }),
      natureOf: (projectId, head) => {
        const index = this.heads[projectId as ProjectId].indexOf(head);
        return { nature: this.s.natures[projectId as ProjectId][index]![this.variants.get(projectId)!]!, planLength: this.planLength(projectId) };
      },
      otherHead: (projectId, head) => this.heads[projectId as ProjectId].find(item => item !== head)!,
    };
  }

  // ---- Checks at each write, census, removal and offer -----------------------------------------------------------

  private checkWrite(projectId: string, next: MainCheckRecord) {
    if (this.corrupt.has(projectId)) this.fail("I1", `the unreadable record of ${projectId} was written over`);
    const prev = this.durable(projectId);
    if (!prev?.running && next.running) this.onAdmission(projectId, prev, next);
    if (prev?.running && !next.running) this.onFinish(projectId, prev, next);
    if (prev?.running && next.running && prev.running.directory !== next.running.directory) this.fail("R4", "one write replaced a running check with another");
    this.checkTold(projectId, prev, next);
    this.checkHealth(projectId, prev, next);
    this.checkAttempts(projectId, next);
    if (next.waiting !== prev?.waiting && next.waiting) bump(this.counts, `waiting:${next.waiting}`);
  }

  private onAdmission(projectId: string, prev: MainCheckRecord | undefined, next: MainCheckRecord) {
    const running = next.running!;
    for (const other of PROJECTS) {
      if (this.corrupt.has(other)) this.fail("I1", `${projectId} was admitted while the record of ${other} is unreadable`);
      const record = other === projectId ? prev : this.durable(other);
      if (other !== projectId && record?.running) this.fail("I1", `${projectId} was admitted while ${other} runs a check`);
      if (record?.retiring?.length) this.fail("I1", `${projectId} was admitted while ${other} has ${record.retiring.length} unretired run directories`);
    }
    if (this.halts(projectId)) this.fail("I8", `${projectId} was admitted under a halt`);
    if (running.checks !== this.digestOf(projectId)) this.fail("R2", "a check was admitted with a checks digest that is not the current one");
    if (running.head !== prev?.observed?.head) this.fail("R2", `${short(running.head)} was admitted while the observed head is ${prev?.observed ? short(prev.observed.head) : "none"}`);
    if (running.recording !== true || running.witness.boot !== this.world.boot || running.witness.groups.length > 0) this.fail("R4", "the admission did not record an empty witness of this boot that is recording");
    const key = `${projectId} ${running.head} ${running.checks}`;
    if (this.measured.has(key)) this.fail("I2", `${short(running.head)} was admitted again although it has a result with the current checks`);
    const count = (this.charged.get(key) ?? 0) + 1;
    this.charged.set(key, count);
    if (count > 3) this.fail("I3", `${short(running.head)} was admitted a ${count}th time with the same checks`);
    this.admitted.set(pathOf(running), { projectId, life: this.life.id });
    bump(this.counts, `admission:${projectId}`);
  }

  private onFinish(projectId: string, prev: MainCheckRecord, next: MainCheckRecord) {
    const running = prev.running!;
    const entry = next.retiring?.find(item => item.directory === running.directory);
    const last = next.last;
    if (!entry || !last || last.head !== running.head) this.fail("R6", "a check left `running` without its directory in `retiring` and its `last`");
    const key = `${projectId} ${running.head} ${running.checks}`;
    // A check an earlier process admitted is ended by R8, at start or when its unreadable record reads again.
    if (this.admitted.get(pathOf(running))?.life !== this.life.id) {
      const kept = isDeepStrictEqual(entry.witness, running.witness) && entry.recording === running.recording;
      if (last.outcome !== "interrupted" || last.reason !== "host-stop" || !kept) this.fail("R8", `host start recorded ${last.outcome}/${last.reason} and ${kept ? "kept" : "changed"} the witness`);
      bump(this.counts, `r8:${this.inStart ? "start" : "reread"}:${running.recording ? "recording" : "recorded"}`);
      return;
    }
    bump(this.counts, `outcome:${last.outcome}${last.reason ? `:${last.reason}` : ""}`);
    // Once a halt poll passed, the check was told to stop: it ends interrupted, unless an earlier stop or an
    // unconfirmed stop decided its ending.
    const since = this.haltSince.get(projectId);
    const stopped = last.outcome === "interrupted" || last.reason === "stop-unconfirmed";
    if (since !== undefined && this.clock.now - since > HALT_WINDOW_MS && !stopped) this.fail("I8", `the check ended ${last.outcome}${last.reason ? `/${last.reason}` : ""} ${this.clock.now - since} ms into a halt`);
    if (since !== undefined && last.reason === "halt") bump(this.counts, "halt:check-interrupted");
    if (last.outcome === "passed" || last.outcome === "failed") {
      const run = this.world.runs.get(pathOf(running));
      if (!run || run.copyHead !== running.head || run.dirtied) this.fail("I9", `a ${last.outcome} result was recorded for a copy that ${!run ? "was never prepared" : run.copyHead !== running.head ? "is at another head" : "changed after a command"}`);
      this.measured.add(key);
      this.charged.delete(key);
      if (next.results?.at(-1)?.observedAt !== this.latestObservation(projectId, running.head)) this.fail("I7", "a result's observedAt is not the latest observation of its head");
      return;
    }
    if (last.outcome === "interrupted" && (last.reason === "halt" || last.reason === "host-stop")) this.charged.set(key, (this.charged.get(key) ?? 0) - 1);
    if (!this.charged.get(key)) this.charged.delete(key);
  }

  private latestObservation(projectId: string, head: string) {
    return (this.log.get(projectId) ?? []).filter(item => item.head === head).at(-1)?.at;
  }

  private checkTold(projectId: string, prev: MainCheckRecord | undefined, next: MainCheckRecord) {
    if (isDeepStrictEqual(prev?.told, next.told)) return;
    const accepting = this.accepting;
    if (accepting?.projectId !== projectId) this.fail("I5", `told became ${JSON.stringify(next.told)} without an acceptance`);
    if (next.told?.notice !== accepting.notice || next.told.outcome !== accepting.outcome) this.fail("I5", `the acceptance of ${accepting.notice} (${accepting.outcome}) set told to ${JSON.stringify(next.told)}`);
    if (accepting.notice < (prev?.told?.notice ?? 0)) this.fail("I5", `a late acceptance of ${accepting.notice} moved told back from ${prev?.told?.notice}`);
    bump(this.counts, "told:changed");
  }

  /** I7's model: the newest observation, in fetch order, whose head has a result with the current digest. */
  private expectedHealth(projectId: string, record: MainCheckRecord): CheckSummary | undefined {
    const digest = this.digestOf(projectId);
    const log = [...(this.log.get(projectId) ?? [])];
    const pending = this.pendingObservation;
    if (pending?.projectId === projectId && record.observed?.head === pending.head && record.observed.at === pending.at) log.push(pending);
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const result = record.results?.filter(item => item.head === log[index]!.head && item.checks === digest).at(-1);
      if (result) return result;
    }
    return undefined;
  }

  private checkHealth(projectId: string, prev: MainCheckRecord | undefined, next: MainCheckRecord) {
    const expected = this.expectedHealth(projectId, next);
    if (!isDeepStrictEqual(next.health, expected)) this.fail("I7", `health is ${show(next.health)}; the most recently observed head with a result under the current checks gives ${show(expected)}`);
    const delta = (next.notice ?? 0) - (prev?.notice ?? 0);
    const changed = outcomeOf(next.health) !== outcomeOf(prev?.health);
    if (delta !== (changed ? 1 : 0)) this.fail("I7", `notice moved by ${delta} while health went from ${show(prev?.health)} to ${show(next.health)}`);
    if (changed) bump(this.counts, `health:${outcomeOf(next.health)}`);
    // I6's case: a failure the owner was never told about is fixed, so nothing is due.
    if (changed && outcomeOf(next.health) === "passed" && outcomeOf(next.told) === "passed") bump(this.counts, "health:fixed-before-told");
  }

  private checkAttempts(projectId: string, next: MainCheckRecord) {
    const recorded = new Map((next.attempts ?? []).map(entry => [`${projectId} ${entry.head} ${entry.checks}`, entry.count]));
    for (const [key, count] of this.charged) {
      if (!key.startsWith(`${projectId} `) || recorded.get(key) === count) continue;
      this.fail("I3", `the record holds ${recorded.get(key) ?? 0} charged admissions of ${short(key.split(" ")[1]!)} where the writes charged ${count}`);
    }
    for (const [key, count] of recorded) if (!this.charged.has(key)) this.fail("I3", `the record holds ${count} charged admissions of ${short(key.split(" ")[1]!)} that no write charged`);
  }

  private noteCensus(directory: string, witness: ProcessWitness, result: CensusResult) {
    this.censuses.set(directory, { life: this.life.id, clean: result.ok && result.findings.length === 0, witness: JSON.stringify(witness) });
  }

  private checkRemove(directory: string) {
    let entry: Retiring | undefined;
    for (const id of PROJECTS) entry ??= this.durable(id)?.retiring?.find(item => pathOf(item) === directory);
    if (!entry) this.fail("I4", `${directory} was removed while no record holds it in retiring`);
    const census = this.censuses.get(directory);
    if (!census?.clean || census.life !== this.life.id || census.witness !== JSON.stringify(entry.witness)) this.fail("I4", "a directory was removed without a clean census of its current witness");
    if (entry.recording && this.earlier.has(directory) && entry.witness.boot === this.world.boot) this.fail("I4", "a directory was removed that an earlier host process left while recording, in the same boot");
    const alive = [...this.world.processes.values()].filter(proc => proc.run === directory).length;
    if (alive > 0) this.fail("I4", `a directory was removed while ${alive} of its run's processes live`);
    bump(this.counts, `retire:removed${this.earlier.has(directory) ? ":earlier" : ""}`);
  }

  private checkNames(projectId: string, head: string, root: string, directoryName: string, branch: string, teamwork: boolean) {
    const project = this.project(projectId);
    const match = new RegExp(`^${project.teamworkDir ? "" : `${projectId}-`}\\d{4}-\\d{2}-\\d{2}-main-check-([0-9a-f]{8})$`).exec(directoryName);
    if (!match || branch !== `infinite/team-main-check-${match[1]}`) this.fail("R5", `the run directory ${directoryName} or branch ${branch} breaks the naming rule`);
    if (root !== (project.teamworkDir ?? TEAMS) || teamwork !== Boolean(project.teamworkDir)) this.fail("R5", `the copy was prepared under ${root}`);
    if (this.durable(projectId)?.running?.head !== head) this.fail("R5", "a copy was prepared for a head the record does not run");
  }

  private checkOffer(notice: MainCheckNotice) {
    const record = this.durable(notice.projectId);
    const flight = this.flights.get(notice.projectId);
    if (flight && flight.until > this.clock.now) this.fail("R9", `a notice of ${notice.projectId} was offered while notice ${flight.notice} is in flight`);
    if (!record || outcomeOf(record.health) === outcomeOf(record.told)) this.fail("I6", `notice ${notice.notice} (${notice.outcome}) was offered while health is ${show(record?.health)} and the owner was told ${record?.told?.outcome ?? "nothing"}`);
    if (notice.outcome !== outcomeOf(record.health) || notice.notice !== (record.notice ?? 0) || !isDeepStrictEqual(notice.summary, record.health)) this.fail("R9", "the notice is not health's generation, outcome and summary");
    if (mainCheckSetting(this.project(notice.projectId).team) === undefined) this.fail("R9", "a notice was offered with the setting off");
    bump(this.counts, `notice:offered:${notice.outcome}${notice.summary ? "" : ":no-summary"}`);
    this.flights.set(notice.projectId, { notice: notice.notice, until: this.clock.now + 60_000 });
  }

  /** I8: a check that runs into a halt ends within a poll and the stop bound. */
  private checkHaltEnds() {
    if (this.life.stopped) return;
    for (const id of PROJECTS) {
      const since = this.haltSince.get(id);
      const running = this.durable(id)?.running;
      if (since === undefined || !running || this.clock.now - since <= HALT_WINDOW_MS + STOP_BOUND_MS + 500) continue;
      if (this.admitted.get(pathOf(running))?.life === this.life.id) this.fail("I8", `the check of ${id} still runs ${this.clock.now - since} ms into a halt`);
    }
  }

  // ---- Lives -----------------------------------------------------------------------------------------------------

  private async open() {
    const life: Life = { id: this.life.id + 1, stopped: false };
    this.life = life;
    this.earlier = new Set(PROJECTS.flatMap(id => {
      const record = this.durable(id);
      return [...(record?.retiring ?? []), ...(record?.running ? [record.running] : [])].map(pathOf);
    }));
    this.flights.clear();
    const ports = guard(life, this.world.ports(life), this.counts);
    const service = new MainCheckService({ config: this.config, key: KEY, mirrorPath: id => `${ROOT}/mirrors/${id}.git`, halt: ports.halt, hostLoad: ports.hostLoad, ports });
    this.variant.patch?.(service);
    this.service = service;
    this.inStart = true;
    try { await service.start(); } finally { this.inStart = false; }
    await flush();
    this.raise();
  }

  /** The host stopped right after a write: it stays down a while, may boot again, and opens over what is on disk. */
  private async recover() {
    // The next process can stop too, after a write of its own start.
    while (this.life.stopped) {
      this.clock.drop(this.life);
      this.down = true;
      try { await this.advance(this.runtime.int(0, 15_000)); } finally { this.down = false; }
      if (this.runtime.chance(0.15)) this.reboot();
      if (this.runtime.chance(0.12)) this.corruptOne();
      await this.open();
    }
  }

  private reboot() {
    this.world.reboot();
    bump(this.counts, "reboot");
  }

  private corruptOne() {
    const id = this.runtime.pick(PROJECTS);
    const text = this.world.records.get(id);
    if (text === undefined || this.corrupt.has(id)) return;
    this.corrupt.set(id, text);
    this.world.records.set(id, this.runtime.chance(0.5) ? "{\"version\":2}" : "{ not json");
    bump(this.counts, "record:unreadable");
  }

  private async advance(ms: number) {
    const target = this.clock.now + ms;
    for (;;) {
      const timer = this.clock.take(target);
      if (!timer) break;
      this.clock.now = timer.at;
      timer.fn();
      await flush();
      this.raise();
      if (this.life.stopped && !this.down) await this.recover();
      this.checkHaltEnds();
    }
    this.clock.now = Math.max(this.clock.now, target);
    await flush();
    this.raise();
  }

  // ---- Steps -----------------------------------------------------------------------------------------------------

  async run() {
    await this.open();
    for (const [index, step] of this.s.steps.entries()) {
      this.where = `step ${index + 1} (${describe(step)})`;
      await this.step(step);
      await flush();
      this.raise();
      if (this.life.stopped) await this.recover();
      this.checkHaltEnds();
    }
    this.where = "drain";
    await this.drain();
  }

  private async step(step: Step) {
    switch (step.do) {
      case "fetch": return this.fetch(step.project, step.move);
      case "advance": return this.advance(step.ms);
      case "halt": return this.halt(step.scope, step.on);
      case "gate": return this.gate(step.gate, step.mode);
      case "checks": return this.changeChecks(step.project, step.variant);
      case "setting": return this.setting(step.project, step.on);
      case "notify": return this.notify(false);
      case "stop":
        if ("kind" in step) this.stopKinds.add(step.kind);
        else this.stopAt = this.writes + step.after;
        return;
      case "restart": return this.restart();
      case "reboot":
        this.life.stopped = true;
        this.clock.drop(this.life);
        this.reboot();
        return this.open();
      case "end-stuck":
        bump(this.counts, `end-stuck:${this.world.endStuck() > 0 ? "some" : "none"}`);
        return;
      case "restore": return this.restore();
    }
  }

  private fetch(id: ProjectId, move: Move) {
    const state = this.main.get(id)!;
    const project = this.project(id);
    const source = project.source as { repository: string; baseBranch: string };
    const last = this.stamps.get(id) ?? T0 - 1;
    let head = this.heads[id][state.index]!;
    let at = Math.max(this.clock.now, last + 1);
    if (move === "next" || move === "revert") {
      const target = move === "next" ? (state.index + 1) % HEADS : state.previous;
      state.previous = state.index;
      state.index = target;
      head = this.heads[id][target]!;
    }
    if (move === "late") {
      head = this.runtime.pick(this.heads[id]);
      at = last - this.runtime.int(1, 20_000);
      // Fetches of one mirror are serial, so two heads never share a stamp; settle could not order them.
      while ((this.log.get(id) ?? []).some(item => Date.parse(item.at) === at && item.head !== head)) at -= 1;
    }
    // A duplicate repeats the last fetch; before any fetch it is a fresh one and takes a fresh stamp.
    const duplicate = move === "duplicate" && state.last !== undefined;
    if (duplicate) {
      head = state.last!.head;
      at = Date.parse(state.last!.at);
    }
    if (move !== "late" && !duplicate) this.stamps.set(id, at);
    const fetchedAt = new Date(at).toISOString();
    if (move !== "late") state.last = { head, at: fetchedAt };
    const repository = move === "foreign" ? "example/elsewhere" : source.repository;
    const before = this.world.records.get(id);
    this.pendingObservation = { projectId: id, head, at: fetchedAt };
    try { this.service.observe({ projectId: id, repository, baseBranch: source.baseBranch, head, fetchedAt }); }
    finally { this.pendingObservation = undefined; }
    if (move === "foreign" && this.world.records.get(id) !== before) this.fail("R1", "a fetch of another repository changed the record");
    const record = this.durable(id);
    const observed = move !== "foreign" && record?.observed?.head === head && record.observed.at === fetchedAt;
    if (observed) this.log.set(id, [...(this.log.get(id) ?? []), { head, at: fetchedAt }]);
    bump(this.counts, `fetch:${move}:${observed ? "observed" : "ignored"}`);
  }

  private halt(scope: "host" | ProjectId | "throw", on: boolean) {
    const halt = this.world.faults.halt;
    if (scope === "host") halt.host = on;
    else if (scope === "throw") halt.throws = on;
    else if (on) halt.projects.add(scope);
    else halt.projects.delete(scope);
    for (const id of PROJECTS) {
      if (!this.halts(id)) this.haltSince.delete(id);
      else if (!this.haltSince.has(id)) {
        this.haltSince.set(id, this.clock.now);
        if (this.durable(id)?.running) bump(this.counts, "halt:during-check");
      }
    }
    bump(this.counts, `halt:${scope === "host" || scope === "throw" ? scope : "project"}:${on ? "on" : "off"}`);
  }

  private gate(gate: "load" | "storage" | "identity" | "census" | "removal", mode: string) {
    const faults = this.world.faults;
    if (gate === "load") faults.load = mode as typeof faults.load;
    if (gate === "storage") faults.storage = mode as typeof faults.storage;
    if (gate === "census") faults.census = mode as typeof faults.census;
    if (gate === "removal") faults.removal = mode as typeof faults.removal;
    if (gate === "identity") this.identity(mode === "fixed");
    bump(this.counts, `gate:${gate}:${mode}`);
  }

  /** A sudo provider profile without a team command prefix breaks R0. */
  private identity(fixed: boolean) {
    const teams = this.config.teams!;
    this.config.agents.claude = { command: "/usr/bin/sudo", args: ["-n", "-u", "agent", "--", "claude"] };
    if (fixed) teams.commandPrefix = SUDO;
    else delete teams.commandPrefix;
  }

  private changeChecks(id: ProjectId, variant: number) {
    const project = this.project(id);
    const record = this.durable(id);
    const before = this.digestOf(id);
    const head = record?.observed?.head;
    if (head && record.results?.some(item => item.head === head && item.checks === before) && this.variants.get(id) !== variant) bump(this.counts, "checks:changed-at-measured-head");
    this.variants.set(id, variant);
    const setting = mainCheckSetting(project.team);
    project.team = { ...structuredClone(VARIANTS[id][variant]!), ...(setting ? { mainCheck: setting } : {}) } as TeamProject;
    bump(this.counts, before === this.digestOf(id) ? "checks:same" : "checks:changed");
  }

  private setting(id: ProjectId, on: boolean) {
    const team = this.project(id).team! as TeamProject & { mainCheck?: { minutes: number } };
    if (on) team.mainCheck = { minutes: MINUTES };
    else delete team.mainCheck;
    bump(this.counts, `setting:${on ? "on" : "off"}`);
  }

  /** `late` acceptances are labelled: out of order after a newer one of the project, stale after health moved on. */
  private accept(notice: MainCheckNotice, late: boolean) {
    const newest = this.acceptedUpTo.get(notice.projectId) ?? -1;
    const how = !late ? "at-once" : notice.notice < newest ? "out-of-order" : notice.notice < (this.durable(notice.projectId)?.notice ?? 0) ? "stale" : "late";
    this.accepting = { projectId: notice.projectId, notice: notice.notice, outcome: notice.outcome };
    try { this.service.accepted(notice.projectId, notice.notice, notice.outcome); }
    finally { this.accepting = undefined; }
    if (this.flights.get(notice.projectId)?.notice === notice.notice) this.flights.delete(notice.projectId);
    this.acceptedUpTo.set(notice.projectId, Math.max(newest, notice.notice));
    bump(this.counts, `notice:accepted:${how}`);
  }

  /** Offers, then answers: at once, later and possibly out of order, refused, or never. `all` accepts everything. */
  private notify(all: boolean) {
    const offered = this.service.notices();
    this.raise();
    for (const notice of offered) {
      this.checkOffer(notice);
      const roll = all ? 0 : this.runtime.next();
      if (roll < 0.45) {
        this.accept(notice, false);
        // A second device's acceptance of the same notice may arrive much later.
        if (!all && this.runtime.chance(0.3)) this.pending.push(notice);
      } else if (roll < 0.7) this.pending.push(notice);
      else if (roll < 0.8) {
        this.service.refused(notice.projectId, notice.notice);
        if (this.flights.get(notice.projectId)?.notice === notice.notice) this.flights.delete(notice.projectId);
        bump(this.counts, "notice:refused");
      } else bump(this.counts, "notice:never");
    }
    // Late acceptances arrive in any order: newest first half the time, otherwise shuffled.
    const late = this.runtime.chance(0.5) ? [...this.pending].sort((a, b) => b.notice - a.notice) : this.shuffle(this.pending);
    this.pending = [];
    for (const notice of late) {
      if (!all && this.runtime.chance(0.7)) this.pending.push(notice);
      else this.accept(notice, true);
    }
    this.raise();
  }

  private shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = this.runtime.int(0, index);
      [copy[index], copy[other]] = [copy[other]!, copy[index]!];
    }
    return copy;
  }

  private disarm() {
    this.stopAt = 0;
    this.stopKinds.clear();
  }

  /** close(), then a new process. An armed stop may still land on a write of the shutdown. */
  private async restart() {
    const life = this.life;
    const closing = this.service.close();
    let done = false;
    void closing.then(() => { done = true; });
    for (let waited = 0; !done && !life.stopped && waited <= STOP_BOUND_MS + 5_000; waited += 250) await this.advance(250);
    // The process ended on a write of its shutdown, as a stop: recovery opens the next one, now or after this step.
    if (life.stopped) {
      bump(this.counts, "restart:stopped-in-close");
      return;
    }
    if (!done) this.fail("close", "close() did not return within the stop bound");
    this.life.stopped = true;
    this.clock.drop(this.life);
    bump(this.counts, "restart:clean");
    if (this.runtime.chance(0.1)) this.corruptOne();
    await this.open();
  }

  private restore() {
    for (const [id, text] of this.corrupt) this.world.records.set(id, text);
    bump(this.counts, `restore:${this.corrupt.size > 0 ? "some" : "none"}`);
    this.corrupt.clear();
  }

  // ---- Drain -----------------------------------------------------------------------------------------------------

  /** Entries only a boot can retire: recording, left by an earlier host process, of this boot. */
  private blockedUntilBoot() {
    return PROJECTS.some(id => this.durable(id)?.retiring?.some(entry => entry.recording && this.earlier.has(pathOf(entry)) && entry.witness.boot === this.world.boot));
  }

  private quiet() {
    for (const id of PROJECTS) {
      const record = this.durable(id);
      if (!record) continue;
      if (record.running || record.retiring?.length) return false;
      const head = record.observed?.head;
      if (head && !this.settledHead(id, record, head)) return false;
      if (outcomeOf(record.health) !== outcomeOf(record.told)) return false;
    }
    return true;
  }

  private settledHead(id: string, record: MainCheckRecord, head: string) {
    const digest = this.digestOf(id);
    return record.results?.some(item => item.head === head && item.checks === digest) || (this.charged.get(`${id} ${head} ${digest}`) ?? 0) >= 3;
  }

  /** Clear gates, a quiet host, working removal and acceptances: the host must come to rest. */
  private async drain() {
    this.disarm();
    this.world.faults = clearFaults();
    this.haltSince.clear();
    this.identity(true);
    for (const id of PROJECTS) this.setting(id, true);
    this.restore();
    let rounds = 0;
    for (; rounds < DRAIN_ROUNDS && !this.quiet(); rounds += 1) {
      const running = PROJECTS.map(id => this.durable(id)?.running).find(Boolean);
      const longRunning = running && this.clock.now - Date.parse(running.startedAt) > 150_000;
      this.world.endStuck(running && !longRunning ? pathOf(running) : undefined);
      this.notify(true);
      if (this.blockedUntilBoot()) {
        this.life.stopped = true;
        this.clock.drop(this.life);
        this.reboot();
        bump(this.counts, "drain:reboot");
        await this.open();
      }
      await this.advance(DRAIN_ROUND_MS);
    }
    bump(this.counts, rounds < DRAIN_ROUNDS ? "drain:rested" : "drain:restless");
    for (const id of PROJECTS) {
      const record = this.durable(id);
      if (!record) continue;
      if (record.running) this.fail("I3", `the check of ${id} still runs after the drain`);
      if (record.retiring?.length) this.fail("I4", `${record.retiring.length} run directories of ${id} were not retired with a clean census and working removal`);
      const head = record.observed?.head;
      if (head && !this.settledHead(id, record, head)) this.fail("I3", `the observed head ${short(head)} of ${id} has neither a result nor 3 charged admissions after the drain`);
      if (outcomeOf(record.health) !== outcomeOf(record.told)) this.fail("I5", `told is ${record.told?.outcome ?? "absent"} while health is ${show(record.health)} after every notice was accepted`);
      bump(this.counts, `end:${outcomeOf(record.health)}`);
    }
    for (const run of this.world.runs.values()) if (run.exists) this.fail("I4", `the run directory ${run.path} is still on disk after the drain`);
  }

  /** The seed is over: its process ends as a stop would end it. Nothing awaits virtual time that no longer moves. */
  end() {
    this.life.stopped = true;
    this.clock.drop(this.life);
  }
}

/** One seed: one host, one script, checked throughout. Throws a Violation that names its seed and step. */
export async function simulate(seed: number, counts: Counts, variant: Variant = {}): Promise<void> {
  const s = script(seed);
  bump(counts, s.sudo ? "start:sudo" : "start:plain");
  const sim = new Sim(seed, s, counts, variant);
  try { await sim.run(); } finally { sim.end(); }
}
