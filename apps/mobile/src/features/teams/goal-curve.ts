import type { GoalMetricsSeries, GoalMetricsView } from "../../api/client";

type CurveSeries = Pick<GoalMetricsSeries, "name" | "label" | "command" | "configured" | "points">;
type CurveView = Pick<GoalMetricsView, "series" | "omittedSeries" | "omittedValues" | "dropped">;

export type Curve = {
  key: string;
  title: string;
  configured: boolean;
  slots: (number | null)[];
  min: number;
  max: number;
  latest: { value: number; cycle: number };
};

export const NO_NUMBERS_NOTE = "No check has reported a number yet.";
export const TITLE_LIMIT = 48;

export function truncate(text: string, limit = TITLE_LIMIT) {
  const characters = [...text];
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`;
}

export function curveTitle(series: Pick<CurveSeries, "name" | "label">) {
  return series.label ? `${truncate(series.name, 24)} · ${truncate(series.label, 24)}` : truncate(series.name);
}

export function buildCurves(view: CurveView, cycles: readonly { cycle: number }[]): Curve[] {
  const order = new Map(cycles.map((entry, index) => [entry.cycle, index]));
  const curves: Curve[] = [];
  for (const series of view.series) {
    const slots: (number | null)[] = cycles.map(() => null);
    let latest: Curve["latest"] | undefined;
    for (const point of series.points) {
      const slot = order.get(point.cycle);
      if (slot === undefined || !Number.isFinite(point.value)) continue;
      slots[slot] = point.value;
    }
    for (let index = slots.length - 1; index >= 0 && !latest; index -= 1) {
      const value = slots[index];
      if (value !== null && value !== undefined) latest = { value, cycle: cycles[index]!.cycle };
    }
    if (!latest) continue;
    const present = slots.filter((value): value is number => value !== null);
    curves.push({
      key: `${series.command}\u0000${series.name}`, title: curveTitle(series), configured: series.configured, slots,
      min: Math.min(...present), max: Math.max(...present), latest,
    });
  }
  return curves;
}

export function curveRuns(slots: readonly (number | null)[]) {
  const runs: { slot: number; value: number }[][] = [];
  let open: { slot: number; value: number }[] | undefined;
  slots.forEach((value, slot) => {
    if (value === null) { open = undefined; return; }
    if (!open) { open = []; runs.push(open); }
    open.push({ slot, value });
  });
  return runs;
}

export function omittedText(view: Pick<CurveView, "omittedSeries" | "omittedValues" | "dropped">) {
  const parts: string[] = [];
  if (view.omittedSeries) parts.push(`${view.omittedSeries} more series not shown`);
  if (view.omittedValues) parts.push(`${view.omittedValues} ${view.omittedValues === 1 ? "value" : "values"} over the per-cycle limit not shown`);
  if (view.dropped) parts.push(`${view.dropped} older ${view.dropped === 1 ? "cycle" : "cycles"} no longer kept`);
  return parts;
}

export const valueText = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)));
