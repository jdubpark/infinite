import { StyleSheet, Text } from "react-native";
import type { Attention, PromptSource } from "@infinite/attention";
import { theme } from "../theme";

/** Where the signal came from: hooks active, screen only, or a prompt read off the screen. */
export function SourceTag({ hooks, source }: { hooks: Attention["hooks"]; source?: PromptSource }) {
  const text =
    source === "screen" ? "detected from screen" : hooks === "active" ? "hooks active" : "screen only";
  return <Text style={s.tag}>{text}</Text>;
}

const s = StyleSheet.create({
  tag: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
});
