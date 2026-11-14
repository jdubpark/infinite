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
  type CoverageResult,
  type PermissionCoverageEntry,
  type PermissionDelegationActor,
  type PermissionDelegationGroup,
  type PermissionOptOut,
  type WorkspaceDelegationProjectView,
  type WorkspaceDelegationView,
  permissionDelegationStoredStateSchema,
} from "./permission-delegation-types.js";

type Receipt = { fingerprint: string; result: unknown };
type Stored = {
  entries: Record<string, PermissionCoverageEntry>;
  optOuts: Record<string, PermissionOptOut>;
  knownProjectIds: string[];
  pendingRegroup?: Record<string, string>;
  receipts: Record<string, Receipt>;
};
type StateWriter = (file: string, key: Buffer, scope: string, value: unknown) => void;
type Groups = Pick<ProjectGroupService, "get" | "list" | "containing">;
type Options = { now?: () => number; writeState?: StateWriter; policyVersion?: number };

const SCOPE = "permission-delegations";
const emptyState = (): Stored => ({ entries: {}, optOuts: {}, knownProjectIds: [], receipts: {} });
const own = <T>(map: Record<string, T>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string) => new TeamError(409, "request-conflict", message);
const projectIds = (group: PermissionDelegationGroup): string[] =>
  [...new Set(group.repos.flatMap(repo => repo.checkouts.map(checkout => checkout.projectId)))];

