import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { api, connectionKey, type Connection } from "../api/client";
import { onForegroundChange } from "../api/foreground";

const TOKEN_KEY = "infinite.push.v1";
export const PUSH_ROTATION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
export type PushState = "registered" | "degraded" | "denied" | "unavailable";

let tokenListener: Notifications.EventSubscription | null = null;
let foregroundUnsubscribe: (() => void) | null = null;
let activeProjectId: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let rotationGeneration = 0;
let rotationInFlight = false;
let pendingDevicePushToken: Notifications.DevicePushToken | null = null;
let lastRotatedDevicePushToken: Notifications.DevicePushToken | null = null;
let pendingToken: string | null = null;
let lastRotatedToken: string | null = null;
let tokenStored = true;
const registered = new Map<string, Connection>();
const acceptedTokenByProfile = new Map<string, string>();
const pendingProfiles = new Set<string>();
let states: Record<string, PushState> = {};
const stateListeners = new Set<() => void>();

function platform() {
  return Platform.OS === "ios" ? "ios" : "android";
}

function notifyStateListeners() {
  stateListeners.forEach(listener => listener());
}

function setPushState(key: string, next: PushState) {
  if (states[key] === next) return;
  states = { ...states, [key]: next };
  notifyStateListeners();
}

function deletePushState(key: string) {
  if (!Object.hasOwn(states, key)) return;
  const next = { ...states };
  delete next[key];
  states = next;
  notifyStateListeners();
}

function clearRetryTimer() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function teardownListeners() {
  rotationGeneration += 1;
  rotationInFlight = false;
  clearRetryTimer();
  pendingDevicePushToken = null;
  lastRotatedDevicePushToken = null;
  pendingToken = null;
  lastRotatedToken = null;
  tokenStored = true;
  activeProjectId = null;
  tokenListener?.remove();
  tokenListener = null;
  foregroundUnsubscribe?.();
  foregroundUnsubscribe = null;
}

function flushPendingStoreIfReady() {
  if (registered.size > 0 && pendingProfiles.size === 0 && !tokenStored && pendingToken && !rotationInFlight && retryTimer === null) {
    rotationGeneration += 1;
    void syncRotation(rotationGeneration, 0);
  }
}

function removeProfileFromRotation(key: string) {
  registered.delete(key);
  pendingProfiles.delete(key);
  if (!registered.size) {
    teardownListeners();
  } else if (pendingProfiles.size === 0 && tokenStored) {
    clearRetryTimer();
  }
}

function restoreRegisteredStates() {
  let changed = false;
  let next = states;
  for (const key of registered.keys()) {
    if (next[key] !== "degraded") continue;
    if (!changed) {
      next = { ...states };
      changed = true;
    }
    next[key] = "registered";
  }
  if (changed) {
    states = next;
    notifyStateListeners();
  }
}

function markPendingDegraded() {
  const keys = pendingProfiles.size > 0 ? [...pendingProfiles] : [...registered.keys()];
  let changed = false;
  let next = states;
  for (const key of keys) {
    if (!registered.has(key) || next[key] === "degraded") continue;
    if (!changed) {
      next = { ...states };
      changed = true;
    }
    next[key] = "degraded";
  }
  if (changed) {
    states = next;
    notifyStateListeners();
  }
}

function scheduleRetryOrDegrade(generation: number, attempt: number) {
  if (generation !== rotationGeneration || !registered.size) return;
  if (attempt < PUSH_ROTATION_RETRY_DELAYS_MS.length) {
    const delay = PUSH_ROTATION_RETRY_DELAYS_MS[attempt]!;
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void syncRotation(generation, attempt + 1);
    }, delay);
    return;
  }
  markPendingDegraded();
}

async function syncRotation(generation: number, attempt: number) {
  if (generation !== rotationGeneration || !registered.size || !activeProjectId) return;
  rotationInFlight = true;
  try {
    let token = pendingToken;
    if (!token) {
      const options: Notifications.ExpoPushTokenOptions = pendingDevicePushToken
        ? { projectId: activeProjectId, devicePushToken: pendingDevicePushToken }
        : { projectId: activeProjectId };
      const fetched = (await Notifications.getExpoPushTokenAsync(options)).data;
      if (generation !== rotationGeneration || !registered.size) return;
      token = fetched;
      pendingToken = fetched;
      lastRotatedToken = fetched;
    }

    const targets: [string, Connection][] = [];
    for (const key of [...pendingProfiles]) {
      const profile = registered.get(key);
      if (!profile) pendingProfiles.delete(key);
      else targets.push([key, profile]);
    }

    if (targets.length > 0) {
      const results = await Promise.allSettled(
        targets.map(([, profile]) =>
          api(profile, "/devices/push", {
            body: { token, platform: platform() },
          }),
        ),
      );
      if (generation !== rotationGeneration || !registered.size) return;
      for (let i = 0; i < targets.length; i += 1) {
        const [key] = targets[i]!;
        if (results[i]?.status === "fulfilled") {
          pendingProfiles.delete(key);
          if (registered.has(key)) {
            acceptedTokenByProfile.set(key, token);
            setPushState(key, "registered");
          }
        } else if (!registered.has(key)) {
          pendingProfiles.delete(key);
        }
      }
    }

    if (pendingProfiles.size === 0 && !tokenStored) {
      await SecureStore.setItemAsync(TOKEN_KEY, token);
      if (generation !== rotationGeneration || !registered.size) return;
      tokenStored = true;
      pendingToken = null;
      pendingDevicePushToken = null;
      restoreRegisteredStates();
    }

    if (pendingProfiles.size > 0 || !tokenStored) {
      scheduleRetryOrDegrade(generation, attempt);
    }
  } catch {
    if (generation !== rotationGeneration || !registered.size) return;
    scheduleRetryOrDegrade(generation, attempt);
  } finally {
    if (generation === rotationGeneration) rotationInFlight = false;
  }
}

