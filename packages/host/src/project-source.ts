import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./types.js";
import type { TeamCommand } from "./team-types.js";
import { syncFailure, type SyncFailureCategory } from "./project-sync.js";
import { TeamError, teamCommand, teamGitArgs } from "./team-workspace.js";
import { hostGithubGrantEnvironment } from "./github-grants.js";

const FETCH_TIMEOUT_MS = 120_000;
const MAX_FETCH_RETRY_MS = 60 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const STAGED_EDITS_MESSAGE = "Staged edits left in the host checkout before a refresh from GitHub";
const SAVED_CHANGES_MESSAGE = "Edits left in the host checkout before a refresh from GitHub";
const NOT_GIT_ROOT_MESSAGE = "the host checkout is not a Git repository root";
const FETCH_MESSAGES: Record<Exclude<SourceFetchCategory, "auth">, string> = {
  network: "the host could not reach GitHub",
  "not-found": "GitHub reports no such repository or branch for the configured source",
  other: "the fetch from GitHub failed",
};

export function fetchCategory(output: string): SourceFetchCategory {
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

export type SourceFetchCategory = "auth" | "network" | "not-found" | "other";
export type SourcePendingReason = "session-running" | "fetch-failed" | "diverged" | "apply-failed";
export interface ProjectSourceStatus {
  mode: "github" | "laptop";
  repository?: string;
  baseBranch?: string;
  mirrorHead?: string;
  fetchStamp?: string;
  mirrorHeadSince?: string;
  appliedHead?: string;
  fetchedAt?: string;
  appliedAt?: string;
  attemptedAt?: string;
  fetchFailures?: number;
  pending?: { reason: SourcePendingReason; category?: SourceFetchCategory | SyncFailureCategory; message?: string; since: string };
  savedBranches?: string[];
}
export type MirrorFetch = { projectId: string; repository: string; baseBranch: string; head: string; previousHead?: string; previousSince?: string; fetchedAt: string };
export interface ProjectSourceOptions {
  running: (projectId: string) => Promise<boolean>;
  prefix?: TeamCommand;
  onApplied?: (projectId: string, head: string) => void;
  onMirror?: (fetch: MirrorFetch) => void;
}

export class ProjectSourceError extends Error {
  constructor(message: string, readonly code: "source-github" | "source-refreshing" | "source-unavailable" | "unknown-project" | "not-github", readonly status = 409) {
    super(message);
  }
}

export function mirrorRemoteUrl(source: { repository: string }, override?: string) {
  return override ?? `https://github.com/${source.repository}.git`;
}

export class ProjectSourceService {
  private readonly serial = new Map<string, Promise<unknown>>();
  private readonly changing = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly tickListeners = new Set<() => void>();

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
    if (saved.repository !== project.source.repository || saved.baseBranch !== project.source.baseBranch) {
      return {
        mode: "github",
        repository: project.source.repository,
        baseBranch: project.source.baseBranch,
        ...(saved.savedBranches ? { savedBranches: saved.savedBranches } : {}),
        ...(saved.fetchStamp ? { fetchStamp: saved.fetchStamp } : {}),
      };
    }
    return { ...saved, mode: "github", repository: project.source.repository, baseBranch: project.source.baseBranch };
  }
  private writeStatus(projectId: string, status: ProjectSourceStatus, expected?: { repository: string; baseBranch: string }) {
    const project = this.project(projectId);
    const source = project.source?.mode === "github" ? project.source : undefined;
    if (expected && !this.sourceMatches(projectId, expected)) return false;
    const file = this.statusFile(projectId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(source ? { ...status, mode: "github", repository: source.repository, baseBranch: source.baseBranch } : status), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    return true;
  }
  private savePending(projectId: string, status: ProjectSourceStatus, pending: Omit<NonNullable<ProjectSourceStatus["pending"]>, "since">, expected?: { repository: string; baseBranch: string }) {
    if (expected && !this.sourceMatches(projectId, expected)) return this.status(projectId);
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
  private async command(cwd: string, args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS, env?: Record<string, string>) {
    return teamCommand({ command: "git", args: teamGitArgs(cwd, args) }, cwd, signal, timeoutMs, this.options.prefix, undefined, env);
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
  private noteMirrorHead(projectId: string, status: ProjectSourceStatus, source: { repository: string; baseBranch: string }, head: string, fetched: boolean): ProjectSourceStatus {
    const now = new Date().toISOString();
    const lastStamp = status.fetchStamp === undefined ? Number.NaN : Date.parse(status.fetchStamp);
    const stamp = Number.isNaN(lastStamp) || Date.parse(now) > lastStamp ? now : new Date(lastStamp + 1).toISOString();
    const previousHead = status.mirrorHead;
    const previousSince = previousHead === undefined ? undefined : status.mirrorHeadSince;
    const next: ProjectSourceStatus = {
      ...status,
      mirrorHead: head,
      mirrorHeadSince: previousHead === head && previousSince !== undefined ? previousSince : stamp,
      fetchStamp: stamp,
      ...(fetched ? { fetchedAt: now, attemptedAt: now } : {}),
    };
    if (this.writeStatus(projectId, next, source)) {
      try {
        this.options.onMirror?.({
          projectId, repository: source.repository, baseBranch: source.baseBranch, head,
          ...(previousHead === undefined ? {} : { previousHead }), ...(previousSince === undefined ? {} : { previousSince }), fetchedAt: stamp,
        });
      } catch {}
    }
    return next;
  }
  private fetchFailure(projectId: string, status: ProjectSourceStatus, source: { repository: string; baseBranch: string }, category: SourceFetchCategory) {
    const repository = source.repository;
    const message = category === "auth"
      ? `grant the GitHub App access to ${repository}`
      : FETCH_MESSAGES[category];
    const attempted = { ...status, attemptedAt: new Date().toISOString(), fetchFailures: (status.fetchFailures ?? 0) + 1 };
    return this.savePending(projectId, attempted, { reason: "fetch-failed", category, message }, source);
  }
  private sourceMatches(projectId: string, source: { repository: string; baseBranch: string }) {
    const current = this.config.projects.find(project => project.id === projectId)?.source;
    return current?.mode === "github" && current.repository === source.repository && current.baseBranch === source.baseBranch;
  }
  private async checkoutRootFailure(projectPath: string, signal?: AbortSignal): Promise<{ category: SyncFailureCategory; message: string } | undefined> {
    let projectRealPath: string;
    try {
      projectRealPath = realpathSync(projectPath);
    } catch (error) {
      const failure = syncFailure(error, projectPath);
      return failure.category === "other" ? { category: "other", message: NOT_GIT_ROOT_MESSAGE } : failure;
    }
    try {
      const result = await this.command(projectPath, ["rev-parse", "--show-toplevel"], signal);
      if (!commandSucceeded(result)) return { category: "other", message: NOT_GIT_ROOT_MESSAGE };
      if (realpathSync(result.stdout.trim()) !== projectRealPath) return { category: "other", message: NOT_GIT_ROOT_MESSAGE };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { category: "other", message: NOT_GIT_ROOT_MESSAGE };
    }
    return undefined;
  }
  private async isRunning(projectId: string) {
    try { return await this.options.running(projectId); }
    catch { return true; }
  }
  private async refreshOne(projectId: string, options?: { maxAgeMs?: number; signal?: AbortSignal }): Promise<ProjectSourceStatus> {
    const project = this.project(projectId);
    if (project.source?.mode !== "github") throw new ProjectSourceError("This project is not tracked on GitHub", "not-github");
    const source = { repository: project.source.repository, baseBranch: project.source.baseBranch };
    let status = this.status(projectId);
    if (options?.maxAgeMs !== undefined && status.fetchedAt && Date.now() - Date.parse(status.fetchedAt) < options.maxAgeMs) return status;
    if (options?.maxAgeMs !== undefined && status.fetchFailures && status.attemptedAt) {
      const wait = Math.min(options.maxAgeMs * 2 ** (status.fetchFailures - 1), MAX_FETCH_RETRY_MS);
      if (Date.now() - Date.parse(status.attemptedAt) < wait) return status;
    }

    const remote = mirrorRemoteUrl(source, this.config.source?.remoteOverrides?.[projectId]);
    const mirror = this.mirrorPath(projectId);
    let fetchedHead: string;
    try {
      await this.ensureMirror(projectId, options?.signal);
      if (status.mirrorHead !== undefined) {
        const held = await this.command(mirror, ["rev-parse", `refs/heads/${source.baseBranch}`], options?.signal);
        if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        if (!this.sourceMatches(projectId, source)) return this.status(projectId);
        const heldHead = commandSucceeded(held) ? held.stdout.trim() : undefined;
        if (heldHead === undefined) {
          const unproven = { ...status };
          delete unproven.mirrorHeadSince;
          status = unproven;
          this.writeStatus(projectId, status, source);
        } else if (heldHead !== status.mirrorHead) {
          status = this.noteMirrorHead(projectId, status, source, heldHead, false);
        }
      }
      const grant = hostGithubGrantEnvironment(this.config, { sid: `source:${projectId}`, project: projectId, repo: source.repository, ops: ["fetch"] });
      const fetched = await this.command(mirror, ["fetch", "--no-tags", remote, `+refs/heads/${source.baseBranch}:refs/heads/${source.baseBranch}`], options?.signal, FETCH_TIMEOUT_MS, grant);
      if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      if (!this.sourceMatches(projectId, source)) return this.status(projectId);
      if (!commandSucceeded(fetched)) {
        const output = `${fetched.output}${fetched.interrupted ? " timed out" : ""}`;
        return this.fetchFailure(projectId, status, source, fetchCategory(output));
      }
      fetchedHead = await this.git(mirror, ["rev-parse", `refs/heads/${source.baseBranch}`], options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (!this.sourceMatches(projectId, source)) return this.status(projectId);
      return this.fetchFailure(projectId, status, source, error instanceof TeamError ? fetchCategory(error.message) : "other");
    }

    if (!this.sourceMatches(projectId, source)) return this.status(projectId);
    const fetchedStatus = status.pending?.reason === "fetch-failed" ? withoutPending(status) : status;
    delete fetchedStatus.fetchFailures;
    status = this.noteMirrorHead(projectId, fetchedStatus, source, fetchedHead, true);

    if (status.mirrorHead === status.appliedHead) {
      const rootFailure = await this.checkoutRootFailure(project.path, options?.signal);
      if (!this.sourceMatches(projectId, source)) return this.status(projectId);
      if (rootFailure) return this.savePending(projectId, status, { reason: "apply-failed", ...rootFailure }, source);
      try {
        if (await this.git(project.path, ["rev-parse", "HEAD"], options?.signal) === status.mirrorHead) return status;
      } catch (error) {
        if (options?.signal?.aborted) throw error;
      }
    }
    if (await this.isRunning(projectId)) return this.savePending(projectId, status, { reason: "session-running" }, source);

    this.changing.add(projectId);
    let moved = false;
    try {
      if (await this.isRunning(projectId)) return this.savePending(projectId, status, { reason: "session-running" }, source);
      if (!this.sourceMatches(projectId, source)) return this.status(projectId);
      const rootFailure = await this.checkoutRootFailure(project.path, options?.signal);
      if (!this.sourceMatches(projectId, source)) return this.status(projectId);
      if (rootFailure) return this.savePending(projectId, status, { reason: "apply-failed", ...rootFailure }, source);
      const treeHead = await this.git(project.path, ["rev-parse", "HEAD"], options?.signal);
      await this.git(project.path, ["fetch", "--no-tags", mirror, `+refs/heads/${source.baseBranch}:refs/remotes/origin/${source.baseBranch}`], options?.signal);
      const ancestry = await this.command(project.path, ["merge-base", "--is-ancestor", treeHead, fetchedHead], options?.signal);
      if (!commandSucceeded(ancestry)) {
        const pending = this.savePending(projectId, status, {
          reason: "diverged",
          message: `the host checkout has commits that are not on ${source.baseBranch}`,
        }, source);
        return pending;
      }

      const dirty = await this.git(project.path, ["status", "--porcelain", "--untracked-files=no"], options?.signal);
      if (dirty) {
        const suffix = randomUUID().slice(0, 8);
        const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
        const branch = `infinite/saved-${date}-${suffix}`;
        await this.git(project.path, ["checkout", "-b", branch], options?.signal);
        const staged = await this.command(project.path, ["diff", "--cached", "--quiet"], options?.signal);
        if (staged.interrupted || staged.truncated || ![0, 1].includes(staged.exitCode ?? -1))
          throw new TeamError(409, "workspace-operation-failed", "A team Git operation failed. The isolated workspace was preserved for inspection.");
        if (staged.exitCode === 1) await this.git(project.path, ["commit", "-m", STAGED_EDITS_MESSAGE], options?.signal);
        await this.git(project.path, ["add", "-u"], options?.signal);
        const worktree = await this.command(project.path, ["diff", "--cached", "--quiet"], options?.signal);
        if (worktree.interrupted || worktree.truncated || ![0, 1].includes(worktree.exitCode ?? -1))
          throw new TeamError(409, "workspace-operation-failed", "A team Git operation failed. The isolated workspace was preserved for inspection.");
        if (worktree.exitCode === 1) await this.git(project.path, ["commit", "-m", SAVED_CHANGES_MESSAGE], options?.signal);
        status = { ...status, savedBranches: [...(status.savedBranches ?? []), branch] };
        this.writeStatus(projectId, status, source);
      }

      if (!this.sourceMatches(projectId, source)) return this.status(projectId);
      await this.git(project.path, ["checkout", "--detach", fetchedHead], options?.signal);
      const applied: ProjectSourceStatus = { ...withoutPending(status), appliedHead: fetchedHead, appliedAt: new Date().toISOString() };
      this.writeStatus(projectId, applied, source);
      moved = treeHead !== fetchedHead;
      return applied;
    } catch (error) {
      const failure = syncFailure(error, project.path);
      return this.savePending(projectId, status, { reason: "apply-failed", ...failure }, source);
    } finally {
      this.changing.delete(projectId);
      if (moved) try { this.options.onApplied?.(projectId, fetchedHead); } catch {}
    }
  }
  refreshing(projectId: string): boolean {
    return this.changing.has(projectId);
  }
  refresh(projectId: string, options?: { maxAgeMs?: number; signal?: AbortSignal }): Promise<ProjectSourceStatus> {
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    }
    const previous = this.serial.get(projectId) ?? Promise.resolve();
    const run = () => {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      return this.refreshOne(projectId, options);
    };
    const next = previous.then(run, run);
    const done = next.catch(() => {});
    this.serial.set(projectId, done);
    void done.finally(() => {
      if (this.serial.get(projectId) === done) this.serial.delete(projectId);
    });
    if (!signal) return next;
    return new Promise<ProjectSourceStatus>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      next.then(
        value => { signal.removeEventListener("abort", onAbort); resolve(value); },
        error => { signal.removeEventListener("abort", onAbort); reject(error); },
      );
    });
  }
  onTick(listener: () => void): () => void {
    this.tickListeners.add(listener);
    return () => { this.tickListeners.delete(listener); };
  }
  start(): void {
    if (this.timer) return;
    const maxAgeMs = (this.config.source?.refreshMinutes ?? 5) * 60_000;
    this.timer = setInterval(() => {
      for (const project of this.config.projects) {
        if (project.source?.mode === "github") void this.refresh(project.id, { maxAgeMs }).catch(() => {});
      }
      for (const listener of this.tickListeners) {
        try { listener(); } catch (error) { console.warn("A source timer listener failed.", error instanceof Error ? error.message : "unknown error"); }
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
