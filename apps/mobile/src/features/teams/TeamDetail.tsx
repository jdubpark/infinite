import { useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me, type SessionRow } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { StatePill } from "../../components/StatePill";
import { theme } from "../../theme";
import {
  activeMembers, leadLabel, newer, openDecisions, ROLE_NAMES, shortDate, TEAM_LABELS, teamControls, teamTone,
  type TeamDecision, type TeamMember, type TeamView,
} from "./model";
import { Clamp, Disclosure, LineupView, LinearLine, ProfileLine, providerName, RequestStatus, RunPill, Section, SteerBox, t } from "./parts";
import { useRunRequest } from "./useRunRequest";

/** One team run: what it needs from you, who is working, the evidence, and its controls. */
export function TeamDetail({ connection, id }: { connection: Connection; id: string }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const poll = usePoll(() => api<TeamView>(connection, `/teams/${id}`), 2000, [connection, id]);
  const { data: me } = usePoll(() => api<Me>(connection, "/me"), 10000, [connection]);
  const { data: sessions } = usePoll(() => api<{ sessions: SessionRow[] }>(connection, "/sessions").then(value => value.sessions), 4000, [connection]);
  // A mutation's result shows at once; a poll that started before it cannot undo it.
  const [recorded, setRecorded] = useState<TeamView | null>(null);
  const team = poll.data ? newer(recorded, poll.data) : recorded;
  const [direction, setDirection] = useState("");
  const request = useRunRequest<TeamView>(connection, `${machine}/team/${id}`, {
    accepted: (result, sent) => { setRecorded(result); if (sent.path.endsWith("/steer")) setDirection(""); poll.refresh(); },
    refused: poll.refresh,
  });
  const fresh = poll.online;
  function back() {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: "/", params: { machine, view: "teams" } });
  }
  const openSession = (sessionId: string) => router.push({ pathname: "/session/[id]", params: { id: sessionId, machine } });
  const header = <View style={s.header}>
    <Button title="Teams" secondary onPress={back} />
    <Text style={[t.note, !fresh && s.offline]}>{fresh ? "Up to date" : poll.loading ? "Connecting" : "Reconnecting"}</Text>
    <Button title={poll.refreshing ? "Checking…" : "Refresh"} secondary disabled={poll.refreshing} onPress={poll.refresh} />
  </View>;
  if (!team) return <View style={s.fill}>{header}<View style={s.empty}><ActivityIndicator /><Text style={t.note}>{poll.loading ? "Loading team…" : "The team could not be loaded. Check the machine and try again."}</Text></View></View>;

  const controls = teamControls(team, me?.role, fresh);
  const locked = request.busy || Boolean(request.pending);
  const decisions = openDecisions(team);
  const current = activeMembers(team);
  const listed = new Map((sessions ?? []).map(session => [session.id, session]));
  const needsYou = current.map(member => listed.get(member.sessionId)).filter(session => session?.attention.state === "needs-you") as SessionRow[];
  const project = me?.projects?.find(value => value.id === team.projectId)?.name ?? team.projectId;
  const send = (path: string, label: string, fields?: Record<string, string>) => request.send(`/teams/${id}${path}`, label, team.revision, fields);
  // Newest revision first; within it, members still working come before stopped ones.
  const live = (member: TeamMember) => ["running", "waiting"].includes(member.status) ? 0 : 1;
  const members = [...team.members].sort((a, b) => b.revision - a.revision || live(a) - live(b));
  const currentMembers = members.filter(member => member.revision === team.revision);
  const earlierMembers = members.filter(member => member.revision !== team.revision);
  const answered = team.decisions.filter(decision => decision.answer != null);

  return <KeyboardAvoidingView style={s.fill} behavior="padding">
    {header}
    <View style={s.titleBlock}>
      <Text style={t.note}>{project} · {leadLabel(team, providerName)}</Text>
      <Text style={t.title} numberOfLines={3}>{team.title}</Text>
      <View style={s.metaRow}>
        <RunPill label={TEAM_LABELS[team.status]} tone={teamTone(team.status)} />
        <Text style={t.note}>Revision {team.revision} · up to {team.parallelism} {team.parallelism === 1 ? "implementer" : "implementers"}</Text>
      </View>
      <Text style={t.note}>{fresh ? `Updated ${poll.seen}` : poll.seen ? `Last received ${poll.seen}` : "Waiting for a fresh response…"}</Text>
    </View>
    {!fresh ? <Text style={t.banner}>Last received team state. Controls are paused until the host reconnects. The team may still be working.</Text> : null}
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      {team.reason ? <Text style={t.warning}>{team.reason}</Text> : null}
      <LinearLine tracking={team.linear} fresh={fresh} />
      {team.status === "ready-for-review" ? <Text style={t.body}>The team reports this run is ready for your review. Inspect the changes and evidence below before merging or publishing.</Text> : null}
      {team.deliveryReceipt ? <Section title="Delivery receipt">
        <Text style={t.body}>The delivery agent reports that the pull request merged. The host records this report; it does not independently verify GitHub or product impact.</Text>
        {/^https:\/\//.test(team.deliveryReceipt.pullRequestUrl) ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(team.deliveryReceipt!.pullRequestUrl)}><Text style={s.link}>Open pull request</Text></Pressable> : null}
        <Clamp text={team.deliveryReceipt.summary} lines={4} />
        <Text style={t.note}>Reported for revision {team.deliveryReceipt.revision} · {shortDate(team.deliveryReceipt.reportedAt)}</Text>
        <Text style={t.note}>Reviewed head commit</Text><Text selectable style={t.mono}>{team.deliveryReceipt.headCommit}</Text>
        <Text style={t.note}>Reported merge commit</Text><Text selectable style={t.mono}>{team.deliveryReceipt.mergeCommit}</Text>
      </Section> : null}
      {team.goal ? <View style={s.metaRow}>
        <Text style={t.note}>Part of a goal · cycle {team.goal.cycle} · goal revision {team.goal.revision}</Text>
        <Button title="Open goal" secondary onPress={() => router.push({ pathname: "/goal/[id]", params: { id: team.goal!.id, machine } })} />
      </View> : null}

      {decisions.length ? <Section title="Decisions for you" count={decisions.length}>
        {decisions.map(decision => <DecisionCard key={decision.id} decision={decision} member={team.members.find(member => member.memberId === decision.memberId)}
          disabled={!controls.answer || locked} onAnswer={text => send(`/decisions/${decision.id}/answer`, "Answer", { text })} />)}
        {team.status === "paused" ? <Text style={t.note}>Resume the team before answering.</Text> : null}
      </Section> : null}

      {needsYou.length ? <Section title="Agent sessions need you" count={needsYou.length}>
        <Text style={t.note}>Respond to provider permission prompts in the session. The team never approves them.</Text>
        {needsYou.map(session => <View key={session.id} style={[t.card, t.attention]}>
          <Text style={t.strong}>{session.title}</Text>
          <Text style={t.note} numberOfLines={2}>{session.attention.now || "Open the session to respond."}</Text>
          <Button title="Open session" onPress={() => openSession(session.id)} />
        </View>)}
      </Section> : null}

      {team.noChange ? <Section title="No change proposed">
        <Clamp text={team.noChange.summary} />
        {team.noChange.evidence.map((item, index) => <Text key={index} style={t.note}>{item.source}: {item.observation}</Text>)}
      </Section> : null}

      <Section title="Your request"><Clamp text={team.objective} /></Section>

      {team.brief ? <Section title="Opportunity brief">
        <Text style={t.note}>An agent proposal, not a confirmed outcome.</Text>
        <Text style={t.strong}>{team.brief.title}</Text>
        <Clamp text={team.brief.problem} lines={4} />
        <Disclosure title="Acceptance criteria and evidence">
          {team.brief.acceptance.map((item, index) => <Text key={index} style={t.body}>• {item}</Text>)}
          <Text style={t.label}>Expected outcome</Text>
          <Text style={t.body}>{team.brief.expectedOutcome}</Text>
          {team.brief.evidence.map((item, index) => <Text key={index} style={t.note}>{item.source}: {item.observation}</Text>)}
        </Disclosure>
      </Section> : null}

      <Section title="Work plan" count={team.tasks.length}>
        {team.tasks.length ? team.tasks.map(task => {
          const member = team.members.find(value => value.memberId === task.memberId);
          const profile = member?.modelProfile ?? [...(team.lineup?.implementers ?? []), ...(team.lineup?.escalations ?? [])].find(value => value.id === task.agentProfileId);
          return <View key={task.id} style={t.card}>
            <View style={s.spread}><Text style={[t.strong, s.fill]}>{task.title}</Text><Text style={t.note}>{task.status}</Text></View>
            <Text style={t.note}>{task.dependsOn.length ? `After ${task.dependsOn.map(dependency => team.tasks.find(value => value.id === dependency)?.title ?? dependency).join(", ")}` : "No task dependencies"}</Text>
            {profile ? <ProfileLine profile={profile} /> : null}
            {task.escalation ? <Text style={t.warning}>Escalated to {task.escalation.toProfileId}: {task.escalation.reason}</Text> : null}
            {task.summary ? <Clamp text={task.summary} lines={3} /> : null}
            <Disclosure title="Instructions and owned paths">
              <Text style={t.body}>{task.instructions}</Text>
              {task.paths.map(path => <Text key={path} style={t.mono}>{path}</Text>)}
            </Disclosure>
          </View>;
        }) : <Text style={t.note}>The coordinator has not reported a plan for this revision yet.</Text>}
      </Section>

      <Section title="Members" count={currentMembers.length}>
        {currentMembers.length ? currentMembers.map(member => <MemberRow key={member.memberId} member={member} session={listed.get(member.sessionId)} listed={sessions !== null} provider={team.provider} onOpen={openSession} />)
          : <Text style={t.note}>No members have started for this revision.</Text>}
        {earlierMembers.length ? <Disclosure title={`Earlier revisions (${earlierMembers.length})`}>
          {earlierMembers.map(member => <MemberRow key={member.memberId} member={member} session={listed.get(member.sessionId)} listed={sessions !== null} provider={team.provider} onOpen={openSession} />)}
        </Disclosure> : null}
        {team.lineup ? <Disclosure title="Recorded lineup">
          <Text style={t.note}>Requested model settings recorded when the run started; provider policy may override them.</Text>
          <LineupView lineup={team.lineup} />
        </Disclosure> : null}
      </Section>

      <Section title="Verification">
        <Text style={t.note}>Host check results and the reviewer’s assessment are recorded separately.</Text>
        {team.checks.length ? team.checks.map((check, index) => <View key={`${check.startedAt}/${index}`} style={t.card}>
          <Text style={t.mono}>{[check.command.command, ...check.command.args].join(" ")}</Text>
          <Text style={check.status === "failed" ? t.error : t.note}>{check.phase === "setup" ? "Setup · " : ""}{check.status} · revision {check.revision} · {shortDate(check.startedAt)}{check.exitCode !== undefined ? ` · exit ${String(check.exitCode)}` : ""}</Text>
          <Disclosure title="Output"><Text selectable style={t.mono}>{check.output ? check.output.slice(-6000) : "No output recorded."}</Text></Disclosure>
        </View>) : <Text style={t.note}>No check results recorded yet.</Text>}
        <Text style={t.label}>Reviewer assessment</Text>
        {team.review ? <>
          <Text style={team.review.verdict === "approved" ? t.strong : t.warning}>{team.review.verdict === "approved" ? "Approved" : "Changes requested"} · revision {team.review.revision} (agent claim)</Text>
          <Clamp text={team.review.summary} lines={4} />
          {team.review.uiEvidence ? <Disclosure title="Interface evidence"><Text style={t.body}>{team.review.uiEvidence}</Text></Disclosure> : null}
        </> : <Text style={t.note}>No review recorded for this revision.</Text>}
      </Section>

      <Section title="Changes">
        <Text style={t.note}>Branch</Text><Text selectable style={t.mono}>{team.branch}</Text>
        <Text style={t.note}>Workspace</Text><Text selectable style={t.mono}>{team.workspace}</Text>
        <Text style={t.note}>Base commit</Text><Text selectable style={t.mono}>{team.baseCommit}</Text>
        {team.headCommit ? <><Text style={t.note}>Head commit</Text><Text selectable style={t.mono}>{team.headCommit}</Text></> : null}
      </Section>

      {team.steering.length || answered.length ? <Section title="Your directions and decisions">
        {team.steering.map((entry, index) => <View key={`${entry.at}/${index}`} style={s.record}><Text style={t.note}>Direction · revision {entry.revision} · {shortDate(entry.at)}</Text><Clamp text={entry.text} lines={3} /></View>)}
        {answered.map(decision => <View key={decision.id} style={s.record}><Text style={t.note}>Decision · revision {decision.revision}</Text><Text style={t.body}>{decision.question}</Text><Text style={t.strong}>Your answer: {decision.answer}</Text></View>)}
      </Section> : null}

      {team.events.length ? <Disclosure title={`Run history (${team.events.length})`}>
        {[...team.events].reverse().map((event, index) => <Text key={`${event.at}/${index}`} style={t.note}>{shortDate(event.at)} · {event.text}</Text>)}
      </Disclosure> : null}

      {me?.role === "owner" && !team.goal && team.status !== "cancelled" ? <View style={s.actions}>
        {team.status === "paused" ? team.deliveryReceipt ? null : <Button title="Resume team" secondary disabled={!controls.resume || locked} onPress={() => send("/resume", "Resume")} />
          : controls.pause ? <Button title="Pause team" secondary disabled={locked} onPress={() => send("/pause", "Pause")} /> : null}
        <Button title="Cancel team…" secondary disabled={!controls.cancel || locked} onPress={() => Alert.alert("Cancel this team?", "This stops its agent sessions and keeps the recorded work and evidence.", [
          { text: "Keep running", style: "cancel" },
          { text: "Cancel team", style: "destructive", onPress: () => send("/cancel", "Cancellation") },
        ])} />
      </View> : null}
    </ScrollView>
    <View style={s.dock}>
      <RequestStatus request={request} canRetry={fresh && me?.role !== undefined && me.role !== "viewer" && (me.role === "owner" || /\/(steer|answer)$/.test(request.pending?.path ?? ""))} subject="team" />
      <SteerBox value={direction} onChange={setDirection} placeholder="Give the team a direction or change the requirements…"
        enabled={controls.steer && !locked} busy={request.busy}
        note={team.status === "delivering" || team.status === "merged" || team.deliveryReceipt ? "Delivery has started or been reported. Inspect its pull request and recorded evidence before starting further work."
          : me?.role === "viewer" ? "This device can view the team. An owner or controller can answer decisions and send direction."
          : team.goal ? "Answer this cycle’s decisions here. Open the goal to steer, pause, resume, or cancel its work."
            : team.status === "cancelled" ? "This run is cancelled. Its work and evidence remain available above." : undefined}
        onSend={() => { const text = direction.trim(); if (text) send("/steer", "Direction", { text }); }} />
    </View>
  </KeyboardAvoidingView>;
}

