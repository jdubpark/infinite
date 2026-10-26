import { Text, View } from "react-native";
import type { UnderstandingCitation } from "@infinite/remote";
import { styles } from "./styles";

/** Evidence references as text chips, each a source and line. */
export function Citations({ items }: { items: UnderstandingCitation[] }) {
  return <View style={styles.wrap}>
    {items.map((citation, index) => <View key={`${citation.source}:${citation.line}/${index}`} style={styles.citation}>
      <Text style={styles.citationText}>{`${citation.source}:${citation.line}`}</Text>
    </View>)}
  </View>;
}
