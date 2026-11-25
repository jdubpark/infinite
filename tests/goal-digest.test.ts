import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as goal from "../packages/host/src/goal-digest.js";
import * as crossing from "../packages/host/src/crossing-digest.js";
import type { CriterionInput, EndedCycle, GoalDigest, HistoryLineInput } from "../packages/host/src/goal-digest.js";
import type { ClaimInput, CrossingDigest, HostInput } from "../packages/host/src/crossing-digest.js";

const { goalDigestSchema } = goal;
const { OMITTED_MAX } = crossing;
const LIMIT = 8192;
const char = (code: number) => String.fromCodePoint(code);

const measure = (digest: unknown) => Buffer.byteLength(JSON.stringify(digest), "utf8");
const utf8 = (value: string) => Buffer.byteLength(value, "utf8");

function valid(digest: GoalDigest | undefined, where = "a call"): GoalDigest {
  assert.ok(digest, `${where}: refused an argument the test meant as usable`);
  const parsed = goalDigestSchema.safeParse(digest);
  assert.ok(parsed.success, `${where}: ${JSON.stringify(parsed.error?.issues.slice(0, 2))}`);
  assert.equal(goal.GOAL_DIGEST_LIMIT_BYTES, LIMIT);
  assert.ok(measure(digest) <= LIMIT, `${where}: ${measure(digest)} bytes`);
  const sizes: [number, number][] = [[digest.history.length, 16], [digest.touched.length, 24], [digest.failures.length, 6],
    [digest.decisions.length, 6], [digest.open.length, 4], [digest.criteria?.length ?? 0, 8]];
  for (const [size, cap] of sizes) assert.ok(size <= cap, `${where}: a list of ${size} over its cap ${cap}`);
  for (const row of digest.history) assert.ok(utf8(row.line) <= 240, where);
  for (const row of digest.criteria ?? []) assert.ok(utf8(row.criterion) <= 240 && utf8(row.check ?? "") <= 120, where);
  assert.ok(digest.touched.every(row => row.by === "receipt"), `${where}: a claim in touched`);
  return digest;
}

function must(digest: CrossingDigest | undefined): CrossingDigest {
  assert.ok(digest, "a crossing builder refused a fixture");
  return digest;
}

const runId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (n: number) => n.toString(16).padStart(40, "0");
const STOP = { kind: "stop", blockCode: "checks-failed", stopClass: "failed" } as const;

function ended(cycle: number, run: CrossingDigest, extra: Partial<EndedCycle> = {}): EndedCycle {
  return { cycle, status: "blocked", line: STOP, run, handles: { runId: runId(cycle) }, outsideContent: false, ...extra };
}

const receiptFields = (digest: GoalDigest) => ({
  cycle: digest.cycle,
  handles: digest.handles,
  outsideContent: digest.outsideContent,
  unclearedHead: digest.unclearedHead,
  touched: digest.touched,
  failures: digest.failures.filter(row => row.by === "receipt"),
});

test("acceptance 11: a cycle that ends blocked after a failed check gives the next cycle its block line and the failure", () => {
  const host = must(crossing.hostDigest({
    outcome: "failed",
    changed: [{ path: "src/a.ts", op: "changed" }],
    failures: [{ signal: "exit 1", where: "npm test", class: "check" }],
  }));
  const run = must(crossing.withClaims(host, { decisions: [{ what: "kept the API", why: "callers" }] }));
  const first = valid(goal.nextGoalDigest(undefined, ended(1, run)));
  assert.deepEqual(first.history, [{ cycle: 1, status: "blocked", line: "block checks-failed, stop failed" }]);
  assert.deepEqual(first.failures, [{ signal: "exit 1", where: "npm test", class: "check", by: "receipt" }]);
  assert.deepEqual(first.handles, { runId: runId(1) });
  assert.deepEqual(first.touched, [{ path: "src/a.ts", op: "changed", by: "receipt" }]);
  assert.deepEqual(first.decisions, [{ what: "kept the API", why: "callers" }]);
  assert.deepEqual(Object.keys(first).sort(), ["cycle", "decisions", "failures", "handles", "history", "omitted", "open", "outsideContent", "touched", "v"]);
  assert.deepEqual(first.omitted, { cycles: 0, touched: 0, failures: 0, decisions: 0, open: 0, criteria: 0 });

  const run2 = must(crossing.hostDigest({
    outcome: "complete", changed: [{ path: "src/b.ts", op: "added" }], failures: [{ signal: "exit 1", where: "npm test", class: "check" }],
  }));
  const second = valid(goal.nextGoalDigest(first, ended(2, run2, {
    status: "merged", line: { kind: "brief", title: "Fix the check", expectedOutcome: "npm test passes" }, handles: { runId: runId(2), reviewedHead: sha(2) },
  })));
  assert.deepEqual(second.history.map(row => [row.cycle, row.status, row.line]), [[2, "merged", "Fix the check: npm test passes"], [1, "blocked", "block checks-failed, stop failed"]]);
  assert.deepEqual([second.failures, second.decisions], [[], []]);
  assert.deepEqual(second.touched.map(row => row.path), ["src/b.ts", "src/a.ts"]);
});

