import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Prompt } from "@infinite/attention";
import type { Blackboard } from "../../packages/host/src/evidence/blackboard.js";
import type { Manager } from "../../packages/host/src/manager.js";
import { permissionAuthorityHash, permissionEvidenceHash } from "../../packages/host/src/team-permissions.js";
import type { TeamRun, TeamStatus, TeamView } from "../../packages/host/src/team-types.js";
import { TeamError } from "../../packages/host/src/team-workspace.js";
import { memberStallReason, TeamService } from "../../packages/host/src/teams.js";
import { unseal } from "../../packages/host/src/vault.js";
import { bump, type Counts, type Rand, rand } from "../outcome-sim-script.js";
import { schedulerFixture } from "./team-scheduler.js";

/*
 * A seeded crash simulator for the team run lifecycle (INF-341). Each seed builds one run in a temporary state
 * directory and scripts owner requests against a real TeamService: pause, resume, cancel, steer, revoke delegated
 * permissions, answer a decision, continue a blocked run, retries of each with the same request id, a request id reused
 * for another action, the host's own pass that ends a halt, and a clean restart. No member process runs: the
 * service is never started and the scheduler fixture answers for the worker boundary.
 *
 * Fault: the host stops right after the Nth record write of a request or pass. The simulator drops the service, opens
 * a new one from disk, and retries the cut request with the same request id.
 * What a stop models: the host process ends right after that write lands. No process is killed. From the stop on, every
 * call the old service makes into what it was given (fixture manager, Blackboard, clock, project runner) fails with
 * HostStopped, and a state file it changes after the stop is put back before the restart. Its timers run until its
 * close(), which still runs at the restart with every effect refused.
 *
 * Invariants, checked against a small pure model that changes only when the host acknowledged a request:
 * I1 An acknowledged request took effect exactly once: revision, status, halt, steering, answers, revocation,
 *    continuations, its event line, and its receipt, across any stop and retry. A request the host admitted before a
 *    stop is acknowledged on retry.
 * I2 A retry of an acknowledged request with the same request id is acknowledged, keeps its receipt, and does not write
 *    the team record.
 * I3 The record loads after every stop, and its whole projection is the model's before the cut request, after it, or
 *    the intermediate state INTERMEDIATE names for that request and write. After the host's own pass only the halt may
 *    have changed.
 * I4 Revision, member cursors and saved receipts never go back across writes, stops and restarts. Cursors start at
 *    the end of the member's journal and never advance here: only the scheduler's full pass reads reports.
 * I5 A settled run stays settled: once a cancelled record is written, every later record is cancelled at the same
 *    revision, and no new request is acknowledged.
 * I6 A refused request does not write the team record.
 * I7 A request is acknowledged only at the revision it names, and a request id belongs to one action: the same id with
 *    another action or body is refused as a request conflict.
 * Two values are observed, not modeled: each receipt's digest (I2 checks it never changes), and whether a host pass
 * ended the halt (I3 allows either).
 * I2 and I6 watch the team record only: its bytes and its captured writes. Other state files are not compared.
 */

export class Violation extends Error {}
/** What every dependency of a stopped service answers: the host process is gone. */
export class HostStopped extends Error {}

export type Kind = "pause" | "resume" | "cancel" | "steer" | "revoke" | "answer" | "continue";
const KINDS: readonly Kind[] = ["pause", "resume", "cancel", "steer", "revoke", "answer", "continue"];
type Body = { requestId: string; revision: number; text?: string };
type Request = { kind: Kind; body: Body; decisionId?: string };
/** The sealed record; only the fields the simulator reads. */
type Saved = { run: TeamRun; receipts: Record<string, string>; halt?: string };
type Fixture = ReturnType<typeof schedulerFixture>;

/** The event line each acknowledged request adds once. A resume that does not resume adds none. */
const EVENT: Record<Kind, string> = {
  pause: "Team paused.", cancel: "Team cancelled.", resume: "Team resumed with a fresh plan.", steer: "User steering recorded.",
  revoke: "Delegated permission decisions were revoked by the owner.", answer: "A user decision was recorded.",
  continue: "Owner continued the run from its clean integration commit",
};
const SETTLED: ReadonlySet<TeamStatus> = new Set(["cancelled", "merged", "no-change", "ready-for-review"]);
// A fixed clock for retention, so a run never ages out under the simulator.
const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
export const RERUN = (seed: number) => `TEAM_SIM_SEED=${seed} node --import tsx --test tests/team-run-sim.test.ts`;

