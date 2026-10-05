import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  ArrowLeft,
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
import { api, isControlRefusal, names, type ControlLease, type Me, type Session, type LogEvent } from "./api";
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
const foreground = () => document.visibilityState !== "hidden" && navigator.onLine;
const sessionStatus = (session: Session) => session.attention?.state === "needs-you"
  ? "Needs you" : session.attention?.state === "turn-finished" ? "Turn finished" : session.status;

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
  useEffect(() => {
    let active = true, polling = false, queued = false, generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    setFresh(false);
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
        if (current()) { setFresh(true); setSeen(new Date().toISOString()); }
      } catch {
        if (current()) { setFresh(false); unavailableRef.current?.(); }
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
  return { fresh, refreshing, seen, refresh: useCallback(() => refreshRef.current(), []) };
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
      setMessage("Monitoring. Take control again when you are ready to send input.");
      if (release) void releaseRequest(previous);
    }
  };
  const observe = (session: Session, revision: number) => {
    if (revision !== generation.current) return;
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
      setMessage(result.control ? "This device has control." : "Control was not granted. Refresh and try again.");
    } catch (error) {
      if (mounted.current && revision === generation.current) {
        forget();
        if (isControlRefusal(error) && error.control !== undefined) setHolder(error.control);
        setMessage((error as Error).message);
      }
    } finally { claiming.current = false; if (mounted.current) setBusy(false); }
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
  return { lease, holder, message, busy, claim, forget, observe, generation, owned };
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
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Me>("/me")
      .then(setMe)
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
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
        <p>Connecting to your host…</p>
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
              onClick={() => {
                setCreating(true);
                setSelected(null);
              }}
            >
              <Plus size={20} />
            </button>
          )}
        </div>
        <nav aria-label="Sessions" className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-row ${selected === session.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(session.id);
                setCreating(false);
              }}
            >
              <div className="row-top">
                <span className={`dot ${session.status}`} />
                <strong>{session.title}</strong>
                <ChevronRight size={16} />
              </div>
              <div className="row-meta">
                <span>{names[session.provider]}</span>
                <span>{sessionStatus(session)}</span>
              </div>
              <div className="row-meta session-id">
                {session.id.slice(0, 8)}
              </div>
            </button>
          ))}
          {!sessions.length && (
            <p className="rail-empty">
              No sessions yet.
              <br />
              Start one from your laptop.
            </p>
          )}
        </nav>
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
                <WifiOff size={13} /> Connection lost · cached view
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
            setSelected(null);
            drafts.clear();
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
              onClick={() => {
                setSelected(null);
                setCreating(false);
              }}
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
            {connected ? "Up to date" : "Reconnecting"}
          </span>
          </div>
        </header>
        {!connected && (
          <div className="connection-notice" role="status">
            This device is offline or the host is unreachable. Work may still be
            running; controls are disabled until a fresh connection arrives.
          </div>
        )}
        {creating ? (
          <Create
            me={me}
            done={(id) => {
              setSelected(id);
              setCreating(false);
            }}
            connected={connected}
          />
        ) : selected ? (
          <SessionView
            key={selected}
            id={selected}
            me={me}
            connected={connected}
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
                  onClick={() => setSelected(session.id)}
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
                  <button className="primary" onClick={() => setCreating(true)}>
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
}: {
  id: string;
  me: Me;
  connected: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<"screen" | "terminal" | "context">("screen");
  const [text, setText] = useState(() => drafts.get(id)?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<LogEvent[]>([]);
  const pending = useRef<PendingInput | null>(drafts.get(id)?.pending ?? null);
  const [pendingInput, setPendingInput] = useState(() => Boolean(drafts.get(id)?.pending));
  const cursor = useRef(0);
  const control = useSessionControl(id);
  const view = useLiveRefresh(async (current) => {
    const revision = control.generation.current;
    const [detail, page] = await Promise.all([
      api<Session>(`/sessions/${id}`),
      api<{ events: LogEvent[]; cursor: number; more: boolean }>(`/sessions/${id}/events?after=${cursor.current}`),
    ]);
    if (current()) {
      setSession(detail);
      control.observe(detail, revision);
      cursor.current = page.cursor;
      setEvents((old) => [...old, ...page.events.filter((event) => event.type !== "output")].slice(-100));
    }
    return page.more ? 0 : 1100;
  }, 1100, id, () => control.forget(true));
  useEffect(() => { drafts.set(id, { text, pending: pending.current }); }, [id, text, pendingInput]);
  const requiresControl = session?.capabilities?.inputControl === 1;
  const canSteer = connected && view.fresh && session?.status === "running" &&
    me.role !== "viewer" && (!requiresControl || Boolean(control.lease));
  async function takeControl(takeover = false) {
    if (!view.fresh || session?.status !== "running") return;
    await control.claim(takeover);
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
    if (!canSteer || busy) return;
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
        <p role="status">Loading this session…</p>
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
      <div className="control-bar" aria-live="polite">
        <div>
          <strong>{requiresControl ? control.lease ? "You have control" : "Monitoring" : me.role === "viewer" ? "Monitoring" : "Shared controls"}</strong>
          <span>{view.fresh ? `Updated ${time(view.seen)}` : "Reconnecting · cached view"}</span>
          {requiresControl && !control.lease && control.holder && <small>{control.holder.label} has control</small>}
        </div>
        <div className="control-actions">
          <button className="text-button" onClick={view.refresh} disabled={view.refreshing} aria-label="Refresh this session"><RefreshCw size={16} /></button>
          {requiresControl && me.role !== "viewer" && session.status === "running" && (
            control.lease ? <button className="text-button" onClick={() => { control.forget(true); view.refresh(); }}>Stop controlling</button> :
              <button className="primary" disabled={!view.fresh || control.busy} onClick={() => takeControl(Boolean(control.holder))}>
                {control.busy ? "Requesting…" : control.holder ? "Take over" : "Take control"}
              </button>
          )}
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Session views">
        {(["screen", "terminal", "context"] as const).map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
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
      <div className="session-body">
        {tab === "terminal" ? (
          <TerminalView id={id} />
        ) : tab === "context" ? (
          <Context session={session} me={me} connected={connected && view.fresh} />
        ) : (
          <div className="catchup">
            {session.attention?.now && <div className="attention-summary"><strong>{sessionStatus(session)}</strong><p>{session.attention.now}</p></div>}
            <div className="section-label">
              <h2>Current screen</h2>
              <span>{view.fresh ? `Updated ${time(view.seen)}` : "Last received · stale"}</span>
            </div>
            <pre className="screen">
              {session.screen ||
                (session.status === "running"
                  ? "Waiting for output…"
                  : "This process is no longer attached. Open Full terminal to replay its recording.")}
            </pre>
            <div className="section-label activity-label">
              <h2>Session activity</h2>
              <span>Latest 100 control events</span>
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
                rows={2}
                placeholder={
                  canSteer
                    ? "Give this session a direction…"
                    : "Draft here. Take control when you are ready to send…"
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy || pendingInput}
                maxLength={32000}
              />
              <button
                className="send-button"
                aria-label={
                  pendingInput ? "Retry same message" : "Send message"
                }
                disabled={!canSteer || busy || !text.trim()}
              >
                {pendingInput ? <RefreshCw size={20} /> : <Send size={20} />}
              </button>
            </form>
            <div className="composer-footer">
              <span>{pendingInput ? "Unconfirmed delivery · retry keeps the same request ID" : "Draft stays on this device until you send."}</span>
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
