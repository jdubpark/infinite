import test from "node:test";
import assert from "node:assert/strict";
import {
  holdUntil,
  landedIds,
  matchLandings,
  matchReverts,
  parseCommits,
  parseIds,
  revertPattern,
  windowCoverage,
  type LandedRun,
  type ScanCommit,
} from "../packages/host/src/outcome-hold.js";
import type { ScanPoint } from "../packages/host/src/outcome-rules.js";

const H = "2026-12-13T00:00:00.000Z";
const HOUR = 3_600_000;

function point(checkedAt: string, overrides: Partial<ScanPoint> = {}): ScanPoint {
  return { seq: 1, at: checkedAt, checkedAt, gap: null, ...overrides };
}

const hex40 = (c: string) => c.repeat(40);
const hex64 = (c: string) => c.repeat(64);

test("the match rules", () => {
  const commits: ScanCommit[] = [{ id: "M", tree: "T1", parents: ["P", "H"] }];

  assert.deepEqual(
    matchLandings(commits, [{ runId: "r", mergeCommit: "M" }]).map((l) => [l.method, l.commit]),
    [["merge-commit", "M"]],
  );
  assert.deepEqual(
    matchLandings(commits, [{ runId: "r", reviewedHead: "H" }]).map((l) => [l.method, l.commit]),
    [["merge-parent", "M"]],
  );
  assert.deepEqual(
    matchLandings(commits, [{ runId: "r", reviewedTree: "T1" }]).map((l) => [l.method, l.commit]),
    [["tree-equal", "M"]],
  );
  assert.deepEqual(
    matchLandings(commits, [{ runId: "r", mergeCommit: "M", reviewedTree: "T1" }]).map((l) => l.method),
    ["merge-commit"],
  );

  const sequence: ScanCommit[] = [
    { id: "c0", tree: "X", parents: [] },
    { id: "c1", tree: "T", parents: [] },
    { id: "c2", tree: "Y", parents: [] },
    { id: "c3", tree: "T", parents: [] },
  ];
  const first = matchLandings(sequence, [{ runId: "r", reviewedTree: "T" }]);
  assert.equal(first.length, 1);
  assert.equal(first[0].position, 1);
  assert.equal(first[0].commit, "c1");

  assert.equal(
    matchLandings(commits, [
      { runId: "a", mergeCommit: "M" },
      { runId: "b", mergeCommit: "M" },
    ]).length,
    2,
  );

  assert.deepEqual(matchLandings(commits, [{ runId: "r" }]), []);
  assert.deepEqual(
    matchLandings([{ id: "M", tree: "T1", parents: ["H", "P"] }], [{ runId: "r", reviewedHead: "H" }]),
    [],
  );
});

test("a tree match needs the base before it", () => {
  const commits: ScanCommit[] = [
    { id: "c0", tree: "T", parents: [] },
    { id: "c1", tree: "X", parents: ["c0"] },
    { id: "c2", tree: "T", parents: ["c1"] },
  ];
  const afterBase = matchLandings(commits, [{ runId: "r", reviewedTree: "T", base: "c1" }]);
  assert.deepEqual(afterBase.map(l => [l.commit, l.position, l.method]), [["c2", 2, "tree-equal"]]);
  assert.deepEqual(matchLandings(commits, [{ runId: "r", reviewedTree: "T", base: "c1" }], true).map(l => l.commit), ["c2"]);

  const unknownBase = [{ runId: "r", reviewedTree: "T", base: "zz" }];
  assert.deepEqual(matchLandings(commits, unknownBase).map(l => l.commit), ["c0"]);
  assert.deepEqual(matchLandings(commits, unknownBase, true), []);
  assert.deepEqual(matchLandings(commits, [{ runId: "r", reviewedTree: "T" }], true), []);

  assert.deepEqual(
    matchLandings(commits, [{ runId: "r", reviewedHead: "c2", reviewedTree: "T", base: "zz" }], true).map(l => [l.commit, l.method]),
    [["c2", "tree-equal"]],
  );

  const empty = { runId: "r", reviewedHead: "c1", reviewedTree: "X", base: "c1", mergeCommit: "c2" };
  assert.deepEqual(matchLandings(commits, [empty]), []);
  assert.deepEqual(matchLandings(commits, [empty], true), []);

  const merge: ScanCommit[] = [{ id: "M", tree: "Z", parents: ["P", "H"] }];
  assert.deepEqual(matchLandings(merge, [{ runId: "r", reviewedHead: "H", base: "zz" }], true).map(l => l.method), ["merge-parent"]);
  assert.deepEqual(matchLandings(merge, [{ runId: "r", mergeCommit: "M", base: "zz" }], true).map(l => l.method), ["merge-commit"]);
});

test("landed ids", () => {
  assert.deepEqual(landedIds("merge-parent", "C", "H"), ["C", "H"]);
  assert.deepEqual(landedIds("merge-commit", "C"), ["C"]);
  assert.deepEqual(landedIds("tree-equal", "C"), ["C"]);
  assert.deepEqual(landedIds("merge-parent", "C", "C"), ["C"]);
});

