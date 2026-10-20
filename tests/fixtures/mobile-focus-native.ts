type AppStateStatus = "active" | "inactive" | "background";
type AppStateListener = (state: AppStateStatus) => void;
type EventOptions = { topics: string[]; after: number; onEvent(event: { topic: string; data: unknown }): void; onClose(): void };
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };

let slots: Slot[] = [];
let cursor = 0;
let effects: (() => void)[] = [];
let focused = true;
let appState: AppStateStatus = "active";
let resolveFirstPoll: ((value: string) => void) | undefined;
let failPolls = false;
const appStateListeners = new Set<AppStateListener>();

const slot = () => (slots[cursor++] ??= {});
const changed = (current: Slot, deps?: unknown[]) =>
  !deps || !current.deps || deps.length !== current.deps.length || deps.some((dep, index) => !Object.is(dep, current.deps![index]));

export function useState<T>(initial: T) {
  const current = slot();
  if (!("value" in current)) current.value = typeof initial === "function" ? (initial as () => T)() : initial;
  const set = (next: T | ((previous: T) => T)) => {
    current.value = typeof next === "function" ? (next as (previous: T) => T)(current.value as T) : next;
  };
  return [current.value as T, set] as const;
}

export function useRef<T>(initial: T) {
  const current = slot();
  if (!("value" in current)) current.value = { current: initial };
  return current.value as { current: T };
}

export function useCallback<T>(callback: T, deps: unknown[]) {
  const current = slot();
  if (changed(current, deps)) Object.assign(current, { value: callback, deps });
  return current.value as T;
}

export function useEffect(effect: () => void | (() => void), deps?: unknown[]) {
  const current = slot();
  if (!changed(current, deps)) return;
  current.deps = deps;
  effects.push(() => {
    if (typeof current.cleanup === "function") current.cleanup();
    current.cleanup = effect();
  });
}

export const useLayoutEffect = useEffect;

export function useSyncExternalStore<T>(_subscribe: (listener: () => void) => () => void, snapshot: () => T) {
  return snapshot();
}

export const useIsFocused = () => focused;
export const setFocused = (value: boolean) => { focused = value; };

export function renderHook<T>(hook: () => T) {
  const mounted: Slot[] = [];
  const render = () => {
    slots = mounted;
    cursor = 0;
    effects = [];
    const result = hook();
    for (const effect of effects) effect();
    return result;
  };
  render();
  return {
    read: render,
    unmount: () => {
      for (const current of mounted) if (typeof current.cleanup === "function") current.cleanup();
    },
  };
}

export const AppState = {
  get currentState() { return appState; },
  addEventListener(_event: "change", listener: AppStateListener) {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
};

export function setAppState(state: AppStateStatus) {
  appState = state;
  for (const listener of [...appStateListeners]) listener(state);
}

export const monitor = {
  pollCalls: 0,
  liveLoads: 0,
  opens: 0,
  closes: 0,
  poll() {
    this.pollCalls++;
    const call = this.pollCalls;
    if (call === 1) return new Promise<string>(resolve => { resolveFirstPoll = resolve; });
    if (failPolls) return Promise.reject(new Error("offline"));
    return Promise.resolve(`poll-${call}`);
  },
  resolveFirstPoll(value: string) {
    resolveFirstPoll?.(value);
    resolveFirstPoll = undefined;
  },
  failPolls(value: boolean) { failPolls = value; },
  load() {
    this.liveLoads++;
    return Promise.resolve(`live-${this.liveLoads}`);
  },
  openEvents(_connection: unknown, _options: EventOptions) {
    this.opens++;
    return Promise.resolve({ close: () => { this.closes++; } });
  },
};

const speechListeners = new Map<string, Set<(event?: unknown) => void>>();
const speech = {
  start() {},
  stop() {},
  abort() {},
  isRecognitionAvailable: () => true,
  requestPermissionsAsync: async () => ({ granted: true }),
  addListener(name: string, listener: (event?: unknown) => void) {
    let listeners = speechListeners.get(name);
    if (!listeners) { listeners = new Set(); speechListeners.set(name, listeners); }
    listeners.add(listener);
    return { remove: () => { listeners!.delete(listener); } };
  },
};

export function requireOptionalNativeModule<T>(_name: string) {
  return speech as T;
}

export function speechListenerCounts() {
  return Object.fromEntries([...speechListeners].filter(([, listeners]) => listeners.size > 0).map(([name, listeners]) => [name, listeners.size]));
}

export class ApiError extends Error {
  constructor(readonly code?: string) { super(code); }
}

export async function api<T>() {
  throw new Error("unexpected API request");
}

export function openEvents(connection: unknown, options: EventOptions) {
  return monitor.openEvents(connection, options);
}

export type Connection = { url: string; token: string };