// ---- Model -------------------------------------------------------------------------------------------------------

/** What the owner may rely on. It changes only when the host acknowledges a request, or when its pass ends a halt. */
type Model = {
  status: TeamStatus; revision: number; halted: boolean; steering: readonly string[]; answers: Readonly<Record<string, string>>;
  revoked: boolean; continued: number; events: Readonly<Record<Kind, number>>;
  /** Acknowledged request ids with the receipt the host saved for each. */
  acked: Readonly<Record<string, { request: Request; receipt: string }>>;
  /** A blocked run the host may replan, because its member stalled. */
  replannable: boolean;
};

/** The model after `request` takes effect once. Pure. */
function apply(m: Model, request: Request): Model {
  const next = { ...m, steering: [...m.steering], answers: { ...m.answers }, events: { ...m.events } };
  const happened = () => { next.events[request.kind] += 1; };
  switch (request.kind) {
    case "pause": next.status = "paused"; next.halted = true; happened(); break;
    case "cancel": next.status = "cancelled"; next.halted = true; happened(); break;
    case "steer": next.revision += 1; next.steering.push(request.body.text!); next.status = "planning"; next.halted = true; happened(); break;
    case "resume":
      if (m.status === "paused" || m.status === "blocked" && m.replannable) { next.revision += 1; next.status = "planning"; happened(); }
      break;
    case "revoke": next.revoked = true; happened(); break;
    case "answer": next.answers[request.decisionId!] = request.body.text!; happened(); break;
    case "continue":
      next.revision += 1; next.status = "planning"; next.halted = false; next.continued += 1;
      if (request.body.text) next.steering.push(request.body.text);
      happened(); break;
  }
  if (next.status !== "blocked") next.replannable = false;
  return next;
}

/** The model once the host acknowledged `request`: its effect, and its id among the acknowledged. */
function acknowledge(pre: Model, request: Request, receipt = ""): Model {
  return { ...apply(pre, request), acked: { ...pre.acked, [request.body.requestId]: { request, receipt } } };
}

/**
 * I3's intermediate states: what the record may hold after a stop that follows write `cut` of a request, besides the
 * state before it and the state after it, as the change relative to the state before. None holds the request's
 * receipt: a saved receipt answers the retry by replay, so the request's whole effect must be saved with it.
 */
const INTERMEDIATE: Readonly<Record<string, (pre: Model) => Partial<Model>>> = {
  // Revocation is set before the permission fence's save, so no delegated answer starts while the fence runs.
  "revoke:1": () => ({ revoked: true }),
};

type Projection = Omit<Model, "acked" | "replannable"> & { receipts: string[] };
type Allowed = readonly (readonly [string, Model])[];

function project(saved: Saved): Projection {
  const run = saved.run;
  const events = Object.fromEntries(KINDS.map(kind => [kind, run.events.filter(event => event.text.startsWith(EVENT[kind])).length])) as Record<Kind, number>;
  return { status: run.status, revision: run.revision, halted: Boolean(saved.halt), steering: run.steering.map(item => item.text),
    answers: Object.fromEntries(run.decisions.filter(item => item.answer !== undefined).map(item => [item.id, item.answer!])),
    revoked: Boolean(run.permissionsRevokedAt), continued: run.continuations?.length ?? 0, events, receipts: Object.keys(saved.receipts).sort() };
}

function expected(m: Model): Projection {
  const { acked, replannable: _replannable, ...rest } = m;
  return { ...rest, receipts: Object.keys(acked).sort() };
}

/** The name of the allowed state the record holds, or undefined. */
function match(saved: Saved, allowed: Allowed): string | undefined {
  const got = project(saved);
  return allowed.find(([, m]) => isDeepStrictEqual(expected(m), got))?.[0];
}

function difference(want: Projection, got: Projection): string {
  return (Object.keys(want) as (keyof Projection)[]).filter(key => !isDeepStrictEqual(want[key], got[key]))
    .map(key => `${key} is ${JSON.stringify(got[key])}, the model has ${JSON.stringify(want[key])}`).join("; ");
}

// ---- Script ------------------------------------------------------------------------------------------------------

type Start = "working" | "paused" | "stalled" | "waiting" | "continuable";
const STARTS: readonly Start[] = ["working", "paused", "stalled", "waiting", "continuable"];
type Step =
  | { do: "request"; kind: Kind; stale: boolean; stopAt: number; again: boolean; settle: boolean; requestId: string; text?: string; decision: "open" | "unknown" }
  | { do: "retry"; pick: number }
  | { do: "conflict"; pick: number; kind: Kind; text: string }
  | { do: "pass"; stopAt: number }
  | { do: "restart" };
