import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { api, closeConnection, connectionKey, type Connection, type Me } from "../api/client";
import { registerForPush, unregisterPush, type PushState } from "../push/register";
import { clearConnection, identifyConnection, loadConnections, selectConnection } from "../store/connection";
import { clearDrafts } from "../store/drafts";
import { creations, goalCreations, lifecycles, runRequests, teamCreations } from "../store/requests";
import { Pair } from "../features/pair/Pair";
import { Inbox, type InboxView } from "../features/inbox/Inbox";
import { Button } from "../components/Button";
import { theme } from "../theme";

export default function Home() {
  const { machine, view } = useLocalSearchParams<{ machine?: string; view?: string }>();
  const [profiles, setProfiles] = useState<Connection[]>([]);
  const [active, setActive] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState("");
  const [push, setPush] = useState<Record<string, PushState>>({});
  const connection = profiles.find(profile => connectionKey(profile) === active) ?? null;
  async function reload(preferred?: string) {
    const saved = await loadConnections();
    setProfiles(saved.profiles);
    setActive(saved.profiles.some(profile => connectionKey(profile) === preferred) ? preferred! : saved.active);
  }
  useEffect(() => {
    let live = true;
    loadConnections().then(saved => {
      if (!live) return;
      setProfiles(saved.profiles);
      setActive(saved.profiles.some(profile => connectionKey(profile) === machine) ? machine! : saved.active);
    }).catch(() => { if (live) setError("Saved machines could not be opened. Pair this device again."); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [machine]);
  useEffect(() => {
    let live = true;
    // Register on every paired machine, including machines that are not selected.
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
  }
  async function disconnect() {
    if (!connection) return;
    await unregisterPush(connection);
    closeConnection(connection);
    clearDrafts(connectionKey(connection));
    creations.clear(connectionKey(connection));
    lifecycles.clearMachine(connectionKey(connection));
    teamCreations.clear(connectionKey(connection));
    goalCreations.clear(connectionKey(connection));
    runRequests.clearMachine(connectionKey(connection));
    await clearConnection(connectionKey(connection));
    await reload();
  }
  return <SafeAreaView style={s.safe}>
    {!loaded ? <ActivityIndicator style={s.loading} /> : pairing || !connection ? <Pair
      initialError={error}
      onCancel={profiles.length ? () => setPairing(false) : undefined}
      onPaired={next => { setError(""); setPairing(false); void reload(connectionKey(next)); }}
    /> : <>
      <View style={s.machines}>
        <Text style={s.label}>MACHINES</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.choices}>
          {profiles.map(profile => <Button key={connectionKey(profile)} title={profile.label || new URL(profile.url).host}
            secondary={connectionKey(profile) !== active} onPress={() => void select(connectionKey(profile))} />)}
          <Button title="Add machine" secondary onPress={() => setPairing(true)} />
        </ScrollView>
      </View>
      <Inbox key={active} connection={connection} onDisconnect={() => void disconnect()}
        initialView={view === "teams" || view === "goals" ? view as InboxView : undefined}
        pushNote={push[active] ? PUSH_NOTES[push[active]] : undefined} />
    </>}
  </SafeAreaView>;
}

const PUSH_NOTES: Record<PushState, string> = {
  registered: "Notifications on for this machine",
  denied: "Notifications off: permission denied",
  unavailable: "Notifications unavailable until this build has an EAS project id",
};
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.paper },
  loading: { marginTop: 100 },
  machines: { paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.rule },
  label: { fontSize: 10, color: theme.colors.mutedInk, marginBottom: 8, letterSpacing: 1 },
  choices: { gap: 8 },
});
