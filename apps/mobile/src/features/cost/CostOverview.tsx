import { useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { LiveStatus, Segmented, TopBar } from "../../components/Glass";
import { theme } from "../../theme";
import { Choices, Section, t } from "../teams/parts";
import { StackedBars } from "./charts";
import { accountColors, accountName, delta, ROLE_LABELS, ROLE_OPTIONS } from "./model";
import { AccountCard, DayCaption, Hero, Legend, ModelCard, ProjectRow, SuggestionCard } from "./parts";
import { useDaily, useModels, useProjects, useUsageOverview } from "./useCost";

type Tab = "spend" | "models";

/**
 * What the host's agents cost, in figures: this month's metered spend, thirty days of bars
 * stacked by account, each account's balance or plan fee, and projects ranked by accrued cost.
 * Models compares profiles per role with their sample size and uncertainty shown; it suggests,
 * never routes. Plan fees stay out of the headline, the bars, and the delta.
 */
export function CostOverview({ connection }: { connection: Connection }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const overview = useUsageOverview(connection), daily = useDaily(connection), projects = useProjects(connection);
  const me = usePoll(() => api<Me>(connection, "/me"), 30000, [connection]);
  const [tab, setTab] = useState<Tab>("spend");
  const [role, setRole] = useState<(typeof ROLE_OPTIONS)[number]>("implementer");
  const [selected, setSelected] = useState<string>();
  const [balances, setBalances] = useState<"idle" | "busy" | "failed">("idle");
  const models = useModels(connection, role);
  const accounts = overview.data?.accounts ?? [];
  // Only metered accounts draw in the bars, so only they take a hue; plans stay unmarked.
  const colors = accountColors(accounts.filter(account => account.kind === "metered").map(account => account.id));
  const days = daily.data?.days ?? [], dailyAccounts = daily.data?.accounts ?? [];
  // Legend entries in the host's account order, limited to accounts that spent in the window.
  const shown = accounts.filter(account => dailyAccounts.includes(account.id)).map(account => account.id);
  const selectedDay = days.find(day => day.date === selected);
  function back() { if (router.canGoBack()) router.back(); else router.replace({ pathname: "/", params: { machine } }); }
  const refresh = () => { overview.refresh(); daily.refresh(); projects.refresh(); me.refresh(); models.refresh(); };
  async function refreshBalances() {
    setBalances("busy");
    try { await api(connection, "/usage/balances/refresh", { method: "POST" }); overview.refresh(); setBalances("idle"); }
    catch { setBalances("failed"); }
  }
  const top = <TopBar backLabel="Home" onBack={back} right={<LiveStatus online={overview.online} loading={overview.loading} seen={overview.seen} />} />;
  if (!overview.data) return <View style={s.fill}>{top}<View style={s.empty}>
    {overview.loading ? <ActivityIndicator color={theme.colors.forest} /> : <Text style={t.note}>{overview.online ? "This host reports no usage." : "Could not load usage."}</Text>}
  </View></View>;
  const month = overview.data.month;
  const rows = models.data ? [...models.data.rows].sort((a, b) => Number(b.enough) - Number(a.enough) || b.attempts - a.attempts) : [];
  return <View style={s.fill}>
    {top}
    {!overview.online && !overview.loading ? <Text style={t.banner}>Offline · last received figures.</Text> : null}
    <ScrollView style={s.fill} contentContainerStyle={s.body} stickyHeaderIndices={[1]}
      refreshControl={<RefreshControl refreshing={overview.refreshing || daily.refreshing || projects.refreshing} onRefresh={refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <Text style={s.title} accessibilityRole="header">Cost</Text>
      <View style={s.sticky}><Segmented value={tab} onChange={setTab} options={[{ value: "spend", label: "Spend" }, { value: "models", label: "Models", count: models.data?.suggestions.length }]} /></View>

      {tab === "spend" ? <View style={s.stack}>
        <Hero month={month} delta={delta(month.spent, month.previous)} />
        <View style={s.chart}>
          <DayCaption day={selectedDay} days={days} accounts={shown} colors={colors} />
          <StackedBars days={days} accounts={shown} colors={colors} selected={selected} onSelect={setSelected} />
          <Legend entries={shown.map(id => ({ id, label: accountName(id), color: colors[id]! }))}
            atLeast={month.spent.unpriced > 0 || accounts.some(account => (account.month?.unpriced ?? 0) > 0)} unmeasured={month.unmeasuredSessions} />
        </View>
        {accounts.length ? <View style={s.accounts}>
          {accounts.map(account => <AccountCard key={account.id} account={account} color={colors[account.id]}
            spark={account.kind === "metered" ? days.map(day => day.byAccount[account.id] ?? 0) : undefined} />)}
        </View> : null}
        {me.data?.role === "owner" && accounts.some(account => account.kind === "metered") ? <View style={s.actions}>
          <Button compact secondary title={balances === "busy" ? "Refreshing…" : "Refresh balances"} disabled={balances === "busy" || !overview.online} onPress={() => void refreshBalances()} />
          {balances === "failed" ? <Text accessibilityRole="alert" style={t.error}>Refresh failed</Text> : null}
        </View> : null}
        <Section title="Projects" count={projects.data?.projects.length}>
          {projects.data?.projects.length ? projects.data.projects.map(project => <ProjectRow key={project.id} project={project} onPress={() => router.push({ pathname: "/cost/project/[id]", params: { id: project.id, machine } })} />)
            : <Text style={t.note}>{projects.loading ? "Loading…" : "No metered spend yet."}</Text>}
        </Section>
        <Text style={s.qualifier}>This host only · metered spend · plans as fixed fees</Text>
      </View> : <View style={s.stack}>
        <Choices values={ROLE_OPTIONS} selected={role} label={value => ROLE_LABELS[value]} onSelect={setRole} />
        {models.data ? <>
          {rows.length ? rows.map(row => <ModelCard key={row.profileId} row={row} minAttempts={models.data!.minAttempts} />) : <Text style={t.note}>No attempts recorded for this role.</Text>}
          <Section title="Suggestions" count={models.data.suggestions.length}>
            {models.data.suggestions.length ? models.data.suggestions.map((suggestion, index) => <SuggestionCard key={`${suggestion.profileId}/${suggestion.comparedTo}/${index}`} suggestion={suggestion} />)
              : <Text style={t.note}>None yet · needs {models.data.minAttempts} attempts per model</Text>}
          </Section>
          <Text style={s.qualifier}>Rubric v{models.data.rubricVersion} · Wilson 95% intervals · advisory only</Text>
        </> : models.loading ? <ActivityIndicator color={theme.colors.forest} style={s.spinner} /> : <Text style={t.note}>No model data.</Text>}
      </View>}
    </ScrollView>
  </View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  empty: { padding: 30, alignItems: "center" },
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.6, color: theme.colors.ink, marginTop: 4 },
  sticky: { backgroundColor: theme.colors.paper, paddingVertical: 8 },
  stack: { gap: 14, paddingTop: 6 },
  chart: { gap: 8 },
  accounts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  actions: { flexDirection: "row", alignItems: "center", gap: 10 },
  qualifier: { fontSize: 11, lineHeight: 16, color: theme.colors.mutedInk, marginTop: 6 },
  spinner: { marginTop: 20 },
});
