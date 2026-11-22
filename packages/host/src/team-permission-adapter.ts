/**
 * The team-member requester adapter of the permission agent. It builds the request and the interactive
 * target for one member's pending dialog from authenticated host records only: the run, the member's
 * assignment and session, and the member's own clone as the session root. Nothing here decides.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Prompt } from "@infinite/attention";
import type { Manager } from "./manager.js";
import type { PermissionEvidence, PermissionInteractiveTarget, PermissionRequest } from "./permission-agent-types.js";
import { PERMISSION_POLICY_VERSION } from "./permission-policy.js";
import { agentAcceptOption, oneShotRejectOption, permissionAction, permissionEvidenceHash, permissionRequestShape, permissionReuseKey, refusedBeforeSend } from "./team-permissions.js";
import type { TeamAssignment, TeamMember, TeamRun, TeamScout, TeamTask } from "./team-types.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (text: string, max: number) => [...text].slice(0, max).join("");
/** How long one delivery may take from the lease to its last key. The worker refuses a key after it. */
const DELIVERY_WINDOW_MS = 60_000;

/**
 * The seat a member works in: the run and the member's task, or the run and its role when the member
 * has no task of its own. A replacement member and a new run revision keep it. Every requester adapter
 * of a team member uses this one value, so a reject lock holds across the interactive and headless paths.
 */
export function teamPermissionAssignment(run: Pick<TeamRun, "id">, member: { role: TeamMember["role"] | TeamAssignment["role"]; taskId?: string }): string {
  return member.taskId ? `team:${run.id}:${member.role}:task:${member.taskId}` : `team:${run.id}:${member.role}`;
}

/** The member's workspace evidence: its changed paths and the bounded command sources. */
export type TeamWorkspaceEvidence = { changedPaths: string[]; evidence: PermissionEvidence };

/** Binds the request to the dialog and to the workspace evidence it was collected with. */
const workspaceDigest = (workspace: TeamWorkspaceEvidence) => digest({ changedPaths: [...workspace.changedPaths].sort(), evidence: workspace.evidence.digest });

/** The member's task: the run's task, or the run's discovery scout with that id. Undefined when the member has no task id. */
export function memberTaskOf(run: Pick<TeamRun, "tasks" | "discovery">, taskId: string | undefined): TeamTask | TeamScout | undefined {
  if (!taskId) return undefined;
  return run.tasks.find(item => item.id === taskId) ?? run.discovery?.tasks.find(item => item.id === taskId);
}

/** The task a permission reviewer reads for a team member: the run objective and the task's instructions. */
export function teamPermissionTask(run: Pick<TeamRun, "title" | "objective">, task: TeamTask | TeamScout | undefined): { title: string; text: string } {
  const instructions = task && "instructions" in task ? task.instructions : undefined;
  return {
    title: bounded(task?.title ?? run.title, 200),
    text: bounded([run.objective, instructions].filter(Boolean).join("\n\n"), 8000),
  };
}

export function teamPermissionRequest(input: {
  run: TeamRun;
  member: TeamMember;
  task?: TeamTask | TeamScout;
  prompt: Prompt;
  /** The canonical path of the member's clone. */
  sessionRoot: string;
  workspace: TeamWorkspaceEvidence;
  acceptedChecks: unknown;
}): PermissionRequest {
  const { run, member, prompt, task } = input;
  const promptEvidence = permissionEvidenceHash(prompt);
  const evidenceHash = digest({ prompt: promptEvidence, workspace: workspaceDigest(input.workspace), sessionRoot: input.sessionRoot });
  const destructive = prompt.destructive ? { pattern: prompt.destructive.pattern } : undefined;
  return {
    id: `team:${member.sessionId}:${prompt.id}:${evidenceHash.slice(0, 24)}`,
    requester: {
      kind: "team-member",
      sessionId: member.sessionId,
      projectId: run.projectId,
      taskId: run.id,
      assignment: teamPermissionAssignment(run, member),
      role: member.role,
      provider: member.provider ?? run.provider,
      ...(member.modelProfile?.model ? { model: member.modelProfile.model } : {}),
      sessionRoot: input.sessionRoot,
      scratchRoots: member.scratchDirectory ? [member.scratchDirectory] : [],
      task: teamPermissionTask(run, task),
    },
    tool: prompt.tool?.name ?? "dialog",
    ...(prompt.tool?.inputComplete ? { input: structuredClone(prompt.tool.input) } : {}),
    action: permissionAction(prompt),
    prompt: structuredClone(prompt),
    ...(destructive ? { destructive } : {}),
    shape: permissionRequestShape(prompt),
    evidenceHash,
    // Today's reuse key without the run's decision limit: the policy version replaces the run's pinned policy.
    ...(prompt.hash ? { reuseKey: permissionReuseKey({
      policyHash: `permission-policy-v${PERMISSION_POLICY_VERSION}`, prompt, option: agentAcceptOption(prompt) ?? -1,
      targetTaskId: member.taskId, changedPaths: input.workspace.changedPaths,
      acceptedChecks: { acceptedChecks: input.acceptedChecks, role: member.role, sessionRoot: input.sessionRoot, evidence: input.workspace.evidence.digest },
    }) } : {}),
    evidence: structuredClone(input.workspace.evidence),
  };
}

