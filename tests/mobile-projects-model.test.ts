import test from "node:test";
import assert from "node:assert/strict";
import { checkoutsOf, combineLabel, groupActivity, groupContaining, primaryCheckout, projectSections, visibleGroups } from "../apps/mobile/src/features/projects/model.ts";
import type { BoardItem, ProjectGroup, ProjectGroupCheckout, ProjectGroupRepo } from "../apps/mobile/src/api/client.ts";

const item = (overrides: Partial<BoardItem> = {}): BoardItem => ({
  kind: "mission", id: "mission", title: "Mission", projectName: "Project", groupId: "project",
  column: "working", status: "working", detail: "Planning work", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
});
const checkout = (projectId: string, primary = false, teamReady = true): ProjectGroupCheckout => ({ projectId, name: projectId, path: `/home/dev/${projectId}`, primary, teamReady });
const group = (id: string, repos: ProjectGroupRepo[], hidden = false): ProjectGroup => ({ id, name: id, kind: "repository", hidden, repos, implicit: false, revision: 1, createdAt: "", updatedAt: "" });
const sample = group("sample", [{ projectId: "sample-main", name: "sample", path: "/home/dev/sample-main", checkouts: [checkout("sample-codex"), checkout("sample-main", true)] }]);

test("visibleGroups drops hidden projects and keeps order", () => {
  assert.deepEqual(visibleGroups([sample, group("old", [], true), group("z", [])]).map(value => value.id), ["sample", "z"]);
});

test("groupActivity counts open columns in order and names the empty case", () => {
  const items = [item({ groupId: "sample", column: "working" }), item({ groupId: "sample", column: "review", kind: "team" }), item({ groupId: "sample", column: "needs-input" }), item({ groupId: "sample", column: "ended" }), item({ groupId: "other" })];
  assert.equal(groupActivity(items, "sample"), "1 needs input · 1 working · 1 to review");
  assert.equal(groupActivity([item({ groupId: "sample", column: "ended" })], "sample"), "Nothing running");
  assert.equal(groupActivity([item({ groupId: "sample", column: "needs-input" }), item({ groupId: "sample", column: "needs-input" })], "sample"), "2 need input");
});

test("checkoutsOf, groupContaining, and primaryCheckout read the folded shape", () => {
  assert.deepEqual(checkoutsOf(sample).map(value => value.projectId), ["sample-main", "sample-codex"]);
  assert.equal(groupContaining([sample], "sample-codex")?.id, "sample");
  assert.equal(groupContaining([sample], "sample")?.id, "sample");
  assert.equal(groupContaining([sample], "nope"), undefined);
  assert.equal(primaryCheckout(sample)?.projectId, "sample-main");
});

test("projectSections splits hidden projects and combineLabel names the projects a suggestion joins", () => {
  const api = group("shop-api", []), web = group("shop-web", []);
  api.name = "Shop API"; web.name = "Shop Web";
  const sections = projectSections({ groups: [api, group("old", [], true), web], suggestions: [{ name: "Shop", repos: ["a", "w"], groupIds: ["shop-api", "shop-web"], reason: "shared-parent" }] });
  assert.deepEqual(sections.visible.map(value => value.id), ["shop-api", "shop-web"]);
  assert.deepEqual(sections.hidden.map(value => value.id), ["old"]);
  assert.equal(combineLabel(sections.suggestions[0]!, sections.visible), "Combine Shop API and Shop Web");
  assert.equal(combineLabel({ name: "x", repos: [], groupIds: ["shop-api", "shop-web", "missing"], reason: "shared-parent" }, sections.visible), "Combine Shop API, Shop Web, and missing");
});
