import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProjectSyncError } from "./project-sync.js";
import { unseal, writeSealed } from "./vault.js";
import type { Config, Project } from "./types.js";

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const invalid = () => new ProjectSyncError("Choose a project below the home directory, or select a configured project with --project ID.", "invalid-manifest", 400);

/** The wire path is relative to a home directory, with portable separators and no normalization ambiguity. */
function homeRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.startsWith(".") &&
    !/[\\\x00-\x1f\x7f-\x9f]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Local launch identity omits the account-specific home prefix. Never guess a mapping outside home. */
export function localProjectPath(root: string): string {
  const path = relative(realpathSync(homedir()), root).split(sep).join("/");
  if (!homeRelativePath(path) || isAbsolute(path)) throw invalid();
  return path;
}

/** Owner-created mappings live in the private vault, independently of the operator's host configuration. */
export class MirroredProjects {
  private readonly paths: string[];
  private readonly file: string;
  constructor(private readonly config: Config, private readonly key: Buffer) {
    this.file = join(config.stateDir, "mirrored-projects.sealed");
    this.paths = existsSync(this.file) ? unseal<string[]>(key, "mirrored-projects", readFileSync(this.file, "utf8")) : [];
    for (const path of this.paths) this.register(path);
  }

  private register(path: string): Project {
    if (!homeRelativePath(path)) throw invalid();
    // Resolve a possibly nonexistent home root through its nearest existing ancestor.
    const canonical = (path: string): string => {
      try { return realpathSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
        return join(canonical(dirname(path)), basename(path));
      }
    };
    const home = canonical(resolve(this.config.sync?.homeDir ?? homedir()));
    const destination = resolve(home, ...path.split("/"));
    if (!inside(home, destination) || destination === home) throw invalid();
    // Refuse symlink aliases: they could silently select another project or private host directory.
    for (let current = destination; current !== home; current = dirname(current)) {
      try { if (!lstatSync(current).isDirectory()) throw invalid(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const protectedPaths = [this.config.stateDir, this.config.runDir, this.config.keyFile];
    if (protectedPaths.some(value => inside(destination, canonical(resolve(value))) || inside(canonical(resolve(value)), destination))) throw invalid();
    const existing = this.config.projects.find(project => canonical(resolve(project.path)) === destination);
    if (existing) return existing;
    // Overlapping projects would have independent sync locks for the same files.
    if (this.config.projects.some(project => inside(canonical(resolve(project.path)), destination) || inside(destination, canonical(resolve(project.path)))))
      throw new ProjectSyncError("This folder overlaps another cloud project. Select that project with --project ID.", "cloud-changed");
    const id = `folder-${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
    if (this.config.projects.some(project => project.id === id)) throw new ProjectSyncError("The mirrored project ID is already configured for another folder.", "cloud-changed");
    const project = { id, name: path, path: destination };
    this.config.projects.push(project);
    return project;
  }

  resolve(path: string): Project {
    const count = this.config.projects.length;
    const project = this.register(path);
    try {
      // Intermediate folders remain host-controlled even when agents can edit each applied project.
      mkdirSync(dirname(project.path), { recursive: true, mode: this.config.sync?.sharedGroup ? 0o2750 : 0o700 });
      mkdirSync(project.path, { recursive: true, mode: this.config.sync?.sharedGroup ? 0o2770 : 0o700 });
      if (!this.paths.includes(path)) {
        writeSealed(this.file, this.key, "mirrored-projects", [...this.paths, path]);
        this.paths.push(path);
      }
    } catch (error) { this.config.projects.splice(count); throw error; }
    return project;
  }
}
