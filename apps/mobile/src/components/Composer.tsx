import type { ReactNode } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
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
  onLayout,
}: {
  canSteer: boolean;
  busy: boolean;
  pending: boolean;
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
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const canType = canSteer && !blocked;
  return (
    <View style={s.area} onLayout={onLayout}>
      {blocked ? <Text style={s.hint}>{blocked}</Text> : null}
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
          busy={controlBusy}
          title={controlLabel}
          onPress={onTakeControl}
          disabled={busy || controlBusy}
        /> : <View style={s.sendControl}>
          {busy ? <View accessible accessibilityRole="progressbar" accessibilityLabel={pending ? "Retrying delivery" : "Sending"} style={s.busyButton}><ActivityIndicator color={theme.colors.forest} /></View>
            : pending ? <Button compact title="Retry" onPress={onSend} disabled={!canType || !text.trim()} />
              : <GlassButton primary glyph="send" size={40} label="Send" onPress={onSend} disabled={!canType || !text.trim()} />}
        </View>}
      </View>
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
  hint: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.warningInk,
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
  sendControl: { width: 88, alignItems: "center", justifyContent: "center" },
  busyButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
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
