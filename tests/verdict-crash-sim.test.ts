import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { goalRecordPort, type GoalHolder } from "../packages/host/src/objective-goals.js";
import { writeHeldRecord } from "../packages/host/src/objective-holder.js";
import { readStoredRecord, VERDICT_OPS } from "../packages/host/src/objective-record.js";
import { recordDigest, type ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { TeamVerdicts, type VerdictHolder, type VerdictHost, type VerdictState } from "../packages/host/src/team-verdicts.js";
import type { TeamCommand, TeamMember, TeamReport, TeamRun } from "../packages/host/src/team-types.js";
import type { Provider } from "../packages/host/src/types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { verdictRecord, type ComposedVerdict } from "../packages/host/src/verdict-compose.js";
import { registerVerdicts, type VerdictEventData } from "../packages/host/src/verdict-store.js";
import {
  AT, BASE, GOAL, PARENT, RANK, RUN, finishPass, holderOf, memberOf, newWorld, receiptOf, recordOf, reportOf, runOf, uuidOf,
  type World,
} from "./fixtures/verdict-runtime.js";

type CrashPoint = "none" | "before-intent" | "before-record-write" | "after-record-write" | "after-final-save";
type Mutant =
  | "write-before-intent"
  | "skip-handle-dedup"
  | "drop-recording-intent"
  | "stale-ledger-version"
  | "skip-settled-assessment"
  | "drift-recovery-timestamp";
type PendingOp = { kind: "result"; memberId: string; revision: number };
type DiskTeam = VerdictHolder & { outbox: OutboxEvent[]; pendingOp?: PendingOp };
type DiskGoal = GoalHolder & { goal: { id: string } };

const DEFAULT_SEEDS = 12;
const ONLY = process.env.VERDICT_SIM_SEED;
const COUNT = Number(process.env.VERDICT_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.VERDICT_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "VERDICT_SIM_SEED, VERDICT_SIM_SEEDS, and VERDICT_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const STATES = ["met", "not-met", "inconclusive"] as const;
const POST_INTENT_CRASHES: readonly CrashPoint[] = ["before-record-write", "after-record-write", "after-final-save"];
const FENCED_REASON = "The host restarted during an unresolved evaluator result operation; it will not be replayed.";

class SimViolation extends Error {
  constructor(readonly invariant: string, readonly seed: number, readonly step: number, detail: string) {
    super(`seed ${seed}, step ${step}: ${invariant}: ${detail}; rerun with VERDICT_SIM_SEED=${seed}`);
  }
}

class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) { super(`simulated crash at ${point}`); }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function headFor(revision: number): string {
  return String(revision % 10 === 0 ? 9 : revision % 10).repeat(40);
}

function addPm(run: TeamRun): TeamMember {
  const pm = memberOf(run, "project-manager", { status: "reported", report: { kind: "no-change", summary: "Nothing to change.", evidence: [] } as never });
  run.members.push(pm);
  return pm;
}

function goalObjectiveRecord(): ObjectiveRecord {
  const baseRecord = recordOf(RUN, 1);
  const criteria = baseRecord.criteria.map(item => {
    if (item.id !== "c0") return item;
    const { statementOf: _statementOf, ...rest } = item as typeof item & { statementOf?: unknown };
    return { ...rest, statement: "Rank founders with verified criteria" };
  });
  const { digest: _digest, ...rest } = baseRecord;
  const body = { ...rest, owner: { kind: "goal" as const, goalId: GOAL }, criteria };
  const record = { ...body, digest: recordDigest(body) } as ObjectiveRecord;
  assert.equal(readStoredRecord(record, { kind: "goal", goalId: GOAL }).kind, "ready");
  return record;
}

class DiskHarness {
  readonly root: string;
  readonly key: Buffer;
  readonly teamPath: string;
  readonly goalPath: string;
  readonly world: World;
  readonly kind: "goal" | "nochange";
  readonly parent?: DiskTeam;
  store!: EvidenceStore;
  outbox!: EventOutbox;
  team!: DiskTeam;
  goal!: DiskGoal;
  verdicts!: TeamVerdicts;
  pending: { complete: (clean: boolean | undefined) => void; member: TeamMember }[] = [];
  armedCrash: CrashPoint = "none";
  saveNumber = 0;
  readonly mutant?: Mutant;

  constructor(kind: "goal" | "nochange", mutant?: Mutant) {
    this.kind = kind;
    this.mutant = mutant;
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-verdict-sim-")));
    mkdirSync(join(this.root, "teams"), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "goals"), { recursive: true, mode: 0o700 });
    this.key = randomBytes(32);
    this.teamPath = join(this.root, "teams", `${RUN}.sealed`);
    this.goalPath = join(this.root, "goals", `${GOAL}.sealed`);
    this.world = newWorld();

    const run = runOf({ goal: { id: GOAL, revision: 1, cycle: 2, parentRunId: PARENT } as never });
    if (kind === "nochange") {
      run.status = "planning";
      run.tasks.length = 0;
      run.headCommit = BASE;
      addPm(run);
      this.parent = { ...holderOf(runOf({ id: PARENT })), outbox: [] };
      this.world.passes.set(PARENT, { head: BASE, pending: false, receipts: [receiptOf("c1", "pass", PARENT, BASE)] });
    }
    const goalOwned = goalObjectiveRecord();
    const initialTeam: DiskTeam = { ...holderOf(run), outbox: [] };
    writeSealed(this.teamPath, this.key, `team:${RUN}`, initialTeam);
    writeSealed(this.goalPath, this.key, `goal:${GOAL}`, { goal: { id: GOAL }, objectiveRecord: goalOwned });
    this.openFromDisk();
  }

  openFromDisk(): void {
    this.pending = [];
    this.store = new EvidenceStore({ databasePath: evidenceDatabasePath(this.root), vaultKey: this.key });
    this.outbox = new EventOutbox(this.store);
    registerVerdicts(this.store, this.outbox);
    this.team = unseal<DiskTeam>(this.key, `team:${RUN}`, readFileSync(this.teamPath, "utf8"));
    this.goal = unseal<DiskGoal>(this.key, `goal:${GOAL}`, readFileSync(this.goalPath, "utf8"));

    if (this.team.outbox.length > 0) this.flushOutbox();

    const host: VerdictHost = {
      holder: id => (id === RUN ? this.team : id === PARENT ? this.parent : undefined),
      prepare: (holder, onPrepared, prebuilt) => {
        const member = memberOf(holder.run, "evaluator", { modelProfile: prebuilt.profile });
        holder.run.members.push(member);
        onPrepared(member);
      },
      consume: (holder, member) => {
        if (member.role === "evaluator") this.verdicts.consume(holder, member);
        else this.verdicts.holdNoChange(holder, member);
      },
      operation: (holder, _perform, complete, member) => {
        const disk = holder as DiskTeam;
        disk.pendingOp = { kind: "result", memberId: member.memberId, revision: disk.run.revision };
        writeSealed(this.teamPath, this.key, `team:${RUN}`, disk);
        this.pending.push({
          member,
          complete: clean => {
            delete disk.pendingOp;
            complete(clean);
          },
        });
      },
      save: holder => {
        this.saveNumber += 1;
        if (this.armedCrash === "before-intent" && this.saveNumber === 1) throw new SimulatedCrash("before-intent");
        if (this.armedCrash === "before-record-write" && this.saveNumber === 2) throw new SimulatedCrash("before-record-write");
        if (this.armedCrash === "after-record-write" && this.saveNumber === 2) throw new SimulatedCrash("after-record-write");
        writeSealed(this.teamPath, this.key, `team:${RUN}`, holder);
        if (this.armedCrash === "after-final-save" && this.saveNumber === 2) throw new SimulatedCrash("after-final-save");
        this.flushOutbox();
      },
      event: (holder, text) => { holder.run.events.push({ at: AT, text }); },
      emit: (holder, data: VerdictEventData) => {
        const disk = holder as DiskTeam;
        const key = `verdict.recorded:${disk.run.id}:${data.verdictId}`;
        if (disk.outbox.some(item => item.key === key)) return;
        disk.outbox.push({
          key,
          runId: disk.run.id,
          revision: disk.verdict?.revision ?? disk.run.revision,
          at: AT,
          kind: "verdict.recorded",
          data: { v: 1, ...data },
        });
      },
      configured: (): readonly TeamCommand[] => [RANK],
      limited: (): Set<Provider> => new Set(),
      prefix: (): TeamCommand | undefined => undefined,
      register: {
        markReviewed: holder => {
          const head = holder.run.headCommit!;
          const current = this.world.passes.get(holder.run.id);
          this.world.marks += 1;
          if (current?.head !== head) this.world.passes.set(holder.run.id, { head, pending: true });
          return true;
        },
        reviewedReceipts: (runId, head) => {
          const pass = this.world.passes.get(runId);
          if (pass === undefined || pass.head !== head) return undefined;
          return pass.pending ? "pending" : (pass.receipts ?? []);
        },
      },
      now: () => AT,
      uuid: () => { this.world.uuids += 1; return uuidOf(this.world.uuids); },
    };

    const verdicts = new TeamVerdicts(host);
    const port = goalRecordPort(
      id => (id === GOAL ? this.goal : undefined),
      holder => {
        if (this.armedCrash === "before-record-write") throw new SimulatedCrash("before-record-write");
        writeSealed(this.goalPath, this.key, `goal:${GOAL}`, holder);
      },
    );
    verdicts.goals = port;
    this.applyMutant(verdicts, host);
    this.verdicts = verdicts;
    this.verdicts.recover(this.team);
    if (this.team.pendingOp) {
      this.team.run.status = "blocked";
      this.team.run.reason = FENCED_REASON;
      writeSealed(this.teamPath, this.key, `team:${RUN}`, this.team);
    }
  }

  private applyMutant(verdicts: TeamVerdicts, host: VerdictHost): void {
    if (!this.mutant) return;
    const internal = verdicts as unknown as {
      finish: (holder: VerdictHolder, state: VerdictState, report?: unknown, reason?: unknown) => void;
      writeRecord: (holder: VerdictHolder, state: VerdictState, record: ObjectiveRecord, composed: ComposedVerdict, at: string) => { written: "wrote" | "log-full" | "write-failed"; version: number };
      recover: (holder: VerdictHolder) => boolean;
    };
    if (this.mutant === "write-before-intent") {
      const originalSave = host.save.bind(host);
      let suppressIntentSave = false;
      const originalFinish = internal.finish.bind(verdicts);
      internal.finish = (holder, state, report, reason) => {
        suppressIntentSave = true;
        try { originalFinish(holder, state, report, reason); }
        finally { suppressIntentSave = false; }
      };
      host.save = holder => {
        if (suppressIntentSave && holder.verdict?.status === "recording") {
          this.saveNumber += 1;
          return;
        }
        originalSave(holder);
      };
    } else if (this.mutant === "skip-handle-dedup") {
      internal.writeRecord = (holder, state, record, composed, at) => {
        try {
          const next = verdictRecord(record, composed, { verdictId: state.verdictId, kind: state.kind, revision: state.revision, head: state.head, at });
          if (next === "log-full") return { written: "log-full", version: record.version };
          writeHeldRecord(holder, verdicts.goals, record, next);
          return { written: "wrote", version: next.version };
        } catch {
          return { written: "write-failed", version: record.version };
        }
      };
    } else if (this.mutant === "drop-recording-intent") {
      internal.recover = holder => {
        if (holder.verdict?.status !== "recording") return false;
        delete holder.verdict;
        host.save(holder);
        return true;
      };
    } else if (this.mutant === "stale-ledger-version") {
      const originalEmit = host.emit.bind(host);
      host.emit = (holder, data) => {
        originalEmit(holder, { ...data, recordVersion: Math.max(1, data.recordVersion - 1) });
      };
    } else if (this.mutant === "skip-settled-assessment") {
      const originalSave = host.save.bind(host);
      host.save = holder => {
        if (holder.verdict?.status === "done") delete holder.run.assessment;
        originalSave(holder);
      };
    } else if (this.mutant === "drift-recovery-timestamp") {
      const originalRecover = internal.recover.bind(verdicts);
      internal.recover = holder => {
        if (holder.verdict?.status === "recording" && holder.verdict.commit) {
          holder.verdict.commit = { ...holder.verdict.commit, at: "2026-11-22T00:00:00.000Z" };
        }
        return originalRecover(holder);
      };
    }
  }

  private flushOutbox(): void {
    if (this.team.outbox.length === 0) return;
    const result = this.outbox.flush(this.team.outbox);
    if (result.stored) {
      this.team.outbox = [];
      writeSealed(this.teamPath, this.key, `team:${RUN}`, this.team);
    }
  }

  restart(): void {
    this.store.close();
    this.openFromDisk();
  }

  close(): void {
    try { this.store.close(); } catch {}
    rmSync(this.root, { recursive: true, force: true });
  }

  goalRecordOnDisk(): ObjectiveRecord {
    return unseal<DiskGoal>(this.key, `goal:${GOAL}`, readFileSync(this.goalPath, "utf8")).objectiveRecord as ObjectiveRecord;
  }

  teamOnDisk(): DiskTeam {
    return unseal<DiskTeam>(this.key, `team:${RUN}`, readFileSync(this.teamPath, "utf8"));
  }

  ledgerRows(): { verdict_id: string; record_version: number; result: string; revision: number }[] {
    return this.store.read(db => db.all<{ verdict_id: string; record_version: number; result: string; revision: number }>(
      "SELECT verdict_id, record_version, result, revision FROM objective_verdicts ORDER BY record_version, verdict_id",
    ));
  }
}

