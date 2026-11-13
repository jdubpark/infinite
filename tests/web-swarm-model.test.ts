import test from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../apps/web/src/api";
import type { Attention, AttentionState } from "../packages/attention/src/types";
import type { SwarmInput, SwarmMember, SwarmMission, SwarmSession, SwarmTeam } from "../apps/web/src/swarm/types";
import { allAgents, buildSwarm, findAgent, findUnit } from "../apps/web/src/swarm/model";
import { approvalOwner } from "../apps/web/src/swarm/approval";
import { ACTIVITY_BUCKETS, ACTIVITY_BUCKET_MS, createActivity } from "../apps/web/src/swarm/activity";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function session(id: string, over: Record<string, unknown> = {}): SwarmSession {
  return { id, title: `${id} title`, provider: "claude", projectId: "api", status: "running", createdAt: iso(2 * HOUR), seq: 0, contextVersion: 1, ...over } as Session;
}

function attention(state: AttentionState, over: Partial<Attention> = {}): Attention {
  return { state, since: iso(60_000), source: "hook", now: iso(0), lastActivityAt: iso(5_000), hooks: "active", hookErrors: 0, sawTurnEnd: false, ...over } as Attention;
}

function prompt(id: number, over: Record<string, unknown> = {}) {
  return { id, kind: "question", title: `prompt ${id}`, options: [], acceptsText: false, source: "hook", ...over } as NonNullable<Attention["prompt"]>;
}

function member(memberId: string, over: Record<string, unknown> = {}): SwarmMember {
  return { memberId, sessionId: `s-${memberId}`, role: "implementer", revision: 1, title: `${memberId} title`, status: "running", ...over } as SwarmMember;
}

function team(id: string, over: Record<string, unknown> = {}): SwarmTeam {
  return {
    id, projectId: "api", provider: "claude", title: `${id} title`, status: "implementing", revision: 1,
    createdAt: iso(3 * HOUR), updatedAt: iso(60_000), baseCommit: "base", members: [], tasks: [], checks: [], decisions: [],
    ...over,
  } as SwarmTeam;
}

function mission(id: string, over: Record<string, unknown> = {}): SwarmMission {
  return { id, title: `${id} title`, status: "working", createdAt: iso(4 * HOUR), updatedAt: iso(60_000), subtasks: [], decisions: [], ...over } as SwarmMission;
}

function input(over: Partial<SwarmInput> = {}): SwarmInput {
  return { sessions: [], teams: [], missions: [], now: NOW, ...over };
}

// A delegated run: permission review is on and the lineup coordinator is strong.
const DELEGATED = { permissions: { maxDecisions: 5 }, lineup: { coordinator: { tier: "strong" } } };

test("state table", () => {
  const rows: [string, Partial<SwarmMember>, Attention | undefined, string][] = [
    ["queued", { status: "queued" }, undefined, "queued"],
    ["needs-you person", { status: "running" }, attention("needs-you", { prompt: prompt(1) }), "needs-you"],
    ["needs-you coordinator", { status: "running" }, attention("needs-you", { prompt: prompt(2, { kind: "permission", delegable: true }) }), "in-review"],
    ["running working", { status: "running" }, attention("working"), "working"],
    ["running turn-finished", { status: "running" }, attention("turn-finished"), "waiting"],
    ["running idle", { status: "running" }, attention("idle"), "waiting"],
    ["waiting working", { status: "waiting" }, attention("working"), "waiting"],
    ["reported", { status: "reported" }, undefined, "reported"],
    ["stopped", { status: "stopped" }, undefined, "stopped"],
    ["unavailable status", { status: "unavailable" }, undefined, "fault"],
    ["running recording-error", { status: "running" }, attention("recording-error"), "fault"],
  ];
  const members = rows.map(([label], index) => member(`m-${index}`, { title: label, ...rows[index][1] }));
  const sessions = rows.flatMap(([, , att], index) => att ? [session(`s-m-${index}`, { attention: att })] : []);
  const model = buildSwarm(input({
    sessions,
    teams: [team("checkout-v2", { ...DELEGATED, members, status: "implementing" })],
  }));
  rows.forEach(([label, , , expected], index) => {
    assert.equal(findAgent(model, `m-${index}`)?.state, expected, label);
  });
});

