import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { Connection } from "../../api/client";
import { loadConnection } from "../../store/connection";
import { Button } from "../../components/Button";
import { theme } from "../../theme";

/**
 * Shared shell for the `/session/[id]` routes: reads the session id from the
 * route, loads the saved pairing, and sends an unpaired phone back to `/`.
 */
export function SessionGate({
  render,
}: {
  render: (connection: Connection, id: string) => ReactNode;
}) {
  const { id, machine } = useLocalSearchParams<{ id: string; machine?: string }>();
  const router = useRouter();
  const [saved, setSaved] = useState<{ connection: Connection; machine?: string } | null>(null);
  const connection = saved?.machine === machine ? saved?.connection : null;
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    loadConnection(machine)
      .then((value) => {
        if (!active) return;
        if (value) setSaved({ connection: value, machine });
        else { setError("This machine is not paired. Return to Machines and connect it first."); }
      })
      .catch(() =>
        setError(
          "Could not open the saved connection. Return to Sessions and pair again.",
        ),
      );
    return () => { active = false; };
  }, [machine, router]);
  return (
    <SafeAreaView style={s.safe}>
      {connection && id ? (
        <View key={`${machine}/${id}`} style={s.safe}>{render(connection, id)}</View>
      ) : error ? (
        <View><Text accessibilityRole="alert" style={s.error}>{error}</Text><Button title="Machines" onPress={() => router.replace("/")} /></View>
      ) : (
        <ActivityIndicator style={s.loading} />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.paper },
  loading: { marginTop: 100 },
  error: {
    color: theme.colors.error,
    fontSize: 13,
    lineHeight: 20,
    padding: theme.space.section,
  },
});
