import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { choose, screen, type Choice, type Scored } from "../packages/host/src/routing-choice.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { guardExploration, shareAllows } from "../packages/host/src/routing-guards.js";
import type { Beta, ExploreGuards, ProfilePosterior, RoutingKnobs } from "../packages/host/src/routing-types.js";
import type { TeamLineup, TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Provider } from "../packages/host/src/types.js";
import { mixedLineup } from "./team-fixture.js";

const knobs = (over: Partial<RoutingKnobs> = {}): RoutingKnobs => ({ ...ROUTING_DEFAULTS, ...over });
const beta = (a: number, b: number): Beta => ({ a, b });
const codex = (id: string, model: string): TeamModelProfile => ({ id, label: id, provider: "codex", model, effort: "high" });
const lineupWith = (implementers: TeamModelProfile[]): TeamLineup => ({ ...mixedLineup, implementers });
const OPEN: ExploreGuards = { pausedAt: null, spareAttempts: 10, share: { exploratory: 0, of: 40 } };
const EXPLORE_KNOBS = knobs({ minSpareAttempts: 4, maxExploreShare: 0.2 });

function posterior(theta: Beta, phi: Beta): ProfilePosterior {
  return { reward: [], rescue: [], theta, phi, rows: { production: 0, duel: 0 }, earlierRows: 0, level: "none", untimed: 0 };
}

function unit(key: string): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
}

function twoEqual(): { screened: ReturnType<typeof screen>; scored: Map<string, Scored> } {
  const lineup = lineupWith([codex("p1", "m1"), codex("p2", "m2")]);
  const screened = screen(lineup, EXPLORE_KNOBS, new Set<Provider>());
  const scored = new Map<string, Scored>();
  for (const item of screened) scored.set(item.identity, { profile: item.profile, identity: item.identity, posterior: posterior(beta(1, 1), beta(1, 1)), costUsd: 0.4 });
  return { screened, scored };
}

test("paused, low budget, and elevated risk never explore over 1,000 seeds", () => {
  const { screened, scored } = twoEqual();
  let explored = 0;
  for (let i = 0; i < 1000; i += 1) {
    const choice = choose(screened, scored, EXPLORE_KNOBS, "normal", `seed-${i}`)!;
    if (choice.explore) explored += 1;
    const paused = guardExploration(choice, { ...OPEN, pausedAt: "2026-11-15T00:00:00.000Z" }, EXPLORE_KNOBS);
    assert.equal(paused.explore, false);
    if (choice.explore) {
      assert.equal(paused.basis, "greedy-paused");
      assert.equal(paused.chosen, choice.greedy);
    }
    const low = guardExploration(choice, { ...OPEN, spareAttempts: 3 }, EXPLORE_KNOBS);
    assert.equal(low.explore, false);
    if (choice.explore) assert.equal(low.basis, "greedy-budget");
    const allGuards = guardExploration(choice, { ...OPEN, pausedAt: "2026-11-15T00:00:00.000Z", spareAttempts: 3 }, EXPLORE_KNOBS);
    if (choice.explore) assert.equal(allGuards.basis, "greedy-paused");
  }
  assert.ok(explored > 100, `explored ${explored} of 1,000 unguarded`);

  let allowed = 0;
  for (let i = 0; i < 1000; i += 1) {
    const choice = choose(screened, scored, EXPLORE_KNOBS, "normal", `seed-${i}`)!;
    const guarded = guardExploration(choice, { ...OPEN, spareAttempts: 4 }, EXPLORE_KNOBS);
    if (guarded.explore) allowed += 1;
  }
  assert.ok(allowed > 100, `allowed ${allowed} of 1,000 at the minimum budget`);

  for (let i = 0; i < 1000; i += 1) {
    const choice = choose(screened, scored, EXPLORE_KNOBS, "elevated", `seed-${i}`)!;
    assert.equal(choice.basis, "greedy-risk");
    assert.equal(guardExploration(choice, OPEN, EXPLORE_KNOBS).explore, false);
  }
});

