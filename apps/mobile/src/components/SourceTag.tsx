import { StyleSheet, Text } from "react-native";
import type { Attention } from "@infinite/attention";
import { theme } from "../theme";

/** The source of the current status, independent of the terminal recording. */
export function SourceTag({ hooks, source }: { hooks: Attention["hooks"]; source?: Attention["source"] }) {
  const text =
    source === "protocol" ? "provider events" : source === "screen" ? "detected from screen" : hooks === "active" ? "hooks active" : "screen only";
  return <Text style={s.tag}>{text}</Text>;
}

const s = StyleSheet.create({
  tag: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
});
