import { z } from "zod";

const hostProjectId = z.string().regex(/^[a-z0-9-]{1,80}$/);
export const projectGroupIdSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);

/** An owner-created project made of one or more enrolled repositories (host projects). */
export const createProjectGroupSchema = z.object({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  repos: z.array(hostProjectId).min(1).max(12),
}).strict().refine(value => new Set(value.repos).size === value.repos.length, { path: ["repos"], message: "List each repository once." });
export type CreateProjectGroup = z.infer<typeof createProjectGroupSchema>;
export const updateProjectGroupSchema = z.object({
  requestId: z.uuid(),
  revision: z.number().int().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  repos: z.array(hostProjectId).min(1).max(12).optional(),
}).strict();
export type UpdateProjectGroup = z.infer<typeof updateProjectGroupSchema>;

export interface ProjectGroupRepo {
  /** Host project ID of the enrolled repository. */
  projectId: string;
  name: string;
  /** Host path of the repository's Git root. */
  path: string;
}
export interface ProjectGroup {
  id: string;
  name: string;
  repos: ProjectGroupRepo[];
  /** True for an enrolled repository that belongs to no owner-created group; its ID is the host project ID. */
  implicit: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
/** A suggested grouping. Never applied without an explicit owner create. */
export interface ProjectGroupSuggestion {
  name: string;
  repos: string[];
  reason: "shared-parent" | "shared-linear-project";
}
export interface ProjectGroupList {
  groups: ProjectGroup[];
  suggestions: ProjectGroupSuggestion[];
}
