import { StyleSheet, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { theme } from "../../theme";
import { t } from "./parts";

export type DecisionRecommendation = { answers: string[]; reason: string; outcome?: "matched" | "different" | "other" };

export function isRecommendedOption(option: string, recommendation: DecisionRecommendation | undefined): boolean {
  return recommendation?.answers.includes(option) === true;
}

export function RecommendationBlock({ recommendation }: { recommendation: DecisionRecommendation }) {
  return <View style={s.block}>
    <Text style={s.label}>Recommended by the agent</Text>
    <Text style={t.strong}>{recommendation.answers.join(", ")}</Text>
    <Text style={t.note}>{recommendation.reason}</Text>
  </View>;
}

export function OutcomeNote({ recommendation }: { recommendation: DecisionRecommendation | undefined }) {
  if (recommendation?.outcome === "matched") return <Text style={t.note}>Matched the recommendation</Text>;
  if (recommendation?.outcome === "different") return <Text style={t.note}>Different from the recommendation</Text>;
  return null;
}

export function DecisionOptions({ options, recommendation, disabled, onAnswer }: {
  options: string[]; recommendation: DecisionRecommendation | undefined; disabled: boolean; onAnswer: (text: string) => void;
}) {
  if (options.length === 0) {
    const answer = recommendation?.answers[0];
    return answer !== undefined ? <Button compact title="Use the recommended answer" disabled={disabled} onPress={() => onAnswer(answer)} /> : null;
  }
  return <>
    {options.map((option, index) => isRecommendedOption(option, recommendation)
      ? <Button key={`${option}/${index}`} compact title={option} accessibilityLabel={`${option}, recommended`} disabled={disabled} onPress={() => onAnswer(option)} />
      : <Button key={`${option}/${index}`} compact secondary title={option} disabled={disabled} onPress={() => onAnswer(option)} />)}
  </>;
}

const s = StyleSheet.create({
  block: { gap: 3, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  label: { fontSize: 12, fontWeight: "600", color: theme.colors.forest },
});
