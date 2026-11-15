import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, ChevronRight, Copy, RefreshCw, X } from "lucide-react";
import { ApiError, ago, useApi, type Me } from "./api";
import { useLiveRefresh } from "./live-refresh";
import { useMachines } from "./machines";
import { requestStore } from "./requests";

type Verdict = "allow" | "reject" | "owner";
type Tier = { tier: "light" | "strong"; profileId: string; family: string; startedAt: string; endedAt: string };
type Mark = { requestId: string; decisionId: string; at: string; by: string; label: "wrong"; note: string };
export type DecisionEntry = {
  id: string; at: string; workspaceId: string; workspaceName?: string; projectId: string; projectName?: string;
  taskId: string; assignment: string; sessionId: string; role?: string; provider: string; family?: string;
  evidenceHash: string; action: { tool: string; summary: string }; rules: string[]; tiers: Tier[];
  verdict: Verdict; code?: string; interruptClass?: string; note?: string; replayOf?: string; repeats?: string;
  raised: boolean; durationMs: number | null; rejectState?: "open" | "reopened" | "closed"; rateFlagged?: true;
  deliveries: { seq: number; at: string; kind: string; detail?: string }[]; marks: Mark[];
  controls: { kind: "reopen" | "close"; at: string; reason?: string }[];
};
type RateFlag = { sessionId: string; workspaceId: string; lastHour: number; baselineMedian: number; threshold: number };
type Rates = { decisions: number; byVerdict: Record<Verdict, number>; replays: number; medianDecisionMs: number | null };
type Status = { agent: string; workspaces: { workspaceId: string; name: string }[]; rates: { lastHour: Rates; lastDay: Rates } | null; rateFlags: RateFlag[] | null };
type Candidate = { decisionId: string; label: string; sources: string[]; decision: Omit<DecisionEntry, "note">; offeredAt: string };
type MarkRequest = { requestId: string; decisionId: string; label: "wrong"; note: string };
type Filters = { rejected: boolean; raised: boolean; workspace: string; since: "" | "1h" | "24h" | "7d" };

const markRequests = requestStore<MarkRequest, { at: string }>();
const inFlight = new Set<string>();
// Machines whose host refused a mark from this tab because the session is not an owner CLI. Their forms show the command.
const cliOnlyMachines = new Set<string>();
export function clearPermissionRequests(machine: string) { markRequests.clearMachine(machine); cliOnlyMachines.delete(machine); }
export const decisionLogAvailable = (me: Me) => me.role === "owner" && me.permissions?.decisionLog === 1;

const codeLabels: Record<string, string> = {
  "outside-workspace": "outside the workspace", unrelated: "not for the task", unsafe: "unsafe", incomplete: "incomplete evidence",
  uncertain: "uncertain", unavailable: "no reviewer in time", locked: "assignment locked", "needs-owner": "needs your answer", pending: "another call waits",
};
const classLabels: Record<string, string> = {
  "production-or-staging": "production or staging", credentials: "credentials", money: "money",
  "destructive-outside-workspace": "destructive outside the workspace", "global-or-account-settings": "global or account settings",
};
const deliveryLabels: Record<string, string> = { intent: "Delivery started", receipt: "Delivered", refusal: "Refused before sending", uncertain: "Delivery uncertain", stale: "Request had changed" };
const rejectStates: Record<string, string> = { open: "Open for its task", reopened: "Reopened by you", closed: "Closed with its task or direction" };
const spans: Record<Exclude<Filters["since"], "">, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const sessionLink = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
/** One shell word, so the owner can paste the command as it is. */
const shellWord = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function verdictWords(entry: Pick<DecisionEntry, "verdict" | "code" | "interruptClass">) {
  if (entry.verdict === "allow") return "Allowed";
  if (entry.verdict === "owner") return `Sent to you · ${classLabels[entry.interruptClass ?? ""] ?? entry.interruptClass ?? "owner"}`;
  return `Rejected · ${codeLabels[entry.code ?? ""] ?? entry.code ?? "no code"}`;
}
function VerdictState({ entry }: { entry: Pick<DecisionEntry, "verdict" | "code" | "interruptClass"> }) {
  return <span className={`permission-verdict ${entry.verdict}`}><span className="dot" />{verdictWords(entry)}</span>;
}

