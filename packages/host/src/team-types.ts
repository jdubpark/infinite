import type { ConnectorSource } from "./mcp-types.js";
import { z } from "zod";
import { featureMapSchema, TASK_KINDS } from "./task-features.js";
import { evalProjectSchema, CANDIDATE_PROFILES_MAX } from "./eval-config.js";
import type { TrialEnding } from "./eval-types.js";
import { POINTS_ALGORITHM_VERSION, teamRoutingSchema } from "./routing-policy.js";
import { intentCheckReportSchema } from "./intent-report.js";
import { judgementReportSchema, type Judgement, type JudgeEnding } from "./judge-types.js";
import { criteriaRowsSchema, verdictReportSchema, type RunAssessment } from "./verdict-types.js";
import { questionRecommendationSchema, refineQuestion, requiredQuestionRecommendationSchema } from "./question-recommendation.js";
import type { RoutingKnobs, TeamRunRouting } from "./routing-types.js";
import type { Prompt, AnswerResult } from "@infinite/attention";
import type { Receipt, Provider } from "./types.js";
import type { LinearTrackingView } from "./linear-types.js";
import type { UsageTotals } from "./usage.js";
import type { UsageRollup } from "./team-usage.js";
import type { ProviderLimit } from "./provider-limits.js";
import type { AutonomyMode } from "./autonomy.js";
import {
  commitHashSchema,
  gitBranchSchema,
  githubRepositorySchema,
  teamCommandSchema,
  type TeamCheck,
  type TeamCommand,
  type TeamDecision,
  type TeamMemberSavedWork,
  type TeamPendingOperation,
  type TeamPermissionAgentDecision,
  type TeamPublication,
  type TeamRole,
} from "./team-state-schemas.js";

export * from "./team-state-schemas.js";

export const teamRetentionSchema = z.object({
  finishedMinutes: z.number().int().min(0).max(10080).default(60),
  cancelledMinutes: z.number().int().min(0).max(10080).default(60),
  reviewHours: z.number().int().min(1).max(720).default(24),
  blockedHours: z.number().int().min(1).max(720).default(72),
  memberMinutes: z.number().int().min(0).max(10080).default(60),
}).strict();
export type TeamRetention = z.infer<typeof teamRetentionSchema>;
export const DEFAULT_TEAM_RETENTION: TeamRetention = teamRetentionSchema.parse({});
export function hostClosedBlockedReason(hours: number, lastBlocker?: string) {
  const blocker = lastBlocker?.trim();
  return `Closed by the host after ${hours} ${hours === 1 ? "hour" : "hours"} blocked without owner action.${blocker ? ` Last blocker: ${blocker.length > 500 ? `${blocker.slice(0, 500)}…` : blocker}` : ""}`;
}

