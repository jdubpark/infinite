import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Agent, AgentState, CodeMap, SessionTouches, Swarm, SwarmModel, SwarmTask, Unit } from "../apps/web/src/swarm/types";
import { areaOf, areaOfOwned, buildGraph, contextRequests, GRAPH_BUDGET, nextBatch, SESSION_BATCH, type GraphData } from "../apps/web/src/swarm/graph-model";
import { layoutGraph } from "../apps/web/src/swarm/graph-layout";

// Fixtures use neutral names only (checkout-v2, packages/host/src, web).

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id, sessionId: `s-${id}`, swarmId: "run-1", unitId: "unit-1", projectId: "checkout-v2", role: "IM", stage: "build",
    state: "working", earlier: false, limited: false, stalled: false, observable: true, title: `task ${id}`, provider: "claude",
    ...over,
  };
}

function unit(id: string, over: Partial<Unit> = {}): Unit {
  return {
    id, swarmId: "run-1", title: `unit ${id}`, projectId: "checkout-v2", status: "implementing", revision: 1, live: true,
    reached: "build", checks: { passed: 0, failed: 0, running: 0 }, agents: [], side: [], dependsOn: [], waiting: 0,
    createdAt: "2026-11-13T09:00:00.000Z", lastActivityAt: "2026-11-13T09:00:00.000Z", baseCommit: "base", tasks: [], ...over,
  };
}

function team(id: string, units: Unit[], over: Partial<Swarm> = {}): Swarm {
  return { id, kind: "team", title: `team ${id}`, live: true, units, ghosts: [], loose: [], waiting: 0, createdAt: "2026-11-13T09:00:00.000Z", ...over };
}

function model(live: Swarm[]): SwarmModel {
  return {
    live, quiet: [], quietOlder: 0,
    totals: {
      byState: { "needs-you": 0, "in-review": 0, working: 0, waiting: 0, queued: 0, reported: 0, stopped: 0, fault: 0 },
      agents: 0, waitingOnPerson: 0, slots: { running: 0, limit: 0 }, costUsd: 0,
    },
  };
}

function touches(sessionId: string, files: SessionTouches["files"], over: Partial<SessionTouches> = {}): SessionTouches {
  return { sessionId, observable: true, complete: true, graphQueries: 0, files, truncated: false, ...over };
}

function task(id: string, memberId: string, paths: string[], changed: string[] = []): SwarmTask {
  return { id, title: `task ${id}`, status: "running", dependsOn: [], paths, memberId, changedPaths: { paths: changed, truncated: false } };
}

function readyMap(areas: { id: string; symbols: number }[], links: { source: string; target: string; weight: number }[] = []): CodeMap {
  return {
    state: "ready", lane: "shared", head: "abc1234", builtAt: "2026-11-13T09:00:00.000Z",
    areas: areas.map(a => ({ id: a.id, files: 1, symbols: a.symbols })), links, truncated: { areas: false, links: false },
  };
}

function build(input: Partial<Parameters<typeof buildGraph>[0]> & { model: SwarmModel }): GraphData {
  return buildGraph({ maps: {}, touches: {}, projectNames: {}, ...input });
}

const nodeIds = (data: GraphData) => new Set(data.nodes.map(node => node.id));
const linkIds = (data: GraphData) => new Set(data.links.map(link => link.id));

