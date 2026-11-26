import { bootId, hostProcesses, type CensusResult } from "./process-census.js";
import { teamRunDirectory, type TeamKernel } from "./team-kernel.js";
import { COMMAND_STOP_UNCONFIRMED_REASON, TeamError } from "./team-workspace.js";
import type { PendingOperation, Stored, TeamServiceOptions } from "./teams.js";

export const COMMAND_STOP_STATEMENT_REASON = "The host stopped a configured team command but cannot confirm that it ended, and its process census cannot tell whether that command's processes still run. While the census cannot tell, the owner's statement is the only way out: after checking the host, run `infinite team processes-ended RUN_ID` (POST /api/teams/RUN_ID/processes-ended); Resume is accepted after that.";
export const commandStopReasons = new Set([COMMAND_STOP_UNCONFIRMED_REASON, COMMAND_STOP_STATEMENT_REASON]);
export const HALT_CENSUS_MS = 30_000;
const CENSUS_TTL_MS = 10 * 60_000;

export type OwnerStatement = { requestId: string; at: string; detail: string };
export type TakenCensus = { pendingId: string; at: string; result: CensusResult };
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

function stopFenceRefusal(id: string, state: CensusState | undefined, code = "team-command-running") {
  return state === "unknown"
    ? new TeamError(409, code, `The host cannot tell whether the stopped command of team run ${id} still runs. The run accepts this request after the owner checks the host and states that its processes ended with \`infinite team processes-ended ${id}\`.`)
    : new TeamError(409, code, `The stopped command of team run ${id} may still be running. The run accepts this request once a process census finds none of that command's processes.`);
}

export function ownerStatementEvent(kind: string, detail: string) {
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
  async take(id: string, anyOperation = false): Promise<TakenCensus | undefined> {
    const stored = this.host.records.get(id), pending = stored?.pending, witness = pending?.witness;
    if (!stored || !pending || !witness || this.host.commands.has(id) || (!anyOperation && !stopFenced(stored))) return undefined;
    const at = new Date(this.now()).toISOString(), processes = this.host.options?.processes ?? hostProcesses;
    const result = await this.flight(pending.id, () => processes.census(witness, teamRunDirectory(stored.run.workspace), this.host.config.teams?.commandPrefix));
    return { pendingId: pending.id, at, result };
  }
  async refresh(stored: Stored, force = false): Promise<CensusState | undefined> {
    const { run } = stored, pending = stored.pending;
    if (!pending?.witness || this.host.commands.has(run.id)) return undefined;
    const previous = stored.census?.pendingId === pending.id ? stored.census : undefined;
    if (!force && previous && this.now() - Date.parse(previous.at) < CENSUS_TTL_MS) return previous.state;
    const taken = await this.take(run.id, true);
    return taken && this.apply(stored, taken);
  }
  apply(stored: Stored, taken: TakenCensus): CensusState | undefined {
    const { run } = stored, pending = stored.pending, result = taken.result;
    if (this.host.records.get(run.id) !== stored || !pending?.witness || pending.id !== taken.pendingId || this.host.commands.has(run.id)) return undefined;
    const previous = stored.census?.pendingId === pending.id ? stored.census : undefined;
    if (previous && Date.parse(previous.at) > Date.parse(taken.at)) return previous.state;
    const count = (reasons: string[]) => result.ok ? result.findings.filter(finding => reasons.includes(finding.reason)).length : 0;
    const recorded = count(["recorded-process", "recorded-session", "recorded-group"]), using = count(["working-directory", "open-file", "command-line"]);
    const unreadable = count(["unreadable"]);
    const recorder = this.recorderOf(stored, pending);
    const incomplete = pending.recording && !recorder && pending.witness.boot === bootId();
    const census: Omit<OperationCensus, "at" | "pendingId"> = !result.ok ? { state: "unknown", detail: result.problem.slice(0, 200) }
      : recorded > 0 ? { state: "running", recorded, ...(using ? { using } : {}) }
        : using > 0 ? { state: "in-use", using }
          : unreadable > 0 ? { state: "unknown", detail: `${unreadable} process(es) of the accounts it inspects could not be inspected` }
            : incomplete ? { state: "unknown", detail: "the host stopped while the operation was starting a command, so its record of the operation's processes may be incomplete" }
              : recorder && recorder.inFlight > 0 ? { state: "unknown", detail: "a command of the operation is still starting" }
                : { state: "ended" };
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
  watch(stored: Stored) {
    if (!stopFenced(stored)) return;
    void this.take(stored.run.id).then(taken => taken && this.host.enqueue(stored.run.id, () => this.apply(stored, taken))).catch(() => {});
  }
  recent(id: string, reuseMs: number): Promise<TakenCensus | undefined> {
    const stored = this.host.records.get(id), census = stored?.census;
    const fresh = census && census.pendingId === stored?.pending?.id && this.now() - Date.parse(census.at) < reuseMs;
    return fresh ? Promise.resolve(undefined) : this.take(id);
  }
  forHalt(id: string, haltId: string, reuseMs = 0): Promise<TakenCensus | undefined> {
    const stored = this.host.records.get(id);
    if (!stored || stored.ownerHalt?.haltId !== haltId || stored.run.status !== "paused") return Promise.resolve(undefined);
    return this.recent(id, reuseMs);
  }
  refusal(stored: Stored, taken: TakenCensus | undefined, code?: string): TeamError | undefined {
    if (!stopFenced(stored) || this.host.commands.has(stored.run.id)) return undefined;
    if (taken) this.apply(stored, taken);
    const census = stored.census?.pendingId === stored.pending?.id ? stored.census : undefined;
    return stopFenceLifted(stored) ? undefined : stopFenceRefusal(stored.run.id, census?.state, code);
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
