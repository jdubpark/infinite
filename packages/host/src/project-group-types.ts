import { z } from "zod";

const hostProjectId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const repoListSchema = z.array(hostProjectId).min(1).max(64)
  .refine(value => new Set(value).size === value.length, { message: "List each repository once." });
export const projectGroupIdSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);

export const createProjectGroupSchema = z.object({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  repos: repoListSchema,
}).strict();
export type CreateProjectGroup = z.infer<typeof createProjectGroupSchema>;
export const updateProjectGroupSchema = z.object({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  repos: repoListSchema.optional(),
  hidden: z.boolean().optional(),
  primary: repoListSchema.optional(),
}).strict();
export type UpdateProjectGroup = z.infer<typeof updateProjectGroupSchema>;

export type ProjectGroupKind = "owner" | "repository" | "implicit";
export interface ProjectGroupCheckout {
  projectId: string;
  name: string;
  path: string;
  primary: boolean;
  teamReady: boolean;
  identityFrom?: "source" | "host-scan";
}
export interface ProjectGroupRepo {
  projectId: string;
  name: string;
  path: string;
  key?: string;
  checkouts: ProjectGroupCheckout[];
}
export interface ProjectGroup {
  id: string;
  name: string;
  kind: ProjectGroupKind;
  hidden: boolean;
  repos: ProjectGroupRepo[];
  implicit: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectGroupSuggestion {
  name: string;
  repos: string[];
  groupIds: string[];
  reason: "shared-parent" | "shared-linear-project";
}
export interface ProjectGroupList {
  groups: ProjectGroup[];
  suggestions: ProjectGroupSuggestion[];
}
