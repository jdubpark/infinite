import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { useClock } from "../../api/useClock";
import { Button } from "../../components/Button";
import { LiveStatus, TopBar } from "../../components/Glass";
import { age } from "../../status";
import { theme } from "../../theme";
import { runRequests } from "../../store/requests";
import { useRunRequest } from "../teams/useRunRequest";
import { t } from "../teams/parts";
import { answerGate, answerSend, createQueueState, decisionForPath, kindLabel, moveQueue, queueRequestKey, QUEUE_ME_POLL_MS, reconcileQueue, removeAnswered, SWAP_GUARD_MS, toggleChoice, type QueueDecision } from "./model";
import { QueueChoices } from "./QueueChoices";
import { QueueSessionAnswer } from "./QueueSessionAnswer";
import { useDecisionQueue } from "./useDecisionQueue";


export function DecisionQueueScreen({ connection }: { connection: Connection }) {
  const router = useRouter();
  const machine = connectionKey(connection);
  const feed = useDecisionQueue(connection);
  const me = usePoll(() => api<Me>(connection, "/me"), QUEUE_ME_POLL_MS, [connection]);
  const [state, setState] = useState(() => createQueueState());
  const [sessionSending, setSessionSending] = useState(false);
  const known = useRef<string[]>([]);
  const [recorded, setRecorded] = useState("");
  const [armedKey, setArmedKey] = useState<string>();
  const now = useClock(QUEUE_ME_POLL_MS);
  const [seenDecisions, setSeenDecisions] = useState<QueueDecision[] | null>(null);
  if (feed.decisions !== seenDecisions) {
    setSeenDecisions(feed.decisions);
    if (feed.decisions) setState(previous => reconcileQueue(previous, feed.decisions ?? []));
  }
  const active = state.decisions.find(decision => decision.key === state.activeKey);
  const role = me.data?.role;
  const projects = me.data?.projects;

  useEffect(() => {
    if (!feed.decisions) return;
    const listed = new Set(feed.decisions.map(decision => decision.key));
    for (const key of known.current) if (!listed.has(key)) runRequests.clear(queueRequestKey(machine, key));
    known.current = [...listed];
  }, [feed.decisions, machine]);

  const { confirmAnswered, refresh } = feed;
  const activeKey = active?.key;
  const swapped = state.activeLeft;
  useEffect(() => {
    if (!swapped || !activeKey) return;
    const timer = setTimeout(() => setArmedKey(activeKey), SWAP_GUARD_MS);
    return () => clearTimeout(timer);
  }, [swapped, activeKey]);
  const settle = useCallback((key: string) => {
    setRecorded("Answer recorded.");
    setTimeout(() => setRecorded(""), 5000);
    confirmAnswered(key);
    setState(previous => removeAnswered(previous, key));
    refresh();
  }, [confirmAnswered, refresh]);
  const run = useRunRequest<{ id: string; revision: number }>(connection, queueRequestKey(machine, active?.key ?? ""), {
    accepted: (_result, request) => {
      const answered = decisionForPath(state.decisions, request.path);
      if (answered) settle(answered.key);
    },
    refused: feed.refresh,
  });

  const promptAnswers = me.data?.capabilities?.answer !== false;
  const permitted = role !== undefined && role !== "viewer" && promptAnswers;
  const gate = active && me.data ? answerGate({ decision: active, role, promptAnswers, online: feed.online }) : undefined;
  const canAnswer = gate?.kind === "answer" && (!swapped || armedKey === activeKey);
  const navigationLocked = run.busy || sessionSending;
  const index = active ? state.decisions.findIndex(decision => decision.key === active.key) : -1;
  const waited = active && now ? age(active.since, now).replace(/^now$/, "under a minute") : "";
  const back = () => { if (router.canGoBack()) router.back(); else router.replace({ pathname: "/", params: { machine } }); };
  const openSession = (id: string) => router.push({ pathname: "/session/[id]", params: { id, machine } });
  const projectName = (id?: string) => id ? projects?.find(project => project.id === id)?.name ?? id : "";
  const sendText = (decision: Exclude<QueueDecision, { kind: "session" }>, text: string) => {
    const send = answerSend(decision, text);
    if (decision.key === active?.key && canAnswer && send) run.send(send.path, send.label, send.revision, send.fields);
  };

  return <View style={s.fill}>
    <TopBar backLabel="Home" onBack={back} right={<LiveStatus online={feed.online} loading={feed.loading} seen={feed.seen} stale={feed.stale} />} />
    {feed.stale && feed.decisions ? <Text style={t.banner}>Offline · answers stay off until the queue refreshes.</Text> : null}
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={feed.refreshing} onRefresh={feed.refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <Text style={s.title} accessibilityRole="header">Decisions</Text>
      <Text style={t.note}>One at a time, oldest first. Nothing is sent until you choose an answer.</Text>
      {recorded ? <Text style={t.note} accessibilityRole="alert" accessibilityLiveRegion="polite">{recorded}</Text> : null}
      {feed.unavailable ? <Text style={t.body} accessibilityRole="alert">This host has no decision queue. Update it to answer decisions here.</Text>
        : !feed.decisions ? <Text style={t.note} accessibilityRole="alert">{feed.loading ? "Reading decisions…" : "The decision queue could not be read. Pull down to try again."}</Text>
        : !active ? <Text style={s.empty}>No decisions wait on you.</Text>
        : <>
          <Text style={s.count} accessibilityLiveRegion="polite">Decision {index + 1} of {state.decisions.length} · waiting {waited}</Text>
          <View style={s.card}>
            <Text style={s.kind}>{kindLabel(active)}</Text>
            <Text style={s.origin} numberOfLines={2}>{active.origin.title}</Text>
            <Text style={t.note}>{[projectName(active.origin.projectId), active.origin.team ? `Team ${active.origin.team.title}` : ""].filter(Boolean).join(" · ")}</Text>
            {active.kind === "team" && active.held ? <Text style={t.warning}>A halt holds this team. Your answer is kept and work continues when the team resumes.</Text> : null}
            {gate?.kind === "blocked" ? <Text style={t.warning} accessibilityRole="alert">{gate.note}</Text> : null}
            {active.kind === "session" ? <>
              {active.terminalOnly ? <>
                <Text style={s.question} selectable>{active.prompt.title}</Text>
                {active.prompt.detail ? <Text style={t.mono} selectable>{active.prompt.detail}</Text> : null}
                <Button compact secondary glyph="terminal" title="Open session" onPress={() => openSession(active.origin.id)} />
              </> : <QueueSessionAnswer key={active.key} connection={connection} decision={active} permitted={permitted} online={feed.online}
                onClosed={() => settle(active.key)} onSending={setSessionSending} onOpenSession={() => openSession(active.origin.id)} />}
              <Button compact secondary title="Open session" onPress={() => openSession(active.origin.id)} />
            </> : <>
              <QueueChoices key={active.key} record={active.decision} selected={state.selected} enabled={canAnswer && !run.busy && !run.pending}
                onToggle={value => setState(previous => toggleChoice(previous, value))} onAnswer={text => sendText(active, text)} />
              {run.pending ? <View style={s.unconfirmed}>
                <Text style={t.warning}>Unconfirmed answer: {String(run.pending.fields.text ?? "").slice(0, 140)}</Text>
                <Button compact title="Retry the same answer" disabled={!canAnswer || run.busy} onPress={run.retry} />
              </View> : null}
              {run.message ? <View style={s.unconfirmed}>
                <Text style={run.recorded ? t.note : t.warning} accessibilityRole="alert">{run.message}</Text>
                <Button compact secondary title="Dismiss" onPress={run.dismissMessage} />
              </View> : null}
            </>}
          </View>
          {state.activeLeft ? <Text style={t.note} accessibilityRole="alert">The decision shown before is no longer in the queue.</Text> : null}
          <View style={s.nav}>
            <View style={s.navButton}><Button compact secondary title="Previous" disabled={index <= 0 || navigationLocked} onPress={() => setState(previous => moveQueue(previous, -1))} /></View>
            <View style={s.navButton}><Button compact secondary title="Skip" disabled={index >= state.decisions.length - 1 || navigationLocked} onPress={() => setState(previous => moveQueue(previous, 1))} /></View>
          </View>
        </>}
    </ScrollView>
  </View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", color: theme.colors.ink, letterSpacing: -0.6, marginTop: 4 },
  empty: { paddingVertical: 32, fontSize: 15, color: theme.colors.mutedInk, textAlign: "center" },
  count: { fontSize: 13, fontWeight: "600", color: theme.colors.ink, fontVariant: ["tabular-nums"], marginTop: 6 },
  card: { gap: 9, padding: 14, borderRadius: theme.radius.card, backgroundColor: theme.colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  kind: { fontSize: 12, fontWeight: "700", color: theme.colors.warningInk },
  origin: { fontSize: 18, lineHeight: 24, fontWeight: "600", color: theme.colors.ink, letterSpacing: -0.2 },
  question: { fontSize: 16, fontWeight: "600", lineHeight: 23, color: theme.colors.ink },
  unconfirmed: { gap: 8 },
  nav: { flexDirection: "row", gap: 10 },
  navButton: { flex: 1 },
});
