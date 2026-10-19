import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { writeSealed, unseal } from "./vault.js";
import { TeamError } from "./team-workspace.js";
import { createProjectGroupSchema, projectGroupIdSchema, updateProjectGroupSchema, type CreateProjectGroup, type ProjectGroup, type ProjectGroupList, type ProjectGroupSuggestion, type UpdateProjectGroup } from "./project-group-types.js";
import type { Config, Project } from "./types.js";

type GroupReceipt = { fingerprint: string; result: ProjectGroup };
type Stored = { groups: Record<string, ProjectGroup>; receipts: Record<string, GroupReceipt> };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const notFound = () => new TeamError(404, "project-group-not-found", "This project group does not exist.");

/** Owner-managed repository groupings. Group records do not change repository policy or context. */
export class ProjectGroupService {
  private readonly directory: string;
  private readonly file: string;
  private readonly state: Stored;

  constructor(private readonly config: Config, private readonly key: Buffer) {
    this.directory = resolve(config.stateDir, "project-groups");
    this.file = resolve(this.directory, "state.sealed");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.state = unseal<Stored>(key, "project-groups", readFileSync(this.file, "utf8"));
      if (!this.state || typeof this.state.groups !== "object" || typeof this.state.receipts !== "object") throw new Error("Invalid project-group state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.state = { groups: {}, receipts: {} };
      else throw error;
    }
  }

  private persist() { writeSealed(this.file, this.key, "project-groups", this.state); }

  private repo(id: string): Project {
    const project = this.config.projects.find(value => value.id === id);
    if (!project) throw new TeamError(400, "unknown-project-group-repo", `Repository ${id} is not enrolled on this host.`);
    return project;
  }

  private repoView(project: Project) { return { projectId: project.id, name: project.name, path: project.path }; }

  private implicit(project: Project): ProjectGroup {
    const timestamp = now();
    return { id: project.id, name: project.name, repos: [this.repoView(project)], implicit: true, revision: 1, createdAt: timestamp, updatedAt: timestamp };
  }

  private group(id: string) {
    const group = this.state.groups[id];
    if (!group) throw notFound();
    return group;
  }

  private replay(requestId: string, fingerprint: string): ProjectGroup | undefined {
    const receipt = this.state.receipts[requestId];
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different project-group action.");
    return structuredClone(receipt.result);
  }

  private record(requestId: string, fingerprint: string, result: ProjectGroup) {
    this.state.receipts[requestId] = { fingerprint, result: structuredClone(result) };
    this.persist();
    return structuredClone(result);
  }

  private validateRepos(ids: string[], excludingGroup?: string) {
    const projects = ids.map(id => this.repo(id));
    const occupied = new Set(Object.values(this.state.groups).filter(group => group.id !== excludingGroup).flatMap(group => group.repos.map(repo => repo.projectId)));
    for (const id of ids) if (occupied.has(id)) throw new TeamError(409, "project-group-repo-conflict", `Repository ${id} already belongs to an owner-created group.`);
    return projects;
  }

