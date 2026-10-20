import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect } from "react-native-svg";
import { theme } from "../../theme";
import { shortDay, usd, type DailyPoint } from "./model";

/**
 * Hand-drawn marks with one fixed grammar: thin bars with a square base and a rounded top, a
 * surface gap between touching fills instead of a stroke, hairline solid rules, and labels in
 * native text so system font scaling still applies. Marks carry colour; text never does.
 */
const GAP = 2, RADIUS = 4, AXIS_BAND = 16, TOP_LABEL = 14;

/** A segment with a rounded top and a square base, as a path. */
function cap(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

/** Thirty days stacked by account; a tap on a band selects that day and dims the rest. */
export function StackedBars({ days, accounts, colors, selected, onSelect, height = 150 }: {
  days: DailyPoint[]; accounts: string[]; colors: Record<string, string>; selected?: string; onSelect: (date: string | undefined) => void; height?: number;
}) {
  const [width, setWidth] = useState(0);
  const max = Math.max(0.01, ...days.map(day => day.usd));
  const total = days.reduce((sum, day) => sum + day.usd, 0);
  const highest = days.reduce<DailyPoint | undefined>((best, day) => !best || day.usd > best.usd ? day : best, undefined);
  const plotHeight = height - AXIS_BAND, top = TOP_LABEL, baseline = plotHeight - StyleSheet.hairlineWidth;
  const band = days.length ? width / days.length : 0, bar = Math.min(24, Math.max(1, band - GAP)), radius = Math.min(RADIUS, bar / 2);
  const scale = (value: number) => value / max * (baseline - top);
  const labelAt = [0, Math.floor(days.length / 2), days.length - 1].filter((index, position, all) => index >= 0 && all.indexOf(index) === position);
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={[s.wrap, { height }]} accessible
    accessibilityLabel={`30-day spend ${usd(total)}${highest && highest.usd > 0 ? `, highest ${usd(highest.usd)} on ${shortDay(highest.date)}` : ""}`}>
    {width > 0 ? <>
      <Text style={[s.axis, { top: 0, right: 0 }]}>{usd(max, { compact: true })}</Text>
      <Svg width={width} height={plotHeight}>
        <Line x1={0} y1={top} x2={width} y2={top} stroke={theme.colors.rule} strokeWidth={StyleSheet.hairlineWidth} />
        <Line x1={0} y1={baseline} x2={width} y2={baseline} stroke={theme.colors.rule} strokeWidth={StyleSheet.hairlineWidth} />
        {days.map((day, index) => {
          const x = index * band + (band - bar) / 2;
          const dim = Boolean(selected) && selected !== day.date;
          const segments = accounts.map(account => ({ account, value: day.byAccount[account] ?? 0 })).filter(segment => segment.value > 0);
          let floor = baseline;
          const marks = segments.map((segment, position) => {
            const full = scale(segment.value);
            const h = Math.max(0, full - (position ? GAP : 0));
            const y = floor - full;
            floor = y;
            const fill = colors[segment.account] ?? theme.colors.placeholder;
            const last = position === segments.length - 1;
            if (h < 1) return null;
            return last && h >= radius
              ? <Path key={segment.account} d={cap(x, Math.max(top, y), bar, h, radius)} fill={fill} opacity={dim ? 0.4 : 1} />
              : <Rect key={segment.account} x={x} y={Math.max(top, y)} width={bar} height={h} fill={fill} opacity={dim ? 0.4 : 1} />;
          });
          return <G key={day.date}>{marks}<Rect x={index * band} y={0} width={band} height={plotHeight} fill="transparent" onPress={() => onSelect(selected === day.date ? undefined : day.date)} /></G>;
        })}
      </Svg>
      {labelAt.map(index => {
        const day = days[index]!;
        const edge = index === 0 ? { left: 0, textAlign: "left" as const } : index === days.length - 1 ? { right: 0, textAlign: "right" as const } : { left: (index + 0.5) * band - 32, textAlign: "center" as const };
        return <Text key={day.date} style={[s.day, { top: plotHeight + 2 }, edge]} numberOfLines={1}>{shortDay(day.date)}</Text>;
      })}
    </> : null}
  </View>;
}

/** Thirty values as one 2-unit line ending in a ringed dot; an empty series is a baseline. */
export function Sparkline({ values, color, width = 64, height = 20 }: { values: number[]; color: string; width?: number; height?: number }) {
  const max = Math.max(0, ...values);
  const inset = 3;
  const points = values.map((value, index) => [
    values.length > 1 ? inset + index * (width - inset * 2) / (values.length - 1) : width / 2,
    height - inset - (max ? value / max * (height - inset * 2) : 0),
  ] as const);
  const path = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = points.at(-1);
  return <Svg width={width} height={height}>
    {max === 0 || !last ? <Line x1={inset} y1={height - inset} x2={width - inset} y2={height - inset} stroke={theme.colors.rule} strokeWidth={StyleSheet.hairlineWidth} /> : <>
      <Path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={last[0]} cy={last[1]} r={3} fill={color} stroke={theme.colors.white} strokeWidth={2} />
    </>}
  </Svg>;
}

/** An integrated rate on a 0–100% track: the Wilson interval as a band, the point as a ringed dot. */
export function IntervalBar({ rate, interval, enough, width = 120 }: { rate: number; interval: [number, number] | null; enough: boolean; width?: number }) {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const left = interval ? clamp(interval[0]) * width : 0;
  const span = interval ? Math.max(0, clamp(interval[1]) * width - left) : 0;
  const tint = enough ? theme.colors.forest : theme.colors.placeholder;
  const label = interval ? `integrated ${Math.round(rate * 100)}%, 95% interval ${Math.round(clamp(interval[0]) * 100)}–${Math.round(clamp(interval[1]) * 100)}%${enough ? "" : ", not enough data"}` : "not enough data";
  return <View accessible accessibilityLabel={label} style={[s.interval, { width }]}>
    <View style={[s.track, { width }]} />
    {interval ? <View style={[s.band, { left, width: span, backgroundColor: tint }]} /> : null}
    {interval ? <View style={[s.point, { left: Math.max(0, Math.min(width - 10, clamp(rate) * width - 5)), backgroundColor: tint }]} /> : null}
  </View>;
}

const s = StyleSheet.create({
  wrap: { width: "100%" },
  axis: { position: "absolute", zIndex: 1, fontSize: 10, lineHeight: 12, color: theme.colors.mutedInk, fontVariant: ["tabular-nums"] },
  day: { position: "absolute", width: 64, fontSize: 10, lineHeight: 12, color: theme.colors.mutedInk, fontVariant: ["tabular-nums"] },
  interval: { height: 16, justifyContent: "center" },
  track: { position: "absolute", height: 4, borderRadius: 2, backgroundColor: theme.colors.rule },
  band: { position: "absolute", height: 4, borderRadius: 2, opacity: 0.35 },
  point: { position: "absolute", width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: theme.colors.white },
});
