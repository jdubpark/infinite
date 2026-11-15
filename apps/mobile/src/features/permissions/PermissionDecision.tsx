import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { ApiError, api, connectionKey, type Connection } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { LiveStatus, TopBar } from "../../components/Glass";
import { useKeyboardPadding } from "../../components/keyboard";
import { theme } from "../../theme";
import { Section, t } from "../teams/parts";
import { deliveryLabels, isSessionId, rejectStates, seconds, verdictColors, verdictWords, when, type DecisionEntry, type Mark } from "./model";

// A mark that has not been confirmed keeps its request id across screen changes, so a retry cannot record it twice.
const pendingMarks = new Map<string, { requestId: string; note: string }>();

/** One recorded decision: the request, the verdict and its reviewers, delivery, the reviewer note and the owner's marks. */
export function PermissionDecision({ connection, id }: { connection: Connection; id: string }) {
  const router = useRouter(), machine = connectionKey(connection);
  // The mark form sits at the end of the page: the keyboard's height is added below it, and the page follows the field.
  const keyboardPadding = useKeyboardPadding(), page = useRef<ScrollView>(null);
  useEffect(() => { if (keyboardPadding) page.current?.scrollToEnd({ animated: true }); }, [keyboardPadding]);
  const decision = usePoll(() => api<{ entry: DecisionEntry }>(connection, `/permissions/decisions/${encodeURIComponent(id)}`).then(value => value.entry), 15000, [connection, id]);
  const top = <TopBar backLabel="Decisions" onBack={() => { if (router.canGoBack()) router.back(); else router.replace({ pathname: "/permissions", params: { machine } }); }}
    right={<LiveStatus online={decision.online} loading={decision.loading} seen={decision.seen} stale={decision.stale} />} />;
  const entry = decision.data;
  if (!entry) return <View style={s.fill}>{top}<View style={s.empty}>
    {decision.loading ? <ActivityIndicator color={theme.colors.forest} /> : <Text style={t.note}>Could not load this decision.</Text>}
  </View></View>;
  const workspace = entry.workspaceName ?? entry.workspaceId, project = entry.projectName ?? entry.projectId;
  const requester = [entry.role, entry.provider, entry.family && `${entry.family} family`].filter(Boolean).join(" · ");
  const openDecision = (target: string) => router.push({ pathname: "/permissions/[id]", params: { id: target, machine } });
  return <View style={s.fill}>
    {top}
    {decision.stale ? <Text style={t.banner}>Offline · last received record.</Text> : null}
    <ScrollView ref={page} style={s.fill} contentContainerStyle={[s.body, { paddingBottom: s.body.paddingBottom + keyboardPadding }]} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={decision.refreshing} onRefresh={decision.refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <Text style={s.eyebrow}>{project === workspace ? workspace : `${workspace} · ${project}`}</Text>
      <Text style={s.action} accessibilityRole="header">{entry.action.summary || entry.action.tool}</Text>
      <Text style={[s.verdict, { color: entry.verdict === "allow" ? theme.colors.running : verdictColors[entry.verdict] }]}>{verdictWords(entry)}</Text>
      <Text style={t.note}>{[when(entry.at), entry.rejectState ? rejectStates[entry.rejectState] : ""].filter(Boolean).join(" · ")}</Text>
      {entry.rateFlagged ? <Text style={[t.banner, s.notice]}>This session is above its workspace’s usual decision rate. Nothing stops on it.</Text> : null}
      <Section title="Request">
        <Field label="Tool"><Text style={t.mono}>{entry.action.tool}</Text></Field>
        <Field label="Action"><Text style={t.mono} selectable>{entry.action.summary}</Text></Field>
        <Field label="Session">{isSessionId(entry.sessionId)
          ? <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: "/session/[id]", params: { id: entry.sessionId, machine } })} hitSlop={6}><Text style={[t.mono, s.link]}>{entry.sessionId.slice(0, 8)}</Text></Pressable>
          : <Text style={t.mono}>{entry.sessionId}</Text>}{requester ? <Text style={t.note}>{requester}</Text> : null}</Field>
        <Field label="Task"><Text style={t.mono} selectable>{entry.taskId}</Text></Field>
        <Field label="Assignment"><Text style={t.mono} selectable>{entry.assignment}</Text></Field>
        <Field label="Evidence"><Text style={t.mono} selectable>{entry.evidenceHash}</Text></Field>
        <Field label="Decision id"><Text style={t.mono} selectable>{entry.id}</Text></Field>
      </Section>
      <Section title="Decision">
        <Field label="Host rules"><Text style={t.mono}>{entry.rules.length ? entry.rules.join("  ") : "None matched"}</Text></Field>
        <Field label="Reviewers">{entry.tiers.length ? entry.tiers.map((tier, index) => <Text key={index} style={t.body}>
          {tier.tier === "strong" ? "Strong" : "Light"} · {tier.profileId} · {tier.family} · {seconds(Date.parse(tier.endedAt) - Date.parse(tier.startedAt))}</Text>)
          : <Text style={t.body}>{entry.replayOf ? "No model turn: a recorded verdict was replayed" : "No model turn"}</Text>}</Field>
        {entry.durationMs !== null ? <Field label="Time to decide"><Text style={t.body}>{seconds(entry.durationMs)}</Text></Field> : null}
        {entry.replayOf ? <Field label="Replays"><Pressable accessibilityRole="link" onPress={() => openDecision(entry.replayOf!)} hitSlop={6}><Text style={[t.mono, s.link]}>{entry.replayOf}</Text></Pressable></Field> : null}
        {entry.repeats ? <Field label="Repeats"><Pressable accessibilityRole="link" onPress={() => openDecision(entry.repeats!)} hitSlop={6}><Text style={[t.mono, s.link]}>{entry.repeats}</Text></Pressable></Field> : null}
        {entry.controls.map((control, index) => <Field key={index} label={control.kind === "reopen" ? "Reopened" : "Closed"}>
          <Text style={t.body}>{when(control.at)}{control.reason ? ` · ${control.reason.replaceAll("-", " ")}` : ""}</Text></Field>)}
      </Section>
      <Section title="Delivery">
        {entry.deliveries.length ? entry.deliveries.map(event => <Text key={event.seq} style={t.body}>
          <Text style={t.note}>{when(event.at)}  </Text>{deliveryLabels[event.kind] ?? event.kind}{event.detail ? ` · ${event.detail}` : ""}</Text>)
          : <Text style={t.note}>No delivery event is recorded.</Text>}
      </Section>
      {entry.note ? <Section title="Reviewer note">
        <Text style={t.note}>Only you see this note. No agent receives it.</Text>
        <Text style={t.body} selectable>{entry.note}</Text>
      </Section> : null}
      <Section title="Your marks" count={entry.marks.length || undefined}>
        {entry.marks.map(mark => <View key={mark.requestId} style={s.mark}><Text style={t.note}>Marked {mark.label} · {when(mark.at)}</Text><Text style={t.body}>{mark.note}</Text></View>)}
        <MarkForm connection={connection} decisionId={entry.id} marked={decision.refresh} />
      </Section>
    </ScrollView>
  </View>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <View style={s.field}><Text style={s.fieldLabel}>{label}</Text><View style={s.fieldValue}>{children}</View></View>;
}

