import type { SwarmSession, SwarmTeam } from "./types";

export function approvalOwner(team: SwarmTeam, sessionId: string, prompt?: NonNullable<SwarmSession["attention"]>["prompt"]): "coordinator" | "person" {
  const decision = [...(team.permissionDecisions ?? [])].reverse().find(item => item.targetSessionId === sessionId && item.promptId === prompt?.id);
  if (decision) return ["pending", "reviewing", "approved", "answering"].includes(decision.status) ? "coordinator" : "person";
  const delegated = Boolean(team.permissions) && !team.permissionsRevokedAt && (team.permissionDecisions?.length ?? 0) < (team.permissions?.maxDecisions ?? 0);
  return delegated && team.lineup?.coordinator.tier === "strong" && prompt?.delegable === true && prompt.kind === "permission" && !prompt.destructive && !prompt.multiSelect ? "coordinator" : "person";
}
