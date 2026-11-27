import express from "express";
import { z } from "zod";
import type { PermissionAgentCoreService } from "./permission-core.js";
import type { PermissionMeasurements } from "./evidence/permission-measurements.js";
import { REPLAY_SET_BYTES, replaySetSchema, type PermissionReplayJobs, type ReplayJob } from "./permission-replay.js";
import type { PermissionReadiness } from "./permission-agent-types.js";

export const PERMISSION_REPLAY_PATH = /^\/api\/permissions\/replays$/;

const replayBodySchema = z.object({ requestId: z.uuid(), set: replaySetSchema }).strict();

const jobView = (job: ReplayJob) => ({
  id: job.id, requestId: job.requestId, state: job.state, done: job.done, total: job.total, startedAt: job.startedAt,
  ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}), ...(job.error ? { error: job.error } : {}),
  ...(job.result ? { result: { id: job.result.id, binding: job.result.binding, cases: job.result.cases, finishedAt: job.result.finishedAt,
    set: job.result.set, byClass: job.result.byClass, byTier: job.result.byTier } } : {}),
});

export interface PermissionAgentStatus {
  readiness: PermissionReadiness;
  replay: {
    latest: { id: string; finishedAt: string; cases: number; missRate: { count: number; relevant: number; rate: number | null; lower: number; upper: number } } | null;
    running: { id: string; done: number; total: number } | null;
  };
}

export function permissionAgentStatus(core: PermissionAgentCoreService | undefined, measurements: PermissionMeasurements | undefined, jobs: PermissionReplayJobs | undefined): PermissionAgentStatus {
  if (!core) return { readiness: { ready: false, reasons: ["The permission agent's decision core is unavailable on this host."] }, replay: { latest: null, running: null } };
  let readiness: PermissionReadiness;
  let latest: PermissionAgentStatus["replay"]["latest"] = null;
  try {
    readiness = core.readiness();
    const stored = measurements?.latest(core.binding());
    if (stored) latest = { id: stored.id, finishedAt: stored.finishedAt, cases: stored.cases, missRate: stored.missRate };
  } catch {
    readiness = { ready: false, reasons: ["The replay results cannot be read on this host."] };
  }
  const running = jobs?.current();
  return { readiness, replay: { latest, running: running ? { id: running.id, done: running.done, total: running.total } : null } };
}

export function registerPermissionAgentRoutes(app: express.Express, deps: {
  requireRole: (roles: ("owner" | "controller" | "viewer")[]) => express.RequestHandler;
  requireOwnerCli: express.RequestHandler;
  jobs: PermissionReplayJobs | undefined;
}) {
  const unavailable = (res: express.Response) => res.status(503).json({ error: "Permission replays are unavailable on this host." });
  app.post("/api/permissions/replays", deps.requireRole(["owner"]), deps.requireOwnerCli, express.json({ limit: REPLAY_SET_BYTES }), (req, res) => {
    if (!deps.jobs) return unavailable(res);
    const body = replayBodySchema.parse(req.body);
    const started = deps.jobs.start(body.requestId, body.set);
    if ("error" in started) {
      if (started.error === "conflict") return res.status(409).json({ error: "This request ID already started a replay of another set." });
      if (started.error === "busy") return res.status(409).json({ error: "A replay is already running on this host." });
      return unavailable(res);
    }
    return res.status(202).json({ job: jobView(started.job) });
  });
  app.get("/api/permissions/replays/:id", deps.requireRole(["owner"]), (req, res) => {
    if (!deps.jobs) return unavailable(res);
    const job = deps.jobs.get(z.uuid().parse(req.params.id));
    if (!job) return res.status(404).json({ error: "No replay with this ID runs or ran since the host started." });
    return res.json({ job: jobView(job) });
  });
}
