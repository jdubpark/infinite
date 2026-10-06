import { useEffect, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { names, type Session } from "./api";

export type SessionTab = "screen" | "terminal" | "context";
type Location = { id: string | null; tab: SessionTab; creating: boolean };

function readLocation(): Location {
  const match = window.location.hash.match(/^#\/sessions\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:\/(screen|terminal|context))?$/i);
  return { id: match?.[1] ?? null, tab: (match?.[2] as SessionTab) ?? "screen", creating: window.location.hash === "#/new" };
}

// Only the route lives in the URL. Drafts, output and credentials never do.
export function useSessionLocation() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const update = () => setLocation(readLocation());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  function navigate(id: string | null, tab: SessionTab = "screen") {
    window.location.hash = id ? `/sessions/${id}/${tab}` : "/";
  }
  function selectTab(tab: SessionTab) {
    if (!location.id) return;
    history.replaceState(null, "", `#/sessions/${location.id}/${tab}`);
    setLocation(readLocation());
  }
  return { ...location, navigate, selectTab, create: () => { window.location.hash = "/new"; } };
}

export const sessionStatus = (session: Session) => session.attention?.state === "needs-you"
  ? "Needs you" : session.attention?.state === "turn-finished" ? "Turn finished" : session.status;

type Filter = "active" | "attention" | "all";
const active = (session: Session) => session.status === "running" || session.status === "starting";

export function SessionPicker({ sessions, selected, loading, onSelect }: {
  sessions: Session[]; selected: string | null; loading: boolean; onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const needsYou = (session: Session) => session.attention?.state === "needs-you";
  const matches = sessions.filter(session => {
    const inFilter = filter === "all" || (filter === "active" ? active(session) : needsYou(session));
    return inFilter && [session.title, session.id, session.projectId, session.provider, names[session.provider]]
      .some(value => value?.toLowerCase().includes(query.trim().toLowerCase()));
  }).sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || b.createdAt.localeCompare(a.createdAt));
  return <>
    <div className="session-search">
      <Search size={16} aria-hidden="true" />
      <input aria-label="Find a session" placeholder="Find a session…" type="search" value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setQuery(""); }} />
      {query && <button className="icon-button" aria-label="Clear session search" onClick={() => setQuery("")}><X size={15} /></button>}
    </div>
    <div className="session-filters" role="group" aria-label="Filter sessions">
      {(["active", "attention", "all"] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
        {value === "active" ? "Active" : value === "attention" ? "Needs you" : "All"}
        <span>{sessions.filter(value === "active" ? active : value === "attention" ? needsYou : () => true).length}</span>
      </button>)}
    </div>
    <nav aria-label="Sessions" className="session-list">
      {matches.map(session => <button key={session.id} aria-current={selected === session.id ? "page" : undefined}
        className={`session-row ${selected === session.id ? "selected" : ""}`} onClick={() => onSelect(session.id)}>
        <div className="row-top"><span className={`dot ${needsYou(session) ? "needs-you" : session.status}`} /><strong>{session.title}</strong><ChevronRight size={16} /></div>
        <div className="row-meta"><span>{names[session.provider]}</span><span>{sessionStatus(session)}</span></div>
        {session.attention?.now && <p className="row-preview">{session.attention.now}</p>}
        <div className="row-meta session-id">{session.id.slice(0, 8)}</div>
      </button>)}
      {!matches.length && <div className="rail-empty" role="status">
        {loading ? "Loading your sessions…" : query ? "No matching sessions in this view." : filter === "attention" ? "No sessions need your attention." : filter === "active" ? "No active sessions." : "Start a session from your laptop to see it here."}
        {!loading && filter !== "all" && <button className="text-button" onClick={() => setFilter("all")}>Show all sessions</button>}
      </div>}
    </nav>
  </>;
}
