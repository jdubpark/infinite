import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me, type SessionRow } from "../../api/client";
import { AvatarStack } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { GroupHeader, ProgressBar } from "../../components/Glass";
import { StatusIcon } from "../../components/Icon";
import { age } from "../../status";
import { theme } from "../../theme";
import {
  blockedTeamsFirst, canContinueBlockedTeam, canResumeBlockedTeam, GOAL_LABELS, goalGroup, goalKind, groupRuns, newer, openDecisions, pendingApprovals, shortDate, TEAM_LABELS, teamGroup, teamKind, teamProgress, teamReady,
  type ProductGoal, type RunGroup, type TeamListItem, type TeamView,
} from "./model";
import { summarizeMobileListWaitReason } from "./inspector-model";
import { providerName, RequestStatus } from "./parts";
import { orderedMembers } from "./summary";
import { useRunRequest } from "./useRunRequest";

function useFolds() {
  const [open, setOpen] = useState<Partial<Record<RunGroup, boolean>>>({});
  return { folded: (group: RunGroup) => group === "closed" ? !open.closed : open[group] === false, toggle: (group: RunGroup, folded: boolean) => setOpen(value => ({ ...value, [group]: folded })) };
}

export function TeamList({ connection, me, teams, sessions, now }: { connection: Connection; me: Me; teams: TeamListItem[]; sessions: SessionRow[]; now: number }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const folds = useFolds();
  const project = (id: string) => me.projects?.find(value => value.id === id)?.name ?? id;
  const attention = new Set(sessions.filter(session => session.attention.state === "needs-you").map(session => session.id));
  const approvals = new Map(teams.map(team => [team.id, pendingApprovals(team, sessions).length]));
  return <View>
    {!me.teams?.enabled ? <Text style={s.notice}>Teams need host setup.</Text>
      : !me.projects?.some(teamReady) ? <Text style={s.notice}>No workspace has team checks yet.</Text> : null}
    {groupRuns(blockedTeamsFirst(teams), team => teamGroup(team, approvals.get(team.id))).map(group => {
      const folded = folds.folded(group.group);
      return <View key={group.group}>
        <GroupHeader kind={group.kind} title={group.title} count={group.items.length} collapsed={folded} onToggle={() => folds.toggle(group.group, folded)} />
        {folded ? null : group.items.map(team => {
          const { kind } = teamKind(team, approvals.get(team.id));
          const { done, total } = teamProgress(team);
          const open = openDecisions(team).length;
          const asks = approvals.get(team.id) ?? 0;
          const finished = ["ready-for-review", "cancelled", "no-change", "merged"].includes(team.status);
          const note = !asks && !finished && team.reason ? team.reason : "";
          const agents = orderedMembers(team.members.filter(member => member.revision === team.revision), team.revision);
          return <TeamRunRow key={team.id} connection={connection} team={team} role={me.role} machine={machine} now={now} kind={kind} done={done} total={total} open={open} asks={asks} note={note} agents={agents} attention={attention} project={project} onOpen={() => router.push({ pathname: "/team/[id]", params: { id: team.id, machine } })} />;
        })}
      </View>;
    })}
    {!teams.length ? <View style={s.empty}>
      <Text style={s.emptyTitle}>No teams</Text>
      <Text style={s.meta}>{me.role === "owner" ? "Start one with +." : "None yet."}</Text>
    </View> : null}
  </View>;
}