function logPath(filters: Filters, before?: string) {
  const params = new URLSearchParams();
  if (filters.rejected) params.set("rejected", "1");
  if (filters.raised) params.set("raised", "1");
  if (filters.workspace) params.set("workspace", filters.workspace);
  if (filters.since) params.set("since", new Date(Date.now() - spans[filters.since]).toISOString());
  if (before) params.set("before", before);
  const query = params.toString();
  return `/permissions/log${query ? `?${query}` : ""}`;
}

/** The rail beside the permission view: the decision log, newest first, with the owner's filters. */
export function PermissionPicker({ selected, onSelect, onOverview }: { selected: string | null; onSelect: (id: string) => void; onOverview: () => void }) {
  const api = useApi();
  const [filters, setFilters] = useState<Filters>({ rejected: false, raised: false, workspace: "", since: "" });
  const [entries, setEntries] = useState<DecisionEntry[] | null>(null);
  const [older, setOlder] = useState<DecisionEntry[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [workspaces, setWorkspaces] = useState<Status["workspaces"]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const identity = JSON.stringify(filters);
  useEffect(() => { setEntries(null); setOlder([]); setNext(undefined); }, [identity]);
  const view = useLiveRefresh(async current => {
    const page = await api<{ entries: DecisionEntry[]; next?: string }>(logPath(filters));
    if (current()) { setEntries(page.entries); setNext(previous => older.length ? previous : page.next); }
    return 15000;
  }, 15000, identity);
  useLiveRefresh(async current => {
    const status = await api<Status>("/permissions/status");
    if (current()) setWorkspaces(status.workspaces);
    return 60000;
  }, 60000, "permission-workspaces");
  async function showOlder() {
    if (!next || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api<{ entries: DecisionEntry[]; next?: string }>(logPath(filters, next));
      setOlder(previous => [...previous, ...page.entries]);
      setNext(page.next);
    } catch { /* The button stays; the next press retries the same page. */ }
    finally { setLoadingOlder(false); }
  }
  const seen = new Set<string>();
  const rows = [...(entries ?? []), ...older].filter(entry => !seen.has(entry.id) && Boolean(seen.add(entry.id)));
  const toggle = (key: "rejected" | "raised") => setFilters(previous => ({ ...previous, [key]: !previous[key] }));
  return <>
    <button className="text-button permission-overview-link" onClick={onOverview}><ArrowUpRight size={14} />Rates, flags and replay cases</button>
    <div className="session-filters" role="group" aria-label="Filter decisions">
      <button aria-pressed={!filters.rejected && !filters.raised} onClick={() => setFilters(previous => ({ ...previous, rejected: false, raised: false }))}>All</button>
      <button aria-pressed={filters.rejected} onClick={() => toggle("rejected")}>Rejected</button>
      <button aria-pressed={filters.raised} onClick={() => toggle("raised")}>Raised</button>
    </div>
    <div className="permission-filter-fields">
      <label className="sr-only" htmlFor="permission-workspace">Workspace</label>
      <select id="permission-workspace" value={filters.workspace} onChange={event => setFilters(previous => ({ ...previous, workspace: event.target.value }))}>
        <option value="">All workspaces</option>
        {workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.name}</option>)}
      </select>
      <label className="sr-only" htmlFor="permission-since">Time</label>
      <select id="permission-since" value={filters.since} onChange={event => setFilters(previous => ({ ...previous, since: event.target.value as Filters["since"] }))}>
        <option value="">Any time</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
      </select>
    </div>
    <nav className="session-list permission-picker" aria-label="Permission decisions">
      {rows.map(entry => <button key={entry.id} className={"session-row " + (selected === entry.id ? "selected" : "")} aria-current={selected === entry.id ? "page" : undefined} onClick={() => onSelect(entry.id)}>
        <div className="row-top"><span className={`dot permission-dot ${entry.verdict}`} /><strong className="permission-action">{entry.action.summary || entry.action.tool}</strong><ChevronRight size={16} /></div>
        <div className="row-meta"><span>{verdictWords(entry)}</span><span>{ago(entry.at)}</span></div>
        <div className="row-meta"><span>{entry.workspaceName ?? entry.workspaceId}</span><span>{[entry.marks.length ? "marked wrong" : "", entry.rateFlagged ? "above usual rate" : ""].filter(Boolean).join(" · ")}</span></div>
        <div className="row-meta session-id">{entry.id.slice(0, 8)}</div>
      </button>)}
      {next && entries && <button className="text-button permission-older" disabled={loadingOlder} aria-busy={loadingOlder} onClick={() => void showOlder()}>{loadingOlder && <RefreshCw className="is-refreshing" size={14} />}Show older decisions</button>}
      {!rows.length && <p className="rail-empty" role="status">{entries ? (filters.rejected || filters.raised || filters.workspace || filters.since ? "No decision matches these filters." : "The permission agent has recorded no decision yet.") : view.failed ? "The decision log is unavailable." : "Loading decisions…"}</p>}
    </nav>
  </>;
}

