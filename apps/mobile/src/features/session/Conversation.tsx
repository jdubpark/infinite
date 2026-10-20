import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, type ChatMessage, type Connection, type MessagesPage } from "../../api/client";
import { useLive } from "../../api/useLive";
import { conversationActivity, shouldRefreshConversation, type ConversationActivity } from "./liveState";
import { theme } from "../../theme";

export function Conversation({ connection, id, onStaleChange }: { connection: Connection; id: string; onStaleChange?: (stale: boolean) => void }) {
  const cursor = useRef<string | number>("");
  const eventCursor = useRef(0);
  const messages = useRef<ChatMessage[]>([]);
  const activity = useRef<{ id: string; value: ConversationActivity | null }>({ id, value: null });
  const { data, loading, stale } = useLive<MessagesPage>(connection, {
    topics: [`session/${id}`], intervalMs: 15000, deps: [id], after: () => eventCursor.current,
    refreshOnEvent(topic, payload) {
      if (topic !== `session/${id}`) return false;
      const previous = activity.current.id === id ? activity.current.value : null;
      const refresh = shouldRefreshConversation(previous, payload);
      activity.current = { id, value: conversationActivity(payload) };
      return refresh;
    },
    async load() {
      const page = await api<MessagesPage>(connection, `/sessions/${id}/messages?limit=100${cursor.current === "" ? "" : `&after=${encodeURIComponent(cursor.current)}`}`);
      cursor.current = page.cursor;
      const merged = new Map(messages.current.map(message => [message.id, message]));
      for (const message of page.messages) merged.set(message.id, message);
      messages.current = [...merged.values()].slice(-500);
      return { ...page, messages: messages.current };
    },
    select(topic, payload, previous) {
      if (topic !== `session/${id}`) return;
      eventCursor.current = Math.max(eventCursor.current, (payload as { events: { cursor: number } }).events.cursor);
      return previous ?? undefined;
    },
  });
  useEffect(() => { onStaleChange?.(stale); }, [onStaleChange, stale]);
  return <View style={s.list}>
    <Text style={s.note}>{data?.source === "recording" ? "From the recording · full output in Terminal" : "Provider conversation"}</Text>
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
