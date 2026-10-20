import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PROVIDER_NAMES, type Provider } from "@infinite/attention";
import { Button } from "../../components/Button";
import { FloatingNotice } from "../../components/FloatingNotice";
import { Chip, GlassButton } from "../../components/Glass";
import { Glyph, StatusIcon } from "../../components/Icon";
import type { StatusKind } from "../../status";
import { theme } from "../../theme";
import { MicButton } from "../../dictation/DictationControls";
import type { Dictation } from "../../dictation/useDictation";
import { profileSetting, type LinearTracking, type ModelProfile, type TeamLineup, type Tone } from "./model";
import type { RunRequestControl } from "./useRunRequest";

export const providerName = (provider: string) => PROVIDER_NAMES[provider as Provider] ?? provider;

/** The run's state as a status icon and its name, in the same chip as a session's state. */
export function RunPill({ label, tone, kind, fraction }: { label: string; tone: Tone; kind?: StatusKind; fraction?: number }) {
  const fallback: StatusKind = tone === "amber" ? "attention" : tone === "error" ? "blocked" : tone === "muted" ? "stopped" : "progress";
  return <Chip kind={kind ?? fallback} fraction={fraction} label={label} accessibilityLabel={`State: ${label}`}
    tone={tone === "amber" ? "attention" : tone === "error" ? "error" : undefined} />;
}

export function Section({ title, count, children, right }: { title: string; count?: number; children: ReactNode; right?: ReactNode }) {
  return <View style={s.section}>
    <View style={s.sectionHead}>
      <Text style={s.heading} accessibilityRole="header">{title}{count !== undefined ? <Text style={s.count}>{`  ${count}`}</Text> : null}</Text>
      {right}
    </View>
    {children}
  </View>;
}

/** Prose that can run to a full PRD: the first lines, then the rest on request. */
export function Clamp({ text, lines = 6, style }: { text: string; lines?: number; style?: object }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 60 || text.split("\n").length > lines;
  return <View>
    <Text selectable style={[t.body, style]} numberOfLines={open || !long ? undefined : lines}>{text}</Text>
    {long ? <Pressable accessibilityRole="button" onPress={() => setOpen(value => !value)} hitSlop={8} style={s.more}>
      <Text style={s.moreText}>{open ? "Less" : "More"}</Text>
    </Pressable> : null}
  </View>;
}

/** Long or secondary records start closed so state and decisions stay near the top. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={s.disclosure}>
      <Glyph name={open ? "down" : "forward"} size={12} color={theme.colors.secondaryInk} />
      <Text style={s.disclosureText}>{title}</Text>
    </Pressable>
    {open ? <View style={s.disclosed}>{children}</View> : null}
  </View>;
}

export function ProfileLine({ profile }: { profile: ModelProfile }) {
  return <Text style={t.note} numberOfLines={2}>
    {profile.label}{profile.tier ? ` · ${profile.tier}` : ""} · {providerName(profile.provider)} <Text style={t.mono}>{profile.model}</Text> · {profileSetting(profile)}
    {profile.dataUse === "contributor" ? " · contributor data use" : ""}
  </Text>;
}

export function LineupView({ lineup }: { lineup: TeamLineup }) {
  const roles: [string, ModelProfile[]][] = [
    ["Coordinator", [lineup.coordinator]], ["Implementer pool", lineup.implementers], ["Integrator", [lineup.integrator]],
    ["Reviewer", [lineup.reviewer]], ["Escalation pool", lineup.escalations ?? []], ["Limit fallback pool", lineup.fallbacks ?? []],
  ];
  return <>{roles.filter(([, profiles]) => profiles.length).map(([role, profiles]) => <View key={role} style={s.lineup}>
    <Text style={t.label}>{role}</Text>
    {profiles.map(profile => <ProfileLine key={profile.id} profile={profile} />)}
  </View>)}</>;
}

/** Linear's issue state by its workflow name; unknown names read as not started. */
function linearKind(state: string): StatusKind {
  const name = state.toLowerCase();
  if (name.includes("progress")) return "progress";
  if (name.includes("review")) return "review";
  if (name === "done" || name.includes("complete")) return "done";
  if (name.includes("cancel") || name.includes("duplicate")) return "cancelled";
  if (name.includes("backlog") || name.includes("triage")) return "backlog";
  return "todo";
}

