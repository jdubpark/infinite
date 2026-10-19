import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { ago } from "../../api/client";
import { Avatar } from "../../components/Avatar";
import { Card, Chip } from "../../components/Glass";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";
import { shortDate } from "../teams/model";
import { t } from "../teams/parts";
import { IntervalBar, Sparkline } from "./charts";
import {
  accountName, compactTokens, monthName, money, rubricMean, shortDay, usd,
  type AccountView, type DailyPoint, type ModelRow, type Money, type OwnerRating, type ProjectCostRow, type Rubric, type Suggestion, type TaskUsage,
} from "./model";

/**
 * The cost screens' pieces. Figures carry the information; the only words are labels. Two markers
 * recur and the legend explains them once: "≥" before a figure whose steps were partly unpriced,
 * and "—" where the provider gave no balance.
 */

/** A figure that is never shown as exact when part of it is unpriced. */
export function MoneyText({ value, style, prefixStyle }: { value: Money; style?: StyleProp<TextStyle>; prefixStyle?: StyleProp<TextStyle> }) {
  const formatted = money(value);
  return <Text accessibilityLabel={formatted.atLeast ? `at least ${formatted.text}` : formatted.text} style={style}>
    {formatted.atLeast ? <Text style={[s.prefix, prefixStyle]}>≥ </Text> : null}{formatted.text}
  </Text>;
}

/** This month's metered spend, its change from last month, and the fixed plan fees beside it. */
export function Hero({ month, delta }: { month: { start: string; spent: Money; plansUsd: number; unmeasuredSessions: number }; delta: { text: string; direction: "up" | "down" | "flat" } | null }) {
  const withPlans = { usd: month.spent.usd + month.plansUsd, unpriced: month.spent.unpriced };
  return <View style={s.hero} accessible accessibilityLabel={`${monthName(month.start)}: ${money(month.spent).atLeast ? "at least " : ""}${usd(month.spent.usd)} metered${delta ? `, ${delta.text} vs last month` : ""}; ${usd(withPlans.usd)} with plans${month.unmeasuredSessions ? `; ${month.unmeasuredSessions} sessions unmeasured` : ""}`}>
    <View style={s.heroLine}>
      <MoneyText value={month.spent} style={s.heroValue} prefixStyle={s.heroPrefix} />
      {delta ? <Chip icon={delta.direction === "flat" ? undefined : <Glyph name={delta.direction} size={11} color={theme.colors.mutedInk} />} label={delta.text} /> : null}
    </View>
    <Text style={s.muted}>{monthName(month.start)} · with plans <MoneyText value={withPlans} />{month.unmeasuredSessions ? ` · ${month.unmeasuredSessions} unmeasured` : ""}</Text>
  </View>;
}

/** The one legend: account hues, then the two markers when the figures use them. */
export function Legend({ entries, atLeast = false, unmeasured = 0 }: { entries: { id: string; label: string; color: string }[]; atLeast?: boolean; unmeasured?: number }) {
  return <View style={s.legend}>
    {entries.map(entry => <View key={entry.id} style={s.legendItem}><View style={[s.dot, { backgroundColor: entry.color }]} /><Text style={s.muted}>{entry.label}</Text></View>)}
    {atLeast ? <View style={s.legendItem}><Text style={[s.muted, s.mark]}>≥</Text><Text style={s.muted}>partly unpriced</Text></View> : null}
    {unmeasured ? <View style={s.legendItem}><Text style={[s.muted, s.mark]}>{unmeasured}</Text><Text style={s.muted}>unmeasured</Text></View> : null}
  </View>;
}

/** The caption above the bars: the range total, or the tapped day split by account. */
export function DayCaption({ day, days, accounts, colors }: { day?: DailyPoint; days: DailyPoint[]; accounts: string[]; colors: Record<string, string> }) {
  if (!day) return <Text style={s.caption}>Last 30 days · {usd(days.reduce((sum, item) => sum + item.usd, 0))}</Text>;
  return <View style={s.captionRow}>
    <Text style={s.caption}>{shortDay(day.date)} · {usd(day.usd)}</Text>
    {accounts.filter(account => (day.byAccount[account] ?? 0) > 0).map(account => <View key={account} style={s.legendItem}>
      <View style={[s.dot, { backgroundColor: colors[account] ?? theme.colors.placeholder }]} /><Text style={s.caption}>{usd(day.byAccount[account]!)}</Text>
    </View>)}
  </View>;
}

