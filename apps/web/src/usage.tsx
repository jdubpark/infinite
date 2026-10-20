import { type Me, type UsageTotals, type TeamUsage } from "./api";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
/** Mirrors formatUsd in the host: four decimals below one cent, "0.00" only for a true zero. */
const amount = (usd: number) => usd === 0 ? "0.00" : usd >= 0.01 ? usd.toFixed(2) : usd < 0.0001 ? "<0.0001" : usd.toFixed(4);
/** Fully unpriced totals carry no figure; partly unpriced ones are a lower bound. */
export const cost = (totals: UsageTotals) => totals.messages > 0 && totals.pricing.unknown === totals.messages ? "No price available"
  : (totals.pricing.unknown > 0 ? "At least " : "") + amount(totals.cost) + " USD";

/** Where each figure comes from: a configured price, the cost OpenCode reported, or no price at all. */
export function usageProvenance(totals: UsageTotals): string {
  const { configured, provider, unknown } = totals.pricing;
  const sources = [configured && `${configured} configured price`, provider && `${provider} reported by OpenCode`].filter(Boolean).join(", ");
  return [plural(totals.messages, "step") + (sources ? ` (${sources})` : ""), unknown ? `${plural(unknown, "step")} unpriced` : ""].filter(Boolean).join(" · ");
}

/** Cost with its provenance. A total with unpriced steps says so rather than presenting a complete figure. */
export function UsageFigure({ usage }: { usage?: UsageTotals }) {
  if (!usage) return <span className="quiet">Unmeasured</span>;
  return <span>{cost(usage)} <span className="quiet">· {usageProvenance(usage)}</span></span>;
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
