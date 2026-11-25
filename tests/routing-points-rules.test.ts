import test from "node:test";
import assert from "node:assert/strict";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import type { RoutingKnobs, RoutingPoint, TeamRunRouting } from "../packages/host/src/routing-types.js";
import {
  PLAN_VERIFICATION_REFUSAL, PROFILE_REQUIRED_REFUSAL, coversPoint, escalationCandidates, hostProfilesFor, hostSelects,
  reportRefusal, scoutCandidates, teamReportSchema, type TeamAssignment, type TeamLineup, type TeamModelProfile, type TeamReport, type TeamRun,
} from "../packages/host/src/team-types.js";

const claude = (id: string, model: string, effort: "high" | "xhigh", tier?: "light" | "strong"): TeamModelProfile =>
  ({ id, label: id, provider: "claude", model, effort, ...(tier ? { tier } : {}) }) as TeamModelProfile;
const codex = (id: string, model: string, effort: "high" | "xhigh", tier?: "light" | "strong"): TeamModelProfile =>
  ({ id, label: id, provider: "codex", model, effort, ...(tier ? { tier } : {}) }) as TeamModelProfile;
const contributor = (id: string): TeamModelProfile =>
  ({ id, label: id, provider: "opencode", model: "contrib/spark", variant: "high", tier: "light", dataUse: "contributor" }) as TeamModelProfile;

const POINT_LINEUP = {
  coordinator: claude("coord", "claude-sonnet-5-5", "high"),
  integrator: claude("integ", "claude-sonnet-5-5", "high"),
  reviewer: claude("reviewer", "claude-opus-5-5", "xhigh"),
  implementers: [
    contributor("spark-high"),
    codex("astra-xhigh", "gpt-6-astra", "xhigh"),
    claude("haiku-light", "claude-haiku-5-5", "high", "light"),
    claude("opus-strong", "claude-opus-5-5", "xhigh", "strong"),
  ],
  escalations: [
    claude("opus-escalation", "claude-opus-5-5", "xhigh", "strong"),
    codex("astra-escalation", "gpt-6-astra", "high", "strong"),
    claude("sonnet-escalation", "claude-sonnet-5-5", "high", "strong"),
    contributor("spark-escalation"),
  ],
} as unknown as TeamLineup;

const ALL_POINTS: RoutingPoint[] = ["start", "escalation", "scout"];
const AUTO_AT = "2026-11-01T00:00:00.000Z";
const REVOKED_AT = "2026-11-02T00:00:00.000Z";

function pin(points: RoutingPoint[], over: Partial<RoutingKnobs> = {}, version = 2, mode: "auto" | "shadow" = "auto"): TeamRunRouting {
  const knobs = { ...ROUTING_DEFAULTS, points, ...over };
  return (mode === "auto"
    ? { mode, requested: "auto", periodEndedAt: AUTO_AT, source: "saved", knobs, defaults: [], algorithmVersion: version, rewardVersion: 1, digest: "d" }
    : { mode, requested: "shadow", source: "saved", knobs, defaults: [], algorithmVersion: version, rewardVersion: 1, digest: "d" }) as TeamRunRouting;
}
function runOf(routing: TeamRunRouting, lineup: TeamLineup = POINT_LINEUP, routingRevokedAt?: string): Pick<TeamRun, "routing" | "routingRevokedAt" | "lineup"> {
  return { routing, lineup, routingRevokedAt } as Pick<TeamRun, "routing" | "routingRevokedAt" | "lineup">;
}
const withLineup = (over: Partial<TeamLineup>): TeamLineup => ({ ...POINT_LINEUP, ...over }) as TeamLineup;
const ids = (profiles: TeamModelProfile[]) => profiles.map(profile => profile.id);
const assignment = (over: Partial<TeamAssignment>): TeamAssignment =>
  ({ runId: "00000000-0000-4000-8000-000000000001", memberId: "00000000-0000-4000-8000-000000000002", revision: 1, role: "implementer", ...over }) as TeamAssignment;
const task = (id: string, agentProfileId?: string) => ({ id, title: `task ${id}`, instructions: `do ${id}`, ...(agentProfileId ? { agentProfileId } : {}) });

