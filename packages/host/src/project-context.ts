import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./types.js";
import { normalizeRemote, type WorkspaceRepositoryBinding } from "./checkout-identity.js";
import { ContentError } from "./session-content.js";
import { unseal, writeSealed } from "./vault.js";

const projectId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const linkSchema = z.object({ projectId, relationship: z.string().trim().min(1).max(300) }).strict();
export const contextLinksRequest = z.object({ expectedVersion: z.number().int().min(0), links: z.array(linkSchema).max(16) }).strict();
const savedBinding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), projectId, companyId: z.string(), companyGeneration: z.string().uuid(), projectGeneration: z.string().uuid(), sourceRepositoryId: z.string().optional(), deliveryRepositoryId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("workspace"), companyId: z.string().min(1), repositoryId: z.string().min(1), companyGeneration: z.string().uuid(), projectGeneration: z.string().uuid() }).strict(),
]);
const epochSchema = z.object({ identity: z.string().min(1), generation: z.string().uuid() }).strict();
const storedLink = linkSchema.extend({ root: z.string(), binding: savedBinding.optional() });
const storedLinks = z.object({ version: z.number().int().min(0), root: z.string(), binding: savedBinding.optional(), links: z.array(storedLink).max(16) }).strict();
const storedContext = z.object({ version: z.number().int().min(0), text: z.string().max(24000), updatedAt: z.string().optional(), root: z.string().optional(), binding: savedBinding.optional() }).strict();
export interface ContextSource { projectId: string; version: number; relationship?: string }
type WorkspaceBindings = ReadonlyMap<string, WorkspaceRepositoryBinding>;
type ProjectBinding = z.infer<typeof savedBinding>;
type CurrentProject = { root: string; binding?: ProjectBinding };
type Epoch = z.infer<typeof epochSchema>;
type Operation = { companyIdentity: string; companyEpoch?: Epoch; workspaceBindings?: WorkspaceBindings; bindingsLoaded: boolean; projects: Map<string, CurrentProject> };
type LinkRead = { version: number; root: string; binding?: "review-required"; links: z.infer<typeof storedLinks>["links"] };

export class ProjectContexts {
  private companyEpoch?: Epoch;
  private companyEpochLoaded = false;
  private readonly projectEpochs = new Map<string, Epoch>();
  private readonly projectEpochsLoaded = new Set<string>();

  constructor(
    private readonly config: Pick<Config, "stateDir" | "projects" | "intake">,
    private readonly key: Buffer,
    private readonly readWorkspaceBindings?: () => WorkspaceBindings | undefined,
  ) {
    this.currentCompanyEpoch(this.companyIdentity());
    for (const project of config.projects) this.currentProjectEpoch(project.id);
  }

  root(id: string) {
    projectId.parse(id);
    const matches = this.config.projects.filter(project => project.id === id);
    const project = matches[0];
    if (!project) throw new ContentError("Unknown project", 404);
    if (matches.length !== 1) throw new ContentError("Project identity is ambiguous. Use a unique project ID for each codebase.", 409);
    return realpathSync(project.path);
  }

  private companyIdentity(): string {
    const intake = this.config.intake, slack = intake?.slack;
    if (!slack) return "slack-free";
    if (!slack.appTokenFile || !slack.botTokenFile || !slack.teamId || !slack.ownerUserId || !intake?.mission.groupId || !slack.organizationScope?.workspaces?.length)
      return "slack-incomplete";
    return `slack:${JSON.stringify({ teamId: slack.teamId, ownerUserId: slack.ownerUserId, groupId: intake.mission.groupId })}`;
  }

  private currentCompanyEpoch(identity: string): Epoch | undefined {
    if (!this.companyEpochLoaded) {
      this.companyEpochLoaded = true;
      try {
        const file = join(this.config.stateDir, "project-context-company.sealed");
        if (existsSync(file)) this.companyEpoch = epochSchema.parse(unseal(this.key, "project-context-company", readFileSync(file, "utf8")));
      } catch { this.companyEpoch = undefined; }
    }
    if (this.companyEpoch?.identity === identity) return this.companyEpoch;
    try {
      const file = join(this.config.stateDir, "project-context-company.sealed");
      const next = { identity, generation: randomUUID() };
      writeSealed(file, this.key, "project-context-company", next);
      this.companyEpoch = next;
      return this.companyEpoch;
    } catch { return undefined; }
  }

  private projectIdentity(id: string) {
    const pin = this.config.intake?.slack?.organizationScope?.workspaces?.find(value => value.projectId === id);
    return pin ? `pinned:${JSON.stringify({ path: pin.path, repository: pin.repository?.toLowerCase() ?? null, rootCommit: pin.rootCommit?.toLowerCase() ?? null })}` : "unpinned";
  }

