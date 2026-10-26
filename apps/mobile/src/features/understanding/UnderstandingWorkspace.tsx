import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ApiError, api, connectionKey, type Connection, type ProjectGroupList } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Chip, LiveStatus, Segmented, type SegmentOption, TopBar } from "../../components/Glass";
import { Glyph } from "../../components/Icon";
import type { UnderstandingRepository, UnderstandingWork, WorkspaceUnderstanding } from "@infinite/remote";
import { theme } from "../../theme";
import { KnowledgePanel } from "./KnowledgePanel";
import { SystemOverview } from "./SystemOverview";
import { clearUnderstandingSummary, readUnderstandingSummary, saveUnderstandingSummary } from "./offline-cache";

type ViewMode = "work" | "system";
type ReadResult = { scope: string; state: "ready" | "missing" | "upgrade" | "denied"; groupName: string; data?: WorkspaceUnderstanding; error?: string; cachedAt?: string };

const views: SegmentOption<ViewMode>[] = [
  { value: "work", label: "Work", glyph: "stack" },
  { value: "system", label: "System", glyph: "target" },
];

/** Read-only Work and System views for one explicitly grouped workspace. */
export function UnderstandingWorkspace({ connection, workspaceId }: { connection: Connection; workspaceId: string }) {
  const router = useRouter();
  const params = useLocalSearchParams<{ machine?: string }>();
  // Keep credential changes inside the in-memory poll scope so stale responses cannot cross pairings.
  const key = `${connectionKey(connection)}|${connection.url}|${connection.relay?.machineId ?? "direct"}|${connection.token}|${connection.access?.clientId ?? ""}|${connection.access?.clientSecret ?? ""}`;
  const scope = `${key}\u0000${workspaceId}`;
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const stopped = useRef("");
  const last = useRef<ReadResult | null>(null);
  const [view, setView] = useState<ViewMode>("work");

  const poll = usePoll(async () => {
    if (stopped.current === scope && last.current?.scope === scope) return last.current;
    let confirmedGroupName = "";
    try {
      const groups = await api<ProjectGroupList>(connection, "/project-groups");
      const group = groups.groups.find(candidate => candidate.id === workspaceId);
      if (!group) {
        await clearUnderstandingSummary(connection, workspaceId);
        const result: ReadResult = { scope, state: "missing", groupName: "", error: "This workspace is no longer available on this machine." };
        last.current = result;
        stopped.current = scope;
        return result;
      }
      confirmedGroupName = group.name;
      const data = await api<WorkspaceUnderstanding>(connection, `/project-groups/${encodeURIComponent(workspaceId)}/understanding`);
      if (data.schemaVersion !== 1 || data.workspace.id !== workspaceId) {
        const result: ReadResult = { scope, state: "upgrade", groupName: group.name, error: "This host returned an unsupported Understanding version." };
        last.current = result;
        stopped.current = scope;
        return result;
      }
      const result: ReadResult = { scope, state: "ready", groupName: group.name, data };
      last.current = result;
      void saveUnderstandingSummary(connection, data);
      return result;
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        await clearUnderstandingSummary(connection, workspaceId).catch(() => {});
        const result: ReadResult = error.status === 404 && confirmedGroupName
          ? { scope, state: "upgrade", groupName: confirmedGroupName, error: "Update this host to use Workspace Understanding." }
          : error.status === 404
            ? { scope, state: "missing", groupName: "", error: "This workspace is no longer available on this machine." }
            : { scope, state: "denied", groupName: confirmedGroupName, error: "This device no longer has access to this workspace." };
        last.current = result;
        stopped.current = scope;
        return result;
      }
      const cached = await readUnderstandingSummary(connection, workspaceId);
      if (cached) {
        const result: ReadResult = { scope, state: "ready", groupName: cached.data.workspace.name, data: cached.data, cachedAt: cached.cachedAt };
        last.current = result;
        return result;
      }
      throw error;
    }
  }, 5000, [connection, scope]);

  useEffect(() => {
    if (stopped.current && stopped.current !== scope) stopped.current = "";
    if (last.current?.scope !== scope) last.current = null;
  }, [scope]);

  // usePoll deliberately retains its last value across dependency changes. Only show a value that
  // belongs to the current machine and workspace so a late response can never flash across scope.
  const result = poll.data?.scope === scope ? poll.data : null;
  const data = result?.state === "ready" ? result.data : undefined;
  const repoById = new Map(data?.repositories.map(repo => [repo.id, repo]) ?? []);
  const groupName = result?.groupName || data?.workspace.name || "Workspace";
  const back = () => router.canGoBack() ? router.back() : router.replace({ pathname: "/(tabs)/understanding", params: { ...(params.machine ? { machine: params.machine } : {}) } });
  const revealKnowledge = (anchor: View | null) => {
    requestAnimationFrame(() => {
      if (!anchor || !content.current) return;
      anchor.measureLayout(content.current, (_x, y) => scroll.current?.scrollTo({ y, animated: false }), () => {});
    });
  };
  const openRepo = (_id: string) => setView("system");

  return <View style={s.fill}>
    <TopBar backLabel="Understand" onBack={back} title={groupName} right={<LiveStatus online={poll.online && result?.state === "ready" && !result.cachedAt} loading={poll.loading} seen={poll.seen} stale={poll.stale} />} />
    <Segmented options={views} value={view} onChange={setView} style={s.segment} />
    <ScrollView ref={scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={() => { stopped.current = ""; poll.refresh(); }} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <View ref={content}>
      {!result && poll.loading ? <ActivityIndicator style={s.loading} color={theme.colors.forest} /> : null}
      {!result && !poll.loading ? <View style={s.empty}>
        <Text style={s.emptyTitle}>{poll.stale ? "Workspace unavailable" : "Loading workspace"}</Text>
        <Text style={s.note}>{poll.stale ? "No earlier brief is available in this view. Check the connection and pull to retry." : "Connecting to the selected machine…"}</Text>
      </View> : null}
      {result?.state === "missing" || result?.state === "upgrade" || result?.state === "denied" ? <View style={s.empty}>
        <Text style={s.emptyTitle}>{result.state === "upgrade" ? "Update required" : result.state === "denied" ? "Access unavailable" : "Workspace unavailable"}</Text>
        <Text style={s.note}>{result.error}</Text>
      </View> : null}
      {data && (result?.cachedAt || !poll.online) ? <Text style={s.notice}>{result?.cachedAt ? `Offline · cached overview from ${date(result.cachedAt)}. Only workspace and repository labels and state are available.` : `Offline · showing the last response received for this workspace at ${date(data.observedAt)}.`}</Text> : null}
      {data ? view === "work"
        ? <WorkView data={data} repoById={repoById} onOpenRepo={openRepo} connection={connection} workspaceId={workspaceId} readGeneration={`${poll.seen}|${data.observedAt}/${data.workspace.revision}`} offline={!poll.online || Boolean(result?.cachedAt)} onComponentNavigate={revealKnowledge} />
        : <SystemView data={data} connection={connection} workspaceId={workspaceId} readGeneration={`${poll.seen}|${data.observedAt}/${data.workspace.revision}`} offline={!poll.online || Boolean(result?.cachedAt)} onComponentNavigate={revealKnowledge} />
        : null}
      </View>
    </ScrollView>
  </View>;
}

