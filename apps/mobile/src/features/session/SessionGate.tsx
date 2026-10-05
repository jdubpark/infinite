import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { Connection } from "../../api/client";
import { loadConnection } from "../../store/connection";
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
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    loadConnection()
      .then((value) => {
        if (value) setConnection(value);
        else router.replace("/");
      })
      .catch(() =>
        setError(
          "Could not open the saved connection. Return to Sessions and pair again.",
        ),
      );
  }, [router]);
  return (
    <SafeAreaView style={s.safe}>
      {connection && id ? (
        render(connection, id)
      ) : error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
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