  private currentProjectEpoch(id: string): Epoch | undefined {
    const identity = this.projectIdentity(id);
    const cached = this.projectEpochs.get(id);
    if (cached?.identity === identity) return cached;
    let previous = cached;
    if (!this.projectEpochsLoaded.has(id)) {
      this.projectEpochsLoaded.add(id);
      try {
        const file = join(this.config.stateDir, "project-context-projects", `${id}.sealed`);
        if (existsSync(file)) previous = epochSchema.parse(unseal(this.key, `project-context-project:${id}`, readFileSync(file, "utf8")));
      } catch { previous = undefined; }
    }
    if (previous?.identity === identity) {
      this.projectEpochs.set(id, previous);
      return previous;
    }
    try {
      const next = { identity, generation: randomUUID() };
      writeSealed(join(this.config.stateDir, "project-context-projects", `${id}.sealed`), this.key, `project-context-project:${id}`, next);
      this.projectEpochs.set(id, next);
      return next;
    } catch { return undefined; }
  }

  private operation(): Operation {
    const companyIdentity = this.companyIdentity();
    return { companyIdentity, companyEpoch: this.currentCompanyEpoch(companyIdentity), bindingsLoaded: false, projects: new Map() };
  }

  private workspaceBindings(operation: Operation): WorkspaceBindings | undefined {
    if (!operation.bindingsLoaded) {
      operation.bindingsLoaded = true;
      if (operation.companyIdentity.startsWith("slack:")) {
        try { operation.workspaceBindings = this.readWorkspaceBindings?.(); } catch { operation.workspaceBindings = undefined; }
      }
    }
    return operation.workspaceBindings;
  }

  private project(id: string, operation: Operation): CurrentProject {
    const cached = operation.projects.get(id);
    if (cached) return cached;
    const root = this.root(id);
    const slack = this.config.intake?.slack;
    const pin = slack?.organizationScope?.workspaces?.find(value => value.projectId === id);
    const epoch = operation.companyEpoch;
    const projectEpoch = this.currentProjectEpoch(id);
    let binding: ProjectBinding | undefined;
    if (!slack || !pin) {
      const project = this.config.projects.find(value => value.id === id)!;
      if (epoch && operation.companyIdentity !== "slack-incomplete" && projectEpoch) {
        const repositoryId = (repository: string | undefined) => repository ? normalizeRemote(`https://github.com/${repository}.git`)?.key : undefined;
        const sourceRepositoryId = repositoryId(project.source?.mode === "github" ? project.source.repository : undefined);
        const deliveryRepositoryId = repositoryId(project.team?.delivery?.repository);
        binding = {
          kind: "local", projectId: id, companyId: epoch.identity, companyGeneration: epoch.generation, projectGeneration: projectEpoch.generation,
          ...(sourceRepositoryId ? { sourceRepositoryId } : {}), ...(deliveryRepositoryId ? { deliveryRepositoryId } : {}),
        };
      }
    } else if (operation.companyIdentity.startsWith("slack:")) {
      const verified = this.workspaceBindings(operation)?.get(id);
      if (verified && epoch && projectEpoch) binding = { kind: "workspace", ...verified, companyGeneration: epoch.generation, projectGeneration: projectEpoch.generation };
    }
    const current = { root, ...(binding ? { binding } : {}) };
    operation.projects.set(id, current);
    return current;
  }

  private contextFile(id: string) { return join(this.config.stateDir, "contexts", `${id}.sealed`); }
  private linksFile(id: string) { return join(this.config.stateDir, "context-links", `${id}.sealed`); }
  private readSavedContext(id: string) {
    const file = this.contextFile(id);
    return existsSync(file) ? storedContext.parse(unseal(this.key, `context:${id}`, readFileSync(file, "utf8"))) : undefined;
  }
  private bindingsMatch(saved: ProjectBinding | undefined, current: ProjectBinding | undefined): boolean {
    if (!saved || !current || saved.kind !== current.kind) return false;
    if (saved.kind === "local" && current.kind === "local") return saved.projectId === current.projectId
      && saved.companyId === current.companyId && saved.companyGeneration === current.companyGeneration
      && saved.projectGeneration === current.projectGeneration
      && saved.sourceRepositoryId === current.sourceRepositoryId && saved.deliveryRepositoryId === current.deliveryRepositoryId;
    return saved.kind === "workspace" && current.kind === "workspace"
      && saved.companyGeneration === current.companyGeneration && saved.projectGeneration === current.projectGeneration
      && saved.companyId === current.companyId && saved.repositoryId === current.repositoryId;
  }
  private contextFor(id: string, operation: Operation) {
    const current = this.project(id, operation);
    const value = this.readSavedContext(id);
    if (!value) return current.binding ? { version: 0, text: "" } : { version: 0, text: "", binding: "review-required" as const };
    if (value.root !== current.root || !this.bindingsMatch(value.binding, current.binding))
      return { version: value.version, text: "", binding: "review-required" as const };
    const { root: _root, binding: _binding, ...context } = value;
    return context;
  }

  context(id: string) { return this.contextFor(id, this.operation()); }

