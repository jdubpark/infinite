import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronRight,
  Cloud,
  Coins,
  Download,
  Infinity as InfinityIcon,
  KeyRound,
  Laptop,
  LogOut,
  Pause,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  TerminalSquare,
  Target,
  Users,
  WifiOff,
} from "lucide-react";
import { useApi, ago, ApiError, isControlRefusal, names, pendingLabel, type ControlLease, type Me, type ProjectDetail, type ProjectSyncStatus, type Session, type LogEvent } from "./api";
import { clearDrafts, readDraft, settleDraft, useSessionDraft, writeDraft, type PendingInput } from "./drafts";
import { creations, lifecycles } from "./requests";
import { MachinePicker, MachineProvider, useMachines } from "./machines";
import { Conversation, ProjectFiles, Dictation, PromptDecision, SessionLifecycle } from "./session-extras";
import { SessionPicker, sessionStatus, useSessionLocation, type SessionTab } from "./session-navigation";
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@xterm/xterm/css/xterm.css";
import { foreground, useLiveRefresh } from "./live-refresh";
import { TeamCreate, TeamDetail, TeamList, TeamPicker, clearTeamRequests, type TeamView } from "./teams";
import { GoalCreate, GoalDetail, GoalList, GoalPicker, clearGoalRequests, type ProductGoal } from "./goals";
import { CostPage, CostPicker } from "./cost";
import "./style.css";

const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
// Switching sessions paints the last view immediately, but never restores authority.
const sessionViews = new Map<string, { session: Session; events: LogEvent[]; cursor: number; seen: string }>();

function useSessionControl(id: string) {
  const api = useApi();
  const [lease, setLease] = useState<ControlLease | null>(null);
  const [holder, setHolder] = useState<ControlLease | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const owned = useRef<ControlLease | null>(null);
  const claiming = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const releaseRequest = (control: ControlLease) => api(`/sessions/${id}/control`, {
    action: "release", leaseId: control.id,
  }).catch(() => {});
  const forget = (release = false) => {
    generation.current++;
    const previous = owned.current;
    owned.current = null;
    setLease(null);
    if (previous) {
      setHolder(current => current?.id === previous.id ? null : current);
      setMessage("");
      if (release) void releaseRequest(previous);
    }
  };
  const observe = (session: Session, revision: number) => {
    if (claiming.current || revision !== generation.current) return;
    setHolder(session.control ?? null);
    const previous = owned.current;
    if (previous && (session.control?.id !== previous.id ||
      session.control.expiresAt <= Date.now() || session.status !== "running")) forget();
  };
  const claim = async (takeover = false) => {
    if (claiming.current) return;
    claiming.current = true;
    const revision = ++generation.current;
    setBusy(true); setMessage("");
    try {
      const result = await api<{ control: ControlLease | null }>(`/sessions/${id}/control`, { action: "claim", takeover });
      if (!mounted.current || !foreground() || revision !== generation.current) {
        if (result.control) void releaseRequest(result.control);
        return;
      }
      // A poll started while claim was pending still carries the old holder.
      // Fence that response as well as polls begun before the request.
      generation.current++;
      owned.current = result.control;
      setLease(result.control); setHolder(result.control);
      setMessage(result.control ? "" : "Control was not granted. Refresh and try again.");
    } catch (error) {
      if (mounted.current && revision === generation.current) {
        forget();
        if (isControlRefusal(error) && error.control !== undefined) setHolder(error.control);
        setMessage((error as Error).message);
      }
    } finally { claiming.current = false; if (mounted.current) setBusy(false); }
  };
  const release = async () => {
    const previous = owned.current;
    if (!previous || claiming.current) return;
    forget();
    const revision = generation.current;
    claiming.current = true;
    setBusy(true);
    try {
      await api(`/sessions/${id}/control`, { action: "release", leaseId: previous.id });
    } catch {
      if (mounted.current && revision === generation.current)
        setMessage("Control release was not confirmed. This device stopped sending; the host lease will expire.");
    } finally {
      // Discard polls begun before the host acknowledged the release.
      if (revision === generation.current) generation.current++;
      claiming.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      const previous = owned.current;
      owned.current = null;
      if (previous) void api(`/sessions/${id}/control`, { action: "release", leaseId: previous.id }).catch(() => {});
    };
  }, [id]);
  useEffect(() => {
    if (!lease) return;
    let renewing = false;
    const expire = setTimeout(() => forget(), Math.max(0, lease.expiresAt - Date.now()));
    const renew = setInterval(async () => {
      if (renewing || !foreground() || owned.current?.id !== lease.id) return;
      renewing = true;
      const revision = generation.current;
      try {
        const result = await api<{ control: ControlLease | null }>(`/sessions/${id}/control`, { action: "renew", leaseId: lease.id });
        if (mounted.current && revision === generation.current && owned.current?.id === lease.id) {
          if (result.control?.id === lease.id && foreground()) {
            generation.current++;
            owned.current = result.control; setLease(result.control); setHolder(result.control);
          } else forget();
        }
      } catch {
        if (mounted.current && revision === generation.current) forget();
      } finally { renewing = false; }
    }, 10000);
    return () => { clearTimeout(expire); clearInterval(renew); };
  }, [id, lease]);
  return { lease, holder, message, busy, claim, release, forget, observe, generation, owned };
}

