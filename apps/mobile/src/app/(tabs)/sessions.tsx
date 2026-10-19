import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { closeConnection, connectionKey } from "../../api/client";
import { Inbox } from "../../features/inbox/Inbox";
import { loadConnections, selectConnection, useConnections } from "../../store/connection";
import { forgetMachine } from "../../store/machines";
import { unregisterPush } from "../../push/register";
import { theme } from "../../theme";

export default function Sessions() {
  const router = useRouter();
  const { machine } = useLocalSearchParams<{ machine?: string }>();
  const saved = useConnections();
  const profiles = saved.profiles;
  const active = profiles.some(profile => connectionKey(profile) === machine) ? machine! : saved.active;
  const [loaded, setLoaded] = useState(false);
  const connection = profiles.find(profile => connectionKey(profile) === active) ?? null;
  useEffect(() => {
    let live = true;
    loadConnections().then(current => {
      if (!live) return;
      if (!current.profiles.length) router.replace("/");
    }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [machine, router]);
  async function select(key: string) {
    await selectConnection(key);
    router.setParams({ machine: key });
  }
  async function disconnect() {
    if (!connection) return;
    const removal = forgetMachine(connection);
    await unregisterPush(connection);
    closeConnection(connection);
    await removal;
    if (profiles.length === 1) router.replace("/");
  }
  if (!loaded || !connection) return <SafeAreaView style={s.safe}><ActivityIndicator style={s.loading} color={theme.colors.forest} /></SafeAreaView>;
  return <SafeAreaView style={s.safe}>
    <View style={s.fill}>
      <Inbox key={active} connection={connection} machines={profiles} onSelectMachine={key => void select(key)}
        onAddMachine={() => router.push({ pathname: "/", params: { pair: "true" } })} onDisconnect={() => void disconnect()} />
    </View>
  </SafeAreaView>;
}

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: theme.colors.paper }, fill: { flex: 1 }, loading: { marginTop: 100 } });
