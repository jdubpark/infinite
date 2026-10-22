import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { BehaviorCheckResult, BehaviorModel, BehaviorPropertyResult, BehaviorTraceStep, KnowledgeBehavior, KnowledgeComponent } from "@infinite/remote";
import { ApiError, api, type Connection } from "../../api/client";
import { Button } from "../../components/Button";
import { Segmented, type SegmentOption } from "../../components/Glass";
import { theme } from "../../theme";

type ModelSide = "current" | "planned";
type PendingRun = { behaviorId: string; requestId: string; revision: number };
const sides: SegmentOption<ModelSide>[] = [{ value: "current", label: "Current" }, { value: "planned", label: "Planned" }];
const renderValue = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
const sortRuns = (runs: KnowledgeBehavior["runs"]) => [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

/** Renders finite-state model evidence for one component. Starting a check is always an explicit owner action. */
export function BehaviorPanel({ connection, workspaceId, componentId, currentSourceSnapshotId, currentSourceState, behaviors, canRun, onAccessDenied }: {
  connection: Connection; workspaceId: string; componentId: string; currentSourceSnapshotId: string; currentSourceState: KnowledgeComponent["current"]["state"];
  behaviors?: KnowledgeBehavior[]; canRun: boolean; onAccessDenied: () => void;
}) {
  const listed = useMemo(() => (behaviors ?? []).filter(item => item.definition.componentId === componentId), [behaviors, componentId]);
  const [selectedId, setSelectedId] = useState(() => listed[0]?.id ?? "");
  const [remoteBehavior, setRemoteBehavior] = useState<KnowledgeBehavior | null>(null);
  const [side, setSide] = useState<ModelSide>("current");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedPropertyId, setSelectedPropertyId] = useState("");
  const [traceIndex, setTraceIndex] = useState(0);
  const [focusedState, setFocusedState] = useState("");
  const [focusedTransition, setFocusedTransition] = useState("");
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingRuns, setPendingRuns] = useState<Record<string, PendingRun>>({});
  const readSequence = useRef(0);
  const revisionById = useRef(new Map<string, number>());
  const base = `/project-groups/${encodeURIComponent(workspaceId)}/understanding`;
  const activeId = listed.some(item => item.id === selectedId) ? selectedId : listed[0]?.id ?? "";
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const listedBehavior = listed.find(item => item.id === activeId) ?? null;
  const behavior = remoteBehavior?.id === activeId && (!listedBehavior || remoteBehavior.revision > listedBehavior.revision || (remoteBehavior.revision === listedBehavior.revision && remoteBehavior.updatedAt >= listedBehavior.updatedAt)) ? remoteBehavior : listedBehavior;

  const acceptBehavior = useCallback((next: KnowledgeBehavior) => {
    if (next.definition.componentId !== componentId) return;
    const previousRevision = revisionById.current.get(next.id);
    if (previousRevision !== undefined && previousRevision !== next.revision) {
      setSelectedRunId(""); setSelectedPropertyId(""); setTraceIndex(0); setFocusedState(""); setFocusedTransition("");
    }
    revisionById.current.set(next.id, next.revision);
    setRemoteBehavior(next);
  }, [componentId]);

  const refreshBehavior = useCallback(async (id: string, quiet = false) => {
    const sequence = ++readSequence.current;
    if (!quiet) { setLoading(true); setError(""); }
    try {
      const value = await api<KnowledgeBehavior>(connection, `${base}/behaviors/${encodeURIComponent(id)}`);
      if (sequence !== readSequence.current || id !== activeId) return;
      if (value.id !== id || value.definition.componentId !== componentId) throw new Error("This host returned behavior outside the selected component.");
      acceptBehavior(value);
      if (!value.runs.length) setSelectedRunId("");
      setError("");
    } catch (cause) {
      if (sequence !== readSequence.current || id !== activeId) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setRemoteBehavior(null); onAccessDenied(); return; }
      setError(cause instanceof Error ? cause.message : "Behavior details could not be loaded.");
    } finally { if (!quiet && sequence === readSequence.current) setLoading(false); }
  }, [acceptBehavior, activeId, base, componentId, connection, onAccessDenied]);

  useEffect(() => {
    if (!activeId) return;
    const id = activeId;
    readSequence.current++;
    void Promise.resolve().then(() => refreshBehavior(id));
  }, [activeId, refreshBehavior]);

  const isRunning = behavior?.status === "running" || behavior?.runs.some(run => run.state === "running") === true;
  useEffect(() => {
    if (!activeId || !isRunning) return;
    const timer = setInterval(() => { void refreshBehavior(activeId, true); }, 2000);
    return () => clearInterval(timer);
  }, [activeId, isRunning, refreshBehavior]);

  const runs = useMemo(() => sortRuns(behavior?.runs ?? []), [behavior?.runs]);
  const defaultRun = runs.filter(run => run.definitionRevision === behavior?.revision).at(-1) ?? runs.at(-1) ?? null;
  const selectedRun = runs.find(run => run.id === selectedRunId) ?? defaultRun;
  const pendingRun = pendingRuns[activeId] ?? null;
  const model: BehaviorModel | null = !behavior ? null : side === "current" ? behavior.definition.current : behavior.definition.planned;
  const check: BehaviorCheckResult | null = selectedRun ? selectedRun[side] : null;
  const modelHashSource = model ? canonicalJson(model) : "";
  const runCheckKey = selectedRun && check ? `${selectedRun.id}/${side}/${check.modelHash}/${modelHashSource}` : "";
  const [verifiedModelHash, setVerifiedModelHash] = useState<{ key: string; matches: boolean } | null>(null);
  useEffect(() => {
    if (!runCheckKey) return;
    let cancelled = false;
    void Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, modelHashSource)
      .then(hash => { if (!cancelled) setVerifiedModelHash({ key: runCheckKey, matches: hash === check?.modelHash }); })
      .catch(() => { if (!cancelled) setVerifiedModelHash({ key: runCheckKey, matches: false }); });
    return () => { cancelled = true; };
  }, [check?.modelHash, modelHashSource, runCheckKey]);
  const selectedRunDefinitionMatches = !selectedRun || selectedRun.definitionRevision === behavior?.revision;
  const modelHashMatches = !selectedRun || !check || (verifiedModelHash?.key === runCheckKey && verifiedModelHash.matches);
  const modelHashChecking = Boolean(selectedRun && check && verifiedModelHash?.key !== runCheckKey);
  const associationsAvailable = selectedRunDefinitionMatches && modelHashMatches;
  const propertyResults = check?.properties ?? [];
  const activePropertyId = associationsAvailable
    ? model?.properties.some(item => item.id === selectedPropertyId) ? selectedPropertyId : model?.properties[0]?.id ?? ""
    : propertyResults.some(item => item.id === selectedPropertyId) ? selectedPropertyId : propertyResults[0]?.id ?? "";
  const property = associationsAvailable ? model?.properties.find(item => item.id === activePropertyId) ?? model?.properties[0] ?? null : null;
  const outcome: BehaviorPropertyResult | undefined = propertyResults.find(item => item.id === activePropertyId);
  const trace: BehaviorTraceStep[] = outcome?.trace ?? [];
  const activeTraceIndex = Math.min(traceIndex, Math.max(0, trace.length - 1));
  const step = trace.length ? trace[activeTraceIndex]! : null;
  const activeState = step?.state ?? focusedState;
  const activeTransition = step?.transitionId ?? focusedTransition;
  const stale = behavior?.freshness !== "current";
  const sourceFreshness = !currentSourceSnapshotId || currentSourceState === "unavailable" ? "unavailable"
    : currentSourceState === "stale" || behavior?.definition.sourceSnapshotId !== currentSourceSnapshotId ? "stale"
      : "current";

  const selectBehavior = (id: string) => {
    if (id === activeId) { if (selectedId !== id) setSelectedId(id); return; }
    readSequence.current++; setSelectedId(id); setRemoteBehavior(null); setError(""); setSide("current");
    setSelectedRunId(""); setSelectedPropertyId(""); setTraceIndex(0); setFocusedState(""); setFocusedTransition("");
  };
  const sendRun = async (request: PendingRun) => {
    if (!behavior || behavior.id !== request.behaviorId || busy) return;
    setBusy(true); setError("");
    try {
      const value = await api<KnowledgeBehavior>(connection, `${base}/behaviors/${encodeURIComponent(request.behaviorId)}/run`, { method: "POST", body: { requestId: request.requestId, revision: request.revision } });
      if (value.id !== request.behaviorId || value.definition.componentId !== componentId) throw new Error("The host returned a behavior outside the selected component.");
      acceptBehavior(value);
      setPendingRuns(existing => { const next = { ...existing }; delete next[request.behaviorId]; return next; });
      if (activeIdRef.current === request.behaviorId) {
        setSelectedRunId(""); setSelectedPropertyId(""); setTraceIndex(0); setFocusedState(""); setFocusedTransition("");
        setError("Check accepted. Results are model evidence and do not prove implementation behavior.");
      }
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        setPendingRuns(existing => { const next = { ...existing }; delete next[request.behaviorId]; return next; });
        if (activeIdRef.current === request.behaviorId) setRemoteBehavior(null);
        onAccessDenied();
      }
      else if (cause instanceof ApiError && cause.status === 0) {
        setPendingRuns(existing => ({ ...existing, [request.behaviorId]: request }));
        if (activeIdRef.current === request.behaviorId) setError("Delivery is uncertain. Retry sends the same request ID and revision; polling never starts another check.");
      } else if (cause instanceof ApiError && cause.status === 409) {
        setPendingRuns(existing => { const next = { ...existing }; delete next[request.behaviorId]; return next; });
        if (activeIdRef.current === request.behaviorId) {
          setError("The definition revision changed. The latest definition is being loaded; press Run check to send a new explicit request.");
          await refreshBehavior(request.behaviorId);
        }
      } else {
        setPendingRuns(existing => { const next = { ...existing }; delete next[request.behaviorId]; return next; });
        if (activeIdRef.current === request.behaviorId) setError(cause instanceof Error ? cause.message : "The check could not be requested.");
      }
    } finally { setBusy(false); }
  };
  const run = () => {
    if (!behavior || !canRun || stale || busy || pendingRun) return;
    const request = { behaviorId: behavior.id, requestId: Crypto.randomUUID(), revision: behavior.revision };
    setPendingRuns(existing => ({ ...existing, [behavior.id]: request }));
    void sendRun(request);
  };

  if (!listed.length) return <View style={b.section}><Text style={b.heading}>Behavior checks</Text><Text style={b.note}>No behavior definition is linked to this component. Add a source-linked definition with the CLI, then reload component knowledge.</Text></View>;
  return <View style={b.section}>
    <View style={b.headingRow}><Text style={b.heading}>Behavior checks · {listed.length}</Text>{loading ? <ActivityIndicator color={theme.colors.forest} accessibilityLabel="Loading behavior" /> : null}</View>
    {listed.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={b.choices} accessibilityRole="tablist">
      {listed.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: activeId === item.id }} onPress={() => selectBehavior(item.id)} style={[b.choice, activeId === item.id && b.choiceSelected]}>
        <Text style={[b.choiceText, activeId === item.id && b.choiceTextSelected]}>{item.definition.title} · r{item.revision}</Text>
      </Pressable>)}
    </ScrollView> : null}
    {behavior ? <>
      <View style={b.card}>
        <Text style={b.title}>{behavior.definition.title} · latest result {statusLabel(behavior.status)}</Text>
        <Text style={b.meta}>Source snapshot freshness · {sourceFreshness} · current {currentSourceSnapshotId || "unavailable"}</Text>
        <Text style={b.meta}>Behavior/check freshness · {behavior.freshness}</Text>
        <Text style={b.meta}>Source snapshot {behavior.definition.sourceSnapshotId} · requirement revision {behavior.definition.requirementRevision}</Text>
        <Text style={b.meta}>Plan revisions · {behavior.definition.planRevisions.map(item => `${item.id} r${item.revision}`).join(", ") || "none"}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: sourcesExpanded }} onPress={() => setSourcesExpanded(value => !value)}>
          <Text style={b.meta}>{sourcesExpanded ? "Hide" : "Show"} captured source fingerprints · {behavior.sources.length} files</Text>
        </Pressable>
        {sourcesExpanded ? behavior.sources.map((source, i) => <Text selectable key={`${source.repositoryId}/${source.path}/${i}`} style={b.evidence}>Source · {source.repositoryId} / {source.path}:{source.lines} · fingerprint {source.hash}</Text>) : null}
        {behavior.definition.assumptions.map((item, i) => <Text key={`assumption-${i}`} style={b.note}>Assumption · {item}</Text>)}
        {behavior.definition.exclusions.map((item, i) => <Text key={`exclusion-${i}`} style={b.note}>Exclusion · {item}</Text>)}
        {sourceFreshness !== "current" ? <Text style={b.warning}>The behavior definition’s source snapshot does not match current component evidence.</Text> : null}
        {stale ? <Text style={b.warning}>The host marks this behavior or its latest result stale or unavailable; review the selected run and captured plan revisions before running another check.</Text> : null}
      </View>
      <Segmented options={sides.filter(option => option.value === "current" || behavior.definition.planned !== null || Boolean(selectedRun?.planned))} value={side} onChange={value => { setSide(value); setSelectedPropertyId(""); setTraceIndex(0); setFocusedState(""); setFocusedTransition(""); }} style={b.sides} />
      <Text style={b.note}>{side === "current" ? "Current source model" : "Planned model"} · finite-state model evidence only; a passing result is not proof that code implements the model.</Text>
      <View style={b.actions}>
        {pendingRun ? <Button compact title={busy ? "Sending…" : "Retry same check request"} disabled={busy || !canRun} onPress={() => void sendRun(pendingRun)} /> : <Button compact title={busy ? "Starting…" : "Run check"} disabled={!canRun || busy || stale} onPress={run} />}
        {!canRun ? <Text style={b.meta}>Owner access and a verified connection are required to start a check.</Text> : null}
        {stale ? <Text style={b.meta}>Refresh this component’s source evidence before running a new check.</Text> : null}
      </View>
      {error ? <View accessibilityRole="alert" style={error.startsWith("Check accepted") ? b.notice : b.warning}><Text style={b.note}>{error}</Text></View> : null}
      {runs.length ? <View style={b.card}>
        <Text style={b.label}>Recorded runs · select a prior trace</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={b.choices}>
          {runs.map((item, index) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Select run ${index + 1}, ${item.state}`} accessibilityState={{ selected: selectedRun?.id === item.id }} onPress={() => { setSelectedRunId(item.id); setSelectedPropertyId(""); setTraceIndex(0); setFocusedState(""); setFocusedTransition(""); }} style={[b.choice, selectedRun?.id === item.id && b.choiceSelected]}>
            <Text style={[b.choiceText, selectedRun?.id === item.id && b.choiceTextSelected]}>Run {index + 1} · {item.state}</Text>
          </Pressable>)}
        </ScrollView>
      </View> : <Text style={b.note}>Unchecked · no recorded model-check run. Run check is an explicit owner action.</Text>}
      {selectedRun ? <View style={b.card}>
        <Text style={b.meta}>Selected run · {selectedRun.id} · definition revision {selectedRun.definitionRevision} · {selectedRun.startedAt}</Text>
        <Text selectable style={b.evidence}>Definition fingerprint · {selectedRun.definitionHash}</Text>
      </View> : null}
      {!selectedRunDefinitionMatches ? <Text style={b.warning}>This trace belongs to definition revision {selectedRun?.definitionRevision}; the active definition is revision {behavior.revision}. The ordered trace remains available as raw run evidence. The current graph and property basis are hidden because they may describe a different model. Current source freshness above belongs to the active definition.</Text>
        : modelHashChecking ? <Text style={b.note}>Checking the selected run’s model identity before associating its result with the current graph.</Text>
          : !modelHashMatches ? <Text style={b.warning}>The selected result’s model hash does not match the active {side} model. The ordered trace remains available as raw run evidence; the graph and property basis are hidden.</Text> : null}
      {model && associationsAvailable && model.properties.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={b.choices} accessibilityRole="tablist">
        {model.properties.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: property?.id === item.id }} onPress={() => { setSelectedPropertyId(item.id); setTraceIndex(0); }} style={[b.choice, property?.id === item.id && b.choiceSelected]}>
          <Text style={[b.choiceText, property?.id === item.id && b.choiceTextSelected]}>{item.basis} · {item.title}</Text>
        </Pressable>)}
      </ScrollView> : null}
      {!associationsAvailable && propertyResults.length ? <View style={b.card}>
        <Text style={b.label}>Historical property results · select a raw result to replay</Text>
        {propertyResults.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: activePropertyId === item.id }} onPress={() => { setSelectedPropertyId(item.id); setTraceIndex(0); }} style={[b.choice, activePropertyId === item.id && b.choiceSelected]}>
          <Text style={[b.choiceText, activePropertyId === item.id && b.choiceTextSelected]}>{item.id} · {item.status}</Text>
        </Pressable>)}
      </View> : null}
      {property ? <View style={b.card}>
        <Text style={b.label}>Property · {property.basis === "accepted" ? "Accepted requirement" : "Proposed requirement"} · {property.kind}</Text>
        <Text style={b.title}>{property.title}</Text>
        <Text selectable style={b.body}>{property.requirement}</Text>
        {property.evidence.map((source, i) => <Text selectable key={`property-source-${i}`} style={b.evidence}>{source.repositoryId} · {source.source}{source.line === null ? "" : `:${source.line}`}{source.text ? ` · ${source.text}` : ""}</Text>)}
        <Text style={b.meta}>Property result · {outcome?.status ?? (check ? "no result returned" : check === null && selectedRun ? "running" : "unchecked")}</Text>
        {outcome?.reachableStates !== undefined ? <Text style={b.meta}>Reachable states · {outcome.reachableStates}</Text> : null}
      </View> : <Text style={b.note}>No properties are defined for this model.</Text>}
      {check ? <View style={b.card}>
        <Text style={b.label}>Checker result · {check.status} · {check.exhaustive ? "exhaustive" : "bounded"}</Text>
        <Text style={b.meta}>{check.exploredStates} states · {check.exploredTransitions} transitions · {check.tool} {check.toolVersion} · checked {check.checkedAt}</Text>
        <Text style={b.meta}>Limits · {check.limits.maxStates} states · {check.limits.maxTransitions} transitions · {check.limits.timeoutMs} ms · {check.limits.maxTraceSteps} trace steps</Text>
        {check.message ? <Text selectable style={b.note}>{check.message}</Text> : null}
        {propertyResults.map(item => {
          const definition = associationsAvailable ? model?.properties.find(candidate => candidate.id === item.id) : undefined;
          return <Text key={item.id} style={b.meta}>{definition ? `${definition.basis} · ${definition.title}` : `Historical property · ${item.id}`} · {item.status}</Text>;
        })}
      </View> : null}
      {outcome?.trace.length ? <TraceReplay trace={trace} traceIndex={activeTraceIndex} setTraceIndex={setTraceIndex} setFocusedState={setFocusedState} setFocusedTransition={setFocusedTransition} canFocus={associationsAvailable} truncated={outcome.traceTruncated} /> : outcome?.status === "failed" ? <Text style={b.warning}>The checker reported a counterexample but did not return its bounded trace.</Text> : null}
      {model && associationsAvailable ? <ModelDiagram model={model} check={check} activeState={activeState} activeTransition={activeTransition} focusedState={setFocusedState} focusedTransition={setFocusedTransition} />
        : !model && selectedRun?.planned == null ? <Text style={b.note}>No planned model is recorded.</Text> : null}
      {behavior.coverage.map((line, i) => <Text key={`coverage-${i}`} style={b.note}>Coverage · {line}</Text>)}
    </> : <Text style={b.note}>Loading behavior details…</Text>}
    <Text style={b.note}>Create or revise behavior definitions from source references and recorded requirements with the CLI or an agent; the phone view keeps model evidence readable and replayable.</Text>
  </View>;
}

function ModelDiagram({ model, check, activeState, activeTransition, focusedState, focusedTransition }: {
  model: BehaviorModel; check: BehaviorCheckResult | null; activeState: string; activeTransition: string; focusedState: (id: string) => void; focusedTransition: (id: string) => void;
}) {
  return <View style={b.card}>
    <Text style={b.label}>State and transition diagram · initial {model.initial}</Text>
    <View style={b.nodes}>
      {model.states.map(state => <Pressable key={state.id} accessibilityRole="button" accessibilityLabel={`Focus state ${state.label}`} accessibilityState={{ selected: state.id === activeState }} onPress={() => focusedState(state.id)} style={[b.node, state.id === model.initial && b.initialNode, state.id === activeState && b.activeNode]}>
        <Text style={b.nodeText}>{state.label}</Text><Text style={b.meta}>{state.id}{state.id === model.initial ? " · initial" : ""}</Text>
      </Pressable>)}
    </View>
    <Text style={b.label}>Transitions · tap an edge to focus it</Text>
    {model.transitions.map(edge => <View key={edge.id} style={[b.edge, edge.id === activeTransition && b.activeEdge]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${edge.from} to ${edge.to}, ${edge.label}`} accessibilityState={{ selected: edge.id === activeTransition }} onPress={() => focusedTransition(edge.id)}>
        <View style={b.edgeGraph}>
          <Text numberOfLines={2} style={b.edgeNode}>{model.states.find(state => state.id === edge.from)?.label ?? edge.from}</Text>
          <View style={b.arrowArea}><Text numberOfLines={1} style={b.edgeLabel}>{edge.label || edge.event}</Text><Text style={b.arrow}>→</Text></View>
          <Text numberOfLines={2} style={b.edgeNode}>{model.states.find(state => state.id === edge.to)?.label ?? edge.to}</Text>
        </View>
        <Text style={b.meta}>{edge.id} · {edge.actor} · {edge.event} · guard {JSON.stringify(edge.guard)}</Text>
        {Object.keys(edge.effects).length ? <Text style={b.meta}>Effects · {Object.entries(edge.effects).map(([key, value]) => `${key}=${"variable" in value ? `$${value.variable}` : renderValue(value.value)}`).join(", ")}</Text> : null}
      </Pressable>
      <EvidenceDisclosure label="Transition evidence" sources={edge.evidence.map(source => `${source.repositoryId} · ${source.source}${source.line === null ? "" : `:${source.line}`}${source.text ? ` · ${source.text}` : ""}`)} />
    </View>)}
    {!model.transitions.length ? <Text style={b.note}>No transitions are defined.</Text> : null}
    {model.variables.map(variable => <Text key={variable.id} style={b.meta}>Variable {variable.id} · initial {renderValue(variable.initial)} · domain {variable.domain.map(renderValue).join(", ")}</Text>)}
    {check ? <Text style={b.meta}>Diagram belongs to the {check.status} model result selected above.</Text> : null}
  </View>;
}

