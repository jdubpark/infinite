import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { Glyph, type GlyphName } from "./Icon";

/**
 * A capsule action. `compact` draws smaller but keeps a 48-unit touch target through hit slop.
 * `destructive` is a secondary button in error ink for actions that remove something.
 */
export function Button({
  title,
  onPress,
  disabled,
  secondary = false,
  destructive = false,
  compact = false,
  glyph,
  busy,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  destructive?: boolean;
  compact?: boolean;
  glyph?: GlyphName;
  busy?: boolean;
}) {
  const ink = destructive ? theme.colors.error : secondary ? theme.colors.secondaryInk : theme.colors.white;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={compact ? { top: 7, bottom: 7 } : undefined}
      style={({ pressed }) => [
        s.button,
        compact && s.compact,
        (secondary || destructive) && s.secondary,
        (disabled || pressed) && s.dim,
      ]}
    >
      {busy !== undefined ? <View style={s.busySlot}>{busy ? <ActivityIndicator size="small" color={ink} /> : glyph ? <Glyph name={glyph} size={compact ? 13 : 15} color={ink} /> : null}</View>
        : glyph ? <Glyph name={glyph} size={compact ? 13 : 15} color={ink} /> : null}
      <Text style={[s.text, compact && s.compactText, { color: ink }]} numberOfLines={1}>{title}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: {
    minHeight: 46,
    flexDirection: "row",
    gap: 7,
    borderRadius: theme.radius.capsule,
    paddingHorizontal: theme.space.controlX,
    paddingVertical: 11,
    backgroundColor: theme.colors.forest,
    justifyContent: "center",
    alignItems: "center",
  },
  compact: { minHeight: 34, paddingHorizontal: 13, paddingVertical: 6 },
  text: { fontSize: 14, fontWeight: "600", flexShrink: 1 },
  compactText: { fontSize: 13 },
  secondary: {
    backgroundColor: theme.colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.fieldRule,
  },
  dim: { opacity: 0.45 },
  busySlot: { width: 15, height: 15, alignItems: "center", justifyContent: "center" },
});
