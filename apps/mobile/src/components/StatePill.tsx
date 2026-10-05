import { StyleSheet, Text, View } from "react-native";
import type { AttentionState } from "@infinite/attention";
import { theme } from "../theme";

const LABEL: Record<AttentionState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  "turn-finished": "Turn finished",
  idle: "Idle",
  exited: "Exited",
  unavailable: "Unreachable",
  "recording-error": "Recording error",
};

type Tone = "amber" | "forest" | "muted" | "error";
const TONE: Record<AttentionState, Tone> = {
  "needs-you": "amber",
  working: "forest",
  "turn-finished": "muted",
  idle: "muted",
  exited: "muted",
  unavailable: "error",
  "recording-error": "error",
};

export function StatePill({ state }: { state: AttentionState }) {
  const tone = TONE[state];
  return (
    <View accessible accessibilityLabel={`State: ${LABEL[state]}`} style={[s.pill, s[tone]]}>
      <Text style={[s.text, s[`${tone}Text`]]}>{LABEL[state]}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "transparent",
    alignSelf: "flex-start",
  },
  text: { fontSize: 12, fontWeight: "600" },
  amber: { backgroundColor: theme.colors.warningSurface },
  amberText: { color: theme.colors.warningInk },
  forest: { backgroundColor: theme.colors.secondarySurface },
  forestText: { color: theme.colors.running },
  muted: { backgroundColor: theme.colors.screenSurface },
  mutedText: { color: theme.colors.mutedInk },
  error: { backgroundColor: theme.colors.paper, borderColor: theme.colors.error },
  errorText: { color: theme.colors.error },
});
