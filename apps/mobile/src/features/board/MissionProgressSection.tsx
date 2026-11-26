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
import { authorityLabel, entryAuthorLabel, mergeMobileEntries } from "../teams/inspector-model";
import { shortDate, TEAM_LABELS } from "../teams/model";
import { Disclosure, Section, t } from "../teams/parts";
import {
  applyMissionProgressPage, createMissionProgressState, dismissMissionProgressNotice, linkedTeamIdOf, partitionMissionSubtasks,
  type MissionProgressState,
} from "./mission-progress-model";

const PREVIEW_PAGE_LIMIT = 100;
const MAX_PREVIEW_PAGES = 10;

type Action =
  | { type: "page"; page: MissionProgressPage }
  | { type: "dismissNotice" };

function reducer(state: MissionProgressState, action: Action): MissionProgressState {
  switch (action.type) {
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

type PreviewState = {
  missionId: string;
  teamId: string;
  title: string;
};

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
  const [rawState, dispatch] = useReducer(reducer, missionId, createMissionProgressState);
  const state = rawState.missionId === missionId ? rawState : createMissionProgressState(missionId);
  const cursorRef = useRef<string | undefined>(undefined);
  const pollGenRef = useRef(0);
  const activeMissionIdRef = useRef(missionId);

  const [previewTeam, setPreviewTeam] = useState<PreviewState | null>(null);
  const [previewEntries, setPreviewEntries] = useState<TeamEntryHead[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    pollGenRef.current += 1;
    activeMissionIdRef.current = missionId;
    cursorRef.current = undefined;
    return () => {
      pollGenRef.current += 1;
    };
  }, [connection, missionId]);

  const poll = usePoll(async () => {
    const gen = pollGenRef.current;
    const targetMissionId = missionId;
    const page = await getMissionProgress(connection, targetMissionId, cursorRef.current);
    if (gen !== pollGenRef.current || activeMissionIdRef.current !== targetMissionId || page.missionId !== targetMissionId) {
      return null;
    }
    cursorRef.current = page.cursor;
    dispatch({ type: "page", page });
    return { missionId: targetMissionId, page, at: Date.now() };
  }, 3000, [connection, missionId]);

  const activePreview = previewTeam?.missionId === missionId ? previewTeam : null;

  function openPreview(teamId: string, title: string) {
    setPreviewEntries([]);
    setPreviewError("");
    setPreviewLoading(true);
    setPreviewTeam({ missionId, teamId, title });
  }

  function closePreview() {
    setPreviewTeam(null);
    setPreviewEntries([]);
    setPreviewError("");
    setPreviewLoading(false);
  }

  useEffect(() => {
    if (!activePreview) return;
    const gen = pollGenRef.current;
    const targetTeamId = activePreview.teamId;
    let active = true;
    void (async () => {
      try {
        let accumulated: TeamEntryHead[] = [];
        let since = 0;
        for (let pageIndex = 0; pageIndex < MAX_PREVIEW_PAGES; pageIndex += 1) {
          const page = await listTeamEntries(connection, targetTeamId, { since, limit: PREVIEW_PAGE_LIMIT });
          if (!active || gen !== pollGenRef.current) return;
          accumulated = mergeMobileEntries(accumulated, page);
          if (!page.more || page.cursor <= since) break;
          since = page.cursor;
        }
        if (active && gen === pollGenRef.current) {
          setPreviewEntries(accumulated.slice(-10).reverse());
        }
      } catch (error) {
        if (active && gen === pollGenRef.current) {
          setPreviewError(error instanceof Error ? error.message : "Could not load team entries.");
        }
      } finally {
        if (active && gen === pollGenRef.current) {
          setPreviewLoading(false);
        }
      }
    })();
    return () => { active = false; };
  }, [connection, activePreview]);

  const snapshot = state.snapshot;
  const now = poll.data?.missionId === missionId ? poll.data.at : 0;
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
            accessibilityState={{ disabled: !teamId }}
            disabled={!teamId}
            accessibilityLabel={`${subtask.title}, ${repoName(subtask.repoProjectId)}, ${summarizeChild(subtask.child)}`}
            onPress={() => { if (teamId) openPreview(teamId, subtask.title); }}
            style={({ pressed }) => [s.itemRow, pressed && Boolean(teamId) && s.pressed]}
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
            accessibilityState={{ disabled: !teamId }}
            accessibilityLabel={`${subtask.title}, ${repoName(subtask.repoProjectId)}, ${summarizeChild(subtask.child)}`}
            disabled={!teamId}
            onPress={() => { if (teamId) openPreview(teamId, subtask.title); }}
            style={({ pressed }) => [s.itemRowCompact, pressed && Boolean(teamId) && s.pressed]}
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
      visible={Boolean(activePreview)}
      onClose={closePreview}
      title={activePreview?.title ?? "Child team"}
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
          <Text style={t.note}>{entryAuthorLabel(entry.author, entry.authorRole)}</Text>
          <Text style={t.body} numberOfLines={2}>{entry.summary}</Text>
        </View>)}
        {activePreview ? <Button
          title="Open team"
          glyph="forward"
          onPress={() => {
            const target = activePreview.teamId;
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
  sheetScroll: { flexShrink: 1 },
  sheetBody: { gap: 10, paddingHorizontal: 8, paddingBottom: 12 },
  previewEntry: { gap: 4, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
});
