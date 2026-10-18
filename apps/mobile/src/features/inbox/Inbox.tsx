import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useIsFocused, useRouter } from "expo-router";
import { PROVIDER_NAMES, groupSessions, type InboxGroup } from "@infinite/attention";
import {
  api,
  connectionKey,
  type Connection,
  type Me,
  type SessionRow,
} from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Avatar } from "../../components/Avatar";
import { GlassButton, GroupHeader, LiveStatus, Segmented, Sheet, SheetRow } from "../../components/Glass";
import { Glyph, StatusIcon } from "../../components/Icon";
import { OfflineBanner } from "../../components/OfflineBanner";
import { age, SESSION_KIND, SESSION_LABELS, type StatusKind } from "../../status";
import { theme } from "../../theme";
import { goalGroup, pendingApprovals, ROLE_NAMES, teamGroup, type ProductGoal, type TeamView } from "../teams/model";
import { GoalList, listStyles, TeamList } from "../teams/RunLists";

export type InboxView = "sessions" | "teams" | "goals";

const GROUP_KIND: Record<InboxGroup, StatusKind> = { "Needs you": "attention", Working: "progress", Finished: "review", Exited: "stopped" };
const machineName = (connection: Connection) => connection.label || new URL(connection.url).host;

/**
 * The machine's work in one place. The active machine's name opens a sheet to switch, add or remove
 * machines; Sessions, Teams and Goals sit in a floating capsule above the list.
 */
