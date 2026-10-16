import { useEffect, useState } from "react";
import { ActivityIndicator, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { Connection } from "../api/client";
import { loadConnection } from "../store/connection";
import { Create } from "../features/create/Create";
import { Button } from "../components/Button";
import { theme } from "../theme";

export default function NewSession() {
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
    {connection ? <Create key={machine} connection={connection} /> : !loaded ? <ActivityIndicator /> : <>
      <Text style={{ padding: 24 }}>Connect this machine before creating a session.</Text>
      <Button title="Machines" onPress={() => router.replace("/")} />
    </>}
  </SafeAreaView>;
}
