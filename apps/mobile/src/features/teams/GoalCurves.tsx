import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { theme } from "../../theme";
import { curveRuns, valueText, type Curve } from "./goal-curve";
import { t } from "./parts";

const HEIGHT = 56, INSET = 4;

export function CurveChart({ curve }: { curve: Curve }) {
  const [width, setWidth] = useState(0);
  const count = curve.slots.length;
  const span = curve.max - curve.min;
  const x = (slot: number) => count > 1 ? INSET + slot * (width - INSET * 2) / (count - 1) : width / 2;
  const y = (value: number) => span === 0 ? HEIGHT / 2 : HEIGHT - INSET - (value - curve.min) / span * (HEIGHT - INSET * 2);
  const runs = curveRuns(curve.slots);
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={s.chart}>
    {width > 0 ? <Svg key={JSON.stringify([width, curve.slots])} width={width} height={HEIGHT}>
      <Line x1={0} y1={HEIGHT - 0.5} x2={width} y2={HEIGHT - 0.5} stroke={theme.colors.rule} strokeWidth={StyleSheet.hairlineWidth} />
      {runs.map(run => run.length > 1
        ? <Path key={run[0]!.slot} d={run.map((point, index) => `${index ? "L" : "M"}${x(point.slot).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")}
          fill="none" stroke={theme.colors.forest} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        : null)}
      {runs.flat().map(point => <Circle key={point.slot} cx={x(point.slot)} cy={y(point.value)} r={2.5} fill={theme.colors.forest} />)}
    </Svg> : null}
  </View>;
}

export function CurveRow({ curve }: { curve: Curve }) {
  return <View style={s.row} accessible accessibilityLabel={`${curve.title}. Latest reported ${valueText(curve.latest.value)} in cycle ${curve.latest.cycle}`}>
    <Text style={t.strong} numberOfLines={1}>{curve.title}</Text>
    {curve.configured ? null : <Text style={t.note}>No longer configured</Text>}
    <CurveChart curve={curve} />
    <Text style={t.note}>Latest reported {valueText(curve.latest.value)} · cycle {curve.latest.cycle}</Text>
  </View>;
}

const s = StyleSheet.create({
  row: { gap: 3, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.rule },
  chart: { height: HEIGHT },
});
