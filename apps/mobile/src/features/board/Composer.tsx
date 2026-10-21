import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { api, ApiError, connectionKey, type BoardItem, type Connection, type Mission, type ProjectGroup, type ProjectGroupSuggestion } from "../../api/client";
import { Button } from "../../components/Button";
import { Sheet, SheetRow } from "../../components/Glass";
import { Glyph } from "../../components/Icon";
import { CombineRow } from "../projects/CombineRow";
import { groupActivity, visibleGroups } from "../projects/model";
import { missionCreations, type MissionCreationRequest } from "../../store/requests";
import { theme } from "../../theme";

const LAST_PROJECT_KEY = "infinite.mobile.last-project";
const inFlight = new Set<string>();

/** A project-targeted mission creator. An uncertain retry reuses its stored request body and ID. */
export function Composer({ connection, groups, items, suggestions, owner, onCreated, onManage, onChanged }: {
  connection: Connection; groups: ProjectGroup[]; items: BoardItem[]; suggestions: ProjectGroupSuggestion[]; owner: boolean;
  onCreated: (mission: Mission) => void; onManage: () => void; onChanged: () => void;
}) {
  const machine = connectionKey(connection);
  const state = missionCreations.use(machine);
  const pending = state.pending;
  const [groupId, setGroupId] = useState("");
  const [objective, setObjective] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [pickerMessage, setPickerMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const latest = useRef(onCreated);
  useEffect(() => { latest.current = onCreated; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = sending || Boolean(pending && inFlight.has(`${machine}/${pending.requestId}`));
  const visible = useMemo(() => visibleGroups(groups), [groups]);
  const selected = visible.find(group => group.id === groupId) ?? visible[0];
  const sendDisabled = !selected || !objective.trim() || busy || Boolean(pending);

  useEffect(() => {
    let live = true;
    void SecureStore.getItemAsync(LAST_PROJECT_KEY).then(saved => {
      if (live && visible.some(group => group.id === saved)) setGroupId(saved!);
      else if (live && visible.length) setGroupId(visible[0]!.id);
    }).catch(() => { if (live && visible.length) setGroupId(visible[0]!.id); });
    return () => { live = false; };
  }, [visible]);

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
      <SheetRow glyph="target" label={selected?.name ?? (visible.length ? "Choose a project" : groups.length ? "No visible projects" : "No projects available")}
        detail={selected ? groupActivity(items, selected.id) : undefined}
        onPress={() => setPickerOpen(true)} disabled={!groups.length || busy || Boolean(pending)} />
      <View style={s.prompt}>
        <TextInput accessibilityLabel="Mission objective" value={objective} onChangeText={setObjective}
          placeholder="What should we work on?" placeholderTextColor={theme.colors.placeholder}
          multiline maxLength={24000} editable={!busy && !pending} style={s.input} textAlignVertical="top" />
        <Pressable accessibilityRole="button" accessibilityLabel={busy ? "Sending mission" : "Send mission"}
          accessibilityState={{ disabled: sendDisabled, busy }} disabled={sendDisabled} onPress={submit}
          style={({ pressed }) => [s.send, (pressed || sendDisabled) && s.dim]}>
          {busy ? <ActivityIndicator size="small" color={theme.colors.white} /> : <Glyph name="send" size={20} color={theme.colors.white} />}
        </Pressable>
      </View>
      {state.message || (pending && !busy) ? <View style={s.actions}>
        {state.message ? <Text accessibilityLiveRegion="polite" style={s.message}>{state.message}</Text> : null}
        {pending ? <Button compact secondary title="Retry" disabled={busy} onPress={() => void transmit(pending)} /> : null}
      </View> : null}
    </View>
    <Sheet visible={pickerOpen} onClose={() => setPickerOpen(false)} title="Choose a project">
      <ScrollView style={s.projects} keyboardShouldPersistTaps="handled">
        {visible.map(group => <SheetRow key={group.id} selected={group.id === selected?.id} glyph="target" label={group.name}
          detail={groupActivity(items, group.id)} onPress={() => choose(group)} />)}
        {owner ? suggestions.map(suggestion => <CombineRow key={suggestion.groupIds.join("+")} connection={connection}
          suggestion={suggestion} groups={groups} onCombined={() => { setPickerMessage(null); onChanged(); }}
          onError={setPickerMessage} />) : null}
        {pickerMessage ? <Text accessibilityLiveRegion="polite" style={s.pickerMessage}>{pickerMessage}</Text> : null}
        <SheetRow glyph="forward" label="Manage projects" onPress={() => { setPickerOpen(false); onManage(); }} />
      </ScrollView>
    </Sheet>
  </View>;
}

const s = StyleSheet.create({
  dock: { paddingHorizontal: 12, paddingTop: 8, backgroundColor: theme.colors.paper, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  composer: { padding: 8, borderRadius: theme.radius.panel, backgroundColor: theme.colors.white, gap: 4 },
  prompt: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: { flex: 1, minHeight: 48, maxHeight: 112, paddingHorizontal: 10, paddingVertical: 12, fontSize: 15, lineHeight: 21, color: theme.colors.ink },
  send: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.forest },
  dim: { opacity: 0.45 },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingHorizontal: 6 },
  message: { flex: 1, color: theme.colors.mutedInk, fontSize: 12, lineHeight: 17 },
  projects: { maxHeight: 420 },
  pickerMessage: { marginVertical: 8, paddingHorizontal: 10, fontSize: 12, lineHeight: 17, color: theme.colors.error },
});
