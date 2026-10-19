import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { useSyncExternalStore } from "react";
import { connectionKey, type Connection } from "../api/client";

/** Unchanged from the single-file app so existing pairings survive. */
export const SECRET_KEY = "infinite.connection.v1";
const PROFILES_KEY = "infinite.machines.v2";
type SavedConnections = { active: string; profiles: Connection[] };
const EMPTY: SavedConnections = { active: "", profiles: [] };
let snapshot: SavedConnections | undefined;
let loading: Promise<SavedConnections> | undefined;
const listeners = new Set<() => void>();

function publish(saved: SavedConnections) {
  snapshot = saved;
  listeners.forEach(listener => listener());
}

export function useConnections() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => snapshot ?? EMPTY,
  );
}

export async function loadConnections(): Promise<SavedConnections> {
  if (snapshot) return snapshot;
  loading ??= (async () => {
    const value = await SecureStore.getItemAsync(PROFILES_KEY);
    if (value) return JSON.parse(value) as SavedConnections;
    const legacy = await SecureStore.getItemAsync(SECRET_KEY);
    if (!legacy) return EMPTY;
    const connection = { ...(JSON.parse(legacy) as Connection), id: Crypto.randomUUID() };
    const saved = { active: connection.id, profiles: [connection] };
    await persist(saved);
    await SecureStore.deleteItemAsync(SECRET_KEY);
    return saved;
  })().then(saved => { publish(saved); return saved; }).finally(() => { loading = undefined; });
  return loading;
}

async function persist(saved: SavedConnections) {
  await SecureStore.setItemAsync(PROFILES_KEY, JSON.stringify(saved), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

let writes: Promise<void> = Promise.resolve();
function update(change: (saved: SavedConnections) => SavedConnections) {
  const next = writes.then(async () => {
    await loadConnections();
    const saved = change(snapshot ?? EMPTY);
    publish(saved);
    await persist(saved);
  });
  writes = next.catch(() => {});
  return next;
}

export async function loadConnection(id?: string): Promise<Connection | null> {
  const saved = await loadConnections();
  return saved.profiles.find(profile => connectionKey(profile) === (id ?? saved.active)) ?? null;
}

export async function saveConnection(connection: Connection) {
  const next = { ...connection, id: connection.id ?? Crypto.randomUUID() };
  await update(saved => ({ active: next.id, profiles: [...saved.profiles.filter(profile => connectionKey(profile) !== next.id), next] }));
  return next;
}

export async function selectConnection(id: string) {
  await update(saved => {
    if (!saved.profiles.some(profile => connectionKey(profile) === id)) throw new Error("Machine is not paired.");
    return { ...saved, active: id };
  });
}

export function clearConnection(id?: string) {
  const target = id ?? snapshot?.active;
  const remove = (saved: SavedConnections, key: string) => {
    const profiles = saved.profiles.filter(profile => connectionKey(profile) !== key);
    return { active: profiles.some(profile => connectionKey(profile) === saved.active) ? saved.active : profiles[0] ? connectionKey(profiles[0]) : "", profiles };
  };
  // Publish removal before persistence so every mounted tab stops using the machine at once.
  if (snapshot && target) publish(remove(snapshot, target));
  const next = writes.then(async () => {
    await loadConnections();
    if (!snapshot) return;
    const key = target ?? snapshot.active;
    const saved = key && snapshot.profiles.some(profile => connectionKey(profile) === key) ? remove(snapshot, key) : snapshot;
    publish(saved);
    await persist(saved);
  });
  writes = next.catch(() => {});
  return next;
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

export async function identifyConnection(connection: Connection, machineId: string) {
  if (connection.machineId === machineId) return;
  await update(saved => ({ ...saved, profiles: saved.profiles.map(profile => connectionKey(profile) === connectionKey(connection) ? { ...profile, machineId } : profile) }));
}
