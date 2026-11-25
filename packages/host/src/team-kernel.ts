import { ACTIVE_MEMBER_STATUSES, type TeamAssignment, type TeamMember, type TeamPermissionDecision, type TeamRun } from "./team-types.js";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Config } from "./types.js";
import type { Manager } from "./manager.js";
import { accountSettingPrompt, type Prompt } from "@infinite/attention";
import { isCollapsedPermissionPrompt, oneShotPermissionOption } from "./team-permissions.js";
import type { Stored } from "./teams.js";

/**
 * The small kernel of TeamService that its member clusters lean on. teams.ts lends it to each moved cluster; every
 * member reads the service at the time of use. It holds only what a moved cluster uses; a later slice adds its own.
 */
export type TeamKernel = {
  readonly records: Map<string, Stored>;
  readonly commands: Map<string, AbortController>;
  readonly manager: Manager;
  readonly config: Config;
  readonly closed: boolean;
  save(stored: Stored): void;
  event(stored: Stored, text: string): void;
  record(id: string): Stored;
  enqueue<T>(runId: string, task: () => T | Promise<T>): Promise<T>;
  operation<T>(stored: Stored, kind: NonNullable<Stored["pending"]>["kind"], perform: (signal: AbortSignal) => Promise<T>, complete: (value: T) => void,
    sourceMember?: TeamMember, sourceWorkspace?: "member" | "integration"): void;
  assertRunPath(stored: Stored, path: string, create?: boolean): void;
  assertBudget(run: TeamRun, addingMember?: boolean): void;
  block(stored: Stored, error: unknown, sourceMember?: TeamMember): void;
};

// Helpers that teams.ts and the moved clusters share. They live here so no moved module imports teams.ts at run time.

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const timestamp = () => new Date().toISOString();
export const activeMember = (member: TeamMember) => ACTIVE_MEMBER_STATUSES.includes(member.status);
export function permissionCoordinatorDecision(run: TeamRun, member: TeamMember) {
  const decisions = run.permissionDecisions ?? [];
  const matches = (decision: TeamPermissionDecision) =>
    decision.coordinatorMemberId === member.memberId && decision.revision === member.revision;
  return decisions.find(decision => matches(decision) && decision.coordinatorSessionId === member.sessionId)
    ?? decisions.find(decision => matches(decision) && decision.coordinatorSessionId === undefined);
}
const inactiveTeamStatuses = new Set(["cancelled", "ready-for-review", "merged", "no-change"]);
export const activeTeamRun = (status: string) => !inactiveTeamStatuses.has(status);
export const automaticRecoveryLimit = 2;
/**
 * A pull request recorded at the run's current revision. A run steered after its delivery keeps the earlier record, so
 * the owner keeps the link, and works and delivers again (INF-324). Delivery recovery keeps testing `run.pullRequest`.
 */
export const deliveredAtRevision = (run: Pick<TeamRun, "pullRequest" | "revision">) => run.pullRequest?.revision === run.revision;
/** Automatic recoveries the run has used, including those a steer took off the run with their delivery recovery record. */
export const recoveriesUsed = (run: Pick<TeamRun, "deliveryRecovery" | "recovery" | "deliveryRecoveryAttempts">) =>
  Math.max(run.deliveryRecovery?.attempts ?? 0, run.recovery?.attempts ?? 0, run.deliveryRecoveryAttempts ?? 0);
export const livePermissionRecoveryStatuses = new Set(["expanding", "diagnosing", "reviewing-evidence"]);
export const screenPermissionPrompt = (prompt: Prompt) => prompt.source === "screen" && prompt.kind === "permission" && prompt.pinned === true && Boolean(prompt.hash);
export const coordinatorPermissionPrompt = (prompt: Prompt) => !accountSettingPrompt(prompt) &&
  (oneShotPermissionOption(prompt) !== undefined || isCollapsedPermissionPrompt(prompt) || screenPermissionPrompt(prompt));
export const permissionPromptKey = (targetSessionId: string, promptId: number, promptHash: string) => `${targetSessionId}:${promptId}:${promptHash}`;
export const boundedRecoveryText = (value: string, max = 400) => [...value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("");
export function permissionRequestCount(run: TeamRun) {
  return new Set((run.permissionDecisions ?? [])
    .map(item => item.recoveryRequestId ?? run.permissionRecovery?.requests.find(request => request.revision === item.revision &&
      request.targetSessionId === item.targetSessionId && request.promptId === item.promptId)?.id ?? permissionPromptKey(item.targetSessionId, item.promptId, item.promptHash))).size;
}
// The flags are persisted on the member at creation, so a recovered or stopped session keeps the fingerprint it launched with. Text an agent reads (`agentText`) leaves out hostProfiles.
export const assignment = (member: TeamMember, agentText = false): TeamAssignment => ({ runId: member.runId, memberId: member.memberId, revision: member.revision, role: member.role, ...(member.taskId ? { taskId: member.taskId } : {}),
  ...(member.verificationRefused ? { verificationRefused: true } : {}), ...(member.entryTools ? { entryTools: true as const } : {}), ...(member.hostProfiles && !agentText ? { hostProfiles: true as const } : {}) });
export function teamRunDirectory(workspace: string) {
  const parent = dirname(workspace);
  return ["recovery", "verification"].includes(basename(parent)) ? dirname(parent) : parent;
}
export function filesystemEntryExists(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
export function terminalPermissionCoordinator(run: TeamRun, member: TeamMember) {
  if (member.role !== "permission-coordinator") return false;
  const decision = permissionCoordinatorDecision(run, member);
  return Boolean(decision && (["stale", "escalated"].includes(decision.status) ||
    decision.status === "answered" && decision.receipt?.state === "delivered" && decision.receipt.result === "closed"));
}