/** A check that fails. `stale` when the request is gone or changed; otherwise the request stays with the owner. */
export type TeamCheckFailure = { stale: boolean; reason: string };

export type TeamTargetDeps = {
  manager: Pick<Manager, "meta" | "state" | "answerAgentPermission"> & Partial<Pick<Manager, "invalidateTeamPermission">>;
  assignment: TeamAssignment;
  /** The run and member as the host holds them now: authority, halt, run status, member status and revision. */
  runCheck(): TeamCheckFailure | undefined;
  /** The member's canonical clone, checked against the run's root. Throws when it cannot be resolved. */
  sessionRoot(): string;
  /** The delivery role's pinned policy and host checks. Throws when they no longer hold. */
  roleCheck?(): Promise<void>;
  /** The member's task as the run holds it now. A task that differs from the request's keeps the dialog with the owner. */
  task?(): { title: string; text: string } | undefined;
  /** Collects the member's current workspace evidence with today's bounded collection. */
  workspace(): Promise<TeamWorkspaceEvidence>;
  /**
   * Today's bounded read-only collection of source paths that the strong tier asks for, inside the member's
   * clone and scratch directory. What a decision read is read again before delivery and must be unchanged.
   */
  collect?(paths: string[]): Promise<PermissionEvidence>;
  /** Called with each delivery's id before its lease is claimed, and again when it ends, so a revoke can fence it. */
  delivering?(deliveryId: string, active: boolean): void;
  signal?: AbortSignal;
  now?: () => number;
};

/**
 * The live target for one member dialog. `check` repeats today's delivery checks: the run's authority, the
 * session's assignment and clone, the delivery policy for the delivery role, the inspected workspace
 * evidence, the exact prompt identity and evidence, and the human control lease. `answer` delivers one
 * recognised one-shot option through the manager, which repeats the exact-screen check before each key.
 */
