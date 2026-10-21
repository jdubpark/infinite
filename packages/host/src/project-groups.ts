import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { captureIdentity, normalizeRemote, readGit, type CheckoutIdentity, type GitReader } from "./checkout-identity.js";
import { writeSealed, unseal } from "./vault.js";
import { TeamError } from "./team-workspace.js";
import {
  createProjectGroupSchema,
  projectGroupIdSchema,
  updateProjectGroupSchema,
  type CreateProjectGroup,
  type ProjectGroup,
  type ProjectGroupCheckout,
  type ProjectGroupList,
  type ProjectGroupRepo,
  type ProjectGroupSuggestion,
  type UpdateProjectGroup,
} from "./project-group-types.js";
import type { Config, Project } from "./types.js";

type GroupReceipt = { fingerprint: string; result: ProjectGroup };
type StoredGroup = {
  id: string;
  name: string;
  kind: "owner" | "repository";
  hidden: boolean;
  members: string[];
  detached: string[];
  primary: Record<string, string>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
type LegacyGroup = Omit<StoredGroup, "kind" | "hidden" | "members" | "detached" | "primary"> & {
  kind?: StoredGroup["kind"];
  hidden?: boolean;
  members?: string[];
  detached?: string[];
  primary?: Record<string, string>;
  repos?: Array<{ projectId: string }>;
};
type Stored = { groups: Record<string, LegacyGroup>; receipts: Record<string, GroupReceipt>; tombstones?: string[] };
type CurrentStored = { groups: Record<string, StoredGroup>; receipts: Record<string, GroupReceipt>; tombstones: string[] };
type StateWriter = (file: string, key: Buffer, scope: string, value: unknown) => void;
type ProjectGroupServiceOptions = {
  git?: GitReader;
  appliedAt?: (projectId: string) => string | undefined;
  now?: () => number;
};

/** A keyed read that ignores inherited properties, so a checkout id such as `constructor` cannot alias a prototype member. */
const own = <T>(map: Record<string, T>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const notFound = () => new TeamError(404, "project-group-not-found", "This project group does not exist.");
const repoConflict = (projectId: string) => new TeamError(409, "project-group-repo-conflict", `Repository ${projectId} already belongs to an owner-created group.`);
const primaryInvalid = () => new TeamError(400, "project-group-primary-invalid", "Choose one primary checkout per repository from this project.");

/** Owner-managed project groups. Groups organize checkout identity without changing repository policy or context. */
export class ProjectGroupService {
  private readonly directory: string;
  private readonly file: string;
  private readonly identitiesFile: string;
  private readonly writeState: StateWriter;
  private readonly git: GitReader;
  private readonly clock: () => number;
  private readonly appliedAt: (projectId: string) => string | undefined;
  private state: CurrentStored;
  private identities: Record<string, CheckoutIdentity>;
  private pending?: CurrentStored;
  private pendingIdentities?: Record<string, CheckoutIdentity>;
  private needsMigration = false;
  private readonly failedCaptureAt = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly key: Buffer,
    writeState: StateWriter = writeSealed,
    options: ProjectGroupServiceOptions = {},
  ) {
    this.writeState = writeState;
    this.git = options.git ?? readGit;
    this.clock = options.now ?? Date.now;
    this.appliedAt = options.appliedAt ?? (() => undefined);
    this.directory = resolve(config.stateDir, "project-groups");
    this.file = resolve(this.directory, "state.sealed");
    this.identitiesFile = resolve(this.directory, "identities.sealed");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });

    try {
      const stored = unseal<Stored>(key, "project-groups", readFileSync(this.file, "utf8"));
      if (!stored || !stored.groups || typeof stored.groups !== "object" || Array.isArray(stored.groups)
        || !stored.receipts || typeof stored.receipts !== "object" || Array.isArray(stored.receipts)) throw new Error("Invalid project-group state");
      const groups: Record<string, StoredGroup> = {};
      for (const [id, group] of Object.entries(stored.groups)) {
        if (Array.isArray(group.members)) {
          groups[id] = {
            ...group,
            kind: group.kind ?? "owner",
            hidden: group.hidden ?? false,
            members: [...group.members],
            detached: [...(group.detached ?? [])],
            primary: { ...(group.primary ?? {}) },
          } as StoredGroup;
        } else {
          const members = Array.isArray(group.repos) ? group.repos.map(repo => repo.projectId) : [];
          groups[id] = {
            id: group.id,
            name: group.name,
            kind: "owner",
            hidden: false,
            members,
            detached: [],
            primary: {},
            revision: group.revision,
            createdAt: group.createdAt,
            updatedAt: group.updatedAt,
          };
          this.needsMigration = true;
        }
        if (group.kind === undefined || group.hidden === undefined || group.detached === undefined || group.primary === undefined)
          this.needsMigration = true;
      }
      const tombstones = stored.tombstones === undefined
        ? this.retiredIdsFromReceipts(groups, stored.receipts)
        : stored.tombstones;
      if (!Array.isArray(tombstones) || tombstones.some(id => typeof id !== "string" || !projectGroupIdSchema.safeParse(id).success))
        throw new Error("Invalid project-group tombstones");
      this.state = { groups, receipts: stored.receipts, tombstones: [...new Set(tombstones)] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.state = { groups: {}, receipts: {}, tombstones: [] };
      else throw error;
    }

    try {
      this.identities = unseal<Record<string, CheckoutIdentity>>(key, "checkout-identities", readFileSync(this.identitiesFile, "utf8"));
      if (!this.identities || typeof this.identities !== "object" || Array.isArray(this.identities)) throw new Error("Invalid checkout-identity state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.identities = {};
      else throw error;
    }
  }

  private retiredIdsFromReceipts(groups: Record<string, StoredGroup>, receipts: Record<string, GroupReceipt>): string[] {
    const retired = new Set<string>();
    for (const receipt of Object.values(receipts)) {
      const id = receipt?.result?.id;
      if (typeof id === "string" && !Object.hasOwn(groups, id) && projectGroupIdSchema.safeParse(id).success) retired.add(id);
    }
    return [...retired];
  }

  private timestamp() { return new Date(this.clock()).toISOString(); }

  private persist(candidate: CurrentStored) {
    try {
      this.writeState(this.file, this.key, "project-groups", candidate);
    } catch (error) {
      this.pending = candidate;
      throw error;
    }
    this.state = candidate;
    this.pending = undefined;
    this.needsMigration = false;
  }

  private persistIdentities(candidate: Record<string, CheckoutIdentity>) {
    try {
      this.writeState(this.identitiesFile, this.key, "checkout-identities", candidate);
    } catch (error) {
      this.pendingIdentities = candidate;
      throw error;
    }
    this.identities = candidate;
    this.pendingIdentities = undefined;
  }

  private reconcilePending() {
    if (this.pendingIdentities) this.persistIdentities(this.pendingIdentities);
    if (this.pending) this.persist(this.pending);
  }

  private repo(id: string): Project {
    const project = this.config.projects.find(value => value.id === id);
    if (!project) throw new TeamError(400, "unknown-project-group-repo", `Repository ${id} is not enrolled on this host.`);
    return project;
  }

  private sourceIdentity(project: Project): CheckoutIdentity | undefined {
    // A GitHub-tracked project names its repository in its source record; no scan of the working tree is needed.
    if (project.source?.mode !== "github") return undefined;
    const normalized = normalizeRemote(`https://github.com/${project.source.repository}.git`);
    return normalized ? {
      projectId: project.id,
      key: normalized.key,
      repoName: normalized.repoName,
      capturedAt: this.timestamp(),
      from: "source",
    } : undefined;
  }

  private identityKey(projectId: string) {
    return own(this.identities, projectId)?.key ?? `project:${projectId}`;
  }

  private checkoutCount(group: StoredGroup, key: string, identities: Record<string, CheckoutIdentity>) {
    return group.members.filter(id => own(identities, id)?.key === key).length;
  }

  /** Capture missing identities, then place every identified checkout in exactly one stored group. */
  private reconcile() {
    this.reconcilePending();
    let identityChanged = false;
    const identities = { ...this.identities };
    const time = this.clock();
    for (const project of this.config.projects) {
      if (own(identities, project.id)) continue;
      const attemptedAt = this.failedCaptureAt.get(project.id);
      if (attemptedAt !== undefined && time - attemptedAt < 60_000) continue;
      const captured = this.sourceIdentity(project) ?? captureIdentity(project, this.git, this.timestamp());
      if (captured) {
        identities[project.id] = captured;
        this.failedCaptureAt.delete(project.id);
        identityChanged = true;
      } else {
        this.failedCaptureAt.set(project.id, time);
      }
    }
    if (identityChanged) this.persistIdentities(identities);

    const candidate = structuredClone(this.state);
    let changed = this.needsMigration;
    for (const project of this.config.projects) {
      const identity = own(this.identities, project.id);
      if (!identity || Object.values(candidate.groups).some(group => group.members.includes(project.id))) continue;

      const possible = Object.values(candidate.groups)
        .filter(group => !group.detached.includes(project.id) && this.checkoutCount(group, identity.key, this.identities) > 0)
        .sort((a, b) => this.checkoutCount(b, identity.key, this.identities) - this.checkoutCount(a, identity.key, this.identities)
          || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const existing = possible[0];
      if (existing) {
        existing.members.push(project.id);
        existing.revision++;
        existing.updatedAt = this.timestamp();
      } else {
        const createdAt = this.timestamp();
        const group: StoredGroup = {
          id: this.slug(identity.repoName, candidate),
          name: identity.repoName,
          kind: "repository",
          hidden: false,
          members: [project.id],
          detached: [],
          primary: {},
          revision: 1,
          createdAt,
          updatedAt: createdAt,
        };
        candidate.groups[group.id] = group;
      }
      changed = true;
    }
    if (changed) {
      this.persist(candidate);
      this.needsMigration = false;
    }
  }

  private slug(name: string, state = this.state) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "") || "project";
    const used = new Set([...Object.keys(state.groups), ...state.tombstones, ...this.config.projects.map(project => project.id)]);
    if (!used.has(base)) return projectGroupIdSchema.parse(base);
    for (let suffix = 2; ; suffix++) {
      const tail = `-${suffix}`;
      const candidate = `${base.slice(0, 80 - tail.length).replace(/-+$/g, "")}${tail}`;
      if (!used.has(candidate)) return projectGroupIdSchema.parse(candidate);
    }
  }

  private storedGroup(group: StoredGroup): ProjectGroup {
    const byKey = new Map<string, Project[]>();
    for (const id of group.members) {
      const project = this.config.projects.find(value => value.id === id);
      if (!project) continue;
      const key = this.identityKey(id);
      byKey.set(key, [...(byKey.get(key) ?? []), project]);
    }

    const repos: ProjectGroupRepo[] = [];
    for (const [key, projects] of byKey) {
      const preferred = own(group.primary, key);
      const primary = projects.find(project => project.id === preferred) ?? [...projects].sort((a, b) => this.comparePrimary(a, b))[0]!;
      const ordered = [primary, ...projects.filter(project => project.id !== primary.id).sort((a, b) => a.id.localeCompare(b.id))];
      const checkouts: ProjectGroupCheckout[] = ordered.map(project => {
        const identity = own(this.identities, project.id);
        return {
          projectId: project.id,
          name: project.name,
          path: project.path,
          primary: project.id === primary.id,
          teamReady: this.teamReady(project),
          ...(identity ? { identityFrom: identity.from } : {}),
        };
      });
      const identity = own(this.identities, primary.id) ?? projects.map(project => own(this.identities, project.id)).find(Boolean);
      repos.push({
        projectId: primary.id,
        name: identity?.repoName ?? primary.name,
        path: primary.path,
        ...(identity ? { key: identity.key } : {}),
        checkouts,
      });
    }
    return {
      id: group.id,
      name: group.name,
      kind: group.kind,
      hidden: group.hidden,
      repos,
      implicit: false,
      revision: group.revision,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  private comparePrimary(a: Project, b: Project) {
    const identityA = own(this.identities, a.id);
    const identityB = own(this.identities, b.id);
    if (identityA?.from !== identityB?.from) {
      if (identityA?.from === "source") return -1;
      if (identityB?.from === "source") return 1;
    }
    const readyA = this.teamReady(a);
    const readyB = this.teamReady(b);
    if (readyA !== readyB) return readyA ? -1 : 1;
    const appliedA = this.appliedTime(a.id);
    const appliedB = this.appliedTime(b.id);
    if (appliedA !== appliedB) return appliedB - appliedA;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.id.localeCompare(b.id);
  }

  private appliedTime(projectId: string) {
    const value = this.appliedAt(projectId);
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private teamReady(project: Project) {
    return Boolean(project.team && (project.team.checks.length || project.team.establishChecks));
  }

  private implicit(project: Project): ProjectGroup {
    const checkout: ProjectGroupCheckout = {
      projectId: project.id,
      name: project.name,
      path: project.path,
      primary: true,
      teamReady: this.teamReady(project),
      ...(own(this.identities, project.id) ? { identityFrom: own(this.identities, project.id)!.from } : {}),
    };
    const repo: ProjectGroupRepo = {
      projectId: project.id,
      name: own(this.identities, project.id)?.repoName ?? project.name,
      path: project.path,
      ...(own(this.identities, project.id) ? { key: own(this.identities, project.id)!.key } : {}),
      checkouts: [checkout],
    };
    const timestamp = this.timestamp();
    return { id: project.id, name: project.name, kind: "implicit", hidden: false, repos: [repo], implicit: true, revision: 1, createdAt: timestamp, updatedAt: timestamp };
  }

  private containingGroup(projectId: string) {
    return Object.values(this.state.groups).find(group => group.members.includes(projectId));
  }

  private group(id: string) {
    const group = own(this.state.groups, id);
    if (!group) throw notFound();
    return group;
  }

  private replay(requestId: string, fingerprint: string): ProjectGroup | undefined {
    const receipt = this.state.receipts[requestId];
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different project-group action.");
    return structuredClone(receipt.result);
  }

  private record(candidate: CurrentStored, requestId: string, fingerprint: string, result: ProjectGroup) {
    candidate.receipts[requestId] = { fingerprint, result: structuredClone(result) };
    this.persist(candidate);
    return structuredClone(result);
  }

  private findContaining(candidate: CurrentStored, projectId: string) {
    return Object.values(candidate.groups).find(group => group.members.includes(projectId));
  }

  private addDetached(group: StoredGroup, projectId: string) {
    if (!group.detached.includes(projectId)) group.detached.push(projectId);
    for (const [key, selected] of Object.entries(group.primary)) if (selected === projectId) delete group.primary[key];
  }

  private removeFromRepositoryGroup(candidate: CurrentStored, source: StoredGroup, projectId: string) {
    source.members = source.members.filter(id => id !== projectId);
    this.addDetached(source, projectId);
    if (source.members.length === 0 && source.kind === "repository") {
      delete candidate.groups[source.id];
      candidate.tombstones = [...new Set([...candidate.tombstones, source.id])];
    } else {
      source.revision++;
      source.updatedAt = this.timestamp();
    }
  }

  private moveInto(candidate: CurrentStored, projectIds: string[], targetId?: string) {
    for (const projectId of projectIds) {
      const source = this.findContaining(candidate, projectId);
      if (!source || source.id === targetId) continue;
      if (source.kind === "owner") throw repoConflict(projectId);
      this.removeFromRepositoryGroup(candidate, source, projectId);
    }
  }

  list(): ProjectGroupList {
    this.reconcile();
    const groups = Object.values(this.state.groups).map(group => this.storedGroup(group));
    const grouped = new Set(Object.values(this.state.groups).flatMap(group => group.members));
    for (const project of this.config.projects)
      if (!grouped.has(project.id) && !own(this.identities, project.id)) groups.push(this.implicit(project));
    groups.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { groups, suggestions: this.suggestions(groups) };
  }

  /** Resolve a stored group id, a host project id, or an ungrouped implicit project. */
  get(idOrProjectId: string): ProjectGroup {
    this.reconcile();
    projectGroupIdSchema.parse(idOrProjectId);
    const group = own(this.state.groups, idOrProjectId);
    if (group) return this.storedGroup(group);
    const project = this.config.projects.find(value => value.id === idOrProjectId);
    if (!project) throw notFound();
    const holding = this.containingGroup(project.id);
    return holding ? this.storedGroup(holding) : this.implicit(project);
  }

  /** Return the named project holding an enrolled checkout, including an implicit project. */
  containing(projectId: string): { id: string; name: string } | undefined {
    this.reconcile();
    const project = this.config.projects.find(value => value.id === projectId);
    if (!project) return undefined;
    const group = this.containingGroup(projectId);
    return group ? { id: group.id, name: group.name } : { id: project.id, name: project.name };
  }

  create(input: CreateProjectGroup): ProjectGroup {
    this.reconcile();
    const request = createProjectGroupSchema.parse(input);
    const fingerprint = digest({ action: "create", body: request });
    const replay = this.replay(request.requestId, fingerprint);
    if (replay) return replay;
    request.repos.forEach(id => this.repo(id));

    const candidate = structuredClone(this.state);
    this.moveInto(candidate, request.repos);
    const createdAt = this.timestamp();
    const group: StoredGroup = {
      id: this.slug(request.name, candidate),
      name: request.name,
      kind: "owner",
      hidden: false,
      members: [...request.repos],
      detached: [],
      primary: {},
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    candidate.groups[group.id] = group;
    return this.record(candidate, request.requestId, fingerprint, this.storedGroup(group));
  }

  update(id: string, input: UpdateProjectGroup): ProjectGroup {
    this.reconcile();
    projectGroupIdSchema.parse(id);
    if (Array.isArray(input.primary) && new Set(input.primary).size !== input.primary.length) throw primaryInvalid();
    const request = updateProjectGroupSchema.parse(input);
    const fingerprint = digest({ action: "update", id, body: request });
    const replay = this.replay(request.requestId, fingerprint);
    if (replay) return replay;

    const candidate = structuredClone(this.state);
    let current: StoredGroup | undefined = own(candidate.groups, id);
    if (!current) {
      const project = this.config.projects.find(value => value.id === id);
      if (!project) throw notFound();
      current = this.findContaining(candidate, id);
      // A retired group id never aliases the group that now holds its checkout: a stale update is refused, not redirected.
      if (current && candidate.tombstones.includes(id)) throw notFound();
      if (!current) {
        const groupId = candidate.tombstones.includes(id) ? this.slug(project.name, candidate) : id;
        current = {
          id: groupId,
          name: project.name,
          kind: "owner",
          hidden: false,
          members: [project.id],
          detached: [],
          primary: {},
          revision: 1,
          createdAt: this.timestamp(),
          updatedAt: this.timestamp(),
        };
        candidate.groups[groupId] = current;
      }
    }
    if (request.revision !== current.revision) throw new TeamError(409, "stale-project-group-revision", "The project group changed. Refresh it before sending this update.");

    const nextMembers = request.repos === undefined ? [...current.members] : [...request.repos];
    if (request.repos !== undefined) request.repos.forEach(projectId => this.repo(projectId));
    for (const projectId of nextMembers) {
      const source = this.findContaining(candidate, projectId);
      if (source && source.id !== current.id && source.kind === "owner") throw repoConflict(projectId);
    }

    if (request.repos !== undefined) {
      const desired = new Set(nextMembers);
      for (const projectId of current.members) {
        if (desired.has(projectId)) continue;
        current.members = current.members.filter(member => member !== projectId);
        this.addDetached(current, projectId);
      }
      this.moveInto(candidate, nextMembers, current.id);
      current.members = nextMembers;
    }

    if (new Set(current.members.map(projectId => this.identityKey(projectId))).size > 1 && current.kind === "repository") current.kind = "owner";
    if (request.primary !== undefined) {
      const chosen = new Map<string, string>();
      for (const projectId of request.primary) {
        if (!current.members.includes(projectId)) throw primaryInvalid();
        const key = this.identityKey(projectId);
        if (chosen.has(key)) throw primaryInvalid();
        chosen.set(key, projectId);
      }
      for (const [key, projectId] of chosen) current.primary[key] = projectId;
    }
    if (request.name !== undefined) current.name = request.name;
    if (request.hidden !== undefined) current.hidden = request.hidden;
    current.revision++;
    current.updatedAt = this.timestamp();
    return this.record(candidate, request.requestId, fingerprint, this.storedGroup(current));
  }

  remove(id: string, input: { requestId: string; revision: number }): ProjectGroup {
    this.reconcile();
    projectGroupIdSchema.parse(id);
    const request = updateProjectGroupSchema.pick({ requestId: true, revision: true }).parse(input);
    const fingerprint = digest({ action: "remove", id, body: request });
    const replay = this.replay(request.requestId, fingerprint);
    if (replay) return replay;
    const current = this.group(id);
    if (request.revision !== current.revision) throw new TeamError(409, "stale-project-group-revision", "The project group changed. Refresh it before deleting it.");
    const result = this.storedGroup(current);
    const candidate = structuredClone(this.state);
    delete candidate.groups[id];
    candidate.tombstones = [...new Set([...candidate.tombstones, id])];
    return this.record(candidate, request.requestId, fingerprint, result);
  }

  private suggestions(groups: ProjectGroup[]): ProjectGroupSuggestion[] {
    const eligible = groups.filter(group => group.kind === "repository" || group.kind === "implicit");
    const byId = new Map(eligible.map(group => [group.id, group]));
    const suggestions: ProjectGroupSuggestion[] = [];
    const seen = new Set<string>();
    const home = resolve(this.config.sync?.homeDir ?? homedir());
    const excludedParents = new Set([home, ...(this.config.teams?.workspaceDir ? [resolve(this.config.teams.workspaceDir)] : [])]);
    const tooBroad = (parent: string) => {
      const below = relative(home, parent);
      return !below.startsWith("..") && !isAbsolute(below) && below.split(sep).length < 2;
    };
    const add = (name: string, ids: string[], reason: ProjectGroupSuggestion["reason"]) => {
      const matched = [...new Set(ids)].map(id => byId.get(id)).filter((group): group is ProjectGroup => Boolean(group))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      if (matched.length < 2) return;
      const key = matched.map(group => group.id).sort().join("\0");
      if (seen.has(key)) return;
      seen.add(key);
      suggestions.push({
        name,
        repos: [...new Set(matched.flatMap(group => group.repos.flatMap(repo => repo.checkouts.map(checkout => checkout.projectId))))],
        groupIds: matched.map(group => group.id),
        reason,
      });
    };

    const byParent = new Map<string, string[]>();
    for (const group of eligible) for (const repo of group.repos) {
      const parent = resolve(dirname(resolve(repo.path)));
      if (excludedParents.has(parent) || tooBroad(parent)) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), group.id]);
    }
    for (const [parent, ids] of byParent) add(basename(parent), ids, "shared-parent");

    const byLinear = new Map<string, string[]>();
    for (const group of eligible) for (const checkout of group.repos.flatMap(repo => repo.checkouts)) {
      const project = this.config.projects.find(value => value.id === checkout.projectId);
      if (project?.linear?.projectId)
        byLinear.set(project.linear.projectId, [...(byLinear.get(project.linear.projectId) ?? []), group.id]);
    }
    for (const [linearProjectId, ids] of byLinear) {
      const matchedIds = new Set(ids);
      const firstCheckout = this.config.projects.find(project => project.linear?.projectId === linearProjectId
        && eligible.some(group => matchedIds.has(group.id) && group.repos.some(repo => repo.checkouts.some(checkout => checkout.projectId === project.id))));
      const matched = [...matchedIds].map(id => byId.get(id)).filter((group): group is ProjectGroup => Boolean(group));
      if (matched.length >= 2) add(firstCheckout?.name ?? matched[0]!.name, matched.map(group => group.id), "shared-linear-project");
    }
    return suggestions;
  }
}
