import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { KnowledgeBehavior, KnowledgeCatalog, KnowledgeComponent, KnowledgeDelivery, KnowledgeFeature, KnowledgeFeatureInput, KnowledgeMaintenance, KnowledgePlan, KnowledgePlanInput, KnowledgePolicy, KnowledgeProject, KnowledgeProjectInput, KnowledgeRelationship, UnderstandingRepository, UnderstandingWork, WorkspaceKnowledge } from "@infinite/remote";
import { useRouter } from "expo-router";
import { ApiError, api, connectionKey, type Connection, type Me } from "../../api/client";
import { Button } from "../../components/Button";
import { Chip, Segmented, type SegmentOption } from "../../components/Glass";
import { theme } from "../../theme";
import { clearUnderstandingSummary } from "./offline-cache";
import { BehaviorPanel } from "./BehaviorPanel";

type Area = "catalog" | "components" | "delivery" | "maintenance";
type CatalogTab = "projects" | "features" | "plans";
type Mutation = { collection: string; id?: string; requestId: string; revision: number; action: "create" | "update" | "archive"; value?: unknown };
type ComponentsIndex = { components: Pick<KnowledgeComponent, "id" | "name" | "description" | "repositoryIds" | "pinned" | "retired" | "redirectTo">[]; coverage: string[] };
type ComponentDetail = { component: KnowledgeComponent; relationships: KnowledgeRelationship[]; coverage: string[]; behaviors?: KnowledgeBehavior[] };
type ComponentDisclosureState = { expanded: Record<string, boolean>; toggle: (id: string) => void };

const areas: SegmentOption<Area>[] = [
  { value: "catalog", label: "Plans & projects" },
  { value: "components", label: "Components" },
  { value: "delivery", label: "Delivery" },
  { value: "maintenance", label: "Maintenance" },
];

