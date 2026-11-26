import type express from "express";
import { z } from "zod";
import type { EventQuery } from "./evidence/store.js";
import { EvidenceError, type EvidenceStatus, type RunEvent } from "./evidence/types.js";
import { computeInterruptedTaskMetrics } from "./interrupted-task-metrics.js";
import { computeRepairLoopMetrics } from "./repair-metrics.js";
import type { TeamMember, TeamRun } from "./team-types.js";
import type { Provider } from "./types.js";
import type { UsageTotals } from "./usage.js";
import type { SessionUsage, UnmeasuredUsage } from "./usage-service.js";

const repairLoopsQuerySchema = z.object({
  project: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  days: z.coerce.number().int().min(1).max(366).default(30),
}).strict();

export type RepairMetricsEventsReader =
  | ((runId: string) => readonly RunEvent[])
  | {
    events(query: EventQuery): { events: RunEvent[]; cursor: number; more: boolean };
    status?(): EvidenceStatus;
  };

export interface RepairMetricsRouteDeps {
  runs: () => readonly TeamRun[];
  memberUsage: (runId: string, memberId: string) => SessionUsage | UnmeasuredUsage;
  readable?: () => boolean;
  events?: RepairMetricsEventsReader;
  now?: () => number;
}

function assertEventsReady(events: RepairMetricsEventsReader | undefined): asserts events is RepairMetricsEventsReader {
  if (!events) throw new EvidenceError("unavailable", "The evidence store is unavailable.");
  if (typeof events !== "function" && events.status && events.status().state !== "ready") {
    throw new EvidenceError("unavailable", "The evidence store is unavailable.");
  }
}

function readRunEvents(events: RepairMetricsEventsReader, runId: string): readonly RunEvent[] {
  if (typeof events === "function") return events(runId);
  const list: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = events.events({ runId, kinds: ["run.revision-advanced", "run.blocked"], after, limit: 500 });
    list.push(...page.events);
    if (!page.more) return list;
    after = page.cursor;
  }
}

export function registerRepairMetricsRoute(app: Pick<express.Express, "get">, deps: RepairMetricsRouteDeps): void {
  app.get("/api/usage/repair-loops", (req, res) => {
    const query = repairLoopsQuerySchema.parse(req.query);
    if (deps.readable && !deps.readable()) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    const lookup = (member: TeamMember, _fallbackProvider: Provider): UsageTotals | undefined => {
      const found = deps.memberUsage(member.runId, member.memberId);
      if (!found.measured) {
        if (found.unavailable) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
        return undefined;
      }
      if (found.coverage !== "complete" || found.pricing.unknown > 0) return undefined;
      return found;
    };
    const report = computeRepairLoopMetrics(deps.runs(), lookup, {
      ...(query.project === undefined ? {} : { projectId: query.project }),
      days: query.days,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    return void res.json(report);
  });

  app.get("/api/usage/interrupted-tasks", (req, res) => {
    const query = repairLoopsQuerySchema.parse(req.query);
    try {
      assertEventsReady(deps.events);
      if (deps.readable && !deps.readable()) throw new EvidenceError("unavailable", "The evidence store is unavailable.");
      const report = computeInterruptedTaskMetrics(deps.runs(), runId => readRunEvents(deps.events!, runId), {
        ...(query.project === undefined ? {} : { projectId: query.project }),
        days: query.days,
        ...(deps.now ? { now: deps.now() } : {}),
      });
      return void res.json(report);
    } catch (error) {
      if (error instanceof EvidenceError && error.code === "unavailable") {
        return void res.status(503).json({ code: "evidence-unavailable", error: "The evidence store is unavailable." });
      }
      throw error;
    }
  });
}
