import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { requireOptionalNativeModule } from "expo";
import { useIsFocused } from "expo-router";
import { ApiError, api, type Connection, type Me } from "../api/client";
import { appendDictation } from "./text";

/**
 * The parts of expo-speech-recognition's native module this hook uses. The package supplies the native
 * code and config plugin; the hook reads the native module directly and needs none of its JavaScript or types.
 */
type SpeechError = { error: "not-allowed" | "no-speech" | (string & {}); message: string };
type SpeechEvents = {
  start: () => void;
  result: (event: { isFinal: boolean; results: { transcript: string }[] }) => void;
  error: (event: SpeechError) => void;
  end: () => void;
};

/** Expo Go and builds made before the speech module was added have no native module, so this is null there. */
type SpeechModule = {
  start(options: { lang: string; interimResults: boolean; continuous: boolean; addsPunctuation: boolean }): void;
  stop(): void;
  abort(): void;
  isRecognitionAvailable(): boolean;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  addListener<K extends keyof SpeechEvents>(event: K, listener: SpeechEvents[K]): { remove(): void };
};

const speech = requireOptionalNativeModule<SpeechModule>("ExpoSpeechRecognition");

export type DictationState = "idle" | "starting" | "listening" | "cleaning";
export type DictationMessage = { message: string; kind: "success" | "warning" | "error"; useOriginal?: () => void };
export type Dictation = { available: boolean; state: DictationState; toggle: () => void; notice: DictationMessage | null; dismiss: () => void };

/** Notice state; `restore` holds what "Use original" needs and is offered only while the field still shows `inserted`. */
type Notice = { message: string; kind: DictationMessage["kind"]; restore?: { inserted: string; apply: () => void } };
type Session = { finals: string[]; interim: string; failure?: SpeechError["error"]; host: Promise<Me | null>; started?: boolean };

const PERMISSION_COPY = "Allow microphone and speech recognition access in Settings to dictate.";
const LOCKED = "Dictation stopped because the field was locked. Nothing was added.";
const LEFT = "Dictation stopped because you left this screen. Nothing was added.";
const BUSY = "Dictation is already running in another field. Stop it there first.";
/** How long an aborted capture may take to deliver its native `end` before the recognizer is free again. */
const DRAIN_MS = 3000;

/**
 * The native recognizer is one per app, and every mounted field hears its events; a screen left in the
 * stack stays mounted. One field owns it from start until its capture's native `end`. An abandoned
 * capture keeps it reserved until its late `end` arrives, so that event cannot finish a newer capture.
 */
const recognizer: { owner: object | null; drain?: { subscription: { remove(): void }; timer: ReturnType<typeof setTimeout> } } = { owner: null };

function release(owner: object) {
  if (recognizer.owner !== owner) return;
  recognizer.owner = null;
  recognizer.drain?.subscription.remove();
  clearTimeout(recognizer.drain?.timer);
  recognizer.drain = undefined;
}

/** Keeps the recognizer reserved after an abort until its `end`, without depending on the owner staying mounted. */
function drain(owner: object) {
  if (!speech || recognizer.owner !== owner || recognizer.drain) return;
  recognizer.drain = { subscription: speech.addListener("end", () => release(owner)), timer: setTimeout(() => release(owner), DRAIN_MS) };
}
/** Ends inside the encrypted remote channel's 30-second request timeout; the host bounds its model call at 25 seconds. */
const CLEANUP_TIMEOUT_MS = 28000;
const NO_CLEANUP_HOST = "this host has no cleanup model";

function recognizerAvailable() {
  try {
    return speech?.isRecognitionAvailable() ?? false;
  } catch {
    return false;
  }
}

const fitNote = (dropped: number) => (dropped ? ` ${dropped} characters did not fit the field limit and were not added.` : "");

