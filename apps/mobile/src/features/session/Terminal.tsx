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
import { ControlBar } from "../../components/ControlBar";
import { OfflineBanner } from "../../components/OfflineBanner";
import { theme } from "../../theme";
import { useControlSync, useSessionControl } from "./useSessionControl";
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
  const control = useSessionControl(connection, id);
  const { data, online, seen, refresh } = usePoll(
    async () => {
      // A poll that started before a local control change must not undo it.
      const revision = control.generation();
      const [session, me] = await Promise.all([
        api<SessionDetail>(connection, `/sessions/${id}`),
        api<Me>(connection, "/me"),
      ]);
      return { session, me, revision };
    },
    1500,
    [connection, id],
  );
  useControlSync(control, data, online);
  const session = data?.session ?? null;
  const role = data?.me.role;
  const environment = data?.me.environment ?? "";
  // Workers that enforce control take input only from the device holding the lease.
  const requiresControl = session?.capabilities?.inputControl === 1;
  // The person sees the screen here, so text may go into an open dialog.
  const steering = useSteering(connection, id, refresh, control, {
    force: true,
    draftKey: `${connection.url}/${id}/terminal`,
    requiresControl,
  });
  const running = session?.status === "running";
  const controlled = !requiresControl || control.lease !== null;
  const canSteer =
    online && running && role !== undefined && role !== "viewer" && controlled;
  async function takeControl(takeover: boolean) {
    await control.claim(takeover);
    refresh();
  }
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
          {online ? "Up to date" : "Reconnecting"}
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
              {new URL(connection.url).host} ·{" "}
              {online
                ? `Updated ${seen}`
                : seen
                  ? `Cached view from ${seen}`
                  : "Waiting for a fresh response…"}
            </Text>
          </View>
          <OfflineBanner
            online={online}
            message="Last received view. Input is disabled until the host reconnects."
          />
          <ControlBar
            role={role}
            requiresControl={requiresControl}
            running={running}
            online={online}
            lease={control.lease}
            holder={control.holder}
            busy={control.busy}
            message={control.message}
            onTake={(takeover) => void takeControl(takeover)}
            onRelease={() => {
              control.forget(true);
              refresh();
            }}
            onRefresh={refresh}
          />
          <ScrollView style={s.fill} contentContainerStyle={s.scrollBody}>
            <Text style={s.label}>Current screen</Text>
            <Text selectable style={s.screen}>
              {session.screen || "This process has no current screen."}
            </Text>
          </ScrollView>
          {role !== undefined && role !== "viewer" && (
            <Composer
              canSteer={canSteer}
              onTakeControl={online && running && !controlled ? () => void takeControl(Boolean(control.holder)) : undefined}
              controlBusy={control.busy}
              controlLabel={control.holder ? "Take over" : "Take control"}
              idleHint={
                online && running && !controlled
                  ? "Draft here. Take control when ready…"
                  : undefined
              }
              busy={steering.busy}
              pending={steering.pending}
              receipt={steering.receipt}
              error={steering.error}
              text={steering.text}
              onChangeText={steering.setText}
              onSend={() => void steering.send()}
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
