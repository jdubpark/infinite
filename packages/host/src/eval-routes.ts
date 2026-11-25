import type express from "express";
import { z } from "zod";
import { EvidenceError } from "./evidence/types.js";
import { validateJobSchema } from "./eval-jobs.js";
import type { BaselineJobRequest, ComparisonJobRequest, EvalHostApi, EvalRefusal, ValidateJobRequest } from "./eval-types.js";
import { baselineJobSchema } from "./eval-trial-jobs.js";
import { comparisonJobSchema } from "./eval-compare-jobs.js";

const uuid = z.uuid();
const TASK_ID = /^(captured|mined):[A-Za-z0-9:._-]{1,200}$/;
const JOB_ACTIONS = ["pause", "resume", "cancel"] as const;
const createBody = z.strictObject({
  projectId: z.string().min(1).max(200),
  requestId: z.uuid(),
  job: z.record(z.string(), z.unknown()),
});

const MESSAGES: Record<EvalRefusal["code"], string> = {
  "invalid-eval-request": "The eval request is not valid.",
  "unknown-project": "The project is not configured on this host.",
  "unknown-job": "No job has this ID.",
  "unknown-task": "No task has this ID.",
  "job-active": "This project already has an active job of this kind.",
  "request-conflict": "This request ID already names a different job.",
  "eval-config-incomplete": "The project's validation settings are incomplete.",
  "profile-not-approved": "The trial profile is not approved for this project.",
  "invalid-job-transition": "The job cannot take this action in its current state.",
  "task-not-active": "The task is not a candidate or valid task.",
  "evidence-unavailable": "The evidence store is unavailable.",
  "too-few-tasks": "The set has too few valid tasks for this job.",
  "subject-confirmed": "This configuration pair already had its confirm job.",
  "report-not-ready": "The job has no report yet.",
  "report-unreadable": "The job's record cannot be read, so it has no report.",
  "no-report": "Only compare and confirm jobs have reports.",
};

export function evalRoutes(
  app: express.Express,
  deps: { host: EvalHostApi },
  readGuard: express.RequestHandler,
  ownerGuard: express.RequestHandler,
): void {
  const host = deps.host;

  app.get("/api/eval/projects/:id", readGuard, guarded(async (req, res) => {
    respond(res, await host.summary(String(req.params.id)));
  }));

  app.get("/api/eval/jobs", readGuard, guarded(async (_req, res) => {
    respond(res, host.jobs());
  }));

  app.get("/api/eval/jobs/:id", readGuard, guarded(async (req, res) => {
    const id = jobId(req.params.id);
    if (id === undefined) return refuse(res, invalid());
    respond(res, host.job(id));
  }));

  app.get("/api/eval/jobs/:id/report", readGuard, guarded(async (req, res) => {
    const id = jobId(req.params.id);
    if (id === undefined) return refuse(res, invalid());
    respond(res, host.report(id));
  }));

  app.get("/api/eval/projects/:id/priors", readGuard, guarded(async (req, res) => {
    respond(res, host.priors(String(req.params.id)));
  }));

  app.post("/api/eval/jobs", ownerGuard, guarded(async (req, res) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return refuse(res, invalid());
    const job = jobOf(body.data.job);
    if (job === undefined) return refuse(res, invalid());
    const result = host.create(body.data.projectId, job, body.data.requestId.toLowerCase());
    if (isRefusal(result)) return refuse(res, result);
    res.status(result.created ? 201 : 200).json(result);
  }));

  for (const action of JOB_ACTIONS) {
    app.post(`/api/eval/jobs/:id/${action}`, ownerGuard, guarded(async (req, res) => {
      const id = jobId(req.params.id);
      if (id === undefined) return refuse(res, invalid());
      respond(res, host.control(id, action));
    }));
  }

  app.post("/api/eval/tasks/:id/retire", ownerGuard, guarded(async (req, res) => {
    const taskId = String(req.params.id);
    if (!TASK_ID.test(taskId)) return refuse(res, invalid());
    respond(res, await host.retire(taskId));
  }));
}

function guarded(handler: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof EvidenceError && error.code === "unavailable") return refuse(res, { status: 503, code: "evidence-unavailable" });
      throw error;
    }
  };
}

function jobOf(value: unknown): ValidateJobRequest | BaselineJobRequest | ComparisonJobRequest | undefined {
  const kind = typeof value === "object" && value !== null && "kind" in value ? value.kind : undefined;
  const parsed = kind === "validate" ? validateJobSchema.safeParse(value)
    : kind === "baseline" ? baselineJobSchema.safeParse(value)
    : kind === "compare" || kind === "confirm" ? comparisonJobSchema.safeParse(value)
    : undefined;
  return parsed?.success ? parsed.data : undefined;
}

function jobId(value: unknown): string | undefined {
  const parsed = uuid.safeParse(String(value).toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

function invalid(): EvalRefusal {
  return { status: 400, code: "invalid-eval-request" };
}

function isRefusal(value: unknown): value is EvalRefusal {
  return typeof value === "object" && value !== null && "code" in value && "status" in value && typeof value.status === "number";
}

function refuse(res: express.Response, refusal: EvalRefusal): void {
  res.status(refusal.status).json({ code: refusal.code, error: MESSAGES[refusal.code] });
}

function respond(res: express.Response, result: unknown): void {
  if (isRefusal(result)) return refuse(res, result);
  res.json(result);
}