/** Asks the host to clean a transcript. Returns why it could not, so the notice can say so. */
async function cleanup(connection: Connection, text: string, host: Promise<Me | null>): Promise<{ model: string; text: string } | { reason: string }> {
  const me = await host;
  if (!me) return { reason: "the host could not be reached" };
  if (!me.capabilities?.dictation) return { reason: NO_CLEANUP_HOST };
  if (me.role === "viewer") return { reason: "viewers cannot clean up dictation" };
  try {
    return await api<{ model: string; text: string }>(connection, "/dictation/cleanup", { method: "POST", body: { text }, timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof ApiError && error.code === "dictation-unavailable") return { reason: NO_CLEANUP_HOST };
    if (error instanceof ApiError && error.code === "dictation-failed") return { reason: "the cleanup model failed" };
    return { reason: "cleanup did not finish" };
  }
}

/**
 * Speech-to-text for one text field. Dictation appends to the field's latest text and never sends it;
 * the host cleans the transcript when it can, and the raw transcript goes in when it cannot.
 */
export function useDictation({ connection, value, onChange, maxLength, disabled = false }: {
  connection: Connection;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  disabled?: boolean;
}): Dictation {
  const [available] = useState(recognizerAvailable);
  const [self] = useState(() => ({}));
  // Leaving the screen stops its capture like a lock does.
  const focused = useIsFocused();
  const blocked = disabled || !focused;
  const [state, setState] = useState<DictationState>("idle");
  const [notice, setNotice] = useState<Notice | null>(null);
  const session = useRef<Session | null>(null);
  // Changes whenever capture or cleanup is abandoned, so a cleanup reply that arrives afterwards is dropped.
  const generation = useRef(0);
  const alive = useRef(false);
  // Read after awaits and from native events, which can outlive the render that scheduled them.
  // Updated at commit, so a cleanup reply never sees a lock that has already rendered as unlocked.
  const latest = useRef({ connection, value, onChange, maxLength, disabled: blocked });
  useLayoutEffect(() => {
    latest.current = { connection, value, onChange, maxLength, disabled: blocked };
  });

  const commit = useCallback((text: string) => {
    latest.current.value = text;
    latest.current.onChange(text);
  }, []);

  // Stops the recognizer and drops any cleanup still in flight; their later events and replies are ignored.
  const abandon = useCallback(() => {
    generation.current++;
    const current = session.current;
    if (!current) return;
    session.current = null;
    // Before the native start there is no `end` to wait for.
    if (!current.started) return release(self);
    drain(self);
    speech?.abort();
  }, [self]);

  const finish = useCallback(async () => {
    const current = session.current;
    // A lock that has rendered but not yet run its effect has already reset the control.
    if (!current || latest.current.disabled) return;
    session.current = null;
    const raw = (current.finals.length ? current.finals : [current.interim]).join(" ").trim();
    if (current.failure === "not-allowed") {
      setState("idle");
      return setNotice({ message: PERMISSION_COPY, kind: "error" });
    }
    if (!raw) {
      setState("idle");
      return setNotice(current.failure && current.failure !== "no-speech"
        ? { message: "Dictation stopped. Try again.", kind: "error" }
        : { message: "No speech heard.", kind: "warning" });
    }
    setState("cleaning");
    const token = generation.current;
    const cleaned = await cleanup(latest.current.connection, raw, current.host);
    if (!alive.current || generation.current !== token) return;
    setState("idle");
    if (latest.current.disabled) return setNotice({ message: LOCKED, kind: "warning" });

    const { value: before, maxLength: limit } = latest.current;
    if ("reason" in cleaned) {
      const { text, dropped } = appendDictation(before, raw, limit);
      commit(text);
      return setNotice({ message: `Added without cleanup: ${cleaned.reason}.${fitNote(dropped)}`, kind: "warning" });
    }
    const { text, dropped } = appendDictation(before, cleaned.text, limit);
    const original = appendDictation(before, raw, limit);
    commit(text);
    setNotice({
      message: `Cleaned up by ${cleaned.model}.${fitNote(dropped)}`,
      kind: dropped ? "warning" : "success",
      restore: {
        inserted: text,
        apply: () => {
          if (latest.current.disabled || latest.current.value !== text) return;
          commit(original.text);
          setNotice({ message: `Added the original transcript.${fitNote(original.dropped)}`, kind: original.dropped ? "warning" : "success" });
        },
      },
    });
  }, [commit]);

  const start = useCallback(async () => {
    if (!speech || session.current) return;
    if (recognizer.owner) {
      // This field's own abandoned capture is still draining; the mic is usable again in a moment.
      if (recognizer.owner !== self) setNotice({ message: BUSY, kind: "warning" });
      return;
    }
    recognizer.owner = self;
    const current: Session = { finals: [], interim: "", host: api<Me>(latest.current.connection, "/me").catch(() => null) };
    session.current = current;
    setNotice(null);
    setState("starting");
    const granted = await speech.requestPermissionsAsync().then(result => result.granted, () => false);
    if (session.current !== current) return;
    if (!granted) {
      session.current = null;
      release(self);
      setState("idle");
      return setNotice({ message: PERMISSION_COPY, kind: "error" });
    }
    try {
      speech.start({ lang: Intl.DateTimeFormat().resolvedOptions().locale, interimResults: true, continuous: true, addsPunctuation: true });
      current.started = true;
    } catch {
      session.current = null;
      release(self);
      setState("idle");
      setNotice({ message: "Dictation could not start. Try again.", kind: "error" });
    }
  }, [self]);

  const toggle = useCallback(() => {
    if (!speech || latest.current.disabled) return;
    if (state === "listening") speech.stop();
    else if (state === "idle") void start();
  }, [state, start]);

  useEffect(() => {
    if (!speech) return;
    alive.current = true;
    // Events belong to the field that owns the recognizer, and not to a capture it already abandoned.
    const mine = () => recognizer.owner === self && !recognizer.drain;
    const subscriptions = [
      speech.addListener("start", () => {
        if (mine() && session.current) setState("listening");
      }),
      speech.addListener("result", event => {
        const current = session.current;
        const transcript = event.results[0]?.transcript.trim();
        if (!mine() || !current || !transcript) return;
        if (event.isFinal) {
          current.finals.push(transcript);
          current.interim = "";
        } else {
          current.interim = transcript;
        }
      }),
      speech.addListener("error", event => {
        if (!mine() || !session.current) return;
        session.current.failure = event.error;
        void finish();
      }),
      speech.addListener("end", () => {
        if (!mine()) return;
        release(self);
        void finish();
      }),
    ];
    return () => {
      subscriptions.forEach(subscription => subscription.remove());
      alive.current = false;
      abandon();
      // An error already finished the capture but its native `end` has not arrived, and this listener is gone.
      if (recognizer.owner === self) drain(self);
    };
  }, [abandon, finish, self]);

  // A send, a pending retry, a status change, or leaving the screen can lock the field while dictation
  // runs. The render that locks it resets the control, and the effect stops the recognizer and any cleanup in flight.
  const [locked, setLocked] = useState(blocked);
  if (locked !== blocked) {
    setLocked(blocked);
    if (blocked && state !== "idle") {
      setState("idle");
      setNotice({ message: disabled ? LOCKED : LEFT, kind: "warning" });
    }
  }
  useEffect(() => {
    if (blocked) abandon();
  }, [blocked, abandon]);

  const dismiss = useCallback(() => setNotice(null), []);
  // "Use original" disappears while the field is locked and as soon as the person edits it after dictation.
  const shown: DictationMessage | null = notice && {
    message: notice.message,
    kind: notice.kind,
    ...(notice.restore && !blocked && notice.restore.inserted === value ? { useOriginal: notice.restore.apply } : {}),
  };
  return { available, state, toggle, notice: shown, dismiss };
}
