import { ActivityIndicator, Pressable, StyleSheet } from "react-native";
import { Button } from "../components/Button";
import { FloatingNotice } from "../components/FloatingNotice";
import { Glyph } from "../components/Icon";
import { theme } from "../theme";
import type { Dictation } from "./useDictation";

/** A round mic beside a field. Renders nothing when the phone cannot dictate, so the field stays plain. */
export function MicButton({ dictation, size = 42, disabled = false }: { dictation: Dictation; size?: number; disabled?: boolean }) {
  if (!dictation.available) return null;
  const { state, toggle } = dictation;
  const listening = state === "listening";
  const busy = state === "starting" || state === "cleaning";
  const label = listening ? "Stop dictation" : state === "cleaning" ? "Cleaning up dictation" : "Dictate";
  const ink = listening ? theme.colors.white : theme.colors.ink;
  // The drawn control can be smaller than 48 units; hit slop makes up the difference.
  const slop = Math.max(6, Math.ceil((48 - size) / 2));
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }}
    disabled={disabled || busy} onPress={toggle} hitSlop={slop}
    style={({ pressed }) => [s.round, { width: size, height: size }, listening ? s.listening : s.glass, (pressed || disabled) && s.dim]}>
    {busy ? <ActivityIndicator color={ink} /> : <Glyph name="mic" size={size * 0.42} color={ink} />}
  </Pressable>;
}

/** Dictation outcome over the screen. Floats, so it never moves the field or the controls beneath it. */
export function DictationNotice({ dictation, position = "bottom", offset = 0 }: { dictation: Dictation; position?: "top" | "bottom"; offset?: number }) {
  const { notice, dismiss } = dictation;
  const actions = notice?.useOriginal ? <Button title="Use original" compact secondary onPress={notice.useOriginal} /> : undefined;
  return <FloatingNotice message={notice?.message} kind={notice?.kind} position={position} offset={offset} actions={actions} onDismiss={dismiss} />;
}

const s = StyleSheet.create({
  round: { borderRadius: theme.radius.capsule, alignItems: "center", justifyContent: "center" },
  glass: { backgroundColor: theme.colors.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.glassRim, ...theme.lift },
  listening: { backgroundColor: theme.colors.forest, ...theme.lift },
  dim: { opacity: 0.45 },
});
