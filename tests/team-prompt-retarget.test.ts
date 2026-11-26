import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  TEAM_PROMPT_LIMIT_BYTES,
  appendBuiltPrompt,
  attachMemberScratchPrompt,
  codexMemberToolInstructions,
  codexSandboxInstructions,
  contextAccessInstructions,
  entryInstructions,
  escalationInstructions,
  escalationSpec,
  getMemberPromptSections,
  permissionFollowUpPromptSpec,
  profileInstructions,
  readOnlyWorkspaceInstructions,
  refreshBuiltPrompt,
  refreshMemberPromptForLaunch,
  refreshReportingInstructions,
  renderPromptSections,
  reportingInstructions,
  retargetBuiltPrompt,
  retargetPrompt,
  retargetPromptSections,
  storedPromptSectionsEntry,
  teamPrompt,
  teamPromptSpec,
  type MemberPromptSectionStore,
  type TeamPromptSection,
} from "../packages/host/src/team-prompts.js";
import { intentCheckerPrompt, intentCheckerPromptSpec } from "../packages/host/src/intent-prompt.js";
import { evaluatorPrompt, evaluatorPromptSpec } from "../packages/host/src/verdict-prompt.js";
import { judgePrompt, judgePromptSpec } from "../packages/host/src/judge-prompt.js";
import { commitProviderLimitSwitch, resolveProviderLimitLaunch } from "../packages/host/src/team-diagnostics.js";
import { permissionEvidenceHash } from "../packages/host/src/team-permissions.js";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService, type Stored } from "../packages/host/src/teams.js";
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

const LEGACY_SHIPPED_CODEX_RULES = [
  {
    name: "v1-short-report-only",
    entryTools: false,
    sha256: "77d618fea6ee839cec3d9641f560e0ce2749985fc0330a1463b38c75470833b5",
    text: "Working rule for tools: when you call tools through exec, do the reading, filtering, counting and comparing inside the program, and print only the result you need for your next decision. Do not print whole tool results. When a program lists or reads items, print how many it listed, read, and matched. Read the context file with a shell call inside a program, and select only the fields needed for your next decision. Tool signatures (arguments -> fields of a successful result's structuredContent): report({report}) -> {requestId, runId, memberId, revision, message}.",
  },
  {
    name: "v1-short-with-entries",
    entryTools: true,
    sha256: "7595d799220ed280b9f93aacd694e6362570b107e7bb19ac814a8c431ae4ac10",
    text: "Working rule for tools: when you call tools through exec, do the reading, filtering, counting and comparing inside the program, and print only the result you need for your next decision. Do not print whole tool results. When a program lists or reads items, print how many it listed, read, and matched. Read the context file with a shell call inside a program, and select only the fields needed for your next decision. Tool signatures (arguments -> fields of a successful result's structuredContent): report({report}) -> {requestId, runId, memberId, revision, message}; entry_list({kinds?, taskId?, path?, since?, limit?}) -> {notice, heads, more, cursor?, unreadable}; entry_get({entryId}) -> {notice, head, body}; entry_post({entry}) -> {entryId, state, message}.",
  },
  {
    name: "v2-schema-report-only",
    entryTools: false,
    sha256: "e6ff71704aae9e01b8e94482cd8f49b02fd685de11b68cb863b6129f14888887",
    text: "Working rule for tools: when you call tools through exec, do the reading, filtering, counting and comparing inside the program, and print only the result you need for your next decision. Do not print whole tool results. When a program lists or reads items, print how many it listed, read, and matched. Read the context file with a shell call inside a program, and select only the fields needed for your next decision. Tool signatures inside exec (generated from the tools' declared schemas, no lookup needed): await tools.mcp__infinite_team__report({ report }) returns { structuredContent: { requestId: string, runId: string, memberId: string, revision: number, message: string } }. Each type is the result of a successful call. When a tool reports a failure the call does not throw: its result has isError true and the reason in content[0].text, and no structuredContent. Check isError before you read structuredContent, and print the reason.",
  },
  {
    name: "v2-schema-with-entries",
    entryTools: true,
    sha256: "6896da1485bc8ccbafa98bc08d6a3f27eaf54884f17acdb68c4e725ff0845bab",
    text: "Working rule for tools: when you call tools through exec, do the reading, filtering, counting and comparing inside the program, and print only the result you need for your next decision. Do not print whole tool results. When a program lists or reads items, print how many it listed, read, and matched. Read the context file with a shell call inside a program, and select only the fields needed for your next decision. Tool signatures inside exec (generated from the tools' declared schemas, no lookup needed): await tools.mcp__infinite_team__report({ report }) returns { structuredContent: { requestId: string, runId: string, memberId: string, revision: number, message: string } }. await tools.mcp__infinite_team__entry_list({ kinds?, taskId?, path?, since?, limit? }) returns { structuredContent: { notice: string, heads: Array<{ entryId: string, seq: number, at: string, kind: \"contract\"|\"finding\"|\"blocker\"|\"handoff\"|\"report\"|\"integration\"|\"check\"|\"direction\", author: \"host\"|\"member\"|\"owner\", authority: \"receipt\"|\"claim\"|\"direction\", authorRole?: \"permission-coordinator\"|\"project-manager\"|\"scout\"|\"implementer\"|\"integrator\"|\"reviewer\"|\"delivery\"|\"intent-checker\"|\"mission-coordinator\", taskId?: string, paths: string[], summary: string, bodyBytes: number, supersedes?: string, state: \"active\"|\"superseded\"|\"withdrawn\" }>, more: boolean, cursor?: number, unreadable: number } }. await tools.mcp__infinite_team__entry_get({ entryId }) returns { structuredContent: { notice: string, head: { entryId: string, seq: number, at: string, kind: \"contract\"|\"finding\"|\"blocker\"|\"handoff\"|\"report\"|\"integration\"|\"check\"|\"direction\", author: \"host\"|\"member\"|\"owner\", authority: \"receipt\"|\"claim\"|\"direction\", authorRole?: \"permission-coordinator\"|\"project-manager\"|\"scout\"|\"implementer\"|\"integrator\"|\"reviewer\"|\"delivery\"|\"intent-checker\"|\"mission-coordinator\", taskId?: string, paths: string[], summary: string, bodyBytes: number, supersedes?: string, state: \"active\"|\"superseded\"|\"withdrawn\" }, body: unknown } }. await tools.mcp__infinite_team__entry_post({ entry }) returns { structuredContent: { entryId: string, state: \"pending\", message: string } }. Each type is the result of a successful call. When a tool reports a failure the call does not throw: its result has isError true and the reason in content[0].text, and no structuredContent. Check isError before you read structuredContent, and print the reason.",
  },
] as const;