/**
 * The run's Linear issue as a chip that opens it. Linear's issue state is separate from the run's
 * execution state; the icon carries the issue's state and the label only its identifier. A pending
 * sync or a cached record swaps the icon for a spinner rather than adding words, so the chip keeps
 * its width; tracking problems turn it red. The state and any trouble are spoken in full.
 */
export function LinearChip({ tracking, fresh }: { tracking?: LinearTracking; fresh: boolean }) {
  if (!tracking) return null;
  const issue = tracking.issue;
  const trouble = tracking.status === "blocked" || tracking.status === "error";
  const loading = tracking.status === "pending" || !fresh;
  const label = issue ? issue.identifier : "Linear";
  const status = tracking.status === "pending" ? ", syncing" : trouble ? `, tracking ${tracking.status}` : !fresh ? ", last received" : "";
  const open = issue && /^https:\/\//.test(issue.url) ? () => void Linking.openURL(issue.url) : undefined;
  const icon = trouble ? <StatusIcon kind="error" size={13} />
    : loading ? <View style={s.spinner}><ActivityIndicator size="small" color={theme.colors.mutedInk} style={s.spinnerScale} /></View>
      : <StatusIcon kind={issue ? linearKind(issue.state.name) : "todo"} size={13} />;
  return <Chip icon={icon} label={label} tone={trouble ? "error" : undefined} onPress={open}
    accessibilityLabel={`Linear ${label}${issue ? `, ${issue.state.name}` : ""}${status}${issue ? `: ${issue.title}` : ""}${tracking.reason ? `. ${tracking.reason}` : ""}`} />;
}

/** The outcome of the last request, and the controls for one whose delivery is unconfirmed. */
export function RequestStatus({ request, canRetry, bottom = 0 }: { request: RunRequestControl; canRetry: boolean; bottom?: number }) {
  const pending = request.pending;
  useEffect(() => {
    if (!request.recorded || !request.message) return;
    const timer = setTimeout(request.dismissMessage, 4000);
    return () => clearTimeout(timer);
  }, [request.dismissMessage, request.recorded, request.message]);
  if (pending && !request.busy) return <FloatingNotice position="bottom" offset={bottom}
    message={`${request.message || `Unconfirmed ${pending.label.toLowerCase()} · revision ${pending.revision}${pending.fields.text ? ` · “${pending.fields.text}”` : ""}`}. Retry sends the same request.`}
    accessibilityRole={request.message ? "alert" : undefined}
    actions={<View style={s.requestActions}>
      <Button compact title="Retry" disabled={!canRetry} onPress={request.retry} />
      <Button compact title="Clear…" secondary onPress={() => Alert.alert("Clear the unconfirmed request?", "The host may have applied it. Clearing only forgets it here.", [
          { text: "Keep pending", style: "cancel" },
          { text: "Clear", style: "destructive", onPress: request.discard },
        ])} />
    </View>} />;
  if (!request.busy && request.message) return <FloatingNotice position="bottom" offset={bottom} message={request.message}
    kind={request.recorded ? "success" : "error"} onDismiss={request.dismissMessage} />;
  return null;
}

