import type { Express } from "express";
import { z } from "zod";
import { MissionProgressService, missionProgressQuerySchema, type MissionProgressSources } from "./mission-progress.js";
import type { MissionService } from "./missions.js";

export function registerMissionReadRoutes(app: Pick<Express, "get">, sources: MissionProgressSources & {
  missions: Pick<MissionService, "list" | "get">;
}) {
  const progress = new MissionProgressService(sources);
  const id = z.uuid();
  app.get("/api/missions", (_req, res) => res.json({ missions: sources.missions.list() }));
  app.get("/api/missions/:id", (req, res) => res.json(sources.missions.get(id.parse(req.params.id))));
  app.get("/api/missions/:id/progress", async (req, res) => {
    const query = missionProgressQuerySchema.parse(req.query);
    return res.json(await progress.read(id.parse(req.params.id), query.cursor));
  });
}
