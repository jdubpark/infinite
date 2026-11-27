import { randomUUID } from "node:crypto";
import { dirname, relative } from "node:path";
import { escalationPool, type TeamCommand, type TeamMember, type TeamModelProfile, type TeamReport, type TeamRun, type TeamScout, type TeamTask } from "./team-types.js";
import { setStoredMemberPrompt, teamDeliveryBranch, teamPromptSpec, type BuiltPrompt } from "./team-prompts.js";
import { reviewEvidenceProblems } from "./team-acceptance.js";
import { CheckOutputScanner, checkFeedback } from "./team-check-output.js";
import { metricObserver } from "./check-observations.js";
import type { RouterStart, RoutingRecorder } from "./routing-recorder.js";
import { assertTaskProfiles } from "./routing-rules.js";
import { pathField, planDigest, profileIdentity, type ReplacementCause } from "./run-events.js";
import { taskFeatures } from "./task-features.js";
import { recordedTaskLimitations } from "./team-task-limitations.js";
import { CommandStopUnconfirmed, TeamError, assertMemberReadOnly, assertMemberScope, captureDeliveryBaseline, captureMemberResult, integrateMemberResult, prepareRecoveryWorkspaceFromSource, prepareVerificationWorkspace, teamCommand, teamGitArgs, teamHead, teamOperationCommand, validateTeamPlan, type CommandResult } from "./team-workspace.js";
import { automaticRecoveryLimit, digest, recoveriesUsed, timestamp, type TeamKernel } from "./team-kernel.js";
import { ENRICH_LIMIT, isBenignEnrichError, type TeamDiagnostics } from "./team-diagnostics.js";
import { deliveryBranchMatches, deliveryInspectionHash, type DeliveryReconciliationReport } from "./team-recovery.js";
import { planRunObjective, runObjectiveNote } from "./objective-runs.js";
import { applyTeamBriefTitle, assertPlannerCapacity, plannedTasks, plannerCorrectionFeedback } from "./team-planning.js";
import { validateGoalTaskCriterionRefs } from "./team-goal-criteria.js";
import { advanceDeliveryReviewLineage, rebaseDeliveryReviewLineage, workspaceContributorFamilies } from "./delivery-review.js";
import { changeIndex, changedPathList, diffStat } from "./team-changes.js";
import { recommendationLine } from "./question-recommendation.js";
import { integrationGauge } from "./outcome-gauges.js";
import type { TeamReplay } from "./team-replay.js";
import type { TeamIntent } from "./team-intent.js";
import type { TeamVerdicts } from "./team-verdicts.js";
import type { RetentionState, Stored, TeamServiceOptions } from "./teams.js";

export const checkTimeoutReason = "A configured check ran past the team check time limit (teams.checkMinutes) and was stopped. No correction round was used; the integrated work was preserved.";
export const repeatedCheckFailureReason = "The same required verification command failed again against an unchanged integration commit. No further identical repair was attempted; inspect the check output and continue with owner direction.";
export const repairLimitReason = "The team exhausted its two correction rounds. Review the check and agent evidence before continuing manually.";
export const invalidNoChangeReason = "A no-change report is valid only before implementation tasks are planned and when the integration head is unchanged from the base.";
export const agentQuestionReason = (role: TeamMember["role"], report: Extract<TeamReport, { kind: "question" }>) =>
  `The ${role} requested an owner decision: ${report.question}${report.recommendation ? ` ${recommendationLine(report.recommendation)}` : ""}`;

