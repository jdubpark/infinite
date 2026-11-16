import type { TeamAcceptanceEvidence, TeamBrief } from "./team-types.js";

type TeamReviewReport = {
  verdict: "approved" | "changes-requested";
  uiEvidence?: string;
  acceptance?: TeamAcceptanceEvidence[];
};

type TeamReviewEvidenceProblem = {
  code: "ui-review-evidence-required" | "acceptance-evidence-required";
  message: string;
  /** What the corrected reviewer must do about this problem. */
  rule: string;
};

/** Returns all brief-backed evidence problems in the order the reviewer should address them. */
export function reviewEvidenceProblems(brief: TeamBrief | undefined, report: TeamReviewReport): TeamReviewEvidenceProblem[] {
  const problems: TeamReviewEvidenceProblem[] = [];
  if (brief?.uiChanges && report.verdict === "approved" && !report.uiEvidence) {
    problems.push({ code: "ui-review-evidence-required", message: "Approval of UI changes requires the reviewer's evidence from inspecting the runnable interface.",
      rule: "Approval of UI changes requires uiEvidence describing the runnable flow you inspected, the results, and limitations; if you cannot inspect it, request changes." });
  }
  const acceptanceProblem = validateTeamAcceptance(brief, report.verdict, report.acceptance);
  if (acceptanceProblem) problems.push({ code: "acceptance-evidence-required", message: acceptanceProblem,
    rule: "Report one acceptance entry per criterion.\nIf any criterion is not verified, the verdict must be changes-requested." });
  return problems;
}

/** Returns a report problem for brief-backed reviews, preserving legacy runs without a brief. */
function validateTeamAcceptance(
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
