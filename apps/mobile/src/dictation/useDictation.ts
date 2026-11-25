import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { requireOptionalNativeModule } from "expo";
import { useIsFocused } from "expo-router";
import { ApiError, api, type Connection, type Me } from "../api/client";
import { appendDictation } from "./text";

type SpeechError = { error: "not-allowed" | "no-speech" | (string & {}); message: string };
type SpeechEvents = {
  start: () => void;
  result: (event: { isFinal: boolean; results: { transcript: string }[] }) => void;
  error: (event: SpeechError) => void;
  end: () => void;
};

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

type Notice = { message: string; kind: DictationMessage["kind"]; restore?: { inserted: string; apply: () => void } };
type Session = { finals: string[]; interim: string; failure?: SpeechError["error"]; host: Promise<Me | null>; started?: boolean };

const PERMISSION_COPY = "Allow microphone and speech recognition access in Settings to dictate.";
const LOCKED = "Dictation stopped because the field was locked. Nothing was added.";
const LEFT = "Dictation stopped because you left this screen. Nothing was added.";
const BUSY = "Dictation is already running in another field. Stop it there first.";
const STOPPING = "Dictation is still stopping. Try again in a moment.";

const recognizer: { owner: object | null; drain?: { remove(): void } } = { owner: null };

function release(owner: object) {
  if (recognizer.owner !== owner) return;
  recognizer.owner = null;
  recognizer.drain?.remove();
  recognizer.drain = undefined;
}

function drain(owner: object) {
  if (!speech || recognizer.owner !== owner || recognizer.drain) return;
  recognizer.drain = speech.addListener("end", () => release(owner));
}
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

export function useDictation({ connection, value, onChange, maxLength, disabled = false }: {
  connection: Connection;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  disabled?: boolean;
}): Dictation {
  const [available] = useState(recognizerAvailable);
  const [self] = useState(() => ({}));
  const focused = useIsFocused();
  const blocked = disabled || !focused;
  const [state, setState] = useState<DictationState>("idle");
  const [notice, setNotice] = useState<Notice | null>(null);
  const session = useRef<Session | null>(null);
  const generation = useRef(0);
  const alive = useRef(false);
  const latest = useRef({ connection, value, onChange, maxLength, disabled: blocked });
  useLayoutEffect(() => {
    latest.current = { connection, value, onChange, maxLength, disabled: blocked };
  });

  const commit = useCallback((text: string) => {
    latest.current.value = text;
    latest.current.onChange(text);
  }, []);

  const abandon = useCallback(() => {
    generation.current++;
    const current = session.current;
    if (!current) return;
    session.current = null;
    if (!current.started) return release(self);
    drain(self);
    speech?.abort();
  }, [self]);

  const finish = useCallback(async () => {
    const current = session.current;
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
      setNotice({ message: recognizer.drain || recognizer.owner === self ? STOPPING : BUSY, kind: "warning" });
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
    if (!speech || !focused) return;
    alive.current = true;
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
      if (recognizer.owner === self) drain(self);
    };
  }, [abandon, finish, focused, self]);

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
  const shown: DictationMessage | null = notice && {
    message: notice.message,
    kind: notice.kind,
    ...(notice.restore && !blocked && notice.restore.inserted === value ? { useOriginal: notice.restore.apply } : {}),
  };
  return { available, state, toggle, notice: shown, dismiss };
}
