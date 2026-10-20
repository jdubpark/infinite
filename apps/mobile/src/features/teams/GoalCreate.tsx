import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { api, ApiError, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { FloatingNotice } from "../../components/FloatingNotice";
import { TopBar } from "../../components/Glass";
import { goalCreations } from "../../store/requests";
import { theme } from "../../theme";
import { DictationNotice, MicButton } from "../../dictation/DictationControls";
import { useDictation, type Dictation } from "../../dictation/useDictation";
import { lines, teamReady, type ProductGoal } from "./model";
import { Choices, Disclosure, LineupView, t } from "./parts";

const inFlight = new Set<string>();
const LIMITS = [
  { key: "maxRuns", label: "Maximum cycles", min: 1, max: 10, initial: 3 },
  { key: "maxMinutes", label: "Time limit (minutes)", min: 5, max: 1440, initial: 60 },
  { key: "maxMembers", label: "Maximum agent members", min: 4, max: 200, initial: 24 },
  { key: "parallelism", label: "Worker limit", min: 1, max: 4, initial: 3 },
] as const;
type LimitKey = (typeof LIMITS)[number]["key"];

/** Starts a product goal. Starting it authorizes work within the scope and limits given here. */
export function GoalCreate({ connection }: { connection: Connection }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const creation = goalCreations.use(machine);
  const pending = creation.pending;
  const { data: me, online, stale, refresh } = usePoll(() => api<Me>(connection, "/me"), 5000, [connection]);
  const projects = me?.projects ?? [];
  const [project, setProject] = useState(pending?.projectId);
  const [linearIssueId, setLinearIssueId] = useState(pending?.linearIssueId ?? "");
  const [title, setTitle] = useState(pending?.title ?? "");
  const [objective, setObjective] = useState(pending?.objective ?? "");
  const [successCriteria, setSuccessCriteria] = useState(pending?.successCriteria ?? "");
  const [allowedPaths, setAllowedPaths] = useState(pending?.allowedPaths.join("\n") ?? ".");
  const [nonGoals, setNonGoals] = useState(pending?.nonGoals.join("\n") ?? "");
  const [evidence, setEvidence] = useState(pending?.evidence.join("\n") ?? "");
  const [limits, setLimits] = useState<Record<LimitKey, string>>(() => Object.fromEntries(LIMITS.map(limit => [limit.key, String(pending?.[limit.key] ?? limit.initial)])) as Record<LimitKey, string>);
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A send started before this screen remounted is still in flight; its result re-renders through the store.
  const busy = sending || Boolean(pending && inFlight.has(pending.requestId));
  const projectId = projects.some(value => value.id === project) ? project! : (projects.find(teamReady) ?? projects[0])?.id;
  const selectedProject = projects.find(value => value.id === projectId);
  const locked = busy || Boolean(pending) || me?.role !== "owner";
  const ready = Boolean(me?.goals?.enabled && me.teams?.lineup && teamReady(selectedProject));
  const complete = Boolean(objective.trim() && successCriteria.trim() && allowedPaths.trim());
  const allowed = online && me?.role === "owner" && (Boolean(pending) || (ready && complete));
  const dictation = useDictation({ connection, value: objective, onChange: setObjective, maxLength: 12000, disabled: locked });
  async function submit() {
    if (busy || !allowed) return;
    setError("");
    let request = pending;
    setRetrying(Boolean(pending));
    // A retry resends the recorded request even if this host's settings have changed since.
    if (!request) {
      if (!projectId) return;
      const values = Object.fromEntries(LIMITS.map(limit => [limit.key, Number(limits[limit.key])])) as Record<LimitKey, number>;
      const outside = LIMITS.find(limit => !Number.isInteger(values[limit.key]) || values[limit.key] < limit.min || values[limit.key] > limit.max);
      if (outside) return setError(`${outside.label} must be a whole number from ${outside.min} to ${outside.max}.`);
      const nonGoalEntries = lines(nonGoals), pathEntries = lines(allowedPaths), evidenceEntries = lines(evidence);
      if (nonGoalEntries.length > 20 || evidenceEntries.length > 20 || pathEntries.length > 32 || nonGoalEntries.some(value => value.length > 1000) || pathEntries.some(value => value.length > 300) || evidenceEntries.some(value => value.length > 2000))
        return setError("Use up to 20 non-goals (1,000 characters each), 20 evidence entries (2,000 each), and 32 paths (300 each).");
      request = goalCreations.begin(machine, {
        requestId: Crypto.randomUUID(), projectId, title: title.trim() || objective.trim().split("\n")[0].slice(0, 100),
        ...(selectedProject?.linear?.enabled && linearIssueId.trim() ? { linearIssueId: linearIssueId.trim() } : {}),
        objective: objective.trim(), successCriteria: successCriteria.trim(), nonGoals: nonGoalEntries, allowedPaths: pathEntries, evidence: evidenceEntries, ...values,
      });
    }
    if (inFlight.has(request.requestId)) return;
    inFlight.add(request.requestId);
    setSending(true);
    try {
      const goal = await api<ProductGoal>(connection, "/goals", { body: request });
      if (goalCreations.complete(machine, request.requestId, { id: goal.id }) && mounted.current) router.replace({ pathname: "/goal/[id]", params: { id: goal.id, machine } });
    } catch (failure) {
      const rejected = failure instanceof ApiError && failure.status >= 400 && failure.status < 500;
      goalCreations.fail(machine, request.requestId, `${(failure as Error).message}${rejected ? " Correct the goal and try again." : " Delivery is unconfirmed. Check Goals or retry the same request."}`, rejected);
    } finally { inFlight.delete(request.requestId); if (mounted.current) setSending(false); }
  }
  const field = (label: string, value: string, change: (text: string) => void, options: { placeholder?: string; multiline?: boolean; maxLength?: number; note?: string; literal?: boolean; dictation?: Dictation } = {}) => <>
    {options.dictation ? <View style={s.labelRow}>
      <Text style={[t.label, s.labelText]}>{label}</Text>
      <MicButton dictation={options.dictation} size={36} disabled={locked} />
    </View> : <Text style={t.label}>{label}</Text>}
    <TextInput accessibilityLabel={label} value={value} onChangeText={change} editable={!locked} multiline={options.multiline} maxLength={options.maxLength}
      autoCapitalize={options.literal ? "none" : undefined} autoCorrect={!options.literal}
      placeholder={options.placeholder} placeholderTextColor={theme.colors.placeholder} style={[t.input, options.multiline && t.multiline]} />
    {options.note ? <Text style={t.note}>{options.note}</Text> : null}
  </>;
  return <KeyboardAvoidingView style={[s.fill, s.overlayRoot]} behavior="padding">
    <TopBar backLabel="Goals" onBack={() => router.canGoBack() ? router.back() : router.replace({ pathname: "/", params: { machine, view: "goals" } })} right={<Text style={t.note} numberOfLines={1}>{connection.label || "Selected machine"}</Text>} />
    <FloatingNotice position="top" offset={58} message={stale ? me ? "Waiting for a fresh machine connection." : "Can't reach this machine." : null} actions={stale ? <Button compact title="Refresh" secondary onPress={refresh} /> : null} />
    <DictationNotice dictation={dictation} position="top" offset={110} />
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>New goal</Text>
      <Text style={t.note}>Give the team an outcome and the evidence it should use. Agents choose scoped improvements and build reviewed cycles within these limits.</Text>
      {me && me.role !== "owner" ? <Text style={t.warning}>An owner key is required to start a goal.</Text> : null}
      {me && (!me.goals?.enabled || !me.teams?.lineup) ? <Text style={t.warning}>Goals need a configured team lineup with strong coordinator and reviewer profiles.</Text> : null}
      {creation.result ? <View style={s.section}><Text style={t.note}>Goal started.</Text><Button title="Open goal" onPress={() => router.replace({ pathname: "/goal/[id]", params: { id: creation.result!.id, machine } })} /></View> : null}
      {field("Desired outcome", objective, setObjective, { multiline: true, maxLength: 12000, dictation, placeholder: "Describe what should improve for the people using this product…" })}
      {field("Success criteria", successCriteria, setSuccessCriteria, { multiline: true, maxLength: 4000, placeholder: "What evidence would show the goal was achieved?" })}
      {field("Goal name (optional)", title, setTitle, { maxLength: 100, placeholder: "Uses the first line of the outcome" })}
      <Text style={t.label}>Workspace</Text>
      <Choices values={projects.map(value => value.id)} selected={projectId} disabled={locked} onSelect={value => { setProject(value); setLinearIssueId(""); }}
        label={value => { const item = projects.find(candidate => candidate.id === value)!; return teamReady(item) ? item.name : `${item.name} · setup required`; }} />
      {selectedProject && !teamReady(selectedProject) ? <Text style={t.warning}>Select a workspace with required team checks.</Text> : null}
      {selectedProject?.team?.establishChecks ? <Text style={t.note}>The first team will establish build and test commands; later cycles keep the same commands.</Text> : null}
      {selectedProject?.linear?.enabled ? field("Existing Linear issue (optional)", linearIssueId, setLinearIssueId, { maxLength: 100, literal: true, placeholder: "Issue identifier or UUID", note: "Leave empty to create a goal issue. Each cycle gets a child issue; workflow states stay under your control." }) : null}
      {field("Allowed files and folders", allowedPaths, setAllowedPaths, { multiline: true, literal: true, note: "One repository-relative path per line. A single dot (.) allows changes across the entire project." })}
      {field("Non-goals (optional)", nonGoals, setNonGoals, { multiline: true, placeholder: "What should the team leave out? One per line." })}
      {field("Evidence and context (optional)", evidence, setEvidence, { multiline: true, placeholder: "One link, repository reference, or observation per line." })}
      <Text style={[t.label, s.limitsHeading]}>Work limits</Text>
      {LIMITS.map(limit => <View key={limit.key} style={s.limit}>
        <Text style={[t.body, s.fill]}>{limit.label} <Text style={t.note}>{limit.min}–{limit.max}</Text></Text>
        <TextInput accessibilityLabel={limit.label} value={limits[limit.key]} onChangeText={value => setLimits(previous => ({ ...previous, [limit.key]: value.replace(/[^0-9]/g, "") }))}
          editable={!locked} keyboardType="number-pad" maxLength={4} style={[t.input, s.number]} />
      </View>)}
      <Text style={t.note}>Limits cover the whole goal. The deadline starts when the host accepts it; pausing does not extend it.</Text>
      <Text style={t.note}>The team starts a worker when a task is ready and stops it when the task is done, up to this limit. You can change the limit while the goal runs; a change applies to the active cycle and later cycles.</Text>
      {me?.teams?.lineup ? <Disclosure title="Configured agents and data use">
        <Text style={t.note}>The host records these requested settings when the goal starts. Provider policy may override them.</Text>
        <LineupView lineup={me.teams.lineup} />
      </Disclosure> : null}
      <Text style={t.note}>Review the team’s results. Delivery follows each repository’s policy. Provider permissions remain in force.</Text>
      {error || creation.message ? <Text accessibilityRole="alert" style={t.warning}>{error || creation.message}</Text> : null}
      <View style={s.section}><Button busy={busy} title={pending && (!busy || retrying) ? "Retry same request" : "Start goal"} disabled={busy || !allowed} onPress={() => void submit()} /></View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  overlayRoot: { position: "relative" },
  body: { padding: 24, gap: 10, paddingBottom: 48 },
  title: { fontSize: 28, lineHeight: 34, color: theme.colors.ink, fontWeight: "700", letterSpacing: -0.6 },
  section: { marginVertical: 16, gap: 12 },
  limitsHeading: { fontSize: 16, marginTop: 24 },
  limit: { flexDirection: "row", alignItems: "center", gap: 12 },
  number: { width: 88, textAlign: "right" },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12 },
  labelText: { marginTop: 0 },
});