describe("swarm graph model", () => {
  test("touch kinds stay separate", () => {
    const member = agent("a1", { unitId: "unit-1" });
    const u = unit("unit-1", {
      agents: [member],
      tasks: [task("t1", "a1", ["packages/host/src/a.ts"], ["packages/host/src/a.ts"])],
    });
    const data = build({
      model: model([team("run-1", [u])]),
      touches: { "s-a1": touches("s-a1", [{ path: "packages/host/src/a.ts", reads: 2, edits: 1, lastAt: "2026-11-13T09:01:00.000Z" }]) },
    });
    const byId = new Map(data.links.map(link => [link.id, link]));
    const target = "area:checkout-v2:packages/host";
    assert.equal(byId.get(`planned:agent:a1>${target}`)?.weight, 1);
    assert.equal(byId.get(`integrated:agent:a1>${target}`)?.weight, 1);
    assert.equal(byId.get(`read:agent:a1>${target}`)?.weight, 2);
    assert.equal(byId.get(`edit:agent:a1>${target}`)?.weight, 1);
  });

  test("neighbours are drawn and capped at three", () => {
    const member = agent("a1");
    const u = unit("unit-1", { agents: [member], tasks: [task("t1", "a1", ["packages/host/src/a.ts"])] });
    const map = readyMap(
      [{ id: "packages/host/src", symbols: 20 }, { id: "packages/a", symbols: 3 }, { id: "packages/b", symbols: 3 },
        { id: "packages/c", symbols: 3 }, { id: "packages/d", symbols: 3 }],
      [
        { source: "packages/a", target: "packages/host/src", weight: 9 },
        { source: "packages/host/src", target: "packages/b", weight: 8 },
        { source: "packages/c", target: "packages/host/src", weight: 7 },
        { source: "packages/d", target: "packages/host/src", weight: 6 },
      ],
    );
    const data = build({ model: model([team("run-1", [u])]), maps: { "checkout-v2": map } });
    const ids = nodeIds(data);
    for (const name of ["packages/a", "packages/b", "packages/c"]) assert.ok(ids.has(`area:checkout-v2:${name}`), name);
    assert.ok(!ids.has("area:checkout-v2:packages/d"));
    const neighbour = data.nodes.find(node => node.id === "area:checkout-v2:packages/a");
    assert.equal(neighbour?.touched, false);
    assert.equal(neighbour?.heat, 0);
  });

  test("no code map", () => {
    const member = agent("a1");
    const u = unit("unit-1", { agents: [member], tasks: [task("t1", "a1", ["packages/host/src/a.ts"])] });
    const data = build({
      model: model([team("run-1", [u])]),
      touches: { "s-a1": touches("s-a1", [{ path: "apps/web/src/b.ts", reads: 1, edits: 0, lastAt: "2026-11-13T09:01:00.000Z" }]) },
    });
    assert.equal(data.codeGraph, "off");
    assert.equal(build({ model: model([]) }).codeGraph, "none", "with no project drawn there is no code graph to flag");
    assert.ok(nodeIds(data).has("area:checkout-v2:packages/host"));
    assert.ok(nodeIds(data).has("area:checkout-v2:apps/web"));
    assert.equal(data.links.filter(link => link.kind === "code").length, 0);
  });

  test("unobservable agent", () => {
    const member = agent("a1", { observable: false });
    const u = unit("unit-1", { agents: [member], tasks: [task("t1", "a1", ["packages/host/src/a.ts"], ["packages/host/src/a.ts"])] });
    const data = build({
      model: model([team("run-1", [u])]),
      touches: { "s-a1": touches("s-a1", [{ path: "packages/host/src/a.ts", reads: 3, edits: 2, lastAt: "2026-11-13T09:01:00.000Z" }]) },
    });
    assert.equal(data.unobserved, 1);
    assert.equal(data.nodes.find(node => node.agentId === "a1")?.unobserved, true, "the node says which agent has no signal");
    assert.equal(data.links.filter(link => link.kind === "read" || link.kind === "edit").length, 0);
    assert.ok(data.links.some(link => link.kind === "planned"));
    assert.ok(data.links.some(link => link.kind === "integrated"));
  });

  test("one cluster per project", () => {
    const a1 = agent("a1", { projectId: "checkout-v2" });
    const a2 = agent("a2", { projectId: "checkout-v2" });
    const u1 = unit("unit-1", { agents: [a1], tasks: [task("t1", "a1", ["packages/host/src/a.ts"])] });
    const u2 = unit("unit-2", { agents: [a2], tasks: [task("t2", "a2", ["apps/web/src/b.ts"])] });
    const data = build({ model: model([team("run-1", [u1, u2])]) });
    const projects = data.nodes.filter(node => node.kind === "project");
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, "project:checkout-v2");
    const contains = data.links.filter(link => link.kind === "contains" && link.source === "project:checkout-v2");
    assert.equal(contains.length, 2);
  });

  test("agent budget drops stopped first", () => {
    const working = Array.from({ length: 59 }, (_, i) => agent(`w${i}`, { state: "working" as AgentState }));
    const extra = [
      agent("stopped-1", { state: "stopped" }),
      agent("reported-1", { state: "reported" }),
      agent("queued-1", { state: "queued" }),
    ];
    const u = unit("unit-1", { agents: [...working, ...extra] });
    const data = build({ model: model([team("run-1", [u])]) });
    assert.equal(data.dropped.agents, 2);
    const ids = nodeIds(data);
    assert.ok(!ids.has("agent:stopped-1"));
    assert.ok(!ids.has("agent:reported-1"));
    assert.ok(ids.has("agent:queued-1"));
    for (const member of working) assert.ok(ids.has(`agent:${member.id}`), member.id);
    assert.equal(data.nodes.filter(node => node.kind === "agent").length, GRAPH_BUDGET.agents);
  });

  test("area and link budgets", () => {
    // 130 touched directories with no code map: 120 drawn, 10 dropped.
    const files = Array.from({ length: 130 }, (_, i) => ({ path: `d${i}/x/f.ts`, reads: 1, edits: 0, lastAt: "2026-11-13T09:01:00.000Z" }));
    const member = agent("a1");
    const u = unit("unit-1", { agents: [member] });
    const wide = build({ model: model([team("run-1", [u])]), touches: { "s-a1": touches("s-a1", files) } });
    assert.equal(wide.nodes.filter(node => node.kind === "area").length, GRAPH_BUDGET.areas);
    assert.equal(wide.dropped.areas, 10);

    // 30 touched areas fully linked: 435 code links, 400 kept, 35 dropped.
    const names = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const links: { source: string; target: string; weight: number }[] = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) links.push({ source: names[i], target: names[j], weight: 1 });
    const dense = build({
      model: model([team("run-1", [u])]),
      maps: { "checkout-v2": readyMap(names.map(name => ({ id: name, symbols: 4 })), links) },
      touches: { "s-a1": touches("s-a1", names.map(name => ({ path: `${name}/f.ts`, reads: 1, edits: 0, lastAt: "2026-11-13T09:01:00.000Z" }))) },
    });
    assert.equal(dense.links.filter(link => link.kind === "code").length, GRAPH_BUDGET.codeLinks);
    assert.equal(dense.dropped.codeLinks, 35);
  });

  test("areaOf picks the longest prefix", () => {
    assert.equal(areaOf("packages/host/src/a.ts", undefined), "packages/host");
    assert.equal(areaOf("README.md", undefined), ".");
    assert.equal(areaOf("packages/host/src/a.ts", new Set(["packages", "packages/host"])), "packages/host");
    assert.equal(areaOf("packages/host/src/a.ts", new Set(["packages", "packages/host", "packages/host/src"])), "packages/host/src");
    assert.equal(areaOf("packages/host/src/a.ts", new Set(["apps"])), ".");
  });

  test("mission coordinator and dispatch links", () => {
    const coordinator = agent("sess-c", { id: "sess-c", sessionId: "sess-c", role: "MC", unitId: undefined, projectId: undefined, stage: undefined });
    const dependent = unit("unit-2", { dependsOn: ["unit-1"] });
    const first = unit("unit-1");
    const mission: Swarm = { id: "m1", kind: "mission", title: "mission m1", live: true, units: [first, dependent], ghosts: [], loose: [], waiting: 0, coordinator, createdAt: "2026-11-13T09:00:00.000Z" };
    const data = build({ model: model([mission]) });
    const linked = linkIds(data);
    assert.ok(linked.has("member:agent:sess-c>mission:m1"));
    assert.ok(linked.has("dispatch:mission:m1>unit:unit-1"));
    assert.ok(linked.has("dispatch:mission:m1>unit:unit-2"));
    assert.ok(linked.has("depends:unit:unit-2>unit:unit-1"));
  });
});

