import { useDictation } from "../../apps/mobile/src/dictation/useDictation";
import { renderHook, speechListenerCounts } from "./mobile-focus-native";

export function mount() {
  return renderHook(() => useDictation({
    connection: { url: "http://127.0.0.1", token: "test" },
    value: "",
    onChange() {},
    maxLength: 200,
  }));
}

export { setFocused } from "./mobile-focus-native";
export { speechListenerCounts };
