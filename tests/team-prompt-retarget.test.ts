import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendBuiltPrompt,
  codexMemberToolInstructions,
  codexSandboxInstructions,
  contextAccessInstructions,
  entryInstructions,
  escalationInstructions,
  escalationSpec,
  permissionFollowUpPromptSpec,
  profileInstructions,
  readOnlyWorkspaceInstructions,
  refreshBuiltPrompt,
  refreshReportingInstructions,
  renderPromptSections,
  reportingInstructions,
  retargetBuiltPrompt,
  retargetPrompt,
  retargetPromptSections,
  teamPrompt,
  teamPromptSpec,
  type TeamPromptSection,
} from "../packages/host/src/team-prompts.js";
import { intentCheckerPrompt, intentCheckerPromptSpec } from "../packages/host/src/intent-prompt.js";
import { evaluatorPrompt, evaluatorPromptSpec } from "../packages/host/src/verdict-prompt.js";
import { judgePrompt, judgePromptSpec } from "../packages/host/src/judge-prompt.js";
import { commitProviderLimitSwitch, resolveProviderLimitLaunch } from "../packages/host/src/team-diagnostics.js";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamService, type Stored } from "../packages/host/src/teams.js";
import type { TeamLineup, TeamMember, TeamModelProfile, TeamRun } from "../packages/host/src/team-types.js";
import { ENTRY_PROFILE, ENTRY_PROVIDERS, smallRun } from "./fixtures/team-prompt-run.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

test("refreshes a profile-less implementer prompt's reporting helper", () => {
  const prompt = teamPrompt(smallRun(), "implementer", undefined, undefined, "opencode");
  assert.doesNotMatch(prompt, /Requested runtime profile:/);
  const older = prompt.replace(/to this command: [^\n]+?\. The helper/, "to this command: 'node' 'dist/team-report.js'. The helper");
  assert.notEqual(older, prompt);
  const carried = `${older}\n\nUser answered: Compact`;
  assert.equal(refreshReportingInstructions(carried, "opencode", "implementer"), `${prompt}\n\nUser answered: Compact`);
  assert.equal(retargetPrompt(carried, { provider: "claude", profile: ENTRY_PROFILE, role: "implementer", entryTools: false }), undefined);
});

test("refreshes a profile-less permission-coordinator prompt's reporting helper", () => {
  const prompt = teamPrompt(smallRun(), "permission-coordinator", undefined, undefined, "opencode");
  assert.doesNotMatch(prompt, /Requested runtime profile:/);
  const older = prompt.replace(/to this command: [^\n]+?\. The helper/, "to this command: 'node' 'dist/team-report.js'. The helper");
  assert.notEqual(older, prompt);
  const carried = `${older}\n\nUser answered: Compact`;
  assert.equal(refreshReportingInstructions(carried, "opencode", "permission-coordinator"), `${prompt}\n\nUser answered: Compact`);
  assert.equal(retargetPrompt(carried, { provider: "claude", profile: ENTRY_PROFILE, role: "permission-coordinator", entryTools: false }), undefined);
});

test("retargeting round trips no-context member and intent prompts", () => {
  const codexProfile = { ...ENTRY_PROFILE, provider: "codex" as const };
  const roundTrip = (prompt: string, role: TeamMember["role"], entryTools: boolean) => {
    const codex = retargetPrompt(prompt, { provider: "codex", profile: codexProfile, role, entryTools });
    assert.ok(codex);
    return retargetPrompt(codex, { provider: "claude", profile: ENTRY_PROFILE, role, entryTools });
  };
  const member = teamPrompt(smallRun({ blackboard: { tools: true } }), "implementer", undefined, undefined, "claude", ENTRY_PROFILE)
    .replace(contextAccessInstructions() + "\n\n", "");
  assert.equal(roundTrip(member, "implementer", true), member);
  assert.equal(retargetPrompt(member + "\n\n" + reportingInstructions("claude"), { provider: "codex", profile: codexProfile, role: "implementer", entryTools: true }), undefined);
  const checker = intentCheckerPrompt("claude", ENTRY_PROFILE).replace(contextAccessInstructions() + "\n\n", "");
  assert.equal(roundTrip(checker, "intent-checker", false), checker);
  const legacy = checker.replace(
    readOnlyWorkspaceInstructions + "\n\n" + profileInstructions(ENTRY_PROFILE),
    readOnlyWorkspaceInstructions + "\n\n" + codexSandboxInstructions + "\n\n" + profileInstructions(ENTRY_PROFILE),
  );
  assert.equal(roundTrip(legacy, "intent-checker", false), checker);
});

