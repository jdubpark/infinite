import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { api, ApiError, connectionKey, type Connection, type Mission, type ProjectGroup } from "../../api/client";
import { Button } from "../../components/Button";
import { Sheet, SheetRow } from "../../components/Glass";
import { missionCreations, type MissionCreationRequest } from "../../store/requests";
import { theme } from "../../theme";

const LAST_PROJECT_KEY = "infinite.mobile.last-project";
const inFlight = new Set<string>();

/** A project-targeted mission creator. An uncertain retry reuses its stored request body and ID. */
export function Composer({ connection, groups, onCreated }: {
  connection: Connection; groups: ProjectGroup[]; onCreated: (mission: Mission) => void;
}) {
  const machine = connectionKey(connection);
  const state = missionCreations.use(machine);
  const pending = state.pending;
  const [groupId, setGroupId] = useState("");
  const [objective, setObjective] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(onCreated);
  useEffect(() => { latest.current = onCreated; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = sending || Boolean(pending && inFlight.has(`${machine}/${pending.requestId}`));
  const selected = groups.find(group => group.id === groupId) ?? groups[0];

  useEffect(() => {
    let live = true;
    void SecureStore.getItemAsync(LAST_PROJECT_KEY).then(saved => {
      if (live && groups.some(group => group.id === saved)) setGroupId(saved!);
      else if (live && groups.length) setGroupId(groups[0]!.id);
    }).catch(() => { if (live && groups.length) setGroupId(groups[0]!.id); });
    return () => { live = false; };
  }, [groups]);

  function choose(group: ProjectGroup) {
    setGroupId(group.id);
    setPickerOpen(false);
    void SecureStore.setItemAsync(LAST_PROJECT_KEY, group.id).catch(() => {});
  }

  const transmit = useCallback(async (request: MissionCreationRequest) => {
    const requestKey = `${machine}/${request.requestId}`;
    if (inFlight.has(requestKey)) return;
    inFlight.add(requestKey);
    setSending(true);
    try {
      const mission = await api<Mission>(connection, "/missions", { method: "POST", body: request });
      const settled = missionCreations.complete(machine, request.requestId, { id: mission.id });
      if (settled && mounted.current) { setObjective(""); latest.current(mission); }
    } catch (error) {
      const refused = error instanceof ApiError && error.status >= 400 && error.status < 500;
      missionCreations.fail(machine, request.requestId, refused
        ? `${(error as Error).message} Review the project and request before sending again.`
        : `${(error as Error).message} Delivery is unconfirmed. Retry sends this exact request.`, refused);
    } finally {
      inFlight.delete(requestKey);
      if (mounted.current) setSending(false);
    }
  }, [connection, machine]);

  function submit() {
    if (!selected || busy || pending || !objective.trim()) return;
    void transmit(missionCreations.begin(machine, {
      requestId: Crypto.randomUUID(), groupId: selected.id, objective: objective.trim(),
    }));
  }

  return <View style={s.dock}>
    <View style={s.composer}>
      <SheetRow glyph="target" label={selected?.name ?? (groups.length ? "Choose a project" : "No projects available")}
        detail={selected ? `${selected.repos.length} ${selected.repos.length === 1 ? "repository" : "repositories"}` : undefined}
        onPress={() => setPickerOpen(true)} disabled={!groups.length || busy || Boolean(pending)} />
      <TextInput accessibilityLabel="Mission objective" value={objective} onChangeText={setObjective}
        placeholder="What should this project do?" placeholderTextColor={theme.colors.placeholder}
        multiline maxLength={24000} editable={!busy && !pending} style={s.input} textAlignVertical="top" />
      <View style={s.actions}>
        {state.message ? <Text accessibilityLiveRegion="polite" style={s.message}>{state.message}</Text> : null}
        {pending ? <Button compact secondary title="Retry" disabled={busy} onPress={() => void transmit(pending)} /> : null}
        <Button title={busy ? "Sending…" : "Send"} disabled={!selected || !objective.trim() || busy || Boolean(pending)} onPress={submit} />
      </View>
    </View>
    <Sheet visible={pickerOpen} onClose={() => setPickerOpen(false)} title="Choose a project">
      <ScrollView style={s.projects} keyboardShouldPersistTaps="handled">
        {groups.map(group => <SheetRow key={group.id} selected={group.id === selected?.id} glyph="target" label={group.name}
          detail={`${group.repos.length} ${group.repos.length === 1 ? "repository" : "repositories"}`}
          onPress={() => choose(group)} />)}
      </ScrollView>
    </Sheet>
  </View>;
}

const s = StyleSheet.create({
  dock: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, backgroundColor: theme.colors.paper, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  composer: { padding: 8, borderRadius: theme.radius.panel, backgroundColor: theme.colors.white, gap: 4 },
  input: { minHeight: 54, maxHeight: 112, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, lineHeight: 21, color: theme.colors.ink },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingHorizontal: 6 },
  message: { flex: 1, color: theme.colors.mutedInk, fontSize: 12, lineHeight: 17 },
  projects: { maxHeight: 420 },
});
