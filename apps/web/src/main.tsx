import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  WifiOff,
} from "lucide-react";
import { api, ApiError, isControlRefusal, names, type ControlLease, type Me, type Session, type LogEvent } from "./api";
import { SessionPicker, sessionStatus, useSessionLocation, type SessionTab } from "./session-navigation";
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
type PendingInput = { requestId: string; text: string; submit: boolean; force: true };
// Drafts and uncertain request IDs live only in this tab's memory.
const drafts = new Map<string, { text: string; pending: PendingInput | null }>();
// Switching sessions paints the last view immediately, but never restores authority.
const sessionViews = new Map<string, { session: Session; events: LogEvent[]; cursor: number; seen: string }>();
const foreground = () => document.visibilityState !== "hidden" && navigator.onLine;

function useLiveRefresh(
  task: (current: () => boolean) => Promise<number | void>,
  interval: number,
  identity: unknown,
  unavailable?: () => void,
) {
  const taskRef = useRef(task);
  const unavailableRef = useRef(unavailable);
  useEffect(() => {
    taskRef.current = task;
    unavailableRef.current = unavailable;
  });
  const refreshRef = useRef<() => void>(() => {});
  const [fresh, setFresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [seen, setSeen] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true, polling = false, queued = false, generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    setFresh(false);
    setFailed(false);
    setSeen("");
    const poll = async () => {
      clearTimeout(timer);
      if (!active || !identity || !foreground()) return;
      if (polling) { queued = true; return; }
      polling = true;
      setRefreshing(true);
      const started = generation;
      const current = () => active && foreground() && started === generation;
      let delay = interval;
      try {
        delay = await taskRef.current(current) ?? interval;
        if (current()) { setFresh(true); setFailed(false); setSeen(new Date().toISOString()); }
      } catch {
        if (current()) { setFresh(false); setFailed(true); unavailableRef.current?.(); }
      } finally {
        polling = false;
        if (active) {
          setRefreshing(false);
          if (foreground()) timer = setTimeout(poll, queued ? 0 : delay);
          queued = false;
        }
      }
    };
    const resync = () => {
      generation++;
      setFresh(false);
      if (!navigator.onLine) setFailed(true);
      clearTimeout(timer);
      if (foreground()) void poll();
      else unavailableRef.current?.();
    };
    refreshRef.current = () => { void poll(); };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("offline", resync);
    window.addEventListener("focus", resync);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      refreshRef.current = () => {};
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("offline", resync);
      window.removeEventListener("focus", resync);
    };
  }, [identity, interval]);
  return { fresh, refreshing, seen, failed, refresh: useCallback(() => refreshRef.current(), []) };
}