test("retargeting preserves quoted owner answers and provider paragraphs in feedback", () => {
  const ownerQuote = `${reportingInstructions("codex")}\n\n${entryInstructions("codex")}`;
  const run = smallRun({
    blackboard: { tools: true },
    decisions: [{
      id: "quoted",
      memberId: "owner",
      revision: 1,
      question: "Which instructions were quoted?",
      options: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      answer: ownerQuote,
      answeredBy: "owner",
      answeredAt: "2026-11-01T00:01:00.000Z",
    }],
  });
  const feedbackQuotes = [
    ...ENTRY_PROVIDERS.map(provider => reportingInstructions(provider)),
    reportingInstructions("opencode", "'node' 'report-helper.js'"),
    ...ENTRY_PROVIDERS.map(provider => entryInstructions(provider)),
    entryInstructions("opencode", "'node' 'entry-helper.js'"),
  ].join("\n\n");
  const feedback = `Quoted provider guidance:\n\n${feedbackQuotes}\n\nEnd of quote.`;
  const sourceProfile = { ...ENTRY_PROFILE, provider: "claude" as const };
  const targetProfile = { ...ENTRY_PROFILE, provider: "codex" as const };
  const prompt = teamPrompt(run, "implementer", undefined, feedback, "claude", sourceProfile);
  const expected = teamPrompt(run, "implementer", undefined, feedback, "codex", targetProfile);
  const refreshedExpected = teamPrompt(run, "implementer", undefined, feedback, "codex", sourceProfile)
    .replace(
      codexSandboxInstructions + "\n\n" + codexMemberToolInstructions(true) + "\n\n" + contextAccessInstructions(),
      contextAccessInstructions(),
    );
  assert.equal(refreshReportingInstructions(prompt, "codex", "implementer"), refreshedExpected);
  assert.equal(retargetPrompt(prompt, { provider: "codex", profile: targetProfile, role: "implementer", entryTools: true }), expected);
});

test("retargeting preserves a quoted owner answer resembling Codex guidance in both directions", () => {
  const ownerEvidence = [
    "Quote:",
    codexSandboxInstructions,
    "Working rule for tools: Owner says retain this evidence.",
    contextAccessInstructions(),
  ].join("\n\n");
  const run = smallRun({
    decisions: [{
      id: "quoted",
      memberId: "owner",
      revision: 1,
      question: "What should remain evidence?",
      options: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      answer: ownerEvidence,
      answeredBy: "owner",
      answeredAt: "2026-11-01T00:01:00.000Z",
    }],
  });
  const claudeProfile = { ...ENTRY_PROFILE, provider: "claude" as const };
  const codexProfile = { ...ENTRY_PROFILE, provider: "codex" as const };
  const directions = [
    ["claude", "codex", claudeProfile, codexProfile],
    ["codex", "claude", codexProfile, claudeProfile],
  ] as const;
  for (const [source, target, sourceProfile, targetProfile] of directions) {
    const prompt = teamPrompt(run, "implementer", undefined, undefined, source, sourceProfile);
    const forward = retargetPrompt(prompt, { provider: target, profile: targetProfile, role: "implementer", entryTools: false });
    assert.equal(forward, teamPrompt(run, "implementer", undefined, undefined, target, targetProfile), `${source} to ${target}`);
    assert.equal(retargetPrompt(forward!, { provider: source, profile: sourceProfile, role: "implementer", entryTools: false }), prompt, `${target} back to ${source}`);
  }
});

test("retargeting refuses an ambiguous whole host block", () => {
  const context = contextAccessInstructions();
  const report = reportingInstructions("claude");
  const answer = `Quote:\n\n${context}\n\n${report}`;
  const run = smallRun({
    decisions: [{
      id: "quoted",
      memberId: "owner",
      revision: 1,
      question: "Which instructions were quoted?",
      options: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      answer,
      answeredBy: "owner",
      answeredAt: "2026-11-01T00:01:00.000Z",
    }],
  });
  const prompt = teamPrompt(run, "implementer", undefined, undefined, "claude", ENTRY_PROFILE);
  assert.equal(retargetPrompt(prompt, { provider: "codex", profile: { ...ENTRY_PROFILE, provider: "codex" }, role: "implementer", entryTools: false }), undefined);
  assert.equal(refreshReportingInstructions(prompt, "codex", "implementer"), prompt);
});

type QuoteCategory = "report" | "entry" | "context" | "sandbox" | "rule" | "profile" | "readonly" | "near-miss";
type Quote = { category: QuoteCategory; text: string };

