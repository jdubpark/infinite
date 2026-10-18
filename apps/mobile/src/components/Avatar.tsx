import { StyleSheet, Text, View } from "react-native";
import { initials } from "../status";
import { theme } from "../theme";

/** Muted provider fills, as the web overview uses for provider initials; they identify, not theme. */
const TONES: Record<string, { fill: string; ink: string }> = {
  claude: { fill: "#efe2d3", ink: "#74461f" },
  codex: { fill: "#e0e5ea", ink: "#2e3c4a" },
  opencode: { fill: "#d9e9e1", ink: "#1f5a45" },
  grok: { fill: "#e5e2ec", ink: "#463c63" },
};
const NEUTRAL = { fill: theme.colors.secondarySurface, ink: theme.colors.secondaryInk };

/** An agent as an assignee: model or provider initials, with a live or waiting dot. */
export function Avatar({ label, provider, size = 24, state }: { label: string; provider?: string; size?: number; state?: "live" | "attention" }) {
  const tone = (provider && TONES[provider]) || NEUTRAL;
  const dot = Math.max(7, size * 0.34);
  return <View accessible accessibilityLabel={label} style={{ width: size, height: size }}>
    <View style={[s.face, { width: size, height: size, borderRadius: size, backgroundColor: tone.fill }]}>
      <Text style={[s.text, { color: tone.ink, fontSize: size * 0.42 }]}>{initials(label)}</Text>
    </View>
    {state ? <View style={[s.dot, { width: dot, height: dot, borderRadius: dot, backgroundColor: state === "live" ? theme.colors.running : theme.colors.warningInk }]} /> : null}
  </View>;
}

/** Overlapping assignees, newest work first; the rest collapse into a count. */
export function AvatarStack({ people, size = 22, max = 4 }: { people: { key: string; label: string; provider?: string; state?: "live" | "attention" }[]; size?: number; max?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return <View style={s.stack} accessible accessibilityLabel={`${people.length} ${people.length === 1 ? "agent" : "agents"}`}>
    {shown.map((person, index) => <View key={person.key} style={[s.ring, { borderRadius: size, marginLeft: index ? -size * 0.3 : 0, zIndex: max - index }]}>
      <Avatar label={person.label} provider={person.provider} size={size} state={person.state} />
    </View>)}
    {rest > 0 ? <Text style={s.more}>+{rest}</Text> : null}
  </View>;
}

const s = StyleSheet.create({
  face: { alignItems: "center", justifyContent: "center" },
  text: { fontWeight: "700", letterSpacing: -0.2, includeFontPadding: false },
  dot: { position: "absolute", right: -1, bottom: -1, borderWidth: 1.5, borderColor: theme.colors.paper },
  stack: { flexDirection: "row", alignItems: "center" },
  ring: { borderWidth: 1.5, borderColor: theme.colors.paper },
  more: { marginLeft: 4, fontSize: 11, fontWeight: "600", color: theme.colors.mutedInk },
});