  setContext(id: string, text: string, expectedVersion: number) {
    const operation = this.operation();
    const current = this.project(id, operation);
    if (!current.binding) throw new ContentError("Workspace enrollment could not be verified. Retry after the repository binding is repaired.", 403);
    const previous = this.readSavedContext(id) ?? { version: 0 };
    if (previous.version !== expectedVersion) throw new ContentError("Context changed on another device. Reload before saving.", 409);
    const next = storedContext.parse({ version: previous.version + 1, text, root: current.root, binding: current.binding, updatedAt: new Date().toISOString() });
    writeSealed(this.contextFile(id), this.key, `context:${id}`, next);
    const { root: _root, binding: _binding, ...context } = next;
    return context;
  }

  private linkAllowed(source: string, target: string, operation: Operation): boolean {
    if (!this.config.intake?.slack) return true;
    const pins = this.config.intake.slack.organizationScope?.workspaces;
    if (!pins?.some(pin => pin.projectId === source) || !pins.some(pin => pin.projectId === target)) return false;
    try {
      return this.project(source, operation).binding?.kind === "workspace"
        && this.project(target, operation).binding?.kind === "workspace";
    } catch { return false; }
  }

  private readLinks(id: string, operation: Operation): LinkRead {
    const current = this.project(id, operation);
    const file = this.linksFile(id);
    if (!existsSync(file)) return { version: 0, root: current.root, ...(!current.binding ? { binding: "review-required" as const } : {}), links: [] };
    const saved = storedLinks.parse(unseal(this.key, `context-links:${id}`, readFileSync(file, "utf8")));
    if (!current.binding || saved.root !== current.root || !this.bindingsMatch(saved.binding, current.binding))
      return { version: saved.version, root: current.root, binding: "review-required", links: [] };
    const links: typeof saved.links = [];
    for (const link of saved.links) {
      if (!this.linkAllowed(id, link.projectId, operation)) continue;
      let target: CurrentProject;
      try { target = this.project(link.projectId, operation); } catch { continue; }
      if (link.root !== target.root || !this.bindingsMatch(link.binding, target.binding)) continue;
      let targetContext: z.infer<typeof storedContext> | undefined;
      try { targetContext = this.readSavedContext(link.projectId); } catch { continue; }
      if (targetContext && (targetContext.root !== target.root || !this.bindingsMatch(targetContext.binding, target.binding))) continue;
      links.push(link);
    }
    return { version: saved.version, root: saved.root, links };
  }

  links(id: string) { return this.readLinks(id, this.operation()); }

  private publicLinks(value: LinkRead) {
    return { version: value.version, ...(value.binding ? { binding: value.binding } : {}), links: value.binding ? [] : value.links.map(({ root: _root, binding: _binding, ...link }) => link) };
  }

  listLinks(id: string) { return this.publicLinks(this.readLinks(id, this.operation())); }

  setLinks(id: string, input: z.infer<typeof contextLinksRequest>) {
    const body = contextLinksRequest.parse(input);
    const operation = this.operation();
    const source = this.project(id, operation);
    if (!source.binding) throw new ContentError("Workspace enrollment could not be verified. Retry after the repository binding is repaired.", 403);
    const previous = this.readLinks(id, operation);
    if (body.expectedVersion !== previous.version) throw new ContentError("Context relationships changed. Reload before saving.", 409);
    const seen = new Set<string>();
    const links = body.links.map(link => {
      if (link.projectId === id || seen.has(link.projectId)) throw new ContentError("Context relationships must name distinct other projects.", 400);
      if (!this.linkAllowed(id, link.projectId, operation)) throw new ContentError("Context links must stay within the enrolled workspace audience.", 403);
      const target = this.project(link.projectId, operation);
      if (!target.binding) throw new ContentError("The linked workspace binding could not be verified.", 403);
      seen.add(link.projectId);
      return { ...link, root: target.root, binding: target.binding };
    });
    const value = storedLinks.parse({ version: previous.version + 1, root: source.root, binding: source.binding, links });
    writeSealed(this.linksFile(id), this.key, `context-links:${id}`, value);
    return this.publicLinks(this.readLinks(id, operation));
  }

  snapshot(id: string) {
    const operation = this.operation();
    const own = this.contextFor(id, operation);
    if ("binding" in own) throw new ContentError("Saved context has no matching repository binding. Review and save context for this project before launching.", 409);
    const links = this.readLinks(id, operation);
    if (links.binding) throw new ContentError("Context relationships need review for the current repository binding. Relink them before launching.", 409);
    const sources: ContextSource[] = [{ projectId: id, version: own.version }];
    const chunks = own.text ? [own.text] : [];
    for (const link of links.links) {
      const source = this.contextFor(link.projectId, operation);
      if ("binding" in source) throw new ContentError("Linked context has no matching repository binding. Its owner must review and save it before use.", 409);
      sources.push({ projectId: link.projectId, version: source.version, relationship: link.relationship });
      if (source.text) chunks.push(`Linked project context ${JSON.stringify({ projectId: link.projectId, version: source.version, relationship: link.relationship })}:\n${source.text}`);
    }
    const text = chunks.join("\n\n");
    if (text.length > 48000) throw new ContentError("Linked context exceeds 48000 characters. Shorten project context or remove a relationship.", 409);
    return { version: own.version, text, sources, linksVersion: links.version, root: links.root };
  }
}
