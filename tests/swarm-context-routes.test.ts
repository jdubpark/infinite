import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startHost, waitFor } from "./helpers.js";

// The Swarm graph's read-only context endpoints on a real host: every paired role may read them, and none of them mutates.
test("swarm context endpoints answer every role and refuse unknown projects, sessions and teams", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    const me = await host.fetchApi("/me", "viewer");
    assert.equal((me.body as { capabilities: { swarmContext?: number } }).capabilities.swarmContext, 1);

    // This host has no repository graphs configured, so its map is disabled rather than missing.
    for (const role of ["owner", "controller", "viewer"] as const) {
      const map = await host.fetchApi("/projects/rehearsal/graph/map", role);
      assert.equal(map.status, 200);
      assert.deepEqual(map.body, { state: "disabled" });
    }
    assert.equal((await host.fetchApi("/projects/rehearsal/graph/map?lane=run-" + randomUUID(), "viewer")).status, 200);
    assert.equal((await host.fetchApi("/projects/missing/graph/map", "viewer")).status, 404);
    assert.equal((await host.fetchApi("/projects/rehearsal/graph/map?lane=../shared", "viewer")).status, 400);
    assert.equal((await host.fetchApi("/projects/rehearsal/graph/map", "owner", {})).status, 404, "the map is GET only");

    const sessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: sessionId, provider: "demo", projectId: "rehearsal", title: "Context", prompt: "Initial request" });
    await waitFor(async () => (await host.fetchApi(`/sessions/${sessionId}`)).status, status => status === 200);
    // The rehearsal provider records no tool inputs, so the host reports it as not observable instead of as having touched nothing.
    const touches = await host.fetchApi(`/sessions/${sessionId}/context`, "viewer");
    assert.equal(touches.status, 200);
    assert.deepEqual(touches.body, { sessionId, observable: false, complete: true, graphQueries: 0, files: [], truncated: false });

    assert.equal((await host.fetchApi(`/sessions/${randomUUID()}/context`, "viewer")).status, 404);
    assert.equal((await host.fetchApi(`/teams/${randomUUID()}/context`, "viewer")).status, 404);
    assert.equal((await host.fetchApi("/teams/not-a-uuid/context", "viewer")).status, 400);
  } finally { await host.stop(); }
});

test("a codex agent whose hooks are off is not observable, even when its command records reads", { timeout: 60000 }, async () => {
  // Codex hooks are off by default, so the host records no tool inputs for it and must not answer as observed.
  const agent = { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/touch-agent.mjs", import.meta.url))] };
  const host = await startHost({ agents: { codex: agent } });
  try {
    const sessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: sessionId, provider: "codex", projectId: "rehearsal", title: "Codex", prompt: "touch" });
    await waitFor(async () => (await host.fetchApi(`/sessions/${sessionId}`)).status, status => status === 200);
    const touches = await host.fetchApi(`/sessions/${sessionId}/context`, "viewer");
    assert.equal(touches.status, 200);
    assert.deepEqual(touches.body, { sessionId, observable: false, complete: true, graphQueries: 0, files: [], truncated: false });
  } finally { await host.stop(); }
});

test("an agent's recorded tool inputs come back as its touched files", { timeout: 60000 }, async () => {
  const agent = { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/touch-agent.mjs", import.meta.url))] };
  const host = await startHost({ agents: { claude: agent }, config: { attention: { idleAfterMs: 3000, hooks: { claude: true, codex: true } } } });
  try {
    const sessionId = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: sessionId, provider: "claude", projectId: "rehearsal", title: "Touches", prompt: "touch" });
    type Touches = { observable: boolean; complete: boolean; graphQueries: number; truncated: boolean; files: { path: string; reads: number; edits: number }[] };
    // The hooks travel worker to journal; the index reads the journal's signals on request.
    const touches = await waitFor(async () => (await host.fetchApi(`/sessions/${sessionId}/context`, "viewer")).body as Touches, body => body.graphQueries === 1, 15000);
    assert.equal(touches.observable, true);
    assert.equal(touches.complete, true);
    assert.equal(touches.truncated, false);
    // The read outside the working directory is not there, and the two reads of one file are one entry.
    assert.deepEqual(touches.files.map(file => [file.path, file.reads, file.edits]).sort(), [["src/app.ts", 2, 0], ["src/lib/http.ts", 0, 1]]);
  } finally { await host.stop(); }
});