/** `ids` name the starting record's decision, delegated decision, its answer request and its coordinator. */
type Script = { start: Start; delegated: boolean; ids: readonly string[]; steps: Step[] };

function weighted<T>(r: Rand, table: readonly (readonly [number, T])[]): T {
  let roll = r.next() * table.reduce((sum, [weight]) => sum + weight, 0);
  for (const [weight, item] of table) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return table[0]![1];
}

/** A version 4 UUID drawn from the seed, so request ids repeat with it. */
function uuid(r: Rand): string {
  const hex = Array.from({ length: 32 }, () => r.int(0, 15).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[r.int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const STEPS_PER_SEED = 14;
/**
 * Which write a stop follows. Most requests write twice, a continue once, an answer once or twice. A stop after a write
 * the request never makes does not fire, and the request completes.
 */
const STOPS: Record<"twice" | "once", readonly (readonly [number, number])[]> = { twice: [[45, 1], [45, 2], [10, 3]], once: [[70, 1], [25, 2], [5, 3]] };
/** Request kinds by starting state, so each start reaches the requests it admits: answers while waiting, continues while blocked. */
const KIND_WEIGHTS: Record<Start, readonly (readonly [number, Kind])[]> = {
  working: [[20, "pause"], [10, "resume"], [5, "cancel"], [20, "steer"], [10, "revoke"], [3, "answer"], [3, "continue"]],
  paused: [[10, "pause"], [25, "resume"], [5, "cancel"], [15, "steer"], [10, "revoke"], [3, "answer"], [3, "continue"]],
  stalled: [[10, "pause"], [25, "resume"], [5, "cancel"], [15, "steer"], [10, "revoke"], [3, "answer"], [5, "continue"]],
  waiting: [[10, "pause"], [8, "resume"], [4, "cancel"], [10, "steer"], [8, "revoke"], [35, "answer"], [3, "continue"]],
  continuable: [[8, "pause"], [10, "resume"], [4, "cancel"], [8, "steer"], [12, "revoke"], [3, "answer"], [35, "continue"]],
};

/** Every random draw happens here, before the host runs, so a seed names one script. */
function script(seed: number): Script {
  const r = rand(seed);
  // Starts cycle with the seed, so every run of consecutive seeds covers each one.
  const start = STARTS[seed % STARTS.length]!;
  // A live delegated decision holds a blocked run's continuation until something invalidates it, so fewer of those.
  const delegated = r.chance(start === "continuable" ? 0.3 : 0.6);
  const ids = [uuid(r), uuid(r), uuid(r), uuid(r)];
  const kinds = KIND_WEIGHTS[start];
  const steps: Step[] = [];
  for (let index = 0; index < STEPS_PER_SEED; index += 1) {
    const what = weighted(r, [[64, "request"], [8, "retry"], [6, "conflict"], [12, "pass"], [8, "restart"]] as const);
    if (what === "request") {
      const kind = weighted(r, kinds), direction = `Direction ${index}: ${r.pick(["keep the API stable", "drop the cache", "add a test"])}.`;
      const text = kind === "answer" ? r.pick(["a", "b"]) : kind === "steer" || kind === "continue" && r.chance(0.5) ? direction : undefined;
      const stale = r.chance(0.1), stopAt = r.chance(0.6) ? weighted(r, STOPS[kind === "continue" || kind === "answer" ? "once" : "twice"]) : 0;
      steps.push({ do: "request", kind, stale, stopAt, again: r.chance(0.15), settle: r.chance(0.6),
        requestId: uuid(r), ...(text ? { text } : {}), decision: r.chance(0.9) ? "open" : "unknown" });
    } else if (what === "retry") steps.push({ do: "retry", pick: r.int(0, 1000) });
    else if (what === "conflict") steps.push({ do: "conflict", pick: r.int(0, 1000), kind: weighted(r, kinds), text: `Conflict ${index}.` });
    else if (what === "pass") steps.push({ do: "pass", stopAt: r.chance(0.5) ? 1 : 0 });
    else steps.push({ do: "restart" });
  }
  return { start, delegated, ids, steps };
}

function describe(step: Step): string {
  switch (step.do) {
    case "request": return `${step.stale ? "stale " : ""}${step.kind} ${step.requestId.slice(0, 8)}${step.stopAt ? `, stop after write ${step.stopAt}` : ""}${step.again ? ", sent twice" : ""}${step.settle ? ", then a host pass" : ""}`;
    case "retry": return "retry of an acknowledged request";
    case "conflict": return `a reused request id sent as ${step.kind}`;
    case "pass": return `host pass${step.stopAt ? `, stop after write ${step.stopAt}` : ""}`;
    case "restart": return "clean restart";
  }
}

// ---- Setup -------------------------------------------------------------------------------------------------------

/** Writes the seed's starting record and returns the model of it. */
function setup(f: Fixture, s: Script): Model {
  const run = f.run, pm = run.members[0]!;
  const events = Object.fromEntries(KINDS.map(kind => [kind, 0])) as Record<Kind, number>;
  const [decisionId, permissionId, answerRequestId, coordinatorMemberId] = s.ids as [string, string, string, string];
  // The coordinator has read its journal so far, so I4 has a nonzero cursor to keep.
  f.journal.append("output", { text: "Earlier output." }); f.journal.append("output", { text: "Later output." });
  pm.cursor = f.journal.seq;
  if (s.start !== "working") pm.status = s.start === "waiting" ? "waiting" : "stopped";
  if (s.start === "paused") run.status = "paused";
  if (s.start === "stalled") { run.status = "blocked"; run.reason = memberStallReason; }
  if (s.start === "continuable") { run.status = "blocked"; run.blockCode = "repair-limit"; run.reason = "The team exhausted its correction rounds."; run.headCommit = run.baseCommit; }
  if (s.start === "waiting") {
    run.status = "needs-input";
    run.decisions = [{ id: decisionId, memberId: pm.memberId, revision: 1, question: "Which file first?", options: ["a", "b"], createdAt: run.createdAt }];
  }
  if (s.delegated) {
    const prompt: Prompt = { id: 1, kind: "permission", source: "screen", hash: "a".repeat(64), pinned: true, acceptsText: false,
      title: "Would you like to run the following command?", detail: "Environment: local\n$ npm run check",
      options: [{ index: 0, label: "Yes, proceed (y)", role: "accept" }, { index: 1, label: "No (esc)", role: "reject" }] };
    run.permissions = { mode: "coordinator", scope: "Approve one-time runs of accepted checks.", maxDecisions: 3 };
    run.permissionDecisions = [{ id: permissionId, revision: 1, targetMemberId: pm.memberId, targetSessionId: pm.sessionId, targetCwd: pm.cwd,
      policyHash: createHash("sha256").update(JSON.stringify(run.permissions)).digest("hex"), promptId: prompt.id, promptHash: prompt.hash!,
      evidenceHash: permissionEvidenceHash(prompt), prompt, option: 0, authorityHash: permissionAuthorityHash(run.permissions, []),
      expiresAt: "2099-01-01T00:00:00.000Z", answerRequestId, coordinatorMemberId, status: "approved" }];
  }
  f.writeTeam();
  return { status: run.status, revision: 1, halted: false, steering: [], answers: {}, revoked: false, continued: 0, events, acked: {},
    replannable: s.start === "stalled" };
}

// ---- Host --------------------------------------------------------------------------------------------------------

/**
 * How a stop leaves the record. "clean" is the real host: writes are atomic, so a stop leaves the last write. The
 * other two are harness mutants: "torn" leaves half of the last write, "lost" loses it.
 */
export type Variant = { patch?: (service: TeamService) => void; stop?: "clean" | "torn" | "lost" };
type Outcome<T> = { value?: T; error?: unknown; writes: Saved[]; stopped: boolean };
/** One service's life: whether its host stopped, and the call it stopped in. */
type Life = { stopped: boolean; label: string };

/** Every file under `root` with its bytes, by path relative to `root`, less the paths in `skip`. */
function files(root: string, skip: ReadonlySet<string>, at = ""): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
    const name = join(at, entry.name);
    if (skip.has(name)) continue;
    if (entry.isDirectory()) for (const [inner, bytes] of files(root, skip, name)) found.set(inner, bytes);
    else if (entry.isFile()) found.set(name, readFileSync(join(root, name)));
  }
  return found;
}

/**
 * One TeamService at a time over the fixture's state directory, with a stop armed per call. Every service gets the same
 * fixture manager: its sessions, states and journals stand for worker processes, which outlive a host restart. Its one
 * host-side part, hostLoad, keeps no state, and its counters only record calls, so a restart resets nothing there.
 * The config and key are data, not calls, and are not guarded.
 */
class Host {
  service?: TeamService;
  private writes: Saved[] = [];
  private stopAt = 0;
  private label = "open";
  private life: Life = { stopped: false, label: "open" };
  private before?: Buffer;
  private unblock?: () => void;
  private atStop?: Map<string, Buffer>;
  private readonly file: string;
  private readonly skip: ReadonlySet<string>;

  constructor(private readonly f: Fixture, private readonly variant: Variant, private readonly counts: Counts) {
    this.file = join(f.config.stateDir, "teams", `${f.run.id}.sealed`);
    this.skip = new Set([join("teams", `${f.run.id}.sealed`), join("teams", `${f.run.id}.sealed.saved`)]);
  }

  bytes(): Buffer { return readFileSync(this.file); }
  read(): Saved { return unseal<Saved>(this.f.key, `team:${this.f.run.id}`, readFileSync(this.file, "utf8")); }

  /** Wraps each method of a dependency: once `life` stopped, a call reaches nothing and fails with HostStopped. */
  private guard<T extends object>(life: Life, target: T, path = ""): T {
    return new Proxy(target, { get: (object, key) => {
      const value: unknown = Reflect.get(object, key), name = `${path}${String(key)}`;
      if (typeof value === "object" && value !== null) return this.guard(life, value, `${name}.`);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (!life.stopped) return value.apply(object, args);
        bump(this.counts, `after-stop:${life.label}:${name}`);
        const error = new HostStopped(`The host stopped before ${name}.`);
        if (value.constructor.name === "AsyncFunction") return Promise.reject(error);
        throw error;
      };
    } });
  }

  /** Opens a service over the record on disk. Its constructor's own writes are returned. */
  open(): Saved[] {
    this.writes = [];
    const life: Life = { stopped: false, label: this.label };
    this.life = life;
    let previous = this.bytes();
    // The Blackboard mirror runs right after each sealed write lands: the simulator's write counter and stop switch.
    const entries = { retryable: () => false, held: () => false, unread: () => false, mirror: () => {
      this.writes.push(this.read());
      if (this.stopAt > 0 && this.writes.length === this.stopAt) {
        life.stopped = true; life.label = this.label; this.before = previous;
        this.atStop = files(this.f.config.stateDir, this.skip);
        this.unblock = this.f.blockRecordWrites("team", this.f.run.id);
      } else previous = this.bytes();
      return true;
    } };
    const given = this.guard(life, { now: () => T0, start: (_project: string, start: () => unknown) => start() });
    const service = new TeamService(this.f.config, this.f.key, this.guard(life, this.f.manager) as unknown as Manager, given.start as never,
      undefined, undefined, { entries: this.guard(life, entries) as unknown as Blackboard, now: given.now });
    this.variant.patch?.(service);
    this.service = service;
    return this.writes;
  }

  /** Runs one host call; with `stopAt`, the host stops right after that write of the call and its answer is lost. */
  async call<T>(work: (service: TeamService) => Promise<T>, label: string, stopAt = 0): Promise<Outcome<T>> {
    const life = this.life;
    this.writes = []; this.stopAt = stopAt; this.label = label;
    let value: T | undefined, error: unknown;
    try { value = await work(this.service!); } catch (caught) { error = caught; }
    this.stopAt = 0;
    return { value, error, writes: this.writes, stopped: life.stopped };
  }

  /** Puts back every state file other than the record that changed after the stop, and counts each by its generic name. */
  private restoreFiles() {
    const root = this.f.config.stateDir, then = this.atStop!, now = files(root, this.skip);
    for (const [name, bytes] of then) if (!now.get(name)?.equals(bytes)) {
      bump(this.counts, `after-stop:file:${name.replace(UUID, "<id>")}`);
      mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), bytes);
    }
    for (const name of now.keys()) if (!then.has(name)) { bump(this.counts, `after-stop:file:${name.replace(UUID, "<id>")}`); rmSync(join(root, name)); }
  }

  /** Drops the service and opens a new one from disk; after a stop the state files and the record come back first. */
  async restart(): Promise<Saved[]> {
    const life = this.life;
    await this.service!.close().catch(error => { if (!(error instanceof HostStopped)) throw error; });
    if (life.stopped) {
      this.restoreFiles();
      this.unblock!(); this.unblock = undefined;
      if (this.variant.stop === "torn") writeFileSync(this.file, this.bytes().subarray(0, this.bytes().length >> 1));
      if (this.variant.stop === "lost") writeFileSync(this.file, this.before!);
    }
    return this.open();
  }

  close() { return this.service?.close(); }
}