function EvidenceDisclosure({ label, sources }: { label: string; sources: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!sources.length) return null;
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}>
      <Text style={b.meta}>{expanded ? "Hide" : "Show"} {label.toLowerCase()} · {sources.length}</Text>
    </Pressable>
    {expanded ? sources.map((source, index) => <Text selectable key={index} style={b.evidence}>{source}</Text>) : null}
  </View>;
}

function TraceReplay({ trace, traceIndex, setTraceIndex, setFocusedState, setFocusedTransition, canFocus, truncated }: {
  trace: BehaviorTraceStep[]; traceIndex: number; setTraceIndex: (value: number | ((previous: number) => number)) => void; setFocusedState: (id: string) => void; setFocusedTransition: (id: string) => void; canFocus: boolean; truncated: boolean;
}) {
  const step = trace[traceIndex]!;
  return <View style={b.card}>
    <Text style={b.label}>Ordered counterexample replay {truncated ? "· trace truncated" : ""}</Text>
    <View style={b.actions}>
      <Button compact secondary title="Previous step" disabled={traceIndex <= 0} onPress={() => setTraceIndex(index => Math.max(0, index - 1))} />
      <Text style={b.meta}>Step {traceIndex + 1} of {trace.length}</Text>
      <Button compact secondary title="Next step" disabled={traceIndex >= trace.length - 1} onPress={() => setTraceIndex(index => Math.min(trace.length - 1, index + 1))} />
    </View>
    <View style={[b.node, b.activeNode]}><Text style={b.nodeText}>{step.state}</Text><Text style={b.meta}>Active state · {step.state}</Text></View>
    {step.transitionId && canFocus ? <Pressable accessibilityRole="button" onPress={() => setFocusedTransition(step.transitionId!)} style={[b.edge, b.activeEdge]}>
      <Text style={b.title}>Active transition · {step.transitionId}</Text><Text style={b.body}>{step.summary}</Text>
    </Pressable> : step.transitionId ? <Text style={b.meta}>Historical transition · {step.transitionId}</Text> : <Text style={b.meta}>Initial state</Text>}
    <Text style={b.body}>{step.summary}</Text>
    {Object.entries(step.values).sort(([a], [z]) => a.localeCompare(z)).map(([key, value]) => <Text key={key} style={b.evidence}>{key} = {renderValue(value)}</Text>)}
    {step.transitionId && canFocus ? <Button compact secondary title="Focus active state" onPress={() => setFocusedState(step.state)} /> : null}
  </View>;
}