function useSessionControl(id: string) {
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
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const route = useSessionLocation();
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
        <p role="status">{bootstrapError ? "Your host is unreachable. Your session link is kept here." : "Connecting to your host…"}</p>
        {bootstrapError && <button className="primary" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
      </main>
    );
  if (!me)
    return (
      <main className="login">
        <div className="login-sheet">
          <Mark />
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
            <button className="primary" disabled={busy}>
              {busy ? "Connecting…" : "Connect to Infinite"}
              <ArrowUpRight size={18} />
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
    <div className={`app ${selected || creating ? "has-detail" : ""}`}>
      <aside className="sidebar">
        <Mark />
        <div className="workspace-label">
          <span>Personal workspace</span>
          <ShieldCheck size={15} />
        </div>
        <div className="rail-heading">
          <h2>
            Sessions <span>{sessions.length}</span>
          </h2>
          {me.role === "owner" && (
            <button
              className="icon-button"
              aria-label="New session"
              onClick={route.create}
            >
              <Plus size={20} />
            </button>
          )}
        </div>
        <SessionPicker sessions={sessions} selected={selected} loading={!host.seen && !host.failed} onSelect={route.navigate} />
        <div className="host-status">
          <div>
            {me.environment === "cloud" ? (
              <Cloud size={18} />
            ) : (
              <Laptop size={18} />
            )}
            <strong>
              {me.environment === "cloud"
                ? "Cloud execution host"
                : "Local rehearsal host"}
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
            await api("/logout", {});
            setMe(null);
            route.navigate(null);
            setSessions([]);
            drafts.clear();
            sessionViews.clear();
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
              onClick={() => route.navigate(null)}
              aria-label="Back to sessions"
            >
              <ArrowLeft size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {creating ? "New session" : selected ? "Session" : "Overview"}
            </strong>
          </div>
          <div className="refresh-status">
          <button className="text-button" onClick={host.refresh} disabled={host.refreshing}>
            <RefreshCw size={14} /> {host.refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <span className={`connection ${connected ? "" : "offline"}`}>
            <span className={`dot ${connected ? "running" : "unavailable"}`} />
            {connected ? "Up to date" : host.failed ? "Reconnecting" : host.seen ? "Refreshing" : "Connecting"}
          </span>
          </div>
        </header>
        {!connected && host.failed && (
          <div className="connection-notice" role="status">
            This device is offline or the host is unreachable. Work may still be
            running; controls are disabled until a fresh connection arrives.
          </div>
        )}
        {creating ? (
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
  const [provider, setProvider] = useState(
    me.providers.includes("demo") ? "demo" : me.providers[0],
  );
  const [projectId, setProjectId] = useState(me.projects[0]?.id);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<{
    requestId: string;
    provider: string;
    projectId: string;
    title: string;
    prompt: string;
  } | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    request.current ??= {
      requestId: crypto.randomUUID(),
      provider,
      projectId,
      title,
      prompt,
    };
    try {
      const session = await api<Session>("/sessions", request.current);
      done(session.id);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="create content">
      <h1>Start something.</h1>
      <p className="intro">Choose an agent and a workspace on your host.</p>
      <form onSubmit={submit}>
        <fieldset disabled={busy || Boolean(request.current)}>
          <label htmlFor="provider">Agent</label>
          <select
            id="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {me.providers.map((p) => (
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
        {error && (
          <p className="error" role="alert">
            {error} Retry will use the same creation request.
          </p>
        )}
        <button className="primary" disabled={busy || !connected}>
          {busy
            ? "Starting…"
            : request.current
              ? "Retry same request"
              : "Start session"}
          <ArrowUpRight size={18} />
        </button>
      </form>
    </div>
  );
}
function TerminalView({ id }: { id: string }) {
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
  const cached = useRef(sessionViews.get(id));
  const [session, setSession] = useState<Session | null>(cached.current?.session ?? null);
  const [text, setText] = useState(() => drafts.get(id)?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<LogEvent[]>(cached.current?.events ?? []);
  const pending = useRef<PendingInput | null>(drafts.get(id)?.pending ?? null);
  const [pendingInput, setPendingInput] = useState(() => Boolean(drafts.get(id)?.pending));
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
      const next = [...(sessionViews.get(id)?.events ?? []), ...page.events].slice(-100);
      setEvents(next);
      sessionViews.delete(id);
      sessionViews.set(id, { session: detail, events: next, cursor: page.cursor, seen: new Date().toISOString() });
      if (sessionViews.size > 20) sessionViews.delete(sessionViews.keys().next().value!);
    }
    return page.more ? 0 : 1100;
  }, 1100, id, () => control.forget(true));
  useEffect(() => { drafts.set(id, { text, pending: pending.current }); }, [id, text, pendingInput]);
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
    if (!canSteer || busy || sending.current || !text.trim()) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const retrying = pending.current !== null;
    // The live screen is shown here, so text may go into an open dialog, as on a terminal.
    pending.current ??= { requestId: crypto.randomUUID(), text, submit: true, force: true };
    setPendingInput(true);
    try {
      const receipt = await api<{ state: string }>(
        `/sessions/${id}/input`,
        pending.current,
        undefined,
        control.owned.current?.id,
      );
      if (receipt.state !== "delivered")
        throw new Error(
          "Delivery is uncertain. Check the terminal before sending anything else.",
        );
      setText("");
      pending.current = null;
      setPendingInput(false);
      setNotice(
        "Delivered to the terminal. Agent execution is not yet confirmed.",
      );
    } catch (e) {
      if (handleInputError(e)) {
        if (!retrying) {
          pending.current = null;
          setPendingInput(false);
        }
        setError(retrying ? `${(e as Error).message} This retry was refused. Earlier delivery remains unconfirmed; its request ID is kept.` :
          `${(e as Error).message} Your draft was not sent.`);
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
            {me.environment === "cloud" ? "Cloud" : "Local"} host <span>·</span>{" "}
            Started {time(session.createdAt)} <span>·</span>{" "}
            {session.pid ? `PID ${session.pid}` : "No live process"}
          </p>
          {session.execution && (
            <p className="session-meta">
              {connected && view.fresh ? "Tools: " : "Last received tools: "}{session.execution.location === "cloud" ? "Cloud" : "Laptop"} <span>·</span>{" "}
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
        {(["screen", "terminal", "context"] as const).map((t) => (
          <button
            role="tab"
            id={`view-${t}`}
            aria-controls="session-panel"
            tabIndex={tab === t ? 0 : -1}
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
            onKeyDown={event => {
              const views: SessionTab[] = ["screen", "terminal", "context"];
              const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!offset) return;
              event.preventDefault();
              const next = views[(views.indexOf(t) + offset + views.length) % views.length];
              setTab(next); document.getElementById(`view-${next}`)?.focus();
            }}
          >
            {t === "screen"
              ? "Catch up"
              : t === "terminal"
                ? "Full terminal"
                : "Context"}
          </button>
        ))}
        <span>{session.seq} recorded events</span>
      </div>
      <div className="session-body" id="session-panel" ref={body} role="tabpanel" aria-labelledby={`view-${tab}`} onScroll={() => {
        if (screen.current && body.current && screen.current.getBoundingClientRect().bottom > body.current.getBoundingClientRect().bottom + 1)
          setFollowing(false);
      }}>
        {tab === "terminal" ? (
          <TerminalView id={id} />
        ) : tab === "context" ? (
          <Context session={session} me={me} connected={connected && view.fresh} />
        ) : (
          <div className="catchup">
            {session.attention?.now && <div className="attention-summary"><strong>{sessionStatus(session)}</strong><p>{session.attention.now}</p></div>}
            <div className="section-label">
              <h2>Current screen</h2>
              <div className="screen-actions">
                <span>{view.fresh ? `Updated ${time(view.seen)}` : view.seen || cached.current?.seen ? `Saved view · ${time(view.seen || cached.current!.seen)}` : "Refreshing…"}</span>
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
        <div className="control-bar">
          <div>
            <strong>{requiresControl ? control.lease ? "You have control" : "Monitoring" : me.role === "viewer" ? "View only" : "Shared controls"}</strong>
            <span>{!view.fresh || !connected ? "Refreshing before input…" : session.status !== "running" ? "Process is not running" : requiresControl && !control.lease ? control.holder ? `${control.holder.label} has control` : "Draft now, take control to send" : "Ready for input"}</span>
          </div>
          <div className="control-actions">
            <button className="text-button" onClick={view.refresh} disabled={view.refreshing} aria-label="Refresh this session"><RefreshCw size={16} /></button>
            {requiresControl && me.role !== "viewer" && session.status === "running" && (
              control.lease ? <button className="text-button" onClick={async () => { await control.release(); view.refresh(); }}>Stop controlling</button> :
                <button className="primary" disabled={!connected || !view.fresh || control.busy} onClick={() => takeControl(Boolean(control.holder))}>
                  {control.busy ? "Updating…" : control.holder ? "Take over" : "Take control"}
                </button>
            )}
          </div>
        </div>
        {control.message && <p className="quiet control-message" role="status">{control.message}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="receipt" role="status">
            <Check size={14} />
            {notice}
          </p>
        )}
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
                aria-label={
                  busy ? "Sending message" : pendingInput ? "Retry same message" : "Send message"
                }
                disabled={!canSteer || busy || !text.trim()}
              >
                {busy ? <span>Sending…</span> : pendingInput ? <RefreshCw size={20} /> : <Send size={20} />}
              </button>
            </form>
            <div className="composer-footer">
              <span>{pendingInput ? "Unconfirmed delivery · retry keeps the same request ID" : text ? "Unsent draft · kept in this tab" : "⌘ / Ctrl + Enter to send · Enter for a new line"}</span>
              <div>
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
  const [context, setContext] = useState({ version: 0, text: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ version: number; text: string }>(
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
          A deliberate handoff between agents: goals, constraints, decisions,
          and relevant file paths. Saving does not rewrite running
          conversations.
        </p>
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
createRoot(document.getElementById("root")!).render(<App />);