test("a planned directory is its own area", () => {
  const areas = new Set(["src/routes/orders", "src/lib"]);
  assert.equal(areaOfOwned("src/routes/orders", areas), "src/routes/orders");
  assert.equal(areaOfOwned("src/routes/orders/", areas), "src/routes/orders");
  assert.equal(areaOfOwned("src/routes/orders/create.ts", areas), "src/routes/orders");
  assert.equal(areaOfOwned("src/lib/http.ts", areas), "src/lib");
  assert.equal(areaOfOwned("docs", areas), ".");
  // Without a map a path with no extension is a directory, cut to two segments like any other.
  assert.equal(areaOfOwned("src/routes/orders", undefined), "src/routes");
  assert.equal(areaOfOwned("src/a.ts", undefined), "src");
});

test("layout depends on which nodes exist, not on agent state", () => {
  const build2 = (state: AgentState) => {
    const live = [team("checkout-v2", [unit("api", { agents: [agent("a1", { state }), agent("a2")], tasks: [task("t1", "a1", ["src/lib"])] })])];
    const data = build({ model: model(live), maps: { "shop-api": readyMap([{ id: "src/lib", symbols: 9 }, { id: "src/routes", symbols: 4 }], [{ source: "src/lib", target: "src/routes", weight: 3 }]) } });
    return layoutGraph(data, model(live));
  };
  const working = build2("working"), waiting = build2("needs-you");
  assert.deepEqual([...waiting.at.entries()], [...working.at.entries()]);
  assert.ok(working.at.size >= 5, "the hub, both agents, and both areas are placed");
  // Every placed node has its own position.
  const spots = new Set([...working.at.values()].map(point => `${point.x},${point.y}`));
  assert.equal(spots.size, working.at.size);
});

