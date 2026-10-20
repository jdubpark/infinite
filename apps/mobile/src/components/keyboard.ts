import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

/**
 * Bottom padding that keeps a docked control above the keyboard. Android runs edge-to-edge, so the
 * window never resizes for the keyboard. The reported height already excludes the navigation
 * inset the screen pads for, so it is applied as is. (`KeyboardAvoidingView` measures itself
 * below the safe-area top padding and came up short by that much.)
 */
export function useKeyboardPadding(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", (event) => setHeight(event.endCoordinates.height));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  return height;
}
