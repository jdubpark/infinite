# ADR-0019: Orchestration Wire, Schema, and Domain Type Invariants

- **Status**: Accepted
- **Scope**: `packages/host/src/team-types.ts`, `packages/host/src/team-state-schemas.ts`, `packages/host/src/mission-types.ts`, `packages/host/src/goal-types.ts`, `packages/host/src/types.ts`, `packages/host/src/teams.ts`, `packages/host/src/missions.ts`

## Context

The host's core orchestration and wire-contract modules (`team-types.ts`, `mission-types.ts`, `goal-types.ts`, `types.ts`) previously combined 329 lines of inline prose comments with flat optional-property bags that allowed impossible state combinations at compile time or runtime (such as a `published` member save carrying a `failure`, an `open` follow-up carrying `settledAt`, a `cloud` online execution state with `cloudReady: false` or a failure `reason`, a non-failed pending operation carrying `failureCode`, a `goalOutcomeSchema` `continue: true` paired with `"achieved"`, or a `team-answer` worker IPC mixing reviewer `coordinatorMemberId` and permission-agent `choice`). Encoding these contracts as strict TypeScript discriminated unions and matching Zod schemas eliminates impossible states while preserving 100% wire and sealed-disk JSON compatibility and bringing all touched files to zero prose comments under `scripts/check-comments.mjs`.

## Decisions

### 1. Discriminated State Machines and Runtime Schemas

- **Team domain (`team-state-schemas.ts`, `team-types.ts`, `teams.ts`)**:
  - `TeamMemberSavedWork` (`teamMemberSavedWorkSchema`) discriminates on `state`: `"published"` requires `repository`, `branch`, and `commit` and forbids `failure`; `"nothing-to-save"` forbids `repository`, `branch`, `commit`, and `failure`; `"retrying" | "gave-up"` require `repository`, `branch`, and `failure` with optional `commit`.
  - `TeamPendingOperation` (`teamPendingOperationSchema`, `buildTeamPendingOperation`) discriminates on `failed` (`false` forbids `failureCode`; `true` allows `failureCode`) and couples `(sourceMemberId, sourceRole)` and `(processes, processesCheckedAt)` so half-populated census or source pairs cannot be constructed.
  - `PermissionDecisionReport` (`permissionDecisionReportSchema`) discriminates on `verdict` (`"approve-once" | "escalate"` forbid `requestedPaths`; `"request-evidence"` requires 1–8 paths). `DeliveryReconciliationReport` (`deliveryReconciliationReportSchema`) discriminates on `disposition` (`"no-publication"` forbids `remoteHeadCommit` and `pullRequestUrl`; `"owned-branch"` requires `remoteHeadCommit` and forbids `pullRequestUrl`; `"pull-request"` requires both). Both invariants are also enforced via `.superRefine` inside `teamReportSchema` / `recordedTeamReportSchema` while keeping every top-level `teamReportSchema.options` element a plain `z.object` with `.shape.kind` for `z.toJSONSchema` tool rendering and report-kind coverage checks.
  - `TeamDecision` (`OpenTeamDecision`, `AnsweredTeamDecision`, `projectTeamDecision`, `teamDecisionSchema`) separates open decisions (forbidding `answer`, `answeredAt`, `answeredBy`, and `source`) from answered decisions (requiring `answer`, permitting `source` only when `answeredBy === "connector"`).
  - `TeamCheck` (`RunningTeamCheck`, `PassedTeamCheck`, `FailedTeamCheck`, `teamCheckSchema`) separates `"running"` (forbidding `finishedAt`, `exitCode`, and `scan`), `"passed"` (requiring `finishedAt`, forbidding `scan`), and `"failed" | "interrupted"` (requiring `finishedAt`, permitting `scan`).
  - `TeamPermissionAgentDecisionState` (`teamPermissionAgentDecisionSchema`) mirrors `PermissionHandled` by discriminating on `result` (`"allowed"`, `"rejected"`, `"owner"`, `"undeliverable"`, `"stale"`).
  - `TeamPublicationState` (`teamPublicationSchema`) requires either a paired `(commit, publishedAt)` publication or a `failure` record (or both when a newer head failed after an earlier head published).
  - `TeamProjectState` (`ConfiguredTeamProject`, `EstablishChecksTeamProject`, `isEstablishChecksProject`) mirrors `teamProjectSchema`'s mutual exclusion between configured `checks` (with optional `mainCheck`) and `establishChecks: true` (requiring `checks: []` and forbidding `mainCheck`).
