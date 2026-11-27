import type express from "express";
import type { CalibrationRefusal, JudgeCalibrations } from "./judge-calibration-jobs.js";

type Refusal = CalibrationRefusal | { status: 503; code: "evidence-unavailable" };
const CALIBRATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESSAGES: Record<Refusal["code"], string> = {
  "judge-not-configured": "The host has no judge configured.",
  "judge-profile-mismatch": "That profile is not the configured judge.",
  "judge-launch-missing": "The judge's provider has no eval login on the host.",
  "calibration-active": "A calibration is already running.",
  "request-conflict": "This request ID was already used for a different request.",
  "eval-config-incomplete": "The host's eval configuration is incomplete.",
  "too-few-pairs": "The projects hold too few resolved pairs for this request.",
  "invalid-calibration-request": "The host refused the request as invalid.",
  "unknown-calibration": "No calibration has this ID.",
  "evidence-unavailable": "The evidence store is unavailable.",
};

export function judgeRoutes(
  app: express.Express,
  deps: { judgements: Pick<JudgeCalibrations, "create" | "cancel" | "views">; ready: () => boolean },
  readGuard: express.RequestHandler,
  ownerGuard: express.RequestHandler,
): void {
  const { judgements, ready } = deps;

  app.get("/api/duels/judges", readGuard, (_req, res) => {
    if (!ready()) return refuse(res, { status: 503, code: "evidence-unavailable" });
    res.json({ calibrations: judgements.views() });
  });

  app.post("/api/duels/judges/calibrations", ownerGuard, (req, res) => {
    if (!ready()) return refuse(res, { status: 503, code: "evidence-unavailable" });
    const result = judgements.create(req.body);
    if ("code" in result) return refuse(res, result);
    res.status(201).json(result);
  });

  app.post("/api/duels/judges/calibrations/:id/cancel", ownerGuard, (req, res) => {
    if (!ready()) return refuse(res, { status: 503, code: "evidence-unavailable" });
    const id = String(req.params.id).toLowerCase();
    if (!CALIBRATION_ID.test(id)) return refuse(res, { status: 404, code: "unknown-calibration" });
    const result = judgements.cancel(id);
    if ("code" in result) return refuse(res, result);
    res.json(result);
  });
}

function refuse(res: express.Response, refusal: Refusal): void {
  res.status(refusal.status).json({ code: refusal.code, error: MESSAGES[refusal.code] });
}
