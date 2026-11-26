import test from "node:test";
import assert from "node:assert/strict";
import {
  EVAL_AGENT_ARGS_MAX,
  EVAL_AGENT_TEXT_MAX,
  EVAL_REPOSITORY_PREFIX_MAX,
  captureSettings,
  evalAgentSchema,
  evalCommandPrefix,
  evalHostSchema,
  evalProjectSchema,
  mineSettings,
  trialSettings,
  validationSettings,
  type EvalMemberConfig,
} from "../packages/host/src/eval-config.js";
import { OWNED_PATH_MAX_CHARS, ownedPathSchema } from "../packages/host/src/schema-primitives.js";
import { teamProjectSchema } from "../packages/host/src/team-types.js";
import { agentProfileSchema, learningPurpose, type AgentProfile } from "../packages/host/src/types.js";

const base = { checks: [], establishChecks: true } as const;

test("the eval block is optional and strict", () => {
  const without = teamProjectSchema.parse(base);
  assert.deepEqual(without, { checks: [], establishChecks: true });
  assert.equal("eval" in without, false);

  assert.deepEqual(teamProjectSchema.parse({ ...base, eval: { capture: true } }).eval, { capture: true });

  const rejects = (eval_: unknown) => assert.equal(teamProjectSchema.safeParse({ ...base, eval: eval_ }).success, false);
  rejects({ capture: true, unknownKey: 1 });
  rejects({ capture: true, retentionDays: 29 });
  rejects({ capture: true, retentionDays: 3651 });
  rejects({ testPaths: { prefixes: Array.from({ length: 33 }, (_, i) => `dir${i}/`), suffixes: [] } });
  rejects({ testPaths: { prefixes: [], suffixes: [] } });
  rejects({ testPaths: { prefixes: ["/abs"], suffixes: [] } });
  rejects({ testPaths: { prefixes: ["a/../b"], suffixes: [] } });
  rejects({ testPaths: { prefixes: ["a\\b"], suffixes: [] } });
  rejects({ testPaths: { prefixes: [], suffixes: ["a/b"] } });
  rejects({ excludeAreas: ["UI"] });
  rejects({ excludeAreas: Array.from({ length: 33 }, (_, i) => `area-${i}`) });
  assert.equal(evalProjectSchema.safeParse({ testPaths: { prefixes: ["tests"], suffixes: [".test.ts"] }, excludeAreas: ["ui-shell"], retentionDays: 30 }).success, true);

  const validation = {
    mine: true,
    gradingPaths: ["packages/host/src"],
    focusedTest: { command: "node", args: ["--import", "tsx", "--test", "{files}", "--test-reporter-destination={report}"] },
    reportFormat: "junit",
    guardChecks: [{ command: "node", args: ["scripts/check.mjs"] }],
  };
  assert.deepEqual(evalProjectSchema.parse({ mine: true }), { mine: true });
  assert.deepEqual(evalProjectSchema.parse(validation), validation);
  const focused = (args: string[], command = "node") => ({ ...validation, focusedTest: { command, args } });
  const refuses = (value: unknown) => assert.equal(evalProjectSchema.safeParse(value).success, false);
  refuses(focused(["{files}", "{files}", "--test-reporter-destination={report}"]));
  refuses(focused(["--x={files}", "--test-reporter-destination={report}"]));
  refuses(focused(["{files}"]));
  refuses(focused(["{files}", "{report}", "{report}"]));
  refuses(focused(["{files}", "{report}"], "{report}"));
  refuses({ ...validation, gradingPaths: Array.from({ length: 65 }, (_, i) => `dir${i}`) });
  refuses({ ...validation, gradingPaths: ["a/../b"] });
  refuses({ ...validation, reportFormat: "xml" });
  refuses({ ...validation, guardChecks: Array.from({ length: 9 }, () => ({ command: "node", args: [] })) });
});

