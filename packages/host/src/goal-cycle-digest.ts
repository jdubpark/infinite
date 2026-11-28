import { emptyDigest, hostDigest, withClaims, type ClaimInput, type CrossingDigest } from "./crossing-digest.js";
import { nextGoalDigest, type CriterionInput, type GoalDigest, type HistoryLineInput } from "./goal-digest.js";
import { isReviewed, maxPreviousWork } from "./goal-standing.js";
import type { GoalCycle, ProductGoal } from "./goal-types.js";
import { emptyRollup, type StoredRollup } from "./team-usage.js";
import { decisionAuthorityQuestion, type TeamView } from "./team-types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEAD_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PREVIOUS_WORK_CHARS = 2000;

function safeCodePointTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > maxChars) break;
    out += ch;
  }
  const trimmed = out.replace(/\s+\S*$/, "").trimEnd();
  return trimmed.length > 0 ? trimmed : out;
}

function fitCarryForwardSections(header: string, groups: { prefix: string; items: string[]; separator: string }[]): string {
  const lines: string[] = [header];
  let currentLength = header.length;
  for (const group of groups) {
    if (!group.items.length) continue;
    const fullLine = `${group.prefix}${group.items.join(group.separator)}`;
    if (currentLength + 1 + fullLine.length <= MAX_PREVIOUS_WORK_CHARS) {
      lines.push(fullLine);
      currentLength += 1 + fullLine.length;
      continue;
    }
    let partial = group.prefix;
    let added = 0;
    for (const item of group.items) {
      const piece = added === 0 ? item : `${group.separator}${item}`;
      if (currentLength + 1 + partial.length + piece.length > MAX_PREVIOUS_WORK_CHARS) break;
      partial += piece;
      added++;
    }
    if (added > 0) lines.push(partial);
    break;
  }
  return lines.length > 1 ? lines.join("\n") : safeCodePointTruncate(header, MAX_PREVIOUS_WORK_CHARS);
}

export function snapshotRollup(cycle: GoalCycle): StoredRollup {
  const snapshot = cycle.usage;
  if (snapshot?.total && snapshot.byProfile && snapshot.byProvider && Number.isInteger(snapshot.unmeasuredMembers))
    return { total: snapshot.total, byProfile: snapshot.byProfile, byProvider: snapshot.byProvider, unmeasuredMembers: snapshot.unmeasuredMembers };
  const rollup = emptyRollup(cycle.memberCount);
  if (snapshot) rollup.total = { cost: snapshot.cost, tokens: snapshot.tokens, messages: snapshot.messages, pricing: { ...snapshot.pricing, catalog: snapshot.pricing.catalog ?? 0 } };
  return rollup;
}

function normalizeCode(raw: string | undefined): string {
  const cleaned = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return "";
  return (/^[a-z]/.test(cleaned) ? cleaned : `s-${cleaned}`).slice(0, 64);
}

function safeRepoReadPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("://")) return false;
  return !value.split("/").includes("..");
}

function changeOp(status: "added" | "modified" | "removed" | "renamed"): "added" | "removed" | "changed" {
  if (status === "added") return "added";
  if (status === "removed") return "removed";
  return "changed";
}

function cycleOutcome(status: string): CrossingDigest["outcome"] {
  if (status === "ready-for-review" || status === "merged" || status === "no-change") return "complete";
  if (status === "blocked") return "failed";
  return "partial";
}

