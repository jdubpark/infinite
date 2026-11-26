type AppStateStatus = "active" | "inactive" | "background";
type AppStateListener = (state: AppStateStatus) => void;
export type DevicePushToken = { type: "ios" | "android" | "web"; data: string };
export type ExpoPushTokenOptions = { projectId?: string; devicePushToken?: DevicePushToken };
type TokenListener = (token: DevicePushToken) => void;

export type Connection = { id?: string; url: string; token: string };
export type ApiCall = { key: string; path: string; method: string; body: unknown };

const appStateListeners = new Set<AppStateListener>();
const tokenListeners = new Set<TokenListener>();
const secureStore = new Map<string, string>();
const apiCalls: ApiCall[] = [];
const tokenFetchOptions: (ExpoPushTokenOptions | undefined)[] = [];

let permissionStatus = "granted";
let reemitWhenDeviceTokenOmitted = false;
let tokenFetcher: (options?: ExpoPushTokenOptions) => Promise<{ data: string }> = async () => ({ data: "ExponentPushToken[initial]" });
let apiHandler: (connection: Connection, path: string, init?: { method?: string; body?: unknown }) => Promise<unknown> = async () => ({});
let secureSetHandler: (key: string, value: string) => Promise<void> = async (key, value) => {
  secureStore.set(key, value);
};

export const Platform = { OS: "ios" as "ios" | "android" };
export let isDevice = true;
export default {
  expoConfig: { extra: { eas: { projectId: "test-eas-project" } } },
  easConfig: { projectId: "test-eas-project" },
};

export const AndroidImportance = { MAX: 5 };
export async function setNotificationChannelAsync() {}
export async function getPermissionsAsync() {
  return { status: permissionStatus };
}
export async function requestPermissionsAsync() {
  return { status: permissionStatus };
}
export async function getExpoPushTokenAsync(options?: ExpoPushTokenOptions) {
  tokenFetchOptions.push(options);
  if (reemitWhenDeviceTokenOmitted && !options?.devicePushToken) {
    for (const listener of [...tokenListeners]) {
      listener({ type: "android", data: "reemitted-device-token" });
    }
  }
  return await tokenFetcher(options);
}
export function addPushTokenListener(listener: TokenListener) {
  tokenListeners.add(listener);
  return {
    remove: () => {
      tokenListeners.delete(listener);
    },
  };
}

export const AppState = {
  currentState: "active" as AppStateStatus,
  addEventListener(_type: "change", listener: AppStateListener) {
    appStateListeners.add(listener);
    return {
      remove: () => {
        appStateListeners.delete(listener);
      },
    };
  },
};

export function setAppState(state: AppStateStatus) {
  if (AppState.currentState === state) return;
  AppState.currentState = state;
  for (const listener of [...appStateListeners]) listener(state);
}

export async function getItemAsync(key: string) {
  return secureStore.get(key) ?? null;
}
export async function setItemAsync(key: string, value: string) {
  await secureSetHandler(key, value);
}
export async function deleteItemAsync(key: string) {
  secureStore.delete(key);
}

export const connectionKey = (connection: Connection) => connection.id ?? connection.url;

export async function api<T>(
  connection: Connection,
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  apiCalls.push({ key: connectionKey(connection), path, method, body: init.body });
  return (await apiHandler(connection, path, init)) as T;
}

export const pushTestControl = {
  reset() {
    permissionStatus = "granted";
    isDevice = true;
    Platform.OS = "ios";
    reemitWhenDeviceTokenOmitted = false;
    AppState.currentState = "active";
    appStateListeners.clear();
    tokenListeners.clear();
    secureStore.clear();
    apiCalls.length = 0;
    tokenFetchOptions.length = 0;
    tokenFetcher = async () => ({ data: "ExponentPushToken[initial]" });
    apiHandler = async () => ({});
    secureSetHandler = async (key, value) => {
      secureStore.set(key, value);
    };
  },
  setPermissionStatus(status: string) {
    permissionStatus = status;
  },
  setIsDevice(value: boolean) {
    isDevice = value;
  },
  setReemitWhenDeviceTokenOmitted(value: boolean) {
    reemitWhenDeviceTokenOmitted = value;
  },
  setTokenFetcher(fn: (options?: ExpoPushTokenOptions) => Promise<{ data: string }>) {
    tokenFetcher = fn;
  },
  setApiHandler(fn: (connection: Connection, path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>) {
    apiHandler = fn;
  },
  setSecureSetHandler(fn: (key: string, value: string) => Promise<void>) {
    secureSetHandler = fn;
  },
  emitTokenRotation(devicePushToken: DevicePushToken = { type: "android", data: "native-device-token" }) {
    for (const listener of [...tokenListeners]) listener(devicePushToken);
  },
  tokenFetchOptions() {
    return [...tokenFetchOptions];
  },
  clearTokenFetchOptions() {
    tokenFetchOptions.length = 0;
  },
  tokenListenerCount() {
    return tokenListeners.size;
  },
  appStateListenerCount() {
    return appStateListeners.size;
  },
  storedToken() {
    return secureStore.get("infinite.push.v1") ?? null;
  },
  calls() {
    return [...apiCalls];
  },
  clearCalls() {
    apiCalls.length = 0;
  },
};
