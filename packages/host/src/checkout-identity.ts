import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import type { ProjectSource } from "./team-types.js";

export type CheckoutIdentity = {
  projectId: string;
  key: string;
  repoName: string;
  capturedAt: string;
  from: "source" | "host-scan";
};

export interface WorkspaceRepositoryBinding { companyId: string; repositoryId: string }

export type GitReader = (cwd: string, args: string[]) => string | undefined;

export type GitCommandResult =
  | { ok: true; stdout: string }
  | { ok: false; status: number | null; stderr: string; errorCode?: string; signal?: string };

export type GitResultReader = (cwd: string, args: string[]) => GitCommandResult;

const READ_ONLY_GIT = ["-c", "safe.directory=*", "-c", "core.fsmonitor=false"];

export const readGitResult: GitResultReader = (cwd, args) => {
  try {
    const stdout = execFileSync("git", [...READ_ONLY_GIT, "-C", cwd, ...args], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    return { ok: true, stdout };
  } catch (error) {
    const err = error as { status?: unknown; stderr?: unknown; code?: unknown; signal?: unknown };
    const stderr = typeof err.stderr === "string"
      ? err.stderr.trim()
      : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8").trim() : "";
    return {
      ok: false,
      status: typeof err.status === "number" ? err.status : null,
      stderr,
      ...(typeof err.code === "string" ? { errorCode: err.code } : {}),
      ...(typeof err.signal === "string" ? { signal: err.signal } : {}),
    };
  }
};

export const readGit: GitReader = (cwd, args) => {
  const result = readGitResult(cwd, args);
  return result.ok ? result.stdout : undefined;
};

const GENERIC_FOLDERS = new Set(["codebase", "code", "src", "repo", "app", "main", "worktree"]);

export function normalizeRemote(url: string): { key: string; repoName: string } | undefined {
  const raw = url.trim();
  if (!raw || /\s/.test(raw)) return undefined;
  let hostAndPath: string | undefined;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(raw);
  if (scheme) hostAndPath = scheme[1];
  else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(raw);
    if (scp) hostAndPath = `${scp[1]}/${scp[2]}`;
    else if (/^[^/]+\.[^/]+\/.+/.test(raw)) hostAndPath = raw;
  }
  if (!hostAndPath) return undefined;
  const withoutUser = hostAndPath.replace(/^[^/@]*@/, "");
  const slash = withoutUser.indexOf("/");
  if (slash <= 0) return undefined;
  const host = withoutUser.slice(0, slash).toLowerCase();
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return undefined;
  const path = withoutUser.slice(slash + 1).replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!path) return undefined;
  const segments = path.split("/").filter(Boolean);
  const repoName = segments.at(-1);
  if (!repoName) return undefined;
  const joined = segments.join("/");
  const hostName = host.replace(/:\d+$/, "");
  return { key: `remote:${host}/${hostName === "github.com" ? joined.toLowerCase() : joined}`, repoName };
}

export function repoNameFromPath(path: string): string {
  const name = basename(path);
  if (!GENERIC_FOLDERS.has(name.toLowerCase())) return name;
  const parent = basename(dirname(path));
  return parent || name;
}

export function sourceIdentity(project: { id: string; source?: ProjectSource }, at = new Date().toISOString()): CheckoutIdentity | undefined {
  if (project.source?.mode !== "github") return undefined;
  const normalized = normalizeRemote(`https://github.com/${project.source.repository}.git`);
  return normalized ? { projectId: project.id, key: normalized.key, repoName: normalized.repoName, capturedAt: at, from: "source" } : undefined;
}

export function expectedIdentity(project: { id: string; path: string; source?: ProjectSource }, git: GitReader, at = new Date().toISOString()): CheckoutIdentity | undefined {
  return sourceIdentity(project, at) ?? captureIdentity(project, git, at);
}

export function captureIdentity(project: { id: string; path: string }, git: GitReader, at = new Date().toISOString()): CheckoutIdentity | undefined {
  const remote = git(project.path, ["config", "--get", "remote.origin.url"]);
  const normalized = remote ? normalizeRemote(remote) : undefined;
  if (normalized) return { projectId: project.id, key: normalized.key, repoName: normalized.repoName, capturedAt: at, from: "host-scan" };
  const roots = git(project.path, ["rev-list", "--max-parents=0", "HEAD"]);
  const root = roots?.split(/\s+/).map(line => line.trim()).filter(line => /^[0-9a-f]{4,64}$/i.test(line)).sort()[0];
  if (!root) return undefined;
  return { projectId: project.id, key: `root:${root.toLowerCase()}`, repoName: repoNameFromPath(project.path), capturedAt: at, from: "host-scan" };
}
