import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { PROVIDER_NAMES } from "@infinite/attention";
import { ago, api, ApiError, connectionKey, pendingLabel, type Connection, type Me, type ProjectDetail, type SessionRow } from "../../api/client";
import { creations } from "../../store/requests";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { TopBar } from "../../components/Glass";
import { FloatingNotice } from "../../components/FloatingNotice";
import { theme } from "../../theme";

export function Create({ connection }: { connection: Connection }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const creation = creations.use(machine);
  const request = creation.pending;
  const [backend, setBackend] = useState<"infinite" | "cmux">(request?.backend ?? "infinite");
  const [provider, setProvider] = useState<string | undefined>(request?.provider);
  const [project, setProject] = useState(request?.projectId ?? "");
  const [title, setTitle] = useState(request?.title ?? "");
  const [prompt, setPrompt] = useState(request?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { data: me, online, stale, refresh } = usePoll(() => api<Me>(connection, "/me"), 4000, [connection]);
  const providers = me?.backendProviders?.[backend] ?? (backend === "infinite" ? me?.providers ?? [] : []);
  const selectedProvider = providers.find(value => value === provider) ?? providers[0];
  const projects = me?.projects ?? [];
  const selectedProject = projects.some(item => item.id === project) ? project : projects[0]?.id;
  // Only a cloud host receives laptop sync; a local host is the laptop.
  const syncs = me?.environment === "cloud";
  const { data: polledDetail, refresh: refreshDetail } = usePoll(() => syncs && selectedProject ? api<ProjectDetail>(connection, `/projects/${selectedProject}`) : Promise.resolve(null), 5000, [connection, selectedProject, syncs]);
  // Keep displaying the poll's previous project until the selected project's value arrives.
  const detail = syncs && polledDetail?.id === selectedProject ? polledDetail : null;
  const displayDetail = syncs ? polledDetail : null;
  const [applying, setApplying] = useState(false);
  const [syncError, setSyncError] = useState("");
  async function applyPending(force: boolean) {
    if (!selectedProject || applying) return;
    setApplying(true);
    setSyncError("");
    try { await api(connection, `/projects/${selectedProject}/sync/apply`, { body: force ? { force } : {} }); }
    catch (error) { if (mounted.current) setSyncError((error as Error).message); }
    finally { if (mounted.current) { setApplying(false); refreshDetail(); } }
  }
  function confirmApply(force: boolean) {
    if (!force) return void applyPending(false);
    Alert.alert("Replace cloud files?", "The cloud copy of this project is replaced with the laptop's latest sync. Changes made in the cloud since the last apply are discarded.", [
      { text: "Keep cloud files", style: "cancel" },
      { text: "Replace", style: "destructive", onPress: () => void applyPending(true) },
    ]);
  }
  const locked = busy || Boolean(request);
  async function submit() {
    if (sending.current || !online || me?.role !== "owner" || !selectedProvider || !selectedProject || !title.trim()) return;
    sending.current = true;
    setRetrying(Boolean(request));
    setBusy(true);
    const body = creations.begin(machine, { requestId: Crypto.randomUUID(), backend, provider: selectedProvider, projectId: selectedProject, title: title.trim(), prompt });
    try {
      const session = await api<SessionRow>(connection, "/sessions", { body });
      const settled = creations.complete(machine, body.requestId, { id: session.id });
      if (settled && mounted.current) router.replace({ pathname: "/session/[id]", params: { id: session.id, machine } });
    } catch (error) {
      const rejected = error instanceof ApiError && error.status === 400 && error.code === "invalid-create";
      creations.fail(machine, body.requestId, `${(error as Error).message}${rejected ? " Correct the session details and try again." : " The result may be uncertain. Check Sessions or retry the same request."}`, rejected);
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  return <KeyboardAvoidingView style={[s.fill, s.overlayRoot]} behavior="padding">
    <TopBar backLabel="Sessions" onBack={() => router.replace({ pathname: "/", params: { machine } })} right={<Text style={s.note} numberOfLines={1}>{connection.label || "Selected machine"}</Text>} />
    <FloatingNotice position="top" offset={58} message={stale ? me ? "Waiting for a fresh machine connection." : "Can't reach this machine." : null} actions={stale ? <Button compact title="Refresh" secondary onPress={refresh} /> : null} />
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>New session</Text>
      <Text style={s.note}>Runs on {me?.machine?.label || connection.label || "this machine"}. The machine must stay online.</Text>
      {me && me.role !== "owner" ? <Text style={s.warning}>An owner key is required to create sessions on this machine.</Text> : null}
      {creation.result ? <View style={s.section}><Text style={s.note}>Session created.</Text><Button title="Open created session" onPress={() => router.replace({ pathname: "/session/[id]", params: { id: creation.result!.id, machine } })} /></View> : null}
      <Text style={s.label}>Session host</Text>
      <View style={s.choices}>{(me?.backends ?? ["infinite"]).map(value => <Button key={value} title={value === "cmux" ? "cmux" : "Infinite"} secondary={backend !== value} disabled={locked} onPress={() => { setBackend(value); setProvider(undefined); }} />)}</View>
      <Text style={s.label}>Project</Text>
      <View style={s.choices}>{projects.map(item => <Button key={item.id} title={item.name} secondary={selectedProject !== item.id} disabled={locked} onPress={() => { setProject(item.id); setSyncError(""); }} />)}</View>
      {displayDetail ? <Text style={s.note} numberOfLines={2}>Synced from laptop {ago(displayDetail.sync.lastSyncedAt)} · applied {ago(displayDetail.sync.appliedAt)}{displayDetail.sync.pendingGeneration ? ` · pending: ${pendingLabel(displayDetail.sync.pendingGeneration)}` : ""}</Text> : null}
      {detail?.sync.pendingGeneration && me?.role === "owner" ? <Button busy={applying} title={detail.sync.pendingGeneration.reason === "cloud-changed" ? "Replace cloud files" : "Apply now"} secondary disabled={applying || !online} onPress={() => confirmApply(detail.sync.pendingGeneration!.reason === "cloud-changed")} /> : null}
      {syncs && syncError ? <Text accessibilityRole="alert" style={s.warning}>{syncError}</Text> : null}
      {me && !projects.length ? <Text style={s.warning}>Add an allowed project to this machine’s Infinite configuration first.</Text> : null}
      <Text style={s.label}>Agent</Text>
      <View style={s.choices}>{providers.map(value => <Button key={value} title={PROVIDER_NAMES[value]} secondary={selectedProvider !== value} disabled={locked} onPress={() => setProvider(value)} />)}</View>
      {me && !providers.length ? <Text style={s.warning}>No agents are configured for this session host.</Text> : null}
      <Text style={s.label}>Session name</Text>
      <TextInput accessibilityLabel="Session name" value={title} onChangeText={setTitle} editable={!locked} style={s.input} placeholder="What are you working on?" placeholderTextColor={theme.colors.placeholder} maxLength={100} />
      <Text style={s.label}>First request (optional)</Text>
      <TextInput accessibilityLabel="First request" value={prompt} onChangeText={setPrompt} editable={!locked} multiline style={[s.input, s.prompt]} placeholder="Give the agent an outcome and useful context…" placeholderTextColor={theme.colors.placeholder} maxLength={24000} />
      <Text style={s.note}>You can use your keyboard’s microphone to dictate. Review the text before starting.</Text>
      {creation.message ? <Text accessibilityRole="alert" style={s.warning}>{creation.message}</Text> : null}
      <View style={s.section}><Button busy={busy} title={request && (!busy || retrying) ? "Retry same request" : "Start session"} onPress={() => void submit()} disabled={busy || !online || me?.role !== "owner" || !selectedProvider || !selectedProject || !title.trim()} /></View>
    </ScrollView>
  </KeyboardAvoidingView>;
}
const s = StyleSheet.create({
  fill: { flex: 1 },
  overlayRoot: { position: "relative" },
  body: { padding: 24, gap: 10 }, title: { fontSize: 28, lineHeight: 34, color: theme.colors.ink, fontWeight: "700", letterSpacing: -0.6 },
  label: { fontSize: 14, fontWeight: "600", color: theme.colors.ink, marginTop: 16 },
  note: { fontSize: 12, lineHeight: 19, color: theme.colors.mutedInk }, warning: { fontSize: 13, lineHeight: 20, color: theme.colors.warningInk },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, section: { marginVertical: 16, gap: 12 },
  input: { borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.control, padding: 14, minHeight: 50, color: theme.colors.ink, fontSize: 15 },
  prompt: { minHeight: 140, textAlignVertical: "top" },
});
