import test from "node:test";
import assert from "node:assert/strict";
import { createHaltStore, haltNotice as phoneNotice, workspaceHaltScope, type HaltView } from "../apps/mobile/src/features/halt/model.ts";
import { haltNotice as webNotice, missionHaltPlace } from "../apps/web/src/halt.ts";

const at = "2026-11-15T09:00:00.000Z";
const billing = { projectId: "billing", haltId: "h-billing", at, by: "Owner phone", reason: "Rotating keys" };
const store = { projectId: "store", haltId: "h-store", at, by: "Owner phone" };
const host = { haltId: "h-host", at, by: "Owner laptop" };
const view = (value: Partial<HaltView>): HaltView => ({ readable: true, projects: [], ...value });

test("a host halt, and an unreadable record, cover every screen on both clients", () => {
  for (const place of ["overview", { projectIds: ["billing"] }, { projectIds: [] }] as const) {
    const own = typeof place === "object" && !place.projectIds.length ? [] : [billing];
    assert.deepEqual(webNotice(view({ host, projects: [billing] }), place), { kind: "host", halt: host, projects: own });
    assert.deepEqual(phoneNotice(view({ host, projects: [billing] }), place), { kind: "host", halt: host, projects: own });
    assert.deepEqual(webNotice({ readable: false, projects: [] }, place), { kind: "unreadable" });
    assert.deepEqual(phoneNotice({ readable: false, projects: [] }, place), { kind: "unreadable" });
  }
  assert.deepEqual(phoneNotice(view({ host }), "screen"), { kind: "host", halt: host, projects: [] });
  assert.deepEqual(phoneNotice({ readable: false, projects: [] }, "screen"), { kind: "unreadable" });
});

test("a project halt shows on that project's screens and compactly on the overview", () => {
  const both = view({ projects: [billing, store] });
  for (const notice of [webNotice, phoneNotice]) {
    assert.deepEqual(notice(both, { projectIds: ["billing"] }), { kind: "project", halts: [billing] });
    assert.deepEqual(notice(both, { projectIds: ["billing", "store", "docs"] }), { kind: "project", halts: [billing, store] });
    assert.equal(notice(both, { projectIds: ["docs"] }), null);
    assert.deepEqual(notice(both, "overview"), { kind: "overview", halts: [billing, store] });
    assert.equal(notice(view({}), "overview"), null);
    assert.equal(notice(null, "overview"), null);
  }
  assert.equal(phoneNotice(both, "screen"), null);
});

test("a mission page covers its pinned repositories, as the host does, not only where subtasks run", () => {
  const docs = { projectId: "docs", haltId: "h-docs", at, by: "Owner phone" };
  const both = view({ host, projects: [billing, store, docs] });
  const place = missionHaltPlace(["billing", "store", "billing"]);
  assert.deepEqual(place, { projectIds: ["billing", "store"] });
  assert.deepEqual(webNotice(both, place), { kind: "host", halt: host, projects: [billing, store] });
  assert.deepEqual(webNotice(view({ projects: [billing, store, docs] }), place), { kind: "project", halts: [billing, store] });
  assert.equal(webNotice(view({ projects: [docs] }), place), null);
  assert.deepEqual(webNotice(view({ projects: [billing] }), missionHaltPlace(["billing"])), { kind: "project", halts: [billing] });
  assert.deepEqual(webNotice(view({ projects: [store] }), missionHaltPlace(["billing", "store"])), { kind: "project", halts: [store] });
  assert.equal(webNotice(view({ projects: [billing] }), missionHaltPlace([])), null);
  assert.deepEqual(webNotice(view({ host, projects: [billing] }), missionHaltPlace([])), { kind: "host", halt: host, projects: [] });
  assert.deepEqual(webNotice({ readable: false, projects: [] }, missionHaltPlace([])), { kind: "unreadable" });
});

test("a workspace's halt scope is its checkouts and primary projects, named from live membership", () => {
  const repositories = [{ id: "api", name: "API", checkoutIds: ["api", "api-fork"] }, { id: "web", name: "Web", checkoutIds: ["web"] }];
  const cached = workspaceHaltScope(repositories);
  assert.deepEqual(cached.projectIds, ["api", "api-fork", "web"]);
  assert.equal(cached.name("api"), "API");
  assert.equal(cached.name("api-fork"), undefined);
  const live = workspaceHaltScope(repositories, [{ projectId: "api-fork", name: "API fork" }]);
  assert.equal(live.name("api-fork"), "API fork");
  assert.deepEqual(workspaceHaltScope([]).projectIds, []);
  assert.equal(phoneNotice(view({ projects: [store] }), { projectIds: cached.projectIds }), null);
  assert.deepEqual(phoneNotice(view({ projects: [billing, { ...store, projectId: "api-fork" }] }), { projectIds: cached.projectIds }), { kind: "project", halts: [{ ...store, projectId: "api-fork" }] });
});

test("every phone screen shows the newest halt read, so navigation cannot bring back a released halt", () => {
  const halts = createHaltStore(), halted = view({ host }), released = view({});
  let redraws = 0;
  halts.subscribe(() => redraws++);
  halts.record("machine", halts.begin(), halted);
  halts.record("machine", halts.begin(), released);
  assert.equal(halts.get("machine"), released);
  const early = halts.begin(), late = halts.begin();
  halts.record("machine", late, released);
  halts.record("machine", early, halted);
  assert.equal(halts.get("machine"), released);
  halts.record("machine", halts.begin(), view({}));
  assert.equal(halts.get("machine"), released);
  assert.equal(redraws, 2);
  assert.equal(halts.get("other"), null);
});
