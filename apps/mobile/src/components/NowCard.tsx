import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PROVIDER_NAMES, type Attention, type Provider } from "@infinite/attention";
import { theme } from "../theme";
import { Button } from "./Button";

const PREVIEW_CHARS = 280;

/** "under a minute", "3 min", "2 h 5 min" since `iso`. */
function elapsed(iso: string): string {
  const minutes = Math.floor(
    Math.max(0, Date.now() - new Date(iso).getTime()) / 60000,
  );
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * What the session is doing now, by attention state. A pending prompt is the
 * Brief's DecisionCard, so `needs-you` with a prompt renders nothing here.
 */
export function NowCard({
  attention,
  provider,
  exitCode,
  onOpenTerminal,
}: {
  attention: Attention;
  provider: Provider;
  exitCode?: number;
  onOpenTerminal: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  switch (attention.state) {
    case "needs-you":
      if (attention.prompt) return null;
      return (
        <Card heading="Needs you">
          <Text style={s.body}>
            {attention.now || `${PROVIDER_NAMES[provider]} needs you`}
          </Text>
          <Button title="Open terminal" secondary onPress={onOpenTerminal} />
        </Card>
      );
    case "working":
      return (
        <Card heading="Working">
          <Text style={s.body}>
            {attention.now || `${PROVIDER_NAMES[provider]} is working`}
          </Text>
          <Text style={s.meta}>for {elapsed(attention.since)}</Text>
        </Card>
      );
    case "turn-finished": {
      const message = attention.lastMessage?.trim() ?? "";
      const long = message.length > PREVIEW_CHARS;
      return (
        <Card heading="Finished a turn">
          <Text selectable style={s.body}>
            {!message
              ? "No closing message was recorded."
              : long && !expanded
                ? `${message.slice(0, PREVIEW_CHARS).trimEnd()}…`
                : message}
          </Text>
          {long ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded((value) => !value)}
              style={({ pressed }) => [s.toggle, pressed && s.pressed]}
            >
              <Text style={s.toggleText}>
                {expanded ? "Show less" : "Read more"}
              </Text>
            </Pressable>
          ) : null}
          <Text style={s.meta}>{elapsed(attention.since)} ago</Text>
        </Card>
      );
    }
    case "idle":
      return (
        <Card heading="Waiting for your direction.">
          <Text style={s.meta}>Idle for {elapsed(attention.since)}</Text>
        </Card>
      );
    case "exited":
      return (
        <Card heading="Process exited">
          {exitCode !== undefined ? (
            <Text style={s.body}>Exit code {exitCode}.</Text>
          ) : null}
        </Card>
      );
    case "unavailable":
      return (
        <Card heading="Unreachable">
          <Text style={s.body}>
            The host cannot reach this session. Your agent may still be
            running.
          </Text>
        </Card>
      );
    case "recording-error":
      return (
        <Card heading="Recording error">
          <Text style={s.body}>
            Recording failed. The process was suspended to protect the record.
          </Text>
        </Card>
      );
  }
}

function Card({
  heading,
  children,
}: {
  heading: string;
  children?: ReactNode;
}) {
  return (
    <View style={s.card} accessibilityRole="summary">
      <Text style={s.heading}>{heading}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.screenSurface,
    borderRadius: theme.radius.panel,
    padding: 18,
    gap: 8,
  },
  heading: { fontSize: 18, fontWeight: "600", color: theme.colors.ink },
  body: { fontSize: 15, lineHeight: 24, color: theme.colors.ink },
  meta: { fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
  toggle: { minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  pressed: { opacity: 0.6 },
  toggleText: { fontSize: 14, fontWeight: "600", color: theme.colors.forest },
});
