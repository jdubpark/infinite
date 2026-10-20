import { ArrowUpRight } from "lucide-react";
import { ago, type LinearTrackingView } from "./api";

const labels: Record<LinearTrackingView["status"], string> = {
  pending: "Tracking pending", synced: "Issue checked", blocked: "Tracking blocked", error: "Tracking unavailable",
};
function issueLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
const date = (value: string) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function LinearTracking({ tracking, stale, compact = false }: { tracking?: LinearTrackingView; stale: boolean; compact?: boolean }) {
  if (!tracking) return null;
  const issue = tracking.issue;
  const href = issue && issueLink(issue.url);
  const checked = tracking.checkedAt && Number.isFinite(Date.parse(tracking.checkedAt)) ? tracking.checkedAt : undefined;
  return <section className={"linear-tracking " + (compact ? "compact " : "") + tracking.status} aria-label="Linear task tracking">
    <div className="linear-tracking-heading">
      <strong>Linear</strong>
      <span className="linear-tracking-status">{labels[tracking.status]}</span>
      {issue && (href ? <a href={href} target="_blank" rel="noopener noreferrer">{issue.identifier}<ArrowUpRight size={14} /></a> : <span>{issue.identifier}</span>)}
    </div>
    {issue && <>
      <p className="linear-issue-title">{issue.title}</p>
      <p className="linear-workflow">Linear workflow state: <strong>{issue.state.name}</strong></p>
    </>}
    {tracking.reason && <p className="linear-tracking-reason" role="status">{tracking.reason}</p>}
    <p className="linear-freshness" role="status">{checked ? <>Last checked <time dateTime={checked} title={date(checked)}>{ago(checked)}</time></> : "No check recorded."}{stale && " · Showing cached host data."}</p>
    {!compact && <>
      <p className="linear-tracking-note">Linear workflow state is separate from execution and product outcomes. Infinite does not change that state automatically.</p>
      {issue?.description && <details><summary>Issue description</summary><p className="team-prose">{issue.description}</p></details>}
    </>}
  </section>;
}
