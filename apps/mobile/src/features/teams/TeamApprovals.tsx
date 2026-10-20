import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, type Connection, type Me, type SessionDetail } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Avatar } from "../../components/Avatar";
import { DecisionCard } from "../../components/DecisionCard";
import { FloatingNotice } from "../../components/FloatingNotice";
import { theme } from "../../theme";
import { useAnswer } from "../session/useAnswer";
import { useControlSync, useSessionControl } from "../session/useSessionControl";
import { ROLE_NAMES, type PermissionDecision, type TeamMember } from "./model";
import { t } from "./parts";

/**
 * One agent's open provider prompt, answered from the team. The person's tap is the consent: the
 * answer goes to that exact prompt with this phone's control lease, borrowed only for the answer
 * and released once it lands. The coordinator's escalation reason, when it gave one, sits on top.
 */
export function AgentApproval({ connection, member, agent, provider, decision, me, onOpenSession }: {
  connection: Connection; member: TeamMember; agent: string; provider?: string; decision?: PermissionDecision; me: Me | null; onOpenSession: () => void;
}) {
  const id = member.sessionId;
  const control = useSessionControl(connection, id);
  const poll = usePoll(async () => {
    // A poll that started before a local control change must not undo it.
    const revision = control.generation();
    const session = await api<SessionDetail>(connection, `/sessions/${id}`);
    return { session, revision, receivedAt: Date.now() };
  }, 2000, [connection, id]);
  useControlSync(control, poll.data, poll.stale);
  const session = poll.data?.session ?? null;
  const requiresControl = session?.capabilities?.inputControl === 1;
  const prompt = session?.attention.state === "needs-you" ? session.attention.prompt : undefined;
  const answering = useAnswer(connection, id, prompt, poll.refresh, control, requiresControl);
  const permitted = me !== null && me.role !== "viewer" && me.capabilities?.answer !== false && !answering.forbidden;
  const running = session?.status === "running";
  const sent = answering.status.kind === "sent";
  const { lease, forget } = control;
  useEffect(() => { if (sent && lease) forget(true); }, [sent, lease, forget]);

  async function answer(option?: number, text?: string) {
    // Enforcing workers take input only with a lease; claim it for this one answer.
    if (requiresControl && !control.lease) await control.claim(false);
    answering.answer(option, text);
  }

  return <View style={s.wrap}>
    <View style={s.head}>
      <Avatar label={agent} provider={provider} size={22} state="attention" />
      <Text style={s.who} numberOfLines={1}>{ROLE_NAMES[member.role]}</Text>
    </View>
    {decision?.status === "escalated" || decision?.status === "stale" || decision?.status === "uncertain"
      ? <Text style={s.reason} numberOfLines={3}>{decision.status === "escalated" ? "Escalated" : decision.status === "stale" ? "Coordinator's decision went stale" : "Coordinator unsure it landed"}{decision.reason ? `: ${decision.reason}` : ""}</Text> : null}
    {control.message && !control.lease ? <Text style={t.note}>{control.message}</Text> : null}
    {prompt ? <DecisionCard key={prompt.id} prompt={prompt} backend={session?.backend} status={answering.status}
      canAnswer={permitted && poll.online && running && !control.busy} readOnly={!permitted && me !== null}
      onAnswer={(option, text) => void answer(option, text)} onRetry={answering.retry} onOpenTerminal={onOpenSession} />
      : <Text style={t.note}>{poll.loading ? "Loading…" : "No longer open."}</Text>}
    <FloatingNotice position="bottom" offset={0} message={answering.notice} accessibilityRole="alert" onDismiss={answering.dismissNotice} />
  </View>;
}

const s = StyleSheet.create({
  wrap: { gap: 8, position: "relative" },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  who: { flex: 1, fontSize: 12, fontWeight: "700", color: theme.colors.warningInk },
  reason: { fontSize: 13, lineHeight: 19, color: theme.colors.warningInk },
});
