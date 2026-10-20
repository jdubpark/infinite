// Two phone dictation fields built from the app's real hook, rendered with React DOM. The native recognizer, screen
// focus, and host API come from ./mobile-dictation-native.ts; tests/mobile-dictation-lifecycle.test.ts drives them through `window.dictation`.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useDictation } from "../../apps/mobile/src/dictation/useDictation";
import { Focus, native } from "./mobile-dictation-native";

Object.assign(window, { dictation: native });
const connection = { url: "http://127.0.0.1", token: "test" };

function Field({ name }: { name: string }) {
  const [value, setValue] = useState("Draft");
  const [locked, setLocked] = useState(false);
  const dictation = useDictation({ connection, value, onChange: setValue, maxLength: 200, disabled: locked });
  const label = dictation.state === "listening" ? "Stop dictation" : dictation.state === "cleaning" ? "Cleaning up dictation" : "Dictate";
  return <section aria-label={name}>
    <textarea aria-label="Field" value={value} disabled={locked} onChange={event => setValue(event.target.value)} />
    <button type="button" disabled={locked || dictation.state === "starting" || dictation.state === "cleaning"} onClick={dictation.toggle}>{label}</button>
    <button type="button" onClick={() => setLocked(current => !current)}>{locked ? "Unlock field" : "Lock field"}</button>
    <p role="status">{dictation.notice?.message ?? ""}</p>
  </section>;
}

function Screen({ name }: { name: string }) {
  const [focused, setFocused] = useState(true);
  return <Focus.Provider value={focused}>
    <button type="button" onClick={() => setFocused(current => !current)}>{focused ? `Leave ${name}` : `Return to ${name}`}</button>
    <Field name={name} />
  </Focus.Provider>;
}

createRoot(document.getElementById("root")!).render(<><Screen name="Brief" /><Screen name="Terminal" /></>);
