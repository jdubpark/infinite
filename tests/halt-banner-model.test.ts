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
    // A screen that belongs to projects names only its own projects among those halted on their own, on both clients.
    const own = typeof place === "object" && !place.projectIds.length ? [] : [billing];
    assert.deepEqual(webNotice(view({ host, projects: [billing] }), place), { kind: "host", halt: host, projects: own });
    assert.deepEqual(phoneNotice(view({ host, projects: [billing] }), place), { kind: "host", halt: host, projects: own });
    // An unreadable record carries no halts, and it still holds the whole host.
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
    // Nothing read yet, or a host that does not serve the halt: no banner and no claim either way.
    assert.equal(notice(null, "overview"), null);
  }
  // The phone's other main screens show only a host halt.
  assert.equal(phoneNotice(both, "screen"), null);
});

test("a mission page shows the host halt and halts on its subtasks' projects only", () => {
  const docs = { projectId: "docs", haltId: "h-docs", at, by: "Owner phone" };
  const both = view({ host, projects: [billing, store, docs] });
  // Subtasks in billing and store; docs is halted but no subtask runs there, so it is not named.
  const place = missionHaltPlace([{ repoProjectId: "billing" }, { repoProjectId: "store" }, { repoProjectId: "billing" }]);
  assert.deepEqual(place, { projectIds: ["billing", "store"] });
  assert.deepEqual(webNotice(both, place), { kind: "host", halt: host, projects: [billing, store] });
  // Without a host halt, the mission shows only the project halts it covers.
  assert.deepEqual(webNotice(view({ projects: [billing, store, docs] }), place), { kind: "project", halts: [billing, store] });
  assert.equal(webNotice(view({ projects: [docs] }), place), null);
  // A mission with no subtasks yet covers no project: only a host halt or an unreadable record shows.
  assert.equal(webNotice(view({ projects: [billing] }), missionHaltPlace([])), null);
  assert.deepEqual(webNotice(view({ host, projects: [billing] }), missionHaltPlace([])), { kind: "host", halt: host, projects: [] });
  assert.deepEqual(webNotice({ readable: false, projects: [] }, missionHaltPlace([])), { kind: "unreadable" });
});

test("a workspace's halt scope is its checkouts and primary projects, named from live membership", () => {
  const repositories = [{ id: "api", name: "API", checkoutIds: ["api", "api-fork"] }, { id: "web", name: "Web", checkoutIds: ["web"] }];
  // Offline, from the cached brief alone: the scope covers every checkout, and only a primary project takes its repo's name.
  const cached = workspaceHaltScope(repositories);
  assert.deepEqual(cached.projectIds, ["api", "api-fork", "web"]);
  assert.equal(cached.name("api"), "API");
  assert.equal(cached.name("api-fork"), undefined);
  // A live group read names each checkout, and that name wins.
  const live = workspaceHaltScope(repositories, [{ projectId: "api-fork", name: "API fork" }]);
  assert.equal(live.name("api-fork"), "API fork");
  assert.deepEqual(workspaceHaltScope([]).projectIds, []);
  // Scoped to the workspace, a project halt outside it is not shown.
  assert.equal(phoneNotice(view({ projects: [store] }), { projectIds: cached.projectIds }), null);
  assert.deepEqual(phoneNotice(view({ projects: [billing, { ...store, projectId: "api-fork" }] }), { projectIds: cached.projectIds }), { kind: "project", halts: [{ ...store, projectId: "api-fork" }] });
});

test("every phone screen shows the newest halt read, so navigation cannot bring back a released halt", () => {
  const halts = createHaltStore(), halted = view({ host }), released = view({});
  let redraws = 0;
  halts.subscribe(() => redraws++);
  // The board reads the halt, then a detail screen reads it after the owner released it.
  halts.record("machine", halts.begin(), halted);
  halts.record("machine", halts.begin(), released);
  assert.equal(halts.get("machine"), released);
  // A read that started before the stored one answers late: it is dropped.
  const early = halts.begin(), late = halts.begin();
  halts.record("machine", late, released);
  halts.record("machine", early, halted);
  assert.equal(halts.get("machine"), released);
  // An unchanged answer keeps the stored object, and machines do not share a snapshot.
  halts.record("machine", halts.begin(), view({}));
  assert.equal(halts.get("machine"), released);
  assert.equal(redraws, 2);
  assert.equal(halts.get("other"), null);
});