/** Catalog editing and live component knowledge for the selected workspace. */
export function KnowledgePanel({ connection, workspaceId, knowledge, readGeneration, defaultArea, repositories, work, offline, onComponentNavigate, initialComponent }: { connection: Connection; workspaceId: string; knowledge?: WorkspaceKnowledge; readGeneration: string; defaultArea: Area; repositories: UnderstandingRepository[]; work: UnderstandingWork[]; offline: boolean; onComponentNavigate?: () => void; initialComponent?: string }) {
  const router = useRouter();
  const [area, setArea] = useState<Area>(defaultArea);
  const [catalog, setCatalog] = useState<KnowledgeCatalog | null>(knowledge?.catalog ?? null);
  const [maintenance, setMaintenance] = useState<KnowledgeMaintenance | null>(knowledge?.maintenance ?? null);
  const [index, setIndex] = useState<ComponentsIndex | null>(null);
  const [detail, setDetail] = useState<ComponentDetail | null>(null);
  const [detailGeneration, setDetailGeneration] = useState("");
  const [role, setRole] = useState<Me["role"] | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Mutation | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latestRevision, setLatestRevision] = useState<number | null>(null);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>("projects");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedComponent, setSelectedComponent] = useState("");
  const pendingComponentNavigation = useRef<string | null>(null);
  const [editor, setEditor] = useState<{ collection: string; id?: string; value?: unknown; baseRevision: number } | null>(null);
  const readSequence = useRef(0);
  const invalidateReads = useCallback(() => { readSequence.current++; }, []);

  const base = `/project-groups/${encodeURIComponent(workspaceId)}/understanding`;
  const clearDeniedState = useCallback(() => {
    invalidateReads();
    setCatalog(null); setIndex(null); setDetail(null); setDetailGeneration(""); setMaintenance(null); setRole(null);
    setPending(null); setConflict(false); setLatestRevision(null); setEditor(null);
    setReadError("");
    setError("This device no longer has access to workspace knowledge.");
    void clearUnderstandingSummary(connection, workspaceId).catch(() => {});
  }, [connection, invalidateReads, workspaceId]);
  const refreshReads = useCallback(async () => {
    const sequence = ++readSequence.current;
    try {
      const [nextCatalog, nextIndex, me] = await Promise.all([
        api<KnowledgeCatalog>(connection, `${base}/catalog`),
        api<ComponentsIndex>(connection, `${base}/components`),
        api<Me>(connection, "/me"),
      ]);
      if (sequence !== readSequence.current) return;
      setCatalog(nextCatalog);
      setIndex(nextIndex);
      setRole(me.role);
      setReadError("");
      if (conflict) setLatestRevision(nextCatalog.revision);
    } catch (cause) {
      if (sequence !== readSequence.current) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) clearDeniedState();
      else setReadError(cause instanceof Error ? cause.message : "Workspace knowledge could not be loaded.");
    }
  }, [base, clearDeniedState, conflict, connection]);

  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => {
      if (current) void refreshReads();
    });
    return () => { current = false; invalidateReads(); };
  }, [invalidateReads, readGeneration, refreshReads]);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => {
      if (current && knowledge) setMaintenance(knowledge.maintenance);
    });
    return () => { current = false; };
  }, [knowledge]);
  useEffect(() => {
    if (!selectedComponent) return;
    let current = true;
    api<ComponentDetail>(connection, `${base}/components/${encodeURIComponent(selectedComponent)}`).then(value => {
      if (current) { setDetail(value); setDetailGeneration(readGeneration); }
    }).catch(cause => {
      if (!current) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) clearDeniedState();
      else setError(cause instanceof Error ? cause.message : "Component details are unavailable.");
    });
    return () => { current = false; };
  }, [base, clearDeniedState, connection, readGeneration, selectedComponent]);

  const owner = role === "owner";
  const canEdit = owner && !busy && !pending && !offline;
  const visibleDetail = detailGeneration === readGeneration && detail?.component.id === selectedComponent ? detail : null;
  const mutate = async (request: Mutation) => {
    if (busy) return;
    setBusy(true); setError(""); setConflict(false); setLatestRevision(null);
    try {
      const suffix = `${base}/catalog/${request.collection}${request.id ? `/${encodeURIComponent(request.id)}` : ""}`;
      const body = { requestId: request.requestId, revision: request.revision, action: request.action, ...(request.value === undefined ? {} : { value: request.value }) };
      const next = await api<KnowledgeCatalog>(connection, suffix, { method: "POST", body });
      invalidateReads();
      setCatalog(next); setPending(null); setConflict(false); setLatestRevision(null); setEditor(null);
      await refreshReads();
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        clearDeniedState();
        return;
      }
      if (cause instanceof ApiError && cause.status === 409) {
        setPending(request); setConflict(true);
        setLatestRevision(null);
        setError("The workspace changed while this form was open. Your draft is kept. Review the latest catalog revision, then explicitly resubmit it.");
        const sequence = ++readSequence.current;
        try {
          const latest = await api<KnowledgeCatalog>(connection, `${base}/catalog`);
          if (sequence !== readSequence.current) return;
          setCatalog(latest); setLatestRevision(latest.revision);
        } catch {
          if (sequence !== readSequence.current) return;
          setError("The workspace rejected this revision. Your draft is kept, but the latest catalog could not be loaded yet. Reload before resubmitting.");
        }
      } else if (cause instanceof ApiError && cause.status === 0) {
        setPending(request);
        setError("Delivery is uncertain. Retry sends the same request ID and form contents, so the host can safely return the recorded result.");
      } else {
        setError(cause instanceof Error ? cause.message : "This change could not be saved.");
        setPending(null);
      }
    } finally { setBusy(false); }
  };
  const submit = async (collection: string, action: Mutation["action"], id?: string, value?: unknown, baseRevision = catalog?.revision ?? -1) => {
    if (!catalog || !owner || !canEdit) return;
    await mutate({ collection, id, action, value, requestId: Crypto.randomUUID(), revision: baseRevision });
  };
  const reloadConflictCatalog = async () => {
    if (busy || !conflict) return;
    setBusy(true);
    const sequence = ++readSequence.current;
    try {
      const latest = await api<KnowledgeCatalog>(connection, `${base}/catalog`);
      if (sequence !== readSequence.current) return;
      setCatalog(latest); setLatestRevision(latest.revision);
      setError("Latest catalog loaded. Review this revision before explicitly resubmitting your draft.");
    } catch (cause) {
      if (sequence !== readSequence.current) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) clearDeniedState();
      else setError(cause instanceof Error ? cause.message : "The latest catalog is still unavailable.");
    }
    finally { setBusy(false); }
  };

  const refreshSources = async () => {
    if (!owner || busy || !catalog) return;
    setBusy(true); setError("");
    try {
      setMaintenance(await api<KnowledgeMaintenance>(connection, `${base}/refresh`, { method: "POST", body: {} }));
      await refreshReads();
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) clearDeniedState();
      else setError(cause instanceof Error ? cause.message : "Refresh could not be requested.");
    }
    finally { setBusy(false); }
  };

  const openEditor = (collection: string, id?: string, value?: unknown) => setEditor({ collection, id, value, baseRevision: catalog?.revision ?? -1 });
  const navigateComponent = (id: string) => {
    pendingComponentNavigation.current = id && (id !== selectedComponent || area !== "components") ? id : null;
    setSelectedComponent(id); setArea("components"); onComponentNavigate?.();
  };
  // A `component` route param selects one component once, when the panel mounts.
  const appliedInitial = useRef(false);
  useEffect(() => {
    if (appliedInitial.current || !initialComponent) return;
    appliedInitial.current = true;
    navigateComponent(initialComponent);
  });
  const componentDetailDidLayout = (id: string) => {
    if (pendingComponentNavigation.current !== id) return;
    pendingComponentNavigation.current = null;
    onComponentNavigate?.();
  };
  const submitEditor = (value: unknown) => {
    if (!editor) return;
    const action = editor.collection === "policy" ? "update" : editor.id ? "update" : "create";
    void submit(editor.collection, action, editor.id, value, editor.baseRevision);
  };
  const catalogOptions: SegmentOption<CatalogTab>[] = [
    { value: "projects", label: "Projects", count: catalog?.projects.filter(item => !item.archived).length },
    { value: "features", label: "Features", count: catalog?.features.filter(item => !item.archived).length },
    { value: "plans", label: "Component plans", count: catalog?.plans.filter(item => !item.archived).length },
  ];

  return <View style={k.wrap}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={k.areaTabs} accessibilityRole="tablist">
      {areas.map(option => <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected: area === option.value }} onPress={() => setArea(option.value)} style={[k.areaTab, area === option.value && k.areaSelected]}><Text style={[k.areaText, area === option.value && k.areaTextSelected]}>{option.label}</Text></Pressable>)}
    </ScrollView>
    {error || readError ? <View accessibilityRole="alert" style={k.error}><Text style={k.errorText}>{error || readError}</Text></View> : null}
    {offline ? <Text style={k.note}>Offline observation · changes and refresh are disabled until the connection is verified.</Text> : !owner ? <Text style={k.note}>{role ? "Read-only · catalog changes and refresh requests are available to workspace owners." : "Checking workspace permissions… catalog controls are disabled."}</Text> : null}
    {pending ? <View style={k.pending}>
      <Text style={k.note}>{conflict ? "Conflict draft · choose to submit against the latest revision." : "Unconfirmed save · retry uses the same request."}</Text>
      {conflict ? <Text style={k.note}>Latest catalog revision: {latestRevision ?? "not loaded"} · draft revision: {pending.revision}</Text> : null}
      <View style={k.actions}>
        <Button compact title={busy ? "Saving…" : conflict ? "Resubmit draft" : "Retry same save"} disabled={busy || offline || !catalog || !owner || (conflict && latestRevision === null)} onPress={() => void mutate(conflict ? { ...pending, requestId: Crypto.randomUUID(), revision: latestRevision! } : pending)} />
        {conflict && latestRevision === null ? <Button compact secondary title="Reload catalog" disabled={busy || offline} onPress={() => void reloadConflictCatalog()} /> : null}
        <Button compact secondary title="Discard draft" disabled={busy} onPress={() => { setPending(null); setConflict(false); setLatestRevision(null); setEditor(null); setError(""); }} />
      </View>
    </View> : null}
    {area === "catalog" ? <>
      <Text style={k.intro}>Projects, features, and component plans are owner-maintained records. Feature status is an explicit owner assessment.</Text>
      <Segmented options={catalogOptions} value={catalogTab} onChange={setCatalogTab} style={k.subtabs} />
      {catalogTab === "projects" ? <ProjectList items={catalog?.projects ?? []} repositories={repositories} selected={selectedProject} canEdit={canEdit} onSelect={id => { setSelectedProject(id); setCatalogTab("features"); }} onCreate={() => openEditor("projects")} onEdit={item => openEditor("projects", item.id, item)} onArchive={item => confirmArchive(item.name, () => void submit("projects", "archive", item.id))} /> : null}
      {catalogTab === "features" ? <FeatureList items={catalog?.features ?? []} catalog={catalog} work={work} components={index?.components ?? []} projectId={selectedProject} onClearProject={() => setSelectedProject("")} onOpenComponent={navigateComponent} canEdit={canEdit} onOpenWork={item => router.push({ pathname: item.kind === "mission" ? "/mission/[id]" : item.kind === "team" ? "/team/[id]" : "/goal/[id]", params: { id: item.sourceId, machine: connectionKey(connection) } })} onCreate={() => openEditor("features")} onEdit={item => openEditor("features", item.id, item)} onArchive={item => confirmArchive(item.title, () => void submit("features", "archive", item.id))} /> : null}
      {catalogTab === "plans" ? <PlanList items={catalog?.plans ?? []} canEdit={canEdit} onCreate={() => openEditor("plans")} onEdit={item => openEditor("plans", item.id, item)} onArchive={item => confirmArchive(item.title, () => void submit("plans", "archive", item.id))} /> : null}
      <Coverage lines={catalog?.coverage ?? []} />
    </> : null}
    {area === "components" ? <ComponentArea index={index} detail={visibleDetail} selected={selectedComponent} onSelect={navigateComponent} onDetailLayout={componentDetailDidLayout} onRefresh={refreshReads} canEdit={canEdit} onAccessDenied={clearDeniedState} connection={connection} workspaceId={workspaceId} onEdit={item => openEditor("components", item.id, item)} /> : null}
    {area === "delivery" ? <DeliveryArea delivery={knowledge?.delivery ?? []} /> : null}
    {area === "maintenance" ? <MaintenanceArea knowledge={knowledge} maintenance={maintenance} catalog={catalog} canEdit={canEdit} owner={owner} busy={busy} onRefresh={refreshSources} onEditPolicy={() => openEditor("policy", undefined, catalog?.policy)} /> : null}
    {editor ? <CatalogEditor key={`${editor.collection}/${editor.id ?? "new"}`} collection={editor.collection} id={editor.id} initial={editor.value} catalog={catalog} repositories={repositories} components={index?.components ?? []} work={work} onCancel={() => setEditor(null)} onSave={submitEditor} busy={busy} locked={Boolean(pending)} /> : null}
    {!catalog && !error && !readError ? <ActivityIndicator color={theme.colors.forest} style={{ marginTop: 16 }} /> : null}
  </View>;
}

