import { usePoll } from "../../apps/mobile/src/api/usePoll";
import { useLive } from "../../apps/mobile/src/api/useLive";
import { monitor, renderHook } from "./mobile-focus-native";

const connection = { url: "http://127.0.0.1", token: "test" };

export function mount() {
  return renderHook(() => {
    const poll = usePoll(() => monitor.poll(), 40, []);
    const live = useLive(connection, {
      topics: ["sessions"], intervalMs: 40, deps: [],
      load: () => monitor.load(),
      select: () => undefined,
    });
    return { poll, live };
  });
}

export { monitor, setFocused } from "./mobile-focus-native";