test("prompt ownership", () => {
  const run = (over: Record<string, unknown>, sessionOver: Record<string, unknown>) => {
    const model = buildSwarm(input({
      sessions: [session("s-api", { attention: attention("needs-you", { prompt: prompt(7, { kind: "permission", delegable: true, ...sessionOver }) }) })],
      teams: [team("checkout-v2", { ...DELEGATED, members: [member("api", { sessionId: "s-api" })], ...over })],
    }));
    return findAgent(model, "api")?.state;
  };

  const reviewing = { permissionDecisions: [{ targetSessionId: "s-api", promptId: 7, status: "reviewing" }] };
  assert.equal(run(reviewing, {}), "in-review");

  const escalated = { permissionDecisions: [{ targetSessionId: "s-api", promptId: 7, status: "escalated" }] };
  assert.equal(run(escalated, {}), "needs-you");

  assert.equal(run({}, {}), "in-review");
  assert.equal(run({}, { destructive: { pattern: "rm -rf" } }), "needs-you");

  const team1 = team("checkout-v2", { ...DELEGATED });
  const p = prompt(7, { kind: "permission", delegable: true });
  assert.equal(approvalOwner(team1, "s-api", p), "coordinator");
  assert.equal(approvalOwner(team1, "s-api", { ...p, multiSelect: true }), "person");
});

test("waiting on a person", () => {
  const model = buildSwarm(input({
    sessions: [
      session("s-pm", { attention: attention("needs-you", { prompt: prompt(3) }) }),
      session("s-b", { attention: attention("working") }),
      session("s-coord", { attention: attention("working") }),
    ],
    teams: [
      team("checkout-v2", { members: [member("pm", { sessionId: "s-pm", role: "project-manager" })], decisions: [{ id: "d1", revision: 1 }] }),
      team("api", { missionId: "m-1", members: [member("b", { sessionId: "s-b" })], decisions: [{ id: "d2", revision: 1 }] }),
    ],
    missions: [mission("m-1", { coordinator: { memberId: "c", sessionId: "s-coord", status: "running" }, decisions: [{ id: "md1" }] })],
  }));
  const standalone = model.live.find(swarm => swarm.id === "checkout-v2");
  const mine = model.live.find(swarm => swarm.id === "m-1");
  assert.equal(standalone?.waiting, 2);
  assert.equal(findUnit(model, "api")?.waiting, 0);
  assert.equal(mine?.waiting, 1);
  assert.equal(model.totals.waitingOnPerson, 3);
});

test("stages", () => {
  const expected: [string, string | undefined, string][] = [
    ["planning", "plan", "plan"],
    ["discovering", "scout", "scout"],
    ["implementing", "build", "build"],
    ["integrating", "integrate", "integrate"],
    ["verifying", "check", "check"],
    ["reviewing", "review", "review"],
    ["delivering", "ship", "ship"],
    ["needs-input", undefined, "plan"],
    ["paused", undefined, "plan"],
    ["blocked", undefined, "plan"],
    ["ready-for-review", undefined, "plan"],
    ["merged", undefined, "plan"],
    ["no-change", undefined, "plan"],
    ["cancelled", undefined, "plan"],
  ];
  const model = buildSwarm(input({
    teams: expected.map(([status]) => team(`run-${status}`, { status })),
  }));
  for (const [status, active, reached] of expected) {
    const unit = findUnit(model, `run-${status}`);
    assert.equal(unit?.active, active, `active for ${status}`);
    assert.equal(unit?.reached, reached, `reached for ${status}`);
  }

  const withChecks = buildSwarm(input({
    teams: [team("checkout-v2", { status: "blocked", checks: [{ status: "passed", revision: 1 }] })],
  }));
  assert.equal(findUnit(withChecks, "checkout-v2")?.reached, "check");

  const steered = buildSwarm(input({
    teams: [team("checkout-v2", {
      status: "planning",
      revision: 2,
      members: [member("old-integrator", { role: "integrator", revision: 1, status: "stopped" })],
      tasks: [{ id: "t1", title: "t", status: "integrated", dependsOn: [], paths: [], memberId: "old-integrator" }],
      checks: [{ status: "passed", revision: 1 }],
      review: { revision: 1 },
      discovery: { revision: 1 },
    })],
  }));
  assert.equal(findUnit(steered, "checkout-v2")?.reached, "plan");

  const scouted = buildSwarm(input({ teams: [team("checkout-v2", { status: "paused", revision: 2, discovery: { revision: 2 } })] }));
  assert.equal(findUnit(scouted, "checkout-v2")?.reached, "scout");
});

