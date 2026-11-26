import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import {
  getTeamEntry, listTeamEntries, TEAM_ENTRY_KINDS, withdrawTeamEntry,
  type Connection, type Me, type TeamEntryDetail, type TeamEntryHead, type TeamEntryKind,
} from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { Card, Chip, Sheet } from "../../components/Glass";
import { theme } from "../../theme";
import { authorityLabel, filterMobileEntries, formatEntryBodySummary, mergeMobileEntries } from "./inspector-model";
import { ROLE_NAMES, shortDate, type TeamView } from "./model";
import { Disclosure, Section, t } from "./parts";

const PAGE_LIMIT = 100;
const MAX_AUTO_PAGES = 5;

const KIND_LABELS: Record<TeamEntryKind | "all", string> = {
  all: "All",
  check: "check",
  integration: "integration",
  report: "report",
  direction: "direction",
  contract: "contract",
  finding: "finding",
  blocker: "blocker",
  handoff: "handoff",
};

export function TeamEvidenceSection({
  connection,
  team,
  me,
  onOpenSession,
}: {
  connection: Connection;
  team: TeamView;
  me: Me | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [kindFilter, setKindFilter] = useState<TeamEntryKind | "all">("all");
  const [extraEntries, setExtraEntries] = useState<TeamEntryHead[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [extraCursor, setExtraCursor] = useState<{ cursor: number; more: boolean } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyIds, setHistoryIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<TeamEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);

  const poll = usePoll(async () => {
    let entries: TeamEntryHead[] = [];
    let since = 0;
    let cursor = 0;
    let more = false;
    for (let pageIndex = 0; pageIndex < MAX_AUTO_PAGES; pageIndex += 1) {
      const page = await listTeamEntries(connection, team.id, { since, limit: PAGE_LIMIT });
      entries = mergeMobileEntries(entries, page);
      cursor = page.cursor;
      more = page.more;
      if (!page.more || page.cursor <= since) break;
      since = page.cursor;
    }
    return { entries, cursor, more };
  }, 4000, [connection, team.id]);

  const polledEntries = poll.data?.entries ?? [];
  const mergedEntries = mergeMobileEntries(polledEntries, { entries: extraEntries });
  const visibleEntries = [...filterMobileEntries(mergedEntries, kindFilter)].reverse();
  const effectiveCursor = extraCursor?.cursor ?? poll.data?.cursor ?? 0;
  const hasMore = extraCursor ? extraCursor.more : Boolean(poll.data?.more);

  async function loadOlderOrNextPage() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const page = await listTeamEntries(connection, team.id, { since: effectiveCursor, limit: PAGE_LIMIT });
      setExtraEntries(prev => mergeMobileEntries(prev, page));
      setExtraCursor({ cursor: page.cursor, more: page.more });
    } catch (error) {
      Alert.alert("Could not load entries", error instanceof Error ? error.message : "Request failed.");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    getTeamEntry(connection, team.id, selectedId)
      .then(result => {
        if (active) setDetail(result);
      })
      .catch(error => {
        if (active) setDetailError(error instanceof Error ? error.message : "Could not load entry detail.");
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [connection, team.id, selectedId]);

  function selectEntry(entryId: string) {
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    setSelectedId(entryId);
  }

  function openEntry(entryId: string) {
    setHistoryIds([]);
    selectEntry(entryId);
  }

  function openSuperseded(entryId: string) {
    if (selectedId) setHistoryIds(prev => [...prev, selectedId]);
    selectEntry(entryId);
  }

  function stepBack() {
    const previous = historyIds[historyIds.length - 1];
    if (!previous) return;
    setHistoryIds(prev => prev.slice(0, -1));
    selectEntry(previous);
  }

  function closeSheet() {
    setSelectedId(null);
    setHistoryIds([]);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
  }

  function confirmWithdraw(head: TeamEntryHead) {
    Alert.alert("Withdraw this entry?", "Marks the entry as withdrawn on the host blackboard. It remains visible as withdrawn.", [
      { text: "Keep entry", style: "cancel" },
      {
        text: "Withdraw",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setWithdrawing(true);
            try {
              const result = await withdrawTeamEntry(connection, team.id, head.entryId, Crypto.randomUUID());
              const updatedHead: TeamEntryHead = { ...head, state: result.state };
              setExtraEntries(prev => mergeMobileEntries(prev, { entries: [updatedHead] }));
              setDetail(prev => (prev && prev.head.entryId === head.entryId ? { ...prev, head: updatedHead } : prev));
              poll.refresh();
            } catch (error) {
              Alert.alert("Withdraw failed", error instanceof Error ? error.message : "Could not withdraw entry.");
            } finally {
              setWithdrawing(false);
            }
          })();
        },
      },
    ]);
  }

  const detailHead = detail?.head ?? mergedEntries.find(item => item.entryId === selectedId);
  const formatted = detail ? formatEntryBodySummary(detail.body) : null;
  const authorMember = detailHead?.authorMemberId
    ? team.members.find(member => member.memberId === detailHead.authorMemberId)
    : undefined;

  return <Section
    title="Evidence"
    count={mergedEntries.length}
    right={<Pressable accessibilityRole="button" onPress={poll.refresh} hitSlop={8}><Text style={s.refresh}>Refresh</Text></Pressable>}
  >
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filters}>
      {(["all", ...TEAM_ENTRY_KINDS] as const).map(kind => <Chip
        key={kind}
        label={KIND_LABELS[kind]}
        selected={kindFilter === kind}
        onPress={() => setKindFilter(kind)}
      />)}
    </ScrollView>

    {poll.loading && !mergedEntries.length ? <ActivityIndicator style={s.loader} color={theme.colors.forest} /> : null}
    {!poll.loading && poll.stale && !mergedEntries.length ? <Text style={t.warning}>Could not load blackboard entries.</Text> : null}
    {!poll.loading && !poll.stale && !visibleEntries.length ? <Text style={t.note}>No matching entries yet.</Text> : null}

    {visibleEntries.length ? <Card style={s.listCard}>
      {visibleEntries.map((entry, index) => {
        const author = entry.authorRole
          ? (entry.authorRole === "mission-coordinator" ? "Mission coordinator" : ROLE_NAMES[entry.authorRole] ?? entry.authorRole)
          : entry.author;
        return <Pressable
          key={entry.entryId}
          accessibilityRole="button"
          accessibilityLabel={`Sequence ${entry.seq}, ${authorityLabel(entry.authority)}, ${entry.kind}: ${entry.summary}`}
          onPress={() => openEntry(entry.entryId)}
          style={({ pressed }) => [s.entryRow, index > 0 && s.rowRule, pressed && s.pressed]}
        >
          <View style={s.entryMeta}>
            <Text style={s.seq}>seq {entry.seq}</Text>
            <Text style={t.note}>{shortDate(entry.at)}</Text>
            <Text style={t.note}>{author}</Text>
            {entry.headCommit ? <Text style={s.commit}>{entry.headCommit.slice(0, 8)}</Text> : null}
          </View>
          <View style={s.entryTags}>
            <Chip label={authorityLabel(entry.authority)} tone={entry.authority === "direction" ? "attention" : undefined} />
            <Chip label={entry.kind} />
            {entry.state !== "active" ? <Chip label={entry.state} tone={entry.state === "withdrawn" ? "error" : "attention"} /> : null}
          </View>
          <Text style={[t.body, entry.state === "withdrawn" && s.withdrawnText]} numberOfLines={3}>{entry.summary}</Text>
        </Pressable>;
      })}
    </Card> : null}

    {hasMore ? <Button
      compact
      secondary
      title={loadingMore ? "Loading…" : "Load older"}
      disabled={loadingMore}
      onPress={() => void loadOlderOrNextPage()}
    /> : null}

    <Sheet
      visible={Boolean(selectedId)}
      onClose={closeSheet}
      title={detailHead ? `seq ${detailHead.seq} · ${detailHead.kind}` : "Entry detail"}
    >
      <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetBody}>
        {detailHead ? <View style={s.entryTags}>
          <Chip label={authorityLabel(detailHead.authority)} tone={detailHead.authority === "direction" ? "attention" : undefined} />
          <Chip label={`rev ${detailHead.revision}`} />
          {detailHead.state !== "active" ? <Chip label={detailHead.state} tone={detailHead.state === "withdrawn" ? "error" : "attention"} /> : null}
        </View> : null}
        {detailHead ? <Text style={t.note}>
          {shortDate(detailHead.at)} · {detailHead.authorRole ?? detailHead.author}{detailHead.taskId ? ` · task ${detailHead.taskId}` : ""}
        </Text> : null}

        {detailLoading ? <ActivityIndicator style={s.loader} color={theme.colors.forest} /> : null}
        {detailError ? <Text style={t.error}>{detailError}</Text> : null}

        {formatted ? <View style={s.detailSections}>
          {formatted.summary ? <View style={s.field}><Text style={t.label}>Summary</Text><Text selectable style={t.body}>{formatted.summary}</Text></View> : null}
          {formatted.verdict ? <View style={s.field}><Text style={t.label}>Verdict</Text><Text style={t.strong}>{formatted.verdict}</Text></View> : null}
          {formatted.headCommit ? <View style={s.field}><Text style={t.label}>Head commit</Text><Text selectable style={t.mono}>{formatted.headCommit}</Text></View> : null}
          {formatted.commit ? <View style={s.field}><Text style={t.label}>Commit</Text><Text selectable style={t.mono}>{formatted.commit}</Text></View> : null}
          {formatted.exitCode !== undefined ? <View style={s.field}><Text style={t.label}>Exit code</Text><Text style={t.mono}>{String(formatted.exitCode)}</Text></View> : null}
          {formatted.round !== undefined ? <View style={s.field}><Text style={t.label}>Round</Text><Text style={t.mono}>{String(formatted.round)}</Text></View> : null}
          {formatted.question ? <View style={s.field}><Text style={t.label}>Question</Text><Text selectable style={t.body}>{formatted.question}</Text></View> : null}
          {formatted.answer ? <View style={s.field}><Text style={t.label}>Answer</Text><Text selectable style={t.body}>{formatted.answer}</Text></View> : null}
          {formatted.uiEvidence ? <View style={s.field}><Text style={t.label}>Interface evidence</Text><Text selectable style={t.body}>{formatted.uiEvidence}</Text></View> : null}
          {formatted.acceptance?.length ? <View style={s.field}>
            <Text style={t.label}>Reviewer acceptance claims</Text>
            {formatted.acceptance.map(item => <Text key={item.criterion} selectable style={t.note}>
              #{item.criterion} ({item.verdict}): {item.evidence}
            </Text>)}
          </View> : null}
          {formatted.changedPaths ? <View style={s.field}>
            <Text style={t.label}>Changed paths{formatted.changedPaths.truncated ? " (truncated)" : ""}</Text>
            {formatted.changedPaths.paths.map(path => <Text key={path} selectable style={t.mono}>{path}</Text>)}
          </View> : null}
          {formatted.facts.map(fact => <View key={fact.label} style={s.field}>
            <Text style={t.label}>{fact.label}</Text>
            <Text selectable style={t.body}>{fact.value}</Text>
          </View>)}
          {formatted.output !== undefined ? <View style={s.field}>
            <Text style={t.label}>Output</Text>
            <ScrollView horizontal style={s.outputBox} contentContainerStyle={s.outputContent}>
              <Text selectable style={s.outputText}>{formatted.output ? formatted.output.slice(-4000) : "No output recorded."}</Text>
            </ScrollView>
          </View> : null}
          <Disclosure title="Raw entry JSON">
            <ScrollView horizontal style={s.outputBox} contentContainerStyle={s.outputContent}>
              <Text selectable style={s.outputText}>{formatted.rawJson}</Text>
            </ScrollView>
          </Disclosure>
        </View> : null}

        <View style={s.sheetActions}>
          {historyIds.length ? <Button compact secondary glyph="back" title="Previous entry" onPress={stepBack} /> : null}
          {detailHead?.supersedes ? <Button
            compact
            secondary
            glyph="forward"
            title="View superseded entry"
            onPress={() => openSuperseded(detailHead.supersedes!)}
          /> : null}
          {authorMember ? <Button
            compact
            secondary
            glyph="terminal"
            title="Open session"
            onPress={() => {
              closeSheet();
              onOpenSession(authorMember.sessionId);
            }}
          /> : null}
          {me?.role === "owner" && detailHead && detailHead.state !== "withdrawn" ? <Button
            compact
            destructive
            title={withdrawing ? "Withdrawing…" : "Withdraw entry"}
            disabled={withdrawing}
            onPress={() => confirmWithdraw(detailHead)}
          /> : null}
        </View>
      </ScrollView>
    </Sheet>
  </Section>;
}

const s = StyleSheet.create({
  refresh: { fontSize: 13, fontWeight: "600", color: theme.colors.forest },
  filters: { flexDirection: "row", gap: 6, paddingVertical: 2 },
  loader: { paddingVertical: 14 },
  listCard: { padding: 0, gap: 0, overflow: "hidden" },
  entryRow: { gap: 6, paddingHorizontal: 14, paddingVertical: 12 },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.rule },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  entryMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  seq: { fontFamily: theme.mono, fontSize: 12, fontWeight: "700", color: theme.colors.secondaryInk },
  commit: { fontFamily: theme.mono, fontSize: 11, color: theme.colors.mutedInk },
  entryTags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  withdrawnText: { color: theme.colors.mutedInk },
  sheetScroll: { maxHeight: 460 },
  sheetBody: { gap: 10, paddingHorizontal: 8, paddingBottom: 12 },
  detailSections: { gap: 8 },
  field: { gap: 2 },
  outputBox: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.terminalSurface, maxHeight: 200 },
  outputContent: { padding: 10 },
  outputText: { fontFamily: theme.mono, fontSize: 11, lineHeight: 16, color: theme.colors.terminalInk },
  sheetActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 6 },
});
