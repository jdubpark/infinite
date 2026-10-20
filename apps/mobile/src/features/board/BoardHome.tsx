import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, closeConnection, connectionKey, type Me } from "../../api/client";
import { identifyConnection, loadConnections, selectConnection, useConnections } from "../../store/connection";
import { forgetMachine } from "../../store/machines";
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
  const saved = useConnections();
  const profiles = saved.profiles;
  const active = profiles.some(profile => connectionKey(profile) === machine) ? machine! : saved.active;
  const [loaded, setLoaded] = useState(false);
  const [push, setPush] = useState<Record<string, PushState>>({});
  const connection = profiles.find(profile => connectionKey(profile) === active) ?? null;
  useEffect(() => {
    let live = true;
    loadConnections().then(current => {
      if (!live) return;
      if (!current.profiles.length) router.replace("/pair");
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
    router.setParams({ machine: id });
  }
  async function disconnect() {
    if (!connection) return;
    const removal = forgetMachine(connection);
    await unregisterPush(connection);
    closeConnection(connection);
    await removal;
    if (profiles.length === 1) router.replace("/pair");
  }
  if (!loaded || !connection) return <SafeAreaView style={s.safe}><ActivityIndicator style={s.loading} color={theme.colors.forest} /></SafeAreaView>;
  return <SafeAreaView style={s.safe}>
    <Board key={active} connection={connection} machines={profiles} onSelectMachine={id => void select(id)}
      onAddMachine={() => router.push({ pathname: "/pair", params: { pair: "true" } })} onDisconnect={() => void disconnect()}
      pushNote={push[active] ? PUSH_NOTES[push[active]] : undefined} />
  </SafeAreaView>;
}

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: theme.colors.paper }, loading: { marginTop: 100 } });
