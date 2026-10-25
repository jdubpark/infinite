import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  KnowledgeCatalog, KnowledgeComponentInput, KnowledgeFeatureInput, KnowledgeMutationContext,
  KnowledgePlanInput, KnowledgePolicy, KnowledgeProjectInput,
} from "@infinite/remote";
import { captureIdentity, readGit } from "./checkout-identity.js";
import type { ProjectGroup, ProjectGroupList } from "./project-group-types.js";
import type { Config } from "./types.js";
import { seal, unseal, writeSealed } from "./vault.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPTS = 256;
const MAX_ENTITIES = 512;
const MAX_IDS = 4096;
const MAX_HISTORY = 16;
export const understandingCatalogLimits = { planText: 12000, planWorkId: 200, componentDescription: 4000 } as const;
const id = z.string().regex(/^[a-z0-9-]{1,80}$/);
const componentId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const idList = z.array(id).min(1).max(64).refine(value => new Set(value).size === value.length);
const label = (max: number) => z.string().trim().min(1).max(max);
const projectInput = z.object({ name: label(120), description: z.string().trim().max(4000), repositoryIds: idList }).strict();
const featureInput = z.object({
  projectId: id.nullable(), title: label(160), description: z.string().trim().max(8000), repositoryIds: idList,
  workIds: z.array(label(200)).max(32), componentIds: z.array(componentId).max(64),
  status: z.enum(["planned", "active", "blocked", "completed", "cancelled", "failed"]),
  sourceUrl: z.string().url().max(2048).nullable(),
}).strict();
const planInput = z.object({ componentId, repositoryIds: idList, title: label(160), text: label(understandingCatalogLimits.planText),
  status: z.enum(["proposed", "accepted", "superseded"]), sourceUrl: z.string().url().max(2048).nullable(), workId: label(understandingCatalogLimits.planWorkId).nullable() }).strict();
const componentInput = z.object({ repositoryIds: idList, name: label(120), description: z.string().trim().max(understandingCatalogLimits.componentDescription),
  redirectTo: componentId.nullable(), pinned: z.boolean() }).strict();
const policyInput = z.object({ enabled: z.boolean(), synthesis: z.boolean(), delivery: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(1440), dailyJobLimit: z.number().int().min(1).max(1000) }).strict();
const policySchema = policyInput.extend({ editedAt: z.string().datetime({ offset: true }).nullable().optional(), editedBy: z.enum(["owner", "migration"]).nullable().optional() }).strict();
const envelope = z.object({ requestId: z.uuid(), revision: z.number().int().nonnegative(), action: z.enum(["create", "update", "archive"]), value: z.unknown().optional() }).strict();
const historySchema = z.array(z.object({ revision: z.number().int().positive(), at: z.string().datetime({ offset: true }), summary: z.string().min(1).max(500) }).strict()).max(MAX_HISTORY);
const projectSchema = z.object({ id, revision: z.number().int().positive(), name: label(120), description: z.string().max(4000), repositoryIds: idList,
  archived: z.boolean(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }), history: historySchema }).strict();
const featureSchema = z.object({ id, revision: z.number().int().positive(), projectId: id.nullable(), title: label(160), description: z.string().max(8000),
  repositoryIds: idList, workIds: z.array(label(200)).max(32), componentIds: z.array(componentId).max(64), status: featureInput.shape.status,
  sourceUrl: z.string().url().max(2048).nullable(), archived: z.boolean(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }), history: historySchema }).strict();
const planSchema = z.object({ id, revision: z.number().int().positive(), componentId, repositoryIds: idList, title: label(160), text: planInput.shape.text,
  status: planInput.shape.status, sourceUrl: z.string().url().max(2048).nullable(), workId: planInput.shape.workId, archived: z.boolean(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }), history: historySchema }).strict();
const overrideSchema = z.object({ id: componentId, revision: z.number().int().positive(), repositoryIds: idList, name: label(120), description: z.string().max(understandingCatalogLimits.componentDescription),
  redirectTo: componentId.nullable(), pinned: z.boolean(), updatedAt: z.string().datetime({ offset: true }) }).strict();
