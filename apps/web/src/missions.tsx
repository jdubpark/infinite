import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { ApiError, useApi, type Me } from "./api";
import { useLiveRefresh } from "./live-refresh";
import { useMachines } from "./machines";
import { requestStore } from "./requests";
import { haltNotice, missionHaltPlace, type HaltView } from "./halt";
import { HaltBanner } from "./halt-banner";
import { missionControls, missionExtendChoices, missionExtensionConfirmation, missionShowsReason, missionStateLabel, missionStopLine, missionStoppedAtLimit, type MissionStatus } from "./mission-model";

type MissionView = {
  id: string;
  title: string;
  status: MissionStatus;
  stopReason?: "deadline";
  reason?: string;
  revision: number;
  updatedAt: string;
  createdAt: string;
  deadlineAt: string;
  clockStoppedAt?: string;
  maxMinutes: number;
  /** Pinned at creation; the host covers a mission with a project halt on any of these. */
  repoProjectIds: string[];
  subtasks: { id: string; title: string; status: string; repoProjectId: string; teamId?: string }[];
  events: { at: string; text: string }[];
};
type MissionAction = "extend" | "pause" | "resume" | "cancel";
type MissionRequest = { requestId: string; revision: number; action: MissionAction; minutes?: number };

const mutations = requestStore<MissionRequest, { id: string }>();
const inFlight = new Set<string>();
export function clearMissionRequests(machine: string) { mutations.clearMachine(machine); }
const rejected = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500;
const date = (value: string) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const missionStatusClass = (status: MissionStatus) => status === "working" ? "" : ["needs-input", "blocked", "paused"].includes(status) ? "waiting" : ["cancelled", "ready-for-review"].includes(status) ? "inactive" : "";
export function MissionPage({ id, me, connected, openTeam, halt }: { id: string; me: Me; connected: boolean; openTeam: (id: string) => void; halt: HaltView | null }) {
  const api = useApi(), machine = useMachines().active.id, key = machine + "/" + id;
  const [mission, setMission] = useState<MissionView | null>(null);
  const [loadError, setLoadError] = useState("");
  const request = mutations.use(key), pending = request.pending;
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function receive(next: MissionView) {
    setMission(previous => !previous || next.revision > previous.revision || (next.revision === previous.revision && next.updatedAt >= previous.updatedAt) ? next : previous);
  }
  const view = useLiveRefresh(async current => {
    try {
      const value = await api<MissionView>("/missions/" + id);
      if (current()) { receive(value); setLoadError(""); }
    } catch (failure) {
      if (current()) setLoadError((failure as Error).message);
      throw failure;
    }
  }, 1800, me.missions?.enabled === false ? null : key);
  const fresh = connected && view.fresh;
  const controls = mission ? missionControls(mission, me.role, fresh, Date.now()) : { extend: false, pause: false, resume: false, cancel: false };

  async function mutate(action: MissionAction, minutes?: number) {
    if (!mission || !fresh || me.role !== "owner" || busy) return;
    let body = pending;
    if (!body) {
      if (!missionControls(mission, me.role, fresh, Date.now())[action]) return undefined;
      if (action === "extend" && (minutes === undefined || !Number.isInteger(minutes) || minutes < 5 || minutes > 1440)) return;
      body = mutations.begin(key, { requestId: crypto.randomUUID(), revision: mission.revision, action, ...(action === "extend" && minutes !== undefined ? { minutes } : {}) });
    }
    if (!body || inFlight.has(body.requestId)) return;
    inFlight.add(body.requestId);
    setBusy(true);
    try {
      const { action: endpoint, ...payload } = body;
      const result = await api<MissionView>("/missions/" + id + "/" + endpoint, payload);
      const message = endpoint === "extend"
        ? missionExtensionConfirmation(result, Date.now(), date)
        : endpoint[0].toUpperCase() + endpoint.slice(1) + " recorded. Revision " + result.revision + ".";
      mutations.complete(key, body.requestId, { id: result.id }, message);
      if (mounted.current) { receive(result); view.refresh(); }
    } catch (failure) {
      const wasRejected = rejected(failure);
      mutations.fail(key, body.requestId, (failure as Error).message + (wasRejected ? " Refresh the mission before sending another request." : " Delivery is unconfirmed. Retry will use the same request."), wasRejected);
      if (mounted.current && wasRejected) view.refresh();
    } finally {
      inFlight.delete(body.requestId);
      if (mounted.current) setBusy(false);
    }
  }

  // The owner's halt for this mission: the host halt, and halts on the projects it is pinned to. Until the mission
  // loads there is no mission to scope to, so only the host halt shows.
  const banner = <HaltBanner className="halt-main" notice={haltNotice(halt, missionHaltPlace(mission?.repoProjectIds ?? []))} name={projectId => me.projects.find(project => project.id === projectId)?.name ?? projectId} owner={me.role === "owner"} />;
  if (me.missions?.enabled === false) return <div className="team-page"><h1>Mission</h1>{banner}<p className="team-notice" role="status">Missions are not enabled on this host.</p></div>;
  if (!mission) return <div className="team-page"><h1>Mission</h1>{banner}<p role="status">{loadError || "Loading mission…"}</p>{loadError && <button type="button" className="text-button" onClick={view.refresh}><RefreshCw size={15} />Try again</button>}</div>;

  const stoppedAtLimit = missionStoppedAtLimit(mission);
  const stopLine = missionStopLine(mission, Date.now(), date);
  const events = mission.events.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);

  return <div className="team-detail mission-detail">
    <header className="team-detail-heading">
      <div>
        <p className="team-eyebrow">Mission</p>
        <h1>{mission.title}</h1>
        <div className="team-detail-meta">
          <span className={"team-status " + missionStatusClass(mission.status)}><span className="dot" />{missionStateLabel(mission)}</span>
          <span>Revision {mission.revision}</span>
          <span className="team-freshness" role="status">{view.stale ? "Showing last received state; controls are disabled." : ""}</span>
        </div>
        {stopLine && <p className="quiet mission-stop-time" role="status">{stopLine}</p>}
      </div>
      <button type="button" className="text-button" disabled={view.refreshing} onClick={view.refresh} aria-busy={view.refreshing}><RefreshCw className={view.refreshing ? "is-refreshing" : ""} size={14} />Refresh mission</button>
    </header>
    {banner}
    <div className="team-detail-body">
      {missionShowsReason(mission) && <p className="team-notice" role="status">{mission.reason}</p>}
      <section className="team-section">
        <h2>Subtasks</h2>
        {mission.subtasks.length ? <ul className="mission-subtasks">{mission.subtasks.map(subtask => <li key={subtask.id}>
          <div><strong>{subtask.title}</strong><span>{subtask.repoProjectId} · {subtask.status.replaceAll("-", " ")}</span></div>
          {subtask.teamId && <button type="button" className="text-button" onClick={() => openTeam(subtask.teamId!)}>Open team <ArrowUpRight size={14} /></button>}
        </li>)}</ul> : <p className="quiet">No subtasks recorded.</p>}
      </section>
      <section className="team-section">
        <details className="team-history"><summary>Mission history</summary>
          {events.length ? <ol>{events.map((event, index) => <li key={event.at + "/" + index}><time>{date(event.at)}</time><p>{event.text}</p></li>)}</ol> : <p className="quiet">No events recorded.</p>}
        </details>
      </section>
      {me.role === "owner" && (controls.extend || controls.pause || controls.resume || controls.cancel) && <section className="team-section mission-actions">
        <h2>Owner controls</h2>
        {controls.extend && <MissionExtendControl maxMinutes={mission.maxMinutes} disabled={busy || Boolean(pending)} stoppedAtLimit={stoppedAtLimit} submit={minutes => void mutate("extend", minutes)} />}
        <div className="mission-action-buttons">
          {controls.pause && <button type="button" className="text-button" disabled={busy || Boolean(pending)} onClick={() => void mutate("pause")}>Pause mission</button>}
          {controls.resume && <button type="button" className="text-button" disabled={busy || Boolean(pending)} onClick={() => void mutate("resume")}>Resume mission</button>}
          {controls.cancel && <button type="button" className="text-button team-cancel" disabled={busy || Boolean(pending)} onClick={() => { if (window.confirm("Cancel this mission? This stops its coordinator and subtasks and keeps the recorded work.")) void mutate("cancel"); }}>Cancel mission</button>}
        </div>
      </section>}
      {me.role === "owner" && (request.message || pending) && <div className="mission-request-notice" role={request.result ? "status" : "alert"}>
        {request.message && <p>{request.message}</p>}
        {pending && <div className="team-pending"><span>Unconfirmed request: {pending.action} · revision {pending.revision}</span><button type="button" className="text-button" disabled={!fresh || busy} onClick={() => void mutate(pending.action)}>Retry same request</button></div>}
      </div>}
    </div>
  </div>;
}

