import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { connectionKey, type Connection, type Me, type SessionRow } from "../../api/client";
import { AvatarStack } from "../../components/Avatar";
import { GroupHeader, ProgressBar } from "../../components/Glass";
import { StatusIcon } from "../../components/Icon";
import { age } from "../../status";
import { theme } from "../../theme";
import {
  GOAL_LABELS, goalGroup, goalKind, groupRuns, openDecisions, shortDate, TEAM_LABELS, teamGroup, teamKind, teamProgress, teamReady,
  type ProductGoal, type RunGroup, type TeamView,
} from "./model";
import { providerName } from "./parts";
import { orderedMembers } from "./summary";

/** Closed runs start folded so live work stays on the first screen. */
function useFolds() {
  const [open, setOpen] = useState<Partial<Record<RunGroup, boolean>>>({});
  return { folded: (group: RunGroup) => group === "closed" ? !open.closed : open[group] === false, toggle: (group: RunGroup, folded: boolean) => setOpen(value => ({ ...value, [group]: folded })) };
}

/**
 * The Teams tab as a Linear-style project list: each run's state, plan progress, and the agents
 * assigned to it, grouped by what it needs from a person.
 */
export function TeamList({ connection, me, teams, sessions, now }: { connection: Connection; me: Me; teams: TeamView[]; sessions: SessionRow[]; now: number }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const folds = useFolds();
  const project = (id: string) => me.projects?.find(value => value.id === id)?.name ?? id;
  const attention = new Set(sessions.filter(session => session.attention.state === "needs-you").map(session => session.id));
  return <View>
    {!me.teams?.enabled ? <Text style={s.notice}>Teams need host setup. Enable teams in the host configuration and give a workspace its required checks.</Text>
      : !me.projects?.some(teamReady) ? <Text style={s.notice}>No workspace is ready for a team. Add required team checks to a workspace in the host configuration.</Text> : null}
    {groupRuns(teams, teamGroup).map(group => {
      const folded = folds.folded(group.group);
      return <View key={group.group}>
        <GroupHeader kind={group.kind} title={group.title} count={group.items.length} collapsed={folded} onToggle={() => folds.toggle(group.group, folded)} />
        {folded ? null : group.items.map(team => {
          const { kind, fraction } = teamKind(team);
          const { done, total } = teamProgress(team);
          const open = openDecisions(team).length;
          const finished = ["ready-for-review", "cancelled", "no-change", "merged"].includes(team.status);
          const alert = !finished && team.reason ? team.reason : "";
          const agents = orderedMembers(team.members.filter(member => member.revision === team.revision), team.revision);
          return <Pressable key={team.id} accessibilityRole="button" accessibilityLabel={`Open team ${team.title}, ${TEAM_LABELS[team.status]}${total ? `, ${done} of ${total} tasks integrated` : ""}`}
            onPress={() => router.push({ pathname: "/team/[id]", params: { id: team.id, machine } })} style={({ pressed }) => [s.row, pressed && s.pressed]}>
            <View style={s.icon}><StatusIcon kind={kind} fraction={fraction} size={18} /></View>
            <View style={s.main}>
              <View style={s.line}>
                <Text style={s.title} numberOfLines={1}>{team.title}</Text>
                <Text style={s.age}>{age(team.updatedAt, now)}</Text>
              </View>
              <View style={s.line}>
                <Text style={[s.state, (kind === "attention" || kind === "paused") && s.attentionText, kind === "blocked" && s.errorText]} numberOfLines={1}>{TEAM_LABELS[team.status]}{open ? ` · ${open} ${open === 1 ? "decision" : "decisions"}` : ""}</Text>
                {total ? <><ProgressBar done={done} total={total} width={40} /><Text style={s.meta}>{done}/{total}</Text></> : null}
                <View style={s.fill} />
                <AvatarStack size={20} people={agents.map(member => ({
                  key: member.memberId, label: member.modelProfile?.label ?? providerName(member.provider ?? team.provider), provider: member.modelProfile?.provider ?? member.provider ?? team.provider,
                  state: attention.has(member.sessionId) ? "attention" as const : member.status === "running" ? "live" as const : undefined,
                }))} />
              </View>
              {alert ? <Text style={s.alert} numberOfLines={2}>{alert}</Text>
                : <Text style={s.meta} numberOfLines={1}>{[project(team.projectId), team.linear?.issue?.identifier, team.lineup ? `Lead ${team.lineup.coordinator.label}` : providerName(team.provider), team.goal ? `Goal cycle ${team.goal.cycle}` : ""].filter(Boolean).join(" · ")}</Text>}
            </View>
          </Pressable>;
        })}
      </View>;
    })}
    {!teams.length ? <View style={s.empty}>
      <Text style={s.emptyTitle}>No team runs yet</Text>
      <Text style={s.meta}>{me.role === "owner" ? "Describe a feature or paste a PRD. A coordinator plans it and implementers build it in parallel." : "Team runs appear here when an owner starts one on this machine."}</Text>
    </View> : null}
  </View>;
}

/** The Goals tab: each goal's state, cycles used against its limit, and deadline. */
export function GoalList({ connection, me, goals, now }: { connection: Connection; me: Me; goals: ProductGoal[]; now: number }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const folds = useFolds();
  const project = (id: string) => me.projects?.find(value => value.id === id)?.name ?? id;
  return <View>
    {!me.goals?.enabled ? <Text style={s.notice}>Goals need a configured team lineup with strong coordinator and reviewer profiles, and a workspace with required checks.</Text> : null}
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
              {alert ? <Text style={s.alert} numberOfLines={2}>{alert}</Text>
                : <Text style={s.meta} numberOfLines={1}>{[project(goal.projectId), goal.linear?.issue?.identifier, `${goal.memberCount}/${goal.maxMembers} agents`, `due ${shortDate(goal.deadlineAt)}`].filter(Boolean).join(" · ")}</Text>}
            </View>
          </Pressable>;
        })}
      </View>;
    })}
    {!goals.length ? <View style={s.empty}>
      <Text style={s.emptyTitle}>No goals yet</Text>
      <Text style={s.meta}>{me.role === "owner" ? "Set a product outcome with evidence and limits. Agents choose and build reviewed improvements." : "Goals appear here when an owner starts one on this machine."}</Text>
    </View> : null}
  </View>;
}

export const listStyles = StyleSheet.create({
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
  notice: { backgroundColor: theme.colors.warningSurface, color: theme.colors.warningInk, fontSize: 12, lineHeight: 18, padding: 12, borderRadius: theme.radius.card, marginTop: 12 },
  empty: { paddingVertical: 40, paddingHorizontal: 12, gap: 8, alignItems: "center" },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: theme.colors.ink },
});
const s = listStyles;
