import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";

const TAB_BAR_HEIGHT = 58;

export default function TabsLayout() {
  // Android draws edge to edge, so the tab bar reserves the system navigation bar's height itself.
  const insets = useSafeAreaInsets();
  return <Tabs screenOptions={{
    headerShown: false,
    tabBarActiveTintColor: theme.colors.forest,
    tabBarInactiveTintColor: theme.colors.mutedInk,
    tabBarStyle: { backgroundColor: theme.colors.paper, borderTopColor: theme.colors.rule, height: TAB_BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom },
    tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
  }}>
    <Tabs.Screen name="index" options={{ title: "Board", tabBarAccessibilityLabel: "Board", tabBarIcon: ({ focused }) => <Glyph name="stack" size={20} color={focused ? theme.colors.forest : theme.colors.mutedInk} /> }} />
    <Tabs.Screen name="sessions" options={{ title: "Sessions", tabBarAccessibilityLabel: "Sessions inbox", tabBarIcon: ({ focused }) => <Glyph name="terminal" size={20} color={focused ? theme.colors.forest : theme.colors.mutedInk} /> }} />
    <Tabs.Screen name="understanding" options={{ title: "Understand", tabBarAccessibilityLabel: "Understand workspaces", tabBarIcon: ({ focused }) => <Glyph name="target" size={20} color={focused ? theme.colors.forest : theme.colors.mutedInk} /> }} />
  </Tabs>;
}