function WorkView({ data, repoById, onOpenRepo, connection, workspaceId, readGeneration, offline, onComponentNavigate }: {
  data: WorkspaceUnderstanding;
  repoById: Map<string, UnderstandingRepository>;
  onOpenRepo: (id: string) => void;
  connection: Connection;
  workspaceId: string;
  readGeneration: string;
  offline: boolean;
  onComponentNavigate: (anchor: View | null) => void;
}) {
  const anchor = useRef<View>(null);
  const router = useRouter();
  return <View style={s.stack}>
    <Text style={s.intro}>Work recorded for this workspace, with the repositories each item names.</Text>
    <MembershipMap workspace={data.workspace.name} repositories={data.repositories} onPress={onOpenRepo} />
    <Text style={s.heading}>Work <Text style={s.count}>{data.work.length}</Text></Text>
    {!data.work.length ? <Text style={s.note}>No work records are available for this workspace.</Text> : null}
    {data.work.map(item => <WorkCard key={item.id} item={item} repoById={repoById}
      onOpen={(kind, id) => router.push({ pathname: routeFor(kind), params: { id, machine: connectionKey(connection) } })}
      onOpenRepo={onOpenRepo} />)}
    <View ref={anchor}><KnowledgePanel onComponentNavigate={() => onComponentNavigate(anchor.current)} key={`${connectionKey(connection)}|${connection.url}|${connection.token}|${workspaceId}`} connection={connection} workspaceId={workspaceId} knowledge={data.knowledge} readGeneration={readGeneration} defaultArea="catalog" repositories={data.repositories} work={data.work} offline={offline} /></View>
    {data.coverage.map((line, index) => <Text key={`coverage-${index}`} style={s.note}>{line}</Text>)}
  </View>;
}

