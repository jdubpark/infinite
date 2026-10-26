import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { z } from "zod";
import { parseMermaid } from "@infinite/remote";
import type { Diagram, UnderstandingArtifact, UnderstandingLink, UnderstandingPlan, UnderstandingRepository, UnderstandingWork, WorkspaceUnderstanding, WorkspaceKnowledge } from "@infinite/remote";
import { MAX_RESPONSE_BYTES } from "@infinite/remote/protocol";
import { captureIdentity, readGit } from "./checkout-identity.js";
import type { RepositorySummary, RepositoryBriefings } from "./repository-briefings.js";
import type { Manager } from "./manager.js";
import type { Project, Session, Config } from "./types.js";
import type { ProjectGroup, ProjectGroupList } from "./project-group-types.js";
import type { MissionService } from "./missions.js";
import type { TeamService } from "./teams.js";
import type { GoalService } from "./goals.js";
import { writeSealed, unseal } from "./vault.js";
import { CatalogError } from "./understanding-catalog.js";

const MAX_GENERATIONS = 64;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
// Runtime output is capped at 1 MiB before sealing. Keep one bounded generation
// of publication headroom so a full store can advance without deleting evidence first.
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const TEMPORARY_ARTIFACT = /^[0-9a-f-]{36}\.sealed\.[0-9a-f]{16}\.tmp$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const projectIdSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
const citationSchema = z.object({ source: z.string().min(1).max(1024), line: z.number().int().positive() }).strict();
const claimSchema = z.object({ text: z.string().min(1).max(900), citations: z.array(citationSchema).max(6) }).strict();
const MAX_DIAGRAM_NODES = 48, MAX_DIAGRAM_EDGES = 120;
const idText = z.string().min(1).max(120);
const diagramSchema = z.object({
  id: idText, title: z.string().min(1).max(120), kind: z.enum(["change-map", "system", "change", "sequence"]),
  basis: z.enum(["source", "agent", "owner", "model", "host"]), direction: z.enum(["LR", "TD"]),
  nodes: z.array(z.object({ id: idText, label: z.string().max(200), shape: z.enum(["box", "round", "diamond", "cylinder", "pill"]),
    change: z.enum(["added", "modified", "removed"]).optional(), componentId: z.string().max(200).optional(), group: z.string().max(200).optional() }).strict()).max(MAX_DIAGRAM_NODES),
  edges: z.array(z.object({ from: idText, to: idText, label: z.string().max(200).optional(), style: z.enum(["solid", "dashed", "thick"]),
    kind: z.enum(["imports", "calls", "publishes", "consumes", "stores", "implements"]).optional() }).strict()).max(MAX_DIAGRAM_EDGES),
  groups: z.array(z.object({ id: idText, label: z.string().max(200) }).strict()).max(MAX_DIAGRAM_NODES),
  sequence: z.object({
    participants: z.array(z.object({ id: idText, label: z.string().max(200) }).strict()).max(MAX_DIAGRAM_NODES),
    messages: z.array(z.object({ from: idText, to: idText, text: z.string().max(300), style: z.enum(["solid", "dashed"]) }).strict()).max(MAX_DIAGRAM_EDGES),
  }).strict().optional(),
  sourceText: z.string().max(3000).optional(), parseError: z.string().max(500).optional(),
  citations: z.array(citationSchema).max(24), coverage: z.array(z.string().max(500)).max(20),
}).strict();
const briefSchema = z.object({
  summary: z.string().min(1).max(600), architecture: z.array(claimSchema).max(6), changes: z.array(claimSchema).max(6), checks: z.array(claimSchema).max(4),
  review: z.array(z.object({ priority: z.enum(["high", "medium"]), area: z.string().min(1).max(150), why: z.string().min(1).max(900), question: z.string().min(1).max(900), citations: z.array(citationSchema).max(6) }).strict()).max(5),
  guidance: z.array(z.object({ text: z.string().min(1).max(900), basis: z.enum(["documented", "proposed"]), citations: z.array(citationSchema).max(6) }).strict()).max(4),
  unknowns: z.array(z.string().min(1).max(900)).max(8),
  diagrams: z.array(diagramSchema).max(4).default([]),
}).strict();
const evidenceSchema = z.array(z.object({ source: z.string().min(1).max(1024), line: z.number().int().positive(), text: z.string().max(12000) }).strict()).max(200);
const artifactSchema = z.object({
  id: z.string().uuid(), sourceProjectId: projectIdSchema, sessionId: z.string().uuid(), sourceKind: z.enum(["project", "team"]),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), base: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), generatedAt: z.string().datetime({ offset: true }), retainedAt: z.string().datetime({ offset: true }),
  coverage: z.array(z.string().max(500)).max(100), brief: briefSchema, evidence: evidenceSchema,
}).strict();
const bindingSchema = z.object({
  projectId: projectIdSchema, sourceKind: z.enum(["project", "team"]), enrolledPath: z.string().min(1).max(4096), root: z.string().min(1).max(4096),
  sourceCwd: z.string().min(1).max(4096),
  projectDevice: z.string().max(80), projectInode: z.string().max(80), rootDevice: z.string().max(80), rootInode: z.string().max(80), repoIdentity: z.string().max(128),
  sourceCwdDevice: z.string().max(80), sourceCwdInode: z.string().max(80),
  runId: z.string().uuid().optional(), memberId: z.string().uuid().optional(),
}).strict();
const entrySchema = z.object({ binding: bindingSchema, artifact: artifactSchema }).strict();
type Binding = z.infer<typeof bindingSchema>;
type Entry = z.infer<typeof entrySchema>;
type State = { version: 1; generations: Entry[] };
type Capture = { binding: Binding };
type ProjectBinding = { enrolledPath: string; projectDevice: string; projectInode: string; repoIdentity: string };

