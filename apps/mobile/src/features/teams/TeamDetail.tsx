import { useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me, type SessionRow } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { Card, Chip, GlassButton, GroupHeader, LiveStatus, ProgressBar, Segmented, Sheet, SheetRow, TopBar } from "../../components/Glass";
import { Glyph, StatusIcon } from "../../components/Icon";
import type { StatusKind } from "../../status";
import { theme } from "../../theme";
import {
  MEMBER_LABELS, memberKind, newer, openDecisions, ROLE_NAMES, shortDate, TEAM_LABELS, taskGroups, taskKind, teamControls, teamKind, teamProgress,
  type ModelProfile, type TeamCheck, type TeamDecision, type TeamMember, type TeamTask, type TeamView,
} from "./model";
import { Clamp, Disclosure, LinearChip, LineupView, ProfileLine, providerName, RequestStatus, Section, SteerBox, t } from "./parts";
import { useRunRequest } from "./useRunRequest";
import { AgentLog, JevcodeSummary } from "./TeamSummary";
import { orderedMembers } from "./summary";

type Tab = "overview" | "tasks" | "agents" | "activity";
const CHECK_KIND: Record<TeamCheck["status"], StatusKind> = { running: "progress", passed: "done", failed: "blocked", interrupted: "stopped" };
const live = (member: TeamMember) => member.status === "running" || member.status === "waiting";

