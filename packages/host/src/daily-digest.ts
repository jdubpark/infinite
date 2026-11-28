import type { Express } from "express";
import { z } from "zod";
import { ownerSteering, type TeamView } from "./team-types.js";
import type { ProductGoal } from "./goal-types.js";
import type { Mission } from "./mission-types.js";
import type { FuseView } from "./fuse/service.js";
import type { HaltView } from "./halt/service.js";

export type DigestItemKind = "host-receipt" | "agent-claim" | "evaluator-assessment" | "owner-decision";

export type DigestItem = {
  at: string;
  kind: DigestItemKind;
  scope: "host" | "project";
  projectId?: string;
  entity: "goal" | "team" | "mission" | "fuse" | "halt";
  entityId?: string;
  title: string;
  summary: string;
};

export type DailyDigest = {
  generatedAt: string;
  windowHours: number;
  since: string;
  counts: Record<DigestItemKind, number>;
  items: DigestItem[];
};

const MAX_DIGEST_ITEMS = 200;

const clip = (text: string, max = 200) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
};

const digestQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(168).optional(),
}).strict();

function collectFuseItems(fuse: FuseView | undefined, items: DigestItem[]) {
  if (!fuse) return;
  if (fuse.host.state === "open" && fuse.host.trip?.openedAt) {
    items.push({
      at: fuse.host.trip.openedAt,
      kind: "host-receipt",
      scope: "host",
      entity: "fuse",
      ...(fuse.host.trip.tripId ? { entityId: fuse.host.trip.tripId } : {}),
      title: "Host spend fuse open",
      summary: `Host spend fuse opened (${fuse.host.trip.cause}${fuse.host.trip.window ? `, ${fuse.host.trip.window}` : ""}).`,
    });
  }
  if (fuse.writeFailedAt) {
    items.push({
      at: fuse.writeFailedAt,
      kind: "host-receipt",
      scope: "host",
      entity: "fuse",
      title: "Host spend fuse write failure",
      summary: "Spend fuse state write failed; launches paused.",
    });
  }
  for (const project of fuse.projects) {
    if (project.state !== "open" || !project.trip?.openedAt) continue;
    items.push({
      at: project.trip.openedAt,
      kind: "host-receipt",
      scope: "project",
      projectId: project.projectId,
      entity: "fuse",
      ...(project.trip.tripId ? { entityId: project.trip.tripId } : {}),
      title: `Project spend fuse open (${project.projectId})`,
      summary: `Project spend fuse opened (${project.trip.cause}${project.trip.window ? `, ${project.trip.window}` : ""}).`,
    });
  }
}

function collectHaltItems(halt: HaltView | undefined, items: DigestItem[]) {
  if (!halt || !halt.readable) return;
  if (halt.host) {
    items.push({
      at: halt.host.at,
      kind: "host-receipt",
      scope: "host",
      entity: "halt",
      entityId: halt.host.haltId,
      title: "Host halt active",
      summary: halt.host.reason ? `Host halted by ${halt.host.by}: ${clip(halt.host.reason)}` : `Host halted by ${halt.host.by}.`,
    });
  }
  for (const project of halt.projects) {
    items.push({
      at: project.at,
      kind: "host-receipt",
      scope: "project",
      projectId: project.projectId,
      entity: "halt",
      entityId: project.haltId,
      title: `Project halt active (${project.projectId})`,
      summary: project.reason ? `Project halted by ${project.by}: ${clip(project.reason)}` : `Project halted by ${project.by}.`,
    });
  }
}