export const storageFloorSchema = z.object({
  inodes: z.number().int().min(0).default(300_000),
  bytes: z.number().int().min(0).default(2 * 1024 ** 3),
}).strict();
export type StorageFloor = z.infer<typeof storageFloorSchema>;
export const DEFAULT_STORAGE_FLOOR: StorageFloor = storageFloorSchema.parse({});
const githubRepository = githubRepositorySchema;
const gitBranch = gitBranchSchema;
export const projectSourceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("github"), repository: githubRepository, baseBranch: gitBranch }).strict(),
  z.object({ mode: z.literal("laptop") }).strict(),
]);
export type ProjectSource = z.infer<typeof projectSourceSchema>;
export const teamDeliverySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("merge"),
    repository: githubRepository,
    baseBranch: gitBranch,
    mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
  }).strict(),
  z.object({ mode: z.literal("pr"), repository: githubRepository, baseBranch: gitBranch }).strict(),
]);
export type TeamDelivery = z.infer<typeof teamDeliverySchema>;
export const nativeContinuationSchema = z.object({
  nativeSessionId: z.string().uuid(),
  mode: z.enum(["start", "resume"]),
}).strict();
export type NativeContinuation = z.infer<typeof nativeContinuationSchema>;
export const DEFAULT_PERMISSION_SCOPE = "Approve one-time development operations that an engineer would routinely run for the accepted objective and assigned role inside the assigned workspace: repository inspection and fetch, scoped edits and staging, dependency installation from the repository's declared manifests and lockfiles, test planning, builds, tests, scripts, local listeners and local browser checks. These may run outside the provider sandbox and use network access, local sockets, IPC and task-owned temporary files while preserving the assigned repository and path scope. Delivery operations require the run's separate pinned delivery policy. Escalate only production or staging actions such as deploy, promote, roll out, release or publish, new or external credentials, other repositories, global or account settings, destructive operations outside the assigned workspace, persistent approvals, permission bypasses, and commands whose effect is unrelated to the task or appears malicious.";
export const DEFAULT_PERMISSION_LIMIT = 25;
export const MAX_PERMISSION_LIMIT = 50;
export const LEGACY_DEFAULT_PERMISSION_SCOPES: readonly string[] = [
  "Approve one-time repository read, edit, build and test operations required by the accepted task within its assigned workspace, including a one-time run of the task's tests or accepted checks outside the provider sandbox. Delivery operations require the run's separate pinned delivery policy. Escalate new credentials, other repositories, global settings, deployment, destructive operations, persistent approvals, other permission bypasses and unclear effects.",
  "Approve one-time development operations required by the accepted objective and assigned role, including repository inspection and fetch, scoped edits and staging, test planning, builds, tests and local browser checks. These may run outside the provider sandbox and use task-owned temporary files while preserving the assigned repository and path scope. Delivery operations require the run's separate pinned delivery policy. Escalate new credentials, other repositories, global settings, deployment, destructive operations, persistent approvals, permission bypasses and unclear effects.",
];
export const teamPermissionsSchema = z.object({
  mode: z.literal("coordinator"),
  scope: z.string().trim().min(1).max(4000),
  maxDecisions: z.number().int().min(1).max(MAX_PERMISSION_LIMIT).default(DEFAULT_PERMISSION_LIMIT),
}).strict();
export type TeamPermissions = z.infer<typeof teamPermissionsSchema>;
export function currentPermissions(saved: TeamPermissions): TeamPermissions {
  if (!LEGACY_DEFAULT_PERMISSION_SCOPES.includes(saved.scope)) return saved;
  return { ...saved, scope: DEFAULT_PERMISSION_SCOPE, maxDecisions: saved.maxDecisions === 10 ? DEFAULT_PERMISSION_LIMIT : saved.maxDecisions };
}
export interface TeamPermissionDecision {
  id: string;
  revision: number;
  policyHash: string;
  targetMemberId: string;
  targetSessionId: string;
  targetCwd: string;
  promptId: number;
  promptHash: string;
  evidenceHash: string;
  reuseKey?: string;
  reusedFromDecisionId?: string;
  verdict?: "approve-once" | "escalate";
  workspaceEvidenceHash?: string;
  authorityHash?: string;
  reviewerProfileId?: string;
  reviewerProfileHash?: string;
  prompt: Prompt;
  option: number;
  expiresAt: string;
  coordinatorMemberId?: string;
  coordinatorSessionId?: string;
  answerRequestId: string;
  purpose?: "answer" | "diagnose";
  recoveryRequestId?: string;
  requestedPaths?: string[];
  status: "pending" | "reviewing" | "approved" | "answering" | "answered" | "escalated" | "stale" | "uncertain";
  reason?: string;
  receipt?: Receipt & { result?: AnswerResult };
}
export interface TeamPermissionRecoveryStep {
  id: string;
  requestId: string;
  decisionId?: string;
  at: string;
  cause: string;
  action: string;
  decision: string;
  consequence: string;
  execution: "unknown";
  receipt?: Receipt;
}
export interface TeamPermissionRecoveryOutcome {
  id: string;
  requestId: string;
  decisionId?: string;
  revision: number;
  promptId: number;
  status: "complete" | "exhausted" | "interrupted";
  cause: string;
  action: string;
  decision: string;
  consequence: string;
  execution: "unknown";
  at: string;
}
export interface TeamPermissionRecoveryRequest {
  id: string;
  revision: number;
  targetMemberId: string;
  targetSessionId: string;
  promptId: number;
  promptHash: string;
  evidenceHash: string;
  targetCwd: string;
  policyHash: string;
  expiresAt: string;
  status: "expanding" | "diagnosing" | "reviewing-evidence" | "complete" | "exhausted" | "interrupted";
  rounds: number;
  latestDecisionId?: string;
  requestedPaths?: string[];
  expansion?: { requestId: string; promptId: number; promptHash: string; status: "intent" | "expanded" | "uncertain" | "refused"; at: string;
    observedPromptId?: number; observedPromptHash?: string; rereads?: number; receipt?: Receipt };
}
export interface TeamPermissionRecoveryState {
  requests: TeamPermissionRecoveryRequest[];
  steps: TeamPermissionRecoveryStep[];
  outcomes: TeamPermissionRecoveryOutcome[];
}
export type TeamPermissionRecoveryView = Omit<TeamPermissionRecoveryOutcome, "requestId">;
export const teamProjectSchema = z.object({
  handoff: z.enum(["auto", "off"]).optional(),
  setup: teamCommandSchema.optional(),
  checks: z.array(teamCommandSchema).max(8),
  establishChecks: z.literal(true).optional(),
  delivery: teamDeliverySchema.optional(),
  permissions: teamPermissionsSchema.optional(),
  handoffMinutes: z.number().int().min(5).max(1440).optional(),
  handoffExtendMinutes: z.number().int().min(0).max(240).optional(),
  handoffMaxTotalMinutes: z.number().int().min(5).max(1440).optional(),
  features: featureMapSchema.optional(),
  eval: evalProjectSchema.extend({ candidateProfiles: z.lazy(() => z.array(teamModelProfileSchema).max(CANDIDATE_PROFILES_MAX)).optional() }).optional(),
  routing: teamRoutingSchema.optional(),
  objective: z.strictObject({ prompts: z.enum(["on", "off"]).optional(), intentCheck: z.enum(["on", "off"]).optional(), register: z.enum(["on", "off"]).optional(), evaluator: z.enum(["on", "off"]).optional() }).optional(),
  mainCheck: z.strictObject({ minutes: z.number().int().min(1).max(240).optional() }).optional(),
}).strict().superRefine((project, context) => {
  if (project.establishChecks ? project.checks.length > 0 : project.checks.length === 0)
    context.addIssue({ code: "custom", path: ["checks"], message: "Configure required checks, or explicitly authorize the team to establish them with an empty checks array." });
  if (project.mainCheck && project.establishChecks)
    context.addIssue({ code: "custom", path: ["mainCheck"], message: "The main check runs the configured checks, and a project that lets the team establish its own checks has none to run." });
  if (project.handoffMaxTotalMinutes !== undefined && project.handoffMaxTotalMinutes < (project.handoffMinutes ?? 60))
    context.addIssue({ code: "custom", path: ["handoffMaxTotalMinutes"], message: "The handoff ceiling cannot be shorter than its time limit." });
});
export type TeamProject = z.infer<typeof teamProjectSchema>;
export type ConfiguredTeamProject = Omit<TeamProject, "checks" | "establishChecks" | "mainCheck"> & {
  checks: [TeamCommand, ...TeamCommand[]];
  establishChecks?: never;
  mainCheck?: { minutes?: number };
};
export type EstablishChecksTeamProject = Omit<TeamProject, "checks" | "establishChecks" | "mainCheck"> & {
  checks: [];
  establishChecks: true;
  mainCheck?: never;
};
export type TeamProjectState = ConfiguredTeamProject | EstablishChecksTeamProject;
export function isEstablishChecksProject(project: TeamProject): project is EstablishChecksTeamProject {
  return project.establishChecks === true && project.checks.length === 0 && project.mainCheck === undefined;
}
export function isConfiguredChecksProject(project: TeamProject): project is ConfiguredTeamProject {
  return project.establishChecks === undefined && project.checks.length > 0;
}
export function projectTeamProject(project: TeamProject): TeamProjectState {
  if (isEstablishChecksProject(project)) return project;
  if (isConfiguredChecksProject(project)) return project;
  throw new Error("Invalid team project state: configure checks or set establishChecks with empty checks and no mainCheck.");
}
export const teamVerificationSchema = z.object({
  setup: teamCommandSchema.optional(),
  checks: z.array(teamCommandSchema).min(1).max(8),
}).strict();
export type TeamVerification = z.infer<typeof teamVerificationSchema>;
const modelProfileFields = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  label: z.string().trim().min(1).max(100),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/),
  tier: z.enum(["light", "strong"]).optional(),
  dataUse: z.enum(["standard", "contributor"]).optional(),
  limitFallback: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
};
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const teamModelProfileSchema = z.discriminatedUnion("provider", [
  z.object({ id: modelProfileFields.id, label: modelProfileFields.label, provider: z.literal("claude"), model: modelProfileFields.model, effort, tier: modelProfileFields.tier, dataUse: modelProfileFields.dataUse, limitFallback: modelProfileFields.limitFallback }).strict(),
  z.object({ id: modelProfileFields.id, label: modelProfileFields.label, provider: z.literal("codex"), model: modelProfileFields.model, effort, tier: modelProfileFields.tier, dataUse: modelProfileFields.dataUse, limitFallback: modelProfileFields.limitFallback }).strict(),
  z.object({ id: modelProfileFields.id, label: modelProfileFields.label, provider: z.literal("opencode"), model: z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/), variant: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).optional(), tier: modelProfileFields.tier, dataUse: modelProfileFields.dataUse, limitFallback: modelProfileFields.limitFallback }).strict(),
]);
export type TeamModelProfile = z.infer<typeof teamModelProfileSchema>;
export const teamLineupSchema = z.object({
  coordinator: teamModelProfileSchema,
  integrator: teamModelProfileSchema,
  reviewer: teamModelProfileSchema,
  implementers: z.array(teamModelProfileSchema).min(1).max(8),
  escalations: z.array(teamModelProfileSchema).min(1).max(8).optional(),
  fallbacks: z.array(teamModelProfileSchema).min(1).max(8).optional(),
  permissionReviewer: teamModelProfileSchema.optional(),
  evaluators: z.array(teamModelProfileSchema).min(1).max(4).optional(),
  judge: teamModelProfileSchema.optional(),
}).strict().superRefine((lineup, context) => {
  for (const [index, profile] of (lineup.evaluators ?? []).entries()) {
    if (profile.tier !== "strong") context.addIssue({ code: "custom", path: ["evaluators", index, "tier"], message: "An evaluator must be a strong profile" });
  }
  if (lineup.judge?.limitFallback !== undefined) context.addIssue({ code: "custom", path: ["judge", "limitFallback"], message: "A judge profile cannot have a limit fallback" });
  if (lineup.permissionReviewer && lineup.permissionReviewer.provider !== "claude")
    context.addIssue({ code: "custom", path: ["permissionReviewer", "provider"], message: "The permission reviewer profile must use Claude Code." });
  for (const pool of ["implementers", "escalations", "fallbacks", "evaluators"] as const) {
    const ids = new Set<string>();
    for (const [index, profile] of (lineup[pool] ?? []).entries()) {
      if (ids.has(profile.id)) context.addIssue({ code: "custom", path: [pool, index, "id"], message: "Profile IDs must be unique within a pool" });
      ids.add(profile.id);
    }
  }
  const identities = new Map<string, string>();
  const profiles = lineupProfiles(lineup);
  for (const profile of [...profiles, ...(lineup.judge ? [lineup.judge] : [])]) {
    const identity = JSON.stringify([profile.provider, profile.model, profile.provider === "opencode" ? profile.variant : profile.effort, profile.tier, profile.dataUse ?? "standard", profile.limitFallback ?? null]);
    if (identities.has(profile.id) && identities.get(profile.id) !== identity)
      context.addIssue({ code: "custom", message: "A profile ID must identify the same provider, model, and effort throughout a lineup" });
    identities.set(profile.id, identity);
  }
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const permissionReviewerFallbacks = new Set<string>();
  let permissionFallback = lineup.permissionReviewer;
  for (let hop = 0; hop < 2 && permissionFallback?.limitFallback; hop++) {
    permissionReviewerFallbacks.add(permissionFallback.id);
    const target = byId.get(permissionFallback.limitFallback);
    if (!target) break;
    permissionFallback = target;
  }
  for (const profile of profiles) {
    if (!profile.limitFallback) continue;
    const seen = new Set([profile.id]);
    let current: TeamModelProfile = profile;
    const permissionReviewerChain = permissionReviewerFallbacks.has(profile.id);
    for (let hop = 1; current.limitFallback; hop++) {
      const target = byId.get(current.limitFallback);
      if (!target) { context.addIssue({ code: "custom", message: `Limit fallback "${current.limitFallback}" of "${current.id}" is not a profile in this lineup` }); break; }
      if (permissionReviewerChain && target.provider !== "claude")
        context.addIssue({ code: "custom", message: "A permission reviewer limit fallback must use Claude Code." });
      if (target.provider === current.provider) { context.addIssue({ code: "custom", message: `Limit fallback "${target.id}" of "${current.id}" must use a different provider` }); break; }
      if (current.tier === "strong" && target.tier !== "strong") { context.addIssue({ code: "custom", message: `Strong profile "${current.id}" must fall back to a strong profile` }); break; }
      if (seen.has(target.id)) { context.addIssue({ code: "custom", message: `Limit fallback chain from "${profile.id}" revisits "${target.id}"` }); break; }
      if (hop >= 2 && target.limitFallback) { context.addIssue({ code: "custom", message: `Limit fallback chain from "${profile.id}" is longer than two hops` }); break; }
      seen.add(target.id);
      current = target;
    }
  }
});
export type TeamLineup = z.infer<typeof teamLineupSchema>;
type LineupShape = Pick<TeamLineup, "coordinator" | "integrator" | "reviewer" | "implementers" | "escalations" | "fallbacks" | "permissionReviewer" | "evaluators">;
export function lineupProfiles(lineup: LineupShape): TeamModelProfile[] {
  return [lineup.coordinator, lineup.integrator, lineup.reviewer, ...lineup.implementers, ...(lineup.escalations ?? []), ...(lineup.fallbacks ?? []), ...(lineup.permissionReviewer ? [lineup.permissionReviewer] : []), ...(lineup.evaluators ?? [])];
}
export function fixedRuleFailure(lineup: Pick<TeamLineup, "reviewer">, knobs: Pick<RoutingKnobs, "allowContributor">, profile: TeamModelProfile): "contributor" | "reviewer-model" | undefined {
  if (profile.dataUse === "contributor" && !knobs.allowContributor) return "contributor";
  if (profile.model === lineup.reviewer.model) return "reviewer-model";
  return undefined;
}
export function autoPinned(run: Pick<TeamRun, "routing">): boolean {
  return run.routing?.mode === "auto";
}
export function autoRouted(run: Pick<TeamRun, "routing" | "routingRevokedAt">): boolean {
  return autoPinned(run) && run.routingRevokedAt === undefined;
}
export function eligibleImplementers(run: Pick<TeamRun, "routing" | "lineup">): TeamModelProfile[] {
  const { routing, lineup } = run;
  if (!lineup) return [];
  if (routing?.mode !== "auto") return lineup.implementers;
  return lineup.implementers.filter(profile => fixedRuleFailure(lineup, routing.knobs, profile) === undefined);
}
export function scoutPool(run: Pick<TeamRun, "routing" | "lineup">): TeamModelProfile[] {
  const { routing, lineup } = run;
  if (!lineup) return [];
  if (routing?.mode !== "auto") return lineup.implementers;
  return lineup.implementers.filter(profile => fixedRuleFailure(lineup, routing.knobs, profile) !== "contributor");
}
export function escalationPool(run: Pick<TeamRun, "routing" | "lineup">): TeamModelProfile[] {
  const { routing, lineup } = run;
  const pool = lineup?.escalations ?? [];
  if (!lineup || routing?.mode !== "auto") return pool;
  return pool.filter(profile => fixedRuleFailure(lineup, routing.knobs, profile) !== "contributor");
}
export function escalationCandidates(lineup: TeamLineup, knobs: Pick<RoutingKnobs, "allowContributor">, ownProfileId?: string): TeamModelProfile[] {
  return (lineup.escalations ?? []).filter(profile => profile.id !== ownProfileId && fixedRuleFailure(lineup, knobs, profile) === undefined);
}
export function scoutCandidates(lineup: TeamLineup, knobs: Pick<RoutingKnobs, "allowContributor">): TeamModelProfile[] {
  return lineup.implementers.filter(profile => profile.tier !== "strong" && fixedRuleFailure(lineup, knobs, profile) === undefined);
}
export function coversPoint(run: Pick<TeamRun, "routing" | "lineup">, point: "escalation" | "scout", ownProfileId?: string): boolean {
  const { routing, lineup } = run;
  if (!lineup || !routing || routing.mode !== "auto" || routing.algorithmVersion < POINTS_ALGORITHM_VERSION || !routing.knobs.points.includes(point)) return false;
  return point === "scout" ? scoutCandidates(lineup, routing.knobs).length > 0 : escalationCandidates(lineup, routing.knobs, ownProfileId).length > 0;
}
export function hostSelects(run: Pick<TeamRun, "routing" | "routingRevokedAt" | "lineup">, point: "escalation" | "scout", ownProfileId?: string): boolean {
  return run.routingRevokedAt === undefined && coversPoint(run, point, ownProfileId);
}
export function hostProfilesFor(run: Pick<TeamRun, "routing" | "lineup">, role: TeamRole, ownProfileId?: string): boolean {
  if (role === "implementer") return coversPoint(run, "escalation", ownProfileId);
  if (role === "project-manager") return coversPoint(run, "scout");
  return false;
}
export const PLAN_VERIFICATION_REFUSAL = "Plan rejected: this run uses the project's configured checks. Remove verification and submit a corrected plan. If the checks seem insufficient, explain that in the summary and assign tasks to run additional commands themselves and report results.";
export const PROFILE_REQUIRED_REFUSAL = "Report rejected: name an approved agentProfileId for the escalation and for every scout, then submit the corrected report.";
export function reportRefusal(team: TeamAssignment, report: TeamReport): string | undefined {
  if (team.role === "project-manager" && report.kind === "plan" && report.verification && team.verificationRefused) return PLAN_VERIFICATION_REFUSAL;
  const missingProfile = (report.kind === "escalate" && report.agentProfileId === undefined)
    || (report.kind === "explore" && report.tasks.some(task => task.agentProfileId === undefined));
  if (team.hostProfiles !== true && missingProfile) return PROFILE_REQUIRED_REFUSAL;
  return undefined;
}
export function memberLimit(run: Pick<TeamRun, "goal" | "handoff">): number {
  return (run.goal ?? run.handoff)?.maxMembers ?? 60;
}
export function resolveLimitFallback(lineup: LineupShape, profileId: string, limited: Set<Provider>, eligible?: (profile: TeamModelProfile) => boolean): TeamModelProfile | undefined {
  const profiles = lineupProfiles(lineup);
  let current = profiles.find(profile => profile.id === profileId);
  for (let hop = 0; hop < 2 && current?.limitFallback; hop++) {
    const next = profiles.find(profile => profile.id === current!.limitFallback);
    if (next && !limited.has(next.provider) && (eligible?.(next) ?? true)) return next;
    current = next;
  }
  return undefined;
}
export function switchFallback(lineup: TeamLineup, profileId: string, provider: Provider, limited: Set<Provider>, eligible?: (profile: TeamModelProfile) => boolean): TeamModelProfile | undefined {
  return resolveLimitFallback(lineup, profileId, new Set([...limited, provider]), eligible);
}
export const createTeamSchema = z.object({
  requestId: z.uuid(),
  projectId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  provider: z.enum(["claude", "codex", "grok", "opencode", "demo"]),
  useConfiguredLineup: z.boolean().optional(),
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(24000),
  parallelism: z.number().int().min(1).max(4).default(2),
}).strict();
export type CreateTeam = z.infer<typeof createTeamSchema>;
export const teamMutationSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1), text: z.string().trim().min(1).max(8000) }).strict();
export const teamDeliveryReconcileSchema = z.object({
  requestId: z.uuid(), revision: z.number().int().min(1), text: z.string().trim().min(1).max(8000),
  failedOperation: z.object({ pendingId: z.uuid(), headCommit: commitHashSchema,
    attestation: z.object({ boundary: z.literal("delivery-preparation"), processesStopped: z.literal(true), text: z.string().trim().min(1).max(4000) }).strict() }).strict().optional(),
}).strict();
export type TeamDeliveryReconcile = z.infer<typeof teamDeliveryReconcileSchema>;
export const teamVerificationReconcileSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1), pendingId: z.uuid(),
  headCommit: commitHashSchema,
  attestation: z.object({ boundary: z.literal("check-only"), processesStopped: z.literal(true), text: z.string().trim().min(1).max(4000) }).strict() }).strict();
