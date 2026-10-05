import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { theme } from "../theme";
import {
  installNotificationHandler,
  useNotificationRouting,
} from "../push/handler";

installNotificationHandler();

export default function Layout() {
  useNotificationRouting();
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.paper },
        }}
      />
    </SafeAreaProvider>
  );
}
