import { Text, View } from "react-native";
import type { WorkBlock } from "@infinite/remote";
import { theme } from "../../../theme";
import { styles } from "./styles";

export type WorkQuestion = Extract<WorkBlock, { kind: "questions" }>["items"][number];

const PRIORITY: Record<WorkQuestion["priority"], { label: string; ink: string; surface: string }> = {
  high: { label: "High", ink: theme.colors.warningInk, surface: theme.colors.warningSurface },
  medium: { label: "Medium", ink: theme.colors.secondaryInk, surface: theme.colors.secondarySurface },
};

/** Open questions for a person, with the reason they matter and the lines they came from. */
export function Questions({ items }: { items: WorkQuestion[] }) {
  return <View style={styles.stack}>
    {items.map((item, index) => {
      const priority = PRIORITY[item.priority];
      const citations = item.citations.map(citation => `${citation.source}:${citation.line}`).join(" · ");
      return <View key={`${item.area}/${index}`} style={styles.card}>
        <View style={styles.row}>
          <View style={[styles.pill, { backgroundColor: priority.surface }]}>
            <Text style={[styles.pillText, { color: priority.ink }]}>{priority.label}</Text>
          </View>
          <Text style={styles.area}>{item.area}</Text>
        </View>
        <Text style={styles.why}>{item.why}</Text>
        <Text style={styles.title}>{item.question}</Text>
        {citations ? <Text style={styles.citationText}>{citations}</Text> : null}
      </View>;
    })}
  </View>;
}