export type TeamVerificationReconcile = z.infer<typeof teamVerificationReconcileSchema>;
export const teamMemberRetireSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1), sessionId: z.uuid(),
  identity: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().trim().min(1).max(4000) }).strict();
export type TeamMemberRetire = z.infer<typeof teamMemberRetireSchema>;
export const teamActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export const teamContinueSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1), text: z.string().trim().min(1).max(8000).optional() }).strict();
export type TeamContinue = z.infer<typeof teamContinueSchema>;
export const teamTaskRatingSchema = z.object({ requestId: z.uuid(), score: z.number().int().min(1).max(5), note: z.string().trim().max(1000).optional() }).strict();
export const teamParallelismSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1), parallelism: z.number().int().min(1).max(4) }).strict();
export type TeamParallelism = z.infer<typeof teamParallelismSchema>;
const taskId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const taskIdSchema = taskId;
const ownedPath = z.string().min(1).max(300).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => part === ".." || part === ".git" || part === "." || part === ""), "Use a repository-relative file or directory without glob syntax").refine(value => !/[*?\[\]:]/.test(value));
export const ownedPathSchema = ownedPath;
export const RECORD_DIGEST_BYTES = 6 * 1024;
export const RECORD_REGISTER_BYTES = 6 * 1024;
export const registerDigestSchema = z.strictObject({
  assumptions: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    status: z.enum(["refuted", "unchecked", "assumed", "verified"]),
    criticality: z.enum(["outcome", "plan", "detail"]),
    statement: z.string(),
  })).max(32),
  questions: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), text: z.string() })).max(8),
  omitted: z.number().int().min(1).max(40).optional(),
}).superRefine((register, context) => {
  register.assumptions.forEach((item, index) => {
    const bytes = Buffer.byteLength(item.statement);
    if (bytes < 1 || bytes > 500) context.addIssue({ code: "custom", path: ["assumptions", index, "statement"], message: "An assumption statement is 1 to 500 bytes." });
  });
  register.questions.forEach((item, index) => {
    const bytes = Buffer.byteLength(item.text);
    if (bytes < 1 || bytes > 1000) context.addIssue({ code: "custom", path: ["questions", index, "text"], message: "A question is 1 to 1,000 bytes." });
  });
  if (registerDigestBytes(register) > RECORD_REGISTER_BYTES) context.addIssue({ code: "custom", path: ["assumptions"], message: "The register digest is over 6 KiB." });
});
export type RegisterDigest = z.infer<typeof registerDigestSchema>;
export function registerDigestBytes(register: RegisterDigest): number { return Buffer.byteLength(JSON.stringify(register)); }
export const RECORD_LABEL_BYTES = 120;
export const recordDigestSchema = z.strictObject({
  version: z.number().int().min(1).max(1_000_000),
  criteria: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    statement: z.string(),
    check: z.string(),
    producer: z.enum(["host", "evaluator", "owner"]),
    derived: z.literal(true).optional(),
  })).min(1).max(8),
  register: registerDigestSchema.optional(),
}).superRefine((digest, context) => {
  const [first, ...rest] = digest.criteria;
  if (first?.id !== "c0" || rest.some(criterion => criterion.id === "c0")) context.addIssue({ code: "custom", path: ["criteria"], message: "The record digest must start with c0 and hold it once." });
  if (first && first.statement !== "") context.addIssue({ code: "custom", path: ["criteria", 0, "statement"], message: "c0 carries its text in the goal context, so its statement is empty." });
  rest.forEach((criterion, index) => {
    const bytes = Buffer.byteLength(criterion.statement);
    if (bytes < 1 || bytes > 1000) context.addIssue({ code: "custom", path: ["criteria", index + 1, "statement"], message: "A criterion statement is 1 to 1,000 bytes." });
  });
  digest.criteria.forEach((criterion, index) => {
    const bytes = Buffer.byteLength(criterion.check);
    if (bytes < 1 || bytes > RECORD_LABEL_BYTES) context.addIssue({ code: "custom", path: ["criteria", index, "check"], message: "A check label is 1 to 120 bytes." });
  });
  if (recordDigestBytes(digest) > RECORD_DIGEST_BYTES) context.addIssue({ code: "custom", path: ["criteria"], message: "The record digest is over 6 KiB." });
});
export type RecordDigest = z.infer<typeof recordDigestSchema>;
export function recordDigestBytes(digest: RecordDigest): number { return Buffer.byteLength(JSON.stringify({ version: digest.version, criteria: digest.criteria })); }
export const teamGoalContextSchema = z.object({
  id: z.uuid(), revision: z.number().int().min(1), cycle: z.number().int().min(1),
  successCriteria: z.string().trim().min(1).max(8000),
  nonGoals: z.array(z.string().trim().min(1).max(1000)).max(20),
  allowedPaths: z.array(z.union([z.literal("."), ownedPath])).min(1).max(32),
  evidence: z.array(z.string().trim().min(1).max(2000)).max(20),
  sourceIssue: z.object({ id: z.uuid(), identifier: z.string().max(100), url: z.url(), title: z.string().max(1000), description: z.string().max(24000).nullable() }).strict().optional(),
  previousWork: z.array(z.string().trim().min(1).max(2000)).max(16),
  deadlineAt: z.iso.datetime(), maxMembers: z.number().int().min(1).max(60), parentRunId: z.uuid().optional(),
  extendMinutes: z.number().int().min(0).max(240).optional(), ceilingAt: z.iso.datetime().optional(),
  ownerExtendedDeadlineAt: z.iso.datetime().optional(),
  record: recordDigestSchema.optional(),
  criteria: criteriaRowsSchema.optional(),
}).strict();
export type TeamGoalContext = z.infer<typeof teamGoalContextSchema>;
export function withoutCriteria(goal: TeamGoalContext): TeamGoalContext {
  if (!goal.criteria) return goal;
  const { criteria: _criteria, ...rest } = goal;
  return rest;
}
export const teamEvidenceSchema = z.object({ source: z.string().trim().min(1).max(1000), observation: z.string().trim().min(1).max(2000) }).strict();
export type TeamEvidence = z.infer<typeof teamEvidenceSchema>;
export const teamBriefSchema = z.object({
  title: z.string().trim().min(1).max(100), problem: z.string().trim().min(1).max(3000),
  evidence: z.array(teamEvidenceSchema).min(1).max(12), dataShape: z.string().trim().min(1).max(3000),
  acceptance: z.array(z.string().trim().min(1).max(1000)).min(1).max(8),
  expectedOutcome: z.string().trim().min(1).max(2000), uiChanges: z.boolean(),
}).strict();
export type TeamBrief = z.infer<typeof teamBriefSchema>;
export const teamAcceptanceEvidenceSchema = z.object({
  criterion: z.number().int().min(1).max(8), verdict: z.enum(["verified", "not-verified", "inconclusive"]),
  evidence: z.string().trim().min(1).max(600),
}).strict();
export type TeamAcceptanceEvidence = z.infer<typeof teamAcceptanceEvidenceSchema>;
export const teamScoutPlanSchema = z.object({ id: taskId, title: z.string().trim().min(1).max(100), instructions: z.string().trim().min(1).max(4000), agentProfileId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional() }).strict();
export type TeamScoutPlan = z.infer<typeof teamScoutPlanSchema>;
export const teamTaskCriterionRefsSchema = z.strictObject({
  objectiveVersion: z.number().int().min(1).max(1_000_000),
  criteria: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).min(1).max(8),
}).superRefine((refs, context) => {
  if (new Set(refs.criteria).size !== refs.criteria.length)
    context.addIssue({ code: "custom", path: ["criteria"], message: "A task may name each objective criterion only once." });
});
export type TeamTaskCriterionRefs = z.infer<typeof teamTaskCriterionRefsSchema>;
export type TeamGoalCriteriaPlanPin = { objectiveVersion: number };
export const teamTaskPlanSchema = z.object({
  id: taskId,
  title: z.string().trim().min(1).max(100),
  instructions: z.string().trim().min(1).max(8000),
  agentProfileId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
  paths: z.array(ownedPath).min(1).max(32),
  dependsOn: z.array(taskId).max(12),
  criterionRefs: teamTaskCriterionRefsSchema.optional(),
  kind: z.enum(TASK_KINDS).optional(),
  risk: z.literal("elevated").optional(),
}).strict();
export type TeamTaskPlan = z.infer<typeof teamTaskPlanSchema>;
export const blockerEvidenceSchema = z.object({
  cause: z.object({ status: z.enum(["observed", "hypothesis", "unknown"]), detail: z.string().trim().min(1).max(1200) }).strict(),
  issueRefs: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
  sourceRefs: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
  attemptedFixes: z.array(z.object({ fix: z.string().trim().min(1).max(800), outcome: z.string().trim().min(1).max(800) }).strict()).max(8).optional(),
  proposedRecovery: z.string().trim().min(1).max(1200),
  prevention: z.string().trim().min(1).max(1200),
  validationEvidence: z.array(z.object({ sourceRef: z.string().trim().min(1).max(500), observation: z.string().trim().min(1).max(1000) }).strict()).min(1).max(8),
}).strict().superRefine((evidence, context) => {
  if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > 12 * 1024)
    context.addIssue({ code: "custom", message: "Blocker evidence must fit within 12 KiB of UTF-8 JSON" });
});
export type BlockerEvidence = z.infer<typeof blockerEvidenceSchema>;
const questionReportShape = { kind: z.literal("question"), question: z.string().min(1).max(4000), options: z.array(z.string().min(1).max(500)).max(4).default([]), answerMode: z.enum(["approval", "single", "multiple"]).optional() };
const recordedDeliveryReconciliationReportSchema = z.object({ kind: z.literal("delivery-reconciliation"), headCommit: commitHashSchema, repository: githubRepository, branch: gitBranch, baseHeadCommit: commitHashSchema, disposition: z.enum(["no-publication", "owned-branch", "pull-request"]), remoteHeadCommit: commitHashSchema.optional(), pullRequestUrl: z.string().trim().min(1).max(500).optional(), summary: z.string().trim().min(1).max(4000) }).strict();
const strictDeliveryReconciliationReportSchema = recordedDeliveryReconciliationReportSchema.superRefine((report, context) => {
  if (report.disposition === "no-publication") {
    if (report.remoteHeadCommit !== undefined) context.addIssue({ code: "custom", path: ["remoteHeadCommit"], message: "A no-publication reconciliation cannot include remoteHeadCommit." });
    if (report.pullRequestUrl !== undefined) context.addIssue({ code: "custom", path: ["pullRequestUrl"], message: "A no-publication reconciliation cannot include pullRequestUrl." });
  } else if (report.disposition === "owned-branch") {
    if (report.remoteHeadCommit === undefined) context.addIssue({ code: "custom", path: ["remoteHeadCommit"], message: "An owned-branch reconciliation requires remoteHeadCommit." });
    if (report.pullRequestUrl !== undefined) context.addIssue({ code: "custom", path: ["pullRequestUrl"], message: "An owned-branch reconciliation cannot include pullRequestUrl." });
  } else {
    if (report.remoteHeadCommit === undefined) context.addIssue({ code: "custom", path: ["remoteHeadCommit"], message: "A pull-request reconciliation requires remoteHeadCommit." });
    if (report.pullRequestUrl === undefined) context.addIssue({ code: "custom", path: ["pullRequestUrl"], message: "A pull-request reconciliation requires pullRequestUrl." });
  }
});
const sharedTeamReportVariants = [
  z.object({ kind: z.literal("permission-decision"), decisionId: z.uuid(), verdict: z.enum(["approve-once", "request-evidence", "escalate"]), summary: z.string().trim().min(1).max(2000), requestedPaths: z.array(z.string().trim().min(1).max(512)).max(8).optional() }).strict().superRefine((report, context) => {
    if (report.verdict === "request-evidence" && !report.requestedPaths?.length)
      context.addIssue({ code: "custom", path: ["requestedPaths"], message: "Request evidence with at least one repository-relative or approved scratch path." });
    if (report.verdict !== "request-evidence" && report.requestedPaths !== undefined)
      context.addIssue({ code: "custom", path: ["requestedPaths"], message: "Only an evidence request may name paths." });
  }),
  z.object({ kind: z.literal("plan"), summary: z.string().min(1).max(4000), parallelism: z.number().int().min(1).max(4).optional(), brief: teamBriefSchema.optional(), tasks: z.array(teamTaskPlanSchema).min(1).max(12), verification: teamVerificationSchema.optional() }).strict(),
  z.object({ kind: z.literal("explore"), summary: z.string().min(1).max(4000), parallelism: z.number().int().min(1).max(4).optional(), tasks: z.array(teamScoutPlanSchema).min(1).max(3) }).strict(),
  z.object({ kind: z.literal("findings"), summary: z.string().min(1).max(4000), evidence: z.array(teamEvidenceSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("no-change"), summary: z.string().min(1).max(4000), evidence: z.array(teamEvidenceSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("escalate"), agentProfileId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(), reason: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("result"), summary: z.string().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("review"), verdict: z.enum(["approved", "changes-requested"]), summary: z.string().min(1).max(8000), uiEvidence: z.string().trim().min(1).max(4000).optional(), acceptance: z.array(teamAcceptanceEvidenceSchema).max(8).optional(), rubric: z.array(z.object({ taskId, correctness: z.object({ score: z.number().int().min(1).max(5), why: z.string().trim().min(1).max(300) }).strict(), cleanliness: z.object({ score: z.number().int().min(1).max(5), why: z.string().trim().min(1).max(300) }).strict(), extensibility: z.object({ score: z.number().int().min(1).max(5), why: z.string().trim().min(1).max(300) }).strict(), docs: z.object({ score: z.number().int().min(1).max(5), why: z.string().trim().min(1).max(300) }).strict() }).strict()).max(12).optional() }).strict(),
  z.object({ kind: z.literal("delivery"), headCommit: commitHashSchema, pullRequestUrl: z.string().trim().min(1).max(500), mergeCommit: commitHashSchema, summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("delivery-repair"), headCommit: commitHashSchema, summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("pull-request"), headCommit: commitHashSchema, pullRequestUrl: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("blocked"), summary: z.string().min(1).max(4000), blocker: blockerEvidenceSchema.optional() }).strict(),
  intentCheckReportSchema,
  verdictReportSchema,
  judgementReportSchema,
] as const;
const liveTeamReportSchema = z.discriminatedUnion("kind", [...sharedTeamReportVariants,
  strictDeliveryReconciliationReportSchema,
  z.object({ ...questionReportShape, recommendation: questionRecommendationSchema.optional() }).strict().superRefine(refineQuestion)]);
export const teamReportSchema = z.discriminatedUnion("kind", [...sharedTeamReportVariants,
  strictDeliveryReconciliationReportSchema,
  z.object({ ...questionReportShape, recommendation: requiredQuestionRecommendationSchema }).strict().superRefine(refineQuestion)]);
export const recordedTeamReportSchema = z.discriminatedUnion("kind", [...sharedTeamReportVariants,
  recordedDeliveryReconciliationReportSchema,
  z.object({ ...questionReportShape, recommendation: questionRecommendationSchema.optional() }).strict().superRefine(refineQuestion)]);
export type TeamReport = z.infer<typeof recordedTeamReportSchema>;
export const teamReportEnvelopeSchema = z.object({ requestId: z.uuid(), runId: z.uuid(), memberId: z.uuid(), revision: z.number().int().min(1), report: liveTeamReportSchema }).strict();
export const recordedTeamReportEnvelopeSchema = z.object({ requestId: z.uuid(), runId: z.uuid(), memberId: z.uuid(), revision: z.number().int().min(1), report: recordedTeamReportSchema }).strict();
export type TeamReportEnvelope = z.infer<typeof recordedTeamReportEnvelopeSchema>;
export type TeamAssignment = { runId: string; memberId: string; revision: number; role: TeamRole | "mission-coordinator"; taskId?: string; verificationRefused?: true; entryTools?: true; hostProfiles?: true };
export type TeamStatus = "planning" | "discovering" | "implementing" | "integrating" | "verifying" | "reviewing" | "delivering" | "merged" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-change" | "cancelled";
export interface TeamMember extends TeamAssignment {
  goalCriteriaPlan?: TeamGoalCriteriaPlanPin;
  role: TeamRole;
  provider?: Provider;
  modelProfile?: TeamModelProfile;
  sessionId: string;
  nativeSessionId?: string;
  continuation?: NativeContinuation;
  turns?: { sessionId: string; decisionId: string; startedAt: string; mode: "start" | "resume" }[];
  pendingFeedback?: string;
  title: string;
  status: "queued" | "running" | "waiting" | "reported" | "stopped" | "unavailable";
  cwd: string;
  scratchDirectory?: string;
  baseCommit: string;
  prompt: string;
  contextFeedback?: string;
  startedAt?: string;
  reportedAt?: string;
  lastActivityAt?: string;
  pendingLimit?: boolean;
  stalledAt?: string;
  report?: TeamReport;
  cursor: number;
  entryCursor?: number;
  stopRequestId: string;
  stoppedReason?: string;
  permissionBlocked?: { code: "locked"; at: string };
  workspaceRemovedAt?: string;
  savedWork?: TeamMemberSavedWork;
  retirement?: { requestId: string; at: string; identity: string; seq: number; processes: number; unsignalable: number };
  exitConfirmedAt?: string;
  usage?: UsageTotals;
}
export const ACTIVE_MEMBER_STATUSES: readonly TeamMember["status"][] = ["queued", "running", "reported", "unavailable"];
export type TaskRouting = { profileId: string; by: "router" | "fallback" };
export interface TeamTask extends TeamTaskPlan {
  revision: number;
  status: "pending" | "running" | "waiting" | "integrated" | "blocked";
  memberId?: string;
  commit?: string;
  summary?: string;
  rubric?: { version: 1; correctness: { score: number; why: string }; cleanliness: { score: number; why: string }; extensibility: { score: number; why: string }; docs: { score: number; why: string }; reviewerProfileId: string };
  ownerRating?: { score: 1 | 2 | 3 | 4 | 5; note?: string; at: string };
  diffStat?: { added: number; removed: number; files: number; docs: boolean; tests: boolean };
  changedPaths?: { paths: string[]; truncated: boolean };
  reviewRounds?: number;
  escalation?: { fromProfileId?: string; toProfileId: string; reason: string; memberId: string; at: string };
  limitSwitches?: { fromProfileId?: string; toProfileId: string; reason: string; resetsAt?: string; memberId: string; at: string }[];
  routing?: TaskRouting;
}
export interface TeamContinuation {
  revision: number;
  requestId: string;
  at: string;
  reason: string;
  baseCommit?: string;
  headCommit: string;
  tasks: TeamTask[];
  review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string; acceptance?: TeamAcceptanceEvidence[] };
  brief?: TeamBrief;
}
export interface TeamScout extends TeamScoutPlan {
  status: "pending" | "running" | "waiting" | "complete";
  routing?: TaskRouting;
  memberId?: string;
  summary?: string;
  evidence?: TeamEvidence[];
}
export type ReplayLink = { jobId: string; trialId: string; purpose: "replay" | "gate" | "duel"; ending?: TrialEnding | JudgeEnding; resultCommit?: string; resetsAt?: string; judgement?: Judgement; judgeMinutes?: number };
export interface TeamRun {
  blackboard?: { tools: true };
  routing?: TeamRunRouting;
  routingRevokedAt?: string;
  autonomy?: AutonomyMode;
  intentCheck?: "on" | "off";
  register?: "on";
  verdicts?: "on";
  assessment?: RunAssessment;
  permissions?: TeamPermissions;
  permissionsRevokedAt?: string;
  permissionDecisions?: TeamPermissionDecision[];
  permissionRecovery?: TeamPermissionRecoveryState;
  permissionAgentDecisions?: TeamPermissionAgentDecision[];
  establishChecks?: true;
  verification?: TeamVerification;
  verificationCorrections?: number[];
  reviewCorrections?: number[];
  verificationReconciliations?: { requestId: string; pendingId: string; revision: number; round: number; headCommit: string; interruptedChecks: number; attestation: string; at: string }[];
  changes?: { headCommit: string; recordedAt: string; files: { path: string; status: "added" | "modified" | "removed" | "renamed"; added: number | null; removed: number | null }[]; truncated: boolean };
  delivery?: TeamDelivery;
  publication?: TeamPublication;
  deliveryReceipt?: { revision: number; headCommit: string; pullRequestUrl: string; mergeCommit: string; summary: string; reportedAt: string };
  pullRequest?: { revision: number; headCommit: string; pullRequestUrl: string; summary: string; reportedAt: string; branch?: string };
  deliveryRecoveryAttempts?: number;
  reviewFeedback?: ReviewFeedbackEntry[];
  recovery?: {
    attempts: number;
    status: "stopping" | "planning" | "complete" | "exhausted";
    source: { code: string; memberId: string; revision: number; reportKind?: TeamReport["kind"]; reason: string; at: string };
  };
  deliveryRecovery?: {
    attempts: number;
    status: "stopping" | "planning" | "replanning" | "complete" | "exhausted";
    revision: number;
    headCommit: string;
    policyHash: string;
    sourceMemberId: string;
    lastFailureHash?: string;
    lastEvidenceHash?: string;
    baseHeadCommit?: string;
    integratedHeadCommit?: string;
    disposition?: "no-publication" | "owned-branch" | "pull-request";
  };
  deliveryOperationReconciliations?: { requestId: string; pendingId: string; pendingKind: "result"; revision: number; headCommit: string;
    source: { memberId: string; role: "delivery" }; failure: { code: string; reason: string; at: string };
    report: Extract<TeamReport, { kind: "delivery-reconciliation" }> & { disposition: "no-publication" }; recoveryAttempts: number;
    attestation: { boundary: "delivery-preparation"; processesStopped: true; text: string }; at: string }[];
  baseStale?: { fetchedAt?: string; reason: "fetch-failed"; category: "auth" | "network" | "not-found" | "other" };
  baseBehind?: { mirrorHead: string };
  titleSource?: "request" | "model" | "brief";
  linearTracking?: boolean;
  linear?: LinearTrackingView;
  id: string;
  projectId: string;
  provider: Provider;
  lineup?: TeamLineup;
  goal?: TeamGoalContext;
  missionId?: string;
  replay?: ReplayLink;
  requestSource?: ConnectorSource;
  workspaceRemovedAt?: string;
  handoff?: import("./handoff-types.js").TeamHandoffContext;
  brief?: TeamBrief;
  discovery?: { revision: number; summary: string; tasks: TeamScout[]; completedAt?: string };
  noChange?: { summary: string; evidence: TeamEvidence[] };
  stopReason?: "deadline" | "member-limit";
  title: string;
  objective: string;
  parallelismCeiling?: number;
  parallelism: number;
  revision: number;
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  branch: string;
  baseCommit: string;
  headCommit?: string;
  tasks: TeamTask[];
  continuations?: TeamContinuation[];
  members: TeamMember[];
  decisions: TeamDecision[];
  checks: TeamCheck[];
  steering: { text: string; revision: number; at: string; source?: SteeringSource }[];
  events: { at: string; text: string }[];
  reason?: string;
  blockCode?: string;
  review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string; acceptance?: TeamAcceptanceEvidence[] };
  round: number;
}
export type TeamView = Omit<TeamRun, "members" | "permissionDecisions" | "permissionRecovery"> & {
  pendingOperation?: TeamPendingOperation;
  members: Omit<TeamMember, "prompt" | "contextFeedback" | "nativeSessionId" | "continuation" | "turns" | "pendingFeedback" | "goalCriteriaPlan">[];
  permissionDecisions?: Omit<TeamPermissionDecision, "prompt" | "coordinatorSessionId">[];
  permissionRecovery?: { outcomes: TeamPermissionRecoveryView[] };
  usage: UsageRollup;
  providerLimits: ProviderLimit[];
  workers: { limit: number; max: number; running: number; ready: number };
  resumable: boolean;
  continuable: boolean;
};

