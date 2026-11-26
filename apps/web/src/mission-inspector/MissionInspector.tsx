import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, RefreshCw, X } from "lucide-react";
import { useApi, type DecisionRecommendation, type Me } from "../api";
import { Decision } from "../team-decision";
import {
  compactAssignments,
  currentAssignmentCount,
  isAwaitingExitMember,
  missionProgressResyncNotice,
  resolveMissionChild,
  type MissionProgressCheck,
  type MissionProgressMember,
  type MissionProgressState,
  type MissionProgressWorkerStatus,
  type ResolvedMissionChild,
} from "./progress-store";
import type { MissionStatus } from "../mission-model";

export type MissionSubtaskView = {
  id: string;
  title: string;
  repoProjectId: string;
  status: "queued" | "running" | "done" | "cancelled" | "blocked";
  objective?: string;
  size?: "solo" | "team";
  parallelism?: number;
  dependsOn?: string[];
  teamId?: string;
  teamStatus?: string;
  finalEvidence?: {
    reason?: string;
    headCommit?: string;
  };
};

export type MissionDecisionView = {
  id: string;
  question: string;
  options: string[];
  answerMode?: "approval" | "single" | "multiple";
  createdAt: string;
  subtaskId?: string;
  childDecisionId?: string;
  answer?: string;
  answeredAt?: string;
  answeredBy?: "owner" | "coordinator" | "connector";
  source?: { kind: "connector"; id: string; name: string };
  recommendation?: DecisionRecommendation;
};

export type MissionSteeringView = {
  text: string;
  revision: number;
  at: string;
  source?: "slack" | { kind: "connector"; id: string; name: string };
};

export type MissionView = {
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  objective: string;
  status: MissionStatus;
  stopReason?: "deadline";
  reason?: string;
  revision: number;
  updatedAt: string;
  createdAt: string;
  deadlineAt: string;
  clockStoppedAt?: string;
  canAnswerPaused?: true;
  maxMinutes: number;
  repoProjectIds: string[];
  coordinator?: { memberId: string; sessionId: string; status: "running" | "waiting" | "stopped" };
  dispatchSummary?: string;
  subtasks: MissionSubtaskView[];
  decisions: MissionDecisionView[];
  steering: MissionSteeringView[];
  events: { at: string; text: string }[];
  result?: { summary: string; revision: number; at: string };
  mode?: "answer";
  origin?: { kind: "intake"; issueId: string; identifier: string; url: string; rule: string };
};

export type EntryKind =
  | "contract"
  | "finding"
  | "blocker"
  | "handoff"
  | "report"
  | "integration"
  | "check"
  | "direction";

export type EntryHeadView = {
  entryId: string;
  seq: number;
  scope: "run" | "mission";
  runId: string;
  revision: number;
  at: string;
  kind: EntryKind;
  author: "host" | "member" | "owner";
  authority: "receipt" | "claim" | "direction";
  authorRole?: string;
  taskId?: string;
  paths: string[];
  subtaskIds?: string[];
  summary: string;
  bodyBytes: number;
  supersedes?: string;
  unreadRequired?: string[];
  state: "active" | "superseded" | "withdrawn";
};

type EntryPageView = {
  entries: EntryHeadView[];
  cursor: number;
  more: boolean;
};

type EntryDetailView = {
  head: EntryHeadView;
  body: unknown;
};

const ENTRY_KIND_OPTIONS: EntryKind[] = [
  "contract",
  "finding",
  "blocker",
  "handoff",
  "report",
  "integration",
  "check",
  "direction",
];

const authorityLabel = (authority: EntryHeadView["authority"]) =>
  authority === "receipt" ? "host receipt" : authority === "claim" ? "agent claim" : "owner direction";

const workerToneClass = (status: MissionProgressWorkerStatus) => {
  if (status === "running" || status === "starting") return "is-live";
  if (status === "unavailable" || status === "recording-error" || status === "mismatched") return "is-fail";
  if (status === "exited" || status === "unknown") return "is-warn";
  return "";
};

