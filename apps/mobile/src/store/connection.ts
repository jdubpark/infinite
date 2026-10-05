import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
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

const CLIENT_KEY = "infinite.client.v1";
let clientId: Promise<string> | undefined;

/**
 * This install's client UUID, sent as `X-Infinite-Client`. The host binds input control to the
 * paired key and this id, so a copied key on another phone cannot use this phone's lease. A
 * failed read or write falls back to an id that lasts until the app restarts.
 */
export function loadClientId(): Promise<string> {
  clientId ??= (async () => {
    const saved = await SecureStore.getItemAsync(CLIENT_KEY).catch(() => null);
    if (saved) return saved;
    const created = Crypto.randomUUID();
    await SecureStore.setItemAsync(CLIENT_KEY, created, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }).catch(() => {});
    return created;
  })();
  return clientId;
}
