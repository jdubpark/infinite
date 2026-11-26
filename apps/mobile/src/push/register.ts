import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { api, connectionKey, type Connection } from "../api/client";
import { onForegroundChange } from "../api/foreground";

const TOKEN_KEY = "infinite.push.v1";
const PROFILE_TOKENS_KEY = "infinite.push.profiles.v1";
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
let profileTokenWrites: Promise<void> = Promise.resolve();
const registered = new Map<string, Connection>();
const acceptedTokenByProfile = new Map<string, string>();
const profileGeneration = new Map<string, number>();
const pendingProfiles = new Set<string>();
let states: Record<string, PushState> = {};
const stateListeners = new Set<() => void>();

function platform() {
  return Platform.OS === "ios" ? "ios" : "android";
}

function bumpProfileGeneration(key: string): number {
  const next = (profileGeneration.get(key) ?? 0) + 1;
  profileGeneration.set(key, next);
  return next;
}

function isCurrentProfileGeneration(key: string, generation: number): boolean {
  return profileGeneration.get(key) === generation;
}

async function readPersistedProfileTokens(): Promise<Record<string, string>> {
  const raw = await SecureStore.getItemAsync(PROFILE_TOKENS_KEY).catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const valid: Record<string, string> = {};
    for (const [entryKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) valid[entryKey] = value;
    }
    return valid;
  } catch {
    return {};
  }
}

function writePersistedProfileTokens(mutate: (current: Record<string, string>) => boolean): Promise<void> {
  const next = profileTokenWrites.then(async () => {
    const current = await readPersistedProfileTokens();
    if (!mutate(current)) return;
    if (Object.keys(current).length === 0) {
      await SecureStore.deleteItemAsync(PROFILE_TOKENS_KEY);
    } else {
      await SecureStore.setItemAsync(PROFILE_TOKENS_KEY, JSON.stringify(current));
    }
  });
  profileTokenWrites = next.catch(() => {});
  return next;
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

async function persistRegisteredAcceptedTokens() {
  await writePersistedProfileTokens(current => {
    let changed = false;
    for (const [profileKey, accepted] of acceptedTokenByProfile) {
      if (registered.has(profileKey) && current[profileKey] !== accepted) {
        current[profileKey] = accepted;
        changed = true;
      }
    }
    return changed;
  });
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

    const acceptedKeys: string[] = [];
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
            acceptedKeys.push(key);
            setPushState(key, "registered");
          }
        } else if (!registered.has(key)) {
          pendingProfiles.delete(key);
        }
      }
    }

    if (acceptedKeys.length > 0 && (pendingProfiles.size > 0 || tokenStored)) {
      await writePersistedProfileTokens(current => {
        let changed = false;
        for (const key of acceptedKeys) {
          if (!registered.has(key)) continue;
          if (current[key] !== token) {
            current[key] = token;
            changed = true;
          }
        }
        return changed;
      });
      if (generation !== rotationGeneration || !registered.size) return;
    }

    if (pendingProfiles.size === 0 && !tokenStored) {
      await persistRegisteredAcceptedTokens();
      if (generation !== rotationGeneration || !registered.size) return;
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

export function clearPushState(connection: Connection) {
  const key = connectionKey(connection);
  bumpProfileGeneration(key);
  removeProfileFromRotation(key);
  deletePushState(key);
  flushPendingStoreIfReady();
}

export async function registerForPush(
  connection: Connection,
): Promise<PushState> {
  const key = connectionKey(connection);
  const regGen = bumpProfileGeneration(key);
  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId || (!Device.isDevice && Platform.OS === "ios")) {
    removeProfileFromRotation(key);
    flushPendingStoreIfReady();
    setPushState(key, "unavailable");
    return "unavailable";
  }
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("attention", {
      name: "Needs your attention",
      importance: Notifications.AndroidImportance.MAX,
    });
    if (!isCurrentProfileGeneration(key, regGen)) return states[key] ?? "unavailable";
  }
  const current = await Notifications.getPermissionsAsync();
  if (!isCurrentProfileGeneration(key, regGen)) return states[key] ?? "unavailable";
  const status =
    current.status === "granted"
      ? current.status
      : (await Notifications.requestPermissionsAsync()).status;
  if (!isCurrentProfileGeneration(key, regGen)) return states[key] ?? "unavailable";
  if (status !== "granted") {
    removeProfileFromRotation(key);
    flushPendingStoreIfReady();
    setPushState(key, "denied");
    return "denied";
  }
  const startGeneration = rotationGeneration;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  if (!isCurrentProfileGeneration(key, regGen)) return states[key] ?? "unavailable";
  await api(connection, "/devices/push", {
    body: { token, platform: platform() },
  });
  if (!isCurrentProfileGeneration(key, regGen)) return states[key] ?? "unavailable";
  activeProjectId = projectId;
  registered.set(key, connection);
  attachListeners();

  const supersededByRotation =
    rotationGeneration !== startGeneration ||
    rotationInFlight ||
    (pendingToken !== null && pendingToken !== token);

  if (supersededByRotation) {
    const shouldRecord = !acceptedTokenByProfile.has(key);
    if (shouldRecord) acceptedTokenByProfile.set(key, token);
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
    if (shouldRecord) {
      await writePersistedProfileTokens(persisted => {
        if (!registered.has(key) || Object.hasOwn(persisted, key)) return false;
        persisted[key] = token;
        return true;
      }).catch(() => {});
    }
    return states[key] ?? "registered";
  }

  acceptedTokenByProfile.set(key, token);
  pendingProfiles.delete(key);
  await writePersistedProfileTokens(persisted => {
    if (!registered.has(key) || persisted[key] === token) return false;
    persisted[key] = token;
    return true;
  });
  if (!isCurrentProfileGeneration(key, regGen)) return states[key] ?? "unavailable";
  if (pendingProfiles.size === 0) {
    await persistRegisteredAcceptedTokens();
    if (!isCurrentProfileGeneration(key, regGen)) return states[key] ?? "unavailable";
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    if (!isCurrentProfileGeneration(key, regGen)) return states[key] ?? "unavailable";
    if (rotationGeneration === startGeneration) {
      tokenStored = true;
      pendingToken = null;
      pendingDevicePushToken = null;
      clearRetryTimer();
      restoreRegisteredStates();
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
  bumpProfileGeneration(key);
  const acceptedToken = acceptedTokenByProfile.get(key) ?? null;
  const activeRotatedToken = pendingToken;
  acceptedTokenByProfile.delete(key);
  removeProfileFromRotation(key);
  deletePushState(key);
  await profileTokenWrites;
  const [storedToken, persistedTokens] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY).catch(() => null),
    readPersistedProfileTokens(),
  ]);
  const persistedProfileToken = persistedTokens[key] ?? null;
  flushPendingStoreIfReady();
  const tokens = new Set<string>();
  if (acceptedToken) tokens.add(acceptedToken);
  if (persistedProfileToken) tokens.add(persistedProfileToken);
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
  await writePersistedProfileTokens(current => {
    if (registered.has(key) || !Object.hasOwn(current, key)) return false;
    delete current[key];
    return true;
  }).catch(() => {});
  if (!registered.size) await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
}
