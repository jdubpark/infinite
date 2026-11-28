import type { TeamModelProfile, TeamRun } from "./team-types.js";
import type { Config, Provider } from "./types.js";

export interface WarmRepairTarget {
  memberId: string;
  taskId: string;
  title: string;
  provider: Provider;
  modelProfile: TeamModelProfile;
  changedPaths: string[];
  summary?: string;
}

export function isWarmRepairEnabled(
  run: Pick<TeamRun, "projectId" | "handoff">,
  config: Pick<Config, "projects" | "teams">,
): boolean {
  const project = config.projects.find(item => item.id === run.projectId);
  const projectSetting = run.handoff?.project?.warmRepair ?? project?.team?.warmRepair;
  return projectSetting ?? config.teams?.warmRepair ?? false;
}

export function selectWarmRepairTarget(
  run: TeamRun,
  cause: "check" | "review" | "delivery",
  config: Pick<Config, "projects" | "teams">,
  limitedProviders?: ReadonlySet<Provider>,
): WarmRepairTarget | undefined {
  if (!isWarmRepairEnabled(run, config)) return undefined;
  if (run.round !== 1 || run.replay) return undefined;
  if (cause !== "check" && cause !== "review") return undefined;

  const integrated = run.tasks.filter(task => (task.revision ?? run.revision) === run.revision && task.status === "integrated");
  if (integrated.length !== 1) return undefined;

  const task = integrated[0]!;
  if (!task.memberId) return undefined;

  const member = run.members.find(
    candidate => candidate.memberId === task.memberId && candidate.revision === run.revision && candidate.role === "implementer",
  );
  if (!member?.modelProfile) return undefined;

  const provider = member.provider ?? member.modelProfile.provider;
  if (limitedProviders?.has(provider)) return undefined;

  return {
    memberId: member.memberId,
    taskId: task.id,
    title: task.title,
    provider,
    modelProfile: structuredClone(member.modelProfile),
    changedPaths: [...(task.changedPaths?.paths ?? task.paths)],
    ...(task.summary ? { summary: task.summary } : {}),
  };
}

export function warmRepairFeedback(target: WarmRepairTarget, feedback: string): string {
  const paths = target.changedPaths.length ? target.changedPaths.join(", ") : "(none recorded)";
  const prior = target.summary ? `\nPrior implementer summary: ${target.summary}` : "";
  return `Warm repair handoff (round 1): fixing single-implementer task "${target.title}" (${target.taskId}) using profile ${target.modelProfile.label}.\nPrior changed paths: ${paths}${prior}\n\n${feedback}`;
}
