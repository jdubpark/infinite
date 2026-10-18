import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { validateLinearConfig } from "./config.js";
import type { Config, Project } from "./types.js";
import { teamProjectSchema, type TeamCommand } from "./team-types.js";
import { TeamError, teamCommand } from "./team-workspace.js";
import { unseal, writeSealed } from "./vault.js";

const enrollmentTeamSchema = teamProjectSchema;
const enrollmentLinearSchema = z.object({ teamId: z.uuid(), projectId: z.uuid().optional() }).strict();
export const repoEnrollmentRequestSchema = z.object({
  requestId: z.uuid(),
  revision: z.number().int().min(0),
  team: enrollmentTeamSchema,
  linear: z.union([enrollmentLinearSchema, z.null()]).optional(),
}).strict();
export type RepoEnrollmentRequest = z.infer<typeof repoEnrollmentRequestSchema>;

export interface RepoEnrollmentView {
  id: string;
  name: string;
  path: string;
  team?: z.infer<typeof enrollmentTeamSchema>;
  linear?: z.infer<typeof enrollmentLinearSchema>;
  revision: number;
  execution: "cloud" | "local";
  hostSetup: { ready: boolean; missing: string[] };
}

interface StoredEnrollment {
  path: string;
  team: z.infer<typeof enrollmentTeamSchema>;
  /** null records an explicit removal; absence means no project overlay was saved. */
  linear?: z.infer<typeof enrollmentLinearSchema> | null;
  revision: number;
}
interface Receipt { fingerprint: string; projectId: string; path: string; response: RepoEnrollmentView }
interface EnrollmentStore { version: 1; projects: Record<string, StoredEnrollment>; requests: Record<string, Receipt> }
interface Options { isBusy?: (projectId: string) => boolean | Promise<boolean> }

const emptyStore = (): EnrollmentStore => ({ version: 1, projects: {}, requests: {} });
const canonicalPath = (path: string) => realpathSync(resolve(path));
const fingerprint = (value: RepoEnrollmentRequest) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Applies owner-authenticated team enrollment overlays after mirrored projects have loaded. */
export class RepoEnrollmentService {
  private readonly file: string;
  private store: EnrollmentStore;
  private mutation = Promise.resolve();

  constructor(private readonly config: Config, private readonly key: Buffer, private readonly options: Options = {}) {
    this.file = join(config.stateDir, "repo-enrollments.sealed");
    this.store = existsSync(this.file) ? unseal<EnrollmentStore>(key, "repo-enrollments", readFileSync(this.file, "utf8")) : emptyStore();
    if (this.store.version !== 1 || !this.store.projects || !this.store.requests) throw new Error("Unsupported repository enrollment store");
    this.applyOverlays();
  }

  get(projectId: string): RepoEnrollmentView {
    const project = this.project(projectId);
    const saved = this.store.projects[projectId];
    this.assertPathBinding(project, saved);
    this.assertProjectPathAllowed(this.projectPath(project));
    return this.view(project, saved?.revision ?? 0);
  }

