import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { PROVIDER_NAMES, deriveMoments } from "@infinite/attention";
import {
  api,
  connectionKey,
  type Connection,
  type Me,
  type SessionDetail,
} from "../../api/client";
import { useLive } from "../../api/useLive";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { Composer } from "../../components/Composer";
import { ControlBar } from "../../components/ControlBar";
import { DecisionCard } from "../../components/DecisionCard";
import { MomentRow } from "../../components/MomentRow";
import { FloatingNotice } from "../../components/FloatingNotice";
import { NowCard } from "../../components/NowCard";
import { Chip, GlassButton, LiveStatus, Segmented, TopBar } from "../../components/Glass";
import { Glyph, StatusIcon } from "../../components/Icon";
import { StatePill } from "../../components/StatePill";
import { theme } from "../../theme";
import { DictationNotice } from "../../dictation/DictationControls";
import { useDictation } from "../../dictation/useDictation";
import { ROLE_NAMES } from "../teams/model";
import { MissionManagedLine } from "../board/MissionManagedLine";
import { Conversation } from "./Conversation";
import { Files } from "./Files";
import { Lifecycle } from "./Lifecycle";
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
  const [tab, setTab] = useState<"chat" | "activity" | "files">("chat");
  const [conversationStale, setConversationStale] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const control = useSessionControl(connection, id);
  const {
    data: poll,
    online,
    stale,
    seen,
    refresh,
  } = useLive(connection, {
    topics: [`session/${id}`],
    intervalMs: 1500,
    deps: [id],
    load: async () => {
      // A poll that started before a local control change must not undo it.
      const revision = control.generation();
      const session = await api<SessionDetail>(connection, `/sessions/${id}`);
      return { session, revision, receivedAt: Date.now() };
    },
    select: (topic, payload) => topic === `session/${id}`
      ? { session: (payload as { state: SessionDetail }).state, revision: control.generation(), receivedAt: Date.now() }
      : undefined,
  });
  const session = poll?.session ?? null;
  useControlSync(control, poll, stale);
  // A mission coordinator runs this session: the phone sends no text, keys, stop, resume or control to it.
  const missionId = session?.managedBy?.missionId;
  // A lease this phone still holds on a managed session is released, so the coordinator keeps control.
  const { forget } = control;
  useEffect(() => {
    if (missionId) forget(true);
  }, [forget, missionId]);
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
  // Workers that enforce control take input only from the device holding the lease; a managed session never grants one.
  const requiresControl = !missionId && session?.capabilities?.inputControl === 1;
  const steering = useSteering(connection, id, refresh, control, {
    draftKey: `${connectionKey(connection)}/${id}/brief`,
    requiresControl,
    managed: Boolean(missionId),
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
    online && running && me !== null && me.role !== "viewer" && controlled && !missionId;
  // Text and Enter would land in the open dialog and pick its highlighted option.
  // A running worker without attention cannot report one, so only the terminal types.
  const blocked = session?.attention.prompt
    ? "Answer the prompt above, or reply instead."
    : running && session?.attention.state === "unavailable"
      ? "This session predates the Brief. Use the terminal to type."
      : undefined;
  const canSend = canSteer && !session?.team && !blocked && !steering.busy && Boolean(steering.text.trim());
  // Drafts work without control, so dictation does too; it stops only where the text itself is locked.
  const dictation = useDictation({
    connection,
    value: steering.text,
    onChange: steering.setText,
    maxLength: 32000,
    disabled: Boolean(blocked) || steering.busy || steering.pending,
  });
  function send() {
    if (!canSend) return;
    void steering.send();
  }
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
    else router.replace({ pathname: "/", params: { machine: connectionKey(connection) } });
  }
  function openTerminal() {
    router.push({ pathname: "/session/[id]/terminal", params: { id, machine: connectionKey(connection) } });
  }

  const toolsOn = (session?.execution?.location ?? session?.executionLocation) === "laptop" ? "your laptop" : me?.machine?.label || connection.label || "this machine";
  const execution = session?.execution;
  const tools = execution ? [
    `${online ? "" : "Last received: "}${execution.location === "cloud" ? "Cloud" : "Laptop"} ${execution.state === "online" ? "connected" : execution.state}`,
    execution.location === "cloud" ? "Cloud handoff complete" : execution.cloudReady ? "Ready for cloud handoff" : "Preparing cloud handoff",
    execution.checkpoint ? `Checkpoint ${Math.max(0, Math.floor(((poll?.receivedAt ?? 0) - Date.parse(execution.checkpoint.capturedAt)) / 1000))}s ago` : "",
    execution.reason ?? "",
    execution.reconciliation ? "Laptop edits preserved; cloud copy available for reconciliation" : "",
  ].filter(Boolean).join(" · ") : "";

  return (
    // Android runs edge-to-edge, so the window no longer resizes for the keyboard.
    <KeyboardAvoidingView style={[s.fill, s.overlayRoot]} behavior="padding">
      <TopBar backLabel="Sessions" onBack={back} right={<>
        <LiveStatus online={online} seen={seen} stale={stale} />
        <GlassButton glyph="terminal" label="Open terminal" onPress={openTerminal} />
      </>} />
      <FloatingNotice position="top" offset={58}
        message={stale ? session ? "Offline · last received view. Input is paused." : "Can't reach this machine." : tab === "chat" && conversationStale ? "Conversation may be stale." : null}
        actions={stale && !session ? <Button compact title="Refresh" secondary onPress={refresh} /> : null} />
      {!session ? (
        <View style={s.empty}>
          <ActivityIndicator />
          <Text style={s.small}>Waiting for this session…</Text>
        </View>
      ) : (
        <>
          <View style={s.head}>
            <Text style={s.title} numberOfLines={2}>
              {session.reading?.title?.text ?? session.title}
            </Text>
            <View style={s.chips}>
              <StatePill state={session.attention.state} />
              <Chip icon={<Avatar label={PROVIDER_NAMES[session.provider]} provider={session.provider} size={16} />}
                label={`${PROVIDER_NAMES[session.provider]}${session.backend === "cmux" ? " · cmux" : ""}`} />
              {session.team ? <Chip icon={<Glyph name="people" size={13} color={theme.colors.mutedInk} />} label={`${ROLE_NAMES[session.team.role]} · rev ${session.team.revision}`}
                accessibilityLabel={`${ROLE_NAMES[session.team.role]} in a team. Open team`}
                onPress={() => router.push({ pathname: "/team/[id]", params: { id: session.team!.runId, machine: connectionKey(connection) } })} /> : null}
              <Chip label={sourceLabel(session.attention.hooks, session.attention.source)} accessibilityLabel={`Status source: ${sourceLabel(session.attention.hooks, session.attention.source)}`} />
              {me?.role === "viewer" ? <Chip label="View only" /> : null}
            </View>
            <Text style={s.small} numberOfLines={1}>
              {toolsOn} · {online ? seen : seen ? `cached ${seen}` : "waiting…"}
            </Text>
            {tools ? <Text style={s.small} numberOfLines={1}>{tools}</Text> : null}
          </View>
          {session.team || missionId ? null : <ControlBar
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
          />}
          <ScrollView
            style={s.fill}
            contentContainerStyle={s.scrollBody}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}
          >
            {prompt && session.team && !missionId ? (
              // A member's open prompt is approved from its team, beside the coordinator's review.
              <View style={s.pointer}>
                <View style={s.pointerHead}>
                  <StatusIcon kind="attention" size={16} />
                  <Text style={[s.pointerTitle, s.fill]}>Waiting on approval</Text>
                </View>
                <Button compact title="Open team" onPress={() => router.push({ pathname: "/team/[id]", params: { id: session.team!.runId, machine: connectionKey(connection) } })} />
              </View>
            ) : prompt ? (
              <DecisionCard
                key={prompt.id}
                prompt={prompt}
                backend={session.backend}
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
                pickedLine={session.reading?.now?.text}
                exitCode={session.exitCode}
                onOpenTerminal={openTerminal}
              />
            )}
            <Segmented style={s.tabs} value={tab} onChange={setTab} options={[
              { value: "chat", label: "Chat" },
              { value: "activity", label: "Activity", count: moments.length },
              { value: "files", label: "Files" },
            ]} />
            {tab === "chat" ? <Conversation connection={connection} id={id} onStaleChange={setConversationStale} /> : tab === "files" ? <Files connection={connection} id={id} online={online} /> : <>
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
                {session.attention.hooks === "none" && session.attention.source !== "protocol" ? (
                  <Text style={s.placeholder}>
                    This provider reports through the screen only.
                  </Text>
                ) : null}
              </View>
            )}
            </>}
            {session.team || missionId ? null : <Lifecycle connection={connection} session={session} role={me?.role} online={online} control={control.lease?.id} refresh={refresh} />}
          </ScrollView>
          {missionId ? (
            <MissionManagedLine missionId={missionId} machine={connectionKey(connection)} style={s.managedLine}
              onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)} />
          ) : session.team ? (
            // A team member is the coordinator's to steer, pause, or stop; direction goes to the team.
            <View style={s.managed}>
              <Glyph name="people" size={16} color={theme.colors.secondaryInk} />
              <Text style={s.managedText}>Run by the coordinator</Text>
              <Button compact title="Team" onPress={() => router.push({ pathname: "/team/[id]", params: { id: session.team!.runId, machine: connectionKey(connection) } })} />
            </View>
          ) : me && me.role !== "viewer" ? (
            <Composer
              canSteer={canSteer}
              onTakeControl={online && running && !controlled ? () => void takeControl(Boolean(control.holder)) : undefined}
              controlBusy={control.busy}
              controlLabel={control.holder ? "Take over" : "Take control"}
              blocked={blocked}
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
              text={steering.text}
              onChangeText={steering.setText}
              onSend={send}
              onInterrupt={() => void steering.sendKey("interrupt")}
              onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
              dictation={dictation}
            />
          ) : null}
        </>
      )}
      <DictationNotice dictation={dictation} position="top" offset={110} />
      <FloatingNotice position="bottom" offset={composerHeight + 10}
        message={answering.notice || (steering.error ? steering.error : steering.pending && !steering.busy ? "Delivery is unconfirmed. Retry sends the same request ID." : steering.receipt)}
        kind={steering.error ? "error" : steering.receipt && !answering.notice ? "success" : "warning"}
        accessibilityRole={answering.notice ? "alert" : undefined}
        onDismiss={answering.notice ? answering.dismissNotice : steering.error || steering.receipt ? steering.dismissStatus : undefined}
        actions={steering.pending && !steering.busy && !answering.notice ? <View style={s.noticeActions}>
          <Button compact title="Retry" disabled={!canSend} onPress={send} />
          <Button compact title="Clear…" secondary onPress={() => Alert.alert("Clear the unconfirmed delivery?", "The host may have received it. Clearing only forgets the request on this phone.", [
            { text: "Keep pending", style: "cancel" },
            { text: "Clear", style: "destructive", onPress: steering.clearPending },
          ])} />
        </View> : null} />
    </KeyboardAvoidingView>
  );
}

