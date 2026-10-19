import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { theme } from "../theme";

/** A message over the screen that never takes space from its content. */
export function FloatingNotice({
  message,
  position = "top",
  offset = 0,
  kind = "warning",
  accessibilityRole = kind === "error" ? "alert" : undefined,
  actions,
  onDismiss,
}: {
  message?: string | null;
  position?: "top" | "bottom";
  offset?: number;
  kind?: "warning" | "error" | "success";
  accessibilityRole?: "alert";
  actions?: ReactNode;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  const placement: ViewStyle = position === "top" ? { top: offset } : { bottom: offset };
  const content = <View style={[s.surface, kind === "success" && s.success, kind === "error" && s.error]}>
    <Text accessibilityRole={accessibilityRole} accessibilityLiveRegion="polite" numberOfLines={2} style={s.text}>{message}</Text>
    <View style={s.actions}>
      {actions}
      {onDismiss ? <Pressable accessibilityRole="button" accessibilityLabel="Dismiss notice" onPress={onDismiss} hitSlop={8} style={s.dismiss}><Text style={s.dismissText}>×</Text></Pressable> : null}
    </View>
  </View>;
  return <View pointerEvents="box-none" style={[s.anchor, placement]}>{content}</View>;
}

const s = StyleSheet.create({
  anchor: { position: "absolute", left: 12, right: 12, zIndex: 20, alignItems: "stretch" },
  surface: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: theme.colors.warningSurface, ...theme.lift },
  text: { flex: 1, color: theme.colors.warningInk, fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  success: { backgroundColor: theme.colors.screenSurface },
  error: { backgroundColor: theme.colors.warningSurface },
  dismiss: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 12 },
  dismissText: { fontSize: 20, lineHeight: 22, color: theme.colors.warningInk },
});
