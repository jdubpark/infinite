import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useApi, type Me } from "../api";
import { useLiveRefresh } from "../live-refresh";
import { Graph } from "./Graph";
import { Lanes, agentTitle, holdGlyph, stateWords, terminalGlyph } from "./Lanes";
import { Wall } from "./Wall";
import { RoleChip, StateMark } from "./marks";
import { clockTime, cost, elapsed, shortModel, usd } from "./format";
import { allAgents, buildSwarm, findAgent, findUnit } from "./model";
import { createActivity } from "./activity";
import { AGENT_STATES, STATE_LABEL, type AgentState, type Selection, type SwarmMission, type SwarmSession, type SwarmTeam, type ViewProps } from "./types";
import "./swarm.css";
import "./views.css";

export type SwarmViewName = "lanes" | "wall" | "graph";
export type SwarmViewProps = {
  me: Me;
  sessions: SwarmSession[];
  teams: SwarmTeam[];
  /** Freshness of the app's session and team feeds. */
  fresh: boolean;
  stale: boolean;
  seen: string;
  view: SwarmViewName;
  setView(view: SwarmViewName): void;
  openSession(sessionId: string): void;
  openTeam(teamId: string): void;
  /** Starts a session; shown to owners when the host has no sessions at all. */
  onCreate?: () => void;
  focus: boolean;
  setFocus(focus: boolean): void;
};

/** The subset of GET /machine/resources the meters read. */
type Resources = { cpu?: { usagePercent: number | null }; memory?: { totalBytes: number; availableBytes: number | null } };

const VIEWS: SwarmViewName[] = ["lanes", "wall", "graph"];
const VITALS: AgentState[] = ["needs-you", "in-review", "working", "waiting", "queued"];
const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);