function wideCycle(cycle: number): EndedCycle {
  const fill = (prefix: string, size: number) => `${prefix} ${cycle} ${'"'.repeat(size)}`;
  const host = must(crossing.hostDigest({
    outcome: "failed",
    changed: Array.from({ length: 8 }, (_, index) => ({ path: `c${cycle}/${index}/${"p".repeat(260)}`, op: "changed" as const })),
    failures: Array.from({ length: 8 }, (_, index) => ({ signal: fill(`signal ${index}`, 40), where: `check ${index}`, class: "check" as const })),
  }));
  const run = must(crossing.withClaims(host, {
    decisions: Array.from({ length: 8 }, (_, index) => ({ what: fill(`what ${index}`, 220), why: fill("why", 220) })),
    open: Array.from({ length: 6 }, (_, index) => fill(`open ${index}`, 220)),
  }));
  const criteria: CriterionInput[] = Array.from({ length: 12 }, (_, index) => ({ criterion: fill(`criterion ${index}`, 300), status: "not-met", check: fill("test", 200) }));
  return ended(cycle, run, {
    status: cycle % 2 ? "blocked" : "ready-for-review",
    line: cycle % 2 ? STOP : { kind: "brief", title: fill("title", 300), expectedOutcome: fill("outcome", 3000) },
    criteria,
    outsideContent: true,
    unclearedHead: { runId: runId(1), head: sha(1) },
  });
}

test("acceptance 11: twenty cycles of large input stay within 8,192 bytes, and a twenty-first still builds", () => {
  let digest: GoalDigest | undefined;
  let largest = 0;
  for (let cycle = 1; cycle <= 21; cycle += 1) {
    digest = valid(goal.nextGoalDigest(digest, wideCycle(cycle)), `cycle ${cycle}`);
    largest = Math.max(largest, measure(digest));
    assert.equal(digest.cycle, cycle);
    assert.equal(digest.omitted.cycles, cycle - digest.history.length);
  }
  assert.ok(digest);
  assert.ok(largest > LIMIT - 300, `the largest digest was ${largest} bytes`);
  assert.ok(digest.touched.length > 0 && digest.failures.some(row => row.by === "receipt"), "receipts were lost");
});

function stored(options: { history: number; claims: number; paths: number }): GoalDigest {
  const quoted = (size: number, tag: string) => `${tag}${'"'.repeat(size)}`;
  return {
    v: 1,
    cycle: 40,
    history: Array.from({ length: 16 }, (_, index) => ({ cycle: 40 - index, status: "merged", line: quoted(options.history, `line ${40 - index} `) })),
    touched: Array.from({ length: 24 }, (_, index) => ({ path: `t${index}/${"p".repeat(options.paths)}`, op: "changed" as const, by: "receipt" as const })),
    failures: [
      { signal: "exit 1", where: "npm test", class: "check", by: "receipt" },
      { signal: "stalled", class: "stop", by: "receipt" },
      { signal: quoted(options.claims, "flaky "), where: "member", class: "claim", by: "claim" },
    ],
    decisions: Array.from({ length: 6 }, (_, index) => ({ what: quoted(options.claims, `what ${index} `), why: quoted(options.claims, "why ") })),
    open: Array.from({ length: 4 }, (_, index) => quoted(options.claims, `open ${index} `)),
    criteria: Array.from({ length: 8 }, (_, index) => ({ criterion: quoted(options.claims, `criterion ${index} `), status: "met" as const })),
    handles: { runId: runId(40) },
    outsideContent: false,
    omitted: { cycles: 24, touched: 0, failures: 0, decisions: 0, open: 0, criteria: 0 },
  };
}

