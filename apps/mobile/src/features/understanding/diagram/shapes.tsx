import { Defs, Ellipse, Marker, Path, Rect } from "react-native-svg";
import type { DiagramNodeShape } from "@infinite/remote";
import { theme } from "../../../theme";

export function NodeShape({ shape, w, h, fill, stroke, dashed, opacity = 1 }: {
  shape: DiagramNodeShape;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  dashed?: boolean;
  /** Applied per element: group opacity is not reliable across react-native-svg renderers. */
  opacity?: number;
}) {
  const strokeDasharray = dashed ? "6 4" : undefined;
  const common = { fill, stroke, strokeWidth: 1.5, strokeDasharray, opacity };

  switch (shape) {
    case "round":
      return <Rect x={0} y={0} width={w} height={h} rx={22} {...common} />;
    case "diamond":
      return <Path d={`M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`} {...common} />;
    case "cylinder":
      return <>
        <Rect x={0} y={5} width={w} height={Math.max(1, h - 10)} {...common} />
        <Ellipse cx={w / 2} cy={5} rx={w / 2} ry={5} {...common} />
        <Ellipse cx={w / 2} cy={h - 5} rx={w / 2} ry={5} {...common} />
      </>;
    case "pill":
      return <Rect x={0} y={0} width={w} height={h} rx={h / 2} {...common} />;
    case "box":
      return <Rect x={0} y={0} width={w} height={h} rx={8} {...common} />;
  }
}

export function ArrowMarker() {
  return <Defs>
    <Marker id="arrow" markerWidth={8} markerHeight={8} refX={7} refY={4} orient="auto" markerUnits="strokeWidth">
      <Path d="M0,0 L8,4 L0,8 Z" fill={theme.colors.forest} />
    </Marker>
  </Defs>;
}