test("a choice that does not explore is returned unchanged, and the guards do not read it", () => {
  const greedy: Choice = { basis: "sampled", chosen: "p1", greedy: "p1", explore: false, candidates: [] };
  assert.equal(guardExploration(greedy, { ...OPEN, pausedAt: "2026-11-15T00:00:00.000Z" }, EXPLORE_KNOBS), greedy);
  const single: Choice = { basis: "single-candidate", chosen: "p1", greedy: "p1", explore: false, candidates: [] };
  assert.equal(guardExploration(single, OPEN, EXPLORE_KNOBS), single);
});

test("guardExploration checks pause, then budget, then headroom, then share", () => {
  const explore: Choice = { basis: "sampled", chosen: "p2", greedy: "p1", explore: true, candidates: [] };
  const share = { exploratory: 9, of: 40 };
  const all = guardExploration(explore, { pausedAt: "x", spareAttempts: 0, nearLimit: true, share }, EXPLORE_KNOBS);
  assert.equal(all.basis, "greedy-paused");
  assert.equal(guardExploration(explore, { pausedAt: null, spareAttempts: 0, nearLimit: true, share }, EXPLORE_KNOBS).basis, "greedy-budget");
  const near = guardExploration(explore, { pausedAt: null, spareAttempts: 4, nearLimit: true, share }, EXPLORE_KNOBS);
  assert.equal(near.basis, "greedy-headroom");
  assert.equal(near.chosen, "p1");
  assert.equal(near.explore, false);
  assert.equal(guardExploration(explore, { pausedAt: null, spareAttempts: 4, nearLimit: false, share }, EXPLORE_KNOBS).basis, "greedy-share");
  const allowed = guardExploration(explore, { pausedAt: null, spareAttempts: 4, nearLimit: false, share: { exploratory: 0, of: 4 } }, EXPLORE_KNOBS);
  assert.equal(allowed, explore);
});

test("the share holds at every exploratory start for any interleaving, and a released row frees its place", () => {
  assert.equal(shareAllows({ exploratory: 0, of: 4 }, 0.2), true);
  assert.equal(shareAllows({ exploratory: 0, of: 3 }, 0.2), false);
  assert.equal(shareAllows({ exploratory: 9, of: 49 }, 0.2), true);
  assert.equal(shareAllows({ exploratory: 10, of: 49 }, 0.2), false);
  assert.equal(shareAllows({ exploratory: 0, of: 0 }, 0), false);
  assert.equal(shareAllows({ exploratory: 0, of: 1000 }, 0), false);

  const twelve = Array.from({ length: 12 }, (_, index) => index < 2);
  assert.equal(shareAllows({ exploratory: twelve.slice(0, 9).filter(Boolean).length, of: 9 }, 0.2), false);
  assert.equal(shareAllows({ exploratory: twelve.slice(1, 10).filter(Boolean).length, of: 9 }, 0.2), true);

  const WINDOW = 20;
  for (let seed = 0; seed < 1000; seed += 1) {
    type Row = { explore: boolean; state: "pending" | "applied" | "released" };
    const rows: Row[] = [];
    const counted = (): Row[] => rows.filter(row => row.state !== "released");
    for (let step = 0; step < 300; step += 1) {
      const action = unit(`action-${seed}-${step}`);
      const live = counted();
      if (action < 0.6 || live.length === 0) {
        const before = live.slice(-(WINDOW - 1));
        const share = { exploratory: before.filter(row => row.explore).length, of: before.length };
        const proposed: Choice = { basis: "sampled", chosen: "p2", greedy: "p1", explore: unit(`propose-${seed}-${step}`) < 0.5, candidates: [] };
        const guarded = guardExploration(proposed, { pausedAt: null, spareAttempts: 10, share }, EXPLORE_KNOBS);
        rows.push({ explore: guarded.explore, state: "pending" });
        if (guarded.explore) {
          const window = counted().slice(-WINDOW);
          const explorations = window.filter(row => row.explore).length;
          assert.ok(explorations <= 0.2 * window.length + 1e-9, `seed ${seed} step ${step}: ${explorations} of ${window.length}`);
        }
      } else if (action < 0.8) {
        const pending = rows.find(row => row.state === "pending");
        if (pending) pending.state = "applied";
      } else {
        const victim = live[Math.floor(unit(`victim-${seed}-${step}`) * live.length)];
        victim!.state = "released";
      }
    }
  }
});