export type GithubReviewSource = { kind: "github-review"; id: string; name: string };
export type SteeringSource = ConnectorSource | GithubReviewSource | "coordinator";
export const githubReviewSource = (reviewId: string): GithubReviewSource => ({ kind: "github-review", id: reviewId, name: "Your GitHub review" });
export type ReviewFeedbackOutcome = "accepted" | "applied" | "approved-seen" | "dismissed" | "stale-head" | "no-text" | "before-enable" | "limit" | "superseded" | "refused";
export type ReviewFeedbackEntry = { reviewId: string; state: "CHANGES_REQUESTED" | "APPROVED" | "DISMISSED"; submittedAt: string; receivedAt: string; outcome: ReviewFeedbackOutcome };
export const ownerSteering = (item: { source?: SteeringSource }) => !item.source || typeof item.source === "object" && item.source.kind === "github-review";
export const inputSourceLabel = (source?: SteeringSource | "slack") =>
  typeof source === "object" ? (source.kind === "github-review" ? "Owner (GitHub review)" : `Connector (${source.name})`) : source === "coordinator" ? "Mission coordinator" : "Owner";
export const decisionAnswerLabel = (decision: Pick<TeamDecision, "answeredBy" | "source">) =>
  decision.answeredBy === "connector" ? (decision.source ? inputSourceLabel(decision.source) : "Connector") : decision.answeredBy === "coordinator" ? "Mission coordinator" : "User";
export const decisionAuthorityQuestion = (decision: Pick<TeamDecision, "question" | "intentQuestions">) =>
  decision.intentQuestions ? `The intent check's questions ${decision.intentQuestions.join(", ")}` : decision.question;