function ProjectList({ items, repositories, selected, canEdit, onSelect, onCreate, onEdit, onArchive }: { items: KnowledgeProject[]; repositories: UnderstandingRepository[]; selected: string; canEdit: boolean; onSelect: (id: string) => void; onCreate: () => void; onEdit: (item: KnowledgeProject) => void; onArchive: (item: KnowledgeProject) => void }) {
  const active = items.filter(item => !item.archived);
  return <View style={k.stack}>
    <View style={k.sectionHead}><Text style={k.heading}>Projects · {active.length}</Text><Button compact title="New project" disabled={!canEdit} onPress={onCreate} /></View>
    {items.map(item => <View key={item.id} style={k.card}>
      <Text style={k.title}>{item.name}{item.archived ? " · Archived" : ""}</Text>
      {item.description ? <Text selectable style={k.body}>{item.description}</Text> : <Text style={k.note}>No description recorded.</Text>}
      <Text style={k.meta}>Repositories: {item.repositoryIds.length ? item.repositoryIds.map(id => repositories.find(repo => repo.id === id)?.name ?? id).join(", ") : "none selected"}</Text>
      <Text style={k.meta}>Revision {item.revision} · updated {date(item.updatedAt)}</Text>
      {!item.archived ? <Button compact secondary title={selected === item.id ? "View features" : "Select project"} onPress={() => onSelect(item.id)} /> : null}
      {!item.archived ? <View style={k.actions}><Button compact secondary title="Edit" disabled={!canEdit} onPress={() => onEdit(item)} /><Button compact destructive title="Archive" disabled={!canEdit} onPress={() => onArchive(item)} /></View> : null}
    </View>)}
    {!active.length ? <Text style={k.note}>No active projects are recorded.</Text> : null}
  </View>;
}

function FeatureList({ items, catalog, work, components, projectId, onClearProject, onOpenComponent, canEdit, onOpenWork, onCreate, onEdit, onArchive }: { items: KnowledgeFeature[]; catalog: KnowledgeCatalog | null; work: UnderstandingWork[]; components: ComponentsIndex["components"]; projectId: string; onClearProject: () => void; onOpenComponent: (id: string) => void; canEdit: boolean; onOpenWork: (item: UnderstandingWork) => void; onCreate: () => void; onEdit: (item: KnowledgeFeature) => void; onArchive: (item: KnowledgeFeature) => void }) {
  const [filter, setFilter] = useState("");
  const matching = items.filter(item => !item.archived && (!projectId || item.projectId === projectId) && (!filter.trim() || `${item.title} ${item.description}`.toLowerCase().includes(filter.trim().toLowerCase())));
  const statuses: KnowledgeFeature["status"][] = ["planned", "active", "blocked", "completed", "cancelled", "failed"];
  return <View style={k.stack}>
    <View style={k.sectionHead}><Text style={k.heading}>Features · {matching.length}</Text><Button compact title="New feature" disabled={!canEdit} onPress={onCreate} /></View>
    {projectId ? <View style={k.actions}><Text style={k.note}>Project filter · {catalog?.projects.find(project => project.id === projectId)?.name ?? projectId}</Text><Button compact secondary title="Clear filter" onPress={onClearProject} /></View> : null}
    <TextInput accessibilityLabel="Filter features" value={filter} onChangeText={setFilter} placeholder="Filter features by name or description" placeholderTextColor={theme.colors.mutedInk} style={k.input} />
    {statuses.map(status => {
      const group = matching.filter(item => item.status === status);
      if (!group.length) return null;
      return <View key={status} style={k.group}><Text style={k.label}>{featureStatus(status)} · {group.length}</Text>{group.map(item => <View key={item.id} style={k.card}>
        <Text style={k.title}>{item.title}</Text><Text selectable style={k.body}>{item.description || "No description recorded."}</Text>
        <Text style={k.meta}>{catalog?.projects.find(project => project.id === item.projectId)?.name ?? "No project selected"} · updated {date(item.updatedAt)}</Text>
        <Text style={k.meta}>Repositories {item.repositoryIds.length} · related components {item.componentIds.length} · work records {item.workIds.length}</Text>
        {item.componentIds.length ? <View style={k.chips}>{item.componentIds.map(id => <Chip key={id} label={components.find(component => component.id === id)?.name ?? id} onPress={() => onOpenComponent(id)} accessibilityLabel={`Open related component ${components.find(component => component.id === id)?.name ?? id}`} />)}</View> : null}
        {item.workIds.length ? <View style={k.group}><Text style={k.label}>Related work timeline</Text>{item.workIds.map(id => work.find(entry => entry.id === id || entry.sourceId === id)).filter((entry): entry is UnderstandingWork => Boolean(entry)).map(entry => <Pressable key={entry.id} accessibilityRole="button" onPress={() => onOpenWork(entry)} style={k.edge}><Text style={k.title}>{entry.title}</Text><Text style={k.meta}>{entry.kind} · {entry.status} · updated {date(entry.updatedAt)}</Text>{entry.reportedSummary ? <Text numberOfLines={3} style={k.body}>{entry.reportedSummary}</Text> : null}{entry.links.map((link, linkIndex) => <SafeLink key={`${link.kind}/${linkIndex}`} label={`${link.kind === "pr" ? "Pull request" : "Issue"} · ${link.label}`} url={link.url} />)}</Pressable>)}</View> : null}
        {item.sourceUrl ? <SafeLink label="Open feature source" url={item.sourceUrl} /> : null}
        <View style={k.actions}><Button compact secondary title="Edit" disabled={!canEdit} onPress={() => onEdit(item)} /><Button compact destructive title="Archive" disabled={!canEdit} onPress={() => onArchive(item)} /></View>
      </View>)}</View>;
    })}
    {!matching.length ? <Text style={k.note}>{items.some(item => !item.archived) ? "No features match this project and filter." : "No features are recorded."}</Text> : null}
  </View>;
}

