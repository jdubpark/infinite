import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { PROVIDER_NAMES } from "@infinite/attention";
import {
  api,
  connectionKey,
  type Connection,
  type Me,
  type SessionDetail,
} from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { useKeyboardPadding } from "../../components/keyboard";
import { Composer, type ComposerAccess } from "../../components/Composer";
import { LiveStatus, TopBar } from "../../components/Glass";
import { FloatingNotice } from "../../components/FloatingNotice";
import { theme } from "../../theme";
import { DictationNotice } from "../../dictation/DictationControls";
import { useDictation } from "../../dictation/useDictation";
import { MissionManagedLine } from "../board/MissionManagedLine";
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
  const keyboardPadding = useKeyboardPadding();
  const [composerHeight, setComposerHeight] = useState(0);
  const control = useSessionControl(connection, id);
  const { data, online, stale, seen, refresh } = usePoll(
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
  useControlSync(control, data, stale);
  const session = data?.session ?? null;
  // A mission coordinator runs this session. While its provider prompt is open the person may answer in the
  // terminal, so input and control are offered; otherwise the phone sends no text, keys, stop, resume or control.
  const missionId = session?.managedBy?.missionId;
  const needsYou = session?.attention.state === "needs-you";
  const missionLocked = Boolean(missionId) && !needsYou;
  const role = data?.me.role;
  const environment = data?.me.environment ?? "";
  // Workers that enforce control take input only from the device holding the lease.
  const requiresControl = !missionLocked && session?.capabilities?.inputControl === 1;
  // A lease this phone still holds once a mission-run session no longer needs a person is released.
  const { forget } = control;
  useEffect(() => {
    if (missionLocked) forget(true);
  }, [forget, missionLocked]);
  // The person sees the screen here, so text may go into an open dialog.
  const steering = useSteering(connection, id, refresh, control, {
    force: true,
    draftKey: `${connectionKey(connection)}/${id}/terminal`,
    requiresControl,
    managed: missionLocked,
  });
  const running = session?.status === "running";
  const controlled = !requiresControl || control.lease !== null;
  const canSteer =
    online && running && role !== undefined && role !== "viewer" && controlled && !missionLocked;
  const canSend = canSteer && !steering.busy && Boolean(steering.text.trim());
  // The field (and its mic) docks only while this phone may type; dictation stops with it.
  const composerShown = role !== undefined && role !== "viewer" && !missionLocked && running;
  const fieldShown = composerShown && controlled;
  const dictation = useDictation({
    connection,
    value: steering.text,
    onChange: steering.setText,
    maxLength: 32000,
    disabled: !fieldShown || steering.busy || steering.pending,
  });
  function send() {
    if (!canSend) return;
    void steering.send();
  }
  async function takeControl(takeover: boolean) {
    await control.claim(takeover);
    refresh();
  }
  // The dock names who may type: a claim line until this phone holds the lease, then the field with its release.
  const access: ComposerAccess | undefined = !requiresControl
    ? undefined
    : control.lease
      ? { kind: "held", onRelease: () => { control.forget(true); refresh(); } }
      : { kind: "take", holder: control.holder?.label, busy: control.busy, disabled: !online, onTake: () => void takeControl(Boolean(control.holder)) };
  function back() {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: "/", params: { machine: connectionKey(connection) } });
  }
  return (
    <View style={[s.fill, s.overlayRoot, { paddingBottom: keyboardPadding }]}>
      <TopBar backLabel={backLabel} onBack={back} title="Terminal" right={<LiveStatus online={online} seen={seen} stale={stale} />} />
      <FloatingNotice position="top" offset={58}
        message={stale ? session ? "Last received view. Input is paused until the host reconnects." : "Can't reach this machine." : null}
        actions={stale && !session ? <Button compact title="Refresh" secondary onPress={refresh} /> : null} />
      {!session ? (
        <View style={s.empty}>
          <ActivityIndicator />
          <Text style={s.body}>Waiting for this session…</Text>
        </View>
      ) : (
        <>
          <View style={s.titleBlock}>
            <Text style={s.title} numberOfLines={1}>{session.title}</Text>
            <Text style={s.small} numberOfLines={1}>
              {PROVIDER_NAMES[session.provider]} · {session.status}
            </Text>
            <Text style={s.small} numberOfLines={1}>
              {environment === "local" ? "Local host" : "Cloud host"} ·{" "}
              {session.pid ? `PID ${session.pid}` : "No live process"}
            </Text>
            <Text style={s.small} numberOfLines={1}>
              {connection.label || new URL(connection.url).host} ·{" "}
              {online
                ? `Updated ${seen}`
                : seen
                  ? `Cached view from ${seen}`
                  : "Waiting for a fresh response…"}
            </Text>
          </View>
          <ScrollView style={s.fill} contentContainerStyle={s.scrollBody}>
            <Text style={s.label}>Current screen</Text>
            <Text selectable style={s.screen}>
              {session.screen || "This process has no current screen."}
            </Text>
          </ScrollView>
          {/* One measured block for the mission line and the composer, so the notice clears whichever is taller. */}
          <View onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}>
            {missionId ? <MissionManagedLine missionId={missionId} machine={connectionKey(connection)} style={s.managedLine} /> : null}
            {composerShown ? (
              <Composer
                canSteer={canSteer}
                access={access}
                busy={steering.busy}
                pending={steering.pending}
                text={steering.text}
                onChangeText={steering.setText}
                onSend={send}
                dictation={dictation}
              >
                {KEYS.map((key) => (
                  <Button
                    key={key}
                    compact
                    title={key[0].toUpperCase() + key.slice(1)}
                    onPress={() => steering.sendKey(key)}
                    secondary
                    disabled={!canSteer || steering.busy}
                  />
                ))}
              </Composer>
            ) : null}
          </View>
        </>
      )}
      <DictationNotice dictation={dictation} position="top" offset={110} />
      <FloatingNotice position="bottom" offset={composerHeight + 10}
        message={control.message || steering.error || (steering.pending && !steering.busy ? "Delivery is unconfirmed. Retry sends the same request ID." : steering.receipt)}
        kind={control.message || steering.error ? "error" : steering.receipt ? "success" : "warning"}
        onDismiss={control.message ? control.dismiss : steering.error || steering.receipt ? steering.dismissStatus : undefined}
        actions={steering.pending && !steering.busy ? <View style={s.noticeActions}>
          <Button compact title="Retry" disabled={!canSend} onPress={send} />
          <Button compact title="Clear…" secondary onPress={() => Alert.alert("Clear the unconfirmed delivery?", "The host may have received it. Clearing only forgets the request on this phone.", [
            { text: "Keep pending", style: "cancel" },
            { text: "Clear", style: "destructive", onPress: steering.clearPending },
          ])} />
        </View> : null} />
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  overlayRoot: { position: "relative" },
  noticeActions: { flexDirection: "row", gap: 6 },
  managedLine: { marginHorizontal: 12, marginTop: 6, marginBottom: 10 },
  small: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
  empty: { padding: 30, gap: 15 },
  body: {
    fontSize: 15,
    lineHeight: 24,
    color: theme.colors.mutedInk,
    marginBottom: 20,
  },
  titleBlock: { paddingHorizontal: 16, paddingBottom: 6, gap: 1 },
  title: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: "600",
    color: theme.colors.ink,
    letterSpacing: -0.3,
    marginBottom: 3,
  },
  scrollBody: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 12 },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.ink,
    marginBottom: 6,
    marginTop: 8,
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
