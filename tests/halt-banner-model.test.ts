import test from "node:test";
import assert from "node:assert/strict";
import { haltNotice as phoneNotice, type HaltView } from "../apps/mobile/src/features/halt/model.ts";
import { haltNotice as webNotice } from "../apps/web/src/halt.ts";

const at = "2026-11-15T09:00:00.000Z";
const billing = { projectId: "billing", haltId: "h-billing", at, by: "Owner phone", reason: "Rotating keys" };
const store = { projectId: "store", haltId: "h-store", at, by: "Owner phone" };
const host = { haltId: "h-host", at, by: "Owner laptop" };
const view = (value: Partial<HaltView>): HaltView => ({ readable: true, projects: [], ...value });

test("a host halt, and an unreadable record, cover every screen on both clients", () => {
  for (const place of ["overview", { projectIds: ["billing"] }, { projectIds: [] }] as const) {
    assert.deepEqual(webNotice(view({ host, projects: [billing] }), place), { kind: "host", halt: host, projects: [billing] });
    assert.deepEqual(phoneNotice(view({ host, projects: [billing] }), place), { kind: "host", halt: host, projects: [billing] });
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