type Internal = { step(stored: unknown): Promise<void>; record(id: string): unknown };

function send(service: TeamService, id: string, request: Request): Promise<TeamView> {
  const { requestId, revision, text } = request.body, action = { requestId, revision };
  switch (request.kind) {
    case "pause": return service.pause(id, action);
    case "resume": return service.resume(id, action);
    case "cancel": return service.cancel(id, action);
    case "revoke": return service.revokePermissions(id, action);
    case "steer": return service.steer(id, { ...action, text: text! });
    case "answer": return service.answer(id, request.decisionId!, { ...action, text: text! });
    case "continue": return service.continueRun(id, { ...action, ...(text ? { text } : {}) });
  }
}

const code = (error: unknown) => error instanceof TeamError ? error.code : error instanceof Error ? `${error.name}: ${error.message}` : String(error);

// ---- Simulation --------------------------------------------------------------------------------------------------

class Sim {
  private model!: Model;
  private where = "setup";
  private readonly durable = { revision: 0, cursors: new Map<string, number>(), receipts: new Set<string>(), settled: undefined as { status: TeamStatus; revision: number } | undefined };

  constructor(private readonly seed: number, private readonly f: Fixture, private readonly host: Host, private readonly counts: Counts, private readonly variant: Variant) {}

  private fail(invariant: string, message: string): never {
    throw new Violation(`seed ${this.seed} ${this.where}: ${invariant}: ${message}; rerun: ${RERUN(this.seed)}`);
  }

