import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, type Connection, type SessionDetail } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { DecisionCard } from "../../components/DecisionCard";
import { FloatingNotice } from "../../components/FloatingNotice";
import { useAnswer } from "../session/useAnswer";
import { useControlSync, useSessionControl } from "../session/useSessionControl";
import { t } from "../teams/parts";
import type { QueueDecision } from "./model";

type SessionQueueDecision = Extract<QueueDecision, { kind: "session" }>;

export function QueueSessionAnswer({ connection, decision, permitted, online, onClosed, onSending, onOpenSession }: {
  connection: Connection; decision: SessionQueueDecision; permitted: boolean; online: boolean;
  onClosed: () => void; onSending: (sending: boolean) => void; onOpenSession: () => void;
}) {
  const id = decision.origin.id;
  const control = useSessionControl(connection, id);
  const poll = usePoll(async () => {
    const revision = control.generation();
    const session = await api<SessionDetail>(connection, `/sessions/${id}`);
    return { session, revision };
  }, 2000, [connection, id]);
  useControlSync(control, poll.data, poll.stale);
  const session = poll.data?.session ?? null;
  const requiresControl = session?.capabilities?.inputControl === 1;
  const answering = useAnswer(connection, id, decision.prompt, poll.refresh, control, requiresControl);
  const running = session?.status === "running";
  const sending = answering.status.kind === "sending";
  const sent = answering.status.kind === "sent";
  const { lease, forget } = control;
  const handlers = useRef({ onClosed, onSending });
  useEffect(() => { handlers.current = { onClosed, onSending }; });
  useEffect(() => { handlers.current.onSending(sending); }, [sending]);
  useEffect(() => { if (sent) { if (lease) forget(true); handlers.current.onClosed(); } }, [sent, lease, forget]);

  async function answer(option?: number, text?: string) {
    if (requiresControl && !control.lease) await control.claim(false);
    answering.answer(option, text);
  }

  const gate = !session ? (poll.loading ? "Checking the session…" : "The session could not be read. Answers stay off until it can.")
    : !running ? "The session is not running." : undefined;
  return <View style={s.wrap}>
    {control.message && !control.lease ? <Text style={t.note}>{control.message}</Text> : null}
    <DecisionCard key={decision.prompt.id} prompt={decision.prompt} backend={session?.backend} status={answering.status}
      canAnswer={permitted && online && running && !control.busy && !answering.forbidden} readOnly={!permitted || answering.forbidden}
      gate={gate} onAnswer={(option, text) => void answer(option, text)} onRetry={answering.retry} onOpenTerminal={onOpenSession} />
    <FloatingNotice position="bottom" offset={0} message={answering.notice} accessibilityRole="alert" onDismiss={answering.dismissNotice} />
  </View>;
}

const s = StyleSheet.create({ wrap: { gap: 8, position: "relative" } });
