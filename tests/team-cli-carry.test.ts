import test from "node:test";
import assert from "node:assert/strict";
import { carriedTeamSettings } from "../packages/host/src/team-cli.js";

test("carriedTeamSettings keeps every team key that repo init does not own", () => {
  const features = { areas: [{ id: "host", paths: ["packages/host"] }] };
  const team = {
    setup: { command: "npm", args: ["ci"] },
    checks: [{ command: "npm", args: ["test"] }],
    establishChecks: true,
    handoff: "auto",
    delivery: { mode: "review" },
    permissions: { mode: "coordinator", scope: "Read files.", maxDecisions: 3 },
    handoffMinutes: 30,
    features,
    eval: { capture: true },
    routing: { mode: "shadow" },
  };
  assert.deepEqual(carriedTeamSettings(team), { handoffMinutes: 30, features, eval: { capture: true }, routing: { mode: "shadow" } });
});

test("carriedTeamSettings returns an empty object for values that are not plain team blocks", () => {
  for (const value of [undefined, null, "team", ["checks"]]) assert.deepEqual(carriedTeamSettings(value), {});
});
