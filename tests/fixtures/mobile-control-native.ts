type Slot = { value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };

let slots: Slot[] = [];
let cursor = 0;
let effects: (() => void)[] = [];
let focused = true;

const slot = () => (slots[cursor++] ??= {});
const changed = (current: Slot, deps?: unknown[]) =>
  !deps || !current.deps || deps.length !== current.deps.length || deps.some((dep, index) => !Object.is(dep, current.deps![index]));

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

export function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T) {
  useEffect(() => subscribe(() => {}), [subscribe]);
  return snapshot();
}

export function useFocusEffect(effect: () => void | (() => void)) {
  useEffect(() => focused ? effect() : undefined, [focused, effect]);
}

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

export function setFocused(value: boolean) {
  focused = value;
}

export const inForeground = () => true;
export const onForegroundChange = () => () => {};

export class ControlRefusal extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

export async function api<T>(): Promise<T> {
  throw new Error("unexpected API request");
}
