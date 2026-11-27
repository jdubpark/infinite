import type express from "express";
import { z } from "zod";
import {
  PermissionMarkConflict,
  type PermissionJournal,
  type PermissionLogEntry,
  type PermissionRateFlag,
} from "./evidence/permission-journal.js";
import { TeamError } from "./team-workspace.js";
import type { Role } from "./types.js";

export interface PermissionReviewDependencies {
  journal: PermissionJournal | undefined;
  requireRole: (roles: Role[]) => express.RequestHandler;
  requireOwnerCli: express.RequestHandler;
  workspaces: { membershipSnapshot(): ReadonlyMap<string, { id: string; name: string }> };
  projects: () => ReadonlyArray<{ id: string; name: string }>;
  now?: () => number;
}

export type PermissionLogEntryView = PermissionLogEntry & {
  workspaceName?: string;
  projectName?: string;
  rateFlagged?: true;
};

const flag = z.enum(["1", "true"]).optional();
const identifier = z.string().min(1).max(200);
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
const logQuerySchema = z.object({
  rejected: flag,
  raised: flag,
  workspace: identifier.optional(),
  since: timestamp.optional(),
  before: z.string().regex(/^\d{1,15}\.\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();
const candidateQuerySchema = z.object({
  before: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();
const markBodySchema = z.object({
  requestId: z.uuid(),
  decisionId: identifier,
  label: z.literal("wrong"),
  note: z.string().max(2000).refine(value => value.trim().length > 0, { message: "A mark needs a note." }),
}).strict();
const unavailable = { error: "The permission journal is unavailable on this host." };

export function permissionRateFlags(journal: PermissionJournal | undefined, nowMs = Date.now()): PermissionRateFlag[] | null {
  if (!journal) return null;
  try { return journal.rateFlags({ now: new Date(nowMs).toISOString() }); }
  catch { return null; }
}

export function registerPermissionReviewRoutes(app: express.Express, deps: PermissionReviewDependencies): void {
  const { journal, requireRole, requireOwnerCli } = deps;
  const now = deps.now ?? Date.now;
  const owner = requireRole(["owner"]);

  const views = (entries: PermissionLogEntry[], flags: PermissionRateFlag[] | null): PermissionLogEntryView[] => {
    const workspaces = new Map<string, string>();
    for (const holder of deps.workspaces.membershipSnapshot().values()) workspaces.set(holder.id, holder.name);
    const projects = new Map(deps.projects().map(project => [project.id, project.name]));
    const flagged = new Set((flags ?? []).map(entry => entry.sessionId));
    return entries.map(entry => {
      const workspaceName = workspaces.get(entry.workspaceId);
      const projectName = projects.get(entry.projectId);
      return {
        ...entry,
        ...(workspaceName === undefined ? {} : { workspaceName }),
        ...(projectName === undefined ? {} : { projectName }),
        ...(flagged.has(entry.sessionId) ? { rateFlagged: true as const } : {}),
      };
    });
  };

  app.get("/api/permissions/log", owner, (req, res) => {
    if (!journal) return res.status(503).json(unavailable);
    const query = logQuerySchema.parse(req.query);
    const page = invalidAsBadRequest(() => journal.log({
      ...(query.workspace === undefined ? {} : { workspaceId: query.workspace }),
      ...(query.rejected === undefined ? {} : { rejectedOnly: true }),
      ...(query.raised === undefined ? {} : { raisedOnly: true }),
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    }));
    const rateFlags = permissionRateFlags(journal, now());
    return res.json({ entries: views(page.entries, rateFlags), ...(page.next === undefined ? {} : { next: page.next }), rateFlags });
  });

  app.get("/api/permissions/decisions/:id", owner, (req, res) => {
    if (!journal) return res.status(503).json(unavailable);
    const entry = journal.logEntry(identifier.parse(req.params.id));
    if (!entry) return res.status(404).json({ code: "decision-not-found", error: "No permission decision has that id." });
    return res.json({ entry: views([entry], permissionRateFlags(journal, now()))[0] });
  });

  app.post("/api/permissions/marks", owner, requireOwnerCli, (req, res) => {
    if (!journal) return res.status(503).json(unavailable);
    const body = markBodySchema.parse(req.body);
    if (!journal.decision(body.decisionId)) {
      return res.status(404).json({ code: "decision-not-found", error: "No permission decision has that id." });
    }
    try {
      const mark = invalidAsBadRequest(() => journal.mark({ ...body, at: new Date(now()).toISOString(), by: String(res.locals.deviceId) }));
      return res.json({ mark });
    } catch (error) {
      if (error instanceof PermissionMarkConflict) throw new TeamError(409, "request-conflict", error.message);
      throw error;
    }
  });

  app.get("/api/permissions/candidates", owner, (req, res) => {
    if (!journal) return res.status(503).json(unavailable);
    const query = candidateQuerySchema.parse(req.query);
    return res.json(invalidAsBadRequest(() => journal.replayCandidates({
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    })));
  });
}

function invalidAsBadRequest<T>(read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof TypeError) throw new TeamError(400, "invalid-request", error.message);
    throw error;
  }
}
