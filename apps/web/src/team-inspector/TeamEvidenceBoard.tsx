import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { clock, useApi, type Me, type Session } from "../api";
import { useLiveRefresh } from "../live-refresh";
import type { TeamMember, TeamView } from "../teams";
import {
  buildSupersessionIndex,
  entryAuthorityMeta,
  filterEntries,
  inspectorRoleLabel,
  mergeEntryPage,
  type EntryFilter,
} from "./model";
import { TEAM_ENTRY_KINDS, type TeamEntryDetail, type TeamEntryHead, type TeamEntryKind, type TeamEntryPage } from "./types";

type TeamEvidenceBoardProps = {
  team: TeamView;
  me: Me;
  fresh: boolean;
  sessions: Session[];
  selectedEntryId: string | null;
  memberFilter: string;
  onMemberFilterChange: (memberId: string) => void;
  onSelectEntry: (entryId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  onViewMemberLogs: (memberId: string) => void;
};

const shortTime = (iso: string) => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : clock(iso);
};

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value, null, 2);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function EntryBodyView({ detail }: { detail: TeamEntryDetail }) {
  const body = asRecord(detail.body);
  if (!body) return <pre className="ti-pre">{renderValue(detail.body)}</pre>;

  const commandObj = asRecord(body.command);
  const commandText = commandObj
    ? [String(commandObj.command ?? ""), ...(Array.isArray(commandObj.args) ? commandObj.args.map(String) : [])].filter(Boolean).join(" ")
    : undefined;
  const changedPathsObj = asRecord(body.changedPaths);
  const changedPaths = changedPathsObj && Array.isArray(changedPathsObj.paths) ? changedPathsObj.paths.map(String) : null;
  const reportObj = asRecord(body.report);
  const acceptance = reportObj && Array.isArray(reportObj.acceptance) ? reportObj.acceptance : null;
  const headCommit = typeof body.headCommit === "string" ? body.headCommit : typeof body.commit === "string" ? body.commit : undefined;
  const summaryText = typeof reportObj?.summary === "string" ? reportObj.summary : typeof body.summary === "string" ? body.summary : undefined;
  const uiEvidence = typeof reportObj?.uiEvidence === "string" ? reportObj.uiEvidence : typeof body.uiEvidence === "string" ? body.uiEvidence : undefined;
  const verdict = typeof reportObj?.verdict === "string" ? reportObj.verdict : typeof body.verdict === "string" ? body.verdict : undefined;
  const outputText = typeof body.output === "string" ? body.output : undefined;
  const questionText = typeof body.question === "string" ? body.question : typeof reportObj?.question === "string" ? reportObj.question : undefined;
  const answerOrSteering = typeof body.text === "string" ? body.text : undefined;
  const doneList = Array.isArray(body.done) ? body.done.map(String) : null;
  const remainingList = Array.isArray(body.remaining) ? body.remaining.map(String) : null;
  const commandsList = Array.isArray(body.commands) ? body.commands.map(String) : null;
  const itemsList = Array.isArray(body.items) ? body.items : null;
  const causeObj = asRecord(body.cause);

  return (
    <div className="ti-body-block">
      <dl className="ti-kv">
        {commandText && <><dt>Command</dt><dd><code>{commandText}</code></dd></>}
        {typeof body.status === "string" && <><dt>Status</dt><dd>{body.status}</dd></>}
        {body.exitCode !== undefined && <><dt>Exit code</dt><dd>{String(body.exitCode)}</dd></>}
        {typeof body.round === "number" && <><dt>Round</dt><dd>{body.round}</dd></>}
        {verdict && <><dt>Verdict</dt><dd>{verdict}</dd></>}
        {headCommit && <><dt>Commit</dt><dd><code>{headCommit}</code></dd></>}
        {typeof body.taskId === "string" && <><dt>Task</dt><dd><code>{body.taskId}</code></dd></>}
        {typeof body.interface === "string" && <><dt>Interface</dt><dd>{body.interface}</dd></>}
        {typeof body.change === "string" && <><dt>Change</dt><dd>{body.change}</dd></>}
        {questionText && <><dt>Question</dt><dd>{questionText}</dd></>}
        {answerOrSteering && <><dt>{body.source === "answer" ? "Answer" : "Direction"}</dt><dd>{answerOrSteering}</dd></>}
      </dl>

      {summaryText && (
        <div className="ti-body-block">
          <h4>Summary</h4>
          <p className="team-prose">{summaryText}</p>
        </div>
      )}

      {uiEvidence && (
        <div className="ti-body-block">
          <h4>Reviewer UI evidence</h4>
          <p className="team-prose">{uiEvidence}</p>
        </div>
      )}

      {changedPaths && changedPaths.length > 0 && (
        <div className="ti-body-block">
          <h4>Changed paths{changedPathsObj?.truncated ? " (truncated)" : ""}</h4>
          <ul className="ti-body-list">
            {changedPaths.map(path => <li key={path}><code>{path}</code></li>)}
          </ul>
        </div>
      )}

      {acceptance && acceptance.length > 0 && (
        <div className="ti-body-block">
          <h4>Reviewer acceptance claims</h4>
          <ul className="ti-body-list">
            {acceptance.map((raw, index) => {
              const row = asRecord(raw);
              if (!row) return <li key={index}>{renderValue(raw)}</li>;
              return (
                <li key={index}>
                  Criterion {String(row.criterion ?? index + 1)}: <strong>{String(row.verdict ?? "unknown")}</strong> — {String(row.evidence ?? "")}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {causeObj && (
        <div className="ti-body-block">
          <h4>Cause ({String(causeObj.status ?? "unknown")})</h4>
          <p className="team-prose">{String(causeObj.detail ?? "")}</p>
          {typeof body.proposedRecovery === "string" && <p className="team-prose">Proposed recovery: {body.proposedRecovery}</p>}
          {typeof body.prevention === "string" && <p className="team-prose">Prevention: {body.prevention}</p>}
        </div>
      )}

      {itemsList && itemsList.length > 0 && (
        <div className="ti-body-block">
          <h4>Findings</h4>
          <ul className="ti-body-list">
            {itemsList.map((raw, index) => {
              const item = asRecord(raw);
              return item
                ? <li key={index}><code>{String(item.source ?? "")}</code>: {String(item.observation ?? "")}</li>
                : <li key={index}>{renderValue(raw)}</li>;
            })}
          </ul>
        </div>
      )}

      {doneList && doneList.length > 0 && (
        <div className="ti-body-block">
          <h4>Done</h4>
          <ul className="ti-body-list">{doneList.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </div>
      )}

      {remainingList && remainingList.length > 0 && (
        <div className="ti-body-block">
          <h4>Remaining</h4>
          <ul className="ti-body-list">{remainingList.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </div>
      )}

      {commandsList && commandsList.length > 0 && (
        <div className="ti-body-block">
          <h4>Commands</h4>
          <ul className="ti-body-list">{commandsList.map((item, index) => <li key={index}><code>{item}</code></li>)}</ul>
        </div>
      )}

      {outputText !== undefined && (
        <div className="ti-body-block">
          <h4>Output</h4>
          <pre className="ti-pre">{outputText || "No output recorded."}</pre>
        </div>
      )}

      <details>
        <summary className="quiet">Raw entry payload</summary>
        <pre className="ti-pre">{JSON.stringify(detail.body, null, 2)}</pre>
      </details>
    </div>
  );
}

export function TeamEvidenceBoard({
  team,
  me,
  fresh,
  sessions,
  selectedEntryId,
  memberFilter,
  onMemberFilterChange,
  onSelectEntry,
  onOpenSession,
  onViewMemberLogs,
}: TeamEvidenceBoardProps) {
  const api = useApi();
  const [entries, setEntries] = useState<TeamEntryHead[]>([]);
  const [cursor, setCursor] = useState(0);
  const [more, setMore] = useState(false);
  const [listError, setListError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [follow, setFollow] = useState(!selectedEntryId);
  const [kindFilter, setKindFilter] = useState<TeamEntryKind | "all">("all");
  const [taskFilter, setTaskFilter] = useState("all");
  const [revisionFilter, setRevisionFilter] = useState<number | "all">("all");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<TeamEntryDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(0);
  const moreRef = useRef(false);
  const followRef = useRef(follow);
  cursorRef.current = cursor;
  moreRef.current = more;
  followRef.current = follow;

  useEffect(() => {
    setEntries([]);
    setCursor(0);
    setMore(false);
    setListError("");
    setDetail(null);
    setDetailError("");
  }, [team.id]);

  const feed = useLiveRefresh(async current => {
    try {
      const page = await api<TeamEntryPage>(`/teams/${team.id}/entries?limit=50`);
      if (!current()) return;
      let latestCursor = page.cursor;
      let hasMore = page.more;
      let accumulated = [page];
      if (followRef.current) {
        let hops = 0;
        while (hasMore && hops < 5) {
          const next = await api<TeamEntryPage>(`/teams/${team.id}/entries?limit=50&since=${latestCursor}`);
          if (!current()) return;
          accumulated.push(next);
          if (next.cursor <= latestCursor) { hasMore = false; break; }
          latestCursor = next.cursor;
          hasMore = next.more;
          hops += 1;
        }
      } else if (moreRef.current && cursorRef.current > page.cursor) {
        const next = await api<TeamEntryPage>(`/teams/${team.id}/entries?limit=50&since=${cursorRef.current}`);
        if (!current()) return;
        accumulated.push(next);
        latestCursor = next.cursor;
        hasMore = next.more;
      }
      setEntries(previous => accumulated.reduce((acc, nextPage) => mergeEntryPage(acc, nextPage), previous));
      setCursor(latestCursor);
      setMore(hasMore);
      setListError("");
    } catch (error) {
      if (current()) setListError((error as Error).message);
      throw error;
    }
  }, 2000, team.id);

  async function loadMore() {
    if (loadingMore || !more) return;
    setLoadingMore(true);
    try {
      const page = await api<TeamEntryPage>(`/teams/${team.id}/entries?limit=50&since=${cursor}`);
      setEntries(previous => mergeEntryPage(previous, page));
      setCursor(page.cursor);
      setMore(page.more);
      setListError("");
    } catch (error) {
      setListError((error as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  const filter: EntryFilter = {
    kind: kindFilter,
    taskId: taskFilter,
    memberId: memberFilter,
    revision: revisionFilter,
    query,
  };
  const filteredEntries = useMemo(() => filterEntries(entries, filter), [entries, kindFilter, taskFilter, memberFilter, revisionFilter, query]);
  const supersessionIndex = useMemo(() => buildSupersessionIndex(entries), [entries]);

  useEffect(() => {
    if (!filteredEntries.length) return;
    if (follow) {
      const latest = filteredEntries[filteredEntries.length - 1]!;
      if (selectedEntryId !== latest.entryId) onSelectEntry(latest.entryId);
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    } else if (!selectedEntryId) {
      onSelectEntry(filteredEntries[filteredEntries.length - 1]!.entryId);
    }
  }, [filteredEntries, follow, selectedEntryId, onSelectEntry]);

  useEffect(() => {
    if (!selectedEntryId) {
      setDetail(null);
      setDetailError("");
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    api<TeamEntryDetail>(`/teams/${team.id}/entries/${selectedEntryId}`)
      .then(result => {
        if (!active) return;
        setDetail(result);
        setEntries(previous => mergeEntryPage(previous, { entries: [result.head], cursor: result.head.seq, more: false }));
      })
      .catch(error => {
        if (active) setDetailError((error as Error).message);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [api, team.id, selectedEntryId]);

  const membersById = useMemo(() => new Map<string, TeamMember>(team.members.map(member => [member.memberId, member])), [team.members]);
  const taskOptions = useMemo(() => {
    const ids = new Set<string>(team.tasks.map(task => task.id));
    for (const entry of entries) if (entry.taskId) ids.add(entry.taskId);
    return [...ids].sort();
  }, [team.tasks, entries]);
  const revisionOptions = useMemo(() => {
    const revisions = new Set<number>([team.revision]);
    for (const entry of entries) revisions.add(entry.revision);
    return [...revisions].sort((a, b) => b - a);
  }, [team.revision, entries]);

  const selectedHead = detail?.head.entryId === selectedEntryId
    ? detail.head
    : entries.find(entry => entry.entryId === selectedEntryId) ?? null;
  const selectedMember = selectedHead?.authorMemberId ? membersById.get(selectedHead.authorMemberId) : undefined;
  const supersededBy = selectedHead ? supersessionIndex.get(selectedHead.entryId) ?? [] : [];
  const supersedesHead = selectedHead?.supersedes ? entries.find(entry => entry.entryId === selectedHead.supersedes) : undefined;
  const sessionIds = useMemo(() => new Set(sessions.map(session => session.id)), [sessions]);

  async function withdrawSelected() {
    if (!selectedHead || withdrawing || me.role !== "owner" || !fresh || selectedHead.state === "withdrawn") return;
    if (!window.confirm("Withdraw this blackboard entry? Its history remains visible as withdrawn.")) return;
    setWithdrawing(true);
    setWithdrawError("");
    try {
      await api<{ entryId: string; state: string; changed: boolean }>(
        `/teams/${team.id}/entries/${selectedHead.entryId}/withdraw`,
        { requestId: crypto.randomUUID() },
      );
      const updated = await api<TeamEntryDetail>(`/teams/${team.id}/entries/${selectedHead.entryId}`);
      setDetail(updated);
      setEntries(previous => mergeEntryPage(previous, { entries: [updated.head], cursor: updated.head.seq, more: false }));
      feed.refresh();
    } catch (error) {
      setWithdrawError((error as Error).message);
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <section className="ti-board" aria-label="Evidence blackboard">
      <div className="ti-overview-head">
        <h2>Blackboard</h2>
        <span className="quiet" role="status">
          {feed.stale ? "Showing last received entries" : `${filteredEntries.length} of ${entries.length} entries`}
        </span>
      </div>

      <div className="ti-board-toolbar">
        <select aria-label="Filter by kind" value={kindFilter} onChange={event => setKindFilter(event.target.value as TeamEntryKind | "all")}>
          <option value="all">All kinds</option>
          {TEAM_ENTRY_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>

        <select aria-label="Filter by task" value={taskFilter} onChange={event => setTaskFilter(event.target.value)}>
          <option value="all">All tasks</option>
          {taskOptions.map(taskId => <option key={taskId} value={taskId}>{taskId}</option>)}
        </select>

        <select aria-label="Filter by member" value={memberFilter} onChange={event => onMemberFilterChange(event.target.value)}>
          <option value="all">All members</option>
          {team.members.map(member => (
            <option key={member.memberId} value={member.memberId}>
              {inspectorRoleLabel(member.role)} · r{member.revision}{member.taskId ? ` · ${member.taskId}` : ""}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by revision"
          value={revisionFilter === "all" ? "all" : String(revisionFilter)}
          onChange={event => setRevisionFilter(event.target.value === "all" ? "all" : Number(event.target.value))}
        >
          <option value="all">All revisions</option>
          {revisionOptions.map(revision => <option key={revision} value={String(revision)}>Revision {revision}</option>)}
        </select>

        <input
          type="search"
          aria-label="Search entries"
          placeholder="Search summary, commit, path…"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />

        <button
          type="button"
          className="ti-follow-btn"
          aria-pressed={follow}
          onClick={() => setFollow(previous => !previous)}
        >
          Follow: {follow ? "on" : "off"}
        </button>
      </div>

      {listError && <p className="error" role="alert">{listError}</p>}

      <div className="ti-board-split">
        <div className="ti-entry-list" ref={listRef} role="listbox" aria-label="Blackboard entries">
          {filteredEntries.map(entry => {
            const meta = entryAuthorityMeta(entry.authority);
            const authorMember = entry.authorMemberId ? membersById.get(entry.authorMemberId) : undefined;
            const authorName = authorMember
              ? inspectorRoleLabel(authorMember.role)
              : entry.authorRole
                ? inspectorRoleLabel(entry.authorRole)
                : entry.author === "owner" ? "Owner" : "Host";
            return (
              <button
                type="button"
                role="option"
                key={entry.entryId}
                aria-selected={entry.entryId === selectedEntryId}
                className={`ti-entry-row${entry.state === "withdrawn" ? " is-withdrawn" : ""}`}
                onClick={() => {
                  setFollow(false);
                  onSelectEntry(entry.entryId);
                }}
              >
                <div className="ti-entry-row-meta">
                  <span className="ti-entry-seq" title="Global monotonic blackboard sequence">seq {entry.seq}</span>
                  <span>{shortTime(entry.at)}</span>
                  <span className={`ti-pill is-${meta.tone}`} title={meta.description}>{meta.label}</span>
                  <span className="ti-pill">{entry.kind}</span>
                  {entry.state !== "active" && <span className={`ti-pill is-${entry.state}`}>{entry.state}</span>}
                  <span>{authorName}</span>
                  {entry.taskId && <span>{entry.taskId}</span>}
                  <span>r{entry.revision}</span>
                  {entry.headCommit && <code className="ti-entry-commit">{entry.headCommit.slice(0, 7)}</code>}
                </div>
                <span className="ti-entry-summary">{entry.summary}</span>
              </button>
            );
          })}
          {!filteredEntries.length && (
            <p className="quiet" style={{ padding: "16px" }}>
              {entries.length ? "No entries match the current filters." : "No blackboard entries recorded for this run yet."}
            </p>
          )}
          {more && (
            <div className="ti-load-more">
              <button type="button" className="ti-link-btn" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>

        <div className="ti-entry-detail" aria-live="polite">
          {!selectedEntryId ? (
            <p className="quiet">Select an entry to inspect its recorded payload and links.</p>
          ) : detailError ? (
            <p className="error" role="alert">{detailError}</p>
          ) : !selectedHead ? (
            <p className="quiet">Loading entry…</p>
          ) : (
            <>
              <div className="ti-detail-head">
                <div className="ti-detail-title-row">
                  <h3>
                    <span className="ti-entry-seq" title="Global monotonic blackboard sequence">seq {selectedHead.seq}</span> · {selectedHead.kind}
                  </h3>
                  <div className="ti-detail-actions">
                    <span className={`ti-pill is-${entryAuthorityMeta(selectedHead.authority).tone}`}>
                      {entryAuthorityMeta(selectedHead.authority).label}
                    </span>
                    {selectedHead.state !== "active" && (
                      <span className={`ti-pill is-${selectedHead.state}`}>{selectedHead.state}</span>
                    )}
                  </div>
                </div>
                <div className="ti-entry-row-meta">
                  <span>{shortTime(selectedHead.at)}</span>
                  <span>Revision {selectedHead.revision}</span>
                  {selectedHead.taskId && <span>Task {selectedHead.taskId}</span>}
                  {selectedHead.headCommit && <code className="ti-entry-commit">{selectedHead.headCommit.slice(0, 7)}</code>}
                  <span>{selectedHead.bodyBytes} B</span>
                </div>
                <div className="ti-detail-actions">
                  {selectedMember && (
                    <>
                      <button type="button" className="ti-link-btn" onClick={() => onViewMemberLogs(selectedMember.memberId)}>
                        View agent logs
                      </button>
                      {Boolean(selectedMember.sessionId) && (
                        <button type="button" className="ti-link-btn" disabled={!sessionIds.has(selectedMember.sessionId)} onClick={() => onOpenSession(selectedMember.sessionId)}>
                          Open session <ArrowUpRight size={12} />
                        </button>
                      )}
                    </>
                  )}
                  {selectedHead.supersedes && (
                    <button
                      type="button"
                      className="ti-link-btn"
                      onClick={() => {
                        setFollow(false);
                        onSelectEntry(selectedHead.supersedes!);
                      }}
                    >
                      Supersedes {supersedesHead ? `seq ${supersedesHead.seq}` : selectedHead.supersedes.slice(0, 8)}
                    </button>
                  )}
                  {supersededBy.map(newer => (
                    <button
                      type="button"
                      key={newer.entryId}
                      className="ti-link-btn"
                      onClick={() => {
                        setFollow(false);
                        onSelectEntry(newer.entryId);
                      }}
                    >
                      Superseded by seq {newer.seq}
                    </button>
                  ))}
                  {me.role === "owner" && selectedHead.state !== "withdrawn" && (
                    <button
                      type="button"
                      className="ti-danger-btn"
                      disabled={!fresh || withdrawing}
                      onClick={() => void withdrawSelected()}
                    >
                      {withdrawing ? "Withdrawing…" : "Withdraw entry"}
                    </button>
                  )}
                </div>
                {withdrawError && <p className="error" role="alert">{withdrawError}</p>}
              </div>

              {detailLoading && (!detail || detail.head.entryId !== selectedHead.entryId) ? (
                <p className="quiet">Loading entry body…</p>
              ) : detail && detail.head.entryId === selectedHead.entryId ? (
                <EntryBodyView detail={detail} />
              ) : (
                <p className="quiet">{selectedHead.summary}</p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