test("mining is on only for a GitHub project that asks for it", () => {
  const github = { mode: "github" };
  assert.equal(mineSettings(undefined), undefined);
  assert.equal(mineSettings({ source: github }), undefined);
  assert.equal(mineSettings({ source: github, team: { eval: {} } }), undefined);
  assert.equal(mineSettings({ source: github, team: { eval: { mine: false } } }), undefined);
  assert.equal(mineSettings({ source: { mode: "laptop" }, team: { eval: { mine: true } } }), undefined);
  assert.equal(mineSettings({ source: github, team: { eval: { capture: true } } }), undefined);
  assert.deepEqual(mineSettings({ source: github, team: { eval: { mine: true } } }), { mine: true });
});

test("a validate job names the first missing setting", () => {
  const github = { mode: "github" };
  const focusedTest = { command: "node", args: ["--import", "tsx", "--test", "{files}", "--test-reporter-destination={report}"] };
  const checks = [{ command: "node", args: ["check.js"] }];
  const setup = { command: "npm", args: ["ci"] };
  const complete = { checks, setup, eval: { focusedTest, reportFormat: "junit" as const } };
  assert.deepEqual(validationSettings({ source: { mode: "laptop" }, team: complete }), { missing: "source" });
  assert.deepEqual(validationSettings({ source: github, team: { checks, eval: { reportFormat: "junit" } } }), { missing: "focusedTest" });
  assert.deepEqual(validationSettings({ source: github, team: { checks, eval: { focusedTest } } }), { missing: "reportFormat" });
  assert.deepEqual(validationSettings({ source: github, team: complete }), {
    settings: { focusedTest, reportFormat: "junit", gradingPaths: [], guardChecks: checks, setup },
  });
  const overridden = [{ command: "node", args: ["guard.js"] }];
  const withGuards = validationSettings({ source: github, team: { checks, eval: { focusedTest, reportFormat: "tap", guardChecks: overridden } } });
  assert.deepEqual(withGuards, { settings: { focusedTest, reportFormat: "tap", gradingPaths: [], guardChecks: overridden } });

  const grader = { prefix: { command: "sudo", args: ["-n", "-u", "infinite-grader", "--", "/usr/local/libexec/infinite/grader-command"] }, root: "/var/lib/infinite-grader" };
  assert.equal(evalHostSchema.safeParse({ grader }).success, true);
  assert.equal(evalHostSchema.safeParse({ grader: { ...grader, root: "relative/root" } }).success, false);
  assert.equal(evalHostSchema.safeParse({ grader: { ...grader, canaries: ["relative/key"] } }).success, false);
  assert.equal(evalHostSchema.safeParse({ grader: { ...grader, canaries: Array.from({ length: 33 }, (_, i) => `/canary/${i}`) } }).success, false);
  assert.equal(evalHostSchema.safeParse({ grader, unknownKey: 1 }).success, false);
});

test("capture is on only for a GitHub project that asks for it", () => {
  const github = { mode: "github" };
  assert.equal(captureSettings(undefined), undefined);
  assert.equal(captureSettings({ source: github }), undefined);
  assert.equal(captureSettings({ source: github, team: { eval: { capture: false } } }), undefined);
  assert.equal(captureSettings({ source: { mode: "laptop" }, team: { eval: { capture: true } } }), undefined);
  assert.deepEqual(captureSettings({ source: github, team: { eval: { capture: true } } }), { capture: true });
});