function currentEvaluator(h: DiskHarness): TeamMember | undefined {
  const id = h.team.verdict?.evaluatorMemberId;
  return id === undefined ? undefined : h.team.run.members.find(member => member.memberId === id);
}

function contextStep(h: DiskHarness): void {
  const member = currentEvaluator(h);
  if (h.team.verdict?.status === "evaluating" && h.team.verdict.judged === undefined && member) h.verdicts.context(h.team, member);
}

function settleAll(h: DiskHarness, clean: boolean): void {
  for (const op of h.pending.splice(0)) op.complete(clean);
}

function holdRun(h: DiskHarness): void {
  if (h.kind === "goal") h.verdicts.reviewed(h.team);
  else h.verdicts.holdNoChange(h.team, h.team.run.members.filter(member => member.role === "project-manager").at(-1)!);
}

function reportEval(h: DiskHarness, a: number): void {
  const member = currentEvaluator(h);
  if (!member || h.team.verdict?.status !== "evaluating" || member.report !== undefined) return;
  const full: TeamReport = a < 0.12
    ? { kind: "review", verdict: "approved", summary: "Wrong kind." } as unknown as TeamReport
    : reportOf({ c0: STATES[Math.floor(a * 3) % 3]!, c1: STATES[Math.floor((a * 9) % 3)]! });
  member.status = "reported";
  member.report = h.verdicts.screen(h.team, member, full);
  writeSealed(h.teamPath, h.key, `team:${RUN}`, h.team);
  h.verdicts.consume(h.team, member);
}

