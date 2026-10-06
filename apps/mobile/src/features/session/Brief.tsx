import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { PROVIDER_NAMES, deriveMoments } from "@infinite/attention";
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
import { DecisionCard } from "../../components/DecisionCard";
import { MomentRow } from "../../components/MomentRow";
import { NowCard } from "../../components/NowCard";
import { OfflineBanner } from "../../components/OfflineBanner";
import { SourceTag } from "../../components/SourceTag";
import { StatePill } from "../../components/StatePill";
import { theme } from "../../theme";
import { useAnswer } from "./useAnswer";
import { useControlSync, useSessionControl } from "./useSessionControl";
import { useSignals } from "./useSignals";
import { useSteering } from "./useSteering";

/** The session at a glance: what it needs or is doing, then the composer. */
export function Brief({
  connection,
  id,
}: {
  connection: Connection;
  id: string;
}) {
  const router = useRouter();
  const control = useSessionControl(connection, id);
  const {
    data: poll,
    online,
    seen,
    refresh,
  } = usePoll(
    async () => {
      // A poll that started before a local control change must not undo it.
      const revision = control.generation();
      const session = await api<SessionDetail>(connection, `/sessions/${id}`);
      return { session, revision };
    },
    1500,
    [connection, id],
  );
  const session = poll?.session ?? null;
  useControlSync(control, poll, online);
  // `/me` is read once; a failed read is retried after the next good poll.
  const [me, setMe] = useState<Me | null>(null);
  const needMe = me === null && online;
  useEffect(() => {
    if (!needMe) return;
    let active = true;
    api<Me>(connection, "/me").then(
      (value) => {
        if (active) setMe(value);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [connection, needMe, seen]);

  const { events: signals } = useSignals(connection, id);
  const moments = useMemo(() => deriveMoments(signals), [signals]);
  // Workers that enforce control take input only from the device holding the lease.
  const requiresControl = session?.capabilities?.inputControl === 1;
  const steering = useSteering(connection, id, refresh, control, {
    draftKey: `${connection.url}/${id}/brief`,
    requiresControl,
  });
  const prompt =
    session?.attention.state === "needs-you"
      ? session.attention.prompt
      : undefined;
  const answering = useAnswer(
    connection,
    id,
    prompt,
    refresh,
    control,
    requiresControl,
  );

  const running = session?.status === "running";
  const controlled = !requiresControl || control.lease !== null;
  const permitted =
    me !== null &&
    me.role !== "viewer" &&
    me.capabilities?.answer !== false &&
    !answering.forbidden;
  const readOnly = answering.forbidden || (me !== null && !permitted);
  const canAnswer = permitted && online && running && controlled;
  const canSteer =
    online && running && me !== null && me.role !== "viewer" && controlled;
  const controlGate =
    online && running && !controlled
      ? control.holder
        ? `${control.holder.label} has control. Take over above to answer here.`
        : "Take control above to answer from this phone."
      : undefined;

  async function takeControl(takeover: boolean) {
    await control.claim(takeover);
    refresh();
  }
  function back() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }
  function openTerminal() {
    router.push({ pathname: "/session/[id]/terminal", params: { id } });
  }

  return (
    // Android runs edge-to-edge, so the window no longer resizes for the keyboard.
    <KeyboardAvoidingView style={s.fill} behavior="padding">
      <View style={s.header}>
        <Button title="Sessions" secondary onPress={back} />
        <Text style={[s.small, !online && s.offlineText]}>
          {online ? "Up to date" : "Reconnecting"}
        </Text>
        <Button title="Terminal" secondary onPress={openTerminal} />
      </View>
      {!session ? (
        <View style={s.empty}>
          <ActivityIndicator />
          <Text style={s.body}>Waiting for this session…</Text>
        </View>
      ) : (
        <>
          <View style={s.titleBlock}>
            <Text style={s.title} numberOfLines={2}>
              {session.title}
            </Text>
            <View style={s.metaRow}>
              <Text style={s.small}>{PROVIDER_NAMES[session.provider]}</Text>
              <StatePill state={session.attention.state} />
              <SourceTag hooks={session.attention.hooks} />
            </View>
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
            message="Last received view. Answers and input are paused until the host reconnects."
          />
          <ControlBar
            role={me?.role}
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
          <ScrollView
            style={s.fill}
            contentContainerStyle={s.scrollBody}
            keyboardShouldPersistTaps="handled"
          >
            {answering.notice ? (
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={s.notice}
              >
                {answering.notice}
              </Text>
            ) : null}
            {prompt ? (
              <DecisionCard
                key={prompt.id}
                prompt={prompt}
                status={answering.status}
                canAnswer={canAnswer}
                readOnly={readOnly}
                gate={controlGate}
                onAnswer={answering.answer}
                onRetry={answering.retry}
                onOpenTerminal={openTerminal}
              />
            ) : (
              <NowCard
                key={session.attention.since}
                attention={session.attention}
                provider={session.provider}
                exitCode={session.exitCode}
                onOpenTerminal={openTerminal}
              />
            )}
            <Text style={s.label}>
              So far
              {moments.length ? (
                <Text style={s.count}>{`  ${moments.length}`}</Text>
              ) : null}
            </Text>
            {moments.length ? (
              <View>
                {moments.map((m) => (
                  <MomentRow key={m.id} moment={m} />
                ))}
              </View>
            ) : (
              <View style={s.emptyTimeline}>
                <Text style={s.placeholder}>
                  Nothing recorded yet. Signals appear here as the agent works.
                </Text>
                {session.attention.hooks === "none" ? (
                  <Text style={s.placeholder}>
                    This provider reports through the screen only.
                  </Text>
                ) : null}
              </View>
            )}
          </ScrollView>
          {me && me.role !== "viewer" ? (
            <Composer
              canSteer={canSteer}
              onTakeControl={online && running && !controlled ? () => void takeControl(Boolean(control.holder)) : undefined}
              controlBusy={control.busy}
              controlLabel={control.holder ? "Take over" : "Take control"}
              // Text and Enter would land in the open dialog and pick its highlighted option.
              // A running worker without attention cannot report one, so only the terminal types.
              blocked={
                session.attention.prompt
                  ? "Answer the prompt above, or reply instead."
                  : running && session.attention.state === "unavailable"
                    ? "This session predates the Brief. Use the terminal to type."
                    : undefined
              }
              blockedPlaceholder={
                session.attention.prompt ? undefined : "Type in the terminal"
              }
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
              onInterrupt={() => void steering.sendKey("interrupt")}
            />
          ) : null}
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
    gap: theme.space.compact,
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
  titleBlock: {
    paddingHorizontal: theme.space.section,
    paddingBottom: theme.space.label,
    gap: 6,
  },
  title: {
    fontSize: 26,
    fontWeight: "500",
    color: theme.colors.ink,
    letterSpacing: -0.7,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.space.compact,
  },
  scrollBody: { padding: theme.space.section, paddingTop: 10, gap: 10 },
  notice: { fontSize: 12, lineHeight: 18, color: theme.colors.warningInk },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.ink,
    marginTop: 17,
  },
  count: { fontWeight: "400", color: theme.colors.mutedInk },
  emptyTimeline: { gap: 4 },
  placeholder: { fontSize: 13, lineHeight: 20, color: theme.colors.mutedInk },
});