function MarkForm({ connection, decisionId, marked }: { connection: Connection; decisionId: string; marked: () => void }) {
  const key = `${connectionKey(connection)}/${decisionId}`;
  const [pending, setPending] = useState(pendingMarks.get(key));
  const [note, setNote] = useState(pending?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  async function submit() {
    if (busy || (!pending && !note.trim())) return;
    const request = pending ?? { requestId: Crypto.randomUUID(), note: note.trim() };
    pendingMarks.set(key, request); setPending(request); setBusy(true); setMessage(null);
    try {
      await api<{ mark: Mark }>(connection, "/permissions/marks", { method: "POST", body: { requestId: request.requestId, decisionId, label: "wrong", note: request.note } });
      pendingMarks.delete(key); setPending(undefined); setNote("");
      setMessage({ text: "Mark recorded. It changes no decision.", error: false });
      marked();
    } catch (failure) {
      const status = failure instanceof ApiError ? failure.status : 0;
      // The host refused this request outright, so a new one may be sent; otherwise delivery is unknown and the retry keeps the request id.
      if (status >= 400 && status < 500) { pendingMarks.delete(key); setPending(undefined); }
      setMessage({ text: `${(failure as Error).message}${status >= 400 && status < 500 ? "" : " Delivery is unconfirmed. Retry keeps the same request."}`, error: true });
    } finally { setBusy(false); }
  }
  return <View style={s.form}>
    <Text style={t.label}>Mark this decision wrong</Text>
    <TextInput accessibilityLabel="Why was it wrong?" placeholder="What the decision should have been, and why…" placeholderTextColor={theme.colors.placeholder}
      value={pending?.note ?? note} onChangeText={setNote} editable={!busy && !pending} multiline maxLength={2000} style={[t.input, t.multiline]} />
    <Text style={t.note}>A mark is a record only. It changes no decision, no replay and no lock. To change later decisions, reopen the reject or change the workspace’s direction. The decision is offered as a replay case that you accept or drop.</Text>
    <View style={s.actions}>
      <Button compact title={busy ? "Recording…" : pending ? "Retry same request" : "Mark wrong"} disabled={busy || (!pending && !note.trim())} onPress={() => void submit()} />
    </View>
    {message ? <Text accessibilityRole={message.error ? "alert" : undefined} accessibilityLiveRegion="polite" style={message.error ? t.error : t.note}>{message.text}</Text> : null}
  </View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  empty: { padding: 30, alignItems: "center" },
  body: { paddingHorizontal: 16, paddingTop: 2, gap: 6, paddingBottom: 28 },
  eyebrow: { fontSize: 12, lineHeight: 17, color: theme.colors.forest },
  action: { fontFamily: theme.mono, fontSize: 18, lineHeight: 25, color: theme.colors.ink },
  verdict: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  notice: { borderRadius: theme.radius.card, marginTop: 8 },
  field: { flexDirection: "row", gap: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  fieldLabel: { width: 92, fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
  fieldValue: { flex: 1, gap: 3 },
  link: { color: theme.colors.forest },
  mark: { gap: 3, paddingVertical: 6 },
  form: { gap: 8 },
  actions: { flexDirection: "row", alignItems: "center", gap: 10 },
});