export function Inbox({
  connection,
  machines,
  onSelectMachine,
  onAddMachine,
  onDisconnect,
  pushNote,
  initialView = "sessions",
}: {
  connection: Connection;
  machines: Connection[];
  onSelectMachine: (key: string) => void;
  onAddMachine: () => void;
  onDisconnect: () => void;
  pushNote?: string;
  initialView?: InboxView;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<InboxView>(initialView);
  const [machineSheet, setMachineSheet] = useState(false);
  const [exitedOpen, setExitedOpen] = useState(false);
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
        // Ages advance with each poll instead of reading the clock while rendering.
        at: Date.now(),
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
  const all = data?.sessions ?? [];
  // Team agents are the coordinator's to steer; they appear under their team and in search.
  const sessions = all.filter(session => !session.team);
  const teamAgents = all.length - sessions.length;
  const now = data?.at ?? 0;
  const waiting = {
    sessions: sessions.filter(session => session.attention.state === "needs-you").length,
    teams: teams.filter(team => teamGroup(team, pendingApprovals(team, all).length) === "attention").length,
    goals: goals.filter(goal => goalGroup(goal) === "attention").length,
  };
  const matches = (query.trim() ? all : sessions).filter(session => [session.title, session.id, PROVIDER_NAMES[session.provider]]
    .some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  const owner = data?.me.role === "owner";
  const canCreate = owner && online && (shown === "sessions" || (shown === "teams" ? data?.me.teams?.enabled : data?.me.goals?.enabled));
  const create = () => router.push({ pathname: shown === "sessions" ? "/new" : shown === "teams" ? "/team/new" : "/goal/new", params: { machine: connectionKey(connection) } });

  return (
    <View style={s.fill}>
      <View style={s.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Machine: ${machineName(connection)}. Switch or add machines`} onPress={() => setMachineSheet(true)} style={s.machine} hitSlop={6}>
          <Text style={s.machineName} numberOfLines={1}>{machineName(connection)}</Text>
          <View style={s.toggle}><Glyph name={machineSheet ? "up" : "down"} size={11} color={theme.colors.secondaryInk} /></View>
        </Pressable>
        <LiveStatus online={online} loading={loading} seen={seen} />
      </View>
      <OfflineBanner
        online={online || loading}
        message="Offline · showing the last received view. Agents may still be running."
      />
      {shown !== "sessions" ? <OfflineBanner online={runs.online || runs.loading} message="Teams offline · last received state." /> : null}
      <ScrollView contentContainerStyle={s.list} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing || runs.refreshing} onRefresh={refreshAll} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
        <Text style={s.title} accessibilityRole="header">{shown === "teams" ? "Teams" : shown === "goals" ? "Goals" : "Sessions"}</Text>
        {shown === "teams" && data ? <TeamList connection={connection} me={data.me} teams={teams} sessions={all} now={now} />
          : shown === "goals" && data ? <GoalList connection={connection} me={data.me} goals={goals} now={now} /> : <>
            {all.length > 4 || query ? <View style={s.search}>
              <Glyph name="search" size={15} color={theme.colors.placeholder} />
              <TextInput accessibilityLabel="Find a session" placeholder="Find a session" value={query} onChangeText={setQuery}
                autoCorrect={false} autoCapitalize="none" placeholderTextColor={theme.colors.placeholder} style={s.searchInput} />
              {query ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery("")} hitSlop={12}>
                <Glyph name="close" size={13} color={theme.colors.mutedInk} />
              </Pressable> : null}
            </View> : null}
            {!matches.length && query ? <Text style={s.summary}>No matches.</Text> : null}
            {groupSessions(matches).map((group) => {
              const folded = group.title === "Exited" && !exitedOpen && !query;
              return <View key={group.title}>
                <GroupHeader kind={GROUP_KIND[group.title]} title={group.title} count={group.rows.length}
                  collapsed={group.title === "Exited" ? folded : undefined} onToggle={group.title === "Exited" && !query ? () => setExitedOpen(value => !value) : undefined} />
                {folded ? null : group.rows.map((row) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${row.title}, ${SESSION_LABELS[row.attention.state]}`}
                    key={row.id}
                    onPress={() => router.push({ pathname: "/session/[id]", params: { id: row.id, machine: connectionKey(connection) } })}
                    style={({ pressed }) => [listStyles.row, pressed && listStyles.pressed]}
                  >
                    <View style={listStyles.icon}><StatusIcon kind={SESSION_KIND[row.attention.state]} size={18} /></View>
                    <View style={listStyles.main}>
                      <View style={listStyles.line}>
                        <Text style={listStyles.title} numberOfLines={1}>{row.title}</Text>
                        <Text style={listStyles.age}>{age(row.attention.since, now)}</Text>
                      </View>
                      <View style={listStyles.line}>
                        <Avatar label={PROVIDER_NAMES[row.provider]} provider={row.provider} size={18} />
                        <Text style={[s.now, row.attention.state === "needs-you" && listStyles.attentionText]} numberOfLines={1}>
                          {row.attention.prompt?.destructive ? <Text style={s.destructive}>Destructive · </Text> : null}
                          {row.team ? <Text style={s.role}>{ROLE_NAMES[row.team.role]}{teamTitles.has(row.team.runId) && !row.title.includes(teamTitles.get(row.team.runId)!) ? ` · ${teamTitles.get(row.team.runId)}` : ""} · </Text> : null}
                          {row.attention.now || SESSION_LABELS[row.attention.state]}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                ))}
              </View>;
            })}
            {teamAgents && !query ? <Pressable accessibilityRole="button" onPress={() => setView("teams")} style={s.agents} hitSlop={6}>
              <Glyph name="people" size={14} color={theme.colors.mutedInk} />
              <Text style={[listStyles.meta, s.fill]}>{teamAgents} team {teamAgents === 1 ? "agent" : "agents"} · in Teams</Text>
              <Glyph name="forward" size={11} color={theme.colors.mutedInk} />
            </Pressable> : null}
            {!all.length && online ? <View style={listStyles.empty}>
              <Text style={listStyles.emptyTitle}>No sessions</Text>
              <Text style={listStyles.meta}>{owner ? "Start one with +." : "None yet."}</Text>
            </View> : null}
          </>}
      </ScrollView>
      <View style={s.dock} pointerEvents="box-none">
        {hasTeams ? <Segmented style={s.tabs} value={shown} onChange={setView} options={[
          { value: "sessions", label: "Sessions", glyph: "stack", count: waiting.sessions, attention: true },
          { value: "teams", label: "Teams", glyph: "people", count: waiting.teams, attention: true },
          ...(hasGoals ? [{ value: "goals" as const, label: "Goals", glyph: "target" as const, count: waiting.goals, attention: true }] : []),
        ]} /> : <View style={s.fill} />}
        {owner ? <GlassButton primary glyph="plus" size={48} disabled={!canCreate}
          label={shown === "sessions" ? "New session" : shown === "teams" ? "New team" : "New goal"} onPress={create} /> : null}
      </View>
      <Sheet visible={machineSheet} onClose={() => setMachineSheet(false)} title="Machines">
        {machines.map(machine => {
          const key = connectionKey(machine);
          const current = key === connectionKey(connection);
          return <SheetRow key={key} selected={current} label={machineName(machine)} detail={current ? (online ? "Connected" : "Offline") : undefined}
            icon={<Avatar label={machineName(machine)} size={26} />} onPress={() => { setMachineSheet(false); if (!current) onSelectMachine(key); }} />;
        })}
        <SheetRow glyph="plus" label="Add machine" onPress={() => { setMachineSheet(false); onAddMachine(); }} />
        {pushNote ? <Text style={s.push}>{pushNote}</Text> : null}
        <SheetRow glyph="close" destructive label={`Remove ${machineName(connection)}…`}
          onPress={() => Alert.alert(`Remove ${machineName(connection)}?`, "Forgets it on this phone. Its agents keep running.", [
            { text: "Keep", style: "cancel" },
            { text: "Remove", style: "destructive", onPress: () => { setMachineSheet(false); onDisconnect(); } },
          ])} />
      </Sheet>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4, minHeight: 48 },
  machine: { flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 1, minHeight: 40 },
  machineName: { fontSize: 15, fontWeight: "600", color: theme.colors.ink, flexShrink: 1 },
  toggle: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.secondarySurface },
  list: { paddingHorizontal: 16, paddingBottom: 120 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", color: theme.colors.ink, letterSpacing: -0.6, marginTop: 4 },
  summary: { fontSize: 13, color: theme.colors.mutedInk, marginTop: 2, marginBottom: 4 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, height: 40, marginTop: 10, paddingHorizontal: 12, borderRadius: theme.radius.capsule, backgroundColor: theme.colors.secondarySurface },
  searchInput: { flex: 1, fontSize: 15, color: theme.colors.ink, paddingVertical: 0 },
  now: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.colors.mutedInk },
  role: { color: theme.colors.secondaryInk, fontWeight: "600" },
  destructive: { color: theme.colors.error, fontWeight: "700" },
  dock: { position: "absolute", left: 12, right: 12, bottom: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  tabs: { flex: 1, backgroundColor: theme.colors.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.glassRim, padding: 4, ...theme.lift },
  push: { fontSize: 12, color: theme.colors.mutedInk, paddingHorizontal: 50, paddingBottom: 6 },
  agents: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, marginTop: 8 },
});
