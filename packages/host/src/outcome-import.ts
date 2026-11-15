import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceTx } from "./evidence/types.js";
import {
  LEGACY_LINE_CAP,
  type LegacyOutcome,
  type LegacyLineOutcome,
  type LegacyPlan,
  legacyOutcomeId,
  planLegacyBatch,
} from "./outcome-legacy.js";
import {
  deleteLegacyOutcome,
  legacyLineCount,
  OUTCOME_RETENTION_DAYS,
  OUTCOMES_MODULE,
  outcomeSources,
  readLegacyLines,
  writeLegacyLine,
  writeOutcome,
} from "./outcome-store.js";

export type LegacyImportResult = { dryRun: boolean; outcomes: LegacyLineOutcome[]; removed: number };
export class LegacyImportRefused extends Error {
  constructor(readonly code: "legacy-limit") {
    super("The legacy import is refused.");
  }
}

const UNAVAILABLE = "The outcome ledger is unavailable.";

/**
 * Imports one batch of legacy lines. A dry run and a real run decide from the same stored state. A real run writes in
 * one transaction, so a throw leaves nothing of the batch. Throws `EvidenceError` `unavailable` when the module is not
 * ready or a stored line does not open, and `LegacyImportRefused` when the table would pass the cap.
 */
export function importLegacy(store: EvidenceStore, input: { dryRun: boolean; lines: LegacyOutcome[] },
  options: { now: string; retentionDays?: number; cap?: number }): LegacyImportResult {
  if (store.status().modules[OUTCOMES_MODULE] !== "ready") throw new EvidenceError("unavailable", UNAVAILABLE);
  const retentionDays = options.retentionDays ?? OUTCOME_RETENTION_DAYS;
  const cap = options.cap ?? LEGACY_LINE_CAP;

  if (input.dryRun) {
    return store.read(db => {
      const plan = decide(db, input.lines, options.now, retentionDays);
      checkCap(db, plan, cap);
      return { dryRun: true, outcomes: plan.outcomes, removed: plan.removed };
    });
  }
  return store.write(tx => {
    const plan = decide(tx, input.lines, options.now, retentionDays);
    checkCap(tx, plan, cap);
    for (const effect of plan.effects) {
      if (effect.kind === "insert") {
        writeOutcome(tx, effect.row);
        writeLegacyLine(tx, effect.ref, effect.state);
      } else {
        if (effect.removeRow) deleteLegacyOutcome(tx, legacyOutcomeId(effect.ref));
        writeLegacyLine(tx, effect.ref, effect.state);
      }
    }
    return { dryRun: false, outcomes: plan.outcomes, removed: plan.removed };
  });
}

/** Reads every stored state the batch can touch, then plans. A stored line that does not open throws here. */
function decide(db: EvidenceDb, lines: readonly LegacyOutcome[], now: string, retentionDays: number): LegacyPlan {
  const refs = lines.map(line => db.index("legacy", line.id));
  const supersededRefs = lines.flatMap(line => line.supersedes === undefined ? [] : [db.index("legacy", line.supersedes)]);
  const known = {
    lines: readLegacyLines(db, [...new Set([...refs, ...supersededRefs])]),
    rows: outcomeSources(db, refs.map(legacyOutcomeId)),
  };
  return planLegacyBatch(lines, known, { now, retentionDays, ref: id => db.index("legacy", id) });
}

function checkCap(db: EvidenceDb, plan: LegacyPlan, cap: number): void {
  if (legacyLineCount(db) + plan.newLines > cap) throw new LegacyImportRefused("legacy-limit");
}
