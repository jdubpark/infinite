import type express from "express";
import { z } from "zod";
import { autonomyOf } from "./autonomy.js";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError } from "./evidence/types.js";
import { objectivePromptsOn } from "./objective-digest.js";
import { routingExplain, routingStatus } from "./routing-reads.js";
import type { Config } from "./types.js";

const uuid = z.uuid();
const TASK_ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * The two routing reads: a project's shadow status and one task's decisions. Both read only; they write nothing and
 * open no sealed payload beyond what the reads name. `unavailable` answers 503 `evidence-unavailable`.
 */
export function routingRoutes(app: express.Express, deps: { evidence: EvidenceStore; config: () => Config }, guard: express.RequestHandler): void {
  const unavailable = (error: unknown, res: express.Response) => {
    if (error instanceof EvidenceError && error.code === "unavailable") {
      return void res.status(503).json({ code: "evidence-unavailable", error: "The evidence store is unavailable." });
    }
    throw error;
  };

  app.get("/api/routing/projects/:id", guard, (req, res) => {
    const config = deps.config();
    const project = config.projects.find(item => item.id === req.params.id);
    if (!project) return void res.status(404).json({ code: "unknown-project", error: "The project is not configured on this host." });
    try {
      res.json(routingStatus(deps.evidence, {
        projectId: project.id,
        saved: project.team?.routing,
        autonomy: autonomyOf(project),
        lineup: config.teams?.lineup,
        // The values a new run pins, so the status shows the prompt versions a new decision would use.
        publishHeads: (config.teams as { publishHeads?: boolean } | undefined)?.publishHeads !== false,
        entryTools: config.teams?.blackboard?.tools === true,
        // Owner criteria on: a goal cycle start carries the record digest, so the status reads that version.
        objectiveDigest: objectivePromptsOn(project),
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