function MissionExtendControl({ maxMinutes, disabled, stoppedAtLimit, submit }: { maxMinutes: number; disabled: boolean; stoppedAtLimit: boolean; submit: (minutes: number) => void }) {
  const contents = <>
    <div className="mission-extend-choices">{missionExtendChoices(maxMinutes).map(choice => <button type="button" key={choice.minutes} disabled={disabled} aria-label={"Extend by " + choice.label} onClick={() => submit(choice.minutes)}>{choice.label}</button>)}</div>
    <MissionExtendForm disabled={disabled} submit={submit} />
  </>;
  return stoppedAtLimit
    ? <div className="mission-extend"><h3>Extend time</h3>{contents}</div>
    : <details className="mission-extend"><summary>Extend time</summary>{contents}</details>;
}

function MissionExtendForm({ disabled, submit }: { disabled: boolean; submit: (minutes: number) => void }) {
  const [minutes, setMinutes] = useState(60);
  const valid = Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440;
  return <form className="mission-custom-extend" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!disabled && valid) submit(minutes); }}>
    <fieldset disabled={disabled}><label htmlFor="mission-extend-minutes">Add minutes</label><input id="mission-extend-minutes" type="number" min={5} max={1440} step={1} required value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></fieldset>
    <button type="submit" className="primary" disabled={disabled || !valid}>Extend time <ArrowUpRight size={16} /></button>
  </form>;
}