const steeringSourceLabel = (source: MissionSteeringView["source"]) => {
  if (!source) return "Owner";
  if (source === "slack") return "Owner (Slack)";
  return source.name;
};

const decisionAnswerAuthorLabel = (decision: MissionDecisionView) => {
  if (decision.answeredBy === "connector") return `${decision.source?.name ?? "Connector"}: `;
  if (decision.answeredBy === "coordinator") return "Mission coordinator: ";
  return "Your answer: ";
};

const roleLabel = (role: MissionProgressMember["role"]) => {
  switch (role) {
    case "project-manager":
      return "Coordinator";
    case "intent-checker":
      return "Intent checker";
    case "scout":
      return "Scout";
    case "implementer":
      return "Implementer";
    case "integrator":
      return "Integrator";
    case "reviewer":
      return "Reviewer";
    case "delivery":
      return "Delivery";
    case "evaluator":
      return "Evaluator";
    case "permission-coordinator":
      return "Permission coordinator";
    case "judge":
      return "Judge";
    default:
      return role;
  }
};

export function MissionResyncBanner({
  progress,
  dismissedCount,
  onDismiss,
}: {
  progress: MissionProgressState;
  dismissedCount: number;
  onDismiss: () => void;
}) {
  const notice = missionProgressResyncNotice(progress.lastResyncReason);
  if (!notice || progress.resyncCount <= dismissedCount) return null;
  return (
    <div className="mission-resync-notice" role="status">
      <p>
        <strong>Progress resynced ({progress.lastResyncReason})</strong> · {notice}
        {progress.resyncCount > 1 ? ` (${progress.resyncCount} resyncs)` : ""}
      </p>
      <button type="button" className="team-notice-dismiss" aria-label="Dismiss resync notice" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  );
}

export function MissionOpenDecisions({
  mission,
  me,
  disabled,
  answer,
}: {
  mission: MissionView;
  me: Me;
  disabled: boolean;
  answer: (decisionId: string, text: string) => void;
}) {
  const open = mission.decisions.filter(item => item.answer === undefined);
  if (!open.length) return null;
  const readOnly = me.role !== "owner";
  return (
    <section className="team-section team-decisions">
      <h2>
        Open mission decisions <span className="quiet">{open.length}</span>
      </h2>
      {readOnly && <p className="quiet">Only an owner can answer mission decisions.</p>}
      {!readOnly && mission.status === "paused" && mission.canAnswerPaused && (
        <p className="quiet">A halt holds this mission. Your answer is kept and takes effect when the mission resumes.</p>
      )}
      {!readOnly && mission.status === "paused" && !mission.canAnswerPaused && (
        <p className="quiet">Resume this mission before answering its decisions.</p>
      )}
      {open.map(decision => (
        <Decision
          key={decision.id}
          decision={{ ...decision, revision: mission.revision }}
          disabled={disabled}
          from={decision.subtaskId ? `Forwarded from subtask ${decision.subtaskId}` : "Mission coordinator"}
          answer={text => answer(decision.id, text)}
          readOnly={readOnly}
        />
      ))}
    </section>
  );
}

