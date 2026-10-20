import { Tabs } from "expo-router";
import { theme } from "../../theme";

export default function TabsLayout() {
  return <Tabs screenOptions={{
    headerShown: false,
    tabBarActiveTintColor: theme.colors.forest,
    tabBarInactiveTintColor: theme.colors.mutedInk,
    tabBarStyle: { backgroundColor: theme.colors.paper, borderTopColor: theme.colors.rule, height: 58 },
    tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
  }}>
    <Tabs.Screen name="index" options={{ title: "Board", tabBarAccessibilityLabel: "Board" }} />
    <Tabs.Screen name="sessions" options={{ title: "Sessions", tabBarAccessibilityLabel: "Sessions inbox" }} />
  </Tabs>;
}
