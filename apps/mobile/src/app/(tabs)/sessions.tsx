import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { closeConnection } from "../../api/client";
import { Inbox } from "../../features/inbox/Inbox";
import { forgetMachine, useSharedMachine } from "../../store/machines";
import { unregisterPush } from "../../push/register";
import { theme } from "../../theme";

export default function Sessions() {
  const router = useRouter();
  const { loaded, active, connection, profiles, select } = useSharedMachine();
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
    <View style={s.fill}>
      <Inbox key={active} connection={connection} machines={profiles} onSelectMachine={key => void select(key)}
        onAddMachine={() => router.push({ pathname: "/pair", params: { pair: "true" } })} onDisconnect={() => void disconnect()} />
    </View>
  </SafeAreaView>;
}

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: theme.colors.paper }, fill: { flex: 1 }, loading: { marginTop: 100 } });