/** The permission view with no decision open: the rate figures, the flagged sessions and the replay candidates. */
export function PermissionOverview({ onSelect }: { onSelect: (id: string) => void }) {
  const api = useApi();
  const [status, setStatus] = useState<Status | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const view = useLiveRefresh(async current => {
    const [nextStatus, nextCandidates] = await Promise.all([
      api<Status>("/permissions/status"),
      api<{ candidates: Candidate[] }>("/permissions/candidates?limit=20"),
    ]);
    if (current()) { setStatus(nextStatus); setCandidates(nextCandidates.candidates); }
    return 30000;
  }, 30000, "permission-overview");
  const figure = (label: string, rates: Rates | undefined) => <div><dt>{label}</dt><dd>{rates ? rates.decisions : "—"}</dd>
    {rates && <small>{rates.byVerdict.allow} allowed · {rates.byVerdict.reject} rejected · {rates.byVerdict.owner} sent to you{rates.replays ? ` · ${rates.replays} replayed` : ""}</small>}</div>;
  return <div className="team-page permission-page">
    <div className="team-page-heading"><div><p className="team-eyebrow">Permission decisions</p><h1>What the permission agent decided.</h1>
      <p className="quiet">Every request it decides is recorded with its evidence, its reviewers and its delivery. Select a decision to read its record. Marking a decision wrong records your judgment; it changes no decision.</p></div></div>
    {status?.agent === "inactive" && <p className="team-notice" role="status">The permission agent is not active on this host yet. Requests are handled as before.</p>}
    <section className="team-section"><div className="team-section-heading"><h2>Decision rate</h2><span className="quiet" role="status">{view.stale ? "Showing last received figures" : view.fresh ? "Up to date" : view.failed ? "Figures unavailable" : "Loading…"}</span></div>
      <dl className="goal-budget">{figure("Last hour", status?.rates?.lastHour)}{figure("Last 24 hours", status?.rates?.lastDay)}</dl></section>
    <section className="team-section"><h2>Above the usual rate</h2>
      {status?.rateFlags?.length ? <ul className="permission-flags">{status.rateFlags.map(flag => <li key={flag.workspaceId + "/" + flag.sessionId}>
        <code>{flag.sessionId}</code><span>{flag.lastHour} decisions in the last hour · flagged above {flag.threshold}</span></li>)}</ul>
        : <p className="quiet">{status && status.rateFlags === null ? "The rate check is unavailable." : "No session is above its workspace’s usual rate."}</p>}
      <p className="form-note">A session is flagged when its decisions in the last hour exceed three times its workspace’s median session-hour over the previous seven days, and twenty. Nothing stops on the flag.</p></section>
    <section className="team-section"><div className="team-section-heading"><h2>Offered as replay cases</h2><span className="quiet">{candidates?.length ?? ""}</span></div>
      {candidates?.length ? candidates.map(candidate => <button key={candidate.decisionId} className="team-run-row" onClick={() => onSelect(candidate.decisionId)}>
        <div><strong className="permission-action">{candidate.decision.action.summary || candidate.decision.action.tool}</strong>
          <p>{verdictWords(candidate.decision)} · {candidate.sources.map(source => source === "reopened" ? "reopened" : "marked wrong").join(" and ")} · labelled {candidate.label}</p></div>
        <ArrowUpRight size={18} /></button>)
        : <p className="quiet">Decisions you mark wrong and rejects you reopen appear here. You accept or drop each one in the replay set; nothing is added without you.</p>}</section>
  </div>;
}

