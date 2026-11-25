import test from "node:test";
import assert from "node:assert/strict";
import {
  autonomyReady, autonomyStartEvent, chooseEvaluator, chooseIntentChecker, evaluatorOverlaps, evaluatorProfiles, intentCheckPin, startMode, verdictPin,
} from "../packages/host/src/evaluator-profiles.js";
import type { TeamLineup, TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Provider } from "../packages/host/src/types.js";
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

const gptReviewer: TeamModelProfile = { id: "reviewer-gpt", label: "GPT reviewer", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong", dataUse: "standard" };
const deepseekAuthor: TeamModelProfile = { id: "author-deepseek", label: "DeepSeek author", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light", dataUse: "standard" };
const deepseekEvaluator: TeamModelProfile = { ...deepseekAuthor, id: "evaluator-deepseek", tier: "strong" };
const geminiEvaluator: TeamModelProfile = { id: "evaluator-gemini", label: "Gemini evaluator", provider: "opencode", model: "google/gemini-3-pro", variant: "high", tier: "strong", dataUse: "standard" };
const claudeCoordinator: TeamModelProfile = { ...claudeStrong, id: "coordinator-claude" };

/** Acceptance 11's lineup: coordinator of family A, reviewer of family B, implementers of family C. */
const acceptance11 = (evaluators: TeamModelProfile[]): TeamLineup => ({
  coordinator: claudeCoordinator,
  implementers: [deepseekAuthor],
  integrator: deepseekAuthor,
  reviewer: gptReviewer,
  evaluators,
});
const noLimits: ReadonlySet<Provider> = new Set();

test("the evaluator rule excludes authors by model and prefers independence", () => {
  const lineup = acceptance11([deepseekEvaluator, gptReviewer]);
  const cycle = { authors: [deepseekAuthor], reviewers: [gptReviewer], managers: [] };
  const choice = chooseEvaluator(lineup, cycle, noLimits);
  assert.ok("profile" in choice, "A profile is chosen");
  if (!("profile" in choice)) return;
  assert.equal(choice.profile.id, "reviewer-gpt", "The author's model is never chosen, even when listed first");
  assert.equal(choice.family, "gpt");
  assert.equal(choice.sharedFamily, false);
  assert.equal(choice.alsoReviewed, true);

  const third = chooseEvaluator(acceptance11([deepseekEvaluator, gptReviewer, geminiEvaluator]), cycle, noLimits);
  assert.ok("profile" in third, "A third profile is chosen");
  if (!("profile" in third)) return;
  assert.equal(third.profile.id, "evaluator-gemini", "A family that neither authored nor reviewed is preferred");
  assert.equal(third.sharedFamily, false);
  assert.equal(third.alsoReviewed, false);

  const sameFamilyOtherModel: TeamModelProfile = { ...deepseekEvaluator, id: "evaluator-deepseek-pro", model: "deepseek/deepseek-pro" };
  const shared = chooseEvaluator(acceptance11([sameFamilyOtherModel]), cycle, noLimits);
  assert.ok("profile" in shared, "A different model of an author's family is eligible when it is the only one");
  if (!("profile" in shared)) return;
  assert.equal(shared.sharedFamily, true);
  assert.equal(shared.alsoReviewed, false);
});

test("the evaluator rule prefers a family that authored nothing over one that authored", () => {
  const sameFamilyOtherModel: TeamModelProfile = { ...deepseekEvaluator, id: "evaluator-deepseek-pro", model: "deepseek/deepseek-pro" };
  const cycle = { authors: [deepseekAuthor], reviewers: [gptReviewer], managers: [] };
  const choice = chooseEvaluator(acceptance11([sameFamilyOtherModel, gptReviewer]), cycle, noLimits);
  assert.ok("profile" in choice, "A profile is chosen");
  if (!("profile" in choice)) return;
  assert.equal(choice.profile.id, "reviewer-gpt");
});

test("an unknown family is never eligible", () => {
  const cycle = { authors: [], reviewers: [], managers: [] };
  const skipsUnknown = chooseEvaluator(acceptance11([unknownStrong, gptReviewer]), cycle, noLimits);
  assert.ok("profile" in skipsUnknown, "The known profile is chosen");
  if ("profile" in skipsUnknown) assert.equal(skipsUnknown.profile.id, "reviewer-gpt");
  const unknownCoordinator = { ...acceptance11([gptReviewer]), coordinator: unknownStrong };
  assert.deepEqual(chooseEvaluator(unknownCoordinator, cycle, noLimits), { skipped: "no-independent-evaluator" });
  const noEvaluators: TeamLineup = { ...acceptance11([]), evaluators: undefined, reviewer: { ...gptReviewer, tier: "light" } };
  assert.deepEqual(chooseEvaluator(noEvaluators, cycle, noLimits), { skipped: "no-independent-evaluator" });
  assert.deepEqual(chooseEvaluator(undefined, cycle, noLimits), { skipped: "no-independent-evaluator" });
});

test("limits and failures make the evaluator unavailable, not ineligible", () => {
  const cycle = { authors: [], reviewers: [], managers: [] };
  const lineup = acceptance11([gptReviewer]);
  assert.deepEqual(chooseEvaluator(lineup, cycle, new Set<Provider>(["codex"])), { skipped: "evaluator-unavailable" });
  assert.deepEqual(chooseEvaluator(lineup, cycle, noLimits, new Set(["reviewer-gpt"])), { skipped: "evaluator-unavailable" });
  const two = acceptance11([gptReviewer, geminiEvaluator]);
  const choice = chooseEvaluator(two, cycle, new Set<Provider>(["codex"]));
  assert.ok("profile" in choice, "The second profile is chosen");
  if ("profile" in choice) assert.equal(choice.profile.id, "evaluator-gemini");
  const failed = chooseEvaluator(two, cycle, noLimits, new Set(["reviewer-gpt"]));
  assert.ok("profile" in failed, "A failed profile is skipped");
  if ("profile" in failed) assert.equal(failed.profile.id, "evaluator-gemini");
});

test("the verdict pin needs both keys and a plain run", () => {
  assert.equal(verdictPin({ evaluator: "on", register: "on", mission: false, handoff: false }), true);
  for (const evaluator of [undefined, "off"] as const) {
    assert.equal(verdictPin({ evaluator, register: "on", mission: false, handoff: false }), false);
  }
  for (const register of [undefined, "off"] as const) {
    assert.equal(verdictPin({ evaluator: "on", register, mission: false, handoff: false }), false);
  }
  assert.equal(verdictPin({ evaluator: "on", register: "on", mission: true, handoff: false }), false);
  assert.equal(verdictPin({ evaluator: "on", register: "on", mission: false, handoff: true }), false);
});

test("evaluator overlaps name shared models", () => {
  const lineup: TeamLineup = { ...acceptance11([deepseekEvaluator, gptReviewer]), escalations: [claudeStrong] };
  assert.deepEqual(evaluatorOverlaps(lineup), ["evaluator-deepseek"]);
  const viaEscalation: TeamLineup = { ...acceptance11([claudeStrong, gptReviewer]), escalations: [claudeStrong] };
  assert.deepEqual(evaluatorOverlaps(viaEscalation), ["opus-xhigh"]);
  const noDefaultModel: TeamModelProfile = { id: "default-codex", label: "Default", provider: "codex", tier: "strong", dataUse: "standard" };
  const implementerDefault: TeamLineup = { ...acceptance11([noDefaultModel]), implementers: [{ ...noDefaultModel, id: "impl-default" }] };
  assert.deepEqual(evaluatorOverlaps(implementerDefault), ["default-codex"], "A profile without a model matches another without one on that provider");
});

test("the evaluator is never of the family of a project manager that ran", () => {
  const gptManager: TeamModelProfile = { ...gptReviewer, id: "manager-gpt", label: "GPT fallback manager" };
  const cycle = { authors: [], reviewers: [], managers: [gptManager] };
  assert.deepEqual(chooseEvaluator(acceptance11([gptReviewer]), cycle, noLimits), { skipped: "no-independent-evaluator" }, "only a manager-family evaluator is listed");
  const choice = chooseEvaluator(acceptance11([gptReviewer, geminiEvaluator]), cycle, noLimits);
  assert.ok("profile" in choice, "The other family is chosen");
  if ("profile" in choice) assert.equal(choice.profile.id, "evaluator-gemini");
  const unknownManager: TeamModelProfile = { ...unknownStrong, id: "manager-unknown" };
  assert.deepEqual(chooseEvaluator(acceptance11([gptReviewer]), { authors: [], reviewers: [], managers: [unknownManager] }, noLimits), { skipped: "no-independent-evaluator" });
  const own = chooseEvaluator(acceptance11([gptReviewer]), { authors: [], reviewers: [], managers: [claudeCoordinator] }, noLimits);
  assert.ok("profile" in own, "A manager of the coordinator's own family changes nothing");
  if ("profile" in own) assert.equal(own.profile.id, "reviewer-gpt");
});
