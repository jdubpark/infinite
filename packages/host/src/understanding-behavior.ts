import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type {
  BehaviorCheckResult, BehaviorDefinition, BehaviorList, BehaviorRun, BehaviorSuite,
  KnowledgeBehavior, KnowledgeComponent, KnowledgeEvidence, KnowledgePlan,
} from "@infinite/remote";
import { behaviorDefinitionHash, BEHAVIOR_CHECKER_VERSION, checkBehaviorModel, validateBehaviorDefinition } from "./behavior-checker.js";
import { exportBehaviorSuite } from "./behavior-suite.js";
import type { UnderstandingCatalog } from "./understanding-catalog.js";
import type { UnderstandingRuntime } from "./understanding-runtime.js";
import type { ProjectGroup, ProjectGroupRepo } from "./project-group-types.js";
import type { Config } from "./types.js";
import { seal, unseal, writeSealed } from "./vault.js";

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const RUN_COMPLETION_RESERVE_BYTES = 4096;
const MAX_BEHAVIORS = 16;
const MAX_RUNS = 8;
const MAX_RECEIPTS = 256;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const CHECK_LIMITS = { maxStates: 10_000, maxTransitions: 100_000, timeoutMs: 2_000, maxTraceSteps: 128 } as const;
const STORE_SCOPE = "understanding-behaviors";
const workspaceIdSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
const behaviorIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/);
const relativePathSchema = z.string().min(1).max(1024).refine(value =>
  !isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && !value.includes(":") &&
  !value.split("/").some(part => part === ".." || part === ""),
);
const behaviorValueSchema = z.union([z.string().max(256), z.number().int().safe(), z.boolean()]);
const traceStepSchema = z.object({ state: z.string().min(1).max(80), values: z.record(z.string().max(80), behaviorValueSchema),
  transitionId: z.string().max(80).nullable(), summary: z.string().max(1000) }).strict();
const propertyResultSchema = z.object({ id: z.string().max(80), status: z.enum(["passed", "failed", "unreachable", "unsupported", "incomplete"]),
  reachableStates: z.number().int().nonnegative().max(CHECK_LIMITS.maxStates), trace: z.array(traceStepSchema).max(CHECK_LIMITS.maxTraceSteps), traceTruncated: z.boolean() }).strict();
const checkResultSchema = z.object({ tool: z.literal("infinite-finite-state"), toolVersion: z.string().min(1).max(80),
  status: z.enum(["passed", "counterexample", "inconclusive", "error"]), checkedAt: z.string().datetime({ offset: true }),
  modelHash: z.string().regex(/^[a-f0-9]{64}$/), exhaustive: z.boolean(),
  exploredStates: z.number().int().nonnegative().max(CHECK_LIMITS.maxStates),
  exploredTransitions: z.number().int().nonnegative().max(CHECK_LIMITS.maxTransitions),
  limits: z.object({ maxStates: z.number().int().positive().max(CHECK_LIMITS.maxStates), maxTransitions: z.number().int().positive().max(CHECK_LIMITS.maxTransitions),
    timeoutMs: z.number().int().positive().max(CHECK_LIMITS.timeoutMs), maxTraceSteps: z.number().int().positive().max(CHECK_LIMITS.maxTraceSteps) }).strict(),
  properties: z.array(propertyResultSchema).max(128), message: z.string().max(2000) }).strict();
const runSchema = z.object({ id: z.uuid(), definitionRevision: z.number().int().positive(), definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().datetime({ offset: true }), finishedAt: z.string().datetime({ offset: true }).nullable(),
  state: z.enum(["running", "finished", "interrupted"]), current: checkResultSchema.nullable(), planned: checkResultSchema.nullable(), message: z.string().max(1000).nullable() }).strict();
const sourceSchema = z.object({ repositoryId: z.string().min(1).max(80), path: relativePathSchema,
  hash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), lines: z.number().int().nonnegative().max(2_000_000) }).strict();
const storedBehaviorSchema = z.object({ id: behaviorIdSchema, revision: z.number().int().positive(), definition: z.unknown(),
  sources: z.array(sourceSchema).max(MAX_FILES), rootIdentity: z.string().regex(/^[a-f0-9]{64}$/), membershipIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime({ offset: true }), runs: z.array(runSchema).max(MAX_RUNS) }).strict();
const receiptSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), behaviorId: behaviorIdSchema }).strict();
const stateSchema = z.object({ version: z.literal(1), workspaceId: workspaceIdSchema, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  jobsToday: z.number().int().nonnegative().max(1_000_000), behaviors: z.array(storedBehaviorSchema).max(MAX_BEHAVIORS),
  receipts: z.record(z.uuid(), receiptSchema), receiptOrder: z.array(z.uuid()).max(MAX_RECEIPTS) }).strict().superRefine((value, context) => {
  if (new Set(value.behaviors.map(behavior => behavior.id)).size !== value.behaviors.length)
    context.addIssue({ code: "custom", path: ["behaviors"], message: "behavior identifiers must be unique" });
  if (new Set(value.receiptOrder).size !== value.receiptOrder.length || value.receiptOrder.length !== Object.keys(value.receipts).length ||
      value.receiptOrder.some(requestId => !Object.hasOwn(value.receipts, requestId)))
    context.addIssue({ code: "custom", path: ["receiptOrder"], message: "request receipts are inconsistent" });
});

type SourceFile = z.infer<typeof sourceSchema>;
type StoredBehavior = Omit<z.infer<typeof storedBehaviorSchema>, "definition"> & { definition: BehaviorDefinition };
type StoredState = Omit<z.infer<typeof stateSchema>, "behaviors"> & { behaviors: StoredBehavior[] };
type BehaviorReceipt = { fingerprint: string; behaviorId: string };
type RootBinding = { root: string; rootIdentity: string; membershipIdentity: string; group: ProjectGroup; repo: ProjectGroupRepo };
type Assessment = { freshness: "current" | "stale" | "unavailable"; coverage: string[]; component?: KnowledgeComponent; sources?: SourceFile[]; root?: RootBinding };
type ActiveRun = { workspaceId: string; behaviorId: string; runId: string; controller: AbortController; immediate?: NodeJS.Immediate; task?: Promise<void> };

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
      : value;
}
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function today() { return new Date().toISOString().slice(0, 10); }
function sortedPlanRevisions(plans: KnowledgePlan[]) {
  return plans.filter(plan => !plan.archived).map(({ id, revision }) => ({ id, revision })).sort((left, right) => left.id.localeCompare(right.id));
}
function sameJson(left: unknown, right: unknown) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function coverageBase() {
  return [
    "A finite-model result covers the submitted model and assumptions; it does not prove correspondence to source code.",
    "Transition and property evidence must resolve to line-bounded files in the captured component source set.",
    "Current and planned models are checked separately; only the current result determines behavior status.",
    "Behavior runs use a separate durable daily admission count bounded by the workspace daily job limit.",
  ];
}
function statusFor(result: BehaviorCheckResult | null): KnowledgeBehavior["status"] {
  if (!result) return "error";
  if (result.status === "passed" && (!result.exhaustive || result.properties.some(property => property.status !== "passed"))) return "inconclusive";
  return result.status === "counterexample" ? "counterexample" : result.status;
}

export class BehaviorError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 429 | 503, message: string) { super(message); this.name = "BehaviorError"; }
}

/** Encrypted, bounded behavior definitions and real finite-state checker receipts. */
export class UnderstandingBehaviorService {
  private readonly directory: string;
  private readonly files = new Map<string, string>();
  private readonly states = new Map<string, StoredState>();
  private readonly storageErrors = new Map<string, string>();
  private directoryError?: string;
  private active?: ActiveRun;
  private closed = false;

  constructor(private readonly sources: { config: Config; key: Buffer;
    groups: { get(id: string): ProjectGroup; list(): { groups: ProjectGroup[] } };
    catalog: Pick<UnderstandingCatalog, "read">; runtime: Pick<UnderstandingRuntime, "read"> }) {
    this.directory = resolve(sources.config.stateDir, "understanding", "behaviors");
    this.load();
  }

