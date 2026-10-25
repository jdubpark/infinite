import { Text, View } from "react-native";
import { theme } from "../../../theme";
import { styles } from "./styles";

/** A short notice from the host or the brief. Warnings use the amber tokens. */
export function Note({ tone, text }: { tone: "info" | "warning"; text: string }) {
  const warning = tone === "warning";
  return <View style={[styles.note, { backgroundColor: warning ? theme.colors.warningSurface : theme.colors.secondarySurface }]}>
    <Text style={[styles.noteText, { color: warning ? theme.colors.warningInk : theme.colors.secondaryInk }]}>{text}</Text>
  </View>;
}