function statusLabel(status: KnowledgeBehavior["status"]): string {
  if (status === "stale") return "stale";
  if (status === "unchecked") return "Unchecked";
  if (status === "running") return "Running";
  if (status === "inconclusive") return "Inconclusive";
  return status;
}

const b = StyleSheet.create({
  section: { gap: 10, paddingTop: 8 }, headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, heading: { fontSize: 15, lineHeight: 21, fontWeight: "700", color: theme.colors.secondaryInk },
  choices: { alignItems: "center", gap: 6, paddingVertical: 2 }, choice: { minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderRadius: theme.radius.card, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.fieldRule, backgroundColor: theme.colors.white }, choiceSelected: { borderColor: theme.colors.forest, backgroundColor: theme.colors.secondarySurface }, choiceText: { fontSize: 11, color: theme.colors.ink }, choiceTextSelected: { color: theme.colors.forest, fontWeight: "700" },
  card: { gap: 7, padding: 12, borderRadius: theme.radius.card, backgroundColor: theme.colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule }, label: { fontSize: 11, lineHeight: 16, fontWeight: "700", color: theme.colors.secondaryInk }, title: { fontSize: 13, lineHeight: 18, fontWeight: "700", color: theme.colors.ink }, body: { fontSize: 12, lineHeight: 18, color: theme.colors.ink }, note: { fontSize: 11, lineHeight: 16, color: theme.colors.mutedInk }, meta: { fontSize: 10, lineHeight: 15, color: theme.colors.mutedInk }, evidence: { fontSize: 10, lineHeight: 15, color: theme.colors.secondaryInk },
  sides: { alignSelf: "flex-start" }, actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }, warning: { gap: 4, padding: 9, borderRadius: theme.radius.card, backgroundColor: theme.colors.warningSurface }, notice: { padding: 9, borderRadius: theme.radius.card, backgroundColor: theme.colors.secondarySurface },
  nodes: { flexDirection: "row", flexWrap: "wrap", gap: 7 }, node: { minWidth: 110, maxWidth: "100%", flexGrow: 1, gap: 3, alignItems: "center", paddingHorizontal: 9, paddingVertical: 8, borderRadius: theme.radius.card, borderWidth: 1, borderColor: theme.colors.fieldRule, backgroundColor: theme.colors.secondarySurface }, initialNode: { borderColor: theme.colors.forest }, activeNode: { borderColor: theme.colors.forest, backgroundColor: theme.colors.warningSurface }, nodeText: { fontSize: 11, lineHeight: 15, fontWeight: "700", color: theme.colors.ink, textAlign: "center" },
  edge: { gap: 5, padding: 8, borderRadius: theme.radius.card, backgroundColor: theme.colors.secondarySurface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule }, activeEdge: { borderColor: theme.colors.forest, backgroundColor: theme.colors.warningSurface }, edgeGraph: { flexDirection: "row", alignItems: "center", gap: 4 }, edgeNode: { flex: 1, minHeight: 34, textAlignVertical: "center", textAlign: "center", paddingHorizontal: 5, paddingVertical: 4, borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.card, color: theme.colors.ink, fontSize: 10, fontWeight: "600" }, arrowArea: { minWidth: 48, alignItems: "center", justifyContent: "center" }, edgeLabel: { maxWidth: 88, fontSize: 8, color: theme.colors.secondaryInk }, arrow: { color: theme.colors.forest, fontSize: 17, lineHeight: 18, fontWeight: "700" },
});
