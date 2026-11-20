import type express from "express";
import { z } from "zod";
import { EvidenceError } from "./evidence/types.js";
import { validateJobSchema } from "./eval-jobs.js";
import type { BaselineJobRequest, EvalHostApi, EvalRefusal, ValidateJobRequest } from "./eval-types.js";
import { baselineJobSchema } from "./eval-trial-jobs.js";

const uuid = z.uuid();
const TASK_ID = /^(captured|mined):[A-Za-z0-9:._-]{1,200}$/;
const JOB_ACTIONS = ["pause", "resume", "cancel"] as const;
const createBody = z.strictObject({
  projectId: z.string().min(1).max(200),
  requestId: z.uuid(),
  job: z.record(z.string(), z.unknown()),
});

/** The fixed sentence of each refusal code. None names an ID, a file, or a commit. */
const MESSAGES: Record<EvalRefusal["code"], string> = {
  "invalid-eval-request": "The eval request is not valid.",
  "unknown-project": "The project is not configured on this host.",
  "unknown-job": "No job has this ID.",
  "unknown-task": "No task has this ID.",
  "job-active": "This project already has an active validation job.",
  "request-conflict": "This request ID already names a different job.",
  "eval-config-incomplete": "The project's validation settings are incomplete.",
  "profile-not-approved": "The trial profile is not approved for this project.",
  "invalid-job-transition": "The job cannot take this action in its current state.",
  "task-not-active": "The task is not a candidate or valid task.",
  "evidence-unavailable": "The evidence store is unavailable.",
};

/**
 * The replay eval routes: the corpus summary, the validate jobs, and the owner's task retirement. Reads sit behind
 * `read` (owner, controller, viewer); every change sits behind `owner`. A host refusal answers its own status and code.
 * An unavailable store answers 503 `evidence-unavailable`. No route returns a capsule, a patch, a file name, a case, or
 * a commit.
 */
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

/** Maps a store that is unavailable to 503, and lets every other failure reach the framework's handler. */
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

/** A job body parsed by its own kind's schema, or undefined: a body with no known kind, or one that does not parse. */
function jobOf(value: unknown): ValidateJobRequest | BaselineJobRequest | undefined {
  const kind = typeof value === "object" && value !== null && "kind" in value ? value.kind : undefined;
  const parsed = kind === "validate" ? validateJobSchema.safeParse(value)
    : kind === "baseline" ? baselineJobSchema.safeParse(value)
    : undefined;
  return parsed?.success ? parsed.data : undefined;
}

/** A job ID is a UUID; the host stores it in lower case. */
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

/** Answers a host result: its refusal, or its value as JSON with 200. */
function respond(res: express.Response, result: unknown): void {
  if (isRefusal(result)) return refuse(res, result);
  res.json(result);
}
