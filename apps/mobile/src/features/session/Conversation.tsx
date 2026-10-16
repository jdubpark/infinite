import { useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, type ChatMessage, type Connection, type MessagesPage } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { theme } from "../../theme";

export function Conversation({ connection, id }: { connection: Connection; id: string }) {
  const cursor = useRef<string | number>("");
  const messages = useRef<ChatMessage[]>([]);
  const { data, online, loading } = usePoll(async () => {
    const page = await api<MessagesPage>(connection, `/sessions/${id}/messages?limit=100${cursor.current === "" ? "" : `&after=${encodeURIComponent(cursor.current)}`}`);
    cursor.current = page.cursor;
    const merged = new Map(messages.current.map(message => [message.id, message]));
    for (const message of page.messages) merged.set(message.id, message);
    messages.current = [...merged.values()].slice(-500);
    return { ...page, messages: messages.current };
  }, 1500, [connection, id]);
  return <View style={s.list}>
    <Text style={s.note}>{data?.source === "recording" ? "Recorded messages and signals. Open Terminal for complete output." : "Provider conversation"}</Text>
    {!online && !loading ? <Text style={s.note}>Conversation may be stale. Reconnecting…</Text> : null}
    {data?.messages.map(message => <View key={message.id} style={[s.message, message.role === "user" && s.user]}>
      <Text style={s.role}>{message.toolName || (message.role === "assistant" ? "Agent" : message.role === "user" ? "You" : message.role)}{message.ts ? ` · ${new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</Text>
      <Text selectable style={s.text}>{message.text}</Text>
    </View>)}
    {!data?.messages.length ? <Text style={s.note}>{loading ? "Loading conversation…" : "No structured messages are available yet. Open Terminal to see the session output."}</Text> : null}
  </View>;
}
const s = StyleSheet.create({
  list: { gap: 12, paddingVertical: 10 }, note: { fontSize: 12, lineHeight: 19, color: theme.colors.mutedInk },
  message: { padding: 14, borderRadius: theme.radius.panel, backgroundColor: theme.colors.secondarySurface, gap: 8 },
  user: { borderLeftWidth: 3, borderLeftColor: theme.colors.forest },
  role: { fontSize: 11, color: theme.colors.mutedInk, fontWeight: "600" },
  text: { fontSize: 14, lineHeight: 22, color: theme.colors.ink },
});
