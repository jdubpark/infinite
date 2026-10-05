import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Moment } from "@infinite/attention";
import { theme } from "../theme";

const GLYPHS: Record<Moment["kind"], string> = {
  command: "$",
  edit: "✎",
  quiet: "…",
  decision: "?",
  turn: "◆",
  notice: "!",
};

/** One timeline entry; press to expand its recorded detail. */
export function MomentRow({ moment }: { moment: Moment }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen((v) => !v)}
      style={s.row}
    >
      <Text style={[s.glyph, moment.kind === "turn" && s.glyphTurn]}>
        {GLYPHS[moment.kind]}
      </Text>
      <View style={s.body}>
        <Text
          style={[
            s.title,
            moment.kind === "command" && s.mono,
            moment.status === "failed" && s.failed,
          ]}
          numberOfLines={open ? undefined : 2}
        >
          {moment.destructive ? <Text style={s.destructive}>⚠ </Text> : null}
          {moment.title}
          {moment.count && moment.count > 1 ? ` ×${moment.count}` : ""}
        </Text>
        {moment.detail ? (
          <Text style={s.detail} numberOfLines={open ? undefined : 1}>
            {moment.detail}
          </Text>
        ) : null}
        {moment.status === "running" ? (
          <Text style={s.running}>running</Text>
        ) : null}
        {open
          ? moment.expanded.map((x, i) => (
              <View key={i} style={s.expanded}>
                <Text style={s.expandedLabel}>{x.label}</Text>
                <Text selectable style={s.mono}>
                  {x.text}
                </Text>
              </View>
            ))
          : null}
        <Text style={s.time}>
          {new Date(moment.at).toLocaleTimeString()}
          {moment.source === "screen" ? " · detected from screen" : ""}
        </Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    minHeight: 48,
    flexDirection: "row",
    paddingVertical: theme.space.label,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.rule,
  },
  glyph: {
    width: 24,
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.mutedInk,
  },
  glyphTurn: { color: theme.colors.forest },
  body: { flex: 1, gap: 3 },
  title: { fontSize: 14, lineHeight: 20, color: theme.colors.ink },
  mono: {
    fontFamily: theme.mono,
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.ink,
  },
  failed: { color: theme.colors.warningInk },
  destructive: { color: theme.colors.error },
  detail: { fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
  running: { fontSize: 11, lineHeight: 17, color: theme.colors.running },
  expanded: { gap: 2, marginTop: 4 },
  expandedLabel: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
  time: { fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk },
});
