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
  backend,
  status,
  canAnswer,
  readOnly,
  gate,
  onAnswer,
  onRetry,
  onOpenTerminal,
}: {
  prompt: Prompt;
  backend?: "infinite" | "cmux";
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
  const feedText = backend === "cmux" && prompt.source === "protocol" && prompt.acceptsText && Boolean(prompt.hash);
  const needsTerminal = !feedText && (prompt.multiSelect || !prompt.hash || prompt.options.length === 0);
  const textReply = prompt.acceptsText && prompt.kind !== "yes-no" && (backend !== "cmux" || prompt.source === "protocol");
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
            <Button compact title="Retry" disabled={!canAnswer} onPress={onRetry} />
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
          {`Destructive command · ${prompt.destructive.pattern.replace(/-/g, " ")}`}
        </Text>
      ) : null}
      {needsTerminal ? (
        <>
          <Text style={s.hint}>
            {backend === "cmux" ? "Answer this prompt in native cmux on the machine." : prompt.multiSelect
              ? "This question allows several answers."
              : "The dialog has not been read from the screen yet."}
            {backend !== "cmux" ? " Open the terminal to answer." : ""}
          </Text>
          {backend !== "cmux" ? <Button compact glyph="terminal" title="Open terminal" secondary onPress={onOpenTerminal} /> : null}
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
          {textReply && !readOnly ? (
            <View style={s.reply}>
              <TextInput
                accessibilityLabel="Reply instead"
                multiline
                submitBehavior="newline"
                value={reply}
                onChangeText={setReply}
                editable={enabled}
                placeholder="Reply instead…"
                placeholderTextColor={theme.colors.placeholder}
                style={s.replyInput}
                maxLength={32000}
              />
              <Button
                compact
                title="Send reply"
                disabled={!enabled || !reply.trim()}
                onPress={() => onAnswer(undefined, reply.trim())}
              />
            </View>
          ) : null}
          {backend === "cmux" && prompt.acceptsText && !textReply ? <Text style={s.hint}>To reply with text, answer in native cmux on the machine.</Text> : null}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.warningSurface,
    borderRadius: theme.radius.card,
    padding: 14,
    gap: 8,
  },
  kicker: { fontSize: 12, color: theme.colors.warningInk, fontWeight: "700" },
  title: { fontSize: 15, lineHeight: 21, fontWeight: "600", color: theme.colors.ink },
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
  options: { gap: 6, marginTop: 2 },
  option: {
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 23,
    backgroundColor: theme.colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.fieldRule,
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
    borderRadius: theme.radius.card,
    padding: 12,
    fontSize: 14,
    color: theme.colors.ink,
    backgroundColor: theme.colors.white,
  },
  status: { fontSize: 13, lineHeight: 19, color: theme.colors.mutedInk },
  statusWarn: { fontSize: 13, lineHeight: 19, color: theme.colors.warningInk },
});