export interface UnderstandingSources {
  config: Config;
  key: Buffer;
  manager: Manager;
  groups: { list(): ProjectGroupList; get(id: string): ProjectGroup };
  missions: Pick<MissionService, "understandingRecords" | "understandingOwnsSession">;
  teams: Pick<TeamService, "understandingRecords" | "understandingOwnsSession">;
  goals: Pick<GoalService, "understandingRecords">;
  briefings?: Pick<RepositoryBriefings, "useRetention" | "understandingStatuses">;
  knowledge?: { read(id: string): WorkspaceKnowledge };
}

/** Read model and retained, source-bound repository brief generations. Reads never schedule work. */
export class UnderstandingService {
  private readonly directory: string;
  private state: State = { version: 1, generations: [] };
  private storageError?: string;
  private readonly pendingPrune = new Set<string>();

  constructor(private readonly sources: UnderstandingSources) {
    this.directory = resolve(sources.config.stateDir, "understanding", "artifacts");
    this.load();
    sources.briefings?.useRetention({
      capture: (session, location) => this.capture(session, location.root),
      persist: (session, location, summary, captured) => this.persist(session, location.root, summary, captured),
    });
  }

  private load() {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const files = readdirSync(this.directory).filter(file => /^[0-9a-f-]{36}\.sealed$/.test(file));
      const generations: Entry[] = [];
      const sizes = new Map<string, number>();
      let bytes = 0, invalid = false;
      for (const file of files) {
        try {
          const size = statSync(join(this.directory, file)).size;
          if (size > MAX_ARTIFACT_BYTES) { invalid = true; continue; }
          bytes += size;
          if (bytes > MAX_STORE_BYTES + MAX_ARTIFACT_BYTES) { invalid = true; break; }
          const raw = readFileSync(join(this.directory, file), "utf8");
          const entry = entrySchema.parse(unseal<unknown>(this.sources.key, "understanding-artifact", raw));
          if (`${entry.artifact.id}.sealed` !== file) throw new Error("generation-name-mismatch");
          generations.push(entry);
          sizes.set(entry.artifact.id, size);
        } catch { invalid = true; }
      }
      this.state = { version: 1, generations: retainedGenerations(generations, sizes) };
      const retained = new Set(this.state.generations.map(entry => entry.artifact.id));
      for (const entry of generations) if (!retained.has(entry.artifact.id)) this.pendingPrune.add(entry.artifact.id);
      if (invalid) this.storageError = "Some retained Understanding snapshots are unavailable or corrupt.";
      else if (generations.length > this.state.generations.length) this.storageError = "Retained Understanding storage needs pruning; older snapshots beyond its byte or generation limit are withheld.";
    } catch { this.storageError = "Retained Understanding storage is unavailable or corrupt."; }
  }

  private project(id: string): Project {
    const project = this.sources.config.projects.find(item => item.id === id);
    if (!project) throw new Error("source-project");
    return project;
  }

  private inside(root: string, candidate: string) {
    const child = relative(root, candidate);
    return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
  }

  private ownedTeamSession(session: Session): { runId: string; memberId: string } | undefined {
    const assignment = session.team;
    if (!assignment) return undefined;
    const projectId = session.projectId;
    if (assignment.role === "mission-coordinator") {
      return this.sources.missions.understandingOwnsSession(assignment.runId, assignment.memberId, session.id, projectId)
        ? { runId: assignment.runId, memberId: assignment.memberId } : undefined;
    }
    if (this.sources.teams.understandingOwnsSession(assignment.runId, assignment.memberId, session.id, projectId))
      return { runId: assignment.runId, memberId: assignment.memberId };
    return undefined;
  }

  private async capture(session: Session, rootInput: string): Promise<Capture> {
    if (session.workspace || session.executionLocation === "laptop") throw new Error("source-unavailable");
    // V1 artifacts bind one repository. A mission coordinator's inseparable
    // multi-repository context needs a full pinned-source binding before retention.
    if (session.team?.role === "mission-coordinator") throw new Error("mission-brief-source-unavailable");
    const live = this.sources.manager.meta(session.id).session;
    if (live.projectId !== session.projectId || live.cwd !== session.cwd || digest(live.team ?? null) !== digest(session.team ?? null)) throw new Error("session-source-rebound");
    const project = this.project(session.projectId);
    const enrolledPath = resolve(project.path);
    const canonicalProject = realpathSync(enrolledPath);
    const root = realpathSync(rootInput);
    const sourceCwd = realpathSync(session.cwd);
    if (!this.inside(root, sourceCwd)) throw new Error("source-cwd-outside-root");
    const sourceKind = session.team ? "team" : "project";
    let runId: string | undefined, memberId: string | undefined;
    if (sourceKind === "team") {
      const owner = this.ownedTeamSession(session);
      if (!owner) throw new Error("team-source-unproven");
      runId = owner.runId; memberId = owner.memberId;
      const member = this.sources.teams.understandingRecords().find(run => run.id === runId)?.members.find(item => item.memberId === memberId && item.sessionId === session.id);
      if (member && resolve(member.cwd) !== resolve(session.cwd)) throw new Error("team-source-rebound");
    } else if (!this.inside(canonicalProject, root)) throw new Error("source-outside-project");
    const projectStat = statSync(canonicalProject), rootStat = statSync(root), cwdStat = statSync(sourceCwd);
    const identity = captureIdentity(project, readGit);
    const group = this.sources.groups.get(project.id);
    const repo = group.repos.find(value => value.checkouts.some(checkout => checkout.projectId === project.id));
    const expectedIdentity = repo?.key;
    if (!identity || (expectedIdentity && identity.key !== expectedIdentity)) throw new Error("source-identity-changed");
    return { binding: bindingSchema.parse({
      projectId: project.id, sourceKind, enrolledPath: canonicalProject, root, sourceCwd, projectDevice: String(projectStat.dev), projectInode: String(projectStat.ino),
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), sourceCwdDevice: String(cwdStat.dev), sourceCwdInode: String(cwdStat.ino), repoIdentity: digest(identity.key),
      ...(runId ? { runId } : {}), ...(memberId ? { memberId } : {}),
    }) };
  }

  private async persist(session: Session, root: string, summary: RepositorySummary, captured: unknown): Promise<void> {
    const capture = captured as Capture;
    const current = await this.capture(session, root);
    if (digest(capture) !== digest(current)) throw new Error("The enrolled source changed while its brief was generated.");
    const brief = summary.repository.brief;
    const artifactId = randomUUID();
    const retained = retainedDiagrams(artifactId, brief.diagrams);
    const artifact: UnderstandingArtifact = artifactSchema.parse({
      id: artifactId, sourceProjectId: session.projectId, sessionId: session.id, sourceKind: capture.binding.sourceKind,
      head: summary.repository.head, base: summary.repository.base, fingerprint: summary.repository.fingerprint,
      generatedAt: summary.repository.generatedAt, retainedAt: new Date().toISOString(),
      coverage: [...summary.repository.coverage.slice(0, Math.max(0, 100 - retained.coverage.length)), ...retained.coverage],
      brief: { summary: brief.summary, architecture: brief.architecture, changes: brief.changes, checks: brief.checks, review: brief.review, guidance: brief.guidance, unknowns: brief.unknowns, diagrams: retained.diagrams },
      evidence: summary.repository.evidence.map(item => ({ source: item.source, line: item.line, text: item.text })),
    });
    const entry = entrySchema.parse({ binding: capture.binding, artifact });
    let candidate: State;
    const raw = JSON.stringify(entry), file = join(this.directory, `${artifact.id}.sealed`);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const sizes = new Map(readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.sealed$/.test(name)).map(name => [name.slice(0, -7), statSync(join(this.directory, name)).size]));
      // Only known unacknowledged writes or validated, superseded generations
      // can be reclaimed before publication; the current acknowledged set stays intact.
      for (const id of this.pendingPrune) {
        this.removeTemporaryArtifact(id);
        if (sizes.has(id)) { unlinkSync(join(this.directory, `${id}.sealed`)); sizes.delete(id); }
        this.pendingPrune.delete(id);
      }
      // Interrupted writes from an earlier process still consume disk even when
      // their UUID is not ours to clean up during this attempt.
      const temporaryBytes = readdirSync(this.directory).filter(name => TEMPORARY_ARTIFACT.test(name))
        .reduce((total, name) => total + statSync(join(this.directory, name)).size, 0);
      const currentBytes = [...sizes.values()].reduce((total, size) => total + size, temporaryBytes);
      const newBytes = Math.ceil(Buffer.byteLength(raw) * 1.5) + 256;
      if (newBytes > MAX_ARTIFACT_BYTES || newBytes + currentBytes > MAX_STORE_BYTES + MAX_ARTIFACT_BYTES) throw new Error("Retained brief storage limit reached.");
      sizes.set(artifact.id, newBytes);
      candidate = { version: 1, generations: retainedGenerations([...this.state.generations, entry], sizes) };
      writeSealed(file, this.sources.key, "understanding-artifact", entry);
    } catch (error) {
      this.pendingPrune.add(artifact.id);
      try { this.removeTemporaryArtifact(artifact.id); }
      catch { /* Retry this exact prefix before any subsequent publication. */ }
      this.storageError = "The latest brief could not be durably retained; prior snapshots remain available.";
      throw error;
    }
    this.state = candidate;
    try {
      const keep = new Set(candidate.generations.map(item => `${item.artifact.id}.sealed`));
      const oldFiles = readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.sealed$/.test(name) && !keep.has(name));
      for (const oldFile of oldFiles) this.pendingPrune.add(oldFile.slice(0, -7));
      for (const oldFile of oldFiles) { unlinkSync(join(this.directory, oldFile)); this.pendingPrune.delete(oldFile.slice(0, -7)); }
      this.storageError = undefined;
    } catch { this.storageError = "A retained brief was written, but storage pruning needs attention."; }
  }

  private removeTemporaryArtifact(id: string): void {
    for (const name of readdirSync(this.directory))
      if (name.startsWith(`${id}.sealed.`) && TEMPORARY_ARTIFACT.test(name)) unlinkSync(join(this.directory, name));
  }

  private projectBinding(project: Project, expectedIdentity: string | undefined): ProjectBinding | undefined {
    try {
      const enrolledPath = realpathSync(project.path), info = statSync(enrolledPath);
      const identity = captureIdentity(project, readGit);
      if (!identity || (expectedIdentity && identity.key !== expectedIdentity)) return undefined;
      return { enrolledPath, projectDevice: String(info.dev), projectInode: String(info.ino), repoIdentity: digest(identity.key) };
    } catch { return undefined; }
  }

  private visibleEntry(entry: Entry, project: ProjectBinding): boolean {
    const expected = entry.binding;
    if (expected.projectId !== entry.artifact.sourceProjectId || expected.sourceKind !== entry.artifact.sourceKind ||
        project.enrolledPath !== expected.enrolledPath || project.projectDevice !== expected.projectDevice ||
        project.projectInode !== expected.projectInode || project.repoIdentity !== expected.repoIdentity) return false;
    let cwd = expected.sourceCwd;
    if (expected.sourceKind === "team") {
      const session = this.sources.manager.meta(entry.artifact.sessionId).session;
      if (session.team?.role === "mission-coordinator") return false;
      if (session.projectId !== expected.projectId || !session.team || session.team.runId !== expected.runId || session.team.memberId !== expected.memberId) return false;
      const owner = this.ownedTeamSession(session);
      if (!owner || owner.runId !== expected.runId || owner.memberId !== expected.memberId) return false;
      const run = this.sources.teams.understandingRecords().find(item => item.id === owner.runId);
      const member = run?.members.find(item => item.memberId === owner.memberId && item.sessionId === session.id);
      if (!member || resolve(member.cwd) !== resolve(session.cwd)) return false;
      cwd = session.cwd;
    }
    const root = realpathSync(expected.root), sourceCwd = realpathSync(cwd), rootStat = statSync(root), cwdStat = statSync(sourceCwd);
    if (!this.inside(root, sourceCwd) || (expected.sourceKind === "project" && !this.inside(project.enrolledPath, root))) return false;
    return root === expected.root && String(rootStat.dev) === expected.rootDevice && String(rootStat.ino) === expected.rootInode &&
      sourceCwd === expected.sourceCwd && String(cwdStat.dev) === expected.sourceCwdDevice && String(cwdStat.ino) === expected.sourceCwdInode;
  }

  private repoIds(group: ProjectGroup) { return new Set(group.repos.flatMap(repo => repo.checkouts.map(checkout => checkout.projectId))); }

  private workRows(group: ProjectGroup): UnderstandingWork[] {
    const ids = this.repoIds(group), rows: UnderstandingWork[] = [];
    const add = (value: Omit<UnderstandingWork, "briefIds" | "links" | "scope"> & { briefIds?: string[]; links?: UnderstandingLink[] }) => {
      const matching = value.repositoryIds.filter(id => ids.has(id));
      if (!matching.length) return;
      const scope = matching.length === value.repositoryIds.length ? "complete" : "partial";
      const repositoryIds = [...new Set(matching.map(id => group.repos.find(repo => repo.checkouts.some(checkout => checkout.projectId === id))?.projectId ?? id))];
      rows.push({ ...value, repositoryIds, scope, ...(scope === "partial" ? { title: "Cross-workspace work item", objective: null, reportedSummary: null, links: [], briefIds: [] } : {}),
        briefIds: scope === "partial" ? [] : value.briefIds ?? [], links: scope === "partial" ? [] : value.links ?? [] });
    };
    const column = (status: string): UnderstandingWork["column"] => status === "needs-input" || status === "blocked" ? "needs-input" : status === "ready-for-review" ? "review" : ["cancelled", "merged", "no-change", "achieved", "no-opportunity", "limit-reached"].includes(status) ? "ended" : "working";
    for (const mission of this.sources.missions.understandingRecords()) add({ id: `mission:${mission.id}`, sourceId: mission.id, kind: "mission", title: mission.title, objective: mission.objective,
      reportedSummary: mission.result?.summary ?? mission.reason ?? null, status: mission.status, column: column(mission.status), updatedAt: mission.updatedAt,
      repositoryIds: [...mission.repoProjectIds], briefIds: [], links: [] });
    const teams = this.sources.teams.understandingRecords();
    for (const team of teams) {
      if (team.missionId || team.goal) continue;
      const links: UnderstandingLink[] = [];
      for (const url of [team.pullRequest?.pullRequestUrl, team.deliveryReceipt?.pullRequestUrl]) {
        const safe = safeUrl(url); if (safe && !links.some(link => link.url === safe)) links.push({ kind: "pr", label: "Pull request", url: safe });
      }
      add({ id: `team:${team.id}`, sourceId: team.id, kind: "team", title: team.title, objective: team.objective,
      reportedSummary: team.noChange?.summary ?? team.deliveryReceipt?.summary ?? team.pullRequest?.summary ?? null,
        status: team.status, column: column(team.status), updatedAt: team.updatedAt, repositoryIds: [team.projectId], briefIds: [], links });
    }
    for (const goal of this.sources.goals.understandingRecords()) add({ id: `goal:${goal.id}`, sourceId: goal.id, kind: "goal", title: goal.title, objective: goal.objective,
      reportedSummary: goal.outcomes.at(-1)?.summary ?? goal.reason ?? null, status: goal.status, column: column(goal.status), updatedAt: goal.updatedAt,
      repositoryIds: [goal.projectId], briefIds: [], links: [] });
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  list(): ProjectGroupList { return this.sources.groups.list(); }

  private workspace(id: string): ProjectGroup {
    const group = this.sources.groups.get(projectIdSchema.parse(id));
    if (group.id !== id) throw new CatalogError(404, "This workspace no longer exists at this address.");
    return group;
  }

  workReferences(id: string): UnderstandingWork[] {
    return this.workRows(this.workspace(id));
  }

  get(id: string): WorkspaceUnderstanding {
    const group = this.workspace(id);
    // One membership snapshot and one Git capture per checkout per request. Never reuse
    // these across reads: a rebind or same-path replacement must invalidate the next read.
    const projects = new Map<string, ProjectBinding | undefined>();
    const bindings = new Map<string, boolean>();
    const rows = this.workRows(group);
    const currentWork = rows.filter(item => item.scope === "complete");
    const briefingStates = new Map((this.sources.briefings?.understandingStatuses() ?? []).map(value => [value.sessionId, value]));
    const repositories: UnderstandingRepository[] = group.repos.map(repo => {
      const checkoutIds = repo.checkouts.map(checkout => checkout.projectId), checkouts = new Set(checkoutIds);
      const current = this.state.generations.filter(entry => {
        if (!checkouts.has(entry.artifact.sourceProjectId)) return false;
        const project = this.sources.config.projects.find(item => item.id === entry.artifact.sourceProjectId);
        if (!project) return false;
        if (!projects.has(project.id)) projects.set(project.id, this.projectBinding(project, repo.key));
        const currentProject = projects.get(project.id);
        if (!currentProject) return false;
        const key = digest([entry.binding, entry.artifact.sourceProjectId, entry.artifact.sourceKind, entry.binding.sourceKind === "team" ? entry.artifact.sessionId : null]);
        if (!bindings.has(key)) {
          try { bindings.set(key, this.visibleEntry(entry, currentProject)); } catch { bindings.set(key, false); }
        }
        return bindings.get(key)!;
      }).map(entry => entry.artifact).sort((a, b) => b.retainedAt.localeCompare(a.retainedAt) || a.id.localeCompare(b.id));
      const activeStates: string[] = [];
      for (const [sessionId, state] of briefingStates) {
        if (!["pending", "running", "failed"].includes(state.state)) continue;
        if (state.state === "failed" && current.length && state.updatedAt <= Date.parse(current[0]!.retainedAt)) continue;
        try {
          const session = this.sources.manager.meta(sessionId).session;
          if (!checkouts.has(session.projectId)) continue;
          if (session.team && !this.ownedTeamSession(session)) continue;
          activeStates.push(state.state);
        } catch { /* closed or unavailable sessions do not alter retained artifact visibility */ }
      }
      const planned: UnderstandingPlan[] = currentWork.filter(work => work.repositoryIds.some(projectId => checkouts.has(projectId))).map(work => ({
        workId: work.id, kind: work.kind, title: work.title, text: work.objective ?? "", status: work.status, updatedAt: work.updatedAt, source: "request" as const,
      })).filter(item => item.text.length > 0);
      const warnings = this.storageError ? [this.storageError] : [];
      if (activeStates.includes("failed")) warnings.push("The latest recorded briefing attempt failed; retained snapshots remain source-labeled.");
      const state: UnderstandingRepository["state"] = activeStates.includes("pending") || activeStates.includes("running") ? "updating" : activeStates.includes("failed") ? "failed" : this.storageError && !current.length ? "unavailable" : current.length ? "ready" : "empty";
      return { id: repo.projectId, name: repo.name, checkoutIds, state, current, planned, warnings, coverage: [] };
    });
    const work = rows.map(item => ({ ...item, briefIds: [] }));
    return boundedResponse({ schemaVersion: 1, workspace: { id: group.id, name: group.name, revision: group.revision }, observedAt: new Date().toISOString(), work, repositories,
      ...(this.sources.knowledge ? { knowledge: this.sources.knowledge.read(id) } : {}),
      coverage: ["Work execution, owner feature assessments, agent reports and provider delivery observations are separate sources. Repository briefs describe their labeled source snapshots.", "Repository briefs are not linked to individual work items unless an explicit association is recorded." ] });
  }
}

