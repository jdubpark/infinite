import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, closeConnection, connectionKey, type Connection, type Me } from "../../api/client";
import { clearDrafts } from "../../store/drafts";
import { clearConnection, identifyConnection, loadConnections, selectConnection } from "../../store/connection";
import { creations, goalCreations, missionCreations, lifecycles, runRequests, teamCreations } from "../../store/requests";
import { registerForPush, unregisterPush, type PushState } from "../../push/register";
import { Board } from "./Board";
import { theme } from "../../theme";

const PUSH_NOTES: Record<PushState, string> = {
  registered: "Notifications on for this machine",
  denied: "Notifications off: permission denied",
  unavailable: "Notifications unavailable until this build has an EAS project id",
};

export function BoardHome() {
  const router = useRouter();
  const { machine } = useLocalSearchParams<{ machine?: string }>();
  const [profiles, setProfiles] = useState<Connection[]>([]);
  const [active, setActive] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [push, setPush] = useState<Record<string, PushState>>({});
  const connection = profiles.find(profile => connectionKey(profile) === active) ?? null;
  async function reload(preferred?: string) {
    const saved = await loadConnections();
    setProfiles(saved.profiles);
    setActive(saved.profiles.some(profile => connectionKey(profile) === preferred) ? preferred! : saved.active);
    return saved.profiles;
  }
  useEffect(() => {
    let live = true;
    loadConnections().then(saved => {
      if (!live) return;
      setProfiles(saved.profiles);
      const next = saved.profiles.some(profile => connectionKey(profile) === machine) ? machine! : saved.active;
      setActive(next);
      if (!saved.profiles.some(profile => connectionKey(profile) === next)) router.replace("/");
    }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [machine, router]);
  useEffect(() => {
    let live = true;
    for (const profile of profiles) void (async () => {
      const me = await api<Me>(profile, "/me");
      if (!live) return;
      if (me.machine?.id) await identifyConnection(profile, me.machine.id);
      if (!live || !me.capabilities?.push) return;
      const state = await registerForPush(profile);
      if (live) setPush(previous => ({ ...previous, [connectionKey(profile)]: state }));
    })().catch(() => {});
    return () => { live = false; };
  }, [profiles]);
  async function select(id: string) {
    await selectConnection(id);
    setActive(id);
    router.setParams({ machine: id });
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
    <Board key={active} connection={connection} machines={profiles} onSelectMachine={id => void select(id)}
      onAddMachine={() => router.push({ pathname: "/", params: { pair: "true" } })} onDisconnect={() => void disconnect()}
      pushNote={push[active] ? PUSH_NOTES[push[active]] : undefined} />
  </SafeAreaView>;
}

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: theme.colors.paper }, loading: { marginTop: 100 } });
