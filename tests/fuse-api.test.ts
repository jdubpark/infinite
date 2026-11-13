import test from "node:test";
import assert from "node:assert/strict";
import { clientCommandCandidate, fuseLines, parseClientArgs, parseFuseCommand } from "../packages/host/src/client.js";
import { inProcessHost, startHost } from "./helpers.js";

const PROJECT = "rehearsal";

test("GET /api/fuse returns the view", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    const response = await host.fetchApi("/fuse", "viewer");
    assert.equal(response.status, 200);
    assert.equal(response.body.host.hour.limit, 80);
    assert.deepEqual(response.body.projects.map((project: { projectId: string }) => project.projectId), [PROJECT]);
    assert.equal(response.body.host.state, "closed");
    assert.equal(response.body.projects[0].state, "closed");
    assert.deepEqual(Object.keys(response.body).sort(), ["authoritative", "host", "projects"]);
  } finally { await host.stop(); }
});

// The in-process host exposes the fuse, so the test can open a trip through the same admission path the teams use.
test("closing a fuse is owner only", { timeout: 60000 }, async () => {
  const host = await inProcessHost();
  try {
    const hostClose = { scope: "host" };
    assert.equal((await host.fetchApi("/fuse/close", "viewer", hostClose)).status, 403);
    const idle = await host.fetchApi("/fuse/close", "owner", hostClose);
    assert.equal(idle.status, 200);
    assert.equal(idle.body.result, "not-open");
    assert.equal(idle.body.view.host.state, "closed");
    assert.equal((await host.fetchApi("/fuse/close", "owner", { scope: "project", projectId: "missing" })).status, 404);
    assert.equal((await host.fetchApi("/fuse/close", "owner", { scope: "project", projectId: PROJECT, extra: true })).status, 400);

    for (let index = 0; index < 30; index++)
      assert.equal(host.fuse.admit({ launchId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, projectId: PROJECT, purpose: "work", role: "implementer", profileId: "profile" }).ok, true);
    assert.equal(host.fuse.check({ projectId: PROJECT }).state, "open");
    const opened = await host.fetchApi("/fuse", "viewer");
    assert.equal(opened.body.projects[0].state, "open");
    const closed = await host.fetchApi("/fuse/close", "owner", { scope: "project", projectId: PROJECT });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.result, "closed");
    assert.equal(closed.body.view.projects[0].state, "closed");
  } finally { await host.stop(); }
});

test("fuse lines and arguments", () => {
  const view = {
    authoritative: true,
    host: { state: "closed" as const, hour: { launches: 3, limit: 80 } },
    projects: [{ projectId: "fixture", state: "open" as const, trip: { cause: "launch-rate" as const, ownerClose: true }, hour: { launches: 30, limit: 30 } }],
  };
  assert.deepEqual(fuseLines(view), [
    "Host: closed, 3 of 80 launches in the last hour",
    "Project fixture: open (launch rate, the owner must close it)",
  ]);
  const hostile = fuseLines({ ...view, projects: [{ ...view.projects[0], projectId: "fix\nture\u001b[2J" }] });
  assert.ok(hostile.every(line => !/[\x00-\x1f\x7f-\x9f]/.test(line)), "host text is cleaned");

  assert.deepEqual(parseFuseCommand([], { "--json": true }), { action: "view" });
  assert.deepEqual(parseFuseCommand(["close"], { "--host": true }), { action: "close", scope: { scope: "host" } });
  assert.deepEqual(parseFuseCommand(["close"], { "--project": "p" }), { action: "close", scope: { scope: "project", projectId: "p" } });
  const usage = /Usage: infinite fuse/;
  assert.throws(() => parseFuseCommand(["close"], { "--host": true, "--project": "p" }), usage);
  assert.throws(() => parseFuseCommand(["close"], {}), usage);

  assert.equal(clientCommandCandidate(["fuse", "--json"]), "fuse");
  assert.equal(parseClientArgs(["fuse", "close", "--host"]).options["--host"], true);
});
