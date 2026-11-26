import { useEffect, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  getMissionProgress, listTeamEntries,
  type Connection, type MissionProgressPage, type MissionProgressSnapshot, type TeamEntryHead,
} from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { Card, Chip, Sheet } from "../../components/Glass";
import { Glyph, StatusIcon } from "../../components/Icon";
import { age, type StatusKind } from "../../status";
import { theme } from "../../theme";
import { authorityLabel } from "../teams/inspector-model";
import { ROLE_NAMES, shortDate, TEAM_LABELS } from "../teams/model";
import { Disclosure, Section, t } from "../teams/parts";
import {
  applyMissionProgressPage, createMissionProgressState, dismissMissionProgressNotice, linkedTeamIdOf, partitionMissionSubtasks,
  type MissionProgressState,
} from "./mission-progress-model";

type Action =
  | { type: "reset"; missionId: string }
  | { type: "page"; page: MissionProgressPage }
  | { type: "dismissNotice" };

function reducer(state: MissionProgressState, action: Action): MissionProgressState {
  switch (action.type) {
    case "reset":
      return createMissionProgressState(action.missionId);
    case "page":
      return applyMissionProgressPage(state, action.page);
    case "dismissNotice":
      return dismissMissionProgressNotice(state);
  }
}

function subtaskIconKind(status: MissionProgressSnapshot["subtasks"][number]["status"]): StatusKind {
  switch (status) {
    case "done": return "done";
    case "running": return "progress";
    case "blocked": return "blocked";
    case "cancelled": return "cancelled";
    default: return "todo";
  }
}

function summarizeChild(child: MissionProgressSnapshot["subtasks"][number]["child"]): string {
  if (child.kind === "not-created") return "Team not created yet";
  if (child.kind === "missing") return "Child team record missing";
  if (child.kind === "mismatched") return "Child team mismatch";
  const teamLabel = TEAM_LABELS[child.status] ?? child.status;
  const activeWorkers = child.assignments.filter(member => member.recordedStatus === "running" || member.recordedStatus === "waiting").length;
  const latestCheck = child.checks[child.checks.length - 1];
  const checkText = latestCheck
    ? `check ${latestCheck.status}${latestCheck.exitCode !== undefined ? ` (${String(latestCheck.exitCode)})` : ""}${latestCheck.headCommit ? ` · ${latestCheck.headCommit.slice(0, 8)}` : ""}`
    : undefined;
  return [teamLabel, `${activeWorkers}/${child.assignments.length} active`, checkText].filter(Boolean).join(" · ");
}

