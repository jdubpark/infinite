import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Check, ChevronRight, GitBranch, Plus, RefreshCw, Send, Users } from "lucide-react";
import { ApiError, ago, clock, names, useApi, type LimitSwitch, type LogEvent, type ProviderLimit, type Me, type Session, type TeamLineup, type TeamModelProfile, type TeamBrief, type TeamEvidence, type LinearTrackingView, type TeamUsage, type UsageTotals } from "./api";
import { SpendBlock, UsageFigure, UsageRollup, usageEnabled } from "./usage";
import { briefText, chooseBrief, monitorMembers, summarySessionId, type BriefingView } from "./team-monitor";
import { useMachines } from "./machines";
import { useLiveRefresh } from "./live-refresh";
import { requestStore } from "./requests";
import { LinearTracking } from "./linear";

type TeamStatus = "planning" | "discovering" | "implementing" | "integrating" | "verifying" | "reviewing" | "delivering" | "merged" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-change" | "cancelled";
type TeamRole = "project-manager" | "scout" | "implementer" | "integrator" | "reviewer" | "delivery";
type TeamCommand = { command: string; args: string[] };
type TeamTask = { id: string; title: string; instructions: string; paths: string[]; dependsOn: string[]; status: "pending" | "running" | "waiting" | "integrated" | "blocked"; memberId?: string; commit?: string; summary?: string; agentProfileId?: string; escalation?: { fromProfileId?: string; toProfileId: string; reason: string; memberId: string; at: string }; limitSwitches?: LimitSwitch[] };
type TeamScout = { id: string; title: string; instructions: string; agentProfileId: string; status: "pending" | "running" | "waiting" | "complete"; memberId?: string; summary?: string; evidence?: TeamEvidence[] };
type TeamMember = { memberId: string; sessionId: string; role: TeamRole; revision: number; title: string; status: string; taskId?: string; cwd: string; baseCommit: string; provider?: string; modelProfile?: TeamModelProfile; usage?: UsageTotals; stoppedReason?: string };
type TeamDecision = { id: string; memberId: string; revision: number; question: string; options: string[]; createdAt: string; answer?: string; answeredAt?: string };
export type TeamView = {
  id: string; projectId: string; provider: string; title: string; objective: string; parallelism: number;
  revision: number; status: TeamStatus; createdAt: string; updatedAt: string; workspace: string;
  branch: string; baseCommit: string; headCommit?: string; tasks: TeamTask[]; members: TeamMember[];
  decisions: TeamDecision[]; checks: { command: TeamCommand; status: "running" | "passed" | "failed" | "interrupted"; startedAt: string; finishedAt?: string; exitCode?: number | null; output: string; revision: number }[];
  steering: { text: string; revision: number; at: string }[]; events: { at: string; text: string }[];
  reason?: string; review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string }; round: number;
  deliveryReceipt?: { pullRequestUrl: string; headCommit: string; mergeCommit: string; summary: string };
  lineup?: TeamLineup;
  providerLimits?: ProviderLimit[];
  usage?: TeamUsage;
  linear?: LinearTrackingView;
  goal?: { id: string; revision: number; cycle: number; successCriteria: string; nonGoals: string[]; allowedPaths: string[]; evidence: string[]; previousWork: string[]; deadlineAt: string; maxMembers: number; parentRunId?: string };
  brief?: TeamBrief;
  discovery?: { revision: number; summary: string; tasks: TeamScout[]; completedAt?: string };
  noChange?: { summary: string; evidence: TeamEvidence[] };
  stopReason?: "deadline" | "member-limit";
  resumable?: boolean;
};
type CreateRequest = { requestId: string; projectId: string; provider: string; title: string; objective: string; parallelism: number; useConfiguredLineup?: boolean };
type MutationRequest = { requestId: string; revision: number; text?: string; path: string; label: string };
const creations = requestStore<CreateRequest, { id: string }>();
const mutations = requestStore<MutationRequest, { id: string }>();
const inFlight = new Set<string>();
export function clearTeamRequests(machine: string) { creations.clearMachine(machine); mutations.clearMachine(machine); }
const rejected = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500;
const labels: Record<TeamStatus, string> = { planning: "Planning", discovering: "Investigating", implementing: "Implementing", integrating: "Integrating", verifying: "Running checks", reviewing: "Reviewing", delivering: "Delivering", merged: "Merge reported", "needs-input": "Needs your input", paused: "Paused", blocked: "Blocked", "ready-for-review": "Ready for your review", "no-change": "No change proposed", cancelled: "Cancelled" };
const roles: Record<TeamRole, { name: string; description: string }> = {
  "project-manager": { name: "Coordinator", description: "Plans tasks, assigns implementers, and asks for decisions." },
  scout: { name: "Scout", description: "Investigates the project and reports evidence before implementation." },
  implementer: { name: "Implementers", description: "Build independent tasks in separate workspaces." },
  integrator: { name: "Integrator", description: "Repairs failed checks and review findings." },
  delivery: { name: "Delivery", description: "Publishes and merges reviewed changes under the repository policy." },
  reviewer: { name: "Reviewer", description: "Reviews the result against your request." },
};
const date = (value: string) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const statusClass = (status: TeamStatus) => ["needs-input", "blocked", "paused"].includes(status) ? "waiting" : ["ready-for-review", "merged"].includes(status) ? "ready" : ["cancelled", "no-change"].includes(status) ? "inactive" : "";
function Status({ status }: { status: TeamStatus }) { return <span className={"team-status " + statusClass(status)}><span className="dot" />{labels[status]}</span>; }
function RoleGuide() { return <div className="team-roles" aria-label="Team responsibilities">{Object.entries(roles).map(([id, role]) => <div key={id}><strong>{role.name}</strong><p>{role.description}</p></div>)}</div>; }
const leadLabel = (team: TeamView) => team.lineup ? "Coordinator: " + team.lineup.coordinator.label : names[team.provider] ?? team.provider;
export function profileSetting(profile: TeamModelProfile) { return profile.provider === "opencode" ? profile.variant ? "variant: " + profile.variant : "provider default variant" : "effort: " + profile.effort; }
export function ModelProfile({ profile }: { profile: TeamModelProfile }) {
  return <span className="team-model-profile"><strong>{profile.label}{profile.tier && <span className="team-profile-tier">{profile.tier}</span>}</strong><span>Requested: {names[profile.provider] ?? profile.provider} · <code>{profile.model}</code> · {profileSetting(profile)}</span>{profile.limitFallback && <span>On a usage limit: <code>{profile.limitFallback}</code></span>}{profile.dataUse === "contributor" && <span className="team-data-use">Contributor data use is enabled for this profile. Its provider’s contributor terms apply.</span>}</span>;
}
/** Shown while the host remembers a provider at its limit. Reset times are the provider's own statement. */
export function ProviderLimitNotice({ limits }: { limits?: ProviderLimit[] }) {
  const now = Date.now(), active = (limits ?? []).filter(limit => Date.parse(limit.expiresAt) > now);
  if (!active.length) return null;
  return <div className="team-notice" role="status">{active.map(limit => {
    const provider = names[limit.provider] ?? limit.provider;
    return <p key={limit.provider}>{provider} limited since {clock(limit.detectedAt)} · {limit.resetsAt ? <>resets {clock(limit.resetsAt)} <span className="quiet">(provider’s stated time)</span></> : <>until {clock(limit.expiresAt)}</>} · new {provider} members launch on their fallback</p>;
  })}</div>;
}
export function Lineup({ lineup }: { lineup: TeamLineup }) {
  return <dl className="team-lineup">
    <div><dt>Coordinator</dt><dd><ModelProfile profile={lineup.coordinator} /></dd></div>
    <div><dt>Implementer pool</dt><dd>{lineup.implementers.map(profile => <ModelProfile key={profile.id} profile={profile} />)}</dd></div>
    <div><dt>Integrator</dt><dd><ModelProfile profile={lineup.integrator} /></dd></div>
    <div><dt>Reviewer</dt><dd><ModelProfile profile={lineup.reviewer} /></dd></div>
    {lineup.escalations?.length ? <div><dt>Escalation pool</dt><dd>{lineup.escalations.map(profile => <ModelProfile key={profile.id} profile={profile} />)}</dd></div> : null}
    {lineup.fallbacks?.length ? <div><dt>Limit fallbacks</dt><dd>{lineup.fallbacks.map(profile => <ModelProfile key={profile.id} profile={profile} />)}</dd></div> : null}
  </dl>;
}
export function EvidenceSource({ source }: { source: string }) {
  let url: URL | undefined;
  try { const candidate = new URL(source); if (["https:", "http:"].includes(candidate.protocol) && !candidate.username && !candidate.password) url = candidate; } catch { /* Notes and repository paths stay as text. */ }
  return url ? <a href={url.href} target="_blank" rel="noopener noreferrer">{source}</a> : <span>{source}</span>;
}
export function EvidenceList({ evidence }: { evidence: TeamEvidence[] }) {
  return <ul className="team-evidence">{evidence.map((item, index) => <li key={index}><EvidenceSource source={item.source} /><p>{item.observation}</p></li>)}</ul>;
}
export function TeamBriefView({ brief }: { brief: TeamBrief }) {
  return <article className="team-brief"><h3>{brief.title}</h3><p className="team-prose">{brief.problem}</p><h4>Evidence behind this proposal</h4><EvidenceList evidence={brief.evidence} /><h4>Acceptance criteria</h4><ul>{brief.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul><h4>Expected outcome</h4><p className="team-prose">{brief.expectedOutcome}</p><details><summary>Data and interface scope</summary><p className="team-prose">{brief.dataShape}</p><p className="quiet">{brief.uiChanges ? "Includes interface changes; reviewer UI evidence is required." : "No interface changes proposed."}</p></details></article>;
}
function TaskModel({ task, team }: { task: TeamTask; team: TeamView }) {
  const member = team.members.find(value => value.memberId === task.memberId);
  const profile = member?.modelProfile ?? [...(team.lineup?.implementers ?? []), ...(team.lineup?.escalations ?? [])].find(value => value.id === task.agentProfileId);
  return <div className="team-task-model"><span>Assigned agent</span>{profile ? <ModelProfile profile={profile} /> : <span>{task.agentProfileId ? "Profile " + task.agentProfileId + " · model details unavailable" : team.lineup ? "Model assignment pending" : names[member?.provider ?? team.provider] ?? member?.provider ?? team.provider}</span>}</div>;
}
function SetupNotice({ me }: { me: Me }) {
  if (!me.teams?.enabled) return <div className="team-notice" role="status"><strong>Teams need host setup.</strong><p>Enable teams in the host configuration, then configure a workspace with its required checks. The host runs those checks before a team can be ready for review.</p></div>;
  if (!me.projects.some(project => (project.team?.checks.length || project.team?.establishChecks))) return <div className="team-notice" role="status"><strong>No workspace is ready for a team.</strong><p>Add required team checks to a workspace in the host configuration. Add a setup command if its isolated workspace needs dependencies.</p></div>;
  return null;
}

export function TeamPicker({ teams, selected, loading, onSelect }: { teams: TeamView[]; selected: string | null; loading: boolean; onSelect: (id: string) => void }) {
  return <nav className="session-list team-picker" aria-label="Agent teams">
    {teams.map(team => <button className={"session-row " + (selected === team.id ? "selected" : "")} key={team.id} onClick={() => onSelect(team.id)} aria-current={selected === team.id ? "page" : undefined}>
      <div className="row-top"><Users size={15} /><strong>{team.title}</strong><ChevronRight size={16} /></div>
      <div className="row-meta"><span>{leadLabel(team)}</span><span>{labels[team.status]}</span></div>
      <div className="row-meta session-id">Revision {team.revision} · {team.id.slice(0, 8)}</div>
    </button>)}
    {!teams.length && <p className="rail-empty" role="status">{loading ? "Loading teams…" : "Your team runs will appear here."}</p>}
  </nav>;
}

export function TeamList({ teams, me, fresh, loading, failed, seen, onCreate, onSelect, refresh }: {
  teams: TeamView[]; me: Me; fresh: boolean; loading: boolean; failed: boolean; seen: string;
  onCreate: () => void; onSelect: (id: string) => void; refresh: () => void;
}) {
  return <div className="team-page team-list-page">
    <div className="team-page-heading"><div><p className="team-eyebrow">Agent teams</p><h1>Give your team an outcome.</h1><p className="quiet">Describe a feature or paste a PRD. Follow the work, answer decisions, and steer as it develops.</p></div>{me.role === "owner" && <button className="primary" onClick={onCreate}>New team <Plus size={18} /></button>}</div>
    <RoleGuide />
    <SetupNotice me={me} />
    <ProviderLimitNotice limits={me.providerLimits} />
    <SpendBlock me={me} />
    <div className="team-section-heading"><h2>Team runs <span className="quiet">{teams.length}</span></h2><span className="quiet">{!me.teams ? "Unavailable on this host" : fresh ? "Up to date" : failed ? "Team updates unavailable" : loading ? "Loading…" : "Checking…"}{seen && " · checked " + ago(seen)}</span></div>
    {failed && <p className="team-notice" role="status">The host could not refresh team runs. Showing the last received state. <button className="text-button" onClick={refresh}>Try again</button></p>}
    {teams.map(team => <button className="team-run-row" key={team.id} onClick={() => onSelect(team.id)}><div><strong>{team.title}</strong><p>{me.projects.find(project => project.id === team.projectId)?.name ?? team.projectId} · {leadLabel(team)} · {date(team.createdAt)}</p>{team.lineup && <p className="team-run-model">Requested coordinator: <code>{team.lineup.coordinator.model}</code> · {profileSetting(team.lineup.coordinator)}</p>}</div><Status status={team.status} /><ArrowUpRight size={18} /></button>)}
    {!teams.length && !loading && !failed && <div className="team-empty"><Users size={32} strokeWidth={1.4} /><h2>No team runs yet.</h2><p>A coordinator will plan the work, then dispatch independent tasks to implementers.</p>{me.role !== "owner" && <p>An owner can start a team on this host.</p>}</div>}
  </div>;
}

export function TeamCreate({ me, connected, done }: { me: Me; connected: boolean; done: (id: string) => void }) {
  const api = useApi();
  const machine = useMachines().active.id;
  const creation = creations.use(machine);
  const pending = creation.pending;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const configuredProviders = me.backendProviders?.infinite ?? me.providers;
  const providers = configuredProviders.includes("claude") ? ["claude", ...configuredProviders.filter(value => value !== "claude")] : configuredProviders;
  const lineup = me.teams?.lineup;
  const [useConfiguredLineup, setUseConfiguredLineup] = useState(pending ? pending.useConfiguredLineup === true : Boolean(lineup));
  const [provider, setProvider] = useState(pending?.provider ?? providers.find(value => value !== "demo") ?? providers[0] ?? "");
  const [projectId, setProjectId] = useState(pending?.projectId ?? me.projects.find(project => (project.team?.checks.length || project.team?.establishChecks))?.id ?? me.projects[0]?.id ?? "");
  const [title, setTitle] = useState(pending?.title ?? "");
  const [objective, setObjective] = useState(pending?.objective ?? "");
  const [parallelism, setParallelism] = useState(pending?.parallelism ?? 2);
  const [busy, setBusy] = useState(false);
  const project = me.projects.find(value => value.id === projectId);
  const configured = Boolean(me.teams?.enabled && (project?.team?.checks.length || project?.team?.establishChecks));
  const maxParallelism = Math.max(1, Math.min(4, me.teams?.maxParallelism ?? 4));
  const selectedProvider = useConfiguredLineup ? lineup?.coordinator.provider : provider;
  const allowed = connected && me.role === "owner" && (Boolean(pending) || (configured && Boolean(selectedProvider)));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !allowed || (!pending && !objective.trim())) return;
    const request = pending ?? creations.begin(machine, { requestId: crypto.randomUUID(), projectId, provider: selectedProvider!, useConfiguredLineup, title: title.trim() || objective.trim().split("\n")[0].slice(0, 100), objective: objective.trim(), parallelism: Math.min(parallelism, maxParallelism) });
    if (inFlight.has(request.requestId)) return;
    inFlight.add(request.requestId); setBusy(true);
    try {
      const team = await api<TeamView>("/teams", request);
      if (creations.complete(machine, request.requestId, { id: team.id }) && mounted.current) done(team.id);
    } catch (error) { creations.fail(machine, request.requestId, (error as Error).message, rejected(error)); }
    finally { inFlight.delete(request.requestId); if (mounted.current) setBusy(false); }
  }
  return <div className="team-page team-create">
    <p className="team-eyebrow">New team</p><h1>What should we build?</h1><p className="quiet">A few sentences or a full PRD are enough to start. Your team will ask when it needs a decision.</p>
    <SetupNotice me={me} />
    {me.role !== "owner" && <p className="team-notice">An owner key is required to start a team.</p>}
    {creation.result && <p role="status">Team started. <button className="text-button" onClick={() => done(creation.result!.id)}>Open team</button></p>}
    <form onSubmit={submit}>
      <fieldset disabled={busy || Boolean(pending) || me.role !== "owner"}>
        <label htmlFor="team-objective">Feature request or PRD</label><textarea id="team-objective" rows={8} required maxLength={24000} value={objective} onChange={event => setObjective(event.target.value)} placeholder="Describe the outcome, who it is for, and what should happen…" />
        <label htmlFor="team-title">Team name <span className="quiet">(optional)</span></label><input id="team-title" maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="Uses the first line of your request" />
        <div className="team-form-grid">
          <div><label htmlFor="team-project">Workspace</label><select id="team-project" value={projectId} onChange={event => setProjectId(event.target.value)}>{me.projects.map(value => <option key={value.id} value={value.id}>{value.name}{(value.team?.checks.length || value.team?.establishChecks) ? "" : " · setup required"}</option>)}</select></div>
          <div>{lineup || useConfiguredLineup ? <><label htmlFor="team-agent-setup">Agent setup</label><select id="team-agent-setup" value={useConfiguredLineup ? "configured" : "single"} onChange={event => setUseConfiguredLineup(event.target.value === "configured")}><option value="configured" disabled={!lineup}>Configured lineup</option><option value="single">Single provider</option></select></> : <><label htmlFor="team-provider">Agent provider</label><select id="team-provider" value={provider} onChange={event => setProvider(event.target.value)}>{providers.map(value => <option key={value} value={value}>{names[value] ?? value}</option>)}</select></>}</div>
        </div>
        {lineup && !useConfiguredLineup && <><label htmlFor="team-provider">Agent provider</label><select id="team-provider" value={provider} onChange={event => setProvider(event.target.value)}>{providers.map(value => <option key={value} value={value}>{names[value] ?? value}</option>)}</select><p className="form-note">All roles use this provider with its host settings.</p></>}
        {useConfiguredLineup && <div className="team-lineup-preview"><h2>Configured lineup</h2><p className="quiet">The coordinator assigns each task to a profile from this implementer pool. These are requested model settings; provider policy may override them.</p>{lineup ? <Lineup lineup={lineup} /> : <p className="team-notice">The host’s current lineup is unavailable. Retrying will preserve the original creation request.</p>}</div>}
        <label htmlFor="team-parallelism">Parallel implementers</label><select id="team-parallelism" value={Math.min(parallelism, maxParallelism)} onChange={event => setParallelism(Number(event.target.value))}>{Array.from({ length: maxParallelism }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} {value === 1 ? "implementer" : "implementers"}</option>)}</select>
      </fieldset>
      {me.teams?.enabled && !(project?.team?.checks.length || project?.team?.establishChecks) && <p className="team-notice">This workspace needs required team checks in the host configuration.</p>}
      {project?.linear?.enabled && <p className="form-note">This workspace tracks team work in Linear. Starting the team creates an issue; its workflow state remains under your control.</p>}
      {project?.team && <details className="team-check-config"><summary>Required workspace checks</summary>{project.team.establishChecks && <p className="quiet">The coordinator will define build and test commands before implementation. The host must run them successfully before review.</p>}<ul>{project.team.checks.map((check, index) => <li key={index}><code>{[check.command, ...check.args].join(" ")}</code></li>)}</ul>{project.team.setup && <p className="quiet">Workspace setup: <code>{[project.team.setup.command, ...project.team.setup.args].join(" ")}</code></p>}</details>}
      <p className="form-note">Work runs on the selected host in isolated workspaces. The team uses the provider permissions already configured there. A refused tool can stop a member; inspect its session before continuing.</p>
      {!useConfiguredLineup && provider === "demo" && <p className="team-notice">Rehearsal uses a local test process. It does not call an AI model or implement a real feature.</p>}
      {creation.message && <p className="error" role="alert">{creation.message}{pending && " Delivery is unconfirmed. Retry keeps the same creation request."}</p>}
      <button className="primary" disabled={busy || !allowed || (!pending && !objective.trim())}>{busy ? "Starting team…" : pending ? "Retry same request" : "Start team"}<ArrowUpRight size={18} /></button>
    </form>
    <RoleGuide />
  </div>;
}

