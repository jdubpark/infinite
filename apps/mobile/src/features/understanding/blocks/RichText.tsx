import { Linking, ScrollView, Text, View } from "react-native";
import type { Basis, Inline, RichNode } from "@infinite/remote";
import { BasisLabel } from "./BasisLabel";
import { styles } from "./styles";

/** Opens https links only; anything else stays as plain text. */
export function safeOpen(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) void Linking.openURL(parsed.toString());
  } catch {
    /* malformed links remain text-only */
  }
}

const HEADING_SIZE = { 1: 20, 2: 17, 3: 15, 4: 14 } as const;

/** Shared-parser rich text rendered with native Text runs. `basis` labels the whole passage. */
export function RichText({ nodes, basis, compact = false }: { nodes: RichNode[]; basis?: Basis; compact?: boolean }) {
  return <View style={styles.stack}>
    {basis ? <BasisLabel basis={basis} /> : null}
    {nodes.map((node, index) => <NodeView key={index} node={node} compact={compact} />)}
  </View>;
}

function NodeView({ node, compact }: { node: RichNode; compact: boolean }) {
  switch (node.type) {
    case "heading":
      return <Text style={[styles.heading, { fontSize: HEADING_SIZE[node.level] }]}>{inlines(node.inlines)}</Text>;
    case "paragraph":
      return <Text style={compact ? styles.paragraphCompact : styles.paragraph}>{inlines(node.inlines)}</Text>;
    case "list":
      return <ListView items={node.items} ordered={node.ordered} start={node.start} compact={compact} />;
    case "code":
      return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.panel} contentContainerStyle={styles.panelContent}>
        <Text selectable style={styles.code}>{node.text}</Text>
      </ScrollView>;
    case "quote":
      return <View style={styles.quote}>
        {node.children.map((child, index) => <NodeView key={index} node={child} compact={compact} />)}
      </View>;
    case "rule":
      return <View style={styles.hairline} />;
  }
}

function ListView({ items, ordered, start, compact }: { items: { inlines: Inline[]; children: RichNode[] }[]; ordered: boolean; start?: number; compact: boolean }) {
  const text = compact ? styles.paragraphCompact : styles.paragraph;
  return <View style={styles.list}>
    {items.map((item, index) => <View key={index} style={styles.listItem}>
      <View style={styles.marker}>
        <Text style={text}>{ordered ? `${(start ?? 1) + index}.` : "•"}</Text>
      </View>
      <View style={styles.listBody}>
        <Text style={text}>{inlines(item.inlines)}</Text>
        {item.children.length ? <View style={styles.nested}>
          {item.children.map((child, childIndex) => <NodeView key={childIndex} node={child} compact={compact} />)}
        </View> : null}
      </View>
    </View>)}
  </View>;
}

function inlines(list: Inline[]) {
  return list.map((inline, index) => {
    switch (inline.type) {
      case "text":
        return <Text key={index} style={[inline.bold ? styles.bold : null, inline.italic ? styles.italic : null]}>{inline.text}</Text>;
      case "code":
        return <Text key={index} style={styles.inlineCode}>{inline.text}</Text>;
      case "link":
        return <Text key={index} accessibilityRole="link" onPress={() => safeOpen(inline.url)} style={styles.inlineLink}>{inline.text}</Text>;
    }
  });
}
