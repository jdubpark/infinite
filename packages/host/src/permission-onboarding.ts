import type { PermissionDelegationService } from "./permission-delegation.js";
import type { CoverageResult } from "./permission-delegation-types.js";
import { TeamError } from "./team-workspace.js";

export type OnboardingPermissionAgent =
  | { coverage: "covered"; workspaceId: string }
  | { coverage: "opt-out" | "not-covered" | "unchanged" }
  | { coverage: "unavailable"; reason: string };

type Delegation = Pick<PermissionDelegationService, "coverProject" | "optOut">;
type Onboarding = { requestId: string; team: { permissions?: unknown }; permissionOptOut?: true };

export const DELEGATION_UNAVAILABLE = "Permission delegation is unavailable on this host.";

const outcome = (result: CoverageResult): OnboardingPermissionAgent =>
  result.covered ? { coverage: "covered", workspaceId: result.workspaceId }
    : result.reason === "opt-out" ? { coverage: "opt-out" } : { coverage: "not-covered" };

export function onboardingPermissions(delegation: Delegation | undefined, projectId: string, request: Onboarding, actor: { deviceId: string }) {
  const input = { requestId: request.requestId };
  let optedOut: CoverageResult | undefined;
  return {
    beforeWrite: request.permissionOptOut && delegation
      ? () => { optedOut = delegation.optOut(projectId, input, actor); }
      : undefined,
    after(first: boolean): OnboardingPermissionAgent {
      if (!request.permissionOptOut && !first) return { coverage: "unchanged" };
      if (!delegation) return { coverage: "unavailable", reason: DELEGATION_UNAVAILABLE };
      try {
        if (request.permissionOptOut) return outcome(optedOut ?? delegation.optOut(projectId, input, actor));
        return outcome(request.team.permissions ? delegation.coverProject(projectId, input, actor) : delegation.optOut(projectId, input, actor));
      } catch (error) {
        return { coverage: "unavailable", reason: error instanceof TeamError ? error.message : "The permission-delegation record could not be written." };
      }
    },
  };
}