function collectTeamItems(teams: readonly TeamView[], items: DigestItem[]) {
  for (const team of teams) {
    if (team.status === "ready-for-review") {
      items.push({
        at: team.updatedAt,
        kind: "host-receipt",
        scope: "project",
        projectId: team.projectId,
        entity: "team",
        entityId: team.id,
        title: team.title,
        summary: `Verified team run ready for owner review${team.headCommit ? ` at ${team.headCommit.slice(0, 7)}` : ""}.`,
      });
    } else {
      const currentChecks = team.checks.filter(check => check.revision === team.revision);
      const passedChecks = currentChecks.filter(check => check.status === "passed" && typeof check.finishedAt === "string");
      if (passedChecks.length > 0 && passedChecks.length === currentChecks.length) {
        const latestAt = passedChecks.map(check => check.finishedAt!).sort().at(-1)!;
        items.push({
          at: latestAt,
          kind: "host-receipt",
          scope: "project",
          projectId: team.projectId,
          entity: "team",
          entityId: team.id,
          title: team.title,
          summary: "Host verification checks passed.",
        });
      }
    }
    for (const decision of team.decisions) {
      if (decision.defaultContinued === true) {
        items.push({
          at: decision.answeredAt ?? decision.createdAt,
          kind: "agent-claim",
          scope: "project",
          projectId: team.projectId,
          entity: "team",
          entityId: team.id,
          title: team.title,
          summary: `Autonomous default-continued question "${clip(decision.question, 120)}" with proposed answer "${clip(decision.answer ?? "", 120)}".`,
        });
      } else if (decision.answeredBy === "owner" && decision.answer) {
        items.push({
          at: decision.answeredAt ?? decision.createdAt,
          kind: "owner-decision",
          scope: "project",
          projectId: team.projectId,
          entity: "team",
          entityId: team.id,
          title: team.title,
          summary: `Owner answered "${clip(decision.question, 120)}": ${clip(decision.answer, 120)}.`,
        });
      }
    }
    if (team.deliveryReceipt) {
      items.push({
        at: team.deliveryReceipt.reportedAt,
        kind: "agent-claim",
        scope: "project",
        projectId: team.projectId,
        entity: "team",
        entityId: team.id,
        title: team.title,
        summary: `Agent-reported merge ${team.deliveryReceipt.mergeCommit.slice(0, 7)} (${team.deliveryReceipt.pullRequestUrl}): ${clip(team.deliveryReceipt.summary)}`,
      });
    }
    if (team.pullRequest) {
      items.push({
        at: team.pullRequest.reportedAt,
        kind: "agent-claim",
        scope: "project",
        projectId: team.projectId,
        entity: "team",
        entityId: team.id,
        title: team.title,
        summary: `Agent-reported pull request (${team.pullRequest.pullRequestUrl}): ${clip(team.pullRequest.summary)}`,
      });
    }
    if (team.noChange) {
      items.push({
        at: team.updatedAt,
        kind: "agent-claim",
        scope: "project",
        projectId: team.projectId,
        entity: "team",
        entityId: team.id,
        title: team.title,
        summary: `Agent-reported no change: ${clip(team.noChange.summary)}`,
      });
    }
    for (const entry of team.steering) {
      if (!ownerSteering(entry)) continue;
      items.push({
        at: entry.at,
        kind: "owner-decision",
        scope: "project",
        projectId: team.projectId,
        entity: "team",
        entityId: team.id,
        title: team.title,
        summary: `Owner steering: ${clip(entry.text)}`,
      });
    }
  }
}

function collectGoalItems(goals: readonly ProductGoal[], items: DigestItem[]) {
  for (const goal of goals) {
    for (const cycle of goal.cycles) {
      if (!cycle.assessment) continue;
      const { result, counts, at } = cycle.assessment;
      items.push({
        at,
        kind: "evaluator-assessment",
        scope: "project",
        projectId: goal.projectId,
        entity: "goal",
        entityId: goal.id,
        title: goal.title,
        summary: `Provisional evaluator assessment (cycle ${cycle.cycle}): ${result} (${counts.met} met, ${counts.notMet} not-met, ${counts.inconclusive} inconclusive, ${counts.pendingOwner} pending-owner).`,
      });
    }
    for (const outcome of goal.outcomes) {
      items.push({
        at: outcome.at,
        kind: "owner-decision",
        scope: "project",
        projectId: goal.projectId,
        entity: "goal",
        entityId: goal.id,
        title: goal.title,
        summary: `Owner recorded goal outcome (${outcome.result}): ${clip(outcome.summary)}`,
      });
    }
    for (const entry of goal.steering) {
      items.push({
        at: entry.at,
        kind: "owner-decision",
        scope: "project",
        projectId: goal.projectId,
        entity: "goal",
        entityId: goal.id,
        title: goal.title,
        summary: `Owner steering: ${clip(entry.text)}`,
      });
    }
  }
}

