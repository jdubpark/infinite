import { useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useRouter } from "expo-router";
import type { WorkBlock, WorkBrief, WorkNarrativeStatus, WorkSection } from "@infinite/remote";
import type { Connection } from "../../api/client";
import { Button } from "../../components/Button";
import { Chip, LiveStatus, TopBar } from "../../components/Glass";
import { theme } from "../../theme";
import { BlockView } from "./blocks";
import { useWorkBrief, type RefreshState } from "./useWorkBrief";

/** One work brief as a sectioned phone screen: a section rail, a narrative status line, and section cards. */
export function WorkBriefScreen({ connection, workspaceId, workId, machine }: { connection: Connection; workspaceId: string; workId: string; machine?: string }) {
  const router = useRouter();
  const { poll, result, brief, canRefresh, refreshState, refreshNarrative, requestRefresh } = useWorkBrief(connection, workspaceId, workId);
  const body = useRef<ScrollView>(null);
  const offsets = useRef<Record<string, number>>({});
  const [selected, setSelected] = useState("");
  const sections = brief?.sections ?? [];
  const active = sections.some(section => section.id === selected) ? selected : sections[0]?.id ?? "";

  const back = () => router.canGoBack()
    ? router.back()
    : router.replace({ pathname: "/understanding/[id]", params: { id: workspaceId, ...(machine ? { machine } : {}) } });
  const openSystem = (componentId: string) => router.push({ pathname: "/understanding/[id]", params: { id: workspaceId, view: "system", component: componentId, ...(machine ? { machine } : {}) } });
  const openWork = (id: string) => router.push({ pathname: "/understanding/work", params: { workspace: workspaceId, work: id, ...(machine ? { machine } : {}) } });
  const openSource = () => {
    if (!brief) return;
    const id = workId.slice(workId.indexOf(":") + 1);
    router.push({ pathname: sourceRoute(brief.kind), params: { id, ...(machine ? { machine } : {}) } });
  };

  const jump = (id: string) => {
    setSelected(id);
    body.current?.scrollTo({ y: offsets.current[id] ?? 0, animated: true });
  };
  // The selected chip is the last section whose top has reached the upper part of the viewport.
  const track = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y + 24;
    let current = "";
    for (const section of sections) if ((offsets.current[section.id] ?? 0) <= y) current = section.id;
    if (current) setSelected(current);
  };

  const refreshing = poll.refreshing;
  const title = brief?.title ?? "Work";
  const unavailable = result && result.state !== "ready" ? result : null;

  return <View style={s.fill}>
    <TopBar backLabel="workspace" onBack={back} title={title}
      right={<LiveStatus online={poll.online && brief !== null} loading={poll.loading} seen={poll.seen} stale={poll.stale} />} />
    {sections.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.rail} contentContainerStyle={s.railContent}>
      {sections.map(section => <Chip key={section.id} label={railLabel(section)} accessibilityLabel={section.title}
        selected={active === section.id} onPress={() => jump(section.id)} />)}
    </ScrollView> : null}
    {brief ? <View style={s.sourceRow}>
      <Text style={s.note}>{`${kindLabel(brief.kind)} · ${brief.source.status}`}</Text>
      <Button compact secondary title={`Open ${kindLabel(brief.kind).toLowerCase()}`} onPress={openSource} />
    </View> : null}
    {brief ? <NarrativeLine narrative={shownNarrative(brief.narrative, refreshNarrative)} canRefresh={canRefresh} refreshState={refreshState} onRefresh={() => void requestRefresh()} /> : null}
    <ScrollView ref={body} scrollEventThrottle={100} onScroll={track} keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => poll.refresh()} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      {!result && poll.loading ? <ActivityIndicator style={s.loading} color={theme.colors.forest} /> : null}
      {!result && !poll.loading ? <View style={s.empty}>
        <Text style={s.emptyTitle}>{poll.stale ? "Work unavailable" : "Loading work"}</Text>
        <Text style={s.note}>{poll.stale ? "This brief is not available right now. Check the connection and pull to retry." : "Connecting to the selected machine…"}</Text>
      </View> : null}
      {unavailable ? <View style={s.empty}>
        <Text style={s.emptyTitle}>{unavailableTitle(unavailable.state)}</Text>
        <Text style={s.note}>{unavailable.error}</Text>
      </View> : null}
      {brief && !poll.online ? <Text style={s.notice}>{poll.seen ? `Offline · showing the last response received for this work at ${poll.seen}.` : "Offline · showing the last response received for this work."}</Text> : null}
      {brief ? <View style={s.stack}>
        {sections.map(section => <SectionCard key={section.id} section={section}
          onLayout={(event: LayoutChangeEvent) => { offsets.current[section.id] = event.nativeEvent.layout.y; }}
          onOpenComponent={openSystem} onOpenWork={openWork} />)}
        {brief.coverage.map((line, index) => <Text key={`coverage-${index}`} style={s.note}>{line}</Text>)}
      </View> : null}
    </ScrollView>
  </View>;
}

