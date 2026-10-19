import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { api, ApiError, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { FloatingNotice } from "../../components/FloatingNotice";
import { TopBar } from "../../components/Glass";
import { teamCreations } from "../../store/requests";
import { theme } from "../../theme";
import { teamReady, type TeamView } from "./model";
import { Choices, Disclosure, LineupView, providerName, t } from "./parts";

const inFlight = new Set<string>();

/** Starts a team from a feature request or PRD. Creation is an owner action. */
export function TeamCreate({ connection }: { connection: Connection }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const creation = teamCreations.use(machine);
  const pending = creation.pending;
  const { data: me, online, stale, refresh } = usePoll(() => api<Me>(connection, "/me"), 5000, [connection]);
  const projects = me?.projects ?? [];
  const lineup = me?.teams?.lineup;
  const configured = me?.backendProviders?.infinite ?? me?.providers ?? [];
  const providers = configured.includes("claude") ? ["claude", ...configured.filter(value => value !== "claude")] : configured;
  const [objective, setObjective] = useState(pending?.objective ?? "");
  const [title, setTitle] = useState(pending?.title ?? "");
  const [project, setProject] = useState(pending?.projectId);
  const [useLineup, setUseLineup] = useState<boolean | undefined>(pending?.useConfiguredLineup);
  const [provider, setProvider] = useState(pending?.provider);
  const [parallelism, setParallelism] = useState(pending?.parallelism ?? 2);
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // A send started before this screen remounted is still in flight; its result re-renders through the store.
  const busy = sending || Boolean(pending && inFlight.has(pending.requestId));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const projectId = projects.some(value => value.id === project) ? project! : (projects.find(teamReady) ?? projects[0])?.id;
  const selectedProject = projects.find(value => value.id === projectId);
  const lineupSelected = useLineup ?? Boolean(lineup);
  const singleProvider = providers.find(value => value === provider) ?? providers.find(value => value !== "demo") ?? providers[0];
  const selectedProvider = lineupSelected ? lineup?.coordinator.provider : singleProvider;
  const maxParallelism = Math.max(1, Math.min(4, me?.teams?.maxParallelism ?? 4));
  const locked = busy || Boolean(pending) || me?.role !== "owner";
  const ready = Boolean(me?.teams?.enabled && teamReady(selectedProject) && selectedProvider);
  const allowed = online && me?.role === "owner" && (Boolean(pending) || (ready && Boolean(objective.trim())));
  async function submit() {
    if (busy || !allowed) return;
    // A retry resends the recorded request even if this host's settings have changed since.
    if (!pending && (!projectId || !selectedProvider)) return;
    const request = pending ?? teamCreations.begin(machine, {
      requestId: Crypto.randomUUID(), projectId: projectId!, provider: selectedProvider!, useConfiguredLineup: lineupSelected,
      title: title.trim() || objective.trim().split("\n")[0].slice(0, 100), objective: objective.trim(), parallelism: Math.min(parallelism, maxParallelism),
    });
    setRetrying(Boolean(pending));
    if (inFlight.has(request.requestId)) return;
    inFlight.add(request.requestId);
    setSending(true);
    try {
      const team = await api<TeamView>(connection, "/teams", { body: request });
      if (teamCreations.complete(machine, request.requestId, { id: team.id }) && mounted.current) router.replace({ pathname: "/team/[id]", params: { id: team.id, machine } });
    } catch (error) {
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
      teamCreations.fail(machine, request.requestId, `${(error as Error).message}${rejected ? " Correct the request and try again." : " Delivery is unconfirmed. Check Teams or retry the same request."}`, rejected);
    } finally { inFlight.delete(request.requestId); if (mounted.current) setSending(false); }
  }
  return <KeyboardAvoidingView style={[s.fill, s.overlayRoot]} behavior="padding">
    <TopBar backLabel="Teams" onBack={() => router.canGoBack() ? router.back() : router.replace({ pathname: "/", params: { machine, view: "teams" } })} right={<Text style={t.note} numberOfLines={1}>{connection.label || "Selected machine"}</Text>} />
    <FloatingNotice position="top" offset={58} message={stale ? me ? "Waiting for a fresh machine connection." : "Can't reach this machine." : null} actions={stale ? <Button compact title="Refresh" secondary onPress={refresh} /> : null} />
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>New team</Text>
      <Text style={t.note}>A coordinator plans the work, implementers build it in isolated copies, and a reviewer checks the result. The team asks when it needs a decision.</Text>
      {me && me.role !== "owner" ? <Text style={t.warning}>An owner key is required to start a team.</Text> : null}
      {me && !me.teams?.enabled ? <Text style={t.warning}>Teams need host setup: enable teams and give a workspace its required checks.</Text> : null}
      {creation.result ? <View style={s.section}><Text style={t.note}>Team started.</Text><Button title="Open team" onPress={() => router.replace({ pathname: "/team/[id]", params: { id: creation.result!.id, machine } })} /></View> : null}
      <Text style={t.label}>Feature request or PRD</Text>
      <TextInput accessibilityLabel="Feature request or PRD" value={objective} onChangeText={setObjective} editable={!locked} multiline maxLength={24000}
        placeholder="Describe the outcome, who it is for, and what should happen…" placeholderTextColor={theme.colors.placeholder} style={[t.input, s.objective]} />
      <Text style={t.label}>Team name (optional)</Text>
      <TextInput accessibilityLabel="Team name" value={title} onChangeText={setTitle} editable={!locked} maxLength={100}
        placeholder="Uses the first line of your request" placeholderTextColor={theme.colors.placeholder} style={t.input} />
      <Text style={t.label}>Workspace</Text>
      <Choices values={projects.map(value => value.id)} selected={projectId} disabled={locked} onSelect={setProject}
        label={value => { const item = projects.find(candidate => candidate.id === value)!; return teamReady(item) ? item.name : `${item.name} · setup required`; }} />
      {selectedProject && !teamReady(selectedProject) ? <Text style={t.warning}>This workspace needs required team checks in the host configuration.</Text> : null}
      {selectedProject?.team?.establishChecks ? <Text style={t.note}>The coordinator will define build and test commands before implementation. The host must run them successfully before review.</Text> : null}
      {selectedProject?.team?.checks.length ? <Disclosure title="Required workspace checks">
        {selectedProject.team.checks.map((check, index) => <Text key={index} style={t.mono}>{[check.command, ...check.args].join(" ")}</Text>)}
      </Disclosure> : null}
      {selectedProject?.linear?.enabled ? <Text style={t.note}>This workspace tracks team work in Linear. Starting the team creates an issue; its workflow state stays under your control.</Text> : null}
      <Text style={t.label}>Agents</Text>
      {lineup ? <Choices values={["lineup", "single"] as const} selected={lineupSelected ? "lineup" : "single"} disabled={locked}
        label={value => value === "lineup" ? "Configured lineup" : "Single provider"} onSelect={value => setUseLineup(value === "lineup")} /> : null}
      {lineupSelected ? lineup ? <Disclosure title="Configured lineup">
        <Text style={t.note}>The coordinator assigns each task to a profile from the implementer pool. These are requested model settings; provider policy may override them.</Text>
        <LineupView lineup={lineup} />
      </Disclosure> : <Text style={t.warning}>The host’s lineup is unavailable. Retrying keeps the original request.</Text>
        : <><Choices values={providers} selected={singleProvider} disabled={locked} label={providerName} onSelect={setProvider} />
          <Text style={t.note}>All roles use this provider with its host settings.</Text></>}
      {!lineupSelected && singleProvider === "demo" ? <Text style={t.warning}>Rehearsal uses a local test process. It does not call an AI model or implement a real feature.</Text> : null}
      <Text style={t.label}>Parallel implementers</Text>
      <Choices values={Array.from({ length: maxParallelism }, (_, index) => index + 1)} selected={Math.min(parallelism, maxParallelism)} disabled={locked} label={String} onSelect={setParallelism} />
      <Text style={t.note}>Work runs on {me?.machine?.label || connection.label || "this machine"} in isolated workspaces with the provider permissions already configured there. A refused tool can stop a member; inspect its session before continuing.</Text>
      {creation.message ? <Text accessibilityRole="alert" style={t.warning}>{creation.message}</Text> : null}
      <View style={s.section}><Button busy={busy} title={pending && (!busy || retrying) ? "Retry same request" : "Start team"} disabled={busy || !allowed} onPress={() => void submit()} /></View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  overlayRoot: { position: "relative" },
  body: { padding: 24, gap: 10, paddingBottom: 48 },
  title: { fontSize: 28, lineHeight: 34, color: theme.colors.ink, fontWeight: "700", letterSpacing: -0.6 },
  section: { marginVertical: 16, gap: 12 },
  objective: { minHeight: 160, textAlignVertical: "top" },
});
