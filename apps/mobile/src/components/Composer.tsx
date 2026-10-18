import type { ReactNode } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";
import { Button } from "./Button";
import { GlassButton } from "./Glass";

/**
 * The docked text composer. The caller owns `text`, so a draft outlives the
 * screen. `pending` means the last send is uncertain: the text stays locked
 * and the button reads "Retry", which resends the same request. `blocked`
 * disables text and Send (not Interrupt) and says why, with
 * `blockedPlaceholder` in the empty field; `idleHint` replaces the
 * placeholder while steering is unavailable. `children` render under the
 * input row (the Terminal's key row).
 */
export function Composer({
  canSteer,
  busy,
  pending,
  receipt,
  error,
  blocked,
  blockedPlaceholder = "Paused while a prompt is open",
  idleHint,
  text,
  onChangeText,
  onSend,
  onInterrupt,
  onTakeControl,
  controlBusy = false,
  controlLabel = "Take control",
  children,
}: {
  canSteer: boolean;
  busy: boolean;
  pending: boolean;
  receipt: string;
  error: string;
  blocked?: string;
  blockedPlaceholder?: string;
  idleHint?: string;
  text: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onInterrupt?: () => void;
  onTakeControl?: () => void;
  controlBusy?: boolean;
  controlLabel?: string;
  children?: ReactNode;
}) {
  const canType = canSteer && !blocked;
  return (
    <View style={s.area}>
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
      {receipt ? <Text style={s.receipt}>{receipt}</Text> : null}
      {blocked ? <Text style={s.hint}>{blocked}</Text> : null}
      {pending ? (
        <Text style={s.note}>
          Unconfirmed delivery · Retry keeps the same request ID
        </Text>
      ) : null}
      <View style={s.row}>
        <TextInput
          accessibilityLabel="Message to agent"
          multiline
          value={text}
          onChangeText={onChangeText}
          editable={!blocked && !busy && !pending}
          placeholder={
            !canSteer
              ? (idleHint ?? "Draft here while reconnecting…")
              : blocked
                ? blockedPlaceholder
                : "Give this session a direction…"
          }
          placeholderTextColor={theme.colors.placeholder}
          style={s.message}
          maxLength={32000}
        />
        {onTakeControl ? <Button
          compact
          title={controlBusy ? "Requesting…" : controlLabel}
          onPress={onTakeControl}
          disabled={busy || controlBusy}
        /> : pending ? <Button
          compact
          title={busy ? "Sending…" : "Retry"}
          onPress={onSend}
          disabled={!canType || busy || !text.trim()}
        /> : <GlassButton
          primary
          glyph="send"
          size={40}
          label={busy ? "Sending" : "Send"}
          onPress={onSend}
          disabled={!canType || busy || !text.trim()}
        />}
      </View>
      {!pending && !blocked && text ? <Text style={s.draftNote}>Unsent draft</Text> : null}
      {onInterrupt || children ? (
        <View style={s.keys}>
          {onInterrupt ? (
            <Button
              compact
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
    paddingHorizontal: 12,
    paddingTop: 6,
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
  note: {
    fontSize: 11,
    lineHeight: 17,
    color: theme.colors.mutedInk,
    marginBottom: theme.space.compact,
  },
  receipt: {
    fontSize: 11,
    lineHeight: 17,
    color: theme.colors.forest,
    marginBottom: theme.space.compact,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 5,
    paddingLeft: 6,
    borderRadius: 26,
    backgroundColor: theme.colors.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.glassRim,
    ...theme.lift,
  },
  draftNote: { fontSize: 11, lineHeight: 16, color: theme.colors.mutedInk, marginTop: 6, paddingHorizontal: 12 },
  message: {
    flex: 1,
    minHeight: 40,
    maxHeight: 150,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: theme.colors.ink,
  },
  keys: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingTop: 6,
  },
});
