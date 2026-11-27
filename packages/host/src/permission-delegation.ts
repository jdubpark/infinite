import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TeamError } from "./team-workspace.js";
import { INTERRUPT_CLASSES, interruptClassesInForce, PERMISSION_POLICY_VERSION } from "./permission-policy.js";
import type { ProjectGroupService } from "./project-groups.js";
import type { Config, Project } from "./types.js";
import { unseal, writeSealed } from "./vault.js";
import {
  permissionDelegationActorSchema,
  permissionDelegationMutationRequestSchema,
  permissionDelegationRequestSchema,
  permissionDelegationStoredStateSchema,
  type CoverageResult,
  type PermissionCoverageEntry,
  type PermissionDelegationActor,
  type PermissionDelegationGroup,
  type PermissionOptOut,
  type WorkspaceDelegationProjectView,
  type WorkspaceDelegationView,
} from "./permission-delegation-types.js";

type Receipt = { fingerprint: string; result: unknown };
type Stored = {
  entries: Record<string, PermissionCoverageEntry>;
  optOuts: Record<string, PermissionOptOut>;
  knownProjectIds: string[];
  receipts: Record<string, Receipt>;
};
type StateWriter = (file: string, key: Buffer, scope: string, value: unknown) => void;
type Groups = Pick<ProjectGroupService, "list" | "containing" | "ownerMoveMark" | "storedHolder">;
type Options = { now?: () => number; writeState?: StateWriter; policyVersion?: number };

const SCOPE = "permission-delegations";
const emptyState = (): Stored => ({ entries: {}, optOuts: {}, knownProjectIds: [], receipts: {} });
const own = <T>(map: Record<string, T>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string) => new TeamError(409, "request-conflict", message);
const notFound = () => new TeamError(404, "project-group-not-found", "This project group does not exist.");
const projectIds = (group: PermissionDelegationGroup): string[] =>
  [...new Set(group.repos.flatMap(repo => repo.checkouts.map(checkout => checkout.projectId)))];

export class PermissionDelegationService {
  private readonly file: string;
  private readonly writeState: StateWriter;
  private readonly clock: () => number;
  private readonly policyVersion: number;
  private state: Stored;
  private uncertain = false;

  constructor(
    private readonly config: Pick<Config, "stateDir" | "projects">,
    private readonly key: Buffer,
    private readonly groups: Groups,
    options: Options = {},
  ) {
    const directory = resolve(config.stateDir, "permission-delegations");
    this.file = resolve(directory, "state.sealed");
    this.writeState = options.writeState ?? writeSealed;
    this.clock = options.now ?? Date.now;
    this.policyVersion = options.policyVersion ?? PERMISSION_POLICY_VERSION;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = this.load();
  }

  private load(): Stored {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }

    let parsed;
    try { parsed = permissionDelegationStoredStateSchema.safeParse(unseal<unknown>(this.key, SCOPE, raw)); }
    catch { throw new Error("Invalid permission-delegation state"); }
    if (!parsed.success) throw new Error("Invalid permission-delegation state");
    return parsed.data;
  }

  private timestamp() { return new Date(this.clock()).toISOString(); }

  private enrolled(projectId: string): Project | undefined {
    return this.config.projects.find(project => project.id === projectId);
  }

  private validEntry(projectId: string, state: Stored): PermissionCoverageEntry | undefined {
    const project = this.enrolled(projectId), entry = own(state.entries, projectId);
    if (!project || !entry || own(state.optOuts, projectId)) return undefined;
    if (entry.path !== resolve(project.path) || entry.moveMark !== this.groups.ownerMoveMark(projectId)) return undefined;
    return entry;
  }

  private newEntry(project: Project, act: PermissionCoverageEntry["act"], workspaceId: string, actor: PermissionDelegationActor, at: string, direction?: string): PermissionCoverageEntry {
    return {
      projectId: project.id,
      act,
      workspaceId,
      by: actor.deviceId,
      at,
      interruptClasses: [...INTERRUPT_CLASSES],
      policyVersion: this.policyVersion,
      path: resolve(project.path),
      moveMark: this.groups.ownerMoveMark(project.id),
      ...(direction === undefined ? {} : { direction }),
    };
  }

  private remember(candidate: Stored, ids: string[]) {
    candidate.knownProjectIds = [...new Set([...candidate.knownProjectIds, ...ids])].sort();
  }

  private persist(candidate: Stored) {
    try {
      this.writeState(this.file, this.key, SCOPE, candidate);
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
    this.state = candidate;
  }

  private settle() {
    if (!this.uncertain) return;
    this.state = this.load();
    this.uncertain = false;
  }

  private replay<T>(requestId: string, fingerprint: string): T | undefined {
    const receipt = own(this.state.receipts, requestId);
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint) throw conflict("This request ID belongs to a different permission-delegation action.");
    return structuredClone(receipt.result) as T;
  }

  private record<T>(candidate: Stored, requestId: string, fingerprint: string, result: T): T {
    candidate.receipts[requestId] = { fingerprint, result: structuredClone(result) };
    this.persist(candidate);
    return structuredClone(result);
  }

  private fingerprint(action: string, target: string | undefined, request: unknown, actor: PermissionDelegationActor) {
    return digest({ action, target, request, actor });
  }

  private target(id: string, state: Stored): { found: PermissionDelegationGroup[]; absent: string[] } {
    const listed = this.groups.list().groups as PermissionDelegationGroup[];
    const away = Object.keys(state.entries).filter(projectId => !this.enrolled(projectId));
    const namesake = away.filter(projectId => projectId === id && this.groups.storedHolder(projectId) === undefined);
    let found = listed.filter(group => group.id === id);
    if (found.length === 0 && namesake.length === 0) {
      const holder = this.enrolled(id) ? undefined : this.groups.storedHolder(id);
      found = listed.filter(group => projectIds(group).includes(id) || (!group.implicit && group.id === holder));
    }
    const stored = new Set(found.filter(group => !group.implicit).map(group => group.id));
    const held = away.filter(projectId => stored.has(this.groups.storedHolder(projectId) ?? ""));
    return { found, absent: [...namesake, ...held] };
  }

  private endEntries(candidate: Stored, ids: string[]) {
    for (const projectId of ids) delete candidate.entries[projectId];
  }

  private members(group: PermissionDelegationGroup) {
    return projectIds(group).filter(projectId => this.enrolled(projectId));
  }

  private directionForDelegate(candidate: Stored, memberIds: string[], direction: string | null | undefined) {
    if (direction !== undefined) return direction ?? undefined;
    const existing = [...new Set(memberIds.flatMap(projectId => {
      const entry = this.validEntry(projectId, candidate);
      return entry ? [entry.direction ?? null] : [];
    }))];
    if (existing.length > 1)
      throw new TeamError(409, "permission-delegation-direction-conflict", "Covered projects have different direction text. Supply an explicit direction to delegate.");
    return existing[0] ?? undefined;
  }

  private applyDelegate(
    candidate: Stored,
    group: PermissionDelegationGroup,
    direction: string | null | undefined,
    actor: PermissionDelegationActor,
    at: string,
  ): string[] {
    const memberIds = this.members(group);
    const selectedDirection = this.directionForDelegate(candidate, memberIds, direction);
    const replaced: string[] = [];
    this.remember(candidate, memberIds);
    for (const projectId of memberIds) {
      if (own(candidate.optOuts, projectId)) {
        delete candidate.optOuts[projectId];
        replaced.push(projectId);
      }
      candidate.entries[projectId] = this.newEntry(this.enrolled(projectId)!, "delegate", group.id, actor, at, selectedDirection);
    }
    return replaced;
  }

  private projectView(projectId: string, state: Stored): WorkspaceDelegationProjectView {
    const project = this.enrolled(projectId)!;
    if (own(state.optOuts, projectId)) return { projectId, name: project.name, state: "opt-out" };
    const entry = this.validEntry(projectId, state);
    return entry
      ? { projectId, name: project.name, state: "covered", act: entry.act, at: entry.at }
      : { projectId, name: project.name, state: "not-covered" };
  }

  private view(group: PermissionDelegationGroup, state: Stored): WorkspaceDelegationView {
    const ids = this.members(group);
    const covered = ids.flatMap(projectId => this.validEntry(projectId, state) ?? []);
    const stateName = ids.length > 0 && covered.length === ids.length
      ? "delegated"
      : covered.length > 0 ? "partly-delegated" : "not-delegated";
    const directions = [...new Set(covered.map(entry => entry.direction ?? null))];
    const direction = directions.length === 1 ? directions[0] : undefined;
    return {
      workspaceId: group.id,
      name: group.name,
      state: stateName,
      ...(direction === undefined || direction === null ? {} : { direction }),
      projects: ids.map(projectId => this.projectView(projectId, state)),
    };
  }

  private coverageFrom(projectId: string, state: Stored): CoverageResult {
    if (!this.enrolled(projectId)) return { covered: false, projectId, reason: "unknown-project" };
    if (own(state.optOuts, projectId)) return { covered: false, projectId, reason: "opt-out" };
    const entry = this.validEntry(projectId, state);
    const holder = entry && this.groups.containing(projectId);
    if (!entry || !holder) return { covered: false, projectId, reason: "not-covered" };
    const classes = interruptClassesInForce(entry.interruptClasses);
    return {
      covered: true,
      projectId,
      workspaceId: holder.id,
      coverage: structuredClone(entry),
      interruptClasses: classes,
      authorityHash: digest({
        pinnedPolicyVersion: entry.policyVersion,
        policyVersionInForce: this.policyVersion,
        interruptClasses: classes,
        direction: entry.direction ?? null,
        at: entry.at,
      }),
    };
  }

  delegate(
    workspaceId: string,
    input: { requestId: string; direction?: string | null },
    actorInput: { deviceId: string },
  ): { view: WorkspaceDelegationView; replacedOptOuts: string[] } {
    this.settle();
    const request = permissionDelegationRequestSchema.parse(input);
    const actor = permissionDelegationActorSchema.parse(actorInput);
    const fingerprint = this.fingerprint("delegate", workspaceId, request, actor);
    const replay = this.replay<{ view: WorkspaceDelegationView; replacedOptOuts: string[] }>(request.requestId, fingerprint);
    if (replay) return replay;

    const candidate = structuredClone(this.state);
    const { found, absent } = this.target(workspaceId, candidate);
    if (found.length === 0) throw notFound();
    if (found.length > 1)
      throw new TeamError(409, "permission-workspace-ambiguous", "Two workspaces share this id. Regroup so that the id names one workspace, or delegate every workspace.");
    const group = found[0]!;
    const replacedOptOuts = this.applyDelegate(candidate, group, request.direction, actor, this.timestamp());
    this.endEntries(candidate, absent);
    return this.record(candidate, request.requestId, fingerprint, {
      view: this.view(group, candidate),
      replacedOptOuts: replacedOptOuts.sort(),
    });
  }

  delegateAll(
    input: { requestId: string; direction?: string | null },
    actorInput: { deviceId: string },
  ): { views: WorkspaceDelegationView[]; replacedOptOuts: string[] } {
    this.settle();
    const request = permissionDelegationRequestSchema.parse(input);
    const actor = permissionDelegationActorSchema.parse(actorInput);
    const fingerprint = this.fingerprint("delegateAll", undefined, request, actor);
    const replay = this.replay<{ views: WorkspaceDelegationView[]; replacedOptOuts: string[] }>(request.requestId, fingerprint);
    if (replay) return replay;

    const groups = this.groups.list().groups as PermissionDelegationGroup[];
    const candidate = structuredClone(this.state);
    const at = this.timestamp();
    const replacedOptOuts: string[] = [];
    for (const group of groups)
      replacedOptOuts.push(...this.applyDelegate(candidate, group, request.direction, actor, at));
    this.endEntries(candidate, Object.keys(candidate.entries).filter(projectId => !this.enrolled(projectId)));
    return this.record(candidate, request.requestId, fingerprint, {
      views: groups.map(group => this.view(group, candidate)),
      replacedOptOuts: [...new Set(replacedOptOuts)].sort(),
    });
  }

  coverProject(
    projectId: string,
    input: { requestId: string },
    actorInput: { deviceId: string },
  ): CoverageResult {
    this.settle();
    const request = permissionDelegationMutationRequestSchema.parse(input);
    const actor = permissionDelegationActorSchema.parse(actorInput);
    const fingerprint = this.fingerprint("coverProject", projectId, request, actor);
    const replay = this.replay<CoverageResult>(request.requestId, fingerprint);
    if (replay) return replay;
    const project = this.enrolled(projectId);
    if (!project) throw new TeamError(404, "unknown-project", "The selected project is not configured on this host.");

    const candidate = structuredClone(this.state);
    if (!candidate.knownProjectIds.includes(projectId)) {
      const holder = this.groups.containing(projectId);
      if (!holder) throw new TeamError(409, "project-workspace-unavailable", "The selected project has no current workspace.");
      this.remember(candidate, [projectId]);
      candidate.entries[projectId] = this.newEntry(project, "onboarding", holder.id, actor, this.timestamp());
    }
    return this.record(candidate, request.requestId, fingerprint, this.coverageFrom(projectId, candidate));
  }

  optOut(projectId: string, input: { requestId: string }, actorInput: { deviceId: string }): CoverageResult {
    this.settle();
    const request = permissionDelegationMutationRequestSchema.parse(input);
    const actor = permissionDelegationActorSchema.parse(actorInput);
    const fingerprint = this.fingerprint("optOut", projectId, request, actor);
    const replay = this.replay<CoverageResult>(request.requestId, fingerprint);
    if (replay) return replay;
    if (!this.enrolled(projectId)) throw new TeamError(404, "unknown-project", "The selected project is not configured on this host.");

    const candidate = structuredClone(this.state);
    delete candidate.entries[projectId];
    this.remember(candidate, [projectId]);
    candidate.optOuts[projectId] = { projectId, by: actor.deviceId, at: this.timestamp() };
    return this.record(candidate, request.requestId, fingerprint, this.coverageFrom(projectId, candidate));
  }

  revoke(workspaceId: string, input: { requestId: string }, actorInput: { deviceId: string }): WorkspaceDelegationView {
    this.settle();
    const request = permissionDelegationMutationRequestSchema.parse(input);
    const actor = permissionDelegationActorSchema.parse(actorInput);
    const fingerprint = this.fingerprint("revoke", workspaceId, request, actor);
    const replay = this.replay<WorkspaceDelegationView>(request.requestId, fingerprint);
    if (replay) return replay;

    const candidate = structuredClone(this.state);
    const { found, absent } = this.target(workspaceId, candidate);
    this.endEntries(candidate, absent);
    if (found.length === 0) {
      if (absent.length === 0) throw notFound();
      return this.record<WorkspaceDelegationView>(candidate, request.requestId, fingerprint,
        { workspaceId, name: workspaceId, state: "not-delegated", projects: [] });
    }
    const group = { ...found[0]!, repos: found.flatMap(workspace => workspace.repos) };
    const memberIds = this.members(group);
    this.remember(candidate, memberIds);
    this.endEntries(candidate, memberIds);
    return this.record(candidate, request.requestId, fingerprint, this.view(group, candidate));
  }

  coverage(projectId: string): CoverageResult {
    this.settle();
    return this.coverageFrom(projectId, this.state);
  }

  status(): WorkspaceDelegationView[] {
    this.settle();
    return (this.groups.list().groups as PermissionDelegationGroup[]).map(group => this.view(group, this.state));
  }
}