/** Durable owner authority, recorded once for each covered host project. */
export class PermissionDelegationService {
  private readonly file: string;
  private readonly writeState: StateWriter;
  private readonly clock: () => number;
  private readonly policyVersion: number;
  private state: Stored;

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

    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = emptyState();
        return;
      }
      throw error;
    }

    try {
      const parsed = permissionDelegationStoredStateSchema.safeParse(unseal<unknown>(key, SCOPE, raw));
      if (!parsed.success) throw new Error("Invalid permission-delegation state");
      const stored = parsed.data;
      this.state = {
        entries: stored.entries,
        optOuts: stored.optOuts,
        knownProjectIds: stored.knownProjectIds ?? [...new Set([...Object.keys(stored.entries), ...Object.keys(stored.optOuts)])],
        ...(stored.pendingRegroup ? { pendingRegroup: stored.pendingRegroup } : {}),
        receipts: stored.receipts,
      };
    } catch {
      throw new Error("Invalid permission-delegation state");
    }
  }

  private timestamp() { return new Date(this.clock()).toISOString(); }

  private enrolled(projectId: string): Project | undefined {
    return this.config.projects.find(project => project.id === projectId);
  }

  private prune(candidate: Stored): boolean {
    const enrolled = new Set(this.config.projects.map(project => project.id));
    let changed = false;
    for (const projectId of Object.keys(candidate.entries)) {
      if (enrolled.has(projectId)) continue;
      delete candidate.entries[projectId];
      changed = true;
    }
    for (const projectId of Object.keys(candidate.optOuts)) {
      if (enrolled.has(projectId)) continue;
      delete candidate.optOuts[projectId];
      changed = true;
    }
    const knownProjectIds = candidate.knownProjectIds.filter(projectId => enrolled.has(projectId));
    if (knownProjectIds.length !== candidate.knownProjectIds.length) changed = true;
    candidate.knownProjectIds = knownProjectIds;
    return changed;
  }

  private remember(candidate: Stored, projectIds: string[]) {
    candidate.knownProjectIds = [...new Set([...candidate.knownProjectIds, ...projectIds])].sort();
  }

  private persist(candidate: Stored) {
    this.writeState(this.file, this.key, SCOPE, candidate);
    this.state = candidate;
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

  private members(group: PermissionDelegationGroup) {
    return projectIds(group).filter(projectId => this.enrolled(projectId));
  }

  private directionForDelegate(candidate: Stored, memberIds: string[], direction: string | null | undefined) {
    if (direction !== undefined) return direction ?? undefined;
    const existing = [...new Set(memberIds.flatMap(projectId => {
      const entry = own(candidate.entries, projectId);
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
    for (const projectId of memberIds) {
      this.remember(candidate, [projectId]);
      if (own(candidate.optOuts, projectId)) {
        delete candidate.optOuts[projectId];
        replaced.push(projectId);
      }
      candidate.entries[projectId] = {
        projectId,
        act: "delegate",
        workspaceId: group.id,
        by: actor.deviceId,
        at,
        interruptClasses: [...INTERRUPT_CLASSES],
        policyVersion: this.policyVersion,
        ...(selectedDirection === undefined ? {} : { direction: selectedDirection }),
      };
    }
    return replaced;
  }

  private projectView(projectId: string, state: Stored): WorkspaceDelegationProjectView {
    const project = this.enrolled(projectId)!;
    const optOut = own(state.optOuts, projectId);
    if (optOut) return { projectId, name: project.name, state: "opt-out" };
    const entry = own(state.entries, projectId);
    return entry
      ? { projectId, name: project.name, state: "covered", act: entry.act, at: entry.at }
      : { projectId, name: project.name, state: "not-covered" };
  }

  private view(group: PermissionDelegationGroup, state: Stored): WorkspaceDelegationView {
    const ids = this.members(group);
    const projects = ids.map(projectId => this.projectView(projectId, state));
    const covered = ids.filter(projectId => own(state.entries, projectId) && !own(state.optOuts, projectId));
    const stateName = ids.length > 0 && covered.length === ids.length
      ? "delegated"
      : covered.length > 0 ? "partly-delegated" : "not-delegated";
    const directions = [...new Set(covered.map(projectId => own(state.entries, projectId)!.direction ?? null))];
    const direction = directions.length === 1 ? directions[0] : undefined;
    return {
      workspaceId: group.id,
      name: group.name,
      state: stateName,
      ...(direction === undefined || direction === null ? {} : { direction }),
      projects,
    };
  }

  private coverageFrom(projectId: string, state: Stored): CoverageResult {
    if (!this.enrolled(projectId)) return { covered: false, projectId, reason: "unknown-project" };
    if (own(state.optOuts, projectId)) return { covered: false, projectId, reason: "opt-out" };
    const entry = own(state.entries, projectId);
    if (!entry) return { covered: false, projectId, reason: "not-covered" };
    const holder = this.groups.containing(projectId);
    if (!holder) return { covered: false, projectId, reason: "not-covered" };
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

  private start() {
    const next = structuredClone(this.state);
    this.prune(next);
    return next;
  }

  /**
   * Finishes an owner regrouping that left its marker: every covered project whose holder differs
   * from the one sealed before the regrouping loses its coverage. Each public method calls this
   * first, so a failed write here surfaces as an error instead of a stale "covered" answer.
   */
  private settle() {
    const pending = this.state.pendingRegroup;
    if (!pending) return;
    const candidate = this.start();
    for (const [projectId, holderId] of Object.entries(pending)) {
      if (!own(candidate.entries, projectId) || this.groups.containing(projectId)?.id === holderId) continue;
      delete candidate.entries[projectId];
      this.remember(candidate, [projectId]);
    }
    delete candidate.pendingRegroup;
    this.persist(candidate);
  }

  /**
   * Runs an owner's regrouping so that coverage cannot outlive a move out of a workspace. The holder
   * of every covered project is sealed before `mutate` runs; afterwards each covered project whose
   * holder changed loses its coverage. If the host stops or the second write fails in between, the
   * sealed marker remains and the next call settles it. A host fold inside that window also drops
   * the folded project's coverage, which is the safe direction.
   */
  aroundOwnerRegroup<T>(mutate: () => T): T {
    this.settle();
    const candidate = this.start();
    const holders: Record<string, string> = {};
    for (const projectId of Object.keys(candidate.entries)) {
      const holder = this.groups.containing(projectId);
      if (holder) holders[projectId] = holder.id;
    }
    if (!Object.keys(holders).length) return mutate();
    candidate.pendingRegroup = holders;
    this.persist(candidate);
    try { return mutate(); }
    finally { this.settle(); }
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

    const group = this.groups.get(workspaceId) as PermissionDelegationGroup;
    const candidate = this.start();
    const replacedOptOuts = this.applyDelegate(candidate, group, request.direction, actor, this.timestamp());
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
    const candidate = this.start();
    const at = this.timestamp();
    const replacedOptOuts: string[] = [];
    for (const group of groups)
      replacedOptOuts.push(...this.applyDelegate(candidate, group, request.direction, actor, at));
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
    if (!this.enrolled(projectId)) throw new TeamError(404, "unknown-project", "The selected project is not configured on this host.");

    const candidate = this.start();
    if (candidate.knownProjectIds.includes(projectId))
      return this.record(candidate, request.requestId, fingerprint, this.coverageFrom(projectId, candidate));

    const holder = this.groups.containing(projectId);
    if (!holder) throw new TeamError(409, "project-workspace-unavailable", "The selected project has no current workspace.");
    this.remember(candidate, [projectId]);
    candidate.entries[projectId] = {
      projectId,
      act: "onboarding",
      workspaceId: holder.id,
      by: actor.deviceId,
      at: this.timestamp(),
      interruptClasses: [...INTERRUPT_CLASSES],
      policyVersion: this.policyVersion,
    };
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

    const candidate = this.start();
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

    const group = this.groups.get(workspaceId) as PermissionDelegationGroup;
    const candidate = this.start();
    const memberIds = this.members(group);
    this.remember(candidate, memberIds);
    for (const projectId of memberIds) delete candidate.entries[projectId];
    return this.record(candidate, request.requestId, fingerprint, this.view(group, candidate));
  }

  /** Throws when an unsettled regrouping cannot be settled; a caller must treat that as not covered. */
  coverage(projectId: string): CoverageResult {
    this.settle();
    return this.coverageFrom(projectId, this.state);
  }

  status(): WorkspaceDelegationView[] {
    this.settle();
    const groups = this.groups.list().groups as PermissionDelegationGroup[];
    const enrolled = new Set(this.config.projects.map(project => project.id));
    return groups.map(group => ({
      ...group,
      repos: group.repos.map(repo => ({
        ...repo,
        checkouts: repo.checkouts.filter(checkout => enrolled.has(checkout.projectId)),
      })),
    })).map(group => this.view(group, this.state));
  }
}