export function PermissionDetail({ id, me, openSession, onSelect }: { id: string; me: Me; openSession: (id: string) => void; onSelect: (id: string) => void }) {
  const api = useApi();
  const [entry, setEntry] = useState<DecisionEntry | null>(null);
  const [error, setError] = useState("");
  const view = useLiveRefresh(async current => {
    try { const result = await api<{ entry: DecisionEntry }>(`/permissions/decisions/${encodeURIComponent(id)}`); if (current()) { setEntry(result.entry); setError(""); } }
    catch (failure) { if (current()) setError(failure instanceof ApiError && failure.status === 404 ? "No decision has this id." : (failure as Error).message); throw failure; }
    return 15000;
  }, 15000, id);
  if (!entry) return <div className="team-page"><h1>Permission decision</h1><p role="status">{error || "Loading decision…"}</p>{error && <button className="text-button" onClick={view.refresh}><RefreshCw size={15} />Try again</button>}</div>;
  const workspace = entry.workspaceName ?? entry.workspaceId, project = entry.projectName ?? entry.projectId;
  // A single-project workspace carries the project's name, so the project is shown only when it adds something.
  const place = project === workspace ? workspace : `${workspace} · ${project}`;
  const requester = [entry.role, entry.provider, entry.family && `${entry.family} family`].filter(Boolean).join(" · ");
  return <div className="team-detail permission-detail">
    <header className="team-detail-heading"><div><p className="team-eyebrow">{place}</p><h1 className="permission-action">{entry.action.summary || entry.action.tool}</h1>
      <div className="team-detail-meta"><VerdictState entry={entry} /><span>{when(entry.at)}</span>{entry.rejectState && <span>{rejectStates[entry.rejectState]}</span>}<span className="team-freshness" role="status">{view.stale ? "Showing last received record." : ""}</span></div></div>
      <button className="text-button" disabled={view.refreshing} onClick={view.refresh} aria-busy={view.refreshing}><RefreshCw className={view.refreshing ? "is-refreshing" : ""} size={14} />Refresh decision</button></header>
    <div className="team-detail-body">
      {entry.rateFlagged && <p className="team-notice" role="status">This session is above its workspace’s usual decision rate. Nothing stops on it.</p>}
      <section className="team-section"><h2>Request</h2><dl className="team-output">
        <dt>Tool</dt><dd><code>{entry.action.tool}</code></dd>
        <dt>Action</dt><dd><code className="permission-code">{entry.action.summary}</code></dd>
        <dt>Session</dt><dd>{sessionLink.test(entry.sessionId) ? <button className="text-button permission-inline" onClick={() => openSession(entry.sessionId)}><code>{entry.sessionId.slice(0, 8)}</code><ArrowUpRight size={14} /></button> : <code>{entry.sessionId}</code>}{requester && <> · {requester}</>}</dd>
        <dt>Task</dt><dd><code>{entry.taskId}</code></dd>
        <dt>Assignment</dt><dd><code>{entry.assignment}</code></dd>
        <dt>Evidence</dt><dd><code>{entry.evidenceHash}</code></dd>
        <dt>Decision id</dt><dd><code>{entry.id}</code></dd>
      </dl></section>
      <section className="team-section"><h2>Decision</h2><dl className="team-output">
        <dt>Verdict</dt><dd>{verdictWords(entry)}</dd>
        <dt>Host rules</dt><dd>{entry.rules.length ? entry.rules.map(rule => <code key={rule} className="permission-rule">{rule}</code>) : "None matched"}</dd>
        <dt>Reviewers</dt><dd>{entry.tiers.length ? <ol className="permission-tiers">{entry.tiers.map((tier, index) => <li key={index}>{tier.tier === "strong" ? "Strong" : "Light"} · <code>{tier.profileId}</code> · {tier.family} · {seconds(Date.parse(tier.endedAt) - Date.parse(tier.startedAt))}</li>)}</ol> : entry.replayOf ? "No model turn: a recorded verdict was replayed" : "No model turn"}</dd>
        {entry.durationMs !== null && <><dt>Time to decide</dt><dd>{seconds(entry.durationMs)}</dd></>}
        {entry.replayOf && <><dt>Replays</dt><dd><button className="text-button permission-inline" onClick={() => onSelect(entry.replayOf!)}><code>{entry.replayOf}</code><ArrowUpRight size={14} /></button></dd></>}
        {entry.repeats && <><dt>Repeats</dt><dd><button className="text-button permission-inline" onClick={() => onSelect(entry.repeats!)}><code>{entry.repeats}</code><ArrowUpRight size={14} /></button></dd></>}
        {entry.controls.map((control, index) => <div key={index} className="permission-control"><dt>{control.kind === "reopen" ? "Reopened" : "Closed"}</dt><dd>{when(control.at)}{control.reason && ` · ${control.reason.replaceAll("-", " ")}`}</dd></div>)}
      </dl></section>
      <section className="team-section"><h2>Delivery</h2>{entry.deliveries.length ? <ol className="permission-deliveries">{entry.deliveries.map(event => <li key={event.seq}><time>{when(event.at)}</time><span>{deliveryLabels[event.kind] ?? event.kind}{event.detail && ` · ${event.detail}`}</span></li>)}</ol> : <p className="quiet">No delivery event is recorded.</p>}</section>
      {entry.note && <section className="team-section"><h2>Reviewer note</h2><p className="form-note">Only you see this note. No agent receives it.</p><p className="team-prose">{entry.note}</p></section>}
      <section className="team-section"><div className="team-section-heading"><h2>Your marks</h2><span className="quiet">{entry.marks.length || ""}</span></div>
        {entry.marks.map(mark => <div className="team-record" key={mark.requestId}><small>Marked {mark.label} · {when(mark.at)}</small><p className="team-prose">{mark.note}</p></div>)}
        {me.role === "owner" && <MarkForm key={entry.id} entry={entry} marked={view.refresh} />}</section>
    </div>
  </div>;
}

