import { StyleSheet, Text, View } from "react-native";
import type { ControlLease, Me } from "../api/client";
import { theme } from "../theme";
import { Button } from "./Button";

/**
 * Who may type into this session, and the explicit way to take control. A worker that enforces
 * control needs this phone to hold the lease before any input; another device's lease is shown
 * by its label and needs "Take over". Older workers take shared input and show no button.
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
  onRefresh,
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
  /** Polls the host now; the screen shows a cached view until the answer arrives. */
  onRefresh: () => void;
}) {
  const viewer = role === undefined || role === "viewer";
  const title = requiresControl
    ? lease
      ? "You have control"
      : "Monitoring"
    : viewer
      ? "Monitoring"
      : "Shared controls";
  const other = requiresControl && !lease ? holder : null;
  return (
    <View style={s.area}>
      <View style={s.row}>
        <View style={s.text}>
          <Text style={s.title}>{title}</Text>
          {other ? (
            <Text style={s.small}>{`${other.label} has control`}</Text>
          ) : null}
        </View>
        <Button title="Refresh" secondary onPress={onRefresh} />
        {requiresControl && !viewer && running ? (
          lease ? (
            <Button title="Stop controlling" secondary onPress={onRelease} />
          ) : (
            <Button
              title={busy ? "Requesting…" : other ? "Take over" : "Take control"}
              disabled={!online || busy}
              onPress={() => onTake(Boolean(other))}
            />
          )
        ) : null}
      </View>
      {message ? (
        <Text accessibilityLiveRegion="polite" style={s.small}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  area: {
    paddingHorizontal: theme.space.section,
    paddingBottom: theme.space.label,
    gap: 6,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.space.compact,
  },
  text: { flexGrow: 1, flexBasis: 120 },
  title: { fontSize: 13, fontWeight: "600", color: theme.colors.ink },
  small: { fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
});
