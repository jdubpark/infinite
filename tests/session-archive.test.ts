import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { claimControl, startHost, waitFor } from "./helpers.js";

async function readLiveSessions(host: Awaited<ReturnType<typeof startHost>>) {
  const response = await fetch(`${host.origin}/api/events?topics=sessions`, {
    headers: { Authorization: `Bearer ${host.tokens.owner}` },
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Live session feed closed before its first update");
      buffered += decoder.decode(value, { stream: true });
      const start = buffered.indexOf("event: update\n");
      const end = start < 0 ? -1 : buffered.indexOf("\n\n", start);
      if (end < 0) continue;
      const frame = buffered.slice(start, end);
      const data = frame.split("\n").find(line => line.startsWith("data: "));
      if (data) return (JSON.parse(data.slice(6)) as { data: { sessions: any[] } }).data.sessions;
    }
  } finally {
    await reader.cancel();
  }
}

test("session archive requires an exited session and is stable across retries and unarchive", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", {
      requestId: id, provider: "demo", projectId: "rehearsal", title: "Archive lifecycle", prompt: "Keep this session available",
    });
    assert.equal(created.status, 201);
    const path = `/sessions/${id}/archive`;
    const archive = (archived: boolean) => host.fetchApi(path, "owner", { requestId: randomUUID(), archived });

    assert.equal((await archive(true)).status, 409, "a running session cannot be archived");
    assert.equal((await host.fetchApi(path, "controller", { requestId: randomUUID(), archived: true })).status, 403);
    assert.equal((await host.fetchApi(path, "viewer", { requestId: randomUUID(), archived: true })).status, 403);
    assert.equal((await host.fetchApi(path, "owner", { requestId: randomUUID(), archived: true, extra: true })).status, 400,
      "the archive request accepts only its request ID and boolean state");

    const control = await claimControl(host, id, "owner");
    const stopped = await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    assert.equal(stopped.status, 200);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), response => response.body.status === "exited");

    const archived = await archive(true);
    assert.equal(archived.status, 200);
    assert.match(archived.body.archivedAt, /^\d{4}-\d\d-\d\dT/);
    const firstTimestamp = archived.body.archivedAt;
    const listed = (await host.fetchApi("/sessions")).body.sessions.find((session: any) => session.id === id);
    assert.equal(listed.archivedAt, firstTimestamp, "the session list retains archivedAt from its session record");
    const live = (await readLiveSessions(host)).find((session: any) => session.id === id);
    assert.equal(live.archivedAt, firstTimestamp, "the live sessions feed retains archivedAt from its session record");

    const retried = await archive(true);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.archivedAt, firstTimestamp, "repeated archive preserves the original timestamp");
    const unarchived = await archive(false);
    assert.equal(unarchived.status, 200);
    assert.equal(unarchived.body.archivedAt ?? null, null);
    const unarchivedList = (await host.fetchApi("/sessions")).body.sessions.find((session: any) => session.id === id);
    assert.equal(unarchivedList.archivedAt ?? null, null);
  } finally {
    await host.stop();
  }
});

test("session deletion requires an exited session without a responding worker", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    const id = randomUUID();
    const createRequest = {
      requestId: id, provider: "demo" as const, projectId: "rehearsal", title: "Delete lifecycle", prompt: "Keep this session available",
    };
    const created = await host.fetchApi("/sessions", "owner", createRequest);
    assert.equal(created.status, 201);
    const path = `/sessions/${id}`;
    assert.equal((await host.fetchApi(path, "controller", undefined, {}, "DELETE")).status, 403);
    assert.equal((await host.fetchApi(path, "viewer", undefined, {}, "DELETE")).status, 403);
    assert.equal((await host.fetchApi(path, "owner", undefined, {}, "DELETE")).status, 409,
      "a running session cannot be removed");

    const control = await claimControl(host, id, "owner");
    const stopped = await host.fetchApi(`${path}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    assert.equal(stopped.status, 200);
    await waitFor(() => host.fetchApi(path), response => response.body.status === "exited");

    // The worker persists its exit before it unlinks the IPC socket. Retry until
    // the manager can confirm that no worker still answers its state call.
    const removed = await waitFor(() => host.fetchApi(path, "owner", undefined, {}, "DELETE"), response => response.status === 200);
    assert.deepEqual(removed.body, { ok: true, id });
    assert.equal((await host.fetchApi("/sessions")).body.sessions.some((session: any) => session.id === id), false);
    const detail = await host.fetchApi(path);
    assert.equal(detail.status, 404);
    assert.equal((await host.fetchApi(`${path}/events`)).status, 404);
    assert.equal((await host.fetchApi(`${path}/stream`)).status, 404);
    const repeated = await host.fetchApi(path, "owner", undefined, {}, "DELETE");
    assert.equal(repeated.status, 404);
    assert.deepEqual(repeated.body, { code: "not-found", error: "Session not found" });
    const replay = await host.fetchApi("/sessions", "owner", createRequest);
    assert.equal(replay.status, 410, "a deleted session ID cannot replay the original create request");
    const conflictingReuse = await host.fetchApi("/sessions", "owner", { ...createRequest, prompt: "Try a different request with the old ID" });
    assert.equal(conflictingReuse.status, 409, "a deleted session ID cannot be reused for a different request");
    assert.equal((await host.fetchApi("/sessions")).body.sessions.some((session: any) => session.id === id), false);
    await host.stopApi();
    await host.start();
    assert.equal((await host.fetchApi("/sessions", "owner", createRequest)).status, 410,
      "the deleted-ID receipt still blocks replay after an API restart");
    assert.equal((await host.fetchApi("/sessions")).body.sessions.some((session: any) => session.id === id), false);
  } finally {
    await host.stop();
  }
});
