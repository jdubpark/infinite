import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, ChevronRight, Minus, Pencil, RefreshCw, Star } from "lucide-react";
import { ago, names, useApi, type AccountView, type Me, type Money, type ModelRow, type OwnerRating, type Scorecard, type TaskUsage, type UsageDaily, type UsageProject, type UsageProjectRow, type UsageSummary } from "./api";
import { useMachines } from "./machines";
import { useLiveRefresh } from "./live-refresh";
import type { CostView } from "./session-navigation";

// Day buckets follow the viewer's clock; the host receives the zone with every series request.
export const viewerZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const zone = encodeURIComponent(viewerZone);
const SERIES = 6;
const seriesColor = (index: number) => `var(--series-${(index % SERIES) + 1})`;
// Account colours are fixed per id on every client, so filtering never repaints a survivor. Same rule as the Mac AccountPalette.
const FIXED_ACCOUNT_COLORS: Record<string, string> = { deepseek: "#3987E5", meta: "#C98500", claude: "#9085E9", codex: "#199E70" };
const ACCOUNT_SLOTS = ["#3987E5", "#C98500", "#9085E9", "#199E70", "#D95926"];
export function accountPalette(ids: string[]): Record<string, string> {
  const present = [...new Set(ids)];
  const taken = new Set(present.flatMap(id => FIXED_ACCOUNT_COLORS[id] ? [FIXED_ACCOUNT_COLORS[id]] : []));
  const free = ACCOUNT_SLOTS.filter(color => !taken.has(color));
  const colors: Record<string, string> = {};
  for (const id of present) if (FIXED_ACCOUNT_COLORS[id]) colors[id] = FIXED_ACCOUNT_COLORS[id];
  for (const id of present.filter(id => !FIXED_ACCOUNT_COLORS[id]).sort()) colors[id] = free.shift() ?? "var(--muted)";
  return colors;
}
const accountName = (id: string) => names[id] ?? ({ deepseek: "DeepSeek", meta: "Meta", openai: "OpenAI", anthropic: "Anthropic" } as Record<string, string>)[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
const roles = ["implementer", "integrator", "reviewer", "scout", "project-manager", "delivery"];
const roleLabel: Record<string, string> = { implementer: "Implementers", integrator: "Integrator", reviewer: "Reviewer", scout: "Scouts", "project-manager": "Coordinator", delivery: "Delivery" };

/** Dollars at the precision the figure deserves: cents from one cent, four places below it, "0.00" only for a true zero. */
export function usd(value: number, currency = "USD"): string {
  const sign = value < 0 ? "−" : "", abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs >= 1000 ? 0 : abs >= 0.01 ? 2 : 4;
  const figure = abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency === "USD" ? `${sign}$${figure}` : `${sign}${figure} ${currency}`;
}
/** Axis and sparkline figures: short, no trailing zeros. */
const compact = (value: number) => value >= 1000 ? `$${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${Number(value.toFixed(1))}` : value >= 0.01 ? `$${Number(value.toFixed(2))}` : value > 0 ? `$${Number(value.toFixed(4))}` : "$0";
const tokens = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M` : value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : String(value);
const minutes = (value: number) => value >= 90 ? `${(value / 60).toFixed(1)} h` : `${Math.round(value)} min`;
const dayLabel = (date: string) => { const [y, m, d] = date.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric" }); };
const monthName = (iso: string, style: "long" | "short" = "long") => new Date(iso).toLocaleDateString([], { month: style, timeZone: "UTC" });

/**
 * A money figure that stays honest about what it could not count. Unpriced steps or unmeasured runs make a
 * non-zero figure a lower bound; a figure with nothing priced at all is "—", never $0. The marks are explained once, in the page legend.
 */
export function Amount({ money, value, currency, unmeasured = 0 }: { money?: Money; value?: number; currency?: string; unmeasured?: number }) {
  const amount = money ? money.usd : value ?? 0;
  const unpriced = money?.unpriced ?? 0;
  const gaps = [unpriced > 0 && `${unpriced} ${unpriced === 1 ? "step" : "steps"} without a price`, unmeasured > 0 && `${unmeasured} unmeasured`].filter(Boolean).join(" · ");
  if (amount === 0 && gaps) return <span className="cost-money cost-dash" title={gaps} aria-label={`no priced spend; ${gaps}`}>—</span>;
  const lower = Boolean(gaps);
  return <span className={"cost-money" + (lower ? " lower" : "")} title={lower ? gaps : undefined}>{lower && <span className="cost-ge" aria-label="at least">≥</span>}{usd(amount, currency)}</span>;
}
function Unmeasured({ count, word = "session" }: { count: number; word?: string }) {
  if (!count) return null;
  return <span className="cost-badge" title={`${count} ${word}${count === 1 ? "" : "s"} produced no usage data`}>{count} unmeasured</span>;
}
/** Explains every marker on the page, once. */
function MarkerLegend() {
  return <ul className="cost-markers" aria-label="How to read figures">
    <li><span className="cost-money lower">≥ $</span> some steps had no price; the figure is a lower bound</li>
    <li><span className="cost-badge">n unmeasured</span> runs without usage data, never counted as $0</li>
    <li><span className="cost-dash">—</span> no balance reported by the provider</li>
  </ul>;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
/** Three clean gridline steps that cover the largest value. */
function ticks(max: number): number[] {
  if (max <= 0) return [1, 2, 3];
  const raw = max / 3, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(unit => unit * power).find(unit => unit >= raw) ?? raw;
  return [step, step * 2, step * 3];
}
const roundedTop = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(4, h / 2, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
};

/** Thirty days stacked by account. Hover, tap, or focus a day to read it. */
function DailyBars({ daily, colors }: { daily: UsageDaily; colors: Record<string, string> }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [picked, setPicked] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const height = 190, top = 12, bottom = 24, left = 44, right = 6;
  const plotW = Math.max(0, width - left - right), plotH = height - top - bottom;
  const days = daily.days, count = days.length || 1;
  const max = Math.max(0, ...days.map(day => day.usd));
  const grid = ticks(max), topValue = grid[2];
  const slot = plotW / count, barW = Math.min(24, Math.max(3, slot - 3));
  const scale = (value: number) => topValue > 0 ? (value / topValue) * plotH : 0;
  const baseline = top + plotH;
  const hovered = picked === null ? null : days[picked];
  const labelEvery = slot >= 34 ? 3 : slot >= 18 ? 7 : 14;
  const empty = max === 0;
  const describe = (index: number) => {
    const day = days[index];
    const parts = daily.accounts.filter(account => day.byAccount[account] > 0).map(account => `${accountName(account)} ${usd(day.byAccount[account])}`);
    return `${dayLabel(day.date)}: ${usd(day.usd)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  };
  return <div className="cost-bars" ref={wrap} onMouseLeave={() => { if (!pinned) setPicked(null); }}>
    {width > 0 && <svg width={width} height={height} role="img" aria-label={`Daily metered spend for the last ${days.length} days, stacked by account`}>
      {grid.map(value => <g key={value}><line x1={left} x2={width - right} y1={baseline - scale(value)} y2={baseline - scale(value)} className="cost-grid" /><text x={left - 8} y={baseline - scale(value) + 3.5} className="cost-axis" textAnchor="end">{compact(value)}</text></g>)}
      <line x1={left} x2={width - right} y1={baseline} y2={baseline} className="cost-baseline" />
      {days.map((day, index) => {
        const x = left + slot * index + (slot - barW) / 2;
        let stacked = 0;
        const order = daily.accounts.map(account => ({ account, value: day.byAccount[account] ?? 0 })).filter(entry => entry.value > 0);
        return <g key={day.date}>
          {picked === index && <rect x={left + slot * index} y={top} width={slot} height={plotH} className="cost-band" />}
          {order.map((entry, position) => {
            const h = scale(entry.value), bottomY = baseline - stacked, gap = position === 0 ? 0 : Math.min(2, h);
            stacked += h;
            const y = bottomY - h, visible = h - gap;
            if (visible <= 0) return null;
            const last = position === order.length - 1;
            return last ? <path key={entry.account} d={roundedTop(x, y, barW, visible)} fill={colors[entry.account]} /> : <rect key={entry.account} x={x} y={y} width={barW} height={visible} fill={colors[entry.account]} />;
          })}
          {(index % labelEvery === 0 || index === days.length - 1) && (index === days.length - 1 || index + labelEvery / 2 < days.length) && <text x={left + slot * index + slot / 2} y={height - 7} className="cost-axis" textAnchor={index === days.length - 1 ? "end" : index === 0 ? "start" : "middle"}>{dayLabel(day.date)}</text>}
          <rect x={left + slot * index} y={top} width={slot} height={plotH} fill="transparent" tabIndex={0} aria-label={describe(index)} className="cost-hit"
            onMouseEnter={() => { if (!pinned) setPicked(index); }} onFocus={() => setPicked(index)} onBlur={() => { if (!pinned) setPicked(null); }}
            onClick={() => { if (pinned && picked === index) { setPinned(false); setPicked(null); } else { setPinned(true); setPicked(index); } }} />
        </g>;
      })}
    </svg>}
    {empty && <p className="cost-bars-empty quiet">No metered spend in this window.</p>}
    {hovered && picked !== null && <div className="cost-tip" role="status" style={{ left: Math.min(Math.max(0, left + slot * picked + slot / 2 - 80), Math.max(0, width - 170)) }}>
      <strong>{dayLabel(hovered.date)}</strong>
      <span className="cost-tip-total">{usd(hovered.usd)}</span>
      {daily.accounts.map(account => hovered.byAccount[account] > 0 && <span key={account} className="cost-tip-row"><i className="cost-swatch" style={{ background: colors[account] }} />{accountName(account)}<b>{usd(hovered.byAccount[account])}</b></span>)}
    </div>}
  </div>;
}
function SeriesLegend({ accounts, colors }: { accounts: string[]; colors: Record<string, string> }) {
  if (accounts.length < 2) return null;
  return <ul className="cost-legend">{accounts.map(account => <li key={account}><i className="cost-swatch" style={{ background: colors[account] }} />{accountName(account)}</li>)}</ul>;
}

