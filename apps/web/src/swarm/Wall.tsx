import { RoleChip, StateMark, agentName } from "./marks";
import { cost, elapsed, shortModel, usd } from "./format";
import { allAgents } from "./model";
import { agentTitle, stateWords } from "./Lanes";
import { AGENT_STATES, type ActivityStore, type Agent, type Selection, type Swarm, type ViewProps } from "./types";

type Section = { key: string; label: string; agents: Agent[]; waitSummary?: string; waitCount?: number };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function sortByState(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => AGENT_STATES.indexOf(a.state) - AGENT_STATES.indexOf(b.state));
}

function WallTile({ agent, selected, onSelect, openSession, activity, now }: {
  agent: Agent; selected: boolean; onSelect(selection: Selection): void; openSession(sessionId: string): void; activity: ActivityStore; now: number;
}) {
  const buckets = activity.buckets(agent.id, now);
  const tier = agent.tier === "strong" ? "S" : agent.tier === "light" ? "L" : "";
  const flags = [agent.limited ? "lim" : "", agent.stalled ? "stall" : "", agent.spinnerOnly ? "spin" : "", agent.earlier ? "earlier" : ""].filter(Boolean);
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
  const sections: Section[] = [];
  switch (swarm.kind) {
    case "mission":
      if (swarm.coordinator) sections.push({ key: "direct", label: "coordinator", agents: [swarm.coordinator] });
      for (const unit of swarm.units) {
        const agents = [...unit.agents, ...unit.side];
        if (agents.length > 0) sections.push({
          key: unit.id,
          label: unit.title,
          agents,
          waitCount: unit.waitReasons.length,
          waitSummary: unit.waitReasons.map(reason => reason.summary).join(" · "),
        });
      }
      break;
    case "team":
      for (const unit of swarm.units) {
        const agents = [...unit.agents, ...unit.side];
        if (agents.length > 0) sections.push({
          key: unit.id,
          label: "",
          agents,
          waitCount: unit.waitReasons.length,
          waitSummary: unit.waitReasons.map(reason => reason.summary).join(" · "),
        });
      }
      break;
    case "solo":
      if (swarm.loose.length > 0) sections.push({ key: "direct", label: "", agents: swarm.loose });
      break;
  }
  const agentCount = allAgents(swarm).length;
  const spend = cost(swarm.costUsd, swarm.unmeasured);
  const teamWaitReasons = swarm.kind === "team" ? swarm.units[0]?.waitReasons ?? [] : [];
  return <section className="sw-wall-swarm" aria-label={swarm.title}>
    <header className="sw-swarm-head">
      <span className="sw-title">{swarm.title}</span>
      {teamWaitReasons.length > 0 && <span className="sw-tag" title={teamWaitReasons.map(reason => reason.summary).join(" · ")}>{teamWaitReasons.length === 1 ? "1 wait" : `${teamWaitReasons.length} waits`}</span>}
      <span className="sw-spacer" />
      <span className="sw-count sw-dim">{plural(agentCount, "agent")}</span>
      <span className="sw-cost sw-num" title={spend.title}>{spend.text}</span>
    </header>
    <div className="sw-wall-sections">{sections.map(section => <div key={section.key} className="sw-wall-section">
      {swarm.kind === "mission" && <div className="sw-wall-unit sw-dim">{section.label}{(section.waitCount ?? 0) > 0 && <span className="sw-tag" title={section.waitSummary}>{section.waitCount === 1 ? "1 wait" : `${section.waitCount} waits`}</span>}</div>}
      <div className="sw-wall-grid">
        {sortByState(section.agents).map(agent => <WallTile key={agent.id} agent={agent}
          selected={selection?.kind === "agent" && selection.id === agent.id}
          onSelect={onSelect} openSession={openSession} activity={activity} now={now} />)}
      </div>
    </div>)}</div>
  </section>;
}

export function Wall(props: ViewProps) {
  return <div className="sw-wall">
    <div className="sw-wall-note sw-dim">activity: observed since this page opened</div>
    {props.model.live.map(swarm => <WallSwarm key={swarm.id} swarm={swarm} {...props} />)}
    {props.model.live.length === 0 && <div className="sw-none-live sw-dim">no live agents</div>}
  </div>;
}