/** The Swarm route: floating glass controls over the Lanes, Wall, or Graph canvas. */
export function SwarmView(props: SwarmViewProps) {
  const { me, sessions, teams, stale, seen, view, setView, openSession, openTeam, onCreate, focus, setFocus } = props;
  const api = useApi();
  const root = useRef<HTMLDivElement>(null);
  const [missions, setMissions] = useState<SwarmMission[]>([]);
  const [resources, setResources] = useState<Resources>();
  const [selection, setSelection] = useState<Selection>(null);
  const [activity] = useState(createActivity);

  useLiveRefresh(async current => {
    const data = await api<{ missions: SwarmMission[] }>("/missions");
    if (current()) setMissions(data.missions);
  }, 1800, me.missions?.enabled ? me : null);
  useLiveRefresh(async current => {
    const data = await api<Resources>("/machine/resources");
    if (current()) setResources(data);
  }, 5000, me);

  // `now` moves with each feed update; there is no separate timer.
  const { model, now } = useMemo(() => {
    const now = Date.now();
    const model = buildSwarm({ sessions, teams, missions, now });
    activity.record(model.live.flatMap(swarm => allAgents(swarm)), now);
    return { model, now };
  }, [sessions, teams, missions, activity]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.key.toLowerCase() === "f") { setFocus(!focus); return; }
      if (event.key === "Escape") { setSelection(null); return; }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && target && root.current?.contains(target) && target.hasAttribute("data-agent")) {
        const marks = Array.from(root.current.querySelectorAll<HTMLElement>("[data-agent]"));
        const next = marks[marks.indexOf(target) + (event.key === "ArrowRight" ? 1 : -1)];
        if (next) { event.preventDefault(); next.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, setFocus]);

  const totals = model.totals;
  const spend = cost(totals.costUsd, totals.unmeasured);
  const empty = model.live.length === 0 && model.quiet.length === 0;
  const selectedAgent = selection?.kind === "agent" ? findAgent(model, selection.id) : undefined;
  const selectedUnit = selection?.kind === "unit" ? findUnit(model, selection.id) : undefined;
  const unitSpend = cost(selectedUnit?.costUsd, selectedUnit?.unmeasured ?? 0);
  const memory = resources?.memory;
  const memoryPercent = memory && memory.availableBytes !== null && memory.totalBytes > 0 ? 100 * (1 - memory.availableBytes / memory.totalBytes) : null;
  const cpuPercent = resources?.cpu?.usagePercent ?? null;
  const limits = (me.providerLimits ?? []).filter(limit => Date.parse(limit.expiresAt) > now);

  const viewProps: ViewProps = { model, selection, onSelect: setSelection, openSession, openTeam, activity, now };

  return <div ref={root} className={`swarm${stale ? " sw-stale" : ""}`}>
    <div className="sw-canvas">
      {empty ? <div className="sw-empty">
        <span className="sw-dim">no agents</span>
        {onCreate && <button type="button" className="sw-link" onClick={onCreate}>start a session</button>}
      </div>
        : view === "lanes" ? <Lanes {...viewProps} />
        : view === "wall" ? <Wall {...viewProps} />
        : <Graph {...viewProps} contextAvailable={me.capabilities?.swarmContext === 1} />}
    </div>

    <div className="sw-top">
      <div className="sw-glass sw-capsule sw-vitals" aria-label="vitals">
        {VITALS.map(state => {
          // The first slot counts everything that waits on a person: prompts a person owns plus open owner decisions.
          const count = state === "needs-you" ? totals.waitingOnPerson : totals.byState[state];
          const label = state === "needs-you" ? "waiting on a person" : STATE_LABEL[state];
          return <span key={state} className={`sw-vital${count ? "" : " sw-dim"}`} title={label}>
            <StateMark state={state} size={14} title={label} />
            <span className="sw-count sw-num">{count}</span>
          </span>;
        })}
        <span className="sw-vital-divider" aria-hidden="true" />
        <span className={`sw-vital${totals.slots.running ? "" : " sw-dim"}`}>
          <small>slots</small>
          <span className="sw-count sw-num">{totals.slots.running}</span>
          <small>/{totals.slots.limit}</small>
        </span>
        <span className={`sw-vital${totals.costUsd ? "" : " sw-dim"}`}><span className="sw-cost sw-num" title={spend.title}>{spend.text}</span></span>
        <Meter label="cpu" value={cpuPercent} />
        <Meter label="mem" value={memoryPercent} />
        {limits.map(limit => <span key={limit.provider} className="sw-flag">lim {limit.provider}</span>)}
        <span className="sw-spacer" />
        <span className="sw-status-slot">{stale ? `STALE ${seen ? clockTime(seen) : ""}` : seen ? clockTime(seen) : ""}</span>
      </div>
      <span className="sw-spacer" />
      <div className="sw-glass sw-capsule sw-switch" role="group" aria-label="view">
        {VIEWS.map(name => <button key={name} type="button" aria-pressed={view === name} onClick={() => setView(name)}>{name}</button>)}
      </div>
      <button type="button" className="sw-glass sw-capsule sw-icon-button" aria-label={focus ? "leave focus" : "focus"} aria-pressed={focus}
        onClick={() => setFocus(!focus)}>
        {focus ? <Minimize2 size={14} strokeWidth={1.75} aria-hidden="true" /> : <Maximize2 size={14} strokeWidth={1.75} aria-hidden="true" />}
      </button>
    </div>

    <div className="sw-bottom">
      <div className="sw-glass sw-legend" aria-label="legend">
        {AGENT_STATES.map(state => <span key={state} className="sw-legend-item">
          <StateMark state={state} size={14} />{STATE_LABEL[state]}
        </span>)}
      </div>
      <div className="sw-glass sw-inspector" aria-live="polite">
        {selectedAgent ? <>
          <span className="sw-inspector-fact"><RoleChip role={selectedAgent.role} /></span>
          <span className="sw-inspector-fact"><small>{shortModel(selectedAgent.model, selectedAgent.provider)}</small></span>
          <span className="sw-inspector-fact" title={agentTitle(selectedAgent)}>
            <StateMark state={selectedAgent.state} size={14} title={stateWords(selectedAgent.state)} />
            {stateWords(selectedAgent.state)}{selectedAgent.since ? ` ${elapsed(selectedAgent.since, now)}` : ""}
          </span>
          {selectedAgent.tool && <span className="sw-inspector-fact">{selectedAgent.tool}</span>}
          {selectedAgent.costUsd !== undefined && <span className="sw-inspector-fact sw-num">{usd(selectedAgent.costUsd)}</span>}
          {selectedAgent.taskId && <span className="sw-inspector-fact"><small>task</small>{selectedAgent.taskId}</span>}
          <span className="sw-inspector-links">
            {selectedAgent.sessionId && <button type="button" className="sw-link" onClick={() => openSession(selectedAgent.sessionId!)}>session</button>}
            {selectedAgent.unitId && <button type="button" className="sw-link" onClick={() => openTeam(selectedAgent.unitId!)}>team</button>}
          </span>
        </> : selectedUnit ? <>
          <span className="sw-inspector-fact sw-title">{selectedUnit.title}</span>
          <span className="sw-inspector-fact sw-dim">{selectedUnit.status}</span>
          <span className="sw-inspector-fact">r{selectedUnit.revision}</span>
          {selectedUnit.workers && <span className="sw-inspector-fact"><small>slots</small>{selectedUnit.workers.running}/{selectedUnit.workers.limit}</span>}
          <span className="sw-inspector-fact" title="passed / failed / running"><small>checks</small>{selectedUnit.checks.passed}/{selectedUnit.checks.failed}/{selectedUnit.checks.running}</span>
          {(selectedUnit.costUsd !== undefined || selectedUnit.unmeasured > 0) && <span className="sw-inspector-fact sw-num" title={unitSpend.title}>{unitSpend.text}</span>}
          {holdGlyph(selectedUnit.hold)}
          {terminalGlyph(selectedUnit.terminal)}
          <span className="sw-inspector-links"><button type="button" className="sw-link" onClick={() => openTeam(selectedUnit.id)}>team</button></span>
        </> : selection?.kind === "area" ? (() => {
          // An area's ID is `area:<project>:<directory>`.
          const [, project, ...path] = selection.id.split(":");
          return <>
            <span className="sw-inspector-fact"><small>area</small>{path.join(":")}</span>
            <span className="sw-inspector-fact sw-dim">{project}</span>
          </>;
        })() : <span className="sw-inspector-empty">–</span>}
      </div>
    </div>
  </div>;
}

function Meter({ label, value }: { label: string; value: number | null }) {
  const text = value === null ? "unavailable" : `${Math.round(value)}%`;
  return <span className={`sw-vital sw-meter-vital${value === null ? " sw-dim" : ""}`} title={`${label} ${text}`}>
    <small>{label}</small>
    <span className="sw-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-valuetext={text}>
      <span style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
    </span>
  </span>;
}
