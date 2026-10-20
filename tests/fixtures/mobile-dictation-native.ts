// Stand-ins for the modules the phone's dictation hook imports: Expo's optional native module lookup, expo-router's
// screen focus, and the host API. tests/mobile-dictation-lifecycle.test.ts bundles the real hook with these in their place.
import { createContext, useContext } from "react";

type Listener = (event?: unknown) => void;
type Cleanup = { text: string; resolve: (value: { model: string; text: string }) => void };

/** One recognizer for the whole app, like the native module. Ends can be held to model a late native `end`. */
const listeners = new Map<string, Set<Listener>>();
const emit = (name: string, event?: unknown) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(event); };
export const native = {
  starts: 0,
  aborts: 0,
  holdEnds: false,
  heldEnds: 0,
  cleanups: [] as Cleanup[],
  say(transcript: string) { emit("result", { isFinal: true, results: [{ transcript }] }); },
  end() { if (native.holdEnds) native.heldEnds++; else emit("end"); },
  releaseEnds() { native.holdEnds = false; for (; native.heldEnds > 0; native.heldEnds--) emit("end"); },
};

const speech = {
  start() { native.starts++; setTimeout(() => emit("start")); },
  stop() { setTimeout(() => native.end()); },
  // Like the platform recognizers, an abort reports the end later.
  abort() { native.aborts++; setTimeout(() => native.end()); },
  isRecognitionAvailable: () => true,
  requestPermissionsAsync: async () => ({ granted: true }),
  addListener(name: string, listener: Listener) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return { remove: () => listeners.get(name)!.delete(listener) };
  },
};

export function requireOptionalNativeModule(name: string) {
  return name === "ExpoSpeechRecognition" ? speech : null;
}

export const Focus = createContext(true);
export const useIsFocused = () => useContext(Focus);

export class ApiError extends Error {
  constructor(readonly code?: string) { super(code); }
}
export type Connection = { url: string; token: string };
export type Me = { role: string; capabilities?: { dictation?: { model: string } } };

export async function api(_connection: Connection, path: string, options?: { body?: { text: string } }) {
  if (path === "/me") return { role: "owner", capabilities: { dictation: { model: "test-cleanup" } } };
  if (path === "/dictation/cleanup" && options?.body) return new Promise(resolve => native.cleanups.push({ text: options.body!.text, resolve }));
  throw new Error(`Unexpected request: ${path}`);
}
