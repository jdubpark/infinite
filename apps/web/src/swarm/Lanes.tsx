import { CircleHelp, Eye, GitMerge, Minus, OctagonAlert, Pause, X } from "lucide-react";
import { RoleChip, StateMark, agentName } from "./marks";
import { elapsed, usd } from "./format";
import { allAgents, findUnit } from "./model";
import { ROLE_NAME, STAGES, STAGE_LABEL, STATE_LABEL, type Agent, type Ghost, type Hold, type Selection, type Stage, type Swarm, type Terminal, type Unit, type ViewProps } from "./types";

export const HOLD_WORDS: Record<Hold, string> = { input: "needs input", paused: "paused", blocked: "blocked" };
export const TERMINAL_WORDS: Record<Terminal, string> = {
  "review-ready": "review ready", "merge-reported": "merge reported (agent report)", "no-change": "no change", cancelled: "cancelled",
};

/** The state in words. A reported agent is an agent's claim, so its words say so. */
export function stateWords(state: Agent["state"]): string {
  return state === "reported" ? "reported (agent report)" : STATE_LABEL[state];
}

/** Tooltip text for an agent: role, state in words, and the flags that apply. */
export function agentTitle(agent: Agent): string {
  return [ROLE_NAME[agent.role], stateWords(agent.state), agent.tool ? `tool ${agent.tool}` : "", agent.earlier ? "earlier revision" : "",
    agent.limited ? "provider limit" : "", agent.stalled ? "stalled" : ""].filter(Boolean).join(", ");
}

const HOLD_ICON = { input: CircleHelp, paused: Pause, blocked: OctagonAlert } as const;
const TERMINAL_ICON = { "review-ready": Eye, "merge-reported": GitMerge, "no-change": Minus, cancelled: X } as const;

export function holdGlyph(hold: Hold | undefined) {
  if (!hold) return null;
  const Icon = HOLD_ICON[hold];
  return <span className={`sw-glyph sw-glyph-${hold}`} role="img" aria-label={HOLD_WORDS[hold]} title={HOLD_WORDS[hold]}>
    <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
  </span>;
}

export function terminalGlyph(terminal: Terminal | undefined) {
  if (!terminal) return null;
  const Icon = TERMINAL_ICON[terminal];
  return <span className={`sw-glyph sw-glyph-${terminal}`} role="img" aria-label={TERMINAL_WORDS[terminal]} title={TERMINAL_WORDS[terminal]}>
    <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
  </span>;
}

/** One agent mark: a button with the agent's accessible name. Enter or double click opens its session. */
export function AgentMark({ agent, selected, onSelect, openSession }: {
  agent: Agent; selected: boolean; onSelect(selection: Selection): void; openSession(sessionId: string): void;
}) {
  const open = () => { if (agent.sessionId) openSession(agent.sessionId); };
  return <button type="button" className={`sw-agent${agent.earlier ? " sw-agent-earlier" : ""}`} data-agent={agent.id}
    aria-label={agentName(agent)} aria-pressed={selected}
    onClick={() => onSelect({ kind: "agent", id: agent.id })}
    onDoubleClick={open}
    onKeyDown={event => { if (event.key === "Enter" && agent.sessionId) { event.preventDefault(); open(); } }}>
    <StateMark state={agent.state} size={14} pulse={agent.state === "working"} title={agentTitle(agent)} />
  </button>;
}

/** Marks for one stage cell: six at most, five and a count beyond that. */
function StageMarks({ agents, selection, onSelect, openSession }: { agents: Agent[]; selection: Selection; onSelect(s: Selection): void; openSession(id: string): void }) {
  const shown = agents.length > 6 ? agents.slice(0, 5) : agents;
  const extra = agents.length - shown.length;
  return <>
    {shown.map(agent => <AgentMark key={agent.id} agent={agent} selected={selection?.kind === "agent" && selection.id === agent.id} onSelect={onSelect} openSession={openSession} />)}
    {extra > 0 && <span className="sw-more">+{extra}</span>}
  </>;
}

