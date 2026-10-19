import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { StatusKind } from "../status";
import { theme } from "../theme";

/**
 * Line icons drawn from views, so they need no font or native module and stay crisp at any
 * density. Each sits in a `size` square; pair an icon-only control with an accessibility label.
 */
export type GlyphName =
  | "back" | "forward" | "down" | "up" | "plus" | "close" | "check" | "search" | "terminal"
  | "more" | "send" | "people" | "target" | "stack" | "pause" | "play" | "dot" | "chart";

export function Glyph({ name, size = 18, color = theme.colors.ink }: { name: GlyphName; size?: number; color?: string }) {
  const w = Math.max(1.6, size / 11);
  const box: ViewStyle = { width: size, height: size, alignItems: "center", justifyContent: "center" };
  const at = (style: ViewStyle): ViewStyle => ({ position: "absolute", ...style });
  switch (name) {
    case "back": case "forward": case "down": case "up": {
      const arm = size * 0.42;
      const turn = { forward: "45deg", down: "135deg", back: "225deg", up: "-45deg" }[name];
      const shift = { forward: [-size * 0.08, 0], back: [size * 0.08, 0], down: [0, -size * 0.08], up: [0, size * 0.08] }[name];
      return <View style={box}><View style={{ width: arm, height: arm, borderTopWidth: w, borderRightWidth: w, borderColor: color, borderRadius: 1,
        transform: [{ translateX: shift[0]! }, { translateY: shift[1]! }, { rotate: turn }] }} /></View>;
    }
    case "plus": case "close":
      return <View style={[box, name === "close" && { transform: [{ rotate: "45deg" }] }]}>
        <View style={at({ width: size * 0.72, height: w, borderRadius: w, backgroundColor: color })} />
        <View style={at({ width: w, height: size * 0.72, borderRadius: w, backgroundColor: color })} />
      </View>;
    case "check":
      return <View style={box}><View style={{ width: size * 0.3, height: size * 0.56, borderBottomWidth: w, borderRightWidth: w, borderColor: color,
        transform: [{ translateY: -size * 0.06 }, { rotate: "45deg" }] }} /></View>;
    case "search":
      return <View style={box}>
        <View style={at({ left: size * 0.12, top: size * 0.12, width: size * 0.56, height: size * 0.56, borderRadius: size, borderWidth: w, borderColor: color })} />
        <View style={at({ left: size * 0.6, top: size * 0.7, width: size * 0.34, height: w, borderRadius: w, backgroundColor: color, transform: [{ rotate: "45deg" }] })} />
      </View>;
    case "terminal":
      return <View style={box}><View style={{ width: size, height: size * 0.82, borderRadius: size * 0.2, borderWidth: w, borderColor: color, justifyContent: "center", paddingLeft: size * 0.12 }}>
        <Text style={{ fontFamily: theme.mono, fontWeight: "700", fontSize: size * 0.42, lineHeight: size * 0.5, color, includeFontPadding: false }}>{">_"}</Text>
      </View></View>;
    case "more":
      return <View style={[box, { flexDirection: "row", gap: size * 0.12 }]}>
        {[0, 1, 2].map(index => <View key={index} style={{ width: size * 0.17, height: size * 0.17, borderRadius: size, backgroundColor: color }} />)}
      </View>;
    case "send":
      return <View style={box}>
        <View style={at({ top: size * 0.2, width: w, height: size * 0.62, borderRadius: w, backgroundColor: color })} />
        <View style={at({ top: size * 0.22, width: size * 0.4, height: size * 0.4, borderTopWidth: w, borderLeftWidth: w, borderColor: color, transform: [{ rotate: "45deg" }] })} />
      </View>;
    case "people":
      return <View style={box}>
        <Person size={size * 0.72} color={color} w={w} style={at({ left: 0, top: size * 0.16 })} />
        <Person size={size * 0.72} color={color} w={w} style={at({ right: 0, top: size * 0.06 })} />
      </View>;
    case "target":
      return <View style={box}>
        <View style={at({ width: size * 0.92, height: size * 0.92, borderRadius: size, borderWidth: w, borderColor: color })} />
        <View style={at({ width: size * 0.5, height: size * 0.5, borderRadius: size, borderWidth: w, borderColor: color })} />
        <View style={at({ width: size * 0.16, height: size * 0.16, borderRadius: size, backgroundColor: color })} />
      </View>;
    case "stack":
      return <View style={box}>
        <View style={at({ left: size * 0.26, top: size * 0.06, width: size * 0.68, height: size * 0.6, borderRadius: size * 0.16, borderWidth: w, borderColor: color })} />
        <View style={at({ left: size * 0.06, top: size * 0.3, width: size * 0.68, height: size * 0.6, borderRadius: size * 0.16, borderWidth: w, borderColor: color, backgroundColor: theme.colors.paper })} />
      </View>;
    case "pause":
      return <View style={[box, { flexDirection: "row", gap: size * 0.18 }]}>
        <View style={{ width: w * 1.2, height: size * 0.6, borderRadius: w, backgroundColor: color }} />
        <View style={{ width: w * 1.2, height: size * 0.6, borderRadius: w, backgroundColor: color }} />
      </View>;
    case "play":
      return <View style={box}><View style={{ width: 0, height: 0, marginLeft: size * 0.12, borderLeftWidth: size * 0.5, borderLeftColor: color,
        borderTopWidth: size * 0.32, borderTopColor: "transparent", borderBottomWidth: size * 0.32, borderBottomColor: "transparent" }} /></View>;
    case "dot":
      return <View style={box}><View style={{ width: size * 0.42, height: size * 0.42, borderRadius: size, backgroundColor: color }} /></View>;
    case "chart": {
      const barWidth = w * 1.4, gap = size * 0.14;
      return <View style={[box, { flexDirection: "row", alignItems: "flex-end", gap }]}>
        {[0.45, 0.8, 0.6].map((height, index) => <View key={index} style={{ width: barWidth, height: size * height, borderRadius: w, backgroundColor: color }} />)}
      </View>;
    }
  }
}