/** The source of the current status, independent of the terminal recording. */
function sourceLabel(hooks: SessionDetail["attention"]["hooks"], source: SessionDetail["attention"]["source"]) {
  return source === "protocol" ? "Provider events" : source === "screen" ? "From screen" : hooks === "active" ? "Hooks active" : "Screen only";
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  overlayRoot: { position: "relative" },
  noticeActions: { flexDirection: "row", gap: 6 },
  small: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
  empty: { padding: 30, gap: 15, alignItems: "center" },
  head: { paddingHorizontal: 16, paddingBottom: 10, gap: 7 },
  title: { fontSize: 22, lineHeight: 27, fontWeight: "600", color: theme.colors.ink, letterSpacing: -0.4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  scrollBody: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 10 },
  tabs: { marginTop: 4 },
  notice: { fontSize: 12, lineHeight: 18, color: theme.colors.warningInk },
  emptyTimeline: { gap: 4, paddingVertical: 8 },
  placeholder: { fontSize: 13, lineHeight: 20, color: theme.colors.mutedInk },
  managed: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 10,
    marginTop: 6,
    paddingVertical: 6,
    paddingLeft: 14,
    paddingRight: 6,
    borderRadius: 26,
    backgroundColor: theme.colors.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.glassRim,
    ...theme.lift,
  },
  managedText: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.colors.secondaryInk },
  managedLine: { marginHorizontal: 12, marginBottom: 10, marginTop: 6 },
  pointer: { gap: 8, padding: 14, borderRadius: theme.radius.card, backgroundColor: theme.colors.warningSurface, alignItems: "flex-start" },
  pointerHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  pointerTitle: { fontSize: 15, fontWeight: "600", color: theme.colors.ink },
});
