import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { useKeyboardPadding } from "../../components/keyboard";
import { Card, Chip, LiveStatus, ProgressBar, TopBar } from "../../components/Glass";
import { Glyph, StatusIcon } from "../../components/Icon";
import { FloatingNotice } from "../../components/FloatingNotice";
import { theme } from "../../theme";
import { DictationNotice } from "../../dictation/DictationControls";
import { useDictation } from "../../dictation/useDictation";
import {
  GOAL_LABELS, goalControls, goalKind, goalStopped, newer, openDecisions, OUTCOME_LABELS, shortDate, TEAM_LABELS, teamKind, teamTone, workerStatus,
  type GoalResult, type ProductGoal, type TeamStatus, type TeamView,
} from "./model";
import { Choices, Clamp, Disclosure, LinearChip, LineupView, RequestStatus, RunPill, Section, SteerBox, t } from "./parts";
import { useRunRequest } from "./useRunRequest";
import { CostLine, MoneyText } from "../cost/parts";

/** One product goal: its outcome, limits, active cycle, earlier cycles, and the person's assessment. */
export function GoalDetail({ connection, id }: { connection: Connection; id: string }) {
  const router = useRouter();
  const keyboardPadding = useKeyboardPadding();
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
  const [dockHeight, setDockHeight] = useState(0);
  const request = useRunRequest<ProductGoal>(connection, `${machine}/goal/${id}`, {
    accepted: (result, sent) => { setRecorded(result); if (sent.path.endsWith("/steer")) setDirection(""); poll.refresh(); },
    refused: poll.refresh,
  });
  const fresh = poll.online;
  // Created before the early return below, so it reads the steer rule directly rather than `controls`.
  const dictation = useDictation({
    connection,
    value: direction,
    onChange: setDirection,
    maxLength: 8000,
    disabled: !goal || !goalControls(goal, me?.role, fresh, poll.data?.receivedAt).steer || request.busy || Boolean(request.pending),
  });
  function back() {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: "/", params: { machine, view: "goals" } });
  }
  const openTeam = (teamId: string) => router.push({ pathname: "/team/[id]", params: { id: teamId, machine } });
  const owns = me?.role === "owner" && goal && !["cancelled", "achieved"].includes(goal.status);
  const header = <TopBar backLabel="Goals" onBack={back} right={<LiveStatus online={fresh} loading={poll.loading} seen={poll.seen} stale={poll.stale} />} />;
  if (!goal) return <View style={[s.fill, s.overlayRoot]}>{header}<FloatingNotice position="top" offset={58} message={poll.stale ? "Can't reach this machine." : null} actions={poll.stale ? <Button compact title="Refresh" secondary onPress={poll.refresh} /> : null} /><View style={s.empty}><ActivityIndicator /><Text style={t.note}>{poll.loading ? "Loading goal…" : "The goal could not be loaded. Check the machine and try again."}</Text></View></View>;

  const controls = goalControls(goal, me?.role, fresh, poll.data?.receivedAt);
  // Judged at the last good poll; the host makes the final decision.
  const expired = Date.parse(goal.deadlineAt) <= (poll.data?.receivedAt ?? 0);
  const locked = request.busy || Boolean(request.pending);
  const decisions = activeTeam ? openDecisions(activeTeam) : [];
  const previous = goal.cycles.filter(cycle => cycle.teamId !== goal.activeTeamId);
  const project = me?.projects?.find(value => value.id === goal.projectId)?.name ?? goal.projectId;
  const send = (action: string, label: string, fields?: Record<string, string | number>) => request.send(`/goals/${id}/${action}`, label, goal.revision, fields);

  return <View style={[s.fill, s.overlayRoot, { paddingBottom: keyboardPadding }]}>
    {header}
    <FloatingNotice position="top" offset={58} message={poll.stale ? "Offline · last received state. Controls paused." : active.stale ? activeTeam ? "Active cycle may be out of date." : "Can't load the active cycle." : null} />
    <DictationNotice dictation={dictation} position="top" offset={110} />
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={poll.refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <View style={s.titleBlock}>
        <Text style={t.note}>{project} · Product goal</Text>
        <Text style={t.title} numberOfLines={3}>{goal.title}</Text>
        <View style={s.metaRow}>
          <Chip kind={goalKind(goal).kind} fraction={goalKind(goal).fraction} label={GOAL_LABELS[goal.status]} accessibilityLabel={`State: ${GOAL_LABELS[goal.status]}`}
            tone={goalKind(goal).kind === "attention" || goalKind(goal).kind === "paused" ? "attention" : goalKind(goal).kind === "blocked" ? "error" : undefined} />
          <Chip icon={<ProgressBar done={goal.cycles.length} total={goal.maxRuns} width={30} />} label={`${goal.cycles.length}/${goal.maxRuns} cycles`} />
          <Chip label={`${goal.memberCount}/${goal.maxMembers} agents`} />
          <Chip label={`Due ${shortDate(goal.deadlineAt)}`} />
          <LinearChip tracking={goal.linear} fresh={fresh} />
          <Chip label={`Rev ${goal.revision}`} accessibilityLabel={`Revision ${goal.revision}`} />
        </View>
        {goal.linear?.reason ? <Text style={t.warning}>{goal.linear.reason}</Text> : null}
        {owns ? <View style={s.metaRow}>
          {goal.status === "paused" && !expired ? <Button compact busy={Boolean(request.pending?.label === "Resume" && request.busy)} glyph="play" title="Resume" disabled={!controls.resume || locked} onPress={() => send("resume", "Resume")} />
            : ["running", "needs-input"].includes(goal.status) ? <Button compact busy={Boolean(request.pending?.label === "Pause" && request.busy)} secondary glyph="pause" title="Pause" disabled={!controls.pause || locked} onPress={() => send("pause", "Pause")} /> : null}
          <Button compact busy={Boolean(request.pending?.label === "Cancellation" && request.busy)} secondary glyph="close" title="Cancel…" disabled={!controls.cancel || locked} onPress={() => Alert.alert("Cancel this goal?", "Stops active work. Cycles stay.", [
            { text: "Keep goal", style: "cancel" },
            { text: "Cancel goal", style: "destructive", onPress: () => send("cancel", "Cancellation") },
          ])} />
        </View> : null}
      </View>
      {goal.reason ? <Card attention><Text style={t.warning}>{goal.reason}</Text></Card> : null}

      {goal.activeTeamId ? <Section title="Active cycle">
        <Card attention={decisions.length > 0}>
          <View style={s.metaRow}>
            {activeTeam ? <StatusIcon kind={teamKind(activeTeam).kind} fraction={teamKind(activeTeam).fraction} size={16} /> : null}
            <Text style={[t.strong, s.fill]}>{activeTeam?.title ?? "Team cycle"}</Text>
          </View>
          {activeTeam ? <Text style={t.note}>{TEAM_LABELS[activeTeam.status]} · {workerStatus(activeTeam)}</Text> : null}
          {decisions.length ? <>
            <Text style={t.warning}>{decisions.length === 1 ? "1 decision needs" : `${decisions.length} decisions need`} your input.</Text>
            {decisions.map(decision => <Text key={decision.id} style={t.body} numberOfLines={3}>{decision.question}</Text>)}
          </> : null}
          <Button compact title={decisions.length ? "Answer in the team" : "Open team"} secondary={!decisions.length} onPress={() => openTeam(goal.activeTeamId!)} />
        </Card>
      </Section> : null}

      <Section title="Desired outcome">
        <Clamp text={goal.objective} />
        <Text style={t.label}>Success criteria</Text>
        <Clamp text={goal.successCriteria} lines={4} />
        <Text style={t.note}>Only your assessment sets the outcome.</Text>
      </Section>

      <Section title="Work limits">
        <Text style={t.body}>{goal.cycles.length}/{goal.maxRuns} cycles · {goal.memberCount}/{goal.maxMembers} agents · Workers {goal.activeTeamId ? workerStatus(activeTeam ?? { parallelism: goal.parallelism }) : "Agent-managed"}</Text>
        <Text style={t.note}>The PM and coordinator adjust workers as work changes.</Text>
        <Text style={t.note}>Deadline {shortDate(goal.deadlineAt)}: {goal.maxMinutes} minutes from creation. Pausing does not extend it.</Text>
      </Section>

      <Section title="Previous cycles" count={previous.length}>
        {previous.length ? previous.map(cycle => <View key={cycle.teamId} style={t.card}>
          <Text style={t.strong}>Cycle {cycle.cycle}{cycle.brief ? ` · ${cycle.brief.title}` : ""}</Text>
          <RunPill label={TEAM_LABELS[cycle.status as TeamStatus] ?? cycle.status} tone={cycle.status in TEAM_LABELS ? teamTone(cycle.status as TeamStatus) : "muted"} />
          <Text style={t.note}>Goal revision {cycle.goalRevision} · {cycle.memberCount} members · {shortDate(cycle.startedAt)}</Text>
          {cycle.reason ? <Clamp text={cycle.reason} lines={3} /> : null}
          {cycle.branch ? <Text selectable style={t.mono}>{cycle.branch}</Text> : null}
          <Button compact title="Review team" secondary onPress={() => openTeam(cycle.teamId)} />
        </View>) : <Text style={t.note}>No earlier cycles recorded.</Text>}
      </Section>

      {goal.tasks?.length ? <Section title="Tasks" count={goal.tasks.length}>
        {/* Unmeasured tasks (Claude, Codex) never read as $0: the total is "—" without a measured task, a lower bound beside one. */}
        <Text style={t.strong}>Total <MoneyText value={goal.tasks.reduce((total, task) => ({
          usd: total.usd + (task.usage?.usd ?? 0), unpriced: total.unpriced + (task.usage?.unpriced ?? 0), unmeasured: total.unmeasured + (task.usage ? 0 : 1),
        }), { usd: 0, unpriced: 0, unmeasured: 0 })} />{goal.tasks.some(task => !task.usage) ? <Text style={t.note}>  {goal.tasks.filter(task => !task.usage).length} unmeasured</Text> : null}</Text>
        {goal.tasks.map(task => <Pressable key={`${task.teamId}/${task.taskId}`} accessibilityRole="button" accessibilityLabel={`Open ${task.title}`} onPress={() => openTeam(task.teamId)} hitSlop={5}
          style={({ pressed }) => [s.taskRow, pressed && s.taskPressed]}>
          <View style={s.taskMain}><Text style={s.taskTitle} numberOfLines={2}>{task.title}</Text><CostLine usage={task.usage} /></View>
          <Glyph name="forward" size={12} color={theme.colors.mutedInk} />
        </Pressable>)}
      </Section> : null}

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
        </View>) : <Text style={t.note}>Not assessed yet.</Text>}
        {me && me.role !== "viewer" ? goalStopped(goal)
          ? <OutcomeForm key={goal.outcomes.length} disabled={!controls.outcome || locked} busy={request.busy} onSubmit={value => send("outcome", "Your outcome assessment", value)} />
          : <Text style={t.note}>Assess once the goal stops.</Text> : null}
      </Section>

      {goal.steering.length ? <Section title="Your directions">
        {goal.steering.map((entry, index) => <View key={`${entry.at}/${index}`} style={s.record}><Text style={t.note}>Revision {entry.revision} · {shortDate(entry.at)}</Text><Clamp text={entry.text} lines={3} /></View>)}
      </Section> : null}

      {goal.events.length ? <Disclosure title={`Goal history (${goal.events.length})`}>
        {[...goal.events].reverse().map((event, index) => <Text key={`${event.at}/${index}`} style={t.note}>{shortDate(event.at)} · {event.text}</Text>)}
      </Disclosure> : null}

    </ScrollView>
    <View style={s.dock} onLayout={(event) => setDockHeight(event.nativeEvent.layout.height)}>
      <SteerBox value={direction} onChange={setDirection} dictation={dictation} placeholder="Update the goal’s direction or add evidence…"
        enabled={controls.steer && !locked} busy={request.busy}
        note={me?.role === "viewer" ? "View only."
          : goal.status === "paused" ? !expired ? "Resume to steer." : "This goal’s time limit has expired. Start a new goal to approve more time."
            : !["running", "needs-input"].includes(goal.status) ? goal.status === "achieved" ? "The achieved outcome was recorded by a person." : "This goal will start no further cycles. Start a new goal to approve further changes." : undefined}
        onSend={() => { const text = direction.trim(); if (text) send("steer", "Direction", { text }); }} />
    </View>
    <RequestStatus request={request} bottom={dockHeight + 10} canRetry={fresh && me?.role !== undefined && me.role !== "viewer" && (me.role === "owner" || /\/(steer|outcome)$/.test(request.pending?.path ?? ""))} />
  </View>;
}

/** The person's judgment of the product outcome. It does not publish the changes. */
function OutcomeForm({ disabled, busy, onSubmit }: { disabled: boolean; busy: boolean; onSubmit: (value: { result: GoalResult; summary: string; evidence: string }) => void }) {
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
    <Button compact busy={busy} title="Record assessment" disabled={disabled || !summary.trim() || !evidence.trim()} onPress={() => onSubmit({ result, summary: summary.trim(), evidence: evidence.trim() })} />
  </Disclosure>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  overlayRoot: { position: "relative" },
  empty: { padding: 30, gap: 15, alignItems: "center" },
  titleBlock: { paddingBottom: 4, gap: 8 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  body: { paddingHorizontal: 16, paddingTop: 2, gap: 10, paddingBottom: 24 },
  record: { gap: 4, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  dock: { gap: 6, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 10 },
  taskRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  taskMain: { flex: 1, gap: 2 },
  taskTitle: { fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.ink },
  taskPressed: { opacity: 0.55 },
});
