import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, type Connection, type Me } from "../api/client";
import {
  registerForPush,
  unregisterPush,
  type PushState,
} from "../push/register";
import { clearConnection, loadConnection } from "../store/connection";
import { Pair } from "../features/pair/Pair";
import { Inbox } from "../features/inbox/Inbox";
import { theme } from "../theme";

export default function Home() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [push, setPush] = useState<PushState | null>(null);
  useEffect(() => {
    loadConnection()
      .then((value) => {
        if (value) setConnection(value);
      })
      .catch(() =>
        setError(
          "Saved connection could not be opened. Pair this device again.",
        ),
      )
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!connection) return;
    let live = true;
    (async () => {
      const me = await api<Me>(connection, "/me");
      if (!me.capabilities?.push) return;
      const state = await registerForPush(connection);
      if (live) setPush(state);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [connection]);
  async function disconnect() {
    if (connection) await unregisterPush(connection);
    setPush(null);
    await clearConnection();
    setConnection(null);
  }
  return (
    <SafeAreaView style={s.safe}>
      {!loaded ? (
        <ActivityIndicator style={s.loading} />
      ) : !connection ? (
        <Pair
          initialError={error}
          onPaired={(next) => {
            setError("");
            setConnection(next);
          }}
        />
      ) : (
        <Inbox
          connection={connection}
          onDisconnect={disconnect}
          pushNote={push ? PUSH_NOTES[push] : undefined}
        />
      )}
    </SafeAreaView>
  );
}

const PUSH_NOTES: Record<PushState, string> = {
  registered: "Notifications on",
  denied: "Notifications off: permission denied",
  unavailable:
    "Notifications unavailable until this build has an EAS project id",
};

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.paper },
  loading: { marginTop: 100 },
});