export type ConsumerHost = Pick<TeamKernel, "records" | "config" | "closed" | "save" | "event" | "enqueue" | "operation" | "assertRunPath" | "assertBudget" | "block"> & {
  readonly options: TeamServiceOptions | undefined;
  readonly diag: Pick<TeamDiagnostics, "warnUnexpected" | "warnEnrichSkip">;
  readonly router: Pick<RoutingRecorder, "routeEscalation"> | undefined;
  readonly replays: Pick<TeamReplay, "consume">;
  readonly intentChecks: Pick<TeamIntent, "consume" | "hold">;
  readonly verdicts: Pick<TeamVerdicts, "consume" | "holdNoChange">;
  readonly startInProject: <T>(projectId: string, start: () => Promise<T>) => Promise<T>;
  consumePermissionCoordinator(stored: Stored, member: TeamMember): void;
  prefixFor(run: TeamRun): TeamCommand | undefined;
  applyProjectManagerCapacity(stored: Stored, requested?: number): void;
  emit(stored: Stored, kind: string, keyParts: readonly (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void;
  emitWith(stored: Stored, kind: string, keyParts: readonly (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number }, build: () => Record<string, unknown>): void;
  routerInput(run: TeamRun): Omit<RouterStart, "run" | "task">;
  newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, promptInput?: string | BuiltPrompt, pinnedProfile?: TeamModelProfile): TeamMember;
  linkReplacement(stored: Stored, next: TeamMember, previous: TeamMember, cause: ReplacementCause): void;
  prepareMember(stored: Stored, role: TeamMember["role"], task?: TeamTask | TeamScout, feedback?: string, onPrepared?: (member: TeamMember) => void): void;
  assertDelivery(stored: Stored): void;
  queueDeliveryRetryAfterEvidence(stored: Stored, member: TeamMember, report: DeliveryReconciliationReport): void;
  memberProfile(run: TeamRun, role: TeamMember["role"], task?: TeamTask | TeamScout): TeamModelProfile | undefined;
  captureApproved(stored: Stored, reviewedHead: string): void;
  captureIntegrated(stored: Stored, member: TeamMember, task: TeamTask, commit: string, head: string): void;
  retentionState(stored: Stored): RetentionState;
  retentionNow(): string;
  flushOutbox(stored: Stored, afterGap?: boolean): boolean;
  replaceCheck(stored: Stored, running: TeamRun["checks"][number], finished: TeamRun["checks"][number], observe?: () => void): Promise<void>;
  noteLeftover(stored: Stored, result: CommandResult): Promise<void>;
};

export class TeamConsumer {
  private enrichments = 0;
  constructor(private readonly host: ConsumerHost) {}
  consume(stored: Stored, member: TeamMember) {
    const run = stored.run, report = member.report!;
    if (stored.run.replay && this.host.replays.consume(stored, member)) return;
    if (member.role === "permission-coordinator") { this.host.consumePermissionCoordinator(stored, member); return; }
    if (member.role === "intent-checker") { this.host.intentChecks.consume(stored, member); return; }
    if (member.role === "evaluator") { this.host.verdicts.consume(stored, member); return; }
    if (report.kind === "blocked") { this.host.block(stored, new TeamError(409, "agent-blocked", report.summary), member); return; }
    if (report.kind === "question" && ["implementer", "scout", "integrator", "reviewer"].includes(member.role)) {
      this.host.block(stored, new TeamError(409, "agent-question", agentQuestionReason(member.role, report)), member); return;
    }
    if (report.kind === "question") {
      if (run.decisions.length >= 40) { this.host.block(stored, new TeamError(409, "team-decision-limit", "The team reached its limit of 40 decisions. Review its evidence before starting another team.")); return; }
      member.status = "waiting";
      run.decisions.push({ id: randomUUID(), memberId: member.memberId, revision: run.revision, question: report.question, options: report.options,
        ...(report.answerMode ? { answerMode: report.answerMode } : {}), ...(report.recommendation ? { recommendation: { ...report.recommendation } } : {}), createdAt: timestamp() });
      const task = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId) : run.tasks.find(item => item.id === member.taskId); if (task) task.status = "waiting";
      run.status = "needs-input"; this.host.event(stored, `${member.title} requested a user decision.`); this.host.save(stored); return;
    }
    const expected = member.role === "project-manager" ? ["plan", "explore", "no-change"] : member.role === "scout" ? ["findings"] : member.role === "reviewer" ? ["review"] : member.role === "delivery" ? ["delivery", "delivery-repair", "delivery-reconciliation", "pull-request"] : member.role === "implementer" ? ["result", "escalate"] : ["result"];
    if (!expected.includes(report.kind)) { this.host.block(stored, new TeamError(409, "wrong-agent-report", "An agent's report does not match its assigned role."), member); return; }
    if (report.kind === "no-change") {
      if (this.host.verdicts.holdNoChange(stored, member)) return;
      if (member.role !== "project-manager" || run.tasks.length || run.headCommit !== run.baseCommit) {
        this.host.block(stored, new TeamError(409, "invalid-no-change", invalidNoChangeReason), member); return;
      }
      this.host.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefixFor(run), signal);
        await assertMemberReadOnly(run.workspace, run.headCommit!, this.host.prefixFor(run), signal, "integration");
      }, () => {
        run.noChange = { summary: report.summary, evidence: report.evidence }; run.status = "no-change"; run.reason = undefined;
        if (run.recovery) run.recovery.status = "complete";
        this.host.event(stored, "The coordinator reported no justified change and recorded its evidence. No implementation was started.");
      }, member); return;
    }
    if (report.kind === "explore") {
      if (run.discovery || run.tasks.length || !run.lineup) throw new TeamError(409, "discovery-already-used", "A team may request one read-only discovery batch before implementation planning.");
      if (new Set(report.tasks.map(task => task.id)).size !== report.tasks.length) throw new TeamError(409, "invalid-discovery", "Discovery task IDs must be unique.");
      assertTaskProfiles(run, report.tasks, "scouts");
      assertPlannerCapacity(run, report.parallelism);
      this.host.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefixFor(run), signal), () => {
        this.host.applyProjectManagerCapacity(stored, report.parallelism);
        run.discovery = { revision: run.revision, summary: report.summary, tasks: report.tasks.map(task => ({ ...task, status: "pending" })) };
        run.status = "discovering";
        this.host.event(stored, `The coordinator requested ${report.tasks.length} read-only discovery tasks.`);
        const map = (run.handoff?.project ?? this.host.config.projects.find(project => project.id === run.projectId)?.team)?.features;
        this.host.emitWith(stored, "discovery.accepted", [member.revision], { memberId: member.memberId, revision: member.revision }, () => ({
          parallelism: run.parallelism,
          scouts: (run.discovery?.tasks ?? []).map(scout => ({
            taskId: scout.id, ...(scout.agentProfileId === undefined ? {} : { profileId: scout.agentProfileId }), features: taskFeatures({ role: "scout", paths: [] }, map),
          })),
        }));
      }, member); return;
    }
    if (report.kind === "findings") {
      const scout = run.discovery?.tasks.find(task => task.id === member.taskId && task.memberId === member.memberId);
      if (!scout || run.discovery?.revision !== run.revision) throw new TeamError(409, "invalid-discovery", "The scout does not belong to the current discovery batch.");
      this.host.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefixFor(run), signal), () => {
        scout.status = "complete"; scout.summary = report.summary; scout.evidence = report.evidence;
        this.host.event(stored, `${member.title} returned evidence without changing its working copy.`);
        this.host.emitWith(stored, "scout.completed", [member.revision, scout.id], { memberId: member.memberId, taskId: scout.id, revision: member.revision }, () => ({}));
      }, member); return;
    }
    if (report.kind === "escalate") {
      const task = run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId);
      const named = escalationPool(run).find(item => item.id === report.agentProfileId && item.id !== member.modelProfile?.id);
      const profile = !task || task.escalation || (report.agentProfileId !== undefined && !named) || !run.routing || !this.host.router ? named
        : this.host.router.routeEscalation({ ...this.host.routerInput(run), run, task, ownProfileId: member.modelProfile?.id, namedProfileId: named?.id }) ?? named;
      if (!task || task.escalation || !profile || profile.id === member.modelProfile?.id)
        throw new TeamError(409, "invalid-escalation", "An implementer may escalate once to a different profile in the approved escalation pool.");
      this.host.operation(stored, "result", signal => assertMemberScope(member.cwd, member.baseCommit, task.paths, this.host.prefixFor(run), signal), () => {
        task.escalation = { ...(member.modelProfile ? { fromProfileId: member.modelProfile.id } : {}), toProfileId: profile.id, reason: report.reason, memberId: member.memberId, at: timestamp() };
        this.host.emitWith(stored, "task.escalated", [member.revision, task.id], { memberId: member.memberId, taskId: task.id, revision: member.revision }, () => ({
          fromProfileId: task.escalation?.fromProfileId, toProfileId: task.escalation?.toProfileId,
        }));
        const next = this.host.newMember(run, "implementer", member.cwd, member.baseCommit, task.id, undefined, profile), escalationNote = `The previous implementer requested escalation: ${report.reason}. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.`;
        next.contextFeedback = [member.contextFeedback ?? member.prompt, escalationNote].filter(Boolean).join("\n\n");
        setStoredMemberPrompt(stored, next, teamPromptSpec(run, "implementer", task, escalationNote, next.provider ?? run.provider, next.modelProfile));
        run.members.push(next); this.host.linkReplacement(stored, next, member, "escalation"); task.memberId = next.memberId; task.status = "running";
        run.status = "implementing";
        this.host.event(stored, `${task.title} escalated to ${profile.label}; the stopped member's partial work was preserved.`);
      }, member); return;
    }
    if (report.kind === "plan") {
      validateTeamPlan(report.tasks);
      try { validateGoalTaskCriterionRefs(report.tasks, member.goalCriteriaPlan, run.goal?.record); }
      catch (error) {
        if (!(error instanceof TeamError) || error.code !== "goal-task-criteria-invalid" || !run.goal?.record || stored.goalPlanCorrectionRevision === run.revision) throw error;
        stored.goalPlanCorrectionRevision = run.revision;
        this.host.event(stored, `The plan needs corrected objective links. ${error.message}`);
        this.host.prepareMember(stored, "project-manager", undefined, plannerCorrectionFeedback(run, error.message));
        this.host.save(stored); return;
      }
      assertTaskProfiles(run, report.tasks, "plan");
      assertPlannerCapacity(run, report.parallelism);
      if (report.verification && !run.establishChecks && !run.verification) {
        if (run.verificationCorrections?.includes(run.revision)) {
          this.host.block(stored, new TeamError(409, "verification-not-authorized", "A plan cannot replace the project's configured checks."));
          return;
        }
        run.verificationCorrections = [...(run.verificationCorrections ?? []), run.revision];
        const message = "Plan rejected: this run uses the project's configured checks. Remove verification and submit a corrected plan. If the checks seem insufficient, explain that in the summary and assign tasks to run additional commands themselves and report results.";
        this.host.event(stored, "The project manager's plan included unauthorized verification; requesting a corrected plan.");
        this.host.save(stored);
        this.host.prepareMember(stored, "project-manager", undefined, plannerCorrectionFeedback(run, message));
        return;
      }
      const tasks = plannedTasks(run, report, member.revision);
      this.host.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefixFor(run), signal), () => {
        if (this.host.intentChecks.hold(stored, member)) return;
        this.host.applyProjectManagerCapacity(stored, report.parallelism);
        run.tasks = tasks;
        applyTeamBriefTitle(run, report.brief, member.revision);
        if (report.verification && !run.verification) {
          run.verification = structuredClone(report.verification);
          this.host.event(stored, "The coordinator established verification commands under the owner's project opt-in.");
        }
        run.status = "implementing";
        const objectiveNote = runObjectiveNote(stored, planRunObjective(stored, member.memberId, timestamp())); if (objectiveNote) this.host.event(stored, objectiveNote);
        this.host.event(stored, `Project manager planned ${run.tasks.length} tasks.`);
        const map = (run.handoff?.project ?? this.host.config.projects.find(project => project.id === run.projectId)?.team)?.features;
        this.host.emitWith(stored, "plan.accepted", [member.revision], { memberId: member.memberId, revision: member.revision }, () => ({
          taskCount: run.tasks.length, planDigest: planDigest(run.tasks), parallelism: run.parallelism,
        }));
        for (const task of run.tasks) this.host.emitWith(stored, "task.planned", [member.revision, task.id], { taskId: task.id, revision: member.revision }, () => ({
          profileId: task.agentProfileId,
          ...(task.criterionRefs && { criterionRefs: task.criterionRefs }),
          ...pathField(task.paths),
          features: taskFeatures({ role: "implementer", paths: task.paths, kind: task.kind, risk: task.risk }, map),
        }));
      }, member); return;
    }
    if (report.kind === "delivery-reconciliation") {
      const { run } = stored;
      const attempt = stored.deliveryAttempt;
      if (!run.delivery || report.repository !== run.delivery.repository || !deliveryBranchMatches(run, report.branch) ||
          report.headCommit !== run.headCommit || member.baseCommit !== run.headCommit || attempt?.memberId !== member.memberId ||
          attempt.revision !== run.revision || attempt.headCommit !== run.headCommit ||
          run.deliveryRecovery && (run.deliveryRecovery.status !== "planning" || run.deliveryRecovery.revision !== run.revision ||
            run.deliveryRecovery.headCommit !== run.headCommit || run.deliveryRecovery.policyHash !== digest(run.delivery)))
        throw new TeamError(409, "delivery-reconciliation-stale", "Structured delivery inspection must identify the current pinned repository, branch, and reviewed head for this attempt.");
      this.host.assertDelivery(stored);
      if (report.disposition === "no-publication" && (report.remoteHeadCommit !== undefined || report.pullRequestUrl !== undefined) ||
          report.disposition === "owned-branch" && (report.remoteHeadCommit !== report.headCommit || report.pullRequestUrl !== undefined) ||
          report.disposition === "pull-request" && (report.remoteHeadCommit !== report.headCommit || !report.pullRequestUrl))
        throw new TeamError(409, "delivery-remote-head-mismatch", "The inspected remote branch or pull request does not identify the exact reviewed head.");
      if (run.pullRequest && (report.disposition !== "pull-request" || report.pullRequestUrl?.toLowerCase() !== run.pullRequest.pullRequestUrl.toLowerCase()))
        throw new TeamError(409, "delivery-pull-request-recorded", "This run delivers only to its recorded pull request; report that pull request at the reviewed head, or report blocked.");
      if (report.disposition === "pull-request") {
        const reconciliationPullRequestUrl = report.pullRequestUrl;
        if (!reconciliationPullRequestUrl) throw new TeamError(409, "delivery-target-mismatch", "The inspected pull request URL is missing.");
        let url: URL;
        try { url = new URL(reconciliationPullRequestUrl); } catch { throw new TeamError(409, "delivery-target-mismatch", "The inspected pull request URL is invalid."); }
        const prefix = `/${run.delivery.repository}/pull/`.toLowerCase();
        if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !url.pathname.toLowerCase().startsWith(prefix) || !/^[1-9][0-9]*$/.test(url.pathname.slice(prefix.length)))
          throw new TeamError(409, "delivery-target-mismatch", "The inspected pull request must belong to the configured repository.");
      }
      this.host.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefixFor(run), signal);
        await assertMemberReadOnly(run.workspace, member.baseCommit, this.host.prefixFor(run), signal, "integration");
        if (report.disposition !== "no-publication" || report.baseHeadCommit === run.baseCommit) return undefined;
        if (run.goal || run.missionId || run.handoff)
          throw new TeamError(409, "delivery-baseline-parent-owned", "A moved-base delivery recovery requires standalone ownership; preserve this parent branch for explicit reconciliation.");
        const source = this.host.options?.source;
        if (!source?.isGithub(run.projectId))
          throw new TeamError(409, "delivery-baseline-source-unavailable", "The host cannot confirm the moved delivery base from its configured GitHub source.");
        this.host.assertBudget(run, true);
        const attempts = recoveriesUsed(run);
        if (attempts >= automaticRecoveryLimit)
          throw new TeamError(409, "delivery-recovery-exhausted", "The team exhausted its automatic delivery recovery allowance. Its reviewed work and remote evidence remain retained.");
        run.deliveryRecovery = { ...run.deliveryRecovery, attempts: attempts + 1, status: "planning", revision: run.revision,
          headCommit: report.headCommit, policyHash: digest(run.delivery!), sourceMemberId: member.memberId,
          baseHeadCommit: report.baseHeadCommit, disposition: report.disposition };
        run.recovery = { attempts: attempts + 1, status: "planning", source: { code: "delivery-baseline-conflict", memberId: member.memberId,
          revision: run.revision, reportKind: report.kind, reason: report.summary, at: timestamp() } };
        this.host.save(stored);
        const refreshed = await this.host.startInProject(run.projectId, () => source.refresh(run.projectId, { maxAgeMs: 0, signal }));
        if (refreshed.mode !== "github" || refreshed.repository !== run.delivery!.repository || refreshed.baseBranch !== run.delivery!.baseBranch ||
            refreshed.pending?.reason === "fetch-failed" || refreshed.mirrorHead !== report.baseHeadCommit)
          throw new TeamError(409, "delivery-baseline-source-mismatch", "The host could not confirm the exact reported base head from the pinned source repository and branch.");
        const originalWorkspace = run.workspace;
        const recovered = await prepareRecoveryWorkspaceFromSource(originalWorkspace, source.mirrorPath(run.projectId), randomUUID(), report.baseHeadCommit,
          this.host.prefixFor(run), signal, run.branch);
        this.host.assertRunPath(stored, recovered.workspace);
        await assertMemberReadOnly(recovered.workspace, report.baseHeadCommit, this.host.prefixFor(run), signal, "integration");
        if (await teamHead(originalWorkspace, this.host.prefixFor(run), signal) !== report.headCommit)
          throw new TeamError(409, "delivery-recovery-head-changed", "The original integration head changed while its fresh-base recovery copy was prepared.");
        return { workspace: recovered.workspace, originalWorkspace, baseHeadCommit: report.baseHeadCommit };
      }, result => {
        if (report.disposition === "pull-request" && run.delivery?.mode === "pr") {
          stored.deliveryAttempt = undefined;
          run.pullRequest = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl!, summary: report.summary, reportedAt: timestamp(), ...(run.pullRequest && !run.pullRequest.branch ? {} : { branch: report.branch }) };
          this.host.emitWith(stored, "delivery.recorded", [member.revision, member.memberId], { memberId: member.memberId, revision: member.revision }, () => ({
            method: "pull-request", headCommit: report.headCommit }));
          run.status = "ready-for-review"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          if (run.deliveryRecovery) run.deliveryRecovery.status = "complete";
          this.host.event(stored, "The delivery coordinator reported an existing pull request for the exact reviewed head. Its repository state remains agent evidence; the owner can review it on GitHub.");
          return;
        }
        if (result) {
          const previousRevision = run.revision, oldBase = run.baseCommit, oldHead = run.headCommit!;
          const originalPath = relative(stored.root ?? this.host.config.teams?.workspaceDir ?? dirname(result.originalWorkspace), result.originalWorkspace).slice(0, 256);
          delete run.changes;
          for (const task of run.tasks) delete task.changedPaths;
          for (const continuation of run.continuations ?? []) for (const task of continuation.tasks) delete task.changedPaths;
          run.continuations = [...(run.continuations ?? []), {
            revision: previousRevision, requestId: randomUUID(), at: timestamp(),
            reason: "The delivery coordinator reported no publication after the configured base moved; original implementation and review history are retained.",
            baseCommit: oldBase, headCommit: oldHead, tasks: structuredClone(run.tasks), ...(run.review ? { review: structuredClone(run.review) } : {}),
            ...(run.brief ? { brief: structuredClone(run.brief) } : {}),
          }];
          run.workspace = result.workspace; run.baseCommit = result.baseHeadCommit; run.headCommit = result.baseHeadCommit;
          stored.deliveryReviewLineage = rebaseDeliveryReviewLineage(stored.deliveryReviewLineage, oldHead, result.baseHeadCommit);
          run.revision++; run.tasks = []; run.review = undefined; run.round = 0; stored.checkHead = undefined;
          this.host.emit(stored, "run.revision-advanced", [run.revision], {}, { cause: "moved-base", fromRevision: previousRevision, baseChanged: true });
          run.brief = undefined; run.noChange = undefined; stored.deliveryAttempt = undefined;
          const attempts = run.deliveryRecovery?.attempts ?? run.recovery?.attempts ?? 0;
          run.deliveryRecovery = { attempts, status: "replanning", revision: run.revision, headCommit: run.headCommit,
            policyHash: digest(run.delivery!), sourceMemberId: member.memberId, baseHeadCommit: result.baseHeadCommit, disposition: report.disposition };
          run.recovery = { attempts, status: "planning", source: { code: "delivery-baseline-conflict", memberId: member.memberId, revision: previousRevision,
            reportKind: report.kind, reason: report.summary, at: timestamp() } };
          const feedback = [
            "The delivery coordinator reported that nothing was published and the pinned base branch moved. The host refreshed the configured source and created this clean workspace at the exact reported base head.",
            `The original integration copy is preserved at ${result.originalWorkspace} (workspace path ${originalPath}). Read its diff from ${oldBase} to ${oldHead} without changing it; the implementation and review were not carried into this new workspace automatically.`,
            "Reconcile only the original approved changes into this workspace. Preserve both sides of any conflicting documentation or code rather than dropping either. Keep the existing objective and goal scope. Report only work actually applied; the host will capture and integrate it, then rerun configured checks and independent review before another delivery attempt.",
          ].join("\n\n");
          this.host.prepareMember(stored, "integrator", undefined, feedback);
          run.status = "planning"; run.reason = undefined; run.blockCode = undefined;
          this.host.event(stored, `The configured base moved to ${result.baseHeadCommit}; the old implementation copy remains preserved at ${originalPath}. An integrator must carry the authorized delta into the new base before checks and review run again.`);
          return;
        }
        this.host.queueDeliveryRetryAfterEvidence(stored, member, report);
      }, member); return;
    }
    if (report.kind === "delivery" || report.kind === "delivery-repair" || report.kind === "pull-request") {
      if ((report.kind === "delivery" && run.delivery?.mode !== "merge") || (report.kind === "pull-request" && run.delivery?.mode !== "pr"))
        throw new TeamError(409, "delivery-mode-mismatch", "The delivery report kind does not match the configured delivery mode.");
      this.host.assertDelivery(stored);
      if (report.headCommit !== run.headCommit || member.baseCommit !== run.headCommit || stored.deliveryAttempt?.memberId !== member.memberId)
        throw new TeamError(409, "stale-delivery", "Delivery evidence must name the checked and independently reviewed commit for this attempt.");
      if (run.deliveryRecovery && (run.deliveryRecovery.status !== "planning" || run.deliveryRecovery.revision !== run.revision ||
          run.deliveryRecovery.headCommit !== run.headCommit || run.deliveryRecovery.policyHash !== digest(run.delivery)))
        throw new TeamError(409, "delivery-recovery-stale", "The active automatic recovery no longer matches the delivery policy, revision, and reviewed head.");
      if (report.kind === "delivery" || report.kind === "pull-request") {
        let url: URL;
        try { url = new URL(report.pullRequestUrl); } catch { throw new TeamError(409, "delivery-target-mismatch", "The delivery report must name a valid pull request URL."); }
        const prefix = `/${run.delivery!.repository}/pull/`.toLowerCase();
        if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !url.pathname.toLowerCase().startsWith(prefix) || !/^[1-9][0-9]*$/.test(url.pathname.slice(prefix.length)))
          throw new TeamError(409, "delivery-target-mismatch", "The pull request must belong to the configured repository.");
        if (report.kind === "pull-request" && run.pullRequest && report.pullRequestUrl.toLowerCase() !== run.pullRequest.pullRequestUrl.toLowerCase())
          throw new TeamError(409, "delivery-target-mismatch", "A continued delivery updates the run's recorded pull request; it cannot open another.");
      }
      this.host.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefixFor(run), signal);
        await assertMemberReadOnly(run.workspace, member.baseCommit, this.host.prefixFor(run), signal, "integration");
        if (report.kind === "delivery") {
          await this.host.enqueue(stored.run.id, () => {
            if (this.host.closed) return;
            run.deliveryReceipt = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl, mergeCommit: report.mergeCommit, summary: report.summary, reportedAt: timestamp() };
            this.host.emitWith(stored, "delivery.recorded", [member.revision, member.memberId], { memberId: member.memberId, revision: member.revision }, () => ({
              method: "merge", headCommit: report.headCommit, mergeCommit: report.mergeCommit }));
            this.host.save(stored);
          });
          await captureDeliveryBaseline(run.workspace, member.cwd, member.baseCommit, report.mergeCommit, this.host.prefixFor(run), signal);
        }
      }, () => {
        if (report.kind === "delivery-repair") {
          const recovery = run.deliveryRecovery;
          const inspected = recovery?.lastEvidenceHash && run.members.some(prior => prior.role === "delivery" && prior.status === "stopped" &&
            prior.revision === run.revision && prior.report?.kind === "delivery-reconciliation" && prior.report.headCommit === report.headCommit &&
            prior.report.repository === run.delivery!.repository && deliveryBranchMatches(run, prior.report.branch) &&
            deliveryInspectionHash(prior.report) === recovery.lastEvidenceHash);
          if (recovery && recovery.attempts > 0 && recovery.status !== "complete" && !inspected)
            throw new TeamError(409, "delivery-reconciliation-required", "An automatic recovery requires structured remote evidence before a delivery repair can change the reviewed head.");
          stored.deliveryAttempt = undefined;
          this.repair(stored, `Delivery requires a scoped repair before checks and independent review run again. No merge was reported.\n${report.summary}`, "delivery");
        } else if (report.kind === "pull-request") {
          stored.deliveryAttempt = undefined;
          run.pullRequest = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl, summary: report.summary, reportedAt: timestamp(), ...(run.pullRequest && !run.pullRequest.branch ? {} : { branch: teamDeliveryBranch(run) }) };
          this.host.emitWith(stored, "delivery.recorded", [member.revision, member.memberId], { memberId: member.memberId, revision: member.revision }, () => ({
            method: "pull-request", headCommit: report.headCommit }));
          run.status = "ready-for-review"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          if (run.deliveryRecovery) run.deliveryRecovery.status = "complete";
          this.host.event(stored, "The delivery agent reported an open pull request for the reviewed commit. Review and merge it on GitHub; the host refreshes the project after the merge.");
        } else {
          stored.deliveryAttempt = undefined;
          run.status = "merged"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          if (run.deliveryRecovery) run.deliveryRecovery.status = "complete";
          this.host.event(stored, "The delivery agent reported a merged pull request for the reviewed commit. This is agent-reported delivery evidence, not proof of product impact.");
          try { this.host.options?.onMerged?.(run.projectId); } catch (error) { this.host.diag.warnUnexpected("on-merged", error); }
        }
      }, member); return;
    }
    if (report.kind === "review") {
      if (member.baseCommit !== run.headCommit || stored.checkHead !== run.headCommit) { this.host.block(stored, new TeamError(409, "stale-review", "The reviewer did not review the currently verified integration commit.")); return; }
      const evidenceProblems = reviewEvidenceProblems(run.brief, report);
      if (evidenceProblems.length) {
        const problem = evidenceProblems.map(item => item.message).join(" ");
        if (run.reviewCorrections?.includes(run.revision)) { this.host.block(stored, new TeamError(409, evidenceProblems[0]!.code, problem)); return; }
        run.reviewCorrections = [...(run.reviewCorrections ?? []), run.revision];
        this.host.event(stored, "The reviewer's evidence was missing or invalid; requesting a corrected review."); this.host.save(stored);
        this.host.prepareMember(stored, "reviewer", undefined, `Review rejected: ${problem}\n${evidenceProblems.map(item => item.rule).join("\n")}`); return;
      }
      this.host.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefixFor(run), signal);
      }, () => {
        run.review = { verdict: report.verdict, summary: report.summary, revision: run.revision, ...(report.uiEvidence ? { uiEvidence: report.uiEvidence } : {}), ...(report.acceptance ? { acceptance: report.acceptance } : {}) };
        stored.deliveryReviewApproval = report.verdict === "approved" ? { reviewerMemberId: member.memberId, revision: member.revision, round: run.round, headCommit: member.baseCommit } : undefined;
        const rubricKept: { taskId: string; correctness: number; cleanliness: number; extensibility: number; docs: number }[] = [];
        if (report.verdict === "approved" && report.rubric?.length) {
          const reviewer = member.modelProfile ?? this.host.memberProfile(run, "reviewer");
          for (const entry of report.rubric) {
            const task = run.tasks.find(item => item.id === entry.taskId && item.status === "integrated");
            if (!task) continue;
            const implementer = run.members.find(candidate => candidate.memberId === task.memberId)?.modelProfile;
            if (reviewer && implementer && reviewer.model === implementer.model) {
              this.host.event(stored, `The rubric for task ${task.id} was dropped because reviewer and implementer use the same model.`);
              continue;
            }
            task.rubric = { version: 1, correctness: entry.correctness, cleanliness: entry.cleanliness, extensibility: entry.extensibility, docs: entry.docs, reviewerProfileId: reviewer?.id ?? "unknown" };
            rubricKept.push({ taskId: task.id, correctness: entry.correctness.score, cleanliness: entry.cleanliness.score, extensibility: entry.extensibility.score, docs: entry.docs.score });
          }
        }
        this.host.emitWith(stored, "review.recorded", [member.revision, member.memberId], { memberId: member.memberId, revision: member.revision }, () => {
          const reviewer = member.modelProfile ?? this.host.memberProfile(run, "reviewer");
          return { verdict: report.verdict, headCommit: member.baseCommit, baseCommit: run.baseCommit,
            reviewer: profileIdentity(reviewer, member.provider ?? run.provider), rubric: rubricKept.length ? rubricKept : undefined,
            acceptance: report.acceptance?.map(({ criterion, verdict }) => ({ criterion, verdict })) };
        });
        if (report.verdict === "approved") this.host.captureApproved(stored, member.baseCommit);
        if (report.verdict === "changes-requested") {
          for (const task of run.tasks) if (task.status === "integrated") task.reviewRounds = (task.reviewRounds ?? 0) + 1;
          this.repair(stored, report.summary, "review");
        }
        else run.status = "reviewing";
        const reviewed = { revision: member.revision, memberId: member.memberId, headCommit: member.baseCommit };
        this.enrich(stored, async signal => {
          const tree = await this.readTree(run, reviewed.headCommit, signal);
          return tree === undefined ? undefined : () => this.host.emitWith(stored, "review.tree", [reviewed.revision, reviewed.memberId],
            { memberId: reviewed.memberId, revision: reviewed.revision }, () => ({ headCommit: reviewed.headCommit, tree }));
        });
      }, member); return;
    }
    if (report.kind !== "result") throw new TeamError(409, "wrong-agent-report", "The member did not submit an implementation result.");
    const task = run.tasks.find(item => item.id === member.taskId);
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    run.status = "integrating";
    this.host.operation(stored, "result", async signal => {
      const commit = await captureMemberResult(member.cwd, member.baseCommit, member.role === "implementer" ? task!.paths : run.goal?.allowedPaths, this.host.prefixFor(run), signal);
      const head = commit ? (run.replay ? commit : await integrateMemberResult(run.workspace, member.cwd, commit, this.host.prefixFor(run), signal)) : run.headCommit!;
      const diff = commit ? await teamCommand({ command: "git", args: teamGitArgs(run.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "-z", member.baseCommit, commit, "--"]) }, run.workspace, signal, 30000, this.host.prefixFor(run)).catch(() => undefined) : undefined;
      const gitRead = (args: string[]) => teamCommand({ command: "git", args: teamGitArgs(run.workspace, args) }, run.workspace, signal, 30000, this.host.prefixFor(run))
        .then(result => result.exitCode === 0 && !result.interrupted && !result.truncated ? result.stdout : undefined, () => undefined);
      const change = commit ? {
        nameStatus: await gitRead(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-M", "-z", run.baseCommit, head, "--"]),
        numstat: await gitRead(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-M", "-z", run.baseCommit, head, "--"]),
        taskPaths: task ? await gitRead(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", member.baseCommit, commit, "--"]) : undefined,
      } : undefined;
      return { commit, head, diff: diff?.exitCode === 0 ? diff.stdout : undefined,
        changes: change ? changeIndex(change.nameStatus, change.numstat, head, timestamp()) : undefined,
        changedPaths: change?.taskPaths !== undefined ? changedPathList(change.taskPaths) : undefined };
    }, ({ commit, head, diff, changes, changedPaths }) => {
      const headBefore = run.headCommit;
      stored.deliveryReviewLineage = advanceDeliveryReviewLineage(stored.deliveryReviewLineage, { headBefore: headBefore ?? "", headAfter: head,
        contributorFamilies: commit ? workspaceContributorFamilies(run, member) : [] });
      run.headCommit = head; stored.checkHead = undefined; run.review = undefined;
      if (commit) { if (changes) run.changes = changes; else delete run.changes; }
      if (member.role === "integrator" && run.deliveryRecovery?.status === "replanning" && run.deliveryRecovery.revision === run.revision)
        run.deliveryRecovery.integratedHeadCommit = head;
      if (task) {
        task.status = "integrated"; task.commit = commit; task.summary = report.summary; task.limitations = recordedTaskLimitations(report); task.diffStat = diffStat(diff);
        if (changedPaths) task.changedPaths = changedPaths; else delete task.changedPaths;
        this.host.emitWith(stored, "task.integrated", [member.revision, task.id], { memberId: member.memberId, taskId: task.id, revision: member.revision }, () => ({
          commit, headCommit: head, baseCommit: run.baseCommit, memberBaseCommit: member.baseCommit, diff: task.diffStat,
          integration: integrationGauge({ tasks: run.tasks, taskId: task.id, memberBase: member.baseCommit, headBefore, changedPaths: task.changedPaths ?? (commit ? undefined : { paths: [], truncated: false }) }),
        }));
        if (commit && member.role === "implementer" && !run.replay) this.host.captureIntegrated(stored, member, task, commit, head);
      }
      if (member.role === "integrator" && run.round > 0) {
        this.host.emitWith(stored, "repair.integrated", [member.revision, run.round], { memberId: member.memberId, revision: member.revision }, () => ({
          round: run.round, commit, headCommit: head, baseCommit: run.baseCommit,
        }));
        const repaired = { revision: member.revision, memberId: member.memberId, round: run.round, base: member.baseCommit, workspace: run.workspace };
        if (commit) this.enrich(stored, async signal => {
          const result = await teamCommand({ command: "git", args: teamGitArgs(repaired.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", repaired.base, commit, "--"]) },
            repaired.workspace, signal, 30000, this.host.prefixFor(run)).catch(() => undefined);
          const list = result && result.exitCode === 0 && !result.interrupted ? changedPathList(result.stdout) : undefined;
          return () => this.host.emitWith(stored, "repair.paths", [repaired.revision, repaired.round], { memberId: repaired.memberId, revision: repaired.revision }, () => ({
            round: repaired.round, commit, ...(list && !list.truncated ? pathField(list.paths) : { pathsOmitted: true }),
          }));
        });
      }
      if (member.role === "implementer" || member.role === "integrator") this.host.retentionState(stored).integratedAt[member.memberId] = this.host.retentionNow();
      this.host.event(stored, `${member.title} reported a result; its validated changes were integrated.`);
      run.status = "implementing";
    }, member, "integration");
  }
  repair(stored: Stored, feedback: string, cause: "check" | "review" | "delivery") {
    if (stored.halt || ["paused", "cancelled"].includes(stored.run.status)) return;
    if (stored.run.round >= 2) { this.host.block(stored, new TeamError(409, "repair-limit", repairLimitReason)); return; }
    stored.run.round++; stored.run.review = undefined; stored.checkHead = undefined;
    const round = stored.run.round;
    this.host.emitWith(stored, "repair.started", [stored.run.revision, round], {}, () => ({ round, cause, headCommit: stored.run.headCommit }));
    this.host.prepareMember(stored, "integrator", undefined, feedback);
  }
  requiredChecks(run: TeamRun) {
    return run.establishChecks ? run.verification?.checks : run.handoff?.project.checks ?? this.host.config.projects.find(project => project.id === run.projectId)?.team?.checks;
  }
  verificationCommands(run: TeamRun) {
    const required = this.requiredChecks(run);
    if (!required?.length) return [];
    const configuredProject = run.handoff?.project ?? this.host.config.projects.find(project => project.id === run.projectId)?.team;
    const setup = run.establishChecks ? run.verification?.setup : configuredProject?.setup;
    const commands: { command: { command: string; args: string[] }; phase?: "setup" }[] = [];
    if (setup) commands.push({ command: setup, phase: "setup" });
    commands.push(...required.map(command => ({ command })));
    return commands;
  }
  enrich(stored: Stored, read: (signal: AbortSignal) => Promise<(() => void) | undefined>): void {
    if (!this.host.options?.events) return;
    if (this.enrichments >= ENRICH_LIMIT) { this.host.diag.warnEnrichSkip(); return; }
    this.enrichments += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    timer.unref();
    void (async () => {
      try {
        const emit = await read(controller.signal);
        if (!emit || this.host.closed || this.host.records.get(stored.run.id) !== stored) return;
        emit();
        this.host.flushOutbox(stored);
      } catch (error) { if (!isBenignEnrichError(error, controller.signal.aborted, this.host.closed)) this.host.diag.warnUnexpected("enrich", error); }
      finally { clearTimeout(timer); this.enrichments -= 1; }
    })();
  }
  async readTree(run: TeamRun, commit: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const result = await teamCommand({ command: "git", args: teamGitArgs(run.workspace, ["rev-parse", "--verify", `${commit}^{tree}`]) }, run.workspace, signal, 30000, this.host.config.teams?.commandPrefix);
      const tree = result.exitCode === 0 && !result.interrupted ? result.stdout.trim() : "";
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree) ? tree : undefined;
    } catch (error) { if (!isBenignEnrichError(error, signal.aborted, this.host.closed)) this.host.diag.warnUnexpected("read-tree", error); return undefined; }
  }
  check(stored: Stored) {
    const run = stored.run, revision = run.revision, head = run.headCommit!;
    const required = this.requiredChecks(run);
    if (!required?.length) throw new TeamError(409, "verification-required", "Required verification commands have not been established; the team cannot be ready for review.");
    const commands = this.verificationCommands(run).map((entry, index) => ({ ...entry, context: index === 0 && entry.phase === "setup" ? "setup" as const : "verification" as const }));
    run.status = "verifying";
    this.host.operation(stored, "check", async signal => {
      const results: typeof run.checks = [];
      this.host.assertRunPath(stored, run.workspace);
      await assertMemberReadOnly(run.workspace, head, this.host.config.teams?.commandPrefix, signal, "integration");
      const verification = await prepareVerificationWorkspace(run.workspace, randomUUID(), head, this.host.config.teams?.commandPrefix, signal);
      this.host.assertRunPath(stored, verification.workspace);
      if (verification.baseCommit !== head) throw new TeamError(409, "verification-head-mismatch", "The verification workspace did not start from the recorded integration commit.");
      await this.host.enqueue(stored.run.id, () => {
        if (this.host.closed || stored.pending?.kind !== "check" || stored.pending.revision !== revision) return;
        const root = stored.root ?? this.host.config.teams?.workspaceDir ?? dirname(run.workspace);
        const verificationPath = relative(root, verification.workspace).slice(0, 256);
        this.host.event(stored, `Configured checks are running in a disposable verification workspace: ${verificationPath}.`);
        this.host.save(stored);
      });
      for (const { context, ...entry } of commands) {
        const baseCheck = { ...entry, startedAt: timestamp(), revision, round: run.round, headCommit: head }, runningCheck: TeamRun["checks"][number] = { ...baseCheck, status: "running", output: "" };
        await this.host.enqueue(stored.run.id, () => { if (!this.host.closed) { run.checks.push(runningCheck); this.host.save(stored); } });
        const scanner = new CheckOutputScanner(), metrics = metricObserver();
        let result: CommandResult;
        try {
          result = await teamOperationCommand(entry.command, verification.workspace, signal, (this.host.config.teams?.checkMinutes ?? 60) * 60000, this.host.config.teams?.commandPrefix, undefined, (chunk, stream) => { metrics.push(chunk, stream); scanner.push(chunk, stream); });
        } catch (error) {
          if (error instanceof CommandStopUnconfirmed) await this.host.replaceCheck(stored, runningCheck, { ...baseCheck, status: "interrupted", finishedAt: timestamp(), ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }), output: error.output, scan: scanner.finish() });
          throw error;
        }
        const finishedCheck: TeamRun["checks"][number] = result.interrupted ? { ...baseCheck, status: "interrupted", finishedAt: timestamp(), exitCode: result.exitCode, output: result.output, scan: scanner.finish() }
          : result.exitCode === 0 ? { ...baseCheck, status: "passed", finishedAt: timestamp(), exitCode: 0, output: result.output }
          : { ...baseCheck, status: "failed", finishedAt: timestamp(), exitCode: result.exitCode, output: result.output, scan: scanner.finish() };
        results.push(finishedCheck);
        await this.host.replaceCheck(stored, runningCheck, finishedCheck, () => metrics.record(stored, finishedCheck));
        await this.host.noteLeftover(stored, result);
        if (!signal.aborted) await assertMemberReadOnly(verification.workspace, head, this.host.config.teams?.commandPrefix, signal, context);
        if (finishedCheck.status !== "passed") break;
      }
      if (!this.host.closed && !signal.aborted) await assertMemberReadOnly(run.workspace, head, this.host.config.teams?.commandPrefix, signal, "integration");
      return results;
    }, results => {
      if (results.length) {
        const first = results[0]!;
        this.host.emitWith(stored, "check.finished", [revision, first.round ?? 0, first.startedAt ?? ""], { revision }, () => ({
          round: first.round, headCommit: head, expected: commands.length,
          passed: results.length === commands.length && results.every(result => result.status === "passed"),
          commands: results.map(result => ({ phase: result.phase ?? "verification", status: result.status, exitCode: result.exitCode ?? null })),
        }));
      }
      if (revision !== run.revision || stored.halt || run.status === "paused" || run.status === "cancelled") return;
      if (results.length === commands.length && results.every(result => result.status === "passed")) {
        stored.checkHead = head; this.host.event(stored, "All configured verification commands passed against the integrated commit."); run.status = "reviewing";
      } else if (results.some(result => result.status === "interrupted")) {
        this.host.block(stored, new TeamError(409, "check-timeout", checkTimeoutReason));
      } else {
        const repeated = results.find(result => result.status === "failed" && result.phase !== "setup" && run.checks.some(prior => prior !== result &&
          prior.status === "failed" && prior.revision === revision && prior.round !== undefined && prior.round < run.round &&
          prior.headCommit === head && (prior.phase ?? "verification") === (result.phase ?? "verification") &&
          prior.command.command === result.command.command && JSON.stringify(prior.command.args) === JSON.stringify(result.command.args)));
        if (repeated) this.host.block(stored, new TeamError(409, "repeated-check-failure", repeatedCheckFailureReason));
        else this.repair(stored, checkFeedback(results), "check");
      }
    });
  }
}
