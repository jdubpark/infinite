import { randomBytes, randomUUID as nodeUUID } from "node:crypto";

/**
 * Stands in for `react-native`, `expo-crypto` and `expo-secure-store` so phone modules
 * run under Node. Tests move the app between states with `setAppState`.
 */
type AppStateStatus = "active" | "inactive" | "background";
const listeners = new Set<(state: AppStateStatus) => void>();

export const AppState = {
  currentState: "active" as AppStateStatus,
  addEventListener(_type: "change", listener: (state: AppStateStatus) => void) {
    listeners.add(listener);
    return { remove: () => void listeners.delete(listener) };
  },
};

export function setAppState(state: AppStateStatus) {
  if (AppState.currentState === state) return;
  AppState.currentState = state;
  for (const listener of [...listeners]) listener(state);
}

export const getRandomBytes = (length: number) => new Uint8Array(randomBytes(length));
export const randomUUID = () => nodeUUID();

const store = new Map<string, string>();
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 0;
export const getItemAsync = async (key: string) => store.get(key) ?? null;
export const setItemAsync = async (key: string, value: string) => void store.set(key, value);
export const deleteItemAsync = async (key: string) => void store.delete(key);

type Event = { topic: string; data: unknown };
type EventOptions = {
  topics: string[];
  after?: number;
  onEvent(event: Event): void;
  onClose(event: { code: number; error?: unknown }): void;
};
export type OpenedEventStream = { options: EventOptions; closed: boolean };
const eventStreams: OpenedEventStream[] = [];
const eventOpenOptions: EventOptions[] = [];
const eventHistory: Event[] = [];
let eventOpenAttempts = 0;
let eventStreamsUnavailable = false;
let nextEventOpenGate: Promise<void> | undefined;

function eventCursor(event: Event) {
  const data = event.data as { cursor?: unknown } | undefined;
  return typeof data?.cursor === "number" ? data.cursor : undefined;
}

/** Test double used only by `useLive`; protocol tests use the real remote client. */
export async function openEvents(_connection: unknown, options: EventOptions) {
  eventOpenAttempts++;
  eventOpenOptions.push(options);
  const gate = nextEventOpenGate;
  nextEventOpenGate = undefined;
  if (gate) await gate;
  if (eventStreamsUnavailable) throw new Error("event stream unavailable");
  const stream: OpenedEventStream = { options, closed: false };
  eventStreams.push(stream);
  for (const event of eventHistory) {
    const cursor = eventCursor(event);
    if (options.topics.includes(event.topic) && cursor !== undefined && cursor > (options.after ?? 0)) options.onEvent(event);
  }
  return { close: () => { stream.closed = true; } };
}

export function resetEventStreams() {
  for (const stream of eventStreams) stream.closed = true;
  eventStreams.length = 0;
  eventOpenOptions.length = 0;
  eventHistory.length = 0;
  eventOpenAttempts = 0;
  eventStreamsUnavailable = false;
  nextEventOpenGate = undefined;
}

export function holdNextEventOpen() {
  let release!: () => void;
  nextEventOpenGate = new Promise<void>(resolve => { release = resolve; });
  return release;
}

export function setEventStreamsUnavailable(unavailable: boolean) {
  eventStreamsUnavailable = unavailable;
}

export function getEventOpenAttempts() {
  return eventOpenAttempts;
}

export function isEventStreamClosed(index: number) {
  if (!eventStreams[index]) throw new Error(`No event stream at index ${index}`);
  return eventStreams[index].closed;
}

export function getEventOpenAfter(index: number) {
  if (!eventOpenOptions[index]) throw new Error(`No event open attempt at index ${index}`);
  return eventOpenOptions[index].after;
}

export function emitEvent(index: number, event: Event) {
  eventHistory.push(event);
  for (const stream of eventStreams) {
    if (!stream.closed && stream.options.topics.includes(event.topic)) stream.options.onEvent(event);
  }
}

export function markEventStreamDead(index: number) {
  const stream = eventStreams[index];
  if (!stream) throw new Error(`No event stream at index ${index}`);
  stream.closed = true;
  stream.options.onClose({ code: 1006 });
}
