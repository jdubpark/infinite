import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { theme } from "../theme";
import { MicButton } from "../dictation/DictationControls";
import type { Dictation } from "../dictation/useDictation";
import { Button } from "./Button";
import { GlassButton } from "./Glass";

/**
 * Who may type into a session that enforces input control. `take` replaces the field with one
 * line naming the holder and the way to claim it; `held` keeps the field and adds a release.
 */
export type ComposerAccess =
  | { kind: "take"; holder?: string; busy: boolean; disabled?: boolean; onTake: () => void }
  | { kind: "held"; onRelease: () => void };

/** Past this measured height the field holds more than one line. One line is 21 units tall. */
const ONE_LINE = 32;
/** Text this short fits the narrow row beside the controls again, so the wide layout can let go. */
const SHORT_TEXT = 24;

/** The claim line: who holds control and the way to take it. */
function TakeStrip({ access }: { access: Extract<ComposerAccess, { kind: "take" }> }) {
  return (
    <View style={s.strip}>
      <View style={s.dot} />
      <Text style={s.stripText} numberOfLines={1}>{access.holder ? `${access.holder} has control` : "Monitoring"}</Text>
      <Button compact busy={access.busy} title={access.holder ? "Take over" : "Take control"} onPress={access.onTake} disabled={access.disabled || access.busy} />
    </View>
  );
}

/** The one-line reminder that this phone holds the lease, with its release. */
function HeldRow({ onRelease }: { onRelease: () => void }) {
  return (
    <View style={s.held}>
      <View style={[s.dot, s.dotOn]} />
      <Text style={s.heldText} numberOfLines={1}>You have control</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Release control" onPress={onRelease} hitSlop={10} style={({ pressed }) => pressed && s.dim}>
        <Text style={s.release}>Release</Text>
      </Pressable>
    </View>
  );
}

/**
 * The control dock on its own, for a session whose input goes elsewhere (a mission prompt is
 * answered from its card) but still needs this phone to hold the lease.
 */
export function ControlDock({ access, onLayout }: { access: ComposerAccess; onLayout?: (event: LayoutChangeEvent) => void }) {
  return (
    <View style={s.area} onLayout={onLayout}>
      <View style={s.box}>
        {access.kind === "take" ? <TakeStrip access={access} /> : <HeldRow onRelease={access.onRelease} />}
      </View>
    </View>
  );
}

/**
 * The docked text composer. The caller owns `text`, so a draft outlives the
 * screen. `pending` means the last send is uncertain: the text stays locked
 * and the button reads "Retry", which resends the same request. `blocked`
 * disables text and Send (not Interrupt) and says why, with
 * `blockedPlaceholder` in the empty field. `dictation` adds a mic beside the
 * send control, off whenever the text is read-only. `onInterrupt` adds a stop
 * key in the same row. A field that grows past one line moves its controls
 * under the text so the words keep the full width. `children` render under
 * the input row (the Terminal's key row).
 */
export function Composer({
  canSteer,
  busy,
  pending,
  blocked,
  blockedPlaceholder = "Paused while a prompt is open",
  text,
  onChangeText,
  onSend,
  onInterrupt,
  access,
  children,
  onLayout,
  dictation,
}: {
  canSteer: boolean;
  busy: boolean;
  pending: boolean;
  blocked?: string;
  blockedPlaceholder?: string;
  text: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onInterrupt?: () => void;
  access?: ComposerAccess;
  children?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  dictation?: Dictation;
}) {
  // Wrapping is measured only in the narrow row: once the field has the full width the same text
  // measures one line again, so the flag sticks until the text is short enough for the row. A draft
  // cleared from outside (a delivered send) is short too, so it falls back to the row on its own.
  const [wrapped, setWrapped] = useState(false);
  const tall = text.includes("\n") || (wrapped && text.length >= SHORT_TEXT);
  const change = (value: string) => {
    if (wrapped && value.length < SHORT_TEXT && !value.includes("\n")) setWrapped(false);
    onChangeText(value);
  };
  if (access?.kind === "take") {
    return (
      <View style={s.area} onLayout={onLayout}>
        <View style={s.box}><TakeStrip access={access} /></View>
      </View>
    );
  }
  const canType = canSteer && !blocked;
  // Drafts stay editable without control, so dictation does too; only a blocked, busy, or pending field locks.
  const editable = !blocked && !busy && !pending;
  const send = busy
    ? <View accessible accessibilityRole="progressbar" accessibilityLabel={pending ? "Retrying delivery" : "Sending"} style={s.busyButton}><ActivityIndicator color={theme.colors.forest} /></View>
    : pending
      ? <Button compact title="Retry" onPress={onSend} disabled={!canType || !text.trim()} />
      : <GlassButton primary glyph="send" size={36} label="Send" onPress={onSend} disabled={!canType || !text.trim()} />;
  return (
    <View style={s.area} onLayout={onLayout}>
      <View style={s.box}>
        {access?.kind === "held" ? <HeldRow onRelease={access.onRelease} /> : null}
        {blocked ? <Text style={s.hint}>{blocked}</Text> : null}
        {/* The field keeps one tree position across both layouts, so switching never remounts the focused input. */}
        <View style={tall ? s.column : s.row}>
          <TextInput
            accessibilityLabel="Message to agent"
            multiline
            value={text}
            onChangeText={change}
            onContentSizeChange={(event) => { if (!tall && event.nativeEvent.contentSize.height > ONE_LINE) setWrapped(true); }}
            editable={editable}
            placeholder={!canSteer ? "Reconnecting…" : blocked ? blockedPlaceholder : "Give this session a direction…"}
            placeholderTextColor={theme.colors.placeholder}
            style={[s.message, tall && s.messageTall]}
            textAlignVertical="top"
            maxLength={32000}
          />
          <View style={[s.controls, tall && s.controlsWide]}>
            {onInterrupt ? <GlassButton glyph="stop" size={36} label="Interrupt" onPress={onInterrupt} disabled={!canSteer || busy} /> : null}
            {dictation ? <MicButton dictation={dictation} size={36} disabled={!editable} /> : null}
            {tall ? <View style={s.fill} /> : null}
            {send}
          </View>
        </View>
      </View>
      {children ? <View style={s.keys}>{children}</View> : null}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  dim: { opacity: 0.6 },
  area: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
  },
  box: {
    padding: 5,
    borderRadius: 24,
    backgroundColor: theme.colors.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.glassRim,
    ...theme.lift,
  },
  strip: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 9, minHeight: 36 },
  stripText: { flex: 1, fontSize: 13, fontWeight: "600", color: theme.colors.ink },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.placeholder },
  dotOn: { backgroundColor: theme.colors.running },
  held: { flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 9, paddingRight: 8, paddingTop: 4, paddingBottom: 2 },
  heldText: { flex: 1, fontSize: 12, fontWeight: "600", color: theme.colors.secondaryInk },
  release: { fontSize: 12, fontWeight: "600", color: theme.colors.forest, paddingVertical: 4 },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.warningInk,
    paddingHorizontal: 9,
    paddingTop: 4,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  column: { flexDirection: "column" },
  controls: { flexDirection: "row", alignItems: "center", gap: 6 },
  controlsWide: { paddingTop: 4 },
  busyButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  message: {
    flex: 1,
    minHeight: 36,
    maxHeight: 168,
    paddingHorizontal: 10,
    paddingVertical: 0,
    marginVertical: 7,
    fontSize: 15,
    lineHeight: 21,
    color: theme.colors.ink,
  },
  messageTall: { flex: 0, marginTop: 9, marginBottom: 4 },
  keys: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingTop: 6,
  },
});
