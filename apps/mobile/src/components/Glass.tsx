import { useEffect, useState, type ReactNode } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { StatusKind } from "../status";
import { theme } from "../theme";
import { Glyph, StatusIcon, type GlyphName } from "./Icon";

/**
 * The phone's shared controls. Content stays flat on the paper sheet; controls that act on a whole
 * screen float above it as translucent capsules with one shared lift. Every touch target reaches
 * 48 units, through hit slop where the drawn control is smaller.
 */
const SLOP = { top: 6, bottom: 6, left: 6, right: 6 };

/** A round floating control showing one icon. `label` is required because the icon has no words. */
export function GlassButton({ glyph, label, onPress, disabled, primary, size = 42 }: {
  glyph: GlyphName; label: string; onPress: () => void; disabled?: boolean; primary?: boolean; size?: number;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={SLOP}
    style={({ pressed }) => [s.round, { width: size, height: size }, primary ? s.primary : s.glass, (pressed || disabled) && s.dim]}>
    <Glyph name={glyph} size={size * 0.42} color={primary ? theme.colors.white : theme.colors.ink} />
  </Pressable>;
}

/** Back control, optional title, and trailing controls; the same on every pushed screen. */
export function TopBar({ backLabel, onBack, title, right }: { backLabel?: string; onBack?: () => void; title?: string; right?: ReactNode }) {
  return <View style={s.bar}>
    {onBack ? <GlassButton glyph="back" label={`Back to ${backLabel ?? "previous screen"}`} onPress={onBack} /> : null}
    <Text style={s.barTitle} numberOfLines={1}>{title ?? ""}</Text>
    <View style={s.barRight}>{right}</View>
  </View>;
}

/** Connection freshness in words beside its dot, kept separate from any work state. */
export function LiveStatus({ online, loading, seen, stale }: { online: boolean; loading?: boolean; seen?: string; stale?: boolean }) {
  const label = online ? "Live" : stale ? seen ? `Offline · ${seen}` : "Offline" : loading || !seen ? "Connecting" : "Checking";
  const offline = !online && Boolean(stale);
  return <View accessible accessibilityLabel={online ? `Up to date${seen ? `, updated ${seen}` : ""}` : offline ? label : "Checking connection"} style={[s.status, offline && s.statusOff]}>
    <View style={[s.statusDot, offline && s.statusDotOff]} />
    <Text style={[s.statusText, offline && s.statusTextOff]} numberOfLines={1}>{label}</Text>
  </View>;
}

/** A Linear-style property: an icon or status and a few words. */
export function Chip({ kind, fraction, icon, label, tone, selected, onPress, accessibilityLabel }: {
  kind?: StatusKind; fraction?: number; icon?: ReactNode; label: string; tone?: "attention" | "error"; selected?: boolean; onPress?: () => void; accessibilityLabel?: string;
}) {
  const body = <>
    {kind ? <StatusIcon kind={kind} fraction={fraction} size={13} /> : icon}
    <Text style={[s.chipText, tone === "attention" && s.chipTextAttention, tone === "error" && s.chipTextError, selected && s.chipTextSelected]} numberOfLines={1}>{label}</Text>
  </>;
  const style = [s.chip, tone === "attention" && s.chipAttention, tone === "error" && s.chipError, selected && s.chipSelected];
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityState={selected === undefined ? undefined : { selected }} accessibilityLabel={accessibilityLabel ?? label} onPress={onPress} hitSlop={SLOP} style={({ pressed }) => [...style, pressed && s.dim]}>{body}</Pressable>
    : <View accessible accessibilityLabel={accessibilityLabel ?? label} style={style}>{body}</View>;
}

export type SegmentOption<T extends string> = { value: T; label: string; count?: number; attention?: boolean; glyph?: GlyphName };

/** A capsule of views; the selected one is a raised lens. Counts that wait on a person turn amber. */
export function Segmented<T extends string>({ options, value, onChange, style }: { options: SegmentOption<T>[]; value: T; onChange: (value: T) => void; style?: StyleProp<ViewStyle> }) {
  return <View accessibilityRole="tablist" style={[s.track, style]}>
    {options.map(option => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={`${option.label}${option.count ? `, ${option.count}${option.attention ? " need you" : ""}` : ""}`}
        onPress={() => onChange(option.value)} style={[s.segment, selected && s.segmentOn]}>
        {option.glyph ? <Glyph name={option.glyph} size={15} color={selected ? theme.colors.forest : theme.colors.mutedInk} /> : null}
        <Text style={[s.segmentText, selected && s.segmentTextOn]} numberOfLines={1}>{option.label}</Text>
        {option.count ? <Text style={[s.badge, option.attention && s.badgeAttention]}>{option.count}</Text> : null}
      </Pressable>;
    })}
  </View>;
}