  async put(projectId: string, input: RepoEnrollmentRequest): Promise<RepoEnrollmentView> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await this.putLocked(projectId, input); }
    finally { release(); }
  }

  private async putLocked(projectId: string, input: RepoEnrollmentRequest): Promise<RepoEnrollmentView> {
    const request = repoEnrollmentRequestSchema.parse(input);
    const project = this.project(projectId);
    const path = this.projectPath(project);
    const requestFingerprint = fingerprint(request);
    const prior = this.store.requests[request.requestId];
    if (prior) {
      if (prior.fingerprint !== requestFingerprint || prior.projectId !== projectId)
        throw new TeamError(409, "request-conflict", "This request ID belongs to a different repository enrollment request.");
      if (prior.path !== path) throw this.pathMismatch();
      return structuredClone(prior.response);
    }

    const current = this.store.projects[projectId];
    this.assertPathBinding(project, current);
    const revision = current?.revision ?? 0;
    if (request.revision !== revision) throw new TeamError(409, "stale-enrollment-revision", "The repository enrollment changed. Refresh it before saving.");
    if (!this.config.teams) throw new TeamError(409, "teams-not-configured", "Configure the host team workspace before enrolling a repository.");
    if (!this.config.teams.commandPrefix && Object.values(this.config.agents).some(agent => agent && /(^|\/)sudo$/.test(agent.command)))
      throw new TeamError(409, "team-execution-identity-required", "Configure a team command prefix for the provider execution identity before enrolling this repository.");
    if (await this.options.isBusy?.(projectId)) throw new TeamError(409, "project-busy", "Repository enrollment cannot change while a team run or project synchronization is active.");

    this.assertProjectPathAllowed(path);
    const commit = await this.assertCleanGitRoot(project.path, this.config.teams?.commandPrefix);
    if (!commit) throw new TeamError(409, "project-git-head-required", "Commit the repository before enrolling it for team work.");

    const nextRevision = revision + 1;
    const inheritedLinear = current && Object.hasOwn(current, "linear") ? current.linear : project.linear ?? null;
    const entry: StoredEnrollment = {
      path,
      team: structuredClone(request.team),
      linear: request.linear === undefined ? inheritedLinear : request.linear,
      revision: nextRevision,
    };
    const prospective: Config = { ...this.config, projects: this.config.projects.map(item => item.id === projectId ? { ...item, team: entry.team, ...(entry.linear === null ? { linear: undefined } : entry.linear ? { linear: entry.linear } : {}) } : item) };
    try { validateLinearConfig(prospective); }
    catch { throw new TeamError(409, "linear-configuration-invalid", "The requested Linear mapping conflicts with the host credential or protected workspace paths."); }
    if (await this.options.isBusy?.(projectId)) throw new TeamError(409, "project-busy", "Repository enrollment cannot change while a team run or project synchronization is active.");
    if (this.projectPath(project) !== path || await this.assertCleanGitRoot(project.path, this.config.teams.commandPrefix) !== commit)
      throw new TeamError(409, "project-changed", "The repository changed during enrollment validation. Refresh it before saving.");

    const responseProject: Project = { ...project, team: entry.team as Project["team"] };
    if (entry.linear) responseProject.linear = entry.linear;
    else delete responseProject.linear;
    const response = this.view(responseProject, nextRevision);
    const next: EnrollmentStore = {
      version: 1,
      projects: { ...this.store.projects, [projectId]: entry },
      requests: { ...this.store.requests, [request.requestId]: { fingerprint: requestFingerprint, projectId, path, response } },
    };
    writeSealed(this.file, this.key, "repo-enrollments", next);
    this.store = next;
    Object.assign(project, { team: entry.team });
    if (entry.linear === null) delete project.linear;
    else if (entry.linear) project.linear = entry.linear;
    return structuredClone(response);
  }

  private project(projectId: string): Project {
    const project = this.config.projects.find(item => item.id === projectId);
    if (!project) throw new TeamError(404, "unknown-project", "The selected project is not configured or mirrored on this host.");
    return project;
  }

  private projectPath(project: Project): string {
    try { return canonicalPath(project.path); }
    catch { throw this.pathMismatch(); }
  }

  private assertPathBinding(project: Project, saved?: StoredEnrollment) {
    if (saved && saved.path !== this.projectPath(project)) throw this.pathMismatch();
  }

  private pathMismatch() { return new TeamError(409, "project-path-mismatch", "The configured repository path no longer matches its saved enrollment."); }

  private assertProjectPathAllowed(path: string) {
    const protectedPaths = [
      this.config.stateDir, this.config.runDir, this.config.keyFile, this.config.teams?.workspaceDir,
      this.config.linear?.apiKeyFile, this.config.push?.accessTokenFile, this.config.remote?.relay?.tokenFile,
      this.config.summaries?.apiKeyFile,
    ].filter((value): value is string => Boolean(value));
    const overlaps = (left: string, right: string) => {
      const rel = relative(left, right);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
    };
    for (const protectedPath of protectedPaths) {
      let protectedRoot: string;
      try { protectedRoot = realpathSync(resolve(protectedPath)); }
      catch { protectedRoot = resolve(protectedPath); }
      if (overlaps(path, protectedRoot) || overlaps(protectedRoot, path))
        throw new TeamError(409, "protected-project-path", "The repository overlaps host runtime, team workspace, or credential storage.");
    }
  }

  private view(project: Project, revision: number): RepoEnrollmentView {
    const missing: string[] = [];
    if (!this.config.teams?.workspaceDir) missing.push("teams.workspaceDir");
    if (!this.config.teams?.commandPrefix && Object.values(this.config.agents).some(agent => agent && /(^|\/)sudo$/.test(agent.command)))
      missing.push("teams.commandPrefix");
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      ...(project.team ? { team: structuredClone(project.team) as RepoEnrollmentView["team"] } : {}),
      ...(project.linear ? { linear: { ...project.linear } } : {}),
      revision,
      execution: this.config.environment === "cloud" ? "cloud" : "local",
      hostSetup: { ready: missing.length === 0, missing },
    };
  }

  private applyOverlays() {
    for (const [projectId, enrollment] of Object.entries(this.store.projects)) {
      const project = this.config.projects.find(item => item.id === projectId);
      if (!project) continue;
      try {
        if (this.projectPath(project) !== enrollment.path) continue;
        this.assertProjectPathAllowed(enrollment.path);
      }
      catch { continue; }
      project.team = enrollment.team as Project["team"];
      if (Object.hasOwn(enrollment, "linear")) {
        if (enrollment.linear) project.linear = enrollment.linear;
        else delete project.linear;
      }
    }
  }

  private async assertCleanGitRoot(path: string, prefix?: TeamCommand): Promise<string> {
    let root: string;
    try { root = canonicalPath(path); }
    catch { throw new TeamError(409, "project-not-git-root", "The configured repository must be an accessible Git root with a committed HEAD."); }
    const run = async (args: string[]) => {
      const result = await teamCommand({ command: "git", args: ["-c", `safe.directory=${root}`, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "user.name=Infinite", "-c", "user.email=agent@example.invalid", ...args] }, root, undefined, 30000, prefix);
      if (result.exitCode !== 0 || result.interrupted || result.truncated) throw new TeamError(409, "project-git-check-failed", "The repository Git check failed. Verify the configured command prefix and repository access.");
      return result.stdout.trim();
    };
    let top: string;
    try { top = await run(["rev-parse", "--show-toplevel"]); }
    catch (error) { if (error instanceof TeamError) throw error; throw new TeamError(409, "project-not-git-root", "The configured repository must be an accessible Git root with a committed HEAD."); }
    if (canonicalPath(top) !== root) throw new TeamError(409, "project-not-git-root", "The configured project must be the Git repository root.");
    if (await run(["status", "--porcelain=v1", "--untracked-files=all"])) throw new TeamError(409, "project-dirty", "Commit or separately preserve repository changes before enrolling it for team work.");
    const head = await run(["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new TeamError(409, "project-git-head-required", "Commit the repository before enrolling it for team work.");
    return head;
  }
}