  private slug(name: string) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "") || "project";
    const used = new Set([...Object.keys(this.state.groups), ...this.config.projects.map(project => project.id)]);
    if (!used.has(base)) return projectGroupIdSchema.parse(base);
    for (let suffix = 2; ; suffix++) {
      const tail = `-${suffix}`;
      const candidate = `${base.slice(0, 80 - tail.length).replace(/-+$/g, "")}${tail}`;
      if (!used.has(candidate)) return projectGroupIdSchema.parse(candidate);
    }
  }

  list(): ProjectGroupList {
    const groups = Object.values(this.state.groups).map(group => structuredClone(group));
    const grouped = new Set(groups.flatMap(group => group.repos.map(repo => repo.projectId)));
    for (const project of this.config.projects) if (!grouped.has(project.id)) groups.push(this.implicit(project));
    groups.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { groups, suggestions: this.suggestions(grouped) };
  }

  get(id: string): ProjectGroup {
    projectGroupIdSchema.parse(id);
    const group = this.state.groups[id];
    if (group) return structuredClone(group);
    const project = this.config.projects.find(value => value.id === id);
    return project ? this.implicit(project) : (() => { throw notFound(); })();
  }

  create(input: CreateProjectGroup): ProjectGroup {
    const request = createProjectGroupSchema.parse(input);
    const fingerprint = digest({ action: "create", body: request });
    const replay = this.replay(request.requestId, fingerprint);
    if (replay) return replay;
    const projects = this.validateRepos(request.repos);
    const createdAt = now();
    const group: ProjectGroup = { id: this.slug(request.name), name: request.name, repos: projects.map(project => this.repoView(project)), implicit: false, revision: 1, createdAt, updatedAt: createdAt };
    this.state.groups[group.id] = group;
    return this.record(request.requestId, fingerprint, group);
  }

  update(id: string, input: UpdateProjectGroup): ProjectGroup {
    projectGroupIdSchema.parse(id);
    const request = updateProjectGroupSchema.parse(input);
    const fingerprint = digest({ action: "update", id, body: request });
    const replay = this.replay(request.requestId, fingerprint);
    if (replay) return replay;
    const current = this.group(id);
    if (request.revision !== current.revision) throw new TeamError(409, "stale-project-group-revision", "The project group changed. Refresh it before sending this update.");
    const repos = request.repos === undefined ? current.repos : this.validateRepos(request.repos, id).map(project => this.repoView(project));
    const updated: ProjectGroup = { ...current, ...(request.name !== undefined ? { name: request.name } : {}), repos, revision: current.revision + 1, updatedAt: now() };
    this.state.groups[id] = updated;
    return this.record(request.requestId, fingerprint, updated);
  }

  remove(id: string, input: { requestId: string; revision: number }): ProjectGroup {
    projectGroupIdSchema.parse(id);
    const request = updateProjectGroupSchema.pick({ requestId: true, revision: true }).parse(input);
    const fingerprint = digest({ action: "remove", id, body: request });
    const replay = this.replay(request.requestId, fingerprint);
    if (replay) return replay;
    const current = this.group(id);
    if (request.revision !== current.revision) throw new TeamError(409, "stale-project-group-revision", "The project group changed. Refresh it before deleting it.");
    delete this.state.groups[id];
    return this.record(request.requestId, fingerprint, current);
  }

  private suggestions(grouped: Set<string>): ProjectGroupSuggestion[] {
    const projects = this.config.projects.filter(project => !grouped.has(project.id));
    const suggestions: ProjectGroupSuggestion[] = [];
    const seen = new Set<string>();
    const excludedParents = new Set([resolve(this.config.sync?.homeDir ?? homedir()), ...(this.config.teams?.workspaceDir ? [resolve(this.config.teams.workspaceDir)] : [])]);
    const add = (name: string, repos: Project[], reason: ProjectGroupSuggestion["reason"]) => {
      if (repos.length < 2) return;
      const key = repos.map(project => project.id).sort().join("\0");
      if (seen.has(key)) return;
      seen.add(key);
      suggestions.push({ name, repos: repos.map(project => project.id), reason });
    };
    const byParent = new Map<string, Project[]>();
    for (const project of projects) {
      const parent = resolve(dirname(resolve(project.path)));
      if (excludedParents.has(parent)) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), project]);
    }
    for (const [parent, siblings] of byParent) add(basename(parent), siblings, "shared-parent");
    const byLinear = new Map<string, Project[]>();
    for (const project of projects) if (project.linear?.projectId)
      byLinear.set(project.linear.projectId, [...(byLinear.get(project.linear.projectId) ?? []), project]);
    for (const matches of byLinear.values()) add(matches[0]!.name, matches, "shared-linear-project");
    return suggestions;
  }
}