test("the trial settings parse with their limits", () => {
  const project = (eval_: Record<string, unknown>) => teamProjectSchema.safeParse({ ...base, eval: eval_ });
  const accepted = (eval_: Record<string, unknown>) => assert.equal(project(eval_).success, true, JSON.stringify(eval_));
  const refused = (eval_: Record<string, unknown>) => assert.equal(project(eval_).success, false, JSON.stringify(eval_));
  const profile = (id: string) => ({ id, label: "Trial", provider: "claude" as const, model: "model", effort: "high" as const, tier: "strong" as const });

  accepted({ trialsPerDay: 1, trialMinutes: 10 });
  accepted({ trialsPerDay: 50, trialMinutes: 240 });
  refused({ trialsPerDay: 0 });
  refused({ trialsPerDay: 51 });
  refused({ trialMinutes: 9 });
  refused({ trialMinutes: 241 });
  accepted({ candidateProfiles: Array.from({ length: 8 }, (_, i) => profile(`p${i}`)) });
  refused({ candidateProfiles: Array.from({ length: 9 }, (_, i) => profile(`p${i}`)) });
  refused({ trialsPerDay: 4, unknownKey: 1 });

  const member = { prefix: { command: "sudo", args: ["-n", "-u", "infinite-eval", "--", "/usr/local/libexec/infinite/eval-command"] }, root: "/var/lib/infinite-eval", agents: { claude: { command: "claude", args: [] } } };
  assert.equal(evalHostSchema.safeParse({ member }).success, true);
  assert.equal(evalHostSchema.safeParse({ member, unknownKey: 1 }).success, false);
  assert.equal(evalHostSchema.safeParse({ member: { ...member, unknownKey: 1 } }).success, false);
  assert.equal(evalHostSchema.safeParse({ member: { ...member, root: "relative/root" } }).success, false);
  assert.equal(evalHostSchema.safeParse({ member: { ...member, agents: { grok: member.agents.claude } } }).success, false);
  const args = (count: number) => ({ member: { ...member, agents: { claude: { command: "claude", args: Array.from({ length: count }, () => "-x") } } } });
  assert.equal(evalHostSchema.safeParse(args(64)).success, true, "64 agent arguments parse");
  assert.equal(evalHostSchema.safeParse(args(65)).success, false, "65 agent arguments are refused");

  const github = { mode: "github" };
  const checks = [{ command: "node", args: ["check.js"] }];
  const focusedTest = { command: "node", args: ["--import", "tsx", "--test", "{files}", "--test-reporter-destination={report}"] };
  const complete = { focusedTest, reportFormat: "junit" as const };
  assert.deepEqual(trialSettings({ source: github, team: { checks, eval: complete } }), { missing: "trialsPerDay" });
  assert.deepEqual(trialSettings({ source: github, team: { checks, eval: { reportFormat: "junit" as const } } }), { missing: "focusedTest" });
  assert.deepEqual(trialSettings({ source: { mode: "laptop" }, team: { checks, eval: { ...complete, trialsPerDay: 4 } } }), { missing: "source" });
  const settings = trialSettings({ source: github, team: { checks, eval: { ...complete, trialsPerDay: 4 } } });
  assert.deepEqual(settings, {
    settings: { focusedTest, reportFormat: "junit", gradingPaths: [], guardChecks: checks, trialsPerDay: 4, trialMinutes: 45, candidateProfiles: [] },
  });
  const withProfiles = trialSettings({ source: github, team: { checks, eval: { ...complete, trialsPerDay: 2, trialMinutes: 60, candidateProfiles: [profile("a")] } } });
  assert.deepEqual(withProfiles, {
    settings: { focusedTest, reportFormat: "junit", gradingPaths: [], guardChecks: checks, trialsPerDay: 2, trialMinutes: 60, candidateProfiles: [profile("a")] },
  });

  const parsed = evalHostSchema.parse({ member }).member;
  assert.equal(evalCommandPrefix(undefined, "exec"), undefined);
  assert.deepEqual(evalCommandPrefix(parsed, "setup"), { command: "sudo", args: ["-n", "-u", "infinite-eval", "--", "/usr/local/libexec/infinite/eval-command", "setup", "--"] });
  assert.deepEqual(evalCommandPrefix(parsed, "exec")!.args.slice(-2), ["exec", "--"]);

  assert.equal(learningPurpose("replay"), true);
  assert.equal(learningPurpose("gate"), true);
  assert.equal(learningPurpose("duel"), true);
  assert.equal(learningPurpose("work"), false);
  assert.equal(learningPurpose(undefined), false);
});

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

