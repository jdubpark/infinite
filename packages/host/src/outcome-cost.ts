import { EvidenceError } from "./evidence/types.js";
import type { SessionCost } from "./outcome-cells.js";
import type { SessionUsage, UnmeasuredUsage } from "./usage-service.js";

export function sessionCostOf(found: SessionUsage | UnmeasuredUsage): SessionCost | undefined {
  if (!found.measured) {
    if (found.unavailable) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    return undefined;
  }
  const tokens = found.tokens.input + found.tokens.output + found.tokens.reasoning + found.tokens.cacheRead + found.tokens.cacheWrite;
  return { usd: found.cost, tokens, complete: found.coverage === "complete" && found.pricing.unknown === 0 };
}
