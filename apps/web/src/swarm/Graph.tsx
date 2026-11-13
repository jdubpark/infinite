import { useMemo, type KeyboardEvent } from "react";
import { agentName, StateMark } from "./marks";
import { buildGraph, nodeId, type GraphData, type GraphLink, type GraphNode, type LinkKind } from "./graph-model";
import { GRID, layoutGraph, linkPath } from "./graph-layout";
import { useSwarmContext } from "./use-context";
import type { Agent, AgentState, Selection, SwarmModel, ViewProps } from "./types";
import "./graph.css";

export type GraphProps = ViewProps & {
  /** False when the host predates the context endpoints; the view then draws without a code map or observed touches. */
  contextAvailable: boolean;
};

const LABEL_MAX = 26;
const LINK_WORDS: Record<LinkKind, string> = {
  member: "member", dispatch: "dispatch", depends: "depends on", planned: "planned ownership", read: "observed read (tool input)",
  edit: "observed edit (tool input)", integrated: "integrated change", code: "code link", contains: "contains",
};
const LINK_BASE_WIDTH: Partial<Record<LinkKind, number>> = { integrated: 2.25, code: 1 };
/** Links are drawn back to front: structure, then code, then the touch strands. */
const LINK_ORDER: LinkKind[] = ["code", "depends", "dispatch", "member", "planned", "read", "edit", "integrated"];

/** Touch lines grow with their count, up to a fixed step. */
function linkWidth(link: GraphLink) {
  return (LINK_BASE_WIDTH[link.kind] ?? 1) * (1 + Math.min(link.weight - 1, 4) * 0.2);
}

/** An area's square grows with its symbol count and stays inside its row. */
function areaSide(node: GraphNode) {
  return Math.min(18, Math.max(7, 6 + 0.9 * Math.sqrt(node.symbols ?? 0)));
}

function shorten(text: string, max = LABEL_MAX, fromEnd = false) {
  if (text.length <= max) return text;
  return fromEnd ? `…${text.slice(-(max - 1))}` : `${text.slice(0, max - 1)}…`;
}

function agentIndex(model: SwarmModel) {
  const index = new Map<string, Agent>();
  for (const swarm of model.live) {
    const members = [swarm.coordinator, ...swarm.units.filter(unit => unit.live).flatMap(unit => [...unit.agents, ...unit.side]), ...swarm.loose];
    for (const agent of members) if (agent) index.set(agent.id, agent);
  }
  return index;
}

/** The part of the graph a selection keeps lit: an agent's links, an area's touching agents, or a unit's members. */
function focusOf(selection: Selection, data: GraphData): { nodes: Set<string>; links: Set<string> } | null {
  if (!selection) return null;
  const root = selection.kind === "agent" ? nodeId.agent(selection.id)
    : selection.kind === "unit" ? nodeId.unit(selection.id)
      : selection.kind === "area" ? selection.id : undefined;
  if (!root || !data.nodes.some(node => node.id === root)) return null;
  const nodes = new Set([root]);
  const links = new Set<string>();
  const touchKinds: LinkKind[] = ["planned", "integrated", "read", "edit"];
  for (const link of data.links) {
    if (link.source !== root && link.target !== root) continue;
    const keep = selection.kind === "area" ? touchKinds.includes(link.kind) || link.kind === "code"
      : selection.kind === "unit" ? link.kind === "member" || link.kind === "dispatch" || link.kind === "depends"
        : link.kind !== "contains";
    if (!keep) continue;
    links.add(link.id);
    nodes.add(link.source);
    nodes.add(link.target);
  }
  return { nodes, links };
}

