import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { requireOptionalNativeModule } from "expo";
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
type Session = { finals: string[]; interim: string; failure?: SpeechError["error"]; host: Promise<Me | null> };

const PERMISSION_COPY = "Allow microphone and speech recognition access in Settings to dictate.";
const LOCKED = "Dictation stopped because the field was locked. Nothing was added.";
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
  const [state, setState] = useState<DictationState>("idle");
  const [notice, setNotice] = useState<Notice | null>(null);
  const session = useRef<Session | null>(null);
  // Changes whenever capture or cleanup is abandoned, so a cleanup reply that arrives afterwards is dropped.
  const generation = useRef(0);
  const alive = useRef(false);
  // Read after awaits and from native events, which can outlive the render that scheduled them.
  // Updated at commit, so a cleanup reply never sees a lock that has already rendered as unlocked.
  const latest = useRef({ connection, value, onChange, maxLength, disabled });
  useLayoutEffect(() => {
    latest.current = { connection, value, onChange, maxLength, disabled };
  });

  const commit = useCallback((text: string) => {
    latest.current.value = text;
    latest.current.onChange(text);
  }, []);

  // Stops the recognizer and drops any cleanup still in flight; their later events and replies are ignored.
  const abandon = useCallback(() => {
    generation.current++;
    if (!session.current) return;
    session.current = null;
    speech?.abort();
  }, []);

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
    const current: Session = { finals: [], interim: "", host: api<Me>(latest.current.connection, "/me").catch(() => null) };
    session.current = current;
    setNotice(null);
    setState("starting");
    const granted = await speech.requestPermissionsAsync().then(result => result.granted, () => false);
    if (session.current !== current) return;
    if (!granted) {
      session.current = null;
      setState("idle");
      return setNotice({ message: PERMISSION_COPY, kind: "error" });
    }
    try {
      speech.start({ lang: Intl.DateTimeFormat().resolvedOptions().locale, interimResults: true, continuous: true, addsPunctuation: true });
    } catch {
      session.current = null;
      setState("idle");
      setNotice({ message: "Dictation could not start. Try again.", kind: "error" });
    }
  }, []);

  const toggle = useCallback(() => {
    if (!speech || latest.current.disabled) return;
    if (state === "listening") speech.stop();
    else if (state === "idle") void start();
  }, [state, start]);

  useEffect(() => {
    if (!speech) return;
    alive.current = true;
    const subscriptions = [
      speech.addListener("start", () => {
        if (session.current) setState("listening");
      }),
      speech.addListener("result", event => {
        const current = session.current;
        const transcript = event.results[0]?.transcript.trim();
        if (!current || !transcript) return;
        if (event.isFinal) {
          current.finals.push(transcript);
          current.interim = "";
        } else {
          current.interim = transcript;
        }
      }),
      speech.addListener("error", event => {
        if (!session.current) return;
        session.current.failure = event.error;
        void finish();
      }),
      speech.addListener("end", () => {
        void finish();
      }),
    ];
    return () => {
      subscriptions.forEach(subscription => subscription.remove());
      alive.current = false;
      abandon();
    };
  }, [abandon, finish]);

  // A send, a pending retry, or a status change can lock the field while dictation runs. The render
  // that locks it resets the control, and the effect stops the recognizer and any cleanup in flight.
  const [locked, setLocked] = useState(disabled);
  if (locked !== disabled) {
    setLocked(disabled);
    if (disabled && state !== "idle") {
      setState("idle");
      setNotice({ message: LOCKED, kind: "warning" });
    }
  }
  useEffect(() => {
    if (disabled) abandon();
  }, [disabled, abandon]);

  const dismiss = useCallback(() => setNotice(null), []);
  // "Use original" disappears while the field is locked and as soon as the person edits it after dictation.
  const shown: DictationMessage | null = notice && {
    message: notice.message,
    kind: notice.kind,
    ...(notice.restore && !disabled && notice.restore.inserted === value ? { useOriginal: notice.restore.apply } : {}),
  };
  return { available, state, toggle, notice: shown, dismiss };
}