  async run(s: Script) {
    this.model = setup(this.f, s);
    this.durableCheck(this.host.read(), "the starting record");
    this.durableChecks(this.host.open(), "the first open");
    this.effect(this.host.read(), "I3");
    for (const [index, step] of s.steps.entries()) {
      this.where = `step ${index + 1} (${describe(step)})`;
      if (step.do === "request") await this.request(step);
      else if (step.do === "retry") await this.retryAcked(step.pick);
      else if (step.do === "conflict") await this.conflict(step);
      else if (step.do === "pass") await this.pass(step.stopAt);
      else await this.restart();
    }
  }

  /** I4 and I5 over one durable record: a write, or a record a service opened. */
  private durableCheck(saved: Saved, what: string) {
    const run = saved.run, d = this.durable;
    if (run.revision < d.revision) this.fail("I4", `${what} is at revision ${run.revision}, behind the written revision ${d.revision}`);
    for (const member of run.members) {
      if (member.cursor < (d.cursors.get(member.memberId) ?? 0)) this.fail("I4", `${what} moved member ${member.memberId} back to cursor ${member.cursor}`);
      d.cursors.set(member.memberId, member.cursor);
    }
    for (const id of d.receipts) if (!saved.receipts[id]) this.fail("I4", `${what} lost the saved receipt of ${id}`);
    if (d.settled && (run.status !== d.settled.status || run.revision !== d.settled.revision))
      this.fail("I5", `${what} is ${run.status} at revision ${run.revision} after ${d.settled.status} was written at revision ${d.settled.revision}`);
    d.revision = run.revision;
    for (const id of Object.keys(saved.receipts)) d.receipts.add(id);
    if (SETTLED.has(run.status)) d.settled ??= { status: run.status, revision: run.revision };
  }