function PlanList({ items, canEdit, onCreate, onEdit, onArchive }: { items: KnowledgePlan[]; canEdit: boolean; onCreate: () => void; onEdit: (item: KnowledgePlan) => void; onArchive: (item: KnowledgePlan) => void }) {
  const active = items.filter(item => !item.archived);
  return <View style={k.stack}>
    <View style={k.sectionHead}><Text style={k.heading}>Plans · {active.length}</Text><Button compact title="New plan" disabled={!canEdit} onPress={onCreate} /></View>
    {active.map(item => <View key={item.id} style={k.card}>
      <Text style={k.title}>{item.title}</Text><Text style={k.meta}>{item.status === "accepted" ? "Accepted plan" : item.status === "superseded" ? "Superseded plan" : "Proposed plan"} · component {item.componentId}</Text>
      <Text selectable style={k.body}>{item.text}</Text><Text style={k.meta}>Repositories {item.repositoryIds.length} · revision {item.revision}</Text>
      {item.sourceUrl ? <SafeLink label="Open plan source" url={item.sourceUrl} /> : null}
      <View style={k.actions}><Button compact secondary title="Edit / change status" disabled={!canEdit} onPress={() => onEdit(item)} /><Button compact destructive title="Archive" disabled={!canEdit} onPress={() => onArchive(item)} /></View>
    </View>)}
    {!active.length ? <Text style={k.note}>No component plans are recorded.</Text> : null}
  </View>;
}

