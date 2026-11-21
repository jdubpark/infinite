import test from "node:test";
import assert from "node:assert/strict";
import {
  codexMemberToolInstructions,
  codexSandboxInstructions,
  contextAccessInstructions,
  entryInstructions,
  profileInstructions,
  readOnlyWorkspaceInstructions,
  refreshReportingInstructions,
  reportingInstructions,
  retargetPrompt,
  teamPrompt,
} from "../packages/host/src/team-prompts.js";
import { intentCheckerPrompt } from "../packages/host/src/intent-prompt.js";
import type { TeamMember, TeamModelProfile } from "../packages/host/src/team-types.js";
import { ENTRY_PROFILE, ENTRY_PROVIDERS, smallRun } from "./fixtures/team-prompt-run.js";

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
