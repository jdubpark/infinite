import { useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { clock, type Session } from "../api";
import type { TeamView } from "../teams";
import { deriveOutcomeGroups, inspectorRoleLabel, orderWaitReasons, partitionRoster, waitReasonMeta, type RosterMemberNode } from "./model";

type TeamOverviewProps = {
  team: TeamView;
  sessions: Session[];
  onOpenSession: (sessionId: string) => void;
  onInspectMemberEntries: (memberId: string) => void;
  onViewMemberLogs: (memberId: string) => void;
};

function assessmentLabel(state: string): string {
  if (state === "met") return "Met";
  if (state === "not-met") return "Not met";
  if (state === "pending-owner") return "Waiting for owner";
  return "Inconclusive";
}

function reviewerVerdictLabel(verdict: string): string {
  if (verdict === "verified") return "Verified (claim)";
  if (verdict === "not-verified") return "Not verified (claim)";
  return "Inconclusive (claim)";
}

function producerLabel(producer: "host" | "evaluator" | "owner"): string {
  if (producer === "host") return "Host receipt";
  if (producer === "evaluator") return "Evaluator";
  return "Owner";
}

function safeClock(iso: string | undefined): string {
  const trimmed = iso?.trim() ?? "";
  if (!trimmed) return "";
  if (Number.isNaN(Date.parse(trimmed))) return trimmed;
  return clock(trimmed);
}

export function TeamOverview({
  team,
  sessions,
  onOpenSession,
  onInspectMemberEntries,
  onViewMemberLogs,
}: TeamOverviewProps) {
  const overview = deriveOutcomeGroups(team);
  const roster = partitionRoster(team.members, team.revision);
  const waitReasons = orderWaitReasons(team.waitReasons ?? []);
  const [showFinished, setShowFinished] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const sessionIds = new Set(sessions.map(session => session.id));

  function jumpToMember(memberId: string) {
    const targetInFinished = roster.finished.some(node => node.member.memberId === memberId);
    if (targetInFinished) setShowFinished(true);
    setHighlightedId(memberId);
  }

  function renderMemberCard(node: RosterMemberNode) {
    const { member, replacedByMemberId, replacesMemberId } = node;
    const roleLabel = inspectorRoleLabel(member.role);
    const hasSession = sessionIds.has(member.sessionId);
    const replacement = replacedByMemberId ? roster.byMemberId[replacedByMemberId]?.member : undefined;
    const replaced = replacesMemberId ? roster.byMemberId[replacesMemberId]?.member : undefined;
    const highlighted = highlightedId === member.memberId;
    const stalledLabel = safeClock(member.stalledAt);
    const spinnerLabel = safeClock(member.spinnerOnlySince);
    return (
      <article
        key={member.memberId}
        id={`ti-member-${member.memberId}`}
        className={`ti-roster-card${highlighted ? " is-highlighted" : ""}`}
      >
        <div className="ti-roster-card-top">
          <strong>{roleLabel}</strong>
          <span className="ti-pill">{member.status}</span>
        </div>
        <div className="ti-roster-sub">
          {member.title} · r{member.revision}
          {member.taskId ? ` · ${member.taskId}` : ""}
        </div>
        {stalledLabel && (
          <div className="ti-roster-sub ti-roster-flag is-attention">Stalled since {stalledLabel}</div>
        )}
        {spinnerLabel && (
          <div className="ti-roster-sub ti-roster-flag is-warning">Spinner-only screen since {spinnerLabel}</div>
        )}
        {member.stoppedReason && (
          <div className="ti-roster-sub">Stopped: {member.stoppedReason}</div>
        )}
        <div className="ti-roster-links">
          <button type="button" className="ti-link-btn" onClick={() => onInspectMemberEntries(member.memberId)}>
            Entries
          </button>
          <button type="button" className="ti-link-btn" onClick={() => onViewMemberLogs(member.memberId)}>
            Logs
          </button>
          {hasSession && (
            <button type="button" className="ti-link-btn" onClick={() => onOpenSession(member.sessionId)}>
              Session <ArrowUpRight size={12} />
            </button>
          )}
          {replacement && (
            <button type="button" className="ti-link-btn" onClick={() => jumpToMember(replacement.memberId)}>
              Replacement ({inspectorRoleLabel(replacement.role)} {replacement.status})
            </button>
          )}
          {replaced && (
            <button type="button" className="ti-link-btn" onClick={() => jumpToMember(replaced.memberId)}>
              Prior attempt
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <section className="team-section ti-overview" aria-label="Run overview">
      <div className="ti-overview-head">
        <h2>Outcome overview</h2>
        <div className="ti-overview-counts">
          <span>{overview.taskCounts.integrated} of {overview.taskCounts.total} tasks integrated</span>
          {overview.taskCounts.running > 0 && <span>{overview.taskCounts.running} running</span>}
          {overview.taskCounts.waiting > 0 && <span>{overview.taskCounts.waiting} waiting</span>}
          {overview.taskCounts.blocked > 0 && <span>{overview.taskCounts.blocked} blocked</span>}
        </div>
      </div>

      {overview.mode === "criteria" ? (
        <div className="ti-criteria-grid">
          {overview.groups.map(group => {
            const pct = group.totalCount > 0 ? Math.round((group.integratedCount / group.totalCount) * 100) : 0;
            return (
              <article className="ti-criterion-card" key={group.id}>
                <div className="ti-criterion-top">
                  <span className="ti-criterion-id">{group.id}</span>
                  <span className="ti-pill">{producerLabel(group.producer)}</span>
                </div>
                <p className="ti-criterion-label">{group.label}</p>
                <div className="ti-criterion-meta">
                  <span>Check: {group.check}</span>
                </div>
                <div className="ti-progress-row">
                  <span>{group.progressText}</span>
                  {group.provisionalState && (
                    <span className={`ti-pill is-${group.provisionalState}`}>
                      Provisional assessment: {assessmentLabel(group.provisionalState)}
                    </span>
                  )}
                </div>
                {group.totalCount > 0 && (
                  <div className="ti-progress-track" aria-hidden="true">
                    <div className="ti-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
                {group.tasks.length > 0 && (
                  <div className="ti-task-chips">
                    {group.tasks.map(task => (
                      <span className="ti-task-chip" key={task.id} title={`${task.title} (${task.status})`}>
                        {task.id}: {task.status}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
          {overview.unassignedTasks.length > 0 && (() => {
            const integrated = overview.unassignedTasks.filter(task => task.status === "integrated").length;
            const total = overview.unassignedTasks.length;
            const pct = Math.round((integrated / total) * 100);
            return (
              <article className="ti-criterion-card" key="other-tasks">
                <div className="ti-criterion-top">
                  <span className="ti-criterion-id">other</span>
                  <span className="ti-pill">Tasks</span>
                </div>
                <p className="ti-criterion-label">Other tasks</p>
                <div className="ti-progress-row">
                  <span>{integrated} of {total} tasks integrated</span>
                </div>
                <div className="ti-progress-track" aria-hidden="true">
                  <div className="ti-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="ti-task-chips">
                  {overview.unassignedTasks.map(task => (
                    <span className="ti-task-chip" key={task.id} title={`${task.title} (${task.status})`}>
                      {task.id}: {task.status}
                    </span>
                  ))}
                </div>
              </article>
            );
          })()}
        </div>
      ) : (
        <div className="ti-summary-box">
          <div className="ti-progress-row">
            <strong>{overview.integratedSummary}</strong>
            {overview.assessment && (
              <span className={`ti-pill is-${overview.assessment.result}`}>
                Provisional assessment: {assessmentLabel(overview.assessment.result)}
              </span>
            )}
          </div>
          {overview.taskCounts.total > 0 && (
            <div className="ti-progress-track" aria-hidden="true">
              <div
                className="ti-progress-fill"
                style={{ width: `${Math.round((overview.taskCounts.integrated / overview.taskCounts.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {overview.reviewerClaims.length > 0 && (
        <div className="ti-summary-box">
          <div className="ti-roster-head">
            <h3>Reviewer acceptance claims</h3>
            <span className="ti-pill is-claim">Reviewer claim</span>
          </div>
          <ul className="ti-claims-list">
            {overview.reviewerClaims.map(claim => (
              <li key={claim.criterion}>
                <span className={`ti-pill is-${claim.verdict}`}>{reviewerVerdictLabel(claim.verdict)}</span>
                <strong>{claim.label}</strong>
                <span className="quiet">{claim.evidence}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {waitReasons.length > 0 && (
        <div className="ti-summary-box ti-wait-reasons">
          <div className="ti-roster-head">
            <h3>Why this run is waiting</h3>
            <span className="quiet">{waitReasons.length}</span>
          </div>
          <ul className="ti-wait-list">
            {waitReasons.map((reason, index) => {
              const meta = waitReasonMeta(reason.kind);
              const member = reason.memberId ? roster.byMemberId[reason.memberId]?.member : undefined;
              const hasSession = Boolean(member && sessionIds.has(member.sessionId));
              const sinceLabel = safeClock(reason.since);
              const resetsLabel = safeClock(reason.resetsAt);
              return (
                <li className="ti-wait-item" key={`${reason.kind}-${reason.memberId ?? ""}-${reason.taskId ?? ""}-${reason.decisionId ?? ""}-${index}`}>
                  <div className="ti-wait-main">
                    <span className={`ti-pill is-wait-${meta.tone}`}>{meta.label}</span>
                    <span className="ti-wait-summary">{reason.summary}</span>
                    {(sinceLabel || resetsLabel) && (
                      <span className="ti-wait-meta">
                        {sinceLabel ? `since ${sinceLabel}` : ""}
                        {sinceLabel && resetsLabel ? " · " : ""}
                        {resetsLabel ? `resets ${resetsLabel}` : ""}
                      </span>
                    )}
                  </div>
                  {member && (
                    <div className="ti-wait-actions">
                      <button type="button" className="ti-link-btn" onClick={() => onViewMemberLogs(member.memberId)}>
                        Logs
                      </button>
                      <button type="button" className="ti-link-btn" onClick={() => onInspectMemberEntries(member.memberId)}>
                        Entries
                      </button>
                      {hasSession && (
                        <button type="button" className="ti-link-btn" onClick={() => onOpenSession(member.sessionId)}>
                          Session <ArrowUpRight size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="ti-roster">
        <div className="ti-roster-head">
          <h3>Roster</h3>
          <span className="quiet">{roster.active.length} active · {roster.finished.length} finished</span>
        </div>
        {roster.active.length > 0 ? (
          <div className="ti-roster-strip">
            {roster.active.map(renderMemberCard)}
          </div>
        ) : (
          <p className="quiet">No active agents in revision {team.revision}.</p>
        )}
        {roster.finished.length > 0 && (
          <>
            <button
              type="button"
              className="ti-finished-toggle"
              aria-expanded={showFinished}
              onClick={() => setShowFinished(previous => !previous)}
            >
              {showFinished ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              Finished ({roster.finished.length})
            </button>
            {showFinished && (
              <div className="ti-roster-strip">
                {roster.finished.map(renderMemberCard)}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
