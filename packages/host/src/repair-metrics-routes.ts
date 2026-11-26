import type express from "express";
import { z } from "zod";
import { EvidenceError } from "./evidence/types.js";
import { computeRepairLoopMetrics } from "./repair-metrics.js";
import type { TeamMember, TeamRun } from "./team-types.js";
import type { Provider } from "./types.js";
import type { UsageTotals } from "./usage.js";
import type { SessionUsage, UnmeasuredUsage } from "./usage-service.js";

const repairLoopsQuerySchema = z.object({
  project: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  days: z.coerce.number().int().min(1).max(366).default(30),
}).strict();

export interface RepairMetricsRouteDeps {
  runs: () => readonly TeamRun[];
  memberUsage: (runId: string, memberId: string) => SessionUsage | UnmeasuredUsage;
  now?: () => number;
}

export function registerRepairMetricsRoute(app: Pick<express.Express, "get">, deps: RepairMetricsRouteDeps): void {
  app.get("/api/usage/repair-loops", (req, res) => {
    const query = repairLoopsQuerySchema.parse(req.query);
    const lookup = (member: TeamMember, _fallbackProvider: Provider): UsageTotals | undefined => {
      const found = deps.memberUsage(member.runId, member.memberId);
      if (!found.measured) {
        if (found.unavailable) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
        return undefined;
      }
      return found;
    };
    const report = computeRepairLoopMetrics(deps.runs(), lookup, {
      ...(query.project === undefined ? {} : { projectId: query.project }),
      days: query.days,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    return void res.json(report);
  });
}