/**
 * One team run, tracked the way Linear tracks a project: its state, plan progress, lead and agents
 * up top; Overview opens on what needs you and the Jevcode summary, Tasks lists the plan with its
 * assignees, Agents shows what each one is doing, and Activity holds the evidence.
 */
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
  const [tab, setTab] = useState<Tab>("overview");
  const [agentId, setAgentId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [actions, setActions] = useState(false);
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
  const owns = me?.role === "owner" && team && !team.goal && team.status !== "cancelled";
  const top = <TopBar backLabel="Teams" onBack={back} right={<>
    <LiveStatus online={fresh} loading={poll.loading} seen={poll.seen} />
    {team && (owns || team.goal) ? <GlassButton glyph="more" label="Team actions" onPress={() => setActions(true)} /> : null}
  </>} />;
  if (!team) return <View style={s.fill}>{top}<View style={s.empty}><ActivityIndicator /><Text style={t.note}>{poll.loading ? "Loading team…" : "The team could not be loaded. Check the machine and try again."}</Text></View></View>;

  const controls = teamControls(team, me?.role, fresh);
  const locked = request.busy || Boolean(request.pending);
  const decisions = openDecisions(team);
  const listed = new Map((sessions ?? []).map(session => [session.id, session]));
  const project = me?.projects?.find(value => value.id === team.projectId)?.name ?? team.projectId;
  const send = (path: string, label: string, fields?: Record<string, string>) => request.send(`/teams/${id}${path}`, label, team.revision, fields);
  const members = orderedMembers(team.members, team.revision);
  const current = members.filter(member => member.revision === team.revision);
  const earlier = members.filter(member => member.revision !== team.revision);
  const needsYou = current.filter(member => live(member) && listed.get(member.sessionId)?.attention.state === "needs-you");
  const working = current.filter(live);
  const { kind, fraction } = teamKind(team);
  const { done, total } = teamProgress(team);
  const profileOf = (member?: TeamMember, task?: TeamTask): ModelProfile | undefined => member?.modelProfile
    ?? [...(team.lineup?.implementers ?? []), ...(team.lineup?.escalations ?? [])].find(value => value.id === task?.agentProfileId);
  const agentLabel = (member: TeamMember) => member.modelProfile?.label ?? providerName(member.provider ?? team.provider);
  const agentState = (member: TeamMember) => listed.get(member.sessionId)?.attention.state === "needs-you" ? "attention" as const : member.status === "running" ? "live" as const : undefined;
  const taskOf = (member: TeamMember) => team.tasks.find(task => task.id === member.taskId);
  // Member titles repeat the role id and often the run title; keep only what adds information.
  const work = (member: TeamMember) => {
    const task = taskOf(member)?.title;
    if (task) return task;
    const title = member.title.replace(/^[a-z-]+:\s*/, "");
    return title === team.title ? "" : title;
  };
  const showAgent = (member: TeamMember) => { setTab("agents"); setAgentId(member.memberId); };
  const answered = team.decisions.filter(decision => decision.answer != null);
  const lead = team.lineup?.coordinator;

  const agentRow = (member: TeamMember) => {
    const open = agentId === member.memberId;
    const session = listed.get(member.sessionId);
    return <View key={member.memberId}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${ROLE_NAMES[member.role]}, ${MEMBER_LABELS[member.status] ?? member.status}. ${open ? "Hide" : "Show"} log`}
        onPress={() => setAgentId(open ? "" : member.memberId)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
        <Avatar label={agentLabel(member)} provider={member.modelProfile?.provider ?? member.provider ?? team.provider} size={30} state={agentState(member)} />
        <View style={s.main}>
          <View style={s.line}>
            <Text style={s.rowTitle} numberOfLines={1}>{ROLE_NAMES[member.role]}</Text>
            <StatusIcon kind={memberKind(member.status)} size={12} />
            <Text style={s.state}>{MEMBER_LABELS[member.status] ?? member.status}</Text>
            {member.revision !== team.revision ? <Text style={t.note}>rev {member.revision}</Text> : null}
          </View>
          <Text style={t.note} numberOfLines={1}>{[work(member), agentLabel(member)].filter(Boolean).join(" · ")}</Text>
          {session?.attention.now ? <Text style={[s.now, session.attention.state === "needs-you" && s.attentionText]} numberOfLines={2}>{session.attention.now}</Text> : null}
          {member.stoppedReason ? <Text style={t.warning} numberOfLines={2}>Stopped: {member.stoppedReason}</Text> : null}
        </View>
        <Glyph name={open ? "down" : "forward"} size={12} color={theme.colors.mutedInk} />
      </Pressable>
      {open ? <AgentLog connection={connection} member={member} live={live(member)} onOpen={() => openSession(member.sessionId)} /> : null}
    </View>;
  };

  return <KeyboardAvoidingView style={s.fill} behavior="padding">
    {top}
    {!fresh ? <Text style={t.banner}>Last received team state. Controls are paused until the host reconnects. The team may still be working.</Text> : null}
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" stickyHeaderIndices={[1]}
      refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={poll.refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <View style={s.head}>
        <Text style={s.crumb} numberOfLines={1}>{project}{team.goal ? ` · goal cycle ${team.goal.cycle}` : ""} · {shortDate(team.createdAt)}</Text>
        <Text style={t.title} numberOfLines={3}>{team.title}</Text>
        <View style={s.chips}>
          <Chip kind={kind} fraction={fraction} label={TEAM_LABELS[team.status]} tone={kind === "attention" || kind === "paused" ? "attention" : kind === "blocked" ? "error" : undefined} accessibilityLabel={`State: ${TEAM_LABELS[team.status]}`} />
          {total ? <Chip icon={<ProgressBar done={done} total={total} width={30} />} label={`${done}/${total} tasks`} accessibilityLabel={`${done} of ${total} tasks integrated`} /> : null}
          <Chip icon={<Avatar label={lead?.label ?? providerName(team.provider)} provider={lead?.provider ?? team.provider} size={16} />} label={lead?.label ?? providerName(team.provider)} accessibilityLabel={`Lead: ${lead?.label ?? providerName(team.provider)}`} />
          <Chip icon={<Glyph name="people" size={13} color={theme.colors.mutedInk} />} label={`${working.length}/${current.length} active`} onPress={() => setTab("agents")} accessibilityLabel={`${working.length} of ${current.length} agents active. Show agents`} />
          <LinearChip tracking={team.linear} fresh={fresh} />
          <Chip label={`Rev ${team.revision} · ≤${team.parallelism} parallel`} accessibilityLabel={`Revision ${team.revision}, up to ${team.parallelism} parallel implementers`} />
        </View>
        {team.linear?.reason ? <Text style={t.warning}>{team.linear.reason}</Text> : null}
      </View>
      <View style={s.sticky}>
        <Segmented value={tab} onChange={setTab} options={[
          { value: "overview", label: "Overview", count: decisions.length + needsYou.length, attention: true },
          { value: "tasks", label: "Tasks", count: team.tasks.length },
          { value: "agents", label: "Agents", count: current.length },
          { value: "activity", label: "Activity" },
        ]} />
      </View>

      {tab === "overview" ? <View>
        {team.reason ? <Card attention style={s.gapTop}><Text style={t.warning}>{team.reason}</Text></Card> : null}
        {team.status === "ready-for-review" ? <Card style={s.gapTop}>
          <View style={s.line}><StatusIcon kind="review" size={16} /><Text style={t.strong}>Ready for your review</Text></View>
          <Text style={t.note}>The team reports this run is ready. Inspect the changes and evidence before merging or publishing.</Text>
        </Card> : null}
        {team.deliveryReceipt ? <Card style={s.gapTop}>
          <View style={s.line}><StatusIcon kind="review" size={16} /><Text style={[t.strong, s.fill]}>Merge reported · agent claim</Text></View>
          <Text style={t.note}>The host records the delivery agent’s report. It does not verify GitHub or product impact.</Text>
          <Clamp text={team.deliveryReceipt.summary} lines={3} />
          <Text style={t.note}>Revision {team.deliveryReceipt.revision} · {shortDate(team.deliveryReceipt.reportedAt)}</Text>
          <Text selectable style={t.mono} numberOfLines={1} ellipsizeMode="middle">head {team.deliveryReceipt.headCommit}</Text>
          <Text selectable style={t.mono} numberOfLines={1} ellipsizeMode="middle">merge {team.deliveryReceipt.mergeCommit}</Text>
          {/^https:\/\//.test(team.deliveryReceipt.pullRequestUrl) ? <Button compact secondary title="Open pull request" onPress={() => void Linking.openURL(team.deliveryReceipt!.pullRequestUrl)} /> : null}
        </Card> : null}

        {decisions.length ? <Section title="Decisions for you" count={decisions.length}>
          {decisions.map(decision => <DecisionCard key={decision.id} decision={decision} member={team.members.find(member => member.memberId === decision.memberId)}
            disabled={!controls.answer || locked} onAnswer={text => send(`/decisions/${decision.id}/answer`, "Answer", { text })} />)}
          {team.status === "paused" ? <Text style={t.note}>Resume the team before answering.</Text> : null}
        </Section> : null}

        {needsYou.length ? <Section title="Agents waiting on a prompt" count={needsYou.length}>
          {needsYou.map(member => <Pressable key={member.memberId} accessibilityRole="button" accessibilityLabel={`Open ${ROLE_NAMES[member.role]} session to respond`}
            onPress={() => openSession(member.sessionId)} style={({ pressed }) => [s.prompt, pressed && s.pressed]}>
            <Avatar label={agentLabel(member)} provider={member.modelProfile?.provider ?? member.provider ?? team.provider} size={26} state="attention" />
            <View style={s.main}>
              <Text style={t.strong}>{ROLE_NAMES[member.role]}</Text>
              <Text style={s.now} numberOfLines={2}>{listed.get(member.sessionId)?.attention.now || "Respond in the session."}</Text>
            </View>
            <Glyph name="forward" size={12} color={theme.colors.warningInk} />
          </Pressable>)}
        </Section> : null}

        {team.noChange ? <Section title="No change proposed">
          <Clamp text={team.noChange.summary} lines={4} />
          {team.noChange.evidence.map((item, index) => <Text key={index} style={t.note}>{item.source}: {item.observation}</Text>)}
        </Section> : null}

        {working.length ? <Section title="Now" count={working.length} right={<Pressable accessibilityRole="button" onPress={() => setTab("agents")} hitSlop={10}><Text style={s.link}>All agents</Text></Pressable>}>
          <Card style={s.nowCard}>
            {working.map((member, index) => <Pressable key={member.memberId} accessibilityRole="button" accessibilityLabel={`${ROLE_NAMES[member.role]}${work(member) ? `: ${work(member)}` : ""}. Show log`}
              onPress={() => showAgent(member)} style={({ pressed }) => [s.nowRow, index > 0 && s.nowRule, pressed && s.pressed]}>
              <Avatar label={agentLabel(member)} provider={member.modelProfile?.provider ?? member.provider ?? team.provider} size={24} state={agentState(member)} />
              <View style={s.main}>
                <Text style={s.nowTitle} numberOfLines={1}><Text style={s.role}>{ROLE_NAMES[member.role]}</Text>{work(member) ? ` · ${work(member)}` : ""}</Text>
                <Text style={t.note} numberOfLines={1}>{listed.get(member.sessionId)?.attention.now || MEMBER_LABELS[member.status] || member.status}</Text>
              </View>
            </Pressable>)}
          </Card>
        </Section> : null}

        <Section title="Summary"><JevcodeSummary connection={connection} team={team} /></Section>
      </View> : null}

      {tab === "tasks" ? <View>
        {team.tasks.length ? taskGroups(team.tasks).map(group => <View key={group.status}>
          <GroupHeader kind={taskKind(group.tasks[0]!, team.tasks)} title={group.title} count={group.tasks.length} />
          {group.tasks.map(task => {
            const member = team.members.find(value => value.memberId === task.memberId);
            const profile = profileOf(member, task);
            const open = taskId === task.id;
            const after = task.dependsOn.map(dependency => team.tasks.find(value => value.id === dependency)?.title ?? dependency);
            const assignee = profile?.label ?? (member ? agentLabel(member) : undefined);
            return <View key={task.id}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${task.title}, ${group.title}${assignee ? `, assigned to ${assignee}` : ", unassigned"}`}
                onPress={() => setTaskId(open ? "" : task.id)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
                <View style={s.icon}><StatusIcon kind={taskKind(task, team.tasks)} size={16} /></View>
                <View style={s.main}>
                  <Text style={s.rowTitle} numberOfLines={open ? undefined : 2}>{task.title}</Text>
                  <Text style={t.note} numberOfLines={1}>{[task.id, after.length ? `after ${after.join(", ")}` : "", assignee].filter(Boolean).join(" · ")}</Text>
                  {task.escalation ? <Text style={t.warning} numberOfLines={open ? undefined : 1}>Escalated to {task.escalation.toProfileId}: {task.escalation.reason}</Text> : null}
                </View>
                {assignee ? <Avatar label={assignee} provider={profile?.provider ?? member?.provider ?? team.provider} size={24} state={member ? agentState(member) : undefined} /> : <View style={s.unassigned} accessible accessibilityLabel="Unassigned" />}
              </Pressable>
              {open ? <View style={s.detail}>
                {task.summary ? <><Text style={t.label}>Reported</Text><Clamp text={task.summary} lines={4} /></> : null}
                <Text style={t.label}>Instructions</Text>
                <Clamp text={task.instructions} lines={5} />
                {task.paths.length ? <><Text style={t.label}>Owned paths</Text>{task.paths.map(path => <Text key={path} selectable style={t.mono}>{path}</Text>)}</> : null}
                {profile ? <ProfileLine profile={profile} /> : null}
                {task.commit ? <Text selectable style={t.mono} numberOfLines={1} ellipsizeMode="middle">commit {task.commit}</Text> : null}
                {member ? <Button compact secondary glyph="people" title={`${ROLE_NAMES[member.role]} log`} onPress={() => showAgent(member)} /> : null}
              </View> : null}
            </View>;
          })}
        </View>) : <Text style={[t.note, s.gapTop]}>The coordinator has not reported a plan for this revision yet.</Text>}
      </View> : null}

      {tab === "agents" ? <View>
        {current.length ? current.map(agentRow) : <Text style={[t.note, s.gapTop]}>No agents have started for this revision.</Text>}
        {earlier.length ? <Disclosure title={`Earlier revisions · ${earlier.length}`}>{earlier.map(agentRow)}</Disclosure> : null}
        {team.lineup ? <Disclosure title="Recorded lineup">
          <Text style={t.note}>Requested model settings recorded when the run started; provider policy may override them.</Text>
          <LineupView lineup={team.lineup} />
        </Disclosure> : null}
      </View> : null}

      {tab === "activity" ? <View>
        <Section title="Checks" count={team.checks.length}>
          {team.checks.length ? team.checks.map((check, index) => <CheckRow key={`${check.startedAt}/${index}`} check={check} />) : <Text style={t.note}>No check results recorded yet.</Text>}
        </Section>
        <Section title="Review">
          {team.review ? <>
            <Chip kind={team.review.verdict === "approved" ? "review" : "attention"} tone={team.review.verdict === "approved" ? undefined : "attention"}
              label={`${team.review.verdict === "approved" ? "Approved" : "Changes requested"} · rev ${team.review.revision} · agent claim`} />
            <Clamp text={team.review.summary} lines={4} />
            {team.review.uiEvidence ? <Disclosure title="Interface evidence"><Text style={t.body}>{team.review.uiEvidence}</Text></Disclosure> : null}
          </> : <Text style={t.note}>No review recorded for this revision.</Text>}
          <Text style={t.note}>Host checks and the reviewer’s assessment are recorded separately.</Text>
        </Section>
        <Section title="Changes">
          <Card style={s.keys}>
            {([["Branch", team.branch], ["Head", team.headCommit], ["Base", team.baseCommit], ["Workspace", team.workspace]] as const).filter(([, value]) => value).map(([label, value]) =>
              <View key={label} style={s.key}><Text style={s.keyLabel}>{label}</Text><Text selectable style={[t.mono, s.fill]} numberOfLines={1} ellipsizeMode="middle">{value}</Text></View>)}
          </Card>
        </Section>
        <Section title="Request">
          <Clamp text={team.objective} lines={4} />
          {team.brief ? <Disclosure title="Opportunity brief · agent proposal">
            <Text style={t.strong}>{team.brief.title}</Text>
            <Clamp text={team.brief.problem} lines={4} />
            <Text style={t.label}>Acceptance</Text>
            {team.brief.acceptance.map((item, index) => <Text key={index} style={t.body}>• {item}</Text>)}
            <Text style={t.label}>Expected outcome</Text>
            <Text style={t.body}>{team.brief.expectedOutcome}</Text>
            {team.brief.evidence.map((item, index) => <Text key={index} style={t.note}>{item.source}: {item.observation}</Text>)}
          </Disclosure> : null}
        </Section>
        {team.steering.length || answered.length ? <Section title="Your directions and decisions" count={team.steering.length + answered.length}>
          {team.steering.map((entry, index) => <View key={`${entry.at}/${index}`} style={s.record}><Text style={t.note}>Direction · rev {entry.revision} · {shortDate(entry.at)}</Text><Clamp text={entry.text} lines={3} /></View>)}
          {answered.map(decision => <View key={decision.id} style={s.record}><Text style={t.note}>Decision · rev {decision.revision}</Text><Text style={t.body}>{decision.question}</Text><Text style={t.strong}>You: {decision.answer}</Text></View>)}
        </Section> : null}
        {team.events.length ? <Section title="History" count={team.events.length}>
          {[...team.events].reverse().slice(0, 6).map((event, index) => <HistoryRow key={`${event.at}/${index}`} at={event.at} day={team.updatedAt} text={event.text} />)}
          {team.events.length > 6 ? <Disclosure title={`Earlier · ${team.events.length - 6}`}>
            {[...team.events].reverse().slice(6).map((event, index) => <HistoryRow key={`${event.at}/${index}`} at={event.at} day={team.updatedAt} text={event.text} />)}
          </Disclosure> : null}
        </Section> : null}
      </View> : null}
    </ScrollView>
    <View style={s.dock}>
      <RequestStatus request={request} canRetry={fresh && me?.role !== undefined && me.role !== "viewer" && (me.role === "owner" || /\/(steer|answer)$/.test(request.pending?.path ?? ""))} subject="team" />
      <SteerBox value={direction} onChange={setDirection} placeholder="Direct the team or change requirements…"
        enabled={controls.steer && !locked} busy={request.busy}
        note={team.status === "delivering" || team.status === "merged" || team.deliveryReceipt ? "Delivery has started or been reported. Inspect its pull request and evidence before starting further work."
          : me?.role === "viewer" ? "This device can view the team. An owner or controller can answer decisions and send direction."
          : team.goal ? "Answer this cycle’s decisions here. Steer, pause, or cancel from its goal."
            : team.status === "cancelled" ? "This run is cancelled. Its work and evidence remain available." : undefined}
        onSend={() => { const text = direction.trim(); if (text) send("/steer", "Direction", { text }); }} />
    </View>
    <Sheet visible={actions} onClose={() => setActions(false)} title="Team">
      {team.goal ? <SheetRow glyph="target" label="Open goal" detail={`Cycle ${team.goal.cycle} · steer, pause, or cancel there`} onPress={() => { setActions(false); router.push({ pathname: "/goal/[id]", params: { id: team.goal!.id, machine } }); }} /> : null}
      {owns && (team.status === "paused" || team.resumable) && !team.deliveryReceipt ? <SheetRow glyph="play" label="Resume team" disabled={!controls.resume || locked} onPress={() => { setActions(false); send("/resume", "Resume"); }} /> : null}
      {owns && controls.pause && !(team.status === "paused" || team.resumable) ? <SheetRow glyph="pause" label="Pause team" disabled={locked} onPress={() => { setActions(false); send("/pause", "Pause"); }} /> : null}
      {owns ? <SheetRow glyph="close" destructive label="Cancel team…" detail="Stops its agents; keeps work and evidence" disabled={!controls.cancel || locked}
        onPress={() => Alert.alert("Cancel this team?", "This stops its agent sessions and keeps the recorded work and evidence.", [
          { text: "Keep running", style: "cancel" },
          { text: "Cancel team", style: "destructive", onPress: () => { setActions(false); send("/cancel", "Cancellation"); } },
        ])} /> : null}
    </Sheet>
  </KeyboardAvoidingView>;
}

