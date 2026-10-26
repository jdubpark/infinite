import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, G, Line, Marker, Polyline, Rect, Text as SvgText } from "react-native-svg";
import { layoutGraph, type DiagramGraph } from "@infinite/remote";
import { theme } from "../../theme";

const MAX_LABEL = 22;
const clip = (label: string) => label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL)}…` : label;
const COLLAPSED_PREFIX = "collapsed:";

type DrawNode = DiagramGraph["nodes"][number];

/** Replaces every collapsed group with one summary node and re-points its edges. */
function collapse(graph: DiagramGraph, collapsed: ReadonlySet<string>): Pick<DiagramGraph, "direction" | "nodes" | "groups" | "edges"> {
  const owner = new Map<string, string>();
  for (const node of graph.nodes) if (node.group && collapsed.has(node.group)) owner.set(node.id, `${COLLAPSED_PREFIX}${node.group}`);
  const nodes: DrawNode[] = graph.nodes.filter(node => !owner.has(node.id));
  for (const group of graph.groups) {
    if (!collapsed.has(group.id)) continue;
    const count = graph.nodes.filter(node => node.group === group.id).length;
    nodes.push({ id: `${COLLAPSED_PREFIX}${group.id}`, label: `${group.label} · ${count}`, group: null, componentId: null });
  }
  const seen = new Set<string>();
  const edges = graph.edges.flatMap(edge => {
    const from = owner.get(edge.from) ?? edge.from, to = owner.get(edge.to) ?? edge.to;
    const key = `${from}\u0000${to}\u0000${edge.label ?? ""}`;
    if (from === to || seen.has(key)) return [];
    seen.add(key);
    return [{ ...edge, from, to }];
  });
  return { direction: graph.direction, nodes, groups: graph.groups.filter(group => !collapsed.has(group.id)), edges };
}

/** Draws one generated diagram as data with native SVG. Mermaid text is never interpreted as markup. */
export function DiagramView({ graph, onOpenComponent, collapsedGroupsAbove = 40 }: {
  graph: DiagramGraph; onOpenComponent?: (componentId: string) => void; collapsedGroupsAbove?: number;
}) {
  const startCollapsed = graph.nodes.length > collapsedGroupsAbove;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const collapsedIds = useMemo(
    () => new Set(startCollapsed ? graph.groups.map(group => group.id).filter(id => !expanded.has(id)) : []),
    [startCollapsed, graph.groups, expanded],
  );
  const drawn = useMemo(() => collapse(graph, collapsedIds), [graph, collapsedIds]);
  const layout = useMemo(
    () => layoutGraph(drawn),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layout depends on graph identity and size only.
    [graph.id, drawn.nodes.length, drawn.edges.length, drawn.groups.length, collapsedIds],
  );
  const nodeById = useMemo(() => new Map(drawn.nodes.map(node => [node.id, node])), [drawn.nodes]);

  if (graph.parseError) {
    return <View style={s.card}>
      <Text style={s.title}>{graph.title}</Text>
      <Text style={s.note}>This diagram could not be drawn.</Text>
      <Text selectable style={s.source}>{graph.sourceText}</Text>
    </View>;
  }

  const expand = (groupId: string) => setExpanded(current => new Set(current).add(groupId));
  return <View style={s.card} accessibilityLabel={`Diagram ${graph.title} with ${graph.nodes.length} parts and ${graph.edges.length} connections`}>
    <Text style={s.title}>{graph.title}</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator maximumZoomScale={3} minimumZoomScale={1} nestedScrollEnabled>
      <ScrollView showsVerticalScrollIndicator maximumZoomScale={3} minimumZoomScale={1} nestedScrollEnabled>
        <View style={{ width: layout.width, height: layout.height }}>
          <Svg width={layout.width} height={layout.height}>
            <Defs>
              <Marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <Polyline points="0,0 10,5 0,10" fill={theme.colors.mutedInk} />
              </Marker>
            </Defs>
            {layout.groups.map(group => <G key={group.id}>
              <Rect x={group.x} y={group.y} width={group.width} height={group.height} rx={theme.radius.card} fill={theme.colors.secondarySurface} stroke={theme.colors.fieldRule} strokeWidth={1} />
              <SvgText x={group.x + 8} y={group.y + 14} fontSize={11} fontWeight="700" fill={theme.colors.mutedInk}>{clip(group.label)}</SvgText>
            </G>)}
            {layout.edges.map((edge, index) => {
              if (edge.points.length < 2) return null;
              const mid = edge.points[Math.floor(edge.points.length / 2)]!;
              const last = edge.points.length - 1;
              return <G key={`${edge.from}>${edge.to}>${index}`}>
                {edge.points.slice(0, last - 1).map((point, i) => {
                  const next = edge.points[i + 1]!;
                  return <Line key={i} x1={point.x} y1={point.y} x2={next.x} y2={next.y} stroke={theme.colors.mutedInk} strokeWidth={1.25} strokeDasharray={edge.back ? "4 3" : undefined} />;
                })}
                <Line x1={edge.points[last - 1]!.x} y1={edge.points[last - 1]!.y} x2={edge.points[last]!.x} y2={edge.points[last]!.y} stroke={theme.colors.mutedInk} strokeWidth={1.25} strokeDasharray={edge.back ? "4 3" : undefined} markerEnd="url(#arrow)" />
                {edge.label ? <SvgText x={mid.x + 4} y={mid.y - 4} fontSize={10} fill={theme.colors.mutedInk}>{clip(edge.label)}</SvgText> : null}
              </G>;
            })}
            {layout.nodes.map(box => {
              const node = nodeById.get(box.id);
              if (!node) return null;
              const linked = Boolean(node.componentId);
              return <G key={box.id}>
                <Rect x={box.x} y={box.y} width={box.width} height={box.height} rx={theme.radius.card} fill={theme.colors.paper} stroke={linked ? theme.colors.forest : theme.colors.fieldRule} strokeWidth={linked ? 2 : 1} />
                <SvgText x={box.x + box.width / 2} y={box.y + box.height / 2 + 4} fontSize={12} textAnchor="middle" fill={theme.colors.ink}>{clip(node.label)}</SvgText>
              </G>;
            })}
          </Svg>
          {layout.nodes.map(box => {
            const node = nodeById.get(box.id);
            if (!node) return null;
            const groupId = box.id.startsWith(COLLAPSED_PREFIX) ? box.id.slice(COLLAPSED_PREFIX.length) : null;
            const open = node.componentId && onOpenComponent ? () => onOpenComponent(node.componentId!) : null;
            if (!groupId && !open) return null;
            return <Pressable key={box.id} accessibilityRole="button"
              accessibilityLabel={groupId ? `Expand group ${node.label}` : `Open component ${node.label}`}
              onPress={groupId ? () => expand(groupId) : open!}
              style={{ position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height }} />;
          })}
        </View>
      </ScrollView>
    </ScrollView>
  </View>;
}

const s = StyleSheet.create({
  card: { gap: 8, padding: 12, borderRadius: theme.radius.card, backgroundColor: theme.colors.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.fieldRule },
  title: { fontSize: 13, lineHeight: 18, fontWeight: "700", color: theme.colors.ink },
  note: { fontSize: 11, lineHeight: 16, color: theme.colors.mutedInk },
  source: { fontFamily: theme.mono, fontSize: 11, lineHeight: 16, color: theme.colors.ink },
});
