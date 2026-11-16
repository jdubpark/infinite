import { useCallback, useSyncExternalStore } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { api, connectionKey, type Connection } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";
import { createHaltStore, haltNotice, haltSince, type HaltPlace, type HaltState, type HaltView } from "./model";

// Every screen reads the same snapshot per machine; a screen opened during a halt shows it at once.
const halts = createHaltStore();

/** Reads `GET /api/halt` every four seconds while the screen is focused, and shows the newest read of any screen. */
function useHalt(connection: Connection): HaltView | null {
  const key = connectionKey(connection);
  usePoll(async () => {
    const ticket = halts.begin();
    halts.record(key, ticket, await api<HaltView>(connection, "/halt"));
  }, 4000, [connection]);
  return useSyncExternalStore(halts.subscribe, useCallback(() => halts.get(key), [key]));
}

const HELD = "No new team, goal, mission, or routine work starts";

function facts(halt: HaltState) {
  return [`Since ${haltSince(halt.at)} · from ${halt.by}`, halt.reason ? `“${halt.reason}”` : ""].filter(Boolean);
}

/**
 * The owner's halt on this screen. It lasts until the owner releases it with `infinite halt off`, so it sits in the
 * content instead of floating, and it has no controls.
 */
export function HaltBanner({ connection, place, names, style }: {
  connection: Connection; place: HaltPlace; names?: (projectId: string) => string | undefined; style?: StyleProp<ViewStyle>;
}) {
  const notice = haltNotice(useHalt(connection), place);
  if (!notice) return null;
  const name = (projectId: string) => names?.(projectId) ?? projectId;
  let title: string, detail: string | undefined, lines: string[];
  if (notice.kind === "unreadable") {
    title = "Halted: the host cannot read its halt record";
    detail = "It holds every launch until it can read the record again.";
    lines = [];
  } else if (notice.kind === "host") {
    title = "Halted by the owner for the whole host";
    detail = `${HELD}; running goals and missions stay paused. Direct sessions keep running.`;
    lines = [...facts(notice.halt), ...(notice.projects.length ? [`Also halted on their own: ${notice.projects.map(halt => name(halt.projectId)).join(", ")}`] : [])];
  } else if (notice.kind === "project") {
    const single = typeof place === "object" && place.projectIds.length === 1;
    title = single ? "Halted by the owner for this project" : `Halted by the owner for ${notice.halts.map(halt => name(halt.projectId)).join(", ")}`;
    detail = `${HELD} here; running goals and missions stay paused. Direct sessions keep running.`;
    lines = notice.halts.flatMap(facts);
  } else {
    title = notice.halts.length === 1 ? "1 project halted by the owner" : `${notice.halts.length} projects halted by the owner`;
    lines = notice.halts.map(halt => [name(halt.projectId), `since ${haltSince(halt.at)}`, halt.reason ? `“${halt.reason}”` : ""].filter(Boolean).join(" · "));
  }
  const compact = notice.kind === "overview";
  return <View accessible accessibilityLabel={[title, detail, ...lines].filter(Boolean).join(". ")} style={[s.banner, compact && s.compact, style]}>
    <View style={s.head}>
      <Glyph name="pause" size={14} color={theme.colors.warningInk} />
      <Text style={s.title}>{title}</Text>
    </View>
    {detail ? <Text style={s.detail}>{detail}</Text> : null}
    {lines.map((line, index) => <Text key={index} style={s.meta} numberOfLines={compact ? 2 : 4}>{line}</Text>)}
  </View>;
}

const s = StyleSheet.create({
  banner: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.warningSurface, paddingHorizontal: 13, paddingVertical: 11, gap: 3 },
  compact: { paddingVertical: 9 },
  head: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.warningInk },
  detail: { fontSize: 13, lineHeight: 18, color: theme.colors.warningInk },
  meta: { fontSize: 12, lineHeight: 17, color: theme.colors.warningInk },
});