/** A slide-up sheet over a dimmed screen. Tapping outside or the close control dismisses it. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [{ rise, translateY }] = useState(() => {
    const value = new Animated.Value(0);
    return { rise: value, translateY: value.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) };
  });
  useEffect(() => {
    if (visible) Animated.spring(rise, { toValue: 1, useNativeDriver: true, damping: 22, stiffness: 220, mass: 0.8 }).start();
    else rise.setValue(0);
  }, [visible, rise]);
  return <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
    <Pressable accessibilityRole="button" accessibilityLabel="Close" style={s.scrim} onPress={onClose} />
    <Animated.View accessibilityViewIsModal style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 8, transform: [{ translateY }] }]}>
      <View style={s.grabber} />
      <View style={s.sheetHead}>
        <Text style={s.sheetTitle} accessibilityRole="header">{title}</Text>
        <GlassButton glyph="close" label="Close" size={34} onPress={onClose} />
      </View>
      {children}
    </Animated.View>
  </Modal>;
}

/** One choice in a sheet. */
export function SheetRow({ glyph, icon, label, detail, onPress, destructive, selected, disabled }: {
  glyph?: GlyphName; icon?: ReactNode; label: string; detail?: string; onPress: () => void; destructive?: boolean; selected?: boolean; disabled?: boolean;
}) {
  const ink = destructive ? theme.colors.error : theme.colors.ink;
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.sheetRow, pressed && s.sheetRowPressed, disabled && s.dim]}>
    <View style={s.sheetIcon}>{icon ?? (glyph ? <Glyph name={glyph} size={18} color={ink} /> : null)}</View>
    <View style={s.fill}>
      <Text style={[s.sheetLabel, { color: ink }]} numberOfLines={1}>{label}</Text>
      {detail ? <Text style={s.sheetDetail} numberOfLines={1}>{detail}</Text> : null}
    </View>
    {selected ? <Glyph name="check" size={16} color={theme.colors.forest} /> : null}
  </Pressable>;
}

/** Integrated work out of the planned total. */
export function ProgressBar({ done, total, width = 56 }: { done: number; total: number; width?: number }) {
  const share = total ? Math.min(1, done / total) : 0;
  return <View accessible accessibilityLabel={`${done} of ${total} done`} style={[s.progress, { width }]}>
    <View style={[s.progressFill, { width: Math.max(share ? 4 : 0, width * share) }]} />
  </View>;
}

/** A rounded group of content on the sheet; `attention` marks work that waits on a person. */
export function Card({ children, attention, style }: { children: ReactNode; attention?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, attention && s.cardAttention, style]}>{children}</View>;
}

