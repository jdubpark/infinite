import { OctagonPause } from "lucide-react";
import { haltSince, type HaltNotice, type HaltState, type ProjectHalt } from "./halt";

const HELD = "No new team, goal, mission, or routine work starts";
const KEPT = "Sessions started directly keep running.";

const since = (halt: HaltState) => `Since ${haltSince(halt.at)} · from ${halt.by}`;

/**
 * The owner's halt over the current screen. Information only: the owner releases a halt with `infinite halt off`.
 * It keeps the last received state through a failed poll and stays dense, so a session record keeps its room.
 */
export function HaltBanner({ notice, name, owner, compact = false, className = "" }: {
  notice: HaltNotice | null; name: (projectId: string) => string; owner: boolean; compact?: boolean; className?: string;
}) {
  if (!notice) return null;
  // A narrow list keeps its rows: a compact host halt says what is held, since when, and why, without the explanation.
  if (compact && (notice.kind === "host" || notice.kind === "unreadable")) return <div className={`halt-banner halt-compact ${className}`} role="status">
    <OctagonPause size={16} aria-hidden="true" />
    {notice.kind === "host"
      ? <p><strong>Halted by the owner for the whole host</strong><span className="halt-compact-item">since {haltSince(notice.halt.at)}{notice.halt.reason ? ` · ${notice.halt.reason}` : ""}</span></p>
      : <p><strong>Halted: the host cannot read its halt record</strong><span className="halt-compact-item">It holds every launch until it can.</span></p>}
  </div>;
  if (notice.kind === "overview") return <div className={`halt-banner halt-compact ${className}`} role="status">
    <OctagonPause size={16} aria-hidden="true" />
    <p><strong>Halted by the owner</strong>{notice.halts.map(halt => <span key={halt.haltId} className="halt-compact-item">
      <b>{name(halt.projectId)}</b> since {haltSince(halt.at)}{halt.reason ? ` · ${halt.reason}` : ""}
    </span>)}</p>
  </div>;
  const halts: (HaltState | ProjectHalt)[] = notice.kind === "host" ? [notice.halt] : notice.kind === "project" ? notice.halts : [];
  const title = notice.kind === "unreadable" ? "Halted: the host cannot read its halt record"
    : notice.kind === "host" ? "Halted by the owner for the whole host"
      : notice.halts.length === 1 ? "Halted by the owner for this project"
        : `Halted by the owner for ${notice.halts.map(halt => name(halt.projectId)).join(", ")}`;
  return <div className={`halt-banner ${className}`} role="status">
    <OctagonPause size={18} aria-hidden="true" />
    <div className="halt-body">
      <p className="halt-title"><strong>{title}</strong>{halts.length === 1 && <span className="halt-meta">{since(halts[0])}</span>}</p>
      {halts.length > 1 && halts.map(halt => <p key={halt.haltId} className="halt-meta">{"projectId" in halt ? `${name(halt.projectId)} · ` : ""}{since(halt)}</p>)}
      {halts.filter(halt => halt.reason).map(halt => <p key={halt.haltId} className="halt-reason"><span>Reason</span>{halt.reason}</p>)}
      <p className="halt-note">
        {notice.kind === "unreadable" ? "It holds every launch until it can read the record again, and checks again every minute."
          : notice.kind === "host" ? `${HELD}, and running goals and missions stay paused. ${KEPT}`
            : `${HELD} ${notice.halts.length === 1 ? "in this project, and its" : "in these projects, and their"} running goals and missions stay paused. ${KEPT}`}
        {notice.kind === "host" && notice.projects.length > 0 && ` Also halted on their own: ${notice.projects.map(halt => name(halt.projectId)).join(", ")}; releasing the host halt leaves ${notice.projects.length === 1 ? "it" : "them"} halted.`}
        {owner && notice.kind !== "unreadable" && <span className="halt-release"> Release it with {(notice.kind === "host" ? ["--host"] : notice.halts.map(halt => `--project ${halt.projectId}`)).map((flag, index) => <span key={flag}>{index ? ", " : ""}<code>infinite halt off {flag}</code></span>)}.</span>}
      </p>
    </div>
  </div>;
}
