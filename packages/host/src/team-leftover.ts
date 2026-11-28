import { mergeWitness, newWitness, type CensusResult, type ProcessWitness } from "./process-census.js";
import type { TeamLeftoverProcesses } from "./team-state-schemas.js";

export const CENSUS_TTL_MS = 10 * 60_000;

export type CensusCounts =
  | { state: "running"; recorded: number; using?: number }
  | { state: "in-use"; using: number }
  | { state: "unknown"; detail: string }
  | { state: "ended" };
export type LeftoverCensus = Exclude<CensusCounts, { state: "ended" }> & { at: string };
export type StoredLeftover = { since: string; operation?: string; directory?: true; witness: ProcessWitness; census?: LeftoverCensus };

export function censusCounts(result: CensusResult): CensusCounts {
  if (!result.ok) return { state: "unknown", detail: result.problem.slice(0, 200) };
  const count = (reasons: string[]) => result.findings.filter(finding => reasons.includes(finding.reason)).length;
  const recorded = count(["recorded-process", "recorded-session", "recorded-group"]);
  const using = count(["working-directory", "open-file", "command-line"]);
  const unreadable = count(["unreadable"]);
  if (recorded > 0) return { state: "running", recorded, ...(using ? { using } : {}) };
  if (using > 0) return { state: "in-use", using };
  if (unreadable > 0) return { state: "unknown", detail: `${unreadable} process(es) of the accounts it inspects could not be inspected` };
  return { state: "ended" };
}

export function countsKey(census: CensusCounts) {
  switch (census.state) {
    case "running": return `running:${census.recorded}:${census.using ?? 0}`;
    case "in-use": return `in-use:${census.using}`;
    case "unknown": return `unknown:${census.detail}`;
    case "ended": return "ended";
  }
}

export function notedLeftover(previous: StoredLeftover | undefined, witness: ProcessWitness | undefined, operation: string | undefined, at: string): StoredLeftover {
  const seen = witness ?? newWitness();
  return { since: previous?.since ?? at, ...(operation ? { operation } : {}), witness: previous ? mergeWitness(previous.witness, seen) : structuredClone(seen) };
}

export function settledLeftover(leftover: StoredLeftover | undefined, operation: { id: string; witness?: ProcessWitness }): StoredLeftover | undefined {
  if (!leftover || leftover.operation !== operation.id || !operation.witness) return leftover;
  return { ...leftover, witness: mergeWitness(leftover.witness, operation.witness) };
}

export function directoryLeftover(at: string): StoredLeftover {
  return { since: at, directory: true, witness: newWitness() };
}

function directoryCensusEvent(census: CensusCounts) {
  switch (census.state) {
    case "running":
    case "in-use":
      return `${census.state === "running" ? census.recorded + (census.using ?? 0) : census.using} process(es) use this run's directories. The host keeps them until a census finds none.`;
    case "unknown":
      return `The host cannot tell whether a process uses this run's directories: ${census.detail}. It keeps them; after checking the host, the owner can state that none does with \`infinite team processes-ended RUN_ID\`.`;
    case "ended":
      return "The host sees no process using this run's directories. They can be removed.";
  }
}

export function leftoverCensusEvent(census: CensusCounts, directory?: boolean) {
  if (directory) return directoryCensusEvent(census);
  switch (census.state) {
    case "running":
      return `The host still sees ${census.recorded} process(es) left behind by an earlier command of this run${census.using ? `, and ${census.using} more using this run's directory` : ""}. It keeps this run's directories until a census finds none.`;
    case "in-use":
      return `The host sees ${census.using} process(es) using this run's directory after an earlier command of this run left a process behind. It keeps this run's directories until a census finds none.`;
    case "unknown":
      return `The host cannot tell whether a process left behind by an earlier command of this run still runs: ${census.detail}. It keeps this run's directories; after checking the host, the owner can state that it ended with \`infinite team processes-ended RUN_ID\`.`;
    case "ended":
      return "The host sees no process left behind by an earlier command of this run, and none using this run's directory. Its directories can be removed.";
  }
}

export function commandStillRunningEvent(count: number) {
  return `${count} process(es) that a command of this run started still run after the command ended. The host keeps this run's directories until a census finds none.`;
}

export function leftoverStatementEvent(detail: string, directory?: boolean) {
  if (directory) return `The owner stated that no process uses this run's directories. The host's census could not tell (${detail}); it no longer keeps them for that.`;
  return `The owner stated that the processes an earlier command of this run left behind have ended. The host's census could not tell (${detail}); it no longer keeps this run's directories for them.`;
}

export function leftoverView(leftover: StoredLeftover): TeamLeftoverProcesses {
  return leftover.census ? { since: leftover.since, state: leftover.census.state, checkedAt: leftover.census.at } : { since: leftover.since, state: "unchecked" };
}