export function MissionOverview({
  mission,
  me,
  progress,
  formatDate,
}: {
  mission: MissionView;
  me: Me;
  progress: MissionProgressState;
  formatDate: (value: string) => string;
}) {
  const projectName = (projectId: string) => me.projects.find(project => project.id === projectId)?.name ?? projectId;
  const counts = { queued: 0, running: 0, done: 0, blocked: 0, cancelled: 0 };
  for (const subtask of mission.subtasks) counts[subtask.status] += 1;
  const total = mission.subtasks.length;
  const progressCoordinator = progress.snapshot?.mission.coordinator;
  const recordedCoordinator = progressCoordinator?.recordedStatus ?? mission.coordinator?.status;
  const workerCoordinator = progressCoordinator?.workerStatus;

  const repoCounts = new Map<string, number>();
  for (const repoId of mission.repoProjectIds) repoCounts.set(repoId, 0);
  for (const subtask of mission.subtasks) {
    repoCounts.set(subtask.repoProjectId, (repoCounts.get(subtask.repoProjectId) ?? 0) + 1);
  }

  return (
    <section className="team-section">
      <h2>Overview</h2>
      <div className="mission-overview-grid">
        <div className="mission-overview-card">
          <h3>Subtasks</h3>
          <div className="mission-overview-metric">
            {counts.done}/{total} done
          </div>
          <p className="mission-overview-sub">
            {total
              ? `${counts.running} running · ${counts.queued} queued · ${counts.blocked} blocked · ${counts.cancelled} cancelled`
              : mission.mode === "answer"
                ? "Read-only answer mission"
                : "No subtasks dispatched yet"}
          </p>
        </div>
        <div className="mission-overview-card">
          <h3>Coordinator</h3>
          <div className="mission-overview-metric">
            {recordedCoordinator ?? "Not started"}
          </div>
          <p className="mission-overview-sub">
            Recorded state: {recordedCoordinator ?? "none"}
            {workerCoordinator ? ` · Live worker: ${workerCoordinator}` : ""}
          </p>
        </div>
        <div className="mission-overview-card">
          <h3>Repositories ({repoCounts.size})</h3>
          <ul className="mission-repo-chips">
            {[...repoCounts.entries()].map(([repoId, count]) => (
              <li key={repoId}>
                {projectName(repoId)} · {count}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mission-objective-box">
        <h3>Objective</h3>
        <p className="team-prose">{mission.objective}</p>
        {mission.dispatchSummary && (
          <p className="mission-overview-sub">Dispatch summary: {mission.dispatchSummary}</p>
        )}
      </div>
      {mission.result && (
        <div className="mission-result-box">
          <h3>
            Coordinator result <span className="quiet">· revision {mission.result.revision} · {formatDate(mission.result.at)}</span>
          </h3>
          <p className="team-prose">{mission.result.summary}</p>
        </div>
      )}
    </section>
  );
}

export function MissionSubtaskInspector({
  mission,
  me,
  progress,
  progressError,
  progressLoading,
  selectedSubtaskId,
  onSelectSubtask,
  openTeam,
  formatDate,
}: {
  mission: MissionView;
  me: Me;
  progress: MissionProgressState;
  progressError: string;
  progressLoading: boolean;
  selectedSubtaskId: string | null;
  onSelectSubtask: (subtaskId: string) => void;
  openTeam: (teamId: string) => void;
  formatDate: (value: string) => string;
}) {
  const [tab, setTab] = useState<"status" | "entries">("status");
  const projectName = (projectId: string) => me.projects.find(project => project.id === projectId)?.name ?? projectId;

  const effectiveId = mission.subtasks.some(item => item.id === selectedSubtaskId)
    ? selectedSubtaskId
    : mission.subtasks[0]?.id ?? null;
  const selectedSubtask = mission.subtasks.find(item => item.id === effectiveId) ?? null;
  const resolvedChild: ResolvedMissionChild | null = selectedSubtask
    ? resolveMissionChild(mission, selectedSubtask, progress.snapshot, { progressError, progressLoading })
    : null;
  const verifiedTeamId = resolvedChild?.kind === "linked" ? resolvedChild.verifiedTeamId : undefined;

  useEffect(() => {
    if (!verifiedTeamId && tab === "entries") setTab("status");
  }, [verifiedTeamId, tab]);

  return (
    <section className="team-section">
      <h2>Subtasks</h2>
      {!mission.subtasks.length ? (
        <p className="quiet">No subtasks recorded.</p>
      ) : (
        <div className="mission-inspector-grid">
          <div className="mission-subtask-list" role="listbox" aria-label="Mission subtasks">
            {mission.subtasks.map(subtask => {
              const resolved = resolveMissionChild(mission, subtask, progress.snapshot, { progressError, progressLoading });
              const childLabel =
                resolved.kind === "linked"
                  ? `${resolved.child.status} · ${currentAssignmentCount(resolved.child.assignments)} assigned`
                  : resolved.kind === "loading"
                    ? "loading progress"
                    : resolved.kind === "unavailable"
                      ? "progress unavailable"
                      : resolved.kind === "mismatched"
                        ? "link mismatch"
                        : resolved.kind;
              const isSelected = subtask.id === effectiveId;
              return (
                <button
                  type="button"
                  key={subtask.id}
                  role="option"
                  aria-selected={isSelected}
                  className={"mission-subtask-row" + (isSelected ? " selected" : "")}
                  onClick={() => onSelectSubtask(subtask.id)}
                >
                  <strong>{subtask.title}</strong>
                  <span>
                    {projectName(subtask.repoProjectId)} · {subtask.status} · {childLabel}
                  </span>
                </button>
              );
            })}
          </div>
          {selectedSubtask && resolvedChild && (
            <div className="mission-subtask-detail">
              <div className="mission-subtask-header">
                <div>
                  <h3>{selectedSubtask.title}</h3>
                  <p>
                    {projectName(selectedSubtask.repoProjectId)} · {selectedSubtask.status}
                    {selectedSubtask.size ? ` · ${selectedSubtask.size}` : ""}
                    {selectedSubtask.parallelism ? ` · parallelism ${selectedSubtask.parallelism}` : ""}
                    {selectedSubtask.dependsOn?.length ? ` · after ${selectedSubtask.dependsOn.join(", ")}` : ""}
                  </p>
                </div>
                {verifiedTeamId && (
                  <button type="button" className="text-button" onClick={() => openTeam(verifiedTeamId)}>
                    Open team <ArrowUpRight size={14} />
                  </button>
                )}
              </div>

              <div className="mission-inspector-tabs" role="tablist" aria-label="Subtask inspection view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "status"}
                  onClick={() => setTab("status")}
                >
                  Assignments &amp; checks
                </button>
                {verifiedTeamId && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "entries"}
                    onClick={() => setTab("entries")}
                  >
                    Blackboard entries
                  </button>
                )}
              </div>

              {tab === "status" ? (
                <ChildStatusPanel subtask={selectedSubtask} resolved={resolvedChild} formatDate={formatDate} />
              ) : (
                verifiedTeamId && <ChildBlackboardPanel key={verifiedTeamId} teamId={verifiedTeamId} formatDate={formatDate} />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ChildStatusPanel({
  subtask,
  resolved,
  formatDate,
}: {
  subtask: MissionSubtaskView;
  resolved: ResolvedMissionChild;
  formatDate: (value: string) => string;
}) {
  if (resolved.kind !== "linked") {
    return (
      <div>
        <p className="quiet" role={resolved.kind === "loading" ? "status" : undefined}>
          {resolved.kind === "loading" && resolved.reason}
          {resolved.kind === "unavailable" && resolved.reason}
          {resolved.kind === "not-created" && "No subteam run has been created for this subtask yet."}
          {resolved.kind === "missing" && "The linked subteam record is no longer present on the host."}
          {resolved.kind === "mismatched" && `${resolved.reason} Blackboard entries and team navigation are disabled until the subteam link is verified.`}
        </p>
        {subtask.finalEvidence?.reason && <p className="mission-overview-sub">Final reason: {subtask.finalEvidence.reason}</p>}
        {subtask.finalEvidence?.headCommit && (
          <p className="mission-overview-sub">
            Final head commit: <code>{subtask.finalEvidence.headCommit}</code>
          </p>
        )}
        {subtask.objective && (
          <details className="mission-finished-fold">
            <summary>Subtask objective</summary>
            <p className="team-prose">{subtask.objective}</p>
          </details>
        )}
      </div>
    );
  }

  const { child } = resolved;
  const compacted = compactAssignments(child.assignments);
  return (
    <div>
      <p className="mission-overview-sub">
        Subteam <code>{child.runId.slice(0, 8)}</code> · status {child.status} · revision {child.revision}
      </p>
      {(child.assignmentsTruncated || child.checksTruncated) && (
        <p className="quiet">Some older assignments or checks are truncated in the snapshot; open the team for full records.</p>
      )}
      <h3>Active assignments ({compacted.active.length})</h3>
      {compacted.active.length ? (
        <ul className="mission-assignment-list">
          {compacted.active.map(({ member, priorAttempts }) => {
            const awaitingExit = isAwaitingExitMember(member);
            return (
              <li className="mission-assignment-item" key={member.memberId}>
                <div className="mission-assignment-top">
                  <strong>
                    {roleLabel(member.role)}
                    {member.taskId ? ` · ${member.taskId}` : ""}
                  </strong>
                  <span className="mission-badge-pair">
                    <span className={"mission-badge" + (awaitingExit ? " is-warn" : "")}>
                      recorded: {awaitingExit ? "reported (awaiting exit)" : member.recordedStatus}
                    </span>
                    <span className={"mission-badge " + workerToneClass(member.workerStatus)}>
                      worker: {member.workerStatus}
                    </span>
                    <span className="mission-badge">r{member.revision}</span>
                  </span>
                </div>
                {priorAttempts.length > 0 && (
                  <div className="mission-prior-attempts">
                    {priorAttempts.map(prior => (
                      <div key={prior.memberId}>
                        Earlier attempt ({prior.recordedStatus} · r{prior.revision}
                        {prior.exitConfirmedAt ? ` · exited ${formatDate(prior.exitConfirmedAt)}` : ""})
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="quiet">No active assignments on this revision.</p>
      )}

      {compacted.finished.length > 0 && (
        <details className="mission-finished-fold">
          <summary>Finished ({compacted.finished.length})</summary>
          <ul className="mission-assignment-list">
            {compacted.finished.map(member => (
              <li className="mission-assignment-item" key={member.memberId}>
                <div className="mission-assignment-top">
                  <span>
                    {roleLabel(member.role)}
                    {member.taskId ? ` · ${member.taskId}` : ""}
                  </span>
                  <span className="mission-badge-pair">
                    <span className="mission-badge">recorded: {member.recordedStatus}</span>
                    <span className="mission-badge">worker: {member.workerStatus}</span>
                    <span className="mission-badge">r{member.revision}</span>
                  </span>
                </div>
                {member.exitConfirmedAt && (
                  <p className="mission-overview-sub">Exit confirmed {formatDate(member.exitConfirmedAt)}</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <h3>Host checks ({child.checks.length})</h3>
      {child.checks.length ? (
        <ul className="mission-check-list">
          {child.checks.map((check: MissionProgressCheck, index: number) => (
            <li className="mission-check-item" key={`${check.startedAt}/${index}`}>
              <span>
                <strong>{check.status}</strong> · r{check.revision}
                {check.round !== undefined ? ` · round ${check.round}` : ""}
                {check.headCommit ? (
                  <>
                    {" · "}
                    <code title={check.headCommit}>{check.headCommit.slice(0, 8)}</code>
                  </>
                ) : null}
                {check.exitCode !== undefined && check.exitCode !== null ? ` · exit ${check.exitCode}` : ""}
              </span>
              <span className="quiet">{formatDate(check.finishedAt ?? check.startedAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet">No host checks recorded for this revision yet.</p>
      )}

      {subtask.objective && (
        <details className="mission-finished-fold">
          <summary>Subtask objective</summary>
          <p className="team-prose">{subtask.objective}</p>
        </details>
      )}
    </div>
  );
}

function ChildBlackboardPanel({ teamId, formatDate }: { teamId: string; formatDate: (value: string) => string }) {
  const api = useApi();
  const [kindFilter, setKindFilter] = useState<"" | EntryKind>("");
  const [entries, setEntries] = useState<EntryHeadView[]>([]);
  const [cursor, setCursor] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);
  const listEpochRef = useRef(0);
  const detailEpochRef = useRef(0);

  useEffect(() => {
    let active = true;
    const epoch = ++listEpochRef.current;
    detailEpochRef.current += 1;
    setLoading(true);
    setError("");
    setEntries([]);
    setCursor(0);
    setMore(false);
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError("");
    const params = new URLSearchParams();
    if (kindFilter) params.set("kind", kindFilter);
    api<EntryPageView>(`/teams/${teamId}/entries${params.size ? `?${params}` : ""}`)
      .then(page => {
        if (!active || listEpochRef.current !== epoch) return;
        setEntries(page.entries);
        setCursor(page.cursor);
        setMore(page.more);
      })
      .catch(failure => {
        if (active && listEpochRef.current === epoch) setError((failure as Error).message);
      })
      .finally(() => {
        if (active && listEpochRef.current === epoch) setLoading(false);
      });
    return () => {
      active = false;
      listEpochRef.current += 1;
      detailEpochRef.current += 1;
    };
  }, [api, teamId, kindFilter, reloadNonce]);

  async function loadMore() {
    if (loading || !more) return;
    const epoch = ++listEpochRef.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (kindFilter) params.set("kind", kindFilter);
      params.set("since", String(cursor));
      const page = await api<EntryPageView>(`/teams/${teamId}/entries?${params}`);
      if (listEpochRef.current !== epoch) return;
      setEntries(previous => {
        const seen = new Set(previous.map(item => item.entryId));
        return [...previous, ...page.entries.filter(item => !seen.has(item.entryId))];
      });
      setCursor(page.cursor);
      setMore(page.more);
    } catch (failure) {
      if (listEpochRef.current === epoch) setError((failure as Error).message);
    } finally {
      if (listEpochRef.current === epoch) setLoading(false);
    }
  }

  async function openEntry(entryId: string) {
    const epoch = ++detailEpochRef.current;
    setSelectedId(entryId);
    setDetailLoading(true);
    setDetailError("");
    try {
      const found = await api<EntryDetailView>(`/teams/${teamId}/entries/${entryId}`);
      if (detailEpochRef.current !== epoch) return;
      setDetail(found);
    } catch (failure) {
      if (detailEpochRef.current !== epoch) return;
      setDetail(null);
      setDetailError((failure as Error).message);
    } finally {
      if (detailEpochRef.current === epoch) setDetailLoading(false);
    }
  }

  return (
    <div>
      <p className="mission-overview-sub">
        Global SQLite blackboard entries for subteam <code>{teamId.slice(0, 8)}</code>. Entry <code>#seq</code> is a
        blackboard sequence number, separate from mission progress sequence.
      </p>
      <div className="mission-entries-controls">
        <select
          aria-label="Filter blackboard entries by kind"
          value={kindFilter}
          onChange={event => setKindFilter(event.target.value as "" | EntryKind)}
        >
          <option value="">All entry kinds</option>
          {ENTRY_KIND_OPTIONS.map(kind => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <button type="button" className="text-button" disabled={loading} onClick={() => setReloadNonce(n => n + 1)}>
          <RefreshCw size={14} className={loading ? "is-refreshing" : ""} /> Refresh entries
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && !entries.length && <p className="quiet" role="status">Loading blackboard entries…</p>}
      {!loading && !error && !entries.length && <p className="quiet">No blackboard entries match this filter.</p>}

      {entries.length > 0 && (
        <ul className="mission-entry-list">
          {entries.map(entry => (
            <li key={entry.entryId}>
              <button
                type="button"
                className={"mission-entry-row" + (selectedId === entry.entryId ? " selected" : "")}
                onClick={() => void openEntry(entry.entryId)}
              >
                <div className="mission-entry-meta">
                  <strong>blackboard #{entry.seq}</strong>
                  <span>{entry.kind}</span>
                  <span>{authorityLabel(entry.authority)}</span>
                  <span>{entry.authorRole ?? entry.author}</span>
                  {entry.taskId && <span>task {entry.taskId}</span>}
                  {entry.state !== "active" && <span>{entry.state}</span>}
                  <span>{formatDate(entry.at)}</span>
                </div>
                <span className="mission-entry-summary">{entry.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {more && (
        <button type="button" className="text-button" disabled={loading} onClick={() => void loadMore()}>
          Load more entries
        </button>
      )}

      {selectedId && (
        <div className="mission-entry-detail">
          {detailLoading && <p className="quiet" role="status">Loading entry detail…</p>}
          {detailError && (
            <p className="error" role="alert">
              {detailError}
            </p>
          )}
          {detail && !detailLoading && (
            <>
              <div className="mission-entry-meta">
                <strong>blackboard #{detail.head.seq}</strong>
                <span>{detail.head.kind}</span>
                <span>{authorityLabel(detail.head.authority)}</span>
                <span>{detail.head.authorRole ?? detail.head.author}</span>
                <span>r{detail.head.revision}</span>
                <span>{detail.head.state}</span>
              </div>
              {detail.head.paths.length > 0 && (
                <p className="mission-overview-sub">Paths: {detail.head.paths.join(", ")}</p>
              )}
              <pre>{JSON.stringify(detail.body, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function MissionDirectionsAndDecisions({
  mission,
  formatDate,
}: {
  mission: MissionView;
  formatDate: (value: string) => string;
}) {
  const answered = mission.decisions.filter(item => item.answer !== undefined);
  if (!mission.steering.length && !answered.length) return null;
  return (
    <section className="team-section">
      <h2>Directions &amp; answered decisions</h2>
      {mission.steering.map((entry, index) => (
        <div className="team-record" key={`${entry.at}/${index}`}>
          <small>
            {steeringSourceLabel(entry.source)} · direction · revision {entry.revision} · {formatDate(entry.at)}
          </small>
          <p className="team-prose">{entry.text}</p>
        </div>
      ))}
      {answered.map(decision => (
        <div className="team-record" key={decision.id}>
          <small>
            Decision{decision.subtaskId ? ` · subtask ${decision.subtaskId}` : ""}
            {decision.answeredAt ? ` · ${formatDate(decision.answeredAt)}` : ""}
          </small>
          <p className="team-prose">{decision.question}</p>
          <p className="team-prose">
            <strong>{decisionAnswerAuthorLabel(decision)}</strong>
            {decision.answer}
          </p>
          {decision.recommendation?.outcome === "matched" && <p className="quiet">Matched the recommendation</p>}
          {decision.recommendation?.outcome === "different" && (
            <p className="quiet">Different from the recommendation</p>
          )}
        </div>
      ))}
    </section>
  );
}

export function MissionProgressAndEvents({
  mission,
  progress,
  progressError,
  formatDate,
}: {
  mission: MissionView;
  progress: MissionProgressState;
  progressError: string;
  formatDate: (value: string) => string;
}) {
  const observations = progress.observations.slice().reverse();
  const events = mission.events.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);

  return (
    <section className="team-section">
      <h2>Progress observations &amp; Mission events</h2>
      {progressError && <p className="quiet" role="status">Progress stream unavailable: {progressError}</p>}
      {observations.length ? (
        <ul className="mission-observation-list">
          {observations.map(observation => {
            const linkedRunning = observation.snapshot.subtasks.filter(
              item => item.child.kind === "linked" && item.status === "running",
            ).length;
            return (
              <li key={`${observation.cursor}/${observation.sequence}`}>
                <strong>Progress sequence #{observation.sequence}</strong> · {formatDate(observation.observedAt)} ·{" "}
                {observation.snapshot.mission.status} · revision {observation.snapshot.mission.revision} ·{" "}
                {observation.snapshot.subtasks.length} subtasks ({linkedRunning} running)
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="quiet">No progress transitions retained since the initial snapshot.</p>
      )}
      {progress.cursor && (
        <p className="mission-cursor-line">
          Progress cursor (generation-scoped): <code>{progress.cursor}</code>
        </p>
      )}
      <details className="team-history">
        <summary>Mission events ({events.length})</summary>
        {events.length ? (
          <ol>
            {events.map((event, index) => (
              <li key={`${event.at}/${index}`}>
                <time>{formatDate(event.at)}</time>
                <p>{event.text}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="quiet">No events recorded.</p>
        )}
      </details>
    </section>
  );
}
