import type { GoalMetricsView, MetricPoint, MetricSeries } from "./api";

export const numberText = (value: number) => String(Number(value.toPrecision(6)));

const WIDTH = 160, HEIGHT = 36, PAD = 5;

export function curveGeometry(points: MetricPoint[], cycles: number[]) {
  const axis = [...new Set([...cycles, ...points.map(point => point.cycle)])].sort((a, b) => a - b);
  const low = Math.min(...points.map(point => point.value)), high = Math.max(...points.map(point => point.value));
  const x = (cycle: number) => axis.length > 1 ? PAD + (axis.indexOf(cycle) / (axis.length - 1)) * (WIDTH - PAD * 2) : WIDTH / 2;
  const y = (value: number) => high === low ? HEIGHT / 2 : HEIGHT - PAD - ((value - low) / (high - low)) * (HEIGHT - PAD * 2);
  const byCycle = new Map(points.map(point => [point.cycle, point]));
  const segments: [number, number][][] = [];
  let open: [number, number][] = [];
  for (const cycle of axis) {
    const point = byCycle.get(cycle);
    if (!point) { if (open.length) segments.push(open); open = []; continue; }
    open.push([x(cycle), y(point.value)]);
  }
  if (open.length) segments.push(open);
  return { segments, dots: points.map(point => [x(point.cycle), y(point.value)] as [number, number]), cyclesOnAxis: axis.length };
}

function Curve({ series, cycles }: { series: MetricSeries; cycles: number[] }) {
  const { segments, dots, cyclesOnAxis } = curveGeometry(series.points, cycles);
  const label = `${series.name}: ${series.points.length} reported ${series.points.length === 1 ? "value" : "values"} over ${cyclesOnAxis} ${cyclesOnAxis === 1 ? "cycle" : "cycles"}; cycles without a report are left blank`;
  return <svg className="goal-metric-curve" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}>
    {segments.filter(segment => segment.length > 1).map((segment, index) => <path key={index} className="goal-metric-line" d={segment.map(([x, y], at) => `${at ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} />)}
    {dots.map(([x, y], index) => <circle key={index} className="goal-metric-dot" cx={x.toFixed(1)} cy={y.toFixed(1)} r={2.5} />)}
  </svg>;
}

function Omitted({ metrics }: { metrics: GoalMetricsView }) {
  const parts = [
    metrics.omittedSeries > 0 && `${metrics.omittedSeries} series left out`,
    metrics.omittedValues > 0 && `${metrics.omittedValues} ${metrics.omittedValues === 1 ? "value" : "values"} left out`,
    metrics.dropped > 0 && `${metrics.dropped} older ${metrics.dropped === 1 ? "cycle entry" : "cycle entries"} removed by retention`,
  ].filter(Boolean);
  return parts.length ? <p className="quiet goal-metric-omitted">{parts.join(" · ")}</p> : null;
}

export function GoalMetricsPanel({ metrics, error, cycles }: { metrics: GoalMetricsView | null; error: string; cycles: number[] }) {
  return <section className="team-section goal-metrics">
    <div className="team-section-heading"><h2>Reported numbers</h2></div>
    {error && <p className="quiet goal-metric-error" role="status">Reported numbers could not be loaded. {error}</p>}
    {!metrics && !error && <p className="quiet" role="status">Loading reported numbers…</p>}
    {metrics && (metrics.series.length === 0
      ? <p className="quiet">No check has reported a number yet. A check reports one by printing <code>infinite-metric NAME VALUE</code>.</p>
      : <>
        <p className="quiet">Numbers the goal’s checks reported, kept only from a check that passed at a reviewed head. A blank cycle means no report.</p>
        <ul className="goal-metric-list">{metrics.series.map(series => {
          const latest = series.points[series.points.length - 1]!;
          return <li key={series.command + "\n" + series.name} className="goal-metric">
            <div className="goal-metric-head"><strong>{series.name}</strong>{series.label !== undefined && <code className="goal-metric-label" title={series.label}>{series.label}</code>}{!series.configured && <span className="quiet">no longer configured</span>}</div>
            <div className="goal-metric-body"><Curve series={series} cycles={cycles} /><span className="goal-metric-latest">{numberText(latest.value)}<small className="quiet"> latest, cycle {latest.cycle}</small></span></div>
          </li>;
        })}</ul>
        <Omitted metrics={metrics} />
      </>)}
  </section>;
}
