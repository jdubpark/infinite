import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { connectionKey, type Connection } from "../api/client";
import { Pair } from "../features/pair/Pair";
import { loadConnections } from "../store/connection";
import { theme } from "../theme";

export default function Home() {
  const router = useRouter();
  const { machine, pair } = useLocalSearchParams<{ machine?: string; pair?: string }>();
  const [profiles, setProfiles] = useState<Connection[]>([]);
  const [active, setActive] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
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
  async function paired(next: Connection) {
    setError("");
    await reload(connectionKey(next));
    router.replace({ pathname: "/(tabs)", params: { machine: connectionKey(next) } });
  }
  if (!loaded) return <SafeAreaView style={s.safe}><ActivityIndicator style={s.loading} color={theme.colors.forest} /></SafeAreaView>;
  if (connection && pair !== "true") return <Redirect href={{ pathname: "/(tabs)", params: { machine: active } }} />;
  return <SafeAreaView style={s.safe}>
    <Pair initialError={error} onCancel={profiles.length ? () => router.back() : undefined} onPaired={next => void paired(next)} />
  </SafeAreaView>;
}

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: theme.colors.paper }, loading: { marginTop: 100 } });