function MarkForm({ entry, marked }: { entry: DecisionEntry; marked: () => void }) {
  const api = useApi(), machines = useMachines(), key = machines.active.id + "/" + entry.id;
  const request = markRequests.use(key), pending = request.pending;
  const [note, setNote] = useState(pending?.note ?? "");
  // A browser session signed in on the host's own origin is not an owner CLI, so the host refuses its marks with 403.
  const [cliOnly, setCliOnly] = useState(cliOnlyMachines.has(machines.active.id));
  const [busy, setBusy] = useState(false), [copied, setCopied] = useState(false), [open, setOpen] = useState(Boolean(pending));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const command = `infinite permissions mark ${shellWord(entry.id)} --wrong --note ${shellWord(note.trim() || "WHY IT WAS WRONG")}`;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || cliOnly || (!pending && !note.trim())) return;
    const body = pending ?? markRequests.begin(key, { requestId: crypto.randomUUID(), decisionId: entry.id, label: "wrong", note: note.trim() });
    if (inFlight.has(body.requestId)) return;
    inFlight.add(body.requestId); setBusy(true);
    try {
      const result = await api<{ mark: Mark }>("/permissions/marks", body);
      if (markRequests.complete(key, body.requestId, { at: result.mark.at }, "Mark recorded. It changes no decision.") && mounted.current) { setNote(""); marked(); }
    } catch (failure) {
      const status = failure instanceof ApiError ? failure.status : 0;
      if (status === 403) { markRequests.fail(key, body.requestId, "", true); cliOnlyMachines.add(machines.active.id); if (mounted.current) setCliOnly(true); }
      else markRequests.fail(key, body.requestId, (failure as Error).message + (status >= 400 && status < 500 ? "" : " Delivery is unconfirmed. Retry keeps the same request."), status >= 400 && status < 500);
    } finally { inFlight.delete(body.requestId); if (mounted.current) setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => mounted.current && setCopied(false), 2000); }
    catch { setCopied(false); }
  }
  return <details className="goal-outcome-form permission-mark" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>Mark this decision wrong</summary>
    <form onSubmit={submit}><fieldset disabled={busy || Boolean(pending)}>
      <label htmlFor="permission-mark-note">Why was it wrong?</label>
      <textarea id="permission-mark-note" rows={3} maxLength={2000} required value={pending?.note ?? note} onChange={event => setNote(event.target.value)} placeholder="What the decision should have been, and why…" />
    </fieldset>
      <p className="form-note">A mark is a record only. It changes no decision, no replay and no lock. To change later decisions, reopen the reject or change the workspace’s direction. The decision is offered as a replay case that you accept or drop.</p>
      {cliOnly ? <div className="permission-cli"><p className="form-note">The host records marks only from the paired owner CLI, and this browser session is not one. Run this command on a paired machine:</p>
        <pre className="permission-command"><code>{command}</code></pre>
        <button type="button" className="text-button" onClick={() => void copy()}><Copy size={14} />{copied ? "Copied" : "Copy command"}</button></div>
        : <button className="primary stable-action" aria-busy={busy} disabled={busy || (!pending && !note.trim())}>{busy && <RefreshCw className="is-refreshing" size={16} />}{pending ? "Retry same request" : "Mark wrong"}<ArrowUpRight size={18} /></button>}
      {!busy && request.message && <p className={request.result ? "form-note" : "error"} role={request.result ? "status" : "alert"}>{request.message}{request.result && <button type="button" className="team-notice-dismiss" aria-label="Dismiss notice" onClick={() => markRequests.clear(key)}><X size={15} /></button>}</p>}
    </form></details>;
}
