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
  // Rules 1 and 3 match the same commit: rule 1 names the method.
  assert.deepEqual(
    matchLandings(commits, [{ runId: "r", mergeCommit: "M", reviewedTree: "T1" }]).map((l) => l.method),
    ["merge-commit"],
  );

  // Matches at positions 1 and 3: the run lands at position 1 only.
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

  // Two runs on one commit: two landings.
  assert.equal(
    matchLandings(commits, [
      { runId: "a", mergeCommit: "M" },
      { runId: "b", mergeCommit: "M" },
    ]).length,
    2,
  );

  // No field matches nothing; a first parent equal to the head is not rule 2.
  assert.deepEqual(matchLandings(commits, [{ runId: "r" }]), []);
  assert.deepEqual(
    matchLandings([{ id: "M", tree: "T1", parents: ["H", "P"] }], [{ runId: "r", reviewedHead: "H" }]),
    [],
  );
});

test("a tree match needs the base before it", () => {
  // The tree T recurs: c0 has it before the run's base c1, and c2 has it after.
  const commits: ScanCommit[] = [
    { id: "c0", tree: "T", parents: [] },
    { id: "c1", tree: "X", parents: ["c0"] },
    { id: "c2", tree: "T", parents: ["c1"] },
  ];
  const afterBase = matchLandings(commits, [{ runId: "r", reviewedTree: "T", base: "c1" }]);
  assert.deepEqual(afterBase.map(l => [l.commit, l.position, l.method]), [["c2", 2, "tree-equal"]]);
  // The same holds in a scan of older history, because the base is in the list.
  assert.deepEqual(matchLandings(commits, [{ runId: "r", reviewedTree: "T", base: "c1" }], true).map(l => l.commit), ["c2"]);

  // The base is not in the list. A scan of new commits only takes the first match; a scan of older history takes none.
  const unknownBase = [{ runId: "r", reviewedTree: "T", base: "zz" }];
  assert.deepEqual(matchLandings(commits, unknownBase).map(l => l.commit), ["c0"]);
  assert.deepEqual(matchLandings(commits, unknownBase, true), []);
  assert.deepEqual(matchLandings(commits, [{ runId: "r", reviewedTree: "T" }], true), []);

  // The reviewed head itself always counts: a fast-forward cannot be older than the run.
  assert.deepEqual(
    matchLandings(commits, [{ runId: "r", reviewedHead: "c2", reviewedTree: "T", base: "zz" }], true).map(l => [l.commit, l.method]),
    [["c2", "tree-equal"]],
  );

  // A run whose reviewed head is its base changed nothing: it lands by no rule.
  const empty = { runId: "r", reviewedHead: "c1", reviewedTree: "X", base: "c1", mergeCommit: "c2" };
  assert.deepEqual(matchLandings(commits, [empty]), []);
  assert.deepEqual(matchLandings(commits, [empty], true), []);

  // Rules 1 and 2 need no base.
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

  // A landing of an earlier scan, with a hit at position 0.
  const earlier: LandedRun = { runId: "r", signalId: "s1", ids: ["L"], holdUntil: H };
  const earlierMatches = matchReverts(commits, [earlier], hitsAt(["L"], "c0"), "2026-12-01T00:00:00.000Z");
  assert.equal(earlierMatches.length, 1);
  assert.equal(earlierMatches[0].commit, "c0");

  // A landing at position 2 of this scan, with hits at positions 1 and 3.
  const sameScan: LandedRun = { runId: "r", signalId: "s2", ids: ["L"], holdUntil: H, position: 2 };
  const hits = new Map([["L", new Set(["c1", "c3"])]]);
  const sameMatches = matchReverts(commits, [sameScan], hits, "2026-12-01T00:00:00.000Z");
  assert.deepEqual(
    sameMatches.map((m) => m.commit),
    ["c3"],
  );

  // holdUntil one millisecond before the time of the scan: no match.
  const expired: LandedRun = { runId: "r", signalId: "s3", ids: ["L"], holdUntil: H };
  assert.deepEqual(matchReverts(commits, [expired], hitsAt(["L"], "c0"), "2026-12-13T00:00:00.001Z"), []);

  // Two ids of one run naming one commit: one match.
  const twoIds: LandedRun = { runId: "r", signalId: "s4", ids: ["L1", "L2"], holdUntil: H };
  const both = new Map([
    ["L1", new Set(["c0"])],
    ["L2", new Set(["c0"])],
  ]);
  assert.equal(matchReverts(commits, [twoIds], both, "2026-12-01T00:00:00.000Z").length, 1);
});

test("window coverage", () => {
  // A gap scan inside the window.
  assert.equal(windowCoverage({ gapInside: true }, H), "gap");

  // The newest scan at or before the close saw the close: covered.
  assert.equal(windowCoverage({ last: point(H), gapInside: false }, H), "covered");

  // One millisecond short of the close, with no later scan: open.
  assert.equal(windowCoverage({ last: point(new Date(Date.parse(H) - 1).toISOString()), gapInside: false }, H), "open");

  // The next scan is six hours after the last one: covered; one millisecond more: gap.
  const last = point(new Date(Date.parse(H) - 5 * HOUR).toISOString());
  const nextAt = new Date(Date.parse(H) + HOUR).toISOString();
  assert.equal(windowCoverage({ last, next: point(nextAt), gapInside: false }, H), "covered");
  const lastLate = point(new Date(Date.parse(H) - 5 * HOUR - 1).toISOString());
  assert.equal(windowCoverage({ last: lastLate, next: point(nextAt), gapInside: false }, H), "gap");

  // A next scan that records a gap: gap.
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
  // parseIds
  assert.equal(parseIds(`${hex40("a").slice(1)}\n`, 2), undefined);
  assert.equal(parseIds(`${hex40("A")}\n`, 2), undefined);
  assert.equal(parseIds(`${hex40("a")}\n${hex40("b")}\n${hex40("c")}\n`, 2), undefined);
  assert.deepEqual(parseIds("", 2), []);
  assert.deepEqual(parseIds(`${hex40("a")}\n`, 2), [hex40("a")]);
  // Git ends every line with a newline, and one repository has ids of one length.
  assert.equal(parseIds(hex40("a"), 2), undefined);
  assert.equal(parseIds(`${hex40("a")}\n${hex64("b")}\n`, 2), undefined);
  assert.equal(parseIds(`${hex40("a")}\n\n`, 2), undefined);

  // parseCommits
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
  // Only a root line ends with a space. A missing final newline, or a tree of another length, is not Git's output.
  assert.equal(parseCommits(`${A} ${T} ${B} \n`, [A]), undefined);
  assert.equal(parseCommits(`${A} ${T}`, [A]), undefined);
  assert.equal(parseCommits(`${A} ${D}\n`, [A]), undefined);
  assert.deepEqual(parseCommits(`${A} ${T} ${B}\n${B} ${T} \n`, [A, B]), [{ id: A, tree: T, parents: [B] }, { id: B, tree: T, parents: [] }]);
});

test("revert pattern is the literal message text", () => {
  assert.equal(revertPattern(hex40("a")), `This reverts commit ${hex40("a")}`);
});
