import type { RequestHandler } from "express";
import { emptyRecord, mainCheckRunnable, mainCheckSetting, viewOf, type MainCheckView } from "./main-check-state.js";
import type { Config } from "./types.js";

/**
 * The owner's read of one project's main check (INF-388). The body is the service's view: the record without
 * directories, roots or witnesses. A project with no record yet answers the empty view, with the setting's state.
 * The caller mounts it behind the owner role check, as the neighbouring project routes are.
 */
export type MainCheckBody = MainCheckView & {
  /** False when the host never checks this project, whatever its setting says: it has no configured checks, no team root, or no GitHub source. */
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