export function buildCrossingDigest(cycle: GoalCycle, team?: TeamView): CrossingDigest {
  const status = team?.status ?? cycle.status;
  const outcome = cycleOutcome(status);
  const changed = team?.changes?.files?.length
    ? team.changes.files.map(file => ({ path: file.path, op: changeOp(file.status) }))
    : [...new Set((team?.tasks ?? []).flatMap(task => task.changedPaths?.paths ?? []))].map(path => ({ path, op: "changed" as const }));
  const readSources = [
    ...(team?.discovery?.tasks ?? []).flatMap(task => (task.evidence ?? []).map(item => item.source)),
    ...(team?.noChange?.evidence ?? []).map(item => item.source),
  ].filter(safeRepoReadPath);
  const read = [...new Set(readSources)];
  const failures: NonNullable<Parameters<typeof hostDigest>[0]["failures"]> = [];
  for (const check of team?.checks ?? []) {
    if (check.status !== "failed" && check.status !== "interrupted") continue;
    const commandText = [check.command.command, ...check.command.args].join(" ");
    failures.push({
      signal: `${commandText} (${check.status})`,
      where: commandText,
      class: "check",
    });
  }
  if (team?.blockCode || team?.stopReason || cycle.deadlineStop || status === "blocked") {
    failures.push({
      signal: team?.reason ?? cycle.reason ?? team?.blockCode ?? team?.stopReason ?? "cycle stopped",
      where: `cycle-${cycle.cycle}`,
      class: team?.stopReason || cycle.deadlineStop ? "stop" : "refusal",
    });
  }
  const base = hostDigest({ outcome, changed, read, failures }) ?? emptyDigest("partial")!;
  const decisions = (team?.decisions ?? [])
    .filter(item => item.answer && item.revision === (team?.revision ?? item.revision))
    .map(item => ({ what: decisionAuthorityQuestion(item), why: item.answer! }));
  const open = [
    ...(team?.decisions ?? []).filter(item => !item.answer).map(item => `Open decision: ${decisionAuthorityQuestion(item)}`),
    ...(team?.review?.verdict === "changes-requested" ? [`Review changes requested: ${team.review.summary}`] : []),
  ];
  if (!decisions.length && !open.length) return base;
  const claims: ClaimInput = {
    ...(decisions.length ? { decisions } : {}),
    ...(open.length ? { open } : {}),
  };
  return withClaims(base, claims) ?? base;
}

export function advanceGoalDigest(goal: ProductGoal, cycle: GoalCycle, team?: TeamView): GoalDigest | undefined {
  if (!UUID_RE.test(cycle.teamId)) return undefined;
  const run = buildCrossingDigest(cycle, team);
  const reviewed = isReviewed(cycle);
  const rawHead = team?.headCommit ?? cycle.headCommit;
  const reviewedHead = reviewed && rawHead && HEAD_RE.test(rawHead) ? rawHead : undefined;
  const status = normalizeCode(team?.status ?? cycle.status) || "settled";
  const blockCode = normalizeCode(team?.blockCode);
  const line: HistoryLineInput = cycle.brief
    ? { kind: "brief", title: cycle.brief.title, expectedOutcome: cycle.brief.expectedOutcome }
    : {
        kind: "stop",
        ...(blockCode ? { blockCode } : {}),
        stopClass: normalizeCode(team?.stopReason ?? cycle.class ?? cycle.status) || "settled",
      };
  const criteria: CriterionInput[] | undefined = cycle.assessment
    ? cycle.assessment.criteria.map(item => ({ criterion: item.id, status: item.state }))
    : undefined;
  return nextGoalDigest(goal.digest, {
    cycle: cycle.cycle,
    status,
    line,
    run,
    ...(criteria ? { criteria } : {}),
    handles: {
      runId: cycle.teamId,
      ...(reviewedHead ? { reviewedHead } : {}),
    },
    outsideContent: false,
  });
}

export function formatPreviousWork(goal: ProductGoal): string[] {
  const reviewedCycles = goal.cycles.filter(isReviewed).slice(-maxPreviousWork);
  const reviewedEntries = reviewedCycles.map(value =>
    safeCodePointTruncate(`${value.brief?.title ?? `Feature ${value.cycle}`}: ${value.brief?.expectedOutcome ?? "Reviewed change"}`, MAX_PREVIOUS_WORK_CHARS),
  );
  const digest = goal.digest;
  if (!digest) return reviewedEntries;

  const reviewedNums = new Set(reviewedCycles.map(cycle => cycle.cycle));
  const nonReviewedHistory = digest.history
    .filter(item => !reviewedNums.has(item.cycle))
    .slice(0, 4)
    .map(item => `Cycle ${item.cycle} (${item.status}): ${item.line}`);
  const touched = digest.touched.slice(0, 12).map(item => `${item.path} (${item.op})`);
  const failures = digest.failures.map(item => (item.where ? `[${item.class}] ${item.where}: ${item.signal}` : `[${item.class}] ${item.signal}`));
  const decisions = digest.decisions.map(item => `${item.what} -> ${item.why}`);

  const groups = [
    { prefix: "Recent non-reviewed cycles: ", items: nonReviewedHistory, separator: "; " },
    { prefix: "Touched files: ", items: touched, separator: ", " },
    { prefix: "Unresolved failures: ", items: failures, separator: "; " },
    { prefix: "Decisions: ", items: decisions, separator: "; " },
    { prefix: "Open items: ", items: digest.open, separator: "; " },
  ].filter(group => group.items.length > 0);

  if (!groups.length) return reviewedEntries;
  const carryForward = fitCarryForwardSections(`Carry-forward digest (cycle ${digest.cycle}):`, groups);
  return [...reviewedEntries.slice(-(maxPreviousWork - 1)), carryForward];
}