/** A member's question. The team records the answer and continues in a new attempt. */
function DecisionCard({ decision, member, disabled, onAnswer }: { decision: TeamDecision; member?: TeamMember; disabled: boolean; onAnswer: (text: string) => void }) {
  const [text, setText] = useState("");
  return <Card attention>
    <Text style={s.decisionMeta}>{member ? ROLE_NAMES[member.role] : "Team"} · rev {decision.revision} · {shortDate(decision.createdAt)}</Text>
    <Text selectable style={t.body}>{decision.question}</Text>
    {decision.options.length ? <View style={s.options}>
      {decision.options.map((option, index) => <Button key={index} compact secondary title={option} disabled={disabled} onPress={() => onAnswer(option)} />)}
    </View> : null}
    <View style={s.answer}>
      <TextInput accessibilityLabel="Your answer" value={text} onChangeText={setText} editable={!disabled} multiline maxLength={8000}
        placeholder={decision.options.length ? "Or write an answer…" : "Write your answer…"} placeholderTextColor={theme.colors.placeholder} style={s.answerInput} />
      <GlassButton primary glyph="send" size={38} label="Send answer" disabled={disabled || !text.trim()} onPress={() => onAnswer(text.trim())} />
    </View>
  </Card>;
}

function CheckRow({ check }: { check: TeamCheck }) {
  const [open, setOpen] = useState(false);
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`Check ${check.status}: ${[check.command.command, ...check.command.args].join(" ")}`}
      onPress={() => setOpen(value => !value)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
      <View style={s.icon}><StatusIcon kind={CHECK_KIND[check.status]} size={16} /></View>
      <View style={s.main}>
        <Text style={t.mono} numberOfLines={open ? undefined : 1}>{[open ? check.command.command : check.command.command.split("/").pop(), ...check.command.args].join(" ")}</Text>
        <Text style={check.status === "failed" ? t.error : t.note}>{check.phase === "setup" ? "Setup · " : ""}{check.status} · rev {check.revision} · {shortDate(check.startedAt)}{check.exitCode !== undefined ? ` · exit ${String(check.exitCode)}` : ""}</Text>
      </View>
      <Glyph name={open ? "down" : "forward"} size={12} color={theme.colors.mutedInk} />
    </Pressable>
    {open ? <ScrollView horizontal style={s.output} contentContainerStyle={s.outputContent}>
      <Text selectable style={s.outputText}>{check.output ? check.output.slice(-6000) : "No output recorded."}</Text>
    </ScrollView> : null}
  </View>;
}

