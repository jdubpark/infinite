export function formatTime(value: string | null): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "not recorded" : parsed.toLocaleString();
}

export function sumCounts(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
