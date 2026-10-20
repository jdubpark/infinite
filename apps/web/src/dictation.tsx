import { useEffect, useRef, useState } from "react";
import { Mic, X } from "lucide-react";
import { useApi, type Me } from "./api";
import { appendDictation } from "./dictation-text";

type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechRecognitionEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type SpeechRecognitionErrorEvent = { error: string };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}
type DictationState = "idle" | "starting" | "listening" | "cleaning";
const LOCKED = "Dictation stopped because the field was locked. Nothing was added.";
type DictationNotice = { message: string; useOriginal?: () => void; postText?: string };
export type DictationController = {
  supported: boolean;
  /** The field is read-only; the mic follows it so capture never outlives editing. */
  disabled: boolean;
  state: DictationState;
  notice: DictationNotice | null;
  startOrStop: () => void;
  dismiss: () => void;
};

export function useDictation({ me, value, onChange, maxLength, disabled }: {
  me: Me; value: string; onChange: (value: string) => void; maxLength: number; disabled: boolean;
}): DictationController {
  const api = useApi();
  // Read after awaits and from recognizer events, which can outlive the render that started them.
  const valueRef = useRef(value);
  valueRef.current = value;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const generation = useRef(0);
  const failed = useRef(false);
  const [state, setState] = useState<DictationState>("idle");
  const [notice, setNotice] = useState<DictationNotice | null>(null);
  const supported = typeof window !== "undefined" && Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);

  // Ends capture and discards a cleanup reply still in flight; their later events and results are ignored.
  function cancel() {
    generation.current++;
    const active = recognition.current;
    recognition.current = null;
    active?.abort();
  }
  function stopLocked() {
    cancel();
    setState("idle");
    setNotice({ message: LOCKED });
  }
  useEffect(() => cancel, []);
  // A send, a pending retry, or a status change can lock the field while dictation runs.
  useEffect(() => {
    if (disabled && state !== "idle") stopLocked();
  }, [disabled, state]);

  function insert(raw: string, cleaned?: { model: string; text: string }, fallbackReason?: string) {
    // The lock can render before its effect runs, so check it here too.
    if (disabledRef.current) return stopLocked();
    const before = valueRef.current;
    const result = appendDictation(before, cleaned?.text ?? raw, maxLength);
    valueRef.current = result.text;
    onChange(result.text);
    const droppedText = result.dropped ? ` ${result.dropped} character${result.dropped === 1 ? "" : "s"} did not fit the limit.` : "";
    if (cleaned) {
      setNotice({
        message: `Cleaned up by ${cleaned.model}.${droppedText}`,
        postText: result.text,
        useOriginal: () => {
          if (disabledRef.current || valueRef.current !== result.text) return;
          const original = appendDictation(before, raw, maxLength);
          valueRef.current = original.text;
          onChange(original.text);
          setNotice({ message: `Original transcript inserted.${original.dropped ? ` ${original.dropped} character${original.dropped === 1 ? "" : "s"} did not fit the limit.` : ""}` });
        },
      });
    } else {
      setNotice({ message: `Added without cleanup${fallbackReason ? ` (${fallbackReason})` : ""}.${droppedText}` });
    }
  }

  async function finish(token: number, raw: string) {
    if (generation.current !== token) return;
    if (disabledRef.current) return stopLocked();
    if (!raw.trim()) { setState("idle"); setNotice({ message: "No speech heard." }); return; }
    const capability = me.capabilities?.dictation;
    if (!capability || me.role === "viewer") {
      setState("idle");
      insert(raw, undefined, "cleanup is not configured");
      return;
    }
    setState("cleaning");
    try {
      const cleaned = await api<{ model: string; text: string }>("/dictation/cleanup", { text: raw }, "POST", undefined, 28000);
      if (generation.current !== token) return;
      insert(raw, cleaned);
    } catch (error) {
      if (generation.current !== token) return;
      const reason = (error as Error).message || "cleanup failed";
      insert(raw, undefined, reason);
    } finally {
      if (generation.current === token) setState("idle");
    }
  }

  function startOrStop() {
    if (disabled || !supported || state === "cleaning") return;
    if (state === "starting" || state === "listening") { recognition.current?.stop(); return; }
    setNotice(null);
    failed.current = false;
    const Constructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Constructor) return;
    const instance = new Constructor();
    const token = ++generation.current;
    recognition.current = instance;
    const finalResults: string[] = [];
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = navigator.language;
    instance.onstart = () => { if (generation.current === token) setState("listening"); };
    instance.onresult = event => {
      if (generation.current !== token) return;
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal) finalResults.push(result[0].transcript);
      }
    };
    instance.onerror = event => {
      if (generation.current !== token) return;
      failed.current = true;
      setState("idle");
      const message = event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "Allow microphone access to dictate."
        : "Speech recognition failed. Try again.";
      setNotice({ message });
    };
    instance.onend = () => {
      if (recognition.current === instance) recognition.current = null;
      if (generation.current !== token) return;
      setState("idle");
      if (!failed.current) void finish(token, finalResults.join(" "));
    };
    setState("starting");
    try { instance.start(); }
    catch { recognition.current = null; setState("idle"); setNotice({ message: "Speech recognition could not start." }); }
  }

  // "Use original" is offered only while the field is editable and still shows the cleaned text.
  const visibleNotice = notice?.useOriginal && (disabled || notice.postText !== value)
    ? { message: notice.message }
    : notice;
  return { supported, disabled, state, notice: visibleNotice, startOrStop, dismiss: () => setNotice(null) };
}

export function MicButton({ dictation }: { dictation: DictationController }) {
  if (!dictation.supported) return null;
  const listening = dictation.state === "starting" || dictation.state === "listening";
  const cleaning = dictation.state === "cleaning";
  return <button
    type="button"
    className={`icon-button dictation-mic${listening ? " is-listening" : ""}${cleaning ? " is-cleaning" : ""}`}
    aria-label={cleaning ? "Cleaning up dictation" : listening ? "Stop dictation" : "Dictate"}
    aria-pressed={listening}
    aria-busy={cleaning}
    disabled={dictation.disabled || cleaning}
    onClick={dictation.startOrStop}
  ><Mic size={19} aria-hidden="true" />{(listening || cleaning) && <span className="dictation-button-state">{cleaning ? "Cleaning" : "Listening"}</span>}</button>;
}

export function DictationNotice({ dictation }: { dictation: DictationController }) {
  if (!dictation.supported) return null;
  return <div className="dictation-notice-slot">{dictation.notice && <span className="dictation-notice" role="status"><span>{dictation.notice.message}</span>{dictation.notice.useOriginal && <button type="button" className="text-button" onClick={dictation.notice.useOriginal}>Use original</button>}<button type="button" className="dictation-dismiss" aria-label="Dismiss dictation notice" onClick={dictation.dismiss}><X size={14} /></button></span>}</div>;
}
