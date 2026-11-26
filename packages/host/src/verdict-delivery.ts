import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb } from "./evidence/types.js";
import { runSignals } from "./outcome-store.js";
import type { DeliveryFact } from "./verdict-types.js";

export function deliveryFact(db: EvidenceDb, runId: string, head: string, since: string): DeliveryFact {
  const rows = runSignals(db, runId).filter(row => row.state === "active" && row.author === "host" && row.authority === "receipt");
  const landing = rows.find(row => row.kind === "landing");
  if (landing === undefined || landing.payload.kind !== "landing") return "none";
  const reviewedHead = landing.payload.reviewedHead;
  if ((reviewedHead !== undefined && reviewedHead !== head) || landing.at < since) return "none";
  const reverted = rows.some(row => row.kind === "revert" && row.payload.kind === "revert" && row.payload.landingSignalId === landing.signalId);
  return reverted ? "reverted" : "landed";
}

export function deliveryPort(store: Pick<EvidenceStore, "read">): (runId: string, head: string, since: string) => DeliveryFact | undefined {
  return (runId, head, since) => {
    try {
      return store.read(db => deliveryFact(db, runId, head, since));
    } catch {
      return undefined;
    }
  };
}
