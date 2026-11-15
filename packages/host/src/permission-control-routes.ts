import type express from "express";
import { z } from "zod";
import type { PermissionOwnerControls } from "./permission-pipeline.js";

const decisionId = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/, "A decision id is printable text with no spaces.");
const assignment = z.string().min(1).max(500).regex(/^[^\x00-\x1f\x7f]+$/, "An assignment has no control characters.");
const reopenBodySchema = z.object({ requestId: z.uuid(), decisionId }).strict();
const unlockBodySchema = z.object({ requestId: z.uuid(), assignment }).strict();

/**
 * The owner's controls over permission rejects and locks. `guards` are the host's owner-CLI checks, the same
 * as the delegation routes. Neither route allows a request.
 */
export function registerPermissionControlRoutes(
  app: express.Express,
  options: { guards: express.RequestHandler[]; controls: PermissionOwnerControls | undefined },
): void {
  const unavailable = (res: express.Response) => res.status(503).json({ error: "The permission journal is unavailable on this host." });
  app.post("/api/permissions/reopenings", ...options.guards, (req, res) => {
    if (!options.controls) return unavailable(res);
    const body = reopenBodySchema.parse(req.body);
    return res.json(options.controls.reopen(body.decisionId, { requestId: body.requestId }, { deviceId: String(res.locals.deviceId) }));
  });
  app.post("/api/permissions/unlocks", ...options.guards, (req, res) => {
    if (!options.controls) return unavailable(res);
    const body = unlockBodySchema.parse(req.body);
    return res.json(options.controls.unlock(body.assignment, { requestId: body.requestId }, { deviceId: String(res.locals.deviceId) }));
  });
}
