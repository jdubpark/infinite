import { useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me, type Mission, type ProjectGroupList } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { FloatingNotice } from "../../components/FloatingNotice";
import { Button } from "../../components/Button";
import { Card, Chip, TopBar } from "../../components/Glass";
import { Glyph, StatusIcon } from "../../components/Icon";
import { age } from "../../status";
import { theme } from "../../theme";
import { newer } from "../teams/model";
import { RequestStatus, Section, SteerBox, t } from "../teams/parts";
import { useRunRequest } from "../teams/useRunRequest";
import { missionControls, missionStatusLabel, missionSubtaskLabel, openMissionDecisions } from "./model";

export function MissionDetail({ connection, id }: { connection: Connection; id: string }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const poll = usePoll(async () => {
    const [mission, me, projects] = await Promise.all([
      api<Mission>(connection, `/missions/${id}`), api<Me>(connection, "/me"), api<ProjectGroupList>(connection, "/project-groups"),
    ]);
    return { mission, me, projects, at: Date.now() };
  }, 2500, [connection, id]);
  const [recorded, setRecorded] = useState<Mission | null>(null);
  const [direction, setDirection] = useState("");
  const [dockHeight, setDockHeight] = useState(0);
  const mission = poll.data ? newer(recorded, poll.data.mission) : recorded;
  const request = useRunRequest<Mission>(connection, `${machine}/mission/${id}`, {
    accepted: result => { setRecorded(previous => newer(previous, result)); poll.refresh(); },
    refused: poll.refresh,
  });
  const fresh = poll.online;
  const back = () => router.canGoBack() ? router.back() : router.replace({ pathname: "/", params: { machine } });
  const top = <TopBar backLabel="Board" onBack={back} />;
  if (!mission) return <View style={s.fill}>{top}<View style={s.empty}><ActivityIndicator /><Text style={t.note}>{poll.loading ? "Loading…" : "Could not load the mission."}</Text></View></View>;

  const me = poll.data?.me;
  const now = poll.data?.at ?? 0;
  const controls = missionControls(mission, me?.role, fresh, now);
  const locked = request.busy || Boolean(request.pending);
  const decisions = openMissionDecisions(mission);
  const group = poll.data?.projects.groups.find(value => value.id === mission.groupId);
  const projectName = group?.name ?? mission.groupName;
  const repoName = (projectId: string) => me?.projects?.find(project => project.id === projectId)?.name
    ?? group?.repos.find(repo => repo.projectId === projectId)?.name ?? projectId;
  const send = (action: string, label: string, fields?: Record<string, string>) => request.send(`/missions/${id}/${action}`, label, mission.revision, fields);
  const answer = (decisionId: string, text: string) => {
    const value = text.trim();
    if (value) send(`answer/${decisionId}`, "Answer", { text: value });
  };
  const statusIcon = mission.status === "needs-input" ? "attention" : mission.status === "blocked" ? "blocked"
    : mission.status === "paused" ? "paused" : mission.status === "ready-for-review" ? "review"
      : mission.status === "cancelled" ? "cancelled" : "progress";

  return <KeyboardAvoidingView style={s.fill} behavior="padding">
    {top}
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={poll.refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <View style={s.heading}>
        <Text style={t.note}>{projectName} · {age(mission.createdAt, now)}</Text>
        <Text style={t.title}>{mission.title}</Text>
        <View style={s.chips}><Chip kind={statusIcon} label={missionStatusLabel(mission.status)} tone={mission.status === "needs-input" || mission.status === "paused" ? "attention" : mission.status === "blocked" ? "error" : undefined} />
          <Chip label={`Updated ${age(mission.updatedAt, now)}`} /><Chip label={`Rev ${mission.revision}`} /></View>
        {mission.reason ? <Text style={mission.status === "blocked" ? t.error : t.warning}>{mission.reason}</Text> : null}
      </View>

      {decisions.length ? <Section title="Needs your input" count={decisions.length}>
        {decisions.map(decision => <Decision key={decision.id} question={decision.question} options={decision.options}
          enabled={controls.answer && !locked} onAnswer={value => answer(decision.id, value)} />)}
      </Section> : null}

      <Section title="Subtasks" count={mission.subtasks.length}>
        {mission.subtasks.length ? mission.subtasks.map(subtask => {
          const label = missionSubtaskLabel(subtask.status);
          return <Pressable key={subtask.id} accessibilityRole="button" accessibilityState={{ disabled: !subtask.teamId }}
            accessibilityLabel={`${subtask.title}, ${repoName(subtask.repoProjectId)}, ${label}${subtask.teamId ? ", open team" : ""}`}
            disabled={!subtask.teamId} onPress={() => router.push({ pathname: "/team/[id]", params: { id: subtask.teamId!, machine } })}
            style={({ pressed }) => [s.subtask, pressed && s.pressed, !subtask.teamId && s.inactive]}>
            <View style={s.subtaskIcon}><StatusIcon kind={subtask.status === "done" ? "done" : subtask.status === "running" ? "progress" : subtask.status === "blocked" ? "blocked" : subtask.status === "cancelled" ? "cancelled" : "todo"} size={15} /></View>
            <View style={s.subtaskMain}>
              <Text style={s.subtaskTitle} numberOfLines={1}>{subtask.title}</Text>
              <Text style={t.note} numberOfLines={1}>{repoName(subtask.repoProjectId)} · {subtask.size} · {label}{subtask.size === "team" ? ` · ${subtask.parallelism} parallel` : ""}</Text>
            </View>
            {subtask.teamId ? <Glyph name="forward" size={12} color={theme.colors.mutedInk} /> : null}
          </Pressable>;
        }) : <Text style={t.note}>No subtasks have been dispatched.</Text>}
      </Section>

      {mission.dispatchSummary ? <Section title="Coordinator update"><Text style={t.body}>{mission.dispatchSummary}</Text></Section> : null}
      {mission.result ? <Section title="Reported result"><Card><Text style={t.body}>{mission.result.summary}</Text><Text style={t.note}>Coordinator report · not an independent review</Text></Card></Section> : null}

      {me?.role === "owner" && (controls.pause || controls.resume || controls.cancel) ? <Section title="Mission controls">
        <View style={s.controls}>
          {controls.resume ? <Button compact title="Resume" glyph="play" disabled={locked} onPress={() => send("resume", "Resume")} />
            : controls.pause ? <Button compact secondary title="Pause" glyph="pause" disabled={locked} onPress={() => send("pause", "Pause")} /> : null}
          {controls.cancel ? <Button compact secondary title="Cancel…" glyph="close" disabled={locked} onPress={() => Alert.alert("Cancel this mission?", "Stops the coordinator and active subtasks. Recorded work stays.", [
            { text: "Keep running", style: "cancel" }, { text: "Cancel mission", style: "destructive", onPress: () => send("cancel", "Cancellation") },
          ])} /> : null}
        </View>
      </Section> : null}

      {mission.steering.length ? <Section title="Your directions" count={mission.steering.length}>
          {[...mission.steering].reverse().map((entry, index) => <Card key={`${entry.at}/${index}`}><Text style={t.note}>Revision {entry.revision} · {age(entry.at, now)}</Text><Text style={t.body}>{entry.text}</Text></Card>)}
      </Section> : null}

      <Section title="Events" count={mission.events.length}>
        {mission.events.length ? [...mission.events].reverse().map((event, index) => <View key={`${event.at}/${index}`} style={s.event}>
          <Text style={s.eventTime}>{age(event.at, now)}</Text><Text style={s.eventText}>{event.text}</Text>
        </View>) : <Text style={t.note}>No events recorded.</Text>}
      </Section>
      <View style={s.endNote}><Text style={t.note}>Ready for review records the coordinator’s report. It does not confirm acceptance or delivery.</Text></View>
    </ScrollView>
    {me?.role === "owner" ? <View style={s.dock} onLayout={event => setDockHeight(event.nativeEvent.layout.height)}>
      <SteerBox value={direction} onChange={setDirection} placeholder="Steer the coordinator…"
        enabled={controls.steer && !locked} busy={request.busy}
        note={me.role !== "owner" ? "View only." : mission.status === "paused" ? "Resume to steer." : !controls.steer ? "This mission cannot be steered in its current state." : undefined}
        onSend={() => { const text = direction.trim(); if (text) { send("steer", "Direction", { text }); setDirection(""); } }} />
    </View> : null}
    {me?.role === "owner" ? <RequestStatus request={request} bottom={dockHeight + 10} canRetry={fresh} /> : null}
    <FloatingNotice position="top" offset={58} message={poll.stale ? "Offline · last received state. Controls paused." : null} />
  </KeyboardAvoidingView>;
}

function Decision({ question, options, enabled, onAnswer }: { question: string; options: string[]; enabled: boolean; onAnswer: (text: string) => void }) {
  const [text, setText] = useState("");
  return <Card attention style={s.decision}>
    <Text style={s.decisionQuestion}>{question}</Text>
    {options.map((option, index) => <Button key={`${option}/${index}`} compact secondary title={option} disabled={!enabled} onPress={() => onAnswer(option)} />)}
    <TextInput accessibilityLabel="Write an answer" value={text} onChangeText={setText} multiline maxLength={8000}
      placeholder="Or write your answer…" placeholderTextColor={theme.colors.placeholder} editable={enabled} style={s.answerInput} />
    <Button compact title="Send answer" disabled={!enabled || !text.trim()} onPress={() => onAnswer(text.trim())} />
  </Card>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  empty: { alignItems: "center", gap: 12, padding: 28 },
  body: { paddingHorizontal: 18, paddingBottom: 28, gap: 18 },
  heading: { gap: 8, paddingTop: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 7 },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  decision: { marginTop: 8, gap: 9 },
  decisionQuestion: { fontSize: 15, fontWeight: "600", lineHeight: 22, color: theme.colors.ink },
  answerInput: { minHeight: 54, maxHeight: 150, borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.message, padding: 10, color: theme.colors.ink, backgroundColor: theme.colors.paper, fontSize: 14, lineHeight: 20 },
  subtask: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  inactive: { opacity: 0.72 },
  subtaskIcon: { width: 22, alignItems: "center" },
  subtaskMain: { flex: 1, minWidth: 0, gap: 2 },
  subtaskTitle: { fontSize: 14, fontWeight: "600", color: theme.colors.ink },
  event: { flexDirection: "row", gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  eventTime: { width: 42, fontSize: 11, color: theme.colors.mutedInk },
  eventText: { flex: 1, fontSize: 13, lineHeight: 19, color: theme.colors.ink },
  endNote: { paddingTop: 4 },
  dock: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule, backgroundColor: theme.colors.paper },
});
