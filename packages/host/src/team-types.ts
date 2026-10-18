import { z } from "zod";
import type { Provider } from "./types.js";
import type { LinearTrackingView } from "./linear-types.js";

export const teamCommandSchema = z.object({
  command: z.string().min(1).max(4096).refine(value => !value.includes("\0")),
  args: z.array(z.string().max(4096).refine(value => !value.includes("\0"))).max(64).default([]),
}).strict();
export type TeamCommand = z.infer<typeof teamCommandSchema>;
export const teamProjectSchema = z.object({
  setup: teamCommandSchema.optional(),
  checks: z.array(teamCommandSchema).min(1).max(8),
}).strict();
export type TeamProject = z.infer<typeof teamProjectSchema>;
const modelProfileFields = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  label: z.string().trim().min(1).max(100),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/),
  tier: z.enum(["light", "strong"]).optional(),
  dataUse: z.enum(["standard", "contributor"]).optional(),
};
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const teamModelProfileSchema = z.discriminatedUnion("provider", [
  // Preserve legacy parsed key order: session request fingerprints include these objects.
  z.object({ id: modelProfileFields.id, label: modelProfileFields.label, provider: z.literal("claude"), model: modelProfileFields.model, effort, tier: modelProfileFields.tier, dataUse: modelProfileFields.dataUse }).strict(),
  z.object({ id: modelProfileFields.id, label: modelProfileFields.label, provider: z.literal("codex"), model: modelProfileFields.model, effort, tier: modelProfileFields.tier, dataUse: modelProfileFields.dataUse }).strict(),
  z.object({ id: modelProfileFields.id, label: modelProfileFields.label, provider: z.literal("opencode"), model: z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/), variant: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).optional(), tier: modelProfileFields.tier, dataUse: modelProfileFields.dataUse }).strict(),
]);
export type TeamModelProfile = z.infer<typeof teamModelProfileSchema>;
export const teamLineupSchema = z.object({
  coordinator: teamModelProfileSchema,
  integrator: teamModelProfileSchema,
  reviewer: teamModelProfileSchema,
  implementers: z.array(teamModelProfileSchema).min(1).max(8),
  escalations: z.array(teamModelProfileSchema).min(1).max(8).optional(),
}).strict().superRefine((lineup, context) => {
  for (const pool of ["implementers", "escalations"] as const) {
    const ids = new Set<string>();
    for (const [index, profile] of (lineup[pool] ?? []).entries()) {
      if (ids.has(profile.id)) context.addIssue({ code: "custom", path: [pool, index, "id"], message: "Profile IDs must be unique within a pool" });
      ids.add(profile.id);
    }
  }
  const identities = new Map<string, string>();
  for (const profile of [lineup.coordinator, lineup.integrator, lineup.reviewer, ...lineup.implementers, ...(lineup.escalations ?? [])]) {
    const identity = JSON.stringify([profile.provider, profile.model, profile.provider === "opencode" ? profile.variant : profile.effort, profile.tier, profile.dataUse ?? "standard"]);
    if (identities.has(profile.id) && identities.get(profile.id) !== identity)
      context.addIssue({ code: "custom", message: "A profile ID must identify the same provider, model, and effort throughout a lineup" });
    identities.set(profile.id, identity);
  }
});
export type TeamLineup = z.infer<typeof teamLineupSchema>;
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
export const teamActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
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
  z.object({ kind: z.literal("plan"), summary: z.string().min(1).max(4000), brief: teamBriefSchema.optional(), tasks: z.array(teamTaskPlanSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("explore"), summary: z.string().min(1).max(4000), tasks: z.array(teamScoutPlanSchema).min(1).max(3) }).strict(),
  z.object({ kind: z.literal("findings"), summary: z.string().min(1).max(4000), evidence: z.array(teamEvidenceSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("no-change"), summary: z.string().min(1).max(4000), evidence: z.array(teamEvidenceSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("escalate"), agentProfileId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), reason: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("result"), summary: z.string().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("review"), verdict: z.enum(["approved", "changes-requested"]), summary: z.string().min(1).max(8000), uiEvidence: z.string().trim().min(1).max(4000).optional() }).strict(),
  z.object({ kind: z.literal("question"), question: z.string().min(1).max(4000), options: z.array(z.string().min(1).max(500)).max(4).default([]) }).strict(),
  z.object({ kind: z.literal("blocked"), summary: z.string().min(1).max(4000) }).strict(),
]);
export type TeamReport = z.infer<typeof teamReportSchema>;
export const teamReportEnvelopeSchema = z.object({ requestId: z.uuid(), runId: z.uuid(), memberId: z.uuid(), revision: z.number().int().min(1), report: teamReportSchema }).strict();
export type TeamReportEnvelope = z.infer<typeof teamReportEnvelopeSchema>;
export type TeamRole = "project-manager" | "scout" | "implementer" | "integrator" | "reviewer";
export type TeamAssignment = { runId: string; memberId: string; revision: number; role: TeamRole; taskId?: string };
export type TeamStatus = "planning" | "discovering" | "implementing" | "integrating" | "verifying" | "reviewing" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-change" | "cancelled";
export interface TeamMember extends TeamAssignment {
  /** Absent on legacy runs; their members use the run's original provider. */
  provider?: Provider;
  modelProfile?: TeamModelProfile;
  sessionId: string;
  title: string;
  status: "queued" | "running" | "waiting" | "reported" | "stopped" | "unavailable";
  cwd: string;
  baseCommit: string;
  prompt: string;
  startedAt?: string;
  report?: TeamReport;
  cursor: number;
  stopRequestId: string;
}
export interface TeamTask extends TeamTaskPlan {
  status: "pending" | "running" | "waiting" | "integrated" | "blocked";
  memberId?: string;
  commit?: string;
  summary?: string;
  escalation?: { fromProfileId?: string; toProfileId: string; reason: string; memberId: string; at: string };
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
  answeredAt?: string;
}
export interface TeamCheck {
  command: TeamCommand;
  status: "running" | "passed" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  output: string;
  revision: number;
}
export interface TeamRun {
  linear?: LinearTrackingView;
  id: string;
  projectId: string;
  provider: Provider;
  /** Immutable model choices; current provider credentials and permissions are not copied here. */
  lineup?: TeamLineup;
  goal?: TeamGoalContext;
  brief?: TeamBrief;
  discovery?: { revision: number; summary: string; tasks: TeamScout[]; completedAt?: string };
  noChange?: { summary: string; evidence: TeamEvidence[] };
  stopReason?: "deadline" | "member-limit";
  title: string;
  objective: string;
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
  members: TeamMember[];
  decisions: TeamDecision[];
  checks: TeamCheck[];
  steering: { text: string; revision: number; at: string }[];
  events: { at: string; text: string }[];
  reason?: string;
  review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string };
  round: number;
}
export type TeamView = Omit<TeamRun, "members"> & { members: Omit<TeamMember, "prompt">[] };
