import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Connection } from "../../api/client";
import { loadConnection } from "../../store/connection";
import { useEffect, useState } from "react";
import { MissionDetail } from "../../features/board/MissionDetail";
import { theme } from "../../theme";

export default function MissionRoute() {
  const { id, machine } = useLocalSearchParams<{ id: string; machine?: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);
  useEffect(() => { let live = true; loadConnection(machine).then(value => { if (live) setConnection(value); }); return () => { live = false; }; }, [machine]);
  if (!connection || !id) return <SafeAreaView style={s.safe}><ActivityIndicator style={s.loading} color={theme.colors.forest} /></SafeAreaView>;
  return <SafeAreaView style={s.safe}><MissionDetail connection={connection} id={id} /></SafeAreaView>;
}

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: theme.colors.paper }, loading: { marginTop: 100 } });
