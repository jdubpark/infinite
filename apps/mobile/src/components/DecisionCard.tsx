import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Prompt } from "@infinite/attention";
import { theme } from "../theme";
import { Button } from "./Button";

export type DecisionStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "still-open" }
  | { kind: "error"; message: string; retry: boolean };

const READ_ONLY_TEXT = "This device key can view but not steer.";

/**
 * The pending dialog with its options in display order. Nothing is sent
 * until the person taps an option, "Send reply" or "Retry".
 */
export function DecisionCard({
  prompt,
  status,
  canAnswer,
  readOnly,
  gate,
  onAnswer,
  onRetry,
  onOpenTerminal,
}: {
  prompt: Prompt;
  status: DecisionStatus;
  /** Options and reply are enabled: permitted, online and running. */
  canAnswer: boolean;
  /** This key may not answer at all (viewer role or no answer capability). */
  readOnly: boolean;
  /** Why a permitted device cannot answer yet, such as not holding control. */
  gate?: string;
  onAnswer: (option?: number, text?: string) => void;
  onRetry: () => void;
  onOpenTerminal: () => void;
}) {
  const [reply, setReply] = useState("");
  const busy = status.kind === "sending" || status.kind === "sent";
  const enabled = canAnswer && !busy;
  const needsTerminal =
    prompt.multiSelect || !prompt.hash || prompt.options.length === 0;
  // Status sits right under the options, where the person just tapped.
  // Outcomes that outlive the prompt ("changed", refusals) are the Brief's notice.
  const statusLine = (
    <>
      {busy ? (
        <Text accessibilityLiveRegion="polite" style={s.status}>
          Sent, waiting for the dialog to close…
        </Text>
      ) : null}
      {status.kind === "still-open" ? (
        <Text accessibilityLiveRegion="polite" style={s.statusWarn}>
          The dialog is still open. Check the terminal.
        </Text>
      ) : null}
      {status.kind === "error" ? (
        <>
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={s.statusWarn}
          >
            {status.message}
          </Text>
          {status.retry ? (
            <Button title="Retry" disabled={!canAnswer} onPress={onRetry} />
          ) : null}
        </>
      ) : null}
    </>
  );
  return (
    <View style={s.card} accessibilityRole="summary">
      <Text style={s.kicker}>
        {prompt.kind === "question"
          ? "Question"
          : prompt.kind === "elicitation"
            ? "Input requested"
            : "Approval needed"}
        {prompt.source === "screen" ? " · detected from screen" : ""}
      </Text>
      <Text style={s.title}>{prompt.title}</Text>
      {prompt.detail ? (
        <Text selectable style={s.detail}>
          {prompt.detail}
        </Text>
      ) : null}
      {prompt.destructive ? (
        <Text style={s.destructive}>
          {`⚠ Destructive command (${prompt.destructive.pattern.replace(/-/g, " ")})`}
        </Text>
      ) : null}
      {needsTerminal ? (
        <>
          <Text style={s.hint}>
            {prompt.multiSelect
              ? "This question allows several answers."
              : "The dialog has not been read from the screen yet."}{" "}
            Open the terminal to answer.
          </Text>
          <Button title="Open terminal" secondary onPress={onOpenTerminal} />
          {statusLine}
        </>
      ) : (
        <View style={s.options}>
          {readOnly ? (
            <Text style={s.hint}>{READ_ONLY_TEXT}</Text>
          ) : gate ? (
            <Text style={s.hint}>{gate}</Text>
          ) : null}
          {prompt.options.map((o) => {
            const accept = o.role.startsWith("accept");
            const highlighted = o.index === prompt.highlighted;
            return (
              <Pressable
                key={o.index}
                accessibilityRole="button"
                accessibilityLabel={o.label}
                accessibilityHint={
                  highlighted ? "current terminal cursor" : undefined
                }
                accessibilityState={{ disabled: !enabled }}
                disabled={!enabled}
                onPress={() => onAnswer(o.index)}
                style={({ pressed }) => [
                  s.option,
                  accept && s.optionAccept,
                  highlighted && s.optionHighlighted,
                  (pressed || !enabled) && s.dim,
                ]}
              >
                <Text style={[s.optionText, accept && s.optionAcceptText]}>
                  {highlighted ? "❯ " : ""}
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
          {statusLine}
          {prompt.acceptsText && prompt.kind !== "yes-no" && !readOnly ? (
            <View style={s.reply}>
              <TextInput
                accessibilityLabel="Reply instead"
                multiline
                submitBehavior="blurAndSubmit"
                value={reply}
                onChangeText={setReply}
                editable={enabled}
                placeholder="Reply instead: tell it what to do differently…"
                placeholderTextColor={theme.colors.placeholder}
                style={s.replyInput}
                maxLength={32000}
              />
              <Button
                title="Send reply"
                disabled={!enabled || !reply.trim()}
                onPress={() => onAnswer(undefined, reply.trim())}
              />
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.warningSurface,
    borderRadius: theme.radius.panel,
    padding: 18,
    gap: 10,
  },
  kicker: { fontSize: 12, color: theme.colors.warningInk, fontWeight: "600" },
  title: { fontSize: 18, fontWeight: "600", color: theme.colors.ink },
  detail: {
    fontFamily: theme.mono,
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.screenInk,
    backgroundColor: theme.colors.paper,
    padding: 12,
    borderRadius: theme.radius.control,
  },
  destructive: { color: theme.colors.error, fontSize: 13, fontWeight: "600" },
  hint: { fontSize: 13, color: theme.colors.mutedInk, lineHeight: 20 },
  options: { gap: 8, marginTop: 4 },
  option: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.paper,
    borderWidth: 1,
    borderColor: theme.colors.rule,
  },
  optionAccept: {
    backgroundColor: theme.colors.secondarySurface,
    borderColor: theme.colors.secondarySurface,
  },
  optionHighlighted: { borderColor: theme.colors.forest },
  optionText: { fontSize: 14, lineHeight: 20, color: theme.colors.ink },
  optionAcceptText: { color: theme.colors.secondaryInk, fontWeight: "600" },
  dim: { opacity: 0.5 },
  reply: { gap: 8, marginTop: 6 },
  replyInput: {
    minHeight: 56,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: theme.colors.fieldRule,
    borderRadius: theme.radius.message,
    padding: 12,
    fontSize: 14,
    color: theme.colors.ink,
    backgroundColor: theme.colors.white,
  },
  status: { fontSize: 13, lineHeight: 19, color: theme.colors.mutedInk },
  statusWarn: { fontSize: 13, lineHeight: 19, color: theme.colors.warningInk },
});