- **Mission domain (`mission-types.ts`, `missions.ts`)**:
  - `MissionFollowUp` (`missionFollowUpSchema`) discriminates on `state`: `"open"` forbids `settledAt`; `"fired" | "cancelled"` require `settledAt`.
  - `BoardItem` (`boardItemSchema`) discriminates on `kind`: only `"mission"` may carry `stopReason` and `subtasks`; `"team"` and `"goal"` forbid both.
  - `MissionDecision` (`OpenMissionDecision`, `AnsweredMissionDecision`, `projectMissionDecision`, `missionDecisionSchema`) couples answer fields identically to `TeamDecision` and enforces that a forwarded `childDecisionId` requires `subtaskId`.
  - `MissionSubtaskState` (`projectMissionSubtask`, `missionSubtaskSchema`) distinguishes `"queued"` (no `teamId`, `teamStatus`, or `finalEvidence`), `"running" | "done" | "blocked"` (requiring `teamId`, no `finalEvidence`), and `"cancelled"` (optional `teamId`, `teamStatus`, and `finalEvidence`).
- **Goal domain (`goal-types.ts`)**:
  - `GoalOutcomeInput` (`goalOutcomeSchema`) encodes `"continue": true` as a strict union branch requiring `result: "not-achieved"` and `verdictId`, forbidding `continue` on all other outcome submissions.
  - `CreateGoalState` (`FiniteCreateGoal`, `StandingCreateGoal`, `projectCreateGoal`) captures the mutual exclusion between `standing` and `maxRuns` while keeping `createGoalSchema` as a `z.object` so `routine-types.ts` (`createGoalSchema.shape`) and `parseCreateGoal` key ordering stay intact.
  - `GoalCycleState` (`ActiveGoalCycle`, `SettledGoalCycle`, `projectGoalCycle`, `goalCycleSchema`) couples `class` and `settledAt` so a standing cycle is either unsettled (neither present) or settled (both present).
- **Session, runtime, and worker IPC (`types.ts`)**:
  - `SessionHeadless` (`sessionHeadlessSchema`) discriminates on `channel`: `true` forbids `reason`; `false` requires `reason`.
  - `ExecutionState` (`executionStateSchema`) discriminates on `(location, state)`: `"cloud"` allows `"online"` (`cloudReady: true`, no `reason`) or `"paused"` (`cloudReady: false`, required `reason`) with optional `reconciliation: "available"`; `"laptop"` forbids `reconciliation`.
  - `SessionRuntime` (`sessionRuntimeSchema`) discriminates on `transport`: `"pty"` permits `nativeUi`; `"cmux"` forbids `nativeUi`.
  - `TeamAnswerWorkerRequest` (`teamAnswerWorkerRequestSchema`) separates run-reviewer deliveries (`coordinatorMemberId`, forbidding `choice` and `text`) from permission-agent deliveries (`choice: "accept" | "reject"`, forbidding `coordinatorMemberId`, and at runtime forbidding `text` on `"accept"`).
  - `PermissionChannelViewState` (`permissionChannelViewSchema`, `projectPermissionChannelView`), `WorkerControlRequestState` (`workerControlRequestSchema`), and `WorkerWorkspaceExportRequestState` (`workerWorkspaceExportRequestSchema`) encode unserved-channel, control-lease action, and workspace-export method invariants.

### 2. Fingerprint Key Ordering and Digest Stability

- **Parsed key order is part of request and lineup digests**:
  - `teamModelProfileSchema` preserves legacy key order (`id`, `label`, `provider`, `model`, `effort`/`variant`, `tier`, `dataUse`, `limitFallback`) because session request fingerprints hash serialized parsed profiles.
  - `teamLineupSchema` keeps `judge` as the final key because lineup fingerprints depend on the parsed object's key order. `judge` is excluded from `lineupProfiles`, routing, trials, and fallback chains, and cannot declare `limitFallback`.
  - `parseCreateGoal` inserts `defaultMaxRuns` (`3`) for finite goals omitting `maxRuns` in `createGoalSchema.shape` key order so creation fingerprints and records match earlier schema-defaulted records while standing goals refuse an explicit `maxRuns`.
- **No-default optional config keys preserve existing authority digests**:
  - On `teamProjectSchema`, `features`, `routing`, `objective`, and `mainCheck` intentionally have no defaults so unset keys leave routine approval and authority digests unchanged. `features` is private (read at acceptance, never sent to members). `objective.intentCheck` overrides the mode default.
  - On `Config`, `teams.outcomes` and `eval` stay outside the routine approval digest because they do not alter routine work; `teams.blackboard` pins into new runs and stays inside the routine approval digest.