/** A member's question. The team records the answer and continues in a new attempt. */
function DecisionCard({ decision, member, disabled, onAnswer }: { decision: TeamDecision; member?: TeamMember; disabled: boolean; onAnswer: (text: string) => void }) {
  const [text, setText] = useState("");
  return <View style={[t.card, t.attention]}>
    <Text style={t.note}>{member ? ROLE_NAMES[member.role] : "Team"} · revision {decision.revision} · {shortDate(decision.createdAt)}</Text>
    <Text selectable style={t.body}>{decision.question}</Text>
    {decision.options.map((option, index) => <Button key={index} title={option} secondary disabled={disabled} onPress={() => onAnswer(option)} />)}
    <TextInput accessibilityLabel="Your answer" value={text} onChangeText={setText} editable={!disabled} multiline maxLength={8000}
      placeholder="Write your answer…" placeholderTextColor={theme.colors.placeholder} style={[t.input, s.answer]} />
    <Button title="Send answer" disabled={disabled || !text.trim()} onPress={() => onAnswer(text.trim())} />
  </View>;
}

function MemberRow({ member, session, listed, provider, onOpen }: { member: TeamMember; session?: SessionRow; listed: boolean; provider: string; onOpen: (id: string) => void }) {
  return <View style={t.card}>
    <View style={s.spread}>
      <Text style={[t.strong, s.fill]} numberOfLines={2}>{member.title}</Text>
      {session ? <StatePill state={session.attention.state} /> : null}
    </View>
    <Text style={t.note}>{ROLE_NAMES[member.role]} · {member.status} · revision {member.revision}{member.taskId ? ` · ${member.taskId}` : ""}</Text>
    {member.modelProfile ? <ProfileLine profile={member.modelProfile} /> : <Text style={t.note}>{providerName(member.provider ?? provider)}</Text>}
    {member.stoppedReason ? <Text style={t.warning}>Stopped: {member.stoppedReason}</Text> : null}
    {session?.attention.now ? <Text style={t.note} numberOfLines={2}>{session.attention.now}</Text> : null}
    <Button title="Open session" secondary disabled={listed && !session} onPress={() => onOpen(member.sessionId)} />
  </View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.compact, paddingHorizontal: theme.space.inset, paddingVertical: theme.space.label },
  offline: { color: theme.colors.warningInk },
  empty: { padding: 30, gap: 15 },
  titleBlock: { paddingHorizontal: theme.space.section, paddingBottom: theme.space.label, gap: 6 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.compact },
  spread: { flexDirection: "row", alignItems: "flex-start", gap: theme.space.compact },
  body: { padding: theme.space.section, paddingTop: 10, gap: 10, paddingBottom: 40 },
  record: { gap: 4, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.rule },
  link: { fontSize: 13, lineHeight: 20, color: theme.colors.forest, textDecorationLine: "underline" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: theme.space.section },
  answer: { minHeight: 70, textAlignVertical: "top", backgroundColor: theme.colors.white },
  dock: { gap: 8, paddingHorizontal: theme.space.inset, paddingVertical: theme.space.label, borderTopWidth: 1, borderTopColor: theme.colors.rule, backgroundColor: theme.colors.paper },
});
