import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { PROVIDER_NAMES, groupSessions } from "@infinite/attention";
import {
  api,
  type Connection,
  type Me,
  type SessionRow,
} from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { OfflineBanner } from "../../components/OfflineBanner";
import { StatePill } from "../../components/StatePill";
import { theme } from "../../theme";

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function Inbox({
  connection,
  onDisconnect,
  pushNote,
}: {
  connection: Connection;
  onDisconnect: () => void;
  pushNote?: string;
}) {
  const router = useRouter();
  const { data, online, seen } = usePoll(
    async () => {
      const [list, me] = await Promise.all([
        api<{ sessions: SessionRow[] }>(connection, "/sessions"),
        api<Me>(connection, "/me"),
      ]);
      return {
        sessions: [...list.sessions].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
        environment: me.environment,
      };
    },
    2500,
    [connection],
  );
  const sessions = data?.sessions ?? [];
  return (
    <View style={s.fill}>
      <View style={s.header}>
        <Text style={s.brand}>infinite</Text>
        <View style={s.connection}>
          <View style={[s.dot, !online && s.offlineDot]} />
          <Text style={s.small}>{online ? "Connected" : "Reconnecting"}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={s.list}>
        <Text style={s.title}>Your sessions</Text>
        <Text style={s.body}>
          {data?.environment === "local"
            ? "Local rehearsal host"
            : "Your cloud workspace"}
        </Text>
        <OfflineBanner
          online={online}
          message="This view may be stale. Your agents may still be running. Check your private network connection."
        />
        <View style={s.listHeading}>
          <Text style={s.small}>
            {sessions.filter((session) => session.status === "running").length}{" "}
            running
          </Text>
          <Text style={s.small}>
            {seen ? `Checked ${seen}` : "Connecting…"}
          </Text>
        </View>
        {groupSessions(sessions).map((group) => (
          <View key={group.title}>
            <Text style={s.groupHeading}>{group.title.toUpperCase()}</Text>
            {group.rows.map((row) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${row.title}`}
                key={row.id}
                onPress={() =>
                  router.push({
                    pathname: "/session/[id]",
                    params: { id: row.id },
                  })
                }
                style={({ pressed }) => [
                  s.row,
                  row.attention.state === "needs-you" && s.rowNeedsYou,
                  pressed && s.pressed,
                ]}
              >
                <View style={s.rowTop}>
                  <Text style={s.rowTitle} numberOfLines={1}>
                    {row.title}
                  </Text>
                  <StatePill state={row.attention.state} />
                </View>
                <Text style={s.now} numberOfLines={2}>
                  {row.attention.prompt?.destructive ? (
                    <Text style={s.destructive}>⚠ </Text>
                  ) : null}
                  {row.attention.now || "—"}
                </Text>
                <Text style={s.meta}>
                  {PROVIDER_NAMES[row.provider]} ·{" "}
                  {timeAgo(row.attention.since)}
                </Text>
              </Pressable>
            ))}
          </View>
        ))}
        {!sessions.length && online && (
          <View style={s.empty}>
            <Text style={s.subtitle}>A session that stays.</Text>
            <Text style={s.body}>
              Start a session from your laptop. It will appear here as soon as
              the host receives it.
            </Text>
          </View>
        )}
      </ScrollView>
      <View style={s.bottom}>
        {pushNote ? <Text style={s.small}>{pushNote}</Text> : null}
        <Button
          title="Disconnect this phone"
          secondary
          onPress={onDisconnect}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 25,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.rule,
  },
  brand: {
    fontSize: 30,
    letterSpacing: -1.1,
    fontWeight: "600",
    color: theme.colors.ink,
  },
  connection: { flexDirection: "row", alignItems: "center", gap: 7 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.running,
  },
  offlineDot: { backgroundColor: theme.colors.warningInk },
  small: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
  list: { padding: 25 },
  title: {
    fontSize: 30,
    fontWeight: "500",
    color: theme.colors.ink,
    letterSpacing: -0.8,
    marginVertical: 10,
  },
  body: {
    fontSize: 15,
    lineHeight: 24,
    color: theme.colors.mutedInk,
    marginBottom: 20,
  },
  listHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.rule,
    paddingVertical: 15,
    marginTop: 10,
  },
  groupHeading: {
    fontSize: 12,
    letterSpacing: 0.6,
    fontWeight: "600",
    color: theme.colors.mutedInk,
    marginTop: theme.space.section,
    marginBottom: 4,
  },
  row: {
    paddingVertical: theme.space.label,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.rule,
    gap: 6,
  },
  rowNeedsYou: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.warningInk,
    paddingLeft: 12,
  },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 15,
  },
  rowTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: "500",
    color: theme.colors.ink,
  },
  now: { fontSize: 14, lineHeight: 20, color: theme.colors.ink },
  destructive: { color: theme.colors.error },
  meta: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
  bottom: { padding: theme.space.inset },
  empty: { padding: 30, gap: 15 },
  subtitle: {
    fontSize: 18,
    fontWeight: "500",
    color: theme.colors.ink,
    marginBottom: 15,
  },
});
