import { createHash } from "node:crypto";
import type { RoutingPoint } from "./routing-types.js";

const MAX_GAMMA_TRIES = 64;

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function decisionSeed(digest: string, runId: string, revision: number, taskKey: string, point: RoutingPoint, ordinal: number): string {
  return sha256Hex(`${digest}|${runId}|${revision}|${taskKey}|${point}|${ordinal}`);
}

export function candidateSeed(seed: string, identity: string): string {
  return sha256Hex(`${seed}|${identity}`);
}

function uniformStream(seed: string): () => number {
  let counter = 0;
  let words: bigint[] = [];
  return () => {
    if (words.length === 0) {
      const block = createHash("sha256").update(`${seed}:${counter}`, "utf8").digest();
      counter += 1;
      words = [];
      for (let offset = 0; offset < block.length; offset += 8) words.push(block.readBigUInt64BE(offset) >> 11n);
    }
    const top = words.shift() as bigint;
    return (Number(top) + 0.5) / 2 ** 53;
  };
}

function normal(next: () => number): number {
  const u1 = next();
  const u2 = next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function gamma(shape: number, next: () => number): number | undefined {
  if (shape < 1) {
    const boosted = gamma(shape + 1, next);
    if (boosted === undefined) return undefined;
    return boosted * next() ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let tries = 0; tries < MAX_GAMMA_TRIES; tries += 1) {
    const x = normal(next);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = next();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return undefined;
}

export function betaSample(a: number, b: number, seed: string): { value: number; fallback: boolean } {
  if (!(Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0)) {
    throw new RangeError(`Beta parameters must be finite and above 0, got ${a} and ${b}`);
  }
  const next = uniformStream(seed);
  const x = gamma(a, next);
  const y = x === undefined ? undefined : gamma(b, next);
  if (x === undefined || y === undefined || x + y === 0) return { value: a / (a + b), fallback: true };
  return { value: x / (x + y), fallback: false };
}