test("a solo session's observed touches are drawn in its own project", () => {
  const solo: Swarm = { id: "solo", kind: "solo", title: "solo", live: true, units: [], ghosts: [], waiting: 0, createdAt: "2026-11-13T09:00:00.000Z",
    loose: [agent("free", { role: "SO", stage: undefined, unitId: undefined, swarmId: "solo", projectId: "shop-api" })] };
  const live = model([solo]);
  assert.deepEqual(contextRequests(live), { projects: ["shop-api"], teams: [], sessions: ["s-free"] });
  const data = build({ model: live, maps: { "shop-api": readyMap([{ id: "src/lib", symbols: 9 }]) },
    touches: { "s-free": touches("s-free", [{ path: "src/lib/http.ts", reads: 2, edits: 0, lastAt: "2026-11-13T09:00:00.000Z" }]) } });
  assert.ok(linkIds(data).has("read:agent:free>area:shop-api:src/lib"));
  assert.ok(nodeIds(data).has("project:shop-api"));
});

test("session context is asked for a batch at a time and reaches every session", () => {
  assert.equal(SESSION_BATCH, 12, "the request budget the design sets");
  const sessions = Array.from({ length: 30 }, (_, index) => `s${index}`);
  const seen = new Set<string>();
  let offset = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    const next = nextBatch(sessions, offset, SESSION_BATCH);
    assert.equal(next.batch.length, SESSION_BATCH);
    for (const id of next.batch) seen.add(id);
    offset = next.offset;
  }
  assert.equal(seen.size, 30);
  // A short list is asked whole every cycle.
  assert.deepEqual(nextBatch(["a", "b"], 5, SESSION_BATCH), { batch: ["a", "b"], offset: 0 });
});
