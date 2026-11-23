/** Pure scoring rules for a judge calibration. The unit is the pair: two orderings of one resolved and one unresolved trial. */
export const CALIBRATION_MIN_PAIRS = 30;
export const CALIBRATION_MAX_PAIRS = 60;
export const CALIBRATION_DEFAULT_PAIRS = 36;
export const CALIBRATION_LOWER_BOUND_MIN = 0.6;
export const CALIBRATION_VALID_DAYS = 60;
export const CALIBRATION_RETRIES = 2;
export const WILSON_Z = 1.96;

/** `preferred` is null when the judge failed to answer. */
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

/** True when the judge preferred the resolved trial, false for the unresolved one, null for a tie or a failure. */
export function preferredResolved(ordering: OrderingResult): boolean | null {
  if (ordering.preferred !== "A" && ordering.preferred !== "B") return null;
  return (ordering.preferred === "A") === ordering.resolvedIsA;
}

/** A pair is correct only when both orderings prefer the resolved trial. */
export function pairCorrect(first: OrderingResult, second: OrderingResult): boolean {
  return preferredResolved(first) === true && preferredResolved(second) === true;
}

/** A pair agrees when both orderings prefer the same trial. A tie or a failure never agrees. */
export function pairAgrees(first: OrderingResult, second: OrderingResult): boolean {
  const one = preferredResolved(first);
  const two = preferredResolved(second);
  return one !== null && two !== null && one === two;
}

/** Lower end of the Wilson score interval, clamped at 0. */
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

/** Phase 2 weight of a judge at admission. */
export function judgeWeight(accuracy: number): number {
  return Math.max(0, 2 * accuracy - 1);
}