function TeamRunRow({ connection, team: received, role, machine, now, kind, done, total, open, asks, note, agents, attention, project, onOpen }: {
  connection: Connection; team: TeamListItem; role: Me["role"]; machine: string; now: number; kind: ReturnType<typeof teamKind>["kind"];
  done: number; total: number; open: number; asks: number; note: string; agents: TeamListItem["members"]; attention: Set<string>;
  project: (id: string) => string; onOpen: () => void;
}) {
  const [recorded, setRecorded] = useState<TeamListItem | null>(null);
  const team = newer(recorded, received);
  const request = useRunRequest<TeamView>(connection, `${machine}/team/${team.id}`, {
    accepted: result => {
      setRecorded(previous => newer<TeamListItem>(previous, result));
      void api<{ teams: TeamListItem[] }>(connection, "/teams?view=list").then(value => {
        const refreshed = value.teams.find(item => item.id === result.id);
        if (refreshed) setRecorded(previous => newer(previous, refreshed));
      }).catch(() => {});
    },
    refused: () => { void api<{ teams: TeamListItem[] }>(connection, "/teams?view=list").then(value => {
      const refreshed = value.teams.find(item => item.id === team.id);
      if (refreshed) setRecorded(previous => newer(previous, refreshed));
    }).catch(() => {}); },
  });
  const canResume = canResumeBlockedTeam(team, role);
  const canContinue = canContinueBlockedTeam(team, role);
  const resume = () => request.send(`/teams/${team.id}/resume`, "Resume", team.revision);
  const { kind: rowKind } = canResume ? { kind: "blocked" as const } : { kind };
  const waitSummary = team.status === "blocked" ? undefined : summarizeMobileListWaitReason(team);
  const normalizedNote = note.replace(/\s+/g, " ").trim();
  const duplicateActionCount = Boolean(
    waitSummary
    && waitSummary.extraCount === 0
    && ((waitSummary.kind === "owner-decision" && open > 0) || (waitSummary.kind === "provider-prompt" && asks > 0)),
  );
  const duplicateNote = Boolean(waitSummary && normalizedNote && normalizedNote === waitSummary.summary && waitSummary.extraCount === 0);
  const shownWait = waitSummary && !duplicateActionCount && !duplicateNote ? waitSummary : undefined;
  const waitAccessibility = shownWait
    ? [shownWait.label, shownWait.summary, shownWait.extraCount > 0 ? `plus ${shownWait.extraCount} more` : ""].filter(Boolean).join(", ")
    : "";
  const rowAccessibilityLabel = [
    `Open team ${team.title}`,
    TEAM_LABELS[team.status],
    total ? `${done} of ${total} tasks integrated` : "",
    waitAccessibility,
  ].filter(Boolean).join(", ");
  return <View style={s.runRowWrap}>
    <View style={s.listRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={rowAccessibilityLabel}
        onPress={onOpen} style={({ pressed }) => [s.rowContent, pressed && s.pressed]}>
        <View style={s.icon}><StatusIcon kind={rowKind} fraction={team.status === "blocked" ? 0 : teamKind(team).fraction} size={18} /></View>
        <View style={s.main}>
          <View style={s.line}>
            <Text style={s.title} numberOfLines={1}>{team.title}</Text>
            <Text style={s.age}>{age(team.updatedAt, now)}</Text>
          </View>
          <View style={s.line}>
            <Text style={[s.state, (rowKind === "attention" || rowKind === "paused") && s.attentionText, rowKind === "blocked" && s.errorText]} numberOfLines={1}>{TEAM_LABELS[team.status]}{open ? ` · ${open} ${open === 1 ? "decision" : "decisions"}` : ""}{asks ? ` · ${asks} ${asks === 1 ? "approval" : "approvals"}` : ""}</Text>
            {total ? <><ProgressBar done={done} total={total} width={40} /><Text style={s.meta}>{done}/{total}</Text></> : null}
            <View style={s.fill} />
            <AvatarStack size={20} people={agents.map(member => ({
              key: member.memberId, label: member.modelProfile?.label ?? providerName(member.provider ?? team.provider), provider: member.modelProfile?.provider ?? member.provider ?? team.provider,
              state: attention.has(member.sessionId) ? "attention" as const : member.status === "running" ? "live" as const : undefined,
            }))} />
          </View>
          {team.status === "blocked" ? <Text style={s.blockedReason} numberOfLines={2}>{team.reason ?? " "}</Text>
            : note ? <Text style={s.alert} numberOfLines={1}>{note}</Text>
              : <Text style={s.meta} numberOfLines={1}>{[project(team.projectId), team.linear?.issue?.identifier, team.goal ? `Goal cycle ${team.goal.cycle}` : ""].filter(Boolean).join(" · ")}</Text>}
          {shownWait ? <Text style={[s.waitLine, shownWait.tone === "attention" && s.attentionText, shownWait.tone === "error" && s.errorText]} numberOfLines={1}>
            <Text style={s.waitLabel}>{shownWait.label}</Text>
            {shownWait.summary ? ` · ${shownWait.summary}` : ""}
            {shownWait.extraCount > 0 ? ` (+${shownWait.extraCount})` : ""}
          </Text> : null}
        </View>
      </Pressable>
      {canResume ? <Button compact busy={request.busy} secondary title="Resume" disabled={request.busy || Boolean(request.pending)} onPress={resume} /> : null}
      {canContinue ? <Button compact secondary title="Continue" onPress={onOpen} /> : null}
    </View>
    {canResume || canContinue || request.pending || request.message ? <RequestStatus request={request} bottom={74} canRetry={role === "owner"} /> : null}
  </View>;
}

export function GoalList({ connection, me, goals, now }: { connection: Connection; me: Me; goals: ProductGoal[]; now: number }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const folds = useFolds();
  const project = (id: string) => me.projects?.find(value => value.id === id)?.name ?? id;
  return <View>
    {!me.goals?.enabled ? <Text style={s.notice}>Goals need a strong lineup and team checks.</Text> : null}
    {groupRuns(goals, goalGroup).map(group => {
      const folded = folds.folded(group.group);
      return <View key={group.group}>
        <GroupHeader kind={group.kind} title={group.title} count={group.items.length} collapsed={folded} onToggle={() => folds.toggle(group.group, folded)} />
        {folded ? null : group.items.map(goal => {
          const { kind, fraction } = goalKind(goal);
          const alert = goal.reason && !["cancelled", "achieved"].includes(goal.status) ? goal.reason : "";
          return <Pressable key={goal.id} accessibilityRole="button" accessibilityLabel={`Open goal ${goal.title}, ${GOAL_LABELS[goal.status]}`}
            onPress={() => router.push({ pathname: "/goal/[id]", params: { id: goal.id, machine } })} style={({ pressed }) => [s.row, pressed && s.pressed]}>
            <View style={s.icon}><StatusIcon kind={kind} fraction={fraction} size={18} /></View>
            <View style={s.main}>
              <View style={s.line}>
                <Text style={s.title} numberOfLines={1}>{goal.title}</Text>
                <Text style={s.age}>{age(goal.updatedAt, now)}</Text>
              </View>
              <View style={s.line}>
                <Text style={[s.state, (kind === "attention" || kind === "paused") && s.attentionText, kind === "blocked" && s.errorText]} numberOfLines={1}>{GOAL_LABELS[goal.status]}</Text>
                <ProgressBar done={goal.cycles.length} total={goal.maxRuns} width={40} />
                <Text style={s.meta}>{goal.cycles.length}/{goal.maxRuns} cycles</Text>
              </View>
              {alert ? <Text style={s.alert} numberOfLines={1}>{alert}</Text>
                : <Text style={s.meta} numberOfLines={1}>{[project(goal.projectId), goal.linear?.issue?.identifier, `due ${shortDate(goal.deadlineAt)}`].filter(Boolean).join(" · ")}</Text>}
            </View>
          </Pressable>;
        })}
      </View>;
    })}
    {!goals.length ? <View style={s.empty}>
      <Text style={s.emptyTitle}>No goals</Text>
      <Text style={s.meta}>{me.role === "owner" ? "Start one with +." : "None yet."}</Text>
    </View> : null}
  </View>;
}

export const listStyles = StyleSheet.create({
  runRowWrap: { position: "relative" },
  listRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  rowContent: { flex: 1, flexDirection: "row", gap: 12 },
  row: { flexDirection: "row", gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  icon: { width: 20, alignItems: "center", paddingTop: 2 },
  main: { flex: 1, gap: 4 },
  line: { flexDirection: "row", alignItems: "center", gap: 7 },
  fill: { flex: 1 },
  title: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.colors.ink },
  age: { fontSize: 12, color: theme.colors.mutedInk, fontVariant: ["tabular-nums"] },
  state: { fontSize: 12, fontWeight: "600", color: theme.colors.secondaryInk, flexShrink: 1 },
  attentionText: { color: theme.colors.warningInk },
  errorText: { color: theme.colors.error },
  meta: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk, flexShrink: 1 },
  alert: { fontSize: 13, lineHeight: 18, color: theme.colors.warningInk },
  waitLine: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk, flexShrink: 1 },
  waitLabel: { fontWeight: "600" },
  blockedReason: { minHeight: 34, fontSize: 12, lineHeight: 17, color: theme.colors.error, flexShrink: 1 },
  notice: { backgroundColor: theme.colors.warningSurface, color: theme.colors.warningInk, fontSize: 12, lineHeight: 18, padding: 12, borderRadius: theme.radius.card, marginTop: 12 },
  empty: { paddingVertical: 40, paddingHorizontal: 12, gap: 8, alignItems: "center" },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: theme.colors.ink },
});
const s = listStyles;