test("drop order: the oldest history lines go first, then claims, then receipts, and omitted counts them", () => {
  const a = stored({ history: 200, claims: 10, paths: 4 });
  const fitA = valid(goal.fitGoalDigest(a), "history over");
  assert.ok(fitA.history.length > 0 && fitA.history.length < 16, `kept ${fitA.history.length} lines`);
  assert.deepEqual(fitA.history, a.history.slice(0, fitA.history.length));
  assert.deepEqual([fitA.decisions, fitA.open, fitA.criteria, fitA.failures, fitA.touched], [a.decisions, a.open, a.criteria, a.failures, a.touched]);
  assert.equal(fitA.omitted.cycles, 40 - fitA.history.length);

  const b = stored({ history: 200, claims: 220, paths: 4 });
  const fitB = valid(goal.fitGoalDigest(b), "claims over");
  assert.deepEqual(fitB.history, []);
  assert.equal(fitB.omitted.cycles, 40);
  assert.ok(fitB.open.length < 4, "no open question went");
  if (fitB.decisions.length < 6) assert.deepEqual(fitB.open, []);
  assert.deepEqual(fitB.decisions, b.decisions.slice(0, fitB.decisions.length));
  assert.deepEqual([fitB.criteria, fitB.failures, fitB.touched], [b.criteria, b.failures, b.touched]);
  assert.equal(fitB.omitted.open, 4 - fitB.open.length);
  assert.equal(fitB.omitted.decisions, 6 - fitB.decisions.length);

  const c = stored({ history: 200, claims: 220, paths: 290 });
  const fitC = valid(goal.fitGoalDigest(c), "receipts over");
  assert.deepEqual([fitC.history, fitC.decisions, fitC.open, fitC.criteria], [[], [], [], []]);
  assert.deepEqual(fitC.failures, c.failures.filter(row => row.by === "receipt"));
  assert.ok(fitC.touched.length > 0 && fitC.touched.length < 24);
  assert.deepEqual(fitC.touched, c.touched.slice(0, fitC.touched.length));
  assert.deepEqual(fitC.omitted, { cycles: 40, touched: 24 - fitC.touched.length, failures: 1, decisions: 6, open: 4, criteria: 8 });
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Step = { claimed: EndedCycle; erased: EndedCycle; collisions: number };
const HOST_CLASSES = ["check", "stop", "refusal", "conflict"] as const;
const STATUSES = ["blocked", "failed", "merged", "ready-for-review", "cancelled", "no-change"] as const;

function randomCycles(seed: number, count: number): Step[] {
  const random = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  const list = <T>(max: number, row: () => T) => Array.from({ length: int(0, max) }, row);
  const longOdds = pick([0, 0.6, 1]);
  const pool = Array.from({ length: 60 }, (_, index) => `src/${index}/${"x".repeat(random() < longOdds ? int(250, 290) : int(1, 12))}.ts`);
  const where = random() < 0.5 ? "npm test" : `npm test ${"w".repeat(int(100, 220))}`;
  const failureKeys = ["exit 1", "exit 2", "timeout", "lint", "denied", "merge", "types", "stalled"].flatMap(signal => [{ signal }, { signal, where }]);
  const textMax = pick([8, 230]);
  const text = (prefix: string) => `${prefix} ${int(0, 20)} ${pick(["", '"', "t"]).repeat(int(0, textMax))}`;
  const steps: Step[] = [];
  let cycle = 0;
  while (steps.length < count) {
    cycle += random() < 0.1 ? 2 : 1;
    const host: HostInput = {
      outcome: pick(["complete", "partial", "failed", "refused"] as const),
      changed: list(10, () => ({ path: pick(pool), op: pick(["changed", "added", "removed"] as const) })),
      read: list(5, () => pick(pool)),
      failures: list(8, () => ({ ...pick(failureKeys), class: pick(HOST_CLASSES) })),
    };
    const hostRun = must(crossing.hostDigest(host));
    const claims: ClaimInput = {
      touched: list(8, () => ({ path: pick(pool), op: pick(["read", "changed", "added", "removed"] as const), ...(random() < 0.5 ? { ids: [`id${int(0, 9)}`] } : {}) })),
      failures: list(6, () => (random() < 0.7 ? pick(failureKeys) : { signal: `member ${int(0, 9)}` })),
      decisions: list(8, () => ({ what: text("what"), why: text("why") })),
      open: list(6, () => text("open")),
      forSiblings: list(3, () => ({ note: text("note") })),
    };
    let run = must(crossing.withClaims(hostRun, claims));
    if (random() < 0.25) {
      run = {
        ...hostRun,
        touched: [...(claims.touched ?? []).map(row => ({ ...row, by: "claim" as const })), ...hostRun.touched],
        failures: [...(claims.failures ?? []).map(row => ({ ...row, class: "claim" as const, by: "claim" as const })), ...hostRun.failures],
        decisions: claims.decisions ?? [],
        open: claims.open ?? [],
      };
    }
    const receiptPaths = new Set(hostRun.touched.map(row => row.path));
    const receiptKeys = new Set(hostRun.failures.map(row => `${row.signal}|${row.where}`));
    const collisions = (claims.touched ?? []).filter(row => receiptPaths.has(row.path)).length
      + (claims.failures ?? []).filter(row => receiptKeys.has(`${row.signal}|${row.where}`)).length;
    const reviewed = random() < 0.35;
    const outsideContent = random() < 0.3;
    const facts = {
      cycle,
      status: pick(STATUSES),
      handles: { runId: runId(seed * 1000 + cycle), ...(reviewed ? { reviewedHead: sha(seed * 1000 + cycle) } : {}) },
      outsideContent,
      ...(outsideContent && random() < 0.5 ? { unclearedHead: { runId: runId(seed), head: sha(seed) } } : {}),
      ...(random() < 0.1 ? { claimsUnavailable: true } : {}),
    };
    const brief = random() < 0.5;
    const stop = { kind: "stop", blockCode: pick(["checks-failed", "unattributed-result"]), stopClass: "failed" } as const;
    const criteria = random() < 0.6 ? list(12, () => ({
      criterion: text("criterion"), status: pick(["met", "not-met", "inconclusive", "pending-owner"] as const), ...(random() < 0.5 ? { check: text("test") } : {}),
    })) : undefined;
    steps.push({
      claimed: {
        ...facts, run, ...(criteria ? { criteria } : {}),
        line: brief ? { kind: "brief", title: text("title"), expectedOutcome: text("outcome") } : stop,
      },
      erased: { ...facts, run: hostRun, line: brief ? { kind: "brief", title: "", expectedOutcome: "" } : stop },
      collisions,
    });
  }
  return steps;
}

const CAP_OF = { touched: 24, failures: 6, decisions: 6, open: 4, criteria: 8 } as const;

function trims(digest: GoalDigest, previous: GoalDigest | undefined, cycle: EndedCycle): Record<keyof typeof CAP_OF, "cap" | "bound" | "none"> {
  const received = cycle.run.omitted;
  const claims = cycle.claimsUnavailable !== true;
  const brought = {
    touched: Math.min(OMITTED_MAX, (previous?.omitted.touched ?? 0) + received.touched),
    failures: cycle.handles.reviewedHead === undefined ? received.failures : 0,
    decisions: claims ? received.decisions : 0,
    open: claims ? (received.open ?? 0) : 0,
    criteria: 0,
  };
  const keys = Object.keys(CAP_OF) as (keyof typeof CAP_OF)[];
  return Object.fromEntries(keys.map(key => [key, digest.omitted[key] <= brought[key] ? "none" : (digest[key]?.length ?? 0) === CAP_OF[key] ? "cap" : "bound"])) as Record<keyof typeof CAP_OF, "cap" | "bound" | "none">;
}

test("differential: every sequence of cycles gives the same receipt fields with its claims erased", t => {
  const seeds = Array.from({ length: 160 }, (_, index) => 310_000 + index);
  const names = ["touched cap", "failures cap", "decisions cap", "open cap", "criteria cap", "history cap", "bound with receipts", "bound with claims", "bound with history"] as const;
  const reached = Object.fromEntries(names.map(name => [name, new Set<number>()])) as Record<(typeof names)[number], Set<number>>;
  let steps = 0;
  let collisions = 0;
  for (const seed of seeds) {
    let claimed: GoalDigest | undefined;
    let erased: GoalDigest | undefined;
    for (const [index, step] of randomCycles(seed, 22).entries()) {
      const where = `seed ${seed}, cycle ${index + 1}`;
      let left: GoalDigest;
      let right: GoalDigest;
      try {
        left = valid(goal.nextGoalDigest(claimed, step.claimed), where);
        right = valid(goal.nextGoalDigest(erased, step.erased), `${where}, erased`);
      } catch (error) {
        throw new Error(`${where}: ${(error as Error).message}`);
      }
      assert.deepEqual(receiptFields(left), receiptFields(right), where);
      const [trimClaimed, trimErased] = [trims(left, claimed, step.claimed), trims(right, erased, step.erased)];
      const historyAvailable = (claimed?.history.length ?? 0) + 1;
      claimed = left;
      erased = right;
      steps += 1;
      collisions += step.collisions;
      const full: [(typeof names)[number], boolean][] = [
        ["touched cap", trimErased.touched === "cap"], ["failures cap", trimClaimed.failures === "cap"],
        ["decisions cap", trimClaimed.decisions === "cap"], ["open cap", trimClaimed.open === "cap"],
        ["criteria cap", trimClaimed.criteria === "cap"], ["history cap", left.history.length === 16 && historyAvailable > 16],
        ["bound with receipts", trimErased.touched === "bound" || trimErased.failures === "bound"],
        ["bound with claims", trimClaimed.decisions === "bound" || trimClaimed.open === "bound" || trimClaimed.criteria === "bound"],
        ["bound with history", left.history.length < Math.min(16, historyAvailable)],
      ];
      for (const [name, hit] of full) if (hit) reached[name].add(seed);
    }
  }
  t.diagnostic(`${seeds.length} seeds, ${steps} cycles, ${collisions} colliding claim rows; sequences reaching ${names.map(name => `the ${name} ${reached[name].size}`).join(", ")}`);
  assert.equal(steps, seeds.length * 22);
  for (const [name, set] of Object.entries(reached)) assert.ok(set.size >= seeds.length / 8, `only ${set.size} sequences reached the ${name}`);
  assert.ok(collisions >= seeds.length * 10, `only ${collisions} colliding claim rows`);
});

test("replay: an ended cycle applied twice gives the digest of applying it once, and an older one changes nothing", () => {
  let checks = 0;
  for (const seed of [7, 8, 9, 10]) {
    const steps = randomCycles(seed, 18);
    let digest: GoalDigest | undefined;
    for (const [index, step] of steps.entries()) {
      const where = `seed ${seed}, cycle ${index + 1}`;
      const next = valid(goal.nextGoalDigest(digest, step.claimed), where);
      assert.deepEqual(goal.nextGoalDigest(digest, step.claimed), next, `${where}: not pure`);
      assert.deepEqual(goal.nextGoalDigest(next, step.claimed), next, `${where}: replay`);
      assert.deepEqual(goal.nextGoalDigest(JSON.parse(JSON.stringify(next)) as GoalDigest, step.claimed), next, `${where}: stored replay`);
      assert.deepEqual(goal.fitGoalDigest(next), next, `${where}: refit`);
      for (const older of steps.slice(0, index)) assert.deepEqual(goal.nextGoalDigest(next, older.claimed), next, `${where}: older cycle ${older.claimed.cycle}`);
      digest = next;
      checks += 1;
    }
  }
  assert.equal(checks, 4 * 18);
});

test("counters: cycles without a line, the run digest's own counts, saturation, and the unavailable marker", () => {
  const big = { ...must(crossing.hostDigest({ outcome: "partial", read: ["a"] })), omitted: { touched: 7, decisions: 2, failures: 3, forSiblings: 1, open: 1e9 } };
  const first = valid(goal.nextGoalDigest(undefined, ended(5, big)));
  assert.deepEqual(first.omitted, { cycles: 4, touched: 7, failures: 3, decisions: 2, open: OMITTED_MAX, criteria: 0 });
  const second = valid(goal.nextGoalDigest(first, ended(8, big, { line: { kind: "stop" }, criteria: [null, { criterion: "x", status: "met" }] as CriterionInput[] })));
  assert.deepEqual(second.history.map(row => row.cycle), [5]);
  assert.deepEqual(second.omitted, { cycles: 7, touched: 14, failures: 3, decisions: 2, open: OMITTED_MAX, criteria: 1 });
  const run = must(crossing.withClaims(must(crossing.hostDigest({ outcome: "failed", read: ["b"], failures: [{ signal: "exit 1", class: "check" }] })), {
    decisions: [{ what: "w", why: "y" }], open: ["q"], failures: [{ signal: "claimed" }],
  }));
  const marked = valid(goal.nextGoalDigest(second, ended(9, run, { claimsUnavailable: true })));
  assert.equal(marked.claimsUnavailable, true);
  assert.deepEqual([marked.decisions, marked.open, marked.failures], [[], [], [{ signal: "exit 1", class: "check", by: "receipt" }]]);
  assert.deepEqual(marked.touched.map(row => row.path), ["b", "a"]);
  assert.equal(valid(goal.nextGoalDigest(marked, ended(10, run))).claimsUnavailable, undefined);
  const host = must(crossing.hostDigest({ outcome: "failed" }));
  const seven = must(crossing.withClaims(host, { failures: Array.from({ length: 7 }, (_, index) => ({ signal: `claimed ${index}` })) }));
  assert.equal(valid(goal.nextGoalDigest(undefined, ended(1, seven))).omitted.failures, 1);
  assert.equal(valid(goal.nextGoalDigest(undefined, ended(1, host))).omitted.failures, 0);
});

const deep = (() => {
  let value: unknown = {};
  for (let index = 0; index < 10_000; index += 1) value = { a: value, b: [value] };
  return value;
})();
const HUGE = "x".repeat(2_000_000);
const HOSTILE: [string, unknown][] = [
  ["undefined", undefined], ["null", null], ["zero", 0], ["negative", -1], ["fraction", 1.5], ["NaN", Number.NaN],
  ["Infinity", Infinity], ["2^53", 2 ** 53], ["text", "x"], ["empty text", ""], ["huge text", HUGE], ["true", true],
  ["empty array", []], ["array", [1, "a", null, {}]], ["empty object", {}], ["null prototype", Object.create(null)],
  ["prototype key", JSON.parse('{"__proto__":{"cycle":1,"runId":"x"}}')], ["deep", deep],
  ["controls", `${char(0x202e)}${char(0x07)}${char(0xd800)}`], ["length", { length: 3 }],
];

function richCycle(cycle: number): EndedCycle {
  const host = must(crossing.hostDigest({
    outcome: "failed", changed: [{ path: "src/a.ts", op: "added" }], read: ["src/b.ts"], failures: [{ signal: "exit 1", where: "npm test", class: "check" }],
  }));
  return ended(cycle, must(crossing.withClaims(host, { decisions: [{ what: "w", why: "y" }], open: ["q"], failures: [{ signal: "flaky" }], touched: [{ path: "src/c.ts", op: "read" }] })), {
    criteria: [{ criterion: "tests pass", status: "not-met", check: "npm test" }],
    outsideContent: true,
    unclearedHead: { runId: runId(99), head: sha(99) },
    line: { kind: "brief", title: "Title", expectedOutcome: "Outcome" },
  });
}

function replaced<T>(value: T, path: (string | number)[], next: unknown): T {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  at[path[path.length - 1]] = next;
  return copy as T;
}

test("totality: hostile values in every position refuse or build a valid digest, and never throw", () => {
  const previous = valid(goal.nextGoalDigest(undefined, richCycle(1)));
  const cycle = richCycle(2);
  const baseline = valid(goal.nextGoalDigest(previous, cycle));
  const refusing = [["cycle"], ["handles"], ["handles", "runId"], ["handles", "reviewedHead"], ["outsideContent"], ["unclearedHead"], ["unclearedHead", "head"], ["run"], ["run", "outcome"]];
  const lenient = [["status"], ["line"], ["line", "kind"], ["line", "title"], ["line", "blockCode"], ["criteria"], ["criteria", 0], ["criteria", 0, "status"],
    ["criteria", 0, "check"], ["claimsUnavailable"], ["run", "touched"], ["run", "touched", 0], ["run", "touched", 0, "path"], ["run", "failures", 0],
    ["run", "failures", 0, "class"], ["run", "decisions", 0], ["run", "open"], ["run", "open", 0], ["run", "omitted"], ["run", "omitted", "touched"]];
  const previousPositions = [["v"], ["cycle"], ["history"], ["history", 0], ["history", 0, "cycle"], ["touched", 0], ["failures"], ["omitted", "touched"], ["criteria", 0], ["handles"]];
  let calls = 0;
  const call = (label: string, run: () => GoalDigest | undefined) => {
    let result: GoalDigest | undefined;
    assert.doesNotThrow(() => { result = run(); }, label);
    if (result !== undefined) valid(result, label);
    calls += 1;
    return result;
  };
  for (const [name, value] of HOSTILE) {
    if (value !== undefined) assert.equal(call(`previous ${name}`, () => goal.nextGoalDigest(value as GoalDigest, cycle)), undefined, `previous ${name}`);
    assert.equal(call(`ended ${name}`, () => goal.nextGoalDigest(undefined, value as EndedCycle)), undefined, `ended ${name}`);
    assert.equal(call(`refit ${name}`, () => goal.fitGoalDigest(value as GoalDigest)), undefined, `refit ${name}`);
    for (const path of refusing) {
      const result = call(`${path.join(".")} = ${name}`, () => goal.nextGoalDigest(previous, replaced(cycle, path, value)));
      const same = Object.is(path.reduce<unknown>((at, key) => (at as Record<string | number, unknown>)[key], cycle), value);
      if (!same && !(value === undefined && ["unclearedHead", "handles.reviewedHead"].includes(path.join(".")))) {
        assert.equal(result, undefined, `${path.join(".")} = ${name} must refuse`);
      }
    }
    for (const path of lenient) {
      const result = call(`${path.join(".")} = ${name}`, () => goal.nextGoalDigest(previous, replaced(cycle, path, value)));
      assert.ok(result, `${path.join(".")} = ${name} must build`);
      assert.deepEqual(receiptFields(result).handles, receiptFields(baseline).handles);
    }
    for (const path of previousPositions) {
      const result = call(`previous ${path.join(".")} = ${name}`, () => goal.nextGoalDigest(replaced(previous, path, value), cycle));
      if (path[0] === "v" || path[0] === "cycle" || path[0] === "handles") assert.equal(result, undefined, `previous ${path.join(".")} = ${name} must refuse`);
      else assert.ok(result, `previous ${path.join(".")} = ${name} must build`);
    }
  }
  assert.ok(calls > HOSTILE.length * 30, `only ${calls} calls`);
  const huge = valid(goal.nextGoalDigest(previous, { ...cycle, line: { kind: "brief", title: HUGE, expectedOutcome: HUGE }, criteria: [{ criterion: HUGE, status: "met", check: HUGE }] }));
  assert.deepEqual([utf8(huge.history[0]?.line ?? ""), utf8(huge.criteria?.[0]?.criterion ?? ""), utf8(huge.criteria?.[0]?.check ?? "")], [240, 240, 120]);
  assert.equal(goal.nextGoalDigest(previous, { ...cycle, outsideContent: false }), undefined);
  assert.deepEqual(valid(goal.nextGoalDigest(previous, { ...cycle, status: "Blocked" })).history.map(row => row.cycle), [1]);
});

test("nothing else carries: extra fields on every input object never reach the digest", () => {
  const MARK = "carried-by-accident";
  const extras = { report: MARK, transcript: MARK, checkOutput: MARK, score: 0.9, rating: 5, usage: { tokens: 1 }, routing: MARK, quarantined: MARK };
  const decorate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decorate);
    if (typeof value !== "object" || value === null) return value;
    return { ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decorate(item)])), ...extras };
  };
  const previous = valid(goal.nextGoalDigest(undefined, richCycle(1)));
  const cycles = [richCycle(2), { ...richCycle(2), line: STOP }, { ...richCycle(2), handles: { runId: runId(2), reviewedHead: sha(2) } }];
  for (const cycle of cycles) {
    const plain = valid(goal.nextGoalDigest(previous, cycle));
    const decorated = valid(goal.nextGoalDigest(decorate(previous) as GoalDigest, decorate(cycle) as EndedCycle));
    assert.deepEqual(decorated, plain);
    assert.equal(JSON.stringify(decorated).includes(MARK), false);
    assert.deepEqual(valid(goal.fitGoalDigest(decorate(plain) as GoalDigest)), plain);
  }
});

