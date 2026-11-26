import type express from "express";
import { z } from "zod";
import type { EventQuery, EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceStatus, type RunEvent } from "./evidence/types.js";
import { computeInterruptedTaskMetrics } from "./interrupted-task-metrics.js";
import {
  computeRepairLoopMetrics,
  type RepairMetricsMember,
  type RepairMetricsRun,
  type RepairRunEvent,
  type RepairRunFilter,
} from "./repair-metrics.js";
import type { TeamRun } from "./team-types.js";
import type { Provider } from "./types.js";
import type { UsageTotals } from "./usage.js";
import type { SessionUsage, UnmeasuredUsage } from "./usage-service.js";

const DAY_MS = 86_400_000;
const EVENT_KINDS = ["review.recorded", "repair.started", "ledger.gap"];
const INTERRUPTED_EVENT_KINDS = ["run.revision-advanced", "run.blocked"];
const EVENT_PAGE_LIMIT = 500;

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

export function readRepairRunEvents(evidence: Pick<EvidenceStore, "events">, runId: string): RepairRunEvent[] {
  const events: RepairRunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = evidence.events({ runId, kinds: EVENT_KINDS, after, limit: EVENT_PAGE_LIMIT });
    events.push(...page.events);
    if (!page.more || page.cursor <= after) break;
    after = page.cursor;
  }
  return events;
}

export interface RepairMetricsRouteDeps {
  runs: (filter?: RepairRunFilter) => readonly RepairMetricsRun[];
  interruptedRuns?: () => readonly TeamRun[];
  memberUsage: (runId: string, memberId: string) => SessionUsage | UnmeasuredUsage;
  runEvents?: (runId: string) => readonly RepairRunEvent[];
  evidence?: Pick<EvidenceStore, "events"> & { status?(): EvidenceStatus };
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
    const page = events.events({ runId, kinds: INTERRUPTED_EVENT_KINDS, after, limit: EVENT_PAGE_LIMIT });
    list.push(...page.events);
    if (!page.more || page.cursor <= after) return list;
    after = page.cursor;
  }
}

export function registerRepairMetricsRoute(app: Pick<express.Express, "get">, deps: RepairMetricsRouteDeps): void {
  app.get("/api/usage/repair-loops", (req, res) => {
    const query = repairLoopsQuerySchema.parse(req.query);
    if (deps.readable && !deps.readable()) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    const now = deps.now ? deps.now() : Date.now();
    const cutoffMs = now - query.days * DAY_MS;
    const filter: RepairRunFilter = { ...(query.project === undefined ? {} : { projectId: query.project }), cutoffMs };
    const lookup = (member: RepairMetricsMember, _fallbackProvider: Provider): UsageTotals | undefined => {
      if (member.status !== "stopped") return undefined;
      const found = deps.memberUsage(member.runId, member.memberId);
      if (!found.measured) {
        if (found.unavailable) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
        return undefined;
      }
      if (found.coverage !== "complete" || found.pricing.unknown > 0) return undefined;
      return found;
    };
    const runEvents = deps.runEvents
      ?? (deps.evidence ? (runId: string) => readRepairRunEvents(deps.evidence!, runId) : undefined);
    const report = computeRepairLoopMetrics(deps.runs(filter), lookup, {
      ...(query.project === undefined ? {} : { projectId: query.project }),
      days: query.days,
      now,
      ...(runEvents ? { runEvents } : {}),
    });
    return void res.json(report);
  });

  app.get("/api/usage/interrupted-tasks", (req, res) => {
    const query = repairLoopsQuerySchema.parse(req.query);
    try {
      const eventsSource = deps.events ?? deps.evidence;
      assertEventsReady(eventsSource);
      const runs = (deps.interruptedRuns ?? (() => deps.runs() as readonly TeamRun[]))();
      const report = computeInterruptedTaskMetrics(runs, runId => readRunEvents(eventsSource, runId), {
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