import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProjectSyncError } from "./project-sync.js";
import { unseal, writeSealed } from "./vault.js";
import type { Config, Project } from "./types.js";

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const invalid = () => new ProjectSyncError("Choose a project below the home directory, or select a configured project with --project ID.", "invalid-manifest", 400);
type Entry = { path: string; id: string; forgotten?: true };
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "") || "project";

/** The wire path is relative to a home directory, with portable separators and no normalization ambiguity. */
export function homeRelativePath(path: string): boolean {
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
  private readonly entries: Entry[];
  private readonly file: string;
  constructor(private readonly config: Config, private readonly key: Buffer) {
    this.file = join(config.stateDir, "mirrored-projects.sealed");
    if (!existsSync(this.file)) this.entries = [];
    else {
      const stored = unseal<unknown>(key, "mirrored-projects", readFileSync(this.file, "utf8"));
      if (Array.isArray(stored)) this.entries = stored.map(path => {
        if (typeof path !== "string") throw invalid();
        return { path, id: `folder-${createHash("sha256").update(path).digest("hex").slice(0, 32)}` };
      });
      else if (stored && typeof stored === "object" && (stored as { version?: unknown }).version === 2 && Array.isArray((stored as { entries?: unknown }).entries))
        this.entries = (stored as { entries: Entry[] }).entries.map(entry => ({ path: entry.path, id: entry.id, ...(entry.forgotten ? { forgotten: true as const } : {}) }));
      else throw invalid();
    }
    for (const entry of this.entries) if (!entry.forgotten) this.register(entry.path, entry.id);
  }

  private persist() { writeSealed(this.file, this.key, "mirrored-projects", { version: 2, entries: this.entries }); }

  /** Resolve a possibly nonexistent path through its nearest existing ancestor. */
  private canonical(path: string): string {
    try { return realpathSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
      return join(this.canonical(dirname(path)), basename(path));
    }
  }

  private destination(path: string): string {
    if (!homeRelativePath(path)) throw invalid();
    const home = this.canonical(resolve(this.config.sync?.homeDir ?? homedir()));
    const destination = resolve(home, ...path.split("/"));
    if (!inside(home, destination) || destination === home) throw invalid();
    // Refuse symlink aliases: they could silently select another project or private host directory.
    for (let current = destination; current !== home; current = dirname(current)) {
      try { if (!lstatSync(current).isDirectory()) throw invalid(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const protectedPaths = [this.config.stateDir, this.config.runDir, this.config.keyFile];
    if (protectedPaths.some(value => inside(destination, this.canonical(resolve(value))) || inside(this.canonical(resolve(value)), destination))) throw invalid();
    return destination;
  }

  private register(path: string, id?: string): Project {
    const destination = this.destination(path);
    const existing = this.config.projects.find(project => this.canonical(resolve(project.path)) === destination);
    if (existing) return existing;
    // Overlapping projects would have independent sync locks for the same files.
    if (this.config.projects.some(project => inside(this.canonical(resolve(project.path)), destination) || inside(destination, this.canonical(resolve(project.path)))))
      throw new ProjectSyncError("This folder overlaps another cloud project. Select that project with --project ID.", "cloud-changed");
    if (this.config.projects.some(project => project.teamworkDir &&
      (inside(this.canonical(resolve(project.teamworkDir)), destination) || inside(destination, this.canonical(resolve(project.teamworkDir))))))
      throw new ProjectSyncError("This folder overlaps a project's teamwork folder.", "cloud-changed");
    if (!id) {
      const parts = path.split("/");
      let candidate = parts.length >= 3 ? `${slug(parts.at(-2)!)}-${slug(parts.at(-1)!)}` : slug(parts.at(-1)!);
      candidate = slug(candidate);
      const occupied = (candidate: string) => this.config.projects.some(project => project.id === candidate) || this.entries.some(entry => entry.id === candidate && entry.path !== path);
      if (occupied(candidate)) candidate = `${candidate}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
      if (occupied(candidate)) throw new ProjectSyncError("Could not allocate a unique mirrored project ID for this folder because the readable ID and its path suffix are already in use.", "cloud-changed");
      id = candidate;
    }
    if (this.config.projects.some(project => project.id === id)) throw new ProjectSyncError("The mirrored project ID is already configured for another folder.", "cloud-changed");
    const project = { id, name: path, path: destination };
    this.config.projects.push(project);
    return project;
  }

  resolve(path: string): Project {
    const count = this.config.projects.length;
    const entry = this.entries.find(value => value.path === path);
    const project = this.register(path, entry?.id);
    try {
      // Intermediate folders remain host-controlled even when agents can edit each applied project.
      mkdirSync(dirname(project.path), { recursive: true, mode: this.config.sync?.sharedGroup ? 0o2750 : 0o700 });
      mkdirSync(project.path, { recursive: true, mode: this.config.sync?.sharedGroup ? 0o2770 : 0o700 });
      const wasForgotten = entry?.forgotten;
      if (entry) delete entry.forgotten;
      else this.entries.push({ path, id: project.id });
      try { this.persist(); } catch (error) {
        if (entry && wasForgotten) entry.forgotten = true;
        else if (!entry) this.entries.pop();
        throw error;
      }
    } catch (error) { this.config.projects.splice(count); throw error; }
    return project;
  }

  isMirrored(id: string): boolean { return this.entries.some(value => value.id === id && !value.forgotten); }

  forget(id: string): { id: string; name: string; path: string } {
    const entry = this.entries.find(value => value.id === id && !value.forgotten);
    if (!entry) throw new ProjectSyncError("Only a mirrored project can be forgotten.", "unknown-project");
    const project = this.config.projects.find(value => value.id === id);
    if (!project) throw new ProjectSyncError("The mirrored project is not currently configured.", "unknown-project");
    entry.forgotten = true;
    try { this.persist(); } catch (error) { delete entry.forgotten; throw error; }
    this.config.projects.splice(this.config.projects.indexOf(project), 1);
    return { id: project.id, name: project.name, path: project.path };
  }
}
