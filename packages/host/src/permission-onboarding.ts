import type { PermissionDelegationService } from "./permission-delegation.js";
import type { CoverageResult } from "./permission-delegation-types.js";
import { TeamError } from "./team-workspace.js";

/**
 * What an owner's onboarding left in the project's permission-delegation record, in host-written words.
 * `unchanged` is a repeat onboarding, which never touches the record. `unavailable` names why nothing was recorded.
 */
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

/**
 * The permission agent's part of one `repo init`.
 *
 * - An explicit off records an opt-out before the enrollment is written. If it cannot be recorded, the enrollment
 *   is not written, so a crash can never leave a project covered after the owner said off.
 * - The first enrollment of a project covers it in its workspace when the request carries a policy, and records an
 *   opt-out when it carries none (an older client's `--permissions off`). The delegation service covers a project
 *   only the first time, so an earlier revoke, opt-out or regrouping stays.
 * - A repeat enrollment calls nothing. A project enrolled before the delegation existed keeps no coverage until the
 *   owner's `permissions delegate`: its saved policy is narrower than the delegation. That holds also when its first
 *   request is replayed, because the enrollment service marks only the creating requests that it saves now.
 *
 * Every call reuses the enrollment's request id, so a replayed request replays the delegation's own receipt, and a
 * replay after a lost reply or a crash records what the first attempt could not. A failure after the enrollment was
 * written does not fail the saved enrollment: it is reported as `unavailable`.
 */
export function onboardingPermissions(delegation: Delegation | undefined, projectId: string, request: Onboarding, actor: { deviceId: string }) {
  const input = { requestId: request.requestId };
  let optedOut: CoverageResult | undefined;
  return {
    beforeWrite: request.permissionOptOut && delegation
      ? () => { optedOut = delegation.optOut(projectId, input, actor); }
      : undefined,
    /** After the enrollment was saved or replayed. `first` marks the request that created the project's enrollment. */
    after(first: boolean): OnboardingPermissionAgent {
      if (!request.permissionOptOut && !first) return { coverage: "unchanged" };
      if (!delegation) return { coverage: "unavailable", reason: DELEGATION_UNAVAILABLE };
      try {
        // A replayed request ran no hook: the opt-out it recorded the first time is replayed from its receipt.
        if (request.permissionOptOut) return outcome(optedOut ?? delegation.optOut(projectId, input, actor));
        return outcome(request.team.permissions ? delegation.coverProject(projectId, input, actor) : delegation.optOut(projectId, input, actor));
      } catch (error) {
        return { coverage: "unavailable", reason: error instanceof TeamError ? error.message : "The permission-delegation record could not be written." };
      }
    },
  };
}