function bumpRevision(h: DiskHarness): void {
  const run = h.team.run;
  run.revision += 1;
  run.headCommit = h.kind === "nochange" ? BASE : headFor(run.revision);
  h.team.checkHead = run.headCommit;
  run.review = { verdict: "approved", summary: "ok", revision: run.revision } as never;
  if (h.kind === "nochange") addPm(run);
  writeSealed(h.teamPath, h.key, `team:${RUN}`, h.team);
}

function checkStepInvariants(h: DiskHarness, seed: number, step: number, settled: boolean): void {
  const record = h.goalRecordOnDisk();
  const team = h.teamOnDisk();
  const rows = h.ledgerRows();
  const entries = record.log.filter(entry => entry.op === VERDICT_OPS.recorded);
  const handles = entries.map(entry => entry.handle);
  if (new Set(handles).size !== handles.length) {
    throw new SimViolation("I1", seed, step, `duplicate verdict.recorded handles in goal record: ${JSON.stringify(handles)}`);
  }
  if (record.version !== 1 + entries.length) {
    throw new SimViolation("I1", seed, step, `record.version=${record.version} does not equal 1 + ${entries.length}`);
  }
  const rowIds = rows.map(row => row.verdict_id);
  if (new Set(rowIds).size !== rowIds.length) {
    throw new SimViolation("I2", seed, step, `duplicate ledger verdict_id rows: ${JSON.stringify(rowIds)}`);
  }
  for (const row of rows) {
    const entry = entries.find(item => item.handle === `verdict:${row.verdict_id}`);
    if (!entry || entry.version !== row.record_version) {
      throw new SimViolation("I2", seed, step, `ledger row ${row.verdict_id} v${row.record_version} does not match goal record`);
    }
  }
  const inFlightCommit = team.verdict?.status === "recording";
  if (!inFlightCommit && team.outbox.length === 0) {
    for (const entry of entries) {
      const id = entry.handle?.slice("verdict:".length);
      if (!rows.some(row => row.verdict_id === id)) {
        throw new SimViolation("I3", seed, step, `goal record entry ${entry.handle} has no matching SQLite ledger row`);
      }
    }
    const recordedEvents = team.run.events.filter(event => event.text.startsWith("Agent assessment, provisional")).length;
    if (recordedEvents !== entries.length) {
      throw new SimViolation("I3", seed, step, `recorded events (${recordedEvents}) != goal verdict entries (${entries.length})`);
    }
  }
  if (settled) {
    if (team.verdict?.status !== "done" || team.verdict.commit !== undefined) {
      throw new SimViolation("I4", seed, step, `settled team verdict state is ${team.verdict?.status ?? "missing"} (commit=${Boolean(team.verdict?.commit)})`);
    }
    if (team.run.assessment?.verdictId !== team.verdict.verdictId || team.run.assessment?.revision !== team.run.revision) {
      throw new SimViolation("I4", seed, step, "settled run assessment does not match current revision and verdictId");
    }
    if (rows.length !== entries.length) {
      throw new SimViolation("I3", seed, step, `settled ledger rows (${rows.length}) != goal verdict entries (${entries.length})`);
    }
  }
}