const quoteGroups = {
  report: {
    claude: { category: "report", text: reportingInstructions("claude") },
    codex: { category: "report", text: reportingInstructions("codex") },
    opencode: { category: "report", text: reportingInstructions("opencode") },
    helper: { category: "report", text: reportingInstructions("opencode", "'node' 'report-helper.js'") },
  },
  entry: {
    claude: { category: "entry", text: entryInstructions("claude") },
    codex: { category: "entry", text: entryInstructions("codex") },
    opencode: { category: "entry", text: entryInstructions("opencode") },
    helper: { category: "entry", text: entryInstructions("opencode", "'node' 'entry-helper.js'") },
  },
  context: { category: "context", text: contextAccessInstructions() },
  sandbox: { category: "sandbox", text: codexSandboxInstructions },
  rule: {
    withoutEntries: { category: "rule", text: codexMemberToolInstructions(false) },
    withEntries: { category: "rule", text: codexMemberToolInstructions(true) },
  },
  profile: { category: "profile", text: profileInstructions(ENTRY_PROFILE) },
  readonly: { category: "readonly", text: readOnlyWorkspaceInstructions },
  nearMiss: { category: "near-miss", text: "Working rule for tools: Owner says retain this evidence." },
} satisfies Record<string, Quote | Record<string, Quote>>;
const quotes: Quote[] = [
  ...Object.values(quoteGroups.report),
  ...Object.values(quoteGroups.entry),
  quoteGroups.context,
  quoteGroups.sandbox,
  ...Object.values(quoteGroups.rule),
  quoteGroups.profile,
  quoteGroups.readonly,
  quoteGroups.nearMiss,
];

function containsSequence(quotes: Quote[], categories: QuoteCategory[]) {
  return quotes.some((_, index) => categories.every((category, offset) => quotes[index + offset]?.category === category));
}

test("seeded retarget comparisons preserve quoted prompt evidence across every role and provider", () => {
  const seed = 0x6d2b79f5;
  let state = seed;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const roles = ["implementer", "reviewer", "project-manager", "scout", "integrator", "delivery", "intent-checker", "permission-coordinator"] as const;
  const entryRoles = new Set(["implementer", "reviewer", "project-manager", "scout", "integrator"]);
  const selected = new Set<number>();
  let returnedPrompts = 0;
  let cases = 0;
  const started = performance.now();
  try {
    for (const role of roles) {
      for (const source of ENTRY_PROVIDERS) {
        for (const target of ENTRY_PROVIDERS) {
          const sourceProfile = { ...ENTRY_PROFILE, id: `${source}-source`, provider: source };
          const targetProfile = { ...ENTRY_PROFILE, id: `${target}-target`, provider: target };
          const toolsOn = entryRoles.has(role);
          const run = smallRun({
            blackboard: { tools: true },
            decisions: [{
              id: "quoted",
              memberId: "owner",
              revision: 1,
              question: "Which quoted text is evidence?",
              options: [],
              createdAt: "2026-11-01T00:00:00.000Z",
              answer: "OWNER_QUOTE_SENTINEL",
              answeredBy: "owner",
              answeredAt: "2026-11-01T00:01:00.000Z",
            }],
          });
          const render = (provider: typeof source, profile: TeamModelProfile) => role === "intent-checker"
            ? intentCheckerPrompt(provider, profile)
            : teamPrompt(run, role, undefined, "FEEDBACK_QUOTE_SENTINEL", provider, profile);
          const sourceTemplate = render(source, sourceProfile);
          const targetTemplate = render(target, targetProfile);
          for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
            cases++;
            const quoteIndex = caseIndex < quotes.length ? caseIndex : random() % quotes.length;
            selected.add(quoteIndex);
            let answerParts = [quotes[quoteIndex]!];
            let feedbackParts = [quotes[(quoteIndex + 1 + random() % (quotes.length - 1)) % quotes.length]!];
            if (caseIndex % 4 >= 2) {
              answerParts.push(quotes[(quoteIndex + 2 + random() % (quotes.length - 2)) % quotes.length]!);
              feedbackParts.push(quotes[(quoteIndex + 3 + random() % (quotes.length - 3)) % quotes.length]!);
            }
            if (caseIndex % 4 === 3) {
              feedbackParts.push(quotes[(quoteIndex + 4 + random() % (quotes.length - 4)) % quotes.length]!);
            }
            let answerJoiner = "\n\nQuoted paragraph follows.\n\n";
            if (caseIndex === 3) {
              answerParts = [quoteGroups.nearMiss, quoteGroups.sandbox];
              answerJoiner = "\n\n";
            }
            if (caseIndex === 0 && role !== "intent-checker" && role !== "permission-coordinator") {
              feedbackParts = [quoteGroups.context, quoteGroups.report[source]];
            }
            if (caseIndex === 1 && role !== "intent-checker" && role !== "permission-coordinator") {
              feedbackParts = [quoteGroups.context, quoteGroups.entry.claude, quoteGroups.report[source]];
            }
            if (caseIndex === 2 && role === "intent-checker") {
              feedbackParts = [quoteGroups.readonly, quoteGroups.profile, quoteGroups.report.claude];
            }
            const directFeedback = (caseIndex < 2 && role !== "intent-checker" && role !== "permission-coordinator")
              || (caseIndex === 2 && role === "intent-checker");
            const answer = `\n\n${answerParts.map(quote => quote.text).join(answerJoiner)}`;
            const feedbackSeparator = directFeedback ? "\n\n" : "\n\nQuoted paragraph follows.\n\n";
            const feedback = `Quoted evidence:\n\n${feedbackParts.map(quote => quote.text).join(feedbackSeparator)}\n\nEnd of quote.`;
            const withQuotes = (template: string) => role === "intent-checker"
              ? template
              : template.replace("OWNER_QUOTE_SENTINEL", answer).replace("FEEDBACK_QUOTE_SENTINEL", feedback);
            const sourcePrompt = withQuotes(sourceTemplate);
            const targetPrompt = withQuotes(targetTemplate);
            const checkerEvidence = `\n\nOwner answer quote:\n\n${answer}\n\nFeedback quote:\n\n${feedback}`;
            const prompt = role === "intent-checker" ? sourcePrompt + checkerEvidence : sourcePrompt;
            const allQuotes = [...answerParts, ...feedbackParts];
            const hasCategory = (category: QuoteCategory) => allQuotes.some(quote => quote.category === category);
            const ambiguousIntent = role === "intent-checker" && (
              hasCategory("context") || (directFeedback && containsSequence(feedbackParts, ["readonly", "profile", "report"]))
            );
            const ambiguousCoordinator = role === "permission-coordinator" && hasCategory("report");
            const ambiguousMemberBlock = role !== "intent-checker" && role !== "permission-coordinator" && (
              (answerJoiner === "\n\n" && (
                containsSequence(answerParts, ["context", "report"])
                || containsSequence(answerParts, ["context", "entry", "report"])
              ))
              || (directFeedback && (
                containsSequence(feedbackParts, ["context", "report"])
                || containsSequence(feedbackParts, ["context", "entry", "report"])
              ))
            );
            const expected = ambiguousIntent || ambiguousCoordinator || ambiguousMemberBlock
              ? undefined
              : role === "intent-checker"
                ? targetPrompt + checkerEvidence
                : targetPrompt;
            const actual = retargetPrompt(prompt, { provider: target, profile: targetProfile, role, entryTools: toolsOn });
            if (actual !== undefined) returnedPrompts++;
            const caseInfo = `seed=${seed} role=${role} case=${caseIndex} ${source}->${target} quote=${quoteIndex}`;
            assert.equal(actual, expected, caseInfo);
          }
        }
      }
    }
    assert.equal(selected.size, quotes.length, `seed=${seed} selected quote category coverage`);
    const elapsedMs = performance.now() - started;
    console.log(`retarget comparison seed=${seed} cases=${cases} returned=${returnedPrompts} elapsedMs=${Math.round(elapsedMs)}`);
    assert.ok(returnedPrompts >= cases / 2, `seed=${seed} returned ${returnedPrompts}/${cases} prompts`);
  } catch (error) {
    console.error(`retarget comparison seed=${seed}; returned=${returnedPrompts}; elapsedMs=${Math.round(performance.now() - started)}`);
    throw error;
  }
});

