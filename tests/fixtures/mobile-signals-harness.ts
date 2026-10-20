import { useSignals } from "../../apps/mobile/src/features/session/useSignals";
import { loadCaptured } from "./mobile-signals-native";

export function loadSignals() {
  useSignals({ url: "http://127.0.0.1", token: "test" }, "session-id");
  return loadCaptured();
}

export { signalRead } from "./mobile-signals-native";
