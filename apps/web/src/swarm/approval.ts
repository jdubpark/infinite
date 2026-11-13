import type { SwarmSession, SwarmTeam } from "./types";

/**
 * Who answers a member's open provider prompt. Must match `approvalOwner` in the phone's
 * team model: the latest permission decision for the session and prompt decides when present
 * (pending, reviewing, approved, answering mean coordinator; anything else person). Otherwise the
 * coordinator owns a fresh one-shot permission when the run delegated permissions, has decisions
 * left, runs a strong lineup coordinator, and the prompt is delegable, a permission, not
 * destructive, and not multi-select. Everything else waits on a person.
 */
export function approvalOwner(team: SwarmTeam, sessionId: string, prompt?: NonNullable<SwarmSession["attention"]>["prompt"]): "coordinator" | "person" {
  const decision = [...(team.permissionDecisions ?? [])].reverse().find(item => item.targetSessionId === sessionId && item.promptId === prompt?.id);
  if (decision) return ["pending", "reviewing", "approved", "answering"].includes(decision.status) ? "coordinator" : "person";
  const delegated = Boolean(team.permissions) && !team.permissionsRevokedAt && (team.permissionDecisions?.length ?? 0) < (team.permissions?.maxDecisions ?? 0);
  return delegated && team.lineup?.coordinator.tier === "strong" && prompt?.delegable === true && prompt.kind === "permission" && !prompt.destructive && !prompt.multiSelect ? "coordinator" : "person";
}
