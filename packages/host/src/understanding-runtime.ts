import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { DiagramGraph, KnowledgeCatalog, KnowledgeComponent, KnowledgeDelivery, KnowledgeMaintenance, KnowledgePlan, KnowledgeRelationship, KnowledgeRepositoryBrief, KnowledgeSource, UnderstandingBrief, WorkspaceKnowledge } from "@infinite/remote";
import type { Config } from "./types.js";
import type { ProjectGroup, ProjectGroupList, ProjectGroupRepo } from "./project-group-types.js";
import { captureIdentity, readGit } from "./checkout-identity.js";
import { failureReason } from "./failure-reason.js";
import { componentGraph, diagramFromMermaid, diagramGraphSchema, linkDiagramNodes } from "./understanding-diagrams.js";
import { seal, unseal, writeSealed } from "./vault.js";
import { CatalogError, understandingCatalogLimits } from "./understanding-catalog.js";

const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_FILES = 30000;
const MAX_COMPONENTS = 5000;
const MAX_COMPONENT_FILES = 128;
const MAX_COMPONENT_FILE_BYTES = 256 * 1024;
const MAX_EDGES = 20000;
const MAX_QUEUE = 32;
const MAX_HISTORY = 12;
const MAX_HOOK_COMPONENTS = 2;
const MAX_EVIDENCE = 40;
const MAX_EVIDENCE_TEXT = 2000;
const MAX_PLANS_PER_COMPONENT = 100;
const MAX_ATTEMPT_MS = 10 * 60_000;
const STATE_SCOPE = "understanding-runtime";
export const understandingOutputLimits = { differenceSummary: 5000, pullRequestTitle: 2000, environment: 200, url: 2048 } as const;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stableId = (prefix: string, key: string, path: string) => `${prefix}_${createHash("sha256").update(`${key}\0${path}`).digest("hex").slice(0, 24)}`;
const relativePath = z.string().min(1).max(1024).refine(value => !isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && !value.split("/").includes(".."));

export interface RepoContext {
  version: 1; repo: string; generatedAt: string; head: string | null; base: string | null;
  files: Record<string, { hash: string; lines: number }>;
  components: { id: string; path: string; name: string; files: number; examples: string[]; entryPoints: string[]; incoming: number; outgoing: number; changed: number }[];
  edges: { from: string; to: string; count: number; examples: string[] }[];
  changed?: string[]; patches?: { source: string; path: string; text: string; truncated?: boolean }[]; documents?: { path: string; text: string }[];
  limitations: string[];
}
export interface UnderstandingAdapterOptions { signal: AbortSignal; timeoutMs: number; maxBytes: number }
export interface UnderstandingSynthesisInput {
  workspaceId: string; root: string; repositoryId: string; context: RepoContext;
  components: KnowledgeComponent[]; plans: KnowledgePlan[];
}
export interface RepositoryBriefOutput {
  head: string | null; base: string | null; generatedAt: string; brief: UnderstandingBrief;
  diagrams: { title: string; kind: "system" | "change"; mermaid: string }[];
  evidence: { source: string; line: number; text: string }[]; coverage: string[];
}
export interface UnderstandingAdapter {
  context?(root: string, options: UnderstandingAdapterOptions): Promise<RepoContext>;
  synthesize?(input: UnderstandingSynthesisInput, options: UnderstandingAdapterOptions): Promise<{ components: KnowledgeComponent[]; coverage: string[] }>;
  brief?(input: { workspaceId: string; root: string; repositoryId: string; context: RepoContext; base: string | null; components: Pick<KnowledgeComponent, "id" | "name">[] }, options: UnderstandingAdapterOptions): Promise<RepositoryBriefOutput>;
  delivery?(input: { workspaceId: string; root: string; repositoryId: string; head: string | null }, options: UnderstandingAdapterOptions): Promise<KnowledgeDelivery>;
}
export function createContextAdapter(config: Config): UnderstandingAdapter {
  return config.repositoryBriefings ? { context: (root, options) => runRepositoryContext(config, root, options) } : {};
}
export interface UnderstandingRuntimeOptions {
  config: Config; key: Buffer;
  groups: { list(): ProjectGroupList; get(id: string): ProjectGroup };
  catalog: { read(id: string): KnowledgeCatalog };
  adapter?: UnderstandingAdapter;
}
export type KnowledgeMaintenanceResult = KnowledgeMaintenance;
export type ReadKnowledge = Omit<WorkspaceKnowledge, "schemaVersion" | "catalog">;

const fileSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{40,64}$/), lines: z.number().int().nonnegative().max(2_000_000) }).strict();
const repoContextSchema = z.object({
  version: z.literal(1), repo: z.string().min(1).max(4096), generatedAt: z.string().datetime({ offset: true }),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), base: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  files: z.record(relativePath, fileSchema).refine(value => Object.keys(value).length <= MAX_FILES),
  components: z.array(z.object({ id: z.string().min(1).max(100), path: relativePath, name: z.string().min(1).max(200), files: z.number().int().nonnegative().max(MAX_FILES), examples: z.array(relativePath).max(64), entryPoints: z.array(relativePath).max(64), incoming: z.number().int().nonnegative().max(MAX_EDGES), outgoing: z.number().int().nonnegative().max(MAX_EDGES), changed: z.number().int().nonnegative().max(MAX_FILES) }).strict()).max(MAX_COMPONENTS),
  edges: z.array(z.object({ from: z.string().min(1).max(100), to: z.string().min(1).max(100), count: z.number().int().positive().max(MAX_EDGES), examples: z.array(z.string().min(1).max(2200)).max(32) }).strict()).max(MAX_EDGES),
  changed: z.array(relativePath).max(MAX_FILES).optional(),
  patches: z.array(z.object({ source: z.string().regex(/^patch:\d+$/).max(40), path: relativePath, text: z.string().max(24000), truncated: z.boolean().optional() }).strict()).max(100).optional(),
  documents: z.array(z.object({ path: relativePath, text: z.string().max(12000) }).strict()).max(100).optional(),
  limitations: z.array(z.string().max(1000)).max(100),
});

type StoredRepository = {
  repositoryKey: string; repositoryIds: string[]; rootIdentity: string; observedAt: string; fingerprint: string; head: string | null;
  context: RepoContext; components: KnowledgeComponent[]; relationships: KnowledgeRelationship[]; delivery: KnowledgeDelivery;
  synthesisCoverage: string[]; completedPlanRevisions: Record<string, string>; history: Record<string, { snapshotId: string; at: string; summary: string }[]>;
  completedSourceFingerprints: Record<string, string>;
  brief: StoredBrief | null; briefFingerprint: string | null; briefFailure: string | null; componentDiagram: DiagramGraph | null;
};
type StoredBrief = Omit<KnowledgeRepositoryBrief, "state" | "repositoryId">;
type RuntimeState = {
  version: 1; day: string; workspaces: Record<string, { jobsToday: number; failureCount: number; synthesisCursor: string | null; repositories: Record<string, StoredRepository>; maintenance: KnowledgeMaintenance; updatedAt: string | null }>;
};
type SourceBinding = { group: ProjectGroup; repo: ProjectGroupRepo; root: string; rootIdentity: string; membership: string; projects: string[] };