function WorkCard({ item, repoById, onOpen, onOpenRepo }: {
  item: UnderstandingWork;
  repoById: Map<string, UnderstandingRepository>;
  onOpen: (kind: UnderstandingWork["kind"], id: string) => void;
  onOpenRepo: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [linkError, setLinkError] = useState("");
  const repoNames = item.repositoryIds.map(id => repoById.get(id)).filter((repo): repo is UnderstandingRepository => Boolean(repo));
  const openLink = async (value: string) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Only secure web links can be opened.");
      await Linking.openURL(url.toString());
      setLinkError("");
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : "This link could not be opened.");
    }
  };
  return <View style={s.card}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={s.workHead}>
      <View style={s.workMain}>
        <Text style={s.workTitle}>{item.title}</Text>
        <Text style={s.meta}>{kindLabel(item.kind)} · {item.status} · updated {date(item.updatedAt)}</Text>
      </View>
      <Glyph name={expanded ? "down" : "forward"} size={13} color={theme.colors.mutedInk} />
    </Pressable>
    {item.scope === "partial" ? <Text style={s.notice}>Partial association · some request or report details are withheld because the work spans other workspaces.</Text> : null}
    {expanded ? <View style={s.detail}>
      {item.objective ? <LabeledText title="Recorded request" text={item.objective} /> : null}
      {item.reportedSummary ? <LabeledText title="Reported result" text={item.reportedSummary} /> : null}
      <Text style={s.meta}>Execution status: {item.status}. {date(item.updatedAt)}</Text>
      <Text style={s.label}>Recorded repository association</Text>
      {repoNames.length ? <View style={s.association}>
        <View style={s.workNode}><Text style={s.workNodeText}>Work</Text></View>
        <Text style={s.associationArrow}>→</Text>
        <View style={s.chips}>{repoNames.map(repo => <Chip key={repo.id} label={repo.name} onPress={() => onOpenRepo(repo.id)} accessibilityLabel={`Open associated repository ${repo.name} in System`} />)}</View>
      </View> : <Text style={s.note}>No repository association is available.</Text>}
      <View style={s.chips}>
        <Pressable accessibilityRole="link" onPress={() => onOpen(item.kind, item.sourceId)} style={s.linkButton}><Text style={s.linkText}>Open {kindLabel(item.kind).toLowerCase()}</Text><Glyph name="forward" size={12} color={theme.colors.forest} /></Pressable>
        {item.links.map((link, index) => <Pressable key={`${link.kind}/${index}`} accessibilityRole="link" onPress={() => void openLink(link.url)} style={s.linkButton}>
          <Text style={s.linkText}>{link.kind === "pr" ? "Pull request" : "Issue"}: {link.label}</Text><Glyph name="forward" size={12} color={theme.colors.forest} />
        </Pressable>)}
      </View>
      {linkError ? <Text accessibilityRole="alert" style={s.linkError}>{linkError}</Text> : null}
    </View> : null}
  </View>;
}

function MembershipMap({ workspace, repositories, onPress }: { workspace: string; repositories: UnderstandingRepository[]; onPress: (id: string) => void }) {
  return <View style={s.map}>
    <Text style={s.mapTitle}>Workspace membership</Text>
    <View accessibilityRole="text" accessibilityLabel={`${workspace} includes ${repositories.length} repositories`} style={s.workspaceNode}>
      <Glyph name="stack" size={16} color={theme.colors.forest} />
      <Text style={s.nodeText} numberOfLines={1}>{workspace}</Text>
      <Text style={s.nodeCount}>{repositories.length}</Text>
    </View>
    <View style={s.repoNodes}>
      {repositories.map((repo, index) => <View key={repo.id} style={s.repoBranch}>
        <View style={[s.branchLine, index === repositories.length - 1 && s.branchLast]} />
        <Pressable accessibilityRole="button" accessibilityLabel={`Open repository ${repo.name}`} onPress={() => onPress(repo.id)} style={({ pressed }) => [s.repoNode, pressed && s.pressed]}>
          <Text style={s.nodeText} numberOfLines={1}>{repo.name}</Text>
          <Text style={s.nodeCount}>{repo.checkoutIds.length}</Text>
        </Pressable>
      </View>)}
      {!repositories.length ? <Text style={s.note}>No repository membership is recorded.</Text> : null}
    </View>
  </View>;
}

