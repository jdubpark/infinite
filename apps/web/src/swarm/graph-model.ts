import type { Agent, AgentState, CodeMap, SessionTouches, Swarm, SwarmModel, Unit } from "./types";

export const GRAPH_BUDGET = { agents: 60, projects: 6, areas: 120, codeLinks: 400 };
const NEIGHBOURS_PER_AREA = 3;

export type GraphNode = {
  id: string;
  kind: "mission" | "unit" | "agent" | "project" | "area";
  side: "swarm" | "code";
  label: string;
  agentId?: string;
  unitId?: string;
  projectId?: string;
  path?: string;
  symbols?: number;
  touched?: boolean;
  heat?: number;
  unobserved?: boolean;
};
export type LinkKind = "member" | "dispatch" | "depends" | "planned" | "read" | "edit" | "integrated" | "code" | "contains";
export type GraphLink = { id: string; source: string; target: string; kind: LinkKind; weight: number };
export type GraphData = {
  nodes: GraphNode[];
  links: GraphLink[];
  dropped: { agents: number; projects: number; areas: number; codeLinks: number };
  codeGraph: "on" | "partial" | "off" | "none";
  unobserved: number;
};
export type GraphInput = {
  model: SwarmModel;
  maps: Record<string, CodeMap | undefined>;
  touches: Record<string, SessionTouches | undefined>;
  projectNames: Record<string, string>;
};

export const nodeId = {
  mission: (id: string) => `mission:${id}`,
  unit: (id: string) => `unit:${id}`,
  agent: (id: string) => `agent:${id}`,
  project: (id: string) => `project:${id}`,
  area: (projectId: string, path: string) => `area:${projectId}:${path}`,
};
const linkId = (kind: LinkKind, source: string, target: string) => `${kind}:${source}>${target}`;

export function areaOf(path: string, areas: ReadonlySet<string> | undefined): string {
  const dirs = path.split("/").slice(0, -1);
  if (!areas) return dirs.slice(0, 2).join("/") || ".";
  for (let depth = dirs.length; depth >= 1; depth--) {
    const candidate = dirs.slice(0, depth).join("/");
    if (areas.has(candidate)) return candidate;
  }
  return ".";
}

export function areaOfOwned(path: string, areas: ReadonlySet<string> | undefined): string {
  const clean = path.replace(/\/+$/, "");
  if (areas) return areaOf(`${clean}/_`, areas);
  const isFile = /\.[A-Za-z0-9]{1,8}$/.test(clean.split("/").pop() ?? "");
  return areaOf(isFile ? clean : `${clean}/_`, undefined);
}

function usablePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0");
}

export function contextRequests(model: SwarmModel): { projects: string[]; teams: string[]; sessions: string[] } {
  const projects = new Set<string>();
  const teams: string[] = [];
  const sessions: string[] = [];
  for (const swarm of model.live) {
    switch (swarm.kind) {
      case "mission":
        for (const unit of swarm.units) {
          if (!unit.live) continue;
          projects.add(unit.projectId);
          teams.push(unit.id);
        }
        if (swarm.coordinator?.sessionId) sessions.push(swarm.coordinator.sessionId);
        break;
      case "team":
        for (const unit of swarm.units) {
          if (!unit.live) continue;
          projects.add(unit.projectId);
          teams.push(unit.id);
        }
        break;
      case "solo":
        for (const agent of swarm.loose) {
          sessions.push(agent.sessionId ?? agent.id);
          if (agent.projectId) projects.add(agent.projectId);
        }
        break;
    }
  }
  return { projects: [...projects].sort(), teams, sessions: [...new Set(sessions)].sort() };
}

export const SESSION_BATCH = 12;

export function nextBatch<T>(items: T[], offset: number, size: number): { batch: T[]; offset: number } {
  if (items.length <= size) return { batch: items, offset: 0 };
  const start = offset % items.length;
  const batch = Array.from({ length: size }, (_, index) => items[(start + index) % items.length]);
  return { batch, offset: (start + size) % items.length };
}

const DROP_RANK: Partial<Record<AgentState, number>> = { stopped: 0, reported: 1, queued: 2 };

type Placed = { agent: Agent; swarm: Swarm; unit?: Unit; hub?: string };
type AreaCandidate = { id: string; projectId: string; path: string; touched: boolean; agents: Set<string>; touchWeight: number; neighbourWeight: number };