test("reverts follow their landing", () => {
  const commits: ScanCommit[] = ["c0", "c1", "c2", "c3"].map((id) => ({ id, tree: "t", parents: [] }));
  const hitsAt = (ids: string[], commit: string) =>
    new Map(ids.map((id) => [id, new Set([commit])] as const));

  const earlier: LandedRun = { runId: "r", signalId: "s1", commit: "L", ids: ["L"], holdUntil: H };
  const earlierMatches = matchReverts(commits, [earlier], hitsAt(["L"], "c0"), "2026-12-01T00:00:00.000Z");
  assert.equal(earlierMatches.length, 1);
  assert.equal(earlierMatches[0].commit, "c0");

  const sameScan: LandedRun = { runId: "r", signalId: "s2", commit: "L", ids: ["L"], holdUntil: H, position: 2 };
  const hits = new Map([["L", new Set(["c1", "c3"])]]);
  const sameMatches = matchReverts(commits, [sameScan], hits, "2026-12-01T00:00:00.000Z");
  assert.deepEqual(
    sameMatches.map((m) => m.commit),
    ["c3"],
  );

  const expired: LandedRun = { runId: "r", signalId: "s3", commit: "L", ids: ["L"], holdUntil: H };
  assert.deepEqual(matchReverts(commits, [expired], hitsAt(["L"], "c0"), "2026-12-13T00:00:00.001Z"), []);

  const twoIds: LandedRun = { runId: "r", signalId: "s4", commit: "L1", ids: ["L1", "L2"], holdUntil: H };
  const both = new Map([
    ["L1", new Set(["c0"])],
    ["L2", new Set(["c0"])],
  ]);
  assert.equal(matchReverts(commits, [twoIds], both, "2026-12-01T00:00:00.000Z").length, 1);

  const reread: LandedRun = { runId: "r", signalId: "s5", commit: "c2", ids: ["c2", "head"], holdUntil: H };
  const named = new Map([["head", new Set(["c1", "c3"])]]);
  assert.deepEqual(matchReverts(commits, [reread], named, "2026-12-01T00:00:00.000Z", true).map((m) => m.commit), ["c3"]);
  const absent: LandedRun = { ...reread, commit: "gone", ids: ["gone", "head"] };
  assert.deepEqual(matchReverts(commits, [absent], named, "2026-12-01T00:00:00.000Z", true), []);
  assert.deepEqual(matchReverts(commits, [reread], named, "2026-12-01T00:00:00.000Z").map((m) => m.commit), ["c3"]);
  assert.deepEqual(matchReverts(commits, [{ ...absent, unsure: true }], named, "2026-12-01T00:00:00.000Z"), []);
  assert.deepEqual(matchReverts(commits, [absent], named, "2026-12-01T00:00:00.000Z").map((m) => m.commit), ["c1", "c3"]);
  assert.deepEqual(matchReverts(commits, [{ ...reread, position: 2 }], named, "2026-12-01T00:00:00.000Z", true).map((m) => m.commit), ["c3"]);
});

test("window coverage", () => {
  assert.equal(windowCoverage({ gapInside: true }, H), "gap");

  assert.equal(windowCoverage({ last: point(H), gapInside: false }, H), "covered");

  assert.equal(windowCoverage({ last: point(new Date(Date.parse(H) - 1).toISOString()), gapInside: false }, H), "open");

  const last = point(new Date(Date.parse(H) - 5 * HOUR).toISOString());
  const nextAt = new Date(Date.parse(H) + HOUR).toISOString();
  assert.equal(windowCoverage({ last, next: point(nextAt), gapInside: false }, H), "covered");
  const lastLate = point(new Date(Date.parse(H) - 5 * HOUR - 1).toISOString());
  assert.equal(windowCoverage({ last: lastLate, next: point(nextAt), gapInside: false }, H), "gap");

  const lastHour = point(new Date(Date.parse(H) - HOUR).toISOString());
  assert.equal(
    windowCoverage({ last: lastHour, next: point(nextAt, { gap: "bound" }), gapInside: false }, H),
    "gap",
  );
});

test("the hold window adds whole days", () => {
  assert.equal(holdUntil("2026-11-13T00:00:00.000Z", 30), "2026-12-13T00:00:00.000Z");
});

test("parsers are strict", () => {
  assert.equal(parseIds(`${hex40("a").slice(1)}\n`, 2), undefined);
  assert.equal(parseIds(`${hex40("A")}\n`, 2), undefined);
  assert.equal(parseIds(`${hex40("a")}\n${hex40("b")}\n${hex40("c")}\n`, 2), undefined);
  assert.deepEqual(parseIds("", 2), []);
  assert.deepEqual(parseIds(`${hex40("a")}\n`, 2), [hex40("a")]);
  assert.equal(parseIds(hex40("a"), 2), undefined);
  assert.equal(parseIds(`${hex40("a")}\n${hex64("b")}\n`, 2), undefined);
  assert.equal(parseIds(`${hex40("a")}\n\n`, 2), undefined);

  const A = hex40("a");
  const B = hex40("b");
  const T = hex40("1");
  assert.equal(parseCommits(`${B} ${T}\n${A} ${T}\n`, [A, B]), undefined);
  assert.equal(parseCommits(`${A} ${T}\n`, [A, B]), undefined);
  assert.equal(parseCommits(`${A} zz\n`, [A]), undefined);
  assert.deepEqual(parseCommits(`${A} ${T} \n`, [A]), [{ id: A, tree: T, parents: [] }]);

  const C = hex64("c");
  const D = hex64("d");
  const E = hex64("e");
  assert.deepEqual(parseCommits(`${C} ${D} ${E}\n`, [C]), [{ id: C, tree: D, parents: [E] }]);
  assert.equal(parseCommits(`${A} ${T} ${B} \n`, [A]), undefined);
  assert.equal(parseCommits(`${A} ${T}`, [A]), undefined);
  assert.equal(parseCommits(`${A} ${D}\n`, [A]), undefined);
  assert.deepEqual(parseCommits(`${A} ${T} ${B}\n${B} ${T} \n`, [A, B]), [{ id: A, tree: T, parents: [B] }, { id: B, tree: T, parents: [] }]);
});

test("revert pattern is the literal message text", () => {
  assert.equal(revertPattern(hex40("a")), `This reverts commit ${hex40("a")}`);
});
