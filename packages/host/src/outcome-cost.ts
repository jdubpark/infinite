import { EvidenceError } from "./evidence/types.js";
import type { SessionCost } from "./outcome-cells.js";
import type { SessionUsage, UnmeasuredUsage } from "./usage-service.js";

/**
 * The cost of one session as the usage ledger measured it, for the scorecard, the outcome cells, and the roll-ups.
 *
 * A session that the ledger did not measure has no cost: undefined, never zero. A session that the ledger could not
 * read is not "no measurement": the read fails with `unavailable`, and the route answers 503.
 *
 * A cost is complete only when the ledger covered the whole session and every step has a price. A session with
 * partial coverage has usage that is known to be understated, so no reader counts it as a cost.
 */
export function sessionCostOf(found: SessionUsage | UnmeasuredUsage): SessionCost | undefined {
  if (!found.measured) {
    if (found.unavailable) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    return undefined;
  }
  const tokens = found.tokens.input + found.tokens.output + found.tokens.reasoning + found.tokens.cacheRead + found.tokens.cacheWrite;
  return { usd: found.cost, tokens, complete: found.coverage === "complete" && found.pricing.unknown === 0 };
}