export function buildGraph({ model, maps, touches, projectNames }: GraphInput): GraphData {
  const dropped = { agents: 0, projects: 0, areas: 0, codeLinks: 0 };
  const nodes = new Map<string, GraphNode>();
  const links = new Map<string, GraphLink>();
  const addLink = (kind: LinkKind, source: string, target: string, weight: number) => {
    const id = linkId(kind, source, target);
    const existing = links.get(id);
    if (existing) existing.weight += weight;
    else links.set(id, { id, source, target, kind, weight });
  };
  const readyMap = (projectId: string) => {
    const map = maps[projectId];
    return map?.state === "ready" ? map : undefined;
  };
  const areaSets = new Map<string, ReadonlySet<string> | undefined>();
  const areaSetOf = (projectId: string) => {
    if (!areaSets.has(projectId)) {
      const map = readyMap(projectId);
      areaSets.set(projectId, map ? new Set(map.areas.map(area => area.id)) : undefined);
    }
    return areaSets.get(projectId);
  };

  const placed: Placed[] = [];
  const seen = new Set<string>();
  const place = (agent: Agent, swarm: Swarm, unit?: Unit, hub?: string) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    placed.push({ agent, swarm, unit, hub });
  };
  for (const swarm of model.live) {
    switch (swarm.kind) {
      case "mission":
        if (swarm.coordinator) place(swarm.coordinator, swarm, undefined, nodeId.mission(swarm.id));
        for (const unit of swarm.units) {
          if (!unit.live) continue;
          for (const agent of [...unit.agents, ...unit.side]) place(agent, swarm, unit, nodeId.unit(unit.id));
        }
        break;
      case "team":
        for (const unit of swarm.units) {
          if (!unit.live) continue;
          for (const agent of [...unit.agents, ...unit.side]) place(agent, swarm, unit, nodeId.unit(unit.id));
        }
        break;
      case "solo":
        for (const agent of swarm.loose) place(agent, swarm);
        break;
    }
  }
  const overAgents = placed.length - GRAPH_BUDGET.agents;
  const cut = new Set<number>();
  if (overAgents > 0) {
    const order = placed.map((_, index) => index)
      .sort((a, b) => (DROP_RANK[placed[a].agent.state] ?? 3) - (DROP_RANK[placed[b].agent.state] ?? 3) || b - a);
    for (const index of order.slice(0, overAgents)) cut.add(index);
    dropped.agents = cut.size;
  }
  const kept = placed.filter((_, index) => !cut.has(index));

  for (const swarm of model.live) {
    if (swarm.kind === "solo") continue;
    if (swarm.kind === "mission") {
      nodes.set(nodeId.mission(swarm.id), { id: nodeId.mission(swarm.id), kind: "mission", side: "swarm", label: swarm.title });
    }
    for (const unit of swarm.units) {
      if (!unit.live) continue;
      nodes.set(nodeId.unit(unit.id), { id: nodeId.unit(unit.id), kind: "unit", side: "swarm", label: unit.title, unitId: unit.id, projectId: unit.projectId });
    }
  }
  for (const swarm of model.live) {
    if (swarm.kind === "solo") continue;
    for (const unit of swarm.units) {
      if (!unit.live) continue;
      if (swarm.kind === "mission") addLink("dispatch", nodeId.mission(swarm.id), nodeId.unit(unit.id), 1);
      for (const dependency of unit.dependsOn) {
        if (dependency !== unit.id && nodes.has(nodeId.unit(dependency))) addLink("depends", nodeId.unit(unit.id), nodeId.unit(dependency), 1);
      }
    }
  }
  for (const { agent, hub } of kept) {
    const id = nodeId.agent(agent.id);
    nodes.set(id, { id, kind: "agent", side: "swarm", label: agent.title, agentId: agent.id, projectId: agent.projectId });
    if (hub && nodes.has(hub)) addLink("member", id, hub, 1);
  }

  const areas = new Map<string, AreaCandidate>();
  const touchingAgents = new Map<string, Set<string>>();
  let unobserved = 0;
  const touch = (kind: LinkKind, agent: Agent, path: string, weight: number) => {
    if (!agent.projectId || !usablePath(path)) return;
    const areaPath = kind === "planned" ? areaOfOwned(path, areaSetOf(agent.projectId)) : areaOf(path, areaSetOf(agent.projectId));
    const target = nodeId.area(agent.projectId, areaPath);
    const agentNode = nodeId.agent(agent.id);
    addLink(kind, agentNode, target, weight);
    let candidate = areas.get(target);
    if (!candidate) {
      candidate = { id: target, projectId: agent.projectId, path: areaPath, touched: true, agents: new Set(), touchWeight: 0, neighbourWeight: 0 };
      areas.set(target, candidate);
    }
    candidate.touched = true;
    candidate.agents.add(agent.id);
    candidate.touchWeight += weight;
    if (!touchingAgents.has(agent.projectId)) touchingAgents.set(agent.projectId, new Set());
    touchingAgents.get(agent.projectId)!.add(agent.id);
  };
  for (const { agent, unit } of kept) {
    const memberTasks = unit?.tasks.filter(item => item.memberId === agent.id) ?? [];
    for (const item of memberTasks) {
      for (const path of item.paths) touch("planned", agent, path, 1);
      for (const path of item.changedPaths?.paths ?? []) touch("integrated", agent, path, 1);
    }
    const observed = touches[agent.sessionId ?? agent.id];
    if (!agent.observable || observed?.observable !== true) {
      unobserved++;
      const node = nodes.get(nodeId.agent(agent.id));
      if (node) node.unobserved = true;
      continue;
    }
    for (const file of observed?.files ?? []) {
      if (file.reads > 0) touch("read", agent, file.path, file.reads);
      if (file.edits > 0) touch("edit", agent, file.path, file.edits);
    }
  }

  const projectSet = new Set<string>();
  for (const swarm of model.live) if (swarm.kind !== "solo") for (const unit of swarm.units) if (unit.live) projectSet.add(unit.projectId);
  for (const area of areas.values()) projectSet.add(area.projectId);
  const rankedProjects = [...projectSet].sort((a, b) => (touchingAgents.get(b)?.size ?? 0) - (touchingAgents.get(a)?.size ?? 0) || a.localeCompare(b));
  const keptProjects = new Set(rankedProjects.slice(0, GRAPH_BUDGET.projects));
  dropped.projects = rankedProjects.length - keptProjects.size;
  const dropArea = (id: string) => {
    areas.delete(id);
    for (const link of [...links.values()]) if (link.source === id || link.target === id) links.delete(link.id);
  };
  for (const area of [...areas.values()]) if (!keptProjects.has(area.projectId)) dropArea(area.id);

  for (const area of [...areas.values()]) {
    const map = readyMap(area.projectId);
    if (!map || !area.touched) continue;
    const known = new Set(map.areas.map(item => item.id));
    const neighbours = map.links
      .filter(link => link.source === area.path || link.target === area.path)
      .map(link => ({ other: link.source === area.path ? link.target : link.source, weight: link.weight }))
      .filter(item => item.other !== area.path && known.has(item.other))
      .sort((a, b) => b.weight - a.weight || a.other.localeCompare(b.other))
      .slice(0, NEIGHBOURS_PER_AREA);
    for (const neighbour of neighbours) {
      const id = nodeId.area(area.projectId, neighbour.other);
      const existing = areas.get(id);
      if (existing) existing.neighbourWeight = Math.max(existing.neighbourWeight, neighbour.weight);
      else areas.set(id, { id, projectId: area.projectId, path: neighbour.other, touched: false, agents: new Set(), touchWeight: 0, neighbourWeight: neighbour.weight });
    }
  }

  const overAreas = areas.size - GRAPH_BUDGET.areas;
  if (overAreas > 0) {
    const victims = [...areas.values()].sort((a, b) =>
      (a.touched === b.touched ? 0 : a.touched ? 1 : -1)
      || (a.touched ? a.touchWeight - b.touchWeight || a.agents.size - b.agents.size : a.neighbourWeight - b.neighbourWeight)
      || a.id.localeCompare(b.id));
    for (const victim of victims.slice(0, overAreas)) dropArea(victim.id);
    dropped.areas = overAreas;
  }

  for (const projectId of keptProjects) {
    nodes.set(nodeId.project(projectId), { id: nodeId.project(projectId), kind: "project", side: "code", label: projectNames[projectId] ?? projectId, projectId });
  }
  for (const area of areas.values()) {
    const map = readyMap(area.projectId);
    const symbols = map?.areas.find(item => item.id === area.path)?.symbols;
    nodes.set(area.id, {
      id: area.id, kind: "area", side: "code", label: area.path, projectId: area.projectId, path: area.path,
      symbols, touched: area.touched, heat: area.agents.size,
    });
    addLink("contains", nodeId.project(area.projectId), area.id, 1);
  }

  const codeLinks = new Map<string, GraphLink>();
  for (const projectId of keptProjects) {
    const map = readyMap(projectId);
    if (!map) continue;
    for (const link of map.links) {
      const source = nodeId.area(projectId, link.source);
      const target = nodeId.area(projectId, link.target);
      if (source === target || !areas.has(source) || !areas.has(target)) continue;
      const [a, b] = source < target ? [source, target] : [target, source];
      const id = linkId("code", a, b);
      const existing = codeLinks.get(id);
      if (existing) existing.weight += link.weight;
      else codeLinks.set(id, { id, source: a, target: b, kind: "code", weight: link.weight });
    }
  }
  const sortedCode = [...codeLinks.values()].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  dropped.codeLinks = Math.max(0, sortedCode.length - GRAPH_BUDGET.codeLinks);
  for (const link of sortedCode.slice(0, GRAPH_BUDGET.codeLinks)) links.set(link.id, link);

  const projectIds = [...keptProjects];
  const withMap = projectIds.filter(id => readyMap(id)).length;
  const codeGraph: GraphData["codeGraph"] = projectIds.length === 0 ? "none" : withMap === 0 ? "off" : withMap === projectIds.length ? "on" : "partial";

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    links: [...links.values()].sort((a, b) => a.id.localeCompare(b.id)),
    dropped,
    codeGraph,
    unobserved,
  };
}
