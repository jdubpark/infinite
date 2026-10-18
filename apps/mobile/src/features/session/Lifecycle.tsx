import { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import { api, connectionKey, type Connection, type Me, type SessionDetail } from "../../api/client";
import { Button } from "../../components/Button";
import { theme } from "../../theme";
import { lifecycles } from "../../store/requests";

export function Lifecycle({ connection, session, role, online, control, refresh }: {
  connection: Connection; session: SessionDetail; role?: Me["role"]; online: boolean; control?: string; refresh: () => void;
}) {
  const router = useRouter();
  const key = `${connectionKey(connection)}/${session.id}`;
  const lifecycle = lifecycles.use(key);
  const pending = lifecycle.pending;
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [sendingId, setSendingId] = useState<string>();
  const busy = Boolean(pending && sendingId === pending.requestId);
  const running = session.status === "running" || session.status === "starting";
  const canStop = online && (!session.capabilities?.inputControl || Boolean(control));
  useEffect(() => {
    if (!online) return;
    if (session.status === "exited" && pending?.action === "stop")
      lifecycles.complete(key, pending.requestId, undefined, "Session has exited. The end request was not confirmed; you can resume explicitly.");
    else if (running && lifecycle.result?.id === session.id) lifecycles.clear(key);
  }, [key, online, session.status, session.id, running, pending, lifecycle.result]);
  async function act(action: "stop" | "resume") {
    if (!online || role !== "owner") return;
    const request = lifecycles.begin(key, { action, requestId: Crypto.randomUUID() });
    if (inFlight.current.has(request.requestId)) return;
    inFlight.current.add(request.requestId);
    setSendingId(request.requestId);
    try {
      const result = await api<SessionDetail & { state?: string }>(connection, `/sessions/${session.id}/${request.action}`, { body: { requestId: request.requestId }, control });
      if (result.state === "uncertain") throw new Error("The machine could not confirm the result.");
      const settled = lifecycles.complete(key, request.requestId, request.action === "resume" && result.id ? { id: result.id } : undefined, request.action === "stop" ? "End requested. Refreshing the session state." : "");
      if (settled && mounted.current && request.action === "resume" && result.id) router.replace({ pathname: "/session/[id]", params: { id: result.id, machine: connectionKey(connection) } });
      if (mounted.current) refresh();
    } catch (error) { lifecycles.fail(key, request.requestId, `${(error as Error).message} Check the session state before retrying. Retry keeps the same request ID.`); }
    finally { inFlight.current.delete(request.requestId); if (mounted.current) setSendingId(current => current === request.requestId ? undefined : current); }
  }
  if (role !== "owner") return null;
  return <View style={s.area}>
    {lifecycle.result ? <Button title="Open resumed session" onPress={() => router.replace({ pathname: "/session/[id]", params: { id: lifecycle.result!.id, machine: connectionKey(connection) } })} /> : pending ? <Button title={busy ? "Waiting…" : `Retry ${pending.action === "stop" ? "end" : "resume"}`} secondary disabled={busy || !online || (pending.action === "stop" && !canStop)} onPress={() => void act(pending.action)} /> : running ? <Button title="End session" secondary disabled={busy || !canStop} onPress={() => Alert.alert("End this session?", "This stops the agent process. Its recording is kept. Resume is available only when the provider has a saved conversation.", [{ text: "Keep running", style: "cancel" }, { text: "End session", style: "destructive", onPress: () => void act("stop") }])} /> : session.resumable && !session.team ? <Button title="Resume session" disabled={busy || !online} onPress={() => void act("resume")} /> : null}
    {lifecycle.message ? <Text style={s.note} accessibilityRole="alert">{lifecycle.message}</Text> : null}
  </View>;
}
const s = StyleSheet.create({ area: { gap: 8, marginTop: 12 }, note: { color: theme.colors.warningInk, fontSize: 12, lineHeight: 18 } });