  private durableChecks(writes: readonly Saved[], what: string) {
    writes.forEach((saved, index) => this.durableCheck(saved, `${what}'s write ${index + 1}`));
  }

  /** The record holds exactly the model's state; `invariant` names the check that expects it. */
  private effect(saved: Saved, invariant: string, request?: Request) {
    const want = expected(this.model), got = project(saved);
    if (!isDeepStrictEqual(want, got)) this.fail(invariant, `${request ? `after the acknowledged ${request.kind}, ` : ""}${difference(want, got)}`);
  }

  /** I3: the record holds none of the allowed states. */
  private unexpected(saved: Saved, allowed: Allowed, what: string): never {
    const got = project(saved);
    this.fail("I3", `${what} is none of the states the model allows; ${allowed.map(([name, m]) => `against ${name}: ${difference(expected(m), got)}`).join("; ")}`);
  }

  private build(step: Extract<Step, { do: "request" }>): Request {
    const revision = step.stale ? (this.model.revision > 1 ? this.model.revision - 1 : this.model.revision + 1) : this.model.revision;
    const open = this.f.run.decisions[0]?.id;
    return { kind: step.kind, body: { requestId: step.requestId, revision, ...(step.text ? { text: step.text } : {}) },
      ...(step.kind === "answer" ? { decisionId: step.decision === "open" && open ? open : step.requestId } : {}) };
  }

