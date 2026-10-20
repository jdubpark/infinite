import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { connectionKey, type Connection } from "../../api/client";
import { LiveStatus, TopBar } from "../../components/Glass";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";
import { Section, t } from "../teams/parts";
import { StackedBars } from "./charts";
import { accountColors, accountName, usd, type Money } from "./model";
import { DayCaption, KindChips, Legend, MoneyText } from "./parts";
import { useDaily, useProject } from "./useCost";

/** One project's accrued cost, its last thirty days, and the goals, runs, sessions, and briefings behind it. */
export function ProjectCost({ connection, id }: { connection: Connection; id: string }) {
  const router = useRouter(), machine = connectionKey(connection);
  const project = useProject(connection, id), daily = useDaily(connection, id);
  const [selected, setSelected] = useState<string>();
  const accounts = daily.data?.accounts ?? [], days = daily.data?.days ?? [];
  const colors = accountColors(accounts);
  const top = <TopBar backLabel="Cost" onBack={() => { if (router.canGoBack()) router.back(); else router.replace({ pathname: "/cost", params: { machine } }); }}
    right={<LiveStatus online={project.online} loading={project.loading} seen={project.seen} />} />;
  if (!project.data) return <View style={s.fill}>{top}<View style={s.empty}>
    {project.loading ? <ActivityIndicator color={theme.colors.forest} /> : <Text style={t.note}>Could not load this project’s cost.</Text>}
  </View></View>;
  const cost = project.data;
  const open = (pathname: "/goal/[id]" | "/team/[id]" | "/session/[id]", target: string) => router.push({ pathname, params: { id: target, machine } });
  const briefings = cost.briefings.runs > 0 || cost.briefings.unmeasured > 0;
  // Older hosts report only the briefings' unmeasured count.
  const unmeasured = cost.unmeasured ?? cost.briefings.unmeasured;
  return <View style={s.fill}>
    {top}
    {!project.online && !project.loading ? <Text style={t.banner}>Offline · last received figures.</Text> : null}
    <ScrollView style={s.fill} contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={project.refreshing || daily.refreshing} onRefresh={() => { project.refresh(); daily.refresh(); }} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <Text style={t.title} accessibilityRole="header">{cost.name}</Text>
      <View style={s.head}>
        <MoneyText value={{ ...cost.total, unmeasured }} style={s.total} prefixStyle={s.totalPrefix} />
        <Text style={t.note}>accrued{unmeasured ? ` · ${unmeasured} unmeasured` : ""}</Text>
      </View>
      <KindChips byKind={cost.byKind} />
      <View style={s.chart}>
        <DayCaption day={days.find(day => day.date === selected)} days={days} accounts={accounts} colors={colors} />
        <StackedBars days={days} accounts={accounts} colors={colors} selected={selected} onSelect={setSelected} />
        <Legend entries={accounts.map(account => ({ id: account, label: accountName(account), color: colors[account]! }))} atLeast={cost.total.unpriced > 0 || (unmeasured > 0 && cost.total.usd > 0)} unmeasured={unmeasured} />
      </View>
      {cost.goals.length ? <Section title="Goals" count={cost.goals.length}>
        {cost.goals.map(goal => <CostRow key={goal.id} label={goal.title} detail={`${goal.tasks} ${goal.tasks === 1 ? "task" : "tasks"}`} total={goal.total} onPress={() => open("/goal/[id]", goal.id)} />)}
      </Section> : null}
      {cost.teams.length ? <Section title="Team runs" count={cost.teams.length}>
        {cost.teams.map(team => <CostRow key={team.id} label={team.title} detail={team.goalId ? "goal cycle" : undefined} total={team.total} onPress={() => open("/team/[id]", team.id)} />)}
      </Section> : null}
      {cost.sessions.length ? <Section title="Sessions" count={cost.sessions.length}>
        {cost.sessions.map(session => <CostRow key={session.id} label={session.title} total={session.total} onPress={() => open("/session/[id]", session.id)} />)}
      </Section> : null}
      {briefings ? <Section title="Briefings" count={cost.briefings.runs}>
        <View style={s.row}>
          <Text style={[t.note, s.fill]}>{cost.briefings.runs} runs{cost.briefings.unmeasured ? ` · ${cost.briefings.unmeasured} unmeasured` : ""}</Text>
          <MoneyText value={cost.briefings.total} style={s.figure} />
        </View>
      </Section> : null}
    </ScrollView>
  </View>;
}

function CostRow({ label, detail, total, onPress }: { label: string; detail?: string; total: Money; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${label}: ${total.unpriced ? "at least " : ""}${usd(total.usd)}`} onPress={onPress} hitSlop={5} style={({ pressed }) => [s.row, pressed && s.pressed]}>
    <View style={s.rowMain}><Text style={s.rowTitle} numberOfLines={2}>{label}</Text>{detail ? <Text style={t.note}>{detail}</Text> : null}</View>
    <MoneyText value={total} style={s.figure} /><Glyph name="forward" size={12} color={theme.colors.mutedInk} />
  </Pressable>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  empty: { padding: 30, alignItems: "center" },
  body: { paddingHorizontal: 16, paddingTop: 2, gap: 10, paddingBottom: 28 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  total: { fontSize: 34, lineHeight: 40, fontWeight: "600", letterSpacing: -0.8, color: theme.colors.ink },
  totalPrefix: { fontSize: 22, fontWeight: "500", letterSpacing: 0 },
  chart: { gap: 8, marginTop: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.ink },
  figure: { fontSize: 14, fontWeight: "600", color: theme.colors.ink, fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.55 },
});
