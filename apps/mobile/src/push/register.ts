import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { api, type Connection } from "../api/client";

const TOKEN_KEY = "infinite.push.v1";
export type PushState = "registered" | "denied" | "unavailable";

let tokenListener: Notifications.EventSubscription | null = null;

function platform() {
  return Platform.OS === "ios" ? "ios" : "android";
}

/**
 * Registers this phone's Expo push token with the host. Callers must first
 * confirm the host reports `capabilities.push`, so hosts that cannot send never
 * trigger a permission prompt. The token is never logged.
 */
export async function registerForPush(
  connection: Connection,
): Promise<PushState> {
  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId || (!Device.isDevice && Platform.OS === "ios"))
    return "unavailable";
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("attention", {
      name: "Needs your attention",
      importance: Notifications.AndroidImportance.MAX,
    });
  const current = await Notifications.getPermissionsAsync();
  const status =
    current.status === "granted"
      ? current.status
      : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return "denied";
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api(connection, "/devices/push", {
    body: { token, platform: platform() },
  });
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  tokenListener?.remove();
  tokenListener = Notifications.addPushTokenListener(async (next) => {
    try {
      await api(connection, "/devices/push", {
        body: { token: next.data, platform: platform() },
      });
      await SecureStore.setItemAsync(TOKEN_KEY, next.data);
    } catch {
      /* retried on next launch */
    }
  });
  return "registered";
}

export async function unregisterPush(connection: Connection) {
  tokenListener?.remove();
  tokenListener = null;
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!token) return;
  await api(connection, "/devices/push", {
    method: "DELETE",
    body: { token },
  }).catch(() => {});
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
}
