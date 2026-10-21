import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Board as BoardData, type BoardItem, type Connection, type Me, type ProjectGroup, type ProjectGroupList, type ProjectGroupSuggestion } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Avatar } from "../../components/Avatar";
import { Chip, GroupHeader, LiveStatus, Sheet, SheetRow } from "../../components/Glass";
import { Glyph, StatusIcon } from "../../components/Icon";
import { FloatingNotice } from "../../components/FloatingNotice";
import { age, type StatusKind } from "../../status";
import { theme } from "../../theme";
import { visibleGroups } from "../projects/model";
import { Composer } from "./Composer";
import { groupBoard, missionStatusLabel } from "./model";

export function Board({ connection, machines, pushNote, onSelectMachine, onAddMachine, onDisconnect }: {
  connection: Connection; machines: Connection[]; pushNote?: string;
  onSelectMachine: (key: string) => void; onAddMachine: () => void; onDisconnect: () => void;
}) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const [machineSheet, setMachineSheet] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [endedOpen, setEndedOpen] = useState(false);
  const poll = usePoll(async () => {
    const [board, groups, me] = await Promise.all([
      api<BoardData>(connection, "/board"),
      api<ProjectGroupList>(connection, "/project-groups"),
      api<Me>(connection, "/me"),
    ]);
    return { board, groups: groups.groups, suggestions: groups.suggestions, me, at: Date.now() };
  }, 4000, [connection]);
  const groups: ProjectGroup[] = poll.data?.groups ?? [];
  const suggestions: ProjectGroupSuggestion[] = poll.data?.suggestions ?? [];
  const chips = visibleGroups(groups);
  const owner = poll.data?.me.role === "owner";
  if (projectId && !chips.some(group => group.id === projectId)) setProjectId("");
  const sections = groupBoard(poll.data?.board.items ?? [], projectId || undefined);
  const machineName = connection.label || (() => { try { return new URL(connection.url).host; } catch { return "Machine"; } })();
  const open = (item: BoardItem) => {
    if (item.kind === "mission") router.push({ pathname: "/mission/[id]", params: { id: item.id, machine } });
    else if (item.kind === "team") router.push({ pathname: "/team/[id]", params: { id: item.id, machine } });
    else router.push({ pathname: "/goal/[id]", params: { id: item.id, machine } });
  };
  const titleOfStatus = (item: BoardItem) => {
    if (item.kind === "mission") return missionStatusLabel(item.status as Parameters<typeof missionStatusLabel>[0]);
    const words = item.status.replace(/-/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const kindOf = (item: BoardItem): StatusKind => {
    if (item.status === "needs-input") return "attention";
    if (item.status === "blocked") return "blocked";
    if (item.status === "paused") return "paused";
    if (item.column === "review") return "review";
    if (item.column === "ended") return item.status === "cancelled" ? "cancelled" : "done";
    return "progress";
  };
  const refresh = () => poll.refresh();

  return <View style={s.fill}>
    <View style={s.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Machine: ${machineName}. Switch or add machines`} onPress={() => setMachineSheet(true)} style={s.machine}>
        <Text style={s.machineName} numberOfLines={1}>{machineName}</Text>
        <View style={s.toggle}><Glyph name="down" size={11} color={theme.colors.secondaryInk} /></View>
      </Pressable>
      <LiveStatus online={poll.online} loading={poll.loading} seen={poll.seen} stale={poll.stale} />
    </View>
    <ScrollView style={s.list} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <Text style={s.title} accessibilityRole="header">Board</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filters}>
        <Chip label="All" accessibilityLabel="All projects" selected={!projectId} onPress={() => setProjectId("")} />
        {chips.map(group => <Chip key={group.id} label={group.name} selected={projectId === group.id} onPress={() => setProjectId(group.id)} accessibilityLabel={`Filter by ${group.name}`} />)}
      </ScrollView>
      {!chips.length && poll.online ? <Text style={s.note}>No projects are available on this machine.</Text> : null}
      {sections.map(section => {
        const folded = section.id === "ended" && !endedOpen;
        return <View key={section.id}>
          <GroupHeader kind={section.id === "needs-input" ? "attention" : section.id === "working" ? "progress" : section.id === "review" ? "review" : "stopped"}
            title={section.title} count={section.items.length}
            collapsed={section.id === "ended" ? folded : undefined}
            onToggle={section.id === "ended" ? () => setEndedOpen(value => !value) : undefined} />
          {section.id !== "ended" ? <Text style={s.subtitle}>{section.subtitle}</Text> : null}
          {folded ? null : section.items.map(item => <Pressable key={`${item.kind}/${item.id}`} accessibilityRole="button"
            accessibilityLabel={`Open ${item.kind} ${item.title}, ${titleOfStatus(item)}`} onPress={() => open(item)}
            style={({ pressed }) => [s.row, pressed && s.pressed]}>
            <View style={s.icon}><StatusIcon kind={kindOf(item)} size={18} /></View>
            <View style={s.main}>
              <View style={s.rowHead}>
                <Text style={s.rowTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={s.age}>{age(item.updatedAt, poll.data?.at ?? 0)}</Text>
              </View>
              <View style={s.rowMeta}>
                <Chip label={item.projectName} accessibilityLabel={`Project: ${item.projectName}`} />
                <Text style={[s.status, (item.column === "needs-input" || item.status === "paused") && s.attention]} numberOfLines={1}>{titleOfStatus(item)}</Text>
                {item.subtasks?.total ? <Text style={s.progress}>{item.subtasks.done}/{item.subtasks.total}</Text> : null}
              </View>
              <Text style={s.detail} numberOfLines={1}>{item.detail}</Text>
            </View>
            <Glyph name="forward" size={12} color={theme.colors.mutedInk} />
          </Pressable>)}
        </View>;
      })}
      {!poll.loading && sections.every(section => !section.items.length) ? <Text style={s.empty}>No work on this board yet.</Text> : null}
      {poll.data?.me.role !== "owner" ? <Text style={s.note}>This device can view the board but cannot start a mission.</Text> : null}
    </ScrollView>
    {owner ? <Composer connection={connection} groups={groups} items={poll.data?.board.items ?? []} suggestions={suggestions} owner={owner}
      onCreated={mission => {
        poll.refresh();
        router.push({ pathname: "/mission/[id]", params: { id: mission.id, machine } });
      }}
      onManage={() => router.push({ pathname: "/projects", params: { machine } })}
      onChanged={() => poll.refresh()} /> : null}
    <Sheet visible={machineSheet} onClose={() => setMachineSheet(false)} title="Machines">
      {machines.map(profile => {
        const key = connectionKey(profile);
        const current = key === machine;
        let label = profile.label;
        if (!label) { try { label = new URL(profile.url).host; } catch { label = "Machine"; } }
        return <SheetRow key={key} selected={current} label={label} detail={current ? (poll.online ? "Connected" : poll.stale ? "Offline" : "Connecting") : undefined}
          icon={<Avatar label={label} size={26} />} onPress={() => { setMachineSheet(false); if (!current) onSelectMachine(key); }} />;
      })}
      <SheetRow glyph="plus" label="Add machine" onPress={() => { setMachineSheet(false); onAddMachine(); }} />
      {pushNote ? <Text style={s.note}>{pushNote}</Text> : null}
      <SheetRow glyph="close" destructive label={`Remove ${machineName}…`} onPress={() => Alert.alert(`Remove ${machineName}?`, "Forgets it on this phone. Its agents keep running.", [
        { text: "Keep", style: "cancel" }, { text: "Remove", style: "destructive", onPress: onDisconnect },
      ])} />
    </Sheet>
    <FloatingNotice position="top" offset={58} message={poll.stale ? "Offline · showing the last received board." : null} />
  </View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 5, paddingBottom: 4, minHeight: 48 },
  machine: { flex: 1, flexDirection: "row", alignItems: "center", gap: 7, minHeight: 40 },
  machineName: { fontSize: 15, fontWeight: "600", color: theme.colors.ink, flexShrink: 1 },
  toggle: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.secondarySurface },
  list: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", color: theme.colors.ink, letterSpacing: -0.6, marginTop: 4 },
  filters: { flexDirection: "row", gap: 6, paddingVertical: 12, paddingRight: 16 },
  subtitle: { marginTop: -7, marginBottom: 2, fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
  row: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  icon: { width: 24, alignItems: "center" },
  main: { flex: 1, minWidth: 0, gap: 4 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.colors.ink },
  age: { fontSize: 11, color: theme.colors.mutedInk, fontVariant: ["tabular-nums"] },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 7 },
  status: { flexShrink: 1, fontSize: 12, color: theme.colors.mutedInk },
  attention: { color: theme.colors.warningInk, fontWeight: "600" },
  progress: { fontSize: 12, color: theme.colors.mutedInk, fontVariant: ["tabular-nums"] },
  detail: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
  empty: { paddingVertical: 24, fontSize: 14, color: theme.colors.mutedInk, textAlign: "center" },
  note: { marginHorizontal: 10, marginVertical: 8, fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
});
