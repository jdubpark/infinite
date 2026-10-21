import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

/** Which repository a checkout is a copy of, captured once from the checkout's own Git metadata. */
export type CheckoutIdentity = {
  projectId: string;
  /** `remote:HOST/PATH` (lowercase) or `root:HASH`. Checkouts with equal keys are the same repository. */
  key: string;
  /** The repository's display name: the remote's last path segment, or the folder name when only a root commit is known. */
  repoName: string;
  capturedAt: string;
  from: "source" | "host-scan";
};

/** Trimmed stdout of `git -C cwd ...args`, or undefined when Git fails, is missing, or exceeds five seconds. */
export type GitReader = (cwd: string, args: string[]) => string | undefined;

export const readGit: GitReader = (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return undefined;
  }
};

/** Folder names that say nothing about which repository lives there. */
const GENERIC_FOLDERS = new Set(["codebase", "code", "src", "repo", "app", "main", "worktree"]);

/**
 * One key for every spelling of a remote: scheme, user info, port, a trailing `.git`, and case in the
 * host and path are dropped. `repoName` keeps the last path segment's spelling.
 */
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
  const host = withoutUser.slice(0, slash).replace(/:\d+$/, "");
  const path = withoutUser.slice(slash + 1).replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path) return undefined;
  const segments = path.split("/").filter(Boolean);
  const repoName = segments.at(-1);
  if (!repoName) return undefined;
  return { key: `remote:${host.toLowerCase()}/${segments.join("/").toLowerCase()}`, repoName };
}

/** The checkout folder's name, or its parent's when the folder name is generic (`codebase`, `src`, ...). */
export function repoNameFromPath(path: string): string {
  const name = basename(path);
  if (!GENERIC_FOLDERS.has(name.toLowerCase())) return name;
  const parent = basename(dirname(path));
  return parent || name;
}

/** Prefer the origin remote, then the repository's lowest root commit; nothing when Git cannot answer. */
export function captureIdentity(project: { id: string; path: string }, git: GitReader, at = new Date().toISOString()): CheckoutIdentity | undefined {
  const remote = git(project.path, ["config", "--get", "remote.origin.url"]);
  const normalized = remote ? normalizeRemote(remote) : undefined;
  if (normalized) return { projectId: project.id, key: normalized.key, repoName: normalized.repoName, capturedAt: at, from: "host-scan" };
  const roots = git(project.path, ["rev-list", "--max-parents=0", "HEAD"]);
  const root = roots?.split(/\s+/).map(line => line.trim()).filter(line => /^[0-9a-f]{4,64}$/i.test(line)).sort()[0];
  if (!root) return undefined;
  return { projectId: project.id, key: `root:${root.toLowerCase()}`, repoName: repoNameFromPath(project.path), capturedAt: at, from: "host-scan" };
}