test("live and quiet", () => {
  const model = buildSwarm(input({
    teams: [
      team("checkout-v2", { status: "blocked", members: [member("stopped-a", { status: "stopped" })] }),
      team("api", { status: "merged", updatedAt: iso(80 * HOUR) }),
    ],
  }));
  assert.equal(model.live.length, 0);
  assert.deepEqual(model.quiet.map(swarm => swarm.id), ["checkout-v2"]);
  assert.equal(findUnit(model, "checkout-v2")?.agents.length, 0);
  assert.equal(model.quietOlder, 1);

  const many = buildSwarm(input({
    teams: Array.from({ length: 14 }, (_, index) => team(`run-${index}`, { status: "blocked", updatedAt: iso(index * 60_000) })),
  }));
  assert.equal(many.quiet.length, 12);
  assert.equal(many.quietOlder, 2);
});

test("stable order", () => {
  const build = (olderUpdate: string, newerUpdate: string) => buildSwarm(input({
    sessions: [session("s-a", { attention: attention("working") }), session("s-b", { attention: attention("working") })],
    teams: [
      team("checkout-v2", { createdAt: iso(5 * HOUR), updatedAt: olderUpdate, members: [member("a", { sessionId: "s-a" })] }),
      team("api", { createdAt: iso(1 * HOUR), updatedAt: newerUpdate, members: [member("b", { sessionId: "s-b" })] }),
    ],
  }));
  const first = build(iso(1_000), iso(2_000)).live.map(swarm => swarm.id);
  const second = build(iso(9_000), iso(100)).live.map(swarm => swarm.id);
  assert.deepEqual(first, ["api", "checkout-v2"]);
  assert.deepEqual(second, first);

  // A swarm that starts waiting on a person keeps its row: order follows creation time, never state.
  const waiting = buildSwarm(input({
    sessions: [session("s-a", { attention: attention("needs-you", { prompt: prompt(7) }) }), session("s-b", { attention: attention("working") })],
    teams: [
      team("checkout-v2", { createdAt: iso(5 * HOUR), members: [member("a", { sessionId: "s-a" })] }),
      team("api", { createdAt: iso(1 * HOUR), members: [member("b", { sessionId: "s-b" })] }),
    ],
  }));
  assert.equal(waiting.live.find(swarm => swarm.id === "checkout-v2")?.waiting, 1);
  assert.deepEqual(waiting.live.map(swarm => swarm.id), first);
});

