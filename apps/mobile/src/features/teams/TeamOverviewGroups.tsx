import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { Card, Chip, ProgressBar } from "../../components/Glass";
import { StatusIcon } from "../../components/Icon";
import { theme } from "../../theme";
import { deriveMobileOutcomeGroups, deriveReviewerAcceptanceClaims, partitionMobileRoster } from "./inspector-model";
import { MEMBER_LABELS, memberKind, ROLE_NAMES, teamProgress, type TeamMember, type TeamView } from "./model";
import { Clamp, Disclosure, Section, t } from "./parts";

const ASSESSMENT_LABELS: Record<"met" | "not-met" | "inconclusive" | "pending-owner", string> = {
  met: "Met",
  "not-met": "Not met",
  inconclusive: "Inconclusive",
  "pending-owner": "Waiting for you",
};

const ACCEPTANCE_LABELS: Record<"verified" | "not-verified" | "inconclusive", string> = {
  verified: "Verified",
  "not-verified": "Not verified",
  inconclusive: "Inconclusive",
};

const isFailedOrStopped = (member: TeamMember) =>
  member.status === "stopped" || member.status === "unavailable" || Boolean(member.stoppedReason) || Boolean(member.stalledAt);

export function TeamOverviewGroups({
  team,
  onSelectMember,
}: {
  team: TeamView;
  onSelectMember: (member: TeamMember) => void;
}) {
  const groups = deriveMobileOutcomeGroups(team);
  const reviewerClaims = deriveReviewerAcceptanceClaims(team);
  const { active, finished } = partitionMobileRoster(team.members, team.revision);
  const memberById = new Map(team.members.map(member => [member.memberId, member]));
  const taskById = new Map(team.tasks.map(task => [task.id, task]));
  const progress = teamProgress(team);

  return <>
    <Section title="Outcome groups" count={groups.length || undefined}>
      {groups.length ? <Card style={s.card}>
        {groups.map((group, index) => <View key={group.id} style={[s.groupRow, index > 0 && s.rowRule]}>
          <View style={s.rowHead}>
            <Text style={s.criterionId}>{group.id}</Text>
            <Text style={[t.note, s.fill]} numberOfLines={1}>{group.check}</Text>
            <ProgressBar done={group.done} total={group.total} width={44} />
          </View>
          <Clamp text={group.statement} lines={3} />
          <Text style={t.note}>{group.integrationSummary}</Text>
          {group.provisionalAssessment ? <View style={s.chips}>
            <Chip
              label={`${group.provisionalAssessment.label} · ${ASSESSMENT_LABELS[group.provisionalAssessment.state]}`}
              tone={group.provisionalAssessment.state === "not-met" ? "error" : group.provisionalAssessment.state === "pending-owner" || group.provisionalAssessment.state === "inconclusive" ? "attention" : undefined}
            />
          </View> : null}
        </View>)}
      </Card> : <Card style={s.card}>
        <View style={s.rowHead}>
          <ProgressBar done={progress.done} total={progress.total} width={44} />
          <Text style={t.strong}>{progress.done} of {progress.total} tasks integrated</Text>
        </View>
        <Text style={t.note}>No pinned goal criteria for this run.</Text>
      </Card>}
    </Section>

    {reviewerClaims.length ? <Section title="Reviewer claims" count={reviewerClaims.length}>
      <Card style={s.card}>
        <Text style={t.note}>Reviewer claim · rev {reviewerClaims[0]!.revision}</Text>
        {reviewerClaims.map((item, index) => <View key={item.criterion} style={[s.claimItem, index > 0 && s.rowRule]}>
          <View style={s.rowHead}>
            <Text style={t.strong}>Acceptance #{item.criterion}</Text>
            <Chip
              label={`Reviewer claim · ${ACCEPTANCE_LABELS[item.verdict]}`}
              tone={item.verdict === "not-verified" ? "error" : item.verdict === "inconclusive" ? "attention" : undefined}
            />
          </View>
          {item.statement ? <Text style={t.body}>{item.statement}</Text> : null}
          <Text style={t.note}>{item.evidence}</Text>
        </View>)}
      </Card>
    </Section> : null}

    <Section title="Compact roster" count={active.length}>
      {active.length ? <Card style={s.rosterCard}>
        {active.map(({ member }, index) => {
          const taskTitle = member.taskId ? taskById.get(member.taskId)?.title : undefined;
          return <Pressable
            key={member.memberId}
            accessibilityRole="button"
            accessibilityLabel={`${ROLE_NAMES[member.role] ?? member.role}, ${MEMBER_LABELS[member.status] ?? member.status}. Open agent log`}
            onPress={() => onSelectMember(member)}
            style={({ pressed }) => [s.rosterRow, index > 0 && s.rowRule, pressed && s.pressed]}
          >
            <StatusIcon kind={memberKind(member.status)} size={14} />
            <View style={s.fill}>
              <Text style={s.memberTitle} numberOfLines={1}>
                {ROLE_NAMES[member.role] ?? member.role}{taskTitle ? ` · ${taskTitle}` : ""}
              </Text>
              <Text style={t.note} numberOfLines={1}>{MEMBER_LABELS[member.status] ?? member.status}</Text>
            </View>
          </Pressable>;
        })}
      </Card> : <Text style={t.note}>No active or waiting agents in the current revision.</Text>}

      {finished.length ? <Disclosure title={`Finished (${finished.length})`}>
        {finished.map(({ member, replacedByMemberId }) => {
          const replacement = replacedByMemberId ? memberById.get(replacedByMemberId) : undefined;
          const taskTitle = member.taskId ? taskById.get(member.taskId)?.title : undefined;
          return <View key={member.memberId} style={s.finishedRow}>
            <View style={s.rowHead}>
              <StatusIcon kind={memberKind(member.status)} size={13} />
              <Text style={[s.memberTitle, s.fill]} numberOfLines={1}>
                {ROLE_NAMES[member.role] ?? member.role}{taskTitle ? ` · ${taskTitle}` : ""}
              </Text>
              <Text style={t.note}>{MEMBER_LABELS[member.status] ?? member.status}{member.revision !== team.revision ? ` · rev ${member.revision}` : ""}</Text>
            </View>
            {member.stoppedReason ? <Text style={t.warning} numberOfLines={2}>Stopped: {member.stoppedReason}</Text> : null}
            <View style={s.actions}>
              <Button compact secondary glyph="terminal" title="Open log" onPress={() => onSelectMember(member)} />
              {replacement && isFailedOrStopped(member) ? <Button
                compact
                secondary
                glyph="forward"
                title="Jump to replacement"
                onPress={() => onSelectMember(replacement)}
              /> : null}
            </View>
          </View>;
        })}
      </Disclosure> : null}
    </Section>
  </>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  card: { gap: 10 },
  groupRow: { gap: 6, paddingTop: 8 },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.rule },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  criterionId: { fontFamily: theme.mono, fontSize: 12, fontWeight: "700", color: theme.colors.secondaryInk },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  claimItem: { gap: 4, paddingTop: 8 },
  rosterCard: { padding: 0, gap: 0, overflow: "hidden" },
  rosterRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  memberTitle: { fontSize: 13, fontWeight: "600", color: theme.colors.ink },
  finishedRow: { gap: 6, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
