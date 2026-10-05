import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

/**
 * Polls `fn` every `intervalMs` while the app is in the foreground. The last
 * good value stays in `data` when a poll fails; `online` reports whether the
 * latest poll succeeded and `seen` is the local time of the last success.
 * Polling stops while the app is backgrounded and resumes on return.
 * `refresh()` cancels the pending timer and polls now (or right after the
 * poll in flight). The effect restarts when `intervalMs` or `deps` change.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: unknown[],
): { data: T | null; online: boolean; seen: string; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [online, setOnline] = useState(false);
  const [seen, setSeen] = useState("");
  const latest = useRef(fn);
  const pollNow = useRef<() => void>(() => {});
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    let active = true,
      polling = false,
      again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || AppState.currentState !== "active") return;
      if (polling) {
        again = true;
        return;
      }
      polling = true;
      again = false;
      try {
        const value = await latest.current();
        if (active) {
          setData(value);
          setOnline(true);
          setSeen(new Date().toLocaleTimeString());
        }
      } catch {
        if (active) setOnline(false);
      } finally {
        polling = false;
        if (active) timer = setTimeout(poll, again ? 0 : intervalMs);
      }
    };
    pollNow.current = () => {
      clearTimeout(timer);
      void poll();
    };
    const listener = AppState.addEventListener("change", (state) => {
      clearTimeout(timer);
      if (state === "active") void poll();
    });
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      listener.remove();
      pollNow.current = () => {};
    };
    // The caller owns the dependency list; `fn` is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
  const refresh = useCallback(() => pollNow.current(), []);
  return { data, online, seen, refresh };
}