test("totality: 200,000 rows in any list position build a valid digest and never throw", () => {
  const rows = 200_000;
  const make: Record<string, (index: number) => unknown> = {
    history: index => ({ cycle: rows - index, status: "blocked", line: "x" }),
    touched: index => ({ path: `p${index}`, op: "read", by: "receipt" }),
    failures: index => ({ signal: `s${index}`, class: "check", by: "receipt" }),
    decisions: index => ({ what: `w${index}`, why: "y" }),
    open: index => `q${index}`,
    criteria: index => ({ criterion: `c${index}`, status: "met" }),
  };
  const base = valid(goal.nextGoalDigest(undefined, richCycle(1)));
  const { run } = richCycle(1);
  let calls = 0;
  const call = (label: string, build: () => GoalDigest | undefined) => {
    let result: GoalDigest | undefined;
    assert.doesNotThrow(() => { result = build(); }, label);
    valid(result, label);
    calls += 1;
  };
  for (const [name, row] of Object.entries(make)) {
    const list = Array.from({ length: rows }, (_, index) => row(index));
    const previous = { ...base, cycle: rows, [name]: list } as GoalDigest;
    call(`previous ${name}, next cycle`, () => goal.nextGoalDigest(previous, richCycle(rows + 1)));
    call(`previous ${name}, replay`, () => goal.nextGoalDigest(previous, richCycle(rows)));
    call(`previous ${name}, refit`, () => goal.fitGoalDigest(previous));
    if (name === "history") continue;
    const cycle = (name === "criteria" ? { ...richCycle(2), criteria: list } : { ...richCycle(2), run: { ...run, [name]: list } }) as EndedCycle;
    call(`ended ${name}, first digest`, () => goal.nextGoalDigest(undefined, cycle));
    call(`ended ${name}, next cycle`, () => goal.nextGoalDigest(base, cycle));
  }
  assert.equal(calls, 6 * 3 + 5 * 2);
});

