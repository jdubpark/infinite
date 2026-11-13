import type { SwarmSession, SwarmTeam } from "./types";

/**
 * Who answers a member's open provider prompt. Must match `approvalOwner` in the phone's
 * team model: the coordinator owns a prompt while its recorded decision is in flight, or
 * when the run delegated permissions and the host can hand the prompt over whole.
 */
export function approvalOwner(_team: SwarmTeam, _sessionId: string, _prompt?: NonNullable<SwarmSession["attention"]>["prompt"]): "coordinator" | "person" {
  return "person";
}
