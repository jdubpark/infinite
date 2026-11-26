import { BoardHome } from "../../apps/mobile/src/features/board/BoardHome";
import { PUSH_ROTATION_RETRY_DELAYS_MS, getPushStates, unregisterPush } from "../../apps/mobile/src/push/register";
import { pushTestControl, renderHook, setSharedMachine, type NodeElement } from "./mobile-board-push-native";

export function mountBoardHome() {
  return renderHook(() => BoardHome() as unknown as NodeElement);
}

export { PUSH_ROTATION_RETRY_DELAYS_MS, getPushStates, pushTestControl, setSharedMachine, unregisterPush };
