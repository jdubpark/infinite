import { useEffect, useState } from "react";
import { inForeground, onForegroundChange } from "./foreground";

/**
 * The time, read every `intervalMs` while `active` and the app is in the foreground, and again on its return.
 * Ages measured against it move on with no network read. It reads 0 until its first tick.
 */
export function useClock(intervalMs: number, active = true): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { clearInterval(timer); timer = undefined; };
    const start = () => { stop(); setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), intervalMs); };
    if (inForeground()) start();
    const unsubscribe = onForegroundChange(foreground => (foreground ? start() : stop()));
    return () => { stop(); unsubscribe(); };
  }, [intervalMs, active]);
  return now;
}
