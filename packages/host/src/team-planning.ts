import { digest } from "./team-kernel.js";
import { decisionAnswerLabel, type TeamBrief, type TeamReport, type TeamRun, type TeamTask } from "./team-types.js";
import { TeamError, teamPathAllowed } from "./team-workspace.js";

export const capacityCeiling = (run: Pick<TeamRun, "parallelismCeiling" | "handoff">) => run.parallelismCeiling ?? (run.handoff ? 2 : 4);

export function assertPlannerCapacity(run: TeamRun, parallelism: number | undefined) {
  const ceiling = capacityCeiling(run);
  if (parallelism !== undefined && parallelism > ceiling)
    throw new TeamError(409, "team-parallelism-limit", `The project manager selected ${parallelism} workers, above this run's capacity ceiling of ${ceiling}.`);
}

export function applyTeamBriefTitle(run: TeamRun, brief: TeamBrief | undefined, revision = run.revision) {
  run.brief = brief;
  if (brief && run.status !== "cancelled" && revision === run.revision && (run.titleSource === "request" || run.titleSource === "model" || run.titleSource === "brief")) {
    run.title = brief.title;
    run.titleSource = "brief";
  }
}

export function plannerCorrectionFeedback(run: TeamRun, message: string): string {
  const planners = new Set(run.members.filter(member => member.role === "project-manager").map(member => member.memberId));
  const answers = run.decisions.filter(decision => decision.answer && decision.revision === run.revision && planners.has(decision.memberId))
    .map(decision => `Earlier planning question: ${decision.question}\n${decisionAnswerLabel(decision)} answered: ${decision.answer}`);
  return [message, ...answers].join("\n\n");
}

export function plannedTasks(run: TeamRun, report: Extract<TeamReport, { kind: "plan" }>, revision: number): TeamTask[] {
  if (run.establishChecks && !run.verification && !report.verification)
    throw new TeamError(409, "verification-required", "The first plan must establish project verification commands before implementation.");
  if (run.verification && report.verification && digest(run.verification) !== digest(report.verification))
    throw new TeamError(409, "verification-changed", "The accepted verification commands cannot change during this run or its goal continuation.");
  const goal = run.goal;
  if (goal && !report.brief) throw new TeamError(409, "goal-brief-required", "A goal plan must include an evidence-backed brief with acceptance criteria.");
  if (goal && report.tasks.some(task => task.paths.some(path => !teamPathAllowed(path, goal.allowedPaths))))
    throw new TeamError(409, "goal-scope-violation", "The plan proposes paths outside the approved goal scope.");

  const remaining = [...report.tasks];
  const ordered: TeamTask[] = [];
  const ready = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex(task => task.dependsOn.every(id => ready.has(id)));
    if (index === -1) throw new TeamError(409, "invalid-plan", "A task has an unsatisfied dependency.");
    const [task] = remaining.splice(index, 1);
    ordered.push({ ...task, revision, reviewRounds: 0, status: "pending" });
    ready.add(task.id);
  }
  return ordered;
}
