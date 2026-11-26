import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ago, api, connectionKey, type Connection } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { LiveStatus, Segmented, TopBar } from "../../components/Glass";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";
import { Section, t } from "../teams/parts";
import { logPath, verdictColors, verdictWords, type Candidate, type DecisionEntry, type LogFilter, type LogPage } from "./model";

function olderErrorMessage(failure: unknown) {
  const detail = failure instanceof Error ? failure.message.trim() : "";
  return detail ? `Could not load older decisions: ${detail}` : "Could not load older decisions.";
}

export function PermissionLog({ connection }: { connection: Connection }) {
  const router = useRouter(), machine = connectionKey(connection);
  const [filter, setFilter] = useState<LogFilter>("all");
  const scope = `${machine}/${filter}`;
  const log = usePoll(() => api<LogPage>(connection, logPath(filter)).then(page => ({ scope, page })), 15000, [connection, filter]);
  const current = log.data?.scope === scope ? log.data.page : null;
  const candidates = usePoll(() => api<{ candidates: Candidate[] }>(connection, "/permissions/candidates?limit=20"), 30000, [connection]);
  const [trackedScope, setTrackedScope] = useState(scope);
  const [older, setOlder] = useState<{ scope: string; entries: DecisionEntry[]; next?: string } | null>(null);
  const [olderLoad, setOlderLoad] = useState<{ epoch: number; scope: string } | null>(null);
  const [olderError, setOlderError] = useState<{ scope: string; message: string } | null>(null);
  const olderEpoch = useRef(0);
  if (trackedScope !== scope) {
    setTrackedScope(scope);
    setOlder(null);
    setOlderLoad(null);
    setOlderError(null);
  }
  useEffect(() => {
    olderEpoch.current += 1;
    return () => { olderEpoch.current += 1; };
  }, [scope]);
  const extra = older?.scope === scope ? older : null;
  const loadingOlder = olderLoad?.scope === scope;
  const paginationError = olderError?.scope === scope ? olderError.message : "";
  const next = extra ? extra.next : current?.next;
  const seen = new Set<string>();
  const rows = current ? [...current.entries, ...(extra?.entries ?? [])].filter(entry => !seen.has(entry.id) && Boolean(seen.add(entry.id))) : [];
  const flags = log.data?.page.rateFlags ?? [];
  const open = (id: string) => router.push({ pathname: "/permissions/[id]", params: { id, machine } });
  function back() { if (router.canGoBack()) router.back(); else router.replace({ pathname: "/", params: { machine } }); }
  async function showOlder() {
    if (!next || loadingOlder) return;
    const epoch = olderEpoch.current;
    setOlderLoad({ epoch, scope });
    setOlderError(null);
    try {
      const page = await api<LogPage>(connection, logPath(filter, next));
      if (olderEpoch.current !== epoch) return;
      setOlder(previous => ({
        scope,
        entries: [...(previous?.scope === scope ? previous.entries : []), ...page.entries],
        next: page.next,
      }));
    } catch (failure) {
      if (olderEpoch.current !== epoch) return;
      setOlderError({ scope, message: olderErrorMessage(failure) });
    } finally {
      if (olderEpoch.current === epoch) setOlderLoad(null);
    }
  }
  const top = <TopBar backLabel="Home" onBack={back} right={<LiveStatus online={log.online} loading={log.loading} seen={log.seen} stale={log.stale} />} />;
  return <View style={s.fill}>
    {top}
    {log.stale && current ? <Text style={t.banner}>Offline · last received decisions.</Text> : null}
    <ScrollView style={s.fill} contentContainerStyle={s.body} stickyHeaderIndices={[1]}
      refreshControl={<RefreshControl refreshing={log.refreshing} onRefresh={() => { log.refresh(); candidates.refresh(); }} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <Text style={s.title} accessibilityRole="header">Permission decisions</Text>
      <View style={s.sticky}><Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "rejected", label: "Rejected" }, { value: "raised", label: "Raised" }]} /></View>
      {flags.length ? <Section title="Above the usual rate" count={flags.length}>
        {flags.map(flag => <View key={`${flag.workspaceId}/${flag.sessionId}`} style={s.flag}>
          <Text style={t.mono} numberOfLines={1}>{flag.sessionId}</Text>
          <Text style={t.note}>{flag.lastHour} decisions in the last hour · flagged above {flag.threshold}. Nothing stops on it.</Text>
        </View>)}
      </Section> : null}
      {candidates.data?.candidates.length ? <Section title="Offered as replay cases" count={candidates.data.candidates.length}>
        {candidates.data.candidates.map(candidate => <DecisionRow key={candidate.decisionId} entry={candidate.decision} onPress={() => open(candidate.decisionId)}
          detail={`${candidate.sources.map(source => source === "reopened" ? "reopened" : "marked wrong").join(" and ")} · labelled ${candidate.label}`} />)}
        <Text style={t.note}>You accept or drop each one in the replay set; nothing is added without you.</Text>
      </Section> : null}
      <Section title="Decisions" count={rows.length || undefined}>
        {rows.map(entry => <DecisionRow key={entry.id} entry={entry} onPress={() => open(entry.id)}
          detail={[entry.workspaceName ?? entry.workspaceId, ago(entry.at), entry.marks.length ? "marked wrong" : "", entry.rateFlagged ? "above usual rate" : ""].filter(Boolean).join(" · ")} />)}
        {!rows.length ? current ? <Text style={t.note}>{filter === "all" ? "The permission agent has recorded no decision yet." : "No decision matches this filter."}</Text>
          : log.stale ? <Text style={t.note}>The decision log is unavailable.</Text> : <ActivityIndicator color={theme.colors.forest} style={s.spinner} /> : null}
        {next && current ? <View style={s.older}>
          <Button compact secondary title={loadingOlder ? "Loading…" : "Show older decisions"} disabled={loadingOlder} onPress={() => void showOlder()} />
          {paginationError ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={t.error}>{paginationError}</Text> : null}
        </View> : null}
      </Section>
    </ScrollView>
  </View>;
}

function DecisionRow({ entry, detail, onPress }: { entry: Pick<DecisionEntry, "action" | "verdict" | "code" | "interruptClass">; detail: string; onPress: () => void }) {
  const action = entry.action.summary || entry.action.tool;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${verdictWords(entry)}: ${action}`} onPress={onPress} hitSlop={4} style={({ pressed }) => [s.row, pressed && s.pressed]}>
    <View style={[s.dot, { backgroundColor: verdictColors[entry.verdict] }]} />
    <View style={s.rowMain}>
      <Text style={s.action} numberOfLines={2}>{action}</Text>
      <Text style={[s.verdict, { color: entry.verdict === "allow" ? theme.colors.secondaryInk : verdictColors[entry.verdict] }]}>{verdictWords(entry)}</Text>
      <Text style={t.note} numberOfLines={1}>{detail}</Text>
    </View>
    <Glyph name="forward" size={12} color={theme.colors.mutedInk} />
  </Pressable>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.6, color: theme.colors.ink, marginTop: 4 },
  sticky: { backgroundColor: theme.colors.paper, paddingVertical: 8 },
  flag: { gap: 3, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  dot: { width: 8, height: 8, borderRadius: 4, alignSelf: "flex-start", marginTop: 6 },
  rowMain: { flex: 1, gap: 3 },
  action: { fontFamily: theme.mono, fontSize: 13, lineHeight: 18, color: theme.colors.ink },
  verdict: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
  pressed: { opacity: 0.55 },
  older: { alignItems: "flex-start", gap: 6, paddingTop: 6 },
  spinner: { marginTop: 20 },
});