  private async request(step: Extract<Step, { do: "request" }>) {
    const request = this.build(step), pre = this.model, before = this.host.bytes();
    const result = await this.host.call(service => send(service, this.f.run.id, request), request.kind, step.stopAt);
    this.durableChecks(result.writes, `the ${request.kind}`);
    if (result.stopped) {
      // A refused request does not write the record (I6), so a request that wrote before the stop was admitted.
      if (request.body.revision !== pre.revision) this.fail("I7", `a ${request.kind} issued against revision ${request.body.revision} wrote the record at revision ${pre.revision} before the stop`);
      if (SETTLED.has(pre.status)) this.fail("I5", `a new ${request.kind} wrote the ${pre.status} record before the stop`);
      bump(this.counts, `cut:${request.kind}:${step.stopAt}`);
      const post = acknowledge(pre, request), name = `intermediate:${request.kind}:${step.stopAt}`, change = INTERMEDIATE[`${request.kind}:${step.stopAt}`];
      const allowed: Allowed = [["the state before it", pre], ["the state after it", post], ...(change ? [[name, { ...pre, ...change(pre) }] as const] : [])];
      // I3 before the retry: once retried, a repaired record would hide what the stop left.
      const saved = await this.reopen(), held = match(saved, allowed);
      if (held === name) bump(this.counts, name);
      if (held === undefined) this.unexpected(saved, allowed, "the reopened record");
      const retry = await this.host.call(service => send(service, this.f.run.id, request), request.kind);
      this.durableChecks(retry.writes, `the retried ${request.kind}`);
      if (retry.error !== undefined) this.fail("I1", `the host admitted the ${request.kind} before the stop, and refused its retry (${code(retry.error)})`);
      this.acknowledged(request, pre, retry.value!, true);
    } else if (result.error !== undefined) {
      this.refused(request, before, result);
      return;
    } else this.acknowledged(request, pre, result.value!, false);
    if (step.again) await this.retry(request);
    // The host's next pass, which ends a halt the request set, so a later resume is not refused while members stop.
    if (step.settle && this.model.halted) await this.pass(0);
  }

  private refused(request: Request, before: Buffer, result: Outcome<TeamView>) {
    if (!(result.error instanceof TeamError)) throw result.error;
    if (result.writes.length > 0 || !before.equals(this.host.bytes())) this.fail("I6", `the refused ${request.kind} (${result.error.code}) wrote the record`);
    bump(this.counts, `refused:${result.error.code}`);
  }

  private acknowledged(request: Request, pre: Model, view: TeamView, cut: boolean) {
    if (SETTLED.has(pre.status)) this.fail("I5", `a new ${request.kind} was acknowledged on a ${pre.status} run`);
    if (request.body.revision !== pre.revision) this.fail("I7", `a ${request.kind} issued against revision ${request.body.revision} was acknowledged at revision ${pre.revision}`);
    const saved = this.host.read(), post = acknowledge(pre, request, saved.receipts[request.body.requestId] ?? "");
    this.model = post;
    this.effect(saved, "I1", request);
    if (view.status !== saved.run.status || view.revision !== saved.run.revision)
      this.fail("I1", `the acknowledgement shows ${view.status} at revision ${view.revision}; the record holds ${saved.run.status} at ${saved.run.revision}`);
    bump(this.counts, `ack:${request.kind}`);
    if (cut) bump(this.counts, `ack:${request.kind}:after-stop`);
  }

  /** I2: the same request again, after it was acknowledged. */
  private async retry(request: Request) {
    const receipt = this.model.acked[request.body.requestId]!.receipt, before = this.host.bytes();
    const result = await this.host.call(service => send(service, this.f.run.id, request), request.kind);
    if (result.error !== undefined) this.fail("I2", `a retry of the acknowledged ${request.kind} was refused (${code(result.error)})`);
    if (result.writes.length > 0 || !before.equals(this.host.bytes())) this.fail("I2", `a retry of the acknowledged ${request.kind} wrote the record`);
    if (this.host.read().receipts[request.body.requestId] !== receipt) this.fail("I2", `a retry of the acknowledged ${request.kind} changed its receipt`);
    this.effect(this.host.read(), "I2");
    bump(this.counts, `retry:${request.kind}`);
  }