export function teamPermissionTarget(request: PermissionRequest, deps: TeamTargetDeps): PermissionInteractiveTarget {
  const prompt = request.prompt!;
  const now = deps.now ?? Date.now;
  const sameAssignment = (left: TeamAssignment | undefined) => Boolean(left && left.runId === deps.assignment.runId &&
    left.memberId === deps.assignment.memberId && left.revision === deps.assignment.revision && left.role === deps.assignment.role &&
    left.taskId === deps.assignment.taskId);
  const fail = (stale: boolean, reason: string) => ({ ok: false as const, stale, reason });
  const workspaceMatches = (workspace: TeamWorkspaceEvidence) => digest({ prompt: permissionEvidenceHash(prompt), workspace: workspaceDigest(workspace),
    sessionRoot: request.requester.sessionRoot }) === request.evidenceHash;
  const current = () => deps.runCheck() === undefined && !deps.signal?.aborted;
  /** The source paths the decision read on request, and what they held. */
  let requested: { paths: string[]; digest: string } | undefined;
  /** The delivery that is with the manager or the worker now. */
  let delivering: string | undefined;

  const target: PermissionInteractiveTarget = {
    request,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.collect ? { collect: async (paths: string[]) => {
      const evidence = await deps.collect!(paths);
      requested = { paths: [...paths], digest: evidence.digest };
      return evidence;
    } } : {}),
    async check() {
      const run = deps.runCheck();
      if (run) return fail(run.stale, run.reason);
      if (deps.signal?.aborted) return fail(false, "The run's permission authority ended while the request was decided.");
      let root: string;
      try { root = deps.sessionRoot(); }
      catch { return fail(true, "The member's workspace could not be verified."); }
      if (root !== request.requester.sessionRoot) return fail(true, "The member's working directory changed.");
      if (deps.task) {
        // The verdict was reached for the task the request was handed with.
        let task: { title: string; text: string } | undefined;
        try { task = deps.task(); } catch { task = undefined; }
        if (!task || task.title !== request.requester.task.title || task.text !== request.requester.task.text)
          return fail(false, "The member's task changed after the request was read.");
      }
      if (deps.roleCheck) {
        try { await deps.roleCheck(); }
        catch { return fail(false, "The delivery policy, reviewed head, or required checks are no longer current."); }
      }
      try {
        if (!workspaceMatches(await deps.workspace())) return fail(true, "The inspected command sources or changed paths changed.");
      } catch { return fail(true, "The member's changed files could not be listed."); }
      if (requested && deps.collect) {
        try {
          if ((await deps.collect(requested.paths)).digest !== requested.digest) return fail(true, "A source file that the review read changed.");
        } catch { return fail(true, "The source files that the review read could not be read again."); }
      }
      try {
        const metadata = deps.manager.meta(request.requester.sessionId).session;
        if (!sameAssignment(metadata.team) || metadata.cwd !== root)
          return fail(true, "The session no longer matches its recorded assignment and working directory.");
        const state = await deps.manager.state(request.requester.sessionId, true);
        if (state.status !== "running") return fail(true, "The member session is no longer running.");
        if (state.control && state.control.expiresAt > now()) return fail(false, "A person holds input control of the session.");
        const live = state.attention.prompt;
        if (state.attention.state !== "needs-you" || !live || live.id !== prompt.id || live.hash !== prompt.hash ||
            permissionEvidenceHash(live) !== permissionEvidenceHash(prompt))
          return fail(true, "The permission dialog changed or closed.");
        const accept = agentAcceptOption(live), reject = oneShotRejectOption(live);
        return { ok: true as const, ...(accept === undefined ? {} : { accept }), ...(reject === undefined ? {} : { reject }) };
      } catch { return fail(true, "The member session could not be verified."); }
    },
    async fence() {
      if (delivering === undefined) return true;
      if (!deps.manager.invalidateTeamPermission) return false;
      return await deps.manager.invalidateTeamPermission(request.requester.sessionId, delivering) === "invalidated";
    },
    async answer(option, decisionId, notice, live) {
      const accept = agentAcceptOption(prompt), reject = oneShotRejectOption(prompt);
      const choice = notice === undefined && option === accept ? "accept" as const : notice !== undefined && option === reject ? "reject" as const : undefined;
      if (!choice) return "refused";
      // The notice is typed only after a reject option that takes text; any other reject sends none.
      const rejectOption = prompt.options.find(item => item.index === reject);
      const withNotice = choice === "reject" && rejectOption?.role === "reject-with-feedback" && prompt.acceptsText;
      const deliveryId = randomUUID();
      deps.delivering?.(deliveryId, true);
      delivering = deliveryId;
      try {
        const receipt = await deps.manager.answerAgentPermission(request.requester.sessionId, deps.assignment, {
          deliveryId, requestId: randomUUID(), choice, option, ...(withNotice ? { notice } : {}),
          prompt, evidenceHash: permissionEvidenceHash(prompt), targetCwd: request.requester.sessionRoot,
          expiresAt: new Date(now() + DELIVERY_WINDOW_MS).toISOString(), authorityHash: digest({ decisionId, requestId: request.id }),
          // The run's authority and the workspace delegation, both read again under the lease.
          current: () => current() && (live?.() ?? true),
        });
        return receipt.state === "delivered" && receipt.result === "closed" ? "delivered" : "uncertain";
      } catch (error) {
        if (!refusedBeforeSend(error)) return "uncertain";
        // Host text only: the refusal is the manager's or the worker's own reason.
        console.warn(`[Infinite] A permission agent delivery was refused before any key was sent: ${error instanceof Error ? error.message : "unknown reason"}`);
        return "refused";
      } finally { delivering = undefined; deps.delivering?.(deliveryId, false); }
    },
  };
  return target;
}
