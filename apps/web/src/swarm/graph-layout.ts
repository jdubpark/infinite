import type { GraphData, GraphLink, LinkKind } from "./graph-model";
import type { SwarmModel } from "./types";

export type Point = { x: number; y: number };
export type GraphLayout = {
  width: number;
  height: number;
  at: Map<string, Point>;
  column: Map<string, "touched" | "neighbour">;
  labels: { id: string; text: string; x: number; y: number }[];
  projects: { id: string; label: string; y: number }[];
};

export const GRID = {
  pad: 24,
  missionX: 40,
  unitX: 176,
  agentX: 312,
  areaX: 560,
  square: 26,
  labelWidth: 176,
  gutter: 92,
  rowAgent: 22,
  rowArea: 24,
  unitGap: 16,
  swarmGap: 30,
  projectHead: 26,
  projectGap: 28,
};
const touchedRight = GRID.areaX + GRID.square + GRID.labelWidth;
const neighbourX = touchedRight + GRID.gutter;
const neighbourRight = neighbourX + GRID.square + GRID.labelWidth;

export function layoutGraph(data: GraphData, model: SwarmModel): GraphLayout {
  const present = new Set(data.nodes.map(node => node.id));
  const at = new Map<string, Point>();
  const labels: GraphLayout["labels"] = [];

  let y = GRID.pad;
  for (const swarm of model.live) {
    const hubs: number[] = [];
    if (swarm.kind === "solo") {
      const agents = swarm.loose.filter(agent => present.has(`agent:${agent.id}`));
      if (agents.length === 0) continue;
      const rows = Math.max(agents.length, 2), top = y;
      agents.forEach((agent, index) => at.set(`agent:${agent.id}`, { x: GRID.agentX, y: top + (index + 0.5) * GRID.rowAgent }));
      labels.push({ id: "solo", text: "solo", x: GRID.unitX, y: top + rows * GRID.rowAgent / 2 });
      y = top + rows * GRID.rowAgent + GRID.swarmGap;
      continue;
    }
    const start = y;
    for (const unit of swarm.units) {
      const hub = `unit:${unit.id}`;
      if (!present.has(hub)) continue;
      const agents = [...unit.agents, ...unit.side].filter(agent => present.has(`agent:${agent.id}`));
      const rows = Math.max(agents.length, 2), top = y, centre = top + rows * GRID.rowAgent / 2;
      agents.forEach((agent, index) => at.set(`agent:${agent.id}`, { x: GRID.agentX, y: top + (index + 0.5) * GRID.rowAgent }));
      at.set(hub, { x: GRID.unitX, y: centre });
      hubs.push(centre);
      y = top + rows * GRID.rowAgent + GRID.unitGap;
    }
    const mission = `mission:${swarm.id}`;
    if (swarm.kind === "mission" && present.has(mission)) {
      if (hubs.length === 0) { hubs.push(y + GRID.rowAgent); y += 2 * GRID.rowAgent + GRID.unitGap; }
      const centre = (hubs[0] + hubs[hubs.length - 1]) / 2;
      at.set(mission, { x: GRID.missionX, y: centre });
      if (swarm.coordinator && present.has(`agent:${swarm.coordinator.id}`)) at.set(`agent:${swarm.coordinator.id}`, { x: GRID.missionX + 30, y: centre });
    }
    if (y > start) y = y - GRID.unitGap + GRID.swarmGap;
  }
  const swarmBottom = y;

  const column: GraphLayout["column"] = new Map();
  const projects: GraphLayout["projects"] = [];
  let codeY = GRID.pad;
  const projectNodes = data.nodes.filter(node => node.kind === "project").sort((a, b) => a.id.localeCompare(b.id));
  for (const project of projectNodes) {
    const areas = data.nodes.filter(node => node.kind === "area" && node.projectId === project.projectId).sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));
    const touched = areas.filter(area => area.touched), neighbours = areas.filter(area => !area.touched);
    const rowsTop = codeY + GRID.projectHead;
    projects.push({ id: project.id, label: project.label, y: codeY + 10 });
    at.set(project.id, { x: GRID.areaX, y: codeY + 10 });
    touched.forEach((area, index) => { at.set(area.id, { x: GRID.areaX + GRID.square / 2, y: rowsTop + (index + 0.5) * GRID.rowArea }); column.set(area.id, "touched"); });
    neighbours.forEach((area, index) => { at.set(area.id, { x: neighbourX + GRID.square / 2, y: rowsTop + (index + 0.5) * GRID.rowArea }); column.set(area.id, "neighbour"); });
    codeY = rowsTop + Math.max(touched.length, neighbours.length, 1) * GRID.rowArea + GRID.projectGap;
  }

  return { width: neighbourRight + GRID.pad + 20, height: Math.max(swarmBottom, codeY, 160) + GRID.pad, at, column, labels, projects };
}

const STRAND: Partial<Record<LinkKind, number>> = { planned: -3, read: -1, edit: 1, integrated: 3 };

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
};
const arc = (x: number, y1: number, y2: number, bulge: number) => `M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}`;

export function linkPath(link: GraphLink, layout: GraphLayout): string | undefined {
  const from = layout.at.get(link.source), to = layout.at.get(link.target);
  if (!from || !to) return undefined;
  switch (link.kind) {
    case "member":
      if (link.target.startsWith("mission:")) return undefined;
      return curve(to.x + 10, to.y, from.x - 36, from.y);
    case "dispatch":
      return curve(from.x + 14, from.y, to.x - 10, to.y);
    case "depends":
      return arc(from.x - 10, from.y, to.y, -26);
    case "planned": case "read": case "edit": case "integrated": {
      const shift = STRAND[link.kind] ?? 0;
      return curve(from.x + 10, from.y + shift, to.x - GRID.square / 2 + 2, to.y + shift);
    }
    case "code": {
      const a = layout.column.get(link.source), b = layout.column.get(link.target);
      if (!a || !b) return undefined;
      const span = Math.abs(from.y - to.y);
      const bulge = Math.min(GRID.gutter * 0.62, 14 + span * 0.12);
      if (a === "touched" && b === "touched") return arc(touchedRight + 4, from.y, to.y, bulge);
      if (a === "neighbour" && b === "neighbour") return arc(neighbourRight + 4, from.y, to.y, Math.min(18, bulge));
      const [left, right] = a === "touched" ? [from, to] : [to, from];
      return curve(touchedRight + 4, left.y, right.x - GRID.square / 2 + 2, right.y);
    }
    default:
      return undefined;
  }
}
