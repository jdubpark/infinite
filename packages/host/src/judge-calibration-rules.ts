export const CALIBRATION_MIN_PAIRS = 30;
export const CALIBRATION_MAX_PAIRS = 60;
export const CALIBRATION_DEFAULT_PAIRS = 36;
export const CALIBRATION_LOWER_BOUND_MIN = 0.6;
export const CALIBRATION_VALID_DAYS = 60;
export const CALIBRATION_RETRIES = 2;
export const CALIBRATION_RELEASES = 10;
export const WILSON_Z = 1.96;

export type OrderingResult = { resolvedIsA: boolean; preferred: "A" | "B" | "tie" | null };
export type CalibrationSummary = {
  counted: number;
  correct: number;
  agree: number;
  accuracy: number | null;
  lowerBound: number | null;
  swapAgreement: number | null;
  state: "ok" | "not-ok";
};

export function preferredResolved(ordering: OrderingResult): boolean | null {
  if (ordering.preferred !== "A" && ordering.preferred !== "B") return null;
  return (ordering.preferred === "A") === ordering.resolvedIsA;
}

export function pairCorrect(first: OrderingResult, second: OrderingResult): boolean {
  return preferredResolved(first) === true && preferredResolved(second) === true;
}

export function pairAgrees(first: OrderingResult, second: OrderingResult): boolean {
  const one = preferredResolved(first);
  const two = preferredResolved(second);
  return one !== null && two !== null && one === two;
}

export function wilsonLower(correct: number, n: number, z = WILSON_Z): number {
  if (n <= 0) return 0;
  const p = correct / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / denominator);
}

export function calibrationSummary(pairs: readonly { first: OrderingResult; second: OrderingResult }[]): CalibrationSummary {
  const counted = pairs.length;
  const correct = pairs.filter(pair => pairCorrect(pair.first, pair.second)).length;
  const agree = pairs.filter(pair => pairAgrees(pair.first, pair.second)).length;
  if (counted === 0)
    return { counted, correct, agree, accuracy: null, lowerBound: null, swapAgreement: null, state: "not-ok" };
  const lowerBound = wilsonLower(correct, counted);
  const ok = counted >= CALIBRATION_MIN_PAIRS && lowerBound >= CALIBRATION_LOWER_BOUND_MIN;
  return { counted, correct, agree, accuracy: correct / counted, lowerBound, swapAgreement: agree / counted, state: ok ? "ok" : "not-ok" };
}

export function judgeWeight(accuracy: number): number {
  return Math.max(0, 2 * accuracy - 1);
}
