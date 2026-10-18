import { StyleSheet, Text, View } from "react-native";
import type { ControlLease, Me } from "../api/client";
import { theme } from "../theme";
import { Button } from "./Button";

/**
 * Who may type into this session, and the explicit way to take control. A worker that enforces
 * control needs this phone to hold the lease before any input; another device's lease is shown
 * by its label and needs "Take over". Older workers take shared input, so the bar shows only a
 * pending message for them. Pull down on the record to refresh.
 * A lease still held after the process stops stays visible so it can be released.
 */
export function ControlBar({
  role,
  requiresControl,
  running,
  online,
  lease,
  holder,
  busy,
  message,
  onTake,
  onRelease,
}: {
  role: Me["role"] | undefined;
  requiresControl: boolean;
  running: boolean;
  online: boolean;
  lease: ControlLease | null;
  holder: ControlLease | null;
  busy: boolean;
  message: string;
  onTake: (takeover: boolean) => void;
  onRelease: () => void;
}) {
  // Control only matters while the process runs; a stopped session keeps just a pending message.
  const shown = requiresControl && (running || lease !== null);
  if (!shown && !message) return null;
  const viewer = role === undefined || role === "viewer";
  const other = requiresControl && !lease ? holder : null;
  return (
    <View style={s.area}>
      {shown ? <View style={s.row}>
        <View style={[s.dot, lease ? s.dotOn : null]} />
        <Text style={s.title} numberOfLines={1}>
          {lease ? "You have control" : other ? `${other.label} has control` : "Monitoring"}
        </Text>
        {!viewer && running ? (
          lease ? (
            <Button compact secondary title="Release" onPress={onRelease} />
          ) : (
            <Button
              compact
              title={busy ? "Requesting…" : other ? "Take over" : "Take control"}
              disabled={!online || busy}
              onPress={() => onTake(Boolean(other))}
            />
          )
        ) : null}
      </View> : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={s.small}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  area: { marginHorizontal: 16, marginBottom: 6, gap: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 4,
    minHeight: 42,
    borderRadius: theme.radius.capsule,
    backgroundColor: theme.colors.secondarySurface,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.placeholder },
  dotOn: { backgroundColor: theme.colors.running },
  title: { flex: 1, fontSize: 13, fontWeight: "600", color: theme.colors.ink },
  small: { fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
});