test("missions", () => {
  const model = buildSwarm(input({
    sessions: [session("s-coord", { attention: attention("working") })],
    teams: [
      team("T-api", { missionId: "M-1", title: "API", status: "implementing", members: [member("b", { role: "implementer" })] }),
      team("T-schema", { missionId: "M-1", title: "Schema", status: "merged" }),
      team("T-orphan", { missionId: "M-gone", title: "Orphan", status: "implementing", members: [member("o", { role: "implementer" })] }),
    ],
    missions: [mission("M-1", {
      title: "checkout-v2",
      coordinator: { memberId: "c", sessionId: "s-coord", status: "running" },
      subtasks: [
        { id: "s1", repoProjectId: "api", title: "Schema", dependsOn: [], status: "done", teamId: "T-schema" },
        { id: "s2", repoProjectId: "api", title: "API", dependsOn: ["s1"], status: "running", teamId: "T-api" },
        { id: "s3", repoProjectId: "web", title: "Web", dependsOn: ["s2"], status: "queued" },
        { id: "s4", repoProjectId: "mobile", title: "Mobile", dependsOn: ["s1"], status: "blocked" },
      ],
    })],
  }));
  const swarm = model.live.find(item => item.id === "M-1");
  assert.equal(swarm?.kind, "mission");
  assert.deepEqual(swarm?.units.map(unit => unit.id), ["T-schema", "T-api"]);
  assert.deepEqual(findUnit(model, "T-api")?.dependsOn, ["T-schema"]);
  assert.deepEqual(swarm?.ghosts.map(ghost => [ghost.title, ghost.after]), [["Web", ["API"]], ["Mobile", ["Schema"]]]);
  assert.equal(model.live.find(item => item.id === "T-orphan")?.kind, "team");
  assert.equal(findAgent(model, "s-coord")?.role, "MC");
});

test("solo", () => {
  const model = buildSwarm(input({
    sessions: [
      session("S-free", { attention: attention("working") }),
      session("s-b", { attention: attention("working") }),
      session("S-managed", { managedBy: { kind: "mission", missionId: "M-1" } }),
      session("S-archived", { archivedAt: iso(1_000) }),
    ],
    teams: [team("checkout-v2", { members: [member("b", { sessionId: "s-b" })] })],
  }));
  const solo = model.live.find(swarm => swarm.kind === "solo");
  assert.deepEqual(solo?.loose.map(agent => agent.id), ["S-free"]);
  assert.equal(findAgent(model, "S-free")?.role, "SO");
  assert.equal(model.live[model.live.length - 1].kind, "solo");
});

test("earlier revision", () => {
  const model = buildSwarm(input({
    sessions: [
      session("s-old", { attention: attention("working") }),
      session("s-new", { attention: attention("working") }),
    ],
    teams: [team("checkout-v2", {
      revision: 2,
      members: [
        member("m-old", { sessionId: "s-old", revision: 1, status: "running" }),
        member("m-stopped", { sessionId: "s-gone", revision: 1, status: "stopped" }),
        member("m-new", { sessionId: "s-new", revision: 2, status: "running" }),
      ],
    })],
  }));
  const unit = findUnit(model, "checkout-v2");
  assert.deepEqual(allAgents(model.live[0]).map(agent => agent.id), ["m-old", "m-new"]);
  assert.equal(findAgent(model, "m-old")?.earlier, true);
  assert.equal(findAgent(model, "m-new")?.earlier, false);
  assert.equal(unit?.agents.length, 2);
  assert.equal(findAgent(model, "m-stopped"), undefined);
});

test("activity", () => {
  const activity = createActivity();
  const bucketStart = Math.floor(NOW / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS;

  activity.record([{ id: "a", lastActivityAt: "t0" }], bucketStart);
  assert.deepEqual(activity.buckets("a", bucketStart), new Array(ACTIVITY_BUCKETS).fill(0));

  activity.record([{ id: "a", lastActivityAt: "t1" }], bucketStart + 1_000);
  assert.equal(activity.buckets("a", bucketStart + 1_000).at(-1), 0.2);

  for (let index = 2; index <= 5; index++) {
    activity.record([{ id: "a", lastActivityAt: `t${index}` }], bucketStart + index * 1_000);
  }
  assert.equal(activity.buckets("a", bucketStart + 5_000).at(-1), 1);

  const later = bucketStart + 31 * ACTIVITY_BUCKET_MS;
  assert.deepEqual(activity.buckets("a", later), new Array(ACTIVITY_BUCKETS).fill(0));
});
