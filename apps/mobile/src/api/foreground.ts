import { AppState, type AppStateStatus } from "react-native";

export const APP_BACKGROUND_GRACE_MS = 30_000;

export function inForeground(state: AppStateStatus = AppState.currentState): boolean {
  return state !== "background";
}

export function onForegroundChange(listener: (foreground: boolean) => void): () => void {
  let foreground = inForeground();
  const subscription = AppState.addEventListener("change", (state) => {
    const next = inForeground(state);
    if (next === foreground) return;
    foreground = next;
    listener(next);
  });
  return () => subscription.remove();
}
