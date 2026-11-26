import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import {
  connectionKey, getTeamEntry, listTeamEntries, TEAM_ENTRY_KINDS,
  type Connection, type TeamEntryDetail, type TeamEntryKind,
} from "../../api/client";
import { inForeground, onForegroundChange } from "../../api/foreground";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { Card, Chip, Sheet } from "../../components/Glass";
import { theme } from "../../theme";
import {
  applyMobileEvidenceHead, applyMobileEvidencePage, authorityLabel, createMobileEvidenceFeedState,
  entryAuthorLabel, filterMobileEntries, formatEntryBodySummary, resolveSelectedEntryHead,
  type MobileEvidenceFeedState,
} from "./inspector-model";
import { shortDate, type TeamView } from "./model";
import { Disclosure, Section, t } from "./parts";

const PAGE_LIMIT = 100;
const MAX_INCREMENTAL_PAGES = 5;
const MAX_REVALIDATE_PAGES = 5;
const REVALIDATE_INTERVAL_MS = 30_000;

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

type SheetState = {
  key: string;
  selectedId: string | null;
  historyIds: string[];
  detail: TeamEntryDetail | null;
  loading: boolean;
  error: string;
};

type ScopedError = {
  key: string;
  message: string;
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
  const [feedState, setFeedState] = useState<MobileEvidenceFeedState>(() => createMobileEvidenceFeedState(scopeKey));
  const [loadingMore, setLoadingMore] = useState(false);
  const [pollError, setPollError] = useState<ScopedError | null>(null);
  const [sheetState, setSheetState] = useState<SheetState>({
    key: scopeKey,
    selectedId: null,
    historyIds: [],
    detail: null,
    loading: false,
    error: "",
  });

  const epochRef = useRef(0);
  const feedRef = useRef<MobileEvidenceFeedState>(feedState);
  const manualRefreshRef = useRef(false);
  const focused = useIsFocused();
  const focusedRef = useRef(focused);

  const commitFeed = useCallback((targetKey: string, updater: (prev: MobileEvidenceFeedState) => MobileEvidenceFeedState) => {
    const base = feedRef.current.key === targetKey ? feedRef.current : createMobileEvidenceFeedState(targetKey);
    const updated = updater(base);
    feedRef.current = updated;
    setFeedState(updated);
  }, []);

  useEffect(() => {
    epochRef.current += 1;
    feedRef.current = createMobileEvidenceFeedState(scopeKey);
    manualRefreshRef.current = false;
    return () => {
      epochRef.current += 1;
    };
  }, [scopeKey]);

  useEffect(() => {
    focusedRef.current = focused;
    epochRef.current += 1;
    const removeForeground = onForegroundChange(() => {
      epochRef.current += 1;
    });
    return () => {
      focusedRef.current = false;
      epochRef.current += 1;
      removeForeground();
    };
  }, [focused]);

  const poll = usePoll(async () => {
    const epoch = epochRef.current;
    const targetKey = scopeKey;
    const targetTeamId = team.id;
    const isCurrent = () => epoch === epochRef.current && focusedRef.current && inForeground();
    if (!isCurrent()) return null;

    const current = feedRef.current.key === targetKey
      ? feedRef.current
      : createMobileEvidenceFeedState(targetKey);
    const nowMs = Date.now();
    const forceRevalidate = manualRefreshRef.current;
    manualRefreshRef.current = false;
    const needsRevalidate = current.entries.length > 0 && (
      forceRevalidate
      || current.revalidateCursor > 0
      || (current.lastRevalidatedAtMs !== undefined && nowMs - current.lastRevalidatedAtMs >= REVALIDATE_INTERVAL_MS)
    );

    try {
      let since = current.cursor;
      let fetchedAny = false;
      for (let pageIndex = 0; pageIndex < MAX_INCREMENTAL_PAGES; pageIndex += 1) {
        const page = await listTeamEntries(connection, targetTeamId, { since, limit: PAGE_LIMIT });
        if (!isCurrent()) return null;
        fetchedAny = true;
        const observedAt = new Date().toISOString();
        commitFeed(targetKey, prev => {
          const applied = applyMobileEvidencePage(prev, page, { mode: "incremental", observedAt });
          return applied.lastRevalidatedAtMs === undefined && applied.entries.length > 0
            ? { ...applied, lastRevalidatedAtMs: nowMs }
            : applied;
        });
        if (!page.more || page.cursor <= since) break;
        since = page.cursor;
      }

      if (needsRevalidate) {
        let revalidateSince = forceRevalidate ? 0 : (feedRef.current.key === targetKey ? feedRef.current.revalidateCursor : 0);
        const upperBound = feedRef.current.key === targetKey ? feedRef.current.cursor : 0;
        let completedSweep = true;
        for (let pageIndex = 0; pageIndex < MAX_REVALIDATE_PAGES; pageIndex += 1) {
          const page = await listTeamEntries(connection, targetTeamId, { since: revalidateSince, limit: PAGE_LIMIT });
          if (!isCurrent()) return null;
          const observedAt = new Date().toISOString();
          commitFeed(targetKey, prev => applyMobileEvidencePage(prev, page, { mode: "revalidate", observedAt }));
          if (!page.more || page.cursor <= revalidateSince || page.cursor >= upperBound) {
            revalidateSince = 0;
            completedSweep = true;
            break;
          }
          revalidateSince = page.cursor;
          completedSweep = false;
        }
        if (isCurrent()) {
          commitFeed(targetKey, prev => ({
            ...prev,
            revalidateCursor: revalidateSince,
            ...(completedSweep ? { lastRevalidatedAtMs: Date.now() } : {}),
          }));
        }
      }

      if (!isCurrent()) return null;
      setPollError(prev => (prev?.key === targetKey ? null : prev));
      return fetchedAny ? { key: targetKey, at: Date.now() } : null;
    } catch (error) {
      if (isCurrent()) {
        setPollError({ key: targetKey, message: error instanceof Error ? error.message : "Could not load blackboard entries." });
      }
      throw error;
    }
  }, 4000, [connection, team.id, scopeKey]);

  const scopedFeed = feedState.key === scopeKey ? feedState : createMobileEvidenceFeedState(scopeKey);
  const scopedSheet = sheetState.key === scopeKey
    ? sheetState
    : { key: scopeKey, selectedId: null, historyIds: [], detail: null, loading: false, error: "" };

  const mergedEntries = scopedFeed.entries;
  const visibleEntries = [...filterMobileEntries(mergedEntries, kindFilter)].reverse();
  const hasMore = scopedFeed.more;
  const activePollError = pollError?.key === scopeKey ? pollError.message : "";
  const isStale = poll.stale || Boolean(activePollError);

  async function loadNewerEntries() {
    if (loadingMore || !hasMore) return;
    const epoch = epochRef.current;
    const targetKey = scopeKey;
    const targetTeamId = team.id;
    const isCurrent = () => epoch === epochRef.current && focusedRef.current && inForeground();
    const startCursor = feedRef.current.key === targetKey ? feedRef.current.cursor : scopedFeed.cursor;
    setLoadingMore(true);
    try {
      const page = await listTeamEntries(connection, targetTeamId, { since: startCursor, limit: PAGE_LIMIT });
      if (!isCurrent()) return;
      commitFeed(targetKey, prev => applyMobileEvidencePage(prev, page, { mode: "incremental", observedAt: new Date().toISOString() }));
      setPollError(prev => (prev?.key === targetKey ? null : prev));
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
    const targetKey = scopeKey;
    const targetTeamId = team.id;
    let active = true;
    getTeamEntry(connection, targetTeamId, selectedId)
      .then(result => {
        if (!active) return;
        commitFeed(targetKey, prev => applyMobileEvidenceHead(prev, result.head));
        setSheetState(prev => (prev.key === targetKey && prev.selectedId === selectedId
          ? { ...prev, detail: result, loading: false }
          : prev));
      })
      .catch(error => {
        if (!active) return;
        setSheetState(prev => (prev.key === targetKey && prev.selectedId === selectedId
          ? { ...prev, error: error instanceof Error ? error.message : "Could not load entry detail.", loading: false }
          : prev));
      });
    return () => { active = false; };
  }, [commitFeed, connection, team.id, scopeKey, scopedSheet.selectedId]);

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

  const listHead = scopedSheet.selectedId
    ? mergedEntries.find(item => item.entryId === scopedSheet.selectedId)
    : undefined;
  const detailHead = resolveSelectedEntryHead(scopedSheet.detail?.head, listHead);
  const formatted = scopedSheet.detail ? formatEntryBodySummary(scopedSheet.detail.body) : null;
  const authorMember = detailHead?.authorMemberId
    ? team.members.find(member => member.memberId === detailHead.authorMemberId)
    : undefined;

  return <Section
    title="Evidence"
    count={mergedEntries.length}
    right={<Pressable accessibilityRole="button" onPress={() => { manualRefreshRef.current = true; poll.refresh(); }} hitSlop={8}><Text style={s.refresh}>Refresh</Text></Pressable>}
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

    {isStale && mergedEntries.length > 0 ? <Card attention style={s.staleBanner}>
      <Text style={t.warning}>
        Evidence may be stale{scopedFeed.lastLoadedAt ? ` · last updated ${shortDate(scopedFeed.lastLoadedAt)}` : ""}.{activePollError ? ` ${activePollError}` : ""}
      </Text>
    </Card> : null}

    {poll.loading && !mergedEntries.length ? <ActivityIndicator style={s.loader} color={theme.colors.forest} /> : null}
    {!poll.loading && isStale && !mergedEntries.length ? <Text style={t.warning}>
      Could not load blackboard entries.{activePollError ? ` ${activePollError}` : ""}
    </Text> : null}
    {!poll.loading && !isStale && !visibleEntries.length ? <Text style={t.note}>No matching entries yet.</Text> : null}

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
          <Text style={[t.body, entry.state !== "active" && s.inactiveText]} numberOfLines={3}>{entry.summary}</Text>
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
  staleBanner: { gap: 6 },
  inactiveText: { color: theme.colors.mutedInk },
  sheetScroll: { flexShrink: 1 },
  sheetBody: { gap: 10, paddingHorizontal: 8, paddingBottom: 12 },
  detailSections: { gap: 8 },
  field: { gap: 2 },
  outputBox: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.terminalSurface },
  outputContent: { padding: 10 },
  outputText: { fontFamily: theme.mono, fontSize: 11, lineHeight: 16, color: theme.colors.terminalInk },
  sheetActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 6 },
});
