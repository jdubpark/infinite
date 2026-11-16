import type { TeamAcceptanceEvidence, TeamBrief } from "./team-types.js";

/** Returns a report problem for brief-backed reviews, preserving legacy runs without a brief. */
export function validateTeamAcceptance(
  brief: TeamBrief | undefined,
  verdict: "approved" | "changes-requested",
  acceptance: TeamAcceptanceEvidence[] | undefined,
): string | undefined {
  if (!brief) return undefined;

  const entries = acceptance ?? [];
  const seen = new Set<number>();
  const duplicate: number[] = [];
  for (const entry of entries) {
    if (entry.criterion < 1 || entry.criterion > brief.acceptance.length || seen.has(entry.criterion)) duplicate.push(entry.criterion);
    seen.add(entry.criterion);
  }
  if (duplicate.length) {
    const criteria = [...new Set(duplicate)].sort((a, b) => a - b).join(", ");
    return `Acceptance evidence contains duplicate or out-of-range criterion numbers: ${criteria}.`;
  }

  if (verdict !== "approved") return undefined;
  const byCriterion = new Map(entries.map(entry => [entry.criterion, entry]));
  const incomplete = brief.acceptance.flatMap((criterion, index) => {
    const number = index + 1;
    const entry = byCriterion.get(number);
    return !entry ? [`${number} (missing)`] : entry.verdict !== "verified" ? [`${number} (${entry.verdict})`] : [];
  });
  return incomplete.length
    ? `Approval requires verified evidence for every acceptance criterion; unresolved criteria: ${incomplete.join(", ")}.`
    : undefined;
}
