import { Text, View } from "react-native";
import type { Basis } from "@infinite/remote";
import { BasisLabel } from "./BasisLabel";
import { styles } from "./styles";

/** Label and value rows. A row shows its basis only when it differs from the row above. */
export function Facts({ items }: { items: { label: string; value: string; basis: Basis }[] }) {
  return <View style={styles.stack}>
    {items.map((item, index) => {
      const showBasis = index === 0 || items[index - 1].basis !== item.basis;
      return <View key={`${item.label}/${index}`} style={styles.factRow}>
        <Text style={styles.factLabel}>{item.label}</Text>
        <View style={styles.factValue}>
          <Text selectable style={styles.factText}>{item.value}</Text>
          {showBasis ? <BasisLabel basis={item.basis} /> : null}
        </View>
      </View>;
    })}
  </View>;
}
