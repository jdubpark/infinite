import { useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { theme } from "../../theme";
import {
  GOAL_LABELS, goalControls, goalStopped, goalTone, newer, openDecisions, OUTCOME_LABELS, shortDate, TEAM_LABELS, teamTone,
  type GoalResult, type ProductGoal, type TeamStatus, type TeamView,
} from "./model";
import { Choices, Clamp, Disclosure, LineupView, LinearLine, RequestStatus, RunPill, Section, SteerBox, t } from "./parts";
import { useRunRequest } from "./useRunRequest";

/** One product goal: its outcome, limits, active cycle, earlier cycles, and the person's assessment. */
export function GoalDetail({ connection, id }: { connection: Connection; id: string }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const poll = usePoll(async () => ({ goal: await api<ProductGoal>(connection, `/goals/${id}`), receivedAt: Date.now() }), 2000, [connection, id]);
  const { data: me } = usePoll(() => api<Me>(connection, "/me"), 10000, [connection]);
  // A mutation's result shows at once; a poll that started before it cannot undo it.
  const [recorded, setRecorded] = useState<ProductGoal | null>(null);
  const goal = poll.data ? newer(recorded, poll.data.goal) : recorded;
  const activeId = goal?.activeTeamId;
  const active = usePoll(() => activeId ? api<TeamView>(connection, `/teams/${activeId}`) : Promise.resolve(null), 4000, [connection, activeId]);
  const activeTeam = active.data?.id === activeId ? active.data : null;
  const [direction, setDirection] = useState("");
  const request = useRunRequest<ProductGoal>(connection, `${machine}/goal/${id}`, {
    accepted: (result, sent) => { setRecorded(result); if (sent.path.endsWith("/steer")) setDirection(""); poll.refresh(); },
    refused: poll.refresh,
  });
  const fresh = poll.online;
  function back() {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: "/", params: { machine, view: "goals" } });
  }
  const openTeam = (teamId: string) => router.push({ pathname: "/team/[id]", params: { id: teamId, machine } });
  const header = <View style={s.header}>
    <Button title="Goals" secondary onPress={back} />
    <Text style={[t.note, !fresh && s.offline]}>{fresh ? "Up to date" : poll.loading ? "Connecting" : "Reconnecting"}</Text>
    <Button title={poll.refreshing ? "Checking…" : "Refresh"} secondary disabled={poll.refreshing} onPress={poll.refresh} />
  </View>;
  if (!goal) return <View style={s.fill}>{header}<View style={s.empty}><ActivityIndicator /><Text style={t.note}>{poll.loading ? "Loading goal…" : "The goal could not be loaded. Check the machine and try again."}</Text></View></View>;

  const controls = goalControls(goal, me?.role, fresh, poll.data?.receivedAt);
  // Judged at the last good poll; the host makes the final decision.
  const expired = Date.parse(goal.deadlineAt) <= (poll.data?.receivedAt ?? 0);
  const locked = request.busy || Boolean(request.pending);
  const decisions = activeTeam ? openDecisions(activeTeam) : [];
  const previous = goal.cycles.filter(cycle => cycle.teamId !== goal.activeTeamId);
  const project = me?.projects?.find(value => value.id === goal.projectId)?.name ?? goal.projectId;
  const send = (action: string, label: string, fields?: Record<string, string>) => request.send(`/goals/${id}/${action}`, label, goal.revision, fields);

  return <KeyboardAvoidingView style={s.fill} behavior="padding">
    {header}
    <View style={s.titleBlock}>
      <Text style={t.note}>{project} · Product goal</Text>
      <Text style={t.title} numberOfLines={3}>{goal.title}</Text>
      <View style={s.metaRow}>
        <RunPill label={GOAL_LABELS[goal.status]} tone={goalTone(goal.status)} />
        <Text style={t.note}>Revision {goal.revision}</Text>
      </View>
      <Text style={t.note}>{fresh ? `Updated ${poll.seen}` : poll.seen ? `Last received ${poll.seen}` : "Waiting for a fresh response…"}</Text>
    </View>
    {!fresh ? <Text style={t.banner}>Last received goal state. Controls are paused until the host reconnects. Its team may still be working.</Text> : null}
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      {goal.reason ? <Text style={t.warning}>{goal.reason}</Text> : null}
      <LinearLine tracking={goal.linear} fresh={fresh} />

      {goal.activeTeamId ? <Section title="Active cycle">
        <View style={[t.card, decisions.length ? t.attention : null]}>
          <Text style={t.strong}>{activeTeam?.title ?? "Team cycle"}</Text>
          {activeTeam ? <RunPill label={TEAM_LABELS[activeTeam.status]} tone={teamTone(activeTeam.status)} /> : null}
          {!active.online ? <Text style={t.note}>Team details may be out of date. Open the team for its current state.</Text> : null}
          {decisions.length ? <>
            <Text style={t.warning}>{decisions.length === 1 ? "1 decision needs" : `${decisions.length} decisions need`} your input.</Text>
            {decisions.map(decision => <Text key={decision.id} style={t.body} numberOfLines={3}>{decision.question}</Text>)}
          </> : null}
          <Button title={decisions.length ? "Answer in the team" : "Open team"} secondary={!decisions.length} onPress={() => openTeam(goal.activeTeamId!)} />
        </View>
      </Section> : null}

      <Section title="Desired outcome">
        <Clamp text={goal.objective} />
        <Text style={t.label}>Success criteria</Text>
        <Clamp text={goal.successCriteria} lines={4} />
        <Text style={t.note}>Reviewed code and passing checks are implementation evidence. Only a recorded human assessment establishes the product outcome.</Text>
      </Section>

      <Section title="Work limits">
        <Text style={t.body}>Cycles started {goal.cycles.length} / {goal.maxRuns}</Text>
        <Text style={t.body}>Agent members {goal.memberCount} / {goal.maxMembers}</Text>
        <Text style={t.body}>Up to {goal.parallelism} parallel {goal.parallelism === 1 ? "worker" : "workers"}</Text>
        <Text style={t.body}>Deadline {shortDate(goal.deadlineAt)}</Text>
        <Text style={t.note}>{goal.maxMinutes} minutes from creation. Pausing does not extend it.</Text>
      </Section>

      <Section title="Previous cycles" count={previous.length}>
        {previous.length ? previous.map(cycle => <View key={cycle.teamId} style={t.card}>
          <Text style={t.strong}>Cycle {cycle.cycle}{cycle.brief ? ` · ${cycle.brief.title}` : ""}</Text>
          <RunPill label={TEAM_LABELS[cycle.status as TeamStatus] ?? cycle.status} tone={cycle.status in TEAM_LABELS ? teamTone(cycle.status as TeamStatus) : "muted"} />
          <Text style={t.note}>Goal revision {cycle.goalRevision} · {cycle.memberCount} members · {shortDate(cycle.startedAt)}</Text>
          {cycle.reason ? <Clamp text={cycle.reason} lines={3} /> : null}
          {cycle.branch ? <Text selectable style={t.mono}>{cycle.branch}</Text> : null}
          <Button title="Review team" secondary onPress={() => openTeam(cycle.teamId)} />
        </View>) : <Text style={t.note}>No earlier cycles recorded.</Text>}
      </Section>

      <Section title="Scope and evidence">
        <Text style={t.label}>Allowed files and folders</Text>
        {goal.allowedPaths.map(path => <Text key={path} style={t.mono}>{path === "." ? ". (entire project)" : path}</Text>)}
        {goal.nonGoals.length ? <><Text style={t.label}>Non-goals</Text>{goal.nonGoals.map((value, index) => <Text key={index} style={t.body}>• {value}</Text>)}</> : null}
        <Text style={t.label}>Provided evidence</Text>
        {goal.evidence.length ? goal.evidence.map((value, index) => <Text key={index} selectable style={t.body}>• {value}</Text>) : <Text style={t.note}>No external evidence was supplied.</Text>}
        <Disclosure title="Recorded agents and data use"><LineupView lineup={goal.lineup} /></Disclosure>
      </Section>

      <Section title="Product outcome">
        {goal.outcomes.length ? goal.outcomes.map((outcome, index) => <View key={`${outcome.at}/${index}`} style={s.record}>
          <Text style={t.strong}>{OUTCOME_LABELS[outcome.result]} (human assessment)</Text>
          <Text style={t.note}>Revision {outcome.revision} · {shortDate(outcome.at)}</Text>
          <Clamp text={outcome.summary} lines={3} />
          <Text style={t.note}>Evidence</Text>
          <Clamp text={outcome.evidence} lines={3} />
        </View>) : <Text style={t.note}>No human outcome assessment has been recorded.</Text>}
        {me && me.role !== "viewer" ? goalStopped(goal)
          ? <OutcomeForm key={goal.outcomes.length} disabled={!controls.outcome || locked} onSubmit={value => send("outcome", "Your outcome assessment", value)} />
          : <Text style={t.note}>Let the goal finish, or cancel it and wait for active work to stop, before recording an outcome.</Text> : null}
      </Section>

      {goal.steering.length ? <Section title="Your directions">
        {goal.steering.map((entry, index) => <View key={`${entry.at}/${index}`} style={s.record}><Text style={t.note}>Revision {entry.revision} · {shortDate(entry.at)}</Text><Clamp text={entry.text} lines={3} /></View>)}
      </Section> : null}

      {goal.events.length ? <Disclosure title={`Goal history (${goal.events.length})`}>
        {[...goal.events].reverse().map((event, index) => <Text key={`${event.at}/${index}`} style={t.note}>{shortDate(event.at)} · {event.text}</Text>)}
      </Disclosure> : null}

      {me?.role === "owner" && !["cancelled", "achieved"].includes(goal.status) ? <View style={s.actions}>
        {goal.status === "paused" && !expired ? <Button title="Resume goal" secondary disabled={!controls.resume || locked} onPress={() => send("resume", "Resume")} />
          : ["running", "needs-input"].includes(goal.status) ? <Button title="Pause goal" secondary disabled={!controls.pause || locked} onPress={() => send("pause", "Pause")} /> : null}
        <Button title="Cancel goal…" secondary disabled={!controls.cancel || locked} onPress={() => Alert.alert("Cancel this goal?", "Active work will stop. Its recorded cycles remain available.", [
          { text: "Keep goal", style: "cancel" },
          { text: "Cancel goal", style: "destructive", onPress: () => send("cancel", "Cancellation") },
        ])} />
      </View> : null}
    </ScrollView>
    <View style={s.dock}>
      <RequestStatus request={request} canRetry={fresh && me?.role !== undefined && me.role !== "viewer" && (me.role === "owner" || /\/(steer|outcome)$/.test(request.pending?.path ?? ""))} subject="goal" />
      <SteerBox value={direction} onChange={setDirection} placeholder="Update the goal’s direction or add evidence…"
        enabled={controls.steer && !locked} busy={request.busy}
        note={me?.role === "viewer" ? "This device can view the goal. An owner or controller can send direction and record outcomes."
          : goal.status === "paused" ? !expired ? "Resume the goal to send direction. The original scope, limits, and deadline still apply." : "This goal’s time limit has expired. Start a new goal to approve more time."
            : !["running", "needs-input"].includes(goal.status) ? goal.status === "achieved" ? "The achieved outcome was recorded by a person." : "This goal will start no further cycles. Start a new goal to approve further changes." : undefined}
        onSend={() => { const text = direction.trim(); if (text) send("steer", "Direction", { text }); }} />
    </View>
  </KeyboardAvoidingView>;
}

