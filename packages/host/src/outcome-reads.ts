import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError } from "./evidence/types.js";
import { buildCells, checkCellQuery, type Cell, type CellQuery, type CostLookup } from "./outcome-cells.js";
import { OUTCOMES_MODULE, type OutcomeRow, rollupRecords, selectOutcomes } from "./outcome-store.js";
import { profileIdentityKey } from "./config-identity.js";
import { CONFIGURATIONS_MODULE, epochAt } from "./configuration-store.js";
import { buildRollup, type GoalAssessment, type OutcomeRollup, type RollupTarget } from "./outcome-rollup.js";

export type CellsResult = { cells: Cell[]; unreadable: number };

const DAY_MS = 86_400_000;
let loggedUnreadable = false;

/**
 * Cells for one query. A refused query throws `CellQueryRefused` before any read. An `outcomes` module that is not
 * ready throws `EvidenceError` with code `unavailable`.
 */
export function queryCells(store: EvidenceStore, query: CellQuery, options: { now: string; cost?: CostLookup }): CellsResult {
  checkCellQuery(query);
  requireOutcomes(store);
  const since = query.days === undefined
    ? undefined
    : new Date(Date.parse(options.now) - query.days * DAY_MS).toISOString();
  const { rows, unreadable } = store.read(db => selectOutcomes(db, {
    sources: query.sources,
    role: query.role,
    projectRef: query.projectId === undefined ? undefined : db.index("project", query.projectId),
    since,
  }));
  noteUnreadable(unreadable);
  return { cells: buildCells(rows, query, options.cost), unreadable };
}

/** Source `production` only, for the scorecard. */
export function productionRows(store: EvidenceStore, role: "implementer" | "scout"): { rows: OutcomeRow[]; unreadable: number } {
  requireOutcomes(store);
  const result = store.read(db => selectOutcomes(db, { sources: ["production"], role }));
  noteUnreadable(result.unreadable);
  return result;
}

/**
 * The current epoch of a profile identity at `now`, read once per identity. Throws `EvidenceError` with code
 * `unavailable` when the `configurations` module is not ready, so a reader never guesses an epoch.
 */
export function currentEpochs(store: EvidenceStore, now: string): (identity: { provider: string; model: string; effort: string | null }) => number {
  if (store.status().modules[CONFIGURATIONS_MODULE] !== "ready") {
    throw new EvidenceError("unavailable", "The configurations module is unavailable.");
  }
  const known = new Map<string, number>();
  return identity => {
    const key = profileIdentityKey(identity);
    let epoch = known.get(key);
    if (epoch === undefined) {
      epoch = store.read(db => epochAt(db, key, now));
      known.set(key, epoch);
    }
    return epoch;
  };
}

function requireOutcomes(store: EvidenceStore): void {
  if (store.status().modules[OUTCOMES_MODULE] !== "ready") {
    throw new EvidenceError("unavailable", "The outcome ledger is unavailable.");
  }
}

/** Logs one fixed line per process. The line names no row. */
function noteUnreadable(unreadable: number): void {
  if (unreadable === 0 || loggedUnreadable) return;
  loggedUnreadable = true;
  console.warn("Outcome reads skipped unreadable rows.");
}

/**
 * The roll-up of one goal or mission. Throws `EvidenceError` with code `unavailable` when the `outcomes` module is not
 * ready. `known` and `assessment` come from the route, which holds the goal and mission services. This never reads them.
 */
export function queryRollup(store: EvidenceStore, target: RollupTarget,
  options: { known: boolean; assessment: GoalAssessment | null; cost?: CostLookup }): OutcomeRollup {
  requireOutcomes(store);
  const records = store.read(db => rollupRecords(db, target.kind, db.index(target.kind, target.id)));
  const { summaries, rows, members } = records.unreadable;
  noteUnreadable(summaries + rows + members);
  return buildRollup(records, { target, known: options.known, assessment: options.assessment, cost: options.cost });
}
