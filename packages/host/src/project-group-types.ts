import { z } from "zod";

const hostProjectId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const repoListSchema = z.array(hostProjectId).min(1).max(64)
  .refine(value => new Set(value).size === value.length, { message: "List each repository once." });
export const projectGroupIdSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);

/** An owner-created project made of one or more enrolled repositories (host projects). */
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
  /** Host project ids to make the primary checkout of their repository; at most one per repository. */
  primary: repoListSchema.optional(),
}).strict();
export type UpdateProjectGroup = z.infer<typeof updateProjectGroupSchema>;

/** `owner`: created or edited by the owner. `repository`: one the host created for a repository identity. `implicit`: an ungrouped checkout without identity. */
export type ProjectGroupKind = "owner" | "repository" | "implicit";
/** One enrolled host project that is a copy of a repository. */
export interface ProjectGroupCheckout {
  projectId: string;
  /** The host project's own name, shown only in detail views. */
  name: string;
  path: string;
  primary: boolean;
  teamReady: boolean;
  identityFrom?: "source" | "host-scan";
}
export interface ProjectGroupRepo {
  /** Host project ID of the repository's primary checkout. */
  projectId: string;
  /** The repository's display name. */
  name: string;
  /** Host path of the primary checkout's Git root. */
  path: string;
  /** Identity key shared by every checkout of this repository; absent when none was captured. */
  key?: string;
  /** Every checkout of this repository in the group, primary first. */
  checkouts: ProjectGroupCheckout[];
}
export interface ProjectGroup {
  id: string;
  name: string;
  kind: ProjectGroupKind;
  /** Hidden projects leave pickers and board chips; their work stays under "All". */
  hidden: boolean;
  repos: ProjectGroupRepo[];
  /** True for an enrolled checkout without identity that belongs to no group; its ID is the host project ID. */
  implicit: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
/** A suggested grouping across repositories. Never applied without an explicit owner create. */
export interface ProjectGroupSuggestion {
  name: string;
  /** Every host project id of every project the suggestion would combine, so one create moves whole repositories. */
  repos: string[];
  /** The projects that would combine, for display. */
  groupIds: string[];
  reason: "shared-parent" | "shared-linear-project";
}
export interface ProjectGroupList {
  groups: ProjectGroup[];
  suggestions: ProjectGroupSuggestion[];
}
