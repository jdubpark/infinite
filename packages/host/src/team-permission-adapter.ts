import { createHash, randomUUID } from "node:crypto";
import type { Prompt } from "@infinite/attention";
import type { Manager } from "./manager.js";
import type { PermissionEvidence, PermissionInteractiveTarget, PermissionRequest } from "./permission-agent-types.js";
import { PERMISSION_POLICY_VERSION } from "./permission-policy.js";
import { agentAcceptOption, oneShotRejectOption, permissionAction, permissionEvidenceHash, permissionRequestShape, permissionReuseKey, refusedBeforeSend } from "./team-permissions.js";
import type { TeamAssignment, TeamMember, TeamRun, TeamScout, TeamTask } from "./team-types.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (text: string, max: number) => [...text].slice(0, max).join("");
const DELIVERY_WINDOW_MS = 60_000;

export function teamPermissionAssignment(run: Pick<TeamRun, "id">, member: { role: TeamMember["role"] | TeamAssignment["role"]; taskId?: string }): string {
  return member.taskId ? `team:${run.id}:${member.role}:task:${member.taskId}` : `team:${run.id}:${member.role}`;
}

export type TeamWorkspaceEvidence = { changedPaths: string[]; evidence: PermissionEvidence };

const workspaceDigest = (workspace: TeamWorkspaceEvidence) => digest({ changedPaths: [...workspace.changedPaths].sort(), evidence: workspace.evidence.digest });

export function memberTaskOf(run: Pick<TeamRun, "tasks" | "discovery">, taskId: string | undefined): TeamTask | TeamScout | undefined {
  if (!taskId) return undefined;
  return run.tasks.find(item => item.id === taskId) ?? run.discovery?.tasks.find(item => item.id === taskId);
}

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
    ...(prompt.hash ? { reuseKey: permissionReuseKey({
      policyHash: `permission-policy-v${PERMISSION_POLICY_VERSION}`, prompt, option: agentAcceptOption(prompt) ?? -1,
      targetTaskId: member.taskId, changedPaths: input.workspace.changedPaths,
      acceptedChecks: { acceptedChecks: input.acceptedChecks, role: member.role, sessionRoot: input.sessionRoot, evidence: input.workspace.evidence.digest },
    }) } : {}),
    evidence: structuredClone(input.workspace.evidence),
  };
}

export type TeamCheckFailure = { stale: boolean; reason: string };

export type TeamTargetDeps = {
  manager: Pick<Manager, "meta" | "state" | "answerAgentPermission"> & Partial<Pick<Manager, "invalidateTeamPermission">>;
  assignment: TeamAssignment;
  runCheck(): TeamCheckFailure | undefined;
  sessionRoot(): string;
  roleCheck?(): Promise<void>;
  task?(): { title: string; text: string } | undefined;
  workspace(): Promise<TeamWorkspaceEvidence>;
  collect?(paths: string[]): Promise<PermissionEvidence>;
  delivering?(deliveryId: string, active: boolean): void;
  signal?: AbortSignal;
  now?: () => number;
};

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
  let requested: { paths: string[]; digest: string } | undefined;
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
        if (deps.task && deps.task()?.text !== request.requester.task.text) return fail(false, "The member's task changed after the request was read.");
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
          current: () => current() && (live?.() ?? true),
        });
        return receipt.state === "delivered" && receipt.result === "closed" ? "delivered" : "uncertain";
      } catch (error) {
        if (!refusedBeforeSend(error)) return "uncertain";
        console.warn(`[Infinite] A permission agent delivery was refused before any key was sent: ${error instanceof Error ? error.message : "unknown reason"}`);
        return "refused";
      } finally { delivering = undefined; deps.delivering?.(deliveryId, false); }
    },
  };
  return target;
}
