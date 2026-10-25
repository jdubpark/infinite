import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ChangeKind, ComponentChange, FileChangeKind } from "@infinite/remote";
import { Button } from "../../../components/Button";
import { Chip } from "../../../components/Glass";
import { Glyph } from "../../../components/Icon";
import { theme } from "../../../theme";
import { sumCounts } from "./format";
import { styles } from "./styles";

const CHANGE: Record<ChangeKind, { label: string; ink: string; surface: string }> = {
  added: { label: "Added", ink: theme.colors.forest, surface: theme.colors.secondarySurface },
  modified: { label: "Modified", ink: theme.colors.warningInk, surface: theme.colors.warningSurface },
  removed: { label: "Removed", ink: theme.colors.error, surface: theme.colors.secondarySurface },
};

const FILE_LETTER: Record<FileChangeKind, string> = { added: "A", modified: "M", removed: "D", renamed: "R" };

/** One card per component touched by the work, with its files one tap away. */
export function Components({ items, onOpenComponent }: { items: ComponentChange[]; onOpenComponent?: (componentId: string) => void }) {
  return <View style={styles.stack}>
    {items.map((item, index) => <ComponentCard key={`${item.repositoryId}/${item.path}/${index}`} item={item} onOpenComponent={onOpenComponent} />)}
  </View>;
}

function ComponentCard({ item, onOpenComponent }: { item: ComponentChange; onOpenComponent?: (componentId: string) => void }) {
  const [open, setOpen] = useState(false);
  const change = CHANGE[item.change];
  const added = sumCounts(item.files.map(file => file.added));
  const removed = sumCounts(item.files.map(file => file.removed));
  const componentId = item.componentId;
  return <View style={styles.card}>
    <View style={[styles.pill, { backgroundColor: change.surface }]}>
      <Text style={[styles.pillText, { color: change.ink }]}>{change.label}</Text>
    </View>
    <Text style={[styles.title, item.change === "removed" ? styles.struck : null]}>{item.name}</Text>
    <Text selectable style={styles.mono}>{item.path}</Text>
    <Text style={styles.meta}>{`${item.filesTotal} ${item.filesTotal === 1 ? "file" : "files"} · +${added} −${removed}`}</Text>
    {item.taskIds.length ? <View style={styles.row}>
      {item.taskIds.map(id => <Chip key={id} label={id} />)}
    </View> : null}
    {item.files.length ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`Files for ${item.name}`}
      onPress={() => setOpen(value => !value)} hitSlop={8} style={styles.disclosure}>
      <Glyph name={open ? "down" : "forward"} size={12} color={theme.colors.secondaryInk} />
      <Text style={styles.disclosureText}>Files</Text>
    </Pressable> : null}
    {open ? <View style={styles.stack}>
      {item.files.map(file => <View key={file.path} style={styles.fileRow}>
        <Text selectable numberOfLines={1} style={styles.filePath}>{file.path}</Text>
        <Text style={styles.fileLetter}>{FILE_LETTER[file.change]}</Text>
        <Text style={styles.fileCount}>{`+${file.added ?? "?"} −${file.removed ?? "?"}`}</Text>
      </View>)}
      {item.filesTotal > item.files.length ? <Text style={styles.meta}>{`and ${item.filesTotal - item.files.length} more`}</Text> : null}
    </View> : null}
    {componentId && onOpenComponent ? <View style={styles.row}>
      <Button compact secondary title="Open component" onPress={() => onOpenComponent(componentId)} />
    </View> : null}
  </View>;
}
