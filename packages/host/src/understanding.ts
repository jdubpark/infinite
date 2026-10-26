import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { z } from "zod";
import type { GeneratedCatalogPage, GeneratedPlan, GeneratedProject, UnderstandingArtifact, UnderstandingLink, UnderstandingPlan, UnderstandingRepository, UnderstandingWork, WorkspaceUnderstanding, WorkspaceKnowledge } from "@infinite/remote";
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
import { pageOf } from "./understanding-pages.js";

const MAX_GENERATIONS_PER_PROJECT = 16;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
// Runtime output is capped at 1 MiB before sealing. Keep one bounded generation
// of publication headroom so a full store can advance without deleting evidence first.
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const TEMPORARY_ARTIFACT = /^[0-9a-f-]{36}\.sealed\.[0-9a-f]{16}\.tmp$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const projectIdSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
const citationSchema = z.object({ source: z.string().min(1).max(1024), line: z.number().int().positive() }).strict();
const claimSchema = z.object({ text: z.string().min(1).max(900), citations: z.array(citationSchema).max(6) }).strict();
const briefSchema = z.object({
  summary: z.string().min(1).max(600), architecture: z.array(claimSchema).max(6), changes: z.array(claimSchema).max(6), checks: z.array(claimSchema).max(4),
  review: z.array(z.object({ priority: z.enum(["high", "medium"]), area: z.string().min(1).max(150), why: z.string().min(1).max(900), question: z.string().min(1).max(900), citations: z.array(citationSchema).max(6) }).strict()).max(5),
  guidance: z.array(z.object({ text: z.string().min(1).max(900), basis: z.enum(["documented", "proposed"]), citations: z.array(citationSchema).max(6) }).strict()).max(4),
  unknowns: z.array(z.string().min(1).max(900)).max(8),
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
    const artifact: UnderstandingArtifact = artifactSchema.parse({
      id: randomUUID(), sourceProjectId: session.projectId, sessionId: session.id, sourceKind: capture.binding.sourceKind,
      head: summary.repository.head, base: summary.repository.base, fingerprint: summary.repository.fingerprint,
      generatedAt: summary.repository.generatedAt, retainedAt: new Date().toISOString(), coverage: summary.repository.coverage,
      brief: { summary: brief.summary, architecture: brief.architecture, changes: brief.changes, checks: brief.checks, review: brief.review, guidance: brief.guidance, unknowns: brief.unknowns },
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
    // Team member workspaces are deleted after a run. When the session record or run membership is gone,
    // or the workspace paths no longer resolve, the matching repository binding and a recorded head suffice.
    const retained = !!entry.artifact.head;
    if (expected.sourceKind === "team") {
      let session: Session | undefined;
      try { session = this.sources.manager.meta(entry.artifact.sessionId).session; } catch { session = undefined; }
      if (!session) return retained;
      if (session.team?.role === "mission-coordinator") return false;
      if (session.projectId !== expected.projectId || !session.team || session.team.runId !== expected.runId || session.team.memberId !== expected.memberId) return false;
      const owner = this.ownedTeamSession(session);
      if (!owner || owner.runId !== expected.runId || owner.memberId !== expected.memberId) return false;
      const run = this.sources.teams.understandingRecords().find(item => item.id === owner.runId);
      const member = run?.members.find(item => item.memberId === owner.memberId && item.sessionId === session.id);
      if (!member) return retained;
      if (resolve(member.cwd) !== resolve(session.cwd)) return false;
      cwd = session.cwd;
    }
    let root: string, sourceCwd: string, rootStat: Stats, cwdStat: Stats;
    try { root = realpathSync(expected.root); sourceCwd = realpathSync(cwd); rootStat = statSync(root); cwdStat = statSync(sourceCwd); }
    catch (error) { if (expected.sourceKind === "team") return retained; throw error; }
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

  /** Unbounded read: complete request text and every retained snapshot. Overview and pages both derive from it. */
  private build(id: string): WorkspaceUnderstanding {
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
      const activeStates: string[] = [], failedReasons: string[] = [];
      for (const [sessionId, state] of briefingStates) {
        if (!["pending", "running", "failed"].includes(state.state)) continue;
        if (state.state === "failed" && current.length && state.updatedAt <= Date.parse(current[0]!.retainedAt)) continue;
        try {
          const session = this.sources.manager.meta(sessionId).session;
          if (!checkouts.has(session.projectId)) continue;
          if (session.team && !this.ownedTeamSession(session)) continue;
          activeStates.push(state.state);
          if (state.state === "failed") failedReasons.push(state.error?.split("Reason: ").slice(1).join("Reason: ") || state.error || "unknown");
        } catch { /* closed or unavailable sessions do not alter retained artifact visibility */ }
      }
      const planned: UnderstandingPlan[] = currentWork.filter(work => work.repositoryIds.some(projectId => checkouts.has(projectId))).map(work => ({
        workId: work.id, kind: work.kind, title: work.title, text: work.objective ?? "", status: work.status, updatedAt: work.updatedAt, source: "request" as const, excerpt: false,
      })).filter(item => item.text.length > 0);
      const warnings = this.storageError ? [this.storageError] : [];
      if (activeStates.includes("failed")) warnings.push(`The latest brief attempt failed: ${failedReasons[0]}`);
      const state: UnderstandingRepository["state"] = activeStates.includes("pending") || activeStates.includes("running") ? "updating" : activeStates.includes("failed") ? "failed" : this.storageError && !current.length ? "unavailable" : current.length ? "ready" : "empty";
      return { id: repo.projectId, name: repo.name, checkoutIds, state, current, planned, warnings, coverage: [] };
    });
    const work = rows.map(item => ({ ...item, briefIds: [] }));
    return { schemaVersion: 1, workspace: { id: group.id, name: group.name, revision: group.revision }, observedAt: new Date().toISOString(), work, repositories,
      ...(this.sources.knowledge ? { knowledge: this.sources.knowledge.read(id) } : {}),
      coverage: ["Work execution, owner feature assessments, agent reports and provider delivery observations are separate sources. Repository briefs describe their labeled source snapshots.", "Repository briefs are not linked to individual work items unless an explicit association is recorded." ] };
  }

  get(id: string): WorkspaceUnderstanding {
    const value = this.build(id);
    return boundedResponse({ ...value, repositories: value.repositories.map(repo => ({ ...repo, planned: repo.planned.map(excerptOf) })) });
  }

  briefsPage(workspaceId: string, repositoryId: string, cursor?: string) {
    const repo = this.build(workspaceId).repositories.find(item => item.id === repositoryId);
    return pageOf(repo?.current ?? [], cursor, item => item.id);
  }

  plannedPage(workspaceId: string, repositoryId: string, cursor?: string) {
    const repo = this.build(workspaceId).repositories.find(item => item.id === repositoryId);
    return pageOf((repo?.planned ?? []).map(plan => ({ ...plan, excerpt: false })), cursor, item => item.workId);
  }

  workPage(workspaceId: string, cursor?: string) {
    return pageOf(this.build(workspaceId).work, cursor, item => item.id);
  }

  /** Derived at read time from recorded work. Never stored, so the owner catalog revision is untouched. */
  generatedPage(workspaceId: string, cursor?: string): GeneratedCatalogPage {
    const group = this.workspace(workspaceId);
    const repositoryOf = new Map(group.repos.flatMap(repo => repo.checkouts.map(checkout => [checkout.projectId, repo.projectId] as const)));
    const plans: GeneratedPlan[] = this.workRows(group).filter(work => work.scope === "complete" && work.objective).map(work => ({
      id: `plan:${work.id}`, workId: work.id, kind: work.kind, title: work.title, objective: work.objective!,
      repositoryIds: [...new Set(work.repositoryIds.flatMap(id => repositoryOf.get(id) ?? []))], status: work.status, column: work.column,
      outcome: work.reportedSummary, links: work.links, updatedAt: work.updatedAt, basis: "work" as const,
    }));
    const projects: GeneratedProject[] = group.repos.map(repo => ({
      id: `project:${repo.projectId}`, name: repo.name, repositoryIds: [repo.projectId],
      planIds: plans.filter(plan => plan.repositoryIds.includes(repo.projectId)).map(plan => plan.id), basis: "repository" as const,
    }));
    const page = pageOf(plans, cursor, plan => plan.id);
    return { projects, plans: page.items, next: page.next, coverage: ["From work: derived from recorded team, mission and goal requests. Status is the run's own status."] };
  }
}

function retainedGenerations(entries: Entry[], sizes: Map<string, number>): Entry[] {
  let remaining = MAX_STORE_BYTES;
  const perProject = new Map<string, number>();
  return [...entries].sort((a, b) => b.artifact.retainedAt.localeCompare(a.artifact.retainedAt) || a.artifact.id.localeCompare(b.artifact.id)).filter(entry => {
    const size = sizes.get(entry.artifact.id) ?? Infinity, count = perProject.get(entry.artifact.sourceProjectId) ?? 0;
    if (count >= MAX_GENERATIONS_PER_PROJECT || size > remaining) return false;
    perProject.set(entry.artifact.sourceProjectId, count + 1); remaining -= size; return true;
  });
}

const PLAN_EXCERPT_CHARS = 600;
function excerptOf(plan: UnderstandingPlan): UnderstandingPlan {
  return plan.text.length > PLAN_EXCERPT_CHARS ? { ...plan, text: plan.text.slice(0, PLAN_EXCERPT_CHARS), excerpt: true } : plan;
}

const shown = (category: string, included: number, total: number) => `${category}: ${included} of ${total} shown here; the rest are available on the detail pages.`;

/** One first-come budget, spent in a fixed order on whole records. Anything left out is
 * reachable through the paged detail endpoints, and the catalog is never emptied. */
export function boundedResponse(value: WorkspaceUnderstanding): WorkspaceUnderstanding {
  const bytes = (item: unknown) => Buffer.byteLength(JSON.stringify(item)) + 1;
  let remaining = MAX_RESPONSE_BYTES - 64 * 1024;
  const take = (item: unknown) => { const size = bytes(item); if (size > remaining) return false; remaining -= size; return true; };
  const coverage = [...value.coverage];
  remaining -= bytes({ ...value, knowledge: undefined, work: [], repositories: [], coverage }) + 8192; // Room for the omission lines.

  const repositories = value.repositories.map(source => ({ ...source, current: [], planned: [], coverage: [] }) as UnderstandingRepository);
  for (const repo of repositories) remaining -= bytes(repo);
  const knowledge = value.knowledge;
  const result: WorkspaceKnowledge | undefined = knowledge && { ...knowledge, briefs: [], diagrams: [], components: [], relationships: [], delivery: [], coverage: [...knowledge.coverage] };
  if (result) remaining -= bytes(result);

  const selected: { source: UnderstandingArtifact; artifact: UnderstandingArtifact }[] = [];
  const addArtifact = (repo: UnderstandingRepository, source: UnderstandingArtifact) => {
    const artifact: UnderstandingArtifact = { ...source, coverage: [...source.coverage], evidence: [] };
    if (!take(artifact)) return;
    remaining -= 256; // Reserve the evidence line.
    repo.current.push(artifact); selected.push({ source, artifact });
  };
  const sourceOf = (repo: UnderstandingRepository) => value.repositories.find(item => item.id === repo.id)!;
  for (const repo of repositories) { const [newest] = sourceOf(repo).current; if (newest) addArtifact(repo, newest); }

  const work: UnderstandingWork[] = [];
  for (const item of value.work) if (take(item)) work.push(item);

  for (const repo of repositories) for (const plan of sourceOf(repo).planned) if (take(plan)) repo.planned.push(plan);

  if (knowledge && result) {
    const takeAll = <T>(items: T[] | undefined, label: string, keep: (item: T) => boolean = () => true): T[] => {
      const all = items ?? [], chosen = all.filter(item => keep(item) && take(item));
      if (chosen.length < all.length) result.coverage.push(shown(label, chosen.length, all.length));
      return chosen;
    };
    result.components = takeAll(knowledge.components, "Components");
    const kept = new Set(result.components.map(component => component.id));
    result.relationships = takeAll(knowledge.relationships, "Relationships", edge => kept.has(edge.from) && kept.has(edge.to));
    result.delivery = takeAll(knowledge.delivery, "Delivery");
    result.briefs = takeAll(knowledge.briefs, "Briefs");
    result.diagrams = takeAll(knowledge.diagrams, "Diagrams");
  }

  for (const repo of repositories) for (const source of sourceOf(repo).current.slice(1)) addArtifact(repo, source);
  for (const { source, artifact } of selected) {
    for (const excerpt of source.evidence) {
      if (!take(excerpt)) break;
      artifact.evidence.push(excerpt);
    }
    if (artifact.evidence.length < source.evidence.length) artifact.coverage.push(shown("Evidence excerpts", artifact.evidence.length, source.evidence.length));
  }

  if (work.length < value.work.length) coverage.push(shown("Work", work.length, value.work.length));
  for (const repo of repositories) {
    const source = sourceOf(repo);
    repo.current.sort((a, b) => b.retainedAt.localeCompare(a.retainedAt) || a.id.localeCompare(b.id));
    if (repo.current.length < source.current.length) {
      repo.coverage.push(shown("Retained snapshots", repo.current.length, source.current.length));
      if (!repo.current.length && repo.state === "ready") repo.state = "unavailable";
    }
    if (repo.planned.length < source.planned.length) repo.coverage.push(shown("Planned requests", repo.planned.length, source.planned.length));
  }
  return { ...value, ...(result ? { knowledge: result } : {}), work, repositories, coverage };
}

function safeUrl(value: string | undefined): string | undefined {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" ? url.toString() : undefined; } catch { return undefined; }
}
