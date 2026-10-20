import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./types.js";
import type { TeamCommand } from "./team-types.js";
import { syncFailure, type SyncFailureCategory } from "./project-sync.js";
import { TeamError, teamCommand, teamGitArgs } from "./team-workspace.js";

const FETCH_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const SAVED_CHANGES_MESSAGE = "Edits left in the host checkout before a refresh from GitHub";
const FETCH_MESSAGES: Record<Exclude<SourceFetchCategory, "auth">, string> = {
  network: "the host could not reach GitHub",
  "not-found": "GitHub reports no such repository or branch for the configured source",
  other: "the fetch from GitHub failed",
};

function fetchCategory(output: string): SourceFetchCategory {
  if (/authentication|403|401|could not read Username/i.test(output)) return "auth";
  if (/could not resolve|unable to access|timed out|connection/i.test(output)) return "network";
  if (/not found|repository .* does not exist/i.test(output)) return "not-found";
  return "other";
}

function commandSucceeded(result: { exitCode: number | null; interrupted: boolean; truncated: boolean }) {
  return result.exitCode === 0 && !result.interrupted && !result.truncated;
}

function withoutPending(status: ProjectSourceStatus): ProjectSourceStatus {
  const next = { ...status };
  delete next.pending;
  return next;
}

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
  private readonly serial = new Map<string, Promise<unknown>>();
  private readonly changing = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: Config, private readonly options: ProjectSourceOptions) {
    if (config.environment === "cloud" && Object.keys(config.source?.remoteOverrides ?? {}).length > 0)
      throw new Error("source.remoteOverrides are only allowed outside cloud hosts");
  }

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
  private writeStatus(projectId: string, status: ProjectSourceStatus) {
    const file = this.statusFile(projectId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(status), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  }
  private savePending(projectId: string, status: ProjectSourceStatus, pending: Omit<NonNullable<ProjectSourceStatus["pending"]>, "since">) {
    const next: ProjectSourceStatus = {
      ...status,
      pending: {
        ...pending,
        since: status.pending?.reason === pending.reason ? status.pending.since : new Date().toISOString(),
      },
    };
    this.writeStatus(projectId, next);
    return next;
  }
  private async command(cwd: string, args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS) {
    return teamCommand({ command: "git", args: teamGitArgs(cwd, args) }, cwd, signal, timeoutMs, this.options.prefix);
  }
  private async git(cwd: string, args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS) {
    const result = await this.command(cwd, args, signal, timeoutMs);
    if (!commandSucceeded(result)) throw new TeamError(409, "workspace-operation-failed", "A team Git operation failed. The isolated workspace was preserved for inspection.");
    return result.stdout.trim();
  }
  private async ensureMirror(projectId: string, signal?: AbortSignal) {
    const mirror = this.mirrorPath(projectId);
    if (existsSync(mirror)) return mirror;
    const parent = dirname(mirror);
    const parentExisted = existsSync(parent);
    const mode = this.config.sync?.sharedGroup ? 0o2770 : 0o750;
    mkdirSync(parent, { recursive: true, mode });
    if (!parentExisted) chmodSync(parent, mode);
    await this.git(parent, ["init", "--bare", mirror], signal);
    return mirror;
  }
  private fetchFailure(projectId: string, status: ProjectSourceStatus, category: SourceFetchCategory) {
    const project = this.project(projectId);
    const message = category === "auth"
      ? `grant the GitHub App access to ${project.source?.mode === "github" ? project.source.repository : "the configured repository"}`
      : FETCH_MESSAGES[category];
    return this.savePending(projectId, status, { reason: "fetch-failed", category, message });
  }
  private async isRunning(projectId: string) {
    try { return await this.options.running(projectId); }
    catch { return true; }
  }
  private async refreshOne(projectId: string, options?: { maxAgeMs?: number; signal?: AbortSignal }): Promise<ProjectSourceStatus> {
    const project = this.project(projectId);
    if (project.source?.mode !== "github") throw new ProjectSourceError("This project is not tracked on GitHub", "not-github");
    let status = this.status(projectId);
    if (options?.maxAgeMs !== undefined && status.fetchedAt && Date.now() - Date.parse(status.fetchedAt) < options.maxAgeMs) return status;

    const remote = mirrorRemoteUrl(project.source, this.config.source?.remoteOverrides?.[projectId]);
    const mirror = this.mirrorPath(projectId);
    let fetchedHead: string;
    try {
      await this.ensureMirror(projectId, options?.signal);
      const fetched = await this.command(mirror, ["fetch", "--no-tags", remote, `+refs/heads/${project.source.baseBranch}:refs/heads/${project.source.baseBranch}`], options?.signal, FETCH_TIMEOUT_MS);
      if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      if (!commandSucceeded(fetched)) {
        const output = `${fetched.output}${fetched.interrupted ? " timed out" : ""}`;
        return this.fetchFailure(projectId, status, fetchCategory(output));
      }
      fetchedHead = await this.git(mirror, ["rev-parse", `refs/heads/${project.source.baseBranch}`], options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      return this.fetchFailure(projectId, status, error instanceof TeamError ? fetchCategory(error.message) : "other");
    }

    const fetchedStatus = status.pending?.reason === "fetch-failed" ? withoutPending(status) : status;
    status = {
      ...fetchedStatus,
      mirrorHead: fetchedHead,
      fetchedAt: new Date().toISOString(),
    };
    this.writeStatus(projectId, status);

    if (status.mirrorHead === status.appliedHead) {
      try {
        if (await this.git(project.path, ["rev-parse", "HEAD"], options?.signal) === status.mirrorHead) return status;
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        // A missing or unreadable working tree is reported through the apply-failed state below.
      }
    }
    if (await this.isRunning(projectId)) return this.savePending(projectId, status, { reason: "session-running" });

    this.changing.add(projectId);
    try {
      if (await this.isRunning(projectId)) return this.savePending(projectId, status, { reason: "session-running" });
      const treeHead = await this.git(project.path, ["rev-parse", "HEAD"], options?.signal);
      // Make the fetched base objects visible to merge-base in this detached checkout.
      await this.git(project.path, ["fetch", "--no-tags", mirror, `+refs/heads/${project.source.baseBranch}:refs/remotes/origin/${project.source.baseBranch}`], options?.signal);
      const ancestry = await this.command(project.path, ["merge-base", "--is-ancestor", treeHead, fetchedHead], options?.signal);
      if (!commandSucceeded(ancestry)) {
        const pending = this.savePending(projectId, status, {
          reason: "diverged",
          message: `the host checkout has commits that are not on ${project.source.baseBranch}`,
        });
        return pending;
      }

      const dirty = await this.git(project.path, ["status", "--porcelain", "--untracked-files=no"], options?.signal);
      if (dirty) {
        const suffix = randomUUID().slice(0, 8);
        const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
        const branch = `infinite/saved-${date}-${suffix}`;
        await this.git(project.path, ["checkout", "-b", branch], options?.signal);
        await this.git(project.path, ["add", "-u"], options?.signal);
        await this.git(project.path, ["commit", "-m", SAVED_CHANGES_MESSAGE], options?.signal);
        status = { ...status, savedBranches: [...(status.savedBranches ?? []), branch] };
        this.writeStatus(projectId, status);
      }

      await this.git(project.path, ["checkout", "--detach", fetchedHead], options?.signal);
      const applied: ProjectSourceStatus = { ...withoutPending(status), appliedHead: fetchedHead, appliedAt: new Date().toISOString() };
      this.writeStatus(projectId, applied);
      return applied;
    } catch (error) {
      const failure = syncFailure(error, project.path);
      return this.savePending(projectId, status, { reason: "apply-failed", ...failure });
    } finally {
      this.changing.delete(projectId);
    }
  }
  /** True only while the working tree is being fast-forwarded; new sessions in the project wait for it. */
  refreshing(projectId: string): boolean {
    return this.changing.has(projectId);
  }
  /** Fetch the base branch into the mirror and, when nothing is running in the project, fast-forward its working tree. */
  refresh(projectId: string, options?: { maxAgeMs?: number; signal?: AbortSignal }): Promise<ProjectSourceStatus> {
    const previous = this.serial.get(projectId) ?? Promise.resolve();
    const next = previous.then(() => this.refreshOne(projectId, options), () => this.refreshOne(projectId, options));
    this.serial.set(projectId, next.catch(() => {}));
    return next;
  }
  start(): void {
    if (this.timer) return;
    const maxAgeMs = (this.config.source?.refreshMinutes ?? 5) * 60_000;
    this.timer = setInterval(() => {
      for (const project of this.config.projects) {
        if (project.source?.mode === "github") void this.refresh(project.id, { maxAgeMs }).catch(() => {});
      }
    }, 60_000);
    this.timer.unref();
  }
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
