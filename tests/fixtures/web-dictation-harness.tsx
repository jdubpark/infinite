// One dictation field built from the web client's real hook and controls. The recognizer and the
// host's cleanup route are stand-ins that tests/web-dictation-lifecycle.test.ts drives through `window.dictation`.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiContext, type Api, type Me } from "../../apps/web/src/api";
import { DictationNotice, MicButton, useDictation } from "../../apps/web/src/dictation";

type Result = { isFinal: boolean; 0: { transcript: string } };
type Cleanup = { text: string; resolve: (value: { model: string; text: string }) => void; reject: (error: Error) => void };

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((event: { resultIndex: number; results: Result[] }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  aborted = false;
  private readonly results: Result[] = [];
  start() {
    control.recognizers.push(this);
    setTimeout(() => this.onstart?.());
  }
  stop() {
    setTimeout(() => this.onend?.());
  }
  // Browsers report an aborted recognizer as an "aborted" error followed by the end event.
  abort() {
    this.aborted = true;
    setTimeout(() => { this.onerror?.({ error: "aborted" }); this.onend?.(); });
  }
  say(transcript: string) {
    this.results.push({ isFinal: true, 0: { transcript } });
    this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
  }
}

const control = { recognizers: [] as FakeRecognition[], cleanups: [] as Cleanup[] };
Object.assign(window, { dictation: control, SpeechRecognition: FakeRecognition });

const cleanupApi = ((path: string, body?: { text: string }) => path === "/dictation/cleanup" && body
  ? new Promise((resolve, reject) => control.cleanups.push({ text: body.text, resolve, reject }))
  : Promise.reject(new Error(`Unexpected request: ${path}`))) as unknown as Api;
const me = { role: "owner", capabilities: { signals: true, answer: true, push: false, dictation: { model: "test-cleanup" } }, providers: [], projects: [] } as unknown as Me;

function Field() {
  const [value, setValue] = useState("Draft");
  const [locked, setLocked] = useState(false);
  const dictation = useDictation({ me, value, onChange: setValue, maxLength: 200, disabled: locked });
  return <form>
    <textarea aria-label="Field" value={value} disabled={locked} onChange={event => setValue(event.target.value)} />
    <MicButton dictation={dictation} />
    <button type="button" onClick={() => setLocked(current => !current)}>{locked ? "Unlock field" : "Lock field"}</button>
    <DictationNotice dictation={dictation} />
  </form>;
}

createRoot(document.getElementById("root")!).render(<ApiContext.Provider value={cleanupApi}><Field /></ApiContext.Provider>);
