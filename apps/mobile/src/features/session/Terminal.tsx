import {
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { PROVIDER_NAMES } from "@infinite/attention";
import {
  api,
  type Connection,
  type Me,
  type SessionDetail,
} from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { Composer } from "../../components/Composer";
import { OfflineBanner } from "../../components/OfflineBanner";
import { theme } from "../../theme";
import { KEYS, useSteering } from "./useSteering";

/** The session's current screen, the raw key row and the text composer. */
export function Terminal({
  connection,
  id,
  backLabel = "Sessions",
}: {
  connection: Connection;
  id: string;
  backLabel?: string;
}) {
  const router = useRouter();
  const { data, online, seen, refresh } = usePoll(
    async () => {
      const [detail, me] = await Promise.all([
        api<SessionDetail>(connection, `/sessions/${id}`),
        api<Me>(connection, "/me"),
      ]);
      return { detail, me };
    },
    1500,
    [connection, id],
  );
  const session = data?.detail ?? null;
  const role = data?.me.role ?? "viewer";
  const environment = data?.me.environment ?? "";
  // The person sees the screen here, so text may go into an open dialog.
  const steering = useSteering(connection, id, refresh, { force: true });
  const canSteer = online && session?.status === "running" && role !== "viewer";
  function back() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }
  return (
    // Android runs edge-to-edge, so the window no longer resizes for the keyboard.
    <KeyboardAvoidingView style={s.fill} behavior="padding">
      <View style={s.header}>
        <Button title={backLabel} secondary onPress={back} />
        <Text style={[s.small, !online && s.offlineText]}>
          {online ? "Connected" : "Reconnecting"}
        </Text>
      </View>
      {!session ? (
        <View style={s.empty}>
          <ActivityIndicator />
          <Text style={s.body}>Waiting for this session…</Text>
        </View>
      ) : (
        <>
          <View style={s.titleBlock}>
            <Text style={s.title}>{session.title}</Text>
            <Text style={s.small}>
              {PROVIDER_NAMES[session.provider]} · {session.status}
            </Text>
            <Text style={s.small}>
              {environment === "local" ? "Local host" : "Cloud host"} ·{" "}
              {session.pid ? `PID ${session.pid}` : "No live process"}
            </Text>
            <Text style={s.small}>
              {new URL(connection.url).host} · Checked {seen || "—"}
            </Text>
          </View>
          <OfflineBanner
            online={online}
            message="Last received view. Input is disabled until the host reconnects."
          />
          <ScrollView style={s.fill} contentContainerStyle={s.scrollBody}>
            <Text style={s.label}>Current screen</Text>
            <Text selectable style={s.screen}>
              {session.screen || "This process has no current screen."}
            </Text>
          </ScrollView>
          {role !== "viewer" && (
            <Composer
              canSteer={canSteer}
              busy={steering.busy}
              pending={steering.pending}
              receipt={steering.receipt}
              error={steering.error}
              onSend={steering.send}
            >
              {KEYS.map((key) => (
                <Button
                  key={key}
                  title={key[0].toUpperCase() + key.slice(1)}
                  onPress={() => steering.sendKey(key)}
                  secondary
                  disabled={!canSteer || steering.busy}
                />
              ))}
            </Composer>
          )}
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: theme.space.inset,
    paddingVertical: theme.space.label,
  },
  small: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
  offlineText: { color: theme.colors.warningInk },
  empty: { padding: 30, gap: 15 },
  body: {
    fontSize: 15,
    lineHeight: 24,
    color: theme.colors.mutedInk,
    marginBottom: 20,
  },
  titleBlock: { paddingHorizontal: theme.space.section, paddingVertical: 16 },
  title: {
    fontSize: 30,
    fontWeight: "500",
    color: theme.colors.ink,
    letterSpacing: -0.8,
    marginVertical: 10,
  },
  scrollBody: { padding: theme.space.section, paddingTop: 10 },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.ink,
    marginBottom: 10,
    marginTop: 17,
  },
  screen: {
    fontFamily: theme.mono,
    fontSize: 11,
    lineHeight: 19,
    padding: 16,
    borderRadius: theme.radius.panel,
    backgroundColor: theme.colors.screenSurface,
    color: theme.colors.screenInk,
  },
});
