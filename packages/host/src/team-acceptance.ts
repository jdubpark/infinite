import type { TeamAcceptanceEvidence, TeamBrief } from "./team-types.js";
import { TeamError } from "./team-workspace.js";

/** Enforces brief-backed evidence on approval while preserving legacy runs without a brief. */
export function validateTeamAcceptance(
  brief: TeamBrief | undefined,
  verdict: "approved" | "changes-requested",
  acceptance: TeamAcceptanceEvidence[] | undefined,
): void {
  if (!brief) return;

  const entries = acceptance ?? [];
  const seen = new Set<number>();
  const duplicate: number[] = [];
  for (const entry of entries) {
    if (entry.criterion > brief.acceptance.length || seen.has(entry.criterion)) duplicate.push(entry.criterion);
    seen.add(entry.criterion);
  }
  if (duplicate.length) {
    const criteria = [...new Set(duplicate)].sort((a, b) => a - b).join(", ");
    throw new TeamError(409, "acceptance-evidence-required", `Acceptance evidence contains duplicate or out-of-range criteria: ${criteria}.`);
  }

  if (verdict !== "approved") return;
  const byCriterion = new Map(entries.map(entry => [entry.criterion, entry]));
  const incomplete = brief.acceptance.flatMap((criterion, index) => {
    const number = index + 1;
    const entry = byCriterion.get(number);
    return !entry ? [`${number} (missing)`] : entry.verdict !== "verified" ? [`${number} (${entry.verdict})`] : [];
  });
  if (incomplete.length)
    throw new TeamError(409, "acceptance-evidence-required", `Approval requires verified evidence for every acceptance criterion; unresolved criteria: ${incomplete.join(", ")}.`);
}