- **Record digest and register byte budgets (`team-types.ts`)**:
  - `recordDigestSchema` requires `c0` first (once) with empty `statement` (`""`) because `c0`'s text lives in `TeamGoalContext.successCriteria`. `derived: true` marks intent-check-derived criteria.
  - `recordDigestBytes` counts `{ version, criteria }` only (`<= 6 KiB`), leaving `register` (`registerDigestSchema`) its own independent `6 KiB` budget (`RECORD_REGISTER_BYTES`) containing intent-check and owner assumptions plus open questions; member prose never enters the register digest.
  - `recordDigestSchema` duplicates the `ID_RE` pattern (`^[a-z][a-z0-9-]{0,39}$`) from `objective-types.ts` to avoid closing a circular import until shared primitive schemas are extracted.

### 3. Honesty, Authority, and Client Redaction Boundaries

- **Agent claims are never host verification**:
  - `TeamStatus` `"merged"`, `TeamRun.deliveryReceipt`, `TeamRun.pullRequest`, `TeamTaskPlan.criterionRefs`, `TeamRun.recovery`, `TeamRun.deliveryRecovery`, `BlockerEvidence`, `MissionReport` `"follow-up"` (`MissionFollowUp.state === "fired"` wakes the coordinator without recording an outcome), `missionNoteSchema` (stored only, never host fact), and `GoalCycle.assessment` (provisional) are agent claims or scheduling records, never independent host verification or satisfaction receipts.
  - `hostClosedBlockedReason` names the host and elapsed `blockedHours` and never claims task completion.
  - `TeamPermissionDecision.purpose === "diagnose"` may request evidence but can never answer a provider prompt; `TeamPermissionRecoveryState` records bounded diagnostics and never confers permission authority; `TeamPermissionRecoveryRequest.expansion` is persisted before sending `Ctrl+A` so an unresolved `"intent"` is never replayed after restart.
  - `GithubReviewSource` (`kind: "github-review"`) represents only the configured `github.reviewFeedback.ownerLogin`'s review on the run's PR as owner direction (never approval); `ownerSteering` treats direct owner input and `github-review` as owner steering while connector and coordinator inputs remain delegated agent direction. `inputSourceLabel` and `decisionAnswerLabel` preserve provenance without upgrading agent input to owner authority.
  - `decisionAuthorityQuestion` prints only intent question IDs (`intentQuestions`) rather than checker prose on authority surfaces (R2).
- **Host-owned fields and client-view redaction**:
  - `Session.purpose` (contract C8, set only via `createTeamSession` and immutable), `Session.configId` (contract C7 lowercase SHA-256), `Session.team`, `Session.workspaceTrusted`, `Session.generatedTitle`, `Session.archivedAt`, `Session.headless`, `Project.autonomy` (set only by `RepoEnrollmentService`), `MissionSubtask.teamStatus`, and `TeamMember.permissionBlocked` are host-owned. `Session.projectRoot` is the canonical checkout at creation and is never inferred from Linear.
  - `TeamPermissionAgentDecision` carries host fields only; model notes remain in the permission journal and never reach runs, agents, or clients.
  - `TeamCheck.scan` is persisted on failed/interrupted checks for repair feedback and stripped from client views; passed checks store no scan.
  - `TeamRun.replay` is set once by `createForReplay` and stripped from `TeamView`. `TeamMember` strips `prompt`, `contextFeedback`, `nativeSessionId`, `continuation`, `turns`, `pendingFeedback`, and `goalCriteriaPlan` in `TeamView`. `TaskRouting` is disclosed in `TeamView` and never shown in member prompts or context. `withoutCriteria` strips `TeamGoalContext.criteria` for non-PM members.
  - Computed-on-read fields (`TeamMember.usage`, `Mission.usage`, `ProductGoal.usage`, `ProductGoal.nextCycleAt`, `Mission.clockStoppedAt` view-only stopped-clock marker, `TeamView.providerLimits`) are never stored.
  - `WorkerState.workerPid` is written to sealed status only (surfaced when a worker did not answer); `TeamView.pendingOperation.processes` reports only bounded categories (`"running" | "in-use" | "ended" | "unknown"`), never raw PIDs.
  - `Config.linear.apiKeyFile` is host-only and never copied into provider env or prompts; `Config.source.remoteOverrides` is test-only and refused on cloud hosts; `Config.jev.sessionReadings === false` restricts Jev to intake routing without sending session text; `Config.teams.memberTraces` enables Codex native traces only when both caps are configured.
- **Worker IPC authority boundaries (`types.ts`)**:
  - `WorkerRequest` `input.force` is terminal-only (types over open dialogs). `answer.missionManaged` is host-only for owner-authorized answers on mission-managed sessions. `team-answer`, `team-permission-expand`, and `session-permission-answer` are host-only over the private worker socket; reject `text` carries only the host's fixed reject notice when the one-shot reject option accepts text.

