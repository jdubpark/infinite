import { useSessionControl } from "../../apps/mobile/src/features/session/useSessionControl";
import { renderHook } from "./mobile-control-native";

const connection = { url: "http://127.0.0.1", token: "test" };
const remoteLease = { id: "remote-lease", label: "another device", expiresAt: Date.now() + 30_000 };

export function mount() {
  return renderHook(() => useSessionControl(connection, "session-one"));
}

export function observeRemoteHolder(control: ReturnType<typeof useSessionControl>) {
  control.observe({ status: "running", control: remoteLease } as never, control.generation());
}

export { setFocused } from "./mobile-control-native";
