import { Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme";

export function Button({
  title,
  onPress,
  disabled,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        (disabled || pressed) && s.dim,
      ]}
    >
      <Text style={[s.text, secondary && s.secondaryText]}>{title}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.space.controlX,
    paddingVertical: 13,
    backgroundColor: theme.colors.forest,
    justifyContent: "center",
    alignItems: "center",
  },
  text: { fontSize: 14, fontWeight: "600", color: theme.colors.white },
  secondary: { backgroundColor: theme.colors.secondarySurface },
  secondaryText: { color: theme.colors.secondaryInk },
  dim: { opacity: 0.45 },
});
