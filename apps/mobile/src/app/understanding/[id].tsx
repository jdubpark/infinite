import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSharedMachine } from "../../store/machines";
import { theme } from "../../theme";
import { UnderstandingWorkspace } from "../../features/understanding/UnderstandingWorkspace";

export default function UnderstandingRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { loaded, connection } = useSharedMachine();
  if (!loaded || !connection) return <View style={s.fill}><ActivityIndicator style={s.loading} color={theme.colors.forest} /></View>;
  if (!id) return <View style={s.fill}><Text style={s.note}>This workspace is not available.</Text></View>;
  return <SafeAreaView style={s.fill}><UnderstandingWorkspace key={`${connection.id ?? connection.url}|${connection.url}|${connection.relay?.machineId ?? "direct"}:${id}`} connection={connection} workspaceId={id} /></SafeAreaView>;
}

const s = StyleSheet.create({ fill: { flex: 1, backgroundColor: theme.colors.paper }, loading: { marginTop: 100 }, note: { padding: 20, color: theme.colors.mutedInk } });
