import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me, type ProjectGroup, type ProjectGroupList, type ProjectGroupSuggestion } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { GroupHeader, TopBar } from "../../components/Glass";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";
import { CombineRow } from "./CombineRow";
import { checkoutsOf, projectSections } from "./model";

/** Manage projects: visible rows, suggested combinations, and hidden projects folded away. */
export function ProjectsList({ connection }: { connection: Connection }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const poll = usePoll(async () => {
    const [list, me] = await Promise.all([api<ProjectGroupList>(connection, "/project-groups"), api<Me>(connection, "/me")]);
    return { list, me };
  }, 5000, [connection]);
  const owner = poll.data?.me.role === "owner";
  const sections = projectSections(poll.data?.list ?? { groups: [], suggestions: [] });
  const everyGroup = [...sections.visible, ...sections.hidden];
  const open = (group: ProjectGroup) => router.push({ pathname: "/projects/[id]", params: { id: group.id, machine } });

  return <View style={s.fill}>
    <TopBar backLabel="Board" onBack={() => router.back()} />
    <ScrollView style={s.fill} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={poll.refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <Text style={s.title} accessibilityRole="header">Projects</Text>
      {sections.visible.map(group => <ProjectRow key={group.id} group={group} onPress={() => open(group)} />)}
      {!poll.loading && poll.online && !sections.visible.length ? <Text style={s.note}>No projects are available on this machine.</Text> : null}
      {owner && sections.suggestions.length ? <View>
        <GroupHeader title="Suggestions" count={sections.suggestions.length} />
        {sections.suggestions.map((suggestion: ProjectGroupSuggestion) => <CombineRow key={suggestion.groupIds.join("+")} connection={connection}
          suggestion={suggestion} groups={everyGroup} onCombined={() => { setMessage(null); poll.refresh(); }}
          onError={setMessage} />)}
      </View> : null}
      {sections.hidden.length ? <View>
        <GroupHeader title="Hidden" count={sections.hidden.length} collapsed={!hiddenOpen} onToggle={() => setHiddenOpen(value => !value)} />
        {hiddenOpen ? sections.hidden.map(group => <ProjectRow key={group.id} group={group} onPress={() => open(group)} />) : null}
      </View> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={s.message}>{message}</Text> : null}
      {poll.data && !owner ? <Text style={s.note}>Only the owner can change projects.</Text> : null}
    </ScrollView>
  </View>;
}

function ProjectRow({ group, onPress }: { group: ProjectGroup; onPress: () => void }) {
  const repos = group.repos.length;
  const checkouts = checkoutsOf(group).length;
  const detail = `${repos} ${repos === 1 ? "repository" : "repositories"}${checkouts > repos ? ` · ${checkouts} checkouts` : ""}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open project ${group.name}`} onPress={onPress}
    style={({ pressed }) => [s.row, pressed && s.pressed]}>
    <View style={s.main}>
      <Text style={s.rowTitle} numberOfLines={1}>{group.name}</Text>
      <Text style={s.detail} numberOfLines={1}>{detail}</Text>
    </View>
    <Glyph name="forward" size={12} color={theme.colors.mutedInk} />
  </Pressable>;
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.colors.paper },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", color: theme.colors.ink, letterSpacing: -0.6, marginTop: 4, marginBottom: 8 },
  row: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  main: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { fontSize: 15, fontWeight: "600", color: theme.colors.ink },
  detail: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
  note: { marginVertical: 12, fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
  message: { marginVertical: 8, fontSize: 12, lineHeight: 17, color: theme.colors.error },
});
