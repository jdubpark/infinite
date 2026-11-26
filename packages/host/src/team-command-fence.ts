import { bootId, hostProcesses, mergeWitness, type CensusResult } from "./process-census.js";
import { teamRunDirectory, type TeamKernel } from "./team-kernel.js";
import { COMMAND_STOP_UNCONFIRMED_REASON, TeamError } from "./team-workspace.js";
import { CENSUS_TTL_MS, censusCounts, countsKey, leftoverCensusEvent, leftoverStatementEvent, type StoredLeftover } from "./team-leftover.js";
import type { PendingOperation, Stored, TeamServiceOptions } from "./teams.js";

export const COMMAND_STOP_STATEMENT_REASON = "The host stopped a configured team command but cannot confirm that it ended, and its process census cannot tell whether that command's processes still run. While the census cannot tell, the owner's statement is the only way out: after checking the host, run `infinite team processes-ended RUN_ID` (POST /api/teams/RUN_ID/processes-ended); Resume is accepted after that.";
export const commandStopReasons = new Set([COMMAND_STOP_UNCONFIRMED_REASON, COMMAND_STOP_STATEMENT_REASON]);
export const HALT_CENSUS_MS = 30_000;

export type OwnerStatement = { requestId: string; at: string; detail: string };
export type TakenCensus = { pendingId?: string; leftover?: StoredLeftover; at: string; result: CensusResult };
export type FenceHost = Pick<TeamKernel, "records" | "commands" | "config" | "save" | "event" | "enqueue"> & { readonly options: TeamServiceOptions | undefined };
type OperationCensus = NonNullable<Stored["census"]>;
type CensusState = OperationCensus["state"];
type Fenced = {
  pending?: { id: string; failure?: { code?: string }; processesEnded?: OwnerStatement };
  census?: { pendingId: string; state: CensusState };
};

export function stopFenced(stored: Fenced) {
  return stored.pending?.failure?.code === "command-stop-unconfirmed";
}

export function processesCleared(stored: Fenced) {
  const pending = stored.pending, census = stored.census;
  if (!pending || census?.pendingId !== pending.id) return false;
  return census.state === "ended" || (census.state === "unknown" && Boolean(pending.processesEnded));
}

export function stopFenceLifted(stored: Fenced) {
  return stopFenced(stored) && processesCleared(stored);
}

function stopFenceRefusal(state: CensusState | undefined, code = "team-command-running") {
  return state === "unknown"
    ? new TeamError(409, code, "The host cannot tell whether an earlier command of this run still runs. After checking the host, state that its processes ended with `infinite team processes-ended RUN_ID`, then retry.")
    : new TeamError(409, code, "An earlier command of this run may still be running. The host accepts this request once a process census finds none of that operation's processes.");
}

function ownerStatementEvent(kind: string, detail: string) {
  return `The owner stated that the processes of the run's ${kind} operation have ended. The host's process census could not tell (${detail}); the host accepts the statement in place of a census that finds none.`;
}

function operationCensusEvent(kind: PendingOperation["kind"], census: Omit<OperationCensus, "at" | "pendingId">) {
  if (census.state === "running") return `The host still sees ${census.recorded} process(es) that match its record of the interrupted ${kind} operation${census.using ? `, and ${census.using} more using this run's directory` : ""}.`;
  if (census.state === "in-use") return `The host sees ${census.using} process(es) using this run's directory. None matches its record of the interrupted ${kind} operation.`;
  if (census.state === "ended") return `The host sees no process that matches its record of the interrupted ${kind} operation, and none using this run's directory. The intent stays recorded and is not replayed.`;
  return `The host cannot tell whether the interrupted ${kind} operation left processes: ${census.detail}.`;
}

