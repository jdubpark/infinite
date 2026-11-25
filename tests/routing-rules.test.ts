import test from "node:test";
import assert from "node:assert/strict";
import { screen } from "../packages/host/src/routing-choice.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { PROFILE_MESSAGES, assertTaskProfiles, escalationFallback, fallbackProfile, fallbackRule, routingComponent, scoutFallback, spareAttempts } from "../packages/host/src/routing-rules.js";
import type { RoutingKnobs, TeamRunRouting } from "../packages/host/src/routing-types.js";
import { autoRouted, eligibleImplementers, escalationPool, fixedRuleFailure, resolveLimitFallback, scoutPool, switchFallback, type TeamLineup, type TeamModelProfile, type TeamRun } from "../packages/host/src/team-types.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import type { Provider } from "../packages/host/src/types.js";
import { limitLineup, mixedLineup } from "./team-fixture.js";

const knobs = (over: Partial<RoutingKnobs> = {}): RoutingKnobs => ({ ...ROUTING_DEFAULTS, ...over });
const runWith = (over: Record<string, unknown>): TeamRun => ({ members: [], tasks: [], ...over }) as unknown as TeamRun;
const autoPin = (over: Partial<RoutingKnobs> = {}): TeamRunRouting => ({
  mode: "auto", requested: "auto", source: "saved", knobs: knobs(over), defaults: [], algorithmVersion: 1, rewardVersion: 1,
  digest: "auto-digest", periodEndedAt: "2026-11-01T00:00:00.000Z",
});
const shadowPin = (requested: "shadow" | "auto" = "shadow"): TeamRunRouting => ({
  mode: "shadow", requested, source: "saved", knobs: knobs(), defaults: [], algorithmVersion: 1, rewardVersion: 1, digest: "shadow-digest",
});
const refuses = (run: TeamRun, tasks: { agentProfileId?: string }[], use: "plan" | "scouts", message: string) =>
  assert.throws(() => assertTaskProfiles(run, tasks, use), (error: unknown) => error instanceof TeamError && error.status === 409
    && error.code === "invalid-agent-profile" && error.message === message);
const contributor = (id: string, model: string): TeamModelProfile => ({ id, label: id, provider: "opencode", model: `contrib/${model}`, variant: "high", tier: "light", dataUse: "contributor" });
const codex = (id: string, model: string): TeamModelProfile => ({ id, label: id, provider: "codex", model, effort: "high", tier: "light" });

test("fixed rules agree with the router's screen", () => {
  for (const lineup of [mixedLineup, limitLineup]) for (const allowContributor of [true, false]) {
    const rules = { allowContributor };
    const screened = screen(lineup, knobs(rules), new Set<Provider>());
    for (const item of screened) assert.equal(fixedRuleFailure(lineup, rules, item.profile), item.removed, item.profile.id);
  }
  assert.equal(fixedRuleFailure(mixedLineup, { allowContributor: false }, mixedLineup.implementers[0]!), "contributor");
});

test("off and shadow plan checks refuse as main does", () => {
  const withLineup = (routing?: TeamRunRouting) => runWith({ lineup: mixedLineup, ...(routing ? { routing } : {}) });
  const bare = runWith({});
  for (const use of ["plan", "scouts"] as const) {
    refuses(bare, [{ agentProfileId: "spark-high" }], use, PROFILE_MESSAGES.singleProvider);
    assert.doesNotThrow(() => assertTaskProfiles(bare, [{}], use));
    for (const run of [withLineup(), withLineup(shadowPin()), withLineup(shadowPin("auto"))]) {
      refuses(run, [{}], use, PROFILE_MESSAGES.pool);
      refuses(run, [{ agentProfileId: "not-a-profile" }], use, PROFILE_MESSAGES.pool);
      assert.doesNotThrow(() => assertTaskProfiles(run, [{ agentProfileId: "astra-xhigh" }, { agentProfileId: "spark-high" }], use));
      assert.deepEqual(scoutPool(run), mixedLineup.implementers);
      assert.deepEqual(eligibleImplementers(run), mixedLineup.implementers);
      assert.deepEqual(escalationPool(run), []);
    }
  }
});