test("pin: outside content comes from the ended cycle alone, so a clearance turns it off", () => {
  const previous = valid(goal.nextGoalDigest(undefined, richCycle(1)));
  assert.deepEqual([previous.outsideContent, previous.unclearedHead], [true, { runId: runId(99), head: sha(99) }]);
  const { unclearedHead: _, ...cleared } = richCycle(2);
  const next = valid(goal.nextGoalDigest(previous, { ...cleared, outsideContent: false }));
  assert.equal(next.outsideContent, false);
  assert.equal(Object.hasOwn(next, "unclearedHead"), false);
});

test("pin: a stop line holds codes only and a brief line text only; otherwise the cycle has no line", () => {
  const previous = valid(goal.nextGoalDigest(undefined, richCycle(1)));
  const lines = [
    { kind: "stop", blockCode: "Checks failed" }, { kind: "stop", stopClass: "failed; see the report" }, { kind: "stop", blockCode: 7 },
    { kind: "brief", title: 7, expectedOutcome: "done" }, { kind: "brief", title: "Title", expectedOutcome: null },
  ] as unknown as HistoryLineInput[];
  for (const line of lines) {
    const digest = valid(goal.nextGoalDigest(previous, { ...richCycle(2), line }), JSON.stringify(line));
    assert.deepEqual([digest.history.map(row => row.cycle), digest.omitted.cycles], [[1], 1], JSON.stringify(line));
  }
  const coded = valid(goal.nextGoalDigest(previous, { ...richCycle(2), line: { kind: "stop", blockCode: "checks-failed" } }));
  assert.deepEqual(coded.history[0], { cycle: 2, status: "blocked", line: "block checks-failed" });
});