/** Parse and validate writer diagrams at persist time; retain source when the parsed graph is outside the artifact schema. */
export function retainedDiagrams(artifactId: string, sources: { title: string; kind: "system" | "change"; mermaid: string; citations: { source: string; line: number }[] }[]): { diagrams: Diagram[]; coverage: string[] } {
  const diagrams: Diagram[] = [], coverage: string[] = [];
  sources.forEach((source, index) => {
    const base = { id: `${artifactId}:${index}`, title: source.title, kind: source.kind, basis: "model" as const, citations: source.citations };
    const parsed = parseMermaid(source.mermaid);
    const candidate = parsed.ok && parsed.diagram.nodes.length <= MAX_DIAGRAM_NODES && parsed.diagram.edges.length <= MAX_DIAGRAM_EDGES
      ? { ...base, direction: parsed.diagram.direction, nodes: parsed.diagram.nodes, edges: parsed.diagram.edges, groups: parsed.diagram.groups,
        ...(parsed.diagram.sequence ? { sequence: parsed.diagram.sequence } : {}), coverage: parsed.coverage }
      : undefined;
    if (candidate) {
      const validated = diagramSchema.safeParse(candidate);
      if (validated.success) { diagrams.push(validated.data); return; }
    }
    const parseError = candidate
      ? "The parsed diagram exceeds the retained schema limits."
      : parsed.ok ? "The diagram exceeds the retained node or edge limit." : parsed.error;
    const fallback = { ...base, direction: "LR" as const, nodes: [], edges: [], groups: [], sourceText: source.mermaid, parseError, coverage: [] };
    const validatedFallback = diagramSchema.safeParse(fallback);
    if (validatedFallback.success) diagrams.push(validatedFallback.data);
    else coverage.push("A diagram was omitted because its parsed graph and source fallback failed retained schema validation.");
  });
  return { diagrams, coverage };
}

