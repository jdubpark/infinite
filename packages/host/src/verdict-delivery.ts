import type { EvidenceDb } from "./evidence/types.js";
import { runSignals } from "./outcome-store.js";
import type { DeliveryFact } from "./verdict-types.js";

/** "none": no active host landing of the run, or its stored reviewedHead differs from `head`, or its `at` is before `since`.
 *  "reverted": such a landing, and an active host revert row of the run. Else "landed". Reads signals only. */
export function deliveryFact(db: EvidenceDb, runId: string, head: string, since: string): DeliveryFact {
  const rows = runSignals(db, runId).filter(row => row.state === "active" && row.author === "host" && row.authority === "receipt");
  const landing = rows.find(row => row.kind === "landing");
  if (landing === undefined || landing.payload.kind !== "landing") return "none";
  const reviewedHead = landing.payload.reviewedHead;
  if ((reviewedHead !== undefined && reviewedHead !== head) || landing.at < since) return "none";
  const reverted = rows.some(row => row.kind === "revert" && row.payload.kind === "revert" && row.payload.landingSignalId === landing.signalId);
  return reverted ? "reverted" : "landed";
}