function Checks({ checks }: { checks: Unit["checks"] }) {
  return <span className="sw-checks" role="img" aria-label={`checks ${checks.passed} passed, ${checks.failed} failed, ${checks.running} running`}>
    {Array.from({ length: checks.passed }, (_, index) => <span key={`passed-${index}`} className="sw-check sw-check-passed" />)}
    {Array.from({ length: checks.failed }, (_, index) => <span key={`failed-${index}`} className="sw-check sw-check-failed" />)}
    {Array.from({ length: checks.running }, (_, index) => <span key={`running-${index}`} className="sw-check sw-check-running" />)}
  </span>;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** `own` marks the single unit of a team swarm: the header already names it, so the label leads with its project. */
function UnitLabel({ unit, own, model, selection, onSelect, openTeam }: Pick<ViewProps, "model" | "selection" | "onSelect" | "openTeam"> & { unit: Unit; own: boolean }) {
  const deps = unit.dependsOn.map(id => findUnit(model, id)?.title ?? id);
  return <div className="sw-lane-label">
    <button type="button" className="sw-unit-title" aria-pressed={selection?.kind === "unit" && selection.id === unit.id}
      title={unit.title} onClick={() => onSelect({ kind: "unit", id: unit.id })} onDoubleClick={() => openTeam(unit.id)}>
      {deps.length > 0 && <span className="sw-dep" title={`after ${deps.join(", ")}`}>↳ </span>}{own ? unit.projectId : unit.title}
    </button>
    <span className="sw-unit-sub sw-dim">{own ? "" : `${unit.projectId} `}r{unit.revision}{unit.goalCycle !== undefined ? ` c${unit.goalCycle}` : ""}</span>
  </div>;
}

function LaneRow({ unit, own, ...props }: ViewProps & { unit: Unit; own: boolean }) {
  const { selection, onSelect, openSession, openTeam, model } = props;
  const reached = STAGES.indexOf(unit.reached);
  const active = unit.active ? STAGES.indexOf(unit.active) : -1;
  const checkStage = STAGES.indexOf("check");
  const running = unit.workers?.running;
  const limit = unit.workers?.limit;
  return <div className="sw-lane-row" data-unit={unit.id}>
    <UnitLabel unit={unit} own={own} model={model} selection={selection} onSelect={onSelect} openTeam={openTeam} />
    {STAGES.map((stage: Stage, index) => <div key={stage} className={`sw-stage${index <= reached ? " sw-reached" : ""}${index === active ? " sw-active" : ""}`}>
      {index === checkStage && <Checks checks={unit.checks} />}
      {index === reached && holdGlyph(unit.hold)}
      <StageMarks agents={unit.agents.filter(agent => agent.stage === stage)} selection={selection} onSelect={onSelect} openSession={openSession} />
    </div>)}
    <div className="sw-lane-end">
      {unit.side.map(agent => <span key={agent.id} className="sw-side">
        <RoleChip role={agent.role} />
        <AgentMark agent={agent} selected={selection?.kind === "agent" && selection.id === agent.id} onSelect={onSelect} openSession={openSession} />
      </span>)}
      <span className="sw-glyph-slot">{terminalGlyph(unit.terminal)}</span>
      <span className="sw-slots sw-num">{unit.workers ? `${running}/${limit}` : ""}</span>
      <span className="sw-cost sw-num">{usd(unit.costUsd)}</span>
    </div>
  </div>;
}

function GhostRow({ ghost }: { ghost: Ghost }) {
  return <div className="sw-lane-row sw-quiet-row">
    <div className="sw-lane-label"><span className="sw-ghost-title"><StateMark state="queued" size={14} title="queued" />{ghost.title}</span></div>
    <div className="sw-quiet-cell"><span className="sw-dim">after {ghost.after.join(", ")}</span></div>
  </div>;
}

function QuietRow({ unit, selection, onSelect, openTeam, now }: Pick<ViewProps, "selection" | "onSelect" | "openTeam" | "now"> & { unit: Unit }) {
  return <div className="sw-lane-row sw-quiet-row">
    <div className="sw-lane-label">
      <button type="button" className="sw-unit-title" aria-pressed={selection?.kind === "unit" && selection.id === unit.id}
        title={unit.title} onClick={() => onSelect({ kind: "unit", id: unit.id })} onDoubleClick={() => openTeam(unit.id)}>{unit.title}</button>
    </div>
    <div className="sw-quiet-cell">
      {holdGlyph(unit.hold) ?? terminalGlyph(unit.terminal)}
      <span className="sw-dim">{elapsed(unit.updatedAt, now)}</span>
    </div>
  </div>;
}

function LaneSwarm({ swarm, ...props }: ViewProps & { swarm: Swarm }) {
  const { selection, onSelect, openSession } = props;
  const agents = allAgents(swarm);
  return <section className="sw-lane-swarm" aria-label={swarm.title}>
    <header className="sw-swarm-head">
      {swarm.kind !== "solo" && <span className="sw-swarm-kind sw-dim">{swarm.kind}</span>}
      <span className="sw-title">{swarm.title}</span>
      {swarm.coordinator && <AgentMark agent={swarm.coordinator} selected={selection?.kind === "agent" && selection.id === swarm.coordinator.id} onSelect={onSelect} openSession={openSession} />}
      <span className="sw-spacer" />
      {swarm.kind === "mission" && <span className="sw-count sw-dim">{plural(swarm.units.length, "unit")}</span>}
      <span className="sw-count sw-dim">{plural(agents.length, "agent")}</span>
      {/* A team's single row already carries its cost. */}
      <span className="sw-cost sw-num">{swarm.kind === "team" ? "" : usd(swarm.costUsd)}</span>
    </header>
    {swarm.loose.length > 0 && <div className="sw-lane-row sw-solo-row">
      <div className="sw-lane-label" />
      <div className="sw-marks sw-marks-row">
        {swarm.loose.map(agent => <AgentMark key={agent.id} agent={agent} selected={selection?.kind === "agent" && selection.id === agent.id} onSelect={onSelect} openSession={openSession} />)}
      </div>
    </div>}
    {swarm.units.map(unit => <LaneRow key={unit.id} unit={unit} own={swarm.kind === "team"} {...props} />)}
    {swarm.ghosts.map(ghost => <GhostRow key={ghost.id} ghost={ghost} />)}
  </section>;
}

/** One row per unit on fixed stage columns. */
export function Lanes(props: ViewProps) {
  const { model } = props;
  const quietUnits = model.quiet.flatMap(swarm => swarm.units);
  return <div className="sw-lanes">
    <div className="sw-lane-row sw-lane-head" aria-hidden="true">
      <span />
      {STAGES.map(stage => <span key={stage} className="sw-stage-label sw-dim">{STAGE_LABEL[stage]}</span>)}
      <span />
    </div>
    {model.live.map(swarm => <LaneSwarm key={swarm.id} swarm={swarm} {...props} />)}
    {model.quiet.length > 0 && <section className="sw-quiet" aria-label="quiet">
      <div className="sw-group-label sw-dim">quiet</div>
      {quietUnits.map(unit => <QuietRow key={unit.id} unit={unit} selection={props.selection} onSelect={props.onSelect} openTeam={props.openTeam} now={props.now} />)}
      {model.quietOlder > 0 && <div className="sw-older sw-dim">+{model.quietOlder} older</div>}
    </section>}
  </div>;
}