function emptyDelivery(repositoryId: string): KnowledgeDelivery {
  return { repositoryId, state: "unavailable", observedAt: null, pullRequests: [], environments: [], coverage: ["Provider delivery data is not configured."] };
}
function emptyMaintenance(policy: KnowledgeCatalog["policy"]): KnowledgeMaintenance {
  return { state: policy.enabled ? "idle" : "disabled", lastObservedAt: null, lastPublishedAt: null, nextAttemptAt: null, jobsToday: 0, dailyJobLimit: policy.dailyJobLimit, message: policy.enabled ? null : "Background maintenance is disabled by workspace policy." };
}
function under(component: string, file: string) { return file === component || file.startsWith(`${component}/`); }
const record = z.record(z.string(), z.unknown());
const historySchema = z.array(z.object({ revision: z.number().int().positive(), at: z.string().datetime({ offset: true }), summary: z.string().max(1000) }).strict()).max(100);
const planSchema = z.object({ id: z.string().max(160), revision: z.number().int().positive(), componentId: z.string().max(160), repositoryIds: z.array(z.string()).max(64), title: z.string().max(300), text: z.string().max(understandingCatalogLimits.planText), status: z.enum(["proposed", "accepted", "superseded"]), sourceUrl: z.string().max(2048).nullable(), workId: z.string().max(understandingCatalogLimits.planWorkId).nullable(), archived: z.boolean(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }), history: historySchema }).strict();
const knowledgeEvidenceSchema = z.object({ repositoryId: z.string().max(80), source: relativePath, line: z.number().int().positive().nullable(), text: z.string().max(12000).optional() }).strict();
const claimEvidenceSchema = knowledgeEvidenceSchema.extend({ line: z.number().int().positive() });
// Review claims combine an area, rationale, and question from the bounded brief.
const knowledgeClaimSchema = z.object({ text: z.string().min(1).max(2000), basis: z.enum(["source", "agent", "owner", "provider"]), evidence: z.array(claimEvidenceSchema).max(6) }).strict();
const citationSchema = z.object({ source: relativePath, line: z.number().int().positive() }).strict();
const briefClaimSchema = z.object({ text: z.string().min(1).max(900), citations: z.array(citationSchema).max(6) }).strict();
const briefSchema = z.object({ summary: z.string().min(1).max(600), architecture: z.array(briefClaimSchema).max(6), changes: z.array(briefClaimSchema).max(6), checks: z.array(briefClaimSchema).max(4),
  review: z.array(z.object({ priority: z.enum(["high", "medium"]), area: z.string().max(150), why: z.string().max(900), question: z.string().max(900), citations: z.array(citationSchema).max(6) }).strict()).max(5),
  guidance: z.array(z.object({ text: z.string().max(900), basis: z.enum(["documented", "proposed"]), citations: z.array(citationSchema).max(6) }).strict()).max(4), unknowns: z.array(z.string().max(900)).max(8) }).strict();
const storedBriefSchema = z.object({
  head: z.string().nullable(), base: z.string().nullable(), generatedAt: z.string().datetime({ offset: true }), observedAt: z.string().datetime({ offset: true }),
  brief: briefSchema, diagrams: z.array(diagramGraphSchema).max(2),
  evidence: z.array(z.object({ source: z.string().max(1024), line: z.number().int().positive(), text: z.string().max(MAX_EVIDENCE_TEXT) }).strict()).max(MAX_EVIDENCE),
  coverage: z.array(z.string().max(1000)).max(100),
}).strict();
const differenceSchema = z.object({ state: z.enum(["unverified", "review-needed", "aligned"]), summary: z.string().max(understandingOutputLimits.differenceSummary), claims: z.array(knowledgeClaimSchema).max(100), planRevisions: z.array(z.object({ id: z.string(), revision: z.number().int().positive() }).strict()).max(1000), snapshotId: z.string().nullable(), generatedAt: z.string().datetime({ offset: true }).nullable() }).strict();
const deliverySchema = z.object({ repositoryId: z.string().max(80), state: z.enum(["ready", "unavailable", "failed", "stale"]), observedAt: z.string().datetime({ offset: true }).nullable(),
  pullRequests: z.array(z.object({ repositoryId: z.string(), number: z.number().int().positive(), title: z.string().max(understandingOutputLimits.pullRequestTitle), url: z.string().max(understandingOutputLimits.url), state: z.enum(["open", "closed", "merged"]), head: z.string().max(128), mergeCommit: z.string().nullable(), observedAt: z.string().datetime({ offset: true }), checks: z.array(z.object({ name: z.string().max(200), status: z.string().max(100), conclusion: z.string().max(100).nullable(), url: z.string().max(understandingOutputLimits.url).nullable() }).strict()).max(100) }).strict()).max(100),
  environments: z.array(z.object({ repositoryId: z.string(), environment: z.string().max(understandingOutputLimits.environment), revision: z.string().max(128), status: z.string().max(100), url: z.string().max(understandingOutputLimits.url).nullable(), observedAt: z.string().datetime({ offset: true }), basis: z.literal("provider") }).strict()).max(100), coverage: z.array(z.string().max(1000)).max(100) }).strict();
const relationshipSchema = z.object({ id: z.string().max(160), from: z.string().max(160), to: z.string().max(160), kind: z.enum(["imports", "calls", "publishes", "consumes", "stores", "implements"]), basis: z.enum(["source", "agent", "owner"]), summary: z.string().max(2200), evidence: z.array(knowledgeEvidenceSchema).max(100) }).strict();
const knowledgeComponentStateSchema = z.object({
  id: z.string().min(1).max(160), name: z.string().max(200), description: z.string().max(understandingCatalogLimits.componentDescription), repositoryIds: z.array(z.string()).max(64),
  paths: z.array(z.object({ repositoryId: z.string(), path: relativePath }).strict()).max(64),
  files: z.array(z.object({ repositoryId: z.string(), path: relativePath, hash: z.string().regex(/^[a-f0-9]{40,64}$/), lines: z.number().int().nonnegative() }).strict()).max(MAX_FILES),
  pinned: z.boolean(), retired: z.boolean(), redirectTo: z.string().max(160).nullable(),
  current: z.object({ state: z.enum(["mapped", "ready", "stale", "unavailable"]), snapshotId: z.string().max(128), sources: z.array(z.object({ repositoryId: z.string(), head: z.string().nullable(), fingerprint: z.string(), observedAt: z.string().datetime({ offset: true }), kind: z.literal("checkout") }).strict()).max(64), summary: z.string().max(4000), claims: z.array(knowledgeClaimSchema).max(1000), brief: briefSchema.nullable(), generatedAt: z.string().datetime({ offset: true }).nullable() }).strict(),
  planned: z.array(planSchema).max(1000), difference: differenceSchema, featureIds: z.array(z.string()).max(100), history: z.array(z.object({ snapshotId: z.string(), at: z.string().datetime({ offset: true }), summary: z.string() }).strict()).max(MAX_HISTORY), coverage: z.array(z.string().max(1200)).max(100),
}).strict();
const storedRepositorySchema = z.object({
  repositoryKey: z.string().min(1).max(500), repositoryIds: z.array(z.string()).max(64), rootIdentity: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.string().datetime({ offset: true }), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), head: z.string().nullable(),
  context: repoContextSchema, components: z.array(knowledgeComponentStateSchema).max(MAX_COMPONENTS), relationships: z.array(relationshipSchema).max(MAX_EDGES), delivery: deliverySchema,
  synthesisCoverage: z.array(z.string().max(1000)).max(100), completedPlanRevisions: record, completedSourceFingerprints: record, history: z.record(z.string(), z.array(z.object({ snapshotId: z.string(), at: z.string().datetime({ offset: true }), summary: z.string().max(4000) }).strict()).max(MAX_HISTORY)),
  brief: storedBriefSchema.nullable().default(null), briefFingerprint: z.string().nullable().default(null), briefFailure: z.string().max(400).nullable().default(null), componentDiagram: diagramGraphSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  for (const [key, revision] of Object.entries(value.completedPlanRevisions)) if (typeof revision !== "string") context.addIssue({ code: "custom", path: ["completedPlanRevisions", key], message: "invalid plan watermark" });
  for (const [key, fingerprint] of Object.entries(value.completedSourceFingerprints)) if (typeof fingerprint !== "string") context.addIssue({ code: "custom", path: ["completedSourceFingerprints", key], message: "invalid source watermark" });
});
const runtimeStateSchema = z.object({ version: z.literal(1), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), workspaces: z.record(z.string(), z.object({
  jobsToday: z.number().int().nonnegative().max(1_000_000), failureCount: z.number().int().nonnegative().max(20), synthesisCursor: z.string().max(400).nullable(), repositories: z.record(z.string(), storedRepositorySchema), maintenance: z.object({ state: z.enum(["disabled", "idle", "queued", "running", "failed", "budget-limited", "unavailable"]), lastObservedAt: z.string().nullable(), lastPublishedAt: z.string().nullable(), nextAttemptAt: z.string().nullable(), jobsToday: z.number().int().nonnegative(), dailyJobLimit: z.number().int().nonnegative(), message: z.string().nullable(), lastFailure: z.object({ at: z.string(), reason: z.string().max(400) }).strict().nullable().optional() }).strict(), updatedAt: z.string().datetime({ offset: true }).nullable(),
}).strict()) }).strict();
function parseRepoContext(value: unknown): RepoContext {
  const parsed = repoContextSchema.parse(value);
  const rawKeys = value && typeof value === "object" ? Object.keys(value) : [];
  const allowed = new Set(["version", "repo", "generatedAt", "head", "base", "files", "components", "edges", "changed", "patches", "documents", "limitations"]);
  const projected = rawKeys.some(key => !allowed.has(key));
  const limitations = [...parsed.limitations];
  if (projected) limitations.push("Some context fields were intentionally omitted by the host projection.");
  if (parsed.edges.length) limitations.push("Static import examples provide file-level paths only; relationship evidence uses a null line to show that no exact source line was reported.");
  return { ...parsed, limitations: limitations.slice(0, 100) };
}