/** Swarm topology linked to the code context in use, on a layered layout that moves only when a node appears or leaves. */
export function Graph({ model, selection, onSelect, openSession, contextAvailable }: GraphProps) {
  const context = useSwarmContext(model, contextAvailable);
  const data = useMemo(
    () => buildGraph({ model, maps: context.maps, touches: context.touches, projectNames: {} }),
    [model, context.maps, context.touches],
  );
  const layout = useMemo(() => layoutGraph(data, model), [data, model]);
  const agents = useMemo(() => agentIndex(model), [model]);
  const focus = useMemo(() => focusOf(selection, data), [selection, data]);
  const links = useMemo(() => [...data.links].sort((a, b) => LINK_ORDER.indexOf(a.kind) - LINK_ORDER.indexOf(b.kind)), [data.links]);

  const isSelected = (node: GraphNode) => (selection?.kind === "agent" && node.agentId === selection.id)
    || (selection?.kind === "unit" && node.unitId === selection.id)
    || (selection?.kind === "area" && selection.id === node.id);
  const select = (node: GraphNode) => {
    if (node.kind === "agent" && node.agentId) onSelect({ kind: "agent", id: node.agentId });
    else if (node.kind === "unit" && node.unitId) onSelect({ kind: "unit", id: node.unitId });
    else if (node.kind === "area") onSelect({ kind: "area", id: node.id });
  };

  const dropped = [
    data.dropped.agents ? `+${data.dropped.agents} agents` : "",
    data.dropped.projects ? `+${data.dropped.projects} projects` : "",
    data.dropped.areas ? `+${data.dropped.areas} areas` : "",
    data.dropped.codeLinks ? `+${data.dropped.codeLinks} code links` : "",
  ].filter(Boolean);
  const strand = (kind: LinkKind, width = 1) => <svg width="22" height="8" aria-hidden="true"><line className={`sw-g-link sw-g-${kind}`} x1={0} y1={4} x2={22} y2={4} strokeWidth={width} /></svg>;

  return (
    <div className="sw-graph">
      <div className="sw-graph-legend" aria-label="Graph legend">
        <span className="sw-legend-item">{strand("planned")}planned</span>
        <span className="sw-legend-item">{strand("read")}read</span>
        <span className="sw-legend-item">{strand("edit")}edit</span>
        <span className="sw-dim">observed tool inputs</span>
        <span className="sw-legend-item">{strand("integrated", 2.25)}integrated</span>
        <span className="sw-legend-item">{strand("code")}code link</span>
        {data.codeGraph === "off" && <span className="sw-graph-flag">code graph off</span>}
        {data.codeGraph === "partial" && <span className="sw-graph-flag">code graph partial</span>}
        {data.unobserved > 0 && <span className="sw-graph-flag">{data.unobserved} no signal</span>}
        {dropped.map(text => <span key={text} className="sw-dim">{text}</span>)}
      </div>
      {data.nodes.length === 0 ? <div className="sw-graph-empty sw-dim">no live agents</div>
        : <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Swarm graph">
          <rect x={0} y={0} width={layout.width} height={layout.height} fill="transparent" onClick={() => onSelect(null)} />
          <g aria-hidden="true">
            {layout.projects.map(project => <g key={project.id}>
              <text className="sw-g-heading" x={GRID.areaX} y={project.y + 4}>{shorten(project.label, 40)}</text>
              <line className="sw-g-rule" x1={GRID.areaX} y1={project.y + 12} x2={layout.width - GRID.pad - 20} y2={project.y + 12} />
            </g>)}
            {layout.labels.map(label => <text key={label.id} className="sw-g-heading" x={label.x} y={label.y + 4} textAnchor="middle">{label.text}</text>)}
          </g>
          <g>
            {links.map(link => {
              const d = linkPath(link, layout);
              if (!d) return null;
              const dim = focus !== null && !focus.links.has(link.id);
              return <path key={link.id} className={`sw-g-link sw-g-${link.kind}${dim ? " sw-graph-dim" : ""}`} d={d} strokeWidth={linkWidth(link)}>
                <title>{`${LINK_WORDS[link.kind]}${link.weight > 1 ? `, ${link.weight}` : ""}`}</title>
              </path>;
            })}
          </g>
          <g>
            {data.nodes.map(node => {
              const p = layout.at.get(node.id);
              if (!p || node.kind === "project") return null;
              const dim = focus !== null && !focus.nodes.has(node.id);
              const selected = isSelected(node);
              const agent = node.agentId ? agents.get(node.agentId) : undefined;
              const label = node.kind === "agent" && agent ? agentName(agent)
                : node.kind === "area" ? (node.touched ? `Code area ${node.path}, touched by ${node.heat ?? 0} agents` : `Neighbouring code area ${node.path}`)
                  : node.kind === "mission" ? `Mission ${node.label}` : `Unit ${node.label}`;
              const state: AgentState = agent?.state ?? "queued";
              const clickable = node.kind !== "mission";
              const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                select(node);
              };
              return <g key={node.id} className={`sw-g-node${dim ? " sw-graph-dim" : ""}`} transform={`translate(${p.x},${p.y})`} data-node={node.id}
                role="button" tabIndex={0} aria-label={label} aria-pressed={selected}
                onClick={event => { event.stopPropagation(); if (clickable) select(node); }}
                onKeyDown={onKeyDown}
                onDoubleClick={() => { if (agent?.sessionId) openSession(agent.sessionId); }}>
                <title>{label}</title>
                {node.kind === "agent" && agent && <>
                  {selected && <circle className="sw-g-halo" r={11} />}
                  {/* A wide hit area, so the small mark is easy to pick. */}
                  <rect x={-34} y={-GRID.rowAgent / 2} width={48} height={GRID.rowAgent} fill="transparent" />
                  {agent.role !== "MC" && <text className="sw-g-role" x={-13} y={3.5} textAnchor="end">{agent.role}</text>}
                  <g transform="translate(-7,-7)"><StateMark state={state} size={14} pulse={state === "working"} title={label} /></g>
                </>}
                {node.kind === "unit" && <>
                  {selected && <circle className="sw-g-halo" r={14} />}
                  <circle className="sw-g-hub" r={9} />
                  <text className="sw-graph-label sw-g-hub-label" y={-16} textAnchor="middle">{shorten(node.label, 18)}</text>
                </>}
                {node.kind === "mission" && <>
                  <circle className="sw-g-hub sw-g-hub-mission" r={13} />
                  <circle className="sw-g-hub-core" r={3.5} />
                  <text className="sw-graph-label sw-g-hub-label" x={-13} y={-21}>{shorten(node.label, 18)}</text>
                </>}
                {node.kind === "area" && (() => {
                  const side = areaSide(node);
                  const heat = node.heat ?? 0;
                  return <>
                    <rect x={-GRID.square / 2} y={-GRID.rowArea / 2} width={GRID.square + GRID.labelWidth} height={GRID.rowArea} fill="transparent" />
                    {selected && <rect className="sw-g-halo" x={-side / 2 - 4} y={-side / 2 - 4} width={side + 8} height={side + 8} rx={5} />}
                    <rect className={`sw-g-area${node.touched ? " sw-g-area-touched" : ""}`} x={-side / 2} y={-side / 2} width={side} height={side} rx={2.5}
                      style={{ fillOpacity: node.touched ? 0.14 + 0.5 * Math.min(heat, 4) / 4 : 0 }} />
                    <text className={`sw-graph-label${node.touched ? "" : " sw-g-quiet"}`} x={GRID.square / 2 + 2} y={3.5}>{shorten(node.path ?? node.label, LABEL_MAX, true)}</text>
                  </>;
                })()}
              </g>;
            })}
          </g>
        </svg>}
    </div>
  );
}