function eventLabel(event: LogEvent) {
  if (event.type === "signal") return String(event.data.kind ?? "Signal");
  if (event.type === "input-result") return event.data.state === "delivered" ? "Input delivered" : "Input";
  if (event.type === "lifecycle") return String(event.data.status ?? "Session updated");
  return event.type;
}
function eventDetail(event: LogEvent) {
  const value = event.data.message ?? event.data.text ?? event.data.error;
  return typeof value === "string" ? value : "";
}
function JevcodeSummary({ team, rows, failed, asking, error, onRequest }: {
  team: TeamView; rows: { sessionId: string; status: BriefingView }[]; failed: boolean; asking: boolean; error: string;
  onRequest: (sessionId: string) => void;
}) {
  const coordinatorId = summarySessionId(team.members, team.revision);
  const chosen = chooseBrief(rows, coordinatorId);
  const member = team.members.find(item => item.sessionId === chosen?.sessionId);
  const brief = chosen?.status.summary?.repository?.brief;
  const text = briefText(chosen?.status);
  const when = chosen?.status.summary?.repository?.generatedAt ?? chosen?.status.summary?.at;
  const updating = chosen?.status.state === "pending" || chosen?.status.state === "running";
  const canAsk = !text && (chosen?.status.state === "empty" || chosen?.status.state === "failed");
  const age = when ? ago(when) : "";
  return <section className="team-section team-summary" aria-live="polite">
    <div className="team-section-heading"><h2>Jevcode summary</h2><span className="quiet">{[brief || chosen?.status.summary?.engine === "jevcode" ? "Jevcode" : "Session summary", member ? roles[member.role].name : "", when ? date(when) : "", age].filter(Boolean).join(" · ")}</span></div>
    {!text && <p className="quiet">{failed ? "The Jevcode summary could not be loaded." : !rows.length ? (team.members.length ? "Loading the Jevcode summary…" : "No agent session is available for a Jevcode summary.") : updating ? "Jevcode is writing the summary." : chosen?.status.error || "No Jevcode summary yet."}</p>}
    {text && <>
      {updating && <p className="quiet">Jevcode is updating this summary.</p>}
      <p className="team-summary-lead">{brief?.summary ?? text}</p>
      {brief?.architecture?.length ? <details className="team-summary-fold"><summary>System shape <span className="quiet">{brief.architecture.length}</span></summary><ul className="team-summary-list">{brief.architecture.map((item, index) => <li key={index}>{item.text}</li>)}</ul></details> : null}
      {brief?.review?.length ? <><h3>Review first <span className="quiet">{brief.review.length}</span></h3><ol className="team-review-list">{brief.review.map((item, index) => <li key={index}>
        <div className="team-review-head"><span className="team-review-rank">{index + 1}</span>{item.priority && <span className={"team-review-priority " + item.priority}>{item.priority}</span>}<strong>{item.area}</strong></div>
        {item.why && <p>{item.why}</p>}
        {item.question && <p className="team-review-question">Ask: {item.question}</p>}
      </li>)}</ol></> : null}
      {brief?.changes?.length ? <><h3>What changed <span className="quiet">{brief.changes.length}</span></h3><ul className="team-summary-list">{brief.changes.map((item, index) => <li key={index}>{item.text}</li>)}</ul></> : null}
      {brief?.checks?.length ? <><h3>Check evidence <span className="quiet">{brief.checks.length}</span></h3><ul className="team-summary-list">{brief.checks.map((item, index) => <li key={index}>{item.text}</li>)}</ul></> : null}
      {brief?.guidance?.length ? <details className="team-summary-fold"><summary>Guidance for agents <span className="quiet">{brief.guidance.length}</span></summary><ul className="team-summary-list">{brief.guidance.map((item, index) => <li key={index}>{[item.basis, item.text].filter(Boolean).join(": ")}</li>)}</ul></details> : null}
      {brief?.unknowns?.length ? <><h3>Gaps and unknowns <span className="quiet">{brief.unknowns.length}</span></h3><ul className="team-summary-list">{brief.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></> : null}
      <p className="quiet">This is the Jevcode agent’s reading of recorded activity and the repository. It is not completion or approval.</p>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {canAsk && coordinatorId && <button className="text-button" disabled={asking} onClick={() => onRequest(chosen?.sessionId ?? coordinatorId)}>{asking ? "Asking Jevcode… this can take a few minutes" : "Ask Jevcode for a summary"}</button>}
  </section>;
}
function TeamLogs({ member, session, events, failed, follow, setFollow, onOpen }: {
  member: TeamMember; session: Session | null; events: LogEvent[]; failed: boolean; follow: boolean; setFollow: (value: boolean) => void; onOpen: () => void;
}) {
  const screenRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const node = screenRef.current;
    if (follow && node) node.scrollTop = node.scrollHeight;
  }, [session?.screen, follow]);
  return <section className="team-section team-logs">
    <div className="team-section-heading"><h2>{roles[member.role].name}</h2><button className="text-button" onClick={onOpen}>Open session <ArrowUpRight size={16} /></button></div>
    <p className="quiet">{member.title} · {member.status}{member.revision ? ` · revision ${member.revision}` : ""}{session?.attention?.now ? ` · ${session.attention.now}` : ""}</p>
    {failed && <p className="team-notice" role="status">This agent’s log could not be refreshed.</p>}
    <div className="screen-actions"><span>{session ? "Current screen" : "Loading the screen…"}</span><button className="text-button" aria-pressed={follow} onClick={() => setFollow(!follow)}>{follow ? "Following latest" : "Follow latest"}</button></div>
    <pre className="screen" ref={screenRef} tabIndex={0} aria-label={`${roles[member.role].name} terminal screen`} onScroll={event => {
      const node = event.currentTarget;
      setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
    }}>{session?.screen || (member.status === "running" || member.status === "waiting" ? "Waiting for output…" : "No screen is recorded for this agent.")}</pre>
    <div className="section-label activity-label"><h2>Recent log</h2><span>Control events</span></div>
    {events.length ? <ol className="activity">{events.map(event => <li key={event.seq}><time>{date(event.at)}</time><span className="event-dot" /><div><strong>{eventLabel(event)}</strong>{eventDetail(event) && <p>{eventDetail(event)}</p>}</div></li>)}</ol> : <p className="quiet">No recent control events.</p>}
  </section>;
}