function baseHostRollbackMemberProjection(member: TeamMember): Record<string, unknown> {
  const {
    prompt: _prompt,
    contextFeedback: _feedback,
    nativeSessionId: _nativeSessionId,
    goalCriteriaPlan: _goalCriteriaPlan,
    continuation: _continuation,
    turns: _turns,
    pendingFeedback: _pendingFeedback,
    ...rest
  } = member as TeamMember & Record<string, unknown>;
  return rest;
}

test("sealed persisted members keep promptSections outside run.members for rollback privacy, re-render on launch/fallback, and prune orphans", async t => {
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
  f.run.parallelism = 3;

  const builtOne = appendBuiltPrompt(
    teamPromptSpec(f.run, "implementer", f.run.tasks[0], undefined, "codex", codexPrimary),
    "User answered: Keep existing API.",
  );
  const builtTwo = appendBuiltPrompt(
    teamPromptSpec(f.run, "implementer", f.run.tasks[1], undefined, "codex", codexPrimary),
    "User answered: Switch cleanly on limit.",
  );
  const permissionEvidenceSentinel = "CONFIDENTIAL_PERMISSION_REQUEST_AND_FILE_EVIDENCE_SENTINEL";
  const builtCoordinator = teamPromptSpec(
    f.run,
    "permission-coordinator",
    undefined,
    `Recorded permission request and collected file evidence: ${permissionEvidenceSentinel}`,
    "claude",
    lineup.reviewer,
  );

  const memberOne: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "t1", entryTools: true,
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: t1",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit,
    prompt: "Stale pre-upgrade Codex prompt with obsolete tool-rule prose.",
    cursor: 0, stopRequestId: randomUUID(),
  };
  const memberTwo: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "t2", entryTools: true,
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: t2",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit,
    prompt: "Stale pre-upgrade Codex prompt that should switch to Claude.",
    cursor: 0, stopRequestId: randomUUID(),
  };
  const coordinatorMember: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "permission-coordinator",
    provider: "claude", modelProfile: structuredClone(lineup.reviewer), sessionId: randomUUID(), title: "permission-coordinator",
    status: "waiting", cwd: f.run.workspace, baseCommit: f.run.baseCommit,
    prompt: builtCoordinator.prompt,
    cursor: 0, stopRequestId: randomUUID(),
  };
  const targetMember = f.run.members[0]!;
  targetMember.role = "implementer";
  targetMember.taskId = "t1";
  const screenPrompt = { id: "perm-b", hash: "hash-b", kind: "permission" as const, title: "Run check", summary: "Run check", options: [{ label: "Yes", key: "y" }] };
  f.state.attention = { ...f.state.attention, state: "needs-you", prompt: screenPrompt };
  f.run.permissions = { mode: "coordinator", scope: "Run tests." };
  const overwrittenCoordSentinel = "NEW_DECISION_B_EVIDENCE_FROM_ROLLED_BACK_HOST";
  const staleCoordSentinel = "OLD_DECISION_A_EVIDENCE_BEFORE_ROLLBACK";
  const builtOldCoordTurn = teamPromptSpec(f.run, "permission-coordinator", undefined, `Old decision A: ${staleCoordSentinel}`, "claude", lineup.reviewer);
  const rolledBackCoordMember: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "permission-coordinator",
    provider: "claude", modelProfile: structuredClone(lineup.reviewer), sessionId: randomUUID(), title: "permission-coordinator-turn-b",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit,
    prompt: teamPrompt(f.run, "permission-coordinator", undefined, `New decision B: ${overwrittenCoordSentinel}`, "claude", lineup.reviewer),
    cursor: 0, stopRequestId: randomUUID(),
  };
  f.run.permissionDecisions = [{
    id: randomUUID(), revision: 1, status: "reviewing", policyHash: "p", authorityHash: "a",
    targetMemberId: targetMember.memberId, targetSessionId: targetMember.sessionId,
    coordinatorMemberId: rolledBackCoordMember.memberId, coordinatorSessionId: rolledBackCoordMember.sessionId,
    promptId: screenPrompt.id, promptHash: screenPrompt.hash, evidenceHash: permissionEvidenceHash(screenPrompt),
    prompt: screenPrompt, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60_000).toISOString(),
  }];
  const orphanMemberId = randomUUID();
  f.run.tasks[0]!.memberId = memberOne.memberId;
  f.run.tasks[1]!.memberId = memberTwo.memberId;
  f.run.members = [targetMember, memberOne, coordinatorMember, rolledBackCoordMember];
  f.writeTeam({
    memberPromptSections: {
      [memberOne.memberId]: storedPromptSectionsEntry(memberOne.prompt, builtOne.promptSections!),
      [coordinatorMember.memberId]: storedPromptSectionsEntry(coordinatorMember.prompt, builtCoordinator.promptSections!),
      [rolledBackCoordMember.memberId]: storedPromptSectionsEntry(builtOldCoordTurn.prompt, builtOldCoordTurn.promptSections),
      [orphanMemberId]: storedPromptSectionsEntry(memberTwo.prompt, builtTwo.promptSections!),
    },
  });

  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as PromptRetargetServiceInternal;
  const stored = internal.records.get(f.run.id)!;

  assert.equal(getMemberPromptSections(stored, { memberId: orphanMemberId, prompt: memberTwo.prompt }), undefined, "stale orphan sections are pruned on load");
  assert.equal(getMemberPromptSections(stored, rolledBackCoordMember), undefined, "mismatched digest from rolled-back host discards stale permission sections");
  assert.equal(stored.memberPromptSections?.[rolledBackCoordMember.memberId], undefined, "stale mismatched entry is pruned on load");
  assert.ok(getMemberPromptSections(stored, memberOne), "live member sections remain loaded on Stored");
  assert.ok(getMemberPromptSections(stored, coordinatorMember), "permission coordinator sections remain loaded on Stored");

  const directMismatchStore: MemberPromptSectionStore = {
    memberPromptSections: { [rolledBackCoordMember.memberId]: storedPromptSectionsEntry(builtOldCoordTurn.prompt, builtOldCoordTurn.promptSections) },
  };
  assert.equal(refreshMemberPromptForLaunch(directMismatchStore, rolledBackCoordMember, "claude"), true, "direct refresh discards stale mismatched entry");
  assert.equal(directMismatchStore.memberPromptSections, undefined, "stale mismatched entry removed from store");
  assert.ok(rolledBackCoordMember.prompt.includes(overwrittenCoordSentinel), "newer prompt is preserved");
  assert.equal(rolledBackCoordMember.prompt.includes(staleCoordSentinel), false, "older sections never overwrite newer prompt");

  const view = teams.get(f.run.id);
  for (const item of view.members) {
    assert.equal("promptSections" in item, false, "TeamView omits promptSections");
  }
  assert.equal(JSON.stringify(view).includes(permissionEvidenceSentinel), false, "TeamView hides permission coordinator prompt evidence");

  await internal.step(stored);
  assert.equal(f.launches.length, 2);
  const impLaunch = f.launches.find(item => item.requestId === memberOne.sessionId)!;
  const coordLaunch = f.launches.find(item => item.requestId === rolledBackCoordMember.sessionId)!;
  assert.equal(impLaunch.provider, "codex");
  assert.ok(impLaunch.prompt.includes(codexSandboxInstructions), "same-provider launch renders current Codex sandbox block");
  assert.ok(impLaunch.prompt.includes(codexMemberToolInstructions(true)), "same-provider launch renders current Codex tool signatures");
  assert.ok(impLaunch.prompt.includes(entryInstructions("codex")));
  assert.ok(impLaunch.prompt.includes(reportingInstructions("codex")));
  assert.ok(impLaunch.prompt.includes("User answered: Keep existing API."));
  assert.equal(impLaunch.prompt.includes("Stale pre-upgrade Codex prompt"), false);
  assert.ok(coordLaunch.prompt.includes(overwrittenCoordSentinel), "rolled-back permission turn launches with newer decision B prompt");
  assert.equal(coordLaunch.prompt.includes(staleCoordSentinel), false, "stale decision A sections never leak into decision B launch");

  const persistedAfterLaunch = f.readRecord<Stored>("team", f.run.id);
  assert.equal(persistedAfterLaunch.memberPromptSections?.[orphanMemberId], undefined, "sealed disk state omits pruned orphans");
  for (const savedMember of persistedAfterLaunch.run.members) {
    assert.equal("promptSections" in savedMember, false, "sealed run.members never carries promptSections");
    const rolledBackView = baseHostRollbackMemberProjection(savedMember);
    assert.equal("promptSections" in rolledBackView, false, "base-host rollback TeamView spread never exposes promptSections");
    assert.equal(JSON.stringify(rolledBackView).includes(permissionEvidenceSentinel), false, "base-host rollback TeamView never leaks permission coordinator evidence");
  }

  const codexLimit = { provider: "codex" as const, detectedAt: new Date(now).toISOString(), resetsAt: new Date(now + 10 * 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(), sessionId: "s-codex", confidence: "corroborated" as const };
  const rollbackStore: MemberPromptSectionStore = { memberPromptSections: { [memberTwo.memberId]: storedPromptSectionsEntry(memberTwo.prompt, builtTwo.promptSections!) } };
  const switchDecision = resolveProviderLimitLaunch(stored.run, memberTwo, [codexLimit], new Set(["codex"]), undefined, getMemberPromptSections(rollbackStore, memberTwo));
  assert.equal(switchDecision.kind, "switch");
  const originalSections = getMemberPromptSections(rollbackStore, memberTwo);
  const undo = commitProviderLimitSwitch(stored.run, memberTwo, switchDecision, () => {}, rollbackStore);
  assert.equal(memberTwo.provider, "claude");
  assert.ok(memberTwo.prompt.includes(reportingInstructions("claude")));
  assert.equal("promptSections" in memberTwo, false, "commit keeps promptSections off TeamMember");
  assert.equal(undo(), true);
  assert.equal(memberTwo.provider, "codex");
  assert.equal(memberTwo.prompt, "Stale pre-upgrade Codex prompt that should switch to Claude.");
  assert.equal(getMemberPromptSections(rollbackStore, memberTwo), originalSections, "rollback restores original Stored promptSections");

  stored.run.members.push(memberTwo);
  (stored.memberPromptSections ??= {})[memberTwo.memberId] = storedPromptSectionsEntry(memberTwo.prompt, builtTwo.promptSections!);
  internal.limits.observe(codexLimit);
  await internal.step(stored);
  assert.equal(f.launches.length, 3);
  const switchedLaunch = f.launches.find(item => item.requestId === memberTwo.sessionId)!;
  assert.equal(switchedLaunch.provider, "claude");
  assert.equal(switchedLaunch.profile?.id, "claude-fallback");
  assert.ok(switchedLaunch.prompt.includes(profileInstructions(claudeFallback)));
  assert.ok(switchedLaunch.prompt.includes(entryInstructions("claude")));
  assert.ok(switchedLaunch.prompt.includes(reportingInstructions("claude")));
  assert.ok(switchedLaunch.prompt.includes("User answered: Switch cleanly on limit."));
  assert.equal(switchedLaunch.prompt.includes(codexSandboxInstructions), false);
  assert.equal(switchedLaunch.prompt.includes("Working rule for tools:"), false);
  const persistedFinal = f.readRecord<Stored>("team", f.run.id);
  for (const savedMember of persistedFinal.run.members) {
    assert.equal("promptSections" in savedMember, false, "sealed run.members stays free of promptSections after fallback switch");
  }
});