test("auto plans may omit profiles, and scouts and escalations pass rule 1", () => {
  const strong: TeamModelProfile = codex("strong-esc", "gpt-6-astra");
  const lineup: TeamLineup = { ...mixedLineup, escalations: [contributor("contrib-esc", "esc"), strong] };
  for (const revoked of [undefined, "2026-11-02T00:00:00.000Z"]) {
    const run = runWith({ lineup, routing: autoPin(), ...(revoked ? { routingRevokedAt: revoked } : {}) });
    assert.equal(autoRouted(run), revoked === undefined);
    assert.doesNotThrow(() => assertTaskProfiles(run, [{}, {}], "plan"));
    refuses(run, [{ agentProfileId: "not-a-profile" }], "plan", PROFILE_MESSAGES.autoPool);
    assert.doesNotThrow(() => assertTaskProfiles(run, [{ agentProfileId: "spark-high" }], "plan"));
    refuses(run, [{ agentProfileId: "spark-high" }], "scouts", PROFILE_MESSAGES.scoutPool);
    refuses(run, [{}], "scouts", PROFILE_MESSAGES.scoutPool);
    assert.doesNotThrow(() => assertTaskProfiles(run, [{ agentProfileId: "astra-xhigh" }], "scouts"));
    assert.deepEqual(escalationPool(run), [strong]);
    const allowed = runWith({ lineup, routing: autoPin({ allowContributor: true }), ...(revoked ? { routingRevokedAt: revoked } : {}) });
    assert.doesNotThrow(() => assertTaskProfiles(allowed, [{ agentProfileId: "spark-high" }], "scouts"));
    assert.deepEqual(escalationPool(allowed).map(profile => profile.id), ["contrib-esc", "strong-esc"]);
  }
});

test("auto fallbacks skip a target that fails a fixed rule; off and shadow keep main's chain", () => {
  const a = { id: "a-claude", label: "A", provider: "claude", model: "claude-x", effort: "high", tier: "light", limitFallback: "c-contrib" } as TeamModelProfile;
  const c = { ...contributor("c-contrib", "c"), limitFallback: "d-codex" } as TeamModelProfile;
  const d = codex("d-codex", "gpt-x");
  const lineup: TeamLineup = { ...mixedLineup, reviewer: { ...mixedLineup.reviewer, model: "claude-reviewer" }, implementers: [a, c], fallbacks: [d] };
  const limited = new Set<Provider>(["claude"]);
  const auto = runWith({ lineup, routing: autoPin() });
  const offRun = runWith({ lineup });
  const shadowRun = runWith({ lineup, routing: shadowPin() });

  assert.equal(resolveLimitFallback(lineup, "a-claude", limited)?.id, "c-contrib");
  assert.equal(resolveLimitFallback(lineup, "a-claude", limited, fallbackRule(auto, "implementer"))?.id, "d-codex");
  assert.equal(switchFallback(lineup, "a-claude", "claude", new Set(), fallbackRule(auto, "implementer"))?.id, "d-codex");
  assert.equal(switchFallback(lineup, "a-claude", "claude", new Set())?.id, "c-contrib");

  const onReviewerModel: TeamLineup = { ...lineup, reviewer: { ...lineup.reviewer, model: "gpt-x" } };
  assert.equal(resolveLimitFallback(onReviewerModel, "a-claude", limited, fallbackRule(runWith({ lineup: onReviewerModel, routing: autoPin() }), "implementer")), undefined);
  assert.equal(resolveLimitFallback(onReviewerModel, "a-claude", limited, fallbackRule(runWith({ lineup: onReviewerModel, routing: autoPin() }), "scout"))?.id, "d-codex");

  for (const role of ["project-manager", "integrator", "reviewer"] as const) assert.equal(fallbackRule(auto, role), undefined, role);
  assert.equal(fallbackRule(offRun, "implementer"), undefined);
  assert.equal(fallbackRule(shadowRun, "implementer"), undefined);
  assert.equal(fallbackRule(shadowRun, "scout"), undefined);
  assert.equal(resolveLimitFallback(lineup, "a-claude", limited, fallbackRule(offRun, "implementer"))?.id, "c-contrib");
  assert.equal(fallbackRule(auto, "scout")!(d), true);
  assert.equal(fallbackRule(auto, "implementer")!(c), false);
});

test("a covered run accepts scouts without a profile, and a named one still passes rule 1", () => {
  const covered = runWith({ lineup: mixedLineup, routing: { ...autoPin({ points: ["start", "scout"] }), algorithmVersion: 2 } });
  assert.doesNotThrow(() => assertTaskProfiles(covered, [{}, {}], "scouts"));
  assert.doesNotThrow(() => assertTaskProfiles(covered, [{ agentProfileId: "astra-xhigh" }, {}], "scouts"));
  refuses(covered, [{ agentProfileId: "spark-high" }], "scouts", PROFILE_MESSAGES.scoutPool);
  refuses(covered, [{}, { agentProfileId: "spark-high" }], "scouts", PROFILE_MESSAGES.scoutPool);
  const v1 = runWith({ lineup: mixedLineup, routing: autoPin({ points: ["start", "scout"] }) });
  refuses(v1, [{}], "scouts", PROFILE_MESSAGES.scoutPool);
  refuses(runWith({ lineup: mixedLineup }), [{}], "scouts", PROFILE_MESSAGES.pool);
});