function retainedGenerations(entries: Entry[], sizes: Map<string, number>): Entry[] {
  let remaining = MAX_STORE_BYTES, count = 0;
  return [...entries].sort((a, b) => b.artifact.retainedAt.localeCompare(a.artifact.retainedAt) || a.artifact.id.localeCompare(b.artifact.id)).filter(entry => {
    const size = sizes.get(entry.artifact.id) ?? Infinity;
    if (count >= MAX_GENERATIONS || size > remaining) return false;
    count++; remaining -= size; return true;
  });
}

/** Bound complete records rather than cutting source claims or request text. The
 * category budgets leave room for metadata, coverage and encrypted framing. */
function boundedResponse(value: WorkspaceUnderstanding): WorkspaceUnderstanding {
  const knowledge = value.knowledge ? boundedKnowledge(value.knowledge) : undefined;
  const responseBudget = knowledge ? MAX_RESPONSE_BYTES * 5 / 16 : MAX_RESPONSE_BYTES;
  const bytes = (item: unknown) => Buffer.byteLength(JSON.stringify(item)) + 1;
  const select = <T>(items: T[], budget: number) => {
    let used = 0;
    return items.filter(item => { const size = bytes(item); if (used + size > budget) return false; used += size; return true; });
  };
  const work = select(value.work, responseBudget * 3 / 16);
  const coverage = [...value.coverage];
  if (work.length < value.work.length) coverage.push(`Work records: ${work.length} of ${value.work.length} included; ${value.work.length - work.length} omitted from this response to fit its byte limit. Newest records are prioritized; source records remain available in their work views.`);
  const repositories: UnderstandingRepository[] = [];
  const sources = new Map<string, UnderstandingRepository>();
  let metadataBytes = bytes({ ...value, knowledge: undefined, work: [], repositories: [], coverage }) + 1024;
  for (const source of value.repositories) {
    const repository: UnderstandingRepository = { ...source, current: [], planned: [], coverage: [] };
    const size = bytes(repository) + 1024;
    if (metadataBytes + size > responseBudget / 32) continue;
    metadataBytes += size; repositories.push(repository); sources.set(repository.id, source);
  }
  if (repositories.length < value.repositories.length) coverage.push(`Repositories: ${repositories.length} of ${value.repositories.length} included; ${value.repositories.length - repositories.length} omitted from this response to fit its byte limit. Omission does not mean those repositories have no work or snapshots.`);

  // Select brief bodies first so large evidence excerpts cannot crowd out the
  // latest source-labeled explanation from another session or repository.
  const candidates = repositories.flatMap(repo => sources.get(repo.id)!.current.map(artifact => ({ repo, artifact })))
    .sort((a, b) => b.artifact.retainedAt.localeCompare(a.artifact.retainedAt) || a.artifact.id.localeCompare(b.artifact.id));
  const seen = new Set<string>(), latest: typeof candidates = [], older: typeof candidates = [];
  for (const item of candidates) {
    const key = `${item.artifact.sourceProjectId}:${item.artifact.sessionId}`;
    (seen.has(key) ? older : latest).push(item); seen.add(key);
  }
  let remaining = responseBudget * 5 / 8;
  const selected: { source: UnderstandingArtifact; artifact: UnderstandingArtifact }[] = [];
  for (const { repo, artifact: source } of [...latest, ...older]) {
    const artifact: UnderstandingArtifact = { ...source, coverage: [...source.coverage], evidence: [] };
    const size = bytes(artifact) + 256; // Reserve the evidence-omission disclosure.
    if (size > remaining) continue;
    remaining -= size; repo.current.push(artifact); selected.push({ source, artifact });
  }
  for (const { source, artifact } of selected) {
    for (const excerpt of source.evidence) {
      const size = bytes(excerpt);
      if (size > remaining) break;
      remaining -= size; artifact.evidence.push(excerpt);
    }
    if (artifact.evidence.length < source.evidence.length) artifact.coverage.push(`Evidence excerpts: ${artifact.evidence.length} of ${source.evidence.length} included; ${source.evidence.length - artifact.evidence.length} omitted from this response to fit its byte limit. Complete excerpts remain retained on the host.`);
  }
  let plannedRemaining = responseBudget / 16;
  for (const repo of repositories) {
    const source = sources.get(repo.id)!;
    repo.current.sort((a, b) => b.retainedAt.localeCompare(a.retainedAt) || a.id.localeCompare(b.id));
    if (repo.current.length < source.current.length) {
      repo.coverage.push(`Retained snapshots: ${repo.current.length} of ${source.current.length} included; ${source.current.length - repo.current.length} omitted from this response to fit its byte limit. Older generations remain retained on the host.`);
      if (!repo.current.length && repo.state === "ready") repo.state = "unavailable";
    }
    repo.planned = select(source.planned, plannedRemaining);
    plannedRemaining -= repo.planned.reduce((size, item) => size + bytes(item), 0);
    if (repo.planned.length < source.planned.length) repo.coverage.push(`Planned requests: ${repo.planned.length} of ${source.planned.length} included; ${source.planned.length - repo.planned.length} omitted from this response to fit its byte limit. Complete requests remain in their source work records.`);
  }
  return { ...value, ...(knowledge ? { knowledge } : {}), work, repositories, coverage };
}