function ComponentArea({ index, detail, selected, onSelect, onDetailLayout, onRefresh, canEdit, onAccessDenied, connection, workspaceId, onEdit }: { index: ComponentsIndex | null; detail: ComponentDetail | null; selected: string; onSelect: (id: string) => void; onDetailLayout: (id: string) => void; onRefresh: () => void; canEdit: boolean; onAccessDenied: () => void; connection: Connection; workspaceId: string; onEdit: (item: KnowledgeComponent) => void }) {
  const [expandedByComponent, setExpandedByComponent] = useState<Record<string, Record<string, boolean>>>({});
  const [detailHeights, setDetailHeights] = useState<Record<string, number>>({});
  const disclosureState: ComponentDisclosureState = {
    expanded: expandedByComponent[selected] ?? {},
    toggle: id => setExpandedByComponent(previous => ({ ...previous, [selected]: { ...previous[selected], [id]: !previous[selected]?.[id] } })),
  };
  const entries = index?.components ?? [];
  if (selected) return <View style={k.stack}>
    <View style={k.actions}><Button secondary title="Back to components" onPress={() => onSelect("")} /></View>
    {detail ? <View key={`detail:${detail.component.id}`} onLayout={event => {
      const height = event.nativeEvent.layout.height;
      setDetailHeights(previous => previous[selected] === height ? previous : { ...previous, [selected]: height });
      onDetailLayout(detail.component.id);
    }}><ComponentDetailView detail={detail} components={entries} disclosureState={disclosureState} canEdit={canEdit} onAccessDenied={onAccessDenied} connection={connection} workspaceId={workspaceId} onEdit={() => onEdit(detail.component)} onSelect={onSelect} /></View> : <View key={`loading:${selected}`} style={[k.group, { minHeight: detailHeights[selected] ?? 0 }]}><Text style={k.heading}>{entries.find(item => item.id === selected)?.name || "Component"}</Text><ActivityIndicator color={theme.colors.forest} accessibilityLabel="Loading component details" /></View>}
  </View>;
  return <View style={k.stack}>
    <View style={k.sectionHead}><Text style={k.heading}>System components · {entries.length}</Text><Button compact secondary title="Reload" onPress={onRefresh} /></View>
    {entries.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Open ${item.name || "component"}`} onPress={() => onSelect(item.id)} style={k.componentRow}>
      <View style={{ flex: 1, gap: 4 }}><Text style={k.title}>{item.name || "Component"}{item.pinned ? " · Pinned" : ""}{item.retired ? " · Retired" : ""}</Text>{componentDescription(item.description) ? <Text numberOfLines={2} style={k.meta}>{componentDescription(item.description)}</Text> : null}<Text style={k.meta}>{item.repositoryIds.length} {item.repositoryIds.length === 1 ? "repository" : "repositories"}</Text></View>
      <Text style={k.selectMark}>Open</Text>
    </Pressable>)}
    {!entries.length ? <Text style={k.note}>No components are mapped yet. Refresh sources to request a new observation.</Text> : null}
    {index?.coverage.length ? <KnowledgeDisclosure title="Source coverage"><Coverage lines={index.coverage} /></KnowledgeDisclosure> : null}
  </View>;
}

function ComponentDetailView({ detail, components, disclosureState, canEdit, onAccessDenied, connection, workspaceId, onEdit, onSelect }: { detail: ComponentDetail; components: ComponentsIndex["components"]; disclosureState: ComponentDisclosureState; canEdit: boolean; onAccessDenied: () => void; connection: Connection; workspaceId: string; onEdit: () => void; onSelect: (id: string) => void }) {
  const { component, relationships } = detail;
  const nameOf = (id: string) => (id === component.id ? component.name : components.find(item => item.id === id)?.name) || "Unavailable component";
  const latestObservation = component.current.sources.map(source => source.observedAt).sort().at(-1);
  const coverage = [...new Set([...component.coverage, ...detail.coverage])];
  return <View style={k.componentDetail}>
    <View style={k.group}>
      <Text style={k.componentTitle}>{component.name || "Component"}</Text>
      {componentDescription(component.description) ? <Text selectable style={k.body}>{component.description}</Text> : null}
      <Text style={k.meta}>{component.repositoryIds.length} {component.repositoryIds.length === 1 ? "repository" : "repositories"}{component.pinned ? " · Pinned" : ""}{component.retired ? " · Retired" : ""}</Text>
    </View>
    <View style={k.group}>
      <Text style={k.sectionTitle}>Current · {component.current.state}</Text>
      <Text selectable style={k.body}>{component.current.summary || "Current source summary is unavailable."}</Text>
      <Text style={k.meta}>Latest source observation {date(latestObservation ?? "")} · generated {date(component.current.generatedAt ?? "")}</Text>
    </View>
    <View style={k.group}>
      <Text style={k.sectionTitle}>Planned</Text>
      {component.planned.length ? component.planned.map(plan => <View key={plan.id} style={k.plan}><Text style={k.title}>{plan.title} · {plan.status === "accepted" ? "Accepted" : plan.status === "superseded" ? "Superseded" : "Proposed"}</Text><Text selectable style={k.body}>{plan.text}</Text><Text style={k.meta}>Updated {date(plan.updatedAt)}</Text></View>) : <Text style={k.note}>No recorded plans are linked to this component.</Text>}
    </View>
    <BehaviorPanel key={`${component.id}:${(detail.behaviors ?? []).map(item => `${item.id}:${item.revision}`).join("|")}`} connection={connection} workspaceId={workspaceId} componentId={component.id} currentSourceSnapshotId={component.current.snapshotId} currentSourceState={component.current.state} behaviors={detail.behaviors} canRun={canEdit} onAccessDenied={onAccessDenied} />
    <View style={k.group}>
      <Text style={k.sectionTitle}>Difference · {component.difference.state}</Text>
      <Text selectable style={k.body}>{component.difference.summary}</Text>
      <Text style={k.meta}>Compared {component.difference.planRevisions.length} {component.difference.planRevisions.length === 1 ? "plan" : "plans"} · generated {date(component.difference.generatedAt ?? "")}</Text>
    </View>
    <View style={k.group}>
      <Text style={k.sectionTitle}>Relationships · {relationships.length}</Text>
      {!relationships.length ? <Text style={k.note}>No relationships are recorded.</Text> : null}
      {relationships.map(edge => {
        const neighbor = edge.from === component.id ? edge.to : edge.from;
        const fromName = nameOf(edge.from);
        const toName = nameOf(edge.to);
        const summary = edge.summary.startsWith("Static import map reports a file-level dependency from ") ? "" : edge.summary.split(edge.from).join(fromName).split(edge.to).join(toName);
        return <View key={edge.id} style={k.edge}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${fromName} ${edge.kind} ${toName}. Open ${nameOf(neighbor)}.`} onPress={() => onSelect(neighbor)} style={k.relationshipLink}>
            <View style={k.graphEdge}>
              <View style={k.graphNode}><Text numberOfLines={2} style={k.graphNodeText}>{fromName}</Text></View>
              <View style={k.graphLink}><View style={k.graphLine} /><Text style={k.graphKind}>{edge.kind}</Text><Text style={k.graphArrow}>›</Text></View>
              <View style={k.graphNode}><Text numberOfLines={2} style={k.graphNodeText}>{toName}</Text></View>
            </View>
            {summary ? <Text style={k.body}>{summary}</Text> : null}
            <Text style={k.meta}>{edge.basis} evidence · open {nameOf(neighbor)}</Text>
          </Pressable>
          <KnowledgeDisclosure state={disclosureState} disclosureId={`relationship:${edge.id}`} title="Relationship evidence"><Text selectable style={k.note}>{edge.summary}</Text>{edge.evidence.map((item, i) => <EvidenceItem key={i} evidence={item} />)}</KnowledgeDisclosure>
        </View>;
      })}
    </View>
    <View style={k.actions}><Button secondary title="Edit component" disabled={!canEdit} onPress={onEdit} /></View>
    {component.current.claims.length || component.current.brief ? <KnowledgeDisclosure state={disclosureState} title="Current evidence and brief">
      {component.current.claims.map((claim, i) => <EvidenceClaim key={`current-${i}`} title={`Current · ${claim.basis}`} text={claim.text} evidence={claim.evidence} />)}
      {component.current.brief ? <View style={k.group}>{component.current.brief.summary !== component.current.summary ? <Text selectable style={k.body}>{component.current.brief.summary}</Text> : null}{component.current.brief.changes.map((claim, i) => <EvidenceClaim key={`change-${i}`} title="Reported change" text={claim.text} evidence={claim.citations.map(c => ({ repositoryId: "", source: c.source, line: c.line, text: undefined }))} />)}{component.current.brief.unknowns.map((line, i) => <Text key={i} style={k.note}>Gap · {line}</Text>)}</View> : null}
    </KnowledgeDisclosure> : null}
    {component.difference.claims.length ? <KnowledgeDisclosure state={disclosureState} title="Comparison evidence">{component.difference.claims.map((claim, i) => <EvidenceClaim key={`difference-${i}`} title={`Difference · ${claim.basis}`} text={claim.text} evidence={claim.evidence} />)}</KnowledgeDisclosure> : null}
    <KnowledgeDisclosure state={disclosureState} disclosureId="files" title={`Observed files · ${component.files.length}`}>
      {component.files.length ? component.files.map((file, i) => <Text selectable key={i} style={k.evidence}>{file.repositoryId} / {file.path} · {file.lines} lines · fingerprint {file.hash}</Text>) : <Text style={k.note}>No file inventory was recorded.</Text>}
    </KnowledgeDisclosure>
    <KnowledgeDisclosure state={disclosureState} title="Source details">
      <Text selectable style={k.evidence}>Component ID · {component.id}</Text>
      <Text selectable style={k.evidence}>Current snapshot · {component.current.snapshotId || "not recorded"}</Text>
      {component.current.sources.map((source, i) => <Text selectable key={i} style={k.evidence}>{source.repositoryId} · revision {source.head || "unavailable"} · fingerprint {source.fingerprint} · observed {date(source.observedAt)}</Text>)}
      {component.paths.map((path, i) => <Text selectable key={`path-${i}`} style={k.evidence}>Source path · {path.repositoryId} / {path.path}</Text>)}
      <Text selectable style={k.evidence}>Compared snapshot · {component.difference.snapshotId || "not recorded"}</Text>
      <Text selectable style={k.evidence}>Compared plan revisions · {component.difference.planRevisions.map(plan => `${plan.id} r${plan.revision}`).join(", ") || "none"}</Text>
    </KnowledgeDisclosure>
    {component.history.length ? <KnowledgeDisclosure state={disclosureState} disclosureId="history" title={`History · ${component.history.length}`}>{component.history.map((item, i) => <View key={i} style={k.group}><Text style={k.meta}>{date(item.at)}</Text><Text selectable style={k.body}>{item.summary}</Text><Text selectable style={k.evidence}>Snapshot · {item.snapshotId}</Text></View>)}</KnowledgeDisclosure> : null}
    {coverage.length ? <KnowledgeDisclosure state={disclosureState} title="Source coverage"><Coverage lines={coverage} /></KnowledgeDisclosure> : null}
  </View>;
}

