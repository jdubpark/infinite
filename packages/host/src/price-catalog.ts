export type CatalogPrice = { input: number; output: number; cacheRead?: number; cacheWrite?: number; peak?: { days: number[]; hoursUtc: [number, number][]; multiplier: number }; source: string; asOf: string };
const deepseekPeak = { days: [1, 2, 3, 4, 5], hoursUtc: [[1, 4], [6, 10]] as [number, number][], multiplier: 2 };
const ds: CatalogPrice = { input: 0.15, cacheRead: 0.003, output: 0.6, peak: deepseekPeak, source: "https://api-docs.deepseek.com/quick_start/pricing", asOf: "2026-10-19" };
const meta = (input: number, cacheRead: number, output: number): CatalogPrice => ({ input, cacheRead, output, source: "https://dev.meta.ai/docs/pricing-rate-limits.md", asOf: "2026-10-19" });
// Chinese public holidays are not modelled; the catalog applies the published weekday UTC windows.
export const PRICE_CATALOG: Record<string, CatalogPrice> = {
  "deepseek/deepseek-flash": ds,
  "deepseek/deepseek-v4-flash": ds,
  "deepseek/deepseek-v4-pro": { ...ds, input: 0.66, cacheRead: 0.022, output: 1.98 },
  "meta/muse-spark-1.3": meta(1.25, 0.15, 4.25),
  "meta/muse-spark-1.2": meta(1.25, 0.15, 4.25),
  "meta/muse-spark-1.1": meta(1.25, 0.15, 4.25),
  "meta/muse-spark-1.3-contributor": meta(0.1, 0.002, 0.2),
  "meta/muse-spark-1.2-contributor": meta(0.1, 0.002, 0.2),
  "meta/muse-wonder-1.0": meta(4, 0.2, 20),
};
