import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { Connection } from "../api/client";
import { loadConnection } from "../store/connection";
import { Button } from "./Button";
import { theme } from "../theme";

/** Shell for screens that act on the machine named by the `machine` route parameter. */
export function ConnectedScreen({ missing, render }: { missing: string; render: (connection: Connection, machine?: string) => ReactNode }) {
  const { machine } = useLocalSearchParams<{ machine?: string }>();
  const router = useRouter();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    loadConnection(machine).then(value => { if (active) setConnection(value); })
      .catch(() => {}).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [machine]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.paper }}>
    {connection ? render(connection, machine) : !loaded ? <ActivityIndicator /> : <>
      <Text style={{ padding: 24 }}>{missing}</Text>
      <Button title="Machines" onPress={() => router.replace("/")} />
    </>}
  </SafeAreaView>;
}