function collectMissionItems(missions: readonly Mission[], items: DigestItem[]) {
  for (const mission of missions) {
    const scope = mission.repoProjectIds.length === 1
      ? { scope: "project" as const, projectId: mission.repoProjectIds[0] }
      : { scope: "host" as const };
    if (mission.result) {
      items.push({
        at: mission.updatedAt,
        kind: "agent-claim",
        ...scope,
        entity: "mission",
        entityId: mission.id,
        title: mission.title,
        summary: `Agent-reported mission result: ${clip(mission.result)}`,
      });
    }
    for (const decision of mission.decisions) {
      if (decision.defaultContinued === true) {
        items.push({
          at: decision.answeredAt ?? decision.createdAt,
          kind: "agent-claim",
          ...scope,
          entity: "mission",
          entityId: mission.id,
          title: mission.title,
          summary: `Autonomous default-continued question "${clip(decision.question, 120)}" with proposed answer "${clip(decision.answer ?? "", 120)}".`,
        });
      } else if (decision.answeredBy === "owner" && decision.answer) {
        items.push({
          at: decision.answeredAt ?? decision.createdAt,
          kind: "owner-decision",
          ...scope,
          entity: "mission",
          entityId: mission.id,
          title: mission.title,
          summary: `Owner answered "${clip(decision.question, 120)}": ${clip(decision.answer, 120)}.`,
        });
      }
    }
    for (const entry of mission.steering) {
      if (entry.source && entry.source !== "slack" && !(typeof entry.source === "object" && entry.source.kind === "github-review")) continue;
      items.push({
        at: entry.at,
        kind: "owner-decision",
        ...scope,
        entity: "mission",
        entityId: mission.id,
        title: mission.title,
        summary: `Owner steering: ${clip(entry.text)}`,
      });
    }
  }
}

export function buildDailyDigest(input: {
  now: number;
  windowHours?: number;
  teams: readonly TeamView[];
  goals: readonly ProductGoal[];
  missions: readonly Mission[];
  fuse?: FuseView;
  halt?: HaltView;
}): DailyDigest {
  const rawHours = input.windowHours ?? 24;
  const windowHours = Number.isFinite(rawHours) ? Math.min(168, Math.max(1, Math.trunc(rawHours))) : 24;
  const sinceMs = input.now - windowHours * 3_600_000;
  const rawItems: DigestItem[] = [];
  collectFuseItems(input.fuse, rawItems);
  collectHaltItems(input.halt, rawItems);
  collectTeamItems(input.teams, rawItems);
  collectGoalItems(input.goals, rawItems);
  collectMissionItems(input.missions, rawItems);
  const filtered = rawItems
    .filter(item => {
      const atMs = Date.parse(item.at);
      return Number.isFinite(atMs) && atMs >= sinceMs;
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.at.localeCompare(a.at))
    .slice(0, MAX_DIGEST_ITEMS);
  const counts: Record<DigestItemKind, number> = {
    "host-receipt": 0,
    "agent-claim": 0,
    "evaluator-assessment": 0,
    "owner-decision": 0,
  };
  for (const item of filtered) counts[item.kind]++;
  return {
    generatedAt: new Date(input.now).toISOString(),
    windowHours,
    since: new Date(sinceMs).toISOString(),
    counts,
    items: filtered,
  };
}

export function registerDigestRoute(
  app: Pick<Express, "get">,
  sources: {
    teams: { list(): readonly TeamView[] };
    goals: { list(): readonly ProductGoal[] };
    missions: { list(): readonly Mission[] };
    fuse?: { view(): FuseView };
    halt?: { view(): HaltView };
    now?: () => number;
  },
): void {
  app.get("/api/digest", (req, res) => {
    const query = digestQuerySchema.parse(req.query);
    return res.json(buildDailyDigest({
      now: sources.now ? sources.now() : Date.now(),
      windowHours: query.windowHours,
      teams: sources.teams.list(),
      goals: sources.goals.list(),
      missions: sources.missions.list(),
      fuse: sources.fuse?.view(),
      halt: sources.halt?.view(),
    }));
  });
}