export function MissionProgressSection({
  connection,
  missionId,
  repoName,
  onOpenTeam,
  onOpenSession,
}: {
  connection: Connection;
  missionId: string;
  repoName: (projectId: string) => string;
  onOpenTeam: (teamId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [state, dispatch] = useReducer(reducer, missionId, createMissionProgressState);
  const cursorRef = useRef<string | undefined>(undefined);
  const [previewTeam, setPreviewTeam] = useState<{ teamId: string; title: string } | null>(null);
  const [previewEntries, setPreviewEntries] = useState<TeamEntryHead[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    cursorRef.current = undefined;
    dispatch({ type: "reset", missionId });
  }, [missionId]);

  const poll = usePoll(async () => {
    const page = await getMissionProgress(connection, missionId, cursorRef.current);
    cursorRef.current = page.cursor;
    dispatch({ type: "page", page });
    return { page, at: Date.now() };
  }, 3000, [connection, missionId]);

  function openPreview(teamId: string, title: string) {
    setPreviewEntries([]);
    setPreviewError("");
    setPreviewLoading(true);
    setPreviewTeam({ teamId, title });
  }

  function closePreview() {
    setPreviewTeam(null);
    setPreviewEntries([]);
    setPreviewError("");
    setPreviewLoading(false);
  }

  useEffect(() => {
    if (!previewTeam) return;
    let active = true;
    listTeamEntries(connection, previewTeam.teamId, { since: 0, limit: 20 })
      .then(page => {
        if (active) setPreviewEntries([...page.entries].reverse().slice(0, 10));
      })
      .catch(error => {
        if (active) setPreviewError(error instanceof Error ? error.message : "Could not load team entries.");
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => { active = false; };
  }, [connection, previewTeam]);

  const snapshot = state.snapshot;
  const now = poll.data?.at ?? 0;
  const subtasks = snapshot?.subtasks ?? [];
  const { active, finished } = partitionMissionSubtasks(subtasks);
  const subtaskById = new Map(subtasks.map(item => [item.id, item]));

  return <Section title="Live progress" count={subtasks.length || undefined}>
    {state.resyncNotice ? <Card attention style={s.banner}>
      <Text style={[t.warning, s.fill]}>{state.resyncNotice}</Text>
      <Button compact secondary title="Dismiss" onPress={() => dispatch({ type: "dismissNotice" })} />
    </Card> : null}

    {poll.loading && !snapshot ? <ActivityIndicator style={s.loader} color={theme.colors.forest} /> : null}
    {!poll.loading && poll.stale && !snapshot ? <Text style={t.warning}>Could not load live mission progress.</Text> : null}

    {snapshot?.mission.coordinator ? <Card style={s.coordinatorCard}>
      <View style={s.rowHead}>
        <Text style={t.strong}>Coordinator</Text>
        <Chip label={`${snapshot.mission.coordinator.recordedStatus} · worker ${snapshot.mission.coordinator.workerStatus}`} />
      </View>
      <Button
        compact
        secondary
        glyph="terminal"
        title="Open coordinator session"
        onPress={() => onOpenSession(snapshot.mission.coordinator!.sessionId)}
      />
    </Card> : null}

    {active.length ? <Card style={s.listCard}>
      {active.map(({ subtask, replacedBySubtaskId }, index) => {
        const teamId = linkedTeamIdOf(subtask.child);
        const replacement = replacedBySubtaskId ? subtaskById.get(replacedBySubtaskId) : undefined;
        const replacementTeamId = replacement ? linkedTeamIdOf(replacement.child) : undefined;
        return <View key={subtask.id} style={[s.itemWrap, index > 0 && s.rowRule]}>
          <Pressable
            accessibilityRole="button"
            disabled={!teamId}
            accessibilityLabel={`${subtask.title}, ${repoName(subtask.repoProjectId)}, ${summarizeChild(subtask.child)}`}
            onPress={() => { if (teamId) openPreview(teamId, subtask.title); }}
            style={({ pressed }) => [s.itemRow, pressed && teamId && s.pressed]}
          >
            <StatusIcon kind={subtaskIconKind(subtask.status)} size={15} />
            <View style={s.fill}>
              <Text style={s.itemTitle} numberOfLines={1}>{subtask.title}</Text>
              <Text style={t.note} numberOfLines={2}>{repoName(subtask.repoProjectId)} · {summarizeChild(subtask.child)}</Text>
            </View>
            {teamId ? <Glyph name="forward" size={12} color={theme.colors.mutedInk} /> : null}
          </Pressable>
          {subtask.status === "blocked" && replacement && replacementTeamId ? <View style={s.jumpWrap}>
            <Button
              compact
              secondary
              glyph="forward"
              title="Jump to replacement"
              onPress={() => onOpenTeam(replacementTeamId)}
            />
          </View> : null}
        </View>;
      })}
    </Card> : snapshot ? <Text style={t.note}>No active subtasks in this snapshot.</Text> : null}

    {finished.length ? <Disclosure title={`Finished subtasks (${finished.length})`}>
      {finished.map(({ subtask, replacedBySubtaskId }) => {
        const teamId = linkedTeamIdOf(subtask.child);
        const replacement = replacedBySubtaskId ? subtaskById.get(replacedBySubtaskId) : undefined;
        const replacementTeamId = replacement ? linkedTeamIdOf(replacement.child) : undefined;
        return <View key={subtask.id} style={s.finishedRow}>
          <Pressable
            accessibilityRole="button"
            disabled={!teamId}
            onPress={() => { if (teamId) openPreview(teamId, subtask.title); }}
            style={({ pressed }) => [s.itemRowCompact, pressed && teamId && s.pressed]}
          >
            <StatusIcon kind={subtaskIconKind(subtask.status)} size={14} />
            <View style={s.fill}>
              <Text style={s.itemTitle} numberOfLines={1}>{subtask.title}</Text>
              <Text style={t.note} numberOfLines={2}>{repoName(subtask.repoProjectId)} · {summarizeChild(subtask.child)}</Text>
            </View>
            {teamId ? <Glyph name="forward" size={12} color={theme.colors.mutedInk} /> : null}
          </Pressable>
          {replacement && replacementTeamId ? <Button
            compact
            secondary
            glyph="forward"
            title="Jump to replacement"
            onPress={() => onOpenTeam(replacementTeamId)}
          /> : null}
        </View>;
      })}
    </Disclosure> : null}

    {state.observations.length ? <Disclosure title={`Progress observations (${state.observations.length})`}>
      {[...state.observations].reverse().map(obs => <View key={obs.cursor} style={s.obsRow}>
        <Text style={s.seq}>seq {obs.sequence}</Text>
        <Text style={[t.note, s.fill]}>
          {now ? age(obs.observedAt, now) : shortDate(obs.observedAt)} · {obs.snapshot.subtasks.filter(item => item.status === "done").length}/{obs.snapshot.subtasks.length} subtasks done
        </Text>
      </View>)}
    </Disclosure> : null}

    <Sheet
      visible={Boolean(previewTeam)}
      onClose={closePreview}
      title={previewTeam?.title ?? "Child team"}
    >
      <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetBody}>
        {previewLoading ? <ActivityIndicator style={s.loader} color={theme.colors.forest} /> : null}
        {previewError ? <Text style={t.error}>{previewError}</Text> : null}
        {!previewLoading && !previewError && !previewEntries.length ? <Text style={t.note}>No blackboard entries recorded for this child team yet.</Text> : null}
        {previewEntries.map(entry => <View key={entry.entryId} style={s.previewEntry}>
          <View style={s.rowHead}>
            <Text style={s.seq}>seq {entry.seq}</Text>
            <Chip label={authorityLabel(entry.authority)} />
            <Chip label={entry.kind} />
            <Text style={t.note}>{shortDate(entry.at)}</Text>
          </View>
          <Text style={t.note}>
            {entry.authorRole ? (ROLE_NAMES[entry.authorRole as keyof typeof ROLE_NAMES] ?? entry.authorRole) : entry.author}
          </Text>
          <Text style={t.body} numberOfLines={2}>{entry.summary}</Text>
        </View>)}
        {previewTeam ? <Button
          title="Open team"
          glyph="forward"
          onPress={() => {
            const target = previewTeam.teamId;
            closePreview();
            onOpenTeam(target);
          }}
        /> : null}
      </ScrollView>
    </Sheet>
  </Section>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  banner: { flexDirection: "row", alignItems: "center", gap: 10 },
  loader: { paddingVertical: 12 },
  coordinatorCard: { gap: 8 },
  rowHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  listCard: { padding: 0, gap: 0, overflow: "hidden" },
  itemWrap: { gap: 4 },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.rule },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  itemRowCompact: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  itemTitle: { fontSize: 14, fontWeight: "600", color: theme.colors.ink },
  jumpWrap: { paddingHorizontal: 14, paddingBottom: 10 },
  finishedRow: { gap: 6, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  obsRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  seq: { fontFamily: theme.mono, fontSize: 12, fontWeight: "700", color: theme.colors.secondaryInk },
  sheetScroll: { maxHeight: 420 },
  sheetBody: { gap: 10, paddingHorizontal: 8, paddingBottom: 12 },
  previewEntry: { gap: 4, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
});