/** One connected account: its balance or plan fee, this month's metered spend, and a 30-day trend. */
export function AccountCard({ account, color, spark }: { account: AccountView; color?: string; spark?: number[] }) {
  const balance = account.balance;
  const name = accountName(account.id);
  const value = balance ? `${usd(balance.amount)}${balance.currency.toUpperCase() !== "USD" ? ` ${balance.currency.toUpperCase()}` : ""}` : account.kind === "subscription" ? usd(account.planUsd ?? 0) : "—";
  const meta = account.kind === "subscription" ? "per month · plan" : balance ? `balance · ${ago(balance.asOf)}` : "no balance";
  const label = `${name}: ${account.kind === "subscription" ? `${value} per month plan` : balance ? `balance ${value} as of ${ago(balance.asOf)}${balance.stale ? ", stale" : ""}` : "no balance"}${account.month ? `, ${money(account.month).atLeast ? "at least " : ""}${usd(account.month.usd)} this month` : ""}`;
  return <Card style={s.account}>
    <View accessible accessibilityLabel={label} style={s.accountBody}>
      <View style={s.accountHead}>{color ? <View style={[s.dot, { backgroundColor: color }]} /> : null}<Text style={s.accountName} numberOfLines={1}>{name}</Text>{balance?.stale ? <Chip label="stale" tone="attention" /> : null}</View>
      <View style={s.accountLine}>
        <Text style={[s.accountValue, !balance && account.kind === "metered" && s.accountNone]}>{value}</Text>
        {color && spark?.some(value => value > 0) ? <Sparkline values={spark} color={color} width={56} height={20} /> : null}
      </View>
      <Text style={s.muted} numberOfLines={1}>{meta}</Text>
      {account.month ? <Text style={s.accountMonth} numberOfLines={1}><MoneyText value={account.month} /> this month</Text> : null}
    </View>
  </Card>;
}