test("evalAgentSchema stays aligned with AgentProfile and enforces eval bounds", () => {
  const exactEvalAgentType: AssertExact<ReturnType<typeof evalAgentSchema.parse>, AgentProfile> = true;
  const exactMemberAgentType: AssertExact<NonNullable<EvalMemberConfig["agents"]["claude"]>, AgentProfile> = true;
  assert.equal(exactEvalAgentType, true);
  assert.equal(exactMemberAgentType, true);

  const acceptAgent = (_profile: NonNullable<EvalMemberConfig["agents"]["claude"]>) => {};
  acceptAgent({ command: "claude", args: ["--print"], appServerCommand: "codex", appServerArgs: ["app-server"], workspaceDir: "/srv/workspaces", sharedWorkspace: true });
  // @ts-expect-error unknown launch field must fail AgentProfile / evalAgentSchema parity
  acceptAgent({ command: "claude", args: [], unknownLaunchField: true });
  // @ts-expect-error required args field cannot be omitted
  acceptAgent({ command: "claude" });

  assert.deepEqual(Object.keys(evalAgentSchema.shape).sort(), Object.keys(agentProfileSchema.shape).sort());

  const fullProfile: AgentProfile = {
    command: "/usr/bin/claude",
    args: ["--print", "--output-format", "json"],
    appServerCommand: "/usr/bin/codex",
    appServerArgs: ["app-server", "--stdio"],
    workspaceDir: "/var/lib/infinite-eval/workspaces",
    sharedWorkspace: false,
  };
  assert.deepEqual(evalAgentSchema.parse(fullProfile), agentProfileSchema.parse(fullProfile));
  assert.equal(agentProfileSchema.safeParse({ ...fullProfile, workspaceDir: "relative/dir" }).success, false);
  assert.equal(evalAgentSchema.safeParse({ ...fullProfile, workspaceDir: "relative/dir" }).success, false);

  const overText = "x".repeat(EVAL_AGENT_TEXT_MAX + 1);
  const overArgs = Array.from({ length: EVAL_AGENT_ARGS_MAX + 1 }, () => "-x");
  const refused: unknown[] = [
    { ...fullProfile, command: "" },
    { ...fullProfile, command: overText },
    { ...fullProfile, args: [overText] },
    { ...fullProfile, args: overArgs },
    { ...fullProfile, appServerCommand: "" },
    { ...fullProfile, appServerCommand: overText },
    { ...fullProfile, appServerArgs: [overText] },
    { ...fullProfile, appServerArgs: overArgs },
    { ...fullProfile, workspaceDir: `/${"a".repeat(EVAL_AGENT_TEXT_MAX)}` },
    { ...fullProfile, unknownKey: 1 },
  ];
  for (const candidate of refused) assert.equal(evalAgentSchema.safeParse(candidate).success, false, JSON.stringify(candidate).slice(0, 120));
});

test("repositoryPrefix shares ownedPath safety rules with its 200-char ceiling", () => {
  assert.equal(ownedPathSchema.safeParse("a".repeat(OWNED_PATH_MAX_CHARS)).success, true);
  assert.equal(ownedPathSchema.safeParse("a".repeat(OWNED_PATH_MAX_CHARS + 1)).success, false);
  assert.equal(evalProjectSchema.safeParse({ gradingPaths: ["a".repeat(EVAL_REPOSITORY_PREFIX_MAX)] }).success, true);
  assert.equal(evalProjectSchema.safeParse({ gradingPaths: ["a".repeat(EVAL_REPOSITORY_PREFIX_MAX + 1)] }).success, false);
  assert.equal(evalProjectSchema.safeParse({ testPaths: { prefixes: ["a".repeat(EVAL_REPOSITORY_PREFIX_MAX)], suffixes: [] } }).success, true);
  assert.equal(evalProjectSchema.safeParse({ testPaths: { prefixes: ["a".repeat(EVAL_REPOSITORY_PREFIX_MAX + 1)], suffixes: [] } }).success, false);

  const unsafe = ["/abs", "a\\b", "a\0b", ".", "..", "a/../b", "a/./b", ".git/config", "a//b", "a/", "src/*.ts", "a?b", "a[0]", "a:b"];
  for (const path of unsafe) {
    assert.equal(ownedPathSchema.safeParse(path).success, false, `ownedPath rejects ${JSON.stringify(path)}`);
    assert.equal(evalProjectSchema.safeParse({ gradingPaths: [path] }).success, false, `gradingPaths rejects ${JSON.stringify(path)}`);
  }
});
