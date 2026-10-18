import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./types.js";
import { ContentError } from "./session-content.js";
import { unseal, writeSealed } from "./vault.js";

const projectId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const linkSchema = z.object({ projectId, relationship: z.string().trim().min(1).max(300) }).strict();
export const contextLinksRequest = z.object({ expectedVersion: z.number().int().min(0), links: z.array(linkSchema).max(16) }).strict();
const storedLinks = z.object({ version: z.number().int().min(0), root: z.string(), links: z.array(linkSchema.extend({ root: z.string() })).max(16) }).strict();
const storedContext = z.object({ version: z.number().int().min(0), text: z.string().max(24000), updatedAt: z.string().optional(), root: z.string().optional() }).strict();
export interface ContextSource { projectId: string; version: number; relationship?: string }

/** Owner-authored context is scoped to both a project identity and its canonical checkout. */
export class ProjectContexts {
  constructor(private readonly config: Config, private readonly key: Buffer) {}

  root(id: string) {
    projectId.parse(id);
    const matches = this.config.projects.filter(project => project.id === id);
    const project = matches[0];
    if (!project) throw new ContentError("Unknown project", 404);
    if (matches.length !== 1) throw new ContentError("Project identity is ambiguous. Use a unique project ID for each codebase.", 409);
    return realpathSync(project.path);
  }

  context(id: string) {
    const root = this.root(id);
    const file = join(this.config.stateDir, "contexts", `${id}.sealed`);
    if (!existsSync(file)) return { version: 0, text: "" };
    const value = storedContext.parse(unseal(this.key, `context:${id}`, readFileSync(file, "utf8")));
    if (value.root !== root) return { version: value.version, text: "", binding: "review-required" as const };
    const { root: _root, ...context } = value;
    return context;
  }

  setContext(id: string, text: string, expectedVersion: number) {
    const root = this.root(id);
    const file = join(this.config.stateDir, "contexts", `${id}.sealed`);
    // An explicit owner save may replace legacy/unbound context after review. Never inject it automatically.
    const previous = existsSync(file) ? storedContext.parse(unseal(this.key, `context:${id}`, readFileSync(file, "utf8"))) : { version: 0 };
    if (previous.version !== expectedVersion) throw new ContentError("Context changed on another device. Reload before saving.", 409);
    const next = storedContext.parse({ version: previous.version + 1, text, root, updatedAt: new Date().toISOString() });
    writeSealed(file, this.key, `context:${id}`, next);
    const { root: _root, ...context } = next;
    return context;
  }

  links(id: string) {
    const root = this.root(id);
    const file = join(this.config.stateDir, "context-links", `${id}.sealed`);
    if (!existsSync(file)) return { version: 0, root, links: [] as z.infer<typeof storedLinks>["links"] };
    const links = storedLinks.parse(unseal(this.key, `context-links:${id}`, readFileSync(file, "utf8")));
    return { ...links, ...(links.root !== root ? { binding: "review-required" as const } : {}) };
  }

  listLinks(id: string) {
    const value = this.links(id);
    return { version: value.version, ...("binding" in value ? { binding: value.binding } : {}), links: "binding" in value ? [] : value.links.map(({ root: _root, ...link }) => link) };
  }

  setLinks(id: string, input: z.infer<typeof contextLinksRequest>) {
    const body = contextLinksRequest.parse(input);
    const previous = this.links(id);
    if (body.expectedVersion !== previous.version) throw new ContentError("Context relationships changed. Reload before saving.", 409);
    const seen = new Set<string>();
    const links = body.links.map(link => {
      if (link.projectId === id || seen.has(link.projectId)) throw new ContentError("Context relationships must name distinct other projects.", 400);
      seen.add(link.projectId);
      const existing = !("binding" in previous) ? previous.links.find(value => value.projectId === link.projectId) : undefined;
      // Preserve retained bindings, including stale ones, so editing another edge cannot reauthorize them.
      return { ...link, root: existing?.root ?? this.root(link.projectId) };
    });
    const value = { version: previous.version + 1, root: this.root(id), links };
    writeSealed(join(this.config.stateDir, "context-links", `${id}.sealed`), this.key, `context-links:${id}`, value);
    return this.listLinks(id);
  }

  snapshot(id: string) {
    const own = this.context(id);
    if ("binding" in own) throw new ContentError("Saved context has no matching codebase binding. Review and save context for this project before launching.", 409);
    const links = this.links(id);
    if ("binding" in links) throw new ContentError("Context relationships belong to a different codebase binding. Review and replace them before launching.", 409);
    const sources: ContextSource[] = [{ projectId: id, version: own.version }];
    const chunks = own.text ? [own.text] : [];
    for (const link of links.links) {
      if (link.root !== this.root(link.projectId)) throw new ContentError("A linked project changed codebase. Review its context relationship before launching.", 409);
      // Read raw owner context only. A source's own links never propagate.
      const source = this.context(link.projectId);
      if ("binding" in source) throw new ContentError("Linked context has no matching codebase binding. Its owner must review and save it before use.", 409);
      sources.push({ projectId: link.projectId, version: source.version, relationship: link.relationship });
      if (source.text) chunks.push(`Linked project context ${JSON.stringify({ projectId: link.projectId, version: source.version, relationship: link.relationship })}:\n${source.text}`);
    }
    const text = chunks.join("\n\n");
    if (text.length > 48000) throw new ContentError("Linked context exceeds 48000 characters. Shorten project context or remove a relationship.", 409);
    return { version: own.version, text, sources, linksVersion: links.version, root: links.root };
  }
}
