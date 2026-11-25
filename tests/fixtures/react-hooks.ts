type Slot = { value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
let slots: Slot[] = [];
let cursor = 0;
let effects: (() => void)[] = [];

const slot = () => (slots[cursor++] ??= {});
const changed = (current: Slot, deps?: unknown[]) =>
  !deps || !current.deps || deps.length !== current.deps.length || deps.some((dep, index) => !Object.is(dep, current.deps![index]));

export function useState<T>(initial: T) {
  const current = slot();
  if (!("value" in current)) current.value = initial;
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

export function useSyncExternalStore<T>(_subscribe: (listener: () => void) => () => void, snapshot: () => T) {
  return snapshot();
}

export const useFocusEffect = (effect: () => void | (() => void)) => useEffect(effect, [effect]);
export const useIsFocused = () => true;

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