function SystemView({ data, connection, workspaceId, readGeneration, offline, onComponentNavigate }: { data: WorkspaceUnderstanding; connection: Connection; workspaceId: string; readGeneration: string; offline: boolean; onComponentNavigate: (anchor: View | null) => void }) {
  const anchor = useRef<View>(null);
  const [openComponentId, setOpenComponentId] = useState("");
  return <View style={s.stack}>
    <SystemOverview connection={connection} workspaceId={workspaceId} data={data} offline={offline}
      onOpenComponent={id => { setOpenComponentId(id); onComponentNavigate(anchor.current); }} />
    <View ref={anchor}><KnowledgePanel onComponentNavigate={() => onComponentNavigate(anchor.current)} key={`${connectionKey(connection)}|${connection.url}|${connection.token}|${workspaceId}`} connection={connection} workspaceId={workspaceId} knowledge={data.knowledge} readGeneration={readGeneration} defaultArea="components" openComponentId={openComponentId} repositories={data.repositories} work={data.work} offline={offline} /></View>
    {data.coverage.map((line, index) => <Text key={`coverage-${index}`} style={s.note}>{line}</Text>)}
    <Text style={s.note}>Generated from the code and the work records. It does not mean anything is deployed or approved.</Text>
  </View>;
}

function LabeledText({ title, text }: { title: string; text: string }) {
  return <View style={s.section}><Text style={s.label}>{title}</Text><Text selectable style={s.body}>{text}</Text></View>;
}

function routeFor(kind: UnderstandingWork["kind"]): "/mission/[id]" | "/team/[id]" | "/goal/[id]" {
  return kind === "mission" ? "/mission/[id]" : kind === "team" ? "/team/[id]" : "/goal/[id]";
}
function kindLabel(kind: UnderstandingWork["kind"]) { return kind === "team" ? "Teamwork" : kind === "goal" ? "Goal" : "Mission"; }
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "time not recorded" : parsed.toLocaleString(); }

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.colors.paper },
  segment: { marginHorizontal: 16, marginBottom: 6 },
  content: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 36 },
  stack: { gap: 12 },
  intro: { fontSize: 13, lineHeight: 19, color: theme.colors.secondaryInk },
  heading: { marginTop: 8, fontSize: 17, fontWeight: "700", color: theme.colors.ink },
  count: { fontSize: 13, fontWeight: "400", color: theme.colors.mutedInk },
  map: { padding: 12, borderRadius: theme.radius.panel, backgroundColor: theme.colors.secondarySurface, gap: 8 },
  mapTitle: { fontSize: 12, fontWeight: "700", color: theme.colors.secondaryInk },
  workspaceNode: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: theme.radius.card, borderWidth: 1, borderColor: theme.colors.fieldRule, backgroundColor: theme.colors.paper },
  repoNodes: { marginLeft: 18, gap: 5 },
  repoBranch: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 },
  branchLine: { width: 15, height: 21, borderLeftWidth: 1, borderBottomWidth: 1, borderColor: theme.colors.fieldRule, marginTop: -10 },
  branchLast: { borderLeftColor: "transparent" },
  repoNode: { minHeight: 38, flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 10, borderRadius: theme.radius.card, borderWidth: 1, borderColor: theme.colors.fieldRule, backgroundColor: theme.colors.paper },
  nodeText: { flex: 1, fontSize: 13, fontWeight: "600", color: theme.colors.ink },
  nodeCount: { fontSize: 11, color: theme.colors.mutedInk },
  card: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule, paddingVertical: 12 },
  workHead: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 10 },
  workMain: { flex: 1, minWidth: 0, gap: 4 },
  workTitle: { fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.ink },
  meta: { fontSize: 11, lineHeight: 16, color: theme.colors.mutedInk },
  detail: { paddingTop: 10, gap: 10 },
  section: { gap: 5, paddingTop: 4 },
  label: { fontSize: 11, lineHeight: 16, fontWeight: "700", color: theme.colors.secondaryInk },
  body: { fontSize: 13, lineHeight: 19, color: theme.colors.ink, flexShrink: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 7 },
  association: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 7, paddingVertical: 5 },
  workNode: { minHeight: 28, justifyContent: "center", paddingHorizontal: 8, borderRadius: theme.radius.card, borderWidth: 1, borderColor: theme.colors.fieldRule, backgroundColor: theme.colors.secondarySurface },
  workNodeText: { fontSize: 11, fontWeight: "700", color: theme.colors.secondaryInk },
  associationArrow: { color: theme.colors.mutedInk, fontSize: 14 },
  linkButton: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 9, borderRadius: theme.radius.capsule, backgroundColor: theme.colors.secondarySurface },
  linkText: { fontSize: 12, fontWeight: "600", color: theme.colors.forest, flexShrink: 1 },
  linkError: { fontSize: 12, lineHeight: 18, color: theme.colors.error },
  notice: { fontSize: 12, lineHeight: 18, color: theme.colors.warningInk, backgroundColor: theme.colors.warningSurface, padding: 9, borderRadius: theme.radius.card },
  note: { fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
  empty: { paddingVertical: 42, gap: 8, alignItems: "center" },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: theme.colors.ink },
  loading: { marginTop: 54 },
  pressed: { backgroundColor: theme.colors.secondarySurface },
});