const catalogSchema = z.object({ revision: z.number().int().nonnegative(), projects: z.array(projectSchema).max(MAX_ENTITIES), features: z.array(featureSchema).max(MAX_ENTITIES),
  plans: z.array(planSchema).max(MAX_ENTITIES), componentOverrides: z.array(overrideSchema).max(MAX_ENTITIES), policy: policySchema,
  coverage: z.array(z.string().max(500)).max(64) }).strict();
const bindingEntrySchema = z.object({ projectId: id, path: z.string().min(1).max(4096), device: z.string().max(80), inode: z.string().max(80), identity: z.string().regex(/^[a-f0-9]{64}$/),
  repositoryIdentity: z.string().regex(/^[a-f0-9]{64}$/), primaryProjectId: id }).strict();
const storedSchema = z.object({ version: z.literal(1), workspaceId: id,
  binding: z.array(bindingEntrySchema).max(512), scopes: z.record(componentId, z.array(bindingEntrySchema).max(512)),
  policyBinding: z.array(bindingEntrySchema).max(512),
  catalog: catalogSchema, receipts: z.record(z.uuid(), z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).refine(value => Object.keys(value).length <= MAX_RECEIPTS),
  usedIds: z.array(id).max(MAX_IDS).refine(value => new Set(value).size === value.length) }).strict();
const defaults: KnowledgePolicy = { enabled: true, synthesis: true, delivery: true, intervalMinutes: 15, dailyJobLimit: 24 };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const own = <T>(value: Record<string, T>, key: string): T | undefined => Object.hasOwn(value, key) ? value[key] : undefined;

type BindingEntry = z.infer<typeof bindingEntrySchema>;
type BindingSnapshot = { entries: BindingEntry[]; gaps: string[] };
type Stored = { version: 1; workspaceId: string; binding: BindingEntry[]; scopes: Record<string, BindingEntry[]>; policyBinding: BindingEntry[]; catalog: KnowledgeCatalog; receipts: Record<string, { fingerprint: string }>; usedIds: string[] };
type EntityKind = "projects" | "features" | "plans" | "components" | "policy";

export class CatalogError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 503, message: string) { super(message); this.name = "CatalogError"; }
}

function emptyCatalog(): KnowledgeCatalog {
  return { revision: 0, projects: [], features: [], plans: [], componentOverrides: [], policy: { ...defaults, editedAt: null, editedBy: null }, coverage: [] };
}

/** Encrypted owner knowledge, bound to one exact enrolled repository group. */
export class UnderstandingCatalog {
  private readonly directory: string;
  private readonly fileFor: (workspaceId: string) => string;
  private readonly states = new Map<string, Stored>();
  private readonly storageErrors = new Map<string, string>();

  constructor(private readonly sources: { config: Config; key: Buffer; groups: { get(id: string): ProjectGroup; list(): ProjectGroupList } }) {
    this.directory = resolve(sources.config.stateDir, "understanding", "catalogs");
    this.fileFor = workspaceId => join(this.directory, `${workspaceId}.sealed`);
  }

  private failStorage(workspaceId: string): never {
    throw new CatalogError(503, this.storageErrors.get(workspaceId) ?? "The Understanding catalog is unavailable or corrupt.");
  }

  private group(workspaceId: string): ProjectGroup {
    if (!id.safeParse(workspaceId).success) throw new CatalogError(404, "This repository workspace does not exist.");
    try {
      const group = this.sources.groups.get(workspaceId);
      if (group.id !== workspaceId) throw new Error("workspace-id-mismatch");
      return group;
    }
    catch { throw new CatalogError(404, "This repository workspace does not exist."); }
  }

