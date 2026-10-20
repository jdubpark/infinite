import { AppState, type AppStateStatus } from "react-native";

// Keep the live stream and remote channel for one host control lease window.
export const APP_BACKGROUND_GRACE_MS = 30_000;

/**
 * iOS reports `inactive` for the app switcher, Control Center, Face ID and call
 * banners; only `background` means the person left the app.
 */
export function inForeground(state: AppStateStatus = AppState.currentState): boolean {
  return state !== "background";
}

/** Calls the listener only when the app crosses between foreground and background. */
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
