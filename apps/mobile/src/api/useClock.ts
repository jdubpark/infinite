import { useEffect, useState } from "react";
import { inForeground, onForegroundChange } from "./foreground";

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
