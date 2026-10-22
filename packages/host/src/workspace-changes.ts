import { watch, lstatSync, realpathSync, type FSWatcher } from "node:fs";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { createWorkspaceWatch, type WorkspaceWatch } from "./workspace-watch.js";

export const QUIET_CAPTURE_MS = 10 * 60 * 1000;

export function shouldCaptureWorkspace(options: {
  changed: boolean;
  previousFailed: boolean;
  lastCaptureStartedAt: number;
  now?: number;
  checkpointCurrent?: boolean;
}): boolean {
  const { changed, previousFailed, lastCaptureStartedAt, now = Date.now(), checkpointCurrent } = options;
  return changed || previousFailed || !checkpointCurrent || lastCaptureStartedAt === 0 || now - lastCaptureStartedAt > QUIET_CAPTURE_MS;
}

export interface WorkspaceChanges {
  take(): Promise<boolean>;
  close(): Promise<void>;
}

function alwaysDirty(): WorkspaceChanges {
  return { take: async () => true, close: async () => {} };
}

function gitMetadataDirectories(root: string): string[] {
  try {
    if (!lstatSync(posix.join(root, ".git")).isFile()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const stdout = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
    maxBuffer: 65536,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const paths = stdout.trim().split("\n");
  if (paths.length !== 2 || paths.some(path => !posix.isAbsolute(path))) throw new Error("Unsupported Git metadata location");
  return paths.map(path => realpathSync(path));
}

/** Best-effort fallback when the bounded native watch is unavailable. */
function watchFileEvents(roots: string[]): WorkspaceChanges {
  const rootWatchers: FSWatcher[] = [], metadataWatchers: FSWatcher[] = [];
  let metadata: string[] = [];
  let dirty = true, sticky = false, closed = false, pointerChanged = false;
  const closeWatchers = (watchers: FSWatcher[]) => {
    for (const watcher of watchers.splice(0)) {
      try { watcher.close(); } catch { /* Continue closing the remaining watchers. */ }
    }
  };
  const fail = () => {
    sticky = true;
    closeWatchers(rootWatchers);
    closeWatchers(metadataWatchers);
  };
  const start = (path: string, into: FSWatcher[], changed: (filename: string | null) => void) => {
    const watcher = watch(path, { recursive: true, persistent: false });
    into.push(watcher);
    watcher.on("change", (_event, filename) => { if (!closed) changed(typeof filename === "string" ? filename : null); });
    watcher.on("error", fail);
  };
  const watchMetadata = () => {
    const next = [...new Set(roots.flatMap(gitMetadataDirectories))].filter(path => !roots.includes(path));
    if (next.join("\0") === metadata.join("\0")) return;
    closeWatchers(metadataWatchers);
    metadata = next;
    for (const path of metadata) start(path, metadataWatchers, () => { dirty = true; });
  };
  try {
    for (const root of roots) start(root, rootWatchers, filename => {
      dirty = true;
      if (filename === ".git" || !filename) pointerChanged = true;
    });
    watchMetadata();
  } catch { fail(); }
  return {
    async take() {
      if (pointerChanged && !sticky) {
        pointerChanged = false;
        try { watchMetadata(); } catch { fail(); }
      }
      if (sticky || closed) return true;
      const result = dirty;
      dirty = false;
      return result;
    },
    async close() {
      closed = true;
      closeWatchers(rootWatchers);
      closeWatchers(metadataWatchers);
    },
  };
}

/** A quiet take drains kernel events; only a topology change rebuilds the tree watch. */
export async function watchWorkspaceChanges(paths: string[], cacheDir: string): Promise<WorkspaceChanges | undefined> {
  if (process.platform !== "darwin") return undefined;

  let roots: string[];
  try { roots = [...new Set(paths.map(path => realpathSync(path)))]; }
  catch { return alwaysDirty(); }

  let watcher: WorkspaceWatch | undefined, metadata: string[] = [];
  let revision = -1, first = true, closed = false;
  let fallback: WorkspaceChanges | undefined;
  let operation = Promise.resolve(false), closing: Promise<void> | undefined;
  const metadataDirectories = () => [...new Set(roots.flatMap(gitMetadataDirectories))];
  const rebuild = async (next: string[]) => {
    await watcher?.close();
    watcher = undefined;
    metadata = next;
    const all = [...new Set([...roots, ...metadata])];
    // The common Git directory already covers a linked worktree's selected metadata.
    const watched = all.filter(path => !all.some(parent => path !== parent && path.startsWith(`${parent}/`)));
    watcher = await createWorkspaceWatch(watched, cacheDir, { purpose: "changes" });
    const state = await watcher.flush();
    // A busy registration stays invalid; take retries it after reporting dirty.
    revision = state.revision;
  };
  const fail = async () => {
    await watcher?.close();
    watcher = undefined;
    // Preserve the existing event/ten-minute gate on unsupported filesystems,
    // missing developer tools or resource exhaustion, without idle tree scans.
    fallback = watchFileEvents(roots);
  };
  try { await rebuild(metadataDirectories()); }
  catch { await fail(); }

  async function take(): Promise<boolean> {
    if (closed) return true;
    if (fallback) return fallback.take();
    if (!watcher) return true;
    try {
      const state = await watcher.flush();
      const changed = state.revision !== revision || !state.valid;
      if (changed) {
        // Re-resolve pointers only on events, including changes to external commondir files.
        const next = metadataDirectories();
        if (!state.valid || next.join("\0") !== metadata.join("\0")) await rebuild(next);
        else revision = state.revision;
      }
      const result = first || changed;
      first = false;
      return result;
    } catch { await fail(); return fallback!.take(); }
  }
  return {
    take() {
      // Serialize re-registration with callers and teardown; no helper can escape close.
      operation = operation.then(take);
      return operation;
    },
    close() {
      closed = true;
      closing ??= operation.then(async () => { await watcher?.close(); await fallback?.close(); watcher = undefined; });
      return closing;
    },
  };
}