/** The person's judgment of the product outcome. It does not publish the changes. */
function OutcomeForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (value: { result: GoalResult; summary: string; evidence: string }) => void }) {
  const [result, setResult] = useState<GoalResult>("inconclusive");
  const [summary, setSummary] = useState("");
  const [evidence, setEvidence] = useState("");
  return <Disclosure title="Record your assessment">
    <Choices values={["achieved", "not-achieved", "inconclusive"] as const} selected={result} label={value => OUTCOME_LABELS[value]} disabled={disabled} onSelect={setResult} />
    <Text style={t.label}>Assessment</Text>
    <TextInput accessibilityLabel="Assessment" value={summary} onChangeText={setSummary} editable={!disabled} multiline maxLength={4000} style={[t.input, t.multiline]} />
    <Text style={t.label}>Evidence for your assessment</Text>
    <TextInput accessibilityLabel="Evidence for your assessment" value={evidence} onChangeText={setEvidence} editable={!disabled} multiline maxLength={8000}
      placeholder="Measured results, review notes, or links supporting your conclusion…" placeholderTextColor={theme.colors.placeholder} style={[t.input, t.multiline]} />
    <Button title="Record assessment" disabled={disabled || !summary.trim() || !evidence.trim()} onPress={() => onSubmit({ result, summary: summary.trim(), evidence: evidence.trim() })} />
  </Disclosure>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.compact, paddingHorizontal: theme.space.inset, paddingVertical: theme.space.label },
  offline: { color: theme.colors.warningInk },
  empty: { padding: 30, gap: 15 },
  titleBlock: { paddingHorizontal: theme.space.section, paddingBottom: theme.space.label, gap: 6 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.compact },
  body: { padding: theme.space.section, paddingTop: 10, gap: 10, paddingBottom: 40 },
  record: { gap: 4, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.rule },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: theme.space.section },
  dock: { gap: 8, paddingHorizontal: theme.space.inset, paddingVertical: theme.space.label, borderTopWidth: 1, borderTopColor: theme.colors.rule, backgroundColor: theme.colors.paper },
});