export function TeamDetail({ id, me, connected, sessions, refreshTeams, openSession }: { id: string; me: Me; connected: boolean; sessions: Session[]; refreshTeams: () => void; openSession: (id: string) => void }) {
  const api = useApi();
  const machine = useMachines().active.id;
  const key = machine + "/" + id;
  const [team, setTeam] = useState<TeamView | null>(null);
  const [loadError, setLoadError] = useState("");
  const request = mutations.use(key);
  const pending = request.pending;
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function receive(next: TeamView) { setTeam(previous => !previous || next.revision > previous.revision || (next.revision === previous.revision && next.updatedAt >= previous.updatedAt) ? next : previous); }
  const view = useLiveRefresh(async current => {
    try { const next = await api<TeamView>("/teams/" + id); if (current()) { receive(next); setLoadError(""); } }
    catch (error) { if (current()) setLoadError((error as Error).message); throw error; }
  }, 1800, key);
  const fresh = connected && view.fresh;
  const canSteer = fresh && me.role !== "viewer" && team?.status !== "cancelled" && team?.status !== "delivering" && !team?.deliveryReceipt;
  const canOwn = fresh && me.role === "owner";
  async function mutate(path: string, label: string, text?: string) {
    if (!team || busy || !fresh || me.role === "viewer") return;
    const body = mutations.begin(key, { requestId: crypto.randomUUID(), revision: team.revision, path, label, ...(text ? { text } : {}) });
    if (inFlight.has(body.requestId)) return;
    inFlight.add(body.requestId); setBusy(true);
    try {
      const { path: endpoint, label: action, ...payload } = body;
      const result = await api<TeamView>(endpoint, payload);
      const accepted = mutations.complete(key, body.requestId, { id: result.id }, action + " recorded. Revision " + result.revision + ".");
      if (mounted.current) { receive(result); if (accepted && endpoint.endsWith("/steer")) setDirection(""); view.refresh(); refreshTeams(); }
    } catch (error) {
      const refused = rejected(error);
      mutations.fail(key, body.requestId, (error as Error).message + (refused ? " Refresh the team before sending another request." : " Delivery is unconfirmed. Retry will use this exact request."), refused);
      if (mounted.current && refused) view.refresh();
    } finally { inFlight.delete(body.requestId); if (mounted.current) setBusy(false); }
  }
  const action = (name: string, label: string) => void mutate("/teams/" + id + "/" + name, label);
  const [mode, setMode] = useState<"summary" | "logs">("summary");
  const [agentId, setAgentId] = useState("");
  const [briefs, setBriefs] = useState<{ sessionId: string; status: BriefingView }[]>([]);
  const [briefError, setBriefError] = useState("");
  const [asking, setAsking] = useState(false);
  const [logSession, setLogSession] = useState<Session | null>(null);
  const [logEvents, setLogEvents] = useState<LogEvent[]>([]);
  const [followLog, setFollowLog] = useState(true);
  const logCursor = useRef<number | null>(null);
  const orderedMembers = team ? monitorMembers(team.members, team.revision) : [];
  const summaryTargets = orderedMembers.filter(member => member.revision === team?.revision).slice(0, 6);
  const summaryKey = mode === "summary" ? (summaryTargets.length ? summaryTargets : orderedMembers.slice(0, 1)).map(member => member.sessionId).join(",") : "";
  useEffect(() => {
    logCursor.current = null;
    setLogEvents([]);
    setLogSession(null);
    setFollowLog(true);
  }, [agentId]);
  useEffect(() => {
    if (!team) return;
    if (agentId && team.members.some(member => member.memberId === agentId)) return;
    const next = monitorMembers(team.members, team.revision).find(member => member.revision === team.revision && (member.status === "running" || member.status === "waiting"))
      ?? monitorMembers(team.members, team.revision)[0];
    setAgentId(next?.memberId ?? "");
  }, [team, agentId]);
  const briefing = useLiveRefresh(async current => {
    if (!summaryKey) return 8000;
    const rows: { sessionId: string; status: BriefingView }[] = [];
    for (const sessionId of summaryKey.split(",")) {
      try { rows.push({ sessionId, status: await api<BriefingView>(`/sessions/${sessionId}/summary?status=1`) }); }
      catch (error) { rows.push({ sessionId, status: { state: "unknown", error: (error as Error).message } }); }
    }
    if (current()) setBriefs(rows);
    return 4000;
  }, 4000, summaryKey);
  const logs = useLiveRefresh(async current => {
    const member = team?.members.find(item => item.memberId === agentId);
    if (!member) return 1500;
    const detail = await api<Session>(`/sessions/${member.sessionId}`);
    const start = logCursor.current;
    const after = start ?? Math.max(0, detail.seq - 80);
    const page = await api<{ events: LogEvent[]; cursor: number; more: boolean }>(`/sessions/${member.sessionId}/events?after=${after}&types=lifecycle,signal,input-result&limit=80`);
    if (!current()) return;
    setLogSession(detail);
    logCursor.current = page.cursor;
    setLogEvents(previous => (start === null ? page.events : [...previous, ...page.events]).filter((event, index, all) => all.findIndex(item => item.seq === event.seq) === index).slice(-80));
    return page.more ? 0 : 1500;
  }, 1500, mode === "logs" ? agentId : "");
  async function requestSummary(sessionId: string) {
    setAsking(true);
    setBriefError("");
    try {
      const summary = await api<BriefingView["summary"]>(`/sessions/${sessionId}/summary?after=0`, undefined, "GET", undefined, 180000);
      if (!mounted.current) return;
      const ready = Boolean(summary?.repository?.brief || summary?.text);
      setBriefs(previous => [...previous.filter(row => row.sessionId !== sessionId), { sessionId, status: { state: ready ? "ready" : "empty", summary, error: ready ? undefined : "No recorded chat is available for a repository brief." } }]);
    } catch (error) {
      if (mounted.current) setBriefError((error as Error).message);
    } finally { if (mounted.current) setAsking(false); }
  }
  if (!team) return <div className="team-page"><h1>Team run</h1><p role="status">{loadError || "Loading team…"}</p>{loadError && <button className="text-button" onClick={view.refresh}><RefreshCw size={15} />Try again</button>}</div>;
  const goalHref = team.goal ? "#" + (machine === "direct" ? "" : "/machines/" + machine) + "/goals/" + team.goal.id : undefined;
  const openDecisions = team.decisions.filter(decision => decision.revision === team.revision && decision.answer === undefined);
  const resumeRun = team.status === "paused" || team.resumable === true;
  const showRunControl = resumeRun || !["blocked", "ready-for-review", "merged", "no-change"].includes(team.status);
  const memberSessions = sessions.filter(session => team.members.some(member => member.sessionId === session.id && member.revision === team.revision && ["running", "waiting"].includes(member.status)));
  const attention = memberSessions.filter(session => session.attention?.state === "needs-you");
  const selectedMember = team.members.find(member => member.memberId === agentId);
  return <div className="team-detail">
    <header className="team-detail-heading"><div><p className="team-eyebrow">{me.projects.find(project => project.id === team.projectId)?.name ?? team.projectId} · {leadLabel(team)}</p><h1>{team.objective.trim() || team.title}</h1><div className="team-detail-meta"><Status status={team.status} /><span>Revision {team.revision}</span><span>Up to {team.parallelism} implementers</span></div></div><div className="team-heading-actions"><div className="team-view-switch" role="group" aria-label="Team view"><button type="button" aria-pressed={mode === "summary"} onClick={() => setMode("summary")}>Summary</button><button type="button" aria-pressed={mode === "logs"} onClick={() => setMode("logs")}>Review logs</button></div><button className="text-button team-refresh" disabled={view.refreshing} onClick={view.refresh}><RefreshCw size={14} />{view.refreshing ? "Checking…" : "Refresh team"}</button></div></header>
    {!fresh && <div className="connection-notice" role="status">{view.failed ? "Team updates are unavailable. Showing the last received state; controls are disabled." : "Checking the team’s current state…"}{view.seen && " Last checked " + date(view.seen) + "."}</div>}
    <div className="team-detail-body">
      {team.reason && <p className="team-notice" role="status">{team.reason}</p>}
      <LinearTracking tracking={team.linear} fresh={fresh} />
      {team.deliveryReceipt && <p className="team-notice team-ready"><Check size={18} /><span>The delivery agent reports that <a href={team.deliveryReceipt.pullRequestUrl} target="_blank" rel="noreferrer">the pull request merged</a>. The host records this report; it does not independently verify GitHub or product impact.</span></p>}
      {team.status === "ready-for-review" && <p className="team-notice team-ready"><Check size={18} />The team reports that this run is ready for your review. Inspect the changes and evidence below before merging or publishing.</p>}
      {team.goal && <p className="goal-team-origin"><a href={goalHref}>Open goal</a> · cycle {team.goal.cycle} · goal revision {team.goal.revision}</p>}
      {team.noChange && <section className="team-section"><h2>No change proposed</h2><p className="team-prose">{team.noChange.summary}</p><EvidenceList evidence={team.noChange.evidence} /></section>}
      {openDecisions.length > 0 && <section className="team-section team-decisions"><h2>Decisions for you <span className="quiet">{openDecisions.length}</span></h2>{openDecisions.map(decision => <Decision key={decision.id} decision={decision} disabled={!canSteer || team.status === "paused" || busy || Boolean(pending)} member={team.members.find(member => member.memberId === decision.memberId)} answer={text => void mutate("/teams/" + id + "/decisions/" + decision.id + "/answer", "Answer", text)} />)}</section>}
      {attention.length > 0 && <section className="team-section team-decisions"><h2>Agent sessions need you</h2><p className="quiet">The host answers ordinary prompts in a member’s own workspace. These sessions still wait on a provider prompt; respond in the session.</p>{attention.map(session => <button className="team-session-link" key={session.id} onClick={() => openSession(session.id)}><span><strong>{session.title}</strong><small>{session.attention?.now ?? "Open the session to respond."}</small></span><ArrowUpRight size={18} /></button>)}</section>}
      <ProviderLimitNotice limits={team.providerLimits} />
      {mode === "logs" ? <>
        <div className="team-agent-switch" role="tablist" aria-label="Agents">{orderedMembers.map(member => <button type="button" role="tab" key={member.memberId} aria-selected={member.memberId === agentId} onClick={() => setAgentId(member.memberId)}><strong><span className={"team-agent-dot" + (["running", "waiting"].includes(member.status) ? " live" : "")} />{roles[member.role].name}</strong><span>{member.status}{member.revision === team.revision ? "" : ` · revision ${member.revision}`}</span></button>)}</div>
        {orderedMembers.length > 1 && (() => {
          const index = Math.max(0, orderedMembers.findIndex(member => member.memberId === agentId));
          const step = (by: number) => setAgentId(orderedMembers[(index + by + orderedMembers.length) % orderedMembers.length]!.memberId);
          return <div className="team-agent-stepper"><button type="button" className="text-button" onClick={() => step(-1)}>‹ Previous</button><span className="quiet">Agent {index + 1} of {orderedMembers.length}</span><button type="button" className="text-button" onClick={() => step(1)}>Next ›</button></div>;
        })()}
        {selectedMember ? <TeamLogs member={selectedMember} session={logSession?.id === selectedMember.sessionId ? logSession : null} events={logEvents} failed={logs.failed} follow={followLog} setFollow={setFollowLog} onOpen={() => openSession(selectedMember.sessionId)} /> : <p className="quiet">This run has no agents yet.</p>}
        <button type="button" className="text-button team-back-summary" onClick={() => setMode("summary")}>Back to summary</button>
      </> : <JevcodeSummary team={team} rows={briefs} failed={briefing.failed} asking={asking} error={briefError} onRequest={sessionId => void requestSummary(sessionId)} />}
      <details className="team-run-details"><summary>Run details</summary>
      <section className="team-section"><h2>Your request</h2><p className="team-prose">{team.objective}</p></section>
      {team.brief && <section className="team-section"><h2>Opportunity brief <span className="quiet">(agent proposal)</span></h2><TeamBriefView brief={team.brief} /></section>}
      {team.discovery && <section className="team-section"><h2>Discovery</h2><p className="team-prose">{team.discovery.summary}</p>{team.discovery.tasks.map(task => <article className="team-task" key={task.id}><div className="team-task-heading"><h3>{task.title}</h3><span className="team-task-state">{task.status}</span></div>{team.lineup?.implementers.find(profile => profile.id === task.agentProfileId) && <ModelProfile profile={team.lineup.implementers.find(profile => profile.id === task.agentProfileId)!} />}{task.summary && <p className="team-prose">{task.summary}</p>}{task.evidence && <EvidenceList evidence={task.evidence} />}<details><summary>Scout instructions</summary><p className="team-prose">{task.instructions}</p></details></article>)}</section>}
      <section className="team-section"><div className="team-section-heading"><h2>Work plan</h2><span className="quiet">{team.tasks.length} tasks</span></div>{team.tasks.length ? <div className="team-tasks">{team.tasks.map(task => <article className="team-task" key={task.id}><div className="team-task-heading"><h3>{task.title}</h3><span className="team-task-state">{task.status}</span></div><p className="team-task-dependencies">{task.dependsOn.length ? "After: " + task.dependsOn.map(dependency => team.tasks.find(value => value.id === dependency)?.title ?? dependency).join(", ") : "No task dependencies"}</p><TaskModel task={task} team={team} />{task.escalation && <p className="team-escalation">Escalated to {task.escalation.toProfileId}: {task.escalation.reason}</p>}{task.limitSwitches?.map((entry, index) => <p className="team-escalation" key={entry.at + "/" + index}>Usage limit: {entry.fromProfileId ?? "unknown profile"} → {entry.toProfileId} · {entry.reason}{entry.resetsAt && <> · resets {clock(entry.resetsAt)} <span className="quiet">(provider’s stated time)</span></>}</p>)}<div className="team-owned"><span>Owns</span>{task.paths.map(path => <code key={path}>{path}</code>)}</div>{task.summary && <p className="team-prose">{task.summary}</p>}<details><summary>Task instructions</summary><p className="team-prose">{task.instructions}</p>{task.commit && <p className="quiet">Integrated commit: <code>{task.commit}</code></p>}</details></article>)}</div> : <p className="quiet">The coordinator has not reported a work plan yet.</p>}</section>
      <section className="team-section"><h2>Team members</h2>{team.lineup ? <><p className="quiet">This lineup was recorded when the run started. It shows requested model settings; provider policy may override them.</p><Lineup lineup={team.lineup} /></> : <RoleGuide />}{team.members.map(member => <div className="team-member" key={member.memberId}><div><strong>{member.title}</strong><p>{roles[member.role].name} · {member.status} · revision {member.revision}{member.taskId && " · " + member.taskId}</p>{member.modelProfile ? <ModelProfile profile={member.modelProfile} /> : <p>{names[member.provider ?? team.provider] ?? member.provider ?? team.provider}</p>}{member.stoppedReason && <p className="quiet">Stopped: {member.stoppedReason}</p>}{usageEnabled(me) && <p className="quiet">Cost: <UsageFigure usage={member.usage} /></p>}</div><button className="text-button" disabled={!sessions.some(session => session.id === member.sessionId)} onClick={() => openSession(member.sessionId)}>Open session <ArrowUpRight size={16} /></button></div>)}</section>
      <section className="team-section"><h2>Verification evidence</h2><p className="quiet">Host check results and the reviewer’s assessment are recorded separately.</p><h3>Required checks</h3>{team.checks.length ? team.checks.map((check, index) => <details className="team-check" key={check.startedAt + "/" + index}><summary><code>{[check.command.command, ...check.command.args].join(" ")}</code><span className={"team-check-status " + check.status}>{check.status} · revision {check.revision}</span></summary><p className="quiet">Revision {check.revision} · started {date(check.startedAt)}{check.finishedAt && " · finished " + date(check.finishedAt)}{check.exitCode !== undefined && " · exit " + String(check.exitCode)}</p><pre>{check.output || "No output recorded."}</pre></details>) : <p className="quiet">No check results recorded yet.</p>}<h3 className="team-review-heading">Reviewer assessment <span className="quiet">(agent report)</span></h3>{team.review ? <div><p><strong>{team.review.verdict === "approved" ? "Approved by reviewer" : "Changes requested"}</strong> <span className="quiet">· revision {team.review.revision}</span></p><p className="team-prose">{team.review.summary}</p>{team.review.uiEvidence && <><h4>Reviewer UI evidence</h4><p className="team-prose">{team.review.uiEvidence}</p></>}</div> : <p className="quiet">No reviewer assessment recorded yet.</p>}</section>
      <UsageRollup me={me} usage={team.usage} heading="Agent spend" />
      <section className="team-section"><h2>Review the changes</h2><dl className="team-output"><dt><GitBranch size={15} />Branch</dt><dd><code>{team.branch}</code></dd><dt>Workspace</dt><dd><code>{team.workspace}</code></dd><dt>Base commit</dt><dd><code>{team.baseCommit}</code></dd>{team.headCommit && <><dt>Head commit</dt><dd><code>{team.headCommit}</code></dd></>}</dl></section>
      {(team.steering.length > 0 || team.decisions.some(decision => decision.answer !== undefined)) && <section className="team-section"><h2>Your directions and decisions</h2>{team.steering.map((entry, index) => <div className="team-record" key={entry.at + "/" + index}><small>Direction · revision {entry.revision} · {date(entry.at)}</small><p className="team-prose">{entry.text}</p></div>)}{team.decisions.filter(decision => decision.answer !== undefined).map(decision => <div className="team-record" key={decision.id}><small>Decision · revision {decision.revision}</small><p className="team-prose">{decision.question}</p><p className="team-prose"><strong>Your answer: </strong>{decision.answer}</p></div>)}</section>}
      {team.events.length > 0 && <section className="team-section"><div className="team-history"><h2>Run history</h2><ol>{team.events.map((event, index) => <li key={event.at + "/" + index}><time>{date(event.at)}</time><p>{event.text}</p></li>)}</ol></div></section>}
      </details>
      {team.resumable && <p className="quiet">Resume starts a fresh plan from the preserved integration commit. The stopped member workspace stays available.</p>}
      {me.role === "owner" && !team.goal && team.status !== "cancelled" && <div className="team-actions">{showRunControl && <button className="text-button" disabled={!canOwn || busy || Boolean(pending)} onClick={() => action(resumeRun ? "resume" : "pause", resumeRun ? "Resume" : "Pause")}>{resumeRun ? "Resume team" : "Pause team"}</button>}<button className="text-button team-cancel" disabled={!canOwn || busy || Boolean(pending)} onClick={() => { if (window.confirm("Cancel this team run? This stops its agent sessions and keeps the recorded work.")) action("cancel", "Cancellation"); }}>Cancel team</button></div>}
    </div>
    <div className="team-composer-area">
      {request.message && <p className={request.result ? "quiet" : "error"} role="status">{request.message}</p>}
      {pending && <div className="team-pending"><span>{busy ? "Sending " : "Unconfirmed request: "}{pending.label.toLowerCase()} · revision {pending.revision}</span>{!busy && <button className="text-button" disabled={!fresh || me.role === "viewer" || (me.role !== "owner" && !pending.path.endsWith("/steer") && !pending.path.endsWith("/answer"))} onClick={() => void mutate(pending.path, pending.label, pending.text)}>Retry same request</button>}</div>}
      {me.role === "viewer" ? <p className="quiet">This device can view the team. An owner or controller can answer decisions and send direction.</p> : team.goal ? <p className="quiet goal-team-origin">Answer this cycle’s decisions above. <a href={goalHref}>Open the goal</a> to steer, pause, resume, or cancel its work.</p> : team.status === "cancelled" ? <p className="quiet">This run is cancelled. Its work and evidence remain available above.</p> : team.status === "delivering" || team.deliveryReceipt ? <p className="quiet">Delivery has started. Inspect its PR and recorded evidence before starting further work.</p> : <form onSubmit={event => { event.preventDefault(); if (direction.trim()) void mutate("/teams/" + id + "/steer", "Direction", direction.trim()); }}><label className="sr-only" htmlFor="team-direction">Steer this team</label><textarea id="team-direction" rows={2} maxLength={8000} placeholder="Give the team a direction or change the requirements…" value={direction} onChange={event => setDirection(event.target.value)} disabled={busy || Boolean(pending)} /><button className="primary" disabled={!canSteer || busy || Boolean(pending) || !direction.trim()}>Send direction <Send size={17} /></button></form>}
    </div>
  </div>;
}

function Decision({ decision, disabled, member, answer }: { decision: TeamDecision; disabled: boolean; member?: TeamMember; answer: (text: string) => void }) {
  const [text, setText] = useState("");
  return <article className="team-decision"><p className="quiet">{member ? roles[member.role].name : "Team"} · revision {decision.revision}</p><p className="team-prose">{decision.question}</p><div className="team-decision-options">{decision.options.map((option, index) => <button key={index} disabled={disabled} onClick={() => answer(option)}>{option}</button>)}</div><form onSubmit={event => { event.preventDefault(); if (text.trim()) answer(text.trim()); }}><label className="sr-only" htmlFor={"decision-" + decision.id}>Your answer</label><textarea id={"decision-" + decision.id} rows={2} maxLength={8000} placeholder="Write your answer…" value={text} onChange={event => setText(event.target.value)} disabled={disabled} /><button className="primary" disabled={disabled || !text.trim()}>Send answer <ArrowUpRight size={16} /></button></form></article>;
}
