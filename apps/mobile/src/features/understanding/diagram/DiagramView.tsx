import { useMemo, useRef, useState } from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { layoutDiagram, NODE_H, NODE_W, type Diagram, type DiagramLayout } from "@infinite/remote";
import { Button } from "../../../components/Button";
import { theme } from "../../../theme";
import { ArrowMarker, NodeShape } from "./shapes";
import { useCanvasGestures } from "./useCanvasGestures";

const DEFAULT_HEIGHT = 260;
const EDGE_OPACITY = 0.35;
const CONTROLS_HEIGHT = 42;
const DETAIL_HEIGHT = 48;

function describeDiagram(diagram: Diagram): string {
  const changes = diagram.nodes.reduce((counts, node) => {
    if (node.change) counts[node.change] += 1;
    return counts;
  }, { added: 0, modified: 0, removed: 0 });
  const title = diagram.title || "Change map";
  const count = diagram.sequence?.participants.length ?? diagram.nodes.length;
  const relationships = diagram.sequence?.messages.length ?? diagram.edges.length;
  return `${title}: ${count} components, ${changes.modified} modified, ${changes.added} added, ${changes.removed} removed; ${relationships} relationships`;
}

function curve(points: [number, number][]): string {
  const [start, controlA, controlB, end] = points;
  return `M${start![0]},${start![1]} C${controlA![0]},${controlA![1]} ${controlB![0]},${controlB![1]} ${end![0]},${end![1]}`;
}

