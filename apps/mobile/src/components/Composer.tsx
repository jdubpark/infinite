import { useState, type ReactNode } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";
import { Button } from "./Button";

/**
 * The docked text composer. `pending` means the last send is uncertain: the
 * text stays locked and the button reads "Retry", which resends the same
 * request. `blocked` disables text and Send (not Interrupt) and says why.
 * `children` render under the input row (the Terminal's key row).
 */
export function Composer({
  canSteer,
  busy,
  pending,
  receipt,
  error,
  blocked,
  onSend,
  onInterrupt,
  children,
}: {
  canSteer: boolean;
  busy: boolean;
  pending: boolean;
  receipt: string;
  error: string;
  blocked?: string;
  onSend: (text: string) => Promise<boolean>;
  onInterrupt?: () => void;
  children?: ReactNode;
}) {
  const [text, setText] = useState("");
  const canType = canSteer && !blocked;
  async function send() {
    if (await onSend(text)) setText("");
  }
  return (
    <View style={s.area}>
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
      {receipt ? <Text style={s.receipt}>{receipt}</Text> : null}
      {blocked ? <Text style={s.hint}>{blocked}</Text> : null}
      <View style={s.row}>
        <TextInput
          accessibilityLabel="Message to agent"
          multiline
          value={text}
          onChangeText={setText}
          editable={canType && !busy && !pending}
          placeholder={
            !canSteer
              ? "Waiting for a live connection"
              : blocked
                ? "Paused while a prompt is open"
                : "Give this session a direction…"
          }
          placeholderTextColor={theme.colors.placeholder}
          style={s.message}
          maxLength={32000}
        />
        <Button
          title={pending ? "Retry" : "Send"}
          onPress={send}
          disabled={!canType || busy || !text.trim()}
        />
      </View>
      {onInterrupt || children ? (
        <View style={s.keys}>
          {onInterrupt ? (
            <Button
              title="Interrupt"
              secondary
              onPress={onInterrupt}
              disabled={!canSteer || busy}
            />
          ) : null}
          {children}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  area: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.rule,
    padding: 15,
    paddingBottom: 8,
  },
  error: {
    color: theme.colors.warningInk,
    fontSize: 13,
    lineHeight: 20,
    marginVertical: 10,
  },
  hint: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.warningInk,
    marginBottom: theme.space.compact,
  },
  receipt: {
    fontSize: 11,
    lineHeight: 17,
    color: theme.colors.forest,
    marginBottom: theme.space.compact,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  message: {
    flex: 1,
    minHeight: 60,
    maxHeight: 150,
    borderWidth: 1,
    borderColor: theme.colors.fieldRule,
    borderRadius: theme.radius.message,
    padding: 12,
    fontSize: 14,
    color: theme.colors.ink,
  },
  keys: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space.compact,
    paddingTop: 10,
  },
});