  close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (!active) return Promise.resolve();
    if (active.immediate) clearImmediate(active.immediate);
    active.controller.abort();
    this.interrupt(active, "The host stopped before the finite-state check completed.");
    this.active = undefined;
    return active.task ? Promise.race([active.task, new Promise<void>(resolvePromise => { const timer = setTimeout(resolvePromise, CHECK_LIMITS.timeoutMs + 500); timer.unref(); })]) : Promise.resolve();
  }

  list(workspaceId: string, componentId?: string): BehaviorList {
    const state = this.state(workspaceId);
    const filter = componentId === undefined ? undefined : z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).parse(componentId);
    const behaviors = state.behaviors.filter(item => !filter || item.definition.componentId === filter).map(item => this.present(workspaceId, item));
    return { schemaVersion: 1, behaviors, coverage: [...coverageBase(), `At most ${MAX_BEHAVIORS} behavior definitions are retained per workspace.`] };
  }

  get(workspaceId: string, behaviorId: string): KnowledgeBehavior {
    const id = behaviorIdSchema.parse(behaviorId);
    const behavior = this.state(workspaceId).behaviors.find(item => item.id === id);
    if (!behavior) throw new BehaviorError(404, "Behavior definition was not found in this workspace.");
    return this.present(workspaceId, behavior);
  }

  save(workspaceId: string, value: unknown): KnowledgeBehavior {
    if (this.closed) throw new BehaviorError(503, "Behavior verification is shutting down.");
    const parsed = z.object({ requestId: z.uuid(), revision: z.number().int().nonnegative(), definition: z.unknown() }).strict().safeParse(value);
    if (!parsed.success) throw new BehaviorError(400, "Invalid behavior mutation.");
    const definition = this.validateDefinition(parsed.data.definition);
    const request = { requestId: parsed.data.requestId, revision: parsed.data.revision, definition };
    const receiptFingerprint = fingerprint({ operation: "save", workspaceId, ...request });
    const state = this.state(workspaceId);
    const priorReceipt = state.receipts[request.requestId];
    if (priorReceipt) {
      if (priorReceipt.fingerprint !== receiptFingerprint) throw new BehaviorError(409, "Request identifier was already used for a different behavior change.");
      const replay = state.behaviors.find(item => item.id === priorReceipt.behaviorId);
      if (!replay) throw new BehaviorError(503, "Behavior request receipt cannot be resolved safely.");
      return this.present(workspaceId, replay);
    }

    const current = state.behaviors.find(item => item.id === definition.id);
    const actualRevision = current?.revision ?? 0;
    if (parsed.data.revision !== actualRevision) throw new BehaviorError(409, "Behavior revision changed. Refresh the current definition before saving.");
    if (current && (current.definition.componentId !== definition.componentId || current.definition.repositoryId !== definition.repositoryId))
      throw new BehaviorError(409, "A retained behavior cannot move to a different component or repository.");
    if (!current && state.behaviors.length >= MAX_BEHAVIORS) throw new BehaviorError(409, "This workspace has reached its behavior definition limit.");
    const scope = this.assertDefinitionScope(workspaceId, definition);
    if (current && (current.rootIdentity !== scope.root.rootIdentity || current.membershipIdentity !== scope.root.membershipIdentity))
      throw new BehaviorError(409, "Repository identity or workspace membership changed. Create a new behavior definition for the current source.");
    const now = new Date().toISOString();
    const nextBehavior: StoredBehavior = {
      id: definition.id, revision: actualRevision + 1, definition, sources: scope.sources,
      rootIdentity: scope.root.rootIdentity, membershipIdentity: scope.root.membershipIdentity,
      updatedAt: now, runs: current ? structuredClone(current.runs) : [],
    };
    const next = structuredClone(state);
    if (current) next.behaviors[next.behaviors.findIndex(item => item.id === current.id)] = nextBehavior;
    else next.behaviors.push(nextBehavior);
    this.addReceipt(next, request.requestId, { fingerprint: receiptFingerprint, behaviorId: definition.id });
    this.commit(workspaceId, next);
    return this.present(workspaceId, nextBehavior);
  }

  run(workspaceId: string, behaviorId: string, value: unknown): KnowledgeBehavior {
    if (this.closed) throw new BehaviorError(503, "Behavior verification is shutting down.");
    const id = behaviorIdSchema.parse(behaviorId);
    const parsed = z.object({ requestId: z.uuid(), revision: z.number().int().nonnegative() }).strict().safeParse(value);
    if (!parsed.success) throw new BehaviorError(400, "Invalid behavior run request.");
    const request = parsed.data;
    const receiptFingerprint = fingerprint({ operation: "run", workspaceId, behaviorId: id, ...request });
    const state = this.state(workspaceId);
    const priorReceipt = state.receipts[request.requestId];
    if (priorReceipt) {
      if (priorReceipt.fingerprint !== receiptFingerprint) throw new BehaviorError(409, "Request identifier was already used for a different behavior operation.");
      const replay = state.behaviors.find(item => item.id === priorReceipt.behaviorId);
      if (!replay) throw new BehaviorError(503, "Behavior request receipt cannot be resolved safely.");
      return this.present(workspaceId, replay);
    }
    if (this.active) throw new BehaviorError(409, "Another behavior check is already running on this host.");
    const current = state.behaviors.find(item => item.id === id);
    if (!current) throw new BehaviorError(404, "Behavior definition was not found in this workspace.");
    if (request.revision !== current.revision) throw new BehaviorError(409, "Behavior revision changed. Refresh before starting a check.");
    const assessment = this.assess(workspaceId, current);
    if (assessment.freshness !== "current") throw new BehaviorError(409, "Behavior source, plans, or repository scope are stale or unavailable.");
    const dailyLimit = this.dailyLimit(workspaceId);
    const day = today(), count = state.day === day ? state.jobsToday : 0;
    if (count >= dailyLimit) throw new BehaviorError(429, "The daily behavior check limit has been reached.");

    const runId = randomUUID(), startedAt = new Date().toISOString(), definitionHash = behaviorDefinitionHash(current.definition);
    const run: BehaviorRun = { id: runId, definitionRevision: current.revision, definitionHash, startedAt, finishedAt: null,
      state: "running", current: null, planned: null, message: null };
    const next = structuredClone(state);
    if (state.day !== day) { next.day = day; next.jobsToday = 0; }
    next.jobsToday++;
    const target = next.behaviors.find(item => item.id === id)!;
    while (target.runs.length >= MAX_RUNS) target.runs.shift();
    target.runs.push(run);
    this.addReceipt(next, request.requestId, { fingerprint: receiptFingerprint, behaviorId: id });
    this.commit(workspaceId, next);

    const active: ActiveRun = { workspaceId, behaviorId: id, runId, controller: new AbortController() };
    this.active = active;
    active.immediate = setImmediate(() => {
      active.immediate = undefined;
      active.task = this.execute(active, structuredClone(current.definition)).catch(() => {
        this.interrupt(active, "The finite-state check was interrupted before a result could be retained.");
        if (this.active?.runId === active.runId) this.active = undefined;
      });
    });
    return this.present(workspaceId, target);
  }

  suite(workspaceId: string, behaviorId: string): BehaviorSuite {
    const behavior = this.get(workspaceId, behaviorId);
    const suite = exportBehaviorSuite(behavior.definition);
    return { ...suite, coverage: [...suite.coverage, ...behavior.coverage] };
  }

  private validateDefinition(value: unknown): BehaviorDefinition {
    try { return validateBehaviorDefinition(value); }
    catch { throw new BehaviorError(400, "Behavior definition is invalid or exceeds the supported data-only model limits."); }
  }

  private assertWorkspace(workspaceId: string): ProjectGroup {
    if (!workspaceIdSchema.safeParse(workspaceId).success) throw new BehaviorError(404, "Workspace was not found.");
    try {
      const group = this.sources.groups.get(workspaceId);
      if (group.id !== workspaceId) throw new Error("workspace id mismatch");
      return group;
    } catch { throw new BehaviorError(404, "Workspace was not found."); }
  }

  private rootBinding(workspaceId: string, repositoryId: string): RootBinding | undefined {
    const group = this.assertWorkspace(workspaceId);
    const repo = group.repos.find(item => item.projectId === repositoryId && item.checkouts.some(checkout => checkout.projectId === repositoryId && checkout.primary));
    const project = this.sources.config.projects.find(item => item.id === repositoryId);
    if (!repo || !project) return undefined;
    try {
      const root = realpathSync(project.path), groupRoot = realpathSync(repo.path), stat = statSync(root);
      if (root !== groupRoot || !stat.isDirectory()) return undefined;
      const checkoutIds = repo.checkouts.map(item => item.projectId).sort();
      const rootIdentity = digest({ repositoryId, root, device: String(stat.dev), inode: String(stat.ino), repositoryKey: repo.key ?? null });
      const membershipIdentity = digest({ workspaceId, repositoryId, repositoryKey: repo.key ?? null, checkoutIds, primary: repo.projectId });
      return { root, rootIdentity, membershipIdentity, group, repo };
    } catch { return undefined; }
  }

  private plans(workspaceId: string, componentId: string): KnowledgePlan[] {
    const catalog = this.sources.catalog.read(workspaceId);
    if (catalog.coverage.length) throw new BehaviorError(503, "Workspace plan scope is unavailable.");
    return catalog.plans.filter(plan => !plan.archived && plan.componentId === componentId);
  }

  private component(workspaceId: string, componentId: string) {
    const value = this.sources.runtime.read(workspaceId);
    const component = value.components.find(item => item.id === componentId);
    if (!component || component.retired) throw new BehaviorError(409, "The current source component is unavailable or retired.");
    return component;
  }

  private assertDefinitionScope(workspaceId: string, definition: BehaviorDefinition): { component: KnowledgeComponent; root: RootBinding; sources: SourceFile[] } {
    const component = this.component(workspaceId, definition.componentId);
    const root = this.rootBinding(workspaceId, definition.repositoryId);
    if (!root) throw new BehaviorError(409, "The target repository is unavailable or no longer belongs to this workspace.");
    if (component.paths.length !== 1 || component.paths[0]?.repositoryId !== definition.repositoryId ||
      !component.current.sources.some(source => source.repositoryId === definition.repositoryId && source.fingerprint === definition.sourceSnapshotId) ||
      component.current.snapshotId !== definition.sourceSnapshotId || component.current.state === "stale" || component.current.state === "unavailable")
      throw new BehaviorError(409, "Behavior definition does not match the current component source observation.");
    const expectedPlans = sortedPlanRevisions(this.plans(workspaceId, definition.componentId));
    if (!sameJson([...definition.planRevisions].sort((left, right) => left.id.localeCompare(right.id)), expectedPlans))
      throw new BehaviorError(409, "Behavior definition does not contain the complete current component plan revision set.");
    const sources = this.captureFiles(root.root, component, definition.repositoryId);
    if (!sources) throw new BehaviorError(409, "Captured component files are unavailable or changed.");
    this.validateEvidence(definition.current, definition.repositoryId, sources);
    if (definition.planned) this.validateEvidence(definition.planned, definition.repositoryId, sources);
    return { component, root, sources };
  }

  private validateEvidence(model: BehaviorDefinition["current"], repositoryId: string, sources: SourceFile[]) {
    const known = new Map(sources.map(source => [source.path, source]));
    const check = (items: KnowledgeEvidence[], label: string) => {
      if (!items.length) throw new BehaviorError(400, `Every ${label} must cite at least one captured source line.`);
      for (const evidence of items) {
        const source = known.get(evidence.source);
        if (evidence.repositoryId !== repositoryId || evidence.line === null || !source || evidence.line > source.lines)
          throw new BehaviorError(400, "Behavior evidence must cite an in-bounds line in a captured file from the target repository.");
      }
    };
    for (const transition of model.transitions) check(transition.evidence, "transition");
    for (const property of model.properties) check(property.evidence, "property");
  }

  private captureFiles(root: string, component: KnowledgeComponent, repositoryId: string): SourceFile[] | undefined {
    if (!component.files.length || component.files.length > MAX_FILES) return undefined;
    const rootPath = resolve(root), rootPrefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
    const seen = new Set<string>(), files: SourceFile[] = [];
    let total = 0;
    try {
      for (const file of component.files) {
        if (file.repositoryId !== repositoryId || !relativePathSchema.safeParse(file.path).success || seen.has(file.path)) return undefined;
        seen.add(file.path);
        const target = resolve(rootPath, ...file.path.split("/"));
        if (!target.startsWith(rootPrefix)) return undefined;
        let cursor = rootPath;
        for (const part of file.path.split("/")) {
          cursor = join(cursor, part);
          if (lstatSync(cursor).isSymbolicLink()) return undefined;
        }
        if (realpathSync(target) !== target) return undefined;
        const stat = statSync(target);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || total + stat.size > MAX_SOURCE_BYTES) return undefined;
        const bytes = readFileSync(target);
        if (bytes.length !== stat.size) return undefined;
        const algorithm = file.hash.length === 40 ? "sha1" : "sha256";
        if (createHash(algorithm).update(bytes).digest("hex") !== file.hash) return undefined;
        const actualLines = bytes.toString("utf8").split(/\r?\n/).length;
        if (actualLines > 2_000_000) return undefined;
        total += bytes.length;
        files.push({ repositoryId, path: file.path, hash: file.hash, lines: Math.min(file.lines, actualLines) });
      }
      return files.sort((left, right) => left.path.localeCompare(right.path));
    } catch { return undefined; }
  }

  private assess(workspaceId: string, behavior: StoredBehavior): Assessment {
    try {
      const root = this.rootBinding(workspaceId, behavior.definition.repositoryId);
      if (!root) return { freshness: "stale", coverage: ["The enrolled repository root or primary checkout changed."] };
      if (root.rootIdentity !== behavior.rootIdentity || root.membershipIdentity !== behavior.membershipIdentity)
        return { freshness: "stale", coverage: ["Repository root identity or workspace membership changed since this behavior was saved."] };
      const state = this.sources.runtime.read(workspaceId);
      const component = state.components.find(item => item.id === behavior.definition.componentId);
      if (!component || component.retired) return { freshness: "stale", coverage: ["The captured source component is no longer current in this workspace."] };
      if (component.current.snapshotId !== behavior.definition.sourceSnapshotId || component.current.state === "stale" || component.current.state === "unavailable" ||
        component.paths.length !== 1 || component.paths[0]?.repositoryId !== behavior.definition.repositoryId ||
        !component.current.sources.some(source => source.repositoryId === behavior.definition.repositoryId && source.fingerprint === behavior.definition.sourceSnapshotId))
        return { freshness: "stale", coverage: ["The component source snapshot changed after this behavior was saved."] };
      const currentPlans = sortedPlanRevisions(this.plans(workspaceId, behavior.definition.componentId));
      if (!sameJson([...behavior.definition.planRevisions].sort((left, right) => left.id.localeCompare(right.id)), currentPlans))
        return { freshness: "stale", coverage: ["The component plan revision set changed after this behavior was saved."] };
      const sources = this.captureFiles(root.root, component, behavior.definition.repositoryId);
      if (!sources || !sameJson(sources, behavior.sources)) return { freshness: "stale", coverage: ["A covered component file changed or cannot be read within the source safety limits."] };
      return { freshness: "current", coverage: [], component, sources, root };
    } catch (error) {
      if (error instanceof BehaviorError) return { freshness: error.statusCode === 404 || error.statusCode === 503 ? "unavailable" : "stale", coverage: ["Current repository, plan, or component scope could not be confirmed."] };
      return { freshness: "unavailable", coverage: ["Current repository, plan, or component scope is unavailable."] };
    }
  }

  private present(workspaceId: string, behavior: StoredBehavior): KnowledgeBehavior {
    const assessment = this.assess(workspaceId, behavior);
    const latest = behavior.runs.at(-1);
    let freshness = assessment.freshness;
    let status: KnowledgeBehavior["status"] = "unchecked";
    if (latest) {
      const latestMatchesDefinition = latest.definitionRevision === behavior.revision && latest.definitionHash === behaviorDefinitionHash(behavior.definition);
      const checkerMatches = latest.state !== "finished" || !latest.current || latest.current.toolVersion === BEHAVIOR_CHECKER_VERSION;
      if (freshness !== "current" || latest.state === "interrupted" || !latestMatchesDefinition || !checkerMatches) {
        status = "stale";
        if (latest.state === "interrupted")
          assessment.coverage.push("The latest check was interrupted; its admission remains consumed and a new explicit run may be requested.");
        else if (!latestMatchesDefinition)
          assessment.coverage.push("The latest result belongs to an earlier behavior definition revision; a new explicit run is available.");
        else if (!checkerMatches)
          assessment.coverage.push("The finite-state checker version changed after the latest result; a new explicit run is available.");
      } else if (latest.state === "running") status = "running";
      else status = statusFor(latest.current);
    }
    return {
      id: behavior.id, revision: behavior.revision, definition: structuredClone(behavior.definition), sources: structuredClone(behavior.sources),
      updatedAt: behavior.updatedAt, freshness, status,
      coverage: [...coverageBase(), ...assessment.coverage], runs: structuredClone(behavior.runs),
    };
  }

  private async execute(active: ActiveRun, definition: BehaviorDefinition) {
    const admittedState = this.states.get(active.workspaceId);
    const admittedBehavior = admittedState?.behaviors.find(item => item.id === active.behaviorId);
    const admittedRun = admittedBehavior?.runs.find(item => item.id === active.runId);
    if (!admittedBehavior || !admittedRun || admittedRun.state !== "running" ||
      admittedRun.definitionRevision !== admittedBehavior.revision || admittedRun.definitionHash !== behaviorDefinitionHash(admittedBehavior.definition) ||
      behaviorDefinitionHash(definition) !== admittedRun.definitionHash || this.assess(active.workspaceId, admittedBehavior).freshness !== "current") {
      this.interrupt(active, "The source, plan, repository scope, or definition changed before the checker started; the admission remains consumed.");
      if (this.active?.runId === active.runId) this.active = undefined;
      return;
    }
    const currentModel = definition.current;
    let current: BehaviorCheckResult | null = null, planned: BehaviorCheckResult | null = null, message: string | null = null;
    try {
      current = checkResultSchema.parse(await checkBehaviorModel(currentModel, { signal: active.controller.signal, ...CHECK_LIMITS })) as BehaviorCheckResult;
      if (definition.planned && !active.controller.signal.aborted)
        planned = checkResultSchema.parse(await checkBehaviorModel(definition.planned, { signal: active.controller.signal, ...CHECK_LIMITS })) as BehaviorCheckResult;
      if (active.controller.signal.aborted) message = "The finite-state check was interrupted before completion.";
    } catch {
      message = "The finite-state checker could not complete this model.";
    }
    const currentState = this.states.get(active.workspaceId);
    const stored = currentState?.behaviors.find(item => item.id === active.behaviorId);
    const run = stored?.runs.find(item => item.id === active.runId);
    if (!stored || !run || run.state !== "running") { if (this.active?.runId === active.runId) this.active = undefined; return; }
    const finishedAt = new Date().toISOString();
    const result: BehaviorRun = { ...run, state: "finished", finishedAt, current, planned, message };
    const next = structuredClone(currentState!);
    const nextBehavior = next.behaviors.find(item => item.id === active.behaviorId)!;
    nextBehavior.runs[nextBehavior.runs.findIndex(item => item.id === active.runId)] = result;
    try {
      try {
        this.commit(active.workspaceId, next);
      } catch (error) {
        if (!(error instanceof BehaviorError) || error.statusCode !== 409) throw error;
        result.current = null;
        result.planned = null;
        result.message = "The checker output exceeded the workspace storage limit. No result was retained; the admission remains consumed.";
        this.commit(active.workspaceId, next);
      }
      // A completion is retained, but a source, plan, identity, or definition change makes it stale immediately.
      this.assess(active.workspaceId, nextBehavior);
    } catch {
      // The durable running receipt remains intact; startup recovery will preserve it as interrupted.
    } finally {
      if (this.active?.runId === active.runId) this.active = undefined;
    }
  }

  private interrupt(active: ActiveRun, message: string) {
    const state = this.states.get(active.workspaceId);
    const behavior = state?.behaviors.find(item => item.id === active.behaviorId);
    const run = behavior?.runs.find(item => item.id === active.runId);
    if (!state || !behavior || !run || run.state !== "running") return;
    const next = structuredClone(state);
    const nextRun = next.behaviors.find(item => item.id === active.behaviorId)!.runs.find(item => item.id === active.runId)!;
    nextRun.state = "interrupted";
    nextRun.finishedAt = new Date().toISOString();
    nextRun.message = message;
    try { this.commit(active.workspaceId, next); } catch { /* Leave the durable running receipt for restart recovery. */ }
  }

  private dailyLimit(workspaceId: string) {
    try {
      const limit = this.sources.catalog.read(workspaceId).policy.dailyJobLimit;
      return Number.isSafeInteger(limit) && limit >= 1 ? limit : 1;
    } catch { throw new BehaviorError(503, "Workspace run policy is unavailable."); }
  }

  private state(workspaceId: string): StoredState {
    this.assertWorkspace(workspaceId);
    if (this.directoryError) throw new BehaviorError(503, "Encrypted behavior state is unavailable or corrupt.");
    const error = this.storageErrors.get(workspaceId);
    if (error) throw new BehaviorError(503, "Encrypted behavior state is unavailable or corrupt.");
    const existing = this.states.get(workspaceId);
    if (existing) return existing;
    return { version: 1, workspaceId, day: today(), jobsToday: 0, behaviors: [], receipts: {}, receiptOrder: [] };
  }

  private addReceipt(state: StoredState, requestId: string, receipt: BehaviorReceipt) {
    state.receipts[requestId] = receipt;
    state.receiptOrder.push(requestId);
    while (state.receiptOrder.length > MAX_RECEIPTS) {
      const removed = state.receiptOrder.shift();
      if (removed) delete state.receipts[removed];
    }
  }

  private commit(workspaceId: string, state: StoredState) {
    if (this.storageErrors.has(workspaceId)) throw new BehaviorError(503, "Encrypted behavior state is unavailable or corrupt.");
    try {
      this.assertSafeDirectory();
      stateSchema.parse(state);
      const scope = `${STORE_SCOPE}:${workspaceId}`;
      const raw = seal(this.sources.key, scope, state);
      // Every mutation preserves space to finish admitted runs even when their output cannot fit.
      const running = state.behaviors.reduce((count, behavior) => count + behavior.runs.filter(run => run.state === "running").length, 0);
      if (Buffer.byteLength(raw) + running * RUN_COMPLETION_RESERVE_BYTES > MAX_STORE_BYTES)
        throw new BehaviorError(409, "This workspace has reached its behavior storage limit.");
      const file = this.file(workspaceId);
      writeSealed(file, this.sources.key, scope, state);
      this.states.set(workspaceId, state);
    } catch (error) {
      if (error instanceof BehaviorError) throw error;
      this.storageErrors.set(workspaceId, "write failed");
      throw new BehaviorError(503, "Encrypted behavior state could not be saved safely.");
    }
  }

  private file(workspaceId: string) {
    if (!workspaceIdSchema.safeParse(workspaceId).success) throw new BehaviorError(404, "Workspace was not found.");
    const cached = this.files.get(workspaceId);
    if (cached) return cached;
    const file = join(this.directory, `${workspaceId}.sealed`);
    this.files.set(workspaceId, file);
    return file;
  }

  private load() {
    try { this.assertSafeDirectory(); } catch { this.directoryError = "directory unavailable"; return; }
    if (!existsSync(this.directory)) return;
    let entries: string[];
    try { entries = readdirSync(this.directory); } catch { this.directoryError = "directory unavailable"; return; }
    for (const name of entries) {
      const match = /^([a-z0-9-]{1,80})\.sealed$/.exec(name);
      if (!match) continue;
      const workspaceId = match[1]!;
      const file = join(this.directory, name);
      this.files.set(workspaceId, file);
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error("invalid behavior store file");
        const root = realpathSync(this.directory);
        if (!realpathSync(file).startsWith(`${root}${sep}`)) throw new Error("behavior store escaped its directory");
        const state = stateSchema.parse(unseal<unknown>(this.sources.key, `${STORE_SCOPE}:${workspaceId}`, readFileSync(file, "utf8"))) as StoredState;
        if (state.workspaceId !== workspaceId) throw new Error("behavior workspace mismatch");
        for (const behavior of state.behaviors) behavior.definition = validateBehaviorDefinition(behavior.definition);
        const next = structuredClone(state);
        let interrupted = false;
        for (const behavior of next.behaviors) for (const run of behavior.runs) if (run.state === "running") {
          run.state = "interrupted";
          run.finishedAt = new Date().toISOString();
          run.message = "The host restarted before the finite-state check completed; the admission remains consumed.";
          interrupted = true;
        }
        this.states.set(workspaceId, next);
        if (interrupted) this.commit(workspaceId, next);
      } catch {
        this.storageErrors.set(workspaceId, "corrupt");
      }
    }
  }

  private assertSafeDirectory() {
    const parents = [resolve(this.sources.config.stateDir, "understanding"), this.directory];
    for (const path of parents) {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe behavior state directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }
}
