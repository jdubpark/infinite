import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSharedMachine } from "../../store/machines";
import { theme } from "../../theme";
import { WorkBriefScreen } from "../../features/understanding/WorkBriefScreen";

export default function UnderstandingWorkRoute() {
  const { workspace, work, machine } = useLocalSearchParams<{ workspace?: string; work?: string; machine?: string }>();
  const { loaded, connection } = useSharedMachine();
  if (!loaded || !connection) return <View style={s.fill}><ActivityIndicator style={s.loading} color={theme.colors.forest} /></View>;
  if (!workspace || !work) return <View style={s.fill}><Text style={s.note}>This work is not available.</Text></View>;
  return <SafeAreaView style={s.fill}>
    <WorkBriefScreen key={`${connection.id ?? connection.url}|${connection.url}|${connection.relay?.machineId ?? "direct"}:${workspace}:${work}`}
      connection={connection} workspaceId={workspace} workId={work} machine={machine} />
  </SafeAreaView>;
}

const s = StyleSheet.create({ fill: { flex: 1, backgroundColor: theme.colors.paper }, loading: { marginTop: 100 }, note: { padding: 20, color: theme.colors.mutedInk } });