test("legacy persisted prompt-only members recognize all four shipped Codex rules, defer unrecognized rules, and upgrade on running limit switch", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  let now = Date.parse("2026-11-26T10:00:00.000Z");
  const claudeFallback: TeamModelProfile = { id: "claude-fallback", label: "Claude Fallback", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
  const codexPrimary: TeamModelProfile = { id: "codex-primary", label: "Codex Primary", provider: "codex", model: "gpt-6-astra", effort: "low", tier: "light", limitFallback: "claude-fallback" };
  const opencodeProfile: TeamModelProfile = { id: "deepseek-light", label: "DeepSeek", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light" };
  const lineup: TeamLineup = {
    coordinator: { id: "coord", label: "Coord", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
    integrator: { id: "integ", label: "Integ", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" },
    reviewer: { id: "rev", label: "Rev", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
    implementers: [codexPrimary],
    fallbacks: [claudeFallback],
  };

  for (const variant of LEGACY_SHIPPED_CODEX_RULES) {
    assert.equal(createHash("sha256").update(variant.text).digest("hex"), variant.sha256, `frozen hash matches ${variant.name}`);
    const run = smallRun(variant.entryTools ? { blackboard: { tools: true } } : {});
    const legacyPrompt = teamPrompt(run, "implementer", undefined, undefined, "codex", codexPrimary)
      .replace(codexMemberToolInstructions(variant.entryTools), variant.text);
    const toClaudeBuilt = retargetBuiltPrompt({ prompt: legacyPrompt }, { provider: "claude", profile: claudeFallback, role: "implementer", entryTools: variant.entryTools });
    assert.equal(toClaudeBuilt?.prompt, teamPrompt(run, "implementer", undefined, undefined, "claude", claudeFallback), `${variant.name} -> claude`);
    assert.ok(Array.isArray(toClaudeBuilt?.promptSections), `${variant.name} -> claude upgrades to structured sections`);
    assert.equal(renderPromptSections(toClaudeBuilt!.promptSections!, { provider: "claude", profile: claudeFallback, role: "implementer", entryTools: variant.entryTools }), toClaudeBuilt!.prompt);
    const toOpenCode = retargetBuiltPrompt({ prompt: legacyPrompt }, { provider: "opencode", profile: opencodeProfile, role: "implementer", entryTools: variant.entryTools });
    assert.equal(toOpenCode?.prompt, teamPrompt(run, "implementer", undefined, undefined, "opencode", opencodeProfile), `${variant.name} -> opencode`);
    assert.ok(Array.isArray(toOpenCode?.promptSections), `${variant.name} -> opencode upgrades to structured sections`);
    const toCodex = retargetBuiltPrompt({ prompt: legacyPrompt }, { provider: "codex", profile: codexPrimary, role: "implementer", entryTools: variant.entryTools });
    assert.equal(toCodex?.prompt, teamPrompt(run, "implementer", undefined, undefined, "codex", codexPrimary), `${variant.name} -> codex upgrades rule`);
    assert.ok(Array.isArray(toCodex?.promptSections), `${variant.name} -> codex upgrades to structured sections`);
  }

  f.config.teams!.stallMinutes = 60;
  f.run.lineup = lineup;
  f.run.provider = "codex";
  f.run.blackboard = { tools: true };
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.parallelism = 4;
  f.run.tasks = [
    { id: "legacy-v1-short", title: "Legacy v1 short", instructions: "Do v1", agentProfileId: "codex-primary", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" },
    { id: "legacy-v1-entries", title: "Legacy v1 entries", instructions: "Do v1 entries", agentProfileId: "codex-primary", paths: ["b.txt"], dependsOn: [], revision: 1, status: "running" },
    { id: "legacy-unknown-rule", title: "Legacy unknown rule", instructions: "Do unknown", agentProfileId: "codex-primary", paths: ["c.txt"], dependsOn: [], revision: 1, status: "running" },
    { id: "legacy-running", title: "Legacy running", instructions: "Do running", agentProfileId: "codex-primary", paths: ["d.txt"], dependsOn: [], revision: 1, status: "running" },
  ];

  const v1ShortPrompt = teamPrompt({ ...f.run, blackboard: undefined }, "implementer", f.run.tasks[0], undefined, "codex", codexPrimary)
    .replace(codexMemberToolInstructions(false), LEGACY_SHIPPED_CODEX_RULES[0].text);
  const v1EntriesPrompt = teamPrompt(f.run, "implementer", f.run.tasks[1], undefined, "codex", codexPrimary)
    .replace(codexMemberToolInstructions(true), LEGACY_SHIPPED_CODEX_RULES[1].text);
  const unknownRulePrompt = teamPrompt(f.run, "implementer", f.run.tasks[2], undefined, "codex", codexPrimary)
    .replace(codexMemberToolInstructions(true), "Working rule for tools: unrecognized unshipped wording.");
  assert.notEqual(unknownRulePrompt, teamPrompt(f.run, "implementer", f.run.tasks[2], undefined, "codex", codexPrimary));

  const legacyV1Short: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "legacy-v1-short",
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: legacy-v1-short",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: v1ShortPrompt, cursor: 0, stopRequestId: randomUUID(),
  };
  const legacyV1Entries: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "legacy-v1-entries", entryTools: true,
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: legacy-v1-entries",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: v1EntriesPrompt, cursor: 0, stopRequestId: randomUUID(),
  };
  const legacyUnknownRule: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "legacy-unknown-rule", entryTools: true,
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: legacy-unknown-rule",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: unknownRulePrompt, cursor: 0, stopRequestId: randomUUID(),
  };
  const legacyRunning: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "legacy-running", entryTools: true,
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: f.run.members[0]!.sessionId, title: "implementer: legacy-running",
    status: "running", cwd: f.run.workspace, baseCommit: f.run.baseCommit, prompt: unknownRulePrompt, cursor: 0, stopRequestId: randomUUID(),
    startedAt: new Date(now - 60_000).toISOString(),
  };
  f.run.decisions = [{
    id: "d-legacy", memberId: legacyRunning.memberId, revision: 1, question: "Which format?", options: [],
    createdAt: new Date(now - 30_000).toISOString(), answer: "Keep JSON.", answeredBy: "owner", answeredAt: new Date(now - 20_000).toISOString(),
  }];
  f.run.tasks[0]!.memberId = legacyV1Short.memberId;
  f.run.tasks[1]!.memberId = legacyV1Entries.memberId;
  f.run.tasks[2]!.memberId = legacyUnknownRule.memberId;
  f.run.tasks[3]!.memberId = legacyRunning.memberId;
  f.run.members = [legacyV1Short, legacyV1Entries, legacyUnknownRule, legacyRunning];
  f.writeTeam();

  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as PromptRetargetServiceInternal;
  const stored = internal.records.get(f.run.id)!;
  const codexReset = new Date(now + 10 * 60_000).toISOString();
  internal.limits.observe({ provider: "codex", detectedAt: new Date(now).toISOString(), resetsAt: codexReset, sessionId: "s-codex", confidence: "corroborated" });

  await internal.step(stored);
  assert.equal(f.launches.length, 2, "both shipped v1 legacy Codex members switch onto Claude while unrecognized rule defers");
  for (const launch of f.launches) {
    assert.equal(launch.provider, "claude");
    assert.ok(launch.prompt.includes(reportingInstructions("claude")));
    assert.equal(launch.prompt.includes(codexSandboxInstructions), false);
    assert.equal(launch.prompt.includes("Working rule for tools:"), false);
  }
  const persistedLegacyUpgrade = f.readRecord<Stored>("team", f.run.id);
  assert.ok(Array.isArray(getMemberPromptSections(persistedLegacyUpgrade, stored.run.members[0]!)), "switched legacy v1 short member persists structured sections");
  assert.ok(Array.isArray(getMemberPromptSections(persistedLegacyUpgrade, stored.run.members[1]!)), "switched legacy v1 entries member persists structured sections");
  assert.equal(stored.run.members[2]!.status, "queued");
  assert.equal(stored.run.members[2]!.pendingLimit, true);

  await internal.switchLimitedMember(stored, stored.run.members[3]!, {
    kind: "limit", limit: "usage", confidence: "corroborated", message: "limit", resetsAt: codexReset, at: new Date(now).toISOString(), seq: 1,
  });
  const deadline = Date.now() + 10_000;
  while (stored.pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await teams.idle();
  const upgraded = stored.run.members.at(-1)!;
  assert.equal(upgraded.taskId, "legacy-running");
  assert.equal(upgraded.provider, "claude");
  assert.equal("promptSections" in upgraded, false, "upgraded member stores sections on Stored, not on TeamMember");
  assert.ok(Array.isArray(getMemberPromptSections(stored, upgraded)), "running legacy fallback rebuilds with structured sections on Stored");
  assert.ok(upgraded.prompt.includes(reportingInstructions("claude")));
  assert.ok(upgraded.prompt.includes("User answered: Keep JSON."));
  assert.equal(upgraded.prompt.includes("unrecognized unshipped wording"), false);

  now = Date.parse(codexReset) + 1000;
  await internal.step(stored);
  const oldRuleLaunch = f.launches.find(launch => launch.requestId === stored.run.members[2]!.sessionId);
  assert.ok(oldRuleLaunch, "deferred legacy prompt launches once Codex limit clears");
  assert.equal(oldRuleLaunch!.provider, "codex");
  assert.equal(oldRuleLaunch!.prompt.includes("unrecognized unshipped wording"), true);
});

test("same-provider launch refresh, unchanged retries, and scratch append enforce TEAM_PROMPT_LIMIT_BYTES", async t => {
  const f = schedulerFixture();
  t.after(() => f.close());
  const now = Date.parse("2026-11-26T11:00:00.000Z");
  const codexPrimary: TeamModelProfile = { id: "codex-primary", label: "Codex Primary", provider: "codex", model: "gpt-6-astra", effort: "low", tier: "light" };
  f.config.teams!.stallMinutes = 60;
  f.run.provider = "codex";
  f.run.blackboard = { tools: true };
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  f.run.tasks = [
    { id: "near-cap", title: "Near cap", instructions: "Work within limit", agentProfileId: "codex-primary", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running" },
  ];

  const baseSpec = teamPromptSpec(f.run, "implementer", f.run.tasks[0], undefined, "codex", codexPrimary);
  const fillerBytes = TEAM_PROMPT_LIMIT_BYTES - Buffer.byteLength(baseSpec.prompt, "utf8") + 128;
  const overgrownSections: TeamPromptSection[] = [...baseSpec.promptSections, { kind: "text", text: "x".repeat(fillerBytes) }];
  const overgrownRendered = renderPromptSections(overgrownSections, { provider: "codex", profile: codexPrimary, role: "implementer", entryTools: true });
  const staleShorterPrompt = baseSpec.prompt;
  assert.ok(Buffer.byteLength(staleShorterPrompt, "utf8") <= TEAM_PROMPT_LIMIT_BYTES);
  assert.ok(Buffer.byteLength(overgrownRendered, "utf8") > TEAM_PROMPT_LIMIT_BYTES);

  const member: TeamMember = {
    runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "near-cap", entryTools: true,
    provider: "codex", modelProfile: structuredClone(codexPrimary), sessionId: randomUUID(), title: "implementer: near-cap",
    status: "queued", cwd: f.run.workspace, baseCommit: f.run.baseCommit,
    prompt: staleShorterPrompt,
    cursor: 0, stopRequestId: randomUUID(),
  };

  const directStore: MemberPromptSectionStore = { memberPromptSections: { [member.memberId]: storedPromptSectionsEntry(staleShorterPrompt, overgrownSections) } };
  assert.throws(
    () => refreshMemberPromptForLaunch(directStore, member, "codex"),
    error => error instanceof TeamError && error.code === "team-prompt-too-large",
    "unit refresh fails closed when re-rendered prompt exceeds TEAM_PROMPT_LIMIT_BYTES",
  );
  assert.equal(member.prompt, staleShorterPrompt, "refused refresh leaves member.prompt unchanged");

  const unchangedOverLimitMember: TeamMember = { ...member, memberId: randomUUID(), prompt: overgrownRendered };
  const unchangedStore: MemberPromptSectionStore = {
    memberPromptSections: { [unchangedOverLimitMember.memberId]: storedPromptSectionsEntry(overgrownRendered, overgrownSections) },
  };
  assert.throws(
    () => refreshMemberPromptForLaunch(unchangedStore, unchangedOverLimitMember, "codex"),
    error => error instanceof TeamError && error.code === "team-prompt-too-large",
    "unchanged retry prompt exceeding TEAM_PROMPT_LIMIT_BYTES still fails closed",
  );

  f.run.tasks[0]!.memberId = member.memberId;
  f.run.members = [member];
  f.writeTeam({ memberPromptSections: { [member.memberId]: storedPromptSectionsEntry(staleShorterPrompt, overgrownSections) } });

  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => now });
  t.after(() => teams.close());
  const internal = teams as unknown as PromptRetargetServiceInternal;
  const stored = internal.records.get(f.run.id)!;

  await internal.step(stored);
  assert.equal(f.launches.length, 0, "oversized refreshed prompt is never passed to createTeamSession");
  assert.equal(stored.run.status, "blocked");
  assert.equal(stored.run.blockCode, "team-prompt-too-large");
  assert.equal(stored.run.members[0]!.prompt, staleShorterPrompt, "blocked launch leaves persisted member.prompt untouched");

  const boundaryFill = TEAM_PROMPT_LIMIT_BYTES - Buffer.byteLength(baseSpec.prompt, "utf8") - 80;
  const boundarySections: TeamPromptSection[] = [...baseSpec.promptSections, { kind: "text", text: "b".repeat(boundaryFill) }];
  const boundaryRendered = renderPromptSections(boundarySections, { provider: "codex", profile: codexPrimary, role: "implementer", entryTools: true });
  assert.ok(Buffer.byteLength(boundaryRendered, "utf8") <= TEAM_PROMPT_LIMIT_BYTES, "boundary prompt fits before scratch append");
  const boundaryMember: TeamMember = {
    ...member, memberId: randomUUID(), sessionId: randomUUID(), prompt: boundaryRendered, scratchDirectory: undefined,
  };
  const boundaryStore: MemberPromptSectionStore = {
    memberPromptSections: { [boundaryMember.memberId]: storedPromptSectionsEntry(boundaryRendered, boundarySections) },
  };
  assert.equal(refreshMemberPromptForLaunch(boundaryStore, boundaryMember, "codex"), false, "refresh passes before scratch append");
  assert.throws(
    () => attachMemberScratchPrompt(boundaryStore, boundaryMember, () => "/srv/scratch/boundary"),
    error => error instanceof TeamError && error.code === "team-prompt-too-large",
    "appending scratch directory past TEAM_PROMPT_LIMIT_BYTES fails closed",
  );
  assert.equal(boundaryMember.scratchDirectory, undefined, "refused scratch append does not set scratchDirectory");
  assert.equal(boundaryMember.prompt, boundaryRendered, "refused scratch append leaves member.prompt unchanged");

  stored.run.status = "implementing";
  stored.run.blockCode = undefined;
  stored.run.reason = undefined;
  stored.halt = undefined;
  stored.run.members = [boundaryMember];
  stored.memberPromptSections = { [boundaryMember.memberId]: storedPromptSectionsEntry(boundaryRendered, boundarySections) };
  await internal.step(stored);
  assert.equal(f.launches.length, 0, "scratch-overflow launch never calls createTeamSession");
  assert.equal(stored.run.status, "blocked");
  assert.equal(stored.run.blockCode, "team-prompt-too-large");
  assert.equal(boundaryMember.scratchDirectory, undefined);
  assert.equal(boundaryMember.prompt, boundaryRendered);
});
