import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { api, ApiError, connectionKey, type BoardItem, type Connection, type Mission, type ProjectGroup, type ProjectGroupSuggestion } from "../../api/client";
import { Button } from "../../components/Button";
import { GlassButton, SheetRow } from "../../components/Glass";
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
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
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
  const selected = pending ? groups.find(group => group.id === pending.groupId) : visible.find(group => group.id === groupId) ?? visible[0];
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
      if (settled && mounted.current) { setObjective(""); setOpen(false); setPickerOpen(false); Keyboard.dismiss(); latest.current(mission); }
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

  function close() {
    Keyboard.dismiss();
    setOpen(false);
    setPickerOpen(false);
  }

  return <>
    <View style={s.floating}>
      <GlassButton glyph="plus" label={pending ? "New work, request pending" : state.message ? "New work, review request" : "New work"}
        primary size={56} onPress={() => setOpen(true)} />
      {pending || state.message ? <View pointerEvents="none" style={s.requestDot} /> : null}
    </View>
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent
      onRequestClose={() => pickerOpen ? setPickerOpen(false) : close()}>
      <View style={s.overlay}>
        <Pressable accessible={false} style={s.scrim} onPress={close} />
        <KeyboardAvoidingView pointerEvents="box-none" behavior={Platform.OS === "ios" ? "padding" : "height"} style={s.overlay}>
          <View pointerEvents="box-none" style={[s.center, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16,
            paddingLeft: insets.left + 20, paddingRight: insets.right + 20 }]}>
            <View accessibilityViewIsModal onAccessibilityEscape={close} style={s.dialog}>
              <View style={s.heading}>
                {pickerOpen ? <GlassButton glyph="back" label="Back to new work" onPress={() => setPickerOpen(false)} /> : null}
                <Text accessibilityRole="header" style={s.title}>{pickerOpen ? "Choose workspace" : "New work"}</Text>
                <GlassButton glyph="close" label="Close new work" onPress={close} />
              </View>
              {pickerOpen ? <ScrollView style={s.scroll} keyboardShouldPersistTaps="handled">
                {visible.map(group => <SheetRow key={group.id} selected={group.id === selected?.id} glyph="target" label={group.name}
                  detail={groupActivity(items, group.id)} onPress={() => choose(group)} />)}
                {owner ? suggestions.map(suggestion => <CombineRow key={suggestion.groupIds.join("+")} connection={connection}
                  suggestion={suggestion} groups={groups} onCombined={() => { setPickerMessage(null); onChanged(); }}
                  onError={setPickerMessage} />) : null}
                {pickerMessage ? <Text accessibilityLiveRegion="polite" style={s.pickerMessage}>{pickerMessage}</Text> : null}
                <SheetRow glyph="forward" label="Manage workspaces" onPress={() => { close(); onManage(); }} />
              </ScrollView> : <ScrollView style={s.scroll} contentContainerStyle={s.form} keyboardShouldPersistTaps="handled">
                <View style={s.field}>
                  <Text style={s.label}>Workspace</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Choose workspace, ${selected?.name ?? "none selected"}`}
                    accessibilityState={{ disabled: busy || Boolean(pending) }} disabled={busy || Boolean(pending)}
                    onPress={() => { Keyboard.dismiss(); setPickerOpen(true); }}
                    style={({ pressed }) => [s.workspace, (pressed || busy || pending) && s.dim]}>
                    <Glyph name="target" size={20} color={theme.colors.secondaryInk} />
                    <Text style={s.workspaceName}>{selected?.name ?? (groups.length ? "No visible workspaces" : "Choose a workspace")}</Text>
                    <Glyph name="down" size={14} color={theme.colors.mutedInk} />
                  </Pressable>
                </View>
                <View style={s.field}>
                  <Text style={s.label}>Prompt</Text>
                  <TextInput accessibilityLabel="Mission objective" value={pending?.objective ?? objective} onChangeText={setObjective}
                    placeholder="What should we work on?" placeholderTextColor={theme.colors.placeholder}
                    multiline maxLength={24000} editable={!busy && !pending} style={s.input} textAlignVertical="top" />
                </View>
                <View style={s.actions}>
                  {state.message ? <Text accessibilityLiveRegion="polite" style={s.message}>{state.message}</Text> : null}
                  {pending && !busy ? <Button compact secondary title="Retry" onPress={() => void transmit(pending)} /> :
                    <Pressable accessibilityRole="button" accessibilityLabel={busy ? "Sending mission" : "Send mission"}
                      accessibilityState={{ disabled: sendDisabled, busy }} disabled={sendDisabled} onPress={submit}
                      style={({ pressed }) => [s.send, (pressed || sendDisabled) && s.dim]}>
                      {busy ? <ActivityIndicator size="small" color={theme.colors.white} /> : <Glyph name="send" size={20} color={theme.colors.white} />}
                    </Pressable>}
                </View>
              </ScrollView>}
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  </>;
}

const s = StyleSheet.create({
  floating: { position: "absolute", right: 20, bottom: 16 },
  requestDot: { position: "absolute", top: 0, right: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.warningInk, borderWidth: 2, borderColor: theme.colors.paper },
  overlay: { flex: 1 },
  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.colors.scrim },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  dialog: { width: "100%", maxWidth: 480, maxHeight: "100%", padding: 16, borderRadius: theme.radius.sheet, backgroundColor: theme.colors.paper, ...theme.lift },
  heading: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 },
  title: { flex: 1, fontSize: 22, fontWeight: "600", color: theme.colors.ink },
  scroll: { flexShrink: 1 },
  form: { gap: 16 },
  field: { gap: 8 },
  label: { fontSize: 13, fontWeight: "600", color: theme.colors.mutedInk },
  workspace: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, padding: 12, borderRadius: theme.radius.panel, backgroundColor: theme.colors.secondarySurface },
  workspaceName: { flex: 1, fontSize: 15, fontWeight: "500", color: theme.colors.ink },
  input: { minHeight: 112, maxHeight: 176, padding: 12, borderRadius: theme.radius.panel, borderWidth: 1, borderColor: theme.colors.fieldRule,
    backgroundColor: theme.colors.white, fontSize: 15, lineHeight: 21, color: theme.colors.ink },
  send: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.forest },
  dim: { opacity: 0.45 },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingHorizontal: 6 },
  message: { flex: 1, color: theme.colors.mutedInk, fontSize: 12, lineHeight: 17 },
  pickerMessage: { marginVertical: 8, paddingHorizontal: 10, fontSize: 12, lineHeight: 17, color: theme.colors.error },
});