function digestState(h: DiskHarness): Record<string, string> {
  return {
    record: canonicalJson(h.goalRecordOnDisk()),
    assessment: canonicalJson(h.teamOnDisk().run.assessment ?? null),
    ledger: canonicalJson(h.ledgerRows()),
    events: canonicalJson(h.teamOnDisk().run.events),
  };
}

type CycleScript = {
  passReceipts: boolean;
  failFirst: boolean;
  reportRoll: number;
  clean: boolean;
  crashPoint: CrashPoint;
  restartMidway: boolean;
};

function scriptOf(seed: number): CycleScript[] {
  const random = mulberry32(seed);
  const cycles = 2 + Math.floor(random() * 2);
  return Array.from({ length: cycles }, (_, index) => ({
    passReceipts: random() < 0.7,
    failFirst: random() < 0.25,
    reportRoll: 0.15 + random() * 0.85,
    clean: random() < 0.9,
    crashPoint: POST_INTENT_CRASHES[(seed + index) % POST_INTENT_CRASHES.length]!,
    restartMidway: random() < 0.5,
  }));
}

function runSeed(
  seed: number,
  withCrashes: boolean,
  counts: Record<string, number>,
  mutant?: Mutant,
): Record<string, string> {
  const kind = seed % 2 === 0 ? "nochange" : "goal";
  const h = new DiskHarness(kind, mutant);
  const cycles = scriptOf(seed);
  let step = 0;
  try {
    for (let index = 0; index < cycles.length; index += 1) {
      const cycle = cycles[index]!;
      if (index > 0) {
        bumpRevision(h);
        checkStepInvariants(h, seed, ++step, false);
      }
      holdRun(h);
      for (const [runId, pass] of h.world.passes) {
        if (pass.pending) finishPass(h.world, runId, [receiptOf("c1", cycle.passReceipts ? "pass" : "fail", runId, pass.head)]);
      }
      h.verdicts.step(h.team);
      h.verdicts.step(h.team);
      contextStep(h);
      checkStepInvariants(h, seed, ++step, false);

      if (cycle.restartMidway && withCrashes) {
        counts.restart = (counts.restart ?? 0) + 1;
        h.restart();
        contextStep(h);
        checkStepInvariants(h, seed, ++step, false);
      }

      if (cycle.failFirst) {
        const failed = currentEvaluator(h);
        if (failed) {
          failed.status = "stopped";
          h.verdicts.failed(h.team, failed);
          writeSealed(h.teamPath, h.key, `team:${RUN}`, h.team);
          h.verdicts.step(h.team);
          contextStep(h);
          checkStepInvariants(h, seed, ++step, false);
        }
      }

      reportEval(h, cycle.reportRoll);
      checkStepInvariants(h, seed, ++step, false);

      if (!cycle.clean && !cycle.failFirst && h.pending.length > 0) {
        settleAll(h, false);
        checkStepInvariants(h, seed, ++step, false);
        h.verdicts.step(h.team);
        contextStep(h);
        reportEval(h, cycle.reportRoll);
        checkStepInvariants(h, seed, ++step, false);
      }

      if (withCrashes && h.pending.length > 0) {
        h.armedCrash = cycle.crashPoint;
        h.saveNumber = 0;
        let crashed: CrashPoint | undefined;
        try {
          settleAll(h, true);
        } catch (error) {
          if (error instanceof SimulatedCrash) crashed = error.point;
          else throw error;
        } finally {
          h.armedCrash = "none";
        }
        if (crashed) {
          counts[`crash:${crashed}`] = (counts[`crash:${crashed}`] ?? 0) + 1;
          h.restart();
          checkStepInvariants(h, seed, ++step, false);
          settleAll(h, true);
        }
      } else {
        settleAll(h, true);
      }
      checkStepInvariants(h, seed, ++step, false);

      for (let guard = 0; guard < 12; guard += 1) {
        if (h.team.verdict?.status === "done" && h.team.verdict.revision === h.team.run.revision) break;
        holdRun(h);
        h.verdicts.step(h.team);
        contextStep(h);
        reportEval(h, cycle.reportRoll);
        settleAll(h, true);
      }
      checkStepInvariants(h, seed, ++step, true);
    }
    return digestState(h);
  } finally {
    h.close();
  }
}

