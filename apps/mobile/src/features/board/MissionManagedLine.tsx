import { Pressable, StyleSheet, Text, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";

export const MISSION_MANAGED_TEXT = "Run by its mission coordinator. Talk to the coordinator from the mission.";

/**
 * The one line that replaces steering for a run or session a mission coordinator runs. Its
 * subteams, their member sessions and the coordinator's own session are read-only to people;
 * tapping the line opens the mission, where the owner talks to the coordinator.
 */
export function MissionManagedLine({ missionId, machine, style, onLayout }: {
  missionId: string; machine: string; style?: StyleProp<ViewStyle>; onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const router = useRouter();
  return <Pressable accessibilityRole="button" accessibilityLabel={`${MISSION_MANAGED_TEXT} Open mission`} onLayout={onLayout}
    onPress={() => router.push({ pathname: "/mission/[id]", params: { id: missionId, machine } })}
    style={({ pressed }) => [s.line, style, pressed && s.pressed]}>
    <Glyph name="people" size={16} color={theme.colors.secondaryInk} />
    <Text style={s.text} numberOfLines={2}>{MISSION_MANAGED_TEXT}</Text>
    <Glyph name="forward" size={12} color={theme.colors.mutedInk} />
  </Pressable>;
}

const s = StyleSheet.create({
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 26,
    backgroundColor: theme.colors.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.glassRim,
    ...theme.lift,
  },
  pressed: { opacity: 0.7 },
  text: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.colors.secondaryInk },
});
