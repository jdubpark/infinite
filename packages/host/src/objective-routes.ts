import type express from "express";
import { z } from "zod";
import type { GoalService } from "./goals.js";
import type { TeamService } from "./teams.js";
import type { TeamVerdicts } from "./team-verdicts.js";
import { goalVerdictsView } from "./verdict-view.js";

const uuid = z.uuid();
const recordQuery = z.strictObject({ version: z.string().regex(/^[1-9][0-9]{0,5}$/).optional() });

export function objectiveRoutes(app: express.Express,
  services: { goals: Pick<GoalService, "objectiveRecord" | "correctObjective" | "get" | "metrics">;
    teams: Pick<TeamService, "objectiveRecord"> & { verdicts: Pick<TeamVerdicts, "detail"> } },
  read: express.RequestHandler, owner: express.RequestHandler): void {
  const recordId = (value: unknown) => uuid.parse(String(value).toLowerCase());
  app.get("/api/goals/:id/record", read, (req, res) => {
    const query = recordQuery.parse(req.query);
    res.json(services.goals.objectiveRecord(recordId(req.params.id), query.version === undefined ? undefined : Number(query.version)));
  });
  app.post("/api/goals/:id/record", owner, async (req, res) => res.json(await services.goals.correctObjective(recordId(req.params.id), req.body)));
  app.get("/api/goals/:id/verdicts", read, (req, res) => {
    res.json(goalVerdictsView(services.goals.get(recordId(req.params.id)), id => services.teams.verdicts.detail(id)));
  });
  app.get("/api/goals/:id/metrics", read, (req, res) => res.json(services.goals.metrics(recordId(req.params.id))));
  app.get("/api/teams/:id/record", read, (req, res) => {
    const query = recordQuery.parse(req.query);
    res.json(services.teams.objectiveRecord(recordId(req.params.id), query.version === undefined ? undefined : Number(query.version)));
  });
}
