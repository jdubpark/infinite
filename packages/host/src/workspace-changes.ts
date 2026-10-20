import { watch, lstatSync, realpathSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";

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
  take(): boolean;
  close(): void;
}

function alwaysDirty(): WorkspaceChanges {
  return { take: () => true, close: () => {} };
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

export function watchWorkspaceChanges(paths: string[]): WorkspaceChanges | undefined {
  if (process.platform !== "darwin") return undefined;

  let roots: string[];
  try { roots = [...new Set(paths.map(path => realpathSync(path)))]; }
  catch { return alwaysDirty(); }

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
  // A linked worktree's metadata lives outside its root. A rewritten `.git` pointer can move it, so the watches follow it.
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
      // An event may arrive without a filename; it could be the pointer too.
      if (filename === ".git" || !filename) pointerChanged = true;
    });
    watchMetadata();
  } catch {
    fail();
  }

  return {
    take() {
      if (pointerChanged && !sticky) {
        pointerChanged = false;
        try { watchMetadata(); } catch { fail(); }
      }
      if (sticky) return true;
      const result = dirty;
      dirty = false;
      return result;
    },
    close() {
      closed = true;
      closeWatchers(rootWatchers);
      closeWatchers(metadataWatchers);
    },
  };
}