function Person({ size, color, w, style }: { size: number; color: string; w: number; style: ViewStyle }) {
  return <View style={[{ width: size, height: size, alignItems: "center" }, style]}>
    <View style={{ width: size * 0.46, height: size * 0.46, borderRadius: size, borderWidth: w, borderColor: color, backgroundColor: theme.colors.paper }} />
    <View style={{ marginTop: size * 0.06, width: size * 0.86, height: size * 0.42, borderTopLeftRadius: size, borderTopRightRadius: size,
      borderWidth: w, borderBottomWidth: 0, borderColor: color, backgroundColor: theme.colors.paper }} />
  </View>;
}

/**
 * Linear-style work states. `progress` fills the ring by quarters; the label beside the icon
 * still carries the meaning (DESIGN.md: state with words).
 */
const RING: Record<StatusKind, string> = {
  backlog: theme.colors.placeholder, todo: theme.colors.placeholder, progress: theme.colors.running,
  review: theme.colors.forest, done: theme.colors.forest, attention: theme.colors.warningInk,
  paused: theme.colors.warningInk, blocked: theme.colors.error, stopped: theme.colors.placeholder,
  cancelled: theme.colors.placeholder, error: theme.colors.error,
};

export function StatusIcon({ kind, fraction = 0.5, size = 16 }: { kind: StatusKind; fraction?: number; size?: number }) {
  const color = RING[kind];
  const ring = Math.max(1.5, size / 10);
  const filled = kind === "done" || kind === "attention" || kind === "blocked" || kind === "cancelled";
  const frame: ViewStyle = {
    width: size, height: size, borderRadius: size, alignItems: "center", justifyContent: "center",
    borderWidth: ring, borderColor: color, backgroundColor: filled ? color : "transparent",
    borderStyle: kind === "backlog" ? "dashed" : "solid",
  };
  const mark = (text: string, tint: string) => <Text style={[st.mark, { fontSize: size * 0.62, lineHeight: size * 0.9, color: tint }]}>{text}</Text>;
  return <View style={frame}>
    {kind === "progress" ? <Quarters size={size - ring * 4} color={color} fraction={fraction} />
      : kind === "done" ? <Glyph name="check" size={size * 0.62} color={theme.colors.white} />
        : kind === "review" ? <Glyph name="check" size={size * 0.56} color={color} />
          : kind === "cancelled" ? <Glyph name="close" size={size * 0.5} color={theme.colors.white} />
            : kind === "attention" ? mark("?", theme.colors.white)
              : kind === "blocked" ? mark("!", theme.colors.white)
                : kind === "error" ? mark("!", color)
                  : kind === "paused" ? <Glyph name="pause" size={size * 0.5} color={color} />
                    : kind === "stopped" ? <View style={{ width: size * 0.32, height: size * 0.32, borderRadius: 1.5, backgroundColor: color }} /> : null}
  </View>;
}

/** A pie in quarter steps, clockwise from twelve o'clock; any started work shows one quarter. */
function Quarters({ size, color, fraction }: { size: number; color: string; fraction: number }) {
  const count = fraction <= 0 ? 0 : Math.min(4, Math.max(1, Math.round(fraction * 4)));
  const half = size / 2;
  const spots = [{ left: half, top: 0 }, { left: half, top: half }, { left: 0, top: half }, { left: 0, top: 0 }];
  return <View style={{ width: size, height: size, borderRadius: size, overflow: "hidden" }}>
    {spots.slice(0, count).map((spot, index) => <View key={index} style={{ position: "absolute", width: half, height: half, backgroundColor: color, ...spot }} />)}
  </View>;
}

const st = StyleSheet.create({
  mark: { fontWeight: "800", textAlign: "center", includeFontPadding: false },
});
