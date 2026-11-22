import type express from "express";
import { z } from "zod";
import { startMode } from "./evaluator-profiles.js";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError } from "./evidence/types.js";
import { memberCodeModeExpected } from "./launch.js";
import { objectivePromptFor } from "./objective-digest.js";
import { routingExplain, routingStatus } from "./routing-reads.js";
import { ROUTING_MODULE, setExplorePause } from "./routing-store.js";
import { teamActionSchema } from "./team-types.js";
import type { Config } from "./types.js";

const uuid = z.uuid();
const TASK_ID = /^[a-z][a-z0-9-]{0,39}$/;

export type RoutingRouteDeps = { evidence: EvidenceStore; config: () => Config;
  teams: { revokeRouting(id: string, input: unknown): Promise<unknown> } };

/**
 * The routing reads (status, explain) and the owner's writes: the exploration pause and resume, and the run's revoke.
 * The reads write nothing and open no sealed payload beyond what the reads name. The pause writes only the project's
 * routing state, never the configuration. `unavailable` answers 503 `evidence-unavailable`.
 */
export function routingRoutes(app: express.Express, deps: RoutingRouteDeps, guard: express.RequestHandler, ownerGuard: express.RequestHandler): void {
  const unavailable = (error: unknown, res: express.Response) => {
    if (error instanceof EvidenceError && error.code === "unavailable") {
      return void res.status(503).json({ code: "evidence-unavailable", error: "The evidence store is unavailable." });
    }
    throw error;
  };
  const unknownProject = (res: express.Response) => res.status(404).json({ code: "unknown-project", error: "The project is not configured on this host." });

  // Pausing or resuming writes one project row. A pause keeps its first time; a resume clears it.
  const explore = (pause: boolean) => (req: express.Request, res: express.Response) => {
    const project = deps.config().projects.find(item => item.id === req.params.id);
    if (!project) return void unknownProject(res);
    try {
      if (deps.evidence.status().modules[ROUTING_MODULE] !== "ready") throw new EvidenceError("unavailable", "The evidence store is unavailable.");
      const now = new Date().toISOString();
      const explorePausedAt = deps.evidence.write(tx => setExplorePause(tx, project.id, pause ? now : null, now));
      res.json({ projectId: project.id, explorePausedAt });
    } catch (error) {
      unavailable(error, res);
    }
  };
  app.post("/api/routing/projects/:id/explore/pause", ownerGuard, explore(true));
  app.post("/api/routing/projects/:id/explore/resume", ownerGuard, explore(false));

  app.post("/api/teams/:id/routing/revoke", ownerGuard, async (req, res) => {
    const run = uuid.safeParse(String(req.params.id).toLowerCase());
    if (!run.success) return void res.status(400).json({ code: "invalid-routing-request", error: "The run ID is not valid." });
    res.json(await deps.teams.revokeRouting(run.data, teamActionSchema.parse(req.body)));
  });

  app.get("/api/routing/projects/:id", guard, (req, res) => {
    const config = deps.config();
    const project = config.projects.find(item => item.id === req.params.id);
    if (!project) return void unknownProject(res);
    try {
      res.json(routingStatus(deps.evidence, {
        projectId: project.id,
        saved: project.team?.routing,
        autonomy: startMode(project, config.teams?.lineup).mode,
        lineup: config.teams?.lineup,
        // The values a new run pins, so the status shows the prompt versions a new decision would use.
        publishHeads: (config.teams as { publishHeads?: boolean } | undefined)?.publishHeads !== false,
        entryTools: config.teams?.blackboard?.tools === true,
        // The shape a new run of this project would pin: the criteria digest, and the register when it is on.
        objectiveDigest: objectivePromptFor(project, startMode(project, config.teams?.lineup).mode),
        codeMode: memberCodeModeExpected(config),
        now: new Date().toISOString(),
      }));
    } catch (error) {
      unavailable(error, res);
    }
  });

  app.get("/api/teams/:id/routing/:taskId", guard, (req, res) => {
    // A UUID is case-insensitive; the host stores its ids in lower case.
    const run = uuid.safeParse(String(req.params.id).toLowerCase());
    const task = TASK_ID.test(String(req.params.taskId));
    if (!run.success || !task) return void res.status(400).json({ code: "invalid-routing-request", error: "The run or task ID is not valid." });
    try {
      const explained = routingExplain(deps.evidence, run.data, String(req.params.taskId));
      if (!explained) return void res.status(404).json({ code: "routing-decision-not-found", error: "No routing decision exists for this run and task." });
      res.json(explained);
    } catch (error) {
      unavailable(error, res);
    }
  });
}
