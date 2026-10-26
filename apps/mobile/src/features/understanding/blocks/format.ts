/** Local date and time for a recorded instant, or "not recorded" when it is absent or invalid. */
export function formatTime(value: string | null): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "not recorded" : parsed.toLocaleString();
}

/** Sums line counts; a count the host could not measure adds nothing. */
export function sumCounts(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