function runBeforeIntentFence(seed: number, counts: Record<string, number>, mutant?: Mutant): void {
  const kind = seed % 2 === 0 ? "nochange" : "goal";
  const h = new DiskHarness(kind, mutant);
  const cycle = scriptOf(seed)[0]!;
  let step = 0;
  try {
    holdRun(h);
    for (const [runId, pass] of h.world.passes) {
      if (pass.pending) finishPass(h.world, runId, [receiptOf("c1", cycle.passReceipts ? "pass" : "fail", runId, pass.head)]);
    }
    h.verdicts.step(h.team);
    h.verdicts.step(h.team);
    contextStep(h);
    reportEval(h, cycle.reportRoll);
    const verdictId = h.team.verdict!.verdictId;

    h.armedCrash = "before-intent";
    h.saveNumber = 0;
    let crashed = false;
    try {
      settleAll(h, true);
    } catch (error) {
      if (error instanceof SimulatedCrash && error.point === "before-intent") crashed = true;
      else throw error;
    } finally {
      h.armedCrash = "none";
    }
    assert.equal(crashed, true, `seed ${seed}: before-intent crash did not trigger`);
    counts["crash:before-intent"] = (counts["crash:before-intent"] ?? 0) + 1;

    const midTeam = h.teamOnDisk();
    assert.equal(midTeam.pendingOp?.kind, "result", `seed ${seed}: pending result operation marker stayed persisted`);
    assert.equal(midTeam.verdict?.status, "evaluating", `seed ${seed}: no recording intent persisted before Save #1`);

    h.restart();
    checkStepInvariants(h, seed, ++step, false);

    const afterTeam = h.teamOnDisk();
    const afterGoal = h.goalRecordOnDisk();
    assert.equal(afterTeam.run.status, "blocked", `seed ${seed}: pre-intent crash fences the run as blocked`);
    assert.match(afterTeam.run.reason ?? "", /will not be replayed/);
    assert.equal(afterTeam.verdict?.status, "evaluating", `seed ${seed}: interrupted verdict is not replayed`);
    assert.equal(afterTeam.run.assessment, undefined, `seed ${seed}: no assessment recorded after fenced crash`);
    assert.equal(afterGoal.log.some(entry => entry.handle === `verdict:${verdictId}`), false, `seed ${seed}: goal record has no entry for fenced verdict`);
    assert.equal(h.ledgerRows().length, 0, `seed ${seed}: SQLite ledger has no row for fenced verdict`);
  } finally {
    h.close();
  }
}

