import { Text, View } from "react-native";
import type { DecisionSummary } from "@infinite/remote";
import { formatTime } from "./format";
import { styles } from "./styles";

/** Questions the work raised, their options, and who answered them. */
export function Decisions({ items }: { items: DecisionSummary[] }) {
  return <View style={styles.stack}>
    {items.map(decision => <DecisionCard key={decision.id} decision={decision} />)}
  </View>;
}

function DecisionCard({ decision }: { decision: DecisionSummary }) {
  const answered = decision.answer !== null;
  const who = decision.answeredBy ? `Answered by ${decision.answeredBy}` : "Answered";
  return <View style={styles.card}>
    <Text style={styles.title}>{decision.question}</Text>
    {decision.options.map((option, index) => <View key={index} style={styles.listItem}>
      <View style={styles.marker}><Text style={styles.paragraphCompact}>•</Text></View>
      <Text style={[styles.body, { flex: 1 }]}>{option}</Text>
    </View>)}
    {decision.answer !== null ? <Text style={styles.body}>{decision.answer}</Text> : null}
    <Text style={styles.meta}>{answered ? `${who} · ${formatTime(decision.answeredAt)}` : "Unanswered"}</Text>
  </View>;
}