/** A 30-point trend. One series, so the chart's row names it; no legend. */
export function Sparkline({ values, width = 104, height = 30, color = seriesColor(0) }: { values: number[]; width?: number; height?: number; color?: string }) {
  const max = Math.max(0, ...values);
  if (!values.length || max <= 0) return <span className="cost-spark-flat" aria-hidden="true" style={{ width }} />;
  const pad = 4, step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const points = values.map((value, index) => [pad + index * step, height - pad - (value / max) * (height - pad * 2)] as const);
  const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [endX, endY] = points[points.length - 1];
  return <svg className="cost-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Trend over ${values.length} days, peaking at ${usd(max)}`}>
    <path d={`${line} L${endX.toFixed(1)},${height - pad} L${pad},${height - pad} Z`} fill={color} opacity={0.1} />
    <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    <circle cx={endX} cy={endY} r={4.5} className="cost-ring" /><circle cx={endX} cy={endY} r={3} fill={color} />
  </svg>;
}
/** The integrated rate with its Wilson 95% interval on a 0–100% track. */
function IntervalBar({ row }: { row: ModelRow }) {
  const width = 120, height = 14, mid = height / 2;
  const x = (value: number) => 4 + value * (width - 8);
  const [low, high] = row.rateInterval ?? [row.rate, row.rate];
  return <svg className="cost-interval" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Integrated ${Math.round(row.rate * 100)}%, interval ${Math.round(low * 100)} to ${Math.round(high * 100)}%`}>
    <line x1={4} x2={width - 4} y1={mid} y2={mid} className="cost-track" strokeWidth={4} strokeLinecap="round" />
    <line x1={x(low)} x2={x(high)} y1={mid} y2={mid} stroke={seriesColor(0)} strokeOpacity={0.35} strokeWidth={6} strokeLinecap="round" />
    <circle cx={x(row.rate)} cy={mid} r={5.5} className="cost-ring" /><circle cx={x(row.rate)} cy={mid} r={4} fill={seriesColor(0)} />
  </svg>;
}
/** One proportional bar for where a project's money went, with its own legend. */
function KindBar({ byKind }: { byKind: UsageProject["byKind"] }) {
  const parts = [["goals", "Goals"], ["teams", "Teams"], ["sessions", "Sessions"], ["briefings", "Briefings"]] as const;
  const total = parts.reduce((sum, [key]) => sum + byKind[key], 0);
  const [wrap, width] = useWidth<HTMLDivElement>();
  let offset = 0;
  return <div className="cost-kinds">
    <div className="cost-kinds-bar" ref={wrap} role="img" aria-label={parts.map(([key, label]) => `${label} ${usd(byKind[key])}`).join(", ")}>
      {width > 0 && total > 0 && <svg width={width} height={10}>{parts.map(([key], index) => {
        const share = byKind[key] / total, w = Math.max(0, share * width - (index ? 2 : 0)), x = offset + (index ? 2 : 0);
        offset += share * width;
        return w > 0 ? <rect key={key} x={x} y={0} width={w} height={10} rx={2} fill={seriesColor(index)} /> : null;
      })}</svg>}
      {total === 0 && <span className="cost-kinds-empty" />}
    </div>
    <ul className="cost-legend">{parts.map(([key, label], index) => <li key={key}><i className="cost-swatch" style={{ background: seriesColor(index) }} />{label}<b>{usd(byKind[key])}</b></li>)}</ul>
  </div>;
}

function DeltaChip({ now, previous, previousMonth }: { now: number; previous: number; previousMonth: string }) {
  const Icon = now > previous ? ArrowUp : now < previous ? ArrowDown : Minus;
  const text = previous === 0 ? (now === 0 ? "no change" : "new spend") : `${Math.abs(Math.round(((now - previous) / previous) * 100))}%`;
  return <span className="cost-delta" title={`Last month: ${usd(previous)}`}><Icon size={13} aria-hidden="true" />{text} vs {previousMonth}</span>;
}
function Failure({ message, retry }: { message: string; retry: () => void }) {
  return <p className="cost-failure" role="status">{message} <button className="text-button" onClick={retry}><RefreshCw size={14} />Try again</button></p>;
}

const PLAN_MAX = 100000;
/** The same rule the host applies: a whole-dollar or two-decimal figure from 0 to 100000. Returns the number or the reason. */
export function parsePlanUsd(text: string): { value: number } | { error: string } {
  // One comma is a decimal separator, as some keyboards type it; thousands grouping is refused rather than guessed.
  const stripped = text.trim().replace(/^\$/, "");
  if ((stripped.match(/,/g)?.length ?? 0) > 1 || (stripped.includes(",") && stripped.includes("."))) return { error: "Use one comma or dot for cents, without thousands separators." };
  const cleaned = stripped.replace(",", ".");
  if (!cleaned) return { error: "Enter a monthly fee in dollars." };
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return { error: "Use a dollar figure with at most two decimals." };
  const value = Number(cleaned);
  if (value > PLAN_MAX) return { error: `The fee must be at most ${usd(PLAN_MAX)}.` };
  return { value };
}
/**
 * A subscription account's monthly fee. The owner can turn the figure into an inline input; everyone else just reads it.
 * The host answers every change with the whole account list, so the card never guesses a figure it did not confirm.
 */
function PlanFee({ account, owner, onChanged }: { account: AccountView; owner: boolean; onChanged: (accounts: AccountView[]) => void }) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const custom = account.planSource === "owner";
  const open = () => { setDraft(String(account.planUsd ?? 0)); setError(""); setEditing(true); };
  const close = () => { setEditing(false); setError(""); };
  async function submit(planUsd: number | null) {
    setBusy(true); setError("");
    try {
      const result = await api<{ accounts: AccountView[] }>(`/usage/accounts/${encodeURIComponent(account.id)}/plan`, { planUsd }, "PUT");
      onChanged(result.accounts);
      setEditing(false);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  if (!editing) return <>
    <strong className="cost-account-figure">{usd(account.planUsd ?? 0)}<small>/mo</small>{owner && <button type="button" className="cost-plan-edit" aria-label={`Edit the ${accountName(account.id)} plan fee`} onClick={open}><Pencil size={13} aria-hidden="true" /></button>}</strong>
    <span className="cost-account-sub">plan fee · no per-use dollars{custom && <span className="cost-plan-owner"> · set by you</span>}</span>
    {error && <small className="error" role="alert">{error}</small>}
  </>;
  return <form className="cost-plan-form" onSubmit={event => { event.preventDefault(); const parsed = parsePlanUsd(draft); if ("error" in parsed) setError(parsed.error); else void submit(parsed.value); }}>
    <label className="cost-plan-field"><span className="sr-only">Monthly fee in US dollars</span><span aria-hidden="true">$</span><input autoFocus inputMode="decimal" value={draft} disabled={busy} onChange={event => { setDraft(event.target.value); setError(""); }} onKeyDown={event => { if (event.key === "Escape") close(); }} /><small>/mo</small></label>
    <span className="cost-plan-actions">
      <button type="submit" className="text-button" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className="text-button" disabled={busy} onClick={close}>Cancel</button>
      {custom && <button type="button" className="text-button quiet" disabled={busy} onClick={() => void submit(null)}>Reset to default</button>}
    </span>
    {error && <small className="error" role="alert">{error}</small>}
  </form>;
}

function Overview({ me }: { me: Me }) {
  const api = useApi();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [daily, setDaily] = useState<UsageDaily | null>(null);
  const [refreshingBalances, setRefreshingBalances] = useState(false);
  const [balanceError, setBalanceError] = useState("");
  const view = useLiveRefresh(async current => {
    const [nextSummary, nextDaily] = await Promise.all([api<UsageSummary>("/usage"), api<UsageDaily>(`/usage/daily?days=30&tz=${zone}`)]);
    if (current()) { setSummary(nextSummary); setDaily(nextDaily); }
    return 30000;
  }, 30000, "overview");
  async function refreshBalances() {
    setRefreshingBalances(true); setBalanceError("");
    try { const result = await api<{ accounts: AccountView[] }>("/usage/balances/refresh", {}); setSummary(previous => previous ? { ...previous, accounts: result.accounts } : previous); }
    catch (error) { setBalanceError((error as Error).message); }
    finally { setRefreshingBalances(false); }
  }
  if (!summary) return view.failed ? <Failure message="Cost data could not be loaded." retry={view.refresh} /> : <p className="quiet" role="status">Loading cost…</p>;
  const { month } = summary;
  const previousMonth = monthName(new Date(Date.parse(month.start) - 86400000).toISOString(), "short");
  const byAccount = (id: string) => daily?.days.map(day => day.byAccount[id] ?? 0) ?? [];
  const colors = accountPalette([...summary.accounts.map(account => account.id), ...(daily?.accounts ?? [])]);
  return <>
    <section className="cost-hero">
      <p className="cost-hero-value"><Amount money={month.spent} /></p>
      <p className="cost-hero-line">metered spend in {monthName(month.start)}<DeltaChip now={month.spent.usd} previous={month.previous.usd} previousMonth={previousMonth} /><span className="cost-with-plans">{usd(month.spent.usd + month.plansUsd)} with plans</span><Unmeasured count={month.unmeasuredSessions} /></p>
    </section>
    <section className="cost-section">
      <div className="cost-section-heading"><h2>Last 30 days</h2><span className="quiet">{viewerZone.replaceAll("_", " ")}</span></div>
      {daily ? <><DailyBars daily={daily} colors={colors} /><SeriesLegend accounts={daily.accounts} colors={colors} /></> : <div className="cost-bars-placeholder" />}
    </section>
    <section className="cost-section">
      <div className="cost-section-heading"><h2>Accounts</h2>{me.role === "owner" && summary.accounts.some(account => account.kind === "metered") && <button className="text-button" disabled={refreshingBalances} onClick={() => void refreshBalances()}><RefreshCw size={14} />{refreshingBalances ? "Asking providers…" : "Refresh balances"}</button>}</div>
      {balanceError && <p className="error" role="alert">{balanceError}</p>}
      {summary.accounts.length ? <ul className="cost-accounts">{summary.accounts.map(account => {
        const series = byAccount(account.id);
        return <li key={account.id} className="cost-account">
          <span className="cost-account-name"><i className="cost-swatch" style={{ background: colors[account.id] }} />{accountName(account.id)}<span className="quiet">{account.kind === "metered" ? "metered" : "subscription"}</span></span>
          {account.kind === "subscription" ? <PlanFee account={account} owner={me.role === "owner"} onChanged={accounts => { setSummary(previous => previous ? { ...previous, accounts } : previous); view.refresh(); }} />
            : account.balance ? <><strong className="cost-account-figure">{usd(account.balance.amount, account.balance.currency)}</strong><span className="cost-account-sub">balance · as of {ago(account.balance.asOf)}{account.balance.stale && <em> · stale</em>}</span></>
            : <><strong className="cost-account-figure cost-dash">—</strong><span className="cost-account-sub">no balance from the provider</span></>}
          <span className="cost-account-foot"><span>{account.month ? <><Amount money={account.month} /> this month</> : <span className="quiet">no metered spend</span>}</span>{series.some(value => value > 0) && <Sparkline values={series} color={colors[account.id]} width={88} height={26} />}</span>
        </li>;
      })}</ul> : <p className="quiet">No accounts are configured on this host.</p>}
    </section>
  </>;
}

function ProjectRow({ project, onOpen }: { project: UsageProjectRow; onOpen: () => void }) {
  return <button type="button" className="cost-project-row" onClick={onOpen}>
    <span className="cost-project-name"><strong>{project.name}</strong><small><Amount money={project.month} unmeasured={project.unmeasured} /> this month{project.unmeasured ? <> · <Unmeasured count={project.unmeasured} word="run" /></> : null}</small></span>
    <Sparkline values={project.spark} />
    <span className="cost-project-total"><Amount money={project.total} unmeasured={project.unmeasured} /></span>
    <ChevronRight size={16} aria-hidden="true" />
  </button>;
}
function Projects({ onOpen }: { onOpen: (id: string) => void }) {
  const api = useApi();
  const [projects, setProjects] = useState<UsageProjectRow[] | null>(null);
  const view = useLiveRefresh(async current => {
    const result = await api<{ projects: UsageProjectRow[] }>(`/usage/projects?tz=${zone}`);
    if (current()) setProjects([...result.projects].sort((a, b) => b.total.usd - a.total.usd));
    return 30000;
  }, 30000, "projects");
  if (!projects) return view.failed ? <Failure message="Projects could not be loaded." retry={view.refresh} /> : <p className="quiet" role="status">Loading projects…</p>;
  return <section className="cost-section">
    <div className="cost-section-heading"><h2>Projects</h2><span className="quiet">accrued, all time</span></div>
    {projects.length ? <div className="cost-project-list">{projects.map(project => <ProjectRow key={project.id} project={project} onOpen={() => onOpen(project.id)} />)}</div> : <p className="quiet">No project has metered spend yet.</p>}
  </section>;
}

function ProjectDetail({ id, back }: { id: string; back: () => void }) {
  const api = useApi();
  const machine = useMachines().active.id;
  const prefix = "#" + (machine === "direct" ? "" : "/machines/" + machine);
  const [project, setProject] = useState<UsageProject | null>(null);
  const view = useLiveRefresh(async current => {
    const result = await api<UsageProject>(`/usage/projects/${encodeURIComponent(id)}?tz=${zone}`);
    if (current()) setProject(result);
    return 30000;
  }, 30000, id);
  if (!project) return <><button className="text-button cost-back" onClick={back}><ArrowLeft size={15} />All projects</button>{view.failed ? <Failure message="This project could not be loaded." retry={view.refresh} /> : <p className="quiet" role="status">Loading project…</p>}</>;
  const goalTitle = (goalId?: string) => goalId ? project.goals.find(goal => goal.id === goalId)?.title : undefined;
  return <>
    <button className="text-button cost-back" onClick={back}><ArrowLeft size={15} />All projects</button>
    <section className="cost-hero cost-hero-project">
      <h2>{project.name}</h2>
      <p className="cost-hero-value"><Amount money={project.total} unmeasured={project.unmeasured} />{project.unmeasured ? <Unmeasured count={project.unmeasured} word="run" /> : null}</p>
      <KindBar byKind={project.byKind} />
    </section>
    <section className="cost-section">
      <div className="cost-section-heading"><h2>Goals</h2><span className="quiet">{project.goals.length}</span></div>
      {project.goals.length ? <ul className="cost-rows">{project.goals.map(goal => <li key={goal.id}><a href={`${prefix}/goals/${goal.id}`}><span><strong>{goal.title}</strong><small>{goal.tasks} {goal.tasks === 1 ? "task" : "tasks"}</small></span><Amount money={goal.total} /><ArrowUpRight size={15} aria-hidden="true" /></a></li>)}</ul> : <p className="quiet">No goal spend recorded.</p>}
    </section>
    <section className="cost-section">
      <div className="cost-section-heading"><h2>Team runs</h2><span className="quiet">{project.teams.length}</span></div>
      {project.teams.length ? <ul className="cost-rows">{project.teams.map(team => <li key={team.id}><a href={`${prefix}/teams/${team.id}`}><span><strong>{team.title}</strong>{goalTitle(team.goalId) && <small>Goal · {goalTitle(team.goalId)}</small>}</span><Amount money={team.total} /><ArrowUpRight size={15} aria-hidden="true" /></a></li>)}</ul> : <p className="quiet">No team spend recorded.</p>}
    </section>
    <section className="cost-section">
      <div className="cost-section-heading"><h2>Sessions</h2><span className="quiet">{project.sessions.length}</span></div>
      {project.sessions.length ? <ul className="cost-rows">{project.sessions.map(session => <li key={session.id}><a href={`${prefix}/sessions/${session.id}/chat`}><span><strong>{session.title}</strong></span><Amount money={session.total} /><ArrowUpRight size={15} aria-hidden="true" /></a></li>)}</ul> : <p className="quiet">No measured session outside a team.</p>}
    </section>
    <section className="cost-section">
      <div className="cost-section-heading"><h2>Briefings</h2><span className="quiet">{project.briefings.runs} {project.briefings.runs === 1 ? "run" : "runs"}</span></div>
      <p className="cost-briefings"><Amount money={project.briefings.total} /><Unmeasured count={project.briefings.unmeasured} word="run" /></p>
    </section>
  </>;
}

const rubricMean = (rubric: NonNullable<ModelRow["rubric"]>) => (rubric.correctness + rubric.cleanliness + rubric.extensibility + rubric.docs) / 4;
function Models() {
  const api = useApi();
  const [role, setRole] = useState("implementer");
  const [card, setCard] = useState<Scorecard | null>(null);
  const view = useLiveRefresh(async current => {
    const result = await api<Scorecard>(`/usage/models?role=${encodeURIComponent(role)}`);
    if (current()) setCard(result);
    return 60000;
  }, 60000, role);
  const rows = card ? [...card.rows].sort((a, b) => Number(b.enough) - Number(a.enough) || (b.enough ? b.rate - a.rate : b.attempts - a.attempts)) : [];
  const dash = <span className="cost-dash">—</span>;
  return <>
    <section className="cost-section">
      <div className="cost-section-heading"><h2>Models</h2><label className="cost-role"><span className="sr-only">Role</span><select value={role} onChange={event => { setCard(null); setRole(event.target.value); }}>{roles.map(value => <option key={value} value={value}>{roleLabel[value] ?? value}</option>)}</select></label></div>
      {!card ? view.failed ? <Failure message="The scorecard could not be loaded." retry={view.refresh} /> : <p className="quiet" role="status">Loading scorecard…</p>
        : !rows.length ? <p className="quiet">No {roleLabel[role]?.toLowerCase() ?? role} attempts recorded yet.</p>
        : <table className="cost-models">
          <thead><tr><th scope="col">Model</th><th scope="col">n</th><th scope="col">Integrated</th><th scope="col">Median $ / task</th><th scope="col">$ / M tokens</th><th scope="col">Median time</th><th scope="col">Review rounds</th><th scope="col">Rubric</th><th scope="col">Owner</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.profileId} className={row.enough ? "" : "thin"}>
            <th scope="row" data-label="Model"><strong>{row.label}</strong><small>{names[row.provider] ?? row.provider}{row.metered ? "" : " · plan"}</small></th>
            <td data-label="n">{row.attempts}</td>
            <td data-label="Integrated">{row.enough ? <span className="cost-rate"><IntervalBar row={row} /><b>{Math.round(row.rate * 100)}%</b><small>{row.integrated}/{row.attempts}</small></span> : <span className="cost-thin">not enough data<small>{row.attempts} of {card.minAttempts} attempts</small></span>}</td>
            <td data-label="Median $ / task">{row.medianUsd === null ? dash : usd(row.medianUsd)}</td>
            <td data-label="$ / M tokens">{row.usdPerMTok === null ? dash : usd(row.usdPerMTok)}</td>
            <td data-label="Median time">{row.medianMinutes === null ? dash : minutes(row.medianMinutes)}</td>
            <td data-label="Review rounds">{row.meanReviewRounds === null ? dash : row.meanReviewRounds.toFixed(1)}</td>
            <td data-label="Rubric">{row.rubric ? <span title={`Correctness ${row.rubric.correctness.toFixed(1)} · cleanliness ${row.rubric.cleanliness.toFixed(1)} · extensibility ${row.rubric.extensibility.toFixed(1)} · docs ${row.rubric.docs.toFixed(1)}`}>{rubricMean(row.rubric).toFixed(1)}<small>n {row.rubric.n}</small></span> : dash}</td>
            <td data-label="Owner">{row.owner ? <span>{row.owner.mean.toFixed(1)}<small>n {row.owner.n}</small></span> : dash}</td>
          </tr>)}</tbody>
        </table>}
      {card && <p className="cost-foot quiet">Integrated rate with a Wilson 95% interval · rubric {card.rubricVersion} means on 1–5 · rows need {card.minAttempts} attempts to rank</p>}
    </section>
    {card && <section className="cost-section">
      <div className="cost-section-heading"><h2>Suggestions</h2><span className="quiet">advisory · the host never changes routing</span></div>
      {card.suggestions.length ? <ul className="cost-suggestions">{card.suggestions.map((suggestion, index) => <li key={index}><p>{suggestion.text}</p><small>{roleLabel[suggestion.role] ?? suggestion.role} · n {suggestion.n[0]} vs {suggestion.n[1]}</small></li>)}</ul> : <p className="quiet">None yet. Two models in the same role need {card.minAttempts} attempts each.</p>}
    </section>}
  </>;
}

export function CostPage({ me, view, projectId, navigate }: { me: Me; view: CostView; projectId: string | null; navigate: (view: CostView, projectId?: string) => void }) {
  const views: [CostView, string][] = [["overview", "Overview"], ["projects", "Projects"], ["models", "Models"]];
  return <div className="team-page cost-page">
    <div className="cost-switch" role="tablist" aria-label="Cost views">{views.map(([key, label]) => <button key={key} role="tab" type="button" aria-selected={view === key} onClick={() => navigate(key)}>{label}</button>)}</div>
    {!me.usage?.enabled ? <p className="quiet">Usage tracking is not enabled on this host.</p>
      : view === "models" ? <Models /> : view === "projects" ? (projectId ? <ProjectDetail key={projectId} id={projectId} back={() => navigate("projects")} /> : <Projects onOpen={id => navigate("projects", id)} />) : <Overview me={me} />}
    <MarkerLegend />
  </div>;
}

/** The rail beside the cost page: projects ranked by what they have cost. */
export function CostPicker({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const api = useApi();
  const [projects, setProjects] = useState<UsageProjectRow[] | null>(null);
  const view = useLiveRefresh(async current => {
    const result = await api<{ projects: UsageProjectRow[] }>(`/usage/projects?tz=${zone}`);
    if (current()) setProjects([...result.projects].sort((a, b) => b.total.usd - a.total.usd));
    return 30000;
  }, 30000, "rail");
  return <nav className="session-list cost-picker" aria-label="Projects by cost">
    {projects?.map((project, index) => <button key={project.id} className={"session-row " + (selected === project.id ? "selected" : "")} aria-current={selected === project.id ? "page" : undefined} onClick={() => onSelect(project.id)}>
      <div className="row-top"><span className="cost-rank">{index + 1}</span><strong>{project.name}</strong><ChevronRight size={16} /></div>
      <div className="row-meta"><span><Amount money={project.total} unmeasured={project.unmeasured} /></span><Sparkline values={project.spark} width={64} height={18} /></div>
    </button>)}
    {!projects?.length && <p className="rail-empty" role="status">{projects ? "No project has metered spend yet." : view.failed ? "Project costs are unavailable." : "Loading project costs…"}</p>}
  </nav>;
}

/** This month at a glance, for the team list. The Cost page carries the rest. */
export function SpendGlance({ me, open }: { me: Me; open: () => void }) {
  const api = useApi();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const enabled = me.usage?.enabled === true;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<UsageSummary>("/usage").then(value => { if (live) { setSummary(value); setFailed(false); } }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, enabled]);
  if (!enabled) return null;
  const month = summary?.month;
  const previousMonth = month ? monthName(new Date(Date.parse(month.start) - 86400000).toISOString(), "short") : "";
  return <section className="team-section cost-glance">
    <div className="team-section-heading"><h2>Spend</h2><span className="quiet">Informational. Budgets never stop or hide work.</span></div>
    {failed && <p className="quiet" role="status">Usage could not be loaded.</p>}
    {!summary && !failed && <p className="quiet">Loading usage…</p>}
    {month && <div className="cost-glance-row">
      <span className="cost-glance-figure"><Amount money={month.spent} /><small>{monthName(month.start, "short")}</small></span>
      <DeltaChip now={month.spent.usd} previous={month.previous.usd} previousMonth={previousMonth} />
      <span className="quiet">{usd(month.spent.usd + month.plansUsd)} with plans</span>
      <Unmeasured count={month.unmeasuredSessions} />
      <button className="text-button" onClick={open}>Open cost <ArrowUpRight size={15} /></button>
    </div>}
  </section>;
}

/** Per-task money, tokens, and attempts beside its model chips. */
export function TaskCost({ usage }: { usage?: TaskUsage }) {
  if (!usage) return <span className="cost-task quiet">Unmeasured</span>;
  return <span className="cost-task"><Amount money={{ usd: usage.usd, unpriced: usage.unpriced }} /><span>{tokens(usage.tokens)} tokens</span><span>{usage.attempts} {usage.attempts === 1 ? "attempt" : "attempts"}</span>{usage.profiles.map(profile => <code key={profile}>{profile}</code>)}</span>;
}
/** The owner's 1–5 verdict on a task. Idempotent per request, so a retry never double-counts. */
export function TaskRating({ teamId, taskId, rating, canRate, onRated }: { teamId: string; taskId: string; rating?: OwnerRating; canRate: boolean; onRated?: () => void }) {
  const api = useApi();
  const [local, setLocal] = useState<OwnerRating | undefined>(rating);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{ requestId: string; score: OwnerRating["score"] } | null>(null);
  useEffect(() => { setLocal(rating); }, [rating?.score, rating?.at]);
  const current = local?.score ?? 0;
  async function rate(score: OwnerRating["score"]) {
    if (busy || !canRate) return;
    const request = pending.current?.score === score ? pending.current : { requestId: crypto.randomUUID(), score };
    pending.current = request;
    setBusy(true); setError("");
    try {
      await api(`/teams/${teamId}/tasks/${taskId}/rating`, request);
      pending.current = null;
      setLocal({ score, at: new Date().toISOString() });
      onRated?.();
    } catch (failure) { setError((failure as Error).message + " Choosing the same score retries this request."); }
    finally { setBusy(false); }
  }
  return <span className="cost-rating">
    <span className="cost-stars" role="radiogroup" aria-label="Your rating">{([1, 2, 3, 4, 5] as const).map(score => <button key={score} type="button" role="radio" aria-checked={current === score} aria-label={`${score} of 5`} disabled={!canRate || busy} className={score <= current ? "on" : ""} onClick={() => void rate(score)}><Star size={15} strokeWidth={1.8} /></button>)}</span>
    {local ? <small>{local.score}/5 · {ago(local.at)}{local.note ? ` · ${local.note}` : ""}</small> : canRate ? <small className="quiet">rate this task</small> : null}
    {error && <small className="error" role="alert">{error}</small>}
  </span>;
}
export function TaskCostRow({ teamId, taskId, usage, rating, canRate, onRated, children }: { teamId: string; taskId: string; usage?: TaskUsage; rating?: OwnerRating; canRate: boolean; onRated?: () => void; children?: ReactNode }) {
  return <div className="cost-task-row"><TaskCost usage={usage} />{children}<TaskRating teamId={teamId} taskId={taskId} rating={rating} canRate={canRate} onRated={onRated} /></div>;
}