/** A list group: status icon, name, count, and an optional collapse control. */
export function GroupHeader({ kind, title, count, collapsed, onToggle }: { kind?: StatusKind; title: string; count: number; collapsed?: boolean; onToggle?: () => void }) {
  const body = <>
    {kind ? <StatusIcon kind={kind} size={13} /> : null}
    <Text style={s.groupTitle}>{title}</Text>
    <Text style={s.groupCount}>{count}</Text>
    {onToggle ? <View style={s.groupToggle}><Glyph name={collapsed ? "forward" : "down"} size={12} color={theme.colors.mutedInk} /></View> : null}
  </>;
  return onToggle
    ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed }} accessibilityLabel={`${title}, ${count}`} onPress={onToggle} style={s.group}>{body}</Pressable>
    : <View accessibilityRole="header" style={s.group}>{body}</View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  dim: { opacity: 0.45 },
  round: { borderRadius: theme.radius.capsule, alignItems: "center", justifyContent: "center" },
  glass: { backgroundColor: theme.colors.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.glassRim, ...theme.lift },
  primary: { backgroundColor: theme.colors.forest, ...theme.lift },
  bar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6, minHeight: 54 },
  barTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.colors.ink },
  barRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  status: { flexDirection: "row", alignItems: "center", gap: 6, height: 30, paddingHorizontal: 11, borderRadius: theme.radius.capsule,
    backgroundColor: theme.colors.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.glassRim, maxWidth: 170 },
  statusOff: { backgroundColor: theme.colors.warningSurface },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.running },
  statusDotOff: { backgroundColor: theme.colors.warningInk },
  statusText: { fontSize: 12, fontWeight: "600", color: theme.colors.secondaryInk },
  statusTextOff: { color: theme.colors.warningInk },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, height: 26, paddingHorizontal: 9, borderRadius: theme.radius.capsule,
    backgroundColor: theme.colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.fieldRule, maxWidth: "100%" },
  chipAttention: { backgroundColor: theme.colors.warningSurface, borderColor: theme.colors.warningSurface },
  chipError: { borderColor: theme.colors.error },
  chipText: { fontSize: 12, fontWeight: "500", color: theme.colors.ink, flexShrink: 1 },
  chipTextAttention: { color: theme.colors.warningInk, fontWeight: "600" },
  chipTextError: { color: theme.colors.error },
  chipSelected: { backgroundColor: theme.colors.forest, borderColor: theme.colors.forest },
  chipTextSelected: { color: theme.colors.white, fontWeight: "600" },
  track: { flexDirection: "row", padding: 3, gap: 2, borderRadius: theme.radius.capsule, backgroundColor: theme.colors.secondarySurface },
  segment: { flex: 1, minHeight: 36, flexDirection: "row", gap: 5, alignItems: "center", justifyContent: "center", paddingHorizontal: 6, borderRadius: theme.radius.capsule },
  segmentOn: { backgroundColor: theme.colors.white, ...theme.lift },
  segmentText: { fontSize: 13, fontWeight: "600", color: theme.colors.mutedInk, flexShrink: 1 },
  segmentTextOn: { color: theme.colors.ink },
  badge: { minWidth: 18, paddingHorizontal: 5, borderRadius: 9, overflow: "hidden", textAlign: "center", fontSize: 11, lineHeight: 16, fontWeight: "700",
    color: theme.colors.mutedInk, backgroundColor: theme.colors.rule },
  badgeAttention: { color: theme.colors.white, backgroundColor: theme.colors.warningInk },
  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.colors.scrim },
  sheet: { position: "absolute", left: 8, right: 8, bottom: 8, borderRadius: theme.radius.sheet, backgroundColor: theme.colors.paper,
    paddingHorizontal: 12, paddingTop: 8, ...theme.lift },
  grabber: { alignSelf: "center", width: 38, height: 5, borderRadius: 3, backgroundColor: theme.colors.fieldRule, marginBottom: 6 },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingBottom: 6 },
  sheetTitle: { fontSize: 17, fontWeight: "700", color: theme.colors.ink },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 10, borderRadius: theme.radius.card },
  sheetRowPressed: { backgroundColor: theme.colors.secondarySurface },
  sheetIcon: { width: 28, alignItems: "center" },
  sheetLabel: { fontSize: 15, fontWeight: "500" },
  sheetDetail: { fontSize: 12, color: theme.colors.mutedInk, marginTop: 1 },
  progress: { height: 5, borderRadius: 3, backgroundColor: theme.colors.rule, overflow: "hidden" },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: theme.colors.running },
  card: { borderRadius: theme.radius.card, backgroundColor: theme.colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule, padding: 14, gap: 8 },
  cardAttention: { backgroundColor: theme.colors.warningSurface, borderColor: theme.colors.warningSurface },
  group: { flexDirection: "row", alignItems: "center", gap: 7, paddingTop: 18, paddingBottom: 6, minHeight: 44 },
  groupTitle: { fontSize: 13, fontWeight: "700", color: theme.colors.ink },
  groupCount: { fontSize: 13, color: theme.colors.mutedInk },
  groupToggle: { marginLeft: 2 },
});