/** Bounded, encrypted deterministic map and opt-in maintenance queue. Reads never enqueue work. */
export class UnderstandingRuntime {
  private readonly stateFile: string;
  private readonly adapter: UnderstandingAdapter;
  private readonly hasConfiguredContext: boolean;
  private state: RuntimeState = { version: 1, day: new Date().toISOString().slice(0, 10), workspaces: {} };
  private queue: string[] = [];
  private queued = new Set<string>();
  private running = false;
  private closed = false;
  private activeDeadline = 0;
  private timer?: NodeJS.Timeout;
  private controllers = new Set<AbortController>();
  private children = new Set<ChildProcess>();
  private storageUnavailable = false;
  private loadFailed = false;

  constructor(private readonly options: UnderstandingRuntimeOptions) {
    this.stateFile = resolve(options.config.stateDir, "understanding", "runtime.sealed");
    this.hasConfiguredContext = Boolean(options.adapter?.context || options.config.repositoryBriefings);
    this.adapter = options.adapter ?? (options.config.repositoryBriefings ? { context: (root, runOptions) => this.runContext(root, runOptions) } : {});
    this.load();
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.reconcile(), 60_000);
    this.timer.unref();
    this.reconcile();
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers) controller.abort();
    for (const child of this.children) this.stopChild(child);
    this.queue = []; this.queued.clear();
    return new Promise(resolvePromise => {
      if (!this.running) return resolvePromise();
      const timer = setInterval(() => { if (!this.running) { clearInterval(timer); resolvePromise(); } }, 10);
      timer.unref();
      setTimeout(() => { clearInterval(timer); resolvePromise(); }, 1500).unref();
    });
  }

  refresh(workspaceId: string): KnowledgeMaintenanceResult {
    this.group(workspaceId);
    const maintenance = this.workspace(workspaceId).maintenance;
    if (this.closed) return { ...maintenance, state: "unavailable", message: "Understanding maintenance is shutting down." };
    if (maintenance.state === "running" || this.queued.has(workspaceId)) return { ...maintenance, state: "queued", message: "A refresh is already queued for this workspace." };
    const policy = this.options.catalog.read(workspaceId).policy;
    if (this.storageUnavailable) return { ...maintenance, state: "unavailable", message: "Encrypted maintenance state is unavailable; new work is refused until its durable watermark can be loaded." };
    if (!this.hasConfiguredContext) return { ...maintenance, state: "unavailable", message: "Repository context collection is not configured." };
    if (this.queue.length >= MAX_QUEUE) return { ...maintenance, state: "unavailable", message: "The bounded maintenance queue is full." };
    if (this.dailyJobs(workspaceId) >= policy.dailyJobLimit) return this.setMaintenance(workspaceId, { ...maintenance, state: "budget-limited", jobsToday: this.dailyJobs(workspaceId), dailyJobLimit: policy.dailyJobLimit, message: "The daily maintenance job limit has been reached." });
    this.queue.push(workspaceId); this.queued.add(workspaceId);
    const next = this.setMaintenance(workspaceId, { ...maintenance, state: "queued", jobsToday: this.dailyJobs(workspaceId), dailyJobLimit: policy.dailyJobLimit, message: null });
    void this.drain();
    return next;
  }

  read(workspaceId: string): ReadKnowledge {
    const group = this.group(workspaceId);
    try {
      const catalog = this.options.catalog.read(workspaceId);
      const saved = this.state.workspaces[workspaceId];
      const entries = group.repos.map((repo): { projectId: string; stored: StoredRepository; currentHead: string | undefined } | undefined => {
        const stored = saved?.repositories[repo.projectId];
        if (!stored) return undefined;
        const binding = this.binding(repo, group);
        if (binding.rootIdentity !== stored.rootIdentity) return undefined;
        const currentHead = readGit(binding.root, ["rev-parse", "HEAD"]);
        if (currentHead && currentHead === stored.head) return { projectId: repo.projectId, stored, currentHead };
        return { projectId: repo.projectId, currentHead, stored: { ...stored, components: stored.components.map(component => ({ ...component, current: { ...component.current, state: "stale" as const, summary: "Repository HEAD changed since this source map was observed." }, coverage: [...component.coverage, "Repository HEAD differs from the latest observed source map."] })) } };
      }).filter(value => value !== undefined);
      const repos = entries.map(entry => entry.stored);
      const components = repos.flatMap(repo => repo.components.map(component => this.enrich(component, repo, catalog)));
      const relationships = repos.flatMap(repo => repo.relationships);
      const delivery = repos.map(repo => repo.delivery);
      const coverage = [...new Set([...catalog.coverage, ...repos.flatMap(repo => repo.context.limitations), ...repos.flatMap(repo => repo.synthesisCoverage), ...(saved?.maintenance.state === "failed" && saved.maintenance.message ? [saved.maintenance.message] : []), ...(this.storageUnavailable ? ["Encrypted runtime state could not be loaded or saved; current deterministic data may be unavailable."] : [])])].slice(0, 200);
      let maintenance = saved?.maintenance ?? emptyMaintenance(catalog.policy);
      maintenance = { ...maintenance, dailyJobLimit: catalog.policy.dailyJobLimit, jobsToday: this.dailyJobs(workspaceId) };
      if (this.loadFailed) maintenance = { ...maintenance, state: "unavailable", message: "Encrypted maintenance state failed validation; the host will not overwrite it or start jobs until explicit recovery." };
      const briefs: KnowledgeRepositoryBrief[] = entries.flatMap(({ projectId, stored, currentHead }) => stored.brief ? [{ repositoryId: projectId, ...stored.brief, state: currentHead && currentHead === stored.brief.head ? "ready" as const : "stale" as const }] : []);
      const diagrams = [...repos.flatMap(repo => repo.componentDiagram ? [repo.componentDiagram] : []), ...briefs.flatMap(brief => brief.diagrams)];
      return { components, relationships, delivery, maintenance, coverage, briefs, diagrams };
    } catch {
      return { components: [], relationships: [], delivery: [], maintenance: { ...emptyMaintenance({ enabled: false, synthesis: false, delivery: false, intervalMinutes: 60, dailyJobLimit: 0 }), state: "unavailable", message: "Workspace sources are unavailable or changed." }, coverage: ["Workspace source or catalog could not be read safely."] };
    }
  }

  private load() {
    try {
      if (!existsSync(this.stateFile)) return;
      const raw = readFileSync(this.stateFile, "utf8");
      if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new Error("store-too-large");
      const value = runtimeStateSchema.parse(unseal<unknown>(this.options.key, STATE_SCOPE, raw));
      this.state = value as RuntimeState;
      this.dailyJobs();
      let recovered = false;
      for (const [id, workspace] of Object.entries(this.state.workspaces)) {
        if (workspace.maintenance.state !== "running" && workspace.maintenance.state !== "queued") continue;
        workspace.failureCount = Math.min(20, workspace.failureCount + 1);
        const retryDelay = this.backoff(id, 60_000);
        workspace.maintenance = { ...workspace.maintenance, state: "failed", nextAttemptAt: new Date(Date.now() + retryDelay).toISOString(), jobsToday: workspace.jobsToday, message: "Maintenance was interrupted by a prior host shutdown; its durable admission remains counted and a bounded retry is scheduled." };
        recovered = true;
      }
      if (recovered) this.persist();
    } catch { this.storageUnavailable = true; this.loadFailed = true; }
  }

  private persist() {
    if (this.loadFailed) { this.storageUnavailable = true; return; }
    try {
      runtimeStateSchema.parse(this.state);
      const raw = JSON.stringify(this.state);
      if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new Error("store-too-large");
      if (Buffer.byteLength(seal(this.options.key, STATE_SCOPE, this.state)) > MAX_STORE_BYTES) throw new Error("sealed-store-too-large");
      writeSealed(this.stateFile, this.options.key, STATE_SCOPE, this.state);
      this.storageUnavailable = false;
    } catch { this.storageUnavailable = true; }
  }

  private dailyJobs(workspaceId?: string) {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.day !== today) {
      this.state.day = today;
      for (const workspace of Object.values(this.state.workspaces)) { workspace.jobsToday = 0; workspace.maintenance.jobsToday = 0; }
      this.persist();
    }
    return workspaceId ? this.state.workspaces[workspaceId]?.jobsToday ?? 0 : 0;
  }
  private group(workspaceId: string): ProjectGroup {
    try {
      const group = this.options.groups.get(workspaceId);
      if (group.id !== workspaceId) throw new Error("workspace-id-mismatch");
      return group;
    } catch { throw new CatalogError(404, "This repository workspace does not exist."); }
  }
  private workspace(id: string) {
    this.state.workspaces[id] ??= { jobsToday: 0, failureCount: 0, synthesisCursor: null, repositories: {}, maintenance: emptyMaintenance(this.options.catalog.read(id).policy), updatedAt: null };
    return this.state.workspaces[id];
  }
  private setMaintenance(id: string, maintenance: KnowledgeMaintenance) {
    this.workspace(id).maintenance = maintenance; this.persist(); return maintenance;
  }

  private reconcile() {
    if (this.closed) return;
    let list: ProjectGroupList;
    try { list = this.options.groups.list(); } catch { return; }
    for (const group of list.groups) {
      try {
        const state = this.workspace(group.id), policy = this.options.catalog.read(group.id).policy;
        if (!policy.enabled || this.queued.has(group.id) || state.maintenance.state === "running") continue;
        const last = Date.parse(state.maintenance.lastObservedAt ?? "");
        const delay = this.backoff(group.id, policy.intervalMinutes * 60_000);
        const retryAt = Date.parse(state.maintenance.nextAttemptAt ?? "");
        const isBackoff = state.maintenance.state === "failed";
        if ((!Number.isFinite(retryAt) || Date.now() >= retryAt) && (isBackoff || !Number.isFinite(last) || Date.now() - last >= delay)) this.refresh(group.id);
      } catch { /* A concurrently removed group is skipped until the next reconciliation. */ }
    }
  }
  private backoff(id: string, interval: number) { const attempts = this.state.workspaces[id]?.failureCount ?? 0; return Math.max(interval, Math.min(24 * 60 * 60_000, interval * (2 ** Math.min(Math.max(0, attempts - 1), 8)))); }

  private async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed && this.queue.length) {
        const id = this.queue.shift()!; this.queued.delete(id);
        const configured = this.options.config.repositoryBriefings?.timeoutMs ?? 30_000;
        this.activeDeadline = Date.now() + Math.min(MAX_ATTEMPT_MS, Math.max(1000, configured));
        try { await this.runWorkspace(id); }
        catch (error) { this.failWorkspace(id, error); }
        finally { this.activeDeadline = 0; }
      }
    } finally { this.running = false; }
  }

  private async runWorkspace(workspaceId: string) {
    const policy = this.options.catalog.read(workspaceId).policy;
    if (this.dailyJobs(workspaceId) >= policy.dailyJobLimit) {
      this.setMaintenance(workspaceId, { ...this.workspace(workspaceId).maintenance, state: "budget-limited", dailyJobLimit: policy.dailyJobLimit, jobsToday: this.dailyJobs(workspaceId), message: "The daily maintenance job limit has been reached." }); return;
    }
    const workspaceState = this.workspace(workspaceId);
    workspaceState.jobsToday += 1; // Persist admission before source capture or any writer hook.
    this.persist();
    if (this.storageUnavailable) throw new Error("runtime-budget-watermark-not-durable");
    const attempt = new Date().toISOString();
    this.setMaintenance(workspaceId, { ...workspaceState.maintenance, state: "running", lastObservedAt: attempt, dailyJobLimit: policy.dailyJobLimit, jobsToday: workspaceState.jobsToday, message: null });
    const catalogAtStart = this.options.catalog.read(workspaceId);
    const groupAtStart = this.group(workspaceId);
    const bindings = groupAtStart.repos.map(repo => this.binding(repo, groupAtStart));
    const repos: Record<string, StoredRepository> = structuredClone(workspaceState.repositories);
    const partial: string[] = [];
    const capturedRepositories = new Set<string>();
    for (const binding of bindings) {
      if (this.closed) throw new Error("closed");
      try {
        const observation = await this.capture(workspaceId, binding, catalogAtStart);
        repos[binding.repo.projectId] = observation;
        capturedRepositories.add(binding.repo.projectId);
      } catch (error) { partial.push(`Repository ${binding.repo.name}: ${failureReason(error)}`); }
    }
    if (!this.membershipStillCurrent(workspaceId, groupAtStart, bindings)) throw new Error("workspace-rebound");
    const hookedRepos = new Set<string>();
    const currentPolicy = this.options.catalog.read(workspaceId).policy;
    let nextSynthesisCursor = workspaceState.synthesisCursor;
    if (currentPolicy.synthesis && this.adapter.brief) {
      for (const binding of bindings) {
        const observation = repos[binding.repo.projectId];
        if (!observation || !capturedRepositories.has(binding.repo.projectId) || observation.briefFingerprint === observation.fingerprint) continue;
        const components = observation.components.filter(component => !component.retired);
        hookedRepos.add(binding.repo.projectId);
        try {
          if (!this.boundStillCurrent(workspaceId, groupAtStart, binding)) throw new Error("source-rebound-before-brief");
          const result = await this.invoke(binding.root, options => this.adapter.brief!({ workspaceId, root: binding.root, repositoryId: binding.repo.projectId, context: observation.context, base: observation.brief?.head ?? null, components: components.map(({ id, name }) => ({ id, name })) }, options));
          if (!this.boundStillCurrent(workspaceId, groupAtStart, binding)) throw new Error("source-rebound-after-brief");
          const observedAt = new Date().toISOString();
          const stored = storedBriefSchema.parse({
            head: result.head, base: result.base, generatedAt: result.generatedAt, observedAt, brief: result.brief,
            diagrams: result.diagrams.map((diagram, index) => linkDiagramNodes(diagramFromMermaid({ id: `${binding.repo.projectId}:${index}`, title: diagram.title, kind: diagram.kind, mermaid: diagram.mermaid, repositoryId: binding.repo.projectId, head: result.head, observedAt }), components)),
            evidence: result.evidence.slice(0, MAX_EVIDENCE).map(item => ({ ...item, text: item.text.slice(0, MAX_EVIDENCE_TEXT) })), coverage: result.coverage,
          });
          observation.brief = stored; observation.briefFingerprint = observation.fingerprint; observation.briefFailure = null;
        } catch (error) {
          if (this.closed) throw error;
          observation.briefFailure = failureReason(error);
          partial.push(`Repository ${binding.repo.name}: brief unavailable: ${observation.briefFailure}`);
        }
      }
    }
    if (currentPolicy.synthesis && this.adapter.synthesize) {
      const pending: { key: string; binding: SourceBinding; observation: StoredRepository; component: KnowledgeComponent; plans: KnowledgePlan[] }[] = [];
      for (const binding of bindings) {
        const observation = repos[binding.repo.projectId]; if (!observation || !capturedRepositories.has(binding.repo.projectId)) continue;
        const plans = catalogAtStart.plans.filter(plan => !plan.archived && plan.repositoryIds.some(id => observation.repositoryIds.includes(id)));
        for (const component of observation.components) if (!component.retired && (observation.completedSourceFingerprints[component.id] !== observation.fingerprint || observation.completedPlanRevisions[component.id] !== this.planKey(component.id, plans))) pending.push({ key: `${binding.repo.projectId}:${component.id}`, binding, observation, component, plans });
      }
      pending.sort((a, b) => a.key.localeCompare(b.key));
      const start = pending.findIndex(item => item.key > (workspaceState.synthesisCursor ?? ""));
      const ordered = start < 0 ? pending : [...pending.slice(start), ...pending.slice(0, start)];
      const selected = ordered.slice(0, MAX_HOOK_COMPONENTS);
      for (const entry of selected) {
        const { binding, observation } = entry;
        const sameRepository = selected.filter(item => item.binding.repo.projectId === binding.repo.projectId);
        if (sameRepository[0] !== entry) continue;
        const selectedComponents = sameRepository.map(item => item.component).filter(component => {
          const count = catalogAtStart.plans.filter(plan => !plan.archived && plan.componentId === component.id && plan.repositoryIds.some(id => observation.repositoryIds.includes(id))).length;
          if (count > MAX_PLANS_PER_COMPONENT) {
            partial.push(`Synthesis deferred for component ${component.id}: its complete plan revision set exceeds the bounded adapter input.`);
            observation.synthesisCoverage = [...new Set([...observation.synthesisCoverage, `Synthesis is deferred because more than ${MAX_PLANS_PER_COMPONENT} plans are attached.`])].slice(0, 100);
            return false;
          }
          return true;
        });
        if (!selectedComponents.length) continue;
        const output: { components: KnowledgeComponent[]; coverage: string[] } = { components: [], coverage: [] };
        for (const component of selectedComponents) {
          if (!this.boundStillCurrent(workspaceId, groupAtStart, binding)) throw new Error("source-rebound-before-synthesis");
          const result = await this.invoke(binding.root, options => this.adapter.synthesize!({ workspaceId, root: binding.root, repositoryId: binding.repo.projectId, context: observation.context, components: [component], plans: entry.plans.filter(plan => plan.componentId === component.id) }, options));
          if (!this.boundStillCurrent(workspaceId, groupAtStart, binding)) throw new Error("source-rebound-after-synthesis");
          z.array(z.string().max(1000)).max(100).parse(result.coverage);
          if (result.components.length !== 1 || result.components[0].id !== component.id) throw new Error("incomplete-synthesis");
          output.components.push(...result.components);
          output.coverage = [...new Set([...output.coverage, ...result.coverage])].slice(0, 100);
        }
        if (Buffer.byteLength(JSON.stringify(output)) > MAX_OUTPUT_BYTES) throw new Error("synthesis-output-too-large");
        hookedRepos.add(binding.repo.projectId);
        const returned = new Map(output.components.map(component => [component.id, component]));
        for (const component of selectedComponents) {
          const synthesized = returned.get(component.id)!;
          const expectedPlanRevisions = component.planned.map(plan => ({ id: plan.id, revision: plan.revision })).sort((a, b) => a.id.localeCompare(b.id));
          const returnedPlanRevisions = synthesized.difference.planRevisions.map(plan => ({ id: plan.id, revision: plan.revision })).sort((a, b) => a.id.localeCompare(b.id));
          const generatedAt = synthesized.current.generatedAt ? Date.parse(synthesized.current.generatedAt) : Number.NaN;
          const priorGeneratedAt = component.current.generatedAt ? Date.parse(component.current.generatedAt) : 0;
          const complete = synthesized.current.state === "ready" && synthesized.current.snapshotId === observation.fingerprint &&
            synthesized.current.sources.some(source => source.repositoryId === binding.repo.projectId && source.fingerprint === observation.fingerprint) &&
            Number.isFinite(generatedAt) && generatedAt > priorGeneratedAt && synthesized.difference.snapshotId === observation.fingerprint &&
            synthesized.difference.generatedAt === synthesized.current.generatedAt && digest(expectedPlanRevisions) === digest(returnedPlanRevisions);
          if (!complete) {
            partial.push(`Synthesis remains pending for component ${component.id}; the adapter did not return a complete current source and plan revision set.`);
            observation.synthesisCoverage = [...new Set([...observation.synthesisCoverage, `Synthesis remains pending for ${component.id}; its source and plan watermarks were not advanced.`])].slice(0, 100);
            continue;
          }
          const index = observation.components.findIndex(item => item.id === component.id);
          observation.components[index] = this.validateSynthesis(component, synthesized, observation);
          observation.completedPlanRevisions[component.id] = this.planKey(component.id, entry.plans);
          observation.completedSourceFingerprints[component.id] = observation.fingerprint;
        }
        observation.synthesisCoverage = [...new Set([...observation.synthesisCoverage, ...output.coverage])].slice(0, 100);
      }
      if (pending.length > selected.length) {
        for (const entry of pending) entry.observation.synthesisCoverage = [...new Set([...entry.observation.synthesisCoverage, `Synthesis is pending for additional components; this workspace refresh admits at most ${MAX_HOOK_COMPONENTS} component briefs.`])].slice(0, 100);
      }
      if (selected.length) nextSynthesisCursor = selected.at(-1)!.key;
    }
    if (currentPolicy.delivery && this.adapter.delivery) {
      for (const binding of bindings) {
        const observation = repos[binding.repo.projectId]; if (!observation || !this.boundStillCurrent(workspaceId, groupAtStart, binding)) continue;
        const value = await this.invoke(binding.root, options => this.adapter.delivery!({ workspaceId, root: binding.root, repositoryId: binding.repo.projectId, head: observation.head }, options));
        hookedRepos.add(binding.repo.projectId);
        if (!this.boundStillCurrent(workspaceId, groupAtStart, binding)) throw new Error("source-rebound-after-delivery");
        if (value.repositoryId !== binding.repo.projectId) throw new Error("delivery-repository-mismatch");
        observation.delivery = deliverySchema.parse(value);
      }
    }
    if (hookedRepos.size) {
      if (!this.adapter.context) throw new Error("source-revalidation-unavailable");
      for (const binding of bindings.filter(item => hookedRepos.has(item.repo.projectId))) {
        const observation = repos[binding.repo.projectId]; if (!observation) continue;
        const fresh = parseRepoContext(await this.invoke(binding.root, options => this.adapter.context!(binding.root, options), MAX_CONTEXT_BYTES));
        const freshFingerprint = digest({ head: fresh.head, files: Object.entries(fresh.files).sort(([a], [b]) => a.localeCompare(b)) });
        if (realpathSync(fresh.repo) !== binding.root || freshFingerprint !== observation.fingerprint || fresh.head !== observation.head || !this.boundStillCurrent(workspaceId, groupAtStart, binding)) throw new Error("source-generation-changed-during-hook");
      }
    }
    // No await may separate this catalog check from publication: a later
    // repository observation can yield to edits of an earlier repository's plans.
    if (currentPolicy.synthesis && this.adapter.synthesize) {
      const currentCatalog = this.options.catalog.read(workspaceId);
      for (const binding of bindings.filter(item => hookedRepos.has(item.repo.projectId))) {
        const observation = repos[binding.repo.projectId]; if (!observation) continue;
        const oldPlans = catalogAtStart.plans.filter(plan => !plan.archived && plan.repositoryIds.some(id => observation.repositoryIds.includes(id)));
        const latestPlans = currentCatalog.plans.filter(plan => !plan.archived && plan.repositoryIds.some(id => observation.repositoryIds.includes(id)));
        for (const component of observation.components) if (observation.completedSourceFingerprints[component.id] === observation.fingerprint &&
          this.planKey(component.id, oldPlans) !== this.planKey(component.id, latestPlans)) throw new Error("plan-revisions-changed-during-synthesis");
      }
    }
    if (!this.membershipStillCurrent(workspaceId, groupAtStart, bindings)) throw new Error("workspace-rebound-at-publish");
    const failedAttempts = partial.length ? Math.min(20, workspaceState.failureCount + 1) : 0;
    const retryDelay = this.backoff(workspaceId, 60_000);
    const publishedAt = new Date().toISOString(), failure = failureReason(partial.join("; "));
    const next: RuntimeState = { ...this.state, workspaces: { ...this.state.workspaces, [workspaceId]: { ...workspaceState, failureCount: failedAttempts, synthesisCursor: nextSynthesisCursor, repositories: repos, maintenance: { ...workspaceState.maintenance, state: partial.length ? "failed" : "idle", lastPublishedAt: publishedAt, nextAttemptAt: partial.length ? new Date(Date.now() + retryDelay).toISOString() : null, jobsToday: workspaceState.jobsToday, dailyJobLimit: currentPolicy.dailyJobLimit, message: partial.length ? `Last attempt failed at ${publishedAt}: ${failure}.` : null, lastFailure: partial.length ? { at: publishedAt, reason: failure } : null }, updatedAt: new Date().toISOString() } } };
    const before = this.state; this.state = next; this.persist();
    if (this.storageUnavailable) { this.state = before; throw new Error("runtime-store-full"); }
  }

  private async capture(workspaceId: string, binding: SourceBinding, catalog: KnowledgeCatalog): Promise<StoredRepository> {
    const context = await this.invoke(binding.root, options => {
      if (this.adapter.context) return this.adapter.context(binding.root, options);
      throw new Error("context-unavailable");
    }, MAX_CONTEXT_BYTES);
    const parsed = parseRepoContext(context);
    if (realpathSync(parsed.repo) !== binding.root || !this.boundStillCurrent(workspaceId, this.group(workspaceId), binding)) throw new Error("source-rebound");
    const fingerprint = digest({ head: parsed.head, files: Object.entries(parsed.files).sort(([a], [b]) => a.localeCompare(b)) });
    const key = binding.repo.key ?? binding.rootIdentity;
    const source: KnowledgeSource = { repositoryId: binding.repo.projectId, head: parsed.head, fingerprint, observedAt: new Date().toISOString(), kind: "checkout" };
    const components = this.mapComponents(binding, parsed, source, key, catalog);
    const relationships = this.mapRelationships(binding, parsed, components, key);
    const existing = this.workspace(workspaceId).repositories[binding.repo.projectId];
    const old = existing ? structuredClone(existing) : undefined;
    if (old?.fingerprint === fingerprint) {
      const currentById = new Map(old.components.map(component => [component.id, component]));
      for (let index = 0; index < components.length; index++) {
        const prior = currentById.get(components[index].id);
        if (prior && !prior.retired) components[index] = { ...components[index], current: prior.current, difference: prior.difference, history: old.history[prior.id] ?? prior.history };
      }
    }
    const delivery = old?.delivery ?? emptyDelivery(binding.repo.projectId);
    const history: StoredRepository["history"] = { ...(old?.history ?? {}) };
    if (old && old.fingerprint !== fingerprint) for (const component of old.components) history[component.id] = [...(history[component.id] ?? []), { snapshotId: old.fingerprint, at: old.observedAt, summary: component.current.summary }].slice(-MAX_HISTORY);
    return { repositoryKey: key, repositoryIds: binding.projects, rootIdentity: binding.rootIdentity, observedAt: source.observedAt, fingerprint, head: parsed.head, context: parsed, components, relationships, delivery, synthesisCoverage: old?.synthesisCoverage ?? [], completedPlanRevisions: old?.completedPlanRevisions ?? {}, completedSourceFingerprints: old?.completedSourceFingerprints ?? {}, history,
      brief: old?.brief ?? null, briefFingerprint: old?.briefFingerprint ?? null, briefFailure: old?.briefFailure ?? null,
      componentDiagram: componentGraph({ repositoryId: binding.repo.projectId, head: parsed.head, observedAt: source.observedAt, components, relationships }) };
  }

  private mapComponents(binding: SourceBinding, context: RepoContext, source: KnowledgeSource, key: string, catalog: KnowledgeCatalog) {
    const mapped: KnowledgeComponent[] = context.components.map(input => {
      const id = stableId("cmp", key, input.path);
      const files: KnowledgeComponent["files"] = [];
      let fileBytes = 0;
      for (const [path, value] of Object.entries(context.files)) {
        if (!under(input.path, path) && !input.examples.includes(path)) continue;
        const item = { repositoryId: binding.repo.projectId, path, hash: value.hash, lines: value.lines };
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (files.length >= MAX_COMPONENT_FILES || fileBytes + bytes > MAX_COMPONENT_FILE_BYTES) break;
        files.push(item); fileBytes += bytes;
      }
      const overrides = catalog.componentOverrides.find(item => item.id === id);
      const allPlans = catalog.plans.filter(plan => !plan.archived && plan.componentId === id);
      const plans = allPlans.slice(0, MAX_PLANS_PER_COMPONENT);
      const snapshotId = source.fingerprint;
      return {
        id, name: overrides?.name ?? input.name.slice(0, 200), description: overrides?.description ?? "Deterministic repository-layout component map; description has not been owner-verified.", repositoryIds: binding.projects,
        paths: [{ repositoryId: binding.repo.projectId, path: input.path }], files,
        pinned: Boolean(overrides?.pinned), retired: false, redirectTo: overrides?.redirectTo ?? null,
        current: { state: "mapped" as const, snapshotId, sources: [source], summary: "Deterministic source map; no model synthesis has been verified.", claims: [], brief: null, generatedAt: null },
        planned: plans, difference: { state: "unverified" as const, summary: "No plan alignment has been verified.", claims: [], planRevisions: [], snapshotId: null, generatedAt: null },
        featureIds: catalog.features.filter(feature => !feature.archived && feature.componentIds.includes(id)).map(feature => feature.id).slice(0, 100),
        history: [], coverage: [`Static component path from repository context: ${input.path}.`, "Component boundary is inferred from repository layout and is not owner-approved.", ...(input.files > files.length ? [`Component file details are bounded to ${MAX_COMPONENT_FILES} files or ${MAX_COMPONENT_FILE_BYTES} bytes.`] : []), ...(allPlans.length > MAX_PLANS_PER_COMPONENT ? [`Component plan details are bounded to ${MAX_PLANS_PER_COMPONENT} plans; synthesis is deferred until the full revision set can be handled.`] : [])],
      } satisfies KnowledgeComponent;
    });
    return [...mapped, ...this.retiredComponents(binding, context, catalog, key)];
  }

  private retiredComponents(binding: SourceBinding, context: RepoContext, catalog: KnowledgeCatalog, key: string): KnowledgeComponent[] {
    const present = new Set(context.components.map(item => stableId("cmp", key, item.path)));
    const previous = this.workspace(binding.group.id).repositories[binding.repo.projectId]?.components ?? [];
    return previous.filter(item => !present.has(item.id)).map(item => ({ ...item, retired: true, repositoryIds: binding.projects, paths: item.paths.map(path => ({ ...path, repositoryId: binding.repo.projectId })), files: [], planned: catalog.plans.filter(plan => !plan.archived && plan.componentId === item.id), current: { ...item.current, state: "stale", summary: "Component path disappeared from the latest deterministic map; retained as retired history." }, coverage: [...new Set(["Component no longer appears in the latest source map.", ...item.coverage])].slice(0, 100) }));
  }

  private mapRelationships(binding: SourceBinding, context: RepoContext, components: KnowledgeComponent[], key: string): KnowledgeRelationship[] {
    const componentForFile = (path: string) => components.find(component => !component.retired && component.paths.some(item => under(item.path, path)));
    const original = new Map(context.components.map(component => [component.id, component]));
    const owns = (component: NonNullable<ReturnType<typeof original.get>>, path: string) => component.examples.includes(path) || under(component.path, path);
    const result: KnowledgeRelationship[] = [];
    for (const edge of context.edges) {
      const sourceComponent = original.get(edge.from), targetComponent = original.get(edge.to);
      if (!sourceComponent || !targetComponent) continue;
      for (const example of edge.examples) {
        const match = /^([^\s]+) → ([^\s]+)$/.exec(example);
        if (!match || !context.files[match[1]] || !context.files[match[2]] || !owns(sourceComponent, match[1]) || !owns(targetComponent, match[2])) continue;
        const from = componentForFile(match[1]), to = componentForFile(match[2]);
        if (!from || !to || from.id === to.id) continue;
        const id = stableId("rel", key, `${from.id}\0${to.id}\0${match[1]}\0${match[2]}`);
        if (!result.some(item => item.id === id)) result.push({ id, from: from.id, to: to.id, kind: "imports", basis: "source", summary: `Static import map reports a file-level dependency from ${match[1]} to ${match[2]}.`, evidence: [{ repositoryId: binding.repo.projectId, source: match[1], line: null }, { repositoryId: binding.repo.projectId, source: match[2], line: null }] });
      }
    }
    return result.slice(0, MAX_EDGES);
  }

  private enrich(component: KnowledgeComponent, repo: StoredRepository, catalog: KnowledgeCatalog): KnowledgeComponent {
    const override = catalog.componentOverrides.find(item => item.id === component.id);
    const plans = catalog.plans.filter(plan => !plan.archived && plan.componentId === component.id);
    const plansChanged = !component.retired && repo.completedPlanRevisions[component.id] !== this.planKey(component.id, catalog.plans);
    return { ...component, name: override?.name ?? component.name, description: override?.description ?? component.description, pinned: Boolean(override?.pinned), redirectTo: override?.redirectTo ?? null,
      planned: plans, difference: plansChanged ? { state: "unverified", summary: "Plan revisions changed after the latest component synthesis.", claims: [], planRevisions: plans.map(plan => ({ id: plan.id, revision: plan.revision })).sort((a, b) => a.id.localeCompare(b.id)), snapshotId: null, generatedAt: null } : component.difference,
      featureIds: catalog.features.filter(feature => !feature.archived && feature.componentIds.includes(component.id)).map(feature => feature.id).slice(0, 100), history: repo.history[component.id] ?? component.history };
  }

  private planKey(componentId: string, plans: KnowledgePlan[]) { return digest(plans.filter(plan => !plan.archived && plan.componentId === componentId).map(plan => ({ id: plan.id, revision: plan.revision })).sort((a, b) => a.id.localeCompare(b.id))); }
  private validateSynthesis(original: KnowledgeComponent, value: KnowledgeComponent, repo: StoredRepository): KnowledgeComponent {
    if (value.id !== original.id || digest(value.paths) !== digest(original.paths) || digest(value.files) !== digest(original.files) || digest(value.repositoryIds) !== digest(original.repositoryIds)) throw new Error("synthesis-source-mismatch");
    const allowed = new Set(Object.keys(repo.context.files));
    const checkEvidence = (claim: { evidence: { repositoryId: string; source: string; line: number | null }[] }) => {
      for (const evidence of claim.evidence) if (evidence.line === null || !allowed.has(evidence.source) || evidence.repositoryId !== original.paths[0]?.repositoryId || evidence.line > (repo.context.files[evidence.source]?.lines ?? 0)) throw new Error("synthesis-evidence-outside-source");
    };
    for (const claim of value.current.claims) checkEvidence(claim);
    for (const claim of value.difference.claims) checkEvidence(claim);
    if (value.current.snapshotId !== original.current.snapshotId || value.current.sources.length === 0 || value.current.sources.some(source => source.fingerprint !== repo.fingerprint || source.repositoryId !== original.paths[0]?.repositoryId)) throw new Error("synthesis-snapshot-mismatch");
    if (value.difference.snapshotId !== repo.fingerprint || value.difference.generatedAt !== value.current.generatedAt) throw new Error("synthesis-difference-snapshot-mismatch");
    const expectedPlanRevisions = original.planned.map(plan => ({ id: plan.id, revision: plan.revision })).sort((a, b) => a.id.localeCompare(b.id));
    const returnedPlanRevisions = value.difference.planRevisions.map(plan => ({ id: plan.id, revision: plan.revision })).sort((a, b) => a.id.localeCompare(b.id));
    if (digest(expectedPlanRevisions) !== digest(returnedPlanRevisions)) throw new Error("synthesis-plan-revisions-mismatch");
    if (value.current.brief) {
      for (const claim of [...value.current.brief.architecture, ...value.current.brief.changes, ...value.current.brief.checks, ...value.current.brief.review, ...value.current.brief.guidance]) {
        for (const citation of claim.citations) if (!allowed.has(citation.source) || citation.line > (repo.context.files[citation.source]?.lines ?? 0)) throw new Error("synthesis-citation-outside-source");
      }
    }
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_OUTPUT_BYTES) throw new Error("synthesis-output-too-large");
    return knowledgeComponentStateSchema.parse({ ...value, pinned: original.pinned, retired: original.retired, redirectTo: original.redirectTo, planned: original.planned, featureIds: original.featureIds, history: original.history }) as KnowledgeComponent;
  }

  private async invoke<T>(root: string, callback: (options: UnderstandingAdapterOptions) => Promise<T>, maxBytes = MAX_OUTPUT_BYTES): Promise<T> {
    const configured = Math.min(MAX_ATTEMPT_MS, Math.max(1000, this.options.config.repositoryBriefings?.timeoutMs ?? 30_000));
    const remaining = this.activeDeadline ? this.activeDeadline - Date.now() : configured;
    if (remaining <= 0) throw new Error("understanding-attempt-deadline");
    const controller = new AbortController(); this.controllers.add(controller);
    const timeoutMs = Math.min(configured, remaining);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("understanding-timeout")); }, timeoutMs); timer.unref(); });
      const result = await Promise.race([callback({ signal: controller.signal, timeoutMs, maxBytes }), timeout]);
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error("understanding-output-too-large");
      return result;
    } finally { if (timer) clearTimeout(timer); this.controllers.delete(controller); }
  }

  private async runContext(root: string, options: UnderstandingAdapterOptions): Promise<RepoContext> {
    return runRepositoryContext(this.options.config, root, options, child => this.children.add(child), child => this.children.delete(child), child => this.stopChild(child));
  }
  private stopChild(child: ChildProcess) {
    if (child.exitCode !== null || child.killed) return;
    try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); }
    const timer = setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); } }, 500);
    timer.unref();
  }

  private binding(repo: ProjectGroupRepo, group: ProjectGroup): SourceBinding {
    const root = realpathSync(repo.path), rootStat = statSync(root);
    const projects = repo.checkouts.map(checkout => checkout.projectId).sort();
    const identity = repo.key ?? (captureIdentity({ id: repo.projectId, path: repo.path }, readGit)?.key ?? "");
    if (!identity) throw new Error("repository-identity-unavailable");
    const checkoutIdentities: unknown[] = [];
    for (const id of projects) {
      const project = this.options.config.projects.find(item => item.id === id);
      if (!project) throw new Error("project-membership-changed");
      const checkout = realpathSync(project.path);
      const gitRoot = readGit(checkout, ["rev-parse", "--show-toplevel"]);
      if (!gitRoot || realpathSync(gitRoot) !== checkout) throw new Error("checkout-root-changed");
      const captured = captureIdentity({ ...project, path: checkout }, readGit);
      if (!captured || captured.key !== identity) throw new Error("repository-identity-changed");
      const checkoutStat = statSync(checkout);
      checkoutIdentities.push([id, checkout, captured.key, String(checkoutStat.dev), String(checkoutStat.ino)]);
    }
    return { group, repo, root, rootIdentity: digest({ path: root, dev: String(rootStat.dev), ino: String(rootStat.ino), identity }), membership: digest({ groupId: group.id, revision: group.revision, key: identity, checkoutIdentities }), projects };
  }
  private boundStillCurrent(workspaceId: string, group: ProjectGroup, binding: SourceBinding) {
    try {
      const latest = this.group(workspaceId), repo = latest.repos.find(item => item.projectId === binding.repo.projectId);
      return Boolean(repo && this.binding(repo, latest).rootIdentity === binding.rootIdentity && this.binding(repo, latest).membership === binding.membership);
    } catch { return false; }
  }
  private membershipStillCurrent(workspaceId: string, group: ProjectGroup, bindings: SourceBinding[]) {
    try {
      const latest = this.group(workspaceId);
      return digest(latest.repos.map(repo => [repo.projectId, repo.key, repo.checkouts.map(item => item.projectId).sort()]).sort()) === digest(group.repos.map(repo => [repo.projectId, repo.key, repo.checkouts.map(item => item.projectId).sort()]).sort()) && bindings.every(binding => this.boundStillCurrent(workspaceId, latest, binding));
    } catch { return false; }
  }
  private failWorkspace(workspaceId: string, error: unknown) {
    const reason = failureReason(error), at = new Date().toISOString();
    console.error(`[Infinite] Understanding maintenance failed · workspace ${workspaceId} · ${reason}`);
    const old = this.workspace(workspaceId);
    old.failureCount = Math.min(20, old.failureCount + 1);
    const delay = this.backoff(workspaceId, 60_000);
    this.setMaintenance(workspaceId, { ...old.maintenance, state: "failed", nextAttemptAt: new Date(Date.now() + delay).toISOString(), jobsToday: this.dailyJobs(workspaceId), message: `Last attempt failed at ${at}: ${reason}.`, lastFailure: { at, reason } });
  }
}