  private async retryAcked(pick: number) {
    const acked = Object.values(this.model.acked);
    if (acked.length === 0) return bump(this.counts, "retry:none");
    await this.retry(acked[pick % acked.length]!.request);
  }

  /** I7: an acknowledged request id sent with another action or body. */
  private async conflict(step: Extract<Step, { do: "conflict" }>) {
    const acked = Object.values(this.model.acked);
    if (acked.length === 0) return bump(this.counts, "conflict:none");
    const prior = acked[step.pick % acked.length]!.request;
    const body = { requestId: prior.body.requestId, revision: this.model.revision, ...(step.kind === "steer" || step.kind === "answer" ? { text: step.text } : {}) };
    const request: Request = { kind: step.kind, body, ...(step.kind === "answer" ? { decisionId: this.f.run.decisions[0]?.id ?? prior.body.requestId } : {}) };
    // The same kind at the same revision is the same request unless its text differs; steer and answer carry new text.
    if (request.kind === prior.kind && request.body.revision === prior.body.revision && request.kind !== "steer" && request.kind !== "answer") request.body.revision += 1;
    const before = this.host.bytes();
    const result = await this.host.call(service => send(service, this.f.run.id, request), request.kind);
    if (result.error === undefined) this.fail("I7", `request id ${prior.body.requestId}, acknowledged as a ${prior.kind}, was acknowledged again as a different ${request.kind}`);
    if (code(result.error) !== "request-conflict") this.fail("I7", `request id ${prior.body.requestId} reused as a different ${request.kind} was refused as ${code(result.error)}, not as a request conflict`);
    this.refused(request, before, result);
  }

  /** The host's own pass, which ends a halt once members stopped. It is not a request; the model takes the halt from the record. */
  private async pass(stopAt: number) {
    if (!this.model.halted) return bump(this.counts, "pass:idle");
    const pre = this.model, allowed: Allowed = [["the state before it", pre], ["the state with its halt ended", { ...pre, halted: false }]];
    const step = (service: TeamService) => {
      const internal = service as unknown as Internal;
      return internal.step(internal.record(this.f.run.id));
    };
    const result = await this.host.call(step, "pass", stopAt);
    this.durableChecks(result.writes, "the pass");
    if (result.stopped) {
      bump(this.counts, "cut:pass");
      const reopened = await this.reopen();
      if (match(reopened, allowed) === undefined) this.unexpected(reopened, allowed, "the reopened record");
      // The next pass runs only while the halt holds: past it, a pass would plan and launch members.
      if (reopened.halt) {
        const again = await this.host.call(step, "pass");
        this.durableChecks(again.writes, "the pass after the stop");
        if (again.error !== undefined) throw again.error;
      }
    } else if (result.error !== undefined) throw result.error;
    const saved = this.host.read();
    if (match(saved, allowed) === undefined) this.unexpected(saved, allowed, "the record after the pass");
    this.model = { ...pre, halted: Boolean(saved.halt) };
    bump(this.counts, saved.halt ? "pass:still-halted" : "pass:ended-halt");
  }

  private async restart() {
    const saved = await this.reopen(), allowed: Allowed = [["the model", this.model]];
    if (match(saved, allowed) === undefined) this.unexpected(saved, allowed, "the record after a clean restart");
    bump(this.counts, "restart");
  }

  /** I3's load, I4 and I5 after the host stopped: a new service opens over the record. Returns the record it holds. */
  private async reopen(): Promise<Saved> {
    let writes: Saved[];
    try { writes = await this.host.restart(); } catch (error) { this.fail("I3", `the record does not load after the stop (${code(error)})`); }
    this.durableChecks(writes, "the reopened service");
    let saved: Saved;
    try { saved = this.host.read(); } catch (error) { this.fail("I3", `the record does not load after the stop (${code(error)})`); }
    this.durableCheck(saved, "the reopened record");
    return saved;
  }
}

/** One seed: one run, one script, checked after every step. Throws a Violation that names its seed and step. */
export async function simulate(seed: number, counts: Counts, variant: Variant = {}): Promise<void> {
  const s = script(seed);
  bump(counts, `start:${s.start}${s.delegated ? ":delegated" : ""}`);
  let f: Fixture | undefined, host: Host | undefined;
  try {
    f = schedulerFixture(); host = new Host(f, variant, counts);
    await new Sim(seed, f, host, counts, variant).run(s);
  } finally {
    await host?.close()?.catch(() => undefined);
    f?.close();
  }
}