### 4. Routing, Retention, Pinning, and Legacy Compatibility Invariants

- **Permissions and routing pinning (`team-types.ts`)**:
  - `currentPermissions` upgrades enrollments saved with `LEGACY_DEFAULT_PERMISSION_SCOPES` to `DEFAULT_PERMISSION_SCOPE` (and legacy default limit `10` to `DEFAULT_PERMISSION_LIMIT = 25`), preserving owner-customized scopes or lower limits.
  - `fixedRuleFailure` checks contributor profiles (Rule 1 unless `allowContributor`) before reviewer-model overlap (Rule 2). `autoPinned` remains true even after `routingRevokedAt` (keeping fixed rules active); `autoRouted` and `hostSelects` require `routingRevokedAt === undefined`. `scoutCandidates` treats profiles without `tier` as light. `coversPoint` requires `algorithmVersion >= POINTS_ALGORITHM_VERSION` and at least one candidate (excluding `ownProfileId` for `"escalation"`). `resolveLimitFallback` walks at most two `limitFallback` hops skipping limited or ineligible targets.
  - `reportRefusal` checks `PLAN_VERIFICATION_REFUSAL` before `PROFILE_REQUIRED_REFUSAL`. `memberLimit` resolves `(run.goal ?? run.handoff)?.maxMembers ?? 60`.
  - `TeamRun` pins `lineup` (immutable model choices without credentials), `autonomy`, `intentCheck`, `register`, `verdicts`, `permissions`, `establishChecks`, `delivery`, `routing`, `blackboard`, and `requestSource` at creation; `deliveryRecoveryAttempts` stays cumulative across steers; `reviewFeedback` retains the newest 20 owner reviews without review text; `changes` bounds changed files to 400 and `TeamTask.changedPaths` bounds task paths to 200. `Stored.goalPlanCorrectionRevision` (`teams.ts`) tracks the revision that already consumed its single task-to-criterion link correction.
- **Retention and standing-goal lifecycle (`team-types.ts`, `mission-types.ts`, `goal-types.ts`)**:
  - `teamRetentionSchema` governs clone lifetime (`finishedMinutes` waits for live owning goal/mission/handoff; `cancelledMinutes` deletes clones and record whole; `blockedHours` closes as cancelled after clone removal; `memberMinutes` retains integrated clones for recovery briefs). Records and events outlive workspaces.
  - `Mission` pins `groupName` and `repoProjectIds` at creation; `mode: "answer"` makes a mission read-only with no subtasks; `stopReason: "deadline"` holds paused subteams with kept workspaces for owner extension; `followUps` keeps open entries plus the 10 most recently settled; `BoardAttempt.superseded` marks older blocked/cancelled attempts foldable behind a newer attempt.
  - `ProductGoal` keeps the newest 50 cycles plus the latest reviewed cycle, folding older cycles into `cycleTotals`, `foldedUsage`, and `foldedMembers`. Legacy records omitting `ceilingAt`, `autonomy`, `blockedAt`, `stopReason`, `TeamMember.provider`, `TeamRun.parallelismCeiling`, `TeamRun.blockCode`, `TeamRun.pullRequest.branch`, `TeamDecision.answerMode`, `TeamPermissionDecision.purpose`, `Session.codeMode`, `Project.source` (absent means `"laptop"`), or question `recommendation` (`recordedTeamReportSchema` / `recordedMissionReportSchema`) remain readable.
  - `createTeamSchema.parallelism` remains accepted as a legacy request field while the project manager selects runtime capacity after planning. `MissionSubtaskPlan` enforces solo ceiling `1` and team scaling up to `4`.

## Consequences

- `packages/host/src/team-types.ts` splits its strict state schemas into `packages/host/src/team-state-schemas.ts` (re-exported from `team-types.ts`), shrinking `team-types.ts` from 964 to 754 lines and keeping every edited/created file under the 1000-line limit.
- `packages/host/src/team-types.ts`, `packages/host/src/team-state-schemas.ts`, `packages/host/src/mission-types.ts`, `packages/host/src/goal-types.ts`, `packages/host/src/types.ts`, `packages/host/src/teams.ts`, `packages/host/src/missions.ts`, and `tests/orchestration-state-types.test.ts` carry zero prose comments under `scripts/check-comments.mjs`.
- `tests/orchestration-state-types.test.ts` pins both runtime Zod validation and compile-time narrowing (including `@ts-expect-error` negative checks for impossible states).