function Mark() {
  return (
    <div className="brand">
      <InfinityIcon size={29} strokeWidth={1.6} />
      <span>infinite</span>
    </div>
  );
}
function App() {
  const api = useApi();
  const machines = useMachines();
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [goals, setGoals] = useState<ProductGoal[]>([]);
  const route = useSessionLocation(machines.active.id);
  const selected = route.id, creating = route.creating;
  const [bootstrapError, setBootstrapError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setBootstrapError(false);
    api<Me>("/me")
      .then(value => { if (current) { setMe(value); setReady(true); } })
      .catch(error => {
        if (!current) return;
        if (error instanceof ApiError && error.status === 401) setReady(true);
        else setBootstrapError(true);
      });
    const retry = () => setAttempt(value => value + 1);
    window.addEventListener("online", retry);
    return () => { current = false; window.removeEventListener("online", retry); };
  }, [attempt]);
  const host = useLiveRefresh(async (current) => {
    const data = await api<{ sessions: Session[] }>("/sessions");
    if (current()) setSessions(data.sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, 1800, me);
  const teamFeed = useLiveRefresh(async current => {
    const data = await api<{ teams: TeamView[] }>("/teams");
    if (current()) setTeams(data.teams.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, 1800, me?.teams ? me : null);
  const goalFeed = useLiveRefresh(async current => {
    const data = await api<{ goals: ProductGoal[] }>("/goals");
    if (current()) setGoals(data.goals.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, 1800, me?.goals ? me : null);
  const connected = host.fresh;
  const lastSeen = host.seen;
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/login", { token: key.trim() });
      setMe(await api<Me>("/me"));
      setKey("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!ready)
    return (
      <main className="login">
        <Mark />
        <MachinePicker expanded />
        <p role="status">{bootstrapError ? "Your host is unreachable. Your session link is kept here." : "Connecting to your host…"}</p>
        {bootstrapError && <button className="primary" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
      </main>
    );
  if (!me)
    return (
      <main className="login">
        <div className="login-sheet">
          <Mark />
          <MachinePicker />
          <div className="login-heading">
            <h1>
              Pick up where
              <br />
              you left off.
            </h1>
            <p>
              Your agents stay with the host.
              <br />
              Connect this device to see their progress.
            </p>
          </div>
          <form onSubmit={login}>
            <label htmlFor="device-key">Device key</label>
            <input
              id="device-key"
              type="password"
              autoComplete="off"
              placeholder="Paste your private device key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
            />
            <button className="primary stable-action" aria-busy={busy} disabled={busy}>
              {busy && <RefreshCw className="is-refreshing" size={16} />}Connect to Infinite <ArrowUpRight size={18} />
            </button>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </form>
          <p className="quiet login-note">
            <KeyRound size={15} /> Use your laptop’s owner key or a limited
            device key.
          </p>
        </div>
        <div className="login-foot">Your own host. Your own workspace.</div>
      </main>
    );
  const active = sessions.filter((s) => s.status === "running").length;
  return (
    <div className={`app ${selected || creating || route.teams || route.goals || route.cost ? "has-detail" : ""}`}>
      <aside className="sidebar">
        <Mark />
        <MachinePicker />
        <div className="workspace-label">
          <span>Personal workspace</span>
          <ShieldCheck size={15} />
        </div>
        <nav className="workspace-navigation" aria-label="Workspace views">
          <button aria-current={!route.teams && !route.goals && !route.cost ? "page" : undefined} onClick={() => route.navigate(null)}><TerminalSquare size={16} />Sessions</button>
          <button aria-current={route.teams ? "page" : undefined} onClick={() => route.navigateTeam(null)}><Users size={16} />Teams</button>
          <button aria-current={route.goals ? "page" : undefined} onClick={() => route.navigateGoal(null)}><Target size={16} />Goals</button>
          {me.usage?.enabled && <button aria-current={route.cost ? "page" : undefined} onClick={() => route.navigateCost()}><Coins size={16} />Cost</button>}
        </nav>
        <div className="rail-heading">
          <h2>
            {route.cost ? "Projects by cost" : <>{route.goals ? "Goals" : route.teams ? "Teams" : "Sessions"} <span>{route.goals ? goals.length : route.teams ? teams.length : sessions.length}</span></>}
          </h2>
          {me.role === "owner" && !route.cost && (
            <button
              className="icon-button"
              aria-label={route.goals ? "New goal" : route.teams ? "New team" : "New session"}
              onClick={route.goals ? route.createGoal : route.teams ? route.createTeam : route.create}
            >
              <Plus size={20} />
            </button>
          )}
        </div>
        {route.cost ? <CostPicker selected={route.costProjectId} onSelect={id => route.navigateCost("projects", id)} /> : route.goals ? <GoalPicker goals={goals} selected={route.goalId} loading={Boolean(me.goals) && !goalFeed.seen && !goalFeed.failed} onSelect={route.navigateGoal} /> : route.teams ? <TeamPicker teams={teams} selected={route.teamId} loading={Boolean(me.teams) && !teamFeed.seen && !teamFeed.failed} onSelect={route.navigateTeam} /> : <SessionPicker sessions={sessions} showUsage={me.usage?.enabled === true} selected={selected} loading={!host.seen && !host.failed} onSelect={route.navigate} />}
        <div className="host-status">
          <div>
            {me.environment === "cloud" ? (
              <Cloud size={18} />
            ) : (
              <Laptop size={18} />
            )}
            <strong>
              {me.machine?.label || (me.environment === "cloud" ? "Cloud machine" : "Laptop")}
            </strong>
          </div>
          <p>
            {connected ? (
              <>
                <span className="dot running" />
                {active} running · up to date
              </>
            ) : (
              <>
                <WifiOff size={13} /> {host.failed ? "Reconnecting · cached view" : host.seen ? "Checking connection…" : "Connecting to host…"}
              </>
            )}
          </p>
          {lastSeen && <small>Last checked {time(lastSeen)}</small>}
        </div>
        <button
          className="logout"
          onClick={async () => {
            if (machines.active.connection) { machines.remove(); }
            else await api("/logout", {});
            setMe(null);
            route.navigate(null);
            setSessions([]);
            setTeams([]);
            setGoals([]);
            clearGoalRequests(machines.active.id);
            clearTeamRequests(machines.active.id);
            creations.clear(machines.active.id);
            lifecycles.clearMachine(machines.active.id);
            clearDrafts(machines.active.id);
            for (const key of sessionViews.keys()) if (key.startsWith(`${machines.active.id}/`)) sessionViews.delete(key);
          }}
        >
          <LogOut size={16} /> Disconnect this device
        </button>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="back icon-button"
              onClick={() => route.costProjectId ? route.navigateCost("projects") : route.goalId || route.creatingGoal ? route.navigateGoal(null) : route.teamId || route.creatingTeam ? route.navigateTeam(null) : route.navigate(null)}
              aria-label={route.costProjectId ? "Back to projects" : route.goalId || route.creatingGoal ? "Back to goals" : route.teamId || route.creatingTeam ? "Back to teams" : "Back to sessions"}
            >
              <ArrowLeft size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {route.cost ? (route.costProjectId ? "Project cost" : route.costView === "models" ? "Models" : "Cost") : route.creatingGoal ? "New goal" : route.goalId ? "Goal" : route.goals ? "Goals" : route.creatingTeam ? "New team" : route.teamId ? "Team" : route.teams ? "Teams" : creating ? "New session" : selected ? "Session" : "Overview"}
            </strong>
          </div>
          <div className="refresh-status">
          <button className="text-button" onClick={() => { host.refresh(); if (me.teams) teamFeed.refresh(); if (me.goals) goalFeed.refresh(); }} disabled={host.refreshing} aria-busy={host.refreshing}>
            <RefreshCw className={host.refreshing ? "is-refreshing" : ""} size={14} /> Refresh
          </button>
          <span className={`connection ${connected ? "" : "offline"}`}>
            <span className={`dot ${connected ? "running" : "unavailable"}`} />
            {connected ? "Up to date" : host.failed ? "Reconnecting" : host.seen ? "Refreshing" : "Connecting"}
          </span>
          </div>
        </header>
        {host.stale && (
          <div className="connection-notice" role="status">
            {host.seen ? "This device is offline or the host is unreachable. Showing the last received state. Work may still be running; controls are disabled until a fresh connection arrives." : "Can’t reach the host. Sessions haven’t loaded; controls are disabled until a fresh connection arrives."}
          </div>
        )}
        {route.cost ? <CostPage me={me} view={route.costView} projectId={route.costProjectId} navigate={route.navigateCost} /> : route.creatingGoal ? <GoalCreate me={me} connected={connected} done={id => { goalFeed.refresh(); route.navigateGoal(id); }} /> : route.goalId ? <GoalDetail key={route.goalId} id={route.goalId} me={me} connected={connected} teams={teams} teamsStale={teamFeed.stale} refreshGoals={goalFeed.refresh} openTeam={route.navigateTeam} /> : route.goals ? <GoalList goals={goals} me={me} fresh={goalFeed.fresh} stale={goalFeed.stale} loading={Boolean(me.goals) && !goalFeed.seen && !goalFeed.failed} failed={goalFeed.failed} seen={goalFeed.seen} onCreate={route.createGoal} onSelect={route.navigateGoal} /> : route.creatingTeam ? <TeamCreate me={me} connected={connected} done={id => { teamFeed.refresh(); route.navigateTeam(id); }} /> : route.teamId ? <TeamDetail key={route.teamId} id={route.teamId} me={me} connected={connected} sessions={sessions} refreshTeams={teamFeed.refresh} openSession={route.navigate} /> : route.teams ? <TeamList teams={teams} me={me} fresh={teamFeed.fresh} stale={teamFeed.stale} loading={Boolean(me.teams) && !teamFeed.seen && !teamFeed.failed} failed={teamFeed.failed} seen={teamFeed.seen} onCreate={route.createTeam} onSelect={route.navigateTeam} refresh={teamFeed.refresh} openCost={() => route.navigateCost()} /> : creating ? (
          <Create
            me={me}
            done={route.navigate}
            connected={connected}
          />
        ) : selected ? (
          <SessionView
            key={selected}
            id={selected}
            me={me}
            connected={connected}
            tab={route.tab}
            setTab={route.selectTab}
          />
        ) : (
          <div className="overview">
            <div className="overview-title">
              <h1>Room to step away.</h1>
              <p>
                Your work stays with the host.
                <br />
                Open a session to catch up or give it a new direction.
              </p>
            </div>
            <div className="overview-rule">
              <span>
                {active} active {active === 1 ? "session" : "sessions"}
              </span>
              <span>
                {me.environment === "local"
                  ? "Running on this computer"
                  : "Running on your cloud server"}
              </span>
            </div>
            {sessions.length ? (
              sessions.map((session) => (
                <button
                  className="overview-session"
                  key={session.id}
                  onClick={() => route.navigate(session.id)}
                >
                  <span className={`provider-avatar ${session.provider}`}>
                    {names[session.provider]?.slice(0, 1)}
                  </span>
                  <span>
                    <strong>{session.title}</strong>
                    <small>
                      {names[session.provider]} · started{" "}
                      {time(session.createdAt)}
                    </small>
                  </span>
                  <span className="session-status">
                    <span className={`dot ${session.status}`} />
                    {sessionStatus(session)}
                  </span>
                  <ArrowUpRight size={20} />
                </button>
              ))
            ) : (
              <div className="empty-workspace">
                <TerminalSquare size={42} strokeWidth={1.2} />
                <h2>A session that stays.</h2>
                <p>
                  Start a rehearsal to test disconnects without using an AI
                  provider, or launch an installed agent.
                </p>
                {me.role === "owner" && (
                  <button className="primary" onClick={route.create}>
                    Start a session
                    <Plus size={17} />
                  </button>
                )}
              </div>
            )}
            <div className="overview-bottom">
              <ShieldCheck size={20} />
              <p>
                <strong>A private connection to your work.</strong>
                <br />
                Session records are encrypted at rest. The execution host can
                read active work.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
function Create({
  me,
  done,
  connected,
}: {
  me: Me;
  done: (id: string) => void;
  connected: boolean;
}) {
  const api = useApi();
  const machines = useMachines();
  const machine = machines.active.id;
  const creation = creations.use(machine);
  const request = creation.pending;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [backend, setBackend] = useState<"infinite" | "cmux">(request?.backend ?? "infinite");
  const providers = me.backendProviders?.[backend] ?? (backend === "infinite" ? me.providers : []);
  const [provider, setProvider] = useState(request?.provider ?? (providers.includes("demo") ? "demo" : providers[0]));
  const [projectId, setProjectId] = useState(request?.projectId ?? me.projects[0]?.id);
  const [title, setTitle] = useState(request?.title ?? "");
  const [prompt, setPrompt] = useState(request?.prompt ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [applying, setApplying] = useState(false);
  // An apply failure belongs to the workspace it was sent for.
  const [syncError, setSyncError] = useState<{ projectId: string; message: string } | null>(null);
  // The age text changes on every poll, so only a new pending reason or an applied generation is announced.
  const [syncNotice, setSyncNotice] = useState("");
  const syncSeen = useRef<{ projectId?: string; pending?: string; applied?: string }>({});
  // Only a cloud host receives laptop sync; a local host is the laptop.
  const syncs = me.environment === "cloud";
  useEffect(() => {
    if (!project) return;
    const waiting = project.sync.pendingGeneration;
    const pending = waiting ? `${waiting.id}:${waiting.reason}` : undefined, applied = project.sync.appliedManifest;
    const before = syncSeen.current;
    syncSeen.current = { projectId: project.id, pending, applied };
    if (before.projectId !== project.id) return;
    if (waiting && pending !== before.pending) setSyncNotice(`Laptop changes pending: ${pendingLabel(waiting)}.`);
    else if (applied && applied !== before.applied) setSyncNotice("Laptop changes applied.");
  }, [project]);
  useEffect(() => {
    setProject(null);
    setSyncError(null);
    setSyncNotice("");
    if (!projectId || !syncs) return;
    let active = true;
    const load = () => api<ProjectDetail>(`/projects/${projectId}`).then(detail => { if (active) setProject(detail); }).catch(() => { if (active) setProject(null); });
    void load();
    const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [api, projectId, syncs]);
  async function applyPending(force: boolean) {
    const id = projectId;
    if (!id || applying) return;
    if (force && !window.confirm("Replace the cloud copy of this workspace with the laptop's latest sync? Changes made in the cloud since the last apply will be discarded.")) return;
    setApplying(true);
    setSyncError(null);
    try {
      const sync = await api<ProjectSyncStatus>(`/projects/${id}/sync/apply`, force ? { force } : {});
      if (mounted.current) setProject(previous => previous?.id === id ? { ...previous, sync } : previous);
    } catch (error) { if (mounted.current) setSyncError({ projectId: id, message: (error as Error).message }); }
    finally { if (mounted.current) setApplying(false); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !connected || me.role !== "owner" || !provider || !projectId) return;
    if (!request && !title.trim()) { setError("Enter a session name."); return; }
    setBusy(true);
    setError("");
    const body = creations.begin(machine, {
      requestId: crypto.randomUUID(),
      backend,
      provider,
      projectId,
      title: title.trim(),
      prompt,
    });
    try {
      const session = await api<Session>("/sessions", body);
      const settled = creations.complete(machine, body.requestId, { id: session.id });
      if (settled && mounted.current) done(session.id);
    } catch (error) {
      creations.fail(machine, body.requestId, (error as Error).message, error instanceof ApiError && error.status === 400 && error.code === "invalid-create");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="create content">
      <h1>Start something.</h1>
      <p className="intro">Create a session on {me.machine?.label || machines.active.label}.</p>
      <MachinePicker />
      {me.role !== "owner" && <p className="error">An owner key is required to create sessions.</p>}
      {creation.result && <p role="status">Session created. <button className="text-button" onClick={() => done(creation.result!.id)}>Open created session</button></p>}
      <form onSubmit={submit}>
        <fieldset disabled={busy || Boolean(request)}>
          <label htmlFor="backend">Session host</label>
          <select id="backend" value={backend} onChange={event => {
            const next = event.target.value as "infinite" | "cmux";
            setBackend(next); setProvider((me.backendProviders?.[next] ?? (next === "infinite" ? me.providers : []))[0]);
          }}>{(me.backends ?? ["infinite"]).map(value => <option key={value} value={value}>{value === "cmux" ? "cmux" : "Infinite"}</option>)}</select>
          <label htmlFor="provider">Agent</label>
          <select
            id="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {names[p]}
              </option>
            ))}
          </select>
          <label htmlFor="project">Workspace</label>
          <select
            id="project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {me.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {syncs && <p className="sr-only" role="status">{syncNotice}</p>}
          {syncs && project && (
            <p className="quiet sync-status">
              Synced from laptop {ago(project.sync.lastSyncedAt)} · applied {ago(project.sync.appliedAt)}
              {project.sync.pendingGeneration && <> · pending: {pendingLabel(project.sync.pendingGeneration)}{" "}
                {me.role === "owner" && <button type="button" className="text-button stable-action" aria-busy={applying} disabled={applying || !connected} onClick={() => void applyPending(project.sync.pendingGeneration!.reason === "cloud-changed")}>
                  {applying ? "Applying…" : project.sync.pendingGeneration.reason === "cloud-changed" ? "Replace cloud files" : "Apply now"}</button>}</>}
            </p>
          )}
          {syncs && syncError?.projectId === projectId && !applying && <p className="error" role="alert">{syncError.message}</p>}
          <label htmlFor="title">Session name</label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What are you working on?"
            required
            maxLength={100}
          />
          <label htmlFor="prompt">
            First request <span className="quiet">(optional)</span>
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="Give the agent an outcome and useful context…"
            maxLength={24000}
          />
        </fieldset>
        <p className="form-note">
          {provider === "demo"
            ? "Rehearsal is a local test process. It does not call an AI model."
            : "The agent uses the account and permissions configured on the host. A permission prompt can pause work until you respond."}
        </p>
        {!busy && (error || creation.message) && <p className="error" role="alert">{error || creation.message}{!error && request ? " Retry will use the same creation request." : ""}</p>}
        <button className="primary stable-action" aria-busy={busy} disabled={busy || !connected || me.role !== "owner" || !provider || !projectId || !title.trim()}>
          {busy && <RefreshCw className="is-refreshing" size={16} />}{request
              ? "Retry same request"
              : "Start session"}
          <ArrowUpRight size={18} />
        </button>
      </form>
    </div>
  );
}
function TerminalView({ id }: { id: string }) {
  const api = useApi();
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const terminal = new Terminal({
      convertEol: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 10000,
      theme: {
        background: "#202923",
        foreground: "#e4e9de",
        cursor: "#e4e9de",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current!);
    fit.fit();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element.current!);
    let active = true,
      cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const page = await api<{
          events: LogEvent[];
          cursor: number;
          more: boolean;
        }>(`/sessions/${id}/events?after=${cursor}`);
        if (!active) return;
        for (const event of page.events)
          if (event.type === "output") terminal.write(String(event.data.text));
        cursor = page.cursor;
        setError("");
        timer = setTimeout(poll, page.more ? 0 : 800);
      } catch {
        if (active) {
          setError("Waiting for the host. Recorded output will resume here.");
          timer = setTimeout(poll, 1800);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      observer.disconnect();
      terminal.dispose();
    };
  }, [id]);
  return (
    <div className="terminal-shell">
      <div className="terminal-caption">
        Recorded terminal · use the composer to send input
      </div>
      <div className="terminal" ref={element} />
      {error && (
        <p className="terminal-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
function SessionView({
  id,
  me,
  connected,
  tab,
  setTab,
}: {
  id: string;
  me: Me;
  connected: boolean;
  tab: SessionTab;
  setTab: (tab: SessionTab) => void;
}) {
  const api = useApi();
  const machines = useMachines();
  const cacheKey = `${machines.active.id}/${id}`;
  const cached = useRef(sessionViews.get(cacheKey));
  const [session, setSession] = useState<Session | null>(cached.current?.session ?? null);
  const draft = useSessionDraft(cacheKey);
  const text = draft.text;
  const pendingInput = draft.pending !== null;
  function setText(next: string | ((previous: string) => string)) {
    const current = readDraft(cacheKey);
    writeDraft(cacheKey, { ...current, text: typeof next === "function" ? next(current.text) : next });
  }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<LogEvent[]>(cached.current?.events ?? []);
  const cursor = useRef<number | null>(cached.current?.cursor ?? null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const screen = useRef<HTMLPreElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const sending = useRef(false);
  const [loadError, setLoadError] = useState("");
  const control = useSessionControl(id);
  const view = useLiveRefresh(async (current) => {
    const revision = control.generation.current;
    let detail: Session;
    try { detail = await api<Session>(`/sessions/${id}`); }
    catch (error) {
      if (current()) setLoadError(error instanceof ApiError && error.status === 404
        ? "This session is not available on this host. Open another session from the list."
        : "The host is unreachable. Your draft stays in this tab; try again when connected.");
      throw error;
    }
    if (!current()) return;
    setSession(detail);
    setLoadError("");
    control.observe(detail, revision);
    // Catch up from a bounded recent window, not the recording's first event.
    const after = cursor.current ?? Math.max(0, detail.seq - 200);
    const page = await api<{ events: LogEvent[]; cursor: number; more: boolean }>(
      `/sessions/${id}/events?after=${after}&types=lifecycle,input-intent,input-result,signal&limit=100`);
    if (current()) {
      cursor.current = page.cursor;
      const next = [...(sessionViews.get(cacheKey)?.events ?? []), ...page.events].slice(-100);
      setEvents(next);
      sessionViews.delete(cacheKey);
      sessionViews.set(cacheKey, { session: detail, events: next, cursor: page.cursor, seen: new Date().toISOString() });
      if (sessionViews.size > 20) sessionViews.delete(sessionViews.keys().next().value!);
    }
    return page.more ? 0 : 1100;
  }, 1100, id, () => control.forget(true));
  useLayoutEffect(() => {
    const output = screen.current, viewport = body.current;
    if (!output || !viewport) return;
    const fit = () => {
      const inset = parseFloat(getComputedStyle(viewport).paddingBottom) || 0;
      const top = output.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
      output.style.maxHeight = `${Math.max(100, Math.min(360, viewport.clientHeight - top - inset))}px`;
      if (following) {
        output.scrollTop = output.scrollHeight;
        const obscured = output.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom + inset;
        if (obscured > 0) viewport.scrollTop += obscured;
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    return () => observer.disconnect();
  }, [session?.screen, following, tab]);
  useLayoutEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = "auto";
    composer.current.style.height = `${Math.min(170, composer.current.scrollHeight)}px`;
  }, [text, tab, session !== null]);
  const requiresControl = session?.capabilities?.inputControl === 1;
  const canSteer = connected && view.fresh && session?.status === "running" &&
    me.role !== "viewer" && (!requiresControl || Boolean(control.lease));
  async function takeControl(takeover = false) {
    if (!view.fresh || session?.status !== "running") return;
    await control.claim(takeover);
    if (control.owned.current) composer.current?.focus();
    view.refresh();
  }
  function handleInputError(error: unknown) {
    if (isControlRefusal(error)) {
      control.forget();
      view.refresh();
      return true;
    }
    return false;
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!canSteer || busy || sending.current || !text.trim() || (session?.attention?.prompt && tab !== "terminal" && tab !== "screen")) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const current = readDraft(cacheKey);
    const retrying = current.pending !== null;
    // Only the terminal views permit typing directly into an open dialog.
    const request: PendingInput = current.pending ?? { requestId: crypto.randomUUID(), text: current.text, submit: true, ...(tab === "terminal" || tab === "screen" ? { force: true } : {}) };
    writeDraft(cacheKey, { text: current.text, pending: request });
    try {
      const receipt = await api<{ state: string }>(
        `/sessions/${id}/input`,
        request,
        undefined,
        control.owned.current?.id,
      );
      if (receipt.state !== "delivered")
        throw new Error(
          "Delivery is uncertain. Check the terminal before sending anything else.",
        );
      settleDraft(cacheKey, request.requestId, true);
      setNotice(
        "Delivered to the terminal. Agent execution is not yet confirmed.",
      );
    } catch (e) {
      if (handleInputError(e)) {
        if (!retrying) {
          settleDraft(cacheKey, request.requestId, false);
        }
        setError(retrying ? `${(e as Error).message} This retry was refused. Earlier delivery remains unconfirmed; its request ID is kept.` :
          `${(e as Error).message} Your draft was not sent.`);
      } else if (e instanceof ApiError && e.code === "prompt-open" && !retrying) {
        settleDraft(cacheKey, request.requestId, false); view.refresh();
        setError("A prompt is open. Answer it above, or use the terminal.");
      } else setError(`${(e as Error).message} Delivery may be uncertain. Check the recording before retrying the same request.`);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function key(key: string) {
    if (!canSteer || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const receipt = await api<{ state: string }>(`/sessions/${id}/key`,
        { requestId: crypto.randomUUID(), key }, undefined, control.owned.current?.id);
      if (receipt.state !== "delivered") throw new Error("Key delivery is uncertain.");
      setNotice(`${key} sent to the terminal.`);
    } catch (e) {
      setError(handleInputError(e) ? `${(e as Error).message} The key was not sent.` :
        `${(e as Error).message} Check the recording before sending another key.`);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError("");
    try {
      const chunks: string[] = [];
      let cursor = 0,
        more = true;
      while (more) {
        const page = await api<{
          events: LogEvent[];
          cursor: number;
          more: boolean;
        }>(`/sessions/${id}/events?after=${cursor}`);
        chunks.push(...page.events.map((e) => JSON.stringify(e) + "\n"));
        cursor = page.cursor;
        more = page.more;
      }
      const url = URL.createObjectURL(
        new Blob(chunks, { type: "application/x-ndjson" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `infinite-${id}.ndjson`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!session)
    return (
      <div className="content">
        <p role="status">{loadError || "Opening this session…"}</p>
        {loadError && <button className="primary" onClick={view.refresh} disabled={view.refreshing}>Try again</button>}
      </div>
    );
  return (
    <div className="session-detail">
      <div className="session-heading">
        <div>
          <h1>{session.title}</h1>
          <div className="provider-name">
            <span className={`dot ${session.status}`} />
            {names[session.provider]}
            <span className="quiet">/ {session.status}</span>
          </div>
          <p className="session-meta">
            Tools run on {(session.execution?.location ?? session.executionLocation) === "laptop" ? "your laptop" : me.machine?.label || "this machine"} <span>·</span>{" "}
            Started {time(session.createdAt)} <span>·</span>{" "}
            {session.pid ? `PID ${session.pid}` : "No live process"}
          </p>
          {session.execution && (
            <p className="session-meta">
              <span className="session-freshness-label">{view.stale ? "Last received tools:" : "Tools:"}</span>{" "}{session.execution.location === "cloud" ? "Cloud" : "Laptop"} <span>·</span>{" "}
              {session.execution.state === "online" ? "connected" : session.execution.state} <span>·</span>{" "}
              {session.execution.location === "cloud" ? "Cloud handoff complete" : session.execution.cloudReady ? "Ready for cloud handoff" : "Preparing cloud handoff"}
              {session.execution.checkpoint && <> · Checkpoint {Math.max(0, Math.floor((Date.now() - Date.parse(session.execution.checkpoint.capturedAt)) / 1000))}s ago</>}
              {session.execution.reason && <> · {session.execution.reason}</>}
              {session.execution.reconciliation && <> · Laptop edits preserved; cloud copy available for reconciliation</>}
            </p>
          )}
        </div>
        <button
          className="icon-button export"
          disabled={busy}
          onClick={download}
          title="Export decrypted log"
          aria-label="Export decrypted log"
        >
          <Download size={19} />
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label="Session views">
        {(["chat", "screen", "terminal", "files", "context"] as const).map((t) => (
          <button
            role="tab"
            id={`view-${t}`}
            aria-controls="session-panel"
            tabIndex={tab === t ? 0 : -1}
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
            onKeyDown={event => {
              const views: SessionTab[] = ["chat", "screen", "terminal", "files", "context"];
              const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!offset) return;
              event.preventDefault();
              const next = views[(views.indexOf(t) + offset + views.length) % views.length];
              setTab(next); document.getElementById(`view-${next}`)?.focus();
            }}
          >
            {t === "chat" ? "Chat" : t === "screen" ? "Catch up" : t === "terminal" ? "Terminal" : t === "files" ? "Files" : "Context"}
          </button>
        ))}
        <span>{session.seq} recorded events</span>
      </div>
      <div className="session-body" id="session-panel" ref={body} role="tabpanel" aria-labelledby={`view-${tab}`} onScroll={() => {
        if (screen.current && body.current && screen.current.getBoundingClientRect().bottom > body.current.getBoundingClientRect().bottom + 1)
          setFollowing(false);
      }}>
        {tab === "chat" ? <Conversation id={id} /> : tab === "files" ? <ProjectFiles id={id} online={connected && view.fresh} /> : tab === "terminal" ? (
          <TerminalView id={id} />
        ) : tab === "context" ? (
          <Context session={session} me={me} connected={connected && view.fresh} />
        ) : (
          <div className="catchup">
            {session.attention?.now && <div className="attention-summary"><strong>{sessionStatus(session)}</strong><p>{session.attention.now}</p></div>}
            <div className="section-label">
              <h2>Current screen</h2>
              <div className="screen-actions">
                <span className="screen-freshness">{view.fresh ? `Updated ${time(view.seen)}` : view.seen || cached.current?.seen ? `Saved view · ${time(view.seen || cached.current!.seen)}` : "Refreshing…"}</span>
                <button className="text-button" aria-pressed={following} onClick={() => setFollowing(value => !value)}>
                  <ArrowDown size={14} />{following ? "Following latest" : "Follow latest"}
                </button>
              </div>
            </div>
            <pre className="screen" ref={screen} tabIndex={0} aria-label="Current terminal screen" onScroll={event => {
              const element = event.currentTarget;
              setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
            }}>
              {session.screen ||
                (session.status === "running"
                  ? "Waiting for output…"
                  : "This process is no longer attached. Open Full terminal to replay its recording.")}
            </pre>
            <div className="section-label activity-label">
              <h2>Session activity</h2>
              <span>Recent control events</span>
            </div>
            <ol className="activity">
              {events.map((event) => (
                <li key={event.seq}>
                  <time>{time(event.at)}</time>
                  <span className="event-dot" />
                  <div>
                    <strong>
                      {event.type === "input-intent"
                        ? "Input requested"
                        : event.type === "input-result"
                          ? event.data.state === "delivered" ? "Input delivered to terminal" : "Input delivery uncertain"
                          : event.type === "signal"
                            ? String(event.data.kind ?? "Signal")
                            : String(event.data.status ?? "Session updated")}
                    </strong>
                    {event.data.text != null && (
                      <p>{String(event.data.text)}</p>
                    )}
                    {event.data.error != null && (
                      <p className="error">{String(event.data.error)}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
      <div className="composer-area">
        {session.attention?.prompt && <PromptDecision key={session.attention.prompt.id} sessionId={id} backend={session.backend} prompt={session.attention.prompt} canAnswer={Boolean(canSteer && me.capabilities?.answer !== false)} controlId={control.lease?.id} refresh={view.refresh} onRefused={() => control.forget()} openTerminal={() => setTab("terminal")} />}
        <div className="control-bar">
          <div>
            <strong>{requiresControl ? control.lease ? "You have control" : "Monitoring" : me.role === "viewer" ? "View only" : "Shared controls"}</strong>
            <span className="control-state" title={!view.fresh || !connected ? "Refreshing before input…" : session.status !== "running" ? "Process is not running" : requiresControl && !control.lease ? control.holder ? `${control.holder.label} has control` : "Draft now, take control to send" : "Ready for input"}>{!view.fresh || !connected ? "Refreshing before input…" : session.status !== "running" ? "Process is not running" : requiresControl && !control.lease ? control.holder ? `${control.holder.label} has control` : "Draft now, take control to send" : "Ready for input"}</span>
          </div>
          <div className="control-actions">
            <SessionLifecycle session={session} role={me.role} online={connected && view.fresh} controlId={control.lease?.id} refresh={view.refresh} />
            <button className="text-button" onClick={view.refresh} disabled={view.refreshing} aria-label="Refresh this session" aria-busy={view.refreshing}><RefreshCw className={view.refreshing ? "is-refreshing" : ""} size={16} /></button>
            {requiresControl && me.role !== "viewer" && session.status === "running" && (
              control.lease ? <button className="text-button" onClick={async () => { await control.release(); view.refresh(); }}>Stop controlling</button> :
                <button className="primary stable-action" aria-busy={control.busy} disabled={!connected || !view.fresh || control.busy} onClick={() => takeControl(Boolean(control.holder))}>
                  {control.busy ? "Updating…" : control.holder ? "Take over" : "Take control"}
                </button>
            )}
          </div>
        </div>
        <div className="composer-feedback">
          <span className={error ? "error" : control.message ? "quiet control-message" : "receipt"} role={error ? "alert" : "status"} title={error || control.message || notice}>
            {!error && !control.message && notice && <Check size={14} aria-hidden="true" />}{error || control.message || notice}
          </span>
        </div>
        {me.role === "viewer" ? (
          <p className="quiet">This device has view-only access.</p>
        ) : (
          <>
            <form className="composer" onSubmit={send}>
              <label className="sr-only" htmlFor="message">
                Message to agent
              </label>
              <textarea
                id="message"
                ref={composer}
                rows={2}
                placeholder={
                  canSteer
                    ? "Give this session a direction…"
                    : "Draft here. Take control when you are ready to send…"
                }
                value={text}
                onChange={(e) => { setText(e.target.value); setNotice(""); setError(""); }}
                onKeyDown={event => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (canSteer && text.trim()) event.currentTarget.form?.requestSubmit();
                  }
                }}
                disabled={busy || pendingInput}
                maxLength={32000}
              />
              <button
                className="send-button"
                aria-busy={busy}
                aria-label={
                  busy ? "Sending message" : pendingInput ? "Retry same message" : "Send message"
                }
                disabled={!canSteer || busy || !text.trim() || Boolean(session.attention?.prompt && tab !== "terminal" && tab !== "screen")}
              >
                {busy ? <RefreshCw className="is-refreshing" size={20} /> : pendingInput ? <RefreshCw size={20} /> : <Send size={20} />}
              </button>
            </form>
            <div className="composer-footer">
              <span>{pendingInput && !busy ? "Unconfirmed delivery · retry keeps the same request ID" : text ? "Unsent draft · kept in this tab" : "⌘ / Ctrl + Enter to send · Enter for a new line"}</span>
              <div>
                <Dictation disabled={busy || pendingInput} onText={value => setText(current => `${current}${current ? " " : ""}${value}`)} />
                <button
                  disabled={!canSteer || busy}
                  onClick={() => key("enter")}
                >
                  Enter
                </button>
                <button
                  disabled={!canSteer || busy}
                  onClick={() => key("escape")}
                >
                  Escape
                </button>
                <button disabled={!canSteer || busy} onClick={() => key("up")}>
                  Up
                </button>
                <button
                  disabled={!canSteer || busy}
                  onClick={() => key("down")}
                >
                  Down
                </button>
                <button
                  disabled={!canSteer || busy}
                  onClick={() => key("interrupt")}
                >
                  <Pause size={13} /> Interrupt
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function Context({
  session,
  me,
  connected,
}: {
  session: Session;
  me: Me;
  connected: boolean;
}) {
  const api = useApi();
  const [context, setContext] = useState<{ version: number; text: string; binding?: "review-required" }>({ version: 0, text: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<typeof context>(
      `/projects/${session.projectId}/context`,
    )
      .then(setContext)
      .catch(() => setMessage("Could not load project context."));
  }, [session.projectId]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const next = await api<typeof context>(
        `/projects/${session.projectId}/context`,
        { text: context.text, expectedVersion: context.version },
        "PUT",
      );
      setContext(next);
      setMessage(
        "Saved for new sessions. Send changes explicitly to an existing session.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="context-view">
      <h2>What this session started with</h2>
      <p className="quiet">
        Project context v{session.contextVersion}. Each provider retains its own
        native conversation.
      </p>
      <pre>{session.context || "No shared project context was supplied."}</pre>
      {session.initialPrompt && (
        <>
          <h3>First request</h3>
          <pre>{session.initialPrompt}</pre>
        </>
      )}
      <form onSubmit={save}>
        <label htmlFor="shared-context">
          Shared project context{" "}
          <span className="quiet">v{context.version}</span>
        </label>
        <p className="quiet">
          Context stays in this project unless the owner explicitly links another project.
          Saving does not rewrite running conversations.
        </p>
        {context.binding === "review-required" && <p role="status">The saved context belongs to an unverified or changed codebase. Enter context for this project and save it before starting a session.</p>}
        <textarea
          id="shared-context"
          rows={8}
          value={context.text}
          disabled={me.role !== "owner" || busy}
          onChange={(e) => setContext({ ...context, text: e.target.value })}
          maxLength={24000}
        />
        {me.role === "owner" && (
          <button className="primary" disabled={!connected || busy}>
            Save context
            <Check size={16} />
          </button>
        )}
        {message && <p role="status">{message}</p>}
      </form>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<MachineProvider><App /></MachineProvider>);
