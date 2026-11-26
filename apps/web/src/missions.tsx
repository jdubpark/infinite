import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, RefreshCw, Send, X } from "lucide-react";
import { ApiError, useApi, type Me } from "./api";
import { useLiveRefresh } from "./live-refresh";
import { useMachines } from "./machines";
import { requestStore } from "./requests";
import { haltNotice, missionHaltPlace, type HaltView } from "./halt";
import { HaltBanner } from "./halt-banner";
import {
  missionCanAnswer,
  missionComposerNotice,
  missionControls,
  missionExtendChoices,
  missionExtensionConfirmation,
  missionShowsReason,
  missionStateLabel,
  missionStopLine,
  missionStoppedAtLimit,
  type MissionStatus,
} from "./mission-model";
import {
  applyMissionProgressPage,
  initialMissionProgressState,
  type MissionProgressPage,
  type MissionProgressState,
} from "./mission-inspector/progress-store";
import {
  MissionDirectionsAndDecisions,
  MissionOpenDecisions,
  MissionOverview,
  MissionProgressAndEvents,
  MissionResyncBanner,
  MissionSubtaskInspector,
  type MissionView,
} from "./mission-inspector/MissionInspector";
import "./mission-inspector/mission-inspector.css";

type MissionAction = "extend" | "pause" | "resume" | "cancel" | "answer" | "steer";
type MissionRequest = {
  requestId: string;
  revision: number;
  action: MissionAction;
  minutes?: number;
  decisionId?: string;
  text?: string;
};

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
  const [progressState, setProgressState] = useState<MissionProgressState>(() => initialMissionProgressState());
  const [progressError, setProgressError] = useState("");
  const [dismissedResyncCount, setDismissedResyncCount] = useState(0);
  const [selectedSubtaskId, setSelectedSubtaskId] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const [dismissedMessage, setDismissedMessage] = useState("");
  const request = mutations.use(key), pending = request.pending;
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const activeKeyRef = useRef(key);
  activeKeyRef.current = key;
  const progressRef = useRef<MissionProgressState>(initialMissionProgressState());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const freshProgress = initialMissionProgressState();
    progressRef.current = freshProgress;
    setProgressState(freshProgress);
    setProgressError("");
    setDismissedResyncCount(0);
    setSelectedSubtaskId(null);
    setMission(null);
    setBusy(false);
  }, [key]);

  useEffect(() => {
    setDismissedMessage("");
    if (!request.result || !request.message) return;
    const timer = setTimeout(() => setDismissedMessage(request.message), 4000);
    return () => clearTimeout(timer);
  }, [request.message, request.result]);

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

  const progressView = useLiveRefresh(async current => {
    try {
      const cursor = progressRef.current.cursor;
      const query = cursor ? "?cursor=" + encodeURIComponent(cursor) : "";
      const page = await api<MissionProgressPage>("/missions/" + id + "/progress" + query);
      if (current()) {
        const next = applyMissionProgressPage(progressRef.current, page);
        progressRef.current = next;
        setProgressState(next);
        setProgressError("");
      }
    } catch (failure) {
      if (current()) setProgressError((failure as Error).message);
      throw failure;
    }
  }, 1800, me.missions?.enabled === false ? null : key);

  const fresh = connected && view.fresh;
  const controls = mission ? missionControls(mission, me.role, fresh, Date.now()) : { extend: false, pause: false, resume: false, cancel: false };
  const liveMission = Boolean(mission && ["planning", "working", "needs-input"].includes(mission.status));
  const canAnswer = Boolean(mission && missionCanAnswer(mission, me.role, fresh));
  const canSteer = Boolean(fresh && me.role === "owner" && liveMission);
  const progressLoading = progressState.snapshot === null && !progressError && (progressView.refreshing || (!progressView.failed && !progressView.seen));

  async function mutate(
    action: MissionAction,
    options: { minutes?: number; decisionId?: string; text?: string } = {},
  ) {
    if (!mission || !fresh || me.role !== "owner" || busy) return;
    const targetKey = key;
    let body = pending;
    if (!body) {
      if (action === "extend" || action === "pause" || action === "resume" || action === "cancel") {
        if (!missionControls(mission, me.role, fresh, Date.now())[action]) return undefined;
        if (action === "extend" && (options.minutes === undefined || !Number.isInteger(options.minutes) || options.minutes < 5 || options.minutes > 1440)) return;
        body = mutations.begin(targetKey, {
          requestId: crypto.randomUUID(),
          revision: mission.revision,
          action,
          ...(action === "extend" && options.minutes !== undefined ? { minutes: options.minutes } : {}),
        });
      } else if (action === "answer") {
        const text = options.text?.trim();
        if (!canAnswer || !options.decisionId || !text) return;
        body = mutations.begin(targetKey, {
          requestId: crypto.randomUUID(),
          revision: mission.revision,
          action,
          decisionId: options.decisionId,
          text,
        });
      } else if (action === "steer") {
        const text = options.text?.trim();
        if (!canSteer || !text) return;
        body = mutations.begin(targetKey, {
          requestId: crypto.randomUUID(),
          revision: mission.revision,
          action,
          text,
        });
      }
    }
    if (!body || inFlight.has(body.requestId)) return;
    inFlight.add(body.requestId);
    setBusy(true);
    try {
      let endpoint = "/missions/" + id + "/" + body.action;
      let payload: Record<string, unknown> = { requestId: body.requestId, revision: body.revision };
      if (body.action === "extend") payload = { ...payload, minutes: body.minutes };
      else if (body.action === "answer") {
        endpoint = "/missions/" + id + "/answer/" + body.decisionId;
        payload = { ...payload, text: body.text };
      } else if (body.action === "steer") {
        payload = { ...payload, text: body.text };
      }
      const result = await api<MissionView>(endpoint, payload);
      const message = body.action === "extend"
        ? missionExtensionConfirmation(result, Date.now(), date)
        : body.action === "answer"
          ? "Answer recorded. Revision " + result.revision + "."
          : body.action === "steer"
            ? "Direction recorded. Revision " + result.revision + "."
            : body.action[0].toUpperCase() + body.action.slice(1) + " recorded. Revision " + result.revision + ".";
      const accepted = mutations.complete(targetKey, body.requestId, { id: result.id }, message);
      if (mounted.current && activeKeyRef.current === targetKey) {
        receive(result);
        if (accepted && body.action === "steer") setDirection("");
        view.refresh();
        progressView.refresh();
      }
    } catch (failure) {
      const wasRejected = rejected(failure);
      mutations.fail(
        targetKey,
        body.requestId,
        (failure as Error).message + (wasRejected ? " Refresh the mission before sending another request." : " Delivery is unconfirmed. Retry will use the same request."),
        wasRejected,
      );
      if (mounted.current && activeKeyRef.current === targetKey && wasRejected) {
        view.refresh();
        progressView.refresh();
      }
    } finally {
      inFlight.delete(body.requestId);
      if (mounted.current && activeKeyRef.current === targetKey) setBusy(false);
    }
  }

  const banner = <HaltBanner className="halt-main" notice={haltNotice(halt, missionHaltPlace(mission?.repoProjectIds ?? []))} name={projectId => me.projects.find(project => project.id === projectId)?.name ?? projectId} owner={me.role === "owner"} />;
  if (me.missions?.enabled === false) return <div className="team-page"><h1>Mission</h1>{banner}<p className="team-notice" role="status">Missions are not enabled on this host.</p></div>;
  if (!mission) return <div className="team-page"><h1>Mission</h1>{banner}<p role="status">{loadError || "Loading mission…"}</p>{loadError && <button type="button" className="text-button" onClick={view.refresh}><RefreshCw size={15} />Try again</button>}</div>;

  const stoppedAtLimit = missionStoppedAtLimit(mission);
  const stopLine = missionStopLine(mission, Date.now(), date);
  const refreshing = view.refreshing || progressView.refreshing;
  const composerNotice = missionComposerNotice(mission, me.role, Date.now());

  return <div className="team-detail mission-detail">
    <header className="team-detail-heading">
      <div>
        <p className="team-eyebrow">{mission.groupName || "Mission"}</p>
        <h1>{mission.title}</h1>
        <div className="team-detail-meta">
          <span className={"team-status " + missionStatusClass(mission.status)}><span className="dot" />{missionStateLabel(mission)}</span>
          <span>Revision {mission.revision}</span>
          <span className="team-freshness" role="status">{view.stale ? "Showing last received state; controls are disabled." : ""}</span>
        </div>
        {stopLine && <p className="quiet mission-stop-time" role="status">{stopLine}</p>}
      </div>
      <button type="button" className="text-button" disabled={refreshing} onClick={() => { view.refresh(); progressView.refresh(); }} aria-busy={refreshing}><RefreshCw className={refreshing ? "is-refreshing" : ""} size={14} />Refresh mission</button>
    </header>
    {banner}
    <div className="team-detail-body">
      <MissionResyncBanner
        progress={progressState}
        dismissedCount={dismissedResyncCount}
        onDismiss={() => setDismissedResyncCount(progressState.resyncCount)}
      />
      {missionShowsReason(mission) && <p className="team-notice" role="status">{mission.reason}</p>}
      <MissionOpenDecisions
        mission={mission}
        me={me}
        disabled={!canAnswer || busy || Boolean(pending)}
        answer={(decisionId, text) => void mutate("answer", { decisionId, text })}
      />
      <MissionOverview mission={mission} me={me} progress={progressState} formatDate={date} />
      <MissionSubtaskInspector
        mission={mission}
        me={me}
        progress={progressState}
        progressError={progressError}
        progressLoading={progressLoading}
        selectedSubtaskId={selectedSubtaskId}
        onSelectSubtask={setSelectedSubtaskId}
        openTeam={openTeam}
        formatDate={date}
      />
      <MissionDirectionsAndDecisions mission={mission} formatDate={date} />
      <MissionProgressAndEvents mission={mission} progress={progressState} progressError={progressError} formatDate={date} />
      {me.role === "owner" && (controls.extend || controls.pause || controls.resume || controls.cancel) && <section className="team-section mission-actions">
        <h2>Owner controls</h2>
        {controls.extend && <MissionExtendControl maxMinutes={mission.maxMinutes} disabled={busy || Boolean(pending)} stoppedAtLimit={stoppedAtLimit} submit={minutes => void mutate("extend", { minutes })} />}
        <div className="mission-action-buttons">
          {controls.pause && <button type="button" className="text-button" disabled={busy || Boolean(pending)} onClick={() => void mutate("pause")}>Pause mission</button>}
          {controls.resume && <button type="button" className="text-button" disabled={busy || Boolean(pending)} onClick={() => void mutate("resume")}>Resume mission</button>}
          {controls.cancel && <button type="button" className="text-button team-cancel" disabled={busy || Boolean(pending)} onClick={() => { if (window.confirm("Cancel this mission? This stops its coordinator and subtasks and keeps the recorded work.")) void mutate("cancel"); }}>Cancel mission</button>}
        </div>
      </section>}
    </div>
    <div className="team-composer-area">
      {me.role === "owner" && !busy && ((request.message && request.message !== dismissedMessage) || pending) && (
        <div className={`team-floating-notice${request.result ? " is-receipt" : ""}`} role={request.result ? "status" : "alert"}>
          {request.message && request.message !== dismissedMessage && (
            <div className="team-floating-message">
              <span>{request.message}</span>
              <button type="button" className="team-notice-dismiss" aria-label="Dismiss notice" onClick={() => setDismissedMessage(request.message)}><X size={15} /></button>
            </div>
          )}
          {pending && (
            <div className="team-pending" role="status">
              <span>Unconfirmed request: {pending.action} · revision {pending.revision}</span>
              <button type="button" className="text-button" disabled={!fresh || busy} onClick={() => void mutate(pending.action)}>Retry same request</button>
            </div>
          )}
        </div>
      )}
      {composerNotice ? (
        <p className="quiet">{composerNotice}</p>
      ) : (
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (direction.trim()) void mutate("steer", { text: direction.trim() }); }}>
          <label className="sr-only" htmlFor="mission-steer-direction">Steer this mission</label>
          <textarea
            id="mission-steer-direction"
            rows={2}
            maxLength={8000}
            placeholder="Send direction to the mission coordinator…"
            value={direction}
            onChange={event => setDirection(event.target.value)}
            disabled={busy || Boolean(pending)}
          />
          <button type="submit" className="primary" disabled={!canSteer || busy || Boolean(pending) || !direction.trim()}>
            Send direction <Send size={17} />
          </button>
        </form>
      )}
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
