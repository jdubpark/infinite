import { Tabs } from "expo-router";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";

export default function TabsLayout() {
  return <Tabs screenOptions={{
    headerShown: false,
    tabBarActiveTintColor: theme.colors.forest,
    tabBarInactiveTintColor: theme.colors.mutedInk,
    tabBarStyle: { backgroundColor: theme.colors.paper, borderTopColor: theme.colors.rule, height: 58 },
    tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
  }}>
    <Tabs.Screen name="index" options={{ title: "Board", tabBarAccessibilityLabel: "Board", tabBarIcon: ({ focused }) => <Glyph name="stack" size={20} color={focused ? theme.colors.forest : theme.colors.mutedInk} /> }} />
    <Tabs.Screen name="sessions" options={{ title: "Sessions", tabBarAccessibilityLabel: "Sessions inbox", tabBarIcon: ({ focused }) => <Glyph name="terminal" size={20} color={focused ? theme.colors.forest : theme.colors.mutedInk} /> }} />
  </Tabs>;
}