/** The floating direction field for a team or goal; `note` replaces it when steering is unavailable. */
export function SteerBox({ value, onChange, placeholder, enabled, busy, note, onSend, dictation }: {
  value: string; onChange: (text: string) => void; placeholder: string; enabled: boolean; busy: boolean; note?: string; onSend: () => void; dictation?: Dictation;
}) {
  if (note) return <Text style={[t.note, s.steerNote]} numberOfLines={1}>{note}</Text>;
  // The field is read-only whenever steering is off or a send is in flight, so the mic follows it.
  const mic = dictation ? <MicButton dictation={dictation} size={40} disabled={!enabled || busy} /> : null;
  if (busy) return <View style={s.steer}>
    <TextInput accessibilityLabel="Direction" value={value} onChangeText={onChange} editable={false} multiline maxLength={8000} placeholder={placeholder} placeholderTextColor={theme.colors.placeholder} style={s.steerInput} />
    {mic}
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Sending direction" style={s.busyButton}><ActivityIndicator color={theme.colors.forest} /></View>
  </View>;
  return <View style={s.steer}>
    <TextInput accessibilityLabel="Direction" value={value} onChangeText={onChange} editable={enabled && !busy} multiline maxLength={8000}
      placeholder={placeholder} placeholderTextColor={theme.colors.placeholder} style={s.steerInput} />
    {mic}
    <GlassButton primary glyph="send" label={busy ? "Sending" : "Send direction"} size={40} disabled={!enabled || busy || !value.trim()} onPress={onSend} />
  </View>;
}

/** A person's choice between a few fixed values, shown as the app's toggle buttons. */
export function Choices<T extends string | number>({ values, selected, label, disabled, onSelect }: {
  values: readonly T[]; selected: T | undefined; label: (value: T) => string; disabled?: boolean; onSelect: (value: T) => void;
}) {
  return <View style={s.wrap}>{values.map(value => <Button key={String(value)} compact title={label(value)} secondary={selected !== value} disabled={disabled} onPress={() => onSelect(value)} />)}</View>;
}

/** Shared text styles for the team and goal screens. */
export const t = StyleSheet.create({
  title: { fontSize: 22, lineHeight: 27, fontWeight: "600", color: theme.colors.ink, letterSpacing: -0.4 },
  body: { fontSize: 14, lineHeight: 21, color: theme.colors.ink },
  strong: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: theme.colors.ink },
  note: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
  warning: { fontSize: 13, lineHeight: 19, color: theme.colors.warningInk },
  error: { fontSize: 13, lineHeight: 19, color: theme.colors.error },
  label: { fontSize: 13, fontWeight: "600", color: theme.colors.ink, marginTop: 12 },
  mono: { fontFamily: theme.mono, fontSize: 12, color: theme.colors.screenInk },
  banner: { backgroundColor: theme.colors.warningSurface, color: theme.colors.warningInk, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingVertical: 8 },
  input: { borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.card, padding: 13, minHeight: 48, color: theme.colors.ink, fontSize: 15, backgroundColor: theme.colors.white },
  multiline: { minHeight: 110, textAlignVertical: "top" },
  card: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule, borderRadius: theme.radius.card, padding: 14, gap: 6, backgroundColor: theme.colors.white },
  attention: { borderColor: theme.colors.warningSurface, backgroundColor: theme.colors.warningSurface },
});

const s = StyleSheet.create({
  section: { gap: 8, marginTop: 20 },
  spinner: { width: 13, height: 13, alignItems: "center", justifyContent: "center" },
  spinnerScale: { transform: [{ scale: 0.65 }] },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  heading: { fontSize: 13, fontWeight: "700", color: theme.colors.ink },
  count: { fontWeight: "400", color: theme.colors.mutedInk },
  more: { paddingVertical: 4, alignSelf: "flex-start" },
  moreText: { fontSize: 13, fontWeight: "600", color: theme.colors.forest },
  disclosure: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 40 },
  disclosureText: { fontSize: 13, fontWeight: "600", color: theme.colors.secondaryInk },
  disclosed: { gap: 6, paddingBottom: 6 },
  lineup: { gap: 2 },
  pending: { gap: 6 },
  requestActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  steer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 5, paddingLeft: 6, borderRadius: 26,
    backgroundColor: theme.colors.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.glassRim, ...theme.lift },
  steerInput: { flex: 1, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, minHeight: 40, maxHeight: 130, color: theme.colors.ink, fontSize: 15 },
  steerNote: { textAlign: "center", paddingHorizontal: 8 },
  busyButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
