import { Pressable, Text, View } from "react-native";
import type { WorkBlock } from "@infinite/remote";
import { BasisLabel } from "./BasisLabel";
import { safeOpen } from "./RichText";
import { styles } from "./styles";

export type WorkLink = Extract<WorkBlock, { kind: "links" }>["items"][number];

/** External references. Only https links open; each row names who supplied it. */
export function Links({ items }: { items: WorkLink[] }) {
  return <View style={styles.stack}>
    {items.map((item, index) => <View key={`${item.url}/${index}`} style={styles.stack}>
      <BasisLabel basis={item.basis} />
      <Pressable accessibilityRole="link" accessibilityLabel={item.label} onPress={() => safeOpen(item.url)}>
        <Text style={styles.link}>{item.label}</Text>
      </Pressable>
    </View>)}
  </View>;
}
