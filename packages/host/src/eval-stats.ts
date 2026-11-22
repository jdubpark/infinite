import { createHash } from "node:crypto";
import { PROMPT_ORIGINS, VOID_ENDINGS, type ComparisonStats, type PairResult, type PromptOrigin, type TrialEnding } from "./eval-types.js";

export const BOOTSTRAP_RESAMPLES = 10_000;
export const INTERVAL_LOW = 250;
export const INTERVAL_HIGH = 9_749;
// 1.959964 (two-sided 95%) + 0.841621 (80% power).
export const POWER_Z = 2.801585;
export const PLANNING_SD = [0.35, 0.41] as const;

export type StatTrial = {
  configuration: number;
  slot: number;
  ending: TrialEnding;
  resolved: boolean;
  matches: boolean;
  tokens: number | null;
  spentUsd: number | null;
  cost: "complete" | "partial" | "none" | null;
  minutes: number | null;
};
export type StatTask = {
  key: string;
  area: string;
  promptOrigin: PromptOrigin | null;
  leftHoldout: boolean;
  trials: StatTrial[];
};
export type StatInput = {
  seed: string;
  configurations: number;
  trialsPerTask: number;
  plannedTasks: number;
  tasks: StatTask[];
};

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** xoshiro128**: four 32-bit words of state, one unsigned 32-bit output per call. */
export function xoshiro128ss(state: readonly [number, number, number, number]): () => number {
  let s0 = state[0] >>> 0;
  let s1 = state[1] >>> 0;
  let s2 = state[2] >>> 0;
  let s3 = state[3] >>> 0;
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  return () => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };
}

/** The seed, pair, and subgroup fix the stream: the same rows give the same interval. */
export function bootstrapStream(seed: string, pair: string, subgroup: string): () => number {
  const digest = createHash("sha256").update(`${seed}\u0000${pair}\u0000${subgroup}`, "utf8").digest();
  return xoshiro128ss([digest.readUInt32BE(0), digest.readUInt32BE(4), digest.readUInt32BE(8), digest.readUInt32BE(12)]);
}

/** Exact two-sided sign test over the untied pairs. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  let sum = 0n;
  let term = 1n;
  const low = Math.min(wins, losses);
  for (let k = 0; k <= low; k += 1) {
    sum += term;
    term = (term * BigInt(n - k)) / BigInt(k + 1);
  }
  const p = Number(2n * sum) / Number(1n << BigInt(n));
  return Math.min(1, p);
}

/** Holm step-down adjustment, returned in the input order. */
export function holm(p: readonly number[]): number[] {
  const order = p.map((value, index) => ({ value, index }));
  order.sort((x, y) => x.value - y.value || x.index - y.index);
  const out = new Array<number>(p.length).fill(1);
  let running = 0;
  order.forEach((entry, rank) => {
    running = Math.max(running, Math.min(1, (p.length - rank) * entry.value));
    out[entry.index] = running;
  });
  return out;
}

const isVoid = (ending: TrialEnding): boolean => VOID_ENDINGS.includes(ending);
const valid = (trial: StatTrial): boolean => !isVoid(trial.ending) && trial.matches;

function resolvedCount(task: StatTask, configuration: number): number {
  return task.trials.filter((trial) => trial.configuration === configuration && valid(trial) && trial.resolved).length;
}

function validCount(task: StatTask, configuration: number): number {
  return task.trials.filter((trial) => trial.configuration === configuration && valid(trial)).length;
}

function pairResult(input: StatInput, tasks: StatTask[], a: number, b: number, subgroup: string): Omit<PairResult, "holm"> {
  const t = input.trialsPerTask;
  const d = tasks.map((task) => resolvedCount(task, b) - resolvedCount(task, a));
  const n = d.length;
  const wins = d.filter((value) => value > 0).length;
  const losses = d.filter((value) => value < 0).length;
  const total = d.reduce((sum, value) => sum + value, 0);
  let mean: number | null = null;
  let interval: [number, number] | null = null;
  if (n > 0) {
    mean = total / (n * t);
    const next = bootstrapStream(input.seed, `${a}:${b}`, subgroup);
    const sums = new Int32Array(BOOTSTRAP_RESAMPLES);
    for (let r = 0; r < BOOTSTRAP_RESAMPLES; r += 1) {
      let sum = 0;
      for (let i = 0; i < n; i += 1) sum += d[Math.floor(next() * n / 2 ** 32)] ?? 0;
      sums[r] = sum;
    }
    sums.sort();
    interval = [(sums[INTERVAL_LOW] ?? 0) / (n * t), (sums[INTERVAL_HIGH] ?? 0) / (n * t)];
  }
  let observed: number | null = null;
  if (n >= 2) {
    const scaled = d.map((value) => value / t);
    const avg = scaled.reduce((sum, value) => sum + value, 0) / n;
    const variance = scaled.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (n - 1);
    observed = POWER_Z * Math.sqrt(variance) / Math.sqrt(n);
  }
  const planning: [number, number] | null = n >= 1
    ? [POWER_Z * PLANNING_SD[0] / Math.sqrt(n), POWER_Z * PLANNING_SD[1] / Math.sqrt(n)]
    : null;
  return {
    a,
    b,
    n,
    mean,
    interval,
    sign: { wins, losses, ties: n - wins - losses, p: signTest(wins, losses) },
    detectable: { observed, planning },
  };
}

