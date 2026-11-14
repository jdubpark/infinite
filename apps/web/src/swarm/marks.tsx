import { ROLE_NAME, STATE_LABEL, type AgentState, type RoleCode } from "./types";

/**
 * One mark per agent state. Shape and colour carry the state together, so the
 * picture still reads without colour. Colours come from `--sw-*` variables in swarm.css.
 */
export function StateMark({ state, size = 14, pulse = false, title }: { state: AgentState; size?: number; pulse?: boolean; title?: string }) {
  const label = title ?? STATE_LABEL[state];
  return <svg className={`sw-mark sw-mark-${state}${pulse && state === "working" ? " sw-pulse" : ""}`} width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
    <title>{label}</title>
    {state === "working" && <><circle className="sw-mark-ring" cx="8" cy="8" r="7" /><circle cx="8" cy="8" r="4.5" fill="currentColor" /></>}
    {state === "waiting" && <><circle cx="8" cy="8" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 3.25a4.75 4.75 0 0 0 0 9.5z" fill="currentColor" /></>}
    {state === "needs-you" && <><circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="4.25" fill="currentColor" /><path className="sw-mark-cut" d="M8 5.4v3M8 10.3v.3" strokeWidth="1.4" strokeLinecap="round" /></>}
    {state === "in-review" && <><circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="3" fill="currentColor" /></>}
    {state === "queued" && <circle cx="8" cy="8" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.2" />}
    {state === "reported" && <circle cx="8" cy="8" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />}
    {state === "stopped" && <rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" />}
    {state === "fault" && <path d="M8 2.5 13.5 8 8 13.5 2.5 8z" fill="currentColor" />}
  </svg>;
}

/** Two-letter role code in the monospace face. */
export function RoleChip({ role }: { role: RoleCode }) {
  return <abbr className="sw-role" title={ROLE_NAME[role]}>{role}</abbr>;
}

/** The accessible name of an agent mark: role, state, and the tool in flight when there is one. */
export function agentName(agent: { role: RoleCode; state: AgentState; tool?: string; earlier?: boolean; limited?: boolean; stalled?: boolean }) {
  return [ROLE_NAME[agent.role], STATE_LABEL[agent.state], agent.tool ? `tool ${agent.tool}` : "", agent.earlier ? "earlier revision" : "",
    agent.limited ? "provider limit" : "", agent.stalled ? "stalled" : ""].filter(Boolean).join(", ");
}
