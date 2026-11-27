import type express from "express";
import { z } from "zod";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceStatus } from "./evidence/types.js";
import {
  computeInterruptedTaskMetrics,
  type InterruptedRunFilter,
  type InterruptedTaskEvent,
  type InterruptedTaskRun,
} from "./interrupted-task-metrics.js";
import {
  computeRepairLoopMetrics,
  type RepairMetricsMember,
  type RepairMetricsRun,
  type RepairRunEvent,
  type RepairRunFilter,
} from "./repair-metrics.js";
import type { Provider } from "./types.js";
import type { UsageTotals } from "./usage.js";
import type { SessionUsage, UnmeasuredUsage } from "./usage-service.js";

const DAY_MS = 86_400_000;
const EVENT_KINDS = ["review.recorded", "repair.started", "ledger.gap"];
const INTERRUPTED_EVENT_KINDS = ["run.revision-advanced", "run.blocked"];
const EVENT_PAGE_LIMIT = 500;

const repairQuerySchema = z.object({
  project: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  days: z.coerce.number().int().min(1).max(366).default(30),
}).strict();

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

function readInterruptedRunEvents(evidence: Pick<EvidenceStore, "events">, runId: string): InterruptedTaskEvent[] {
  const events: InterruptedTaskEvent[] = [];
  let after = 0;
  for (;;) {
    const page = evidence.events({ runId, kinds: INTERRUPTED_EVENT_KINDS, after, limit: EVENT_PAGE_LIMIT });
    events.push(...page.events);
    if (!page.more || page.cursor <= after) return events;
    after = page.cursor;
  }
}

export interface RepairMetricsRouteDeps {
  runs: (filter?: RepairRunFilter) => readonly RepairMetricsRun[];
  memberUsage: (runId: string, memberId: string) => SessionUsage | UnmeasuredUsage;
  runEvents?: (runId: string) => readonly RepairRunEvent[];
  evidence?: Pick<EvidenceStore, "events"> & { status?(): EvidenceStatus };
  readable?: () => boolean;
  now?: () => number;
}

export interface InterruptedTaskMetricsRouteDeps {
  runs: (filter?: InterruptedRunFilter) => readonly InterruptedTaskRun[];
  evidence?: Pick<EvidenceStore, "events"> & { status?(): EvidenceStatus };
  events?: (runId: string) => readonly InterruptedTaskEvent[];
  now?: () => number;
}

function assertEvidenceReady(
  evidence: (Pick<EvidenceStore, "events"> & { status?(): EvidenceStatus }) | undefined,
): asserts evidence is Pick<EvidenceStore, "events"> & { status?(): EvidenceStatus } {
  if (!evidence || (evidence.status && evidence.status().state !== "ready")) {
    throw new EvidenceError("unavailable", "The evidence store is unavailable.");
  }
}

export function registerRepairMetricsRoute(app: Pick<express.Express, "get">, deps: RepairMetricsRouteDeps): void {
  app.get("/api/usage/repair-loops", (req, res) => {
    const query = repairQuerySchema.parse(req.query);
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
}

export function registerInterruptedTaskMetricsRoute(
  app: Pick<express.Express, "get">,
  deps: InterruptedTaskMetricsRouteDeps,
): void {
  app.get("/api/usage/interrupted-tasks", (req, res) => {
    const query = repairQuerySchema.parse(req.query);
    try {
      let readEvents: (runId: string) => readonly InterruptedTaskEvent[];
      if (deps.events) {
        readEvents = deps.events;
      } else {
        assertEvidenceReady(deps.evidence);
        const evidence = deps.evidence;
        readEvents = runId => readInterruptedRunEvents(evidence, runId);
      }
      const now = deps.now ? deps.now() : Date.now();
      const filter: InterruptedRunFilter = {
        ...(query.project === undefined ? {} : { projectId: query.project }),
        cutoffMs: now - query.days * DAY_MS,
      };
      const report = computeInterruptedTaskMetrics(deps.runs(filter), readEvents, {
        ...(query.project === undefined ? {} : { projectId: query.project }),
        days: query.days,
        now,
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
