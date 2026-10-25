import { z } from "zod";
import type { Prompt, AnswerResult } from "@infinite/attention";
import type { Receipt } from "./types.js";
import type { Provider } from "./types.js";
import type { LinearTrackingView } from "./linear-types.js";
import type { UsageTotals } from "./usage.js";
import type { UsageRollup } from "./team-usage.js";
import type { ProviderLimit } from "./provider-limits.js";

export const teamCommandSchema = z.object({
  command: z.string().min(1).max(4096).refine(value => !value.includes("\0")),
  args: z.array(z.string().max(4096).refine(value => !value.includes("\0"))).max(64).default([]),
}).strict();
export type TeamCommand = z.infer<typeof teamCommandSchema>;
export const githubRepositorySchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const githubRepository = githubRepositorySchema;
export const gitBranchSchema = z.string().min(1).max(255).refine(value =>
  value !== "@" && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && !value.includes("..") && !value.includes("@{") &&
  !value.includes("//") && !value.includes("\\") && !/[~^:?*\s\x00-\x1f\x7f]/.test(value) &&
  !value.includes("[") && !value.includes("]") &&
  value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
"Use a safe Git branch name");
const gitBranch = gitBranchSchema;
/** Where the host's copy of a project comes from. `github`: the host follows the base branch itself; `laptop`: workspace sync from the owner's computer. */
export const projectSourceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("github"), repository: githubRepository, baseBranch: gitBranch }).strict(),
  z.object({ mode: z.literal("laptop") }).strict(),
]);
export type ProjectSource = z.infer<typeof projectSourceSchema>;
/** `merge`: the delivery member merges the reviewed head itself. `pr`: it pushes the branch and opens a pull request, and the owner merges on GitHub. */
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
/** The owner's default delegation: routine development work is the coordinator's to approve; release actions stay with the owner. */
export const DEFAULT_PERMISSION_SCOPE = "Approve one-time development operations that an engineer would routinely run for the accepted objective and assigned role inside the assigned workspace: repository inspection and fetch, scoped edits and staging, dependency installation from the repository's declared manifests and lockfiles, test planning, builds, tests, scripts, local listeners and local browser checks. These may run outside the provider sandbox and use network access, local sockets, IPC and task-owned temporary files while preserving the assigned repository and path scope. Delivery operations require the run's separate pinned delivery policy. Escalate only production or staging actions such as deploy, promote, roll out, release or publish, new or external credentials, other repositories, global or account settings, destructive operations outside the assigned workspace, persistent approvals, permission bypasses, and commands whose effect is unrelated to the task or appears malicious.";
export const DEFAULT_PERMISSION_LIMIT = 25;
export const MAX_PERMISSION_LIMIT = 50;
/** Earlier host defaults. A saved policy that still reads exactly like one was never customised by the owner. */
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
/**
 * The policy a new run pins. An enrollment saved with an earlier host default follows the current
 * default scope and limit; a scope the owner wrote, or a limit the owner lowered, is kept as saved.
 */
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
  /** Absent only when the target workspace or changed paths could not be inspected. */
  reuseKey?: string;
  reusedFromDecisionId?: string;
  verdict?: "approve-once" | "escalate";
  /** Binds inspected command sources and changed paths to this exact review. */
  workspaceEvidenceHash?: string;
  prompt: Prompt;
  option: number;
  expiresAt: string;
  coordinatorMemberId?: string;
  answerRequestId: string;
  status: "pending" | "reviewing" | "approved" | "answering" | "answered" | "escalated" | "stale" | "uncertain";
  reason?: string;
  receipt?: Receipt & { result?: AnswerResult };
}
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
}).strict().superRefine((project, context) => {
  if (project.establishChecks ? project.checks.length > 0 : project.checks.length === 0)
    context.addIssue({ code: "custom", path: ["checks"], message: "Configure required checks, or explicitly authorize the team to establish them with an empty checks array." });
  if (project.handoffMaxTotalMinutes !== undefined && project.handoffMaxTotalMinutes < (project.handoffMinutes ?? 60))
    context.addIssue({ code: "custom", path: ["handoffMaxTotalMinutes"], message: "The handoff ceiling cannot be shorter than its time limit." });
});
export type TeamProject = z.infer<typeof teamProjectSchema>;
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
  // Preserve legacy parsed key order: session request fingerprints include these objects.
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
}).strict().superRefine((lineup, context) => {
  for (const pool of ["implementers", "escalations", "fallbacks"] as const) {
    const ids = new Set<string>();
    for (const [index, profile] of (lineup[pool] ?? []).entries()) {
      if (ids.has(profile.id)) context.addIssue({ code: "custom", path: [pool, index, "id"], message: "Profile IDs must be unique within a pool" });
      ids.add(profile.id);
    }
  }
  const identities = new Map<string, string>();
  const profiles = lineupProfiles(lineup);
  for (const profile of profiles) {
    const identity = JSON.stringify([profile.provider, profile.model, profile.provider === "opencode" ? profile.variant : profile.effort, profile.tier, profile.dataUse ?? "standard", profile.limitFallback ?? null]);
    if (identities.has(profile.id) && identities.get(profile.id) !== identity)
      context.addIssue({ code: "custom", message: "A profile ID must identify the same provider, model, and effort throughout a lineup" });
    identities.set(profile.id, identity);
  }
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  for (const profile of profiles) {
    if (!profile.limitFallback) continue;
    const seen = new Set([profile.id]);
    let current: TeamModelProfile = profile;
    for (let hop = 1; current.limitFallback; hop++) {
      const target = byId.get(current.limitFallback);
      if (!target) { context.addIssue({ code: "custom", message: `Limit fallback "${current.limitFallback}" of "${current.id}" is not a profile in this lineup` }); break; }
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
type LineupShape = Pick<TeamLineup, "coordinator" | "integrator" | "reviewer" | "implementers" | "escalations" | "fallbacks">;
export function lineupProfiles(lineup: LineupShape): TeamModelProfile[] {
  return [lineup.coordinator, lineup.integrator, lineup.reviewer, ...lineup.implementers, ...(lineup.escalations ?? []), ...(lineup.fallbacks ?? [])];
}
/** First profile reachable within two `limitFallback` hops whose provider is not limited. */
export function resolveLimitFallback(lineup: LineupShape, profileId: string, limited: Set<Provider>): TeamModelProfile | undefined {
  const profiles = lineupProfiles(lineup);
  let current = profiles.find(profile => profile.id === profileId);
  for (let hop = 0; hop < 2 && current?.limitFallback; hop++) {
    const next = profiles.find(profile => profile.id === current!.limitFallback);
    if (next && !limited.has(next.provider)) return next;
    current = next;
  }
  return undefined;
}
export const createTeamSchema = z.object({
  requestId: z.uuid(),
  projectId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  provider: z.enum(["claude", "codex", "grok", "opencode", "demo"]),
  useConfiguredLineup: z.boolean().optional(),
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(24000),
  /** Legacy request field. Capacity is selected by the project manager after planning. */
  parallelism: z.number().int().min(1).max(4).default(2),
}).strict();
export type CreateTeam = z.infer<typeof createTeamSchema>;
export const teamMutationSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1), text: z.string().trim().min(1).max(8000) }).strict();
export const teamDeliveryReconcileSchema = z.object({
  requestId: z.uuid(), revision: z.number().int().min(1), text: z.string().trim().min(1).max(8000),
  failedOperation: z.object({ pendingId: z.uuid(), headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    attestation: z.object({ boundary: z.literal("delivery-preparation"), processesStopped: z.literal(true), text: z.string().trim().min(1).max(4000) }).strict() }).strict().optional(),
}).strict();
export type TeamDeliveryReconcile = z.infer<typeof teamDeliveryReconcileSchema>;
export const teamVerificationReconcileSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1), pendingId: z.uuid(),
  headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
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
const ownedPath = z.string().min(1).max(300).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => part === ".." || part === ".git" || part === "." || part === ""), "Use a repository-relative file or directory without glob syntax").refine(value => !/[*?\[\]:]/.test(value));
export const teamGoalContextSchema = z.object({
  id: z.uuid(), revision: z.number().int().min(1), cycle: z.number().int().min(1),
  successCriteria: z.string().trim().min(1).max(8000),
  nonGoals: z.array(z.string().trim().min(1).max(1000)).max(20),
  allowedPaths: z.array(z.union([z.literal("."), ownedPath])).min(1).max(32),
  evidence: z.array(z.string().trim().min(1).max(2000)).max(20),
  sourceIssue: z.object({ id: z.uuid(), identifier: z.string().max(100), url: z.url(), title: z.string().max(1000), description: z.string().max(24000).nullable() }).strict().optional(),
  previousWork: z.array(z.string().trim().min(1).max(2000)).max(16),
  deadlineAt: z.iso.datetime(), maxMembers: z.number().int().min(1).max(60), parentRunId: z.uuid().optional(),
  /** Owner-approved automatic extension; absent when the goal has no extension policy. */
  extendMinutes: z.number().int().min(0).max(240).optional(), ceilingAt: z.iso.datetime().optional(),
  /** Set only after an explicit owner extension to distinguish it from an unapproved deadline mismatch. */
  ownerExtendedDeadlineAt: z.iso.datetime().optional(),
}).strict();
export type TeamGoalContext = z.infer<typeof teamGoalContextSchema>;
export const teamEvidenceSchema = z.object({ source: z.string().trim().min(1).max(1000), observation: z.string().trim().min(1).max(2000) }).strict();
export type TeamEvidence = z.infer<typeof teamEvidenceSchema>;
export const teamBriefSchema = z.object({
  title: z.string().trim().min(1).max(100), problem: z.string().trim().min(1).max(3000),
  evidence: z.array(teamEvidenceSchema).min(1).max(12), dataShape: z.string().trim().min(1).max(3000),
  acceptance: z.array(z.string().trim().min(1).max(1000)).min(1).max(8),
  expectedOutcome: z.string().trim().min(1).max(2000), uiChanges: z.boolean(),
}).strict();
export type TeamBrief = z.infer<typeof teamBriefSchema>;
export const teamScoutPlanSchema = z.object({ id: taskId, title: z.string().trim().min(1).max(100), instructions: z.string().trim().min(1).max(4000), agentProfileId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict();
export type TeamScoutPlan = z.infer<typeof teamScoutPlanSchema>;
export const teamTaskPlanSchema = z.object({
  id: taskId,
  title: z.string().trim().min(1).max(100),
  instructions: z.string().trim().min(1).max(8000),
  agentProfileId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
  paths: z.array(ownedPath).min(1).max(32),
  dependsOn: z.array(taskId).max(12),
}).strict();
export type TeamTaskPlan = z.infer<typeof teamTaskPlanSchema>;
export const teamReportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission-decision"), decisionId: z.uuid(), verdict: z.enum(["approve-once", "escalate"]), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("plan"), summary: z.string().min(1).max(4000), parallelism: z.number().int().min(1).max(4).optional(), brief: teamBriefSchema.optional(), tasks: z.array(teamTaskPlanSchema).min(1).max(12), verification: teamVerificationSchema.optional() }).strict(),
  z.object({ kind: z.literal("explore"), summary: z.string().min(1).max(4000), parallelism: z.number().int().min(1).max(4).optional(), tasks: z.array(teamScoutPlanSchema).min(1).max(3) }).strict(),
  z.object({ kind: z.literal("findings"), summary: z.string().min(1).max(4000), evidence: z.array(teamEvidenceSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("no-change"), summary: z.string().min(1).max(4000), evidence: z.array(teamEvidenceSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("escalate"), agentProfileId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), reason: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("result"), summary: z.string().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("review"), verdict: z.enum(["approved", "changes-requested"]), summary: z.string().min(1).max(8000), uiEvidence: z.string().trim().min(1).max(4000).optional(), rubric: z.array(z.object({ taskId, correctness: z.object({ score: z.number().int().min(1).max(5), why: z.string().trim().min(1).max(300) }).strict(), cleanliness: z.object({ score: z.number().int().min(1).max(5), why: z.string().trim().min(1).max(300) }).strict(), extensibility: z.object({ score: z.number().int().min(1).max(5), why: z.string().trim().min(1).max(300) }).strict(), docs: z.object({ score: z.number().int().min(1).max(5), why: z.string().trim().min(1).max(300) }).strict() }).strict()).max(12).optional() }).strict(),
  z.object({ kind: z.literal("delivery"), headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i), pullRequestUrl: z.string().trim().min(1).max(500), mergeCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i), summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("delivery-repair"), headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i), summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("delivery-reconciliation"), headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i), repository: githubRepository, branch: gitBranch, baseHeadCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i), disposition: z.enum(["no-publication", "owned-branch", "pull-request"]), remoteHeadCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i).optional(), pullRequestUrl: z.string().trim().min(1).max(500).optional(), summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("pull-request"), headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i), pullRequestUrl: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("question"), question: z.string().min(1).max(4000), options: z.array(z.string().min(1).max(500)).max(4).default([]) }).strict(),
  z.object({ kind: z.literal("blocked"), summary: z.string().min(1).max(4000) }).strict(),
]);
export type TeamReport = z.infer<typeof teamReportSchema>;
export const teamReportEnvelopeSchema = z.object({ requestId: z.uuid(), runId: z.uuid(), memberId: z.uuid(), revision: z.number().int().min(1), report: teamReportSchema }).strict();
export type TeamReportEnvelope = z.infer<typeof teamReportEnvelopeSchema>;
export type TeamRole = "permission-coordinator" | "project-manager" | "scout" | "implementer" | "integrator" | "reviewer" | "delivery";
/** A mission coordinator's assignment carries the mission ID as `runId`; it reports `MissionReport`s. */
export type TeamAssignment = { runId: string; memberId: string; revision: number; role: TeamRole | "mission-coordinator"; taskId?: string; verificationRefused?: true };
/** `merged` is set only from an explicit delivery report; it is not host verification. */
export type TeamStatus = "planning" | "discovering" | "implementing" | "integrating" | "verifying" | "reviewing" | "delivering" | "merged" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-change" | "cancelled";
export interface TeamMember extends TeamAssignment {
  role: TeamRole;
  /** Absent on legacy runs; their members use the run's original provider. */
  provider?: Provider;
  modelProfile?: TeamModelProfile;
  sessionId: string;
  title: string;
  status: "queued" | "running" | "waiting" | "reported" | "stopped" | "unavailable";
  cwd: string;
  /** Host-assigned external directory for this member's temporary development files. */
  scratchDirectory?: string;
  baseCommit: string;
  prompt: string;
  /** Full assignment feedback for the private context file; omitted from client views. */
  contextFeedback?: string;
  startedAt?: string;
  reportedAt?: string;
  /** The latest attention activity the host observed for this member while it had no report. */
  lastActivityAt?: string;
  /** A provider limit was observed but the member has not yet been switched or stopped. */
  pendingLimit?: boolean;
  /** Set when the member stopped for lack of activity; its replacement continues the same assignment. */
  stalledAt?: string;
  report?: TeamReport;
  cursor: number;
  stopRequestId: string;
  /** Why the host stopped this member without a report, such as a provider usage limit. */
  stoppedReason?: string;
  /** Confirmed process retirement for a recording-failed reviewer; its original journal remains sealed. */
  retirement?: { requestId: string; at: string; identity: string; seq: number; processes: number; unsignalable: number };
  /** Set only after stopped() confirms exit while the member waits for serialized integration. */
  exitConfirmedAt?: string;
  /** Computed on read for members whose provider reports usage; never stored. */
  usage?: UsageTotals;
}
export interface TeamTask extends TeamTaskPlan {
  /** Run revision whose plan created this task. */
  revision: number;
  status: "pending" | "running" | "waiting" | "integrated" | "blocked";
  memberId?: string;
  commit?: string;
  summary?: string;
  rubric?: { version: 1; correctness: { score: number; why: string }; cleanliness: { score: number; why: string }; extensibility: { score: number; why: string }; docs: { score: number; why: string }; reviewerProfileId: string };
  ownerRating?: { score: 1 | 2 | 3 | 4 | 5; note?: string; at: string };
  diffStat?: { added: number; removed: number; files: number; docs: boolean; tests: boolean };
  reviewRounds?: number;
  escalation?: { fromProfileId?: string; toProfileId: string; reason: string; memberId: string; at: string };
  /** Each provider-limit switch of this task's member; a replacement can itself be switched. */
  limitSwitches?: { fromProfileId?: string; toProfileId: string; reason: string; resetsAt?: string; memberId: string; at: string }[];
}
export interface TeamContinuation {
  revision: number;
  requestId: string;
  at: string;
  reason: string;
  baseCommit?: string;
  headCommit: string;
  tasks: TeamTask[];
  review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string };
  brief?: TeamBrief;
}
export interface TeamScout extends TeamScoutPlan {
  status: "pending" | "running" | "waiting" | "complete";
  memberId?: string;
  summary?: string;
  evidence?: TeamEvidence[];
}
export interface TeamDecision {
  id: string;
  memberId: string;
  revision: number;
  question: string;
  options: string[];
  createdAt: string;
  answer?: string;
  answeredBy?: "owner" | "coordinator";
  answeredAt?: string;
}
export interface TeamCheck {
  command: TeamCommand;
  phase?: "setup";
  headCommit?: string;
  status: "running" | "passed" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  output: string;
  revision: number;
  /** Correction round that launched this verification attempt. */
  round?: number;
}
export interface TeamRun {
  /** Explicit owner delegation pinned at creation. Old runs remain opted out. */
  permissions?: TeamPermissions;
  permissionsRevokedAt?: string;
  permissionDecisions?: TeamPermissionDecision[];
  /** Owner opt-in is pinned at creation; accepted commands cannot change within this run. */
  establishChecks?: true;
  verification?: TeamVerification;
  /** Revisions where an unauthorized verification plan already received its one correction. */
  verificationCorrections?: number[];
  verificationReconciliations?: { requestId: string; pendingId: string; revision: number; round: number; headCommit: string; interruptedChecks: number; attestation: string; at: string }[];
  /** Owner-authorized repository delivery policy pinned when this run starts. */
  delivery?: TeamDelivery;
  /** Agent-reported delivery evidence; this is not independently verified by the host. */
  deliveryReceipt?: { revision: number; headCommit: string; pullRequestUrl: string; mergeCommit: string; summary: string; reportedAt: string };
  /** Agent-reported open pull request for a `pr` delivery; the owner merges it on GitHub. Not host verification. */
  pullRequest?: { revision: number; headCommit: string; pullRequestUrl: string; summary: string; reportedAt: string };
  /** Bounded PM recovery of routine report/protocol failures; member reports remain the evidence source. */
  recovery?: {
    attempts: number;
    status: "stopping" | "planning" | "complete" | "exhausted";
    source: { code: string; memberId: string; revision: number; reportKind?: TeamReport["kind"]; reason: string; at: string };
  };
  /** Bounded delivery inspection and baseline recovery; provider observations remain agent claims. */
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
  /** Durable evidence that an owner cleared an attributed failed delivery-preparation gate. */
  deliveryOperationReconciliations?: { requestId: string; pendingId: string; pendingKind: "result"; revision: number; headCommit: string;
    source: { memberId: string; role: "delivery" }; failure: { code: string; reason: string; at: string };
    report: Extract<TeamReport, { kind: "delivery-reconciliation" }> & { disposition: "no-publication" }; recoveryAttempts: number;
    attestation: { boundary: "delivery-preparation"; processesStopped: true; text: string }; at: string }[];
  /** The base came from the host mirror while the latest fetch from GitHub failed. */
  baseStale?: { fetchedAt?: string; reason: "fetch-failed"; category: "auth" | "network" | "not-found" | "other" };
  /** A continuation kept its parent's base while the mirror already holds a newer base-branch head. */
  baseBehind?: { mirrorHead: string };
  /** Whether the current run title came from its request, a naming model, or the coordinator brief. */
  titleSource?: "request" | "model" | "brief";
  linearTracking?: boolean;
  linear?: LinearTrackingView;
  id: string;
  projectId: string;
  provider: Provider;
  /** Immutable model choices; current provider credentials and permissions are not copied here. */
  lineup?: TeamLineup;
  goal?: TeamGoalContext;
  /** Set when a mission started this run as one of its subteams; the board shows it only inside that mission. */
  missionId?: string;
  handoff?: import("./handoff-types.js").TeamHandoffContext;
  brief?: TeamBrief;
  discovery?: { revision: number; summary: string; tasks: TeamScout[]; completedAt?: string };
  noChange?: { summary: string; evidence: TeamEvidence[] };
  stopReason?: "deadline" | "member-limit";
  title: string;
  objective: string;
  /** Maximum worker slots allowed for this run; absent on legacy records. */
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
  steering: { text: string; revision: number; at: string }[];
  events: { at: string; text: string }[];
  reason?: string;
  /** TeamError.code for the current blocked state; absent on legacy records. */
  blockCode?: string;
  review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string };
  round: number;
}
/** `providerLimits` is the host's active limit memory at read time, shared by every run. */
export type TeamView = Omit<TeamRun, "members" | "permissionDecisions"> & {
  pendingOperation?: { id: string; kind: "prepare" | "member" | "result" | "check"; revision: number; failed: boolean;
    failureCode?: string; sourceMemberId?: string; sourceRole?: TeamMember["role"] };
  members: Omit<TeamMember, "prompt" | "contextFeedback">[];
  permissionDecisions?: Omit<TeamPermissionDecision, "prompt">[];
  usage: UsageRollup;
  providerLimits: ProviderLimit[];
  workers: { limit: number; max: number; running: number; ready: number };
  resumable: boolean;
  continuable: boolean;
};
