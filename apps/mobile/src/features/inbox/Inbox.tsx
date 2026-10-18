import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useIsFocused, useRouter } from "expo-router";
import { PROVIDER_NAMES, groupSessions } from "@infinite/attention";
import {
  api,
  connectionKey,
  type Connection,
  type Me,
  type SessionRow,
} from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { OfflineBanner } from "../../components/OfflineBanner";
import { StatePill } from "../../components/StatePill";
import { theme } from "../../theme";
import { ROLE_NAMES, type ProductGoal, type TeamView } from "../teams/model";
import { GoalList, TeamList } from "../teams/RunLists";

export type InboxView = "sessions" | "teams" | "goals";

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function Inbox({
  connection,
  onDisconnect,
  pushNote,
  initialView = "sessions",
}: {
  connection: Connection;
  onDisconnect: () => void;
  pushNote?: string;
  initialView?: InboxView;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<InboxView>(initialView);
  const { data, online, loading, refreshing, seen, refresh } = usePoll(
    async () => {
      const [list, me] = await Promise.all([
        api<{ sessions: SessionRow[] }>(connection, "/sessions"),
        api<Me>(connection, "/me"),
      ]);
      return {
        sessions: [...list.sessions].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
        me,
      };
    },
    2500,
    [connection],
  );
  // Hosts that predate teams advertise no `teams` field and have no team routes to poll.
  const hasTeams = Boolean(data?.me.teams), hasGoals = Boolean(data?.me.goals);
  // Full run records are large, so only the visible tab polls quickly; the others refresh their counts slowly.
  const focused = useIsFocused();
  const pace = (tab: InboxView) => focused && view === tab ? 4000 : 20000;
  const teamsPoll = usePoll(() => hasTeams ? api<{ teams: TeamView[] }>(connection, "/teams").then(value => value.teams) : Promise.resolve(null), pace("teams"), [connection, hasTeams]);
  const goalsPoll = usePoll(() => hasGoals ? api<{ goals: ProductGoal[] }>(connection, "/goals").then(value => value.goals) : Promise.resolve(null), pace("goals"), [connection, hasGoals]);
  const teams = teamsPoll.data ?? [];
  const goals = goalsPoll.data ?? [];
  const teamTitles = new Map(teams.map(team => [team.id, team.title]));
  const shown = hasTeams ? view : "sessions";
  const refreshAll = () => { refresh(); teamsPoll.refresh(); goalsPoll.refresh(); };
  const runs = shown === "goals" ? goalsPoll : teamsPoll;
  // Each tab names how many of its items wait on a person.
  const tabs: [InboxView, string, number][] = [
    ["sessions", "Sessions", (data?.sessions ?? []).filter(session => session.attention.state === "needs-you").length],
    ["teams", "Teams", teams.filter(team => team.status === "needs-input").length],
    ...(hasGoals ? [["goals", "Goals", goals.filter(goal => goal.status === "needs-input").length] as [InboxView, string, number]] : []),
  ];
  const sessions = data?.sessions ?? [];
  const matches = sessions.filter(session => [session.title, session.id, PROVIDER_NAMES[session.provider]]
    .some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <View style={s.fill}>
      <View style={s.header}>
        <Text style={s.brand}>infinite</Text>
        <View style={s.connection}>
          <View style={[s.dot, !online && s.offlineDot]} />
          <Text style={s.small}>{online ? "Up to date" : loading ? "Connecting" : "Reconnecting"}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={s.list} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing || runs.refreshing} onRefresh={refreshAll} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
        <Text style={s.title}>{shown === "teams" ? "Teams" : shown === "goals" ? "Goals" : "Your sessions"}</Text>
        <Text style={s.body}>
          {data?.me.machine?.label || connection.label || (data?.me.environment === "local" ? "Laptop" : "Cloud machine")}
        </Text>
        <OfflineBanner
          online={online || loading}
          message="This view may be stale. Your agents may still be running. Check the machine and your network connection."
        />
        {hasTeams ? <View style={s.tabs}>
          {tabs.map(([value, label, waiting]) => <Button key={value} title={waiting ? `${label} · ${waiting}` : label} secondary={shown !== value} onPress={() => setView(value)} />)}
        </View> : null}
        {shown !== "sessions" ? <>
          <OfflineBanner online={runs.online || runs.loading} message="Team and goal updates are unavailable. Showing the last received state." />
          {shown === "teams" ? <TeamList connection={connection} me={data!.me} teams={teams} online={online && runs.online} />
            : <GoalList connection={connection} me={data!.me} goals={goals} online={online && runs.online} />}
        </> : <>
        <View style={s.listHeading}>
          <Text style={s.small}>
            {sessions.filter((session) => session.status === "running").length}{" "}
            running
          </Text>
          {data?.me.role === "owner" ? <Button title="New session" disabled={!online} onPress={() => router.push({ pathname: "/new", params: { machine: connectionKey(connection) } })} /> : null}
          <Button title={refreshing ? "Refreshing…" : "Refresh"} secondary disabled={refreshing} onPress={refresh} />
        </View>
        <Text style={s.small}>
          {online
            ? `Last updated ${seen}`
            : seen
              ? `Cached view from ${seen}`
              : "Waiting for a fresh response…"}
        </Text>
        <TextInput accessibilityLabel="Find a session" placeholder="Find a session…" value={query} onChangeText={setQuery}
          autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" placeholderTextColor={theme.colors.placeholder} style={s.search} />
        {query ? <Button title="Clear search" secondary onPress={() => setQuery("")} /> : null}
        {!matches.length && query ? <Text style={s.body}>No sessions match this search.</Text> : null}
        {groupSessions(matches).map((group) => (
          <View key={group.title}>
            <Text style={s.groupHeading}>{group.title.toUpperCase()}</Text>
            {group.rows.map((row) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${row.title}`}
                key={row.id}
                onPress={() =>
                  router.push({
                    pathname: "/session/[id]",
                    params: { id: row.id, machine: connectionKey(connection) },
                  })
                }
                style={({ pressed }) => [
                  s.row,
                  row.attention.state === "needs-you" && s.rowNeedsYou,
                  pressed && s.pressed,
                ]}
              >
                <View style={s.rowTop}>
                  <Text style={s.rowTitle} numberOfLines={1}>
                    {row.title}
                  </Text>
                  <StatePill state={row.attention.state} />
                </View>
                <Text style={s.now} numberOfLines={2}>
                  {row.attention.prompt?.destructive ? (
                    <Text style={s.destructive}>⚠ </Text>
                  ) : null}
                  {row.attention.now || "—"}
                </Text>
                <Text style={s.meta}>
                  {PROVIDER_NAMES[row.provider]}{row.backend === "cmux" ? " · cmux" : ""} ·{" "}
                  {timeAgo(row.attention.since)}
                  {row.team ? ` · ${ROLE_NAMES[row.team.role]} in ${teamTitles.get(row.team.runId) ?? "a team"}` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        ))}
        {!sessions.length && online && (
          <View style={s.empty}>
            <Text style={s.subtitle}>A session that stays.</Text>
            <Text style={s.body}>
              {data?.me.role === "owner" ? "Start a session on this machine from this phone." : "Sessions appear here when an owner creates one on this machine."}
            </Text>
          </View>
        )}
        </>}
      </ScrollView>
      <View style={s.bottom}>
        {pushNote ? <Text style={s.small}>{pushNote}</Text> : null}
        <Button
          title="Remove this machine"
          secondary
          onPress={onDisconnect}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 25,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.rule,
  },
  brand: {
    fontSize: 30,
    letterSpacing: -1.1,
    fontWeight: "600",
    color: theme.colors.ink,
  },
  connection: { flexDirection: "row", alignItems: "center", gap: 7 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.running,
  },
  offlineDot: { backgroundColor: theme.colors.warningInk },
  small: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
  list: { padding: 25 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  search: {
    minHeight: 50, borderWidth: 1, borderColor: theme.colors.fieldRule,
    borderRadius: theme.radius.control, color: theme.colors.ink, fontSize: 15,
    paddingHorizontal: 14, paddingVertical: 12, marginTop: 16, marginBottom: 8,
  },
  title: {
    fontSize: 30,
    fontWeight: "500",
    color: theme.colors.ink,
    letterSpacing: -0.8,
    marginVertical: 10,
  },
  body: {
    fontSize: 15,
    lineHeight: 24,
    color: theme.colors.mutedInk,
    marginBottom: 20,
  },
  listHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.rule,
    paddingVertical: 15,
    marginTop: 10,
  },
  groupHeading: {
    fontSize: 12,
    letterSpacing: 0.6,
    fontWeight: "600",
    color: theme.colors.mutedInk,
    marginTop: theme.space.section,
    marginBottom: 4,
  },
  row: {
    paddingVertical: theme.space.label,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.rule,
    gap: 6,
  },
  rowNeedsYou: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.warningInk,
    paddingLeft: 12,
  },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 15,
  },
  rowTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: "500",
    color: theme.colors.ink,
  },
  now: { fontSize: 14, lineHeight: 20, color: theme.colors.ink },
  destructive: { color: theme.colors.error },
  meta: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
  bottom: { padding: theme.space.inset },
  empty: { padding: 30, gap: 15 },
  subtitle: {
    fontSize: 18,
    fontWeight: "500",
    color: theme.colors.ink,
    marginBottom: 15,
  },
});
