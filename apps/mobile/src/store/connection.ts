import * as SecureStore from "expo-secure-store";
import type { Connection } from "../api/client";

/** Unchanged from the single-file app so existing pairings survive. */
export const SECRET_KEY = "infinite.connection.v1";

export async function loadConnection(): Promise<Connection | null> {
  const value = await SecureStore.getItemAsync(SECRET_KEY);
  return value ? (JSON.parse(value) as Connection) : null;
}

export async function saveConnection(connection: Connection) {
  await SecureStore.setItemAsync(SECRET_KEY, JSON.stringify(connection), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearConnection() {
  await SecureStore.deleteItemAsync(SECRET_KEY);
}
