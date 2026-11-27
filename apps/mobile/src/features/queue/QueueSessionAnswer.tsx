import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, type Connection, type SessionDetail } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { DecisionCard } from "../../components/DecisionCard";
import { FloatingNotice } from "../../components/FloatingNotice";
import { useAnswer } from "../session/useAnswer";
import { useControlSync, useSessionControl } from "../session/useSessionControl";
import { t } from "../teams/parts";
import { controlStep, QUEUE_SESSION_POLL_MS, type QueueDecision } from "./model";

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
  }, QUEUE_SESSION_POLL_MS, [connection, id]);
  useControlSync(control, poll.data, poll.stale);
  const session = poll.data?.session ?? null;
  const requiresControl = session?.capabilities?.inputControl === 1 && !session.managedBy;
  const answering = useAnswer(connection, id, decision.prompt, poll.refresh, control, requiresControl);
  const running = session?.status === "running";
  const sending = answering.status.kind === "sending";
  const sent = answering.status.kind === "sent";
  const { lease, forget } = control;
  const handlers = useRef({ onClosed, onSending });
  useEffect(() => { handlers.current = { onClosed, onSending }; });
  useEffect(() => { handlers.current.onSending(sending); }, [sending]);
  useEffect(() => { if (sent) { if (lease) forget(true); handlers.current.onClosed(); } }, [sent, lease, forget]);

  const step = controlStep({ requiresControl, hasLease: Boolean(control.lease), holderLabel: control.holder?.label });
  const answerable = step.kind !== "take";

  const gate = !session ? (poll.loading ? "Checking the session…" : "The session could not be read. Answers stay off until it can.")
    : !running ? "The session is not running." : undefined;
  return <View style={s.wrap}>
    {control.message && !control.lease ? <Text style={t.note}>{control.message}</Text> : null}
    {permitted && running && step.kind === "take" ? <View style={s.control}>
      <Text style={t.note}>{step.takeover ? `${control.holder?.label} has control of this session.` : "Answering needs control of this session. You hold it until the answer is sent."}</Text>
      <Button compact title={step.takeover ? "Take over" : "Take control"} disabled={!online || control.busy} onPress={() => void control.claim(step.takeover)} />
    </View> : null}
    <DecisionCard key={decision.prompt.id} prompt={decision.prompt} backend={session?.backend} status={answering.status}
      canAnswer={permitted && online && running && answerable && !control.busy && !answering.forbidden} readOnly={!permitted || answering.forbidden}
      gate={gate} onAnswer={answering.answer} onRetry={answering.retry} onOpenTerminal={onOpenSession} />
    <FloatingNotice position="bottom" offset={0} message={answering.notice} accessibilityRole="alert" onDismiss={answering.dismissNotice} />
  </View>;
}

const s = StyleSheet.create({ wrap: { gap: 8, position: "relative" }, control: { gap: 8 } });