function KnowledgeDisclosure({ title, children, state, disclosureId = title }: { title: string; children: ReactNode; state?: ComponentDisclosureState; disclosureId?: string }) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = state ? state.expanded[disclosureId] === true : localExpanded;
  return <View style={k.disclosure}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }} onPress={() => state ? state.toggle(disclosureId) : setLocalExpanded(value => !value)} style={k.disclosureToggle}>
      <Text style={k.disclosureTitle}>{title}</Text><Text style={k.selectMark}>{expanded ? "Hide" : "Show"}</Text>
    </Pressable>
    {expanded ? <View style={k.group}>{children}</View> : null}
  </View>;
}

function componentDescription(description: string) {
  return description === "Deterministic repository-layout component map; description has not been owner-verified." ? "" : description;
}

function DeliveryArea({ delivery }: { delivery: KnowledgeDelivery[] }) {
  return <View style={k.stack}>
    <Text style={k.intro}>Pull requests and provider environments are separate observations. A merged change does not prove deployment.</Text>
    {!delivery.length ? <Text style={k.note}>Delivery data is unavailable for this host or workspace.</Text> : null}
    {delivery.map((item, i) => <View key={`${item.repositoryId}/${i}`} style={k.card}>
      <Text style={k.title}>{item.repositoryId} · {item.state}</Text><Text style={k.meta}>Observed {date(item.observedAt ?? "")}</Text>
      {item.pullRequests.map(pr => <View key={`${pr.repositoryId}/${pr.number}`} style={k.plan}><SafeLink label={`PR #${pr.number} · ${pr.title} · ${pr.state}`} url={pr.url} /><Text style={k.meta}>Head {pr.head || "not recorded"} · observed {date(pr.observedAt)}</Text>{pr.checks.map((check, j) => <View key={j} style={k.edge}><Text style={k.label}>{check.name} · {check.status}{check.conclusion ? ` · ${check.conclusion}` : ""}</Text>{check.url ? <SafeLink label="Open check" url={check.url} /> : null}</View>)}</View>)}
      {item.environments.map((env, j) => <View key={`${env.environment}/${j}`} style={k.plan}><Text style={k.label}>Provider environment · {env.environment}</Text><Text style={k.meta}>Status {env.status} · revision {env.revision} · observed {date(env.observedAt)}</Text>{env.url ? <SafeLink label="Open environment" url={env.url} /> : null}</View>)}
      {!item.pullRequests.length && !item.environments.length ? <Text style={k.note}>No provider observations are available.</Text> : null}<Coverage lines={item.coverage} />
    </View>)}
  </View>;
}

function MaintenanceArea({ knowledge, maintenance, catalog, canEdit, owner, busy, onRefresh, onEditPolicy }: { knowledge?: WorkspaceKnowledge; maintenance: KnowledgeMaintenance | null; catalog: KnowledgeCatalog | null; canEdit: boolean; owner: boolean; busy: boolean; onRefresh: () => void; onEditPolicy: () => void }) {
  const currentMaintenance = maintenance ?? knowledge?.maintenance;
  const policy = catalog?.policy;
  return <View style={k.stack}>
    <Text style={k.intro}>Model work runs only under the saved owner policy and when a host writer is configured.</Text>
    <View style={k.card}>
      <Text style={k.title}>Saved policy</Text>
      {policy ? <>
        <Text style={k.body}>Knowledge {policy.enabled ? "enabled" : "disabled"} · synthesis {policy.synthesis ? "enabled" : "disabled"} · delivery {policy.delivery ? "enabled" : "disabled"}</Text>
        <Text style={k.meta}>Interval {policy.intervalMinutes} minutes · daily job limit {policy.dailyJobLimit}</Text>
      </> : <Text style={k.note}>Policy is unavailable.</Text>}
      <Button compact title="Edit saved policy" disabled={!canEdit} onPress={onEditPolicy} />
      {!owner ? <Text style={k.note}>{catalog ? "Only workspace owners can change policy." : "Policy is read-only until the workspace is available."}</Text> : null}
    </View>
    <View style={k.card}>
      <Text style={k.title}>Maintenance status · {currentMaintenance?.state ?? "unavailable"}</Text>
      <Text style={k.body}>{currentMaintenance?.message ?? "The host did not provide maintenance details."}</Text>
      <Text style={k.meta}>Last observed {date(currentMaintenance?.lastObservedAt ?? "")} · last published {date(currentMaintenance?.lastPublishedAt ?? "")}</Text>
      <Text style={k.meta}>Next attempt {date(currentMaintenance?.nextAttemptAt ?? "")} · jobs today {currentMaintenance?.jobsToday ?? 0} of {currentMaintenance?.dailyJobLimit ?? "unknown"}</Text>
      <Button compact secondary title={busy ? "Requesting…" : "Refresh sources"} disabled={!canEdit || busy} onPress={onRefresh} />
      {!owner ? <Text style={k.note}>Only owners can request a source refresh.</Text> : null}
    </View>
    <Coverage lines={knowledge?.coverage ?? []} />
  </View>;
}