/** Times on the run's latest day show the clock only; earlier days add the date. */
function HistoryRow({ at, day, text }: { at: string; day: string; text: string }) {
  const when = new Date(at);
  const clock = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const label = when.toDateString() === new Date(day).toDateString() ? clock : `${when.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock}`;
  return <View style={s.history} accessible accessibilityLabel={`${shortDate(at)}: ${text}`}><Text style={s.historyTime}>{label}</Text><Text style={[t.note, s.fill]}>{text}</Text></View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  empty: { padding: 30, gap: 15, alignItems: "center" },
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  head: { gap: 8, paddingBottom: 12 },
  crumb: { fontSize: 12, color: theme.colors.mutedInk },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  sticky: { backgroundColor: theme.colors.paper, paddingVertical: 6 },
  gapTop: { marginTop: 12 },
  line: { flexDirection: "row", alignItems: "center", gap: 7 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  icon: { width: 18, alignItems: "center" },
  main: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.ink, flexShrink: 1 },
  state: { fontSize: 12, fontWeight: "600", color: theme.colors.secondaryInk },
  now: { fontSize: 13, lineHeight: 18, color: theme.colors.ink },
  attentionText: { color: theme.colors.warningInk },
  role: { fontWeight: "700", color: theme.colors.ink },
  link: { fontSize: 13, fontWeight: "600", color: theme.colors.forest },
  unassigned: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderStyle: "dashed", borderColor: theme.colors.fieldRule },
  detail: { gap: 6, paddingLeft: 30, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  prompt: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: theme.radius.card, backgroundColor: theme.colors.warningSurface },
  nowCard: { padding: 0, gap: 0, overflow: "hidden" },
  nowRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  nowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.rule },
  nowTitle: { fontSize: 13, lineHeight: 18, color: theme.colors.ink },
  keys: { gap: 0, paddingVertical: 4 },
  key: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7 },
  keyLabel: { width: 76, fontSize: 12, color: theme.colors.mutedInk },
  record: { gap: 3, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  history: { flexDirection: "row", gap: 10, paddingVertical: 3 },
  historyTime: { width: 64, fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk, fontVariant: ["tabular-nums"] },
  output: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.terminalSurface, maxHeight: 280, marginBottom: 8 },
  outputContent: { padding: 12 },
  outputText: { fontFamily: theme.mono, fontSize: 11, lineHeight: 16, color: theme.colors.terminalInk },
  decisionMeta: { fontSize: 12, fontWeight: "600", color: theme.colors.warningInk },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  answer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 4, paddingLeft: 4, borderRadius: 22, backgroundColor: theme.colors.white },
  answerInput: { flex: 1, minHeight: 38, maxHeight: 120, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: theme.colors.ink },
  dock: { gap: 6, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 10 },
});
