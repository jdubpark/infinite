import { z } from "zod";

export const permissionProjectIdSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
const timestampSchema = z.string().datetime();
const deviceIdSchema = z.string().min(1).max(200);

export const permissionDelegationActorSchema = z.object({
  deviceId: z.string().trim().min(1).max(200),
}).strict();
export type PermissionDelegationActor = z.infer<typeof permissionDelegationActorSchema>;

export const permissionDelegationDirectionSchema = z.string().trim().min(1).max(4000);

export const permissionDelegationRequestSchema = z.object({
  requestId: z.uuid(),
  direction: permissionDelegationDirectionSchema.nullable().optional(),
}).strict();
export type PermissionDelegationRequest = z.infer<typeof permissionDelegationRequestSchema>;

export const permissionDelegationMutationRequestSchema = z.object({
  requestId: z.uuid(),
}).strict();
export type PermissionDelegationMutationRequest = z.infer<typeof permissionDelegationMutationRequestSchema>;

export interface PermissionCoverageEntry {
  projectId: string;
  act: "delegate" | "onboarding";
  /** The workspace named by the owner act; the current holder is resolved separately. */
  workspaceId: string;
  by: string;
  at: string;
  interruptClasses: string[];
  policyVersion: number;
  /** The project's root path at the owner act. Another checkout enrolled later under the same id is not covered. */
  path: string;
  /** The project's owner-move mark at the owner act. An owner regrouping that moves the project changes the mark. */
  moveMark: string;
  direction?: string;
}

export const permissionCoverageEntrySchema = z.object({
  projectId: permissionProjectIdSchema,
  act: z.enum(["delegate", "onboarding"]),
  workspaceId: permissionProjectIdSchema,
  by: deviceIdSchema,
  at: timestampSchema,
  interruptClasses: z.array(z.string().min(1)),
  policyVersion: z.number().int().positive(),
  path: z.string().min(1).max(4096),
  moveMark: z.string().min(1).max(200),
  direction: z.string().max(4000).optional(),
}).strict();

export interface PermissionOptOut {
  projectId: string;
  by: string;
  at: string;
}

export const permissionOptOutSchema = z.object({
  projectId: permissionProjectIdSchema,
  by: deviceIdSchema,
  at: timestampSchema,
}).strict();

export const permissionKnownProjectIdsSchema = z.array(permissionProjectIdSchema)
  .refine(ids => new Set(ids).size === ids.length, { message: "Known project IDs must be unique." });

const permissionReceiptSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.unknown(),
}).strict();

export const permissionDelegationStoredStateSchema = z.object({
  entries: z.record(permissionProjectIdSchema, permissionCoverageEntrySchema),
  optOuts: z.record(permissionProjectIdSchema, permissionOptOutSchema),
  knownProjectIds: permissionKnownProjectIdsSchema,
  receipts: z.record(z.uuid(), permissionReceiptSchema),
}).strict().superRefine((state, context) => {
  const known = new Set(state.knownProjectIds);
  for (const [projectId, entry] of Object.entries(state.entries)) {
    if (entry.projectId !== projectId)
      context.addIssue({ code: "custom", path: ["entries", projectId, "projectId"], message: "Entry project ID does not match its key." });
    if (!known.has(projectId))
      context.addIssue({ code: "custom", path: ["knownProjectIds"], message: "Known project IDs must include every coverage entry." });
  }
  for (const [projectId, optOut] of Object.entries(state.optOuts)) {
    if (optOut.projectId !== projectId)
      context.addIssue({ code: "custom", path: ["optOuts", projectId, "projectId"], message: "Opt-out project ID does not match its key." });
    if (!known.has(projectId))
      context.addIssue({ code: "custom", path: ["knownProjectIds"], message: "Known project IDs must include every opt-out." });
  }
});
export type PermissionDelegationStoredState = z.infer<typeof permissionDelegationStoredStateSchema>;

export type CoverageResult =
  | {
    covered: true;
    projectId: string;
    workspaceId: string;
    coverage: PermissionCoverageEntry;
    interruptClasses: string[];
    authorityHash: string;
  }
  | { covered: false; projectId: string; reason: "unknown-project" | "not-covered" | "opt-out" };

export interface WorkspaceDelegationProjectView {
  projectId: string;
  name: string;
  state: "covered" | "opt-out" | "not-covered";
  act?: PermissionCoverageEntry["act"];
  at?: string;
}

export interface WorkspaceDelegationView {
  workspaceId: string;
  name: string;
  state: "delegated" | "partly-delegated" | "not-delegated";
  direction?: string;
  projects: WorkspaceDelegationProjectView[];
}

export type PermissionDelegationGroup = {
  id: string;
  name: string;
  repos: Array<{ checkouts: Array<{ projectId: string; name?: string }> }>;
};