function DiagramCanvas({ diagram, layout, height, onOpenComponent, onExpand }: {
  diagram: Diagram;
  layout: DiagramLayout;
  height: number;
  onOpenComponent?: (componentId: string) => void;
  onExpand?: () => void;
}) {
  const frameRef = useRef<View>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [frameOrigin, setFrameOrigin] = useState({ x: 0, y: 0 });
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const gestures = useCanvasGestures({
    contentWidth: layout.width,
    contentHeight: layout.height,
    frameWidth,
    frameHeight: height,
    frameOrigin,
  });
  const selectedParticipant = diagram.sequence?.participants.find(node => node.id === selectedId);
  const selected: Diagram["nodes"][number] | undefined = diagram.nodes.find(node => node.id === selectedId)
    ?? (selectedParticipant ? { id: selectedParticipant.id, label: selectedParticipant.label, shape: "box" as const } : undefined);
  const neighborIds = useMemo(() => {
    const neighbors = new Set<string>();
    if (selectedId) {
      neighbors.add(selectedId);
      const relationships = diagram.sequence?.messages ?? diagram.edges;
      for (const edge of relationships) {
        if (edge.from === selectedId) neighbors.add(edge.to);
        if (edge.to === selectedId) neighbors.add(edge.from);
      }
    }
    return neighbors;
  }, [diagram.edges, diagram.sequence?.messages, selectedId]);
  const measureFrameOrigin = () => frameRef.current?.measureInWindow((x, y) =>
    setFrameOrigin(current => current.x === x && current.y === y ? current : { x, y }));
  const onFrameLayout = (event: LayoutChangeEvent) => {
    setFrameWidth(event.nativeEvent.layout.width);
    measureFrameOrigin();
  };
  const accessibilityLabel = diagram.parseError
    ? `${describeDiagram(diagram)}. Diagram could not be parsed.`
    : describeDiagram(diagram);

  return <View style={s.diagramBody}>
    <View ref={frameRef} {...(!diagram.parseError ? gestures.panHandlers : {})} accessible accessibilityRole="image"
      accessibilityLabel={accessibilityLabel} accessibilityHint={diagram.parseError ? undefined : "Tap a node to show its change details."}
      onLayout={onFrameLayout} onTouchStart={measureFrameOrigin} style={[s.frame, { height }]}>
      {diagram.parseError ? <ScrollView style={s.sourceScroll} nestedScrollEnabled>
        <ScrollView horizontal nestedScrollEnabled contentContainerStyle={s.sourceContent}>
          <Text selectable style={s.sourceText}>{diagram.sourceText ?? ""}</Text>
        </ScrollView>
      </ScrollView> : frameWidth > 0 ? <>
        <Pressable accessible={false} onPress={() => setSelectedId(undefined)} style={s.backgroundTapTarget} />
        <Animated.View pointerEvents="box-none" style={[s.canvas, {
        width: layout.width,
        height: layout.height,
        transform: gestures.transform,
        transformOrigin: [0, 0, 0],
      }]}>
      <Svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <ArrowMarker />
        <Rect x={0} y={0} width={layout.width} height={layout.height} fill="transparent" onPress={() => setSelectedId(undefined)} />
        {diagram.sequence ? layout.lanes?.map(lane => {
          const header = layout.nodes.find(node => node.id === lane.id);
          const x = header?.x ?? lane.x;
          const y = header?.y ?? 16;
          const w = header?.w ?? NODE_W;
          const h = header?.h ?? NODE_H;
          const lines = header?.lines ?? [lane.label];
          const firstBaseline = h / 2 + 4 - (lines.length - 1) * 15 / 2;
          return <G key={`lane-${lane.id}`}>
            <Line x1={x + w / 2} y1={y + h + 16} x2={x + w / 2} y2={layout.height - 8}
              stroke={theme.colors.rule} strokeWidth={StyleSheet.hairlineWidth} />
            <G x={x} y={y} opacity={!selectedId || neighborIds.has(lane.id) ? 1 : EDGE_OPACITY} onPress={() => setSelectedId(lane.id)}>
              <NodeShape shape="box" w={w} h={h} fill={theme.colors.white} stroke={theme.colors.fieldRule} />
              {lines.map((line, index) => <SvgText key={`line-${index}`} x={w / 2} y={firstBaseline + index * 15}
                fill={theme.colors.ink} fontSize={12} textAnchor="middle">{line}</SvgText>)}
            </G>
          </G>;
        }) : null}
        {layout.groups.map(group => {
          const related = !selectedId || diagram.nodes.some(node => node.group === group.id && neighborIds.has(node.id));
          return <G key={`group-${group.id}`} opacity={related ? 1 : EDGE_OPACITY}>
            <Rect x={group.x} y={group.y} width={group.w} height={group.h} rx={10} fill="none" stroke={theme.colors.fieldRule}
              strokeWidth={1} strokeDasharray="5 4" />
            <SvgText x={group.x + 9} y={group.y + 14} fill={theme.colors.mutedInk} fontSize={11}>{group.label}</SvgText>
          </G>;
        })}
        {layout.edges.map((edge, index) => {
          const isRelated = !selectedId || edge.from === selectedId || edge.to === selectedId;
          const opacity = isRelated ? 1 : EDGE_OPACITY;
          const width = edge.style === "thick" ? 2.5 : 1.5;
          const message = diagram.sequence?.messages[index];
          const label = diagram.sequence ? `${index + 1}. ${message?.text ?? ""}` : edge.label;
          const labelWidth = label ? Math.max(26, Array.from(label).length * 6.5 + 12) : 0;
          const labelY = edge.labelAt[1] - (diagram.sequence ? 12 : 0);
          return <G key={`edge-${edge.from}-${edge.to}-${index}`} opacity={opacity}>
            <Path d={curve(edge.points)} fill="none" stroke={theme.colors.forest} strokeWidth={width}
              strokeDasharray={edge.style === "dashed" ? "6 4" : undefined} markerEnd="url(#arrow)" />
            {label ? <G>
              <Rect x={edge.labelAt[0] - labelWidth / 2} y={labelY - 10} width={labelWidth} height={20} rx={8} fill={theme.colors.paper} />
              <SvgText x={edge.labelAt[0]} y={labelY + 4} fill={theme.colors.secondaryInk} fontSize={10} textAnchor="middle">{label}</SvgText>
            </G> : null}
          </G>;
        })}
        {layout.nodes.map(position => {
          if (diagram.sequence?.participants.some(participant => participant.id === position.id)) return null;
          const participant = diagram.sequence?.participants.find(item => item.id === position.id);
          const node = diagram.nodes.find(item => item.id === position.id)
            ?? (participant ? { id: participant.id, label: participant.label, shape: "box" as const } : undefined);
          if (!node) return null;
          const dimmed = Boolean(selectedId) && !neighborIds.has(node.id);
          const change = node.change;
          const fill = change === "added" ? theme.colors.secondarySurface
            : change === "modified" ? theme.colors.warningSurface
              : change === "removed" ? theme.colors.rule : theme.colors.white;
          const stroke = change === "added" ? theme.colors.forest
            : change === "modified" ? theme.colors.warningInk
              : change === "removed" ? theme.colors.error : theme.colors.fieldRule;
          const lineHeight = 15;
          const firstBaseline = position.h / 2 + 4 - (position.lines.length - 1) * lineHeight / 2;
          return <G key={`node-${node.id}`} x={position.x} y={position.y} opacity={dimmed ? EDGE_OPACITY : 1} onPress={() => setSelectedId(node.id)}>
            <NodeShape shape={node.shape} w={position.w} h={position.h} fill={fill} stroke={stroke} dashed={change === "removed"} />
            {position.lines.map((line, index) => <SvgText key={`line-${index}`} x={position.w / 2} y={firstBaseline + index * lineHeight}
              fill={theme.colors.ink} fontSize={12} textAnchor="middle" textDecoration={change === "removed" ? "line-through" : "none"}>{line}</SvgText>)}
          </G>;
        })}
      </Svg>
        </Animated.View>
      </> : null}
    </View>
    {diagram.parseError ? <Text style={s.parseError}>{diagram.parseError}</Text> : <View style={s.controls}>
      <Button title="Fit" onPress={gestures.reset} secondary compact />
      {onExpand ? <Button title="Expand" onPress={onExpand} secondary compact /> : null}
    </View>}
    {selected ? <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`${selected.label}${selected.change ? `, ${selected.change}` : ""}`} style={s.detail}>
      <View style={s.detailCopy}>
        <Text numberOfLines={1} style={s.detailLabel}>{selected.label}</Text>
        {selected.change ? <Text style={[s.detailChange, selected.change === "added" && s.added,
          selected.change === "modified" && s.modified, selected.change === "removed" && s.removed]}>{selected.change}</Text> : null}
      </View>
      {selected.componentId && onOpenComponent ? <Button title="Open component" onPress={() => onOpenComponent(selected.componentId!)} secondary compact /> : null}
    </View> : null}
  </View>;
}