export class CommandFence {
  private readonly flights = new Map<string, Promise<CensusResult>>();
  constructor(private readonly host: FenceHost, private readonly recorderOf: (stored: Stored, pending: PendingOperation) => { inFlight: number } | undefined) {}
  private now() { return this.host.options?.now?.() ?? Date.now(); }
  private flight(key: string, census: () => Promise<CensusResult>): Promise<CensusResult> {
    const flight = this.flights.get(key);
    if (flight) return flight;
    const taken = Promise.resolve().then(census)
      .catch((error): CensusResult => ({ ok: false, problem: error instanceof Error ? error.message : "The census failed." }))
      .finally(() => { this.flights.delete(key); });
    this.flights.set(key, taken);
    return taken;
  }
  async take(id: string, anyOperation = false, withLeftover = false): Promise<TakenCensus | undefined> {
    const stored = this.host.records.get(id);
    if (!stored || this.host.commands.has(id)) return undefined;
    const pending = stored.pending?.witness && (anyOperation || stopFenced(stored)) ? stored.pending : undefined, leftover = withLeftover ? stored.leftover : undefined;
    const witness = pending?.witness && leftover ? mergeWitness(pending.witness, leftover.witness) : pending?.witness ?? leftover?.witness;
    if (!witness) return undefined;
    const at = new Date(this.now()).toISOString(), processes = this.host.options?.processes ?? hostProcesses;
    const result = await this.flight(`${id}:${pending?.id ?? ""}:${leftover ? "leftover" : ""}`, () => processes.census(witness, teamRunDirectory(stored.run.workspace), this.host.config.teams?.commandPrefix));
    return { ...(pending ? { pendingId: pending.id } : {}), ...(leftover ? { leftover } : {}), at, result };
  }
  async refresh(stored: Stored, force = false, withLeftover = false): Promise<CensusState | undefined> {
    const { run } = stored, pending = stored.pending?.witness ? stored.pending : undefined, leftover = withLeftover ? stored.leftover : undefined;
    if ((!pending && !leftover) || this.host.commands.has(run.id)) return undefined;
    const previous = pending && stored.census?.pendingId === pending.id ? stored.census : undefined;
    if (!force && !leftover && previous && this.now() - Date.parse(previous.at) < CENSUS_TTL_MS) return previous.state;
    const taken = await this.take(run.id, true, withLeftover);
    return taken && this.apply(stored, taken);
  }
  apply(stored: Stored, taken: TakenCensus): CensusState | undefined {
    const { run } = stored, pending = stored.pending;
    if (this.host.records.get(run.id) !== stored || this.host.commands.has(run.id)) return undefined;
    if (taken.pendingId !== undefined && (!pending?.witness || pending.id !== taken.pendingId)) return undefined;
    if (taken.leftover && stored.leftover !== taken.leftover) return undefined;
    const counts = censusCounts(taken.result);
    const state = taken.pendingId === undefined ? "ended" : this.applyOperation(stored, taken, counts);
    if (!taken.leftover) return state;
    stored.leftover = counts.state === "ended" ? undefined : { ...taken.leftover, census: { ...counts, at: taken.at } };
    if (!taken.leftover.census || countsKey(taken.leftover.census) !== countsKey(counts)) {
      this.host.event(stored, leftoverCensusEvent(counts));
      this.host.save(stored);
    }
    return state === "ended" ? counts.state : state;
  }
  private applyOperation(stored: Stored, taken: TakenCensus, counts: ReturnType<typeof censusCounts>): CensusState {
    const { run } = stored, pending = stored.pending!;
    const previous = stored.census?.pendingId === pending.id ? stored.census : undefined;
    if (previous && Date.parse(previous.at) > Date.parse(taken.at)) return previous.state;
    const recorder = this.recorderOf(stored, pending);
    const incomplete = pending.recording && !recorder && pending.witness?.boot === bootId();
    const census: Omit<OperationCensus, "at" | "pendingId"> = counts.state !== "ended" ? counts
      : incomplete ? { state: "unknown", detail: "the host stopped while the operation was starting a command, so its record of the operation's processes may be incomplete" }
        : recorder && recorder.inFlight > 0 ? { state: "unknown", detail: "a command of the operation is still starting" }
          : counts;
    stored.census = { pendingId: pending.id, at: taken.at, ...census };
    const changed = previous?.state !== census.state || previous.recorded !== census.recorded || previous.using !== census.using || previous.detail !== census.detail;
    const reason = stopFenced(stored) && commandStopReasons.has(run.reason ?? "") ? (census.state === "unknown" ? COMMAND_STOP_STATEMENT_REASON : COMMAND_STOP_UNCONFIRMED_REASON) : run.reason;
    if (changed) this.host.event(stored, operationCensusEvent(pending.kind, census));
    if (changed || reason !== run.reason) {
      run.reason = reason;
      this.host.save(stored);
    }
    return census.state;
  }
  state(stored: Stored, requestId: string) {
    const pending = stored.pending, census = stored.census, leftover = stored.leftover;
    if (pending?.witness && census?.pendingId === pending.id && census.state === "unknown") {
      pending.processesEnded = { requestId, at: new Date(this.now()).toISOString(), detail: census.detail ?? "" };
      this.host.event(stored, ownerStatementEvent(pending.kind, pending.processesEnded.detail));
    }
    if (leftover?.census?.state === "unknown") {
      this.host.event(stored, leftoverStatementEvent(leftover.census.detail));
      stored.leftover = undefined;
    }
  }
  watch(stored: Stored) {
    if (!stopFenced(stored)) return;
    void this.take(stored.run.id).then(taken => taken && this.host.enqueue(stored.run.id, () => this.apply(stored, taken))).catch(() => {});
  }
  forHalt(id: string, haltId: string, reuseMs = 0): Promise<TakenCensus | undefined> {
    const stored = this.host.records.get(id), census = stored?.census;
    if (!stored || stored.ownerHalt?.haltId !== haltId || stored.run.status !== "paused") return Promise.resolve(undefined);
    const fresh = census && census.pendingId === stored.pending?.id && this.now() - Date.parse(census.at) < reuseMs;
    return fresh ? Promise.resolve(undefined) : this.take(id);
  }
  refusal(stored: Stored, taken: TakenCensus | undefined, code?: string): TeamError | undefined {
    if (!stopFenced(stored) || this.host.commands.has(stored.run.id)) return undefined;
    if (taken) this.apply(stored, taken);
    const census = stored.census?.pendingId === stored.pending?.id ? stored.census : undefined;
    return stopFenceLifted(stored) ? undefined : stopFenceRefusal(census?.state, code);
  }
  check(stored: Stored, taken: TakenCensus | undefined) {
    const refusal = this.refusal(stored, taken);
    if (refusal) throw refusal;
  }
  lift(stored: Stored) {
    if (!stopFenceLifted(stored)) return;
    const stated = stored.census?.state === "unknown";
    stored.pending = undefined;
    this.host.event(stored, stated
      ? "The host cleared the stopped command's operation on the owner's statement that its processes ended."
      : "The host sees no process of the stopped command's operation and cleared it.");
  }
}
