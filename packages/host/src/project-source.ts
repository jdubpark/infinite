import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./types.js";
import type { TeamCommand } from "./team-types.js";
import type { SyncFailureCategory } from "./project-sync.js";

/** Why a fetch from GitHub failed, as a fixed category; the Git output is never stored. */
export type SourceFetchCategory = "auth" | "network" | "not-found" | "other";
export type SourcePendingReason = "session-running" | "fetch-failed" | "diverged" | "apply-failed";
export interface ProjectSourceStatus {
  mode: "github" | "laptop";
  repository?: string;
  baseBranch?: string;
  /** Base-branch head in the host mirror after the last successful fetch. */
  mirrorHead?: string;
  /** Commit the project working tree was last fast-forwarded to. */
  appliedHead?: string;
  fetchedAt?: string;
  appliedAt?: string;
  pending?: { reason: SourcePendingReason; category?: SourceFetchCategory | SyncFailureCategory; message?: string; since: string };
  /** Local branches holding tracked edits a session left in the working tree before a refresh. */
  savedBranches?: string[];
}
export interface ProjectSourceOptions {
  /** Whether a cloud session is running or starting in the project directory. Teams, goals and handoffs do not count. */
  running: (projectId: string) => Promise<boolean>;
  prefix?: TeamCommand;
}

export class ProjectSourceError extends Error {
  constructor(message: string, readonly code: "source-github" | "source-refreshing" | "source-unavailable" | "unknown-project" | "not-github", readonly status = 409) {
    super(message);
  }
}

/** Remote the host mirror fetches from; tests point it at a local bare repository. */
export function mirrorRemoteUrl(source: { repository: string }, override?: string) {
  return override ?? `https://github.com/${source.repository}.git`;
}

/**
 * Keeps a bare mirror of each GitHub-tracked project on the host and fast-forwards the project working
 * tree to it when no session is using that tree. Team runs clone the mirror.
 */
export class ProjectSourceService {
  constructor(private readonly config: Config, private readonly options: ProjectSourceOptions) {}

  private project(projectId: string) {
    const project = this.config.projects.find(p => p.id === projectId);
    if (!project) throw new ProjectSourceError("Unknown project", "unknown-project", 404);
    return project;
  }
  isGithub(projectId: string) {
    return this.config.projects.find(p => p.id === projectId)?.source?.mode === "github";
  }
  /** Outside every project directory; agent-writable because the fetch runs as the agent identity. */
  mirrorPath(projectId: string) {
    this.project(projectId);
    const base = this.config.source?.mirrorDir ?? join(dirname(this.config.teams?.workspaceDir ?? join(this.config.stateDir, "team-workspaces")), "source-mirrors");
    return join(base, `${projectId}.git`);
  }
  private statusFile(projectId: string) { return join(this.config.stateDir, "projects", projectId, "source", "status.json"); }
  status(projectId: string): ProjectSourceStatus {
    const project = this.project(projectId);
    if (project.source?.mode !== "github") return { mode: "laptop" };
    const file = this.statusFile(projectId);
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectSourceStatus> : {};
    return { ...saved, mode: "github", repository: project.source.repository, baseBranch: project.source.baseBranch };
  }
  /** True only while the working tree is being fast-forwarded; new sessions in the project wait for it. */
  refreshing(_projectId: string): boolean {
    throw new Error("not implemented");
  }
  /** Fetch the base branch into the mirror and, when nothing is running in the project, fast-forward its working tree. */
  refresh(_projectId: string, _options?: { maxAgeMs?: number; signal?: AbortSignal }): Promise<ProjectSourceStatus> {
    throw new Error("not implemented");
  }
  start(): void { throw new Error("not implemented"); }
  stop(): void { throw new Error("not implemented"); }
}
