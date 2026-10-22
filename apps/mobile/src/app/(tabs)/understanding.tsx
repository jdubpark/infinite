import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, connectionKey, type ProjectGroup, type ProjectGroupList } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Glyph } from "../../components/Icon";
import { useSharedMachine } from "../../store/machines";
import { theme } from "../../theme";

export default function UnderstandingIndex() {
  const router = useRouter();
  const { loaded, connection } = useSharedMachine();
  const key = connection ? `${connectionKey(connection)}|${connection.url}|${connection.relay?.machineId ?? "direct"}` : "";
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const poll = usePoll(async () => connection
    ? { connection: key, groups: await api<ProjectGroupList>(connection, "/project-groups") }
    : null, 5000, [connection, key]);
  const result = poll.data?.connection === key ? poll.data : null;
  const visible = result?.groups.groups.filter(group => !group.hidden) ?? [];
  const hidden = result?.groups.groups.filter(group => group.hidden) ?? [];

  const open = (group: ProjectGroup) => router.push({ pathname: "/understanding/[id]", params: { id: group.id } });
  return <SafeAreaView style={s.fill} edges={["top", "left", "right"]}>
    <View style={s.header}>
      <Text style={s.title} accessibilityRole="header">Understand</Text>
      <Text style={s.subtitle}>{connection?.label || "Selected machine"} · work and system briefs.</Text>
    </View>
    <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={poll.refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      {!loaded || !connection || (poll.loading && !result) ? <ActivityIndicator style={s.loading} color={theme.colors.forest} /> : null}
      {visible.map(group => <Pressable key={group.id} accessibilityRole="button" accessibilityLabel={`Open brief for ${group.name}`} onPress={() => open(group)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
        <View style={s.rowMain}>
          <Text style={s.rowTitle} numberOfLines={1}>{group.name}</Text>
          <Text style={s.detail}>{group.repos.length} {group.repos.length === 1 ? "repository" : "repositories"} · {checkoutCount(group)} {checkoutCount(group) === 1 ? "checkout" : "checkouts"}</Text>
        </View>
        <Glyph name="forward" size={13} color={theme.colors.mutedInk} />
      </Pressable>)}
      {result && !visible.length ? <Text style={s.note}>No visible workspaces are available on this machine.</Text> : null}
      {hidden.length ? <View style={s.hidden}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: hiddenOpen }} onPress={() => setHiddenOpen(value => !value)} style={s.hiddenHead}>
          <Text style={s.hiddenTitle}>Hidden workspaces · {hidden.length}</Text><Glyph name={hiddenOpen ? "down" : "forward"} size={12} color={theme.colors.mutedInk} />
        </Pressable>
        {hiddenOpen ? hidden.map(group => <Pressable key={group.id} accessibilityRole="button" accessibilityLabel={`Open hidden workspace ${group.name}`} onPress={() => open(group)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
          <View style={s.rowMain}><Text style={s.rowTitle} numberOfLines={1}>{group.name}</Text><Text style={s.detail}>{group.repos.length} {group.repos.length === 1 ? "repository" : "repositories"}</Text></View>
          <Glyph name="forward" size={13} color={theme.colors.mutedInk} />
        </Pressable>) : null}
      </View> : null}
      {!result && poll.stale ? <Text style={s.note}>Could not load workspaces. Pull to retry.</Text> : null}
      {result && !poll.online ? <Text style={s.note}>Offline · showing the last received workspace list.</Text> : null}
    </ScrollView>
  </SafeAreaView>;
}

function checkoutCount(group: ProjectGroup) { return group.repos.reduce((count, repo) => count + repo.checkouts.length, 0); }

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.colors.paper },
  header: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 12 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", color: theme.colors.ink, letterSpacing: -0.6 },
  subtitle: { marginTop: 4, fontSize: 13, lineHeight: 19, color: theme.colors.mutedInk },
  content: { paddingHorizontal: 18, paddingBottom: 24 },
  row: { minHeight: 66, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  rowMain: { flex: 1, minWidth: 0, gap: 4 },
  rowTitle: { fontSize: 15, fontWeight: "600", color: theme.colors.ink },
  detail: { fontSize: 12, color: theme.colors.mutedInk },
  note: { marginVertical: 12, fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
  hidden: { marginTop: 24 },
  hiddenHead: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  hiddenTitle: { fontSize: 13, fontWeight: "600", color: theme.colors.secondaryInk },
  loading: { marginTop: 48 },
});