/** Keep the catalog whole for revisioned edits; complete component detail is also
 * available by ID. Omitted graph nodes never leave misleading dangling edges. */
function boundedKnowledge(value: WorkspaceKnowledge): WorkspaceKnowledge {
  const result: WorkspaceKnowledge = { ...value, components: [], relationships: [], delivery: [], coverage: [...value.coverage] };
  const size = (item: unknown) => Buffer.byteLength(JSON.stringify(item));
  const limit = MAX_RESPONSE_BYTES * 5 / 8;
  if (size(result) > limit - 4096) {
    result.catalog = { ...value.catalog, projects: [], features: [], plans: [], componentOverrides: [], coverage: [...value.catalog.coverage, "Catalog records omitted from the overview because they exceed its byte limit. Read the catalog endpoint for the complete revision."] };
  }
  let remaining = limit - size(result) - 4096;
  for (const key of ["components", "delivery"] as const) {
    const selected = value[key].filter(item => { const bytes = size(item) + 1; if (bytes > remaining) return false; remaining -= bytes; return true; });
    if (key === "components") result.components = selected as WorkspaceKnowledge["components"];
    else result.delivery = selected as WorkspaceKnowledge["delivery"];
    if (selected.length < value[key].length) result.coverage.push(`${key}: ${selected.length} of ${value[key].length} included in this bounded overview. Component details remain available by ID.`);
  }
  const ids = new Set(result.components.map(component => component.id));
  result.relationships = value.relationships.filter(edge => {
    if (!ids.has(edge.from) || !ids.has(edge.to)) return false;
    const bytes = size(edge) + 1; if (bytes > remaining) return false; remaining -= bytes; return true;
  });
  if (result.relationships.length < value.relationships.length) result.coverage.push(`Relationships: ${result.relationships.length} of ${value.relationships.length} included; omitted nodes and edges are not evidence of absent dependencies.`);
  return result;
}

function safeUrl(value: string | undefined): string | undefined {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" ? url.toString() : undefined; } catch { return undefined; }
}