function CatalogEditor({ collection, id, initial, catalog, repositories, components, work, onCancel, onSave, busy, locked }: { collection: string; id?: string; initial?: unknown; catalog: KnowledgeCatalog | null; repositories: UnderstandingRepository[]; components: ComponentsIndex["components"]; work: UnderstandingWork[]; onCancel: () => void; onSave: (value: unknown) => void; busy: boolean; locked: boolean }) {
  const item = initial as Record<string, unknown> | undefined;
  const repositoryChoices = repositories.map(repo => ({ id: repo.id, label: repo.name }));
  const componentChoices = components.filter(component => !component.retired).map(component => ({ id: component.id, label: component.name }));
  const projectChoices = catalog?.projects.filter(project => !project.archived).map(project => ({ id: project.id, label: project.name })) ?? [];
  const workChoices = work.map(entry => ({ id: entry.id, label: `${entry.title} · ${entry.kind} · ${entry.status}` }));
  const [values, setValues] = useState<Record<string, string>>(() => ({
    name: String(item?.name ?? ""), description: String(item?.description ?? ""), repositoryIds: list(item?.repositoryIds),
    projectId: String(item?.projectId ?? ""), title: String(item?.title ?? ""), workIds: list(item?.workIds), componentIds: list(item?.componentIds), status: String(item?.status ?? (collection === "features" ? "planned" : "proposed")), sourceUrl: String(item?.sourceUrl ?? ""),
    componentId: String(item?.componentId ?? ""), text: String(item?.text ?? ""), workId: String(item?.workId ?? ""),
    redirectTo: String(item?.redirectTo ?? ""), pinned: String(item?.pinned ?? false), enabled: String(item?.enabled ?? false), synthesis: String(item?.synthesis ?? false), delivery: String(item?.delivery ?? false), intervalMinutes: String(item?.intervalMinutes ?? 60), dailyJobLimit: String(item?.dailyJobLimit ?? 20),
  }));
  const field = (key: string, label: string, multiline = false, hint?: string) => <View key={key} style={k.inputGroup}><Text style={k.label}>{label}</Text><TextInput accessibilityLabel={label} value={values[key] ?? ""} onChangeText={text => setValues(old => ({ ...old, [key]: text }))} editable={!busy && !locked} multiline={multiline} autoCapitalize="sentences" placeholder={hint} placeholderTextColor={theme.colors.mutedInk} style={[k.input, multiline && k.multiline, (busy || locked) && k.inputLocked]} /></View>;
  const toggle = (key: string, label: string) => <Pressable key={key} disabled={busy || locked} accessibilityRole="checkbox" accessibilityState={{ checked: values[key] === "true", disabled: busy || locked }} onPress={() => setValues(old => ({ ...old, [key]: old[key] === "true" ? "false" : "true" }))} style={k.toggle}><Text style={k.toggleCheck}>{values[key] === "true" ? "✓" : "○"}</Text><Text style={k.body}>{label}</Text></Pressable>;
  const choose = (key: string, label: string, options: { id: string; label: string }[]) => <View key={key} style={k.inputGroup}><Text style={k.label}>{label}</Text><View style={k.chips}>{options.map(option => <Chip key={option.id} label={option.label} selected={(values[key] ?? "").split(",").map(x => x.trim()).includes(option.id)} onPress={busy || locked ? undefined : () => setValues(old => { const selected = (old[key] ?? "").split(",").map(x => x.trim()).filter(Boolean); const next = selected.includes(option.id) ? selected.filter(x => x !== option.id) : [...selected, option.id]; return { ...old, [key]: next.join(", ") }; })} accessibilityLabel={`${label}: ${option.label}`} />)}</View><Text style={k.meta}>Selected: {(values[key] ?? "").split(",").map(id => options.find(option => option.id === id)?.label ?? id).filter(Boolean).join(", ") || "none"}</Text></View>;
  const chooseOne = (key: string, label: string, options: { id: string; label: string }[]) => <View key={key} style={k.inputGroup}><Text style={k.label}>{label}</Text><View style={k.chips}>{options.map(option => <Chip key={option.id} label={option.label} selected={values[key] === option.id} onPress={busy || locked ? undefined : () => setValues(old => ({ ...old, [key]: old[key] === option.id ? "" : option.id }))} accessibilityLabel={`${label}: ${option.label}`} />)}</View><Text style={k.meta}>Selected: {options.find(option => option.id === values[key])?.label ?? "none"}</Text></View>;
  const submit = () => {
    if (collection === "policy") return onSave({ enabled: values.enabled === "true", synthesis: values.synthesis === "true", delivery: values.delivery === "true", intervalMinutes: Number(values.intervalMinutes), dailyJobLimit: Number(values.dailyJobLimit) } satisfies KnowledgePolicy);
    if (collection === "projects") return onSave({ name: values.name.trim(), description: values.description.trim(), repositoryIds: split(values.repositoryIds) } satisfies KnowledgeProjectInput);
    if (collection === "features") return onSave({ projectId: values.projectId.trim() || null, title: values.title.trim(), description: values.description.trim(), repositoryIds: split(values.repositoryIds), workIds: split(values.workIds), componentIds: split(values.componentIds), status: values.status as KnowledgeFeature["status"], sourceUrl: values.sourceUrl.trim() || null } satisfies KnowledgeFeatureInput);
    if (collection === "plans") return onSave({ componentId: values.componentId.trim(), repositoryIds: split(values.repositoryIds), title: values.title.trim(), text: values.text.trim(), status: values.status as KnowledgePlan["status"], sourceUrl: values.sourceUrl.trim() || null, workId: values.workId.trim() || null } satisfies KnowledgePlanInput);
    return onSave({ name: values.name.trim(), description: values.description.trim(), repositoryIds: split(values.repositoryIds), pinned: values.pinned === "true", redirectTo: values.redirectTo.trim() || null });
  };
  return <View style={k.editor}>
    <Text style={k.sectionTitle}>{editorTitle(collection, Boolean(id))}</Text>
    {collection === "policy" ? <>
      {toggle("enabled", "Enable Understanding maintenance")}{toggle("synthesis", "Allow model synthesis")}{toggle("delivery", "Allow delivery observations")}
      {field("intervalMinutes", "Refresh interval in minutes")}{field("dailyJobLimit", "Daily job limit")}
    </> : collection === "projects" ? <>{field("name", "Project name")}{field("description", "Description", true)}{choose("repositoryIds", "Repositories · choose from this workspace", repositoryChoices)}</>
      : collection === "features" ? <>{field("title", "Feature name")}{field("description", "Description", true)}{chooseOne("projectId", "Project", [{ id: "", label: "No project" }, ...projectChoices])}{chooseOne("status", "Owner assessment", ["planned", "active", "blocked", "completed", "cancelled", "failed"].map(value => ({ id: value, label: featureStatus(value as KnowledgeFeature["status"]) })))}{choose("repositoryIds", "Repositories", repositoryChoices)}{choose("workIds", "Related work records", workChoices)}{choose("componentIds", "Related components", componentChoices)}{field("sourceUrl", "Feature source URL")}</>
        : collection === "plans" ? <>{field("title", "Plan title")}{field("text", "Plan description", true)}{chooseOne("componentId", "Component", componentChoices)}{chooseOne("status", "Plan status", ["proposed", "accepted", "superseded"].map(value => ({ id: value, label: value === "accepted" ? "Accepted" : value === "superseded" ? "Superseded" : "Proposed" })))}{choose("repositoryIds", "Repositories", repositoryChoices)}{chooseOne("workId", "Related work record (optional)", [{ id: "", label: "None" }, ...workChoices])}{field("sourceUrl", "Plan source URL (optional)")}</>
          : <>{field("name", "Component name")}{field("description", "Description", true)}{choose("repositoryIds", "Repositories", repositoryChoices)}{toggle("pinned", "Pin component in the index")}{chooseOne("redirectTo", "Redirect after rename (optional)", [{ id: "", label: "None" }, ...componentChoices.filter(component => component.id !== id)])}</>}
    {locked ? <Text style={k.note}>This form is the exact draft awaiting retry or conflict resolution. Resolve the pending request above before editing it.</Text> : null}
    <View style={k.actions}><Button title={busy ? "Saving…" : "Save"} disabled={busy || locked} onPress={submit} /><Button secondary title="Cancel" disabled={busy || locked} onPress={onCancel} /></View>
  </View>;
}