test("the fallbacks at the new points pass rules 1 and 2 and never the member's own profile", () => {
  const astraEscalation = codex("astra-escalation", "gpt-6-astra");
  const sonnetEscalation: TeamModelProfile = { id: "sonnet-escalation", label: "Sonnet escalation", provider: "claude", model: "claude-sonnet-5-5", effort: "high", tier: "strong" };
  const opusEscalation: TeamModelProfile = { id: "opus-escalation", label: "Opus escalation", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
  const haikuLight: TeamModelProfile = { id: "haiku-light", label: "Haiku light", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
  const opusStrong: TeamModelProfile = { id: "opus-strong", label: "Opus strong", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
  const lineup: TeamLineup = {
    ...mixedLineup,
    implementers: [...mixedLineup.implementers, haikuLight, opusStrong],
    escalations: [astraEscalation, sonnetEscalation, opusEscalation],
  };
  const covered = (over: Partial<TeamLineup> = {}) => runWith({ lineup: { ...lineup, ...over }, routing: { ...autoPin({ points: ["start", "escalation", "scout"] }), algorithmVersion: 2 } });
  const run = covered();

  assert.equal(escalationFallback(run, "astra-xhigh", "sonnet-escalation")?.id, "sonnet-escalation");
  assert.equal(escalationFallback(run, "astra-xhigh", "opus-escalation")?.id, "astra-escalation");
  assert.equal(escalationFallback(run, "astra-escalation", "astra-escalation")?.id, "sonnet-escalation");
  assert.equal(escalationFallback(run, "astra-escalation", undefined)?.id, "sonnet-escalation");
  assert.equal(escalationFallback(run, "astra-xhigh", undefined)?.id, "astra-escalation");
  assert.equal(escalationFallback(covered({ escalations: [astraEscalation] }), "astra-escalation", "astra-escalation"), undefined);

  assert.equal(scoutFallback(run, { agentProfileId: "haiku-light" })?.id, "haiku-light");
  assert.equal(scoutFallback(run, { agentProfileId: "opus-strong" })?.id, "astra-xhigh");
  assert.equal(scoutFallback(run, { agentProfileId: "spark-high" })?.id, "astra-xhigh");
  assert.equal(scoutFallback(run, {})?.id, "astra-xhigh");

  const coveredScout = fallbackRule(run, "scout")!;
  assert.equal(coveredScout(opusEscalation), false);
  assert.equal(coveredScout(mixedLineup.implementers[0]!), false);
  assert.equal(coveredScout(haikuLight), true);
  const v1 = runWith({ lineup, routing: autoPin({ points: ["start", "scout"] }) });
  assert.equal(fallbackRule(v1, "scout")!(opusEscalation), true);
  assert.equal(fallbackRule(v1, "scout")!(mixedLineup.implementers[0]!), false);
});

test("the fallback profile is the coordinator's pick when it passes, else the default", () => {
  const auto = runWith({ lineup: mixedLineup, routing: autoPin() });
  assert.equal(fallbackProfile(auto, { agentProfileId: "astra-xhigh" }).id, "astra-xhigh");
  assert.equal(fallbackProfile(auto, { agentProfileId: "spark-high" }).id, "astra-xhigh");
  assert.equal(fallbackProfile(auto, {}).id, "astra-xhigh");
  const allowed = runWith({ lineup: mixedLineup, routing: autoPin({ allowContributor: true }) });
  assert.equal(fallbackProfile(allowed, { agentProfileId: "spark-high" }).id, "spark-high");

  const allContributor: TeamLineup = { ...mixedLineup, implementers: [contributor("c1", "one"), contributor("c2", "two")] };
  assert.throws(() => fallbackProfile(runWith({ lineup: allContributor, routing: autoPin() }), {}), (error: unknown) => error instanceof TeamError
    && error.status === 409 && error.code === "routing-no-eligible-profile" && error.message === PROFILE_MESSAGES.noEligible);
});

test("spare attempts and the routing component", () => {
  const member = {} as TeamRun["members"][number];
  const task = (status: string) => ({ status }) as TeamRun["tasks"][number];
  const limit = runWith({ members: Array.from({ length: 5 }, () => member), tasks: ["pending", "running", "waiting", "integrated", "blocked"].map(task) });
  assert.equal(spareAttempts(limit), 48);
  const goal = runWith({ goal: { maxMembers: 10 }, members: Array.from({ length: 9 }, () => member), tasks: [task("pending")] });
  assert.equal(spareAttempts(goal), -3);

  assert.equal(routingComponent(runWith({})), "off");
  assert.equal(routingComponent(runWith({ routing: shadowPin() })), "off");
  assert.equal(routingComponent(runWith({ routing: autoPin() })), "auto-digest");
  assert.equal(routingComponent(runWith({ routing: autoPin(), routingRevokedAt: "2026-11-02T00:00:00.000Z" })), "off");
});
