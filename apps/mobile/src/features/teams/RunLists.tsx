import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { connectionKey, type Connection, type Me } from "../../api/client";
import { Button } from "../../components/Button";
import { theme } from "../../theme";
import { GOAL_LABELS, goalTone, leadLabel, openDecisions, shortDate, TEAM_LABELS, teamReady, teamRowLine, teamTone, type ProductGoal, type TeamView } from "./model";
import { providerName, RunPill, t } from "./parts";

/** The home screen's Teams tab: every run on this machine, newest first, with what each waits on. */
export function TeamList({ connection, me, teams, online }: { connection: Connection; me: Me; teams: TeamView[]; online: boolean }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const project = (id: string) => me.projects?.find(value => value.id === id)?.name ?? id;
  return <View>
    <View style={s.heading}>
      <Text style={t.note}>{teams.filter(team => team.status === "needs-input").length} need you · {teams.length} {teams.length === 1 ? "run" : "runs"}</Text>
      {me.role === "owner" ? <Button title="New team" disabled={!online || !me.teams?.enabled} onPress={() => router.push({ pathname: "/team/new", params: { machine } })} /> : null}
    </View>
    {!me.teams?.enabled ? <Text style={s.notice}>Teams need host setup. Enable teams in the host configuration and give a workspace its required checks.</Text>
      : !me.projects?.some(teamReady) ? <Text style={s.notice}>No workspace is ready for a team. Add required team checks to a workspace in the host configuration.</Text> : null}
    {teams.map(team => <Pressable key={team.id} accessibilityRole="button" accessibilityLabel={`Open team ${team.title}`}
      onPress={() => router.push({ pathname: "/team/[id]", params: { id: team.id, machine } })}
      style={({ pressed }) => [s.row, (team.status === "needs-input" || openDecisions(team).length > 0) && s.rowNeedsYou, pressed && s.pressed]}>
      <View style={s.rowTop}>
        <Text style={s.rowTitle} numberOfLines={1}>{team.title}</Text>
        <RunPill label={TEAM_LABELS[team.status]} tone={teamTone(team.status)} />
      </View>
      <Text style={s.now} numberOfLines={2}>{teamRowLine(team)}</Text>
      <Text style={t.note}>{project(team.projectId)} · {leadLabel(team, providerName)}{team.goal ? ` · goal cycle ${team.goal.cycle}` : ""} · {shortDate(team.createdAt)}</Text>
    </Pressable>)}
    {!teams.length ? <View style={s.empty}>
      <Text style={s.subtitle}>No team runs yet.</Text>
      <Text style={t.note}>{me.role === "owner" ? "Describe a feature or paste a PRD. A coordinator plans it and implementers build it in parallel." : "Team runs appear here when an owner starts one on this machine."}</Text>
    </View> : null}
  </View>;
}

/** The home screen's Goals tab. */
export function GoalList({ connection, me, goals, online }: { connection: Connection; me: Me; goals: ProductGoal[]; online: boolean }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const project = (id: string) => me.projects?.find(value => value.id === id)?.name ?? id;
  return <View>
    <View style={s.heading}>
      <Text style={t.note}>{goals.filter(goal => goal.status === "needs-input").length} need you · {goals.length} {goals.length === 1 ? "goal" : "goals"}</Text>
      {me.role === "owner" ? <Button title="New goal" disabled={!online || !me.goals?.enabled} onPress={() => router.push({ pathname: "/goal/new", params: { machine } })} /> : null}
    </View>
    {!me.goals?.enabled ? <Text style={s.notice}>Goals need a configured team lineup with strong coordinator and reviewer profiles, and a workspace with required checks.</Text> : null}
    {goals.map(goal => <Pressable key={goal.id} accessibilityRole="button" accessibilityLabel={`Open goal ${goal.title}`}
      onPress={() => router.push({ pathname: "/goal/[id]", params: { id: goal.id, machine } })}
      style={({ pressed }) => [s.row, goal.status === "needs-input" && s.rowNeedsYou, pressed && s.pressed]}>
      <View style={s.rowTop}>
        <Text style={s.rowTitle} numberOfLines={1}>{goal.title}</Text>
        <RunPill label={GOAL_LABELS[goal.status]} tone={goalTone(goal.status)} />
      </View>
      <Text style={s.now} numberOfLines={2}>{goal.reason && !["cancelled", "achieved"].includes(goal.status) ? goal.reason : goal.objective.split("\n")[0]}</Text>
      <Text style={t.note}>{project(goal.projectId)} · {goal.cycles.length}/{goal.maxRuns} cycles · {goal.memberCount}/{goal.maxMembers} members · deadline {shortDate(goal.deadlineAt)}</Text>
    </Pressable>)}
    {!goals.length ? <View style={s.empty}>
      <Text style={s.subtitle}>No goals yet.</Text>
      <Text style={t.note}>{me.role === "owner" ? "Set a product outcome with evidence and limits. Agents choose and build reviewed improvements." : "Goals appear here when an owner starts one on this machine."}</Text>
    </View> : null}
  </View>;
}

const s = StyleSheet.create({
  heading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: theme.colors.rule, paddingVertical: 15, marginTop: 10 },
  notice: { backgroundColor: theme.colors.warningSurface, color: theme.colors.warningInk, fontSize: 12, lineHeight: 19, padding: 14, marginTop: 12 },
  row: { paddingVertical: theme.space.label, borderBottomWidth: 1, borderBottomColor: theme.colors.rule, gap: 6 },
  rowNeedsYou: { borderLeftWidth: 3, borderLeftColor: theme.colors.warningInk, paddingLeft: 12 },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 15 },
  rowTitle: { flex: 1, fontSize: 17, fontWeight: "500", color: theme.colors.ink },
  now: { fontSize: 14, lineHeight: 20, color: theme.colors.ink },
  empty: { padding: 30, gap: 15 },
  subtitle: { fontSize: 18, fontWeight: "500", color: theme.colors.ink },
});