function EvidenceClaim({ title, text, evidence }: { title: string; text: string; evidence: { repositoryId: string; source: string; line: number | null; text?: string }[] }) {
  return <View style={k.evidenceClaim}><Text style={k.label}>{title}</Text><Text selectable style={k.body}>{text}</Text>{evidence.map((item, i) => <EvidenceItem key={i} evidence={item} />)}</View>;
}
function EvidenceItem({ evidence }: { evidence: { repositoryId: string; source: string; line: number | null; text?: string } }) {
  return <Text selectable style={k.evidence}>{evidence.repositoryId ? `${evidence.repositoryId} · ` : ""}{evidence.source}{evidence.line === null ? "" : `:${evidence.line}`}{evidence.text ? ` · ${evidence.text}` : ""}</Text>;
}
function Coverage({ lines }: { lines: string[] }) { return lines.map((line, i) => <Text key={`${i}/${line}`} style={k.note}>Coverage · {line}</Text>); }
function SafeLink({ label, url }: { label: string; url: string }) {
  const open = () => { try { const parsed = new URL(url); if (parsed.protocol === "https:" && !parsed.username && !parsed.password) void Linking.openURL(parsed.toString()); } catch { /* malformed links remain text-only */ } };
  return <Pressable accessibilityRole="link" onPress={open}><Text style={k.link}>{label}</Text></Pressable>;
}
function confirmArchive(name: string, onConfirm: () => void) { Alert.alert(`Archive ${name}?`, "This hides the record from active lists and keeps its history.", [{ text: "Cancel", style: "cancel" }, { text: "Archive", style: "destructive", onPress: onConfirm }]); }
function editorTitle(collection: string, edit: boolean) { const label = collection === "policy" ? "maintenance policy" : collection.slice(0, -1); return `${edit ? "Edit" : "Create"} ${label}`; }
function split(value: string) { return value.split(",").map(item => item.trim()).filter(Boolean); }
function list(value: unknown) { return Array.isArray(value) ? value.join(", ") : ""; }
function date(value: string | null) { if (!value) return "not recorded"; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "not recorded" : parsed.toLocaleString(); }
function featureStatus(status: KnowledgeFeature["status"]) { return status.charAt(0).toUpperCase() + status.slice(1); }

const k = StyleSheet.create({
  componentDetail: { gap: 18 }, componentTitle: { fontSize: 22, fontWeight: "600", color: theme.colors.ink }, relationshipLink: { gap: 8, minHeight: 48, justifyContent: "center" }, disclosure: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.rule }, disclosureToggle: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12 }, disclosureTitle: { flex: 1, fontSize: 12, fontWeight: "600", color: theme.colors.ink },
  wrap: { gap: 12, marginTop: 14 }, areaTabs: { alignItems: "center", gap: 7, paddingRight: 4 }, areaTab: { minHeight: 36, justifyContent: "center", paddingHorizontal: 13, borderRadius: theme.radius.capsule, backgroundColor: theme.colors.secondarySurface }, areaSelected: { backgroundColor: theme.colors.white, ...theme.lift }, areaText: { fontSize: 12, fontWeight: "600", color: theme.colors.mutedInk }, areaTextSelected: { color: theme.colors.ink }, subtabs: { marginTop: 2 }, stack: { gap: 12 }, group: { gap: 8, paddingTop: 8 },
  intro: { fontSize: 12, lineHeight: 18, color: theme.colors.secondaryInk }, heading: { fontSize: 15, fontWeight: "700", color: theme.colors.ink }, sectionTitle: { fontSize: 14, fontWeight: "700", color: theme.colors.ink, marginTop: 5 }, label: { fontSize: 11, lineHeight: 16, fontWeight: "700", color: theme.colors.secondaryInk },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, card: { gap: 7, padding: 12, borderRadius: theme.radius.card, backgroundColor: theme.colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule }, title: { fontSize: 13, lineHeight: 18, fontWeight: "700", color: theme.colors.ink }, body: { fontSize: 12, lineHeight: 18, color: theme.colors.ink }, note: { fontSize: 11, lineHeight: 16, color: theme.colors.mutedInk }, meta: { fontSize: 10, lineHeight: 15, color: theme.colors.mutedInk }, evidence: { fontSize: 10, lineHeight: 15, color: theme.colors.secondaryInk }, link: { fontSize: 12, fontWeight: "600", color: theme.colors.forest, textDecorationLine: "underline" },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 4 }, componentRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 11, borderRadius: theme.radius.card, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule, backgroundColor: theme.colors.white }, selected: { borderColor: theme.colors.forest, backgroundColor: theme.colors.secondarySurface }, selectMark: { color: theme.colors.forest, fontSize: 11, fontWeight: "700" }, detail: { gap: 8, padding: 12, borderRadius: theme.radius.card, backgroundColor: theme.colors.secondarySurface }, plan: { gap: 5, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule }, edge: { gap: 4, padding: 8, borderRadius: theme.radius.card, backgroundColor: theme.colors.white }, evidenceClaim: { gap: 3, paddingVertical: 5 },
  graphEdge: { flexDirection: "row", alignItems: "center", gap: 4 }, graphNode: { flex: 1, minHeight: 38, justifyContent: "center", paddingHorizontal: 7, paddingVertical: 5, borderRadius: theme.radius.card, borderWidth: 1, borderColor: theme.colors.fieldRule, backgroundColor: theme.colors.secondarySurface }, graphNodeText: { fontSize: 10, lineHeight: 14, fontWeight: "600", color: theme.colors.ink, textAlign: "center" }, graphLink: { minWidth: 50, alignItems: "center", justifyContent: "center" }, graphLine: { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: theme.colors.fieldRule }, graphKind: { paddingHorizontal: 3, backgroundColor: theme.colors.white, fontSize: 8, color: theme.colors.secondaryInk }, graphArrow: { position: "absolute", right: -2, fontSize: 16, lineHeight: 16, color: theme.colors.forest },
  error: { borderRadius: theme.radius.card, padding: 10, backgroundColor: theme.colors.warningSurface }, errorText: { color: theme.colors.warningInk, fontSize: 12, lineHeight: 18 }, pending: { gap: 7, padding: 10, borderRadius: theme.radius.card, backgroundColor: theme.colors.warningSurface }, editor: { gap: 10, padding: 12, borderRadius: theme.radius.card, backgroundColor: theme.colors.secondarySurface }, inputGroup: { gap: 5 }, input: { minHeight: 42, paddingHorizontal: 10, paddingVertical: 8, borderRadius: theme.radius.card, color: theme.colors.ink, backgroundColor: theme.colors.white, borderWidth: 1, borderColor: theme.colors.fieldRule, fontSize: 13 }, inputLocked: { opacity: 0.8 }, multiline: { minHeight: 82, textAlignVertical: "top" }, chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, toggle: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 }, toggleCheck: { width: 24, color: theme.colors.forest, fontWeight: "700", fontSize: 18 },
});