  /** Captures enrolled identities without joining projects by display name. */
  private binding(group: ProjectGroup): BindingSnapshot {
    const projects = new Map(this.sources.config.projects.map(project => [project.id, project]));
    const folded = group.repos.flatMap(repo => repo.checkouts.map(checkout => ({ checkout, repo })));
    const entries: BindingEntry[] = [], gaps: string[] = [];
    for (const { checkout, repo } of folded) {
      const project = projects.get(checkout.projectId);
      if (!project) { gaps.push(checkout.projectId); continue; }
      try {
        const path = realpathSync(project.path);
        const stat = statSync(path);
        const captured = captureIdentity(project, readGit);
        if (!captured || (repo.key && captured.key !== repo.key)) throw new Error("identity-mismatch");
        entries.push({ projectId: project.id, path, device: String(stat.dev), inode: String(stat.ino), identity: digest(captured.key),
          repositoryIdentity: digest(repo.key ?? captured.key), primaryProjectId: repo.projectId });
      } catch {
        gaps.push(checkout.projectId);
      }
    }
    const unique = new Map<string, BindingEntry>();
    for (const entry of entries) unique.set(entry.projectId, entry);
    for (const entry of entries) if (entries.filter(value => value.projectId === entry.projectId).length > 1) gaps.push(entry.projectId);
    return { entries: [...unique.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)), gaps: [...new Set(gaps)] };
  }

  private load(workspaceId: string): Stored {
    const cached = this.states.get(workspaceId);
    if (cached) return cached;
    if (this.storageErrors.has(workspaceId)) this.failStorage(workspaceId);
    try {
      const raw = readFileSync(this.fileFor(workspaceId), "utf8");
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("catalog-too-large");
      const value = storedSchema.parse(unseal<unknown>(this.sources.key, `understanding-catalog:${workspaceId}`, raw)) as Stored;
      if (value.workspaceId !== workspaceId) throw new Error("catalog-workspace-mismatch");
      if (value.catalog.policy.editedAt === undefined) {
        // One-time migration: records saved before edits were stamped lack the key and carry the old disabled defaults.
        value.catalog.policy = { ...defaults, editedAt: new Date().toISOString(), editedBy: "migration" };
        try { this.persist(workspaceId, value); } catch { /* keep the migrated policy in memory; it retries on the next load */ }
      }
      this.states.set(workspaceId, value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const initial: Stored = { version: 1, workspaceId, binding: [], scopes: {}, policyBinding: [], catalog: emptyCatalog(), receipts: {}, usedIds: [] };
        this.states.set(workspaceId, initial);
        return initial;
      }
      this.storageErrors.set(workspaceId, "The Understanding catalog is unavailable or corrupt.");
      this.failStorage(workspaceId);
    }
  }

  private scopeMatches(scope: BindingEntry[] | undefined, current: BindingEntry[]) {
    if (!scope?.length) return false;
    const currentById = new Map(current.map(entry => [entry.projectId, entry]));
    for (const saved of scope) {
      const live = currentById.get(saved.projectId);
      if (!live || live.path !== saved.path || live.device !== saved.device || live.inode !== saved.inode
        || live.identity !== saved.identity || live.repositoryIdentity !== saved.repositoryIdentity) return false;
    }
    // Extra enrolled copies of an unchanged repository do not expand a record's
    // repository scope. Every originally pinned checkout must still match.
    return true;
  }

  private exactMembershipMatches(previous: BindingEntry[], current: BindingEntry[]) {
    if (!previous.length || previous.length !== current.length) return false;
    const stable = (entries: BindingEntry[]) => entries.map(({ projectId, path, device, inode, identity, repositoryIdentity }) => ({ projectId, path, device, inode, identity, repositoryIdentity }));
    return digest(stable(previous)) === digest(stable(current));
  }

  private captureScope(ids: string[], binding: BindingEntry[]) {
    const identityByCheckout = new Map(binding.map(entry => [entry.projectId, entry.repositoryIdentity]));
    const identityByPrimary = new Map(binding.map(entry => [entry.primaryProjectId, entry.repositoryIdentity]));
    const identities = new Set(ids.map(value => identityByCheckout.get(value) ?? identityByPrimary.get(value)).filter((value): value is string => Boolean(value)));
    return binding.filter(entry => identities.has(entry.repositoryIdentity));
  }

  private canonicalRepositoryIds(ids: string[], binding: BindingEntry[]): string[] {
    const primaryByIdentity = new Map(binding.map(entry => [entry.repositoryIdentity, entry.primaryProjectId]));
    const identityByCheckout = new Map(binding.map(entry => [entry.projectId, entry.repositoryIdentity]));
    return [...new Set(ids.map(projectId => {
      const identity = identityByCheckout.get(projectId);
      return identity ? primaryByIdentity.get(identity) ?? projectId : projectId;
    }))];
  }

  private translatedCatalog(catalog: KnowledgeCatalog, previous: BindingEntry[], current: BindingEntry[]): KnowledgeCatalog {
    if (!previous.length) return structuredClone(catalog);
    const primaryByIdentity = new Map(current.map(entry => [entry.repositoryIdentity, entry.primaryProjectId]));
    const identityByCheckout = new Map(previous.map(entry => [entry.projectId, entry.repositoryIdentity]));
    const translate = (ids: string[]) => [...new Set(ids.map(projectId => {
      const identity = identityByCheckout.get(projectId);
      return identity ? primaryByIdentity.get(identity) ?? projectId : projectId;
    }))];
    const result = structuredClone(catalog);
    for (const item of result.projects) item.repositoryIds = translate(item.repositoryIds);
    for (const item of result.features) item.repositoryIds = translate(item.repositoryIds);
    for (const item of result.plans) item.repositoryIds = translate(item.repositoryIds);
    for (const item of result.componentOverrides) item.repositoryIds = translate(item.repositoryIds);
    return result;
  }

  private scopedRead(state: Stored, current: BindingSnapshot): KnowledgeCatalog {
    const catalog = structuredClone(state.catalog);
    const projectsBefore = catalog.projects.length;
    const featuresBefore = catalog.features.length;
    const plansBefore = catalog.plans.length;
    const componentsBefore = catalog.componentOverrides.length;
    catalog.projects = catalog.projects.filter(item => this.scopeMatches(state.scopes[item.id], current.entries));
    for (const item of catalog.projects) item.repositoryIds = this.canonicalRepositoryIds(item.repositoryIds, current.entries);
    catalog.features = catalog.features.filter(item => this.scopeMatches(state.scopes[item.id], current.entries)
      && (!item.projectId || item.archived || catalog.projects.some(project => project.id === item.projectId && !project.archived)));
    for (const item of catalog.features) item.repositoryIds = this.canonicalRepositoryIds(item.repositoryIds, current.entries);
    catalog.plans = catalog.plans.filter(item => this.scopeMatches(state.scopes[item.id], current.entries));
    for (const item of catalog.plans) item.repositoryIds = this.canonicalRepositoryIds(item.repositoryIds, current.entries);
    catalog.componentOverrides = catalog.componentOverrides.filter(item => this.scopeMatches(state.scopes[item.id], current.entries));
    for (const item of catalog.componentOverrides) item.repositoryIds = this.canonicalRepositoryIds(item.repositoryIds, current.entries);
    const policyChanged = state.policyBinding.length > 0 && !this.exactMembershipMatches(state.policyBinding, current.entries);
    if (policyChanged) catalog.policy = { ...defaults };
    const withheld = projectsBefore !== catalog.projects.length || featuresBefore !== catalog.features.length || plansBefore !== catalog.plans.length || componentsBefore !== catalog.componentOverrides.length;
    catalog.coverage = current.gaps.length || withheld || policyChanged ? ["Some catalog records are withheld because their complete repository scope is unavailable or changed."] : [];
    return catalog;
  }

  read(workspaceId: string): KnowledgeCatalog {
    const group = this.group(workspaceId);
    let state: Stored;
    try { state = this.load(workspaceId); }
    catch (error) {
      if (error instanceof CatalogError && error.statusCode === 503) {
        const unavailable = emptyCatalog();
        unavailable.coverage = [error.message];
        return unavailable;
      }
      throw error;
    }
    const current = this.binding(group);
    return this.scopedRead(state, current);
  }

  private fail(message: string): never { throw new CatalogError(400, message); }
  private revision(state: Stored, requested: number) {
    if (state.catalog.revision !== requested) throw new CatalogError(409, "The catalog changed; reload it and retry.");
  }

  private checkScope(repositoryIds: string[], members: Set<string>) {
    if (repositoryIds.some(repositoryId => !members.has(repositoryId))) this.fail("Repository scope must stay within this workspace.");
  }

  private validateReferences(kind: EntityKind, value: unknown, state: Stored, members: Set<string>, context: KnowledgeMutationContext, binding: BindingEntry[], entityId?: string): unknown {
    const canonicalScope = (ids: string[]) => this.canonicalRepositoryIds(ids, binding);
    const contains = (outer: string[], inner: string[]) => canonicalScope(inner).every(id => canonicalScope(outer).includes(id));
    const equal = (a: string[], b: string[]) => contains(a, b) && contains(b, a);
    if (kind === "projects") {
      const parsed = projectInput.safeParse(value); if (!parsed.success) this.fail("Invalid project catalog value.");
      this.checkScope(parsed.data.repositoryIds, members); return { ...parsed.data, repositoryIds: this.canonicalRepositoryIds(parsed.data.repositoryIds, binding) } satisfies KnowledgeProjectInput;
    }
    if (kind === "features") {
      const parsed = featureInput.safeParse(value); if (!parsed.success) this.fail("Invalid feature catalog value.");
      const input = parsed.data;
      this.checkScope(input.repositoryIds, members);
      const project = input.projectId && state.catalog.projects.find(item => item.id === input.projectId && !item.archived);
      if (input.projectId && (!project || !contains(project.repositoryIds, input.repositoryIds))) this.fail("Feature scope must be contained by its active project.");
      if (input.workIds.some(workId => !context.work.some(work => work.id === workId && work.scope === "complete" && contains(input.repositoryIds, work.repositoryIds) && work.repositoryIds.every(repoId => members.has(repoId))))) this.fail("Work references must name complete associations within the feature's repository scope.");
      const components = new Map(context.components.map(component => [component.id, component]));
      if (input.componentIds.some(componentId => { const component = components.get(componentId); return !component || !contains(input.repositoryIds, component.repositoryIds); })) this.fail("Component references must exist within the feature repository scope.");
      return { ...input, repositoryIds: this.canonicalRepositoryIds(input.repositoryIds, binding) } satisfies KnowledgeFeatureInput;
    }
    if (kind === "plans") {
      const parsed = planInput.safeParse(value); if (!parsed.success) this.fail("Invalid plan catalog value.");
      const input = parsed.data; this.checkScope(input.repositoryIds, members);
      const component = context.components.find(item => item.id === input.componentId);
      if (!component || !equal(input.repositoryIds, component.repositoryIds)) this.fail("Plan scope must match its complete component repository scope.");
      if (input.workId && !context.work.some(work => work.id === input.workId && work.scope === "complete" && contains(input.repositoryIds, work.repositoryIds) && work.repositoryIds.every(repoId => members.has(repoId)))) this.fail("Plan work must be a complete association within its repository scope.");
      return { ...input, repositoryIds: this.canonicalRepositoryIds(input.repositoryIds, binding) } satisfies KnowledgePlanInput;
    }
    if (kind === "components") {
      const parsed = componentInput.safeParse(value); if (!parsed.success) this.fail("Invalid component override value.");
      const input = parsed.data; this.checkScope(input.repositoryIds, members);
      const component = context.components.find(item => item.id === entityId);
      if (!component || !equal(component.repositoryIds, input.repositoryIds)) this.fail("Component override must match an existing component scope.");
      if (input.redirectTo && !context.components.some(item => item.id === input.redirectTo && equal(item.repositoryIds, input.repositoryIds))) this.fail("Component redirects must stay within the same workspace and scope.");
      return { ...input, id: component.id, repositoryIds: this.canonicalRepositoryIds(input.repositoryIds, binding) } satisfies KnowledgeComponentInput & { id: string };
    }
    const parsed = policyInput.safeParse(value); if (!parsed.success) this.fail("Invalid catalog policy.");
    return parsed.data as KnowledgePolicy;
  }

  private listFor(state: Stored, kind: Exclude<EntityKind, "policy">): Array<Record<string, any>> {
    return kind === "projects" ? state.catalog.projects : kind === "features" ? state.catalog.features
      : kind === "plans" ? state.catalog.plans : state.catalog.componentOverrides;
  }

  private persist(workspaceId: string, state: Stored) {
    try {
      storedSchema.parse(state);
      const encryptedSize = Buffer.byteLength(seal(this.sources.key, `understanding-catalog:${workspaceId}`, state));
      if (encryptedSize > MAX_BYTES) throw new Error("Catalog exceeds storage limit.");
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeSealed(this.fileFor(workspaceId), this.sources.key, `understanding-catalog:${workspaceId}`, state);
      this.states.set(workspaceId, state);
    } catch {
      throw new CatalogError(503, "The Understanding catalog could not be durably saved.");
    }
  }

  mutate(workspaceId: string, collection: EntityKind, entityId: string | undefined, body: unknown, context: KnowledgeMutationContext): KnowledgeCatalog {
    const group = this.group(workspaceId);
    const current = this.binding(group);
    const loaded = this.load(workspaceId);
    const state: Stored = loaded.binding.length ? { ...structuredClone(loaded), catalog: this.translatedCatalog(loaded.catalog, loaded.binding, current.entries), binding: current.entries } : structuredClone(loaded);
    const parsedEnvelope = envelope.safeParse(body);
    if (!parsedEnvelope.success) this.fail("Invalid catalog mutation envelope.");
    const request = parsedEnvelope.data;
    const fingerprint = digest(canonical({ collection, entityId: entityId ?? null, request }));
    const receipt = own(state.receipts, request.requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CatalogError(409, "This request ID was already used for a different catalog mutation.");
      return this.scopedRead(state, current);
    }
    this.revision(state, request.revision);
    if (collection === "policy") {
      if (request.action !== "update" || entityId !== undefined) this.fail("Policy supports update only.");
      if (current.gaps.length) throw new CatalogError(409, "The workspace repository source set is incomplete; policy changes are withheld.");
    } else {
      if (!entityId && request.action !== "create") this.fail("An entity ID is required for update or archive.");
      if (entityId && request.action === "create") this.fail("Create IDs are assigned from the request ID.");
    }
    if ((request.action === "create" || request.action === "update") && request.value === undefined) this.fail("A value is required for create or update.");
    if (request.action === "archive" && request.value !== undefined) this.fail("Archive does not accept a value.");
    const members = new Set(current.entries.map(entry => entry.projectId));
    const candidate = structuredClone(state);
    const at = new Date().toISOString();
    if (collection === "policy") {
      candidate.catalog.policy = { ...this.validateReferences(collection, request.value, state, members, context, current.entries) as KnowledgePolicy, editedAt: at, editedBy: "owner" };
      candidate.policyBinding = current.entries;
    } else {
      const rows = this.listFor(candidate, collection);
      const idToUse = request.action === "create" ? request.requestId : entityId!;
      const existing = rows.find(row => row.id === idToUse);
      if (existing && !this.scopeMatches(candidate.scopes[idToUse], current.entries))
        throw new CatalogError(409, "This catalog item's repository scope changed; mutation is withheld.");
      if (collection === "components") {
        if (request.action !== "update" || !entityId) this.fail("Component overrides support update only.");
        const value = this.validateReferences(collection, request.value, state, members, context, current.entries, entityId) as Record<string, unknown> & { id: string };
        if (existing) {
          Object.assign(existing, value, { revision: existing.revision + 1, updatedAt: at });
        } else {
          if (rows.length >= MAX_ENTITIES) throw new CatalogError(409, "The catalog has reached its item limit.");
          rows.push({ id: entityId, revision: 1, repositoryIds: value.repositoryIds, name: value.name, description: value.description,
            redirectTo: value.redirectTo, pinned: value.pinned, updatedAt: at } as never);
        }
        candidate.scopes[entityId] = this.captureScope(value.repositoryIds as string[], current.entries);
      } else if (request.action === "create") {
        if (existing || candidate.usedIds.includes(idToUse)) throw new CatalogError(409, "This catalog ID has already been used.");
        if (rows.length >= MAX_ENTITIES || candidate.usedIds.length >= MAX_IDS) throw new CatalogError(409, "The catalog has reached its item limit.");
        const value = this.validateReferences(collection, request.value, state, members, context, current.entries) as Record<string, unknown>;
        const row: any = { id: idToUse, revision: 1, ...value, archived: false, createdAt: at, updatedAt: at,
          history: [{ revision: 1, at, summary: "Created by owner." }] };
        rows.push(row); candidate.usedIds.push(idToUse);
        candidate.scopes[idToUse] = this.captureScope(value.repositoryIds as string[], current.entries);
      } else {
        if (!existing) throw new CatalogError(404, "This catalog item does not exist.");
        if (request.action === "archive") {
          if (existing.archived) this.fail("This catalog item is already archived.");
          existing.archived = true;
          existing.revision++;
          existing.updatedAt = at;
          existing.history = [...existing.history, { revision: existing.revision, at, summary: "Archived by owner." }].slice(-MAX_HISTORY);
        } else {
          const value = this.validateReferences(collection, request.value, state, members, context, current.entries) as Record<string, unknown>;
          const old = structuredClone(existing);
          Object.assign(existing, value, { revision: existing.revision + 1, updatedAt: at });
          existing.history = [...(existing.history ?? []), { revision: existing.revision, at, summary: `Updated by owner: ${old.name ?? old.title ?? "catalog item"}.` }].slice(-MAX_HISTORY);
          candidate.scopes[idToUse] = this.captureScope(value.repositoryIds as string[], current.entries);
        }
      }
      if (collection === "components") this.validateRedirects(candidate.catalog.componentOverrides);
      if (collection === "projects" || collection === "features" || collection === "plans") this.validateArchiveReferences(candidate.catalog);
    }
    candidate.catalog.revision++;
    candidate.catalog.coverage = [];
    candidate.binding = current.entries;
    candidate.receipts[request.requestId] = { fingerprint };
    const receiptIds = Object.keys(candidate.receipts);
    for (const oldId of receiptIds.slice(0, Math.max(0, receiptIds.length - MAX_RECEIPTS))) delete candidate.receipts[oldId];
    this.persist(workspaceId, candidate);
    return this.scopedRead(candidate, current);
  }

  private validateRedirects(overrides: KnowledgeCatalog["componentOverrides"]) {
    const byId = new Map(overrides.map(value => [value.id, value]));
    for (const item of overrides) {
      const visited = new Set<string>([item.id]);
      let next = item.redirectTo;
      while (next) {
        if (visited.has(next)) this.fail("Component redirects cannot contain cycles.");
        visited.add(next);
        next = byId.get(next)?.redirectTo ?? null;
      }
    }
  }

  private validateArchiveReferences(catalog: KnowledgeCatalog) {
    const active = new Set(catalog.projects.filter(item => !item.archived).map(item => item.id));
    const projects = new Map(catalog.projects.map(item => [item.id, item]));
    for (const feature of catalog.features) {
      const projectId = feature.projectId;
      if (!feature.archived && projectId && (!active.has(projectId)
        || feature.repositoryIds.some(repositoryId => !projects.get(projectId)!.repositoryIds.includes(repositoryId))))
        this.fail("Active features must stay within their active project scope.");
    }
  }
}