test("pin: a claim failure with a receipt's signal and place is dropped, and the receipts keep their order", () => {
  const run: CrossingDigest = {
    ...must(crossing.hostDigest({ outcome: "failed" })),
    failures: [
      { signal: "exit 1", where: "npm test", class: "claim", by: "claim" },
      { signal: "lint", class: "check", by: "receipt" },
      { signal: "exit 1", where: "npm test", class: "check", by: "receipt" },
      { signal: "flaky", class: "claim", by: "claim" },
    ],
  };
  assert.deepEqual(valid(goal.nextGoalDigest(undefined, ended(1, run))).failures, [
    { signal: "lint", class: "check", by: "receipt" },
    { signal: "exit 1", where: "npm test", class: "check", by: "receipt" },
    { signal: "flaky", class: "claim", by: "claim" },
  ]);
});

test("pin: a replayed cycle returns the refitted digest, never the stored object", () => {
  const digest = valid(goal.nextGoalDigest(undefined, richCycle(1)));
  const stored = { ...digest, extra: "written by an older host", omitted: { ...digest.omitted, extra: 1 } } as GoalDigest;
  const replayed = valid(goal.nextGoalDigest(stored, richCycle(1)));
  assert.deepEqual(replayed, digest);
  assert.notEqual(replayed, stored);
});

test("pin: omitted.cycles saturates at 9,999", () => {
  const digest = valid(goal.nextGoalDigest(undefined, ended(10_001, must(crossing.hostDigest({ outcome: "failed" })))));
  assert.deepEqual([digest.history.length, digest.omitted.cycles], [1, OMITTED_MAX]);
});

test("pin: a criterion and its check label are normalized by the text rule", () => {
  const raw = ["a", char(0x200e), "b", char(0x2028), "c", char(0x202e), "d"].join("");
  const escape = (code: number) => `${char(0x5c)}u{${code.toString(16)}}`;
  const expected = ["a", escape(0x200e), "b", char(0x0a), "c", escape(0x202e), "d"].join("");
  const digest = valid(goal.nextGoalDigest(undefined, { ...richCycle(1), criteria: [{ criterion: raw, status: "met", check: raw }] }));
  assert.deepEqual(digest.criteria, [{ criterion: expected, status: "met", check: expected }]);
});