function runRepositoryContext(config: Config, root: string, options: UnderstandingAdapterOptions, onChild: (child: ChildProcess) => void = () => {}, onDone: (child: ChildProcess) => void = () => {}, stop: (child: ChildProcess) => void = stopContextChild): Promise<RepoContext> {
  const briefing = config.repositoryBriefings;
  if (!briefing) return Promise.reject(new Error("repository-briefings-unavailable"));
  const commandArgs = [...briefing.args, "context", "--repo", root];
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try { child = spawn(briefing.command, commandArgs, { cwd: root, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" }); }
    catch { rejectPromise(new Error("context-spawn-failed")); return; }
    onChild(child);
    let out = Buffer.alloc(0), settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; options.signal.removeEventListener("abort", abort); onDone(child);
      if (error) { rejectPromise(error); return; }
      try { resolvePromise(parseRepoContext(JSON.parse(out.toString("utf8")))); }
      catch (error) { rejectPromise(new Error(`context-output-invalid: ${error instanceof Error ? error.message : "invalid context"}`)); }
    };
    const abort = () => { stop(child); finish(new Error("context-aborted")); };
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      out = Buffer.concat([out, chunk]);
      if (out.length > Math.min(options.maxBytes, MAX_CONTEXT_BYTES)) { stop(child); finish(new Error("context-output-too-large")); }
    });
    child.once("error", () => finish(new Error("context-process-error")));
    child.once("close", code => { if (code !== 0) finish(new Error("context-process-failed")); else finish(); });
  });
}
function stopContextChild(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return;
  try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); }
  const timer = setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); } }, 500);
  timer.unref();
}
