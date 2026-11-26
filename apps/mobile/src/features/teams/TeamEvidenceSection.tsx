import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  connectionKey, getTeamEntry, listTeamEntries, TEAM_ENTRY_KINDS,
  type Connection, type TeamEntryDetail, type TeamEntryHead, type TeamEntryKind,
} from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { Card, Chip, Sheet } from "../../components/Glass";
import { theme } from "../../theme";
import { authorityLabel, entryAuthorLabel, filterMobileEntries, formatEntryBodySummary, mergeMobileEntries } from "./inspector-model";
import { shortDate, type TeamView } from "./model";
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

type ExtraState = {
  key: string;
  entries: TeamEntryHead[];
  cursor: number;
  more: boolean;
};

type SheetState = {
  key: string;
  selectedId: string | null;
  historyIds: string[];
  detail: TeamEntryDetail | null;
  loading: boolean;
  error: string;
};

export function TeamEvidenceSection({
  connection,
  team,
  onOpenSession,
}: {
  connection: Connection;
  team: TeamView;
  onOpenSession: (sessionId: string) => void;
}) {
  const scopeKey = `${connectionKey(connection)}/${team.id}`;
  const [kindFilter, setKindFilter] = useState<TeamEntryKind | "all">("all");
  const [extraState, setExtraState] = useState<ExtraState>({ key: scopeKey, entries: [], cursor: 0, more: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [sheetState, setSheetState] = useState<SheetState>({
    key: scopeKey,
    selectedId: null,
    historyIds: [],
    detail: null,
    loading: false,
    error: "",
  });

  const epochRef = useRef(0);
  const highWaterRef = useRef<{ key: string; cursor: number }>({ key: scopeKey, cursor: 0 });

  useEffect(() => {
    epochRef.current += 1;
    highWaterRef.current = { key: scopeKey, cursor: 0 };
    return () => {
      epochRef.current += 1;
    };
  }, [scopeKey]);

  const poll = usePoll(async () => {
    const epoch = epochRef.current;
    const targetTeamId = team.id;
    let entries: TeamEntryHead[] = [];
    let since = 0;
    let cursor = 0;
    let more = false;
    for (let pageIndex = 0; pageIndex < MAX_AUTO_PAGES; pageIndex += 1) {
      const page = await listTeamEntries(connection, targetTeamId, { since, limit: PAGE_LIMIT });
      if (epoch !== epochRef.current) return null;
      entries = mergeMobileEntries(entries, page);
      cursor = page.cursor;
      more = page.more;
      if (!page.more || page.cursor <= since) break;
      since = page.cursor;
    }
    const tail = highWaterRef.current.key === scopeKey ? highWaterRef.current.cursor : 0;
    if (more && tail > cursor) {
      const tailPage = await listTeamEntries(connection, targetTeamId, { since: tail, limit: PAGE_LIMIT });
      if (epoch !== epochRef.current) return null;
      entries = mergeMobileEntries(entries, tailPage);
      cursor = Math.max(cursor, tailPage.cursor);
      more = tailPage.more;
    }
    if (highWaterRef.current.key === scopeKey) {
      highWaterRef.current.cursor = Math.max(highWaterRef.current.cursor, cursor);
    }
    return { key: scopeKey, entries, cursor, more };
  }, 4000, [connection, team.id, scopeKey]);

  const scopedPoll = poll.data?.key === scopeKey ? poll.data : null;
  const scopedExtra = extraState.key === scopeKey ? extraState : null;
  const scopedSheet = sheetState.key === scopeKey
    ? sheetState
    : { key: scopeKey, selectedId: null, historyIds: [], detail: null, loading: false, error: "" };

  const polledEntries = scopedPoll?.entries ?? [];
  const mergedEntries = mergeMobileEntries(polledEntries, { entries: scopedExtra?.entries ?? [] });
  const visibleEntries = [...filterMobileEntries(mergedEntries, kindFilter)].reverse();
  const pollCursor = scopedPoll?.cursor ?? 0;
  const extraCursor = scopedExtra?.cursor ?? 0;
  const effectiveCursor = Math.max(pollCursor, extraCursor);
  const hasMore = extraCursor > pollCursor
    ? Boolean(scopedExtra?.more)
    : Boolean(scopedPoll?.more || (scopedExtra && scopedExtra.cursor === pollCursor && scopedExtra.more));

  async function loadNewerEntries() {
    if (loadingMore || !hasMore) return;
    const epoch = epochRef.current;
    const targetKey = scopeKey;
    const targetTeamId = team.id;
    setLoadingMore(true);
    try {
      const page = await listTeamEntries(connection, targetTeamId, { since: effectiveCursor, limit: PAGE_LIMIT });
      if (epoch !== epochRef.current) return;
      if (highWaterRef.current.key === targetKey) {
        highWaterRef.current.cursor = Math.max(highWaterRef.current.cursor, page.cursor);
      }
      setExtraState(prev => ({
        key: targetKey,
        entries: mergeMobileEntries(prev.key === targetKey ? prev.entries : [], page),
        cursor: Math.max(prev.key === targetKey ? prev.cursor : 0, page.cursor),
        more: page.more,
      }));
    } catch (error) {
      if (epoch === epochRef.current) {
        Alert.alert("Could not load entries", error instanceof Error ? error.message : "Request failed.");
      }
    } finally {
      if (epoch === epochRef.current) setLoadingMore(false);
    }
  }

  useEffect(() => {
    const selectedId = scopedSheet.selectedId;
    if (!selectedId) return;
    const epoch = epochRef.current;
    const targetKey = scopeKey;
    const targetTeamId = team.id;
    let active = true;
    getTeamEntry(connection, targetTeamId, selectedId)
      .then(result => {
        if (active && epoch === epochRef.current) {
          setSheetState(prev => (prev.key === targetKey && prev.selectedId === selectedId
            ? { ...prev, detail: result, loading: false }
            : prev));
        }
      })
      .catch(error => {
        if (active && epoch === epochRef.current) {
          setSheetState(prev => (prev.key === targetKey && prev.selectedId === selectedId
            ? { ...prev, error: error instanceof Error ? error.message : "Could not load entry detail.", loading: false }
            : prev));
        }
      });
    return () => { active = false; };
  }, [connection, team.id, scopeKey, scopedSheet.selectedId]);

  function openEntry(entryId: string) {
    setSheetState({
      key: scopeKey,
      selectedId: entryId,
      historyIds: [],
      detail: null,
      loading: true,
      error: "",
    });
  }

  function openSuperseded(entryId: string) {
    setSheetState(prev => ({
      key: scopeKey,
      selectedId: entryId,
      historyIds: prev.key === scopeKey && prev.selectedId ? [...prev.historyIds, prev.selectedId] : [],
      detail: null,
      loading: true,
      error: "",
    }));
  }

  function stepBack() {
    setSheetState(prev => {
      if (prev.key !== scopeKey || !prev.historyIds.length) return prev;
      const previous = prev.historyIds[prev.historyIds.length - 1]!;
      return {
        key: scopeKey,
        selectedId: previous,
        historyIds: prev.historyIds.slice(0, -1),
        detail: null,
        loading: true,
        error: "",
      };
    });
  }

  function closeSheet() {
    setSheetState({
      key: scopeKey,
      selectedId: null,
      historyIds: [],
      detail: null,
      loading: false,
      error: "",
    });
  }

  const detailHead = scopedSheet.detail?.head ?? mergedEntries.find(item => item.entryId === scopedSheet.selectedId);
  const formatted = scopedSheet.detail ? formatEntryBodySummary(scopedSheet.detail.body) : null;
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

    {hasMore ? <Button
      compact
      secondary
      title={loadingMore ? "Loading…" : "Load newer"}
      disabled={loadingMore}
      onPress={() => void loadNewerEntries()}
    /> : null}

    {poll.loading && !mergedEntries.length ? <ActivityIndicator style={s.loader} color={theme.colors.forest} /> : null}
    {!poll.loading && poll.stale && !mergedEntries.length ? <Text style={t.warning}>Could not load blackboard entries.</Text> : null}
    {!poll.loading && !poll.stale && !visibleEntries.length ? <Text style={t.note}>No matching entries yet.</Text> : null}

    {visibleEntries.length ? <Card style={s.listCard}>
      {visibleEntries.map((entry, index) => {
        const author = entryAuthorLabel(entry.author, entry.authorRole);
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

    <Sheet
      visible={Boolean(scopedSheet.selectedId)}
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
          {shortDate(detailHead.at)} · {entryAuthorLabel(detailHead.author, detailHead.authorRole)}{detailHead.taskId ? ` · task ${detailHead.taskId}` : ""}
        </Text> : null}

        {scopedSheet.loading ? <ActivityIndicator style={s.loader} color={theme.colors.forest} /> : null}
        {scopedSheet.error ? <Text style={t.error}>{scopedSheet.error}</Text> : null}

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
          {scopedSheet.historyIds.length ? <Button compact secondary glyph="back" title="Previous entry" onPress={stepBack} /> : null}
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
  sheetScroll: { flexShrink: 1 },
  sheetBody: { gap: 10, paddingHorizontal: 8, paddingBottom: 12 },
  detailSections: { gap: 8 },
  field: { gap: 2 },
  outputBox: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.terminalSurface },
  outputContent: { padding: 10 },
  outputText: { fontFamily: theme.mono, fontSize: 11, lineHeight: 16, color: theme.colors.terminalInk },
  sheetActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 6 },
});