const ALL_ROLES = [
  "implementer",
  "reviewer",
  "project-manager",
  "scout",
  "integrator",
  "delivery",
  "permission-coordinator",
] as const;
const ENTRY_TOOL_ROLES = new Set(["implementer", "reviewer", "project-manager", "scout", "integrator"]);

test("structured prompt sections render deterministically for Claude, Codex, OpenCode, and demo", () => {
  const providers = ["claude", "codex", "opencode", "demo"] as const;
  for (const provider of providers) {
    const profile: TeamModelProfile = provider === "opencode"
      ? { id: "deepseek-light", label: "DeepSeek", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light" }
      : { ...ENTRY_PROFILE, id: `${provider}-profile`, provider: provider === "demo" ? "claude" : provider };
    for (const role of ALL_ROLES) {
      for (const toolsOn of [false, true]) {
        const run = smallRun(toolsOn ? { blackboard: { tools: true } } : {});
        const entryTools = toolsOn && ENTRY_TOOL_ROLES.has(role);
        const built = teamPromptSpec(run, role, undefined, undefined, provider, profile);
        const target = { provider, profile, role, entryTools };
        assert.equal(built.prompt, teamPrompt(run, role, undefined, undefined, provider, profile), `${role} ${provider}`);
        assert.equal(renderPromptSections(built.promptSections, target), built.prompt, `${role} ${provider} deterministic re-render`);
        assert.equal(renderPromptSections(built.promptSections, target), built.prompt, `${role} ${provider} repeatable re-render`);
        const expectCodex = provider === "codex" && role !== "permission-coordinator";
        assert.equal(built.prompt.includes(codexSandboxInstructions), expectCodex, `${role} ${provider} sandbox`);
        assert.equal(built.prompt.includes(codexMemberToolInstructions(entryTools)), expectCodex, `${role} ${provider} tool rule`);
        assert.equal(built.prompt.includes(reportingInstructions(provider)), true, `${role} ${provider} reporting`);
        assert.equal(built.prompt.includes(entryInstructions(provider)), entryTools, `${role} ${provider} entry`);
      }
    }
    const checker = intentCheckerPromptSpec(provider, profile);
    assert.equal(checker.prompt, intentCheckerPrompt(provider, profile));
    assert.equal(renderPromptSections(checker.promptSections, { provider, profile, role: "intent-checker", entryTools: false }), checker.prompt);

    const evaluator = evaluatorPromptSpec(provider, profile);
    assert.equal(evaluator.prompt, evaluatorPrompt(provider, profile));
    assert.equal(renderPromptSections(evaluator.promptSections, { provider, profile, role: "evaluator", entryTools: false }), evaluator.prompt);

    const judge = judgePromptSpec(provider);
    assert.equal(judge.prompt, judgePrompt(provider));
    assert.equal(renderPromptSections(judge.promptSections, { provider, role: "judge", entryTools: false }), judge.prompt);
    assert.equal(judge.prompt.includes("Requested runtime profile:"), false);
  }

  const followUp = permissionFollowUpPromptSpec('{"decisionId":"d1"}', ["Keep checks strict."]);
  assert.equal(renderPromptSections(followUp.promptSections, { provider: "claude", role: "permission-coordinator", entryTools: false }), followUp.prompt);
  assert.equal(retargetPromptSections(followUp.promptSections, { provider: "codex", profile: { ...ENTRY_PROFILE, provider: "codex" }, role: "permission-coordinator", entryTools: false }), undefined);
});

test("structured retargeting switches providers, profiles, and escalation modes even when prior prose wording differs or quotes host blocks", () => {
  const claudeProfile: TeamModelProfile = { id: "claude-light", label: "Claude Light", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
  const codexProfile: TeamModelProfile = { id: "codex-light", label: "Codex Light", provider: "codex", model: "gpt-6-astra", effort: "low", tier: "light" };
  const opencodeProfile: TeamModelProfile = { id: "deepseek-light", label: "DeepSeek", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light" };
  const strongEsc: TeamModelProfile = { id: "opus-strong", label: "Opus Strong", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
  const secondEsc: TeamModelProfile = { id: "astra-strong", label: "Astra Strong", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" };

  const quotedWholeBlock = [
    "Owner quoted an ambiguous host block:",
    codexSandboxInstructions,
    codexMemberToolInstructions(true),
    contextAccessInstructions(),
    entryInstructions("codex"),
    reportingInstructions("codex"),
    escalationInstructions({ lineup: { coordinator: strongEsc, integrator: strongEsc, reviewer: secondEsc, implementers: [claudeProfile], escalations: [strongEsc] } }, claudeProfile.id)!,
  ].join("\n\n");

  const run = smallRun({
    blackboard: { tools: true },
    lineup: {
      coordinator: strongEsc,
      integrator: strongEsc,
      reviewer: secondEsc,
      implementers: [claudeProfile, codexProfile, opencodeProfile],
      escalations: [strongEsc, secondEsc],
    },
    routing: {
      mode: "auto",
      algorithmVersion: 2,
      knobs: { allowContributor: true, points: ["escalation"] },
    } as TeamRun["routing"],
    decisions: [{
      id: "d-quote",
      memberId: "owner",
      revision: 1,
      question: "Keep quoted evidence?",
      options: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      answer: quotedWholeBlock,
      answeredBy: "owner",
      answeredAt: "2026-11-01T00:01:00.000Z",
    }],
  });

  const claudeBuilt = teamPromptSpec(run, "implementer", undefined, quotedWholeBlock, "claude", claudeProfile);
  assert.equal(
    retargetPrompt(claudeBuilt.prompt, { provider: "codex", profile: codexProfile, role: "implementer", entryTools: true }),
    undefined,
    "legacy flat string retargeter refuses the ambiguous quoted block",
  );

  const stalePersisted = {
    prompt: "Pre-upgrade rendered prose with completely different Codex working rule and reporting wording.",
    promptSections: claudeBuilt.promptSections,
  };
  const withNotes = appendBuiltPrompt(stalePersisted, ["User answered: Preserve the quote.", "Host-assigned task scratch directory: /srv/scratch/m1."]);

  const toCodex = retargetBuiltPrompt(withNotes, {
    provider: "codex",
    profile: codexProfile,
    role: "implementer",
    entryTools: true,
    escalation: { spec: { mode: "pool", pool: [strongEsc] } },
  });
  assert.ok(toCodex?.promptSections);
  assert.equal(toCodex.prompt.split(codexSandboxInstructions).length - 1, 3, "two quoted copies plus one live Codex sandbox block");
  assert.equal(toCodex.prompt.split(codexMemberToolInstructions(true)).length - 1, 3, "two quoted copies plus one live Codex tool rule");
  assert.ok(toCodex.prompt.includes(profileInstructions(codexProfile)));
  assert.equal(toCodex.prompt.split("to this approved pool:").length - 1, 3, "two quoted escalation copies plus one live escalation pool");
  assert.ok(toCodex.prompt.includes(`to this approved pool: ${JSON.stringify([strongEsc])}`));
  assert.ok(toCodex.prompt.includes("User answered: Preserve the quote."));
  assert.ok(toCodex.prompt.includes("Host-assigned task scratch directory: /srv/scratch/m1."));

  const toClaudeNoEsc = retargetBuiltPrompt(toCodex, {
    provider: "claude",
    profile: strongEsc,
    role: "implementer",
    entryTools: true,
    escalation: { spec: undefined },
  });
  assert.ok(toClaudeNoEsc?.promptSections);
  assert.equal(toClaudeNoEsc.prompt.split(codexSandboxInstructions).length - 1, 2, "live Codex sandbox block removed while quotes stay intact");
  assert.equal(toClaudeNoEsc.prompt.split(codexMemberToolInstructions(true)).length - 1, 2, "live Codex rule removed while quotes stay intact");
  assert.ok(toClaudeNoEsc.prompt.includes(profileInstructions(strongEsc)));
  assert.ok(toClaudeNoEsc.prompt.includes(reportingInstructions("claude")));
  assert.ok(toClaudeNoEsc.prompt.includes(entryInstructions("claude")));
  assert.equal(toClaudeNoEsc.prompt.split("to this approved pool:").length - 1, 2, "live escalation omitted when spec is undefined while quoted copies stay intact");

  const toOpenCodeHostEsc = retargetBuiltPrompt(toClaudeNoEsc, {
    provider: "opencode",
    profile: opencodeProfile,
    role: "implementer",
    entryTools: true,
    escalation: { spec: escalationSpec(run, opencodeProfile.id) },
  });
  assert.ok(toOpenCodeHostEsc?.promptSections);
  assert.ok(toOpenCodeHostEsc.prompt.includes(profileInstructions(opencodeProfile)));
  assert.ok(toOpenCodeHostEsc.prompt.includes(reportingInstructions("opencode")));
  assert.ok(toOpenCodeHostEsc.prompt.includes(entryInstructions("opencode")));
  assert.ok(toOpenCodeHostEsc.prompt.includes("The host selects the stronger profile."));

  const customStaticSections: TeamPromptSection[] = [
    { kind: "text", text: "Completely revised intro wording from a future release." },
    { kind: "profile" },
    { kind: "text", text: "Completely revised body wording that never existed before." },
    { kind: "codex" },
    { kind: "context" },
    { kind: "report" },
  ];
  const customCodex = retargetPromptSections(customStaticSections, {
    provider: "codex",
    profile: codexProfile,
    role: "intent-checker",
    entryTools: false,
  });
  assert.ok(customCodex);
  assert.equal(
    customCodex.prompt,
    [
      "Completely revised intro wording from a future release.",
      profileInstructions(codexProfile),
      "Completely revised body wording that never existed before.",
      codexSandboxInstructions,
      codexMemberToolInstructions(false),
      contextAccessInstructions(),
      reportingInstructions("codex"),
    ].join("\n\n"),
  );

  const refreshed = refreshBuiltPrompt(
    { prompt: "Old helper command prose", promptSections: judgePromptSpec("opencode").promptSections },
    { provider: "opencode", role: "judge", entryTools: false },
  );
  assert.equal(refreshed.prompt, judgePrompt("opencode"));
  assert.equal(
    retargetPromptSections(judgePromptSpec("claude").promptSections, { provider: "codex", profile: codexProfile, role: "judge", entryTools: false }),
    undefined,
    "profile-less structured prompts refuse retargeting",
  );
});

type PromptRetargetServiceInternal = {
  records: Map<string, Stored>;
  limits: { observe(limit: { provider: "claude" | "codex" | "opencode" | "demo"; detectedAt: string; resetsAt?: string; sessionId: string; runId?: string; confidence: "corroborated" }): void };
  step(stored: Stored): Promise<void>;
  switchLimitedMember(stored: Stored, member: TeamMember, limit: { kind: "limit"; limit: "usage" | "credits"; confidence: "corroborated"; message: string; resetsAt?: string; at: string; seq: number }): Promise<void>;
};

test("sealed persisted members re-render stale pre-upgrade wording from promptSections on launch and fallback, and redact promptSections from TeamView", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  const now = Date.parse("2026-11-26T09:00:00.000Z");
  const claudeFallback: TeamModelProfile = { id: "claude-fallback", label: "Claude Fallback", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
  const codexPrimary: TeamModelProfile = { id: "codex-primary", label: "Codex Primary", provider: "codex", model: "gpt-6-astra", effort: "low", tier: "light", limitFallback: "claude-fallback" };
  const lineup: TeamLineup = {
    coordinator: { id: "coord", label: "Coord", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
    integrator: { id: "integ", label: "Integ", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" },
    reviewer: { id: "rev", label: "Rev", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
    implementers: [codexPrimary],
    fallbacks: [claudeFallback],
  };

  f.config.teams!.stallMinutes = 60;
  f.run.lineup = lineup;
  f.run.provider = "codex";
  f.run.blackboard = { tools: true };
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.tasks = [
    { id: "t1", title: "Task 1", instructions: "Implement T1", agentProfileId: "codex-primary", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" },
    { id: "t2", title: "Task 2", instructions: "Implement T2", agentProfileId: "codex-primary", paths: ["b.txt"], dependsOn: [], revision: 1, status: "running" },
  ];
  f.run.parallelism = 2;

  const builtOne = appendBuiltPrompt(
    teamPromptSpec(f.run, "implementer", f.run.tasks[0], undefined, "codex", codexPrimary),
    "User answered: Keep existing API.",
  );
  const builtTwo = appendBuiltPrompt(
    teamPromptSpec(f.run, "implementer", f.run.tasks[1], undefined, "codex", codexPrimary),
    "User answered: Switch cleanly on limit.",
  );

  const memberOne: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "t1", entryTools: true,
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: t1",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit,
    prompt: "Stale pre-upgrade Codex prompt with obsolete tool-rule prose.",
    promptSections: builtOne.promptSections,
    cursor: 0, stopRequestId: randomUUID(),
  };
  const memberTwo: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "t2", entryTools: true,
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: t2",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit,
    prompt: "Stale pre-upgrade Codex prompt that should switch to Claude.",
    promptSections: builtTwo.promptSections,
    cursor: 0, stopRequestId: randomUUID(),
  };
  f.run.tasks[0]!.memberId = memberOne.memberId;
  f.run.tasks[1]!.memberId = memberTwo.memberId;
  f.run.members = [memberOne];
  f.writeTeam();

  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as PromptRetargetServiceInternal;
  const stored = internal.records.get(f.run.id)!;

  const view = teams.get(f.run.id);
  assert.equal("promptSections" in view.members[0]!, false, "TeamView omits internal promptSections");

  await internal.step(stored);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]!.provider, "codex");
  assert.ok(f.launches[0]!.prompt.includes(codexSandboxInstructions), "same-provider launch renders current Codex sandbox block");
  assert.ok(f.launches[0]!.prompt.includes(codexMemberToolInstructions(true)), "same-provider launch renders current Codex tool signatures");
  assert.ok(f.launches[0]!.prompt.includes(entryInstructions("codex")));
  assert.ok(f.launches[0]!.prompt.includes(reportingInstructions("codex")));
  assert.ok(f.launches[0]!.prompt.includes("User answered: Keep existing API."));
  assert.equal(f.launches[0]!.prompt.includes("Stale pre-upgrade Codex prompt"), false);

  const codexLimit = { provider: "codex" as const, detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 10 * 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(), sessionId: "s-codex", confidence: "corroborated" as const };
  const switchDecision = resolveProviderLimitLaunch(stored.run, memberTwo, [codexLimit], new Set(["codex"]));
  assert.equal(switchDecision.kind, "switch");
  const originalSections = memberTwo.promptSections;
  const undo = commitProviderLimitSwitch(stored.run, memberTwo, switchDecision, () => {});
  assert.equal(memberTwo.provider, "claude");
  assert.ok(memberTwo.prompt.includes(reportingInstructions("claude")));
  assert.equal(undo(), true);
  assert.equal(memberTwo.provider, "codex");
  assert.equal(memberTwo.prompt, "Stale pre-upgrade Codex prompt that should switch to Claude.");
  assert.equal(memberTwo.promptSections, originalSections, "rollback restores original promptSections");

  stored.run.members.push(memberTwo);
  internal.limits.observe(codexLimit);
  await internal.step(stored);
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1]!.provider, "claude");
  assert.equal(f.launches[1]!.profile?.id, "claude-fallback");
  assert.ok(f.launches[1]!.prompt.includes(profileInstructions(claudeFallback)));
  assert.ok(f.launches[1]!.prompt.includes(entryInstructions("claude")));
  assert.ok(f.launches[1]!.prompt.includes(reportingInstructions("claude")));
  assert.ok(f.launches[1]!.prompt.includes("User answered: Switch cleanly on limit."));
  assert.equal(f.launches[1]!.prompt.includes(codexSandboxInstructions), false);
  assert.equal(f.launches[1]!.prompt.includes("Working rule for tools:"), false);
});

test("legacy persisted prompt-only members load, retarget recognizable prompts, defer unrecognized ones, and upgrade on running limit switch", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T10:00:00.000Z");
  const claudeFallback: TeamModelProfile = { id: "claude-fallback", label: "Claude Fallback", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
  const codexPrimary: TeamModelProfile = { id: "codex-primary", label: "Codex Primary", provider: "codex", model: "gpt-6-astra", effort: "low", tier: "light", limitFallback: "claude-fallback" };
  const lineup: TeamLineup = {
    coordinator: { id: "coord", label: "Coord", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
    integrator: { id: "integ", label: "Integ", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" },
    reviewer: { id: "rev", label: "Rev", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
    implementers: [codexPrimary],
    fallbacks: [claudeFallback],
  };

  f.config.teams!.stallMinutes = 60;
  f.run.lineup = lineup;
  f.run.provider = "codex";
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.parallelism = 3;
  f.run.tasks = [
    { id: "legacy-ok", title: "Legacy recognizable", instructions: "Do ok", agentProfileId: "codex-primary", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" },
    { id: "legacy-old-rule", title: "Legacy old rule", instructions: "Do old", agentProfileId: "codex-primary", paths: ["b.txt"], dependsOn: [], revision: 1, status: "running" },
    { id: "legacy-running", title: "Legacy running", instructions: "Do running", agentProfileId: "codex-primary", paths: ["c.txt"], dependsOn: [], revision: 1, status: "running" },
  ];

  const currentCodexPrompt = teamPrompt(f.run, "implementer", f.run.tasks[0], undefined, "codex", codexPrimary);
  const obsoleteRulePrompt = teamPrompt(f.run, "implementer", f.run.tasks[1], undefined, "codex", codexPrimary)
    .replace(codexMemberToolInstructions(false), "Working rule for tools: obsolete schema wording from an older release.");
  assert.notEqual(obsoleteRulePrompt, teamPrompt(f.run, "implementer", f.run.tasks[1], undefined, "codex", codexPrimary));

  const legacyOk: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "legacy-ok",
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: legacy-ok",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: currentCodexPrompt, cursor: 0, stopRequestId: randomUUID(),
  };
  const legacyOldRule: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "legacy-old-rule",
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: legacy-old-rule",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: obsoleteRulePrompt, cursor: 0, stopRequestId: randomUUID(),
  };
  const legacyRunning: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "legacy-running",
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: f.run.members[0]!.sessionId, title: "implementer: legacy-running",
    status: "running", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: obsoleteRulePrompt, cursor: 0, stopRequestId: randomUUID(),
    startedAt: new Date(now - 60_000).toISOString(),
  };
  f.run.decisions = [{
    id: "d-legacy", memberId: legacyRunning.memberId, revision: 1, question: "Which format?", options: [],
    createdAt: new Date(now - 30_000).toISOString(), answer: "Keep JSON.", answeredBy: "owner", answeredAt: new Date(now - 20_000).toISOString(),
  }];
  f.run.tasks[0]!.memberId = legacyOk.memberId;
  f.run.tasks[1]!.memberId = legacyOldRule.memberId;
  f.run.tasks[2]!.memberId = legacyRunning.memberId;
  f.run.members = [legacyOk, legacyOldRule, legacyRunning];
  f.writeTeam();

  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as PromptRetargetServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const codexReset = new Date(now + 10 * 60_000).toISOString();
  internal.limits.observe({ provider: "codex", detectedAt: new Date(now).toISOString(), resetsAt: codexReset, sessionId: "s-codex", confidence: "corroborated" });

  await internal.step(stored);
  assert.equal(f.launches.length, 1, "recognizable legacy member switches onto Claude while unrecognized legacy member defers fail-closed");
  assert.equal(f.launches[0]!.provider, "claude");
  assert.ok(f.launches[0]!.prompt.includes(reportingInstructions("claude")));
  assert.equal(f.launches[0]!.prompt.includes(codexSandboxInstructions), false);
  assert.equal(stored.run.members[1]!.status, "queued");
  assert.equal(stored.run.members[1]!.pendingLimit, true);

  await internal.switchLimitedMember(stored, stored.run.members[2]!, {
    kind: "limit", limit: "usage", confidence: "corroborated", message: "limit", resetsAt: codexReset, at: new Date(now).toISOString(), seq: 1,
  });
  const deadline = Date.now() + 10_000;
  while (stored.pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await teams.idle();
  const upgraded = stored.run.members.at(-1)!;
  assert.equal(upgraded.taskId, "legacy-running");
  assert.equal(upgraded.provider, "claude");
  assert.ok(Array.isArray(upgraded.promptSections), "running legacy fallback rebuilds with structured promptSections");
  assert.ok(upgraded.prompt.includes(reportingInstructions("claude")));
  assert.ok(upgraded.prompt.includes("User answered: Keep JSON."));
  assert.equal(upgraded.prompt.includes("obsolete schema wording"), false);

  now = Date.parse(codexReset) + 1000;
  await internal.step(stored);
  const oldRuleLaunch = f.launches.find(launch => launch.requestId === stored.run.members[1]!.sessionId);
  assert.ok(oldRuleLaunch, "deferred legacy prompt launches once Codex limit clears");
  assert.equal(oldRuleLaunch!.provider, "codex");
  assert.equal(oldRuleLaunch!.prompt.includes("obsolete schema wording"), true);
});