test("a run covers a point only under an auto pin of version 2 that lists it, with a candidate", () => {
  const covered = runOf(pin(ALL_POINTS));
  assert.equal(coversPoint(covered, "escalation"), true);
  assert.equal(coversPoint(covered, "scout"), true);
  assert.equal(hostSelects(covered, "escalation"), true);
  assert.equal(hostSelects(covered, "scout"), true);

  const revoked = runOf(pin(ALL_POINTS), POINT_LINEUP, REVOKED_AT);
  assert.equal(coversPoint(revoked, "escalation"), true);
  assert.equal(coversPoint(revoked, "scout"), true);
  assert.equal(hostSelects(revoked, "escalation"), false);
  assert.equal(hostSelects(revoked, "scout"), false);

  for (const routing of [pin(ALL_POINTS, {}, 1), pin(ALL_POINTS, {}, 2, "shadow"), pin(["start"])]) {
    for (const point of ["escalation", "scout"] as const) {
      assert.equal(coversPoint(runOf(routing), point), false);
      assert.equal(hostSelects(runOf(routing), point), false);
    }
  }

  assert.deepEqual(ids(escalationCandidates(POINT_LINEUP, { allowContributor: false }, "astra-escalation")), ["sonnet-escalation"]);
  assert.equal(coversPoint(runOf(pin(ALL_POINTS)), "escalation", "astra-escalation"), true);
  assert.equal(coversPoint(runOf(pin(ALL_POINTS)), "escalation", "sonnet-escalation"), true);
  const oneEscalation = runOf(pin(ALL_POINTS), withLineup({ escalations: [POINT_LINEUP.escalations![0]] }));
  assert.equal(coversPoint(oneEscalation, "escalation"), false);
  assert.equal(coversPoint(runOf(pin(ALL_POINTS), withLineup({ escalations: undefined })), "escalation"), false);
  const twoEscalations = runOf(pin(ALL_POINTS), withLineup({ escalations: [POINT_LINEUP.escalations![2], POINT_LINEUP.escalations![0]] }));
  assert.equal(coversPoint(twoEscalations, "escalation"), true);
  assert.equal(coversPoint(twoEscalations, "escalation", "sonnet-escalation"), false);

  assert.deepEqual(ids(scoutCandidates(POINT_LINEUP, { allowContributor: false })), ["astra-xhigh", "haiku-light"]);
  const scoutLineup = withLineup({ implementers: [contributor("spark-high"), claude("opus-strong", "claude-opus-5-5", "xhigh", "strong")] });
  assert.equal(coversPoint(runOf(pin(ALL_POINTS), scoutLineup), "scout"), false);
  assert.equal(coversPoint(runOf(pin(ALL_POINTS, { allowContributor: true }), scoutLineup), "scout"), true);
  const strongOnly = withLineup({ implementers: [claude("sonnet-strong", "claude-sonnet-5-5", "high", "strong")] });
  assert.deepEqual(ids(scoutCandidates(strongOnly, { allowContributor: false })), []);
  assert.equal(coversPoint(runOf(pin(ALL_POINTS), strongOnly), "scout"), false);

  assert.equal(hostProfilesFor(runOf(pin(ALL_POINTS)), "implementer", "astra-escalation"), true);
  assert.equal(hostProfilesFor(runOf(pin(ALL_POINTS)), "project-manager"), true);
  assert.equal(hostProfilesFor(runOf(pin(ALL_POINTS)), "reviewer"), false);
  assert.equal(hostProfilesFor(runOf(pin(ALL_POINTS, {}, 1)), "implementer", "astra-escalation"), false);
});

test("the worker refuses a missing profile unless the member's assignment says the host selects", () => {
  const escalate = { kind: "escalate", reason: "needs a stronger model" } as unknown as TeamReport;
  assert.equal(reportRefusal(assignment({ role: "implementer" }), escalate), PROFILE_REQUIRED_REFUSAL);
  assert.equal(reportRefusal(assignment({ role: "implementer", hostProfiles: true }), escalate), undefined);
  const named = { kind: "escalate", agentProfileId: "sonnet-escalation", reason: "needs a stronger model" } as unknown as TeamReport;
  assert.equal(reportRefusal(assignment({ role: "implementer" }), named), undefined);

  const explore = { kind: "explore", summary: "scouts", tasks: [task("s1", "haiku-light"), task("s2")] } as unknown as TeamReport;
  assert.equal(reportRefusal(assignment({ role: "project-manager" }), explore), PROFILE_REQUIRED_REFUSAL);
  assert.equal(reportRefusal(assignment({ role: "project-manager", hostProfiles: true }), explore), undefined);

  const plan = { kind: "plan", summary: "plan", tasks: [task("a")], verification: { checks: [{ command: "npm test" }] } } as unknown as TeamReport;
  assert.equal(PLAN_VERIFICATION_REFUSAL, "Plan rejected: this run uses the project's configured checks. Remove verification and submit a corrected plan. If the checks seem insufficient, explain that in the summary and assign tasks to run additional commands themselves and report results.");
  assert.equal(reportRefusal(assignment({ role: "project-manager", verificationRefused: true }), plan), PLAN_VERIFICATION_REFUSAL);
  assert.equal(reportRefusal(assignment({ role: "project-manager" }), plan), undefined);

  for (const report of [{ kind: "result", summary: "done" }, { kind: "blocked", summary: "stuck" }]) {
    assert.equal(reportRefusal(assignment({ role: "implementer" }), report as unknown as TeamReport), undefined);
  }

  assert.equal(teamReportSchema.safeParse({ kind: "escalate", reason: "stronger model" }).success, true);
  assert.equal(teamReportSchema.safeParse({ kind: "explore", summary: "scouts", tasks: [task("s1")] }).success, true);
});
