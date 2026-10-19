import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { closeConnection, connectionKey, type Connection } from "../../api/client";
import { Inbox } from "../../features/inbox/Inbox";
import { clearDrafts } from "../../store/drafts";
import { clearConnection, loadConnections, selectConnection } from "../../store/connection";
import { creations, goalCreations, missionCreations, lifecycles, runRequests, teamCreations } from "../../store/requests";
import { unregisterPush } from "../../push/register";
import { theme } from "../../theme";

export default function Sessions() {
  const router = useRouter();
  const { machine } = useLocalSearchParams<{ machine?: string }>();
  const [profiles, setProfiles] = useState<Connection[]>([]);
  const [active, setActive] = useState("");
  const [loaded, setLoaded] = useState(false);
  const connection = profiles.find(profile => connectionKey(profile) === active) ?? null;
  const reload = async (preferred?: string) => {
    const saved = await loadConnections();
    setProfiles(saved.profiles);
    setActive(saved.profiles.some(profile => connectionKey(profile) === preferred) ? preferred! : saved.active);
    return saved.profiles;
  };
  useEffect(() => {
    let live = true;
    loadConnections().then(saved => {
      if (!live) return;
      setProfiles(saved.profiles);
      setActive(saved.profiles.some(profile => connectionKey(profile) === machine) ? machine! : saved.active);
    }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [machine]);
  async function select(key: string) {
    await selectConnection(key);
    setActive(key);
    router.setParams({ machine: key });
  }
  async function disconnect() {
    if (!connection) return;
    await unregisterPush(connection);
    closeConnection(connection);
    const key = connectionKey(connection);
    clearDrafts(key);
    creations.clear(key); lifecycles.clearMachine(key); teamCreations.clearMachine(key);
    goalCreations.clearMachine(key); missionCreations.clearMachine(key); runRequests.clearMachine(key);
    await clearConnection(key);
    const remaining = await reload();
    if (!remaining.length) router.replace("/");
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
