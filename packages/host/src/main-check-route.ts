import type { RequestHandler } from "express";
import { emptyRecord, mainCheckRunnable, mainCheckSetting, viewOf, type MainCheckView } from "./main-check-state.js";
import type { Config } from "./types.js";

export type MainCheckBody = MainCheckView & {
  runnable: boolean;
};

export function mainCheckRoute(config: Pick<Config, "projects" | "teams">, view: (projectId: string) => MainCheckView | undefined): RequestHandler {
  return (req, res) => {
    const projectId = String(req.params.id);
    const project = config.projects.find(item => item.id === projectId);
    if (!project) return void res.status(404).json({ error: "Unknown project" });
    const body: MainCheckBody = { ...(view(projectId) ?? viewOf(emptyRecord(), mainCheckSetting(project.team) !== undefined)), runnable: mainCheckRunnable(config, project) };
    res.json(body);
  };
}
