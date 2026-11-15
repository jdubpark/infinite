import type express from "express";
import { z } from "zod";
import type { GoalService } from "./goals.js";
import type { TeamService } from "./teams.js";

const uuid = z.uuid();
const recordQuery = z.strictObject({ version: z.string().regex(/^[1-9][0-9]{0,5}$/).optional() });

/** The two objective record reads. Each answers the record as it was at `version` (default: the latest). Reads take no lock and write nothing. */
export function objectiveRoutes(app: express.Express,
  services: { goals: Pick<GoalService, "objectiveRecord">; teams: Pick<TeamService, "objectiveRecord"> }, read: express.RequestHandler): void {
  // A UUID is case-insensitive; the host stores its ids in lower case.
  const recordId = (value: unknown) => uuid.parse(String(value).toLowerCase());
  app.get("/api/goals/:id/record", read, (req, res) => {
    const query = recordQuery.parse(req.query);
    res.json(services.goals.objectiveRecord(recordId(req.params.id), query.version === undefined ? undefined : Number(query.version)));
  });
  app.get("/api/teams/:id/record", read, (req, res) => {
    const query = recordQuery.parse(req.query);
    res.json(services.teams.objectiveRecord(recordId(req.params.id), query.version === undefined ? undefined : Number(query.version)));
  });
}
