import { RoleChip, StateMark, agentName } from "./marks";
import { elapsed, shortModel, usd } from "./format";
import { allAgents } from "./model";
import { agentTitle, stateWords } from "./Lanes";
import { AGENT_STATES, type ActivityStore, type Agent, type Selection, type Swarm, type ViewProps } from "./types";

type Section = { key: string; label: string; agents: Agent[] };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function sortByState(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => AGENT_STATES.indexOf(a.state) - AGENT_STATES.indexOf(b.state));
}

function WallTile({ agent, selected, onSelect, openSession, activity, now }: {
  agent: Agent; selected: boolean; onSelect(selection: Selection): void; openSession(sessionId: string): void; activity: ActivityStore; now: number;
}) {
  const buckets = activity.buckets(agent.id, now);
  const tier = agent.tier === "strong" ? "S" : agent.tier === "light" ? "L" : "";
  const flags = [agent.limited ? "lim" : "", agent.stalled ? "stall" : "", agent.earlier ? "earlier" : ""].filter(Boolean);
  const open = () => { if (agent.sessionId) openSession(agent.sessionId); };
  const classes = ["sw-tile", selected ? "sw-tile-selected" : "", agent.state === "needs-you" ? "sw-tile-needs" : ""].filter(Boolean).join(" ");
  return <button type="button" className={classes} data-agent={agent.id} aria-label={agentName(agent)} aria-pressed={selected}
    title={agentTitle(agent)}
    onClick={() => onSelect({ kind: "agent", id: agent.id })}
    onDoubleClick={open}
    onKeyDown={event => { if (event.key === "Enter" && agent.sessionId) { event.preventDefault(); open(); } }}>
    <span className="sw-tile-row">
      <RoleChip role={agent.role} />
      <StateMark state={agent.state} size={14} pulse={agent.state === "working"} title={stateWords(agent.state)} />
      {flags.map(flag => <span key={flag} className="sw-tag">{flag}</span>)}
    </span>
    <span className="sw-tile-row">
      <span className="sw-model">{shortModel(agent.model, agent.provider)}</span>
      <span className="sw-dim">{tier}</span>
    </span>
    <span className="sw-tile-band" aria-hidden="true">
      {buckets.map((value, index) => <span key={index} className="sw-bar" style={{ height: `${Math.max(1, Math.round(value * 18))}px` }} />)}
    </span>
    <span className="sw-tile-row">
      <span className="sw-tool">{agent.tool ?? ""}</span>
      <span className="sw-dim sw-age">{elapsed(agent.lastActivityAt, now)}</span>
    </span>
    <span className="sw-tile-row"><span className="sw-num sw-cost">{usd(agent.costUsd)}</span></span>
  </button>;
}

function WallSwarm({ swarm, ...props }: ViewProps & { swarm: Swarm }) {
  const { selection, onSelect, openSession, activity, now } = props;
  const direct = [...(swarm.coordinator ? [swarm.coordinator] : []), ...swarm.loose];
  const sections: Section[] = [];
  // A mission groups its tiles by unit, with its coordinator first; a team or the solo group is one cluster.
  if (direct.length > 0) sections.push({ key: "direct", label: swarm.kind === "mission" ? "coordinator" : "", agents: direct });
  for (const unit of swarm.units) {
    const agents = [...unit.agents, ...unit.side];
    if (agents.length > 0) sections.push({ key: unit.id, label: swarm.kind === "mission" ? unit.title : "", agents });
  }
  const agentCount = allAgents(swarm).length;
  return <section className="sw-wall-swarm" aria-label={swarm.title}>
    <header className="sw-swarm-head">
      <span className="sw-title">{swarm.title}</span>
      <span className="sw-spacer" />
      <span className="sw-count sw-dim">{plural(agentCount, "agent")}</span>
      <span className="sw-cost sw-num">{usd(swarm.costUsd)}</span>
    </header>
    <div className="sw-wall-sections">{sections.map(section => <div key={section.key} className="sw-wall-section">
      {swarm.kind === "mission" && <div className="sw-wall-unit sw-dim">{section.label}</div>}
      <div className="sw-wall-grid">
        {sortByState(section.agents).map(agent => <WallTile key={agent.id} agent={agent}
          selected={selection?.kind === "agent" && selection.id === agent.id}
          onSelect={onSelect} openSession={openSession} activity={activity} now={now} />)}
      </div>
    </div>)}</div>
  </section>;
}

/** One fixed-size tile per agent of a live unit, grouped by swarm and unit. */
export function Wall(props: ViewProps) {
  return <div className="sw-wall">
    <div className="sw-wall-note sw-dim">activity: observed since this page opened</div>
    {props.model.live.map(swarm => <WallSwarm key={swarm.id} swarm={swarm} {...props} />)}
    {props.model.live.length === 0 && <div className="sw-none-live sw-dim">no live agents</div>}
  </div>;
}