test("disk-backed verdict crash/restart simulator converges post-intent crashes and fences pre-intent crashes", t => {
  const counts: Record<string, number> = {};
  for (const seed of SEEDS) {
    const plain = runSeed(seed, false, {});
    const crashed = runSeed(seed, true, counts);
    for (const key of Object.keys(plain)) {
      if (plain[key] !== crashed[key]) {
        throw new SimViolation("I5", seed, -1, `${key} diverged after crash/restart`);
      }
    }
    runBeforeIntentFence(seed, counts);
  }
  t.diagnostic(`verdict crash sim: ${SEEDS.length} seeds from ${SEEDS[0]}, counts=${JSON.stringify(counts)}`);
  if (!DEFAULT_CORPUS) return;
  for (const point of [...POST_INTENT_CRASHES, "before-intent" as const]) {
    assert.ok((counts[`crash:${point}`] ?? 0) >= 4, `crash:${point} ran ${counts[`crash:${point}`] ?? 0} times, expected >= 4`);
  }
});

const MUTANTS: readonly { name: string; mutant: Mutant; invariant: string }[] = [
  { name: "finish writes the goal objective record before persisting the recording intent", mutant: "write-before-intent", invariant: "I3" },
  { name: "writeRecord skips handle deduplication on recovery", mutant: "skip-handle-dedup", invariant: "I1" },
  { name: "recover drops recording state without committing", mutant: "drop-recording-intent", invariant: "I3" },
  { name: "emit records a stale pre-write record version", mutant: "stale-ledger-version", invariant: "I2" },
  { name: "finalize drops run assessment when settling", mutant: "skip-settled-assessment", invariant: "I4" },
  { name: "recovery replays finalization with a drifted timestamp instead of commit.at", mutant: "drift-recovery-timestamp", invariant: "I5" },
];

for (const item of MUTANTS) {
  test(`verdict crash simulator catches mutant: ${item.name} (${item.invariant})`, { skip: ONLY !== undefined }, t => {
    let caught: SimViolation | undefined;
    for (const seed of SEEDS) {
      try {
        const crashed = runSeed(seed, true, {}, item.mutant);
        const plain = runSeed(seed, false, {});
        for (const key of Object.keys(plain)) {
          if (plain[key] !== crashed[key]) {
            throw new SimViolation("I5", seed, -1, `${key} diverged`);
          }
        }
      } catch (error) {
        if (error instanceof SimViolation) {
          caught = error;
          break;
        }
        throw error;
      }
    }
    assert.ok(caught, `none of ${SEEDS.length} seeds caught mutant ${item.mutant}`);
    assert.equal(caught.invariant, item.invariant, `expected ${item.invariant}, got ${caught.message}`);
    t.diagnostic(`caught at ${caught.message}`);
  });
}