function SectionCard({ section, onLayout, onOpenComponent, onOpenWork }: {
  section: WorkSection;
  onLayout: (event: LayoutChangeEvent) => void;
  onOpenComponent: (componentId: string) => void;
  onOpenWork: (workId: string) => void;
}) {
  return <View onLayout={onLayout} style={s.section}>
    <Text accessibilityRole="header" style={s.sectionTitle}>{section.title}</Text>
    {section.blocks.map((block, index) => <BlockView key={index} block={block} onOpenComponent={onOpenComponent} onOpenWork={onOpenWork} />)}
  </View>;
}

/** Shows narrative state in words. Only a `ready` narrative shows nothing, and no line claims more than the host recorded. Eligible readers can ask again; the host answers with the reason when it cannot run. */
function NarrativeLine({ narrative, canRefresh, refreshState, onRefresh }: {
  narrative: WorkNarrativeStatus;
  canRefresh: boolean;
  refreshState: RefreshState;
  onRefresh: () => void;
}) {
  const refresh = canRefresh ? <Button compact secondary title="Refresh" onPress={onRefresh} /> : null;
  let line: ReactNode = null;
  switch (narrative.state) {
    case "pending":
      line = <>
        <ActivityIndicator size="small" color={theme.colors.forest} />
        <Text style={s.narrativeText}>Generating narrative…</Text>
      </>;
      break;
    case "stale":
      line = <>
        <Text style={s.narrativeText}>Narrative for an earlier revision.</Text>
        {refresh}
      </>;
      break;
    case "failed":
      line = <>
        <Text style={s.narrativeText}>{`Narrative failed: ${narrative.reason}`}</Text>
        {refresh}
      </>;
      break;
    case "unavailable":
      line = <>
        <Text style={s.narrativeText}>{narrative.reason}</Text>
        {refresh}
      </>;
      break;
    case "ready":
      break;
  }
  const refreshNote = refreshState === "denied"
    ? "Only workspace owners and controllers can refresh the narrative."
    : refreshState === "failed" ? "The refresh did not reach the host. Try again." : null;
  if (!line && !refreshNote) return null;
  return <View style={s.narrative}>
    {line ? <View style={s.narrativeRow}>{line}</View> : null}
    {refreshNote ? <Text style={s.narrativeText}>{refreshNote}</Text> : null}
  </View>;
}

/** A refused refresh carries the specific reason; the brief's own status only says that no narrative exists. */
function shownNarrative(current: WorkNarrativeStatus, fromRefresh: WorkNarrativeStatus | null): WorkNarrativeStatus {
  if (!fromRefresh || current.state !== "unavailable") return current;
  return fromRefresh.state === "unavailable" || fromRefresh.state === "failed" ? fromRefresh : current;
}

/** Section rail labels carry a count only where the section lists items. */
function railLabel(section: WorkSection): string {
  const count = section.blocks.reduce((total, block) => total + listCount(block), 0);
  return count ? `${section.title} ${count}` : section.title;
}

function listCount(block: WorkBlock): number {
  switch (block.kind) {
    case "facts":
    case "components":
    case "tasks":
    case "checks":
    case "decisions":
    case "questions":
    case "links":
    case "citations":
      return block.items.length;
    default:
      return 0;
  }
}

function kindLabel(kind: WorkBrief["kind"]): string { return kind === "team" ? "Teamwork" : kind === "goal" ? "Goal" : "Mission"; }
function sourceRoute(kind: WorkBrief["kind"]): "/mission/[id]" | "/team/[id]" | "/goal/[id]" {
  return kind === "mission" ? "/mission/[id]" : kind === "team" ? "/team/[id]" : "/goal/[id]";
}

function unavailableTitle(state: "missing" | "upgrade" | "denied"): string {
  return state === "upgrade" ? "Update required" : state === "denied" ? "Access unavailable" : "Work unavailable";
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.colors.paper },
  rail: { flexGrow: 0 },
  railContent: { paddingHorizontal: 16, paddingVertical: 8, gap: 7 },
  sourceRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  narrative: { paddingHorizontal: 16, paddingBottom: 6, gap: 4 },
  narrativeRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  narrativeText: { fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
  content: { paddingHorizontal: 16, paddingBottom: 36 },
  stack: { paddingTop: 10, gap: 22 },
  section: { gap: 10 },
  sectionTitle: { fontSize: 17, lineHeight: 24, fontWeight: "700", color: theme.colors.ink },
  notice: { marginTop: 10, fontSize: 12, lineHeight: 18, color: theme.colors.warningInk, backgroundColor: theme.colors.warningSurface, padding: 9, borderRadius: theme.radius.card },
  note: { fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
  empty: { paddingVertical: 42, gap: 8, alignItems: "center" },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: theme.colors.ink },
  loading: { marginTop: 54 },
});
