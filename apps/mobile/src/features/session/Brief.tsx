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
import { DecisionCard } from "../../components/DecisionCard";
import { MomentRow } from "../../components/MomentRow";
import { NowCard } from "../../components/NowCard";
import { OfflineBanner } from "../../components/OfflineBanner";
import { SourceTag } from "../../components/SourceTag";
import { StatePill } from "../../components/StatePill";
import { theme } from "../../theme";
import { useAnswer } from "./useAnswer";
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
  const {
    data: session,
    online,
    seen,
    refresh,
  } = usePoll(() => api<SessionDetail>(connection, `/sessions/${id}`), 1500, [
    connection,
    id,
  ]);
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
  const steering = useSteering(connection, id, refresh);
  const prompt =
    session?.attention.state === "needs-you"
      ? session.attention.prompt
      : undefined;
  const answering = useAnswer(connection, id, prompt, refresh);

  const running = session?.status === "running";
  const permitted =
    me !== null &&
    me.role !== "viewer" &&
    me.capabilities?.answer !== false &&
    !answering.forbidden;
  const readOnly = answering.forbidden || (me !== null && !permitted);
  const canAnswer = permitted && online && running;
  const canSteer = online && running && me !== null && me.role !== "viewer";

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
          {online ? "Connected" : "Reconnecting"}
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
              {new URL(connection.url).host} · Checked {seen || "—"}
            </Text>
          </View>
          <OfflineBanner
            online={online}
            message="Last received view. Answers and input are paused until the host reconnects."
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
              // Text and Enter would land in the open dialog and pick its highlighted option.
              blocked={
                session.attention.prompt
                  ? "Answer the prompt above, or reply instead."
                  : undefined
              }
              busy={steering.busy}
              pending={steering.pending}
              receipt={steering.receipt}
              error={steering.error}
              onSend={steering.send}
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
