import { useState, type ReactNode } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PROVIDER_NAMES, type Provider } from "@infinite/attention";
import { Button } from "../../components/Button";
import { theme } from "../../theme";
import { profileSetting, type LinearTracking, type ModelProfile, type TeamLineup, type Tone } from "./model";
import type { RunRequestControl } from "./useRunRequest";

export const providerName = (provider: string) => PROVIDER_NAMES[provider as Provider] ?? provider;

/** The run's state in the same pill shape and tones as a session's StatePill. */
export function RunPill({ label, tone }: { label: string; tone: Tone }) {
  return <View accessible accessibilityLabel={`State: ${label}`} style={[s.pill, s[tone]]}>
    <Text style={[s.pillText, s[`${tone}Text`]]}>{label}</Text>
  </View>;
}

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <View style={s.section}>
    <Text style={s.heading}>{title}{count !== undefined ? <Text style={s.count}>{`  ${count}`}</Text> : null}</Text>
    {children}
  </View>;
}

/** Prose that can run to a full PRD: the first lines, then the rest on request. */
export function Clamp({ text, lines = 6 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 60 || text.split("\n").length > lines;
  return <View>
    <Text selectable style={t.body} numberOfLines={open || !long ? undefined : lines}>{text}</Text>
    {long ? <Pressable accessibilityRole="button" onPress={() => setOpen(value => !value)} style={s.disclosure}>
      <Text style={s.disclosureText}>{open ? "Show less" : "Show all"}</Text>
    </Pressable> : null}
  </View>;
}

/** Long or secondary records start closed so the run's state and decisions stay near the top. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={s.disclosure}>
      <Text style={s.disclosureText}>{open ? "▾" : "▸"} {title}</Text>
    </Pressable>
    {open ? <View style={s.disclosed}>{children}</View> : null}
  </View>;
}

export function ProfileLine({ profile }: { profile: ModelProfile }) {
  return <Text style={t.note}>
    {profile.label}{profile.tier ? ` · ${profile.tier}` : ""} · {providerName(profile.provider)} <Text style={t.mono}>{profile.model}</Text> · {profileSetting(profile)}
    {profile.dataUse === "contributor" ? " · contributor data use" : ""}
  </Text>;
}

export function LineupView({ lineup }: { lineup: TeamLineup }) {
  const roles: [string, ModelProfile[]][] = [
    ["Coordinator", [lineup.coordinator]], ["Implementer pool", lineup.implementers], ["Integrator", [lineup.integrator]],
    ["Reviewer", [lineup.reviewer]], ["Escalation pool", lineup.escalations ?? []], ["Limit fallback pool", lineup.fallbacks ?? []],
  ];
  return <>{roles.filter(([, profiles]) => profiles.length).map(([role, profiles]) => <View key={role}>
    <Text style={t.label}>{role}</Text>
    {profiles.map(profile => <ProfileLine key={profile.id} profile={profile} />)}
  </View>)}</>;
}

/** Linear's issue state is separate from the run's execution state; a cached record is not proof Linear is reachable. */
export function LinearLine({ tracking, fresh }: { tracking?: LinearTracking; fresh: boolean }) {
  if (!tracking) return null;
  const issue = tracking.issue;
  const status = tracking.status === "synced" ? "tracking confirmed" : tracking.status === "pending" ? "tracking pending" : tracking.status === "blocked" ? "tracking blocked" : "tracking error";
  return <View style={s.linear}>
    <Text style={tracking.status === "blocked" || tracking.status === "error" ? t.warning : t.note}>
      Linear{issue ? ` ${issue.identifier} · ${issue.state.name}` : ""} · {status}{!fresh ? " · last received" : ""}
    </Text>
    {tracking.reason ? <Text style={t.warning}>{tracking.reason}</Text> : null}
    {issue && /^https:\/\//.test(issue.url) ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(issue.url)}><Text style={s.link}>{issue.title}</Text></Pressable> : null}
  </View>;
}

/** The outcome of the last request, and the controls for one whose delivery is unconfirmed. */
export function RequestStatus({ request, canRetry, subject }: { request: RunRequestControl; canRetry: boolean; subject: string }) {
  const pending = request.pending;
  return <>
    {request.message ? <Text accessibilityRole="alert" style={request.recorded ? t.note : t.warning}>{request.message}</Text> : null}
    {pending ? <View style={s.pending}>
      <Text style={t.note}>{request.busy ? "Sending" : "Unconfirmed"} {pending.label.toLowerCase()} · revision {pending.revision}</Text>
      {pending.fields.text ? <Text style={t.note} numberOfLines={2}>“{pending.fields.text}”</Text> : null}
      {!request.busy ? <View style={s.row}>
        <Button title="Retry same request" disabled={!canRetry} onPress={request.retry} />
        <Button title="Clear…" secondary onPress={() => Alert.alert("Clear the unconfirmed request?", `The host may already have applied it. Check the ${subject} first; clearing only forgets it on this phone.`, [
          { text: "Keep pending", style: "cancel" },
          { text: "Clear", style: "destructive", onPress: request.discard },
        ])} />
      </View> : null}
    </View> : null}
  </>;
}

/** The docked direction field for a team or goal; `note` replaces it when steering is unavailable. */
export function SteerBox({ value, onChange, placeholder, enabled, busy, note, onSend }: {
  value: string; onChange: (text: string) => void; placeholder: string; enabled: boolean; busy: boolean; note?: string; onSend: () => void;
}) {
  if (note) return <Text style={t.note}>{note}</Text>;
  return <View style={s.steer}>
    <TextInput accessibilityLabel="Direction" value={value} onChangeText={onChange} editable={enabled && !busy} multiline maxLength={8000}
      placeholder={placeholder} placeholderTextColor={theme.colors.placeholder} style={s.steerInput} />
    <Button title={busy ? "Sending…" : "Send"} disabled={!enabled || busy || !value.trim()} onPress={onSend} />
  </View>;
}

/** A person's choice between a few fixed values, shown as the app's toggle buttons. */
export function Choices<T extends string | number>({ values, selected, label, disabled, onSelect }: {
  values: readonly T[]; selected: T | undefined; label: (value: T) => string; disabled?: boolean; onSelect: (value: T) => void;
}) {
  return <View style={s.wrap}>{values.map(value => <Button key={String(value)} title={label(value)} secondary={selected !== value} disabled={disabled} onPress={() => onSelect(value)} />)}</View>;
}

/** Shared text styles for the team and goal screens. */
export const t = StyleSheet.create({
  title: { fontSize: 26, fontWeight: "500", color: theme.colors.ink, letterSpacing: -0.7 },
  body: { fontSize: 15, lineHeight: 23, color: theme.colors.ink },
  strong: { fontSize: 15, lineHeight: 22, fontWeight: "600", color: theme.colors.ink },
  note: { fontSize: 12, lineHeight: 19, color: theme.colors.mutedInk },
  warning: { fontSize: 13, lineHeight: 20, color: theme.colors.warningInk },
  error: { fontSize: 13, lineHeight: 20, color: theme.colors.error },
  label: { fontSize: 14, fontWeight: "600", color: theme.colors.ink, marginTop: 16 },
  mono: { fontFamily: theme.mono, fontSize: 12, color: theme.colors.screenInk },
  banner: { backgroundColor: theme.colors.warningSurface, color: theme.colors.warningInk, fontSize: 12, lineHeight: 19, padding: 14 },
  input: { borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.control, padding: 14, minHeight: 50, color: theme.colors.ink, fontSize: 15 },
  multiline: { minHeight: 110, textAlignVertical: "top" },
  card: { borderWidth: 1, borderColor: theme.colors.rule, borderRadius: theme.radius.panel, padding: 14, gap: 6, backgroundColor: theme.colors.white },
  attention: { borderColor: theme.colors.warningInk, backgroundColor: theme.colors.warningSurface },
});

const s = StyleSheet.create({
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: "transparent", alignSelf: "flex-start" },
  pillText: { fontSize: 12, fontWeight: "600" },
  amber: { backgroundColor: theme.colors.warningSurface },
  amberText: { color: theme.colors.warningInk },
  forest: { backgroundColor: theme.colors.secondarySurface },
  forestText: { color: theme.colors.running },
  muted: { backgroundColor: theme.colors.screenSurface },
  mutedText: { color: theme.colors.mutedInk },
  error: { backgroundColor: theme.colors.paper, borderColor: theme.colors.error },
  errorText: { color: theme.colors.error },
  section: { gap: 8, marginTop: theme.space.section },
  heading: { fontSize: 14, fontWeight: "600", color: theme.colors.ink },
  count: { fontWeight: "400", color: theme.colors.mutedInk },
  disclosure: { paddingVertical: 8 },
  disclosureText: { fontSize: 13, fontWeight: "600", color: theme.colors.secondaryInk },
  disclosed: { gap: 6, paddingBottom: 6 },
  linear: { gap: 2 },
  link: { fontSize: 13, lineHeight: 20, color: theme.colors.forest, textDecorationLine: "underline" },
  pending: { gap: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  steer: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  steerInput: { flex: 1, borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.control, paddingHorizontal: 14, paddingVertical: 12, minHeight: 48, maxHeight: 140, color: theme.colors.ink, fontSize: 15, backgroundColor: theme.colors.white },
});
