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

/**
 * The owner's review of the permission journal: the decision log, marks, replay candidates and the rate flag.
 * Nothing here changes a decision. Every read that can carry a model's note needs the owner role, and a mark
 * needs the paired owner CLI.
 */
export interface PermissionReviewDependencies {
  /** Undefined when the journal will not open. Its routes then answer 503. */
  journal: PermissionJournal | undefined;
  requireRole: (roles: Role[]) => express.RequestHandler;
  requireOwnerCli: express.RequestHandler;
  /** Current workspace holders by project id, for display names. A decision keeps the workspace id it was recorded under. */
  workspaces: { membershipSnapshot(): ReadonlyMap<string, { id: string; name: string }> };
  projects: () => ReadonlyArray<{ id: string; name: string }>;
  now?: () => number;
}

/** A log entry as the API serves it: the recorded entry with current display names and the session's rate flag. */
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

/** The sessions the rate rule flags now, or null when the journal cannot be read. Informational: nothing stops on it. */
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

  // The log carries the model's note, so only the owner reads it. A controller or a viewer is refused outright.
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

  // A mark is a record only. It changes no decision, no replay and no lock. A retried request id returns the first mark.
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

  // Marked-wrong decisions and reopened rejects, each with the label it implies. The owner accepts or drops them in the replay set.
  app.get("/api/permissions/candidates", owner, (req, res) => {
    if (!journal) return res.status(503).json(unavailable);
    const query = candidateQuerySchema.parse(req.query);
    return res.json(invalidAsBadRequest(() => journal.replayCandidates({
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    })));
  });
}

/** The journal validates its own input with TypeError. Here that is the caller's request, not a host fault. */
function invalidAsBadRequest<T>(read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof TypeError) throw new TeamError(400, "invalid-request", error.message);
    throw error;
  }
}