function pairsOf(input: StatInput, tasks: StatTask[], subgroup: string): PairResult[] {
  const raw: Omit<PairResult, "holm">[] = [];
  for (let a = 0; a < input.configurations; a += 1) {
    for (let b = a + 1; b < input.configurations; b += 1) raw.push(pairResult(input, tasks, a, b, subgroup));
  }
  const adjusted = holm(raw.map((pair) => pair.sign.p));
  return raw.map((pair, index) => ({ ...pair, holm: adjusted[index] ?? 1 }));
}

const byCode = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

export function comparisonStats(input: StatInput): ComparisonStats {
  const t = input.trialsPerTask;
  const tasks = input.tasks
    .map((task) => ({
      ...task,
      trials: [...task.trials].sort((x, y) => x.configuration - y.configuration || x.slot - y.slot),
    }))
    .sort((x, y) => byCode(x.key, y.key));
  const configs = Array.from({ length: input.configurations }, (_, index) => index);
  const analysed = tasks.filter((task) => !task.leftHoldout && configs.every((c) => validCount(task, c) >= t));
  const area = new Map<string, StatTask[]>();
  const origin = new Map<PromptOrigin, StatTask[]>();
  for (const task of analysed) {
    area.set(task.area, [...(area.get(task.area) ?? []), task]);
    if (task.promptOrigin !== null) origin.set(task.promptOrigin, [...(origin.get(task.promptOrigin) ?? []), task]);
  }
  const sensitivity: ComparisonStats["sensitivity"] = [];
  const seen = tasks.filter((task) => !task.leftHoldout && configs.every((c) => task.trials.some((trial) => trial.configuration === c)));
  for (let a = 0; a < input.configurations; a += 1) {
    for (let b = a + 1; b < input.configurations; b += 1) {
      const total = seen.reduce((sum, task) => sum + resolvedCount(task, b) - resolvedCount(task, a), 0);
      sensitivity.push({ a, b, n: seen.length, mean: seen.length === 0 ? null : total / (seen.length * t) });
    }
  }
  const attrition = configs.map((configuration) => {
    const own = tasks.flatMap((task) => task.trials.filter((trial) => trial.configuration === configuration));
    const counts = { "void-limit": 0, "void-host": 0, "void-owner": 0 };
    for (const trial of own) {
      if (trial.ending === "void-limit" || trial.ending === "void-host" || trial.ending === "void-owner") counts[trial.ending] += 1;
    }
    return {
      configuration,
      void: counts,
      changed: own.filter((trial) => !trial.matches).length,
      short: tasks.filter((task) => !task.leftHoldout && validCount(task, configuration) < t).length,
    };
  });
  const cost = configs.map((configuration) => {
    const own = tasks.flatMap((task) => task.trials.filter((trial) => trial.configuration === configuration));
    const resolvedAmong = (list: StatTrial[]): number => list.filter((trial) => valid(trial) && trial.resolved).length;
    const costed = own.filter((trial) => trial.cost === "complete");
    const timed = own.filter((trial) => trial.minutes !== null);
    const per = (list: StatTrial[], pick: (trial: StatTrial) => number | null): number | null => {
      const divisor = resolvedAmong(list);
      if (divisor === 0) return null;
      return list.reduce((sum, trial) => sum + (pick(trial) ?? 0), 0) / divisor;
    };
    return {
      configuration,
      trials: own.length,
      resolved: resolvedAmong(own),
      costed: costed.length,
      tokensPerResolved: per(costed, (trial) => trial.tokens),
      spentUsdPerResolved: per(costed, (trial) => trial.spentUsd),
      listUsdPerResolved: null,
      minutesPerResolved: per(timed, (trial) => trial.minutes),
    };
  });
  return {
    trialsPerTask: t,
    conclusive: analysed.length >= 1 && analysed.length * 10 >= input.plannedTasks * 9,
    tasks: { planned: input.plannedTasks, analysed: analysed.length, leftHoldout: tasks.filter((task) => task.leftHoldout).length },
    pairs: pairsOf(input, analysed, "all"),
    sensitivity,
    attrition,
    cost,
    byPromptOrigin: PROMPT_ORIGINS.filter((name) => origin.has(name)).map((name) => {
      const group = origin.get(name) ?? [];
      return { promptOrigin: name, n: group.length, pairs: pairsOf(input, group, `origin:${name}`) };
    }),
    byArea: [...area.keys()].sort(byCode).map((name) => {
      const group = area.get(name) ?? [];
      return { area: name, n: group.length, pairs: pairsOf(input, group, `area:${name}`) };
    }),
  };
}