function startTokenRotation(devicePushToken: Notifications.DevicePushToken) {
  if (!registered.size || !activeProjectId) return;
  rotationGeneration += 1;
  clearRetryTimer();
  pendingDevicePushToken = devicePushToken;
  lastRotatedDevicePushToken = devicePushToken;
  pendingToken = null;
  lastRotatedToken = null;
  tokenStored = false;
  pendingProfiles.clear();
  for (const key of registered.keys()) pendingProfiles.add(key);
  void syncRotation(rotationGeneration, 0);
}

function retryPendingOnForeground() {
  if (!registered.size || !activeProjectId || rotationInFlight) return;
  if (pendingProfiles.size === 0 && tokenStored) return;
  rotationGeneration += 1;
  clearRetryTimer();
  void syncRotation(rotationGeneration, 0);
}

function attachListeners() {
  tokenListener ??= Notifications.addPushTokenListener(devicePushToken => {
    startTokenRotation(devicePushToken);
  });
  foregroundUnsubscribe ??= onForegroundChange(foreground => {
    if (foreground) retryPendingOnForeground();
  });
}

export function getPushStates(): Record<string, PushState> {
  return states;
}

export function subscribePushStates(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export async function registerForPush(
  connection: Connection,
): Promise<PushState> {
  const key = connectionKey(connection);
  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId || (!Device.isDevice && Platform.OS === "ios")) {
    removeProfileFromRotation(key);
    flushPendingStoreIfReady();
    setPushState(key, "unavailable");
    return "unavailable";
  }
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
  if (status !== "granted") {
    removeProfileFromRotation(key);
    flushPendingStoreIfReady();
    setPushState(key, "denied");
    return "denied";
  }
  const startGeneration = rotationGeneration;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api(connection, "/devices/push", {
    body: { token, platform: platform() },
  });
  activeProjectId = projectId;
  registered.set(key, connection);
  attachListeners();

  const supersededByRotation =
    rotationGeneration !== startGeneration ||
    rotationInFlight ||
    (pendingToken !== null && pendingToken !== token);

  if (supersededByRotation) {
    if (!acceptedTokenByProfile.has(key)) acceptedTokenByProfile.set(key, token);
    if (!pendingProfiles.has(key)) {
      pendingProfiles.add(key);
      if (lastRotatedDevicePushToken && !pendingDevicePushToken) {
        pendingDevicePushToken = lastRotatedDevicePushToken;
      }
      if (lastRotatedToken && !pendingToken) {
        pendingToken = lastRotatedToken;
      }
      if (!rotationInFlight && retryTimer === null) {
        rotationGeneration += 1;
        void syncRotation(rotationGeneration, 0);
      }
    }
    if (!Object.hasOwn(states, key)) setPushState(key, "registered");
    return states[key] ?? "registered";
  }

  acceptedTokenByProfile.set(key, token);
  pendingProfiles.delete(key);
  if (pendingProfiles.size === 0) {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    if (rotationGeneration === startGeneration) {
      tokenStored = true;
      pendingToken = null;
      pendingDevicePushToken = null;
      clearRetryTimer();
    }
  }
  if (rotationGeneration === startGeneration) {
    setPushState(key, "registered");
  } else if (!Object.hasOwn(states, key)) {
    setPushState(key, "registered");
  }
  return states[key] ?? "registered";
}

export async function unregisterPush(connection: Connection) {
  const key = connectionKey(connection);
  const acceptedToken = acceptedTokenByProfile.get(key) ?? null;
  const activeRotatedToken = pendingToken;
  acceptedTokenByProfile.delete(key);
  removeProfileFromRotation(key);
  deletePushState(key);
  const storedToken = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  flushPendingStoreIfReady();
  const tokens = new Set<string>();
  if (acceptedToken) tokens.add(acceptedToken);
  if (storedToken) tokens.add(storedToken);
  if (activeRotatedToken) tokens.add(activeRotatedToken);
  if (tokens.size > 0) {
    await Promise.allSettled(
      [...tokens].map(token =>
        api(connection, "/devices/push", {
          method: "DELETE",
          body: { token },
        }),
      ),
    );
  }
  if (!registered.size) await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
}
