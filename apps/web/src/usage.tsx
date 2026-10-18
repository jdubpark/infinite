import { useEffect, useState } from "react";
import { useApi, type Me, type UsageSummary, type UsageTotals, type TeamUsage } from "./api";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const money = (usd: number) => usd.toFixed(2) + " USD";
const day = (value: string) => new Date(value).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

/** Where each figure comes from: a configured price, the cost OpenCode reported, or no price at all. */
export function usageProvenance(totals: UsageTotals): string {
  const { configured, provider, unknown } = totals.pricing;
  const sources = [configured && `${configured} configured price`, provider && `${provider} reported by OpenCode`].filter(Boolean).join(", ");
  return [plural(totals.messages, "step") + (sources ? ` (${sources})` : ""), unknown ? `${plural(unknown, "step")} unpriced` : ""].filter(Boolean).join(" · ");
}

/** Cost with its provenance. A total with unpriced steps says so rather than presenting a complete figure. */
export function UsageFigure({ usage }: { usage?: UsageTotals }) {
  if (!usage) return <span className="quiet">Unmeasured</span>;
  return <span>{money(usage.cost)} <span className="quiet">· {usageProvenance(usage)}</span></span>;
}

export const usageEnabled = (me: Me) => me.usage?.enabled === true;

/** Cost rollup for a team run or goal. Unmeasured members are counted, never priced at zero. */
export function UsageRollup({ me, usage, heading }: { me: Me; usage?: TeamUsage; heading: string }) {
  if (!usageEnabled(me) || !usage) return null;
  const profiles = Object.entries(usage.byProfile), providers = Object.entries(usage.byProvider).flatMap(([name, totals]) => totals ? [[name, totals] as const] : []);
  return <section className="team-section"><h2>{heading}</h2>
    <p><UsageFigure usage={usage.total.messages || usage.unmeasuredMembers === 0 ? usage.total : undefined} /></p>
    {usage.unmeasuredMembers > 0 && <p className="quiet">{plural(usage.unmeasuredMembers, "member")} unmeasured. Only OpenCode team members report usage, and their totals exclude unmeasured members.</p>}
    {(profiles.length > 0 || providers.length > 0) && <details><summary>Breakdown</summary><dl className="team-output">
      {providers.map(([name, totals]) => <FragmentRow key={"p/" + name} label={names(name)} usage={totals} />)}
      {profiles.map(([name, totals]) => <FragmentRow key={"m/" + name} label={"Profile " + name} usage={totals} />)}
    </dl></details>}
  </section>;
}
const names = (value: string) => value === "opencode" ? "OpenCode" : value;
function FragmentRow({ label, usage }: { label: string; usage: UsageTotals }) { return <><dt>{label}</dt><dd><UsageFigure usage={usage} /></dd></>; }

/** One row per provider. Each row is labelled from that provider's own window and budget period. */
export function SpendBlock({ me }: { me: Me }) {
  const api = useApi();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const enabled = usageEnabled(me);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<UsageSummary>("/usage").then(value => { if (live) { setSummary(value); setFailed(false); } }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, enabled]);
  if (!enabled) return null;
  return <section className="team-section"><div className="team-section-heading"><h2>Spend</h2><span className="quiet">Informational. Budgets never stop or hide work.</span></div>
    {failed && <p className="quiet" role="status">Usage could not be loaded.</p>}
    {!summary && !failed && <p className="quiet">Loading usage…</p>}
    {summary && <dl className="team-output">{Object.entries(summary.providers).map(([name, entry]) => {
      const period = entry.budget?.period, over = entry.spent && entry.budget && entry.spent.cost > entry.budget.usd;
      return <FragmentProvider key={name} name={names(name)}>
        {!entry.measured || !entry.spent ? <span className="quiet">Unmeasured{entry.unmeasuredSessions ? ` · ${plural(entry.unmeasuredSessions, "session")}` : ""}</span>
          : <span>{entry.spent.cost.toFixed(2)}{entry.budget ? ` / ${entry.budget.usd.toFixed(2)}` : ""} USD{over && <strong> · over budget</strong>} <span className="quiet">· {period ? `${period} budget, ` : ""}{day(entry.period.start)} to {day(new Date(Date.parse(entry.period.end) - 1).toISOString())} UTC · {usageProvenance(entry.spent)}{entry.unmeasuredSessions ? ` · ${plural(entry.unmeasuredSessions, "session")} unmeasured` : ""}</span></span>}
      </FragmentProvider>;
    })}</dl>}
  </section>;
}
function FragmentProvider({ name, children }: { name: string; children: React.ReactNode }) { return <><dt>{name}</dt><dd>{children}</dd></>; }