/** A project ranked by accrued cost, with its month and a 30-day trend. */
export function ProjectRow({ project, onPress }: { project: ProjectCostRow; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${project.name}: ${usd(project.month.usd)} this month, ${usd(project.total.usd)} accrued`} onPress={onPress} hitSlop={6}
    style={({ pressed }) => [s.row, pressed && s.pressed]}>
    <View style={s.rowMain}><Text style={s.rowTitle} numberOfLines={1}>{project.name}</Text><Text style={s.muted}><MoneyText value={project.total} /> accrued</Text></View>
    <Sparkline values={project.spark} color={theme.colors.forest} />
    <MoneyText value={project.month} style={s.rowFigure} /><Glyph name="forward" size={12} color={theme.colors.mutedInk} />
  </Pressable>;
}

export function KindChips({ byKind }: { byKind: { goals: number; teams: number; sessions: number; briefings: number } }) {
  const items = [[byKind.goals, "goals"], [byKind.teams, "runs"], [byKind.sessions, "sessions"], [byKind.briefings, "briefings"]] as const;
  return <View style={s.legend}>{items.filter(([count]) => count > 0).map(([count, label]) => <Chip key={label} label={`${count} ${label}`} />)}</View>;
}

/** A task's metered cost on one line: dollars, tokens, and attempts beyond the first. */
export function CostLine({ usage }: { usage?: TaskUsage }) {
  if (!usage) return null;
  return <Text style={t.note}><MoneyText value={usage} /> · {compactTokens(usage.tokens)} tok{usage.attempts > 1 ? ` · ${usage.attempts} attempts` : ""}</Text>;
}

/** The owner's 1–5 score for a task; the host records it as the owner's claim beside the reviewer's. */
export function RatingControl({ value, disabled, onRate, busy, error }: { value?: OwnerRating; disabled: boolean; onRate: (score: 1 | 2 | 3 | 4 | 5) => void; busy: boolean; error: string }) {
  return <View style={s.rating}>
    <View style={s.ratingRow} accessibilityRole="radiogroup" accessibilityLabel="Your rating">
      <Text style={t.label}>Your rating</Text>
      <View style={s.ratingButtons}>{([1, 2, 3, 4, 5] as const).map(score => {
        const filled = Boolean(value && score <= value.score);
        return <Pressable key={score} accessibilityRole="radio" accessibilityLabel={`${score} of 5`} accessibilityState={{ selected: value?.score === score, disabled: disabled || busy }} disabled={disabled || busy}
          onPress={() => onRate(score)} hitSlop={8} style={({ pressed }) => [s.ratingButton, filled && s.ratingFilled, (busy || pressed) && s.dim]}>
          <Text style={[s.ratingDigit, filled && s.ratingDigitFilled]}>{score}</Text>
        </Pressable>;
      })}</View>
    </View>
    {busy ? <Text style={s.muted}>Recording…</Text> : value ? <Text style={s.muted}>{value.score}/5 · {shortDate(value.at)}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={t.error}>{error}</Text> : null}
  </View>;
}

export function RubricLine({ rubric }: { rubric: Rubric }) {
  return <Text style={t.note}>Reviewer rubric · correctness {rubric.correctness.score} · clean {rubric.cleanliness.score} · extend {rubric.extensibility.score} · docs {rubric.docs.score}</Text>;
}

/** One model profile in a role: how often its tasks integrated, with the uncertainty, and what they cost. */
export function ModelCard({ row, minAttempts }: { row: ModelRow; minAttempts: number }) {
  const mean = rubricMean(row.rubric);
  const facts = [
    row.metered ? row.medianUsd == null ? null : `median ${usd(row.medianUsd)}` : "plan · —",
    row.metered && row.usdPerMTok != null ? `${usd(row.usdPerMTok)}/MTok` : null,
    row.medianMinutes == null ? null : `${Math.round(row.medianMinutes)} min`,
    row.meanReviewRounds == null ? null : `${row.meanReviewRounds.toFixed(1)} rounds`,
    row.rubric && mean != null ? `rubric ${mean.toFixed(1)} (${row.rubric.n})` : null,
    row.owner ? `owner ${row.owner.mean.toFixed(1)} (${row.owner.n})` : null,
  ].filter(Boolean);
  return <Card>
    <View style={s.modelHead}><Avatar label={row.label} provider={row.provider} size={24} /><Text style={s.rowTitle} numberOfLines={1}>{row.label}</Text><Chip label={`n ${row.attempts}`} accessibilityLabel={`${row.attempts} attempts`} /></View>
    <View style={s.modelRate}>
      <IntervalBar rate={row.rate} interval={row.rateInterval} enough={row.enough} />
      {row.enough ? <Text style={s.rate}>{Math.round(row.rate * 100)}%</Text> : <Text style={s.muted}>not enough data · {row.attempts}/{minAttempts}</Text>}
    </View>
    {facts.length ? <Text style={s.muted}>{facts.join(" · ")}</Text> : null}
  </Card>;
}

export function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  return <Card><Text style={t.body}>{suggestion.text}</Text><Text style={s.muted}>n {suggestion.n[0]} · {suggestion.n[1]} · advisory</Text></Card>;
}

const s = StyleSheet.create({
  muted: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
  mark: { fontWeight: "700", fontVariant: ["tabular-nums"] },
  prefix: { color: theme.colors.mutedInk },
  hero: { gap: 2 },
  heroLine: { flexDirection: "row", alignItems: "center", gap: 10 },
  heroValue: { fontSize: 44, lineHeight: 50, fontWeight: "600", letterSpacing: -1.2, color: theme.colors.ink },
  heroPrefix: { fontSize: 26, fontWeight: "500", letterSpacing: 0 },
  legend: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, rowGap: 4 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  caption: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk, fontVariant: ["tabular-nums"] },
  captionRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  account: { flexBasis: "48%", flexGrow: 1, padding: 12, gap: 0 },
  accountBody: { gap: 2 },
  accountHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  accountName: { flexShrink: 1, fontSize: 13, fontWeight: "600", color: theme.colors.ink },
  accountLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 },
  accountValue: { flexShrink: 1, fontSize: 24, lineHeight: 30, fontWeight: "600", letterSpacing: -0.5, color: theme.colors.ink },
  accountNone: { color: theme.colors.placeholder, fontWeight: "400" },
  accountMonth: { fontSize: 12, lineHeight: 17, color: theme.colors.ink, marginTop: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.ink },
  rowFigure: { fontSize: 14, fontWeight: "600", color: theme.colors.ink, fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.55 },
  rating: { gap: 4 },
  ratingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  ratingButtons: { flexDirection: "row", gap: 6, marginTop: 12 },
  ratingButton: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.secondarySurface },
  ratingFilled: { backgroundColor: theme.colors.forest },
  ratingDigit: { fontSize: 13, fontWeight: "600", color: theme.colors.secondaryInk },
  ratingDigitFilled: { color: theme.colors.white },
  dim: { opacity: 0.45 },
  modelHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  modelRate: { flexDirection: "row", alignItems: "center", gap: 8 },
  rate: { fontSize: 13, fontWeight: "600", color: theme.colors.ink, fontVariant: ["tabular-nums"] },
});
