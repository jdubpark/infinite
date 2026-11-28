import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "../../components/Button";
import { theme } from "../../theme";
import { RecommendationBlock } from "../teams/Recommendation";
import { t } from "../teams/parts";
import { formatAnswer, orderedChoices, type QueueDecisionRecord } from "./model";

export function QueueChoices({ record, selected, enabled, onToggle, onAnswer }: {
  record: QueueDecisionRecord; selected: string[]; enabled: boolean;
  onToggle: (value: string) => void; onAnswer: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const choices = orderedChoices(record);
  const recommended = new Set(record.recommendation?.answers ?? []);
  const multiple = record.answerMode === "multiple";
  const recommendedChoices = choices.filter(choice => recommended.has(choice));
  return <View style={s.wrap}>
    <Text style={s.question} selectable>{record.question}</Text>
    {record.recommendation ? <RecommendationBlock recommendation={record.recommendation} /> : null}
    {choices.length === 0 && record.recommendation?.answers[0] !== undefined
      ? <Button compact title="Use the recommended answer" disabled={!enabled} onPress={() => onAnswer(record.recommendation?.answers[0] ?? "")} /> : null}
    {multiple ? <>
      {choices.map(choice => {
        const on = selected.includes(choice);
        return <Pressable key={choice} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: !enabled }}
          accessibilityLabel={recommended.has(choice) ? `${choice}, recommended` : choice} disabled={!enabled} onPress={() => onToggle(choice)}
          style={({ pressed }) => [s.choice, on && s.choiceOn, (pressed || !enabled) && s.dim]}>
          <Text style={[s.choiceText, on && s.choiceTextOn]}>{on ? "✓ " : ""}{choice}</Text>
        </Pressable>;
      })}
      {recommendedChoices.length ? <Button compact secondary title="Send the recommended answers" disabled={!enabled} onPress={() => onAnswer(formatAnswer(recommendedChoices, "multiple"))} /> : null}
      <Button compact title="Send selected answers" disabled={!enabled || selected.length === 0}
        onPress={() => onAnswer(formatAnswer(choices.filter(choice => selected.includes(choice)), "multiple"))} />
    </> : choices.map(choice => recommended.has(choice)
      ? <Button key={choice} compact title={choice} accessibilityLabel={`${choice}, recommended`} disabled={!enabled} onPress={() => onAnswer(choice)} />
      : <Button key={choice} compact secondary title={choice} disabled={!enabled} onPress={() => onAnswer(choice)} />)}
    <TextInput accessibilityLabel="Write an answer" value={text} onChangeText={setText} multiline maxLength={8000}
      placeholder="Or write your answer…" placeholderTextColor={theme.colors.placeholder} editable={enabled} style={s.input} />
    <Button compact secondary title="Send written answer" disabled={!enabled || !text.trim()} onPress={() => onAnswer(text.trim())} />
    {choices.length === 0 && !record.recommendation ? <Text style={t.note}>This decision has no listed choices. Write the answer.</Text> : null}
  </View>;
}

const s = StyleSheet.create({
  wrap: { gap: 9 },
  question: { fontSize: 16, fontWeight: "600", lineHeight: 23, color: theme.colors.ink },
  choice: { minHeight: 46, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 9, borderRadius: 23, backgroundColor: theme.colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.fieldRule },
  choiceOn: { borderColor: theme.colors.forest, backgroundColor: theme.colors.secondarySurface },
  choiceText: { fontSize: 14, lineHeight: 20, color: theme.colors.ink },
  choiceTextOn: { fontWeight: "600", color: theme.colors.secondaryInk },
  dim: { opacity: 0.5 },
  input: { minHeight: 54, maxHeight: 150, borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.message, padding: 10, color: theme.colors.ink, backgroundColor: theme.colors.paper, fontSize: 14, lineHeight: 20 },
});
