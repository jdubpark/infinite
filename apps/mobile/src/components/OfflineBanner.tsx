import { StyleSheet, Text } from "react-native";
import { theme } from "../theme";

/** The stale-view warning shown while the host is unreachable. */
export function OfflineBanner({
  online,
  message,
}: {
  online: boolean;
  message: string;
}) {
  if (online) return null;
  return <Text style={s.warning}>{message}</Text>;
}

const s = StyleSheet.create({
  warning: {
    backgroundColor: theme.colors.warningSurface,
    color: theme.colors.warningInk,
    fontSize: 12,
    lineHeight: 19,
    padding: 14,
  },
});
