import test from "node:test";
import assert from "node:assert/strict";
import {
  autonomyReady, autonomyStartEvent, chooseIntentChecker, evaluatorProfiles, intentCheckPin, startMode,
} from "../packages/host/src/evaluator-profiles.js";
import type { TeamLineup, TeamModelProfile } from "../packages/host/src/team-types.js";
import { mixedLineup } from "./team-fixture.js";

const claudeStrong: TeamModelProfile = { id: "opus-xhigh", label: "Opus 5.5 xhigh", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong", dataUse: "standard" };
const codexStrong: TeamModelProfile = { id: "astra-high", label: "Astra 6 high", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong", dataUse: "standard" };
const codexStrongXhigh: TeamModelProfile = { id: "astra-strong-xhigh", label: "Astra 6 xhigh", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong", dataUse: "standard" };
const unknownStrong: TeamModelProfile = { id: "vendor-strong", label: "Unknown strong", provider: "opencode", model: "vendor/unknown-model", variant: "high", tier: "strong", dataUse: "standard" };
const claudeLight: TeamModelProfile = { id: "haiku-high", label: "Haiku 5.5 high", provider: "claude", model: "claude-haiku-5-5", effort: "high", tier: "light", dataUse: "standard" };

/** `docs/teams.md`, section "Add `lineup`": the example lineup, copied as written there. */
const documentedLineup: TeamLineup = {
  coordinator: { id: "opus-xhigh", label: "Opus 5.5 xhigh", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong", dataUse: "standard" },
  implementers: [
    { id: "haiku-high", label: "Haiku 5.5 high", provider: "claude", model: "claude-haiku-5-5", effort: "high", tier: "light", dataUse: "standard" },
    { id: "luna-high", label: "Luna 6 high", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light", dataUse: "standard" },
  ],
  integrator: { id: "opus-xhigh", label: "Opus 5.5 xhigh", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong", dataUse: "standard" },
  reviewer: { id: "astra-high", label: "Astra 6 high", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong", dataUse: "standard" },
  escalations: [
    { id: "opus-xhigh", label: "Opus 5.5 xhigh", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong", dataUse: "standard" },
    { id: "astra-xhigh", label: "Astra 6 xhigh", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong", dataUse: "standard" },
  ],
  permissionReviewer: { id: "haiku-permission-reviewer", label: "Haiku 5.5 high", provider: "claude", model: "claude-haiku-5-5", effort: "high", tier: "light", dataUse: "standard" },
};

const lineupWith = (extra: Partial<TeamLineup>): TeamLineup => ({ ...mixedLineup, ...extra });
const strongClaudeCoordinator = (extra: Partial<TeamLineup>): TeamLineup => ({
  ...mixedLineup,
  coordinator: claudeStrong,
  reviewer: { ...mixedLineup.reviewer, tier: "strong" },
  ...extra,
});

test("evaluators are listed, else derived", () => {
  const listed = lineupWith({ evaluators: [codexStrong, claudeStrong] });
  const listedBefore = structuredClone(listed);
  assert.deepEqual(evaluatorProfiles(listed), [codexStrong, claudeStrong]);
  assert.deepEqual(listed, listedBefore);

  const reviewer = { ...codexStrong, id: "reviewer-strong" };
  const escalations = [
    { ...codexStrong, id: "reviewer-strong" },
    claudeLight,
    claudeStrong,
    codexStrongXhigh,
    unknownStrong,
    { ...claudeStrong, id: "extra-strong" },
  ];
  const derived: TeamLineup = lineupWith({ reviewer, escalations });
  const derivedBefore = structuredClone(derived);
  const derivedList = evaluatorProfiles(derived);
  assert.deepEqual(derivedList.map(profile => profile.id), ["reviewer-strong", "opus-xhigh", "astra-strong-xhigh", "vendor-strong"]);
  assert.equal(derivedList.length, 4, "At most 4 evaluators");
  assert.equal(derivedList.filter(profile => profile.id === "reviewer-strong").length, 1, "A reviewer listed as an escalation appears once");
  assert.deepEqual(derived, derivedBefore, "The derived list is never written back");

  const lightReviewer = lineupWith({ reviewer: { ...mixedLineup.reviewer }, escalations: [claudeLight] });
  assert.deepEqual(evaluatorProfiles(lightReviewer), [], "A reviewer without tier strong and light escalations are left out");
});

test("the checker differs in family from the coordinator and the plan's author", () => {
  const author = claudeStrong;
  assert.deepEqual(chooseIntentChecker(mixedLineup, mixedLineup.coordinator, new Set()), { skipped: "no-eligible-profile" }, "mixedLineup has no strong evaluator");

  const withEvaluators = strongClaudeCoordinator({ evaluators: [claudeStrong, codexStrong] });
  assert.deepEqual(chooseIntentChecker(withEvaluators, { ...claudeStrong, id: "plan-author" }, new Set()), { profile: codexStrong }, "The Claude evaluator shares the coordinator's family");

  const codexAuthor = { ...codexStrong, id: "codex-author" };
  assert.deepEqual(chooseIntentChecker(withEvaluators, codexAuthor, new Set()), { skipped: "no-eligible-profile" }, "A plan author on Codex leaves no evaluator");

  const unknownFamily = strongClaudeCoordinator({ evaluators: [unknownStrong] });
  assert.deepEqual(chooseIntentChecker(unknownFamily, author, new Set()), { skipped: "no-eligible-profile" }, "An evaluator of unknown family is never eligible");

  assert.deepEqual(chooseIntentChecker(withEvaluators, { ...claudeStrong, id: "plan-author" }, new Set<"codex">(["codex"])), { skipped: "no-eligible-profile" }, "A limited provider is never chosen");
});

test("the documented lineup is ready and derives Astra", () => {
  const before = structuredClone(documentedLineup);
  assert.deepEqual(evaluatorProfiles(documentedLineup).map(profile => profile.id), ["astra-high", "opus-xhigh", "astra-xhigh"]);
  assert.deepEqual(autonomyReady(documentedLineup), { ready: true });
  assert.deepEqual(chooseIntentChecker(documentedLineup, documentedLineup.coordinator, new Set()), { profile: documentedLineup.reviewer });
  assert.deepEqual(chooseIntentChecker(documentedLineup, documentedLineup.coordinator, new Set<"codex">(["codex"])), { skipped: "no-eligible-profile" });
  assert.deepEqual(documentedLineup, before);
});

test("readiness and the start mode fail closed", () => {
  assert.deepEqual(autonomyReady(undefined), { ready: false, reason: "no-lineup" });
  assert.deepEqual(autonomyReady(mixedLineup), { ready: false, reason: "no-eligible-evaluator" });
  const unknownCoordinator = lineupWith({
    coordinator: { id: "vendor-coordinator", label: "Unknown", provider: "opencode", model: "vendor/unknown-model", variant: "high", tier: "strong", dataUse: "standard" },
    reviewer: codexStrong,
  });
  assert.deepEqual(autonomyReady(unknownCoordinator), { ready: false, reason: "no-eligible-evaluator" });

  assert.deepEqual(startMode({ autonomy: "autonomous" }, undefined), { mode: "supervised", reason: "no-lineup" });
  assert.deepEqual(startMode({ autonomy: "autonomous" }, mixedLineup), { mode: "supervised", reason: "no-eligible-evaluator" });
  assert.deepEqual(startMode({ autonomy: "autonomous" }, unknownCoordinator), { mode: "supervised", reason: "no-eligible-evaluator" });
  assert.deepEqual(startMode({ autonomy: "autonomous" }, documentedLineup), { mode: "autonomous" });
  assert.deepEqual(startMode({ autonomy: "supervised" }, documentedLineup), { mode: "supervised" });
  assert.deepEqual(startMode({ autonomy: "supervised" }, undefined), { mode: "supervised" });
});

test("the start events are fixed text", () => {
  assert.equal(autonomyStartEvent("run", "no-lineup"), "This run starts supervised: it has no lineup, so no evaluator of another model family can check it.");
  assert.equal(autonomyStartEvent("run", "no-eligible-evaluator"), "This run starts supervised: no lineup profile of a model family other than the coordinator's can evaluate it.");
  assert.equal(autonomyStartEvent("goal", "no-lineup"), "This goal starts supervised: it has no lineup, so no evaluator of another model family can check it.");
  assert.equal(autonomyStartEvent("goal", "no-eligible-evaluator"), "This goal starts supervised: no lineup profile of a model family other than the coordinator's can evaluate it.");
});

test("the pin follows the mode and the setting", () => {
  const settings: Array<"on" | "off" | undefined> = [undefined, "on", "off"];
  for (const setting of settings) {
    const autonomous = intentCheckPin({ autonomy: "autonomous", setting, mission: false, handoff: false });
    const supervised = intentCheckPin({ autonomy: "supervised", setting, mission: false, handoff: false });
    assert.equal(autonomous, setting === "off" ? "off" : "on", `autonomous with setting ${String(setting)}`);
    assert.equal(supervised, setting === "on" ? "on" : "off", `supervised with setting ${String(setting)}`);
    for (const autonomy of ["autonomous", "supervised"] as const) {
      assert.equal(intentCheckPin({ autonomy, setting, mission: true, handoff: false }), "off", "A mission subteam never checks");
      assert.equal(intentCheckPin({ autonomy, setting, mission: false, handoff: true }), "off", "A handoff run never checks");
    }
  }
});