export function DiagramView({ diagram, height = DEFAULT_HEIGHT, onOpenComponent }: {
  diagram: Diagram;
  height?: number;
  onOpenComponent?: (componentId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedSpaceHeight, setExpandedSpaceHeight] = useState(0);
  const insets = useSafeAreaInsets();
  const layout = useMemo(() => diagram.parseError
    ? { width: 1, height: 1, nodes: [], edges: [], groups: [] } satisfies DiagramLayout
    : layoutDiagram(diagram), [diagram]);
  const onExpandedSpaceLayout = (event: LayoutChangeEvent) => setExpandedSpaceHeight(event.nativeEvent.layout.height);
  const expandedCanvasHeight = Math.max(DEFAULT_HEIGHT, expandedSpaceHeight - CONTROLS_HEIGHT - DETAIL_HEIGHT);

  return <View style={s.card}>
    <DiagramCanvas diagram={diagram} layout={layout} height={height} onOpenComponent={onOpenComponent}
      onExpand={() => setExpanded(true)} />
    <Modal visible={expanded} animationType="slide" onRequestClose={() => setExpanded(false)} statusBarTranslucent navigationBarTranslucent>
      <View style={[s.modal, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <View style={s.modalHeader}>
          <Text accessibilityRole="header" numberOfLines={1} style={s.modalTitle}>{diagram.title}</Text>
          <Button title="Close" onPress={() => setExpanded(false)} secondary compact />
        </View>
        <View onLayout={onExpandedSpaceLayout} style={s.expandedContent}>
          <DiagramCanvas diagram={diagram} layout={layout} height={expandedCanvasHeight} onOpenComponent={onOpenComponent ? componentId => {
            setExpanded(false);
            onOpenComponent(componentId);
          } : undefined} />
        </View>
      </View>
    </Modal>
  </View>;
}

const s = StyleSheet.create({
  card: { overflow: "hidden", borderRadius: theme.radius.card, backgroundColor: theme.colors.paper },
  diagramBody: { backgroundColor: theme.colors.paper },
  frame: { width: "100%", overflow: "hidden", borderRadius: theme.radius.card, borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.rule, backgroundColor: theme.colors.paper, alignItems: "center", justifyContent: "center" },
  backgroundTapTarget: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  canvas: { position: "absolute", left: 0, top: 0 },
  controls: { flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingTop: 8 },
  detail: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.rule, backgroundColor: theme.colors.paper },
  detailCopy: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  detailLabel: { flexShrink: 1, color: theme.colors.ink, fontSize: 13, fontWeight: "600" },
  detailChange: { color: theme.colors.mutedInk, fontSize: 11, textTransform: "capitalize" },
  added: { color: theme.colors.forest },
  modified: { color: theme.colors.warningInk },
  removed: { color: theme.colors.error, textDecorationLine: "line-through" },
  sourceScroll: { width: "100%", height: 180, backgroundColor: theme.colors.screenSurface },
  sourceContent: { padding: 12, flexGrow: 0 },
  sourceText: { flexShrink: 0, color: theme.colors.screenInk, fontFamily: theme.mono, fontSize: 12, lineHeight: 18 },
  parseError: { width: "100%", paddingHorizontal: 12, paddingVertical: 8, color: theme.colors.error, fontSize: 12 },
  modal: { flex: 1, paddingHorizontal: 12, backgroundColor: theme.colors.paper },
  modalHeader: { height: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 },
  expandedContent: { flex: 1 },
  modalTitle: { flex: 1, color: theme.colors.ink, fontSize: 16, fontWeight: "600" },
});
